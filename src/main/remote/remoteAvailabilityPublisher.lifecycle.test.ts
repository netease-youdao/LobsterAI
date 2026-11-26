import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { payloadHash } from './canonical';
import { type AvailabilityContext, RemoteAvailabilityPublisher } from './remoteAvailabilityPublisher';
import type { AvailabilityRequest, AvailabilitySession } from './remoteAvailabilityStore';
import { RemoteStore } from './remoteStore';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
vi.mock('./remoteTelemetry', () => ({ captureRemoteTelemetry: () => ({ emit: vi.fn() }), remoteTelemetryEvent: vi.fn() }));

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).reverse().forEach(dispose => dispose());
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const lifecycleChanges = ['stop', 'context', 'restart', 'route_aba', 'invalidated_aba'] as const;
type LifecycleChange = typeof lifecycleChanges[number];
const contextChanged = 'REMOTE_AVAILABILITY_CONTEXT_CHANGED';
function notFound() { return Object.assign(new Error('No receipt yet'), { httpStatus: 404 }); }

function fixture(attempted = true) {
  vi.useFakeTimers();
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  cleanup.push(() => store.history.close()); store.setWake(() => {});
  const owner = { userId: '1', scopeKey: 'personal' };
  store.transaction(() => {
    db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?,NULL,NULL)').run('local', 'Task', 'idle');
    store.assignNew('local', owner, 'local_create');
  });
  const sessionId = store.sync('local')!.session_id;
  store.bindRemote('local', sessionId, 'desktop');
  const initial: AvailabilityContext = { scope: 'target:1:personal:desktop', routeEpoch: 1, owner, deviceId: 'desktop', generation: '1', supported: true, publicationResolutionSupported: true };
  let context = initial;
  const receipt = { state: 'accepted', publicationId: 'pending', projectionRevision: '1', committedSeq: '1' };
  const request = vi.fn(async (_path: string, _method: string, _body: unknown, _version: number, _timeout?: number): Promise<any> => receipt);
  const publisher = new RemoteAvailabilityPublisher({ store, context: () => context, admitted: () => true, request });
  cleanup.push(() => publisher.dispose());
  publisher.ledger.saveSession({ scope: context.scope, localId: 'local', sessionId, writerGeneration: 'writer', controlEpoch: 'epoch',
    phase: 'active', operationId: 'operation', pendingCommandIds: [], pendingRunIds: [], controlRevision: '1', factSeq: '0', records: {} });
  const sealed = publisher.ledger.saveRequest({ key: 'pending', scope: context.scope, localId: 'local', lane: 'live',
    method: 'POST', pathname: '/sync/live-projections', version: 3, lookup: '/sync/live-projections/pending', lookupVersion: 3, createdAt: 1, attempted,
    body: { publicationId: 'pending', sessionId, deviceId: context.deviceId, writerGeneration: 'writer', owner,
      objectKind: 'message', objectId: 'message', sourceObjectRevision: '1', representation: 'complete' } });
  // Exercise the real retry/persistence boundary without scheduling unrelated control/history work.
  const access = publisher as unknown as {
    send(context: AvailabilityContext, request: AvailabilityRequest): Promise<unknown>;
    resolveLive(context: AvailabilityContext, state: AvailabilitySession, publicationId: string): Promise<void>;
  };
  const send = () => access.send(context, publisher.ledger.request(sealed.key)!);
  const change = (mode: LifecycleChange) => {
    if (mode === 'context') context = { ...initial, scope: 'other:1:personal:desktop', generation: '2' };
    else if (mode === 'route_aba') {
      context = { ...initial, scope: 'other:1:personal:desktop', routeEpoch: 2 };
      context = { ...initial, routeEpoch: 3 };
    } else if (mode === 'invalidated_aba') {
      publisher.invalidateContext(); context = { ...initial, scope: 'other:1:personal:desktop' };
      publisher.invalidateContext(); context = initial;
    }
    else { publisher.stop(); if (mode === 'restart') publisher.start(); }
  };
  const resume = () => { context = initial; publisher.start(); };
  const resolve = () => access.resolveLive(context, publisher.ledger.session(context.scope, sealed.localId)!, sealed.key);
  return { publisher, request, sealed, receipt, send, resolve, change, resume };
}

