import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { advanceAvailabilityMigration, AvailabilityMigration } from './remoteAvailabilityMigration';
import { type AvailabilityRequest, RemoteAvailabilityStore } from './remoteAvailabilityStore';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
function fixture(): { ledger: RemoteAvailabilityStore; core: Database.Database; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'remote-control-ledger-'));
  cleanup.push(() => fs.rmSync(directory,{ recursive: true, force: true }));
  const core = new Database(path.join(directory,'cowork.sqlite')); core.pragma('journal_mode = WAL');
  cleanup.push(() => core.close());
  const ledger = new RemoteAvailabilityStore(core.name); cleanup.push(() => ledger.close());
  return { ledger,core,file: path.join(directory,'remote-control.sqlite') };
}
const pending: AvailabilityRequest = { key: 'publication1',lane: 'live',scope: 'owner:target',localId: 's',method: 'POST',pathname: '/sync/live-projections',
  version: 3,body: { publicationId: 'publication1',bytes: 'immutable' },lookup: '/sync/live-projections/publication1',lookupVersion: 3,createdAt: 1,attempted: true };
describe('control ledger locator', () => {
  it('commits the core locator before exposing the ledger and preserves unknown requests across reopen', () => {
    const { ledger,core } = fixture(); ledger.saveRequest(pending);
    expect(core.prepare('SELECT phase FROM remote_control_ledger_locator').get()).toEqual({ phase: 'ready' });
    ledger.close(); expect(ledger.request(pending.key)).toEqual(pending);
  });
  it('never recreates a missing adopted control ledger as a new empty ledger', () => {
    const { ledger,file } = fixture(); ledger.saveRequest(pending); ledger.close(); fs.rmSync(file);
    expect(() => ledger.pending(pending.scope,'live')).toThrow(); expect(fs.existsSync(file)).toBe(false);
  });
  it('rejects replacement by an empty SQLite database without creating request tables', () => {
    const { ledger,file } = fixture(); ledger.saveRequest(pending); ledger.close(); fs.rmSync(file);
    new Database(file).close(); expect(() => ledger.pending(pending.scope,'live')).toThrow('REMOTE_CONTROL_LEDGER_MISSING');
    const replacement = new Database(file);
    expect(replacement.prepare("SELECT 1 FROM sqlite_master WHERE name='availability_requests'").get()).toBeUndefined(); replacement.close();
  });
  it('does not manufacture an empty request table after adopted schema loss', () => {
    const { ledger,file } = fixture(); ledger.saveRequest(pending); ledger.close();
    const damaged = new Database(file); damaged.exec('DROP TABLE availability_requests'); damaged.close();
    expect(() => ledger.request(pending.key)).toThrow('REMOTE_CONTROL_LEDGER_SCHEMA_MISSING');
  });
  it('resumes a prepared locator with the same ledger identity', () => {
    const { ledger,core } = fixture(); ledger.saveRequest(pending); ledger.close();
    core.prepare("UPDATE remote_control_ledger_locator SET phase='prepared'").run();
    expect(ledger.request(pending.key)).toEqual(pending);
    expect(core.prepare('SELECT phase FROM remote_control_ledger_locator').get()).toEqual({ phase: 'ready' });
  });
});

