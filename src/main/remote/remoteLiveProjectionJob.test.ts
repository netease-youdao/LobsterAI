import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteLiveProjectionJob } from './remoteLiveProjectionJob';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
function fixture(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'remote-live-job-')); cleanup.push(() => fs.rmSync(directory,{ recursive: true,force: true }));
  const filename = path.join(directory,'worker.cjs'); fs.writeFileSync(filename,body);
  const db = new Database(path.join(directory,'core.sqlite')); cleanup.push(() => db.close());
  const input = { database: db.name,localId: 's',sessionId: 'remote',deviceId: 'pc',owner: { userId: '1',scopeKey: 'personal' },objectId: 'm',revision: '1' };
  return { filename,db,input };
}
describe('live encoder process lifecycle', () => {
  it('holds the busy slot after cancellation until actual exit, then permits the next job', async () => {
    const f = fixture("process.once('message',r=>{setInterval(()=>{},1000);process.send({jobId:r.jobId,result:{pid:process.pid}})});");
    const job = new RemoteLiveProjectionJob(f.filename);
    const first = job.project(f.db,f.input); job.cancel();
    await expect(job.project(f.db,f.input)).rejects.toThrow('REMOTE_LIVE_ENCODER_BUSY');
    await expect(first).rejects.toThrow('REMOTE_LIVE_ENCODER_CONTEXT_CHANGED');
    const result = await job.project(f.db,f.input) as unknown as { pid: number };
    expect(() => process.kill(result.pid,0)).toThrow();
  });
  it('kills a hung child on budget and retains only one child slot', async () => {
    const f = fixture("process.once('message',()=>{while(true){}});");
    const job = new RemoteLiveProjectionJob(f.filename,100);
    await expect(job.project(f.db,f.input)).rejects.toThrow('REMOTE_LIVE_ENCODER_BUDGET');
    fs.writeFileSync(f.filename,"process.once('message',r=>process.send({jobId:r.jobId,result:null}));");
    await expect(job.project(f.db,f.input)).resolves.toBeNull();
  });
  it('rejects an oversized child payload and permits the next bounded result', async () => {
    const f = fixture("process.once('message',r=>process.send({jobId:r.jobId,result:'x'.repeat(200000)}));");
    const job = new RemoteLiveProjectionJob(f.filename);
    await expect(job.project(f.db,f.input)).rejects.toThrow('REMOTE_LIVE_ENCODER_INVALID_RESULT');
    fs.writeFileSync(f.filename,"process.once('message',r=>process.send({jobId:r.jobId,result:null}));");
    await expect(job.project(f.db,f.input)).resolves.toBeNull();
  });
});
