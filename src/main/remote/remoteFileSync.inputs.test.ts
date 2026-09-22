import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import { type RemoteFilePolicy, RemoteFileReason } from '../../shared/remote/files';
import { captureDesktopInput } from './desktopInputMetadata';
import { RemoteFileSync } from './remoteFileSync';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'attachment-user', scopeKey: 'personal' };
const policy: RemoteFilePolicy = {
  policyVersion: '1', features: { inputUpload: true, desktopInputSync: true, artifactPublish: false, artifactDownload: true },
  types: [
    { category: 'image', extensions: ['png'], maxFileBytes: '10485760', inputAllowed: true, artifactAutoSync: true },
    { category: 'text', extensions: ['md', 'json', 'py'], maxFileBytes: '5242880', inputAllowed: true, artifactAutoSync: true },
    { category: 'document', extensions: ['pdf', 'docx'], maxFileBytes: '31457280', inputAllowed: true, artifactAutoSync: true },
    { category: 'video', extensions: ['mp4'], maxFileBytes: '52428800', inputAllowed: true, artifactAutoSync: false },
  ],
  limits: { partBytes: '4194304', maxInputCount: 10, maxInputBytes: '104857600', maxImageBytes: '20971520', maxTaskArtifactCount: 20, maxTaskArtifactBytes: '209715200' },
};
const disposables: Array<() => void> = [];
afterEach(() => { for (const dispose of disposables.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });
const ok = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-input-policy-'));
  disposables.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheRoot = path.join(root, 'cache');
  const db = new Database(':memory:'); disposables.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner); store.setInputProjectionSupported(true); store.setFileProjectionSupported(true);
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'running',NULL,NULL)"); store.assignNew('s', owner, 'local_create'); });
  store.beginRun('s', 'run');
  let actor: RemoteOwner | null = owner, enabled = true, now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const connection = { owner, environment: 'https://example.invalid', deviceId: 'pc', generation: '1' };
  const uploads: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (_connection: unknown, pathname: string, init: RequestInit) => {
    if (pathname.startsWith('/file-policy')) return ok(policy);
    if (pathname === '/devices/pc/input-assets') {
      const body = JSON.parse(String(init.body)); uploads.push(body);
      return ok({ ...body, assetId: 'asset', version: '1', status: 'ready' });
    }
    throw new Error(`Unexpected ${pathname}`);
  });
  const sync = new RemoteFileSync({ store, cacheRoot, owner: () => actor, enabled: () => enabled,
    environment: () => connection.environment, access: () => ({ assertAllowed: () => undefined }), request });
  sync.configure(true);
  const sourcePath = path.join(root, 'selected-file');
  const capture = async (extension?: string) => {
    if (extension) fs.writeFileSync(sourcePath, 'send-time selected file');
    const input = await captureDesktopInput({ text: '', attachments: extension ? [{ path: sourcePath, name: `selected.${extension}`, intent: 'file' }] : [] },
      extension ? undefined : [{ name: 'photo.png', mimeType: 'image/png', base64Data: Buffer.from('send-time image').toString('base64') }], {
      owner, fallbackText: '', cacheRoot, captureSnapshot: sync.canCaptureInput(), selectedFileCaptureDeadline: performance.now() + 5000, current: () => actor === owner,
      access: () => ({ assertAllowed: () => undefined }),
    });
    store.put('desktopInputRun:run', input);
    store.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES('m','s','user','',?,1,1)").run(JSON.stringify({ remoteRunId: 'run' })));
    store.snapshot('s');
    db.prepare("UPDATE remote_sync SET device_id='pc',ack_seq=source_seq,needs_snapshot=0 WHERE local_id='s'").run();
    return input!.attachments[0].snapshot!;
  };
  const tick = async (): Promise<void> => { sync.tick({ ...connection }); await sync.settled(); };
  return { sync, store, request, connection, uploads, capture, tick, sourcePath, job: () => store.get<any>('desktopAsset:m:0'),
    advance: () => { now += 60_001; }, setOwner: (value: RemoteOwner | null) => { actor = value; }, setEnabled: (value: boolean) => { enabled = value; } };
}

