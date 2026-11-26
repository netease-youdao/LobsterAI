import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { once } from 'events';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Worker } from 'worker_threads';

import { payloadHash } from './canonical';
import type { RemoteIdentity } from './installationIdentity';
import type { RemoteSecurityCommit, RemoteSecurityEvidence, RemoteSecurityJournal, RemoteSecurityJournalWorkerIo } from './remoteSecurityJournal';

const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-security-worker-code-'));
const require = createRequire(import.meta.url);
let runtime: typeof import('./remoteSecurityJournal');
beforeAll(async () => {
  await build({ entryPoints: [path.join(__dirname, 'remoteSecurityJournal.ts')], outfile: path.join(compiled, 'journal.cjs'), bundle: true, platform: 'node', format: 'cjs' });
  await build({ entryPoints: [path.join(__dirname, 'remoteSecurityJournalWorker.ts')], outfile: path.join(compiled, 'remoteSecurityJournalWorker.js'), bundle: true, platform: 'node', format: 'cjs' });
  runtime = require(path.join(compiled, 'journal.cjs'));
});
afterAll(() => fs.rmSync(compiled, { recursive: true, force: true }));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const identity: RemoteIdentity = { installationId: 'test-installation', databaseId: 'test-database', deviceKey: Buffer.alloc(32, 7).toString('base64url') };
const operation = { operationId: 'remote-command:execute', operationDigest: payloadHash({ requestHash: 'immutable-request', phase: 'executing' }) };

function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-security-worker-disk-'));
  cleanup.push(() => fs.rmSync(folder, { recursive: true, force: true }));
  const database = path.join(folder, 'core.sqlite'), external = path.join(folder, 'external');
  let db = new Database(database);
  cleanup.push(() => { if (db.open) db.close(); });
  db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
  db.exec('CREATE TABLE security_head(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)');
  const evidence = (): RemoteSecurityEvidence => {
    const row = db.prepare('SELECT record FROM security_head WHERE id=1').get() as { record: string } | undefined;
    return { head: row ? JSON.parse(row.record) as RemoteSecurityCommit : null, restored: false, hasConflict: false, legacyCheckpointVerified: true };
  };
  const commitCore = (record: RemoteSecurityCommit): void => { db.transaction(() => {
    db.prepare('INSERT INTO security_head VALUES (1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(JSON.stringify(record));
  })(); };
  const reopenCore = (): void => { db.close(); db = new Database(database); db.pragma('synchronous=FULL'); };
  const open = () => {
    const io: RemoteSecurityJournalWorkerIo = new runtime.RemoteSecurityJournalWorkerIo(external, 5000);
    const journal: RemoteSecurityJournal = new runtime.RemoteSecurityJournal(identity, io, true);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return; closed = true;
      // Wait for the actual worker to exit before removing its isolated temporary directory.
      const worker = (io as unknown as { worker: Worker }).worker;
      const ended = worker.threadId === -1 ? Promise.resolve() : once(worker, 'exit');
      journal.close(); await ended;
    };
    cleanup.push(close);
    return { journal, close };
  };
  return { external, evidence, commitCore, reopenCore, open };
}

describe('security journal real filesystem worker', () => {
  it('fsyncs prepare/finalize and accepts the matching SQLite head after process restart', async () => {
    const f = fixture(), first = f.open();
    expect((await first.journal.initialize(f.evidence())).status).toBe(runtime.RemoteSecurityRecovery.Ready);
    const record = await first.journal.prepare(operation); f.commitCore(record);
    await first.journal.finalize(record, f.evidence); await first.close(); f.reopenCore();
    const current = JSON.parse(fs.readFileSync(path.join(f.external, 'security-journal.json'), 'utf8'));
    expect(current.anchor.pending).toBeNull(); expect(current.anchor.committed.recordDigest).toBe(record.recordDigest);
    expect(fs.existsSync(path.join(f.external, 'security-journal.previous.json'))).toBe(true);
    expect(fs.readdirSync(f.external).some(file => file.endsWith('.tmp'))).toBe(false);
    const second = f.open(); expect((await second.journal.initialize(f.evidence())).status).toBe(runtime.RemoteSecurityRecovery.Ready);
    const next = await second.journal.prepare({ ...operation, operationId: 'second-command:execute' });
    expect(next.sequence).toBe(2); expect(next.previousDigest).toBe(record.recordDigest);
  });
  it('requires cancellation evidence after external prepare without a core commit, never another prepare', async () => {
    const f = fixture(), first = f.open(); await first.journal.initialize(f.evidence());
    const pending = await first.journal.prepare(operation); await first.close(); f.reopenCore();
    const bytes = fs.readFileSync(path.join(f.external, 'security-journal.json'), 'utf8');
    const second = f.open();
    expect(await second.journal.initialize(f.evidence())).toEqual({ status: runtime.RemoteSecurityRecovery.CancellationRequired, pending });
    await expect(second.journal.prepare(operation)).rejects.toThrow();
    expect(fs.readFileSync(path.join(f.external, 'security-journal.json'), 'utf8')).toBe(bytes);
  });
  it('finishes a matching committed core after a crash between SQLite commit and external finalize', async () => {
    const f = fixture(), first = f.open(); await first.journal.initialize(f.evidence());
    const pending = await first.journal.prepare(operation); f.commitCore(pending); await first.close(); f.reopenCore();
    const second = f.open();
    expect((await second.journal.initialize(f.evidence())).status).toBe(runtime.RemoteSecurityRecovery.Finalized);
    await second.close();
    const third = f.open(); expect((await third.journal.initialize(f.evidence())).status).toBe(runtime.RemoteSecurityRecovery.Ready);
    expect(f.evidence().head).toEqual(pending);
  });
  it.each(['corrupt', 'missing'])('rejects %s current even with a valid previous slot', async state => {
    const f = fixture(), first = f.open(); await first.journal.initialize(f.evidence());
    const pending = await first.journal.prepare(operation); f.commitCore(pending);
    await first.journal.finalize(pending, f.evidence); await first.close();
    const current = path.join(f.external, 'security-journal.json'), previous = path.join(f.external, 'security-journal.previous.json');
    const prior = fs.readFileSync(previous, 'utf8');
    if (state === 'corrupt') fs.writeFileSync(current, '{corrupted-current'); else fs.unlinkSync(current);
    await expect(f.open().journal.initialize(f.evidence())).rejects.toThrow();
    expect(fs.readFileSync(previous, 'utf8')).toBe(prior);
    if (state === 'corrupt') expect(fs.readFileSync(current, 'utf8')).toBe('{corrupted-current'); else expect(fs.existsSync(current)).toBe(false);
  });
  it('rejects an older SQLite head after the external commit completed', async () => {
    const f = fixture(), first = f.open(); await first.journal.initialize(f.evidence());
    const pending = await first.journal.prepare(operation); f.commitCore(pending);
    await first.journal.finalize(pending, f.evidence); await first.close();
    const before = fs.readFileSync(path.join(f.external, 'security-journal.json'), 'utf8');
    const restored = { ...f.evidence(), head: null };
    await expect(f.open().journal.initialize(restored)).rejects.toThrow('differs');
    expect(fs.readFileSync(path.join(f.external, 'security-journal.json'), 'utf8')).toBe(before);
  });
});
