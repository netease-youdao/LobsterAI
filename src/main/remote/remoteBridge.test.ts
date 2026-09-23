import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnershipSyncState, OwnershipTargetKind } from '../../shared/ownership/constants';
import { RemoteCapability, RemoteSyncHealthReason, RemoteSyncHealthStatus, RemoteSyncStatus } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteQuestion } from '../../shared/remote/questions';
import { RemoteReply } from '../../shared/remote/reply';
import { OwnershipAssociationStore } from '../ownershipAssociationStore';
import { payloadHash } from './canonical';
import { RemoteAgentError } from './remoteAgentCatalog';
import { RemoteApprovalError } from './remoteApproval';
import { type InboxEntry, RemoteApiError,RemoteBridge } from './remoteBridge';
import { RemoteQuestionError } from './remoteQuestionService';
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
    runSessionTransaction: <T>(operation: () => T) => store.transaction(operation),
    getOwner: () => owner, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request: requestApi,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: () => { store.db.prepare("INSERT INTO cowork_sessions VALUES ('local','hello',1,1,'idle')").run(); store.assignNew('local', owner, 'remote_command'); return { localSessionId: 'local', remoteSessionId: 'remote', runId: command.runId }; },
    execute, onAccountChange: vi.fn(),
  });
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' }; bridge.generation = '1'; bridge.sameAccountAccess = true;
  store.put('settings:10001:personal', { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [{ workspaceId: 'workspace', name: 'Folder', path: '/work', available: true }] });
  return { store, bridge, envelope, calls, execute, requestApi, disconnect: () => { disconnectOnReceipt = true; }, terminalReceipt: () => { receiptStatus = 'applied'; } };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('remote command task admission', () => {
  it('does not claim new commands while shared execution evidence is unverified', async () => {
    const f = fixture(); f.store.setControlAdmission(() => false);
    expect(await f.bridge.claim()).toBe(false);
    expect(f.requestApi).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    f.bridge.stop();
  });
  it('preserves a claimed command without preparing an unadmitted existing task', async () => {
    const f = fixture();
    f.store.transaction(() => {
      f.store.db.exec("INSERT INTO cowork_sessions VALUES('existing','Existing',1,1,'idle')");
      f.store.assignNew('existing', owner, 'local_create'); f.store.bindRemote('existing', 'remote', 'desktop');
    });
    f.store.setTaskAdmission(id => id !== 'existing');
    const prepare = vi.spyOn(f.bridge.deps, 'prepare');
    await f.bridge.claim();
    expect(prepare).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.get('inbox:command-1')).toMatchObject({ state: 'unknown', localSessionId: 'existing', command: { claimId: 'claim', claimToken: 'secret' } });
    await f.bridge.reconcile();
    const body = JSON.parse(String(f.requestApi.mock.calls.find(([, pathname]) => pathname.endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'unknown', requestExecutionPermit: false, localEvidence: null });
    expect(prepare).not.toHaveBeenCalled(); f.bridge.stop();
  });
  it('requires admission after a newly created task is bound and before execution', async () => {
    const f = fixture(); f.store.setTaskAdmission(() => false);
    await f.bridge.claim();
    expect(f.store.sync('local')?.session_id).toBe('remote');
    expect(f.store.get('inbox:command-1')).toMatchObject({ state: 'prepared' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.requestApi.mock.calls.some(([, pathname]) => pathname.endsWith('/ack'))).toBe(false);
    f.bridge.stop();
  });
  it('checks admission again after persisting the executing journal', async () => {
    const f = fixture();
    f.bridge.deps.security = { commit: async (_id: string, _operation: unknown, apply: () => void) => { apply(); f.store.setTaskAdmission(() => false); } };
    await f.bridge.claim();
    expect(f.store.get('inbox:command-1')).toMatchObject({ state: 'executing' });
    expect(f.execute).not.toHaveBeenCalled();
    f.bridge.stop();
  });
  it('does not reconstruct a lost claim or infer not-started for an unadmitted task', async () => {
    const f = fixture();
    f.store.transaction(() => {
      f.store.db.exec("INSERT INTO cowork_sessions VALUES('existing','Existing',1,1,'idle')");
      f.store.assignNew('existing', owner, 'local_create'); f.store.bindRemote('existing', 'remote', 'desktop');
    });
    f.store.setTaskAdmission(() => false); (f.envelope as any).currentClaimId = 'lost-claim';
    const prepare = vi.spyOn(f.bridge.deps, 'prepare');
    await f.bridge.reconcile();
    expect(prepare).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    const body = JSON.parse(String(f.requestApi.mock.calls.find(([, pathname]) => pathname.endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'unknown', requestExecutionPermit: false });
    expect(f.store.get('inbox:command-1')).toBeNull(); f.bridge.stop();
  });
  it('reconciles a factual applied result even when further execution is blocked', async () => {
    const f = fixture(); await f.bridge.claim();
    const saved = f.store.get<InboxEntry>('inbox:command-1')!;
    f.store.setControlAdmission(() => false); f.store.setTaskAdmission(() => false);
    await f.bridge.reconcile();
    const body = JSON.parse(String(f.requestApi.mock.calls.find(([, pathname]) => pathname.endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'applied', result: saved.result, requestExecutionPermit: false });
    expect(f.execute).toHaveBeenCalledTimes(1); f.bridge.stop();
  });
});

describe('device synchronization health', () => {
  it('keeps an online idle device idle during and after an empty history scan', async () => {
    const { bridge, store, requestApi } = fixture();
    bridge.stopped = false; bridge.lastPong = Date.now();
    let release!: () => void;
    const scan = vi.spyOn(store, 'flushProjections').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      expect(bridge.state()).toMatchObject({ connected: true, syncHealth: { status: RemoteSyncHealthStatus.Idle, pendingSessions: 0 } });
      bridge.startHistorySync();
      const work = bridge.historyWork;
      expect(work).toBeInstanceOf(Promise);
      expect(bridge.state()).toMatchObject({ connected: true, syncHealth: { status: RemoteSyncHealthStatus.Idle, pendingSessions: 0 } });
      release(); await work;
      expect(bridge.state().syncHealth.status).toBe(RemoteSyncHealthStatus.Idle);
      expect(requestApi).not.toHaveBeenCalled();
    } finally {
      release?.(); await bridge.historyWork; scan.mockRestore(); bridge.stop();
    }
  });
  it('reports real pending content until its ACK even with no history scan in progress', () => {
    const { bridge, store } = fixture(); store.setEnabledOwner(owner); bridge.lastPong = Date.now();
    try {
      store.transaction(() => {
        store.db.exec("INSERT INTO cowork_sessions VALUES('pending-task','Task',1,1,'idle')");
        store.assignNew('pending-task', owner, 'local_create');
      });
      expect(bridge.historyWork).toBeNull();
      expect(bridge.state()).toMatchObject({ connected: true, syncHealth: { status: RemoteSyncHealthStatus.Syncing, pendingSessions: 1 } });
      const snapshot = store.snapshot('pending-task');
      const row = store.sync('pending-task')!;
      store.bindRemote('pending-task', row.session_id, 'desktop');
      store.acknowledge('pending-task', 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
      expect(bridge.state().syncHealth).toMatchObject({ status: RemoteSyncHealthStatus.Idle, pendingSessions: 0 });
    } finally { bridge.stop(); }
  });
  it('continues to surface pending files and failures independently of the history scheduler', () => {
    const { bridge } = fixture(); bridge.lastPong = Date.now();
    try {
      bridge.files = { health: () => ({ pending: 1, degraded: false }), pause: (): void => undefined };
      expect(bridge.state().syncHealth.status).toBe(RemoteSyncHealthStatus.Syncing);
      bridge.files = { health: () => ({ pending: 1, degraded: true }), pause: (): void => undefined };
      expect(bridge.state().syncHealth).toMatchObject({ status: RemoteSyncHealthStatus.Degraded, reason: RemoteSyncHealthReason.Files });
      bridge.sessionSyncFailed = true;
      expect(bridge.state().syncHealth).toMatchObject({ status: RemoteSyncHealthStatus.Degraded, reason: RemoteSyncHealthReason.Projection });
    } finally { bridge.stop(); }
  });
});

describe('ownership association synchronization', () => {
  function claimed() {
    const value = fixture();
    value.bridge.targetId = RemoteEnvironment.Test;
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
    bridge.ownershipClaimCapability = { environment: RemoteEnvironment.Test, owner, enabled: true };
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
    bridge.ownershipClaimCapability = { environment: RemoteEnvironment.Test, owner, enabled: true };
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

describe('session synchronization recovery', () => {
  const bridges: RemoteBridge[] = [];
  afterEach(() => { for (const bridge of bridges.splice(0)) bridge.stop(); vi.restoreAllMocks(); });

  function syncing(beginCommitted = false) {
    const value = fixture();
    const { bridge, store, requestApi } = value;
    const target = bridge.targets.activateLegacy({ owner, deviceId: 'desktop', allowPartialLegacy: true });
    bridge.targetId = target.targetId;
    store.setProjectionIdentity(target.targetId, owner, 'desktop');
    store.setFileEnvironment(target.targetId);
    bridges.push(bridge); store.setWake(() => {}); store.setEnabledOwner(owner);
    store.transaction(() => {
      store.db.prepare("INSERT INTO cowork_sessions VALUES ('sync-task','History',1,1,'idle')").run();
      store.assignNew('sync-task', owner, 'local_create');
    });
    store.snapshot('sync-task');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestApi.mockImplementation(async (_owner, pathname) => {
      const saved = store.get<any>('import:sync-task')!;
      const receipt = { sessionId: saved.sessionId, committedSourceSeq: saved.baseSourceSeq, committedSeq: '1', stateVersion: '1' };
      let data: any;
      if (pathname.endsWith('/sync/imports')) data = { ...receipt, state: beginCommitted ? 'committed' : 'uploading' };
      else if (pathname.endsWith('/commit')) data = { ...receipt, state: 'committed' };
      else if (pathname.includes('/parts/')) data = {};
      else throw new Error(`Unexpected synchronization request ${pathname}`);
      return new Response(JSON.stringify({ code: 0, message: 'success', data }));
    });
    return { ...value, warning };
  }

  function expireTaskRetry(bridge: any, store: RemoteStore, id = 'sync-task'): void {
    const context = bridge.taskContext();
    store.db.prepare(`UPDATE remote_sync_task_state SET next_retry_at=0,server_retry_at=0
      WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`)
      .run(context.owner.userId, context.owner.scopeKey, context.target, context.deviceId, id);
  }

  function acknowledgeSnapshot(store: RemoteStore): void {
    const snapshot = store.snapshot('sync-task');
    const row = store.sync('sync-task')!;
    store.bindRemote('sync-task', row.session_id, 'desktop');
    store.acknowledge('sync-task', 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
  }

  it('clears a failed import after a later commit and logs no sensitive error content', async () => {
    const { bridge, store, requestApi, warning } = syncing();
    const secret = 'private conversation and device credential';
    requestApi.mockRejectedValueOnce(new RemoteApiError(503, secret, { reason: 'TEMPORARILY_UNAVAILABLE', accessToken: secret }, 503));
    await bridge.syncSessions();
    const failure = store.get<any>('syncFailure:sync-task');
    expect(failure.code).toBe(503);
    expect(store.get('import:sync-task')).not.toBeNull();
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'sync-task' })).toBe(OwnershipSyncState.Failed);
    expect(bridge.state()).toMatchObject({ error: undefined, errorCode: undefined, sessionSyncStatus: RemoteSyncStatus.Error });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('accessToken');
    expireTaskRetry(bridge, store);

    await bridge.syncSessions();
    expect(store.get('syncFailure:sync-task')).toBeNull();
    expect(store.get('import:sync-task')).toBeNull();
    expect(store.pending('sync-task')).toEqual([]);
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'sync-task' })).toBe(OwnershipSyncState.Synced);
    expect(bridge.state()).toMatchObject({ error: undefined, errorCode: undefined, sessionSyncStatus: RemoteSyncStatus.Synced });
  });

  it('preserves quota dependency waits and original imports across an explicit reconnect', async () => {
    const { bridge, store, requestApi } = syncing();
    vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
    requestApi.mockRejectedValueOnce(new RemoteApiError(47012, 'quota exceeded', { reason: 'REPLY_CONTENT_QUOTA_EXCEEDED' }, 413));
    await bridge.syncSessions();
    const saved = store.get<any>('import:sync-task');
    const failure = store.get<any>('syncFailure:sync-task');
    store.put('syncFailure:sync-task', { ...failure, retryAt: 0 });
    await bridge.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(1);
    expect(store.get<any>('import:sync-task')?.importId).toBe(saved.importId);
    await bridge.configure({ retry: true });
    await bridge.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(1);
    expect(store.get<any>('syncFailure:sync-task')?.code).toBe(47012);
    expect(store.get<any>('import:sync-task')?.importId).toBe(saved.importId);
    expect(bridge.taskSync.get(bridge.taskContext(), 'sync-task').phase).toBe('waiting_dependency');
  });

  for (const change of ['stop', 'account', 'projection'] as const) it(`stops a snapshot publication when ${change} changes after content upload`, async () => {
    const { bridge, store, requestApi } = syncing();
    vi.spyOn(bridge, 'uploadReplyContents').mockImplementation(async () => {
      if (change === 'stop') bridge.stop();
      else if (change === 'account') bridge.deps.getOwner = () => ({ userId: 'other', scopeKey: 'personal' });
      else bridge.projectionVersion = 4;
    });
    await bridge.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(1);
    expect(requestApi.mock.calls[0][1]).toBe('/api/remote/v1/sync/imports');
    expect(store.get<any>('import:sync-task')?.beginConfirmed).toBe(true);
    expect(store.sync('sync-task')!.ack_seq).toBe(0);
  });

  for (const localExists of [true, false]) it(`stops retrying a remotely deleted session while preserving its local state (local exists: ${localExists})`, async () => {
    const { bridge, store, requestApi } = syncing();
    store.transaction(() => {
      store.db.prepare("INSERT INTO cowork_messages VALUES ('retained-message','sync-task','assistant','Keep local content',NULL,1,1)").run();
      store.project('sync-task');
    });
    if (!localExists) {
      store.transaction(() => { store.db.prepare('DELETE FROM cowork_sessions WHERE id=?').run('sync-task'); store.project('sync-task'); });
    }
    const pending = store.pending('sync-task');
    const before = store.sync('sync-task')!;
    const messages = store.db.prepare('SELECT * FROM cowork_messages WHERE session_id=?').all('sync-task');
    requestApi.mockRejectedValueOnce(new RemoteApiError(47010, 'Session deleted', { reason: 'SESSION_DELETED' }, 410));
    await bridge.syncSessions();
    const savedImport = store.get('import:sync-task');
    expect(savedImport).not.toBeNull();
    expect(store.get('syncFailure:sync-task')).toMatchObject({ code: 47010, httpStatus: 410, reason: 'SESSION_DELETED', blocked: true });
    await bridge.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(1);

    const restarted: any = new RemoteBridge(bridge.deps); bridges.push(restarted);
    restarted.owner = owner; restarted.registration = { ...bridge.registration }; restarted.generation = '1'; restarted.targetId = bridge.targetId;
    await restarted.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(1);
    expect(store.pending('sync-task')).toEqual(pending);
    expect(store.sync('sync-task')).toMatchObject({ session_id: before.session_id, ack_seq: before.ack_seq, source_seq: before.source_seq });
    expect(store.get('import:sync-task')).toEqual(savedImport);
    expect(!!store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get('sync-task')).toBe(localExists);
    expect(store.db.prepare('SELECT * FROM cowork_messages WHERE session_id=?').all('sync-task')).toEqual(messages);

    store.transaction(() => {
      store.db.prepare("INSERT INTO cowork_sessions VALUES ('healthy-task','Other',1,1,'idle')").run();
      store.assignNew('healthy-task', owner, 'local_create');
    });
    requestApi.mockImplementation(async (_owner, pathname) => {
      const saved = store.get<any>('import:healthy-task')!;
      expect(saved).not.toBeNull();
      const data = { sessionId: saved.sessionId, committedSourceSeq: saved.baseSourceSeq, committedSeq: '1', stateVersion: '1', state: 'committed' };
      expect(pathname).toBe('/api/remote/v1/sync/imports');
      return new Response(JSON.stringify({ code: 0, data }));
    });
    await restarted.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(2);
    expect(store.sync('healthy-task')!.ack_seq).toBe(store.sync('healthy-task')!.source_seq);
    expect(store.get('syncFailure:healthy-task')).toBeNull();
    expect(store.get('import:sync-task')).toEqual(savedImport);
    expect(store.pending('sync-task')).toEqual(pending);
  });

  for (const failure of [
    new RemoteApiError(47010, 'Other error', { reason: 'OTHER_REASON' }, 410),
    new RemoteApiError(47019, 'Other error', { reason: 'SESSION_DELETED' }, 410),
    new RemoteApiError(47010, 'Other error', { reason: 'SESSION_DELETED' }, 503),
  ]) it(`never closes the stream on non-deletion errors (${failure.code}/${failure.httpStatus}/${failure.data.reason})`, async () => {
    const { bridge, store, requestApi } = syncing(true);
    requestApi.mockRejectedValueOnce(failure);
    await bridge.syncSessions();
    const saved = store.get<any>('syncFailure:sync-task');
    const retryable = failure.httpStatus >= 500;
    expect(bridge.taskSync.get(bridge.taskContext(), 'sync-task').phase).toBe(retryable ? 'backoff' : 'isolated');
    const originalImport = store.get<any>('import:sync-task');
    expireTaskRetry(bridge, store);
    await bridge.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(retryable ? 2 : 1);
    if (retryable) expect(store.get('syncFailure:sync-task')).toBeNull();
    else {
      expect(store.get('syncFailure:sync-task')).toEqual(saved);
      expect(store.get<any>('import:sync-task')?.importId).toBe(originalImport.importId);
    }
  });

  it('clears a previous failure when begin returns an already committed import', async () => {
    const { bridge, store, requestApi } = syncing(true);
    requestApi.mockRejectedValueOnce(new RemoteApiError(503, 'Begin acknowledgement was lost', null, 503));
    await bridge.syncSessions();
    const saved = store.get<any>('import:sync-task');
    expireTaskRetry(bridge, store);

    await bridge.syncSessions();
    expect(requestApi).toHaveBeenCalledTimes(2);
    expect(requestApi.mock.calls.every(call => call[1].endsWith('/sync/imports'))).toBe(true);
    expect(store.sync('sync-task')!.ack_seq).toBe(Number(saved.baseSourceSeq));
    expect(store.get('syncFailure:sync-task')).toBeNull();
    expect(store.get('import:sync-task')).toBeNull();
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'sync-task' })).toBe(OwnershipSyncState.Synced);
    expect(bridge.state()).toMatchObject({ error: undefined, errorCode: undefined, sessionSyncStatus: RemoteSyncStatus.Synced });
  });

  for (const failureAt of ['commit', 'ack'] as const) it(`preserves the failed import and outbox when ${failureAt} fails`, async () => {
    const { bridge, store, requestApi } = syncing();
    const successfulRequest = requestApi.getMockImplementation()!;
    requestApi.mockImplementation(async (actor, pathname, init) => {
      if (pathname.endsWith('/commit')) {
        if (failureAt === 'commit') throw new RemoteApiError(47025, 'Commit baseline changed');
        return new Response(JSON.stringify({ code: 0, data: { committedSourceSeq: '999', committedSeq: '1' } }));
      }
      return successfulRequest(actor, pathname, init);
    });
    store.put('syncFailure:sync-task', { code: 47019, retryAt: 0 });
    const pending = store.pending('sync-task');
    const before = store.sync('sync-task')!;
    // A malformed import receipt pauses that session without failing the independent control lane.
    await bridge.syncSessions();

    if (failureAt === 'commit') expect(store.get<any>('syncFailure:sync-task')?.code).toBe(47025);
    else expect(bridge.taskSync.get(bridge.taskContext(), 'sync-task')?.phase).toBe('isolated');
    expect(store.get<any>('import:sync-task')?.beginConfirmed).toBe(true);
    expect(store.pending('sync-task')).toEqual(pending);
    expect(store.sync('sync-task')!.ack_seq).toBe(before.ack_seq);
    expect(store.sync('sync-task')!.needs_snapshot).toBe(1);
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'sync-task' })).toBe(OwnershipSyncState.Failed);
  });

  it('repairs an old failure marker on an acknowledged task before its retry deadline', async () => {
    const { bridge, store, requestApi } = syncing();
    acknowledgeSnapshot(store);
    bridge.sessionSyncFailed = true;
    store.put('syncFailure:sync-task', { code: 47019, retryAt: Date.now() + 60000 });

    await bridge.syncSessions();
    expect(requestApi).not.toHaveBeenCalled();
    expect(store.get('syncFailure:sync-task')).toBeNull();
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'sync-task' })).toBe(OwnershipSyncState.Synced);
    expect(bridge.state()).toMatchObject({ error: undefined, errorCode: undefined, sessionSyncStatus: RemoteSyncStatus.Synced });
  });

  it('does not restore the previous account synchronization warning after a pending retention fence finishes', async () => {
    const { bridge, store } = syncing();
    const failure = { code: 47019, blocked: true };
    store.put('syncFailure:sync-task', failure);
    bridge.sessionSyncFailed = true;
    let currentOwner = owner;
    vi.spyOn(bridge.deps, 'getOwner').mockImplementation(() => currentOwner);
    vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
    let releaseFence!: () => void;
    const pendingFence = new Promise<void>(resolve => { releaseFence = resolve; });
    const fence = vi.spyOn(bridge, 'ensureRetentionFence').mockReturnValue(pendingFence);
    const sync = bridge.syncSessions();
    await vi.waitFor(() => expect(fence).toHaveBeenCalledTimes(1));
    currentOwner = { userId: '20002', scopeKey: 'personal' };
    bridge.accountChanged();
    expect(bridge.state().sessionSyncStatus).toBe(RemoteSyncStatus.Synced);
    releaseFence();
    await sync;
    expect(bridge.state()).toMatchObject({ owner: currentOwner, sessionSyncStatus: RemoteSyncStatus.Synced });
    expect(store.get('syncFailure:sync-task')).toEqual(failure);
  });

  it('retains the synchronization summary while another owned task still has a failure', async () => {
    const { bridge, store, requestApi } = syncing();
    acknowledgeSnapshot(store);
    store.transaction(() => {
      store.db.prepare("INSERT INTO cowork_sessions VALUES ('other-task','Other',1,1,'idle')").run();
      store.assignNew('other-task', owner, 'local_create');
    });
    const failure = { code: 47019, retryAt: Date.now() + 60000 };
    store.put('syncFailure:sync-task', failure);
    store.put('syncFailure:other-task', failure);
    bridge.sessionSyncFailed = true;

    await bridge.syncSessions();
    expect(requestApi).not.toHaveBeenCalled();
    expect(store.get('syncFailure:sync-task')).toBeNull();
    expect(store.get('syncFailure:other-task')).toEqual(failure);
    expect(bridge.state()).toMatchObject({ error: undefined, errorCode: undefined, sessionSyncStatus: RemoteSyncStatus.Error });
  });

  for (const pendingState of ['snapshot', 'source', 'dirty', 'import', 'outbox', 'device'] as const) {
    it(`keeps an old failure marker while ${pendingState} still needs recovery`, async () => {
      const { bridge, store, requestApi } = syncing();
      acknowledgeSnapshot(store);
      if (pendingState === 'snapshot') store.requireSnapshot('sync-task');
      if (pendingState === 'source') store.db.prepare('UPDATE remote_sync SET source_seq=source_seq+1 WHERE local_id=?').run('sync-task');
      if (pendingState === 'dirty') {
        // Keep queued dirt visible while isolating the failure cleanup guard from admission transactions.
        vi.spyOn(bridge, 'ownershipSyncBlocked').mockReturnValue(false);
        store.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run('sync-task');
      }
      if (pendingState === 'import') store.put('import:sync-task', { importId: 'pending' });
      if (pendingState === 'outbox') store.db.prepare('INSERT INTO remote_outbox VALUES (?,1,?)').run('sync-task', JSON.stringify({ sourceSeq: '1' }));
      if (pendingState === 'device') store.bindRemote('sync-task', store.sync('sync-task')!.session_id, 'other-device');
      const failure = { code: 47019, retryAt: Date.now() + 60000 };
      store.put('syncFailure:sync-task', failure);

      await bridge.syncSessions();
      expect(requestApi).not.toHaveBeenCalled();
      expect(store.get('syncFailure:sync-task')).toEqual(failure);
    });
  }
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
      vi.spyOn(bridge, 'refreshCapabilities').mockResolvedValue(undefined);
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


