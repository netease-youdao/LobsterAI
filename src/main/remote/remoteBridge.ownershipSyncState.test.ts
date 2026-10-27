import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnershipSyncState, OwnershipTargetKind } from '../../shared/ownership/constants';
import { RemoteConnectionReasonCode } from '../../shared/remote/connections';
import { REMOTE_DEVICE_RETIRED_CODE, RemoteConnectionReason } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteSyncTarget } from '../../shared/remote/syncTarget';
import { recordAvailabilityObjectHealth } from './remoteAvailabilityHealth';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const target = { kind: OwnershipTargetKind.Task, id: 'task' };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  let route = 'https://service.example';
  let routeEpoch = 1;
  let account = owner;
  const request = vi.fn();
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'db' },
    runSessionTransaction: <T>(operation: () => T) => store.transaction(operation),
    getOwner: () => account, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => route, getRouteEpoch: () => routeEpoch,
    request, metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: () => ({ localSessionId: 'task', remoteSessionId: 'remote', runId: null }), execute: vi.fn(), onAccountChange: vi.fn(),
  });
  cleanup.push(() => { bridge.stop(); db.close(); });
  bridge.owner = owner;
  bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  store.put('settings:10001:personal', { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [] });
  const activation = bridge.targets.activateLegacy({ owner, deviceId: 'desktop', allowPartialLegacy: true });
  bridge.targetId = activation.targetId;
  store.setEnabledOwner(owner);
  store.setProjectionIdentity(activation.targetId, owner, 'desktop');
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('task','Task',1,1,'completed')");
    store.assignNew('task', owner, 'local_create');
  });
  const ack = () => {
    const snapshot = store.snapshot('task'), row = store.sync('task')!;
    store.bindRemote('task', row.session_id, 'desktop');
    store.acknowledge('task', 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
  };
  const unavailable = () => bridge.recordConnectionFailure(new RemoteApiError(47003, 'Service not ready', { reason: 'DEVICE_NOT_READY' }, 503));
  return { bridge, store, ack, unavailable, request, route: (value: string) => { route = value; },
    routeEpoch: (value: number) => { routeEpoch = value; }, account: (value: typeof owner) => { account = value; } };
}

