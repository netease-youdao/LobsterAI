import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteFileReason } from '../../shared/remote/files';
import { payloadHash } from './canonical';
import type { DesktopInputRun } from './desktopInputMetadata';
import type { LocalPreparedInput } from './inputPreparationService';
import { remoteFileCacheDirectory } from './remoteFileSnapshots';
import { RemoteFileSync } from './remoteFileSync';
import { capturePreparedInputSnapshot, materializeRemotePreparedInputSources, type RemotePreparedInputSource } from './remotePreparedInputSnapshots';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';

const owner = { userId: '7', scopeKey: 'personal' };
const disposables: Array<() => void> = [];
afterEach(() => { for (const dispose of disposables.splice(0).reverse()) dispose(); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-prepared-snapshot-')));
  disposables.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'sealed.txt'); fs.writeFileSync(source, 'immutable phone bytes');
  const db = new Database(':memory:'); disposables.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner);
  new RemoteSyncTargetStore(store);
  db.prepare('INSERT INTO remote_sync_targets VALUES (?,?,?,?,?)').run('target-a', owner.userId, owner.scopeKey, 'device-a', null);
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'running',NULL,NULL)"); store.assignNew('session', owner, 'local_create'); });
  store.beginRun('session', 'run', 'command');
  store.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES('message','session','user','phone message',?,1,1)").run(JSON.stringify({ remoteRunId: 'run', remoteCommandId: 'command' })));
  const stat = fs.statSync(source), input = { text: 'phone message', agentId: 'main', expectedAgentVersion: '1', workspaceId: 'old-workspace',
    model: { modelRef: 'old-model', version: '1' }, options: {}, attachments: [{ assetId: 'old-asset', version: '1', intent: 'file' as const,
      sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sizeBytes: String(stat.size), mimeType: 'text/plain', fileName: 'input.txt' }] };
  const key = `inputPreparation:${JSON.stringify(['target-a', 'prepared'])}`;
  const prepared = { preparationId: 'prepared', owner, deviceId: 'device-a', targetId: 'target-a', inputDigest: payloadHash(input),
    resolvedInput: input, files: [{ assetId: 'old-asset', version: '1', path: source,
      identity: { realPath: source, dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs } }], boundCommandId: 'command' } as LocalPreparedInput;
  store.put(key, prepared); store.put('syncRunTarget:run', 'target-a'); store.put('inputRun:run', { input });
  store.put('inbox:target-a:command', { owner, targetId: 'target-a', localSessionId: 'session', runId: 'run', state: 'applied',
    command: { commandId: 'command', request: { payload: { inputPreparationId: 'prepared', inputDigest: prepared.inputDigest, resolvedInput: input } } } });
  const sourceJob = () => {
    materializeRemotePreparedInputSources(store, owner, 'device-b');
    const run = store.get<DesktopInputRun>('desktopInputRun:run')!;
    return { ...run.attachments[0], preparedSource: run.attachments[0].preparedSource as RemotePreparedInputSource,
      owner, localSessionId: 'session', messageId: 'message' };
  };
  return { root, source, db, store, key, prepared, sourceJob };
}