describe('v4 reply negotiation', () => {
  it('enables replies only with both the projection version and capability, then rebuilds on downgrade', async () => {
    const { bridge, store, requestApi } = fixture();
    requestApi.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {
      enabled: true, protocolVersions: [1], projectionVersions: [1, 2, 3, 4], capabilities: [RemoteCapability.SameAccountAccess, RemoteReply.Capability],
    } })));
    await bridge.refreshCapabilities();
    expect(bridge.projectionVersion).toBe(RemoteReply.ProjectionVersion);
    expect(bridge.advertisedCapabilities()).toContain(RemoteReply.Capability);
    requestApi.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {
      enabled: true, protocolVersions: [1], projectionVersions: [1, 2, 3], capabilities: [RemoteCapability.SameAccountAccess, RemoteReply.Capability],
    } })));
    await bridge.refreshCapabilities();
    expect(bridge.projectionVersion).toBe(1);
    expect(bridge.advertisedCapabilities()).not.toContain(RemoteReply.Capability);
    expect(store).toBeDefined(); bridge.stop();
  });
  it('aborts an outstanding old projection import before rebuilding a v4 snapshot', async () => {
    const { bridge, store, requestApi } = fixture();
    bridge.replySupported = true; bridge.projectionVersion = RemoteReply.ProjectionVersion;
    store.db.exec("INSERT INTO cowork_sessions VALUES ('switch','Task',1,1,'idle')");
    store.transaction(() => { store.assignNew('switch', owner, 'local_create'); store.bindRemote('switch', 'remote-switch', 'desktop'); });
    const saved = { importId: 'old-import', sessionId: 'remote-switch', projectionVersion: 3, beginConfirmed: true,
      snapshotEpoch: 1, parts: [], manifest: { recordCounts: {} } };
    store.put('import:switch', saved);
    const paths: string[] = [];
    requestApi.mockImplementation(async (_owner, pathname) => {
      paths.push(pathname);
      return new Response(JSON.stringify({ code: 0, data: pathname.endsWith('/abort') ? { state: 'aborted' } : { state: 'uploading', stateVersion: '3' } }));
    });
    await bridge.importSession(store.sync('switch'), saved);
    expect(paths).toEqual(['/api/remote/v1/sync/imports/old-import', '/api/remote/v1/sync/imports/old-import/abort']);
    expect(store.get('import:switch')).toBeNull();
    expect(store.sync('switch')?.needs_snapshot).toBe(1); bridge.stop();
  });
});

