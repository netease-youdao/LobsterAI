import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteStore } from './remoteStore';

vi.mock('./remoteSyncLog', async importOriginal => ({ ...await importOriginal<typeof import('./remoteSyncLog')>(), remoteDiagnosticLog: vi.fn() }));
const databases: Database.Database[] = [];
const owner = { userId: 'owner', scopeKey: 'personal' };
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
  const create = (id: string) => store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES(?,?,1,1,'idle')").run(id, id);
    store.assignNew(id, owner, 'local_create');
  });
  return { store, db, create };
}
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('core writes independent of optional synchronization', () => {
  it('keeps owner, run and messages durable when optional schema initialization fails', () => {
    const { store, db, create } = fixture();
    db.exec('CREATE VIEW remote_projection AS SELECT 1 AS unavailable');
    expect(() => store.initializeSynchronization()).toThrow();
    create('s');
    store.beginRun('s'); store.markRunDispatched('s');
    store.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES('m','s','assistant','hello',NULL,2,1)").run());
    expect(store.owner('s')).toEqual(owner);
    expect(store.run('s')?.status).toBe('starting');
    expect(db.prepare("SELECT content FROM cowork_messages WHERE id='m'").get()).toEqual({ content: 'hello' });
    expect(store.projectionRevision('s')).toBeGreaterThan(1);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_outbox'").get()).toBeUndefined();
  });
  it('keeps a committed mutation successful when its optional wake observer throws', () => {
    const { store, db, create } = fixture();
    store.setWake(() => { throw new Error('broken remote observer'); });
    expect(() => create('s')).not.toThrow();
    expect(db.prepare("SELECT id FROM cowork_sessions WHERE id='s'").get()).toEqual({ id: 's' });
  });
  it('retains a dispatched output binding without parsing later damaged run JSON', () => {
    const { store, db, create } = fixture(); create('s');
    const run = store.beginRun('s', 'run', 'command'); store.markRunDispatched('s');
    db.prepare("UPDATE remote_state SET value='{' WHERE key='run:s'").run();
    expect(store.messageRunBinding('s')).toMatchObject({ runId: run.runId, commandId: 'command' });
    expect(() => store.beginRun('s')).toThrow();
    expect(() => store.activeDecisionRun('s')).toThrow();
  });
  it('preserves the existing global security fence and strict corrupt-run evidence during recovery', async () => {
    const { db, create } = fixture(); create('bad'); create('good');
    db.prepare('INSERT INTO remote_state VALUES(?,?)').run('run:bad', '{');
    const reopened = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true });
    await reopened.waitRunRecovery();
    expect(reopened.needsSecurityRecovery()).toBe(true);
    expect(reopened.hasCompleteExecutionHistory()).toBe(false);
    expect(() => reopened.beginRun('bad')).toThrow();
    expect(() => reopened.beginRun('good')).not.toThrow();
    expect(db.prepare("SELECT value FROM remote_state WHERE key='run:bad'").get()).toEqual({ value: '{' });
  });
  it('invalidates decision bindings as soon as the core run becomes terminal', () => {
    const { store, create } = fixture(); create('s');
    store.beginRun('s');
    expect(store.activeDecisionRun('s')).not.toBeNull();
    store.updateRun('s', 'succeeded');
    expect(store.activeDecisionRun('s')).toBeNull();
  });
  it('keeps terminal state committed when approval cleanup throws and retries from its durable marker', () => {
    const { store, db, create } = fixture(); create('s'); store.beginRun('s', 'run');
    const close = vi.fn(() => {
      expect(db.inTransaction).toBe(false);
      expect(store.activeDecisionRun('s')).toBeNull();
      throw new Error('cleanup unavailable');
    });
    store.setApprovalLifecycle({ close, expire: () => undefined });
    expect(() => store.updateRun('s', 'succeeded')).not.toThrow();
    expect(store.run('s')?.status).toBe('succeeded');
    expect(store.get('terminalCleanup:s:run')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
    store.expireApprovals();
    expect(close).toHaveBeenCalledOnce();
    expect(store.run('s')?.status).toBe('succeeded');
    close.mockImplementation(() => undefined);
    store.expireApprovals();
    expect(store.get('terminalCleanup:s:run')).toBeNull();
  });
  it('does not invoke terminal cleanup inside a containing transaction which rolls back', () => {
    const { store, create } = fixture(); create('s'); store.beginRun('s', 'run');
    const close = vi.fn(); store.setApprovalLifecycle({ close, expire: () => undefined });
    expect(() => store.transaction(() => { store.updateRun('s', 'succeeded'); throw new Error('rollback'); })).toThrow();
    expect(store.run('s')?.status).toBe('starting');
    expect(store.get('terminalCleanup:s:run')).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
  it('rebuilds more than one scheduling page without a poisoned first page starving later tasks', () => {
    const { store, db, create } = fixture();
    for (let i = 0; i < 260; i++) create(`s${String(i).padStart(3, '0')}`);
    store.initializeSynchronization();
    store.refreshProjectionHints(); store.refreshProjectionHints(); store.refreshProjectionHints();
    expect(db.prepare('SELECT COUNT(*) AS n FROM remote_dirty').get()).toEqual({ n: 260 });
  });
});

describe('bounded safety-record scans', () => {
  it('returns corrupt as distinct from absent and advances past malformed or oversized records', () => {
    const { store, db } = fixture();
    db.prepare('INSERT INTO remote_state VALUES(?,?)').run('inbox:a', '{');
    db.prepare('INSERT INTO remote_state VALUES(?,?)').run('inbox:b', 'x'.repeat(1048577));
    store.put('inbox:c', { id: 'healthy' });
    const first = store.scanEntries('inbox:', { limit: 2 });
    expect(first.rows.map(row => row.state)).toEqual(['corrupt', 'corrupt']);
    expect(first.nextCursor).toBe('inbox:b');
    expect(store.scanEntries('inbox:', { after: first.nextCursor!, limit: 2 }).rows).toEqual([{ key: 'inbox:c', state: 'valid', value: { id: 'healthy' } }]);
    expect(() => store.get('inbox:a')).toThrow();
    expect(db.prepare("SELECT value FROM remote_state WHERE key='inbox:a'").get()).toEqual({ value: '{' });
  });
  it('expires healthy approvals after a malformed approval without guessing the bad decision', () => {
    const { store, db, create } = fixture(); create('a'); create('b');
    store.beginRun('a'); store.beginRun('b');
    db.prepare('INSERT INTO remote_state VALUES(?,?)').run('approval:a:bad', '{');
    store.put('approval:b:good', { approvalId: 'good', runId: store.run('b')!.runId, status: 'pending', approvalVersion: '1', expiresAt: '2026-01-01T00:00:00Z' });
    expect(() => store.expireApprovals(Date.parse('2026-09-29T00:00:00Z'))).not.toThrow();
    expect(store.get<{ status: string }>('approval:b:good')?.status).toBe('expired');
    expect(() => store.get('approval:a:bad')).toThrow();
  });
});
