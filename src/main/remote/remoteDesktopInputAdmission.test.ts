import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteInputIntent } from '../../shared/remote/input';
import { RemoteRetention } from '../../shared/remote/retention';
import { RemoteSyncTarget } from '../../shared/remote/syncTarget';
import { RemoteBridge } from './remoteBridge';
import { isUnpublishedDesktopInputJob } from './remoteDesktopInputAdmission';
import { ensureDesktopInputJobs } from './remoteDesktopInputJobs';
import { readRemoteSessionAdmission, RemoteSessionAdmission } from './remoteDisplayHealthAdmission';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';

const owner = { userId: 'attachment-user', scopeKey: 'personal' };
vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
const bridges: RemoteBridge[] = [];
const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.stop(); for (const db of databases.splice(0)) if (db.open) db.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

function fixture(intent: 'file' | 'image' = RemoteInputIntent.File, count = 1, filename = ':memory:') {
  const db = new Database(filename); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  const targets = new RemoteSyncTargetStore(store);
  const target = targets.activate({ owner, deviceId: 'desktop',
    syncTarget: { version: RemoteSyncTarget.Version, dataSpaceId: 'test', dataGeneration: '1' } });
  store.setProjectionIdentity(target.targetId, owner, 'desktop'); store.setEnabledOwner(owner);
  store.setTaskAdmission(id => targets.isAdmitted(owner, 'desktop', target.targetId, id));
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'idle',NULL,NULL)");
    store.assignNew('s', owner, 'local_create');
  });
  store.beginRun('s', 'run');
  const source = { path: '/selected/input.pdf', fileName: 'input.pdf', mimeType: 'application/pdf', intent, sizeBytes: '12',
    fileIdentity: { dev: '1', ino: '2', sizeBytes: '12', mtimeMs: 1 } };
  store.put('desktopInputRun:run', { owner, localSessionId: 's', text: 'Read this', attachments: Array.from({ length: count }, () => source) });
  store.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES('m','s','user','Read this',?,1,1)").run(JSON.stringify({ remoteRunId: 'run' })));
  const admitted = () => targets.isAdmitted(owner, 'desktop', target.targetId, 's');
  const prepare = () => ensureDesktopInputJobs(store, 's', 'm');
  return { db, store, targets, target, source, admitted, prepare };
}

