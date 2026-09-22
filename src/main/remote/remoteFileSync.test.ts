import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteCapability } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { type RemoteFilePolicy, RemoteFileReason, remoteFileRule } from '../../shared/remote/files';
import { RemoteFileCapability } from '../../shared/remote/files';
import type { LibraryIndexedFile } from '../library/libraryLocalStore';
import { captureDesktopInput } from './desktopInputMetadata';
import { RemoteBridge } from './remoteBridge';
import { captureRemoteFileSnapshot, remoteFileCacheDirectory, verifyRemoteFileSnapshot } from './remoteFileSnapshots';
import { RemoteFileSync } from './remoteFileSync';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'A', scopeKey: 'personal' };
const disposable: Array<() => void> = [];
afterEach(() => { for (const dispose of disposable.splice(0).reverse()) dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
const policy: RemoteFilePolicy = { policyVersion: '1', features: { inputUpload: true, desktopInputSync: true, artifactPublish: true, artifactDownload: true },
  types: [{ category: 'text', extensions: ['md', 'txt', 'json', 'yaml', 'js', 'html'], maxFileBytes: '5242880', inputAllowed: true, artifactAutoSync: true },
    { category: 'image', extensions: ['png'], maxFileBytes: '10485760', inputAllowed: true, artifactAutoSync: true }],
  limits: { partBytes: '4194304', maxInputCount: 10, maxInputBytes: '104857600', maxImageBytes: '20971520', maxTaskArtifactCount: 20, maxTaskArtifactBytes: '209715200' } };
function folder(): string { const result = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-files-test-'))); disposable.push(() => fs.rmSync(result, { recursive: true, force: true })); return result; }
const ok = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));
function fixture(sealedProducer = true, deliveries = false, fileName = 'report.md') {
  const directory = folder(), source = path.join(directory, fileName), cache = path.join(directory, 'cache'); fs.writeFileSync(source, 'first');
  const db = new Database(':memory:'); disposable.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);
    CREATE TABLE library_local_artifacts(id TEXT PRIMARY KEY,file_path TEXT,file_name TEXT,file_identity TEXT,updated_at INTEGER,extension TEXT,size_bytes INTEGER,availability TEXT);
    CREATE TABLE library_artifact_sessions(artifact_id TEXT,session_id TEXT,last_message_id TEXT,relation_kind TEXT,PRIMARY KEY(artifact_id,session_id));`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner); store.setFileProjectionSupported(true);
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'running',NULL,NULL)"); store.assignNew('s', owner, 'local_create'); });
  const stat = fs.statSync(source), sourceIdentity = `${stat.dev}:${stat.ino}:${Math.trunc(stat.birthtimeMs)}`;
  store.beginRun('s', 'run1');
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_messages VALUES('m1','s','assistant','report',?,1,1)").run(JSON.stringify({ remoteRunId: 'run1' }));
    db.prepare("INSERT INTO library_local_artifacts VALUES('local',?,?,?,1,?,5,'available')").run(source, fileName, sourceIdentity, path.extname(fileName).slice(1));
    db.exec("INSERT INTO library_artifact_sessions VALUES('local','s','m1','created')");
  });
  let actor: RemoteOwner | null = owner, generation = '1', version = 0;
  const calls: Array<{ pathname: string; body: any; headers: HeadersInit | undefined; generation: string }> = [];
  const uploads = new Map<string, any>(), bytes = new Map<string, Buffer>(), references: any[] = [];
  let latest: any = null, responseHook: ((pathname: string) => void) | undefined, loseVersionReceipt = false, manifestOverrides: Record<string, unknown> = {};
  const connection = () => ({ owner, environment: 'https://example.invalid', deviceId: 'pc', generation });
  const request = vi.fn(async (con, pathname, init) => {
    const body = init.body && init.method !== 'PUT' ? JSON.parse(String(init.body)) : null;
    calls.push({ pathname, body, headers: init.headers, generation: con.generation });
    responseHook?.(pathname);
    if (pathname.startsWith('/file-policy')) return ok(policy);
    if (pathname === '/devices/pc/artifacts') return ok({ artifactId: 'remote', revision: '1', latestVersion: '0' });
    const manifest = () => ({ artifactId: 'remote', sessionId: store.sync('s')!.session_id, name: fileName, revision: String(version + 1), availability: latest ? 'ready' : 'desktop_only', latest,
      latestVersion: latest?.artifactVersion || '0', lastCaptureSequence: latest ? uploads.get(latest.assetId).captureSequence : '0',
      pendingArtifactVersion: [...uploads.values()].find(item => item.publicationStatus === 'uploading')?.artifactVersion || null, ...manifestOverrides });
    if (pathname.startsWith('/sessions/')) return ok(manifest());
    if (pathname === '/artifacts/remote/versions') {
      const existing = [...uploads.values()].find(item => item.publicationId === body.publicationId);
      if (existing) return ok(existing);
      const item = { ...body, artifactId: 'remote', assetId: `asset${++version}`, artifactVersion: String(version), assetVersion: '1', writerGeneration: con.generation,
        status: 'uploading', publicationStatus: 'uploading', published: false, partBytes: '4194304', partCount: 1, completedParts: [] };
      uploads.set(item.assetId, item);
      if (loseVersionReceipt) { loseVersionReceipt = false; throw new Error('create receipt lost'); }
      return ok(item);
    }
    if (pathname.includes('/parts/')) { const id = pathname.split('/')[2]; bytes.set(id, Buffer.from(init.body)); uploads.get(id).completedParts = [1]; return ok({}); }
    if (pathname.endsWith('/complete')) { const item = uploads.get(pathname.split('/')[2]); item.status = 'ready'; return ok(item); }
    if (pathname.endsWith('/resume')) { const item = uploads.get(pathname.split('/')[2]); item.writerGeneration = con.generation; return ok(item); }
    if (pathname.startsWith('/artifact-uploads/')) return ok(uploads.get(pathname.split('/')[2]));
    if (pathname.endsWith('/publish')) {
      const item = [...uploads.values()].find(item => item.artifactVersion === pathname.split('/')[4]);
      item.publicationStatus = 'published'; item.published = true;
      latest = { artifactVersion: item.artifactVersion, assetId: item.assetId, assetVersion: '1', mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256 };
      return ok(manifest());
    }
    if (pathname.endsWith('/references')) { references.push(body); return ok({}); }
    if (pathname.endsWith('/sync-state')) return ok({});
    throw new Error(`Unexpected ${pathname}`);
  });
  const deps = { store, cacheRoot: cache, owner: () => actor, environment: () => connection().environment, enabled: () => true,
    access: () => ({ assertAllowed: () => { if (actor !== owner) throw new Error('hidden'); } }), request,
    recordArtifact: deliveries ? async (candidate: { filePath: string; messageId?: string }, _owner: RemoteOwner, assert: () => void, validate: (file: LibraryIndexedFile) => void) => {
      assert();
      const stat = fs.statSync(candidate.filePath);
      const identity = `${stat.dev}:${stat.ino}:${Math.trunc(stat.birthtimeMs)}`;
      validate({ filePath: candidate.filePath, fileIdentity: identity, sizeBytes: stat.size, fileMtimeMs: Math.trunc(stat.mtimeMs) } as LibraryIndexedFile);
      db.prepare("UPDATE library_local_artifacts SET file_identity=?,size_bytes=?,updated_at=? WHERE id='local'").run(identity, stat.size, Date.now());
      db.prepare("UPDATE library_artifact_sessions SET last_message_id=?,relation_kind='modified' WHERE artifact_id='local'").run(candidate.messageId);
      return true;
    } : undefined,
    // Simulates an engine that already sealed bytes before reporting its terminal event.
    terminalSnapshot: sealedProducer ? (item: { run_id: string; id: string }) => {
      const directory = remoteFileCacheDirectory(cache, owner); fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, randomUUID()); fs.copyFileSync(source, target);
      const file = fs.statSync(target), original = fs.statSync(source);
      const identity = (value: fs.Stats) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
      return { runId: item.run_id, artifactId: item.id, producerRevision: `revision-${item.run_id}`,
        snapshot: { path: target, sizeBytes: String(file.size), sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'), identity: identity(original), cacheIdentity: identity(file) } };
    } : undefined };
  let sync = new RemoteFileSync(deps); sync.configure(true);
  const ack = (): void => { store.snapshot('s'); db.prepare("UPDATE remote_sync SET device_id='pc',ack_seq=source_seq,needs_snapshot=0 WHERE local_id='s'").run(); };
  const tick = async (): Promise<void> => { ack(); sync.tick(connection()); await sync.settled(); };
  const nextRun = (number: number, text: string): void => {
    fs.writeFileSync(source, text); store.beginRun('s', `run${number}`);
    store.transaction(() => {
      db.prepare("INSERT INTO cowork_messages VALUES(?,'s','assistant','report',?,1,?)").run(`m${number}`, JSON.stringify({ remoteRunId: `run${number}` }), number);
      db.prepare("UPDATE library_artifact_sessions SET last_message_id=? WHERE artifact_id='local'").run(`m${number}`);
      db.prepare("UPDATE library_local_artifacts SET updated_at=? WHERE id='local'").run(number);
    });
  };
  return { store, db, source, cache, calls, bytes, references, uploads, tick, nextRun,
    prepareDelivery: () => sync.prepareRun('s', [fs.realpathSync(directory)], () => true),
    switchOwner: () => { actor = { userId: 'B', scopeKey: 'personal' }; },
    hook: (hook?: typeof responseHook) => { responseHook = hook; },
    loseVersionReceipt: () => { loseVersionReceipt = true; },
    expireUpload: () => { const item = uploads.get('asset1'); item.status = 'deleted'; item.publicationStatus = 'deleted'; },
    manifestOverride: (values: Record<string, unknown>) => { manifestOverrides = values; },
    reconnect: () => { generation = String(Number(generation) + 1); sync = new RemoteFileSync(deps); sync.configure(true); },
    jobs: () => store.entries<any>('fileOutput:').map(row => row.value) };
}
describe('remote files policy and immutable snapshots', () => {
  it('intersects server types and limits with local deny-by-default rules', () => {
    expect(remoteFileRule(policy, 'report.md', '5242880', true)).toBeNull();
    expect(remoteFileRule(policy, 'report.md', '5242881', true)).toBe(RemoteFileReason.Size);
    expect(remoteFileRule(policy, 'index.html', '1', true)).toBe(RemoteFileReason.Type);
    expect(remoteFileRule(policy, 'archive.zip', '1', false)).toBe(RemoteFileReason.Type);
    expect(remoteFileRule(policy, 'video.mp4', '1', true)).toBe(RemoteFileReason.Type);
  });
  it('uses the immutable image bytes passed to the engine instead of a later mutable file version', async () => {
    const root = folder(), source = path.join(root, 'input.txt'); fs.writeFileSync(source, 'original');
    const input = await captureDesktopInput({ text: 'read', attachments: [] }, [{ name: 'input.png', mimeType: 'image/png', base64Data: Buffer.from('original').toString('base64') }],
      { owner, cacheRoot: path.join(root, 'cache'), captureSnapshot: true, fallbackText: 'read', current: () => true, access: () => ({ assertAllowed: () => undefined }) });
    fs.writeFileSync(source, 'modified');
    expect(fs.readFileSync(input!.attachments[0].snapshot!.path, 'utf8')).toBe('original');
  });
  it('rejects symlinks, per-file excess, and account-cache overflow before upload', async () => {
    const root = folder(), source = path.join(root, 'a.md'), cache = path.join(root, 'cache'); fs.writeFileSync(source, 'value');
    const link = path.join(root, 'link'); fs.symlinkSync(source, link);
    await expect(captureRemoteFileSnapshot(link, cache, owner, 10, () => undefined)).rejects.toThrow(RemoteFileReason.Source);
    await expect(captureRemoteFileSnapshot(source, cache, owner, 4, () => undefined)).rejects.toThrow(RemoteFileReason.Size);
    const bucket = remoteFileCacheDirectory(cache, owner); fs.mkdirSync(bucket, { recursive: true });
    const full = fs.openSync(path.join(bucket, 'full'), 'w'); fs.ftruncateSync(full, 200 * 1024 * 1024); fs.closeSync(full);
    await expect(captureRemoteFileSnapshot(source, cache, owner, 10, () => undefined)).rejects.toThrow(RemoteFileReason.Final);
  });
  it('bounds total private snapshots across accounts without deleting source files', async () => {
    const root = folder(), cache = path.join(root, 'cache'), source = path.join(root, 'a.md'); fs.writeFileSync(source, 'value');
    for (let index = 0; index < 6; index++) {
      const bucket = remoteFileCacheDirectory(cache, { userId: `previous-${index}`, scopeKey: 'personal' }); fs.mkdirSync(bucket, { recursive: true });
      const descriptor = fs.openSync(path.join(bucket, 'full'), 'w');
      fs.ftruncateSync(descriptor, 180 * 1024 * 1024); fs.closeSync(descriptor);
    }
    await expect(captureRemoteFileSnapshot(source, cache, owner, 10, () => undefined)).rejects.toThrow(RemoteFileReason.Final);
    expect(fs.readFileSync(source, 'utf8')).toBe('value');
  });
  it('detects snapshot corruption even when size stays unchanged', async () => {
    const root = folder(), source = path.join(root, 'a.md'); fs.writeFileSync(source, 'first');
    const copy = await captureRemoteFileSnapshot(source, path.join(root, 'cache'), owner, 10, () => undefined); fs.writeFileSync(copy.path, 'other');
    await expect(verifyRemoteFileSnapshot(copy, () => true)).rejects.toThrow(RemoteFileReason.Source);
  });
  it('counts cached snapshots across spaces of the same account', async () => {
    const root = folder(), cache = path.join(root, 'cache'), source = path.join(root, 'a.md'); fs.writeFileSync(source, 'value');
    const bucket = remoteFileCacheDirectory(cache, { ...owner, scopeKey: 'team:2' }); fs.mkdirSync(bucket, { recursive: true });
    const descriptor = fs.openSync(path.join(bucket, 'full'), 'w'); fs.ftruncateSync(descriptor, 200 * 1024 * 1024); fs.closeSync(descriptor);
    await expect(captureRemoteFileSnapshot(source, cache, owner, 10, () => undefined)).rejects.toThrow(RemoteFileReason.Final);
  });
});
describe('artifact sync durable boundaries and protocol', () => {
  it('publishes an exec-delivered Markdown reference through the existing HTTP protocol', async () => {
    const f = fixture(false, true);
    f.db.prepare("UPDATE library_artifact_sessions SET relation_kind='referenced'").run();
    await f.tick();
    await f.prepareDelivery();
    fs.writeFileSync(f.source, '100 new arithmetic problems');
    f.store.transaction(() => {
      f.db.prepare("UPDATE cowork_messages SET content=?,sequence=3 WHERE id='m1'").run(`Delivered [report](${f.source})`);
      f.db.prepare("INSERT INTO cowork_messages VALUES('tool','s','tool_use','',?,1,1)").run(JSON.stringify({ remoteRunId: 'run1', toolName: 'exec', toolUseId: 't' }));
      f.db.prepare("INSERT INTO cowork_messages VALUES('result','s','tool_result','',?,1,2)").run(JSON.stringify({ remoteRunId: 'run1', toolUseId: 't', isFinal: true, toolResultDetails: { exitCode: 0 } }));
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2);
    f.store.updateRun('s', 'succeeded'); clock.mockRestore();
    await f.tick(); await f.tick();
    expect(f.bytes.get('asset1')?.toString()).toBe('100 new arithmetic problems');
    expect(f.references).toHaveLength(0);
    expect(f.jobs()[0].reason).toBeUndefined();
    expect(f.jobs()[0].references.m1).toMatchObject({ pinned: false, latest: { artifactVersion: '1' } });
    const message = f.store.snapshot('s').records.find(row => row.eventType === 'message.upsert' && row.payload.message.messageId === 'm1');
    expect(message?.payload.message.blocks.at(-1)).toMatchObject({ availability: 'ready', referenceMode: 'latest' });
  });
  it.each([
    { fileName: 'result.json', bytes: Buffer.from('{"answer":42}'), mimeType: 'application/json', image: false },
    { fileName: 'result.yaml', bytes: Buffer.from('answer: 42\n'), mimeType: 'text/plain', image: false },
    { fileName: 'result.png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64'), mimeType: 'image/png', image: true },
  ])('publishes $fileName as a ready version without reading a remote URL', async sample => {
    const f = fixture(false, true, sample.fileName);
    f.db.prepare("UPDATE library_artifact_sessions SET relation_kind='referenced'").run();
    await f.tick(); await f.prepareDelivery();
    fs.writeFileSync(f.source, sample.bytes);
    f.store.transaction(() => {
      f.db.prepare("UPDATE cowork_messages SET content=?,sequence=3 WHERE id='m1'")
        .run(`Delivered ${sample.image ? '!' : ''}[result](${f.source})`);
      f.db.prepare("INSERT INTO cowork_messages VALUES('tool','s','tool_use','',?,1,1)")
        .run(JSON.stringify({ remoteRunId: 'run1', toolName: 'exec', toolUseId: 't' }));
      f.db.prepare("INSERT INTO cowork_messages VALUES('result','s','tool_result','',?,1,2)")
        .run(JSON.stringify({ remoteRunId: 'run1', toolUseId: 't', isFinal: true, toolResultDetails: { exitCode: 0 } }));
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2);
    f.store.updateRun('s', 'succeeded'); clock.mockRestore();
    await f.tick(); await f.tick();
    expect(f.bytes.get('asset1')).toEqual(sample.bytes);
    expect(f.calls.find(call => call.pathname === '/artifacts/remote/versions')?.body).toMatchObject({ mimeType: sample.mimeType });
    const message = f.store.snapshot('s').records.find(row => row.eventType === 'message.upsert' && row.payload.message.messageId === 'm1');
    expect(message?.payload.message.blocks.at(-1)).toMatchObject({ name: sample.fileName, availability: 'ready', referenceMode: 'latest', mimeType: sample.mimeType });
    expect(JSON.stringify(f.calls)).not.toContain(f.source);
  });
  it('binds identical current bytes to a new message without fabricating terminal history', async () => {
    const f = fixture(false); await f.tick(); f.store.updateRun('s', 'succeeded'); await f.tick();
    f.nextRun(2, 'first'); await f.tick(); f.store.updateRun('s', 'succeeded'); await f.tick();
    expect(f.uploads.size).toBe(1);
    expect(f.jobs()[0].references.m2).toMatchObject({ runId: 'run2', pinned: false, latest: { artifactVersion: '1' } });
    expect(f.references).toHaveLength(0);
  });
  it('does not pin a mutable file as the past terminal version or delay starting the next run', async () => {
    const f = fixture(false); await f.tick(); f.store.updateRun('s', 'succeeded');
    expect(f.jobs()[0].queue).toHaveLength(0);
    expect(f.jobs()[0].reason).toBe(RemoteFileReason.Final);
    await f.tick();
    expect(f.bytes.get('asset1')?.toString()).toBe('first');
    expect(f.references).toHaveLength(0);
    expect(f.jobs()[0].references.m1.pinned).toBe(false);
    expect(f.jobs()[0].reason).toBe(RemoteFileReason.Final);
  });
  it('never attributes the next run bytes to an uncaptured older run', async () => {
    const f = fixture(false); await f.tick(); f.store.updateRun('s', 'succeeded');
    f.nextRun(2, 'second'); await f.tick();
    expect(f.references).toHaveLength(0);
    expect(f.jobs()[0].queue.some((item: { runId: string }) => item.runId === 'run1')).toBe(false);
  });

  it('publishes producer-sealed final bytes, pins the actual run, and projects no local path', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded'); await f.tick();
    expect(f.bytes.get('asset1')?.toString()).toBe('first'); expect(f.references).toMatchObject([{ runId: 'run1', messageId: 'm1', kind: 'terminal', artifactVersion: '1' }]);
    const record = f.store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!;
    expect(record.payload.message.blocks.at(-1)).toMatchObject({ artifactId: 'remote', availability: 'ready', artifactVersion: '1', referenceMode: 'pinned' });
    expect(JSON.stringify(f.calls)).not.toContain(f.source); expect(f.jobs()[0].queue).toHaveLength(0);
  });
  it('keeps two final snapshots in capture order while the later run overwrites the source', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded'); f.nextRun(2, 'second'); f.store.updateRun('s', 'succeeded');
    expect(f.jobs()[0].queue).toHaveLength(2); await f.tick(); await f.tick();
    expect([...f.bytes.values()].map(value => value.toString())).toEqual(['first', 'second']);
    expect(f.references.map(item => item.runId)).toEqual(['run1', 'run2']);
  });
  it('does not lose a terminal snapshot captured while another upload is awaiting a response', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded'); let queued = false;
    f.hook(pathname => { if (pathname.includes('/parts/') && !queued) { queued = true; f.nextRun(2, 'second'); f.store.updateRun('s', 'succeeded'); } });
    await f.tick(); f.hook(); expect(f.jobs()[0].queue).toHaveLength(1); await f.tick();
    expect(f.references.map(item => item.runId)).toEqual(['run1', 'run2']);
  });
  it('resumes the same publication on a new connection after a lost complete response', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded'); let failed = false;
    f.hook(pathname => { if (pathname.endsWith('/complete') && !failed) { failed = true; throw new Error('offline'); } });
    await f.tick(); const request = f.calls.find(item => item.pathname === '/artifacts/remote/versions')!.body;
    f.hook(); f.reconnect(); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000); await f.tick();
    expect(f.calls.some(item => item.pathname === '/artifact-uploads/asset1/resume')).toBe(true);
    expect(f.uploads.size).toBe(1); expect(f.references[0].requestId).toBe(request.publicationId);
  });
  it('pins unchanged final content for a new run without allocating another content asset', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded'); await f.tick();
    f.nextRun(2, 'first'); f.store.updateRun('s', 'succeeded'); await f.tick();
    expect(f.uploads.size).toBe(1); expect(f.references.map(item => [item.runId, item.artifactVersion])).toEqual([['run1', '1'], ['run2', '1']]);
  });
  it('resumes an old-generation idempotent CREATE when the original allocation response was lost', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded'); f.loseVersionReceipt(); await f.tick();
    expect(f.jobs()[0].queue[0].assetId).toBeUndefined(); expect(f.uploads.size).toBe(1);
    f.reconnect(); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000); await f.tick();
    const resume = f.calls.findIndex(item => item.pathname === '/artifact-uploads/asset1/resume');
    const part = f.calls.findIndex(item => item.pathname.includes('/parts/'));
    expect(resume).toBeGreaterThan(-1); expect(part).toBeGreaterThan(resume);
    expect(f.uploads.size).toBe(1); expect(f.references[0]).toMatchObject({ runId: 'run1', artifactVersion: '1' });
  });
  it.each([false, true])('replaces a confirmed expired upload using the original snapshot and CAS (lost CREATE receipt: %s)', async lostReceipt => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded');
    if (lostReceipt) f.loseVersionReceipt(); else f.hook(pathname => { if (pathname.endsWith('/complete')) throw new Error('offline'); });
    await f.tick(); const original = f.jobs()[0].queue[0]; f.hook(); f.expireUpload(); f.reconnect();
    // A later task may change the source; only the already captured run1 bytes can be recovered.
    f.nextRun(2, 'second'); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_461_000); await f.tick();
    const requests = f.calls.filter(item => item.pathname === '/artifacts/remote/versions').map(item => item.body);
    expect(new Set(requests.map(item => item.publicationId)).size).toBe(2);
    expect(requests.at(-1)).toMatchObject({ expectedLatestVersion: original.expectedLatestVersion, captureSequence: original.captureSequence,
      messageId: original.messageId, runId: original.runId, sha256: original.snapshot.sha256 });
    expect(f.bytes.get('asset2')?.toString()).toBe('first'); expect(f.references[0]).toMatchObject({ runId: 'run1', artifactVersion: '2' });
    expect(f.jobs()[0].queue).toHaveLength(0); expect(f.jobs()[0].completedPublications).toContain(original.publicationId);
    const oldState = f.calls.findLastIndex(item => item.pathname === '/artifact-uploads/asset1'
      || item.pathname === '/artifacts/remote/versions' && item.body.publicationId === original.publicationId);
    expect(f.calls.slice(oldState + 1).find(item => item.pathname.startsWith('/sessions/'))).toBeDefined();
    expect(f.calls.some(item => item.pathname === '/artifact-uploads/asset1/resume')).toBe(false);
  });
  it.each(['pending', 'missing-pending', 'newer-latest', 'advanced-capture', 'unknown-state', 'unknown-manifest', 'different-receipt', 'published'])(
    'does not replace an expired upload when reconciliation is unsafe: %s', async reason => {
      const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded');
      f.hook(pathname => { if (pathname.endsWith('/complete')) throw new Error('offline'); }); await f.tick();
      const original = f.jobs()[0].queue[0]; f.hook(); f.expireUpload(); f.reconnect();
      if (reason === 'different-receipt') f.uploads.get('asset1').sha256 = '0'.repeat(64);
      if (reason === 'published') f.uploads.get('asset1').published = true;
      let readOldState = false;
      f.hook(pathname => {
        if (pathname === '/artifact-uploads/asset1') {
          if (reason === 'unknown-state') throw new Error('offline');
          readOldState = true;
          // Change only after the initial manifest was read: recovery must fetch a fresh manifest.
          if (reason === 'pending') f.manifestOverride({ pendingArtifactVersion: '1' });
          if (reason === 'missing-pending') f.manifestOverride({ pendingArtifactVersion: undefined });
          if (reason === 'newer-latest') f.manifestOverride({ latestVersion: '9', latest: { artifactVersion: '9', sha256: 'other' } });
          if (reason === 'advanced-capture') f.manifestOverride({ lastCaptureSequence: original.captureSequence });
        }
        if (reason === 'unknown-manifest' && readOldState && pathname.startsWith('/sessions/')) throw new Error('offline');
      });
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_461_000); await f.tick();
      expect(f.uploads.size).toBe(1); expect(f.references).toHaveLength(0);
      expect(f.jobs()[0].queue[0]).toMatchObject({ publicationId: original.publicationId, captureSequence: original.captureSequence,
        expectedLatestVersion: original.expectedLatestVersion, snapshot: original.snapshot });
    });
  it.each(['replaced-cache', 'changed-message-run', 'missing-run', 'account-switch'])(
    'keeps an expired upload blocked when the local snapshot or context changed: %s', async reason => {
      const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded');
      f.hook(pathname => { if (pathname.endsWith('/complete')) throw new Error('offline'); }); await f.tick();
      const original = f.jobs()[0].queue[0]; f.hook(); f.expireUpload(); f.reconnect();
      if (reason === 'replaced-cache') { fs.renameSync(original.snapshot.path, `${original.snapshot.path}.old`); fs.writeFileSync(original.snapshot.path, 'first'); }
      if (reason === 'changed-message-run') f.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='m1'").run(JSON.stringify({ remoteRunId: 'run2' }));
      if (reason === 'missing-run') f.store.remove('runHistory:s:run1');
      if (reason === 'account-switch') f.hook(pathname => { if (pathname === '/artifact-uploads/asset1') f.switchOwner(); });
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_461_000); await f.tick();
      expect(f.uploads.size).toBe(1); expect(f.references).toHaveLength(0); expect(f.jobs()[0].queue[0].publicationId).toBe(original.publicationId);
    });
  it('stops the publish chain on account switch and preserves pending snapshots', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded');
    f.hook(pathname => { if (pathname.includes('/parts/')) f.switchOwner(); }); await f.tick();
    expect(f.calls.some(item => item.pathname.endsWith('/publish'))).toBe(false); expect(f.jobs()[0].queue).toHaveLength(1);
  });
  it('does not upload referenced-only files or substitute new bytes for a missed final boundary', async () => {
    const f = fixture(); f.db.prepare("UPDATE library_artifact_sessions SET relation_kind='referenced'").run(); await f.tick();
    expect(f.jobs()).toHaveLength(0); f.store.updateRun('s', 'succeeded'); f.store.remove('fileTerminalBoundary:s:run1');
    f.db.prepare("UPDATE library_artifact_sessions SET relation_kind='created'").run(); await f.tick();
    expect(f.jobs()[0].reason).toBe(RemoteFileReason.Final); expect(f.uploads.size).toBe(0);
  });
  it('captures a late renderer registration only while the same admitted run remains terminal', async () => {
    const f = fixture(); f.db.prepare("DELETE FROM library_artifact_sessions").run(); await f.tick(); f.store.updateRun('s', 'succeeded');
    f.db.prepare("INSERT INTO library_artifact_sessions VALUES('local','s','m1','created')").run(); await f.tick();
    expect(f.bytes.get('asset1')?.toString()).toBe('first'); expect(f.references[0]).toMatchObject({ runId: 'run1', kind: 'terminal' });
  });
  it('rejects late capture after file modification or a later persistent run ordinal', async () => {
    for (const change of ['modified', 'ordinal', 'next-run']) {
      const f = fixture(); f.db.prepare("DELETE FROM library_artifact_sessions").run(); await f.tick(); f.store.updateRun('s', 'succeeded');
      if (change === 'modified') { const after = Date.parse(f.store.run('s')!.finishedAt!) / 1000 + 5; fs.writeFileSync(f.source, 'changed'); fs.utimesSync(f.source, after, after); }
      if (change === 'ordinal') f.store.put('fileRunOrdinal:s', '2');
      if (change === 'next-run') f.store.beginRun('s', 'run2');
      f.db.prepare("INSERT INTO library_artifact_sessions VALUES('local','s','m1','created')").run(); await f.tick();
      expect(f.uploads.size).toBe(0); expect(f.jobs()[0].reason).toBe(RemoteFileReason.Final);
    }
  });
  it('keeps at most three protected final snapshots and never replaces them with a fourth run', async () => {
    const f = fixture(); await f.tick(); f.store.updateRun('s', 'succeeded');
    for (let i = 2; i <= 4; i++) { f.nextRun(i, `run${i}`); f.store.updateRun('s', 'succeeded'); }
    expect(f.jobs()[0].queue.map((item: any) => item.runId)).toEqual(['run1', 'run2', 'run3']);
    expect(f.jobs()[0].reason).toBe(RemoteFileReason.Final);
  });
  it('debounces ordinary writes and freezes a phase only after the delay', async () => {
    const f = fixture(), now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now); await f.tick();
    expect(f.uploads.size).toBe(0); vi.mocked(Date.now).mockReturnValue(now + 2100); await f.tick();
    expect(f.uploads.size).toBe(1); expect(f.references).toHaveLength(0);
    expect(f.jobs()[0].references.m1.pinned).toBe(false);
  });
  it('discovers capabilities with v1 even after the previous successful negotiation used v3', async () => {
    const f = fixture(), requests: RequestInit[] = [];
    const bridge: any = new RemoteBridge({ store: f.store, identity: { installationId: 'i', deviceKey: 'k', databaseId: 'd' },
      files: { cacheRoot: f.cache, access: () => ({ assertAllowed: () => undefined }) },
      getOwner: () => owner, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.invalid', runSessionTransaction: fn => f.store.transaction(fn),
      metadata: { name: 'pc', hostName: 'pc', instanceLabel: 'default', platform: 'macos', appVersion: '1' }, prepare: vi.fn(), execute: vi.fn(), onAccountChange: vi.fn(),
      request: async (_owner, _pathname, init) => { requests.push(init); return ok({ enabled: true, protocolVersions: [1], projectionVersions: [1, 2, 3], capabilities: [RemoteCapability.SameAccountAccess, ...Object.values(RemoteFileCapability)] }); },
    });
    bridge.owner = owner; bridge.registration = { deviceId: 'pc', ...owner, metadataVersion: '1' }; bridge.targetId = RemoteEnvironment.Test;
    await bridge.refreshCapabilities(); await bridge.refreshCapabilities();
    expect(bridge.projectionVersion).toBe(3);
    expect(requests.every(init => !new Headers(init.headers).has('X-Remote-Projection-Version'))).toBe(true);
    // File sync can be enabled while the separate Agent/model-selection rollout remains off.
    expect(bridge.inputCapabilities).toEqual([]);
    f.store.put('inputRun:run1', { input: { text: 'Read the attachment', attachments: [{ assetId: 'input-asset', version: '1', fileName: 'input.txt', mimeType: 'text/plain', sizeBytes: '5', intent: 'file' }] }, inputModel: null });
    f.store.transaction(() => f.db.prepare("INSERT INTO cowork_messages VALUES('input-message','s','user','Read',?,1,2)").run(JSON.stringify({ remoteRunId: 'run1' })));
    const message = f.store.snapshot('s').records.find(record => record.eventType === 'message.upsert' && record.payload.message.messageId === 'input-message')!;
    expect(message.payload.message.blocks[1]).toMatchObject({ type: 'attachment', assetId: 'input-asset', availability: 'ready' }); bridge.stop();
  });
});
