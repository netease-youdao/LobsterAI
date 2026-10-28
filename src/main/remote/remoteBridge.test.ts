import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnershipSyncState, OwnershipTargetKind } from '../../shared/ownership/constants';
import { RemoteCapability, RemoteSyncHealthReason, RemoteSyncHealthStatus, RemoteSyncLaneStatus, RemoteSyncStatus } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteQuestion } from '../../shared/remote/questions';
import { RemoteReply } from '../../shared/remote/reply';
import { OwnershipAssociationStore } from '../ownershipAssociationStore';
import { payloadHash } from './canonical';
import { RemoteAgentError } from './remoteAgentCatalog';
import { RemoteApprovalError } from './remoteApproval';
import { type InboxEntry, RemoteApiError,RemoteBridge } from './remoteBridge';
import { RemoteDisplayHealthFailure, type RemoteDisplayHealthResult, RemoteDisplayHealthStatus } from './remoteDisplayHealth';
import { RemoteQuestionError } from './remoteQuestionService';
import { RemoteStore } from './remoteStore';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: (level: 'debug' | 'warn' | 'error' | 'info', message: string, fields: Record<string, unknown>) => console[level](message, fields) }));

const owner = { userId: '10001', scopeKey: 'personal' };
const databases: Database.Database[] = [];
type KnownDisplay = Extract<RemoteDisplayHealthResult, { status: typeof RemoteDisplayHealthStatus.Known }>;
function knownDisplay(overrides: Partial<KnownDisplay> = {}): KnownDisplay {
  return { status: RemoteDisplayHealthStatus.Known, observedAt: Date.now(), settings: null,
    pendingSettings: false, pendingName: false, catalogFailed: false,
    legacy: { pendingSessions: 0, oldest: null, lastSuccess: null }, availability: null, ...overrides };
}
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
  // In-memory fixtures cannot be opened by a worker; install an explicit display snapshot seam.
  let displayed: RemoteDisplayHealthResult | null = knownDisplay({ settings: bridge.settings() });
  const display = vi.spyOn(bridge.displaySnapshot, 'read').mockImplementation((key: unknown) => key ? displayed : null);
  const setDisplay = (value: RemoteDisplayHealthResult | null): void => { displayed = value; };
  return { store, bridge, envelope, calls, execute, requestApi, display, setDisplay,
    disconnect: () => { disconnectOnReceipt = true; }, terminalReceipt: () => { receiptStatus = 'applied'; } };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('remote command task admission', () => {
  it('does not claim new commands while shared execution evidence is unverified', async () => {
    const f = fixture(); f.store.setControlAdmission(() => false);
    expect(await f.bridge.claim()).toBe(false);
    expect(f.requestApi).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    f.bridge.stop();
  });
  it('does not recover commands when the physical database health check returns false', async () => {
    const f = fixture(); vi.spyOn(f.store, 'verifyExecutionDatabaseHealth').mockResolvedValue(false);
    await expect(f.bridge.reconcile()).rejects.toThrow('REMOTE_EXECUTION_DATABASE_UNHEALTHY');
    expect(f.requestApi).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); f.bridge.stop();
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
  it('reads only cached memory when SQLite throws and never converts unknown health into a disconnection', () => {
    const { bridge, store, setDisplay } = fixture(); bridge.lastPong = Date.now();
    const read = vi.spyOn(store.db, 'prepare').mockImplementation(() => { throw new Error('projection unavailable'); });
    const get = vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('state unavailable'); });
    try {
      expect(bridge.state()).toMatchObject({ connected: true, syncHealth: { status: RemoteSyncHealthStatus.Idle } });
      setDisplay({ status: RemoteDisplayHealthStatus.Unknown, observedAt: Date.now(), reason: RemoteDisplayHealthFailure.Unavailable });
      expect(bridge.state()).toMatchObject({ connected: true, connectionStatus: 'online', sessionSyncStatus: RemoteSyncStatus.Pending,
        syncHealth: { status: RemoteSyncHealthStatus.Degraded, reason: RemoteSyncHealthReason.StorageDependency, pendingSessions: null } });
      expect(read).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    } finally { read.mockRestore(); get.mockRestore(); bridge.stop(); }
  });
  it('uses the display owner cache for state while business mutations retain authoritative owner checks', async () => {
    const { bridge } = fixture(); bridge.lastPong = Date.now();
    bridge.deps.getDisplayOwner = () => owner;
    const getOwner = vi.spyOn(bridge.deps, 'getOwner').mockImplementation(() => { throw new Error('authoritative owner unavailable'); });
    try {
      expect(bridge.state()).toMatchObject({ owner, connected: true, syncHealth: { status: RemoteSyncHealthStatus.Idle } });
      expect(getOwner).not.toHaveBeenCalled();
      await expect(bridge.configure({ name: 'Requires authority' })).rejects.toThrow('authoritative owner unavailable');
      expect(getOwner).toHaveBeenCalledTimes(1);
    } finally { getOwner.mockRestore(); bridge.stop(); }
  });
  it.each(['pending', 'unknown'])('does not label %s statistics as synced while transport stays online', kind => {
    const { bridge, setDisplay } = fixture(); bridge.lastPong = Date.now();
    setDisplay(kind === 'pending' ? null : { status: RemoteDisplayHealthStatus.Unknown,
      observedAt: Date.now(), reason: RemoteDisplayHealthFailure.Unavailable });
    expect(bridge.state()).toMatchObject({ connected: true, settingsSyncStatus: RemoteSyncStatus.Pending,
      nameSyncStatus: RemoteSyncStatus.Pending, agentCatalogSyncStatus: RemoteSyncStatus.Pending, sessionSyncStatus: RemoteSyncStatus.Pending,
      syncHealth: { status: RemoteSyncHealthStatus.Degraded, statisticsUnavailable: true, pendingSessions: null, lastSuccessfulSyncAt: null } });
    bridge.stop();
  });
  it.each(['account', 'route', 'signout', 'owner-error', 'route-error'])('invalidates cached display data immediately after %s context changes', async change => {
    vi.useFakeTimers();
    const { bridge, display } = fixture(); bridge.lastPong = Date.now(); display.mockRestore();
    const produce = vi.spyOn(bridge.displaySnapshot.options, 'produce').mockResolvedValue(knownDisplay({
      legacy: { pendingSessions: 9, oldest: 1, lastSuccess: '2026-10-01T00:00:00.000Z' } }));
    try {
      expect(bridge.state().syncHealth.statisticsUnavailable).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.state()).toMatchObject({ name: 'Desktop', deviceId: 'desktop', syncHealth: { pendingSessions: 9 } });
      const nextOwner = { userId: 'another-owner', scopeKey: 'personal' };
      if (change === 'account') vi.spyOn(bridge.deps, 'getOwner').mockReturnValue(nextOwner);
      if (change === 'signout') vi.spyOn(bridge.deps, 'getOwner').mockReturnValue(null);
      if (change === 'route') vi.spyOn(bridge.deps, 'getApiBaseUrl').mockReturnValue('https://another.example');
      if (change === 'owner-error') vi.spyOn(bridge.deps, 'getOwner').mockImplementation(() => { throw new Error('owner unavailable'); });
      if (change === 'route-error') vi.spyOn(bridge.deps, 'getApiBaseUrl').mockImplementation(() => { throw new Error('route unavailable'); });
      expect(bridge.state()).toMatchObject({ connected: false, name: 'host', deviceId: undefined, workspaces: [], accessRequests: [],
        error: undefined, sessionSyncStatus: RemoteSyncStatus.Pending,
        syncHealth: { statisticsUnavailable: true, pendingSessions: null, lastSuccessfulSyncAt: null } });
      expect(produce).toHaveBeenCalledTimes(1);
    } finally { bridge.stop(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); vi.restoreAllMocks(); }
  });
  it('returns saved local settings immediately while the display sample is unavailable', async () => {
    const { bridge, store, setDisplay, requestApi } = fixture(); setDisplay(null);
    vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
    const saved = await bridge.configure({ enabled: false, name: 'Renamed desktop' });
    expect(saved).toMatchObject({ enabled: false, name: 'Renamed desktop', nameSyncStatus: RemoteSyncStatus.Pending,
      syncHealth: { status: RemoteSyncHealthStatus.Paused, statisticsUnavailable: true } });
    expect(store.get<any>('settings:10001:personal')).toMatchObject({ enabled: false, name: 'Renamed desktop' });
    expect(requestApi).not.toHaveBeenCalled();
    const read = vi.spyOn(store.db, 'prepare').mockImplementation(() => { throw new Error('unavailable'); });
    try {
      expect(bridge.state()).toMatchObject({ enabled: false, name: 'Renamed desktop' });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); bridge.stop(); }
  });
  it('refreshes the settings ACK while remote access is disabled without activating availability', async () => {
    vi.useFakeTimers();
    const { bridge, display, requestApi } = fixture(); display.mockRestore();
    vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
    const produce = vi.spyOn(bridge.displaySnapshot.options, 'produce').mockResolvedValue(knownDisplay({ settings: { enabled: false } }));
    const content = vi.spyOn(bridge.contentSnapshot, 'read');
    try {
      await bridge.configure({ enabled: false });
      expect(bridge.state().settingsSyncStatus).toBe(RemoteSyncStatus.Pending);
      await vi.advanceTimersByTimeAsync(0);
      expect(produce).toHaveBeenCalledOnce();
      expect(bridge.displayInput().availabilityScope).toBeNull();
      bridge.associationTaskSync({ kind: OwnershipTargetKind.Task, id: 'task' });
      expect(content).toHaveBeenCalledWith(null, 'task');
      expect(bridge.state()).toMatchObject({ enabled: false, connected: false, settingsSyncStatus: RemoteSyncStatus.Synced });
      expect(requestApi).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60000);
      expect(produce).toHaveBeenCalledOnce();
      expect(bridge.state().settingsSyncStatus).toBe(RemoteSyncStatus.Synced);
      bridge.queueControl({ ...bridge.settings(), createSessionAvailable: false });
      expect(bridge.state().settingsSyncStatus).toBe(RemoteSyncStatus.Pending);
      produce.mockResolvedValue(knownDisplay({ settings: { enabled: false }, pendingSettings: true }));
      await vi.advanceTimersByTimeAsync(0); expect(produce).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000); expect(produce).toHaveBeenCalledTimes(3);
      await bridge.configure({ enabled: true });
      expect(bridge.state().settingsSyncStatus).toBe(RemoteSyncStatus.Pending);
    } finally { bridge.stop(); vi.useRealTimers(); vi.restoreAllMocks(); }
  });
  it('keeps acknowledged desktop-only content separate from failed object health in the cached state', () => {
    const { bridge, setDisplay } = fixture(); bridge.lastPong = Date.now();
    const availability = { sessions: 1, pendingSessions: 0, degraded: false, oldest: null, lastSuccess: null,
      lanes: { live: RemoteSyncLaneStatus.Idle }, countsTruncated: false, desktopOnlySessions: 1 };
    setDisplay(knownDisplay({ availability }));
    expect(bridge.state()).toMatchObject({ connected: true, sessionSyncStatus: RemoteSyncStatus.Synced,
      syncHealth: { status: RemoteSyncHealthStatus.Idle, pendingSessions: 0, desktopOnlySessions: 1 } });
    setDisplay(knownDisplay({ availability: { ...availability, pendingSessions: 1, degraded: true },
      taskHealth: { failedSessions: 1, isolatedSessions: 1, retryingSessions: 0, taskIssues: [], taskIssuesTruncated: false } }));
    expect(bridge.state()).toMatchObject({ connected: true, sessionSyncStatus: RemoteSyncStatus.Error,
      syncHealth: { status: RemoteSyncHealthStatus.Degraded, failedSessions: 1, desktopOnlySessions: 1 } });
    setDisplay(null);
    expect(bridge.state().syncHealth).toMatchObject({ statisticsUnavailable: true, pendingSessions: null });
    expect(bridge.state().syncHealth.desktopOnlySessions).toBeUndefined(); bridge.stop();
  });
  it('uses v3 publication health independently of its fenced legacy outbox and historical failure', () => {
    const { bridge, store, setDisplay } = fixture(); store.setEnabledOwner(owner); bridge.lastPong = Date.now();
    store.transaction(() => { store.db.exec("INSERT INTO cowork_sessions VALUES('v3-task','Task',1,1,'idle')"); store.assignNew('v3-task', owner, 'local_create'); });
    expect(store.sync('v3-task')!.needs_snapshot).toBeTruthy(); bridge.sessionSyncFailed = true;
    setDisplay(knownDisplay({ availability: { sessions: 1, pendingSessions: 0, degraded: false, oldest: null, lastSuccess: null, lanes: {}, countsTruncated: false } }));
    expect(bridge.state()).toMatchObject({ connected: true, sessionSyncStatus: RemoteSyncStatus.Synced, syncHealth: { status: RemoteSyncHealthStatus.Idle, pendingSessions: 0 } });
    bridge.stop();
  });
  it('merges current-scope in-flight and backoff state without synchronous storage reads or false idle', () => {
    const { bridge, store, setDisplay } = fixture(); bridge.lastPong = Date.now(); bridge.targetId = 'current-target';
    const scope = `current-target:${owner.userId}:${owner.scopeKey}:desktop`;
    bridge.availability.controlDeadlines.set(`${scope}:control:task`, Date.now() + 1000);
    const read = vi.spyOn(store.db, 'prepare').mockImplementation(() => { throw new Error('database unavailable'); });
    const get = vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('state unavailable'); });
    const scan = vi.spyOn(bridge.availability, 'health').mockImplementation(() => { throw new Error('unexpected synchronous scan'); });
    try {
      expect(bridge.displayInput()).toMatchObject({ database: ':memory:', availabilityScope: scope });
      expect(bridge.state()).toMatchObject({ connected: true, syncHealth: { status: RemoteSyncHealthStatus.Syncing,
        pendingSessions: 1, lanes: { control: RemoteSyncLaneStatus.InFlight } } });
      bridge.availability.failures.set(`${scope}:live:task`, { count: 1, retryAt: Date.now() + 5000 });
      expect(bridge.state()).toMatchObject({ connected: true, sessionSyncStatus: RemoteSyncStatus.Error,
        syncHealth: { status: RemoteSyncHealthStatus.Degraded, pendingSessions: 1,
          lanes: { control: RemoteSyncLaneStatus.InFlight, live: RemoteSyncLaneStatus.Backoff } } });
      setDisplay(knownDisplay({ availability: { sessions: 1, pendingSessions: 0, degraded: false, oldest: null, lastSuccess: null,
        countsTruncated: false, lanes: { control: RemoteSyncLaneStatus.Unknown, live: RemoteSyncLaneStatus.Degraded, recovery: RemoteSyncLaneStatus.Degraded } } }));
      expect(bridge.state().syncHealth.lanes).toEqual({ control: RemoteSyncLaneStatus.Unknown, live: RemoteSyncLaneStatus.Degraded, recovery: RemoteSyncLaneStatus.Degraded });
      setDisplay(null);
      expect(bridge.state().syncHealth).toMatchObject({ status: RemoteSyncHealthStatus.Degraded, statisticsUnavailable: true, pendingSessions: null });
      expect(read).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
    } finally { read.mockRestore(); get.mockRestore(); scan.mockRestore(); bridge.stop(); }
  });
  it('does not let another environment, account or device transient failure contaminate current display health', () => {
    const { bridge, store } = fixture(); bridge.lastPong = Date.now(); bridge.targetId = 'current-target';
    for (const scope of [`other-target:${owner.userId}:${owner.scopeKey}:desktop`,
      `current-target:other-owner:${owner.scopeKey}:desktop`, `current-target:${owner.userId}:${owner.scopeKey}:other-device`]) {
      bridge.availability.controlDeadlines.set(`${scope}:control:task`, Date.now() + 1000);
      bridge.availability.failures.set(`${scope}:live:task`, { count: 1, retryAt: Date.now() + 5000 });
    }
    const read = vi.spyOn(store.db, 'prepare').mockImplementation(() => { throw new Error('database unavailable'); });
    const get = vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('state unavailable'); });
    try {
      expect(bridge.state()).toMatchObject({ connected: true, sessionSyncStatus: RemoteSyncStatus.Synced,
        syncHealth: { status: RemoteSyncHealthStatus.Idle, pendingSessions: 0, lanes: {} } });
      expect(read).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    } finally { read.mockRestore(); get.mockRestore(); bridge.stop(); }
  });
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
  it('reflects pending content and its ACK on the next display snapshot without a synchronous scan', () => {
    const { bridge, store, setDisplay } = fixture(); store.setEnabledOwner(owner); bridge.lastPong = Date.now();
    bridge.stopped = false;
    bridge.targetId = bridge.targets.activateLegacy({ owner, deviceId: 'desktop' }).targetId;
    try {
      store.transaction(() => {
        store.db.exec("INSERT INTO cowork_sessions VALUES('pending-task','Task',1,1,'idle')");
        store.assignNew('pending-task', owner, 'local_create');
      });
      expect(bridge.historyWork).toBeNull();
      setDisplay(knownDisplay({ legacy: { pendingSessions: 1, oldest: 1, lastSuccess: null } }));
      expect(bridge.state()).toMatchObject({ connected: true, syncHealth: { status: RemoteSyncHealthStatus.Syncing, pendingSessions: 1 } });
      const snapshot = store.snapshot('pending-task');
      const row = store.sync('pending-task')!;
      store.bindRemote('pending-task', row.session_id, 'desktop');
      store.acknowledge('pending-task', 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
      expect(bridge.state().syncHealth).toMatchObject({ status: RemoteSyncHealthStatus.Syncing, pendingSessions: 1 });
      setDisplay(knownDisplay());
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
    const { bridge, store, requestApi, warning, setDisplay } = syncing();
    const secret = 'private conversation and device credential';
    requestApi.mockRejectedValueOnce(new RemoteApiError(503, secret, { reason: 'TEMPORARILY_UNAVAILABLE', accessToken: secret }, 503));
    await bridge.syncSessions();
    const failure = store.get<any>('syncFailure:sync-task');
    expect(failure.code).toBe(503);
    expect(store.get('import:sync-task')).not.toBeNull();
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'sync-task' })).toBe(OwnershipSyncState.Failed);
    setDisplay(knownDisplay({ taskHealth: { failedSessions: 1, retryingSessions: 1, isolatedSessions: 0, taskIssues: [], taskIssuesTruncated: false } }));
    expect(bridge.state()).toMatchObject({ error: undefined, errorCode: undefined, sessionSyncStatus: RemoteSyncStatus.Error });
    expect(warning.mock.calls.filter(([message]) => message === '[RemoteSync] Session synchronization failed')).toHaveLength(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('accessToken');
    expireTaskRetry(bridge, store);

    await bridge.syncSessions();
    expect(store.get('syncFailure:sync-task')).toBeNull();
    expect(store.get('import:sync-task')).toBeNull();
    expect(store.pending('sync-task')).toEqual([]);
    expect(bridge.associationSyncState({ kind: OwnershipTargetKind.Task, id: 'sync-task' })).toBe(OwnershipSyncState.Synced);
    setDisplay(knownDisplay());
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

  it('persists a deferred failure after storage recovery before resuming the original task', async () => {
    const { bridge, store, requestApi } = syncing();
    requestApi.mockRejectedValueOnce(new RemoteApiError(503, 'Temporary transport failure', null, 503));
    vi.spyOn(bridge.taskSync, 'fail').mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); });
    await bridge.syncSessions();
    expect(bridge.taskMemoryBlocks.size).toBe(1);
    expect(bridge.state().syncHealth.reason).toBe(RemoteSyncHealthReason.StorageDependency);
    const operation = store.get<any>('import:sync-task');
    expect(operation).not.toBeNull();
    const sent = requestApi.mock.calls.length;
    bridge.taskMemoryBlocks.get('sync-task').retryAt = 0;
    await bridge.syncSessions();
    expect(bridge.taskMemoryBlocks.size).toBe(0);
    expect(bridge.taskSync.get(bridge.taskContext(), 'sync-task').phase).toBe('backoff');
    expect(store.get<any>('import:sync-task').importId).toBe(operation.importId);
    expect(requestApi).toHaveBeenCalledTimes(sent);
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
    const { bridge, store, setDisplay } = syncing();
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
    currentOwner = { userId: '20002', scopeKey: 'personal' }; setDisplay(null);
    bridge.accountChanged();
    expect(bridge.state().sessionSyncStatus).toBe(RemoteSyncStatus.Pending);
    releaseFence();
    await sync;
    expect(bridge.state()).toMatchObject({ owner: currentOwner, sessionSyncStatus: RemoteSyncStatus.Pending });
    expect(store.get('syncFailure:sync-task')).toEqual(failure);
  });

  it('retains the synchronization summary while another owned task still has a failure', async () => {
    const { bridge, store, requestApi, setDisplay } = syncing();
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
    setDisplay(knownDisplay({ taskHealth: { failedSessions: 1, retryingSessions: 1, isolatedSessions: 0, taskIssues: [], taskIssuesTruncated: false } }));
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
    const { bridge, store, setDisplay } = fixture();
    expect(bridge.state().enabled).toBe(true);
    setDisplay(null);
    const read = vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('cache unavailable'); });
    expect(bridge.state()).toMatchObject({ enabled: true, connected: false, syncHealth: { status: 'degraded', reason: 'storage_dependency', pendingSessions: null } });
    expect(read).not.toHaveBeenCalled(); read.mockRestore(); bridge.stop();
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


