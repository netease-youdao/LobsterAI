import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteInputReason } from '../../shared/remote/input';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { RemoteNetworkError } from './remoteNetworkError';
import { RemoteNetworkFailure } from './remoteNetworkProtocol';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'isolation-owner', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks(); vi.useRealTimers(); });
const ok = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));
function fixture() {
  const db = new Database(':memory:'); dispose.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  const request = vi.fn(async (_owner, path, init) => {
    const body = JSON.parse(String(init.body));
    if (path.endsWith('/sync/batches')) return ok({ batchId: body.batchId, deviceId: body.deviceId, sessionId: body.sessionId,
      committedSourceSeq: body.events.at(-1).sourceSeq, committedSeq: '2' });
    throw new Error('Unexpected test request');
  });
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'install', deviceKey: 'key', databaseId: 'db' },
    runSessionTransaction: operation => store.transaction(operation), getOwner: () => owner,
    getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.invalid', request,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    execute: vi.fn(), prepare: vi.fn(), onAccountChange: vi.fn(),
  });
  dispose.push(() => bridge.stop());
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.generation = '1'; bridge.sameAccountAccess = true;
  store.put(`settings:${owner.userId}:${owner.scopeKey}`, { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [] });
  const target = bridge.targets.activateLegacy({ owner, deviceId: 'desktop', allowPartialLegacy: true });
  bridge.targetId = target.targetId;
  store.setProjectionIdentity(target.targetId, owner, 'desktop'); store.setFileEnvironment(target.targetId);
  store.setWake(() => {}); store.setEnabledOwner(owner);
  vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  const add = (id: string): void => {
    store.transaction(() => {
      db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?)').run(id, id, 'idle');
      store.assignNew(id, owner, 'local_create');
    });
    const snapshot = store.snapshot(id), row = store.sync(id)!;
    store.bindRemote(id, row.session_id, 'desktop');
    store.acknowledge(id, 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
    store.transaction(() => {
      db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,NULL,2,1)').run(`${id}-message`, id, 'assistant', 'Preserve this content');
      store.project(id);
    });
  };
  const acknowledged = (id: string): boolean => store.sync(id)!.source_seq === store.sync(id)!.ack_seq;
  return { db, store, bridge, request, add, acknowledged };
}

describe('history wake deadlines', () => {
  function scheduledFixture() {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-08T10:12:27Z'));
    const f = fixture();
    f.bridge.schedule.mockRestore();
    // Exercise the real history scheduler while the command lane remains idle.
    const tick = vi.spyOn(f.bridge, 'tick').mockImplementation(async () => { f.bridge.startHistorySync(); });
    return { ...f, tick };
  }
  it('publishes after a five-second projection deferral without waiting for the idle command poll', async () => {
    const f = scheduledFixture(); f.add('tail');
    vi.spyOn(f.store, 'projectionPublishing').mockReturnValueOnce(true).mockReturnValue(false);
    f.bridge.schedule(30000); f.bridge.startHistorySync(); await f.bridge.historyWork;
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'tail').next_retry_at).toBe(Date.now() + 5000);
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4999); expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await f.bridge.historyWork;
    expect(f.acknowledged('tail')).toBe(true); expect(f.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.tick).toHaveBeenCalledOnce(); expect(f.request).toHaveBeenCalledOnce();
  });
  it('wakes when an asynchronous projection publishes after an empty history scan', async () => {
    const f = scheduledFixture(); f.add('tail');
    f.bridge.startHistorySync(); await f.bridge.historyWork; expect(f.acknowledged('tail')).toBe(true);
    f.request.mockClear();
    let release!: () => void;
    vi.spyOn(f.store, 'flushProjections').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    f.bridge.startHistorySync(); await f.bridge.historyWork;
    expect(vi.getTimerCount()).toBe(0);
    f.store.transaction(() => {
      f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,NULL,3,2)').run('tail-final', 'tail', 'assistant', 'Final text');
      f.store.project('tail');
    });
    release(); await f.bridge.projectionWork;
    await vi.advanceTimersByTimeAsync(500); await f.bridge.historyWork;
    expect(f.acknowledged('tail')).toBe(true); expect(f.request).toHaveBeenCalledOnce();
  });
  it('preserves future server and service retry bounds without an idle hot loop', async () => {
    const f = scheduledFixture(); f.add('tail');
    const context = f.bridge.taskContext(), now = Date.now();
    f.bridge.taskSync.fail(context, 'tail', { phase: 'backoff', scope: 'service', reason: 'TRANSPORT', retryAfterMs: 90000 });
    f.bridge.historyRetryAt = now + 100000;
    f.bridge.scheduleHistorySync(f.bridge.syncContext());
    await vi.advanceTimersByTimeAsync(99999); expect(f.request).not.toHaveBeenCalled(); expect(f.tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await f.bridge.historyWork;
    expect(f.acknowledged('tail')).toBe(true); expect(f.request).toHaveBeenCalledOnce();
    f.bridge.startHistorySync(); await f.bridge.historyWork; await f.bridge.projectionWork;
    await vi.advanceTimersByTimeAsync(60000); expect(f.tick).toHaveBeenCalledOnce();
  });
  it.each(['stopped', 'account', 'projection'] as const)('does not wake from a stale projection context: %s', async reason => {
    const f = scheduledFixture();
    const current = f.bridge.syncContext();
    f.add('tail'); f.bridge.taskSync.defer(f.bridge.taskContext(), 'tail', 5000);
    if (reason === 'stopped') f.bridge.stop();
    else if (reason === 'account') f.bridge.accountGeneration++;
    else f.bridge.projectionVersion++;
    f.bridge.scheduleHistorySync(current);
    expect(vi.getTimerCount()).toBe(0); expect(f.request).not.toHaveBeenCalled();
  });
});

