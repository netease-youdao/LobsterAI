import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import { emptyAgentSettingsPermissions, type RemoteAgentSettingsBinding, sameAccountAgentSettingsPermissions } from '../../shared/remote/agentSettings';
import type { AgentSettingsPersistence } from '../libs/agentSettings/types';
import { payloadHash } from './canonical';
import type { RemoteAgentSettingsConnection } from './remoteAgentSettingsAccess';
import { agentSettingsErrorReason, RemoteAgentSettingsProtocol } from './remoteAgentSettingsProtocol';

async function fixture(userId = 'owner', initialAuthorize = true, permissions = sameAccountAgentSettingsPermissions(true)) {
  const data = new Map<string, unknown>();
  const store: AgentSettingsPersistence = { get: key => structuredClone(data.get(key) ?? null) as never, set: (key, value) => { data.set(key, structuredClone(value)); } };
  const connection: RemoteAgentSettingsConnection = { owner: { userId, scopeKey: 'personal' }, dataSpaceId: 'test', dataGeneration: '1', deviceId: 'desktop',
    route: 'https://example.test', connectionGeneration: 'generation-1', active: true };
  const service = { read: vi.fn(async () => ({ revision: 'rev-1', value: { text: 'private' }, documentState: 'present' as const, sourceUpdatedAt: null, readAt: new Date().toISOString() })),
    prepare: vi.fn(), apply: vi.fn(), recover: vi.fn(async () => ({ operationId: operationId, section: 'memory' as const, status: 'reconciling' as const })) };
  const operationId = randomUUID(); let claimed = false;
  let permitAction: (() => void) | undefined; let losePermit = false;
  let remoteBindings: RemoteAgentSettingsBinding[] = [];
  const candidates = [{ mobileDeviceId: 'phone', name: 'My phone', grantId: 'grant', grantVersion: '1' }];
  const operation = { schemaVersion: 1, operationId, type: 'read', section: 'memory', bindingId: 'binding', bindingVersion: '1', accountEpoch: '1', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  let requestHash = '';
  const request = vi.fn(async (path: string, _method: string, body?: unknown): Promise<unknown> => {
    if (path.endsWith('/agent-settings-access-candidates')) return { items: candidates, nextCursor: null };
    if (path.endsWith('/settings-access')) {
      const input = body as RemoteAgentSettingsBinding, agentId = path.split('/').at(-2)!;
      const binding: RemoteAgentSettingsBinding = { bindingId: agentId === 'main' ? 'binding' : `binding-${agentId}`, bindingVersion: '1',
        mobileDeviceId: input.mobileDeviceId, agentId, grantId: input.grantId, grantVersion: input.grantVersion,
        accountEpoch: input.accountEpoch, sections: input.sections, status: 'active' };
      remoteBindings = [...remoteBindings.filter(item => item.agentId !== agentId || item.mobileDeviceId !== input.mobileDeviceId), binding];
      return binding;
    }
    if (path.endsWith('/agent-settings-access')) return { items: remoteBindings, nextCursor: null };
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
  if (initialAuthorize) {
    // A previously confirmed binding simulates upgrading an installation that used the old settings form.
    const input = { expectedAccountEpoch: '1', mobileDeviceId: 'phone', agentId: 'main', grantId: 'grant', grantVersion: '1', sections: permissions };
    protocol.access.activate(connection);
    const pending = protocol.access.authorize(connection, input, true);
    const value = await request('/devices/desktop/agents/main/settings-access', 'POST', { ...input, accountEpoch: '1' }) as RemoteAgentSettingsBinding;
    protocol.access.confirm(pending, value);
  }
  requestHash = payloadHash({ deviceId: 'desktop', agentId: 'main', body: operation, target: { version: 1, dataSpaceId: 'test', dataGeneration: '1' } });
  return { protocol, deps, store, connection, service, request, operationId, operation, candidates,
    losePermit: () => { losePermit = true; }, onPermit: (action: () => void) => { permitAction = action; }, corruptHash: () => { requestHash = 'a'.repeat(64); } };
}
describe('same-account Agent settings', () => {
  async function poll(f: Awaited<ReturnType<typeof fixture>>, offset = 0): Promise<void> {
    const count = f.request.mock.calls.filter(([path]) => path.endsWith('/claim')).length;
    const clock = offset ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + offset) : null;
    try {
      f.protocol.tick();
      await vi.waitFor(() => expect(f.request.mock.calls.filter(([path]) => path.endsWith('/claim')).length).toBe(count + 1));
      await vi.waitFor(() => expect(f.store.get<{ phase: string }>(`remote-agent-settings-operation:${f.operationId}`)?.phase).toBe('settled'));
    } finally { clock?.mockRestore(); }
  }
  it('automatically enables settings for the signed-in account without a manual authorization', async () => {
    const f = await fixture('owner', false); await poll(f);
    expect(f.service.read).toHaveBeenCalledOnce();
    expect(f.protocol.access.bindings(f.connection)[0].sections).toEqual(sameAccountAgentSettingsPermissions(true));
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(1);
  });
  it('does not recreate unchanged bindings on later polls', async () => {
    const f = await fixture('owner', false); await poll(f); await poll(f, 6000);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(1);
  });
  it('keeps confirmed account bindings across an ordinary WebSocket reconnection', async () => {
    const f = await fixture('owner', false); await poll(f);
    f.connection.connectionGeneration = 'generation-2'; await poll(f, 6000);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(1);
  });
  it('refreshes the binding when its control grant version changes', async () => {
    const f = await fixture('owner', false); await poll(f);
    f.candidates[0].grantVersion = '2'; await poll(f, 6000);
    expect(f.protocol.access.bindings(f.connection)[0].grantVersion).toBe('2');
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(2);
  });
  it('continues a large access snapshot on the next tick without revoking missing local bindings', async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    const existing = f.protocol.access.bindings(f.connection)[0];
    f.request.mockImplementation(async (path, method, body) => {
      if (path.includes('/agent-settings-access') && !path.includes('candidates')) {
        const cursor = new URL(path, 'https://example.test').searchParams.get('cursor');
        const page = cursor ? Number(cursor) : 0;
        return page < 6 ? { items: [], nextCursor: String(page + 1) } : { items: [existing], nextCursor: null };
      }
      return original(path, method, body);
    });
    await poll(f);
    expect(f.request.mock.calls.filter(([path]) => path.includes('/agent-settings-access') && !path.includes('candidates'))).toHaveLength(5);
    await poll(f, 6000);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(1);
    expect(f.protocol.access.bindings(f.connection)[0].status).toBe('active');
  });
  it('upgrades old partial section permissions automatically', async () => {
    const permissions = emptyAgentSettingsPermissions(); permissions.memory = { read: true, directUpdate: false, conversationUpdate: true };
    const f = await fixture('owner', true, permissions); await poll(f);
    expect(f.protocol.access.bindings(f.connection)[0].sections).toEqual(sameAccountAgentSettingsPermissions(true));
  });
  it('follows pagination even when a page has no eligible phones', async () => {
    const f = await fixture('owner', false), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, method, body) => {
      if (path.endsWith('/agent-settings-access-candidates')) return { items: [], nextCursor: 'next-page' };
      if (path.endsWith('/agent-settings-access-candidates?cursor=next-page')) return { items: f.candidates, nextCursor: null };
      return original(path, method, body);
    });
    await poll(f);
    expect(f.service.read).toHaveBeenCalledOnce();
  });
  it('keeps locally confirmed bindings when an older server returns a partial first page', async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, method, body) => path.endsWith('/agent-settings-access') ? { items: [] } : original(path, method, body));
    await poll(f);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(1);
    expect(f.service.read).toHaveBeenCalledOnce();
  });
  it('publishes at most five bindings per poll and continues with the other Agents later', async () => {
    const f = await fixture('owner', false);
    f.deps.listAgents = () => ['main', 'a', 'b', 'c', 'd', 'e', 'f'].map(agentId => ({ agentId, name: agentId }));
    await poll(f);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(5);
    await poll(f, 6000);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/settings-access'))).toHaveLength(7);
  });
  it('isolates a failed publication so the next Agent can still synchronize', async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.deps.listAgents = () => ['main', 'fails', 'works'].map(agentId => ({ agentId, name: agentId }));
    f.request.mockImplementation(async (path, method, body) => {
      if (path.endsWith('/agents/fails/settings-access')) throw new Error('network');
      return original(path, method, body);
    });
    await poll(f);
    expect(f.protocol.access.bindings(f.connection).map(binding => binding.agentId)).toContain('works');
  });
  it('never grants direct text changes through the same-account defaults', () => {
    const permissions = sameAccountAgentSettingsPermissions(false);
    for (const section of ['identity', 'memory', 'userProfile'] as const) expect(permissions[section]).toEqual({ read: true, directUpdate: false, conversationUpdate: false });
    expect(permissions.model.directUpdate).toBe(true);
  });
});

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

  it.each([{ status: 'revoked', bindingVersion: '2' }, { mobileDeviceId: 'different-phone' }])('cannot revive a stale or mismatched binding response: %o', async patch => {
    const f = await fixture('owner', false), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, method, body) => {
      const value = await original(path, method, body);
      return path.endsWith('/settings-access') ? { ...value as object, ...patch } : value;
    });
    f.protocol.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/claim'))).toBe(true));
    expect(f.service.read).not.toHaveBeenCalled();
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
