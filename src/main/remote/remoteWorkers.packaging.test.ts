import Database from 'better-sqlite3';
import { fork } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Worker } from 'worker_threads';

import { remoteWorkerBuilds } from '../../../remote-workers.config';
import { RemoteHistoryJob } from './remoteHistoryJob';
import { RemoteLiveProjectionJob } from './remoteLiveProjectionJob';
import { RemoteNetworkTransport } from './remoteNetworkTransport';
import { RemoteStore } from './remoteStore';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-worker-packaging-'));
const unpacked = path.join(root, 'resources', 'app.asar.unpacked');
const output = path.join(unpacked, 'dist-electron');
const archived = path.join(root, 'resources', 'app.asar', 'dist-electron');
const require = createRequire(import.meta.url);
const owner = { userId: 'packaged-owner', scopeKey: 'personal' };
beforeAll(async () => {
  fs.mkdirSync(output, { recursive: true });
  // The native dependency is intentionally external. Replicate its packaged lookup root.
  fs.symlinkSync(path.resolve(__dirname, '../../../node_modules'), path.join(unpacked, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const worker of remoteWorkerBuilds(output)) await build({ ...worker.vite, logLevel: 'silent' });
}, 60000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function invoke(filename: typeof RemoteWorkerFile[keyof typeof RemoteWorkerFile], workerData?: unknown, message?: unknown): Promise<any> {
  if (filename === RemoteWorkerFile.Projection || filename === RemoteWorkerFile.ImportSnapshot) {
    const result = await new RemoteHistoryJob(remoteWorkerPath(RemoteWorkerFile.HistoryGuard, archived)).run(remoteWorkerPath(filename, archived), workerData, { timeoutMs: 10000, memoryMb: 256, current: () => true, prefix: 'REMOTE_PROJECTION' });
    return { result };
  }
  const worker = new Worker(remoteWorkerPath(filename, archived), { workerData });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged worker did not reply')), 10000);
      worker.once('message', result => { clearTimeout(timer); resolve(result); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Packaged worker exited ${code}`)); });
      if (message) worker.postMessage(message);
    });
  } finally { await worker.terminate(); }
}

describe('independent packaged remote workers', () => {
  it('emits all unpacked files and keeps native SQLite external', () => {
    const config = require(path.resolve(__dirname, '../../../electron-builder.json'));
    for (const filename of Object.values(RemoteWorkerFile)) {
      expect(remoteWorkerPath(filename, archived)).toBe(path.join(output, filename));
      expect(config.asarUnpack).toContain(`dist-electron/${filename}`);
      expect(fs.statSync(path.join(output, filename)).size).toBeLessThan(2 * 1024 * 1024);
    }
    for (const filename of [RemoteWorkerFile.Projection, RemoteWorkerFile.ImportSnapshot, RemoteWorkerFile.LiveProjection])
      expect(fs.readFileSync(path.join(output, filename), 'utf8')).toMatch(/require\(["']better-sqlite3["']\)/u);
    const compiledDirectory = path.join(root, 'dist-electron', 'main', 'remote');
    expect(remoteWorkerPath(RemoteWorkerFile.Projection, compiledDirectory)).toBe(path.join(compiledDirectory, RemoteWorkerFile.Projection));
  });
  it('runs bounded HTTP parsing and WS admission in the packaged child without core access', async () => {
    const fixture = path.join(root, 'network-fixture.cjs');
    fs.writeFileSync(fixture, `
      const { EventEmitter } = require('events');
      global.fetch = async url => {
        const mode = String(url).split('/').pop();
        if (mode === 'oversized') return new Response('x'.repeat(2 * 1024 * 1024 + 1));
        if (mode === 'deep') return new Response('['.repeat(100) + '0' + ']'.repeat(100));
        if (mode === 'wide') return new Response(JSON.stringify(Array.from({length: 20001}, () => 0)));
        if (mode === 'invalid') return new Response('{secret');
        return new Response(JSON.stringify({code:0,data:{workerPid:process.pid}}));
      };
      global.WebSocket = class extends EventEmitter {
        static OPEN = 1;
        readyState = 1;
        bufferedAmount = 0;
        constructor() { super(); setImmediate(() => this.emit('open')); }
        addEventListener(type, listener) { this.on(type, listener); }
        close() { this.readyState = 3; }
        send(mode) {
          if(mode === 'burst') for(let i=0;i<17;i++) this.emit('message',{data:JSON.stringify({type:'pong'})});
          else this.emit('message',{data:mode === 'oversized' ? 'x'.repeat(65537) : mode === 'deep' ? '{"type":"pong","value":'+'['.repeat(100)+'0'+']'.repeat(100)+'}' : '{secret'});
        }
      };
      require(${JSON.stringify(path.join(output, RemoteWorkerFile.Network))});
    `);
    const transport = new RemoteNetworkTransport(fork, fixture);
    try {
      const prefix = 'https://example.com/api/remote/v1/capabilities/';
      const response = await transport.fetch(prefix + 'ok');
      const data = await response.clone().json(); expect(data.data.workerPid).not.toBe(process.pid);
      for (const mode of ['oversized', 'deep', 'wide']) await expect(transport.fetch(prefix + mode)).rejects.toThrow('REMOTE_NETWORK_RESPONSE_BUDGET');
      await expect((await transport.fetch(prefix + 'invalid')).json()).rejects.toThrow('REMOTE_NETWORK_RESPONSE_INVALID');
      for (const [mode, code] of [['oversized',1009], ['deep',1002], ['invalid',1002], ['burst',1013]] as const) {
        const socket = transport.socket('wss://example.com/api/remote/v1/ws'); const frames = vi.fn(); socket.addEventListener('message', frames);
        const closed = new Promise<any>(resolve => socket.addEventListener('close', resolve));
        await vi.waitFor(() => expect(socket.readyState).toBe(1)); socket.send(mode);
        expect(await closed).toEqual({ code }); expect(frames.mock.calls.length).toBe(mode === 'burst' ? 16 : 0);
      }
    } finally { transport.dispose(); }
  });
  it('starts file and security workers from the same paths used by the bundled main process', async () => {
    const directory = path.join(root, 'cache', 'owner', 'scope');
    const file = await invoke(RemoteWorkerFile.FileSnapshot, undefined, { id: 1, kind: 'input', args: { directory, base64: Buffer.from('immutable').toString('base64') }, cancel: new SharedArrayBuffer(4) });
    expect(file.error).toBeUndefined(); expect(fs.readFileSync(file.value, 'utf8')).toBe('immutable');
    const security = await invoke(RemoteWorkerFile.SecurityJournal, { directory: path.join(root, 'security') }, { id: 2, operation: 'read' });
    expect(security).toEqual({ id: 2, value: { current: null, previous: null } });
  });
  it('loads native SQLite and completes projection plus immutable import build/read in packaged workers', async () => {
    const database = path.join(root, 'core.sqlite'), target = path.join(root, 'projection.sqlite');
    const db = new Database(database);
    try {
      db.exec('CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT); CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER)');
      const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
      store.transaction(() => {
        db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle')").run(); store.assignNew('session', owner, 'local_create');
        db.prepare("INSERT INTO cowork_messages VALUES('message','session','assistant','Worker output','{}',1,1)").run();
      });
      db.prepare("UPDATE remote_sync SET device_id='device',sync_environment='test' WHERE local_id='session'").run();
      const live = await new RemoteLiveProjectionJob(remoteWorkerPath(RemoteWorkerFile.LiveProjection,archived),10000).project(db, {
        database,localId: 'session',sessionId: store.controlBinding('session')!.session_id,deviceId: 'device',owner,objectId: 'message',revision: '1',
      });
      expect(live?.payload.preview).toBe('Worker output'); expect(live?.objectId).toBe('message');
      const projected = await invoke(RemoteWorkerFile.Projection, { database, target, sessionId: 'session', owner, deviceId: 'device', environment: 'test', agent: null, approval: false, input: false, files: false, reply: false });
      expect(projected.error).toBeUndefined(); expect(projected.result.targetSourceSeq).toBeGreaterThan(0);
      const snapshot = new Database(target);
      let identity;
      try {
        const sync = snapshot.prepare("SELECT * FROM remote_sync WHERE local_id='session'").get() as any;
        const revision = snapshot.prepare("SELECT revision FROM remote_session_revisions WHERE session_id='session'").get() as any;
        const epoch = snapshot.prepare("SELECT value FROM remote_state WHERE key='snapshotEpoch:session'").get() as any;
        identity = { localSessionId: 'session', sessionId: sync.session_id, deviceId: 'device', environment: 'test', owner,
          sourceSeq: String(sync.source_seq), snapshotEpoch: epoch ? JSON.parse(epoch.value) : 0, revision: revision?.revision || 0 };
      } finally { snapshot.close(); }
      const directory = path.join(root, 'immutable-import');
      const imported = await invoke(RemoteWorkerFile.ImportSnapshot, { operation: 'build', database: target, directory, fileSet: 'sealed-files', identity });
      expect(imported.error).toBeUndefined(); expect(imported.result.parts.length).toBeGreaterThan(0);
      const read = await invoke(RemoteWorkerFile.ImportSnapshot, { operation: 'read', directory, part: imported.result.parts[0] });
      expect(read.error).toBeUndefined(); expect(JSON.parse(read.result).records.length).toBeGreaterThan(0);
    } finally { db.close(); }
  });
});
