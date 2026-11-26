import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { build } from 'esbuild';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Worker } from 'worker_threads';

import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteImportValidation, RemoteRetention } from '../../shared/remote/retention';
import { payloadHash, stableJson } from './canonical';
import { RemoteBridge } from './remoteBridge';
import { RemoteImportSnapshotError, RemoteImportSnapshots } from './remoteImportSnapshots';
import type { ImportSnapshotIdentity, ImportSnapshotPackage } from './remoteImportSnapshotWorker';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';
import { RemoteTaskSyncState, TaskSyncPhase } from './remoteTaskSyncState';

const workerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-import-worker-'));
const workerPath = path.join(workerDirectory, 'worker.cjs');
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await build({ entryPoints: [path.join(__dirname, 'remoteImportSnapshotWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: workerPath,
    plugins: [{ name: 'native-sqlite', setup(builder) { builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }] });
});
afterAll(() => fs.rmSync(workerDirectory, { recursive: true, force: true }));
const owner = { userId: 'A', scopeKey: 'personal' }, environment = RemoteEnvironment.Test;
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });
function fixture(count = 10, size = 10) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-import-'));
  disposals.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new Database(path.join(directory, 'core.sqlite')); disposals.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner);
  store.publicationOrigins.setRouteProvider(() => 'https://example.com');
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('task','Task',1,1,'idle')"); store.assignNew('task', owner, 'local_create'); });
  store.bindRemote('task', store.sync('task')!.session_id, 'desktop');
  store.setProjectionIdentity(environment, owner, 'desktop'); store.setWake(() => {});
  db.transaction(() => {
    for (let n = 0; n < count; n++) db.prepare('INSERT INTO remote_projection VALUES (?,?,?,?,?)').run('task', `message:${String(n).padStart(6, '0')}`, 'hash', 1,
      stableJson({ eventType: 'message.upsert', payload: { message: { messageId: String(n), revision: '1', ordinal: String(n + 1), blocks: [{ type: 'text', text: '中'.repeat(size) }] } } }));
  })();
  const snapshots = new RemoteImportSnapshots(store, workerPath);
  const identity = () => snapshots.identity('task', owner, 'desktop', environment);
  return { directory, db, store, snapshots, identity };
}
function bridgeFixture(f = fixture()) {
  const request = vi.fn();
  const bridge: any = new RemoteBridge({ store: f.store, identity: { installationId: 'i', deviceKey: 'secret', databaseId: 'db' },
    runSessionTransaction: operation => f.store.transaction(operation), getOwner: () => owner, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com',
    request, execute: vi.fn(), prepare: vi.fn(), onAccountChange: vi.fn(),
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
  });
  bridge.importSnapshots = f.snapshots;
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' }; bridge.generation = '1';
  disposals.push(() => bridge.stop()); f.store.setWake(() => {});
  f.store.publicationOrigins.confirm(owner, 'https://example.com', null, `legacy:${payloadHash([owner.userId, owner.scopeKey, 'desktop'])}`);
  return { ...f, bridge, request };
}
const ok = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));
function saved(f: ReturnType<typeof fixture>, overrides: object = {}) {
  const row = f.store.sync('task')!;
  return { importId: randomUUID(), fileSet: randomUUID(), sessionId: row.session_id, owner, deviceId: 'desktop', environment,
    projectionVersion: 1, snapshotEpoch: 0, baseSourceSeq: String(row.source_seq), expectedSourceSeq: '0', expectedServerSeq: '0',
    parts: [{ partNo: 0, payloadHash: 'missing', byteSize: 20 }], manifest: { partCount: 1, manifestHash: 'manifest', recordCounts: { 'session.upsert': 1 } }, ...overrides };
}
function buildCapturedSnapshot(f: ReturnType<typeof fixture>, identity: ImportSnapshotIdentity): Promise<{ result?: ImportSnapshotPackage; error?: string }> {
  const fileSet = randomUUID();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { operation: 'build', database: f.db.name,
      directory: path.join(f.directory, fileSet), fileSet, identity } });
    worker.once('message', resolve); worker.once('error', reject);
  });
}