describe('historical phone input snapshots for another target', () => {
  it('materializes only local sealed source metadata, preserving the original target and preparation', async () => {
    const f = fixture(), raw = f.db.prepare('SELECT value FROM remote_state WHERE key=?').get(f.key);
    expect(materializeRemotePreparedInputSources(f.store, owner, 'device-b')).toBe(1);
    const run = f.store.get<DesktopInputRun>('desktopInputRun:run')!;
    expect(run.text).toBe('phone message');
    expect(run.attachments[0]).not.toHaveProperty('assetId');
    expect(run).not.toHaveProperty('inputModel');
    expect(f.db.prepare('SELECT value FROM remote_state WHERE key=?').get(f.key)).toEqual(raw);
    const job = f.sourceJob(), cache = path.join(f.root, 'uploads');
    const first = await capturePreparedInputSnapshot(f.store, job, cache, 'device-b', () => undefined);
    expect(first.path).not.toBe(f.source); expect(fs.readFileSync(first.path, 'utf8')).toBe('immutable phone bytes');
    fs.rmSync(first.path);
    const second = await capturePreparedInputSnapshot(f.store, job, cache, 'device-c', () => undefined);
    expect(second.path).not.toBe(first.path); expect(fs.readFileSync(f.source, 'utf8')).toBe('immutable phone bytes');
  });

  it.each(['owner', 'session', 'message', 'run', 'digest', 'device', 'unbound'])('does not materialize mismatched %s evidence', kind => {
    const f = fixture();
    if (kind === 'owner') f.store.put(f.key, { ...f.prepared, owner: { ...owner, scopeKey: 'another' } });
    if (kind === 'session') f.db.prepare("UPDATE cowork_messages SET session_id='other'").run();
    if (kind === 'message') f.db.prepare("UPDATE cowork_messages SET type='assistant'").run();
    if (kind === 'run') f.store.put('runHistory:session:run', { runId: 'other' });
    if (kind === 'digest') f.store.put('inputRun:run', { input: { ...f.prepared.resolvedInput, text: 'other' } });
    if (kind === 'device') f.store.put(f.key, { ...f.prepared, deviceId: 'device-b' });
    if (kind === 'unbound') f.store.put(f.key, { ...f.prepared, boundCommandId: null });
    expect(materializeRemotePreparedInputSources(f.store, owner, 'device-b')).toBe(0);
    expect(f.store.get('desktopInputRun:run')).toBeNull();
  });

  it('finds an exactly verified origin inbox after a claim retained its legacy key', () => {
    const f = fixture();
    f.db.prepare("UPDATE remote_state SET key='inbox:legacy:command' WHERE key='inbox:target-a:command'").run();
    expect(materializeRemotePreparedInputSources(f.store, owner, 'device-b')).toBe(1);
  });

  it('requires a unique exact origin inbox when an older user message omits the command ID', () => {
    const f = fixture();
    f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='message'").run(JSON.stringify({ remoteRunId: 'run' })));
    expect(materializeRemotePreparedInputSources(f.store, owner, 'device-b')).toBe(1);
    f.store.remove('desktopInputRun:run');
    f.store.put('inbox:duplicate', f.store.get('inbox:target-a:command'));
    expect(materializeRemotePreparedInputSources(f.store, owner, 'device-b')).toBe(0);
  });

  it('rejects changed source identity or digest and removes an untrusted upload copy', async () => {
    const f = fixture(), job = f.sourceJob(), cache = path.join(f.root, 'uploads');
    fs.writeFileSync(f.source, 'different phone bytes');
    await expect(capturePreparedInputSnapshot(f.store, job, cache, 'device-b', () => undefined)).rejects.toThrow(RemoteFileReason.Source);
    const stat = fs.statSync(f.source);
    f.prepared.files[0].identity = { realPath: f.source, dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs };
    f.store.put(f.key, f.prepared);
    await expect(capturePreparedInputSnapshot(f.store, job, cache, 'device-b', () => undefined)).rejects.toThrow(RemoteFileReason.Source);
    expect(fs.readdirSync(remoteFileCacheDirectory(cache, owner))).toEqual([]);
  });

  it('stops a target switch during capture without retaining a new upload snapshot', async () => {
    const f = fixture(), job = f.sourceJob(), cache = path.join(f.root, 'uploads'); let checks = 0;
    await expect(capturePreparedInputSnapshot(f.store, job, cache, 'device-b', () => {
      if (++checks >= 5) throw new Error(RemoteFileReason.Access);
    })).rejects.toThrow(RemoteFileReason.Access);
    expect(fs.existsSync(f.source)).toBe(true);
    const bucket = remoteFileCacheDirectory(cache, owner);
    expect(fs.existsSync(bucket) ? fs.readdirSync(bucket) : []).toEqual([]);
  });

  it('retains archived upload snapshots during the hourly file cleanup', async () => {
    const f = fixture(), cache = path.join(f.root, 'uploads'), job = f.sourceJob();
    const archived = await capturePreparedInputSnapshot(f.store, job, cache, 'device-b', () => undefined);
    const unused = await capturePreparedInputSnapshot(f.store, job, cache, 'device-b', () => undefined);
    const old = new Date(Date.now() - 2 * 86_400_000); fs.utimesSync(archived.path, old, old); fs.utimesSync(unused.path, old, old);
    f.db.prepare('INSERT INTO remote_sync_target_archives VALUES (?,?,?,?)').run('target-a', 'remote_state', 1,
      JSON.stringify({ key: 'desktopAsset:old:0', value: JSON.stringify({ owner, snapshot: archived }) }));
    const sync = new RemoteFileSync({ store: f.store, cacheRoot: cache, owner: () => owner, environment: () => 'target-b', enabled: () => true,
      access: () => ({ assertAllowed: () => undefined }), request: async () => new Response(JSON.stringify({ code: 0,
        data: { policyVersion: '1', types: [], features: {}, limits: {} } })) });
    sync.configure(true); sync.tick({ owner, environment: 'target-b', deviceId: 'device-b', generation: '1' }); await sync.settled();
    expect(fs.existsSync(archived.path)).toBe(true); expect(fs.existsSync(unused.path)).toBe(false); expect(fs.existsSync(f.source)).toBe(true);
  });

  it('uploads original bytes through a new desktop message asset and preserves origin caches', async () => {
    const f = fixture(); f.sourceJob();
    f.store.setInputProjectionSupported(true); f.store.setFileProjectionSupported(true);
    f.store.put('syncTargetHistory:session', { targetId: 'target-b', runIds: ['run'] });
    const calls: Array<{ url: string; body: any }> = [], bytes: Buffer[] = [];
    let descriptor: Record<string, any>;
    const sync = new RemoteFileSync({ store: f.store, cacheRoot: path.join(f.root, 'uploads'), owner: () => owner, environment: () => 'target-b', enabled: () => true,
      access: () => ({ assertAllowed: () => undefined }), request: async (_connection, url, init) => {
        const body = init.body && init.method !== 'PUT' ? JSON.parse(String(init.body)) : null;
        calls.push({ url, body });
        const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
        if (url.startsWith('/file-policy')) return ok({ policyVersion: '1', features: { desktopInputSync: true },
          types: [{ category: 'text', extensions: ['txt'], maxFileBytes: '5242880', inputAllowed: true }],
          limits: { maxInputCount: 10, maxInputBytes: '104857600', maxImageBytes: '20971520' } });
        if (url.endsWith('/input-assets')) { descriptor = { ...body, assetId: 'new-asset', version: '1', status: 'uploading', partBytes: '4194304', partCount: 1, completedParts: [] }; return ok(descriptor); }
        if (url.includes('/parts/')) { const part = Buffer.from(init.body as ArrayBuffer); bytes.push(part); return ok({ assetId: 'new-asset', partNo: 1, status: 'ready', sha256: createHash('sha256').update(part).digest('hex') }); }
        if (url.endsWith('/complete')) return ok({ ...descriptor, status: 'ready' });
        throw new Error(`Unexpected ${url}`);
      } });
    sync.configure(true); f.store.setFileEnvironment('target-b');
    f.store.snapshot('session'); f.db.prepare("UPDATE remote_sync SET device_id='device-b',ack_seq=source_seq,needs_snapshot=0 WHERE local_id='session'").run();
    sync.tick({ owner, environment: 'target-b', deviceId: 'device-b', generation: '1' }); await sync.settled();
    expect(Buffer.concat(bytes).toString()).toBe('immutable phone bytes');
    expect(JSON.stringify(calls)).not.toContain('old-asset');
    expect(f.store.get<any>('desktopAsset:message:0')).toMatchObject({ availability: 'ready', uploadedAsset: { assetId: 'new-asset' } });
    expect(fs.existsSync(f.source)).toBe(true); expect(f.store.get(f.key)).toEqual(f.prepared);
  });
});