describe('bounded command recovery and claim fairness', () => {
  function multiFixture() {
    const f = fixture();
    const commands = ['a', 'b', 'c'].map(id => {
      const request = { ...f.envelope.request, commandId: `command-${id}` };
      return { ...f.envelope, command: { ...f.envelope.command, commandId: request.commandId, sessionId: `remote-${id}`, runId: `run-${id}` },
        request, requestHash: payloadHash(request) };
    });
    f.bridge.deps.prepare = (command: any) => {
      const localId = `local-${command.sessionId}`;
      if (!f.store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(localId)) {
        f.store.db.prepare('INSERT INTO cowork_sessions VALUES (?,?,1,1,?)').run(localId, 'task', 'idle');
        f.store.assignNew(localId, owner, 'remote_command');
      }
      return { localSessionId: localId, remoteSessionId: command.sessionId, runId: command.runId };
    };
    f.execute.mockImplementation(async (_entry, permitted) => { expect(permitted()).toBe(true); return { outcome: 'started' }; });
    let ack: (id: string, status: string) => Promise<void> = async () => {};
    f.requestApi.mockImplementation(async (_owner, pathname, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      let data: any;
      if (pathname.endsWith('/commands/claim')) data = { items: commands };
      else if (pathname.includes('/commands?')) data = { items: commands, nextCursor: null };
      else if (pathname.endsWith('/ack')) {
        const envelope = commands.find(item => pathname.includes(`/${item.command.commandId}/`))!;
        await ack(envelope.command.commandId, body.status);
        data = { ...envelope.command, status: body.status, statusVersion: body.status === 'received' ? '3' : '4' };
      } else throw new Error(`Unexpected ${pathname}`);
      return new Response(JSON.stringify({ code: 0, message: 'success', data }));
    });
    return { ...f, commands, setAck: (next: typeof ack) => { ack = next; } };
  }
  it('allows B and C to execute while A is waiting for its received ACK', async () => {
    const f = multiFixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.setAck(async (id, status) => { if (id === 'command-a' && status === 'received') await held; });
    const work = f.bridge.claim();
    try {
      await vi.waitFor(() => expect(f.execute.mock.calls.map(([entry]) => entry.command.commandId)).toEqual(['command-b', 'command-c']));
      expect(f.store.get<InboxEntry>('inbox:command-a')?.state).toBe('prepared');
    } finally { release(); await work; f.bridge.stop(); }
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it('serializes two commands for one task and never overlaps its runner starts', async () => {
    const f = multiFixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.commands[1].command.sessionId = f.commands[0].command.sessionId;
    let bReceived = false;
    f.setAck(async (id, status) => {
      if (id === 'command-a' && status === 'received') await held;
      if (id === 'command-b' && status === 'received') bReceived = true;
    });
    const work = f.bridge.claim();
    try {
      await vi.waitFor(() => expect(f.execute.mock.calls.some(([entry]) => entry.command.commandId === 'command-c')).toBe(true));
      expect(bReceived).toBe(false);
    } finally { release(); await work; f.bridge.stop(); }
    expect(f.execute.mock.calls.map(([entry]) => entry.command.commandId)).toEqual(['command-c', 'command-a', 'command-b']);
  });
  it('does not isolate an authentication failure as one bad task or execute queued work', async () => {
    const f = multiFixture();
    f.setAck(async () => { throw new RemoteApiError(401, 'expired', null, 401); });
    await expect(f.bridge.claim()).rejects.toMatchObject({ code: 401 });
    expect(f.bridge.generation).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
    expect(f.bridge.commandTaskRetryAt.size).toBe(0); f.bridge.stop();
  });
  it('keeps a slow reconciliation single-flight without waiting before claiming', async () => {
    const f = multiFixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reconcile = vi.spyOn(f.bridge, 'reconcile').mockImplementation(() => held);
    for (const method of ['schedule', 'ensureAccount', 'startDeletionSync', 'startInputRecovery', 'startOptionalPublications', 'startHistorySync', 'syncFiles'])
      vi.spyOn(f.bridge, method).mockImplementation(() => undefined);
    for (const method of ['ensureRegistration', 'ensureDefaultWorkspace', 'refreshCapabilities', 'writeSettings', 'connect'])
      vi.spyOn(f.bridge, method).mockResolvedValue(undefined);
    try {
      await f.bridge.tick();
      expect(f.execute).toHaveBeenCalledTimes(3);
      f.bridge.commandPollAt = 0; await f.bridge.tick();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(f.execute).toHaveBeenCalledTimes(3); // Duplicate claims still require reconciliation.
    } finally { release(); await f.bridge.reconcileWork; f.bridge.stop(); }
  });
  it('ignores an old connection recovery failure after a new connection is established', async () => {
    const f = multiFixture(); let reject!: (error: unknown) => void;
    f.requestApi.mockImplementation(async () => await new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
    f.bridge.startCommandReconciliation();
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    const work = f.bridge.reconcileWork;
    f.bridge.generation = '2'; f.bridge.unresolvedCursor = 'new-cursor';
    reject(new RemoteApiError(401, 'old request expired', null, 401)); await work;
    expect(f.bridge.generation).toBe('2'); expect(f.bridge.unresolvedCursor).toBe('new-cursor');
    expect(f.bridge.reconcileRetryAt).toBe(0); expect(f.bridge.commandRetryAt).toBe(0); f.bridge.stop();
  });
  it('backs off one recovery task without skipping its durable unknown evidence', async () => {
    const f = multiFixture(); const attempted: string[] = [];
    const recover = async (envelope: any) => { attempted.push(envelope.command.commandId); if (envelope.command.commandId === 'command-a') throw new Error('bad task record'); };
    await f.bridge.commandBatch(f.commands, recover, true);
    await f.bridge.commandBatch(f.commands, recover, true);
    expect(attempted.filter(id => id === 'command-a')).toHaveLength(1);
    expect(attempted.filter(id => id === 'command-b')).toHaveLength(2);
    expect(f.execute).not.toHaveBeenCalled(); f.bridge.stop();
  });
});

describe('isolated command recovery compatibility', () => {
  it('negotiates v4 and retains unreadable execution evidence while reconciling healthy rows', async () => {
    const f = fixture();
    await f.bridge.claim();
    const saved = f.store.get<InboxEntry>('inbox:command-1')!;
    f.store.put('inbox:unreadable', { ...saved, state: 'unknown', command: { ...saved.command, commandId: 'unreadable' } });
    const before = f.store.get('inbox:unreadable');
    f.bridge.capabilitySnapshot = { capabilities: [RemoteCapability.IsolatedCommandRecovery] };
    const original = f.requestApi.getMockImplementation()!;
    f.requestApi.mockImplementation(async (owner, pathname, init) => {
      if (pathname.startsWith('/api/remote/v4/') && pathname.includes('/commands/unresolved?')) {
        expect(init.headers['X-Remote-Connection-Generation']).toBe('1');
        return new Response(JSON.stringify({ code: 0, data: { items: [f.envelope],
          unresolvedItems: [{ commandId: 'unreadable', sessionId: 'remote', diagnostic: { kind: 'stored_data_unavailable' } }],
          nextCursor: null, scanComplete: true } }));
      }
      return original(owner, pathname, init);
    });
    const callsBefore = f.requestApi.mock.calls.filter(([, pathname]) => pathname.endsWith('/reconcile')).length;
    await f.bridge.reconcile();
    expect(f.requestApi.mock.calls.filter(([, pathname]) => pathname.endsWith('/reconcile')).length).toBeGreaterThan(callsBefore);
    expect(f.store.get('inbox:unreadable')).toEqual(before); f.bridge.stop();
  });
  it('restarts the signed cursor for a new connection and falls back to v1 for an old server', async () => {
    const f = fixture(); f.bridge.capabilitySnapshot = { capabilities: [RemoteCapability.IsolatedCommandRecovery] };
    const paths: string[] = [];
    f.requestApi.mockImplementation(async (_owner, pathname) => {
      paths.push(pathname);
      return new Response(JSON.stringify({ code: 0, data: { items: [], unresolvedItems: [], nextCursor: 'signed-next', scanComplete: false } }));
    });
    await f.bridge.reconcile(); f.bridge.generation = '2'; await f.bridge.reconcile();
    expect(paths).toHaveLength(2); expect(paths.every(path => !path.includes('cursor='))).toBe(true);
    f.bridge.capabilitySnapshot = { capabilities: [] };
    await f.bridge.reconcile();
    expect(paths[2]).toContain('/api/remote/v1/devices/desktop/commands?state=unresolved');
    expect(paths[2]).not.toContain('cursor='); f.bridge.stop();
  });
});
