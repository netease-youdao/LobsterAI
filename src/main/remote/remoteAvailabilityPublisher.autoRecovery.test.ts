import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteDeletion } from '../../shared/remote/deletions';
import { payloadHash, stableJson } from './canonical';
import { type AvailabilityContext, RemoteAvailabilityPublisher } from './remoteAvailabilityPublisher';
import type { ControlSnapshot } from './remoteAvailabilitySource';
import type { AvailabilityRequest, AvailabilitySession } from './remoteAvailabilityStore';
import type { HistoryOperation } from './remoteHistoryStore';
import { RemoteStore } from './remoteStore';
import { RemoteRecoveryLimiter } from './remoteSyncRecoveryLedger';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
vi.mock('./remoteTelemetry', () => ({ captureRemoteTelemetry: () => ({ emit: vi.fn() }), remoteTelemetryEvent: vi.fn() }));
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(action => action()); vi.useRealTimers(); vi.restoreAllMocks(); });
const rejected = (status = 400) => Object.assign(new Error('Unknown request rejection'), {
  httpStatus: status, code: status === 426 ? 47009 : 47019, data: { reason: status === 426 ? 'PROTOCOL_UNSUPPORTED' : 'INVALID_REMOTE_REQUEST' },
});
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false }); store.setWake(() => {}); cleanup.push(() => store.history.close());
  const owner = { userId: '1', scopeKey: 'personal' };
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES('local','Task',1,1,'idle',NULL,NULL)").run(); store.assignNew('local', owner, 'local_create'); });
  const sessionId = store.sync('local')!.session_id; store.bindRemote('local', sessionId, 'desktop');
  const context: AvailabilityContext = { scope: 'target:1:personal:desktop', owner, deviceId: 'desktop', generation: '1', supported: true,
    checkpointPagesSupported: true, historySupported: true, recoveryCapabilities: ['control_facts_v1', 'live_projections_v3', 'sync_recovery_v3'] };
  const request = vi.fn(async (_path: string, _method: string, _body: any, _version: number): Promise<any> => { throw new Error('Unexpected request'); });
  const publisher = new RemoteAvailabilityPublisher({ store, context: () => context, admitted: () => true, request, recoveryLimiter: new RemoteRecoveryLimiter() });
  cleanup.push(() => publisher.dispose()); store.setIndependentControlReady(id => publisher.controlReady(id));
  const state: AvailabilitySession = { scope: context.scope, localId: 'local', sessionId, writerGeneration: 'writer', controlEpoch: 'epoch',
    phase: 'active', operationId: 'checkpoint', pendingCommandIds: [], pendingRunIds: [], controlRevision: '1', factSeq: '0', records: {} };
  publisher.ledger.saveSession(state);
  const access = publisher as unknown as {
    send(context: AvailabilityContext, request: AvailabilityRequest): Promise<any>;
    recoverHistory(context: AvailabilityContext, operation: HistoryOperation): Promise<void>;
    bootstrap(context: AvailabilityContext, state: AvailabilitySession, options?: { snapshot: ControlSnapshot; extra: Record<string, unknown> }): Promise<void>;
  };
  const advance = () => vi.setSystemTime(Date.now() + 31_000);
  return { db, store, context, request, publisher, state, access, advance };
}
function sealedLive(f: ReturnType<typeof fixture>) {
  return f.publisher.ledger.saveRequest({ key: 'live', scope: f.context.scope, localId: 'local', lane: 'live', method: 'POST',
    pathname: '/sync/live-projections', version: 3, lookupVersion: 3, lookup: '/sync/live-projections/live', createdAt: 1, attempted: false,
    body: { publicationId: 'live', sessionId: f.state.sessionId, deviceId: 'desktop', owner: f.context.owner, writerGeneration: 'writer',
      objectKind: 'message', objectId: 'message', sourceObjectRevision: '1', representation: 'complete', payloadHash: payloadHash('text') } });
}
function checkpointFixture(paged = false) {
  const f = fixture(); f.state.phase = 'bootstrap'; f.publisher.ledger.saveSession(f.state);
  let begin: Record<string, any> | undefined, parentCommitted = false, rejectPart = true;
  const committed = () => ({ ...begin, state: 'committed', controlReady: true, committedSeq: '2' });
  f.request.mockImplementation(async (path, method, body) => {
    if (path === '/control/bootstrap' || path === '/control/bootstrap/paged') { begin = body; return { operationId: body.operationId,
      sessionId: body.sessionId, writerGeneration: body.writerGeneration, state: 'uploading' }; }
    if (path === '/control/operations/checkpoint') return parentCommitted ? committed() : { operationId: 'checkpoint', sessionId: f.state.sessionId,
      writerGeneration: 'writer', state: 'uploading' };
    if (method === 'PUT') {
      if (rejectPart) { rejectPart = false; throw rejected(); }
      return { partNo: Number(path.split('/').at(-1)), payloadHash: body.payloadHash, recordCount: body.records.length };
    }
    if (path.endsWith('/commit')) return committed();
    throw new Error('Unexpected request');
  });
  const options = paged ? { snapshot: { revision: '1', records: Array.from({ length: 65 }, (_, index) => ({ eventType: 'message.upsert',
    payload: { messageId: `message${index}` } })) } as ControlSnapshot, extra: {} } : undefined;
  const bootstrap = () => f.access.bootstrap(f.context, f.state, options);
  return { ...f, bootstrap, parentCommitted: () => { parentCommitted = true; } };
}
function historyFixture() {
  const f = fixture();
  const context = { scope: f.context.scope, localId: 'local', sessionId: f.state.sessionId, writerGeneration: 'writer', owner: f.context.owner, deviceId: 'desktop' };
  const session = f.store.history.prepare(context)!;
  expect(session).not.toBeNull();
  const begin = { owner: f.context.owner, deviceId: 'desktop', sessionId: f.state.sessionId, localSessionId: 'local', writerGeneration: 'writer',
    mode: 'online', recoveryId: 'history', streamEpoch: 'stream', expectedHistoryGeneration: session.historyGeneration,
    expectedResolvedSourceSeq: session.resolvedSourceSeq, frozenThroughSourceSeq: '1', controlCheckpointReceiptId: 'checkpoint' };
  const operation = f.store.history.sealOperation({ id: 'history', context, kind: 'recovery', request: { begin, checkpointState: f.state } });
  const { mode: _mode, ...business } = begin;
  const receipt = { recoveryId: 'history', sessionId: f.state.sessionId, state: 'committed', requestHash: payloadHash(business),
    streamEpoch: 'stream', historyGeneration: String(BigInt(session.historyGeneration) + 1n), resolvedSourceSeq: '1', controlCheckpointReceiptId: 'checkpoint' };
  return { ...f, operation, receipt, recover: () => f.access.recoverHistory(f.context, operation) };
}
describe('v3 original operation automatic recovery', () => {
  it('queries an opaque rejection once and never replays after a 404', async () => {
    const f = fixture(), original = sealedLive(f);
    f.request.mockRejectedValueOnce(rejected());
    await expect(f.access.send(f.context, original)).rejects.toMatchObject({ httpStatus: 400 });
    f.advance(); f.request.mockRejectedValueOnce(Object.assign(new Error('Not found'), { httpStatus: 404 }));
    await expect(f.access.send(f.context, f.publisher.ledger.request(original.key)!)).rejects.toMatchObject({ httpStatus: 404 });
    f.advance(); await expect(f.access.send(f.context, original)).rejects.toThrow('DEFERRED');
    expect(f.request.mock.calls.map(call => call[1])).toEqual(['POST', 'GET']);
    expect(f.publisher.ledger.request(original.key)?.body).toEqual(original.body);
    expect(f.publisher.legacyHistoryAllowed('local')).toBe(false);
  });
  it.each(['writer', 'fence'] as const)('does not query or publish when the %s changes during recovery wait', async change => {
    const f = fixture(), original = sealedLive(f); f.request.mockRejectedValueOnce(rejected(426));
    await expect(f.access.send(f.context, original)).rejects.toThrow(); f.advance();
    if (change === 'writer') f.publisher.ledger.saveSession({ ...f.state, writerGeneration: 'new-writer' });
    else f.store.put(`${RemoteDeletion.Fence}local`, { phase: RemoteDeletion.EffectStarted });
    await expect(f.access.send(f.context, original)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('keeps a valid original receipt recoverable if the process stops before the caller ACK', async () => {
    const f = fixture(), original = sealedLive(f); f.request.mockRejectedValueOnce(rejected());
    await expect(f.access.send(f.context, original)).rejects.toThrow(); f.advance();
    const receipt = { ...original.body, state: 'accepted', projectionRevision: '1', committedSeq: '1' };
    f.request.mockResolvedValue(receipt);
    await expect(f.access.send(f.context, original)).resolves.toEqual(receipt);
    f.publisher.invalidateContext();
    await expect(f.access.send(f.context, original)).resolves.toEqual(receipt);
    expect(f.request.mock.calls.map(call => call[1])).toEqual(['POST', 'GET', 'GET']);
    f.publisher.ledger.completeObject(original, receipt);
    expect(f.publisher.ledger.request(original.key)).toBeNull();
  });
  it('samples dependency proof after the failed query and keeps the third failure baseline across a publisher restart', async () => {
    const f = fixture(), original = sealedLive(f); f.context.recoveryDependencyEpoch = 0;
    f.request.mockRejectedValueOnce(rejected()); await expect(f.access.send(f.context, original)).rejects.toThrow(); f.advance();
    for (let index = 0; index < 3; index++) {
      f.request.mockImplementationOnce(async () => {
        if (index === 2) f.context.recoveryDependencyEpoch = 1;
        throw new Error('network unavailable');
      });
      await expect(f.access.send(f.context, original)).rejects.toThrow('network unavailable');
      vi.setSystemTime(Date.now() + 120_000);
    }
    f.publisher.invalidateContext();
    await expect(f.access.send(f.context, original)).rejects.toThrow('DEFERRED');
    expect(f.request).toHaveBeenCalledTimes(4);
    f.context.recoveryDependencyEpoch = 2;
    const receipt = { ...original.body, state: 'accepted', projectionRevision: '1', committedSeq: '1' };
    f.request.mockResolvedValueOnce(receipt);
    await expect(f.access.send(f.context, original)).resolves.toEqual(receipt);
    expect(f.request.mock.calls.map(call => call[1])).toEqual(['POST', 'GET', 'GET', 'GET', 'GET']);
    const row = f.publisher.ledger.db.prepare("SELECT body FROM availability_auto_recovery WHERE object_key='@lane-budget'").get() as { body: string };
    expect(JSON.parse(row.body).rounds.map((round: { dependencyEpoch: number }) => round.dependencyEpoch)).toEqual([0, 2]);
  });
  it('does not silently treat a damaged dependency proof as the initial epoch', async () => {
    const f = fixture(), original = sealedLive(f); f.request.mockRejectedValueOnce(rejected());
    await expect(f.access.send(f.context, original)).rejects.toThrow(); f.advance();
    f.context.recoveryDependencyEpoch = null;
    await expect(f.access.send(f.context, original)).rejects.toThrow('DEFERRED');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('resumes only the sealed part after its original parent is verified (paged=%s)', async paged => {
    const f = checkpointFixture(paged);
    await expect(f.bootstrap()).rejects.toMatchObject({ httpStatus: 400 });
    const first = f.request.mock.calls.find(call => call[1] === 'PUT')!;
    const originalBody = stableJson(first[2]); f.advance();
    await expect(f.bootstrap()).resolves.toBeUndefined();
    const repeated = f.request.mock.calls.filter(call => call[1] === 'PUT' && call[0] === first[0]);
    expect(repeated).toHaveLength(2); expect(stableJson(repeated[1][2])).toBe(originalBody);
    expect(f.request.mock.calls.some(call => call[0] === '/control/operations/checkpoint' && call[1] === 'GET')).toBe(true);
    expect(f.publisher.ledger.session(f.context.scope, 'local')?.phase).toBe('active');
  });
  it('uses a committed parent as the original checkpoint ACK without PUT or fabricated part receipt', async () => {
    const f = checkpointFixture(); await expect(f.bootstrap()).rejects.toThrow();
    f.parentCommitted(); f.advance(); f.request.mockClear();
    await f.bootstrap();
    expect(f.request.mock.calls.map(call => call.slice(0, 2))).toEqual([['/control/operations/checkpoint', 'GET']]);
    expect(f.publisher.ledger.operationReceipt('checkpoint')?.state).toBe('committed');
    expect(f.publisher.ledger.operationReceipt('step:checkpoint:part:0')).toBeNull();
  });
  it('confirms a lost history result only through the original request hash and epoch', async () => {
    const f = historyFixture(); f.request.mockRejectedValueOnce(rejected());
    await expect(f.recover()).rejects.toMatchObject({ httpStatus: 400 }); f.advance();
    f.request.mockResolvedValueOnce(f.receipt); await f.recover();
    expect(f.request.mock.calls.map(call => call[1])).toEqual(['GET', 'GET']);
    expect(f.store.history.operation(f.operation.context, f.operation.id)?.state).toBe('complete');
    expect(f.store.sync('local')?.ack_seq).toBe(0);
  });
  it.each(['requestHash', 'streamEpoch'] as const)('retains a pending history operation on mismatched %s', async field => {
    const f = historyFixture(); f.request.mockRejectedValueOnce(rejected()); await expect(f.recover()).rejects.toThrow();
    f.advance(); f.request.mockResolvedValueOnce({ ...f.receipt, [field]: 'wrong' });
    await expect(f.recover()).rejects.toThrow('HISTORY_RECEIPT_INVALID');
    expect(f.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
    expect(f.store.history.operation(f.operation.context, f.operation.id)?.state).toBe('pending');
  });
  it('does not turn an immutable history conflict into a replacement after an expired receipt', async () => {
    const f = historyFixture();
    f.request.mockRejectedValueOnce(Object.assign(rejected(), { data: { reason: 'INVALID_REMOTE_REQUEST',
      syncDiagnostic: { version: 1, cause: 'immutable_operation_conflict' } } }));
    await expect(f.recover()).rejects.toThrow(); f.advance(); f.request.mockResolvedValueOnce({ ...f.receipt, state: 'expired' });
    await expect(f.recover()).rejects.toThrow('EVIDENCE_INVALID');
    expect(f.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
    expect(f.store.history.operation(f.operation.context, f.operation.id)?.state).toBe('pending');
  });
  it('blocks a part that no longer matches its sealed paged manifest', async () => {
    const f = checkpointFixture(true); await expect(f.bootstrap()).rejects.toThrow();
    const original = f.publisher.ledger.request('checkpoint:checkpoint')!;
    original.body.pagedManifest.pageManifest[0].payloadHash = payloadHash('changed descriptor');
    f.publisher.ledger.updateRequest(original);
    f.advance(); f.request.mockClear(); await expect(f.bootstrap()).rejects.toThrow();
    expect(f.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
    expect(f.publisher.ledger.operationReceipt('checkpoint')).toBeNull();
  });
});
