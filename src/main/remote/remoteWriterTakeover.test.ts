import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteDeletion } from '../../shared/remote/deletions';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { payloadHash, stableJson } from './canonical';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { rememberRemoteDeletionAdoption } from './remoteDeletionSyncState';
import { LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX } from './remoteImportSnapshots';
import { projectLiveMessage } from './remoteLiveProjection';
import { RemoteStore } from './remoteStore';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
vi.mock('./remoteTelemetry', () => ({ captureRemoteTelemetry: () => ({ emit: vi.fn() }), remoteTelemetryEvent: vi.fn() }));
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(filename?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-writer-takeover-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = new Database(filename || join(directory, 'core.sqlite')); cleanup.push(() => { if (db.open) db.close(); });
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE IF NOT EXISTS cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); cleanup.push(() => store.history.close());
  const owner = { userId: '1', scopeKey: 'personal' };
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'i', deviceKey: 'secret', databaseId: 'db' },
    runSessionTransaction: operation => store.transaction(operation), getOwner: () => owner,
    getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request: vi.fn(), execute: vi.fn(), prepare: vi.fn(), onAccountChange: vi.fn(),
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
  });
  cleanup.push(() => bridge.stop());
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1', syncTarget: {} };
  bridge.generation = '1'; bridge.retentionSupported = true;
  bridge.capabilitySnapshot = { capabilities: ['control_facts_v1', 'live_projections_v3'] };
  const target = bridge.targets.activateLegacy({ owner, deviceId: 'desktop', allowPartialLegacy: true });
  bridge.targetId = target.targetId; store.setProjectionIdentity(target.targetId, owner, 'desktop'); store.setEnabledOwner(owner);
  if (!store.sync('local')) store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('local','Task',1,1,'idle',NULL,NULL)"); store.assignNew('local', owner, 'local_create'); });
  store.bindRemote('local', store.sync('local')!.session_id, 'desktop'); store.setWake(() => {}); store.transaction(() => {});
  const publisher = bridge.availability, context = publisher.deps.context();
  cleanup.push(() => publisher.dispose());
  const activation = deferred<any>(), activationStarted = deferred<void>();
  const server = { tookOver: false, holdActivation: true, writer: null as any, beginResult: null as any };
  const api = vi.spyOn(bridge, 'api').mockImplementation(async (pathname: unknown, _method: unknown, body: any) => {
    if (String(pathname).startsWith('/sync/state')) {
      const row = store.sync('local')!;
      if (server.tookOver) {
        if (server.writer?.state === 'fenced') throw new RemoteApiError(47003, '控制事实正在核对', { reason: 'DEVICE_NOT_READY', reasonDetail: 'CONTROL_BASELINE_REQUIRED' }, 409);
        return server.writer;
      }
      return { sessionId: row.session_id, localSessionId: 'local', deviceId: 'desktop', syncProtocolVersion: 1, streamEpoch: null,
        lastSourceSeq: '0', lastSeq: '0', sourcePurgeSeq: '0', eventPurgeSeq: '0', activeImport: null };
    }
    if (pathname === '/sync/mode-activations') {
      server.tookOver = true; server.writer = { sessionId: body.sessionId, writerGeneration: body.writerGeneration, state: 'fenced' };
      activationStarted.resolve(); return server.holdActivation ? activation.promise : server.writer;
    }
    if (pathname === '/sync/imports') {
      if (server.beginResult) return server.beginResult;
      if (server.tookOver) throw new RemoteApiError(47006, '会话已切换独立同步通道', { reason: 'IDEMPOTENCY_CONFLICT', reasonDetail: 'WRITER_TAKEOVER' }, 409);
      throw new Error('unexpected legacy begin');
    }
    if (String(pathname).startsWith('/control/bootstrap')) throw new Error('hold bootstrap');
    throw new Error(`unexpected ${String(pathname)} ${body?.operationId || ''}`);
  });
  return { bridge, store, db, publisher, context, activation, activationStarted, api, server };
}

