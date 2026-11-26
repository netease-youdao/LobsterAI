import { type ChildProcess, fork } from 'child_process';
import { randomUUID } from 'crypto';
import { buildSync } from 'esbuild';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { RemoteNetworkFailure as Failure, RemoteNetworkLimit as Limit, RemoteNetworkMessage as Message } from './remoteNetworkProtocol';

let directory: string, bootstrap: string, child: ChildProcess;
const base = 'https://example.invalid/api/remote';
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-network-worker-'));
  const worker = path.join(directory, 'network.cjs'); bootstrap = path.join(directory, 'bootstrap.cjs');
  buildSync({ entryPoints: [path.join(__dirname, 'remoteNetworkWorker.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs' });
  fs.writeFileSync(bootstrap, `
    global.fetch = async (url, init) => {
      if (String(url).endsWith('?fail=true')) throw new Error('private-fetch-error');
      if (String(url).includes('/input-assets/')) return new Response(new Uint8Array([1,2,3,4]));
      return new Response(JSON.stringify({ url: String(url), method: init.method, redirect: init.redirect, workerPid: process.pid }));
    };
    require(${JSON.stringify(worker)});
  `);
});
beforeEach(() => { child = fork(bootstrap, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' }); });
afterEach(async () => {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
});
afterAll(() => { fs.rmSync(directory, { recursive: true, force: true }); });
async function request(url: string, method = 'GET', extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const started: unknown[] = [];
  const result = await new Promise<any>((resolve, reject) => {
    const receive = (value: any): void => {
      if (value.id !== id) return;
      if (value.type === Message.FetchStarted) started.push(value);
      if (value.type === Message.Result) { child.off('message', receive); resolve(value); }
    };
    child.on('message', receive);
    child.send({ type: Message.Fetch, id, url, method, headers: {}, ...extra }, error => { if (error) reject(error); });
  });
  return { result, started };
}
it.each([
  ['/v1/devices/desktop/commands?state=unresolved&limit=20', 'GET'],
  ['/v2/device-connections', 'GET'], ['/v3/sync/recoveries/recovery-1', 'GET'],
  ['/v1/commands/command-1/reconcile', 'POST'], ['/v3/sync/live-projections', 'POST'],
  ['/v4/devices/desktop-1/commands/unresolved?limit=20&cursor=opaque%2Fcursor', 'GET'],
])('allows the existing APIs and negotiated recovery through the real worker: %s', async (pathname, method) => {
  const { result, started } = await request(base + pathname, method);
  expect(result).toMatchObject({ type: Message.Result, status: 200, jsonValid: true,
    json: { url: base + pathname, method, redirect: 'error', workerPid: child.pid } });
  expect(started).toHaveLength(1); expect(child.pid).not.toBe(process.pid);
});
it.each([
  ['/v4/capabilities', 'GET'], ['/v4/devices/desktop/commands', 'GET'],
  ['/v4/devices/desktop/commands/unresolved/extra', 'GET'], ['/v4/devices/desktop/commands/unresolved', 'POST'],
  ['/v4/devices/desktop/commands/unresolved', 'DELETE'], ['/v4/devices/desktop/commands/unresolved', 'HEAD'],
  ['/v4/devices/desktop%2Fother/commands/unresolved', 'GET'], ['/v4/devices/' + 'x'.repeat(65) + '/commands/unresolved', 'GET'],
  ['/v5/devices/desktop/commands/unresolved', 'GET'], ['/v3/capabilities', 'TRACE'],
])('rejects unrelated routes or methods in the real worker before fetch: %s %s', async (pathname, method) => {
  const { result, started } = await request(base + pathname, method);
  expect(result.error).toBe(Failure.RequestInvalid); expect(started).toHaveLength(0);
});
it.each(['http:', 'file:', 'ftp:'])('retains HTTPS-only admission for recovery: %s', async protocol => {
  const { result, started } = await request(base.replace('https:', protocol) + '/v4/devices/desktop/commands/unresolved');
  expect(result.error).toBe(Failure.RequestInvalid); expect(started).toHaveLength(0);
});
it('retains worker request body and header size budgets on the new route', async () => {
  const url = base + '/v4/devices/desktop/commands/unresolved';
  const body = await request(url, 'GET', { body: 'x'.repeat(Limit.BodyBytes + 1) });
  expect(body.result.error).toBe(Failure.RequestBudget); expect(body.started).toHaveLength(0);
  const headers = await request(url, 'GET', { headers: { test: 'x'.repeat(Limit.HeaderBytes) } });
  expect(headers.result.error).toBe(Failure.RequestInvalid); expect(headers.started).toHaveLength(0);
});

function expectWorkerTiming(value: any): void {
  expect(Number.isFinite(value.transportMs)).toBe(true); expect(value.transportMs).toBeGreaterThanOrEqual(0);
  expect(value.transportMs).toBeLessThan(24 * 60 * 60 * 1000);
  expect(Number.isSafeInteger(value.sentAtEpochMs)).toBe(true); expect(value.sentAtEpochMs).toBeGreaterThan(0);
  expect(value.sentAtEpochMs).toBeLessThanOrEqual(Date.now());
}
it('adds finite child timings to success and fetch errors without changing their response fields', async () => {
  const successful = await request(base + '/v1/capabilities'); expectWorkerTiming(successful.result);
  expect(successful.result.json.workerPid).toBe(child.pid); expect(successful.started).toHaveLength(1);
  const failed = await request(base + '/v1/capabilities?fail=true'); expectWorkerTiming(failed.result);
  expect(failed.result.error).toBe(Failure.Failed); expect(failed.started).toHaveLength(1);
  expect(JSON.stringify(failed.result)).not.toContain('private-fetch-error');
  const rejected = await request(base + '/v5/capabilities'); expectWorkerTiming(rejected.result);
  expect(rejected.result.transportMs).toBe(0); expect(rejected.started).toHaveLength(0);
});
it('includes child timings on the final streamed response after all bytes are consumed', async () => {
  const id = randomUUID(), chunks: string[] = [];
  const end = await new Promise<any>((resolve, reject) => {
    const receive = (message: any): void => {
      if (message.id !== id) return;
      if (message.type === Message.StreamStart) child.send({ type: Message.StreamPull, id, seq: 0 });
      if (message.type === Message.StreamChunk) { chunks.push(message.body); child.send({ type: Message.StreamPull, id, seq: message.seq + 1 }); }
      if (message.type === Message.StreamEnd || message.type === Message.Result) { child.off('message', receive); resolve(message); }
    };
    child.on('message', receive);
    child.send({ type: Message.Fetch, id, url: base + '/v1/input-assets/asset/content', method: 'GET', headers: {} }, error => { if (error) reject(error); });
  });
  expect(end).toMatchObject({ type: Message.StreamEnd, bytes: 4 }); expectWorkerTiming(end);
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(Buffer.from([1,2,3,4]));
});
