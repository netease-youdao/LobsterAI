import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteEnvironment } from '../../shared/remote/environment';
import { payloadHash } from './canonical';
import { migrateRemoteEnvironment } from './remoteEnvironmentMigration';
import { remoteFileCacheDirectory } from './remoteFileSnapshots';
import { acknowledgeRemoteSessionDeletion, recordRemoteSessionDeletion, RemoteLocalGc } from './remoteLocalGc';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';

const owner = { userId: 'a', scopeKey: 'personal' }, other = { userId: 'b', scopeKey: 'personal' };
const day = 24 * 60 * 60_000;
const databases: Database.Database[] = [], directories: string[] = [];
function fixture(environment: string | null = null) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT); CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER)');
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-local-gc-'))); directories.push(root);
  let actor = owner;
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES ('s','title',1,1,'idle')").run(); store.assignNew('s', owner, 'local_create'); });
  db.prepare("UPDATE remote_sync SET device_id='device',source_seq=1,ack_seq=1,needs_snapshot=0,sync_environment=? WHERE local_id='s'").run(environment);
  store.transaction(() => { recordRemoteSessionDeletion(store, 's', 100); db.prepare("DELETE FROM cowork_sessions WHERE id='s'").run(); });
  db.prepare("UPDATE remote_sync SET source_seq=2,ack_seq=2 WHERE local_id='s'").run();
  db.prepare('INSERT INTO remote_projection VALUES (?,?,?,?,?)').run('s', 'deleted', 'hash', 1, JSON.stringify({ eventType: 'session.deleted', payload: { deletedAt: 'date' } }));
  db.prepare('INSERT INTO remote_projection VALUES (?,?,?,?,?)').run('s', 'message:m', 'hash', 1, JSON.stringify({ content: 'secret body' }));
  db.prepare('INSERT INTO remote_reply_chunks VALUES (?,?,?,?)').run('s', 'sha', 'body', 4);
  db.prepare('INSERT INTO remote_object_state VALUES (?,?,?,?)').run('s', 'message:m', 1, JSON.stringify({ ordinal: '1', digest: 'hash' }));
  store.put('run:s', { runId: 'r', status: 'succeeded' });
  store.put('approval:s:a', { status: 'approved' });
  store.put('inbox:command', { localSessionId: 's', state: 'applied', command: { status: 'applied', requestHash: 'unchanged' } });
  const deps = { store, cacheRoot: root, inputCacheRoot: path.join(root, 'inputs'), owner: () => actor };
  return { store, db, root, deps, gc: new RemoteLocalGc(deps), actor: (next: typeof owner) => { actor = next; },
    ack: () => acknowledgeRemoteSessionDeletion(store, 's', 1000),
    body: () => db.prepare("SELECT COUNT(*) AS n FROM remote_projection WHERE object_key<>'deleted'").get() as { n: number } };
}
async function finish(gc: RemoteLocalGc) { for (let i = 0; i < 12; i++) await gc.sweep(day + 2000); }
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) fs.rmSync(dir, { force: true, recursive: true }); });

