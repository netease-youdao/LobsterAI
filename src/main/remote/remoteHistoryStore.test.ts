import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteAvailabilityStore } from './remoteAvailabilityStore';
import { type HistoryContext, HistoryPreparation, RemoteHistoryStore } from './remoteHistoryStore';
import { RemoteStore } from './remoteStore';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); });
function fixture(): { store: RemoteStore; context: HistoryContext; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'remote-history-store-'));
  cleanup.push(() => fs.rmSync(directory,{ recursive: true, force: true }));
  const db = new Database(path.join(directory,'cowork.sqlite'));
  cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db,{ restoreRuns: false });
  cleanup.push(() => store.history.close());
  const owner = { userId: '10001', scopeKey: 'personal' };
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES('s','task',1,1,'idle')").run(); store.assignNew('s',owner,'local_create'); });
  const sessionId = store.controlBinding('s')!.session_id;
  store.bindRemote('s',sessionId,'desktop'); store.setIndependentControlReady(() => true);
  return { store, directory, context: { scope: 'account:test:target1',localId: 's',sessionId,writerGeneration: 'writer1',owner,deviceId: 'desktop' } };
}
function reopen(store: RemoteStore): RemoteHistoryStore {
  store.history.close();
  const history = new RemoteHistoryStore(store); cleanup.push(() => history.close()); return history;
}
describe('v3 history isolation and migration', () => {
  it('compacts only terminal payloads while retaining immutable replay proof across restart', () => {
    const { store,context } = fixture(); store.history.prepare(context);
    const request = { checkpointState: { operationId: 'checkpoint' }, snapshot: { records: ['x'.repeat(100_000)] },
      begin: { recoveryId: 'recovery', frozenThroughSourceSeq: '7', expectedResolvedSourceSeq: '1', sourceManifest: { ranges: ['evidence'] } } };
    const original = store.history.sealOperation({ id: 'recovery', context, kind: 'recovery', request });
    expect(store.history.compactCompletedOperation(context,'recovery')).toBe(false);
    const receipt = { state: 'committed', recoveryId: 'recovery', gaps: [{ first: '2', last: '7' }], exactSourcePrefix: '1' };
    store.history.completeOperation(context,'recovery',receipt,{ historyGeneration: '1', resolvedSourceSeq: '7' });
    expect(store.history.compactCompletedOperation(context,'recovery')).toBe(true);
    const history = reopen(store); history.prepare(context);
    const compacted = history.operation(context,'recovery')!;
    expect(compacted.requestHash).toBe(original.requestHash); expect(compacted.receipt).toEqual(receipt);
    expect(compacted.request).toMatchObject({ checkpointId: 'checkpoint', begin: { frozenThroughSourceSeq: '7', expectedResolvedSourceSeq: '1' } });
    expect(compacted.request).not.toHaveProperty('snapshot');
    expect(history.sealOperation({ id: 'recovery', context, kind: 'recovery', request }).state).toBe('complete');
    expect(() => history.sealOperation({ id: 'recovery', context, kind: 'recovery', request: { changed: true } })).toThrow('IMMUTABLE');
    expect(history.pending(context)).toEqual([]); expect(store.sync('s')!.ack_seq).toBe(0);
  });
  it('classifies a malformed task manifest without opening a shared storage cooldown', () => {
    const { store, context } = fixture(); store.history.prepare(context);
    store.db.prepare("UPDATE remote_history_migrations SET manifest_json='{' WHERE local_id='s'").run();
    expect(store.history.prepareResult(context)).toMatchObject({ kind: HistoryPreparation.TaskBlocked });
    expect(store.history.status()).toMatchObject({ available: true, retryAt: 0 });
  });
  it('does not extend shared storage cooldown when deferred preparation is visited again', () => {
    const { store, context, directory } = fixture();
    fs.writeFileSync(path.join(directory, 'remote-sync.sqlite'), 'broken');
    const first = store.history.prepareResult(context);
    expect(first.kind).toBe(HistoryPreparation.StorageDeferred);
    expect(store.history.prepareResult(context)).toEqual(first);
  });
  it('copies and verifies bounded metadata while preserving unknown legacy bytes and exact ACK', () => {
    const { store,context } = fixture();
    store.db.prepare('UPDATE remote_sync SET source_seq=2,ack_seq=1 WHERE local_id=?').run('s');
    const original = '{ malformed legacy bytes retained';
    store.db.prepare('INSERT INTO remote_outbox VALUES(?,?,?)').run('s',2,original);
    const session = store.history.prepare(context)!;
    expect(session.resolvedSourceSeq).toBe('0'); expect(session.historyGeneration).toBe('0');
    expect(store.db.prepare('SELECT phase FROM remote_history_migrations').get()).toEqual({ phase: 'ready' });
    expect(store.history.legacySourcePage(context,'1','2')).toEqual([{ sourceSeq: '2',eventJson: original }]);
    expect(store.history.legacyMetadata(context)).toEqual({ sourceSeq: '2',exactAckSeq: '1' });
    const operation = store.history.sealOperation({ id: 'recovery1',context,kind: 'recovery',request: { throughSourceSeq: '2' } });
    expect(store.history.pending(context)).toEqual([operation]);
    store.history.completeOperation(context,'recovery1',{ state: 'committed',recoveryId: 'recovery1' },{ historyGeneration: '1',resolvedSourceSeq: '2' });
    expect(store.history.session(context)?.resolvedSourceSeq).toBe('2'); expect(store.history.pending(context)).toEqual([]);
    expect(store.sync('s')?.ack_seq).toBe(1); expect(store.sync('s')?.source_seq).toBe(2);
    expect(store.db.prepare('SELECT event_json FROM remote_outbox').get()).toEqual({ event_json: original });
  });
  it('keeps the archived legacy writer fenced even if runtime eligibility later permits it', () => {
    const { store,context } = fixture();
    store.db.prepare('UPDATE remote_sync SET source_seq=2,ack_seq=1 WHERE local_id=?').run('s');
    store.db.prepare('INSERT INTO remote_outbox VALUES(?,?,?)').run('s',2,'original');
    store.history.prepare(context); store.history.close();
    store.setIndependentControlReady(() => false); store.setTaskProjectionEligibility(() => true); store.setEnabledOwner(context.owner);
    expect(store.hasIndependentHistoryFence('s')).toBe(true); expect(store.pending('s')).toEqual([]);
    expect(() => store.snapshot('s')).toThrow('REMOTE_LEGACY_WRITER_FENCED');
    expect(() => store.acknowledge('s','desktop',context.sessionId,'2','3')).toThrow('REMOTE_LEGACY_WRITER_FENCED');
    store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES('after','s','user','still works',NULL,2,1)").run());
    expect(store.sync('s')?.source_seq).toBe(2); expect(store.sync('s')?.ack_seq).toBe(1);
    expect(store.db.prepare('SELECT event_json FROM remote_outbox').get()).toEqual({ event_json: 'original' });
  });
  it('a lost control ledger fails remote eligibility closed without aborting a local core commit', () => {
    const { store,directory } = fixture();
    const ledger = new RemoteAvailabilityStore(store.db.name); expect(ledger.db.open).toBe(true); ledger.close();
    fs.rmSync(path.join(directory,'remote-control.sqlite'));
    store.setTaskProjectionEligibility(() => ledger.session('scope','s') === null);
    expect(() => store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES('continued','s','user','local remains usable',NULL,2,1)").run())).not.toThrow();
    expect(store.db.prepare("SELECT content FROM cowork_messages WHERE id='continued'").get()).toEqual({ content: 'local remains usable' });
    expect(fs.existsSync(path.join(directory,'remote-control.sqlite'))).toBe(false);
  });
  it('does not open a corrupt history file during core startup or local commits', () => {
    const { store,context,directory } = fixture();
    fs.writeFileSync(path.join(directory,'remote-sync.sqlite'),'not a sqlite database');
    expect(store.history.prepare(context)).toBeNull(); expect(store.history.status().available).toBe(false);
    expect(() => store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES('new','s','user','continue',NULL,2,1)").run())).not.toThrow();
    expect(store.controlBinding('s')?.session_id).toBe(context.sessionId);
    expect(store.isIndependentControlReady('s')).toBe(true);
    expect(store.db.prepare("SELECT revision FROM remote_live_revisions WHERE object_id='new'").get()).toEqual({ revision: 1 });
    expect(fs.readFileSync(path.join(directory,'remote-sync.sqlite'),'utf8')).toBe('not a sqlite database');
  });
  it('resumes a crash after verified copy without changing the original migration or pending operation', () => {
    const { store,context } = fixture();
    const initial = store.history.prepare(context)!;
    store.history.sealOperation({ id: 'unknown',context,kind: 'batch',request: { immutable: true } });
    store.db.prepare("UPDATE remote_history_migrations SET phase='copied'").run();
    const history = reopen(store);
    expect(history.prepare(context)).toEqual(initial);
    expect(history.pending(context).map(operation => operation.id)).toEqual(['unknown']);
    expect(store.db.prepare('SELECT phase FROM remote_history_migrations').get()).toEqual({ phase: 'ready' });
  });
  it('refuses to recreate an adopted missing sidecar containing unknown operations', () => {
    const { store,context } = fixture();
    expect(store.history.prepare(context)).not.toBeNull();
    store.history.sealOperation({ id: 'unknown',context,kind: 'batch',request: { bytes: 'preserve' } });
    store.history.close(); fs.rmSync(store.history.filename);
    const history = reopen(store);
    expect(history.prepare(context)).toBeNull(); expect(fs.existsSync(history.filename)).toBe(false);
    expect(store.isIndependentControlReady('s')).toBe(true);
  });
  it('does not overwrite a mismatched migration copy', () => {
    const { store,context } = fixture(); store.history.prepare(context); store.history.close();
    const sidecar = new Database(store.history.filename);
    sidecar.prepare("UPDATE history_migration_copies SET manifest_json='{}'").run(); sidecar.close();
    const history = reopen(store);
    expect(history.prepare(context)).toBeNull(); expect(history.status().reason).toBe('REMOTE_HISTORY_MIGRATION_COPY_INVALID');
  });
  it('protects immutable unknown operation requests and prohibits cross-database transactions', () => {
    const { store,context } = fixture(); store.history.prepare(context);
    const operation = { id: 'unknown',context,kind: 'batch' as const,request: { bytes: 'original' } };
    store.history.sealOperation(operation);
    expect(() => store.history.sealOperation({ ...operation,request: { bytes: 'changed' } })).toThrow('REMOTE_HISTORY_OPERATION_IMMUTABLE');
    const history = reopen(store); history.prepare(context);
    expect(history.operation(context,'unknown')?.request).toEqual({ bytes: 'original' });
    expect(() => store.db.transaction(() => history.pending(context))()).toThrow('REMOTE_HISTORY_CROSS_DATABASE_TRANSACTION');
  });
  it('bounds history migration lock waits without changing the core connection timeout', () => {
    const { store,context } = fixture(); store.db.pragma('busy_timeout = 5000');
    const blocker = new Database(store.db.name); blocker.exec('BEGIN IMMEDIATE');
    try {
      const began = Date.now(); expect(store.history.prepare(context)).toBeNull();
      expect(Date.now() - began).toBeLessThan(1000);
      expect(store.db.pragma('busy_timeout',{ simple: true })).toBe(5000);
    } finally { blocker.exec('ROLLBACK'); blocker.close(); }
    expect(store.controlBinding('s')?.session_id).toBe(context.sessionId);
  });
  it('requires a ready control fence and preserves core rollback independently', () => {
    const { store,context } = fixture(); store.setIndependentControlReady(() => false);
    expect(store.history.prepare(context)).toBeNull(); expect(fs.existsSync(store.history.filename)).toBe(false);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM remote_history_migrations').get()).toEqual({ count: 0 });
    expect(() => store.transaction(() => { store.db.prepare("UPDATE cowork_sessions SET title='temporary' WHERE id='s'").run(); throw new Error('rollback'); })).toThrow('rollback');
    expect(store.db.prepare("SELECT title FROM cowork_sessions WHERE id='s'").get()).toEqual({ title: 'task' });
  });
});
