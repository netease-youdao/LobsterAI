import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AvailabilityContext, RemoteAvailabilityPublisher } from './remoteAvailabilityPublisher';
import { ReplyModelDisplayVersion } from './remoteAvailabilityStore';
import type { RemoteLiveProjectionJob } from './remoteLiveProjectionJob';
import { RemoteStore } from './remoteStore';

// Keep diagnostics out of the timer inventory; the Store/Publisher wake circuit remains real.
vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
vi.mock('./remoteTelemetry', () => ({
  captureRemoteTelemetry: () => ({ emit: vi.fn() }), remoteTelemetryEvent: vi.fn(),
}));

interface SchedulingAccess {
  tick(): void;
  live(context: AvailabilityContext): Promise<void>;
  encoder: RemoteLiveProjectionJob;
}
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).reverse().forEach(dispose => dispose());
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  vi.useFakeTimers();
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  cleanup.push(() => store.history.close());
  const owner = { userId: '1', scopeKey: 'personal' };
  store.setWake(() => {});
  store.transaction(() => {
    db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?,NULL,NULL)').run('local', 'Task', 'idle');
    store.assignNew('local', owner, 'local_create');
    db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,2,1)').run('message', 'local', 'assistant', 'Hello', '{}');
  });
  const sessionId = store.sync('local')!.session_id;
  store.bindRemote('local', sessionId, 'desktop');
  const context: AvailabilityContext = { scope: 'target:1:personal:desktop', owner, deviceId: 'desktop', generation: '1', supported: true, historySupported: false };
  const request = vi.fn(async (pathname: string, _method: string, body: any) => {
    if (pathname === '/sync/live-projections') return { publicationId: body.publicationId, state: 'accepted', projectionRevision: '10', committedSeq: '10' };
    if (pathname === '/control/facts/batches') return { state: 'committed', lastFactSeq: body.lastFactSeq };
    throw new Error(`Unexpected fixture request: ${pathname}`);
  });
  const publisher = new RemoteAvailabilityPublisher({ store, context: () => context, admitted: () => true, request });
  cleanup.push(() => publisher.dispose());
  store.setIndependentControlReady(id => publisher.controlReady(id));
  const revision = db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get('local') as { revision: number };
  publisher.ledger.saveSession({ scope: context.scope, localId: 'local', sessionId, writerGeneration: 'writer', controlEpoch: 'epoch',
    phase: 'active', operationId: 'operation', pendingCommandIds: [], pendingRunIds: [], controlRevision: String(revision.revision), factSeq: '0', records: {} });
  const acknowledged = publisher.ledger.saveRequest({ key: 'acknowledged', scope: context.scope, localId: 'local', lane: 'live',
    method: 'POST', pathname: '/sync/live-projections', version: 3, lookup: null, lookupVersion: 3, createdAt: 1, attempted: true,
    replyModelDisplayVersion: ReplyModelDisplayVersion,
    body: { publicationId: 'acknowledged', sessionId, deviceId: context.deviceId, writerGeneration: 'writer', owner,
      objectKind: 'message', objectId: 'message', sourceObjectRevision: '1', representation: 'complete' } });
  publisher.ledger.completeObject(acknowledged, { state: 'accepted', publicationId: 'acknowledged', projectionRevision: '1' });
  const access = publisher as unknown as SchedulingAccess;
  const originalTick = access.tick.bind(access);
  let ticks = 0;
  vi.spyOn(access, 'tick').mockImplementation(() => {
    // A regression must fail quickly rather than generating an unbounded fake-clock workload.
    if (++ticks > 100 || vi.getTimerCount() > 100) { publisher.stop(); throw new Error('Scheduling regression safety cap'); }
    originalTick();
  });
  const wake = vi.fn(() => publisher.wake());
  store.setWake(wake);
  const prepare = vi.spyOn(db, 'prepare');
  const ledgerPrepare = vi.spyOn(publisher.ledger.db, 'prepare');
  const changeMessage = () => store.transaction(() => {
    db.prepare('UPDATE cowork_messages SET content=? WHERE id=?').run('Updated local content', 'message');
  });
  return { db, store, publisher, access, request, wake, prepare, ledgerPrepare, changeMessage,
    ticks: () => ticks, context: () => context };
}

async function advanceBounded(milliseconds: number, maximumTimers = 1): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 200) {
    await vi.advanceTimersByTimeAsync(Math.min(200, milliseconds - elapsed));
    expect(vi.getTimerCount()).toBeLessThanOrEqual(maximumTimers);
  }
}

