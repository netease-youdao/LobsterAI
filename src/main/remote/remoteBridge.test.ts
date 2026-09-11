import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnershipSyncState, OwnershipTargetKind } from '../../shared/ownership/constants';
import { RemoteCapability } from '../../shared/remote/constants';
import { OwnershipAssociationStore } from '../ownershipAssociationStore';
import { payloadHash } from './canonical';
import { RemoteAgentError } from './remoteAgentCatalog';
import { RemoteApprovalError } from './remoteApproval';
import { type InboxEntry, RemoteApiError,RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  const request = { commandId: 'command-1', type: 'create_session', deviceId: 'desktop', expiresAt: new Date(Date.now() + 60000).toISOString(), payload: { text: 'hello', workspaceId: 'workspace' } };
  const command = { sessionId: 'remote', runId: 'server-run', commandId: request.commandId, type: request.type, status: 'claimed', statusVersion: '2', expiresAt: request.expiresAt };
  const envelope = { command, request, requestHash: payloadHash(request), claimId: 'claim', claimToken: 'secret', claimUntil: new Date(Date.now() + 15000).toISOString(), statusVersion: '2' };
  const calls: string[] = [];
  let disconnectOnReceipt = false;
  let receiptStatus = 'received';
  const execute = vi.fn(async (entry: InboxEntry, stillPermitted: () => boolean) => {
    expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('executing');
    expect(stillPermitted()).toBe(true); calls.push('execute'); return { outcome: 'started' };
  });
  const requestApi = vi.fn(async (_owner, pathname, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${pathname}:${body?.status || ''}`);
    let data: any;
    if (pathname.endsWith('/commands/claim')) data = { items: [envelope] };
    else if (pathname.endsWith('/ack')) {
      // Mirror RemoteCommandService.mapping/result/error validators, rather than a permissive self-mock.
      expect(body.sessionId).toBe(command.sessionId); expect(body.runId).toBe(command.runId);
      if (body.status === 'applied') expect(body.result).toEqual({ outcome: 'started' });
      else expect(body.result).toBeNull();
      if (body.error) {
        expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'reason', 'reasonDetail', 'retryAfterMs', 'retryable']);
        expect(typeof body.error.code).toBe('number'); expect(typeof body.error.retryable).toBe('boolean');
      }
      if (body.status === 'received') {
        expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('prepared');
        if (disconnectOnReceipt) bridge.generation = null;
      }
      data = { ...command, status: body.status === 'received' ? receiptStatus : body.status, statusVersion: body.status === 'received' ? '3' : '4' };
    } else if (pathname.includes('/commands?')) data = { items: [envelope], nextCursor: null };
    else if (pathname.endsWith('/reconcile')) data = { command: { ...command, status: 'unknown', statusVersion: '4' }, executionPermit: null };
    else throw new Error(`Unexpected request ${pathname}`);
    return new Response(JSON.stringify({ code: 0, message: 'success', data }));
  });
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'db' },
    getOwner: () => owner, getApiBaseUrl: () => 'https://example.com', request: requestApi,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: () => { store.db.prepare("INSERT INTO cowork_sessions VALUES ('local','hello',1,1,'idle')").run(); store.assignNew('local', owner, 'remote_command'); return { localSessionId: 'local', remoteSessionId: 'remote', runId: command.runId }; },
    execute, onAccountChange: vi.fn(),
  });
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' }; bridge.generation = '1'; bridge.sameAccountAccess = true;
  store.put('settings:10001:personal', { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [{ workspaceId: 'workspace', name: 'Folder', path: '/work', available: true }] });
  return { store, bridge, envelope, calls, execute, requestApi, disconnect: () => { disconnectOnReceipt = true; }, terminalReceipt: () => { receiptStatus = 'applied'; } };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('ownership association synchronization', () => {
  function claimed() {
    const value = fixture();
    const { store } = value;
    store.db.exec("ALTER TABLE cowork_sessions ADD COLUMN agent_id TEXT; INSERT INTO cowork_sessions VALUES('claimed-task','History',1,1,'idle','claimed-agent'); INSERT INTO cowork_sessions VALUES('future-task','New',1,1,'idle','claimed-agent');");
    store.transaction(() => {
      store.assignNew('claimed-task', owner, 'manual_claim');
      store.assignNew('future-task', owner, 'local_create');
      new OwnershipAssociationStore(store).save({ operation_id: 'claim', owner_user_id: owner.userId, owner_scope_key: owner.scopeKey,
        request_id: 'request', commit_request_hash: 'request-hash', manifest_hash: 'manifest-hash', target_kind: OwnershipTargetKind.Agent,
        target_id: 'claimed-agent', associated_at: 1, remote_admissions_json: '{}', manifest_json: JSON.stringify({
          kind: OwnershipTargetKind.Agent, targetId: 'claimed-agent', agentId: 'claimed-agent', agentVersion: '2',
          associatedSessionIds: ['claimed-task'], retainedSessionIds: [], affectedAgentIds: ['claimed-agent'],
        }) });
    });
    return value;
  }
  it('blocks the whole unadmitted Agent including later tasks and does not admit from a detail read', () => {
    const { bridge, store } = claimed();
    expect(bridge.ownershipSyncBlocked('claimed-task')).toBe(true);
    expect(bridge.ownershipSyncBlocked('future-task')).toBe(true);
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'claimed-task' })).toBe(OwnershipSyncState.WaitingService);
    expect(new OwnershipAssociationStore(store).list(owner)[0].remote_admissions_json).toBe('{}');
    bridge.stop();
  });
  it('keeps admitted work recoverable after the flag turns off but gates a different device', () => {
    const { bridge, store } = claimed();
    bridge.ownershipClaimCapability = { environment: 'https://example.com', owner, enabled: true };
    expect(bridge.ownershipSyncBlocked('claimed-task')).toBe(false);
    expect(new OwnershipAssociationStore(store).list(owner)[0].remote_admissions_json).not.toBe('{}');
    bridge.ownershipClaimCapability.enabled = false;
    expect(bridge.ownershipSyncBlocked('future-task')).toBe(false);
    bridge.registration.deviceId = 'replacement';
    expect(bridge.ownershipSyncBlocked('claimed-task')).toBe(true);
    bridge.stop();
  });
  it('reports pending and failed task persistence independently from a healthy websocket', () => {
    const { bridge, store } = claimed();
    bridge.ownershipClaimCapability = { environment: 'https://example.com', owner, enabled: true };
    bridge.ownershipSyncBlocked('claimed-task');
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'claimed-task' })).toBe(OwnershipSyncState.Pending);
    store.put('syncFailure:claimed-task', { code: 47019 });
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'claimed-task' })).toBe(OwnershipSyncState.Failed);
    bridge.stop();
  });
  it('keeps an owned task pending while the bridge has not adopted the current login', () => {
    const { bridge } = claimed();
    bridge.owner = null;
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'claimed-task' })).toBe(OwnershipSyncState.Pending);
    bridge.stop();
  });
});

describe('command execution safety', () => {
  it('durably prepares before received ACK and dispatches only once across duplicate claims', async () => {
    const { bridge, execute, store, calls } = fixture();
    await bridge.claim(); await bridge.claim();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('applied');
    expect(calls.indexOf('/api/remote/v1/commands/command-1/ack:received')).toBeLessThan(calls.indexOf('execute'));
    expect(store.sync('local')!.device_id).toBe('desktop'); bridge.stop();
  });
  it('does not dispatch after generation loss during received ACK', async () => {
    const { bridge, execute, store, disconnect } = fixture(); disconnect();
    await bridge.claim(); expect(execute).not.toHaveBeenCalled(); expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('prepared'); bridge.stop();
  });
  it('rejects tampered request hashes without calling the executor', async () => {
    const { bridge, envelope, execute, store } = fixture(); envelope.request.payload.text = 'changed';
    await bridge.claim(); expect(execute).not.toHaveBeenCalled(); expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('rejected'); bridge.stop();
  });
  it('reports uncertain execution after restart without requesting a new permit', async () => {
    const { bridge, execute, requestApi, store } = fixture(); await bridge.claim();
    const entry = store.get<InboxEntry>('inbox:command-1')!; entry.state = 'executing'; store.put('inbox:command-1', entry);
    execute.mockClear(); await bridge.reconcile(); expect(execute).not.toHaveBeenCalled();
    const reconcile = requestApi.mock.calls.find((call: any[]) => call[1].endsWith('/reconcile'))!;
    const body = JSON.parse(String(reconcile[2].body)); expect(body.observedExecution).toBe('unknown'); expect(body.requestExecutionPermit).toBe(false); bridge.stop();
  });
  it('merges terminal received responses without dispatching an already-applied command', async () => {
    const { bridge, execute, terminalReceipt, store } = fixture(); terminalReceipt();
    await bridge.claim(); expect(execute).not.toHaveBeenCalled(); expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('applied'); bridge.stop();
  });
  it('does not cancel local runs when the remote socket closes', () => {
    const { bridge, execute } = fixture(); bridge.disconnect(); expect(execute).not.toHaveBeenCalled(); expect(bridge.generation).toBeNull(); bridge.stop();
  });
});


describe('settings intent ordering', () => {
  for (const pauseAt of ['GET', 'PATCH']) it(`preserves a newer disable while an older ${pauseAt} is in flight`, async () => {
    const { bridge, requestApi, store } = fixture();
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const updates: boolean[] = [];
    let paused = false;
    requestApi.mockImplementation(async (_owner, pathname, init) => {
      if (pathname.endsWith('/settings')) {
        if (init.method === pauseAt && !paused) { paused = true; reached(); await gate; }
        if (init.method === 'PATCH') updates.push(JSON.parse(String(init.body)).remoteEnabled);
        return new Response(JSON.stringify({ code: 0, data: { settingsVersion: '2' } }));
      }
      if (pathname.endsWith('/metadata')) return new Response(JSON.stringify({ code: 0, data: { metadataVersion: '2' } }));
      throw new Error(`Unexpected ${pathname}`);
    });
    await bridge.configure({ enabled: true });
    const enable = bridge.writeSettings();
    await waiting;
    await bridge.configure({ enabled: false });
    const disable = bridge.writeSettings();
    await Promise.resolve(); await Promise.resolve();
    expect(store.get<any>('settings:10001:personal').enabled).toBe(false);
    release();
    await Promise.all([enable, disable]);
    expect(store.get<any>('settings:10001:personal').enabled).toBe(false);
    expect(updates.at(-1)).toBe(false);
    expect(updates).toEqual([true, false]);
    bridge.stop();
  });
});


describe('temporary rollout unavailability', () => {
  for (const code of [404, 47000]) it(`automatically probes again after ${code} without dropping durable work`, async () => {
    vi.useFakeTimers();
    const { bridge, store } = fixture();
    try {
      vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
      const registration = vi.spyOn(bridge, 'ensureRegistration').mockRejectedValueOnce(new RemoteApiError(code, 'temporarily unavailable')).mockResolvedValue(undefined);
      vi.spyOn(bridge, 'connect').mockResolvedValue(undefined);
      vi.spyOn(bridge, 'pollAccess').mockResolvedValue(undefined);
      vi.spyOn(bridge, 'reconcile').mockResolvedValue(undefined);
      const sync = vi.spyOn(bridge, 'syncSessions').mockResolvedValue(undefined);
      vi.spyOn(bridge, 'claim').mockResolvedValue(undefined);
      store.put('inbox:retained', { state: 'unknown' });
      await bridge.tick();
      expect(bridge.suspended).toBe(false); expect(bridge.backoff).toBe(60000);
      await bridge.tick(); expect(registration).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 60001);
      await bridge.tick();
      expect(registration).toHaveBeenCalledTimes(2); expect(sync).toHaveBeenCalledTimes(1);
      expect(store.get<any>('inbox:retained')).toEqual({ state: 'unknown' });
      expect(bridge.owner).toEqual(owner);
    } finally { bridge.stop(); vi.useRealTimers(); }
  });
});

describe('Agent protocol negotiation and lost claim recovery', () => {
  it('declares selection before the first catalog is ready and preserves protocol support when admission flags close', async () => {
    const { bridge, store, requestApi } = fixture();
    let capabilities = [RemoteCapability.SameAccountAccess, RemoteCapability.SessionAgent, RemoteCapability.AgentCatalog, RemoteCapability.AgentSelection];
    requestApi.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {
      enabled: true, protocolVersions: [1], capabilities, limits: { maxAgentCatalogItems: 200, maxAgentCatalogBytes: 262144 },
    } })));
    const extended: any = new RemoteBridge({ ...bridge.deps, agentOwnership: { subscribe: vi.fn() }, getAgentWorkspace: () => ({ path: '/private/tmp', name: 'Workspace' }) });
    extended.owner = owner; extended.registration = bridge.registration;
    await extended.refreshCapabilities();
    expect(extended.advertisedCapabilities(false)).toEqual(expect.arrayContaining([RemoteCapability.CreateSession, RemoteCapability.AgentSelection]));
    expect(store.entries('agentCatalog:')).toHaveLength(0);
    store.put('controlQueue:10001:personal', []);
    capabilities = [RemoteCapability.SameAccountAccess];
    await extended.refreshCapabilities();
    expect(extended.agentCapabilities).toEqual([]);
    expect(extended.advertisedCapabilities()).toContain(RemoteCapability.AgentSelection);
    expect(store.get('controlQueue:10001:personal')).toEqual([]);
    extended.stop(); bridge.stop();
  });
  for (const grantPermit of [false, true]) it(`recovers a lost claim with an invalid Agent using not-started evidence (new permit: ${grantPermit})`, async () => {
    const { bridge, store, envelope, execute, requestApi } = fixture();
    (envelope as any).currentClaimId = 'lost-claim';
    delete (envelope as any).claimToken;
    vi.spyOn(bridge, 'commandWorkspace').mockImplementation(() => { throw new RemoteAgentError(47029, 'AGENT_VERSION_CONFLICT', 'VERSION_CHANGED'); });
    const original = requestApi.getMockImplementation()!;
    requestApi.mockImplementation(async (...args) => {
      const [, pathname, init] = args;
      if (pathname.endsWith('/reconcile')) {
        const body = JSON.parse(String(init.body));
        expect(body.observedExecution).toBe('not_started');
        expect(body.claimToken).toBeUndefined();
        expect(body.localEvidence.executionNeverStarted).toBe(true);
        const error = { code: 47029, reason: 'AGENT_VERSION_CONFLICT', message: 'Changed', retryable: false, reasonDetail: null, retryAfterMs: null };
        const command = { ...envelope.command, status: grantPermit ? 'claimed' : 'rejected', statusVersion: '4', error };
        return new Response(JSON.stringify({ code: 0, data: { command, executionPermit: grantPermit ? {
          claimId: 'new-claim', claimToken: 'new-token', claimUntil: new Date(Date.now() + 15000).toISOString(), statusVersion: '4',
        } : null } }));
      }
      return original(...args);
    });
    await bridge.reconcile();
    expect(execute).not.toHaveBeenCalled();
    expect(store.get<any>('inbox:command-1')).toMatchObject({ state: 'rejected', localSessionId: null, command: { status: 'rejected' } });
    const acknowledgements = requestApi.mock.calls.filter(([, pathname]) => pathname.endsWith('/ack'));
    if (grantPermit) expect(JSON.parse(String(acknowledgements[0][2].body))).toMatchObject({ status: 'rejected', claimId: 'new-claim', claimToken: 'new-token' });
    else expect(acknowledgements).toHaveLength(0);
    bridge.stop();
  });
});

function approvalFixture() {
  const result = fixture();
  const envelope: any = result.envelope;
  envelope.command.type = 'approval_response';
  envelope.request = { ...envelope.request, type: 'approval_response', sessionId: 'remote', payload: {
    runId: 'server-run', approvalId: 'approval', approvalVersion: '1', operationDigest: 'digest', decision: 'approve',
  } };
  envelope.requestHash = payloadHash(envelope.request);
  const original = result.requestApi.getMockImplementation()!;
  result.requestApi.mockImplementation(async (ownerArg, pathname, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (pathname.endsWith('/ack') && body.status === 'applied') {
      expect(body.result).toEqual({ outcome: 'approval_applied' });
      return new Response(JSON.stringify({ code: 0, data: { ...envelope.command, status: 'applied', statusVersion: '4' } }));
    }
    return original(ownerArg, pathname, init);
  });
  return result;
}
describe('dual approval command evidence', () => {
  it('maps a definitely rejected pre-dispatch decision to rejected while preserving the original claim', async () => {
    const { bridge, execute, store, requestApi } = approvalFixture();
    execute.mockRejectedValue(new RemoteApprovalError({ kind: 'known_not_applied', reason: 'NEVER_DISPATCHED' }));
    await bridge.claim();
    expect(store.get<InboxEntry>('inbox:command-1')).toMatchObject({ state: 'rejected', command: { claimId: 'claim', claimToken: 'secret' } });
    expect(requestApi.mock.calls.filter(call => call[1].endsWith('/ack')).map(call => JSON.parse(String(call[2].body)).status)).toEqual(['received', 'rejected']);
    bridge.stop();
  });
  it('keeps a dispatched timeout unknown and recovers a late confirmed result without another execute', async () => {
    const { bridge, execute, store, requestApi } = approvalFixture();
    execute.mockRejectedValue(new RemoteApprovalError({ kind: 'unknown', reason: 'RPC_TIMEOUT' }));
    await bridge.claim();
    expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('unknown');
    bridge.deps.reconcileApproval = vi.fn(async () => ({ kind: 'confirmed', decision: 'approve' }));
    await bridge.reconcile();
    const body = JSON.parse(String(requestApi.mock.calls.find(call => call[1].endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'applied', claimId: 'claim', claimToken: 'secret',
      result: { outcome: 'approval_applied' }, requestExecutionPermit: false });
    expect(execute).toHaveBeenCalledTimes(1); bridge.stop();
  });
  it('does not infer approval not_started from the containing run and never requests a replacement permit', async () => {
    const { bridge, disconnect, store, execute, requestApi } = approvalFixture(); disconnect();
    await bridge.claim();
    store.put('runPublished:server-run', false);
    bridge.deps.reconcileApproval = vi.fn(async () => null);
    await bridge.reconcile();
    const body = JSON.parse(String(requestApi.mock.calls.find(call => call[1].endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'unknown', requestExecutionPermit: false, localEvidence: null });
    expect(execute).not.toHaveBeenCalled(); bridge.stop();
  });
  it('reports a safely released reservation as not_applied on the original claim even when the run was published', async () => {
    const { bridge, execute, store, requestApi } = approvalFixture();
    execute.mockRejectedValue(new RemoteApprovalError({ kind: 'unknown', reason: 'RESULT_UNKNOWN' }));
    await bridge.claim(); store.put('runPublished:server-run', true);
    bridge.deps.reconcileApproval = vi.fn(async () => ({ kind: 'known_not_applied', reason: 'NEVER_DISPATCHED' }));
    await bridge.reconcile();
    const body = JSON.parse(String(requestApi.mock.calls.find(call => call[1].endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'not_applied', requestExecutionPermit: false, claimToken: 'secret',
      error: { code: 47007, reasonDetail: 'NEVER_DISPATCHED' } });
    expect(execute).toHaveBeenCalledTimes(1); bridge.stop();
  });
});
it('advertises verified dual approval support once and preserves projection/recovery when admission turns off', async () => {
  const { bridge, requestApi, store } = fixture();
  let enabled = true;
  bridge.deps.supportsDualApproval = () => true;
  bridge.deps.configureDualApproval = vi.fn();
  requestApi.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {
    enabled: true, protocolVersions: [1], capabilities: [RemoteCapability.SameAccountAccess, ...(enabled ? [RemoteCapability.DualApproval] : [])],
  } })));
  await bridge.refreshCapabilities();
  expect(bridge.advertisedCapabilities()).toContain(RemoteCapability.DualApproval);
  expect(bridge.deps.configureDualApproval).toHaveBeenLastCalledWith({ enabled: true, projectionSupported: true });
  store.put('controlQueue:10001:personal', []);
  await bridge.refreshCapabilities();
  expect(store.get<any[]>('controlQueue:10001:personal')).toEqual([]);
  enabled = false; await bridge.refreshCapabilities();
  expect(bridge.advertisedCapabilities()).toContain(RemoteCapability.DualApproval);
  expect(bridge.deps.configureDualApproval).toHaveBeenLastCalledWith({ enabled: false, projectionSupported: true });
  expect(store.get<any[]>('controlQueue:10001:personal')).toEqual([]);
  bridge.stop();
});
it('waits for verified Gateway readiness and discovers it automatically without an Agent catalog', async () => {
  const { bridge, requestApi } = fixture();
  let ready = false;
  bridge.deps.supportsDualApproval = () => ready;
  bridge.deps.configureDualApproval = vi.fn();
  requestApi.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {
    enabled: true, protocolVersions: [1], capabilities: [RemoteCapability.SameAccountAccess, RemoteCapability.DualApproval],
  } })));
  await bridge.refreshCapabilities();
  expect(bridge.advertisedCapabilities()).not.toContain(RemoteCapability.DualApproval);
  expect(bridge.deps.configureDualApproval).toHaveBeenLastCalledWith({ enabled: false, projectionSupported: false });
  bridge.writeSettings = vi.fn(async () => {}); bridge.reconcile = vi.fn(async () => {});
  bridge.syncSessions = vi.fn(async () => {}); bridge.claim = vi.fn(async () => {});
  bridge.socket = { close: vi.fn() };
  ready = true; bridge.lastCapabilityCheck = Date.now() - 45001;
  await bridge.tick();
  expect(bridge.advertisedCapabilities()).toContain(RemoteCapability.DualApproval);
  expect(bridge.deps.configureDualApproval).toHaveBeenLastCalledWith({ enabled: true, projectionSupported: true });
  // A lost Gateway can stop admission without falsely withdrawing implemented protocol support.
  ready = false; bridge.lastCapabilityCheck = Date.now() - 45001;
  await bridge.tick();
  expect(bridge.advertisedCapabilities()).toContain(RemoteCapability.DualApproval);
  expect(bridge.deps.configureDualApproval).toHaveBeenLastCalledWith({ enabled: false, projectionSupported: true });
  bridge.stop();
});
