import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { payloadHash } from './canonical';
import { type AvailabilityContext,RemoteAvailabilityPublisher } from './remoteAvailabilityPublisher';
import { RemoteLiveEncoderVersion } from './remoteLiveMetadata';
import { RemoteLiveRecovery } from './remoteLiveRecovery';
import { RemoteStore } from './remoteStore';

const telemetryEvents = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock('./remoteTelemetry', () => ({
  captureRemoteTelemetry: (base: Record<string, unknown> = {}) => ({
    emit: (event: string, fields: Record<string, unknown> = {}) => telemetryEvents.push({ event, fields: { ...base, ...fields } }),
  }),
  remoteTelemetryEvent: (event: string, fields: Record<string, unknown> = {}) => telemetryEvents.push({ event, fields }),
}));


vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: (level: 'debug' | 'warn' | 'error' | 'info', message: string, fields: Record<string, unknown>) => console[level](message, fields) }));

const cleanup: Array<() => void> = [];
afterEach(() => { telemetryEvents.length = 0; cleanup.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks(); });
function fixture() {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false }); store.setWake(() => {});
  const owner = { userId: '1', scopeKey: 'personal' };
  let context: AvailabilityContext | null = { scope: 'target:1:personal:desktop', owner, deviceId: 'desktop', generation: '1', supported: true, historySupported: true };
  store.transaction(() => {
    db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?,NULL,NULL)').run('local', 'Task', 'idle');
    store.assignNew('local', owner, 'local_create');
    db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,2,1)').run('message', 'local', 'assistant', 'Hello', '{}');
  });
  store.bindRemote('local', store.sync('local')!.session_id, 'desktop');
  const bootstraps = new Map<string, any>();
  const request = vi.fn(async (pathname: string, _method: string, body: any) => {
    if (pathname === '/sync/mode-activations') return { writerGeneration: body.writerGeneration, state: 'fenced', pendingCommandIds: [], pendingCommands: [] };
    if (pathname === '/control/bootstrap' || pathname === '/control/bootstrap/paged') {
      bootstraps.set(body.operationId, body);
      return { state: 'uploading', operationId: body.operationId, sessionId: body.sessionId, writerGeneration: body.writerGeneration };
    }
    if (/\/parts\/\d+$/u.test(pathname)) return { state: 'accepted' };
    if (pathname.endsWith('/commit')) {
      const operationId = pathname.split('/')[3], begin = bootstraps.get(operationId);
      return { state: 'committed', controlReady: true, operationId, sessionId: body.sessionId, writerGeneration: body.writerGeneration,
        controlEpoch: body.controlEpoch, manifestHash: begin?.manifestHash, coreCheckpointId: begin?.coreCheckpointId,
        throughFactSeq: begin?.throughFactSeq,
        ...(begin?.sourceManifestHash ? { sourceManifestHash: begin.sourceManifestHash, frozenThroughSourceSeq: begin.frozenThroughSourceSeq, expectedResolvedSourceSeq: begin.expectedResolvedSourceSeq } : {}) };
    }
    if (pathname === '/control/facts/batches') return { state: 'committed', lastFactSeq: body.lastFactSeq };
    if (pathname === '/sync/live-projections') return { publicationId: body.publicationId, sessionId: body.sessionId, writerGeneration: body.writerGeneration, objectKind: body.objectKind, objectId: body.objectId, sourceObjectRevision: body.sourceObjectRevision, state: 'accepted', projectionRevision: '900', committedSeq: '10' };
    throw Object.assign(new Error('unknown operation'), { httpStatus: 404 });
  });
  const publisher = new RemoteAvailabilityPublisher({ store, context: () => context, admitted: () => true, request });
  store.setIndependentControlReady(id => publisher.controlReady(id));
  cleanup.push(() => store.history.close());
  cleanup.push(() => publisher.dispose());
  const controls = (): Promise<void> => (publisher as any).controls(context);
  const live = (): Promise<void> => (publisher as any).live(context);
  return { db, store, owner, context: context!, setContext: (value: AvailabilityContext | null) => { context = value; }, request, publisher, controls, live };
}