describe('legacy import and availability writer handoff', () => {
  it('does not freeze or send a legacy package when availability takes over during async encoding', async () => {
    const f = fixture(), encoded = deferred<any>(), encoding = deferred<void>();
    const snapshot = f.store.snapshot('local'), payload = { records: snapshot.records };
    f.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run('local');
    expect(f.bridge.sessionAdmitted('local')).toBe(true);
    const part = { partNo: 0, payloadHash: payloadHash(payload), byteSize: Buffer.byteLength(stableJson(payload)) };
    vi.spyOn(f.bridge.importSnapshots, 'create').mockImplementation(async () => { encoding.resolve(); return encoded.promise; });
    const importing = f.bridge.importSession(f.store.sync('local'), null, true).catch((error: unknown) => error);
    await Promise.race([encoding.promise, importing.then((value: unknown) => { throw value || new Error("import returned before encoding"); })]);
    const controls = f.publisher.controls(f.context);
    await Promise.race([f.activationStarted.promise, controls.then(() => { throw new Error("controls returned before activation"); })]);
    const state = f.publisher.ledger.session(f.context.scope, 'local');
    expect(state.phase).toBe('activating');
    encoded.resolve({ fileSet: randomUUID(), parts: [part], manifest: { partCount: 1, recordCounts: { 'session.upsert': 1 }, manifestHash: payloadHash([part]) } });
    const failure = await importing;
    expect(failure).toMatchObject({ message: 'REMOTE_IMPORT_CONTEXT_CHANGED' });
    expect(f.api.mock.calls.some(call => call[0] === '/sync/imports')).toBe(false);
    expect(f.store.get('import:local')).toBeNull();
    expect(f.store.sync('local')).toMatchObject({ migration_frozen: 0, ack_seq: 0, sync_protocol_version: 1 });
    expect(f.publisher.legacyHistoryAllowed('local')).toBe(false);
    expect(f.publisher.candidates(f.context, 'control')).toHaveLength(1);
    f.activation.resolve({ writerGeneration: state.writerGeneration, state: 'fenced', pendingCommandIds: [], pendingCommands: [] });
    await controls;
  });
});

function frozenFixture(attempted = true) {
  const f = fixture(), row = f.store.sync('local')!;
  const writer = { scope: f.context.scope, localId: 'local', sessionId: row.session_id, writerGeneration: randomUUID(), controlEpoch: randomUUID(),
    phase: 'bootstrap', operationId: randomUUID(), pendingCommandIds: [], pendingRunIds: [], controlRevision: '0', factSeq: '0', records: {} };
  f.publisher.ledger.saveSession(writer);
  const binding = { scope: writer.scope, sessionId: writer.sessionId, deviceId: 'desktop', writerGeneration: writer.writerGeneration, controlEpoch: writer.controlEpoch };
  rememberRemoteDeletionAdoption(f.store, 'local', { ...f.context, adopted: true, controlBinding: binding }, binding);
  const part = { partNo: 0, payloadHash: 'part-hash', byteSize: 200 };
  const saved = { importId: randomUUID(), sessionId: row.session_id, owner: f.context.owner, environment: f.context.targetId, deviceId: 'desktop',
    reason: 'protocol_upgrade', syncProtocolVersion: 2, migration: true, expectedStreamEpoch: null, beginAttempted: attempted,
    baseSourceSeq: String(row.source_seq), expectedSourceSeq: '0', expectedServerSeq: '0', snapshotEpoch: 0,
    manifest: { partCount: 1, recordCounts: { 'session.upsert': 1 }, manifestHash: payloadHash([part]) }, parts: [part], fileSet: randomUUID() };
  f.store.put('import:local', saved); f.store.freezeMigration('local');
  f.bridge.taskSync.fail(f.bridge.taskContext(), 'local', { phase: 'isolated', scope: 'session', reason: 'IDEMPOTENCY_CONFLICT' });
  f.server.tookOver = true; f.server.writer = { sessionId: row.session_id, writerGeneration: writer.writerGeneration, state: 'fenced' };
  const recover = () => f.bridge.reconcileTakenOverImports(f.bridge.taskContext(), f.bridge.syncContext());
  return { ...f, saved, writer, recover };
}

