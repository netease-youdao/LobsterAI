import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteHistoryJob } from './remoteHistoryJob';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function script(body: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-history-child-')); directories.push(directory);
  const filename = path.join(directory, 'worker.cjs'); fs.writeFileSync(filename, body); return filename;
}
const options = { timeoutMs: 2000, memoryMb: 64, current: () => true, prefix: 'REMOTE_IMPORT' as const };
const stopped = (pid: number): void => { expect(() => process.kill(pid, 0)).toThrow(); };

describe('independent history encoding process', () => {
  it('stops a synchronous spool writer after its supervising parent is killed', async () => {
    const filename = script(`
      const fs = require('fs'), path = require('path');
      process.once('message', () => {
        fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
        const output = fs.openSync(path.join(__dirname, 'spool'), 'w'), bytes = Buffer.alloc(4096);
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (true) { fs.writeSync(output, bytes); Atomics.wait(pause, 0, 0, 5); }
      });
    `);
    const directory = path.dirname(filename), compiled = path.join(directory, 'history.cjs');
    buildSync({ entryPoints: [path.join(__dirname, 'remoteHistoryJob.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const parentFile = path.join(directory, 'parent.cjs');
    fs.writeFileSync(parentFile, `
      const { RemoteHistoryJob } = require(${JSON.stringify(compiled)});
      const job = new RemoteHistoryJob(${JSON.stringify(path.join(__dirname, 'remoteHistoryGuardWorker.cjs'))});
      job.run(${JSON.stringify(filename)}, {}, { timeoutMs: 30000, memoryMb: 64, current: () => true, prefix: 'REMOTE_IMPORT' }).catch(() => {});
    `);
    const parent = spawn(process.execPath, [parentFile], { stdio: 'ignore' });
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(fs.existsSync(path.join(directory, 'pid'))).toBe(true), { timeout: 5000 });
      pid = Number(fs.readFileSync(path.join(directory, 'pid'), 'utf8'));
      const exited = new Promise<void>(resolve => parent.once('exit', () => resolve()));
      parent.kill('SIGKILL'); await exited;
      await vi.waitFor(() => stopped(pid!), { timeout: 5000 });
      const size = fs.statSync(path.join(directory, 'spool')).size;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fs.statSync(path.join(directory, 'spool')).size).toBe(size);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    }
  });
  it('runs outside the caller and waits for actual process termination before completing', async () => {
    const filename = script("process.once('message', request => { setInterval(()=>{},1000); process.send({jobId:request.jobId,result:process.pid}); });");
    const job = new RemoteHistoryJob();
    const pid = await job.run<number>(filename, { value: 'one' }, options);
    expect(pid).not.toBe(process.pid); stopped(pid);
    const next = await job.run<number>(filename, { value: 'two' }, options); stopped(next);
  });
  it('rejects a response for another job and terminates the child', async () => {
    const filename = script("process.once('message', () => process.send({jobId:'wrong',result:'not accepted'}));");
    await expect(new RemoteHistoryJob().run(filename, {}, options)).rejects.toThrow('REMOTE_IMPORT_INVALID_RESULT');
  });
  it('kills a child that exceeds its time budget and can start the next independent job', async () => {
    const filename = script("process.once('message',()=>{while(true){}});");
    const job = new RemoteHistoryJob();
    await expect(job.run(filename, {}, { ...options, timeoutMs: 200 })).rejects.toThrow('REMOTE_IMPORT_BUDGET');
    const success = script("process.once('message',r=>process.send({jobId:r.jobId,result:1}));");
    await expect(job.run(success, {}, options)).resolves.toBe(1);
  });
  it('cancels actual child work after ownership changes or explicit cancellation', async () => {
    const filename = script("process.once('message',()=>{while(true){}});");
    const job = new RemoteHistoryJob();
    const cancelled = job.run(filename, {}, options); job.cancel();
    await expect(cancelled).rejects.toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
    let current = true;
    const stale = job.run(filename, {}, { ...options, current: () => current }); current = false;
    await expect(stale).rejects.toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
  });
  it('contains a failed context lookup instead of throwing from the supervisor timer', async () => {
    const filename = script("process.once('message',()=>{while(true){}});");
    let available = true;
    const pending = new RemoteHistoryJob().run(filename, {}, { ...options, current: () => { if (!available) throw new Error('SQLITE_CORRUPT'); return true; } });
    available = false;
    await expect(pending).rejects.toThrow('REMOTE_IMPORT_CONTEXT_CHANGED');
  });
});
