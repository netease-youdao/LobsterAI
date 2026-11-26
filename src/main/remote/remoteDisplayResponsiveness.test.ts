import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { build } from 'esbuild';
import { promises as fs } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteDisplayHealthFailure, type RemoteDisplayHealthInput, type RemoteDisplayHealthResult,RemoteDisplayHealthStatus } from './remoteDisplayHealth';
import { RemoteHistoryJob } from './remoteHistoryJob';

const Mode = { Cpu: 'cpu', Hang: 'hang', Oversized: 'oversized', Exit: 'exit', Reply: 'reply' } as const;
type Mode = typeof Mode[keyof typeof Mode];
const limits = { timeoutMs: 5000, memoryMb: 96, resultLimitBytes: 64 * 1024, current: () => true, prefix: 'REMOTE_IMPORT' as const };
const directories: string[] = [];
const active: Array<{ job: RemoteHistoryJob; completion: Promise<unknown> }> = [];
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

afterEach(async () => {
  for (const { job } of active) job.cancel();
  await Promise.allSettled(active.splice(0).map(({ completion }) => completion));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

interface Reply { pid: number; args: string[] }
interface Distribution { count: number; p95Ms: number; p99Ms: number; maxMs: number }
interface Measurement { label: string; elapsedMs: number; duringChild: number; http: Distribution; timerLag: Distribution }

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const value = (quantile: number): number => Number((sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0).toFixed(3));
  return { count: sorted.length, p95Ms: value(0.95), p99Ms: value(0.99), maxMs: value(1) };
}

async function fixture(mode: Mode, job = new RemoteHistoryJob(path.join(__dirname, 'remoteHistoryGuardWorker.cjs'))) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-display-responsiveness-'));
  directories.push(directory);
  const filename = path.join(directory, 'worker.cjs');
  const pidFile = path.join(directory, 'pid');
  await fs.writeFile(filename, `
    const fs = require('fs');
    const { performance } = require('perf_hooks');
    const Mode = ${JSON.stringify(Mode)};
    process.once('message', request => {
      fs.writeFileSync(request.input.pidFile, String(process.pid));
      const reply = () => {
        setInterval(() => {}, 1000);
        process.send({ jobId: request.jobId, result: { pid: process.pid, args: process.execArgv } });
      };
      if (request.input.mode === Mode.Hang) { while (true) {} }
      if (request.input.mode === Mode.Cpu) {
        const end = performance.now() + 1000;
        while (performance.now() < end) { Math.sqrt(Math.random()); }
        reply();
      } else if (request.input.mode === Mode.Oversized) {
        setTimeout(() => process.send({ jobId: request.jobId, result: 'x'.repeat(65536) }), 250);
      } else if (request.input.mode === Mode.Exit) {
        setTimeout(() => process.exit(23), 250);
      } else if (request.input.mode === Mode.Reply) reply();
    });
  `);
  const completion = job.run<Reply>(filename, { mode, pidFile }, limits);
  // Register rejection before waiting for the child PID, including early startup failure.
  void completion.catch(() => undefined);
  active.push({ job, completion });
  const deadline = performance.now() + limits.timeoutMs;
  let pid: number | undefined;
  while (!pid && performance.now() < deadline) {
    try { pid = Number(await fs.readFile(pidFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!pid) await pause(5);
  }
  expect(pid).toBeGreaterThan(0);
  expect(pid).not.toBe(process.pid);
  return { job, completion, pid: pid! };
}

function stopped(pid: number): void {
  let code: string | undefined;
  try { process.kill(pid, 0); }
  catch (error) { code = (error as NodeJS.ErrnoException).code; }
  expect(code, 'the job must settle only after its real child has exited').toBe('ESRCH');
}

async function echoEndpoint() {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const echo = (): Promise<void> => new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: address.port, path: '/', agent }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.once('end', () => body === 'ok' ? resolve() : reject(new Error('Invalid echo response')));
      response.once('error', reject);
    });
    request.setTimeout(1000, () => request.destroy(new Error('Parent echo timed out')));
    request.once('error', reject);
  });
  const close = async (): Promise<void> => {
    agent.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  // Exclude TCP/server cold start from both baseline and fault measurements.
  for (let i = 0; i < 20; i++) await echo();
  return { echo, close };
}