function metadataFixture() {
  const f = fixture();
  f.context.publicationResolutionSupported = true;
  f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET type='tool_result',content='Updated document',metadata=? WHERE id='message'")
    .run(JSON.stringify({ toolCallId: 'call', toolName: 'Edit', isFinal: true, toolResultDetails: { diff: 'x'.repeat(32000), patch: 'y'.repeat(31000) } })));
  const revision = (f.db.prepare("SELECT revision FROM remote_live_revisions WHERE object_id='message'").get() as { revision: number }).revision;
  const fingerprint = payloadHash({ kind: 'message', objectId: 'message', revision: String(revision) });
  return { ...f, revision, fingerprint };
}

describe('bounded live metadata recovery', () => {
  it('recovers an old fault outside the recent window, publishes the tool, and removes evidence only after ACK', async () => {
    const f = metadataFixture();
    f.store.transaction(() => {
      for (let index = 0; index < 70; index++) f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?,?)')
        .run(`recent-${index}`, 'local', 'assistant', 'Newer message', '{}', 3 + index, 2 + index);
    });
    await f.controls();
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', f.fingerprint);
    f.publisher.ledger.db.prepare('UPDATE availability_faults SET next_retry=?').run(Date.now() + 86400000);
    await f.live();
    const message = f.request.mock.calls.find(call => call[0] === '/sync/live-projections' && call[2].objectId === 'message')?.[2];
    expect(message).toMatchObject({ sourceObjectRevision: String(f.revision), representation: 'complete', payload: { contentState: 'complete' } });
    expect(message.payload.blocks[0]).toMatchObject({ toolCallId: 'call', text: 'Updated document' });
    expect(message).not.toHaveProperty('toolSource');
    expect(message).not.toHaveProperty('encodingStats');
    expect(JSON.stringify(message)).not.toContain('patch');
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT tool_id FROM remote_live_tool_sources WHERE message_id='message'").get()).toEqual({ tool_id: 'call' });
    await f.live();
    const second = f.request.mock.calls.filter(call => call[0] === '/sync/live-projections').at(-1)?.[2];
    expect(second.objectId).toBe('recent-69');
    expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections' && call[2].objectKind === 'tool')).toBe(false);
    await f.live();
    const tool = f.request.mock.calls.find(call => call[0] === '/sync/live-projections' && call[2].objectKind === 'tool')?.[2];
    expect(tool.payload).toMatchObject({ toolCallId: 'call', name: 'Edit', status: 'succeeded' });
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_tool_refresh').get()).toEqual({ n: 0 });
    expect(f.store.sync('local')?.source_seq).toBe(f.store.sync('local')?.ack_seq);
  });

  it('persists a single upgrade probe across restart and keeps oversized records isolated', async () => {
    const f = metadataFixture();
    f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='message'")
      .run(JSON.stringify({ toolCallId: 'call', toolName: 'Edit', toolResultDetails: { diff: 'x'.repeat(270000) } })));
    const revision = (f.db.prepare("SELECT revision FROM remote_live_revisions WHERE object_id='message'").get() as { revision: number }).revision;
    const fingerprint = payloadHash({ kind: 'message', objectId: 'message', revision: String(revision) });
    await f.controls();
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', fingerprint);
    f.publisher.ledger.db.prepare('UPDATE availability_faults SET next_retry=?').run(Date.now() + 86400000);
    await f.live();
    const recovery = new RemoteLiveRecovery(f.publisher.ledger);
    expect(recovery.canAttempt(f.context.scope, 'local', 'message:message', fingerprint)).toBe(false);
    expect(f.publisher.ledger.db.prepare('SELECT attempts FROM availability_faults').get()).toEqual({ attempts: 2 });
    await f.live();
    expect(f.publisher.ledger.db.prepare('SELECT attempts FROM availability_faults').get()).toEqual({ attempts: 2 });
    expect(f.request.mock.calls.filter(call => call[0] === '/sync/live-projections')).toHaveLength(0);
  });

  it('pages old fault candidates and bounds manual retries without deleting faults', async () => {
    const f = fixture(), recovery = new RemoteLiveRecovery(f.publisher.ledger);
    for (let index = 0; index < 7; index++) {
      const id = `old-${index}`;
      f.store.transaction(() => f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?,?)').run(id, 'local', 'assistant', 'old', '{}', 1, index + 2));
      f.publisher.ledger.objectFault(f.context.scope, 'local', `message:${id}`, `hash-${index}`);
    }
    const first = recovery.candidates(f.db, f.context.scope, 'local'), second = recovery.candidates(f.db, f.context.scope, 'local');
    expect(first).toHaveLength(4); expect(second).toHaveLength(3);
    expect(new Set([...first, ...second].map(item => item.object_id)).size).toBe(7);
    expect(recovery.retry('different-scope', () => true)).toBe(0);
    expect(new RemoteLiveRecovery(f.publisher.ledger).retry(f.context.scope, () => false)).toBe(0);
    expect(recovery.retry(f.context.scope, () => true, 'local')).toBe(4);
    expect(recovery.retry(f.context.scope, () => true, 'local')).toBe(3);
    expect(recovery.retry(f.context.scope, () => true, 'local')).toBe(0);
    expect(new RemoteLiveRecovery(f.publisher.ledger).retry(f.context.scope, () => true, 'local')).toBe(0);
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 7 });
  });

  it('retains faults and sealed request bytes after an invalid ACK', async () => {
    const f = metadataFixture(); await f.controls();
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', f.fingerprint);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0] === '/sync/live-projections'
      ? { publicationId: 'wrong-publication', state: 'accepted', projectionRevision: '900', committedSeq: '10' } : original(...args));
    await f.live();
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 1 });
    const pending = f.publisher.ledger.db.prepare("SELECT key,body FROM availability_requests WHERE lane='live'").get();
    expect(pending).toBeDefined();
    expect(f.publisher.retryLive('local')).toBe(true);
    expect(f.publisher.ledger.db.prepare("SELECT key,body FROM availability_requests WHERE lane='live'").get()).toEqual(pending);
  });

  it('repairs stale tool display with CAS and does not invent a source revision', async () => {
    const f = metadataFixture(); await f.controls();
    const toolRevision = (f.db.prepare("SELECT revision FROM remote_live_tools WHERE tool_id='call'").get() as { revision: number }).revision;
    f.publisher.ledger.db.prepare('INSERT INTO availability_objects VALUES(?,?,?,?,?)').run(f.context.scope, 'local', 'tool:call', String(toolRevision),
      JSON.stringify({ state: 'accepted', projectionRevision: '899', representation: 'complete' }));
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', f.fingerprint);
    await f.live(); await f.live(); await f.live();
    const tool = f.request.mock.calls.find(call => call[0] === '/sync/live-projections' && call[2].objectKind === 'tool')?.[2];
    expect(tool).toMatchObject({ sourceObjectRevision: String(toolRevision), representation: 'repair', expectedProjectionRevision: '899', payload: { status: 'succeeded' } });
    expect(f.db.prepare("SELECT revision FROM remote_live_tools WHERE tool_id='call'").get()).toEqual({ revision: toolRevision });
    expect(f.publisher.ledger.object(f.context.scope, 'local', 'tool:call')?.result.representation).toBe('complete');
  });

  it('rejects late tool-source evidence after the source changes', () => {
    const f = metadataFixture(), recovery = new RemoteLiveRecovery(f.publisher.ledger);
    f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET content='new' WHERE id='message'").run());
    expect(() => recovery.recordToolSource(f.db, f.context.scope, 'local', { messageId: 'message', toolId: 'call', sourceRevision: String(f.revision) }))
      .toThrow('REMOTE_LIVE_ENCODER_CONTEXT_CHANGED');
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_tool_refresh').get()).toEqual({ n: 0 });
  });
});