describe('task detail synchronization state', () => {
  it('distinguishes initial registration from an unavailable service without changing persisted work', () => {
    const f = fixture(); f.bridge.registration = null;
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    const before = f.store.sync('task');
    f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
    expect(f.store.sync('task')).toEqual(before);
  });
  it('keeps an ACK for the verified target synced during a temporary connection failure', () => {
    const f = fixture(); f.ack(); f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Synced);
  });
  it('reports a pending upload blocked by service failure instead of ordinary pending', () => {
    const f = fixture(); f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('does not reuse an old ACK when current registration is unknown', () => {
    const f = fixture(); f.ack(); f.bridge.registration = null; f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('does not reuse an ACK after registration but before target verification completes', () => {
    const f = fixture(); f.ack(); f.bridge.targetId = null;
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('does not reuse an old ACK or connection error while the API route is changing', () => {
    const f = fixture(); f.ack(); f.unavailable(); f.route('https://new-service.example');
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
  });
  it('hides old connection state and ACKs after same-URL ABA before bridge account notification', () => {
    const f = fixture(); f.ack(); f.unavailable();
    f.bridge.generation = 'connection'; f.bridge.lastPong = Date.now();
    f.bridge.error = 'Old route failure'; f.bridge.errorCode = 47003;
    expect(f.bridge.state()).toMatchObject({ connected: true, deviceId: 'desktop', error: 'Old route failure', errorCode: 47003 });
    const before = f.store.sync('task');
    f.routeEpoch(3);
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    expect(f.bridge.state()).toMatchObject({ connected: false, deviceId: undefined, error: undefined, errorCode: undefined,
      connectionReason: RemoteConnectionReason.Connecting });
    expect(f.store.sync('task')).toEqual(before);
  });
  it.each([
    ['removed', 409, { reason: RemoteConnectionReasonCode.Removed, connectionVersion: '2' }],
    ['retired', REMOTE_DEVICE_RETIRED_CODE, null],
    ['target changed', RemoteSyncTarget.ChangedCode, null],
  ] as const)('ignores a delayed %s transport rejection after same-URL ABA', async (_name, code, data) => {
    const f = fixture(); f.ack();
    let reject!: (reason: unknown) => void;
    f.request.mockReturnValue(new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    f.bridge.generation = 'connection'; f.bridge.lastPong = Date.now();
    const ensureAccount = vi.spyOn(f.bridge, 'ensureAccount'), disconnect = vi.spyOn(f.bridge, 'disconnect');
    const before = { registration: f.bridge.registration, targetId: f.bridge.targetId, reason: f.bridge.connectionReason,
      persisted: f.store.db.prepare('SELECT * FROM remote_state ORDER BY key').all(), sync: f.store.sync('task') };
    const pending = f.bridge.api('/devices/desktop/heartbeat', 'POST');
    expect(f.request).toHaveBeenCalledTimes(1);
    f.routeEpoch(3);
    const failure = new RemoteApiError(code, 'Old route rejection', data);
    const rejected = expect(pending).rejects.toBe(failure);
    reject(failure);
    await rejected;
    expect(ensureAccount).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
    expect(f.bridge.registration).toBe(before.registration); expect(f.bridge.targetId).toBe(before.targetId);
    expect(f.bridge.generation).toBe('connection'); expect(f.bridge.connectionReason).toBe(before.reason);
    expect(f.bridge.connectionRemoved).toBe(false); expect(f.bridge.suspended).toBe(false);
    expect(f.bridge.error).toBeUndefined(); expect(f.bridge.errorCode).toBeUndefined();
    expect(f.store.db.prepare('SELECT * FROM remote_state ORDER BY key').all()).toEqual(before.persisted);
    expect(f.store.sync('task')).toEqual(before.sync);
  });
  it('does not present another target ACK or failure as the current target state', () => {
    const f = fixture(); f.ack(); f.bridge.targetId = 'other-target';
    f.store.put('syncFailure:task', { code: 47019 });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('reports a local projection failure and returns to synced after recovery', () => {
    const f = fixture(); f.ack();
    f.store.db.prepare('INSERT INTO remote_projection_failures VALUES(?,?,?,?)').run('task', 'REMOTE_PROJECTION_BUDGET', Number.MAX_SAFE_INTEGER, 1);
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Failed);
    f.store.db.prepare('DELETE FROM remote_projection_failures WHERE session_id=?').run('task');
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Synced);
  });
  it('distinguishes a real desktop-only ACK, new pending content and an object fault in task detail', () => {
    const f = fixture(); f.ack();
    const scope = `${f.bridge.targetId}:${owner.userId}:${owner.scopeKey}:desktop`;
    const row = f.store.sync('task')!;
    const revision = (f.store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get('task') as { revision: number } | undefined)?.revision || 1;
    f.bridge.availability.ledger.saveSession({ scope, localId: 'task', sessionId: row.session_id, deviceId: 'desktop', owner,
      writerGeneration: 'writer', phase: 'active', controlEpoch: 'epoch', operationId: 'operation', pendingCommandIds: [], pendingRunIds: [],
      controlRevision: String(revision), factSeq: '0', records: {} });
    f.store.transaction(() => f.store.db.prepare("INSERT INTO cowork_messages VALUES('message','task','assistant','content','{}',1,1)").run());
    const sourceRevision = (f.store.db.prepare('SELECT revision FROM remote_live_revisions WHERE session_id=? AND object_id=?').get('task', 'message') as { revision: number } | undefined)?.revision || 1;
    recordAvailabilityObjectHealth(f.store, scope, 'task', 'message:message', String(sourceRevision), 'desktop_only');
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Partial);
    f.store.transaction(() => f.store.db.prepare('UPDATE remote_live_revisions SET revision=? WHERE session_id=? AND object_id=?').run(sourceRevision + 1, 'task', 'message'));
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    recordAvailabilityObjectHealth(f.store, scope, 'task', 'message:message', String(sourceRevision + 1), 'complete');
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Synced);
    f.bridge.availability.ledger.objectFault(scope, 'task', 'message:message', 'fingerprint');
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Failed);
  });
  it('does not expose a different account or scope synchronization state', () => {
    const f = fixture(); f.ack(); f.unavailable();
    f.account({ ...owner, scopeKey: 'team:another' });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Local);
    f.account({ userId: 'another-user', scopeKey: 'personal' });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Local);
  });
  it('does not label intentionally disabled synchronization as a service outage', () => {
    const f = fixture(); f.bridge.registration = null; f.unavailable();
    f.store.put(f.bridge.settingsKey(), { enabled: false, name: 'Desktop', settingsVersion: '1', workspaces: [] });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
  });
});

describe('ownership task retry routing', () => {
  function isolatedTask() {
    const f = fixture();
    f.bridge.schedule = () => undefined;
    const context = f.bridge.taskContext();
    f.bridge.taskSync.fail(context, 'task', { phase: 'isolated', scope: 'session', reason: 'REMOTE_BATCH_ACK_INVALID' });
    f.store.put('syncFailure:task', { blocked: true, code: 47019 });
    return { ...f, context };
  }
  it('routes availability-owned task retries through bounded object recovery and respects cooldown rejection', async () => {
    const f = fixture(); f.ack();
    vi.spyOn(f.bridge.availability, 'ownsHistory').mockReturnValue(true);
    const live = vi.spyOn(f.bridge.availability, 'retryLive').mockReturnValue(true);
    const legacy = vi.spyOn(f.bridge.taskSync, 'manualRetry');
    const before = f.store.sync('task');
    await expect(f.bridge.configure({ retrySessionId: 'task' })).resolves.toBeDefined();
    expect(live).toHaveBeenCalledWith('task'); expect(legacy).not.toHaveBeenCalled();
    expect(f.store.sync('task')).toEqual(before);
    live.mockReturnValue(false);
    await expect(f.bridge.configure({ retrySessionId: 'task' })).rejects.toThrow('Task synchronization retry is unavailable');
    expect(legacy).not.toHaveBeenCalled(); expect(f.store.sync('task')).toEqual(before);
  });
  it('continues ordinary reconnect scheduling when optional live recovery storage fails', async () => {
    const f = fixture(); f.ack(); f.unavailable();
    const schedule = vi.spyOn(f.bridge, 'schedule').mockImplementation(() => undefined);
    const disconnect = vi.spyOn(f.bridge, 'disconnect');
    const live = vi.spyOn(f.bridge.availability, 'retryLive').mockImplementation(() => { throw Object.assign(new Error('Storage unavailable'), { code: 'SQLITE_BUSY' }); });
    await expect(f.bridge.configure({ retry: true })).resolves.toBeDefined();
    expect(live).toHaveBeenCalledWith(); expect(disconnect).toHaveBeenCalled(); expect(schedule).toHaveBeenCalledWith(0);
    expect(f.bridge.connectionReason).toBe(RemoteConnectionReason.Reconnecting);
    expect(f.bridge.error).toBeUndefined();
  });
  it('keeps task safety blocks intact during a global reconnect', async () => {
    const f = isolatedTask(), before = f.bridge.taskSync.get(f.context, 'task');
    await f.bridge.configure({ retry: true });
    expect(f.bridge.taskSync.get(f.context, 'task')).toEqual(before);
    expect(f.bridge.taskSync.eligible(f.context, 'task')).toBe(false);
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Failed);
  });
  it('schedules the identified task for reconciliation without clearing its failure evidence or granting an ACK', async () => {
    const f = isolatedTask(), before = f.store.sync('task');
    await f.bridge.configure({ retrySessionId: 'task' });
    expect(f.bridge.taskSync.get(f.context, 'task').phase).toBe('reconciling');
    expect(f.bridge.taskSync.eligible(f.context, 'task')).toBe(true);
    expect(f.store.get('syncFailure:task')).toEqual({ blocked: true, code: 47019 });
    expect(f.store.sync('task')).toEqual(before);
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Failed);
  });
});