describe('persisted unallocated legacy import recovery', () => {
  it.each([false, true])('releases only the migration freeze with original evidence preserved (attempted=%s)', async attempted => {
    const f = frozenFixture(attempted), before = f.store.sync('local');
    expect(f.bridge.taskSync.candidates(f.bridge.taskContext())).toEqual([]);
    expect(f.publisher.candidates(f.context, 'control')).toEqual([]);
    await f.recover();
    expect(f.store.sync('local')).toEqual({ ...before, migration_frozen: 0 });
    expect(f.store.get('import:local')).toBeNull();
    expect(f.store.get(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`)).toMatchObject({ importId: f.saved.importId, manifestHash: f.saved.manifest.manifestHash,
      savedImport: f.saved, writer: { writerGeneration: f.writer.writerGeneration }, proof: attempted ? 'begin_rejected_writer_takeover' : 'never_sent' });
    const begin = f.api.mock.calls.find(call => call[0] === '/sync/imports');
    if (attempted) expect(begin?.[2]).toMatchObject({ importId: f.saved.importId, sessionId: f.saved.sessionId, baseSourceSeq: f.saved.baseSourceSeq,
      expectedSourceSeq: '0', expectedServerSeq: '0', expectedStreamEpoch: null, manifest: f.saved.manifest, syncProtocolVersion: 2 });
    else expect(begin).toBeUndefined();
    expect(f.publisher.candidates(f.context, 'control')).toHaveLength(1);
    expect(f.publisher.legacyHistoryAllowed('local')).toBe(false);
  });
  it.each(['uploading', 'committed', 'aborted', 'expired'])('preserves an allocated original import (%s)', async state => {
    const f = frozenFixture(); f.server.beginResult = { state, importId: f.saved.importId, sessionId: f.saved.sessionId };
    await f.recover();
    expect(f.store.sync('local')?.migration_frozen).toBe(1);
    expect(f.store.get('import:local')).toEqual(f.saved);
    expect(f.store.get(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`)).toBeNull();
    expect(f.publisher.candidates(f.context, 'live')).toEqual([]);
  });
  it('rolls back the proof and freeze together, then retries independently after a storage failure', async () => {
    const f = frozenFixture();
    f.db.exec("CREATE TRIGGER reject_unfreeze BEFORE UPDATE OF migration_frozen ON remote_sync WHEN NEW.migration_frozen=0 BEGIN SELECT RAISE(ABORT,'storage unavailable'); END");
    await f.recover();
    expect(f.store.get(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`)).toBeNull();
    expect(f.store.sync('local')?.migration_frozen).toBe(1);
    expect(f.store.get('import:local')).toEqual(f.saved);
    const attempts = f.api.mock.calls.length;
    await f.recover(); expect(f.api).toHaveBeenCalledTimes(attempts);
    f.db.exec('DROP TRIGGER reject_unfreeze');
    f.bridge.legacyImportRecoveryRetry.clear();
    await f.recover(); expect(f.store.sync('local')?.migration_frozen).toBe(0);
  });
  it('recovers an isolated frozen import after reopening both core and control databases', async () => {
    const first = frozenFixture(), filename = first.db.name, saved = first.saved, writer = first.writer;
    first.bridge.stop(); first.publisher.dispose(); first.store.history.close(); first.db.close();
    const restored = fixture(filename);
    restored.server.tookOver = true;
    restored.server.writer = { sessionId: writer.sessionId, writerGeneration: writer.writerGeneration, state: 'fenced' };
    expect(restored.publisher.ledger.session(restored.context.scope, 'local')).toMatchObject({ writerGeneration: writer.writerGeneration });
    expect(restored.store.sync('local')?.migration_frozen).toBe(1);
    expect(restored.bridge.taskSync.candidates(restored.bridge.taskContext())).toEqual([]);
    const read = restored.publisher.ledger.session.bind(restored.publisher.ledger);
    vi.spyOn(restored.publisher.ledger, 'session').mockImplementation((...args: any[]) => {
      expect(restored.db.inTransaction).toBe(false);
      return read(...args);
    });
    await restored.bridge.syncSessions(true);
    expect(restored.store.sync('local')?.migration_frozen).toBe(0);
    expect(restored.store.get('import:local')).toBeNull();
    expect(restored.store.get(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${saved.importId}`)).toMatchObject({ savedImport: saved });
    expect(restored.publisher.candidates(restored.context, 'control')).toHaveLength(1);
    expect(restored.api.mock.calls.map(call => String(call[0]).split('?')[0])).toEqual(['/sync/state', '/sync/imports']);
  });
  it.each(['owner', 'target', 'device', 'session', 'reason', 'manifest', 'confirmed', 'adoption', 'fence', 'deleted'])('retains an unsafe original identity: %s', async change => {
    const f = frozenFixture();
    if (change === 'owner') f.saved.owner = { userId: 'different', scopeKey: 'personal' };
    if (change === 'target') f.saved.environment = 'different';
    if (change === 'device') f.saved.deviceId = 'different';
    if (change === 'session') f.saved.sessionId = 'different';
    if (change === 'reason') f.saved.reason = 'initial_sync';
    if (change === 'manifest') f.saved.manifest.manifestHash = 'different';
    if (change === 'confirmed') Object.assign(f.saved, { beginConfirmed: true });
    if (change === 'adoption') f.db.prepare("UPDATE remote_state SET value='{' WHERE key LIKE 'remoteDeletionAdoption:%'").run();
    if (change === 'fence') f.store.put(`${RemoteDeletion.Fence}local`, { deletionId: 'deleting' });
    if (change === 'deleted') f.store.put('localGcDeleted:local', { deletedAt: 1 });
    f.store.put('import:local', f.saved);
    await f.recover();
    expect(f.store.sync('local')?.migration_frozen).toBe(1);
    expect(f.store.get(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`)).toBeNull();
    expect(f.api).not.toHaveBeenCalled();
  });
  it.each(['writer', 'epoch', 'not-ready', 'wrong-code', 'timeout', 'other-conflict', 'missing'])('requires precise online and unallocated proofs: %s', async failure => {
    const f = frozenFixture();
    if (failure === 'writer' || failure === 'epoch') f.server.writer = { sessionId: f.saved.sessionId,
      writerGeneration: failure === 'writer' ? 'different' : f.writer.writerGeneration, state: 'active', controlReady: true,
      controlEpoch: failure === 'epoch' ? 'different' : f.writer.controlEpoch };
    if (failure === 'not-ready') f.api.mockRejectedValueOnce(new RemoteApiError(47003, 'not ready', { reason: 'DEVICE_NOT_READY', reasonDetail: 'OTHER_REASON' }, 409));
    if (failure === 'wrong-code') f.api.mockRejectedValueOnce(new RemoteApiError(47006, 'not ready', { reason: 'DEVICE_NOT_READY', reasonDetail: 'CONTROL_BASELINE_REQUIRED' }, 409));
    if (failure === 'timeout') f.api.mockRejectedValueOnce(new Error('network unavailable'));
    if (failure === 'other-conflict' || failure === 'missing') {
      const original = f.api.getMockImplementation()!;
      f.api.mockImplementation(async (...args: any[]) => {
        if (args[0] === '/sync/imports') throw failure === 'missing' ? new RemoteApiError(47002, 'missing', {}, 404)
          : new RemoteApiError(47006, 'conflict', { reason: 'IDEMPOTENCY_CONFLICT', reasonDetail: 'OTHER_CONFLICT' }, 409);
        return original(...args);
      });
    }
    await f.recover();
    expect(f.store.sync('local')?.migration_frozen).toBe(1);
    expect(f.store.get(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`)).toBeNull();
    const count = f.api.mock.calls.length;
    await f.recover(); expect(f.api).toHaveBeenCalledTimes(count);
  });
  it.each(['generation', 'writer', 'controlEpoch', 'import', 'target', 'deletion'])('rechecks identity after a pending request: %s', async change => {
    const f = frozenFixture();
    f.api.mockImplementationOnce(async () => {
      if (change === 'generation') f.bridge.generation = '2';
      if (change === 'target') { const target = f.bridge.targetId; f.bridge.targetId = 'other'; f.bridge.accountGeneration++; f.bridge.targetId = target; }
      if (change === 'writer' || change === 'controlEpoch') f.publisher.ledger.saveSession({ ...f.writer,
        ...(change === 'writer' ? { writerGeneration: randomUUID() } : { controlEpoch: randomUUID() }) });
      if (change === 'import') f.store.put('import:local', { ...f.saved, importId: randomUUID() });
      if (change === 'deletion') f.store.put('localGcDeleted:local', { deletedAt: 1 });
      throw new RemoteApiError(47003, 'not ready', { reason: 'DEVICE_NOT_READY', reasonDetail: 'CONTROL_BASELINE_REQUIRED' }, 409);
    });
    await f.recover();
    expect(f.store.sync('local')?.migration_frozen).toBe(1);
    expect(f.store.get(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`)).toBeNull();
    expect(f.api).toHaveBeenCalledTimes(1);
  });

  it('keeps the archived spool after releasing the active import and fails closed on a corrupt archive', async () => {
    const f = frozenFixture(), snapshots = f.bridge.importSnapshots;
    const spool = snapshots.directory(f.saved.fileSet);
    mkdirSync(spool, { recursive: true }); writeFileSync(join(spool, '0.json'), 'original immutable part');
    await f.recover();
    expect(f.store.get('import:local')).toBeNull();
    await snapshots.collect(); expect(existsSync(join(spool, '0.json'))).toBe(true);
    const orphan = snapshots.directory(randomUUID()); mkdirSync(orphan); writeFileSync(join(orphan, '0.json'), 'unknown');
    f.db.prepare('UPDATE remote_state SET value=? WHERE key=?').run('{', `${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`);
    await snapshots.collect();
    expect(existsSync(join(spool, '0.json'))).toBe(true); expect(existsSync(join(orphan, '0.json'))).toBe(true);
  });

  it.each([null, false])('never overwrites an existing invalid archive (%s)', async previous => {
    const f = frozenFixture(), key = `${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}${f.saved.importId}`;
    f.store.put(key, previous);
    await f.recover();
    expect(f.store.get(key)).toBe(previous);
    expect(f.store.get('import:local')).toEqual(f.saved);
    expect(f.store.sync('local')?.migration_frozen).toBe(1);
  });
  it('publishes the completed run baseline and final message after recovering the original frozen task', async () => {
    const f = frozenFixture();
    f.store.beginRun('local', 'completed-run'); f.store.updateRun('local', 'running'); f.store.updateRun('local', 'succeeded');
    f.store.transaction(() => f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?,?)')
      .run('final', 'local', 'assistant', 'Excel 已完成', '{}', 2, 1));
    const oldRow = f.store.sync('local');
    const ordinary = f.api.getMockImplementation()!;
    const bootstraps = new Map<string, any>();
    f.api.mockImplementation(async (...args: any[]) => {
      const [pathname, , body] = args;
      if (pathname === '/control/bootstrap') {
        bootstraps.set(body.operationId, body);
        return { state: 'uploading', operationId: body.operationId, sessionId: body.sessionId, writerGeneration: body.writerGeneration };
      }
      if (/\/parts\/\d+$/u.test(pathname)) return { state: 'accepted' };
      if (pathname.endsWith('/commit')) {
        const begin = bootstraps.get(pathname.split('/')[3]);
        return { state: 'committed', controlReady: true, operationId: begin.operationId, sessionId: begin.sessionId,
          writerGeneration: begin.writerGeneration, controlEpoch: begin.controlEpoch, manifestHash: begin.manifestHash,
          coreCheckpointId: begin.coreCheckpointId, throughFactSeq: begin.throughFactSeq };
      }
      if (pathname === '/control/facts/batches') return { state: 'committed', lastFactSeq: body.lastFactSeq };
      if (pathname === '/sync/live-projections') return { publicationId: body.publicationId, sessionId: body.sessionId,
        writerGeneration: body.writerGeneration, objectKind: body.objectKind, objectId: body.objectId,
        sourceObjectRevision: body.sourceObjectRevision, state: 'accepted', projectionRevision: '1', committedSeq: '1' };
      return ordinary(...args);
    });
    vi.spyOn(f.publisher.encoder, 'project').mockImplementation(async (db: any, input: any) => projectLiveMessage(db, input));
    await f.recover();
    await f.publisher.controls(f.context); await f.publisher.live(f.context);
    expect(f.publisher.ledger.session(f.context.scope, 'local')?.phase).toBe('active');
    const records = f.api.mock.calls.filter(call => /\/parts\/\d+$/u.test(String(call[0]))).flatMap(call => (call[2] as any).records);
    expect(records.some(record => record.eventType === 'run.updated' && record.payload.run.runId === 'completed-run'
      && record.payload.run.status === 'succeeded')).toBe(true);
    const publication = f.api.mock.calls.find(call => call[0] === '/sync/live-projections')?.[2] as any;
    expect(publication).toMatchObject({ objectKind: 'message', objectId: 'final', payload: { blocks: [{ type: 'markdown', text: 'Excel 已完成' }] } });
    expect(f.publisher.ledger.pending(f.context.scope, 'live', 'local')).toEqual([]);
    expect(f.store.sync('local')).toEqual({ ...oldRow, migration_frozen: 0 });
    expect(f.store.get('import:local')).toBeNull();
  });

});
