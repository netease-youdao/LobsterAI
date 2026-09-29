import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

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