async function measure(label: string, completion: Promise<unknown>, echo: () => Promise<void>, minimumMs = 1000): Promise<Measurement> {
  let settled = false;
  void completion.then(() => { settled = true; }, () => { settled = true; });
  const httpTimes: number[] = [], timerLag: number[] = [];
  const began = performance.now();
  let lastTick = began, duringChild = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    timerLag.push(Math.max(0, now - lastTick - 5)); lastTick = now;
  }, 5);
  try {
    while (!settled || httpTimes.length < 1000 || performance.now() - began < minimumMs) {
      if (performance.now() - began > 12000) throw new Error('Responsiveness observation exceeded its budget');
      const started = performance.now();
      await echo();
      httpTimes.push(performance.now() - started);
      if (!settled) duringChild++;
    }
  } finally { clearInterval(timer); }
  const measurement = { label, elapsedMs: Number((performance.now() - began).toFixed(3)), duringChild,
    http: distribution(httpTimes), timerLag: distribution(timerLag) };
  console.info('[RemoteDisplayResponsiveness]', JSON.stringify(measurement));
  expect(measurement.http.count).toBeGreaterThanOrEqual(1000);
  expect(measurement.timerLag.count).toBeGreaterThanOrEqual(10);
  for (const observed of [measurement.http, measurement.timerLag]) {
    expect(observed.p95Ms).toBeLessThanOrEqual(100);
    expect(observed.p99Ms).toBeLessThanOrEqual(250);
    expect(observed.maxMs).toBeLessThanOrEqual(500);
  }
  return measurement;
}