describe('new desktop sessions with locally prepared attachments', () => {
  it.each([RemoteInputIntent.File, RemoteInputIntent.Image])('remains admitted after preparing %s jobs, including after reconstruction', intent => {
    const f = fixture(intent, 2);
    expect(f.admitted()).toBe(true);
    expect(f.prepare()).not.toBeNull();
    const before = f.store.sync('s');
    const jobs = f.store.entries('desktopAsset:');
    expect(jobs).toHaveLength(2);
    expect(f.admitted()).toBe(true);
    expect(new RemoteSyncTargetStore(f.store).isAdmitted(owner, 'desktop', f.target.targetId, 's')).toBe(true);
    expect(f.prepare()).toBeNull();
    expect(f.store.sync('s')).toEqual(before);
    expect(f.store.entries('desktopAsset:')).toEqual(jobs);
  });

  it('also admits pending jobs produced by the history projector', () => {
    const f = fixture();
    f.store.project('s');
    expect(f.store.get('desktopAsset:m:0')).not.toBeNull();
    expect(f.admitted()).toBe(true);
  });

  it.each([
    { assetId: 'allocated' }, { uploadedAsset: { assetId: 'ready' } }, { environment: 'other-target' },
    { deviceId: 'other-device' }, { availability: 'ready' }, { retry: { phase: 'backoff' } },
    { reason: 'unknown' }, { futureReceipt: {} }, { assetId: null }, { uploadRequestId: '' },
    { owner: { ...owner, userId: 'other' } }, { localSessionId: 'other' }, { sessionId: 'other' },
    { messageId: 'other' }, { path: '/different/file.pdf' }, { sizeBytes: '13' },
  ])('retains the admission barrier for modified or remotely attempted jobs: %j', patch => {
    const f = fixture(); f.prepare();
    f.store.put('desktopAsset:m:0', { ...f.store.get<Record<string, unknown>>('desktopAsset:m:0'), ...patch });
    expect(f.admitted()).toBe(false);
  });

  it.each(['message', 'source', 'run', 'prepared-source', 'malformed-source', 'source-receipt', 'foreign-run', 'remote-command'])('requires original local provenance (%s)', change => {
    const f = fixture(); f.prepare();
    if (change === 'message') f.db.prepare("UPDATE cowork_messages SET type='assistant' WHERE id='m'").run();
    if (change === 'source') f.store.remove('desktopInputRun:run');
    if (change === 'run') f.store.remove('runHistory:s:run');
    if (change === 'prepared-source' || change === 'source-receipt') {
      const input = f.store.get<{ attachments: Record<string, unknown>[] }>('desktopInputRun:run')!;
      const patch = change === 'prepared-source' ? { preparedSource: {} } : { assetId: 'hidden-receipt' };
      Object.assign(input.attachments[0], patch); f.store.put('desktopInputRun:run', input);
      f.store.put('desktopAsset:m:0', { ...f.store.get<Record<string, unknown>>('desktopAsset:m:0'), ...patch });
    }
    if (change === 'malformed-source') f.db.prepare("UPDATE remote_state SET value='{' WHERE key='desktopInputRun:run'").run();
    if (change === 'foreign-run') f.store.put('syncRunTarget:run', 'other-target');
    if (change === 'remote-command') f.store.put('runCommand:s', 'remote-command');
    expect(f.admitted()).toBe(false);
  });

  it.each(['import', 'inbox', 'file-output', 'archive', 'quarantine', 'owner', 'device', 'ack', 'epoch'])('does not bypass existing synchronization protections (%s)', barrier => {
    const f = fixture(); f.prepare();
    if (barrier === 'import') f.store.put('import:s', { importId: 'original' });
    if (barrier === 'inbox') f.store.put('inbox:original', { localSessionId: 's', owner });
    if (barrier === 'file-output') f.store.put('fileOutput:original', { localSessionId: 's', owner });
    if (barrier === 'archive') f.db.prepare('INSERT INTO remote_sync_admission_evidence VALUES(?,?,?,?)')
      .run(`admission:${f.target.targetId}`, 'remote_sync', 's', JSON.stringify(f.store.sync('s')));
    if (barrier === 'quarantine') f.db.prepare('INSERT INTO remote_sync_session_admissions VALUES(?,?,?,?,?,?,?,?,?)')
      .run(f.target.targetId, owner.userId, owner.scopeKey, 'desktop', 's', f.store.sync('s')!.session_id, RemoteSessionAdmission.Quarantined, null, 'original-archive');
    if (barrier === 'owner') f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='other' WHERE session_id='s'").run();
    if (barrier === 'device') f.db.prepare("UPDATE remote_sync SET device_id='other-device' WHERE local_id='s'").run();
    if (barrier === 'ack') f.db.prepare("UPDATE remote_sync SET ack_seq=1 WHERE local_id='s'").run();
    if (barrier === 'epoch') f.db.prepare("UPDATE remote_sync SET stream_epoch='original' WHERE local_id='s'").run();
    expect(f.admitted()).toBe(false);
  });
});


describe('desktop attachment snapshot synchronization', () => {
  it.each([false, true])('commits an initial snapshot after a missing server mapping (previously isolated: %s)', isolated => {
    return synchronize(isolated);
  });
});