describe('task detail readonly snapshot path', () => {
  it('returns unknown before sampling and never runs the synchronous per-task health reader', () => {
    const f = fixture(); f.ack();
    const heavy = vi.spyOn(f.bridge.availability, 'sessionHealth').mockImplementation(() => { throw new Error('heavy'); });
    vi.spyOn(f.bridge.contentSnapshot, 'read').mockReturnValue(null);
    expect(f.bridge.associationTaskSync(target)).toEqual({ syncState: OwnershipSyncState.Pending,
      contentSync: { state: 'unknown', reason: 'unavailable', retryable: false } });
    expect(heavy).not.toHaveBeenCalled();
  });
  it('uses current target cache only, expires old observations and suppresses retry when disconnected', () => {
    const f = fixture(); f.ack();
    const sample = { observedAt: Date.now(), syncState: OwnershipSyncState.Failed,
      contentSync: { state: 'failed', reason: 'content', retryable: true } };
    const read = vi.spyOn(f.bridge.contentSnapshot, 'read').mockReturnValue(sample);
    expect(f.bridge.associationTaskSync(target).contentSync.retryable).toBe(false);
    f.bridge.generation = 'connection';
    expect(f.bridge.associationTaskSync(target).contentSync.retryable).toBe(true);
    read.mockReturnValue({ ...sample, observedAt: Date.now() - 16000 });
    expect(f.bridge.associationTaskSync(target).contentSync.state).toBe('unknown');
    read.mockReturnValue(sample); f.route('https://different.example');
    expect(f.bridge.associationTaskSync(target).contentSync.state).toBe('unknown');
    expect(read).toHaveBeenLastCalledWith(null, 'task');
  });
});