describe('availability scheduling with the real SQLite Store wake circuit', () => {
  it('keeps an acknowledged idle task at one timer for 60 seconds, stops completely and restarts once', async () => {
    const f = fixture();
    expect(f.publisher.ledger.object(f.context().scope, 'local', 'message:message')).toMatchObject({
      sourceRevision: '1', result: { state: 'accepted', representation: 'complete' },
    });
    f.publisher.start(); f.publisher.start();
    await advanceBounded(60_000);
    expect(f.ticks()).toBe(60);
    expect(f.request).not.toHaveBeenCalled();
    // Includes all three real lanes, not just the optimized current-content helper.
    expect(f.prepare.mock.calls.length + f.ledgerPrepare.mock.calls.length).toBeLessThan(60 * 200);
    f.publisher.stop();
    expect(vi.getTimerCount()).toBe(0);
    await advanceBounded(2000, 0);
    expect(f.ticks()).toBe(60);
    f.publisher.start(); f.publisher.start();
    await advanceBounded(2200);
    expect(f.ticks()).toBe(63);
    expect(f.request).not.toHaveBeenCalled();
    f.publisher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns one timer even when a synchronous Store transaction wakes it inside every live scan', async () => {
    const f = fixture();
    const object = f.publisher.ledger.object.bind(f.publisher.ledger);
    vi.spyOn(f.publisher.ledger, 'object').mockImplementation((...args) => {
      // Independent fault injection: no-op input-job optimization cannot mask timer ownership.
      f.store.transaction(() => undefined);
      return object(...args);
    });
    f.publisher.start();
    await advanceBounded(2400);
    expect(f.ticks()).toBe(3);
    expect(f.wake.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.request).not.toHaveBeenCalled();
    f.publisher.stop();
    expect(vi.getTimerCount()).toBe(0);
    await advanceBounded(2000, 0);
    expect(f.ticks()).toBe(3);
  });

  it('does not reenter live publication while its real sealed HTTP request is pending', async () => {
    const f = fixture();
    const pending = deferred<Record<string, unknown>>();
    f.request.mockImplementation(() => pending.promise as Promise<any>);
    const live = vi.spyOn(f.access, 'live');
    f.changeMessage(); f.publisher.start();
    await advanceBounded(4200);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][0]).toBe('/sync/live-projections');
    expect(live).toHaveBeenCalledTimes(1);
    expect(f.publisher.ledger.scanPending(f.context().scope, 'live', 'local').rows).toHaveLength(1);
    const body = f.request.mock.calls[0][2];
    pending.resolve({ state: 'accepted', publicationId: body.publicationId, projectionRevision: '2', committedSeq: '2' });
    await advanceBounded(1000);
    expect(live.mock.calls.length).toBeGreaterThan(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.publisher.ledger.scanPending(f.context().scope, 'live', 'local').rows).toHaveLength(0);
  });

  it('does not reenter encoding while its first current-content projection is pending', async () => {
    const f = fixture();
    const pending = deferred<void>();
    const project = f.access.encoder.project.bind(f.access.encoder);
    const encoder = vi.spyOn(f.access.encoder, 'project').mockImplementation(async (...args) => { await pending.promise; return project(...args); });
    const live = vi.spyOn(f.access, 'live');
    f.changeMessage(); f.publisher.start();
    await advanceBounded(4200);
    expect(encoder).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
    pending.resolve();
    await advanceBounded(1000);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(encoder).toHaveBeenCalledTimes(1);
    expect(f.publisher.ledger.object(f.context().scope, 'local', 'message:message')?.sourceRevision).toBe('2');
  });

  it('still wakes and acknowledges a real local edit after an idle period', async () => {
    const f = fixture(); f.publisher.start();
    await advanceBounded(2200);
    expect(f.request).not.toHaveBeenCalled();
    f.wake.mockClear();
    f.changeMessage();
    expect(f.wake).toHaveBeenCalledTimes(1);
    expect(f.db.prepare('SELECT revision FROM remote_live_revisions WHERE object_id=?').get('message')).toEqual({ revision: 2 });
    await advanceBounded(2000);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][2]).toMatchObject({ objectId: 'message', sourceObjectRevision: '2' });
    expect(f.publisher.ledger.object(f.context().scope, 'local', 'message:message')).toMatchObject({ sourceRevision: '2', result: { state: 'accepted' } });
    await advanceBounded(3000);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
