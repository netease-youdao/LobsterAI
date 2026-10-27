import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteDeletion } from '../../shared/remote/deletions';
import { AvailabilityDeletion } from './remoteAvailabilityDeletion';
import * as health from './remoteAvailabilityHealth';
import { type AvailabilityContext, RemoteAvailabilityPublisher } from './remoteAvailabilityPublisher';
import { ReplyModelDisplayVersion } from './remoteAvailabilityStore';
import { RemoteStore } from './remoteStore';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
vi.mock('./remoteTelemetry', () => ({ captureRemoteTelemetry: () => ({ emit: vi.fn() }), remoteTelemetryEvent: vi.fn() }));

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks(); });

function fixture(messageCount = 17, sessionCount = 1) {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  store.setWake(() => {}); cleanup.push(() => store.history.close());
  const owner = { userId: '1', scopeKey: 'personal' };
  let context: AvailabilityContext = { scope: 'target:1:personal:desktop', owner, deviceId: 'desktop', generation: '1', supported: true };
  let admitted = true;
  const request = vi.fn(async () => { throw new Error('An acknowledged scan must not send HTTP'); });
  const publisher = new RemoteAvailabilityPublisher({ store, context: () => context, admitted: () => admitted, request });
  cleanup.push(() => publisher.dispose());
  const initialContext = context;
  for (let session = 0; session < sessionCount; session++) {
    const localId = `local-${session}`;
    store.transaction(() => {
      db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?,NULL,NULL)').run(localId, 'Task', 'idle');
      store.assignNew(localId, owner, 'local_create');
      const insert = db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,2,?)');
      for (let index = 0; index < messageCount; index++) insert.run(`message-${session}-${index}`, localId, 'assistant', 'Hello', '{}', index + 1);
    });
    const sessionId = store.sync(localId)!.session_id;
    store.bindRemote(localId, sessionId, 'desktop');
    publisher.ledger.saveSession({ scope: context.scope, localId, sessionId, writerGeneration: 'writer', controlEpoch: 'epoch',
      phase: 'active', operationId: 'operation', pendingCommandIds: [], pendingRunIds: [], controlRevision: '1', factSeq: '0', records: {} });
    const insert = publisher.ledger.db.prepare('INSERT INTO availability_objects VALUES(?,?,?,?,?)');
    for (let index = 0; index < messageCount; index++) insert.run(context.scope, localId, `message:message-${session}-${index}`, '1',
      JSON.stringify({ state: 'accepted', representation: 'complete', replyModelDisplayVersion: ReplyModelDisplayVersion }));
  }
  const recorded = vi.spyOn(health, 'recordAvailabilityObjectHealth');
  const live = (): Promise<void> => (publisher as any).live(initialContext);
  return { db, store, publisher, request, recorded, live, context: initialContext,
    setContext: (value: AvailabilityContext) => { context = value; }, setAdmitted: (value: boolean) => { admitted = value; } };
}