describe('immutable import snapshot worker', () => {
  it('waits for this task projection and rejects a dirty marker added after identity capture in the actual worker', async () => {
    const f = fixture(), identity = f.identity();
    f.db.prepare('INSERT INTO remote_dirty VALUES (?)').run('task');
    expect(f.identity).toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
    expect(await buildCapturedSnapshot(f, identity)).toEqual({ error: 'REMOTE_IMPORT_CONTEXT_CHANGED' });
    f.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run('task');
    const result = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    expect(result.manifest.recordCounts['session.upsert']).toBe(1);
  });
  it('rejects publication started after identity capture without blocking another task dirty marker', async () => {
    const f = fixture(), identity = f.identity();
    f.db.prepare('INSERT INTO remote_projection_publications VALUES (?,?,?,?,?)').run('task', '/publication', 1, 1, 'hash');
    expect(f.identity).toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
    expect(await buildCapturedSnapshot(f, identity)).toEqual({ error: 'REMOTE_IMPORT_CONTEXT_CHANGED' });
    f.db.prepare('DELETE FROM remote_projection_publications').run();
    f.db.prepare('INSERT INTO remote_dirty VALUES (?)').run('other-task');
    const result = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    expect(result.manifest.recordCounts['session.upsert']).toBe(1);
  });
  it('waits for revisions not yet scanned into dirty hints in both the main process and actual worker', async () => {
    const f = fixture(), identity = f.identity();
    f.db.prepare('UPDATE remote_session_revisions SET revision=revision+1 WHERE session_id=?').run('task');
    expect(f.identity).toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
    expect(await buildCapturedSnapshot(f, { ...identity, revision: identity.revision + 1 }))
      .toEqual({ error: 'REMOTE_IMPORT_CONTEXT_CHANGED' });
  });
  for (const count of [0, 2]) it(`does not seal a first snapshot with ${count} session summaries`, async () => {
    const f = fixture(0), fileSet = randomUUID();
    if (count === 0) f.db.prepare('DELETE FROM remote_projection WHERE session_id=?').run('task');
    else f.db.prepare(`INSERT INTO remote_projection SELECT session_id,'duplicate-session',hash,revision,record_json
      FROM remote_projection WHERE session_id=? AND object_key='session'`).run('task');
    await expect(f.snapshots.create(fileSet, f.identity(), () => true)).rejects.toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
    expect(fs.existsSync(path.join(f.directory, 'remote-import-snapshots', fileSet))).toBe(false);
  });
  it('keeps explicit deletion snapshots valid without a session summary', async () => {
    const f = fixture();
    f.store.transaction(() => f.db.prepare('DELETE FROM cowork_sessions WHERE id=?').run('task'));
    const result = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    expect(result.manifest.recordCounts).toEqual({ 'session.deleted': 1 });
    const payload = JSON.parse(await f.snapshots.read(result.fileSet, result.parts[0], () => true));
    expect(payload.records).toHaveLength(1); expect(payload.records[0].eventType).toBe('session.deleted');
  });
  it('streams a large snapshot into bounded canonical parts without embedding bodies in the core manifest', async () => {
    const f = fixture(1800, 1800); let turns = 0;
    const timer = setInterval(() => { turns++; }, 1);
    const result = await f.snapshots.create(randomUUID(), f.identity(), () => true); clearInterval(timer);
    expect(turns).toBeGreaterThan(2); expect(result.parts.length).toBeGreaterThan(10);
    expect(result.parts.every(part => part.byteSize <= 600 * 1024 && !('payload' in part))).toBe(true);
    expect(result.manifest.manifestHash).toBe(payloadHash(result.parts));
    let records = 0;
    for (const part of result.parts) {
      const content = await f.snapshots.read(result.fileSet, part, () => true), payload = JSON.parse(content);
      expect(Buffer.byteLength(content)).toBe(part.byteSize); expect(payloadHash(payload)).toBe(part.payloadHash);
      expect(payload.records.length).toBeLessThanOrEqual(1000); records += payload.records.length;
    }
    expect(records).toBe(1801); expect(JSON.stringify(result).length).toBeLessThan(12000);
  });
  it('splits tiny records at the server record count limit', async () => {
    const f = fixture(2300, 1), result = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    expect(result.parts).toHaveLength(3);
    const first = JSON.parse(await f.snapshots.read(result.fileSet, result.parts[0], () => true));
    expect(first.records).toHaveLength(1000);
  });
  it('rejects stale revisions and removes unadopted package files', async () => {
    const f = fixture(2000, 500), id = randomUUID();
    const operation = f.snapshots.create(id, f.identity(), () => true);
    f.db.prepare('UPDATE remote_session_revisions SET revision=revision+1 WHERE session_id=?').run('task');
    await expect(operation).rejects.toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
    expect(fs.existsSync(path.join(f.directory, 'remote-import-snapshots', id))).toBe(false);
  });
  it('cancels work when the account generation changes, preserving local writes', async () => {
    const f = fixture(3000, 300), id = randomUUID(); let current = true;
    const operation = f.snapshots.create(id, f.identity(), () => current); current = false;
    await expect(operation).rejects.toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
    f.store.transaction(() => f.db.prepare("UPDATE cowork_sessions SET title='Local remains writable' WHERE id='task'").run());
    expect(f.db.prepare("SELECT title FROM cowork_sessions WHERE id='task'").get()).toEqual({ title: 'Local remains writable' });
  });
  it('preserves referenced packages on restart, collects orphans, and rejects corrupt or missing parts', async () => {
    const f = fixture(), result = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    f.store.put('import:task', { fileSet: result.fileSet });
    const orphan = path.join(f.directory, 'remote-import-snapshots', randomUUID()); fs.mkdirSync(orphan);
    const reopened = new RemoteImportSnapshots(f.store, workerPath); await reopened.collect();
    expect(fs.existsSync(orphan)).toBe(false); expect(await reopened.exists(result.fileSet, result.parts)).toBe(true);
    const file = path.join(f.directory, 'remote-import-snapshots', result.fileSet, '0.json');
    fs.writeFileSync(file, 'x'.repeat(result.parts[0].byteSize));
    await expect(reopened.read(result.fileSet, result.parts[0], () => true)).rejects.toThrow('REMOTE_IMPORT_PART_UNAVAILABLE');
    fs.rmSync(file); expect(await reopened.exists(result.fileSet, result.parts)).toBe(false);
    await reopened.release(result.fileSet); expect(fs.existsSync(path.dirname(file))).toBe(true);
    f.store.remove('import:task'); await reopened.release(result.fileSet); expect(fs.existsSync(path.dirname(file))).toBe(false);
  });
  it('preserves immutable import parts referenced only by an inactive target', async () => {
    const f = fixture(), result = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    new RemoteSyncTargetStore(f.store);
    f.db.prepare('INSERT INTO remote_sync_target_archives VALUES (?,?,?,?)').run('inactive-target', 'remote_state', 0,
      JSON.stringify({ key: 'import:task', value: JSON.stringify({ fileSet: result.fileSet }) }));
    const reopened = new RemoteImportSnapshots(f.store, workerPath);
    await reopened.collect(); await reopened.release(result.fileSet);
    expect(await reopened.exists(result.fileSet, result.parts)).toBe(true);
    f.db.prepare('DELETE FROM remote_sync_target_archives').run();
    await reopened.release(result.fileSet);
    expect(await reopened.exists(result.fileSet, result.parts)).toBe(false);
  });
  it('uploads each production part from disk, stores only indexes, and keeps the existing request hash contract', async () => {
    const f = bridgeFixture(fixture(1200, 100)); let uploaded = 0;
    const originalSnapshot = vi.spyOn(f.store, 'snapshot').mockImplementation(() => { throw new Error('main snapshot forbidden'); });
    f.request.mockImplementation(async (_actor, pathname, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null, entry = f.store.get<any>('import:task');
      expect(entry.fileSet).toBeTruthy(); expect(entry.parts.every((part: object) => !('payload' in part))).toBe(true);
      if (pathname.endsWith('/sync/imports')) return ok({ sessionId: entry.sessionId, importId: entry.importId, state: 'uploading', stateVersion: '1' });
      if (pathname.includes('/parts/')) { expect(payloadHash(body.payload)).toBe(body.payloadHash); uploaded += body.payload.records.length; return ok({}); }
      return ok({ sessionId: entry.sessionId, importId: entry.importId, manifestHash: entry.manifest.manifestHash, state: 'committed', committedSourceSeq: entry.baseSourceSeq, committedSeq: '1' });
    });
    await f.bridge.importSession(f.store.sync('task'), null);
    expect(uploaded).toBe(1201); expect(originalSnapshot).not.toHaveBeenCalled(); expect(f.store.get('import:task')).toBeNull();
  });
  it('does not discard missing parts after a possibly sent begin returns 404', async () => {
    const f = bridgeFixture(), entry = saved(f, { beginAttempted: true }); f.store.put('import:task', entry);
    f.request.mockResolvedValue(new Response(JSON.stringify({ code: 47020, message: 'missing' }), { status: 404 }));
    await expect(f.bridge.importSession(f.store.sync('task'), entry)).rejects.toThrow();
    expect(f.store.get<any>('import:task')?.importId).toBe(entry.importId); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('requires confirmed abort for both legacy and current imports before discarding missing parts', async () => {
    const f = bridgeFixture(), entry = saved(f, { beginAttempted: true }); f.store.put('import:task', entry);
    f.request.mockImplementation(async (_actor, pathname) => ok(pathname.endsWith('/abort') ? {} : { importId: entry.importId, sessionId: entry.sessionId, manifestHash: 'manifest', state: 'uploading', stateVersion: '1' }));
    await expect(f.bridge.importSession(f.store.sync('task'), entry)).rejects.toThrow('Import abortion is not confirmed');
    expect(f.store.get<any>('import:task')?.importId).toBe(entry.importId);
    f.request.mockImplementation(async (_actor, pathname) => ok({ importId: entry.importId, sessionId: entry.sessionId, manifestHash: 'manifest', state: pathname.endsWith('/abort') ? 'aborted' : 'uploading', stateVersion: '1' }));
    await f.bridge.importSession(f.store.sync('task'), entry); expect(f.store.get('import:task')).toBeNull();
  });
  it('stops budget failures until explicit retry instead of re-encoding the same long session', async () => {
    const f = bridgeFixture();
    const row = f.store.sync('task')!;
    const target = f.bridge.targets.activateLegacy({ owner, deviceId: 'desktop', legacyStates: [{ localSessionId: row.local_id,
      deviceId: row.device_id, sessionId: row.session_id, syncProtocolVersion: row.sync_protocol_version, streamEpoch: row.stream_epoch,
      lastSourceSeq: String(row.ack_seq), lastSeq: row.server_seq, sourcePurgeSeq: row.source_purge_seq, eventPurgeSeq: row.event_purge_seq }] });
    f.bridge.targetId = target.targetId;
    f.store.setProjectionIdentity(target.targetId, owner, 'desktop'); f.store.setFileEnvironment(target.targetId);
    const create = vi.spyOn(f.snapshots, 'create').mockRejectedValue(new RemoteImportSnapshotError('REMOTE_IMPORT_BUDGET'));
    await f.bridge.syncSessions();
    expect(f.store.get<any>('syncFailure:task')?.blocked).toBe(true);
    await f.bridge.syncSessions(); await f.bridge.syncSessions();
    expect(create).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
  });
  it('quarantines a legacy task without source environment proof instead of entering import recovery', async () => {
    const source = fixture();
    source.db.prepare('DELETE FROM remote_publication_origins WHERE local_id=?').run('task');
    const f = bridgeFixture(source), row = f.store.sync('task')!;
    const target = f.bridge.targets.activateLegacy({ owner, deviceId: 'desktop', legacyStates: [{ localSessionId: row.local_id,
      deviceId: row.device_id, sessionId: row.session_id, syncProtocolVersion: row.sync_protocol_version, streamEpoch: row.stream_epoch,
      lastSourceSeq: String(row.ack_seq), lastSeq: row.server_seq, sourcePurgeSeq: row.source_purge_seq, eventPurgeSeq: row.event_purge_seq }] });
    f.bridge.targetId = target.targetId;
    f.store.setProjectionIdentity(target.targetId, owner, 'desktop'); f.store.setFileEnvironment(target.targetId);
    const create = vi.spyOn(f.snapshots, 'create');
    expect(f.db.prepare('SELECT admission FROM remote_sync_session_admissions WHERE local_session_id=?').get('task'))
      .toEqual({ admission: 'quarantined' });
    expect(f.bridge.sessionAdmitted('task')).toBe(false);
    await f.bridge.syncSessions();
    expect(create).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    expect(f.store.sync('task')!.ack_seq).toBe(0);
  });
  it('rejects insufficient disk space in the actual worker before creating a materialization', async () => {
    const f = fixture(), wrapped = path.join(f.directory, 'budget-worker.cjs');
    fs.writeFileSync(wrapped, `require('fs').statfsSync=()=>({bavail:1,bsize:1});require(${JSON.stringify(workerPath)});`);
    const limited = new RemoteImportSnapshots(f.store, wrapped);
    await expect(limited.create(randomUUID(), f.identity(), () => true)).rejects.toThrow('REMOTE_IMPORT_BUDGET');
    expect(fs.readdirSync(path.join(f.directory, 'remote-import-snapshots'))).toEqual([]);
  });
  it('never collects package files when an import receipt is corrupt and its references are unknown', async () => {
    const f = fixture(), result = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    f.db.prepare('INSERT OR REPLACE INTO remote_state VALUES (?,?)').run('import:task', '{');
    await expect(f.snapshots.collect()).resolves.toBeUndefined();
    expect(await f.snapshots.exists(result.fileSet, result.parts)).toBe(true);
    const other = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    expect(await f.snapshots.exists(other.fileSet, other.parts)).toBe(true);
    expect(await f.snapshots.exists(result.fileSet, result.parts)).toBe(true);
  });
  it('rebuilds a discarded never-sent package with a fresh import ID', async () => {
    const f = bridgeFixture(), entry = saved(f, { beginAttempted: false }); f.store.put('import:task', entry);
    await f.bridge.importSession(f.store.sync('task'), entry);
    expect(f.request).not.toHaveBeenCalled(); expect(f.store.get('import:task')).toBeNull();
    let rebuiltId = '';
    f.request.mockImplementation(async () => {
      const rebuilt = f.store.get<any>('import:task'); rebuiltId = rebuilt.importId;
      return ok({ ...rebuilt, state: 'committed', committedSourceSeq: rebuilt.baseSourceSeq, committedSeq: '1' });
    });
    await f.bridge.importSession(f.store.sync('task'), null);
    expect(rebuiltId).not.toBe(entry.importId); expect(f.store.get('import:task')).toBeNull();
  });
  it('preserves the next package and its original evidence when the durable rebuild budget is exhausted', async () => {
    const f = bridgeFixture(), context = f.bridge.taskContext();
    const first = saved(f, { beginAttempted: false }); f.store.put('import:task', first);
    await f.bridge.importSession(f.store.sync('task'), first);
    const packaged = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    const next = saved(f, { ...packaged, beginConfirmed: true, beginAttempted: true }); f.store.put('import:task', next);
    f.store.freezeMigration('task');
    f.request.mockResolvedValue(ok({ importId: next.importId, sessionId: next.sessionId, state: 'expired' }));
    f.bridge.taskSync = new RemoteTaskSyncState(f.db);
    await expect(f.bridge.importSession(f.store.sync('task'), next, true)).rejects.toThrow('REMOTE_IMPORT_REBUILD_LIMIT');
    expect(f.store.get('import:task')).toMatchObject({ importId: next.importId, manifest: next.manifest, fileSet: packaged.fileSet });
    expect(await f.snapshots.exists(packaged.fileSet, packaged.parts)).toBe(true);
    expect(f.store.sync('task')).toMatchObject({ ack_seq: 0, migration_frozen: 1 });
    expect(JSON.parse(f.bridge.taskSync.get(context, 'task').repair_json).times).toHaveLength(1);
  });
  it('does not consume rebuild budget for unknown results or contradictory never-sent evidence', async () => {
    const f = bridgeFixture(), entry = saved(f, { beginAttempted: true }); f.store.put('import:task', entry);
    f.request.mockRejectedValue(new Error('network unavailable'));
    await expect(f.bridge.importSession(f.store.sync('task'), entry)).rejects.toThrow();
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'task')).toBeNull();
    const contradictory = { ...entry, beginAttempted: false, beginConfirmed: true }; f.store.put('import:task', contradictory);
    await expect(f.bridge.importSession(f.store.sync('task'), contradictory)).rejects.toThrow('never-sent evidence');
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'task')).toBeNull();
    expect(f.store.get<any>('import:task').importId).toBe(entry.importId);
    expect(() => f.bridge.discardImport(f.store.sync('task'), { ...entry, beginAttempted: false })).toThrow('evidence changed');
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'task')).toBeNull();
  });
  it('rejects mismatched terminal identities before replacing imports and accepts old v1 terminal fields', async () => {
    const f = bridgeFixture(), entry = saved(f, { beginConfirmed: true }); f.store.put('import:task', entry);
    await expect(f.bridge.recoverImportConflict(f.store.sync('task'), { importId: entry.importId, state: 'expired', manifestHash: 'other' }, () => true)).rejects.toThrow('identity mismatch');
    expect(f.store.get<any>('import:task').importId).toBe(entry.importId);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'task')).toBeNull();
    await f.bridge.recoverImportConflict(f.store.sync('task'), { importId: entry.importId, state: 'expired' }, () => true);
    expect(f.store.get('import:task')).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  });
  it('refreshes a near-expiry original import without replaying acknowledged parts or clearing failure progress', async () => {
    const f = bridgeFixture(fixture(2300, 1)), packaged = await f.snapshots.create(randomUUID(), f.identity(), () => true);
    const entry = saved(f, { ...packaged, beginAttempted: true, beginConfirmed: true, uploadCursor: 1, confirmedPartCount: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 120000).toISOString() });
    f.store.put('import:task', entry);
    f.bridge.verifiedImports.set(entry.importId, { importId: entry.importId, sessionId: entry.sessionId, state: 'uploading', stateVersion: '1', checkedAt: Date.now() - 31000 });
    const progress = vi.spyOn(f.bridge.taskSync, 'progress');
    f.request.mockImplementation(async (_actor, pathname) => {
      if (pathname.endsWith('/sync/imports')) return ok({ importId: entry.importId, sessionId: entry.sessionId, state: 'uploading', stateVersion: '1', expiresAt: entry.expiresAt });
      const partNo = Number(pathname.split('/').at(-1));
      return ok(packaged.parts[partNo]);
    });
    await f.bridge.importSession(f.store.sync('task'), entry, true);
    expect(f.store.get<any>('import:task').uploadCursor).toBe(1); expect(progress).not.toHaveBeenCalled();
    await f.bridge.importSession(f.store.sync('task'), f.store.get('import:task'), true);
    expect(f.request.mock.calls[1][1]).toContain('/parts/1'); expect(progress).toHaveBeenCalledTimes(1);
    // A process restart revalidates original parts, but a duplicate ACK is not new progress.
    f.bridge.verifiedImports.clear(); progress.mockClear();
    await f.bridge.importSession(f.store.sync('task'), f.store.get('import:task'), true);
    await f.bridge.importSession(f.store.sync('task'), f.store.get('import:task'), true);
    expect(f.request.mock.calls.at(-1)![1]).toContain('/parts/0'); expect(progress).not.toHaveBeenCalled();
    expect(f.store.get<any>('import:task').confirmedPartCount).toBe(2);
  });
  it('promotes only one verified expiring import while preserving regular task order and retry gates', () => {
    const f = bridgeFixture(), row = f.store.sync('task')!;
    const normal = { ...row, local_id: 'normal', session_id: 'normal' }, later = { ...row, local_id: 'later', session_id: 'later' };
    const receipts = f.bridge.verifiedImports;
    receipts.set('current', { sessionId: row.session_id, state: 'uploading', absoluteExpiresAt: new Date(Date.now() + 60000).toISOString() });
    receipts.set('later', { sessionId: later.session_id, state: 'uploading', expiresAt: new Date(Date.now() + 120000).toISOString() });
    expect(f.bridge.prioritizeExpiringImports([normal, later, row])).toEqual([row, normal, later]);
    f.bridge.taskSync.defer(f.bridge.taskContext(), row.local_id, 60000);
    expect(f.bridge.prioritizeExpiringImports([normal, later, row])).toEqual([later, normal, row]);
    receipts.clear();
    expect(f.bridge.prioritizeExpiringImports([normal, later, row])).toEqual([normal, later, row]);
  });
  it('uses a committed original receipt without reading missing payload files', async () => {
    const f = bridgeFixture(), entry = saved(f, { beginAttempted: true }); f.store.put('import:task', entry);
    f.request.mockResolvedValue(ok({ ...entry, state: 'committed', committedSourceSeq: entry.baseSourceSeq, committedSeq: '1' }));
    await f.bridge.importSession(f.store.sync('task'), entry);
    expect(f.store.get('import:task')).toBeNull(); expect(f.store.sync('task')?.ack_seq).toBe(Number(entry.baseSourceSeq));
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

describe('recovery of rejected empty initial snapshots', () => {
  function rejectedInitial(protocolVersion = 1) {
    const f = bridgeFixture(fixture(0)), row = f.store.sync('task')!;
    const target = f.bridge.targets.activateLegacy({ owner, deviceId: 'desktop', legacyStates: [{ localSessionId: row.local_id,
      deviceId: row.device_id, sessionId: row.session_id, syncProtocolVersion: row.sync_protocol_version, streamEpoch: row.stream_epoch,
      lastSourceSeq: String(row.ack_seq), lastSeq: row.server_seq, sourcePurgeSeq: row.source_purge_seq, eventPurgeSeq: row.event_purge_seq }] });
    f.bridge.targetId = target.targetId;
    f.store.setProjectionIdentity(target.targetId, owner, 'desktop'); f.store.setFileEnvironment(target.targetId);
    f.store.put(`settings:${owner.userId}:${owner.scopeKey}`, { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [] });
    vi.spyOn(f.bridge, 'schedule').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const parts = [{ partNo: 0, byteSize: 14, payloadHash: payloadHash({ records: [] }) }];
    const entry = saved(f, { environment: target.targetId, beginAttempted: true, baseSourceSeq: '0', parts,
      ...(protocolVersion === RemoteRetention.Version ? { syncProtocolVersion: RemoteRetention.Version, expectedStreamEpoch: null, migration: true } : {}),
      manifest: { partCount: 1, recordCounts: {}, manifestHash: payloadHash(parts) } });
    f.store.put('import:task', entry);
    if (protocolVersion === RemoteRetention.Version) f.store.freezeMigration('task');
    const directory = path.join(f.directory, 'remote-import-snapshots', entry.fileSet);
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, '0.json'), '{"records":[]}');
    const context = f.bridge.taskContext();
    f.bridge.taskSync.fail(context, 'task', { phase: TaskSyncPhase.Isolated, scope: 'session', reason: RemoteImportValidation.Reason });
    f.db.prepare('UPDATE remote_sync_task_state SET recovery_probe_version=1').run();
    f.store.put('syncFailure:task', { code: RemoteImportValidation.Code, reason: RemoteImportValidation.Reason, blocked: true });
    const before = f.db.prepare('SELECT * FROM remote_outbox ORDER BY source_seq').all();
    const due = () => f.db.prepare('UPDATE remote_sync_task_state SET next_retry_at=0,last_served_at=0').run();
    const rejection = () => new Response(JSON.stringify({ code: RemoteImportValidation.Code, message: RemoteImportValidation.MissingSummary,
      data: { reason: RemoteImportValidation.Reason } }), { status: 400 });
    f.request.mockImplementation(async () => rejection());
    return { ...f, entry, context, directory, before, due, rejection };
  }
  for (const protocolVersion of [1, RemoteRetention.Version]) it(`reopens the persisted v${protocolVersion} failure, replays its original begin, then commits a real disk snapshot before advancing ACK`, async () => {
    const f = rejectedInitial(protocolVersion), retention = protocolVersion === RemoteRetention.Version, epoch = randomUUID();
    expect(f.store.sync('task')!.source_seq).toBeGreaterThan(0);
    // Fresh Store/Bridge objects use only the persisted mapping, operation and recovery marker.
    f.bridge.stop();
    const store = new RemoteStore(f.db); store.setEnabledOwner(owner);
    store.setProjectionIdentity(f.context.target, owner, 'desktop'); store.setFileEnvironment(f.context.target);
    const resumed = bridgeFixture({ ...f, store, snapshots: new RemoteImportSnapshots(store, workerPath) });
    const bridge = resumed.bridge; bridge.targetId = f.context.target;
    bridge.retentionSupported = retention; bridge.fenceCheckedAt = Date.now();
    vi.spyOn(bridge, 'schedule').mockImplementation(() => {});
    resumed.request.mockImplementation(async () => f.rejection());
    await bridge.syncSessions(true);
    expect(resumed.request).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(resumed.request.mock.calls[0][2].body));
    expect(body).toMatchObject({ importId: f.entry.importId, manifest: f.entry.manifest, baseSourceSeq: '0', expectedSourceSeq: '0', expectedServerSeq: '0' });
    if (retention) expect(body).toMatchObject({ syncProtocolVersion: RemoteRetention.Version, expectedStreamEpoch: null });
    else { expect(body).not.toHaveProperty('syncProtocolVersion'); expect(body).not.toHaveProperty('expectedStreamEpoch'); }
    expect(store.get('import:task')).toBeNull();
    expect(store.get('syncFailure:task')).not.toBeNull();
    expect(store.sync('task')!.ack_seq).toBe(0);
    expect(store.sync('task')!.migration_frozen).toBe(0);
    expect(f.db.prepare('SELECT * FROM remote_outbox ORDER BY source_seq').all()).toEqual(f.before);
    const uploaded: any[] = [];
    resumed.request.mockImplementation(async (_actor, pathname, init) => {
      if (pathname.startsWith('/api/remote/v1/sync/state?')) {
        expect(retention).toBe(true);
        return new Response(JSON.stringify({ code: RemoteRetention.StateMissingCode, data: { reason: 'SYNC_STATE_NOT_FOUND' } }), { status: 404 });
      }
      const pending = store.get<any>('import:task')!, requestBody = init.body ? JSON.parse(String(init.body)) : null;
      expect(pending.importId).not.toBe(f.entry.importId);
      if (pathname.endsWith('/sync/imports')) {
        expect(requestBody.manifest.recordCounts['session.upsert']).toBe(1);
        if (retention) {
          expect(requestBody).toMatchObject({ syncProtocolVersion: RemoteRetention.Version, expectedStreamEpoch: null });
          expect(store.sync('task')!.migration_frozen).toBe(1);
        }
        return ok({ importId: pending.importId, sessionId: pending.sessionId, state: 'uploading', stateVersion: '1',
          ...(retention ? { syncProtocolVersion: RemoteRetention.Version, targetStreamEpoch: epoch, manifestHash: pending.manifest.manifestHash } : {}) });
      }
      if (retention) expect(requestBody).toMatchObject({ syncProtocolVersion: RemoteRetention.Version, streamEpoch: epoch });
      if (pathname.includes('/parts/')) { uploaded.push(...requestBody.payload.records); return ok({}); }
      return ok({ importId: pending.importId, sessionId: pending.sessionId, manifestHash: pending.manifest.manifestHash,
        ...(retention ? { syncProtocolVersion: RemoteRetention.Version, targetStreamEpoch: epoch, streamEpoch: epoch,
          sourcePurgeSeq: pending.baseSourceSeq, eventPurgeSeq: '0' } : {}),
        state: 'committed', committedSourceSeq: pending.baseSourceSeq, committedSeq: '1' });
    });
    f.due(); await bridge.syncSessions();
    expect(uploaded.some(record => record.eventType === 'session.upsert')).toBe(true);
    expect(store.get('import:task')).toBeNull(); expect(store.get('syncFailure:task')).toBeNull();
    expect(store.sync('task')!.ack_seq).toBe(store.sync('task')!.source_seq);
    expect(store.sync('task')).toMatchObject({ sync_protocol_version: protocolVersion, stream_epoch: retention ? epoch : null, migration_frozen: 0 });
  });
  for (const response of [
    { status: 400, code: RemoteImportValidation.Code, message: 'Another invalid field', reason: RemoteImportValidation.Reason },
    { status: 400, code: RemoteImportValidation.Code, message: RemoteImportValidation.MissingSummary, reason: 'OTHER_REASON' },
    { status: 404, code: 47002, message: RemoteImportValidation.MissingSummary, reason: RemoteImportValidation.Reason },
    { status: 403, code: 47002, message: 'Access denied', reason: 'ACCESS_DENIED' },
    { status: 503, code: 503, message: 'Unavailable', reason: 'UNAVAILABLE' },
  ]) it(`retains immutable evidence for ${response.status}/${response.code}/${response.reason}/${response.message}`, async () => {
    const f = rejectedInitial();
    f.request.mockImplementation(async () => new Response(JSON.stringify({ code: response.code, message: response.message,
      data: { reason: response.reason } }), { status: response.status }));
    await f.bridge.syncSessions(true);
    expect(f.store.get('import:task')).toEqual(f.entry);
    expect(fs.existsSync(path.join(f.directory, '0.json'))).toBe(true);
    expect(f.store.sync('task')!.ack_seq).toBe(0);
    expect(f.db.prepare('SELECT * FROM remote_outbox ORDER BY source_seq').all()).toEqual(f.before);
  });
  it('retains the original import after a lost response and never executes a task during recovery', async () => {
    const f = rejectedInitial(); f.request.mockRejectedValue(new Error('network unavailable'));
    await f.bridge.syncSessions(true);
    expect(f.store.get('import:task')).toEqual(f.entry); expect(f.bridge.deps.execute).not.toHaveBeenCalled();
    expect(f.bridge.taskSync.get(f.context, 'task').phase).toBe(TaskSyncPhase.Backoff);
  });
  for (const state of ['uploading', 'committed']) it(`preserves an unexpected ${state} receipt instead of manufacturing rejection evidence`, async () => {
    const f = rejectedInitial(); f.request.mockImplementation(async () => ok({ ...f.entry, state, committedSourceSeq: '0', committedSeq: '1' }));
    await f.bridge.syncSessions(true);
    expect(f.store.get('import:task')).toEqual(f.entry); expect(f.store.sync('task')!.ack_seq).toBe(0);
    expect(fs.existsSync(path.join(f.directory, '0.json'))).toBe(true);
  });
  for (const mutation of ['manifest', 'baseline', 'owner', 'ack', 'stop', 'claim'] as const) it(`does not clean up when ${mutation} changes during the request`, async () => {
    const f = rejectedInitial();
    f.request.mockImplementation(async () => {
      if (mutation === 'manifest') f.store.put('import:task', { ...f.entry, manifest: { ...f.entry.manifest, recordCounts: { 'session.upsert': 1 } } });
      if (mutation === 'baseline') f.store.put('import:task', { ...f.entry, expectedSourceSeq: '1' });
      if (mutation === 'owner') f.bridge.owner = { ...owner, userId: 'other' };
      if (mutation === 'ack') f.db.prepare("UPDATE remote_sync SET ack_seq=1 WHERE local_id='task'").run();
      if (mutation === 'stop') f.bridge.stop();
      if (mutation === 'claim') vi.spyOn(f.bridge, 'ownershipSyncBlocked').mockReturnValue(true);
      return f.rejection();
    });
    await f.bridge.syncSessions(true);
    expect(f.store.get<any>('import:task')?.importId).toBe(f.entry.importId);
    expect(fs.existsSync(path.join(f.directory, '0.json'))).toBe(true);
  });
  it('defers an ownership-blocked recovery without consuming its opportunity, then resumes when admitted', async () => {
    const f = rejectedInitial(), blocked = vi.spyOn(f.bridge, 'ownershipSyncBlocked').mockReturnValue(true);
    await f.bridge.syncSessions(true);
    expect(f.request).not.toHaveBeenCalled(); expect(f.store.get('import:task')).toEqual(f.entry);
    blocked.mockReturnValue(false); f.due(); await f.bridge.syncSessions(true);
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.store.get('import:task')).toBeNull();
  });
  for (const invalid of ['counts', 'part', 'hash', 'confirmed', 'epoch', 'owner', 'device', 'environment', 'admission'] as const) it(`does not promote an old failure with mismatched ${invalid} evidence`, async () => {
    const f = rejectedInitial(), entry: any = structuredClone(f.entry);
    if (invalid === 'counts') entry.manifest.recordCounts = [];
    if (invalid === 'part') entry.parts[0].byteSize++;
    if (invalid === 'hash') entry.manifest.manifestHash = 'wrong';
    if (invalid === 'confirmed') Object.assign(entry, { beginConfirmed: true });
    if (invalid === 'epoch') Object.assign(entry, { targetStreamEpoch: 'active' });
    if (invalid === 'owner') entry.owner = { ...owner, userId: 'other' };
    if (invalid === 'device') entry.deviceId = 'other';
    if (invalid === 'environment') entry.environment = 'other';
    if (invalid === 'admission') vi.spyOn(f.bridge, 'sessionAdmitted').mockReturnValue(false);
    f.store.put('import:task', entry); await f.bridge.syncSessions(true);
    expect(f.request).not.toHaveBeenCalled(); expect(f.store.get('import:task')).toEqual(entry);
    expect(f.bridge.taskSync.get(f.context, 'task').phase).toBe(TaskSyncPhase.Isolated);
  });
  it('retains the rejected operation when its durable rebuild budget is spent', async () => {
    const f = rejectedInitial();
    expect(f.bridge.taskSync.reserveRepair(f.context, 'task', 'IMPORT_REBUILD')).toBe(true);
    f.bridge.taskSync.fail(f.context, 'task', { phase: TaskSyncPhase.Isolated, scope: 'session', reason: RemoteImportValidation.Reason });
    f.db.prepare('UPDATE remote_sync_task_state SET recovery_probe_version=1').run();
    await f.bridge.syncSessions(true);
    expect(f.store.get('import:task')).toEqual(f.entry);
    expect(fs.existsSync(path.join(f.directory, '0.json'))).toBe(true);
  });
});
