import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

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