describe('availability HTTP lifecycle fencing', () => {
  it.each(lifecycleChanges)('does not replay after %s during lookup, then retries the same durable identity on the next valid turn', async mode => {
    const f = fixture(), lookup = deferred<unknown>();
    f.request.mockImplementationOnce(() => lookup.promise);
    const pending = f.send();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0].slice(0, 2)).toEqual([f.sealed.lookup, 'GET']);
    f.change(mode); lookup.reject(notFound());
    await expect(pending).rejects.toThrow(contextChanged);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.publisher.ledger.request(f.sealed.key)).toEqual(f.sealed);

    f.resume();
    f.request.mockImplementationOnce(async () => { throw notFound(); });
    await expect(f.send()).resolves.toEqual(f.receipt);
    expect(f.request.mock.calls.slice(1).map(call => call.slice(0, 2))).toEqual([
      [f.sealed.lookup, 'GET'], [f.sealed.pathname, 'POST'],
    ]);
    expect(f.request.mock.calls[2][2]).toEqual({ ...f.sealed.body, connectionGeneration: '1' });
    expect(f.publisher.ledger.request(f.sealed.key)?.body).toEqual(f.sealed.body);
  });

  it.each(lifecycleChanges)('rejects a late POST receipt after %s and keeps its sealed request recoverable', async mode => {
    const f = fixture(false), reply = deferred<unknown>();
    f.request.mockImplementationOnce(() => reply.promise);
    const pending = f.send();
    expect(f.request.mock.calls[0].slice(0, 2)).toEqual([f.sealed.pathname, 'POST']);
    f.change(mode); reply.resolve(f.receipt);
    await expect(pending).rejects.toThrow(contextChanged);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.publisher.ledger.request(f.sealed.key)).toMatchObject({ key: f.sealed.key, attempted: true, body: f.sealed.body });
    expect(f.publisher.ledger.object(f.sealed.scope, f.sealed.localId, 'message:message')).toBeNull();
  });

  it('replays the exact original request after a valid lookup 404', async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => { throw notFound(); });
    await expect(f.send()).resolves.toEqual(f.receipt);
    expect(f.request.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [f.sealed.lookup, 'GET'], [f.sealed.pathname, 'POST'],
    ]);
    expect(f.request.mock.calls[1][2]).toEqual({ ...f.sealed.body, connectionGeneration: '1' });
    expect(f.publisher.ledger.request(f.sealed.key)?.body).toEqual(f.sealed.body);
  });


  it.each(['original_terminal', 'sealed_unpublished'] as const)(
    'fences a late %s resolution after restart and retains its original resolution identity for recovery', async state => {
      const f = fixture(), reply = deferred<unknown>();
      f.request.mockImplementationOnce(() => reply.promise);
      const pending = f.resolve();
      const original = f.publisher.ledger.db.prepare('SELECT body,request_hash,resolution_body,resolution_receipt FROM availability_requests WHERE key=?')
        .get(f.sealed.key) as { body: string; request_hash: string; resolution_body: string; resolution_receipt: string | null };
      const body = JSON.parse(original.resolution_body);
      const { mode: _mode, ...business } = body;
      const receipt = { state, publicationId: f.sealed.key, sessionId: f.sealed.body.sessionId, writerGeneration: f.sealed.body.writerGeneration,
        ...(state === 'original_terminal' ? { originalRequestHash: original.request_hash, receipt: f.receipt }
          : { sealId: 'seal', resolutionRequestHash: payloadHash({ ...business, publicationId: f.sealed.key }) }) };
      expect(typeof body.resolutionId).toBe('string');
      expect(original.resolution_receipt).toBeNull();
      f.change('restart'); reply.resolve(receipt);
      await expect(pending).rejects.toThrow(contextChanged);
      expect(f.publisher.ledger.db.prepare('SELECT body,request_hash,resolution_body,resolution_receipt FROM availability_requests WHERE key=?')
        .get(f.sealed.key)).toEqual(original);
      expect(f.publisher.ledger.hasPendingObject(f.sealed.scope, f.sealed.localId, 'message', 'message')).toBe(true);

      f.request.mockResolvedValueOnce(receipt);
      await expect(f.resolve()).resolves.toBeUndefined();
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.request.mock.calls.map(call => call.slice(0, 2))).toEqual([
        ['/sync/live-projections/pending/resolve', 'POST'], ['/sync/live-projections/pending/resolve', 'POST'],
      ]);
      expect(f.request.mock.calls[1][2]).toEqual(f.request.mock.calls[0][2]);
      const terminal = f.publisher.ledger.db.prepare('SELECT body,request_hash,resolution_body,resolution_receipt FROM availability_requests WHERE key=?')
        .get(f.sealed.key) as typeof original;
      expect({ ...terminal, resolution_receipt: null }).toEqual(original);
      expect(JSON.parse(terminal.resolution_receipt!)).toEqual(receipt);
      expect(f.publisher.ledger.hasPendingObject(f.sealed.scope, f.sealed.localId, 'message', 'message')).toBe(false);
    },
  );

  it.each([true, false])('preserves the original non-404 failure while the lifecycle is valid (lookup=%s)', async attempted => {
    const f = fixture(attempted), failure = Object.assign(new Error('Unavailable'), { httpStatus: 503 });
    f.request.mockRejectedValueOnce(failure);
    await expect(f.send()).rejects.toBe(failure);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.publisher.ledger.request(f.sealed.key)?.body).toEqual(f.sealed.body);
  });
});
