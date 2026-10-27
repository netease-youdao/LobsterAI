import { describe, expect, test, vi } from 'vitest';

import { OpenClawGatewayMethod } from './constants';
import { confirmOpenClawSessionStopped } from './openclawSessionStop';

const sessionKey = 'agent:main:lobsterai:task';
const idle = { key: sessionKey, hasActiveRun: false, hasActiveSubagentRun: false };
function gateway(snapshot: unknown = { sessions: [idle] }, result: unknown = { ok: true }) {
  return { request: vi.fn(async (method: string, _params?: unknown, _options?: { timeoutMs?: number }): Promise<unknown> =>
    method === OpenClawGatewayMethod.SessionsAbort ? result : snapshot) };
}

describe('confirmed OpenClaw session stop', () => {
  test.each([false, undefined])('confirms only after an exact idle row with descendant state %s', async hasActiveSubagentRun => {
    const client = gateway({ sessions: [{ ...idle, hasActiveSubagentRun }] });
    expect(await confirmOpenClawSessionStopped(client, sessionKey, () => true)).toBe(true);
    expect(client.request).toHaveBeenNthCalledWith(1, OpenClawGatewayMethod.SessionsAbort,
      { key: sessionKey, clearQueued: true }, { timeoutMs: 15_000 });
    expect(client.request).toHaveBeenNthCalledWith(2, OpenClawGatewayMethod.SessionsList,
      { search: sessionKey, limit: 50, archived: 'all' }, { timeoutMs: 2_000 });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  test.each([
    { ...idle, hasActiveRun: true },
    { ...idle, hasActiveRun: undefined },
    { ...idle, hasActiveRun: null },
    { ...idle, hasActiveRun: 'false' },
    { ...idle, hasActiveSubagentRun: true },
    { ...idle, hasActiveSubagentRun: null },
    { ...idle, hasActiveSubagentRun: 'unknown' },
  ])('does not confirm active or unknown run state: %j', async row => {
    expect(await confirmOpenClawSessionStopped(gateway({ sessions: [row] }), sessionKey, () => true)).toBe(false);
  });

  test.each([
    undefined, null, {}, { sessions: null }, { sessions: [] },
    { sessions: [{ ...idle, key: `${sessionKey}-other` }] },
    { sessions: [idle, { ...idle }] },
    { sessions: [idle, { ...idle, hasActiveRun: true }] },
  ])('does not infer stopping from a missing, malformed, or duplicate row: %j', async snapshot => {
    const client = gateway(); client.request.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(snapshot);
    expect(await confirmOpenClawSessionStopped(client, sessionKey, () => true)).toBe(false);
  });

  test.each([undefined, null, true, {}, { ok: false }, { ok: 'true' }])('requires explicit abort acceptance: %j', async result => {
    const client = gateway(); client.request.mockResolvedValueOnce(result);
    expect(await confirmOpenClawSessionStopped(client, sessionKey, () => true)).toBe(false);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  test('does not issue a request for an empty key or an obsolete context', async () => {
    const client = gateway();
    expect(await confirmOpenClawSessionStopped(client, '', () => true)).toBe(false);
    expect(await confirmOpenClawSessionStopped(client, sessionKey, () => false)).toBe(false);
    expect(client.request).not.toHaveBeenCalled();
  });

  test.each([OpenClawGatewayMethod.SessionsAbort, OpenClawGatewayMethod.SessionsList])('rejects a context change while awaiting %s', async method => {
    let current = true;
    const client = gateway();
    client.request.mockImplementation(async invoked => {
      if (invoked === method) current = false;
      return invoked === OpenClawGatewayMethod.SessionsAbort ? { ok: true } : { sessions: [idle] };
    });
    expect(await confirmOpenClawSessionStopped(client, sessionKey, () => current)).toBe(false);
    expect(client.request).toHaveBeenCalledTimes(method === OpenClawGatewayMethod.SessionsAbort ? 1 : 2);
  });

  test.each([OpenClawGatewayMethod.SessionsAbort, OpenClawGatewayMethod.SessionsList])('keeps failure or timeout of %s unconfirmed', async method => {
    const client = gateway();
    client.request.mockImplementation(async invoked => {
      if (invoked === method) throw new Error('Gateway request timed out');
      return { ok: true };
    });
    expect(await confirmOpenClawSessionStopped(client, sessionKey, () => true)).toBe(false);
  });

  test('treats an unavailable context guard as unconfirmed', async () => {
    const client = gateway();
    expect(await confirmOpenClawSessionStopped(client, sessionKey, () => { throw new Error('Store closed'); })).toBe(false);
    expect(client.request).not.toHaveBeenCalled();
  });
});