describe('availability request integrity and durable backoff', () => {
  it('counts disjoint activating and live-pending tasks once without reading corrupt JSON globally', () => {
    const { ledger } = fixture();
    ledger.db.prepare('INSERT INTO availability_sessions VALUES(?,?,?)').run(pending.scope, 'a', '{');
    ledger.db.prepare('INSERT INTO availability_sessions VALUES(?,?,?)').run(pending.scope, 'b', '{"phase":"active"}');
    ledger.saveRequest({ ...pending, localId: 'b' });
    expect(ledger.health(pending.scope)).toEqual({ sessions: 2, pendingSessions: 2, degraded: true });
  });
  it('retains a corrupted operation and its independent object identity while scanning healthy requests', () => {
    const { ledger } = fixture();
    ledger.saveRequest({ ...pending, key: 'a', body: { objectId: 'bad', objectKind: 'message', publicationId: 'a' } });
    ledger.saveRequest({ ...pending, key: 'b', body: { objectId: 'good', objectKind: 'message', publicationId: 'b' } });
    ledger.db.prepare("UPDATE availability_requests SET body='{' WHERE key='a'").run();
    const first = ledger.scanPending(pending.scope, 'live', pending.localId, '', 1);
    expect(first).toMatchObject({ rows: [{ key: 'a', state: 'corrupt', objectId: 'bad', objectKind: 'message' }], nextCursor: 'a' });
    expect(ledger.scanPending(pending.scope, 'live', pending.localId, first.nextCursor!).rows[0]).toMatchObject({ key: 'b', state: 'valid' });
    expect(ledger.hasPendingObject(pending.scope, pending.localId, 'message', 'bad')).toBe(true);
    expect(ledger.hasPendingObject(pending.scope, pending.localId, 'message', 'later')).toBe(false);
    expect(() => ledger.request('a')).toThrow('REMOTE_AVAILABILITY_RECORD_INVALID');
    expect(ledger.db.prepare("SELECT body FROM availability_requests WHERE key='a'").get()).toEqual({ body: '{' });
    ledger.close();
    expect(ledger.scanPending(pending.scope, 'live', pending.localId).rows[0]).toMatchObject({ state: 'corrupt', objectId: 'bad' });
  });
  it('detects syntactically valid request changes instead of replaying a different original operation', () => {
    const { ledger } = fixture(); ledger.saveRequest(pending);
    ledger.db.prepare('UPDATE availability_requests SET body=? WHERE key=?').run(JSON.stringify({ ...pending, body: { altered: true } }), pending.key);
    expect(() => ledger.request(pending.key)).toThrow('REMOTE_AVAILABILITY_RECORD_INVALID');
  });
  it('does not infer an object for undecodable legacy evidence', () => {
    const { ledger } = fixture(); ledger.saveRequest(pending);
    ledger.db.prepare("UPDATE availability_requests SET body='{',request_hash=NULL,object_id=NULL,object_kind=NULL").run();
    ledger.close();
    expect(ledger.hasPendingObject(pending.scope, pending.localId, 'message', 'new-message')).toBe(true);
    expect(ledger.hasPendingObject(pending.scope, 'unrelated-task', 'message', 'new-message')).toBe(false);
  });
  it('keeps repeated encoding failures deferred across reopen but allows a changed source revision', () => {
    const { ledger } = fixture();
    ledger.objectFault(pending.scope, pending.localId, 'message:bad', 'revision-1', 1000);
    ledger.close();
    expect(ledger.objectRetryAllowed(pending.scope, pending.localId, 'message:bad', 2000, 'revision-1')).toBe(false);
    expect(ledger.objectRetryAllowed(pending.scope, pending.localId, 'message:bad', 2000, 'revision-2')).toBe(true);
    ledger.objectFault(pending.scope, pending.localId, 'message:bad', 'revision-1', 301000);
    expect(ledger.objectRetryAllowed(pending.scope, pending.localId, 'message:bad', 900000, 'revision-1')).toBe(false);
  });
});


describe('availability activity and terminal evidence budgets', () => {
  it('archives resolved bytes outside active capacity while preserving raw evidence across reopen', () => {
    const { ledger } = fixture();
    const body = { sessionId: 'session', writerGeneration: 'generation' };
    for (let index = 0; index < 140; index++) {
      const key = `publication${index}`;
      ledger.saveRequest({ ...pending, key, body: { bytes: 'x'.repeat(250 * 1024) } });
      const resolution = ledger.sealResolution(pending.scope, pending.localId, key, body);
      ledger.completeResolution(pending.scope, pending.localId, key, resolution,
        { ...body, publicationId: key, state: 'sealed_unpublished', sealId: 'seal' });
    }
    ledger.close();
    expect(ledger.scanPending(pending.scope, 'live', pending.localId).rows).toEqual([]);
    expect(ledger.request('publication0')?.body.bytes.length).toBe(250 * 1024);
    ledger.saveRequest({ ...pending, key: 'healthy-task', localId: 'other' });
    const usage = ledger.db.prepare('SELECT SUM(active_bytes) AS active,SUM(archive_bytes) AS archived FROM availability_usage').get() as { active: number; archived: number };
    expect(usage.active).toBeLessThan(1024); expect(usage.archived).toBeGreaterThan(32 * 1024 * 1024);
  });
  it('accounts attempted metadata changes and keeps a full request available to another task', () => {
    const { ledger } = fixture(); let count = 0;
    expect(() => { for (; count < 150; count++) ledger.saveRequest({ ...pending, key: `p${count}`, body: { bytes: 'x'.repeat(250 * 1024) } }); })
      .toThrow('REMOTE_AVAILABILITY_QUEUE_BUDGET');
    ledger.saveRequest({ ...pending, key: 'another', localId: 'other', attempted: false });
    const original = ledger.request('another')!; ledger.attempted(original);
    const saved = ledger.db.prepare("SELECT bytes,length(CAST(body AS BLOB)) AS actual FROM availability_requests WHERE key='another'").get() as { bytes: number; actual: number };
    expect(saved.bytes).toBe(saved.actual);
    const accounting = ledger.db.prepare('SELECT SUM(active_bytes) AS bytes FROM availability_usage').get();
    expect(accounting).toEqual(ledger.db.prepare('SELECT SUM(length(CAST(body AS BLOB))) AS bytes FROM availability_requests').get());
  });
});