describe('display statistics real-process responsiveness boundary', () => {
  it('keeps parent timers and loopback HTTP responsive during 1000ms of synchronous child CPU, against an idle baseline', async () => {
    const endpoint = await echoEndpoint();
    try {
      const baseline = await measure('baseline/no-child', pause(1000), endpoint.echo);
      const running = await fixture(Mode.Cpu);
      const busy = await measure('child/cpu-1000ms', running.completion, endpoint.echo);
      const reply = await running.completion;
      expect(reply.args).toContain('--max-old-space-size=96');
      expect(busy.duringChild).toBeGreaterThanOrEqual(50);
      stopped(running.pid);
      console.info('[RemoteDisplayResponsivenessComparison]', JSON.stringify({
        httpP95DeltaMs: Number((busy.http.p95Ms - baseline.http.p95Ms).toFixed(3)),
        httpP99DeltaMs: Number((busy.http.p99Ms - baseline.http.p99Ms).toFixed(3)),
        timerP99DeltaMs: Number((busy.timerLag.p99Ms - baseline.timerLag.p99Ms).toFixed(3)),
      }));
      const next = await fixture(Mode.Reply, running.job);
      await next.completion; stopped(next.pid);
    } finally { await endpoint.close(); }
  });

  it('enforces a real 5s deadline without blocking the parent and does not release the lane until child exit', async () => {
    const endpoint = await echoEndpoint();
    const started = performance.now();
    try {
      const running = await fixture(Mode.Hang);
      const assertion = expect(running.completion).rejects.toThrow('REMOTE_IMPORT_BUDGET');
      await expect(running.job.run('', {}, limits)).rejects.toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
      const observation = await measure('child/infinite-cpu-5s-deadline', running.completion, endpoint.echo);
      await assertion;
      expect(performance.now() - started).toBeGreaterThanOrEqual(4800);
      expect(performance.now() - started).toBeLessThan(7500);
      expect(observation.duringChild).toBeGreaterThanOrEqual(1000);
      stopped(running.pid);
      const next = await fixture(Mode.Reply, running.job);
      await next.completion; stopped(next.pid);
    } finally { await endpoint.close(); }
  });

  it.each([
    [Mode.Oversized, 'REMOTE_IMPORT_INVALID_RESULT'],
    [Mode.Exit, 'REMOTE_IMPORT_WORKER_EXIT'],
  ] as const)('contains child %s and keeps the parent responsive until process exit', async (mode, expectedError) => {
    const endpoint = await echoEndpoint();
    try {
      const running = await fixture(mode);
      const assertion = expect(running.completion).rejects.toThrow(expectedError);
      const observation = await measure(`child/${mode}`, running.completion, endpoint.echo, 300);
      await assertion;
      expect(observation.duringChild).toBeGreaterThanOrEqual(20);
      stopped(running.pid);
      const next = await fixture(Mode.Reply, running.job);
      await next.completion; stopped(next.pid);
    } finally { await endpoint.close(); }
  });

  it('returns unknown from the real read-only collector on an exclusive SQLite lock while parent HTTP and timers continue', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-display-sqlite-busy-'));
    directories.push(directory);
    const database = path.join(directory, 'core.sqlite'), compiled = path.join(directory, 'collector.cjs');
    const require = createRequire(import.meta.url);
    await build({ entryPoints: [path.join(__dirname, 'remoteDisplayHealthWorker.ts')], outfile: compiled,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      plugins: [{ name: 'native-sqlite', setup(builder) {
        builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true }));
      } }],
    });
    const db = new Database(database);
    const endpoint = await echoEndpoint();
    try {
      db.pragma('journal_mode=DELETE');
      db.exec(`CREATE TABLE remote_state(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE remote_sync(local_id TEXT PRIMARY KEY,needs_snapshot INTEGER,source_seq INTEGER,ack_seq INTEGER);
        CREATE TABLE remote_session_revisions(session_id TEXT PRIMARY KEY,dirty_at INTEGER);
        CREATE TABLE cowork_session_ownership(session_id TEXT PRIMARY KEY,ownership_status TEXT,owner_user_id TEXT,owner_scope_key TEXT);
        CREATE TABLE remote_dirty(session_id TEXT PRIMARY KEY);`);
      const digest = async (): Promise<string> => createHash('sha256').update(await fs.readFile(database)).digest('hex');
      const before = await digest();
      const input: RemoteDisplayHealthInput = { database, owner: { userId: 'test-owner', scopeKey: 'personal' },
        target: 'test-environment', targetId: null, deviceId: null, availabilityScope: null, historySupported: false,
        settingsKey: 'settings:test', controlsKey: 'controls:test', nameKey: 'name:test', catalogFailureKey: 'catalog:test' };
      const job = new RemoteHistoryJob(path.join(__dirname, 'remoteHistoryGuardWorker.cjs'));
      const start = async (label: string) => {
        const pidFile = path.join(directory, `${label}.pid`), wrapper = path.join(directory, `${label}.cjs`);
        await fs.writeFile(wrapper, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); require(${JSON.stringify(compiled)});`);
        const completion = job.run<RemoteDisplayHealthResult>(wrapper, input, limits);
        void completion.catch(() => undefined);
        active.push({ job, completion });
        return { completion, pidFile };
      };
      db.exec('BEGIN EXCLUSIVE');
      const locked = await start('busy');
      const measurement = await measure('collector/sqlite-exclusive-busy', locked.completion, endpoint.echo, 300);
      const failed = await locked.completion;
      expect(failed).toMatchObject({ status: RemoteDisplayHealthStatus.Unknown, reason: RemoteDisplayHealthFailure.Unavailable });
      expect(Object.keys(failed).sort()).toEqual(['observedAt', 'reason', 'status']);
      expect(JSON.stringify(failed)).not.toContain(database);
      expect(measurement.duringChild).toBeGreaterThanOrEqual(20);
      stopped(Number(await fs.readFile(locked.pidFile, 'utf8')));
      db.exec('ROLLBACK');
      const unlocked = await start('unlocked');
      const succeeded = await unlocked.completion;
      expect(succeeded.status).toBe(RemoteDisplayHealthStatus.Known);
      stopped(Number(await fs.readFile(unlocked.pidFile, 'utf8')));
      expect(await digest(), 'the display collector must not mutate the fixture database').toBe(before);
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close(); await endpoint.close();
    }
  });
});