describe('availability live scan cooperative turns', () => {
  it('lets an event-loop callback run after eight objects and visits every unchanged ACK exactly once', async () => {
    const f = fixture(); vi.spyOn(performance, 'now').mockReturnValue(0);
    let atYield = 0;
    const echo = new Promise<void>(resolve => setImmediate(() => { atYield = f.recorded.mock.calls.length; resolve(); }));
    await f.live(); await echo;
    expect(atYield).toBe(8);
    expect(f.recorded).toHaveBeenCalledTimes(17);
    expect(new Set(f.recorded.mock.calls.map(call => call[3])).size).toBe(17);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.publisher.ledger.db.prepare('SELECT COUNT(*) AS count FROM availability_objects').get()).toEqual({ count: 17 });
  });

  it('yields while scanning deferred requests without altering their sealed bytes or retry state', async () => {
    const f = fixture(0); vi.spyOn(performance, 'now').mockReturnValue(0);
    const state = f.publisher.ledger.session(f.context.scope, 'local-0')!;
    const internal = f.publisher as any, retryAt = Date.now() + 60000;
    for (let index = 0; index < 17; index++) {
      const key = `retry-${String(index).padStart(2, '0')}`;
      f.publisher.ledger.saveRequest({ key, scope: f.context.scope, localId: 'local-0', lane: 'live', method: 'POST',
        pathname: '/sync/live-projections', version: 3, lookup: null, lookupVersion: 3, createdAt: Date.now(), attempted: true,
        body: { publicationId: key, objectId: `message-${index}`, objectKind: 'message', sessionId: state.sessionId,
          owner: f.context.owner, deviceId: f.context.deviceId, writerGeneration: state.writerGeneration } });
      internal.failures.set(key, { count: 1, retryAt });
    }
    const read = (): unknown[] => f.publisher.ledger.db.prepare('SELECT key,body,request_hash FROM availability_requests ORDER BY key').all();
    const before = read(), eligible = vi.spyOn(internal, 'eligible');
    const visited = (): number => eligible.mock.calls.filter(([key]) => String(key).startsWith('retry-')).length;
    let atYield = 0;
    const echo = new Promise<void>(resolve => setImmediate(() => { atYield = visited(); resolve(); }));
    await f.live(); await echo;
    expect(atYield).toBe(8); expect(visited()).toBe(17); expect(read()).toEqual(before);
    for (let index = 0; index < 17; index++) expect(internal.failures.get(`retry-${String(index).padStart(2, '0')}`)).toEqual({ count: 1, retryAt });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('yields on the time budget before the object-count budget', async () => {
    const f = fixture(3); let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    // Keep the real display write; simulate elapsed time without blocking the parent thread.
    f.recorded.mockRestore();
    const write = health.recordAvailabilityObjectHealth;
    const recorded = vi.spyOn(health, 'recordAvailabilityObjectHealth').mockImplementation((...args) => { write(...args); clock += 9; });
    let atYield = 0;
    const echo = new Promise<void>(resolve => setImmediate(() => { atYield = recorded.mock.calls.length; resolve(); }));
    await f.live(); await echo;
    expect(atYield).toBe(1); expect(recorded).toHaveBeenCalledTimes(3); expect(f.request).not.toHaveBeenCalled();
  });

  it('checks the time budget before scanning another session even when every session has no objects', async () => {
    const f = fixture(0, 17); let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const read = f.publisher.ledger.scanPending.bind(f.publisher.ledger);
    const scanned = vi.spyOn(f.publisher.ledger, 'scanPending').mockImplementation((...args) => { const result = read(...args); clock += 9; return result; });
    let atYield = 0;
    const echo = new Promise<void>(resolve => setImmediate(() => { atYield = scanned.mock.calls.length; resolve(); }));
    await f.live(); await echo;
    expect(atYield).toBe(1); expect(scanned).toHaveBeenCalledTimes(17);
    expect(new Set(scanned.mock.calls.map(call => call[2])).size).toBe(17);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('revalidates later sessions from the original candidate page after an earlier session yielded', async () => {
    const f = fixture(9, 2); vi.spyOn(performance, 'now').mockReturnValue(0);
    const mutate = new Promise<void>(resolve => setImmediate(() => {
      f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='other' WHERE session_id='local-1'").run();
      resolve();
    }));
    await f.live(); await mutate;
    expect(f.recorded).toHaveBeenCalledTimes(9);
    expect(f.recorded.mock.calls.every(call => call[2] === 'local-0')).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.publisher.ledger.db.prepare('SELECT COUNT(*) AS count FROM availability_objects').get()).toEqual({ count: 18 });
  });

  it.each(['context', 'restart', 'admission', 'deletion', 'closed', 'owner', 'binding', 'writer'] as const)(
    'rechecks %s after yielding and leaves the remaining ACKs untouched', async change => {
      const f = fixture(); vi.spyOn(performance, 'now').mockReturnValue(0);
      const mutate = new Promise<void>(resolve => setImmediate(() => {
        if (change === 'context') f.setContext({ ...f.context, scope: 'other-target:1:personal:desktop' });
        if (change === 'restart') { f.publisher.stop(); f.publisher.start(); }
        if (change === 'admission') f.setAdmitted(false);
        if (change === 'deletion') f.store.put(`${AvailabilityDeletion.Prefix}local-0`, { deletedAt: Date.now() });
        if (change === 'closed') f.store.put(`${RemoteDeletion.Closed}local-0`, true);
        if (change === 'owner') f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='other' WHERE session_id='local-0'").run();
        if (change === 'binding') f.db.prepare("UPDATE remote_sync SET sync_environment='other-environment' WHERE local_id='local-0'").run();
        if (change === 'writer') {
          const state = f.publisher.ledger.session(f.context.scope, 'local-0')!;
          f.publisher.ledger.saveSession({ ...state, writerGeneration: 'next-writer' });
        }
        resolve();
      }));
      await f.live(); await mutate;
      expect(f.recorded).toHaveBeenCalledTimes(8); expect(f.request).not.toHaveBeenCalled();
      expect(f.publisher.ledger.db.prepare('SELECT COUNT(*) AS count FROM availability_objects').get()).toEqual({ count: 17 });
    },
  );
});