describe('deleted remote session local GC', () => {
  it.each(['task', 'shared'])('retains acknowledged deletion caches while %s admission is blocked', async scope => {
    const f = fixture();
    if (scope === 'task') f.store.setTaskAdmission(() => false); else f.store.setControlAdmission(() => false);
    f.ack();
    expect(f.store.get('localGcDeleted:s')).toMatchObject({ ackAt: 1000 });
    await finish(f.gc); expect(f.body().n).toBe(1);
    expect(f.store.get('inbox:command')).toMatchObject({ command: { requestHash: 'unchanged' } });
    f.store.setTaskAdmission(() => true); f.store.setControlAdmission(() => true);
    await finish(f.gc); expect(f.body().n).toBe(0);
  });
  it.each([
    ['https://lobsterai-server-dev.inner.youdao.com', RemoteEnvironment.Test],
    ['https://lobsterai-server.youdao.com', RemoteEnvironment.Production],
    ['https://lobsterai-server-dev.inner.youdao.com', 'https://lobsterai-server.inner.youdao.com'],
  ])('acknowledges an unchanged deletion stream after environment migration from %s to %s', async (legacyEnvironment, environment) => {
    const f = fixture(legacyEnvironment);
    f.db.prepare("UPDATE remote_sync SET sync_environment=? WHERE local_id='s'").run(environment);
    f.ack();
    expect(f.store.get('localGcDeleted:s')).toMatchObject({ environment, ackAt: 1000 });
    await finish(f.gc);
    expect(f.body().n).toBe(0);
  });
  it('keeps existing deletion evidence valid when its local environment migrates after acknowledgement', async () => {
    const legacyEnvironment = 'https://lobsterai-server-dev.inner.youdao.com';
    const f = fixture(legacyEnvironment);
    f.ack();
    f.db.prepare("UPDATE remote_sync SET sync_environment=? WHERE local_id='s'").run(RemoteEnvironment.Test);
    await finish(f.gc);
    expect(f.body().n).toBe(0);
    expect(f.store.get('localGcDeleted:s')).toMatchObject({ environment: legacyEnvironment, ackAt: 1000 });
  });
  it('uses persisted custom-domain identity when legacy deletion evidence is recovered after migration', async () => {
    const legacyEnvironment = 'https://custom-gateway.example.com';
    const f = fixture(legacyEnvironment);
    f.ack();
    const tombstone = f.store.get('localGcDeleted:s');
    migrateRemoteEnvironment(f.store, { owner, deviceId: 'device', environment: RemoteEnvironment.Test, legacyEnvironments: [legacyEnvironment] });
    f.store.put('localGcDeleted:s', tombstone);
    expect(f.store.sync('s')?.sync_environment).toBe(RemoteEnvironment.Test);
    await finish(f.gc);
    expect(f.body().n).toBe(0);
    expect(f.store.get('localGcDeleted:s')).toMatchObject({ environment: legacyEnvironment, ackAt: 1000 });
  });
  it.each([RemoteEnvironment.Production, 'https://unknown.example.com', null])('retains deletion data after a distinct environment switch to %s', async environment => {
    const f = fixture('https://lobsterai-server-dev.inner.youdao.com');
    f.db.prepare("UPDATE remote_sync SET sync_environment=? WHERE local_id='s'").run(environment);
    f.ack();
    expect(f.store.get('localGcDeleted:s')).toMatchObject({ ackAt: null });
    f.db.prepare("UPDATE remote_sync SET sync_environment=? WHERE local_id='s'").run(RemoteEnvironment.Test);
    f.ack();
    expect(f.store.get('localGcDeleted:s')).toMatchObject({ ackAt: 1000 });
    f.db.prepare("UPDATE remote_sync SET sync_environment=? WHERE local_id='s'").run(environment);
    await finish(f.gc);
    expect(f.body().n).toBe(1);
  });
  it('requires a transaction and retains caches without deletion ACK or during grace', async () => {
    const f = fixture(); expect(() => recordRemoteSessionDeletion(f.store, 's')).toThrow();
    await finish(f.gc); expect(f.body().n).toBe(1);
    f.ack(); await f.gc.sweep(day); expect(f.body().n).toBe(1);
  });
  it('removes body pages after verified ACK, preserving all execution and monotonic evidence', async () => {
    const f = fixture(); f.ack(); await finish(f.gc);
    expect(f.body().n).toBe(0); expect(f.db.prepare('SELECT 1 FROM remote_reply_chunks').get()).toBeUndefined();
    expect(f.db.prepare('SELECT 1 FROM remote_object_state').get()).toBeDefined();
    expect(f.store.owner('s')).toEqual(owner); expect(f.store.sync('s')?.source_seq).toBe(2);
    expect(f.store.get('inbox:command')).toMatchObject({ command: { requestHash: 'unchanged' } });
    expect(f.store.get('approval:s:a')).toEqual({ status: 'approved' });
    expect(f.store.get('run:s')).toMatchObject({ runId: 'r' });
    expect(f.db.prepare("SELECT 1 FROM remote_projection WHERE object_key='deleted'").get()).toBeDefined();
  });
  it.each(['run', 'inbox', 'approval', 'question', 'question-fact', 'import', 'publication', 'recovery'])('retains caches for %s blockers', async blocker => {
    const f = fixture(); f.ack();
    if (blocker === 'run') f.store.put('run:s', { runId: 'r', status: 'running' });
    if (blocker === 'inbox') f.store.put('inbox:command', { localSessionId: 's', state: 'unknown', command: { status: 'received' } });
    if (blocker === 'approval') f.store.put('approval:s:a', { status: 'pending' });
    if (blocker === 'question') f.store.put('question:s:q', { status: 'pending', resolution: { phase: 'unknown' } });
    if (blocker === 'question-fact') f.store.put('questionDecision:q', { state: { sessionId: 's', status: 'pending', resolution: { phase: 'unknown' } } });
    if (blocker === 'import') f.store.put('import:s', { state: 'uploading' });
    if (blocker === 'publication') f.db.prepare('INSERT INTO remote_projection_publications VALUES (?,?,?,?,?)').run('s', 'path', 2, 2, 'digest');
    if (blocker === 'recovery') f.store.setSecurityRecoveryRequired(true);
    await finish(f.gc); expect(f.body().n).toBe(1);
  });
  it('does not clean another account or an unverified/replaced stream', async () => {
    const f = fixture(); f.ack(); f.actor(other); await finish(f.gc); expect(f.body().n).toBe(1);
    f.actor(owner); f.db.prepare("UPDATE remote_sync SET stream_epoch='different' WHERE local_id='s'").run();
    await finish(f.gc); expect(f.body().n).toBe(1);
  });
  it('resumes bounded cleanup after interruption', async () => {
    const f = fixture(); f.ack();
    for (let i = 0; i < 30; i++) f.db.prepare('INSERT INTO remote_projection VALUES (?,?,?,?,?)').run('s', `m:${i}`, 'h', 1, '{}');
    expect(await f.gc.sweep(day + 2000)).toBe(20); expect(f.body().n).toBe(11);
    await finish(new RemoteLocalGc(f.deps)); expect(f.body().n).toBe(0);
  });
  it('reclaims settled private snapshots, preserving source workspace files and job receipts', async () => {
    const f = fixture(); f.ack();
    const folder = remoteFileCacheDirectory(f.root, owner); fs.mkdirSync(folder, { recursive: true });
    const snapshot = path.join(folder, 'snapshot'); fs.writeFileSync(snapshot, 'cache');
    const workspace = path.join(f.root, 'workspace.txt'); fs.writeFileSync(workspace, 'original');
    f.store.put('desktopAsset:asset', { owner, localSessionId: 's', availability: 'ready', snapshot: { path: snapshot }, path: workspace, uploadRequestId: 'id', assetId: 'asset' });
    await finish(f.gc); expect(fs.existsSync(snapshot)).toBe(false); expect(fs.readFileSync(workspace, 'utf8')).toBe('original');
    expect(f.store.get('desktopAsset:asset')).toBeNull(); expect(f.store.entries('localGcReceipt:')).toHaveLength(1);
  });
  it('retains files referenced by an inactive target after the active deletion is acknowledged', async () => {
    const f = fixture(); f.ack(); new RemoteSyncTargetStore(f.store);
    const folder = remoteFileCacheDirectory(f.root, owner); fs.mkdirSync(folder, { recursive: true });
    const snapshot = path.join(folder, 'snapshot'); fs.writeFileSync(snapshot, 'retained bytes');
    f.store.put('desktopAsset:asset', { owner, localSessionId: 's', availability: 'ready', snapshot: { path: snapshot } });
    f.db.prepare('INSERT INTO remote_sync_target_archives VALUES (?,?,?,?)').run('inactive-target', 'remote_state', 0,
      JSON.stringify({ key: 'fileOutput:pending', value: JSON.stringify({ queue: [{ publicationId: 'unknown', snapshot: { path: snapshot } }] }) }));
    await finish(f.gc);
    expect(f.store.get('desktopAsset:asset')).toBeNull();
    expect(fs.readFileSync(snapshot, 'utf8')).toBe('retained bytes');
    f.db.prepare('DELETE FROM remote_sync_target_archives').run();
    await finish(f.gc); expect(fs.existsSync(snapshot)).toBe(false);
  });
  it.each(['session-field', 'legacy-history', 'legacy-prefix'])('reclaims %s desktop input snapshots using exact session evidence', async format => {
    const f = fixture(); f.ack();
    const folder = remoteFileCacheDirectory(f.root, owner); fs.mkdirSync(folder, { recursive: true });
    const snapshot = path.join(folder, 'input-snapshot'); fs.writeFileSync(snapshot, 'send-time bytes');
    const original = path.join(f.root, 'original.md'); fs.writeFileSync(original, 'user file');
    const key = format === 'legacy-prefix' ? 'desktopInputRun:s:run-id' : 'desktopInputRun:run-id';
    if (format === 'legacy-history') f.store.put('runHistory:s:run-id', { runId: 'run-id', status: 'succeeded' });
    f.store.put(key, { owner, ...(format === 'session-field' ? { localSessionId: 's' } : {}),
      attachments: [{ path: original, snapshot: { path: snapshot } }, { path: original, snapshot: { path: original } }] });
    await finish(f.gc);
    expect(f.store.get(key)).toBeNull(); expect(fs.existsSync(snapshot)).toBe(false);
    expect(fs.readFileSync(original, 'utf8')).toBe('user file');
    expect(f.store.get(`localGcReceipt:${payloadHash(key)}`)).toMatchObject({ localSessionId: 's', owner });
    if (format === 'legacy-history') expect(f.store.get('runHistory:s:run-id')).toMatchObject({ runId: 'run-id' });
  });
  it.each(['other-account', 'other-space', 'other-session', 'unknown-history', 'unsettled-history', 'conflicting-session'])('retains desktop input snapshots for %s', async reason => {
    const f = fixture(); f.ack();
    const folder = remoteFileCacheDirectory(f.root, owner); fs.mkdirSync(folder, { recursive: true });
    const snapshot = path.join(folder, 'input-snapshot'); fs.writeFileSync(snapshot, 'keep');
    const key = reason === 'conflicting-session' ? 'desktopInputRun:s:run-id' : 'desktopInputRun:run-id';
    const savedOwner = reason === 'other-account' ? other : reason === 'other-space' ? { ...owner, scopeKey: 'team:other' } : owner;
    const localSessionId = ['other-session', 'conflicting-session'].includes(reason) ? 'other-session' : 's';
    const legacy = ['unknown-history', 'unsettled-history'].includes(reason);
    f.store.put(key, { owner: savedOwner, ...(!legacy ? { localSessionId } : {}), attachments: [{ snapshot: { path: snapshot } }] });
    f.store.put('runHistory:other-session:run-id', { runId: 'run-id', status: 'succeeded' });
    if (reason === 'unsettled-history') f.store.put('runHistory:s:run-id', { runId: 'run-id', status: 'running' });
    await finish(f.gc);
    expect(f.store.get(key)).not.toBeNull(); expect(fs.readFileSync(snapshot, 'utf8')).toBe('keep');
    expect(f.store.get(`localGcReceipt:${payloadHash(key)}`)).toBeNull();
  });
  it('keeps input snapshots until deletion is acknowledged and pending uploads settle', async () => {
    const f = fixture();
    const folder = remoteFileCacheDirectory(f.root, owner); fs.mkdirSync(folder, { recursive: true });
    const snapshot = path.join(folder, 'input-snapshot'); fs.writeFileSync(snapshot, 'send-time bytes');
    const inputKey = 'desktopInputRun:run-id', uploadKey = 'desktopAsset:pending';
    f.store.put(inputKey, { owner, localSessionId: 's', attachments: [{ snapshot: { path: snapshot } }] });
    await finish(f.gc); expect(f.store.get(inputKey)).not.toBeNull(); expect(fs.existsSync(snapshot)).toBe(true);
    f.ack();
    f.store.put(uploadKey, { owner, localSessionId: 's', availability: 'uploading', snapshot: { path: snapshot } });
    await finish(f.gc); expect(f.store.get(uploadKey)).not.toBeNull(); expect(fs.existsSync(snapshot)).toBe(true);
    f.store.put(uploadKey, { owner, localSessionId: 's', availability: 'ready', snapshot: { path: snapshot } });
    await finish(f.gc); expect(f.store.get(uploadKey)).toBeNull(); expect(fs.existsSync(snapshot)).toBe(false);
  });
  it('does not unlink a snapshot acquired by a pending upload during filesystem validation', async () => {
    const f = fixture(); f.ack();
    const folder = remoteFileCacheDirectory(f.root, owner); fs.mkdirSync(folder, { recursive: true });
    const snapshot = path.join(folder, 'input-snapshot'); fs.writeFileSync(snapshot, 'send-time bytes');
    f.store.put('desktopInputRun:run-id', { owner, localSessionId: 's', attachments: [{ snapshot: { path: snapshot } }] });
    const lstat = fs.promises.lstat;
    let injected = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (String(args[0]) === snapshot && !injected) {
        injected = true;
        f.store.put('desktopAsset:late', { owner, localSessionId: 's', availability: 'uploading', snapshot: { path: snapshot } });
      }
      return stat;
    });
    await finish(f.gc);
    expect(injected).toBe(true); expect(fs.readFileSync(snapshot, 'utf8')).toBe('send-time bytes');
    expect(f.store.get('desktopAsset:late')).toMatchObject({ availability: 'uploading' });
  });
  it('reclaims bound preparation files only after terminal command and deletion ACK, preserving hashes', async () => {
    const f = fixture(); f.ack();
    const folder = path.join(f.deps.inputCacheRoot, payloadHash([owner.userId, owner.scopeKey, 'device']), '11111111-1111-4111-8111-111111111111');
    fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, 'download.txt'); fs.writeFileSync(file, 'input');
    f.store.put('inputPreparation:prepared', { owner, deviceId: 'device', boundCommandId: 'command', preparationId: 'prepared',
      requestHash: 'request-digest', inputDigest: 'input-digest', files: [{ path: file }] });
    await finish(f.gc); expect(fs.existsSync(file)).toBe(false); expect(f.store.get('inputPreparation:prepared')).toBeNull();
    expect(f.store.entries('localGcReceipt:')[0].value).toMatchObject({ boundCommandId: 'command', requestHash: 'request-digest', inputDigest: 'input-digest' });
    expect(f.store.get('inbox:command')).toBeDefined();
  });
  it.each([true, false])('scopes preparation cleanup to its target and exact command when IDs collide (active=%s)', async active => {
    const targetId = 'a'.repeat(64), otherTarget = 'b'.repeat(64);
    const f = fixture(targetId); new RemoteSyncTargetStore(f.store);
    f.db.prepare('INSERT INTO remote_sync_targets VALUES (?,?,?,?,?)').run(targetId, owner.userId, owner.scopeKey, 'device', null);
    f.ack();
    const preparationTarget = active ? targetId : otherTarget;
    const folder = path.join(f.deps.inputCacheRoot, payloadHash([owner.userId, owner.scopeKey, 'device']), '11111111-1111-4111-8111-111111111111');
    fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, 'download.txt'); fs.writeFileSync(file, 'input');
    const key = `inputPreparation:${JSON.stringify([preparationTarget, 'prepared'])}`;
    f.store.put(key, { owner, targetId: preparationTarget, deviceId: 'device', boundCommandId: 'command', preparationId: 'prepared', files: [{ path: file }] });
    f.store.put('inbox:command', { targetId: otherTarget, localSessionId: 'other-session', state: 'applied', command: { status: 'applied' } });
    f.store.put(`inbox:${preparationTarget}:command`, { targetId: preparationTarget, localSessionId: 's', state: 'applied', command: { status: 'applied' } });
    await finish(f.gc);
    expect(fs.existsSync(file)).toBe(!active);
    expect(f.store.get(key) === null).toBe(active);
  });
  it.each(['unknown-command', 'unknown-run', 'other-owner'])('keeps preparation copies protected for %s', async reason => {
    const f = fixture(); f.ack();
    const folder = path.join(f.deps.inputCacheRoot, payloadHash([owner.userId, owner.scopeKey, 'device']), '11111111-1111-4111-8111-111111111111');
    fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, 'download.txt'); fs.writeFileSync(file, 'input');
    f.store.put('inputPreparation:prepared', { owner, deviceId: 'device', boundCommandId: 'command', preparationId: 'prepared', files: [{ path: file }] });
    if (reason === 'unknown-command') f.store.put('inbox:command', { localSessionId: 's', state: 'unknown', command: { status: 'received' } });
    if (reason === 'unknown-run') f.store.put('run:s', { runId: 'r', status: 'reconciling' });
    if (reason === 'other-owner') f.actor(other);
    await finish(f.gc); expect(fs.readFileSync(file, 'utf8')).toBe('input'); expect(f.store.get('inputPreparation:prepared')).toBeDefined();
  });
  it('does not delete a recreated/live core session even with old deletion evidence', async () => {
    const f = fixture(); f.ack();
    f.store.transaction(() => f.db.prepare("INSERT INTO cowork_sessions VALUES ('s','live',2,2,'idle')").run());
    await finish(f.gc); expect(f.body().n).toBe(1);
  });
  it('retains unknown upload jobs and symlink targets', async () => {
    const f = fixture(); f.ack();
    const folder = remoteFileCacheDirectory(f.root, owner); fs.mkdirSync(folder, { recursive: true });
    const original = path.join(f.root, 'original'); fs.writeFileSync(original, 'original');
    const snapshot = path.join(folder, 'snapshot'); fs.symlinkSync(original, snapshot);
    f.store.put('desktopAsset:ready', { owner, localSessionId: 's', availability: 'ready', snapshot: { path: snapshot } });
    f.store.put('desktopAsset:unknown', { owner, localSessionId: 's', availability: 'uploading', snapshot: { path: original } });
    await finish(f.gc); expect(fs.readFileSync(original, 'utf8')).toBe('original'); expect(fs.lstatSync(snapshot).isSymbolicLink()).toBe(true);
    expect(f.store.get('desktopAsset:unknown')).toBeDefined();
  });
});