describe('recovery conflict and fairness guards', () => {
  it('advances the tool refresh cursor past blocked entries and retains repair when a fault overlaps', () => {
    const f = fixture(), recovery = new RemoteLiveRecovery(f.publisher.ledger);
    for (let index = 0; index < 6; index++) {
      f.db.prepare('INSERT INTO remote_live_tools VALUES(?,?,?)').run('local', `tool-${index}`, 1);
      f.publisher.ledger.db.prepare('INSERT INTO availability_tool_refresh VALUES(?,?,?)').run(f.context.scope, 'local', `tool-${index}`);
    }
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'tool:tool-0', 'fingerprint');
    const first = recovery.candidates(f.db, f.context.scope, 'local'), second = recovery.candidates(f.db, f.context.scope, 'local');
    expect(first.filter(item => item.object_id === 'tool-0')).toEqual([{ kind: 'tool', object_id: 'tool-0', revision: 1, position: 0, repair: true }]);
    expect(second.some(item => item.object_id === 'tool-5' && item.repair)).toBe(true);
  });

  it('advances a manual retry page even when earlier sessions are ineligible', () => {
    const f = fixture(), recovery = new RemoteLiveRecovery(f.publisher.ledger);
    for (let index = 0; index < 5; index++) f.publisher.ledger.objectFault(f.context.scope, `local-${index}`, 'message:message', 'hash');
    expect(recovery.retry(f.context.scope, id => id === 'local-4')).toBe(0);
    recovery.reset(); // Reconnecting does not put the same denied page back at the front.
    expect(recovery.retry(f.context.scope, id => id === 'local-4')).toBe(1);
  });

  it('preserves recovery evidence when the receipt echoes another source object', async () => {
    const f = metadataFixture(); await f.controls();
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', f.fingerprint);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const response = await original(...args);
      return args[0] === '/sync/live-projections' ? { ...response, objectId: 'other-message' } : response;
    });
    await f.live();
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 1 });
    expect(f.publisher.ledger.db.prepare("SELECT count(*) AS n FROM availability_requests WHERE lane='live'").get()).toEqual({ n: 1 });
    expect(f.publisher.ledger.object(f.context.scope, 'local', 'message:message')).toBeNull();
  });

  it('backs off a sealed tool CAS conflict across restarts instead of creating new publications each tick', async () => {
    const f = metadataFixture(); await f.controls();
    const toolRevision = (f.db.prepare("SELECT revision FROM remote_live_tools WHERE tool_id='call'").get() as { revision: number }).revision;
    f.publisher.ledger.db.prepare('INSERT INTO availability_objects VALUES(?,?,?,?,?)').run(f.context.scope, 'local', 'tool:call', String(toolRevision),
      JSON.stringify({ state: 'accepted', projectionRevision: '899', representation: 'complete' }));
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', f.fingerprint);
    await f.live();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const [path, , body] = args;
      if (path === '/sync/live-projections' && body.objectKind === 'tool') throw Object.assign(new Error('changed cloud head'), { httpStatus: 409 });
      if (path.endsWith('/resolve')) {
        const { mode: _mode, connectionGeneration: _connection, ...business } = body;
        const publicationId = path.split('/')[3];
        return { publicationId, sessionId: body.sessionId, writerGeneration: body.writerGeneration,
          state: 'sealed_unpublished', sealId: 'seal', resolutionRequestHash: payloadHash({ ...business, publicationId }) };
      }
      return original(...args);
    });
    await f.live(); await f.live();
    const count = () => f.request.mock.calls.filter(call => call[0] === '/sync/live-projections' && call[2].objectKind === 'tool').length;
    expect(count()).toBe(1);
    for (let index = 0; index < 8; index++) await f.live();
    expect(count()).toBe(1);
    const fingerprint = payloadHash({ kind: 'tool', objectId: 'call', revision: String(toolRevision) });
    expect(new RemoteLiveRecovery(f.publisher.ledger).canAttempt(f.context.scope, 'local', 'tool:call', fingerprint)).toBe(false);
    expect(f.publisher.ledger.db.prepare("SELECT count(*) AS n FROM availability_faults WHERE object_key='tool:call'").get()).toEqual({ n: 1 });
    expect(f.publisher.ledger.object(f.context.scope, 'local', 'tool:call')?.result.projectionRevision).toBe('899');
  });
});


