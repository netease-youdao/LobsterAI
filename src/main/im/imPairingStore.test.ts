import { describe, expect, test, vi } from 'vitest';

import { IMPairingFailure, OpenClawPairingMethod } from '../../shared/im/pairing';
import { PlatformRegistry } from '../../shared/platform';
import { approvePairingCode, listPairingRequests, type PairingGatewayClient, rejectPairingRequest } from './imPairingStore';

const channel = PlatformRegistry.channelOf('telegram');
const accountId = 'bot-one';
const request = {
  requestId: 'opaque-request-one', channel, accountId, senderId: 'sender-one', code: 'PAIR1234',
  createdAt: '2026-09-10T00:00:00.000Z', lastSeenAt: '2026-09-10T00:00:00.000Z',
  metadata: { name: 'Fixture', accountId: 'untrusted-metadata' },
};

function mockGateway(payload: unknown = {
  accounts: [{ channel, accountId, allowFrom: ['previous-sender'] }], requests: [request],
}) {
  const call = vi.fn<(method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>>(
    async method => method === OpenClawPairingMethod.List ? payload : {},
  );
  return { call, client: { request: call } as PairingGatewayClient };
}

describe('IM pairing Gateway adapter', () => {
  test('reads pending requests and preserves account-scoped approvals', async () => {
    const { call, client } = mockGateway({
      accounts: [
        { channel, accountId, allowFrom: ['previous-sender'] },
        { channel, accountId: 'bot-two', allowFrom: ['other-sender', 'previous-sender'] },
      ], requests: [request],
    });
    const result = await listPairingRequests(client, 'telegram');
    expect(result.requests[0]).toMatchObject({
      id: request.senderId, code: request.code, requestId: request.requestId, accountId,
      meta: { name: 'Fixture', accountId },
    });
    expect(result.accounts).toHaveLength(2);
    expect(result.allowFrom).toEqual(['previous-sender', 'other-sender']);
    expect(call).toHaveBeenCalledWith(OpenClawPairingMethod.List, {
      channel, includeCodes: true, includeAllowFrom: true,
    }, { timeoutMs: 10_000 });
  });

  test.each(PlatformRegistry.platforms)('maps platform %s to the configured OpenClaw channel', async platform => {
    const { call, client } = mockGateway({ accounts: [], requests: [] });
    await listPairingRequests(client, platform);
    expect(call.mock.calls[0][1]).toMatchObject({ channel: PlatformRegistry.channelOf(platform) });
  });

  test.each([
    [approvePairingCode, OpenClawPairingMethod.Approve],
    [rejectPairingRequest, OpenClawPairingMethod.Dismiss],
  ] as const)('resolves a human code to the official identity for %s', async (act, method) => {
    const { call, client } = mockGateway();
    await act(client, 'telegram', ' pair1234 ', ' BOT-ONE ');
    expect(call.mock.calls).toEqual([
      [OpenClawPairingMethod.List, { channel, accountId, includeCodes: true, includeAllowFrom: true }, { timeoutMs: 10_000 }],
      [method, { channel, accountId, requestId: request.requestId }, { timeoutMs: 10_000 }],
    ]);
  });

  test('does not fall back to local files while the gateway is unavailable', async () => {
    await expect(listPairingRequests(null, 'telegram')).rejects.toMatchObject({ code: IMPairingFailure.Unavailable });
    await expect(approvePairingCode(null, 'telegram', request.code)).rejects.toMatchObject({ code: IMPairingFailure.Unavailable });
  });

  test('does not write an approval for a missing or expired code', async () => {
    const { call, client } = mockGateway({ accounts: [{ channel, accountId, allowFrom: [] }], requests: [] });
    await expect(approvePairingCode(client, 'telegram', request.code)).rejects.toMatchObject({ code: IMPairingFailure.NotFound });
    expect(call).toHaveBeenCalledTimes(1);
  });

  test('rejects ambiguous codes instead of selecting the first account', async () => {
    const { call, client } = mockGateway({
      accounts: [{ channel, accountId, allowFrom: [] }, { channel, accountId: 'bot-two', allowFrom: [] }],
      requests: [request, { ...request, accountId: 'bot-two', requestId: 'opaque-request-two' }],
    });
    await expect(approvePairingCode(client, 'telegram', request.code)).rejects.toMatchObject({ code: IMPairingFailure.Ambiguous });
    expect(call).toHaveBeenCalledTimes(1);
  });

  test('rejects a response from a different account before mutation', async () => {
    const { call, client } = mockGateway();
    await expect(approvePairingCode(client, 'telegram', request.code, 'bot-two')).rejects.toMatchObject({ code: IMPairingFailure.InvalidResponse });
    expect(call).toHaveBeenCalledTimes(1);
  });

  test('rejects an older runtime that omits the requested codes or allowlists', async () => {
    const { client } = mockGateway({ accounts: [{ channel, accountId }], requests: [] });
    await expect(listPairingRequests(client, 'telegram')).rejects.toMatchObject({ code: IMPairingFailure.InvalidResponse });
  });

  test('reports mutation failure after a successful list without retrying or changing config', async () => {
    const { call, client } = mockGateway();
    call.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(listPairingRequests(client, 'telegram')).rejects.toThrow('database unavailable');
    call.mockClear();
    call.mockImplementation(async method => {
      if (method === OpenClawPairingMethod.List) return { accounts: [{ channel, accountId, allowFrom: [] }], requests: [request] };
      throw new Error('pending DM access request no longer exists');
    });
    await expect(approvePairingCode(client, 'telegram', request.code)).rejects.toThrow('no longer exists');
    expect(call).toHaveBeenCalledTimes(2);
  });

  test('rejects invalid input before making a gateway request', async () => {
    const { call, client } = mockGateway();
    await expect(listPairingRequests(client, '../../elsewhere')).rejects.toMatchObject({ code: IMPairingFailure.InvalidTarget });
    await expect(listPairingRequests(client, 'telegram', '')).rejects.toMatchObject({ code: IMPairingFailure.InvalidTarget });
    await expect(approvePairingCode(client, 'telegram', '')).rejects.toMatchObject({ code: IMPairingFailure.NotFound });
    expect(call).not.toHaveBeenCalled();
  });
});