describe('desktop input capture and upload admission', () => {
  it.each(['md', 'json', 'py', 'pdf', 'docx', 'mp4'])('uploads only the sealed send-time .%s input after the task edits the source', async extension => {
    const f = fixture();
    const snapshot = await f.capture(extension);
    expect(f.request).not.toHaveBeenCalled();
    fs.writeFileSync(f.sourcePath, 'changed by the local task');
    expect(fs.readFileSync(snapshot.path, 'utf8')).toBe('send-time selected file');
    await f.tick();
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]).toMatchObject({ sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, fileName: `selected.${extension}` });
    expect(f.job()).toMatchObject({ availability: 'ready', uploadedAsset: { assetId: 'asset', intent: 'file' } });
    expect(fs.readFileSync(f.sourcePath, 'utf8')).toBe('changed by the local task');
  });

  it('captures sealed send-time bytes before the first policy response and uploads after policy arrives', async () => {
    const f = fixture();
    expect(f.sync.canCaptureInput()).toBe(true);
    const snapshot = await f.capture();
    expect(f.request).not.toHaveBeenCalled();
    expect(fs.readFileSync(snapshot.path, 'utf8')).toBe('send-time image');
    await f.tick();
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]).toMatchObject({ sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, fileName: 'photo.png' });
    expect(f.job()).toMatchObject({ availability: 'ready', uploadedAsset: { assetId: 'asset', intent: 'image' } });
    expect(fs.existsSync(snapshot.path)).toBe(false);
  });

  it('retains immutable bytes across policy failure and backs off before retrying', async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error('policy unavailable'));
    const snapshot = await f.capture();
    await f.tick();
    expect(f.sync.canCaptureInput()).toBe(true);
    expect(f.uploads).toHaveLength(0);
    expect(fs.readFileSync(snapshot.path, 'utf8')).toBe('send-time image');
    await f.tick(); expect(f.request).toHaveBeenCalledTimes(1);
    f.advance(); await f.tick();
    expect(f.job().availability).toBe('ready');
    expect(f.uploads[0].sha256).toBe(snapshot.sha256);
  });

  it('keeps capture separate from an explicit upload denial and waits for fresh policy on reconnect', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(ok({ ...policy, features: { ...policy.features, desktopInputSync: false } }));
    await f.tick();
    const snapshot = await f.capture();
    await f.tick();
    expect(f.uploads).toHaveLength(0);
    expect(fs.existsSync(snapshot.path)).toBe(true);
    f.sync.pause();
    expect(f.sync.canCaptureInput()).toBe(true);
    f.connection.generation = '2'; await f.tick();
    expect(f.job().availability).toBe('ready');
  });

  it('preserves captured bytes after upload failure and publishes changed failure state', async () => {
    const f = fixture(); const snapshot = await f.capture();
    const markDirty = vi.spyOn(f.store, 'markFilesDirty');
    f.request.mockResolvedValueOnce(ok(policy)).mockRejectedValueOnce(new Error('upload unavailable'));
    await f.tick();
    expect(fs.existsSync(snapshot.path)).toBe(true);
    expect(f.job()).toMatchObject({ reason: 'upload unavailable', snapshot: { sha256: snapshot.sha256 } });
    expect(markDirty).toHaveBeenCalledWith('s');
    const changed = markDirty.mock.calls.length;
    await f.tick(); expect(markDirty).toHaveBeenCalledTimes(changed);
    f.advance(); await f.tick();
    expect(f.job()).toMatchObject({ availability: 'ready', uploadedAsset: { assetId: 'asset' } });
    expect(f.job().reason).toBeUndefined();
  });

  it('keeps the ready receipt when local cache cleanup fails after upload', async () => {
    const f = fixture(); const snapshot = await f.capture();
    const remove = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => target === snapshot.path
      ? Promise.reject(new Error('EACCES: cache cleanup unavailable')) : remove(target, options));
    await f.tick();
    expect(f.job()).toMatchObject({ availability: 'ready', uploadedAsset: { assetId: 'asset' } });
    expect(f.job().reason).toBeUndefined();
    expect(fs.existsSync(snapshot.path)).toBe(true);
    f.advance(); await f.tick();
    expect(f.uploads).toHaveLength(1);
    expect(f.job().availability).toBe('ready');
  });

  it.each([
    [RemoteFileReason.Final, RemoteFileReason.Final],
    [RemoteFileReason.Size, RemoteFileReason.Size],
    ['/private/secret token=value', RemoteFileReason.Source],
  ])('preserves only safe capture failure reasons during upload scheduling: %s', async (captureReason, reason) => {
    const f = fixture(); await f.capture();
    const job = f.job(); delete job.snapshot;
    f.store.put('desktopAsset:m:0', { ...job, captureReason });
    await f.tick();
    expect(f.job().reason).toBe(reason);
    expect(f.uploads).toHaveLength(0);
  });

  it('does not upload captured bytes under another account or without remote admission', async () => {
    const f = fixture(); const snapshot = await f.capture();
    f.setOwner({ userId: 'another-account', scopeKey: 'personal' });
    await f.tick();
    expect(f.request).not.toHaveBeenCalled();
    expect(fs.existsSync(snapshot.path)).toBe(true);
    f.setOwner(null); expect(f.sync.canCaptureInput()).toBe(false);
    f.setOwner(owner); f.setEnabled(false); expect(f.sync.canCaptureInput()).toBe(false);
    f.setEnabled(true); f.sync.configure(false); expect(f.sync.canCaptureInput()).toBe(false);
  });
});