async function synchronize(isolated: boolean): Promise<void> {
  const f = fixture(); f.prepare();
  const request = vi.fn(async (_actor: unknown, pathname: string) => {
    const response = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, data }), { status });
    if (pathname.includes('/sync/state?')) return response({ reason: 'SYNC_STATE_NOT_FOUND' }, RemoteRetention.StateMissingCode, 404);
    const saved = f.store.get<any>('import:s');
    const state = pathname.endsWith('/commit') ? 'committed' : 'uploading';
    if (pathname.endsWith('/sync/imports') || pathname.endsWith('/commit')) return response({
      importId: saved.importId, sessionId: saved.sessionId, syncProtocolVersion: RemoteRetention.Version,
      targetStreamEpoch: '11111111-2222-4333-8444-555555555555', manifestHash: saved.manifest.manifestHash, state, stateVersion: '1',
      ...(state === 'committed' ? { streamEpoch: '11111111-2222-4333-8444-555555555555', committedSourceSeq: saved.baseSourceSeq,
        committedSeq: '5', sourcePurgeSeq: saved.baseSourceSeq, eventPurgeSeq: '0', partsExpired: true } : {}),
    });
    if (pathname.includes('/parts/')) return response({});
    throw new Error(`Unexpected request ${pathname}`);
  });
  const bridge: any = new RemoteBridge({ store: f.store, identity: { installationId: 'test', deviceKey: 'test-key', databaseId: 'test-db' },
    runSessionTransaction: operation => f.store.transaction(operation), getOwner: () => owner,
    getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.invalid', request,
    execute: vi.fn(), prepare: vi.fn(), onAccountChange: vi.fn(),
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
  });
  bridges.push(bridge);
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.targetId = f.target.targetId; bridge.generation = '1'; bridge.retentionSupported = true; bridge.fenceCheckedAt = Date.now();
  f.store.setWake(() => {});
  f.store.put(`settings:${owner.userId}:${owner.scopeKey}`, { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [] });
  f.store.project('s');
  const job = f.store.get('desktopAsset:m:0');
  if (isolated) {
    const context = bridge.taskContext();
    bridge.taskSync.fail(context, 's', { phase: 'isolated', scope: 'session', reason: 'REMOTE_SYNC_STATE_CONFLICT' });
    f.store.put('syncFailure:s', { blocked: true, reason: 'REMOTE_SYNC_STATE_CONFLICT', retryAt: Number.MAX_SAFE_INTEGER });
    expect(bridge.sessionAdmitted('s')).toBe(true);
    expect(bridge.taskSync.manualRetry(context, 's')).toBe(true);
    // The first pass verifies the missing mapping before retrying the original snapshot.
    await bridge.syncSessions();
  }
  await bridge.syncSessions();
  expect(request.mock.calls.some(call => call[1].endsWith('/commit'))).toBe(true);
  expect(f.store.get('syncFailure:s')).toBeNull();
  expect(f.store.sync('s')).toMatchObject({ device_id: 'desktop', needs_snapshot: 0, sync_protocol_version: RemoteRetention.Version });
  expect(f.store.sync('s')!.ack_seq).toBeGreaterThan(0);
  expect(f.store.get('desktopAsset:m:0')).toEqual(job);
  expect(f.admitted()).toBe(true);
}