describe('recovery scheduling and durable ACK regressions', () => {
  it('advances exactly four archived faults and fresh messages without consuming the recovery page on recent turns', async () => {
    const f = fixture(); await f.controls(); await f.live();
    const oldIds = Array.from({ length: 4 }, (_, index) => `archived-${index}`);
    f.store.transaction(() => {
      for (const [index, id] of oldIds.entries()) f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?,?)')
        .run(id, 'local', 'assistant', 'Archived message', '{}', 2 + index, 2 + index);
      for (let index = 0; index < 70; index++) f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?,?)')
        .run(`tail-${index}`, 'local', 'assistant', 'Recent message', '{}', 10 + index, 10 + index);
    });
    for (const id of oldIds) {
      const { revision } = f.db.prepare('SELECT revision FROM remote_live_revisions WHERE object_id=?').get(id) as { revision: number };
      f.publisher.ledger.objectFault(f.context.scope, 'local', `message:${id}`,
        payloadHash({ kind: 'message', objectId: id, revision: String(revision) }));
    }
    f.publisher.ledger.db.prepare('UPDATE availability_faults SET next_retry=?').run(Date.now() + 86400000);
    f.request.mockClear();
    for (let turn = 0; turn < 12; turn++) {
      f.store.transaction(() => f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?,?)')
        .run(`fresh-${turn}`, 'local', 'assistant', 'Newest message', '{}', 100 + turn, 100 + turn));
      await f.live();
      if (turn === 0) {
        expect(f.request.mock.calls.filter(call => call[0] === '/sync/live-projections').map(call => call[2].objectId)).toEqual(['fresh-0']);
        expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 4 });
      }
    }
    const published = f.request.mock.calls.filter(call => call[0] === '/sync/live-projections').map(call => call[2].objectId as string);
    expect(published.filter(id => oldIds.includes(id)).sort()).toEqual(oldIds);
    expect(published.filter(id => id.startsWith('fresh-')).length).toBeGreaterThanOrEqual(6);
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 0 });
  });

  it('keeps strict recovery validation on a rejected publication fallback and preserves evidence after an incomplete ACK', async () => {
    const f = metadataFixture(); await f.controls();
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', f.fingerprint);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const [path, , body] = args;
      if (path !== '/sync/live-projections') return original(...args);
      if (body.representation === 'complete') return { publicationId: body.publicationId, sessionId: body.sessionId,
        writerGeneration: body.writerGeneration, objectId: body.objectId, state: 'rejected', reason: 'INVALID_REMOTE_REQUEST', committedSeq: '0' };
      return { publicationId: body.publicationId, state: 'accepted' };
    });
    await f.live();
    const fallback = f.publisher.ledger.pending(f.context.scope, 'live', 'local')[0];
    expect(fallback).toMatchObject({ liveEncoderVersion: RemoteLiveEncoderVersion,
      body: { objectId: 'message', representation: 'desktop_only', payload: { contentState: 'desktop_only', blocks: [] } } });
    const sealedBody = JSON.stringify(fallback.body);
    await f.live();
    const retained = f.publisher.ledger.request(fallback.key);
    expect(retained).toMatchObject({ key: fallback.key, liveEncoderVersion: RemoteLiveEncoderVersion, attempted: true });
    expect(JSON.stringify(retained?.body)).toBe(sealedBody);
    expect(f.publisher.ledger.object(f.context.scope, 'local', 'message:message')?.result.state).toBe('rejected');
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 1 });
    expect(f.request.mock.calls.filter(call => call[0] === '/sync/live-projections' && call[2].representation === 'desktop_only')).toHaveLength(1);
  });

  it('re-encodes a same-source rejected tool after an encoder upgrade without inventing a source revision or CAS base', async () => {
    const f = metadataFixture(); await f.controls();
    const recovery = new RemoteLiveRecovery(f.publisher.ledger);
    recovery.recordToolSource(f.db, f.context.scope, 'local', { messageId: 'message', toolId: 'call', sourceRevision: String(f.revision) });
    const { revision } = f.db.prepare("SELECT revision FROM remote_live_tools WHERE tool_id='call'").get() as { revision: number };
    const fingerprint = payloadHash({ kind: 'tool', objectId: 'call', revision: String(revision) });
    f.publisher.ledger.db.prepare('INSERT INTO availability_objects VALUES(?,?,?,?,?)').run(f.context.scope, 'local', 'tool:call', String(revision),
      JSON.stringify({ publicationId: 'old-rejected', state: 'rejected', representation: 'complete', reason: 'INVALID_REMOTE_REQUEST' }));
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'tool:call', fingerprint);
    f.publisher.ledger.db.prepare('UPDATE availability_faults SET next_retry=?').run(Date.now() + 86400000);
    f.publisher.ledger.db.prepare('INSERT INTO availability_encoding_probes VALUES(?,?,?,?,?,-1)')
      .run(f.context.scope, 'local', 'tool:call', fingerprint, RemoteLiveEncoderVersion - 1);
    await f.live();
    const tool = f.request.mock.calls.find(call => call[0] === '/sync/live-projections' && call[2].objectKind === 'tool')?.[2];
    expect(tool).toMatchObject({ objectId: 'call', sourceObjectRevision: String(revision), representation: 'complete',
      payload: { toolCallId: 'call', name: 'Edit', status: 'succeeded' } });
    expect(tool.publicationId).not.toBe('old-rejected');
    expect(tool).not.toHaveProperty('expectedProjectionRevision');
    expect(f.db.prepare("SELECT revision FROM remote_live_tools WHERE tool_id='call'").get()).toEqual({ revision });
    expect(f.publisher.ledger.object(f.context.scope, 'local', 'tool:call')?.result.state).toBe('accepted');
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 0 });
  });

  it('retains the fault and original request when a matching strict ACK cannot be committed locally', async () => {
    const f = metadataFixture(); await f.controls();
    f.publisher.ledger.objectFault(f.context.scope, 'local', 'message:message', f.fingerprint);
    // Inject failure before the ledger transaction; this is not a disk-failure simulation.
    const commit = vi.spyOn(f.publisher.ledger, 'completeObject').mockImplementationOnce(() => { throw new Error('simulated ACK commit failure'); });
    await f.live();
    expect(commit).toHaveBeenCalledTimes(1);
    const [request, result] = commit.mock.calls[0];
    expect(request.liveEncoderVersion).toBe(RemoteLiveEncoderVersion);
    expect(result).toMatchObject({ publicationId: request.body.publicationId, sessionId: request.body.sessionId,
      writerGeneration: request.body.writerGeneration, objectKind: request.body.objectKind, objectId: request.body.objectId,
      sourceObjectRevision: request.body.sourceObjectRevision, state: 'accepted', projectionRevision: '900', committedSeq: '10' });
    expect(f.publisher.ledger.request(request.key)?.body).toEqual(request.body);
    expect(f.publisher.ledger.object(f.context.scope, 'local', 'message:message')).toBeNull();
    expect(f.publisher.ledger.db.prepare('SELECT count(*) AS n FROM availability_faults').get()).toEqual({ n: 1 });
  });
});