it('pauses only new remote requests when disk headroom is exhausted', () => {
  const { ledger, core } = fixture(); ledger.saveRequest(pending);
  const statfs = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 1, bsize: 1 } as ReturnType<typeof fs.statfsSync>);
  try {
    expect(ledger.saveRequest(pending)).toEqual(pending);
    expect(() => ledger.saveRequest({ ...pending, key: 'new-publication' })).toThrow('REMOTE_SIDECAR_STORAGE_BUDGET');
    expect(ledger.request('new-publication')).toBeNull();
    expect(ledger.request(pending.key)).toEqual(pending);
    expect(() => core.exec("CREATE TABLE desktop_messages(body TEXT); INSERT INTO desktop_messages VALUES('local save')")).not.toThrow();
  } finally { statfs.mockRestore(); }
  expect(() => ledger.saveRequest({ ...pending, key: 'new-publication' })).not.toThrow();
});

 describe('bounded ledger migration', () => {
  it('resumes hash and usage pages across restart while the single core connection remains writable', async () => {
    const { ledger, core, file } = fixture();
    for (let i = 0; i < 70; i++) ledger.saveRequest({ ...pending, key: `old-${i}`, body: { objectId: `m-${i}`, objectKind: 'message' } });
    ledger.close();
    const old = new Database(file);
    old.exec(`DROP TRIGGER availability_usage_insert; DROP TRIGGER availability_usage_update; DROP TRIGGER availability_usage_delete;
      DROP TABLE availability_usage; DROP TABLE availability_migration; UPDATE availability_requests SET request_hash=NULL`);
    old.close();
    const current = new RemoteAvailabilityStore(core); cleanup.push(() => current.close());
    expect(() => current.pending(pending.scope, 'live')).toThrow(AvailabilityMigration.Pending);
    const inspect = new Database(file);
    expect(inspect.prepare('SELECT count(*) AS n FROM availability_requests WHERE request_hash IS NOT NULL').get()).toEqual({ n: 32 });
    expect(() => current.pending(pending.scope, 'live')).toThrow(AvailabilityMigration.Pending);
    expect(inspect.prepare('SELECT count(*) AS n FROM availability_requests WHERE request_hash IS NOT NULL').get()).toEqual({ n: 32 });
    inspect.close(); current.close();
    core.exec('CREATE TABLE local_progress(id INTEGER PRIMARY KEY)');
    core.prepare('INSERT INTO local_progress VALUES(1)').run();
    let ready = false;
    for (let turn = 0; turn < 10 && !ready; turn++) {
      try { ready = current.pending(pending.scope, 'live').length > 0; }
      catch (error) { expect((error as Error).message).toBe(AvailabilityMigration.Pending); }
      if (!ready) await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(ready).toBe(true);
    expect(current.request('old-69')?.body.objectId).toBe('m-69');
    expect(current.db.prepare('SELECT SUM(reserved_bytes) AS bytes FROM availability_usage').get()).toEqual({ bytes: 70 * 64 * 1024 });
    current.close(); expect(core.open).toBe(true);
  });
  it('rejects first locator adoption inside a local transaction instead of opening a second writable core connection', () => {
    const { core } = fixture(); const ledger = new RemoteAvailabilityStore(core); cleanup.push(() => ledger.close());
    expect(() => core.transaction(() => ledger.db)()).toThrow('REMOTE_CONTROL_LEDGER_CORE_TRANSACTION');
    expect(core.open).toBe(true);
    expect(ledger.db.open).toBe(true);
  });
 });

it('advances past deeply nested legacy JSON without manufacturing a hash or suppressing SQL failure', () => {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE availability_requests(key TEXT PRIMARY KEY,lane TEXT,scope TEXT,local_id TEXT,body TEXT,
    request_hash TEXT,object_id TEXT,object_kind TEXT,resolution_body TEXT,resolution_receipt TEXT)`);
  const deep = '{"body":{},"nested":' + '['.repeat(20_000) + '0' + ']'.repeat(20_000) + '}';
  const insert = db.prepare("INSERT INTO availability_requests(key,lane,scope,local_id,body) VALUES(?,'live','owner','session',?)");
  insert.run('bad', deep);
  for (let i = 0; i < 70; i++) insert.run(`good-${i}`, JSON.stringify({ body: { objectId: `m-${i}`, objectKind: 'message' } }));
  let ready = false;
  for (let turn = 0; turn < 12 && !ready; turn++) ready = advanceAvailabilityMigration(db);
  expect(ready).toBe(true);
  expect(db.prepare("SELECT request_hash,body FROM availability_requests WHERE key='bad'").get()).toEqual({ request_hash: null, body: deep });
  expect(db.prepare('SELECT count(*) AS count FROM availability_requests WHERE request_hash IS NOT NULL').get()).toEqual({ count: 70 });
  db.exec('DROP TABLE availability_usage');
  expect(() => advanceAvailabilityMigration(db)).toThrow('REMOTE_AVAILABILITY_USAGE_MISSING');
});