describe('attachment admission compatibility and bounded work', () => {
  it.each(['/Users/test/桌面/文件.pdf', String.raw`C:\Users\test\Desktop\文件.pdf`, String.raw`\\server\share\文件.pdf`])('preserves platform-specific paths without accessing or normalizing them: %s', filePath => {
    const f = fixture();
    const input = f.store.get<any>('desktopInputRun:run');
    input.attachments[0].path = filePath;
    input.attachments[0].snapshot = { path: filePath, sizeBytes: '12', identity: 'original' };
    f.store.put('desktopInputRun:run', input); f.prepare();
    expect(f.admitted()).toBe(true);
  });

  it('reopens persisted legacy local inputs read-only without schema changes or rewriting any receipts', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'desktop-admission-upgrade-')); directories.push(directory);
    const filename = path.join(directory, 'existing.sqlite');
    const f = fixture(RemoteInputIntent.File, 1, filename);
    const input = f.store.get<any>('desktopInputRun:run');
    delete input.localSessionId; delete input.attachments[0].fileIdentity;
    input.attachments[0].snapshot = { path: '/old/cache', identity: 'old', sizeBytes: '12' };
    f.store.put('desktopInputRun:run', input); f.prepare();
    const before = f.db.prepare('SELECT key,value FROM remote_state ORDER BY key').all();
    const schema = f.db.pragma('schema_version', { simple: true });
    f.db.close();
    const db = new Database(filename, { readonly: true, fileMustExist: true }); databases.push(db);
    expect(readRemoteSessionAdmission(db, owner, 'desktop', f.target.targetId, 's')).toBe(true);
    expect(db.pragma('schema_version', { simple: true })).toBe(schema);
    expect(db.prepare('SELECT key,value FROM remote_state ORDER BY key').all()).toEqual(before);
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual({ count: 0 });
  });

  it('reuses only statements and immediately observes changed receipts, metadata and owners', () => {
    const f = fixture(RemoteInputIntent.File, 20); f.prepare();
    const row = f.store.sync('s')!, job = f.store.get('desktopAsset:m:0');
    expect(isUnpublishedDesktopInputJob(f.db, 'desktopAsset:m:0', job, row)).toBe(true);
    const prepare = vi.spyOn(f.db, 'prepare');
    for (let index = 0; index < 100; index++) expect(isUnpublishedDesktopInputJob(f.db, 'desktopAsset:m:0', job, row)).toBe(true);
    expect(prepare).not.toHaveBeenCalled(); prepare.mockRestore();
    f.db.prepare("UPDATE cowork_messages SET metadata='{}' WHERE id='m'").run();
    expect(isUnpublishedDesktopInputJob(f.db, 'desktopAsset:m:0', job, row)).toBe(false);
    f.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='m'").run(JSON.stringify({ remoteRunId: 'run' }));
    f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='other' WHERE session_id='s'").run();
    expect(isUnpublishedDesktopInputJob(f.db, 'desktopAsset:m:0', job, row)).toBe(false);
  });

  it.each(['deep', 'wide', 'oversized', 'malformed'])('rejects abnormal retained JSON safely (%s)', shape => {
    const f = fixture(); f.prepare();
    const input = f.store.get<any>('desktopInputRun:run'), job = f.store.get<any>('desktopAsset:m:0');
    let raw: string;
    if (shape === 'deep') raw = '{"nested":'.repeat(10000) + '0' + '}'.repeat(10000);
    else if (shape === 'wide') raw = JSON.stringify(Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [String(index), index])));
    else if (shape === 'oversized') raw = JSON.stringify('x'.repeat(1048577));
    else raw = '{';
    const inputText = JSON.stringify(input).replace('"intent":"file"', '"snapshot":' + raw + ',"intent":"file"');
    const jobText = JSON.stringify(job).replace('"intent":"file"', '"snapshot":' + raw + ',"intent":"file"');
    f.db.prepare('UPDATE remote_state SET value=? WHERE key=?').run(inputText, 'desktopInputRun:run');
    f.db.prepare('UPDATE remote_state SET value=? WHERE key=?').run(jobText, 'desktopAsset:m:0');
    // Call the added validator directly: global admission handles malformed legacy rows separately.
    const value = shape === 'malformed' ? {} : JSON.parse(jobText);
    expect(() => isUnpublishedDesktopInputJob(f.db, 'desktopAsset:m:0', value, f.store.sync('s')!)).not.toThrow();
    expect(isUnpublishedDesktopInputJob(f.db, 'desktopAsset:m:0', value, f.store.sync('s')!)).toBe(false);
  });

  it('does not hide storage errors as a successful local admission', () => {
    const f = fixture(); f.prepare();
    const row = f.store.sync('s')!, job = f.store.get('desktopAsset:m:0');
    f.db.close();
    expect(() => isUnpublishedDesktopInputJob(f.db, 'desktopAsset:m:0', job, row)).toThrow();
  });
});