describe('task synchronization isolation', () => {
  it.each([false, true].flatMap(conflict => [
    { conflict, reason: 'REMOTE_TASK_SYNC_FAILED', probe: 0 },
    { conflict, reason: RemoteInputReason.Version, probe: 1 },
  ]))('verifies the original stream before resuming $reason (conflict: $conflict)', async ({ conflict, reason, probe }) => {
    const f = fixture(); f.add('legacy-isolated');
    const context = f.bridge.taskContext(), row = f.store.sync('legacy-isolated')!;
    f.bridge.taskSync.fail(context, row.local_id, { phase: 'isolated', scope: 'session', reason });
    f.db.prepare('UPDATE remote_sync_task_state SET recovery_probe_version=? WHERE local_session_id=?').run(probe, row.local_id);
    f.store.put(`syncFailure:${row.local_id}`, { blocked: true, reason });
    const original = f.store.pending(row.local_id), usual = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (actor, pathname, init) => {
      if (pathname.includes('/sync/state?')) return ok({ deviceId: 'desktop', sessionId: conflict ? 'another-session' : row.session_id,
        localSessionId: row.local_id, lastSourceSeq: String(row.ack_seq), lastSeq: row.server_seq, syncProtocolVersion: row.sync_protocol_version });
      return usual(actor, pathname, init);
    });
    await f.bridge.syncSessions(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][1]).toContain('/sync/state?');
    expect(f.store.sync(row.local_id)!.ack_seq).toBe(row.ack_seq);
    expect(f.store.pending(row.local_id)).toEqual(original);
    expect(f.bridge.taskSync.get(context, row.local_id).failure_count).toBe(conflict ? 2 : 1);
    await f.bridge.syncSessions(true);
    if (conflict) {
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.bridge.taskSync.get(context, row.local_id)).toMatchObject({ phase: 'isolated', reason: 'REMOTE_SYNC_STATE_CONFLICT' });
      expect(f.store.sync(row.local_id)!.ack_seq).toBe(row.ack_seq);
      expect(f.store.pending(row.local_id)).toEqual(original);
    } else {
      expect(f.request.mock.calls[1][1]).toBe('/api/remote/v1/sync/batches');
      expect(f.acknowledged(row.local_id)).toBe(true);
      expect(f.bridge.taskSync.get(context, row.local_id).failure_count).toBe(0);
    }
    expect(f.bridge.deps.execute).not.toHaveBeenCalled();
  });

  it('yields local network admission pressure without failing tasks or opening the service circuit', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(); f.add('a-busy'); f.add('b-busy'); f.add('c-busy');
    const usual = f.request.getMockImplementation()!;
    f.request.mockRejectedValue(new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, 'Authenticated request failed', {
      failureKind: AuthRefreshFailureKind.Network, originalError: new RemoteNetworkError(RemoteNetworkFailure.AdmissionBusy),
    }));
    await f.bridge.syncSessions(true);
    expect(f.bridge.historyCircuitProbe).toBe(false);
    expect(f.bridge.historyTransportFailures).toEqual([]);
    for (const id of ['a-busy', 'b-busy', 'c-busy']) {
      expect(f.bridge.taskSync.get(f.bridge.taskContext(), id)).toMatchObject({ phase: 'ready', failure_count: 0, next_retry_at: now + 500 });
      expect(f.store.get(`syncFailure:${id}`)).toBeNull(); expect(f.acknowledged(id)).toBe(false);
    }
    expect(f.bridge.state().syncHealth.failedSessions).toBe(0);
    now += 501; f.request.mockImplementation(usual);
    await f.bridge.syncSessions(true);
    for (const id of ['a-busy', 'b-busy', 'c-busy']) expect(f.acknowledged(id)).toBe(true);
  });

  it('retries an authenticated transport failure after backoff while retaining the original batch', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(); f.add('transport');
    const usual = f.request.getMockImplementation()!;
    const before = f.store.pending('transport');
    f.request.mockRejectedValue(new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, 'Authenticated request failed', {
      failureKind: AuthRefreshFailureKind.Network, originalError: new TypeError('fetch failed'),
    }));
    await f.bridge.syncSessions(true);
    const state = f.bridge.taskSync.get(f.bridge.taskContext(), 'transport');
    expect(state).toMatchObject({ phase: 'backoff', scope: 'service', failure_count: 1 });
    expect(f.store.pending('transport')).toEqual(before);
    const originalBody = f.request.mock.calls[0][2].body;
    now = state.next_retry_at; f.request.mockImplementation(usual);
    await f.bridge.syncSessions(true);
    expect(f.request.mock.calls[1][2].body).toBe(originalBody);
    expect(f.acknowledged('transport')).toBe(true);
  });

  it('lets the projection scheduler recover a transient failure without blocking another task', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(); f.add('a-projecting'); f.add('b-ready');
    f.store.recordProjectionFailure('a-projecting', 'REMOTE_PROJECTION_CONTEXT_CHANGED');
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-ready')).toBe(true); expect(f.acknowledged('a-projecting')).toBe(false);
    const state = f.bridge.taskSync.get(f.bridge.taskContext(), 'a-projecting');
    expect(state).toMatchObject({ phase: 'ready', failure_count: 0 });
    expect(f.bridge.taskSync.projectionEligible(f.bridge.taskContext(), 'a-projecting')).toBe(true);
    // The real projection worker clears its failure only after publishing a valid projection.
    f.db.prepare('DELETE FROM remote_projection_failures WHERE session_id=?').run('a-projecting');
    now = state.next_retry_at;
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('a-projecting')).toBe(true);
  });

  it('reports a projection-only failure consistently before a network turn and deduplicates its later task ledger', () => {
    const f = fixture(); f.add('a-bad'); f.add('b-good');
    f.store.recordProjectionFailure('a-bad', 'REMOTE_PROJECTION_BUDGET');
    const before = f.bridge.state();
    expect(before.syncHealth).toMatchObject({ status: 'degraded', failedSessions: 1, isolatedSessions: 1, retryingSessions: 0 });
    expect(before.syncHealth.taskIssues.map((issue: { localSessionId: string }) => issue.localSessionId)).toEqual(['a-bad']);
    expect(before.sessionSyncStatus).toBe('error');
    f.bridge.taskSync.fail(f.bridge.taskContext(), 'a-bad', { phase: 'isolated', scope: 'session', reason: 'REMOTE_PROJECTION_BUDGET' });
    expect(f.bridge.state().syncHealth).toMatchObject({ failedSessions: 1, isolatedSessions: 1 });
    f.bridge.taskSync.fail(f.bridge.taskContext(), 'a-bad', { phase: 'closed', scope: 'session', reason: 'SESSION_DELETED' });
    expect(f.bridge.state().syncHealth).toMatchObject({ failedSessions: 0, taskIssues: [] });
  });
  it('isolates a failed interrupted publication instead of deferring it forever', async () => {
    const f = fixture(); f.add('a-bad'); f.add('b-good');
    const before = f.store.sync('a-bad')!;
    vi.spyOn(f.store, 'projectionPublishing').mockImplementation(id => id === 'a-bad');
    f.store.recordProjectionFailure('a-bad', 'REMOTE_PROJECTION_PUBLICATION_INVALID');
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-good')).toBe(true);
    expect(f.store.sync('a-bad')!.ack_seq).toBe(before.ack_seq);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'a-bad').phase).toBe('isolated');
    expect(f.bridge.state().syncHealth.failedSessions).toBe(1);
  });
  it('does not permanently isolate a task after shared authentication fails and later recovers', async () => {
    const f = fixture(); f.add('reauthenticate');
    const usual = f.request.getMockImplementation()!;
    f.request.mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: 'Authentication required' }), { status: 401 }));
    await expect(f.bridge.syncSessions(true)).rejects.toMatchObject({ code: 401 });
    const state = f.bridge.taskSync.get(f.bridge.taskContext(), 'reauthenticate');
    expect(state.phase).toBe('ready'); expect(state.failure_count).toBe(0);
    expect(f.bridge.taskMemoryBlocks.has('reauthenticate')).toBe(false);
    expect(f.store.get('syncFailure:reauthenticate')).toBeNull();
    expect(f.acknowledged('reauthenticate')).toBe(false);
    f.request.mockImplementation(usual);
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('reauthenticate')).toBe(true);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'reauthenticate').phase).toBe('ready');
  });

  it('opens a bounded history circuit after transport failures span independent tasks', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(); f.add('a-network'); f.add('b-network'); f.add('c-network');
    const usual = f.request.getMockImplementation()!;
    f.request.mockRejectedValue(new TypeError('fetch failed'));
    await f.bridge.syncSessions(true);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.bridge.historyCircuitProbe).toBe(true);
    expect(f.bridge.historyRetryAt).toBe(now + 30000);
    expect(f.bridge.historyCircuitDelay).toBe(60000);
    for (const id of ['a-network', 'b-network', 'c-network']) {
      expect(f.bridge.taskSync.get(f.bridge.taskContext(), id)).toMatchObject({ phase: 'backoff', failure_count: 1 });
      expect(f.acknowledged(id)).toBe(false);
    }
    await f.bridge.syncSessions(true); expect(f.request).toHaveBeenCalledTimes(3);
    now += 40000; f.request.mockImplementation(usual);
    await f.bridge.syncSessions(true);
    expect(f.bridge.historyCircuitProbe).toBe(false); expect(f.bridge.historyCircuitDelay).toBe(30000);
    for (const id of ['a-network', 'b-network', 'c-network']) expect(f.acknowledged(id)).toBe(true);
  });

  for (const corrupt of ['outbox', 'import'] as const) it(`isolates corrupt ${corrupt} without losing evidence or blocking a healthy task`, async () => {
    const f = fixture(); f.add('a-bad'); f.add('b-good');
    const before = f.store.sync('a-bad')!;
    if (corrupt === 'outbox') f.db.prepare('UPDATE remote_outbox SET event_json=? WHERE session_id=?').run('{', 'a-bad');
    else f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run('import:a-bad', '{');
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-good')).toBe(true);
    expect(f.store.sync('a-bad')!.ack_seq).toBe(before.ack_seq);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'a-bad').phase).toBe('isolated');
    expect(f.bridge.registration.deviceId).toBe('desktop');
    if (corrupt === 'outbox') expect(f.db.prepare('SELECT event_json FROM remote_outbox WHERE session_id=?').get('a-bad')).toEqual({ event_json: '{' });
    else expect(f.db.prepare('SELECT value FROM remote_state WHERE key=?').get('import:a-bad')).toEqual({ value: '{' });
    await f.bridge.syncSessions(true);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('allows a healthy ACK while another task HTTP request is still pending', async () => {
    const f = fixture(); f.add('a-slow'); f.add('b-ready');
    const usual = f.request.getMockImplementation()!;
    let release!: (value: Response) => void;
    f.request.mockImplementation(async (actor, path, init) => {
      const body = JSON.parse(String(init.body));
      if (body.localSessionId === 'a-slow') return new Promise<Response>(resolve => { release = resolve; });
      return usual(actor, path, init);
    });
    const work = f.bridge.syncSessions(true);
    await vi.waitFor(() => expect(f.acknowledged('b-ready')).toBe(true));
    expect(f.acknowledged('a-slow')).toBe(false);
    const call = f.request.mock.calls.find(([, , init]) => JSON.parse(String(init.body)).localSessionId === 'a-slow')!;
    release(await usual(...call)); await work;
    expect(f.acknowledged('a-slow')).toBe(true);
  });

  it('contains an exception raised during conflict recovery', async () => {
    const f = fixture(); f.add('a-conflict'); f.add('b-ready');
    const usual = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (actor, path, init) => {
      if (JSON.parse(String(init.body)).localSessionId === 'a-conflict') throw new RemoteApiError(47025, 'conflict', { currentImport: { importId: 'original' } }, 409);
      return usual(actor, path, init);
    });
    vi.spyOn(f.bridge, 'recoverImportConflict').mockRejectedValue(new Error('corrupt recovery record'));
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-ready')).toBe(true);
    expect(f.acknowledged('a-conflict')).toBe(false);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'a-conflict').phase).toBe('isolated');
  });

  it('keeps healthy tasks moving when a task failure record cannot be written', async () => {
    const f = fixture(); f.add('a-bad'); f.add('b-ready');
    f.db.prepare('UPDATE remote_outbox SET event_json=? WHERE session_id=?').run('{', 'a-bad');
    vi.spyOn(f.bridge.taskSync, 'fail').mockImplementation(() => { throw new Error('derived state write failed'); });
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-ready')).toBe(true);
    expect(f.bridge.taskMemoryBlocks.has('a-bad')).toBe(true);
    expect(f.acknowledged('a-bad')).toBe(false);
  });

  it('does not require state or diagnostics support from an old v1 server', async () => {
    const f = fixture(); f.add('legacy');
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('legacy')).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][1]).toBe('/api/remote/v1/sync/batches');
    expect(f.request.mock.calls[0][2].headers['X-Remote-Sync-Diagnostics']).toBeUndefined();
  });

  it('keeps Retry-After outside the legacy response body and prevents an early retry', async () => {
    const f = fixture(); f.add('rate-limited');
    f.request.mockResolvedValue(new Response(JSON.stringify({ code: 429, data: { reason: 'RATE_LIMITED' } }), { status: 429, headers: { 'Retry-After': '120' } }));
    const now = Date.now(); await f.bridge.syncSessions(true);
    const state = f.bridge.taskSync.get(f.bridge.taskContext(), 'rate-limited');
    expect(state.server_retry_at).toBeGreaterThanOrEqual(now + 120000);
    expect(f.bridge.taskSync.manualRetry(f.bridge.taskContext(), 'rate-limited')).toBe(false);
    await f.bridge.syncSessions(true); expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('does not make transient task failures reset their budget on reconnect', async () => {
    const f = fixture(); f.add('offline');
    f.request.mockRejectedValue(new TypeError('fetch failed'));
    await f.bridge.syncSessions(true);
    const context = f.bridge.taskContext(), before = f.bridge.taskSync.get(context, 'offline');
    await f.bridge.configure({ retry: true });
    expect(f.bridge.taskSync.get(context, 'offline')).toEqual(before);
    expect(f.store.get('syncFailure:offline')).not.toBeNull();
  });
});
