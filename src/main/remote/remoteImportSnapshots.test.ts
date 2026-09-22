import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { build } from 'esbuild';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RemoteEnvironment } from '../../shared/remote/environment';
import { payloadHash, stableJson } from './canonical';
import { RemoteBridge } from './remoteBridge';
import { RemoteImportSnapshotError, RemoteImportSnapshots } from './remoteImportSnapshots';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';

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
  return { ...f, bridge, request };
}
const ok = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));
function saved(f: ReturnType<typeof fixture>, overrides: object = {}) {
  const row = f.store.sync('task')!;
  return { importId: randomUUID(), fileSet: randomUUID(), sessionId: row.session_id, owner, deviceId: 'desktop', environment,
    projectionVersion: 1, snapshotEpoch: 0, baseSourceSeq: String(row.source_seq), expectedSourceSeq: '0', expectedServerSeq: '0',
    parts: [{ partNo: 0, payloadHash: 'missing', byteSize: 20 }], manifest: { partCount: 1, manifestHash: 'manifest', recordCounts: { 'session.upsert': 1 } }, ...overrides };
}

describe('immutable import snapshot worker', () => {
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
    const create = vi.spyOn(f.snapshots, 'create').mockRejectedValue(new RemoteImportSnapshotError('REMOTE_IMPORT_BUDGET'));
    await f.bridge.syncSessions();
    expect(f.store.get<any>('syncFailure:task')?.blocked).toBe(true);
    await f.bridge.syncSessions(); await f.bridge.syncSessions();
    expect(create).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
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
    await expect(f.snapshots.collect()).rejects.toThrow('REMOTE_IMPORT_PART_UNAVAILABLE');
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
  it('uses a committed original receipt without reading missing payload files', async () => {
    const f = bridgeFixture(), entry = saved(f, { beginAttempted: true }); f.store.put('import:task', entry);
    f.request.mockResolvedValue(ok({ ...entry, state: 'committed', committedSourceSeq: entry.baseSourceSeq, committedSeq: '1' }));
    await f.bridge.importSession(f.store.sync('task'), entry);
    expect(f.store.get('import:task')).toBeNull(); expect(f.store.sync('task')?.ack_seq).toBe(Number(entry.baseSourceSeq));
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
