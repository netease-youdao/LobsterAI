import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import { emptyAgentSettingsPermissions } from '../../shared/remote/agentSettings';
import type { AgentSettingsPersistence } from '../libs/agentSettings/types';
import { payloadHash } from './canonical';
import type { RemoteAgentSettingsConnection } from './remoteAgentSettingsAccess';
import { agentSettingsErrorReason, RemoteAgentSettingsProtocol } from './remoteAgentSettingsProtocol';

async function fixture() {
  const data = new Map<string, unknown>();
  const store: AgentSettingsPersistence = { get: key => structuredClone(data.get(key) ?? null) as never, set: (key, value) => { data.set(key, structuredClone(value)); } };
  const connection: RemoteAgentSettingsConnection = { owner: { userId: 'owner', scopeKey: 'personal' }, dataSpaceId: 'test', dataGeneration: '1', deviceId: 'desktop',
    route: 'https://example.test', connectionGeneration: 'generation-1', active: true };
  const service = { read: vi.fn(async () => ({ revision: 'rev-1', value: { text: 'private' }, documentState: 'present' as const, sourceUpdatedAt: null, readAt: new Date().toISOString() })),
    prepare: vi.fn(), apply: vi.fn(), recover: vi.fn(async () => ({ operationId: operationId, section: 'memory' as const, status: 'reconciling' as const })) };
  const operationId = randomUUID(); let claimed = false;
  let permitAction: (() => void) | undefined; let losePermit = false;
  const permissions = emptyAgentSettingsPermissions(); permissions.memory = { read: true, directUpdate: false, conversationUpdate: true };
  const operation = { schemaVersion: 1, operationId, type: 'read', section: 'memory', bindingId: 'binding', bindingVersion: '1', accountEpoch: '1', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  let requestHash = '';
  const request = vi.fn(async (path: string, _method: string, body?: unknown): Promise<unknown> => {
    if (path.endsWith('/agent-settings-access-candidates')) return { items: [{ mobileDeviceId: 'phone', name: 'My phone', grantId: 'grant', grantVersion: '1' }] };
    if (path.endsWith('/settings-access')) return { bindingId: 'binding', bindingVersion: '1', mobileDeviceId: 'phone', agentId: 'main', grantId: 'grant', grantVersion: '1', accountEpoch: '1', sections: permissions, status: 'active' };
    if (path.endsWith('/agent-settings-access')) return { items: [{ bindingId: 'binding', bindingVersion: '1', mobileDeviceId: 'phone', agentId: 'main', grantId: 'grant', grantVersion: '1', accountEpoch: '1', sections: permissions, status: 'active' }] };
    if (path.endsWith('/revoke')) return { status: 'revoked' };
    if (path.includes('unresolved=true')) return { items: [], nextCursor: null };
    if (path.endsWith('/claim')) {
      if (claimed) return { items: [] }; claimed = true;
      return { items: [{ operation: { ...operation, source: 'app', deviceId: 'desktop', agentId: 'main' }, request: operation,
        requestHash, claimId: 'claim', claimToken: 'claim-token-of-sufficient-length', leaseExpiresAt: new Date(Date.now() + 15000).toISOString(), expiresAt: operation.expiresAt }] };
    }
    if (path.endsWith('/permit')) { permitAction?.(); if (losePermit) throw new Error('network');
      return { operationId, permitId: 'permit', permitToken: 'permit-token-of-sufficient-length', startBefore: new Date(Date.now() + 5000).toISOString() }; }
    if (path.endsWith('/result') || path.endsWith('/settle')) return { status: 'succeeded', received: body };
    throw new Error(`Unexpected path: ${path}`);
  });
  const deps = { store, service, request, connection: () => connection, available: () => true, conversationReady: () => true,
    listAgents: () => [{ agentId: 'main', name: 'Default' }] };
  const protocol = new RemoteAgentSettingsProtocol(deps); protocol.configure(true);
  await protocol.authorize({ expectedAccountEpoch: '1', mobileDeviceId: 'phone', agentId: 'main', grantId: 'grant', grantVersion: '1', sections: permissions });
  requestHash = payloadHash({ deviceId: 'desktop', agentId: 'main', body: operation, target: { version: 1, dataSpaceId: 'test', dataGeneration: '1' } });
  return { protocol, deps, store, connection, service, request, operationId, operation,
    losePermit: () => { losePermit = true; }, onPermit: (action: () => void) => { permitAction = action; }, corruptHash: () => { requestHash = 'a'.repeat(64); } };
}
describe('Agent settings HTTP execution', () => {
  it('reads only after a durable permit and keeps document bodies out of settled evidence', async () => {
    const f = await fixture(); f.protocol.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/result'))).toBe(true));
    expect(f.service.read).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.findIndex(([path]) => path.endsWith('/permit'))).toBeLessThan(f.request.mock.calls.findIndex(([path]) => path.endsWith('/result')));
    const journal = f.store.get<{ phase: string; result?: unknown; request: unknown }>(`remote-agent-settings-operation:${f.operationId}`)!;
    expect(journal.phase).toBe('settled'); expect(journal.result).toBeUndefined(); expect(journal.request).toBeNull();
  });
  it('a lost permit response cannot read files and settles only non-application evidence', async () => {
    const f = await fixture(); f.losePermit(); f.protocol.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/settle'))).toBe(true));
    expect(f.service.read).not.toHaveBeenCalled();
    const settled = f.request.mock.calls.find(([path]) => path.endsWith('/settle'))?.[2];
    expect(settled).toMatchObject({ outcome: 'not_applied' }); expect(JSON.stringify(settled)).not.toContain('private');
  });
  it('checks local epoch again after the permit HTTP round trip', async () => {
    const f = await fixture(); f.onPermit(() => f.protocol.fence()); f.protocol.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/settle'))).toBe(true));
    expect(f.service.read).not.toHaveBeenCalled();
  });
  it('rejects a claim whose immutable body does not match its authenticated hash', async () => {
    const f = await fixture(); f.corruptHash(); f.protocol.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/claim'))).toBe(true));
    expect(f.service.read).not.toHaveBeenCalled(); expect(f.request.mock.calls.some(([path]) => path.endsWith('/permit'))).toBe(false);
  });
  it('never announces or polls the new protocol against an older service', async () => {
    const f = await fixture(); f.protocol.configure(false); f.request.mockClear(); f.protocol.tick();
    expect(f.protocol.available()).toBe(false); expect(f.request).not.toHaveBeenCalled();
  });
  it('settles a lost read result with its revision and no document body', async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, method, body) => {
      if (path.endsWith('/result')) throw new Error('response lost');
      return original(path, method, body);
    });
    f.protocol.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/settle'))).toBe(true));
    const body = f.request.mock.calls.find(([path]) => path.endsWith('/settle'))?.[2];
    expect(body).toMatchObject({ outcome: 'succeeded', revision: 'rev-1', error: null });
    expect(JSON.stringify(body)).not.toContain('private'); expect(f.service.read).toHaveBeenCalledOnce();
  });
  it('journals conversation registration before HTTP and retries the exact original request after restart', async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!, id = randomUUID(); let dropped = false;
    const binding = f.protocol.access.bindings(f.connection)[0];
    const context = { owner: f.connection.owner, dataSpaceId: 'test', dataGeneration: '1', deviceId: 'desktop', agentId: 'main',
      accountEpoch: '1', bindingId: binding.bindingId, bindingVersion: binding.bindingVersion, source: 'conversation' as const, commandId: 'command', runId: 'run' };
    const requests: unknown[] = [];
    f.request.mockImplementation(async (path, method, body) => {
      if (path.endsWith('/conversation-changes')) {
        expect(f.store.get<{ phase: string }>(`remote-agent-settings-operation:${id}`)?.phase).toBe('registering');
        requests.push(structuredClone(body));
        if (!dropped) { dropped = true; throw new Error('response lost'); }
        return { requestHash: payloadHash({ deviceId: 'desktop', agentId: 'main', body, target: { version: 1, dataSpaceId: 'test', dataGeneration: '1' } }),
          claimId: 'conversation-claim', recoveryMode: 'receipt_only', recoveryToken: 'settlement-only-recovery-token', permitIssued: false,
          leaseExpiresAt: new Date(Date.now() + 15000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
      }
      return original(path, method, body);
    });
    await expect(f.protocol.prepareConversation({ context, binding, connectionGeneration: 'generation-1', connection: structuredClone(f.connection) },
      { operationId: id, commandId: 'command', runId: 'run', toolCallId: 'tool', section: 'memory', expectedRevision: 'rev-1', proposedDigest: 'a'.repeat(64), changeKind: 'append', approvalId: 'approval' })).rejects.toThrow('response lost');
    f.connection.connectionGeneration = 'generation-2';
    f.service.recover.mockResolvedValue({ operationId: id, section: 'memory', status: 'rejected' } as never);
    const restored = new RemoteAgentSettingsProtocol(f.deps); restored.configure(true); restored.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path === `/agent-settings-operations/${id}/settle`)).toBe(true));
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    const settlement = f.request.mock.calls.find(([path]) => path === `/agent-settings-operations/${id}/settle`)?.[2];
    expect(settlement).toMatchObject({ recoveryToken: 'settlement-only-recovery-token', outcome: 'not_applied' });
    expect(settlement).not.toHaveProperty('claimToken');
    expect(f.request.mock.calls.some(([path]) => path === `/agent-settings-operations/${id}/permit`)).toBe(false);
    expect(f.service.apply).not.toHaveBeenCalled();
  });

  it('does not extend the local five-second start window when the permit response arrives late', async () => {
    const f = await fixture(); const clock = vi.spyOn(Date, 'now');
    f.onPermit(() => clock.mockReturnValue(new Date().getTime() + 6000));
    try {
      f.protocol.tick();
      await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/settle'))).toBe(true));
      expect(f.service.read).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each([{ status: 'revoked', bindingVersion: '2' }, { mobileDeviceId: 'different-phone' }])('cannot revive a stale or mismatched authorization response: %o', async patch => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    const local = f.protocol.access.bindings(f.connection)[0];
    f.request.mockImplementation(async (path, method, body) => {
      const value = await original(path, method, body);
      return path.endsWith('/settings-access') ? { ...value as object, ...patch } : value;
    });
    await expect(f.protocol.authorize({ expectedAccountEpoch: local.accountEpoch, mobileDeviceId: local.mobileDeviceId,
      agentId: local.agentId, grantId: local.grantId, grantVersion: local.grantVersion, sections: local.sections })).rejects.toThrow('SETTINGS_ACCESS_STALE');
    expect(f.protocol.access.bindings(f.connection).some(binding => binding.status === 'active')).toBe(false);
    expect(f.protocol.access.pending(f.connection).some(pending => pending.kind === 'authorize')).toBe(false);
  });

});


describe('Agent settings business error mapping', () => {
  it('prefers RemoteApiError.data.reason over localized messages and generic error fields', () => {
    const error = Object.assign(new Error('审批尚未同步'), { data: { reason: 'SETTINGS_APPROVAL_REQUIRED' }, reason: 'SETTINGS_UNAVAILABLE' });
    expect(agentSettingsErrorReason(error)).toBe('SETTINGS_APPROVAL_REQUIRED');
  });
  it('preserves a local domain pending reason', () => {
    expect(agentSettingsErrorReason(Object.assign(new Error('pending'), { reason: 'SETTINGS_OPERATION_PENDING' }))).toBe('SETTINGS_OPERATION_PENDING');
  });
  it('never copies private or malformed error text into a settlement receipt', () => {
    expect(agentSettingsErrorReason(Object.assign(new Error('private memory content'), { data: { reason: 'private memory content' } }))).toBe('SETTINGS_UNAVAILABLE');
    expect(agentSettingsErrorReason({ data: { reason: { secret: 'value' } } })).toBe('SETTINGS_UNAVAILABLE');
  });
});