describe('history and command lane isolation', () => {
  it('claims and applies a command while a history upload remains unresolved', async () => {
    const { bridge, execute } = fixture();
    let release!: () => void;
    const history = vi.spyOn(bridge, 'syncSessions').mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    bridge.startHistorySync();
    expect(history).toHaveBeenCalledOnce();
    await bridge.claim();
    expect(execute).toHaveBeenCalledOnce();
    expect(bridge.historyWork).not.toBeNull();
    release(); await bridge.historyWork; bridge.stop();
  });
  it('preserves same-account switch intent and reports unknown when status storage reads fail', () => {
    const { bridge, store } = fixture();
    expect(bridge.state().enabled).toBe(true);
    const read = vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('cache unavailable'); });
    expect(bridge.state()).toMatchObject({ enabled: true, connected: false, syncHealth: { status: 'degraded', reason: 'storage_dependency', pendingSessions: null } });
    read.mockRestore(); bridge.stop();
  });
});


function questionFixture() {
  const result = fixture(), envelope: any = result.envelope;
  envelope.command.type = RemoteQuestion.Command;
  envelope.request = { ...envelope.request, type: RemoteQuestion.Command, sessionId: 'remote', payload: {
    runId: 'server-run', questionId: 'question', questionVersion: '1', operationDigest: 'digest', action: 'answer', answers: { q_0: ['Yes'] },
  } };
  envelope.requestHash = payloadHash(envelope.request);
  return result;
}
describe('question command receipts and capability negotiation', () => {
  it('rejects a proven no-send failure with the original claim and question error contract', async () => {
    const f = questionFixture();
    f.execute.mockRejectedValue(new RemoteQuestionError({ kind: 'known_not_applied', reason: 'QUESTION_CHANGED' }));
    await f.bridge.claim();
    expect(f.store.get<InboxEntry>('inbox:command-1')).toMatchObject({ state: 'rejected', command: { claimId: 'claim', claimToken: 'secret' },
      result: { code: 47024, reason: 'COMMAND_STATE_CONFLICT', reasonDetail: 'QUESTION_CHANGED' } });
    f.bridge.stop();
  });
  it('keeps an uncertain answer unknown and applies a later exact receipt without replay', async () => {
    const f = questionFixture();
    f.execute.mockRejectedValue(new RemoteQuestionError({ kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' }));
    await f.bridge.claim();
    f.bridge.deps.reconcileQuestion = vi.fn(async () => ({ kind: 'confirmed', status: 'answered' }));
    await f.bridge.reconcile();
    const body = JSON.parse(String(f.requestApi.mock.calls.find(call => call[1].endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'applied', claimId: 'claim', claimToken: 'secret', result: { outcome: 'question_applied' }, requestExecutionPermit: false });
    expect(f.execute).toHaveBeenCalledTimes(1); f.bridge.stop();
  });
  it('converges only an existing question receipt while device synchronization is paused', async () => {
    const f = questionFixture();
    f.execute.mockRejectedValue(new RemoteQuestionError({ kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' }));
    await f.bridge.claim();
    f.bridge.connectionRemoved = true;
    f.bridge.deps.reconcileQuestion = vi.fn(async () => ({ kind: 'confirmed', status: 'answered' }));
    await f.bridge.reconcilePaused();
    const body = JSON.parse(String(f.requestApi.mock.calls.find(call => call[1].endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ mode: 'recovery', observedExecution: 'applied', result: { outcome: 'question_applied' }, requestExecutionPermit: false });
    expect(f.execute).toHaveBeenCalledTimes(1); f.bridge.stop();
  });
  it('never derives question execution from containing run evidence or asks for a fresh permit', async () => {
    const f = questionFixture(); f.disconnect();
    await f.bridge.claim(); f.store.put('runPublished:server-run', false);
    f.bridge.deps.reconcileQuestion = vi.fn(async () => null);
    await f.bridge.reconcile();
    const body = JSON.parse(String(f.requestApi.mock.calls.find(call => call[1].endsWith('/reconcile'))![2].body));
    expect(body).toMatchObject({ observedExecution: 'unknown', requestExecutionPermit: false, localEvidence: null });
    expect(f.execute).not.toHaveBeenCalled(); f.bridge.stop();
  });
  it('negotiates outer v5 only with question support and keeps reply content on its own v4 capability', async () => {
    const f = fixture(); f.bridge.deps.supportsQuestions = () => true;
    let enabled = true;
    f.requestApi.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {
      enabled: true, protocolVersions: [1], projectionVersions: enabled ? [1, 2, 3, 4, 5] : [1, 2, 3, 4],
      capabilities: [RemoteCapability.SameAccountAccess, RemoteReply.Capability, RemoteQuestion.Capability],
    } })));
    await f.bridge.refreshCapabilities();
    expect(f.bridge.projectionVersion).toBe(5); expect(f.bridge.replySupported).toBe(true);
    expect(f.bridge.advertisedCapabilities()).toContain(RemoteQuestion.Capability);
    enabled = false; await f.bridge.refreshCapabilities();
    expect(f.bridge.projectionVersion).toBe(4); expect(f.bridge.questionsSupported).toBe(false);
    expect(f.bridge.advertisedCapabilities()).toContain(RemoteQuestion.Capability);
    f.bridge.stop();
  });
});


describe('independent reply format inside question projection v5', () => {
  it.each([true, undefined])('aborts a prior inner reply format (%s) before rebuilding an unchanged v5 envelope', async replyProjection => {
    const { bridge, store, requestApi } = fixture();
    bridge.replySupported = false; bridge.questionsSupported = true; bridge.projectionVersion = 5;
    store.db.exec("INSERT INTO cowork_sessions VALUES ('switch','Task',1,1,'idle')");
    store.transaction(() => { store.assignNew('switch', owner, 'local_create'); store.bindRemote('switch', 'remote-switch', 'desktop'); });
    const saved = { importId: 'old-v5-import', sessionId: 'remote-switch', projectionVersion: 5,
      ...(replyProjection === undefined ? {} : { replyProjection }), beginConfirmed: true,
      snapshotEpoch: 1, parts: [], manifest: { recordCounts: {} } };
    store.put('import:switch', saved);
    const paths: string[] = [];
    requestApi.mockImplementation(async (_owner, pathname) => {
      paths.push(pathname);
      return new Response(JSON.stringify({ code: 0, data: pathname.endsWith('/abort') ? { state: 'aborted' } : { state: 'uploading', stateVersion: '3' } }));
    });
    await bridge.importSession(store.sync('switch'), saved);
    expect(paths).toEqual(['/api/remote/v1/sync/imports/old-v5-import', '/api/remote/v1/sync/imports/old-v5-import/abort']);
    expect(store.get('import:switch')).toBeNull(); expect(store.sync('switch')?.needs_snapshot).toBe(1);
    bridge.stop();
  });
  it('retains the device protocol declaration after server admission is switched off', async () => {
    const f = fixture(); f.bridge.deps.supportsQuestions = () => true;
    let admitted = true;
    f.requestApi.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {
      enabled: true, protocolVersions: [1], projectionVersions: [1, 2, 3, 4, 5],
      capabilities: [RemoteCapability.SameAccountAccess, ...(admitted ? [RemoteQuestion.Capability] : [])],
    } })));
    await f.bridge.refreshCapabilities(); expect(f.bridge.questionsSupported).toBe(true);
    admitted = false; await f.bridge.refreshCapabilities();
    expect(f.bridge.questionsSupported).toBe(false); expect(f.bridge.advertisedCapabilities()).toContain(RemoteQuestion.Capability);
    expect(f.store.get('questionCapability:10001:personal')).toBe(true); f.bridge.stop();
  });
  it('invalidates an in-flight sync context when only the inner reply format changes', () => {
    const { bridge } = fixture(); bridge.projectionVersion = 5; bridge.replySupported = true;
    const current = bridge.syncContext(); expect(current()).toBe(true);
    bridge.replySupported = false; expect(current()).toBe(false); bridge.stop();
  });
});
