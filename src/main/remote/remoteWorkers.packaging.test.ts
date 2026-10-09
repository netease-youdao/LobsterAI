import Database from 'better-sqlite3';
import { fork } from 'child_process';
import { createHash, randomUUID } from 'crypto';
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
import { RemoteNetworkBodyEncoding, RemoteNetworkFailure, RemoteNetworkLimit as NetworkLimit,RemoteNetworkMessage } from './remoteNetworkProtocol';
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
  it('uploads binary file parts through the real packaged network child', async () => {
    const fixture = path.join(root, 'upload-network-fixture.cjs');
    fs.writeFileSync(fixture, `
      const {createHash}=require('crypto');
      const stats={started:0,cancelled:0};
      let lastTimeout=0;const realTimeout=setTimeout;
      global.setTimeout=(fn,ms,...args)=>{if(ms===30000||ms===120000)lastTimeout=ms;return realTimeout(fn,ms,...args);};
      global.fetch = async (url, options) => {
        if (new URL(url).pathname.endsWith('/capabilities')) return new Response(JSON.stringify({code:0,data:{workerPid:process.pid,...stats}}));
        stats.started++;
        const mode=new URL(url).searchParams.get('mode');
        if(mode==='unauthorized') return new Response(JSON.stringify({code:40100}),{status:401,headers:{'content-type':'application/json'}});
        if(mode==='hold') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{stats.cancelled++;reject(new Error('aborted'));},{once:true}));
        const bytes = Buffer.from(options.body);
        return new Response(JSON.stringify({code:0,data:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),timeoutMs:lastTimeout}}));
      };
      require(${JSON.stringify(path.join(output, RemoteWorkerFile.Network))});
    `);
    const transport = new RemoteNetworkTransport(fork, fixture);
    const base = 'https://example.com/api/remote/v1';
    try {
      const metadata = await (await transport.fetch(base + '/capabilities')).json();
      expect(metadata.data.workerPid).not.toBe(process.pid);
      for (const [route, length, offset] of [
        ['artifact-uploads', 133604, 0], ['artifact-uploads', 3 * 1024 * 1024 + 123, 17],
        ['artifact-uploads', NetworkLimit.ArtifactPartBytes, 0], ['input-assets', NetworkLimit.InputPartBytes, 19],
      ] as const) {
        const original = new Uint8Array(length + offset + 23);
        for (let i = 0; i < original.length; i++) original[i] = i % 251;
        const bytes = original.subarray(offset, offset + length);
        const expected = createHash('sha256').update(bytes).digest('hex');
        const response = await transport.queuedFetch(base + '/' + route + '/upload-1/parts/1', {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
          body: offset ? bytes : original.buffer.slice(0, length),
        });
        expect(await response.json()).toMatchObject({ code: 0, data: { bytes: length, sha256: expected, timeoutMs: NetworkLimit.BinaryTimeoutMs } });
      }
      const part = base + '/artifact-uploads/upload-1/parts/1';
      const denied = await transport.queuedFetch(part + '?mode=unauthorized', { method: 'PUT', body: new ArrayBuffer(4) });
      expect(denied.status).toBe(401); expect(await denied.clone().json()).toEqual({ code: 40100 });
      const abort = new AbortController();
      const waiting = transport.queuedFetch(part + '?mode=hold', { method: 'PUT', body: new ArrayBuffer(4), signal: abort.signal });
      const cancelled = expect(waiting).rejects.toThrow('CANCELLED');
      await vi.waitFor(async () => expect((await (await transport.fetch(base + '/capabilities')).json()).data.started).toBe(6));
      abort.abort(); await cancelled;
      await vi.waitFor(async () => expect((await (await transport.fetch(base + '/capabilities')).json()).data.cancelled).toBe(1));
    } finally { transport.dispose(); }
  });
  it('rejects malformed or oversized binary request IPC again inside the packaged child', async () => {
    const fixture = path.join(root, 'rejected-upload-fixture.cjs');
    fs.writeFileSync(fixture, `
      global.fetch=async()=>new Response(JSON.stringify({code:0}));
      require(${JSON.stringify(path.join(output, RemoteWorkerFile.Network))});
    `);
    const child = fork(fixture, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','ignore','ignore','ipc'], serialization: 'json' });
    const base = 'https://example.com/api/remote/v1';
    const send = (message: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => reject(new Error('No request rejection')), 5000);
      const listener = (result: any): void => {
        if (result.id !== id) return;
        expect(result.type).not.toBe(RemoteNetworkMessage.FetchStarted);
        if (result.type === RemoteNetworkMessage.Result) { clearTimeout(timer); child.off('message', listener); resolve(result); }
      };
      child.on('message', listener);
      child.send({ type: RemoteNetworkMessage.Fetch, id, url: base + '/artifact-uploads/upload-1/parts/1', method: 'PUT', headers: {},
        bodyEncoding: RemoteNetworkBodyEncoding.Base64, body: 'AP8=', ...message });
    });
    try {
      for (const message of [
        { url: base + '/capabilities' }, { url: base + '/artifact-uploads/upload-1/complete' }, { method: 'POST' },
        { bodyEncoding: 'unknown' }, { body: '%%%=' }, { body: 'AP8' }, { body: 'AP9=' },
      ]) expect((await send(message)).error).toBe(RemoteNetworkFailure.RequestInvalid);
      expect((await send({ body: Buffer.alloc(NetworkLimit.ArtifactPartBytes + 1).toString('base64') })).error).toBe(RemoteNetworkFailure.RequestBudget);
      expect((await send({ url: base + '/input-assets/asset-1/parts/1', body: Buffer.alloc(NetworkLimit.InputPartBytes + 1).toString('base64') })).error).toBe(RemoteNetworkFailure.RequestBudget);
      expect((await send({ bodyEncoding: undefined, body: 'x'.repeat(NetworkLimit.BodyBytes + 1) })).error).toBe(RemoteNetworkFailure.RequestBudget);
    } finally { child.kill('SIGKILL'); }
  });
  it('preserves binary input asset bytes in the packaged network child', async () => {
    const fixture = path.join(root, 'binary-network-fixture.cjs');
    fs.writeFileSync(fixture, `
      global.fetch = async () => new Response(Buffer.from([137,80,78,71,13,10,26,10]), {headers:{'content-type':'image/png'}});
      require(${JSON.stringify(path.join(output, RemoteWorkerFile.Network))});
    `);
    const transport = new RemoteNetworkTransport(fork, fixture);
    try {
      const response = await transport.fetch('https://example.com/api/remote/v1/input-assets/asset-1/content?preparationId=prep-1');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    } finally { transport.dispose(); }
  });
  it('streams large input downloads with backpressure, cancellation, limits and independent controls', async () => {
    const fixture = path.join(root, 'streaming-network-fixture.cjs');
    fs.writeFileSync(fixture, `
      const stats = {pulls:0,cancelled:0,started:0};
      global.fetch = async (url, options) => {
        const mode = new URL(url).searchParams.get('mode');
        if (!mode) return new Response(JSON.stringify({code:0,data:stats}));
        if (mode === 'unauthorized') return new Response(JSON.stringify({code:40100}),{status:401,headers:{'content-type':'application/json'}});
        stats.started++;
        const total = mode === 'oversized-stream' ? ${NetworkLimit.BinaryBytes + 1} : 3*1024*1024+123;
        let sent = 0, abort;
        const body = new ReadableStream({
          start(controller) {
            abort = () => {stats.cancelled++;controller.error(new DOMException('Aborted','AbortError'));};
            options.signal.addEventListener('abort',abort,{once:true});
          },
          pull(controller) {
            stats.pulls++;
            if (sent === total) {options.signal.removeEventListener('abort',abort);controller.close();return;}
            const bytes = Buffer.alloc(Math.min(65536,total-sent));
            for (let i=0;i<bytes.length;i++) bytes[i]=(sent+i)%251;
            sent+=bytes.length;controller.enqueue(bytes);
          },
          cancel() {stats.cancelled++;options.signal.removeEventListener('abort',abort);}
        },{highWaterMark:0});
        return new Response(body,{headers:{'content-type':mode==='json-file'?'application/json':'image/png',
          ...(mode === 'oversized-header' ? {'content-length':'${NetworkLimit.BinaryBytes + 1}'} : {})}});
      };
      require(${JSON.stringify(path.join(output, RemoteWorkerFile.Network))});
    `);
    const transport = new RemoteNetworkTransport(fork, fixture);
    const prefix = 'https://example.com/api/remote/v1';
    const asset = (mode: string) => `${prefix}/input-assets/asset-1/content?preparationId=prep-1&mode=${mode}`;
    const stats = async () => (await (await transport.fetch(`${prefix}/capabilities`)).json()).data;
    try {
      const large = await transport.fetch(asset('large'));
      expect((await stats()).pulls).toBe(0);
      const reader = large.body!.getReader(), first = await reader.read();
      expect(first.value).toHaveLength(NetworkLimit.BinaryChunkBytes);
      expect((await stats()).pulls).toBe(1);
      // A queued file occupies no additional transfer slot; controls proceed while consumption pauses.
      let secondStarted = false;
      const second = transport.queuedFetch(asset('json-file')).then(response => { secondStarted = true; return response; });
      expect((await stats()).started).toBe(1); expect(secondStarted).toBe(false);
      await reader.cancel();
      const response = await second;
      const actual = Buffer.from(await response.arrayBuffer());
      const expected = Buffer.alloc(3 * 1024 * 1024 + 123);
      for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
      expect(actual.length).toBe(expected.length);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
      expect((await stats()).cancelled).toBeGreaterThan(0);
      const denied = await transport.fetch(asset('unauthorized'));
      expect(denied.status).toBe(401); expect(await denied.clone().json()).toEqual({ code: 40100 });
      await expect(transport.fetch(asset('oversized-header'))).rejects.toThrow('RESPONSE_BUDGET');
      const oversized = await transport.fetch(asset('oversized-stream'));
      let bytes = 0;
      await expect((async () => {
        for await (const chunk of oversized.body as unknown as AsyncIterable<Uint8Array>) bytes += chunk.byteLength;
      })()).rejects.toThrow('RESPONSE_BUDGET');
      expect(bytes).toBe(NetworkLimit.BinaryBytes);
      expect((await stats()).started).toBe(4);
    } finally { transport.dispose(); }
  }, 15000);
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
