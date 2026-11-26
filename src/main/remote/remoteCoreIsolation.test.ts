import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteHistoryStore } from './remoteHistoryStore';
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


describe('desktop fault-containment dispatch boundaries', () => {
  it('preserves a damaged file ordinal while committing a text run', () => {
    const { store, db, create } = fixture(); create('s');
    db.prepare('INSERT INTO remote_state VALUES (?,?)').run('fileRunOrdinal:s', '{');
    expect(() => store.beginRun('s', 'run')).not.toThrow();
    expect(store.run('s')?.runId).toBe('run');
    expect(db.prepare("SELECT value FROM remote_state WHERE key='fileRunOrdinal:s'").get()).toEqual({ value: '{' });
    expect(store.get('fileRunOrdinal:s:run')).toBeNull();
  });
  it('rejects a late send after settlement wins, including after a new run starts', () => {
    const { store, create } = fixture(); create('s'); store.beginRun('s', 'old'); store.prepareLocalDispatch('s');
    expect(store.settleUndispatchedRun('s', 'old')).toBe(true);
    expect(() => store.markExecutionDispatch('s', 'old')).toThrow('REMOTE_RUN_CHANGED');
    store.beginRun('s', 'new'); store.prepareLocalDispatch('s');
    expect(() => store.markExecutionDispatch('s', 'old')).toThrow('REMOTE_RUN_CHANGED');
    expect(store.run('s')?.status).toBe('starting');
  });
  it('retains the occupied run when dispatch wins before settlement', () => {
    const { store, create } = fixture(); create('s'); store.beginRun('s', 'run'); store.prepareLocalDispatch('s');
    store.markExecutionDispatch('s', 'run');
    expect(store.settleUndispatchedRun('s', 'run')).toBe(false);
    expect(store.run('s')?.status).toBe('starting');
    expect(() => store.beginRun('s')).toThrow('REMOTE_SESSION_BUSY');
  });
  it('does not infer never-dispatched from a mobile or unclassified run', () => {
    const { store, create } = fixture(); create('mobile'); create('unknown');
    store.beginRun('mobile', 'm', 'command'); store.prepareLocalDispatch('mobile');
    store.beginRun('unknown', 'u');
    expect(store.settleUndispatchedRun('mobile', 'm')).toBe(false);
    expect(store.settleUndispatchedRun('unknown', 'u')).toBe(false);
  });
  it('ignores a revoked old decision body only with an immutable binding and trusted terminal run', () => {
    const { store, db, create } = fixture(); create('s'); store.beginRun('s', 'old');
    store.put('approval:s:a', { approvalId: 'a', runId: 'old', status: 'pending', approvalVersion: '1' });
    store.updateRun('s', 'succeeded'); store.beginRun('s', 'new');
    db.prepare("UPDATE remote_state SET value='{' WHERE key='approval:s:a'").run();
    expect(() => store.refreshApprovalRunState('s', true)).not.toThrow();
    expect(store.run('s')?.status).toBe('running');
    expect(() => store.put('approval:s:a', { approvalId: 'a', runId: 'new', status: 'pending' })).toThrow('REMOTE_DECISION_BINDING_CHANGED');
    expect(db.prepare("SELECT value FROM remote_state WHERE key='approval:s:a'").get()).toEqual({ value: '{' });
  });
  it('keeps pre-upgrade unbound corrupt decisions and current corrupt decisions blocking', () => {
    const { store, db, create } = fixture(); create('s'); store.beginRun('s', 'run');
    db.prepare('INSERT INTO remote_state VALUES (?,?)').run('approval:s:legacy', '{');
    expect(() => store.refreshApprovalRunState('s', true)).toThrow();
    db.prepare("DELETE FROM remote_state WHERE key='approval:s:legacy'").run();
    store.put('approval:s:current', { approvalId: 'current', runId: 'run', status: 'pending' });
    db.prepare("UPDATE remote_state SET value='{' WHERE key='approval:s:current'").run();
    expect(() => store.refreshApprovalRunState('s', true)).toThrow();
  });
});


it('keeps optional projection worker DDL out of deferred core startup', () => {
  const { db } = fixture();
  db.exec('CREATE VIEW remote_projection_worker_budget AS SELECT 1 AS unavailable');
  const store = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true });
  expect(() => store.initializeSynchronization()).toThrow();
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES('desktop','Desktop',1,1,'idle')").run(); });
  expect(() => store.beginRun('desktop')).not.toThrow();
});


it('selected control questions keep private facts authoritative and enforce materialization budgets', () => {
  const { store, create } = fixture(); create('s'); store.beginRun('s', 'run');
  store.put('question:s:q', { questionId: 'q', runId: 'run', questionVersion: '1', status: 'pending' });
  store.put('questionDecision:request', { binding: { owner }, state: { sessionId: 's', requestId: 'request', questionId: 'q', runId: 'run', questionVersion: '2', status: 'resolved' } });
  expect(store.questionStates('s', undefined, ['q'])).toMatchObject([{ questionId: 'q', questionVersion: '2', status: 'resolved' }]);
  store.put('question:s:large', { questionId: 'large', runId: 'run', text: 'x'.repeat(32768) });
  expect(() => store.questionStates('s', undefined, ['large'])).toThrow('REMOTE_CONTROL_DECISION_BUDGET');
  for (let n = 0; n < 65; n++) store.put(`questionDecision:extra-${n}`, { binding: { owner }, state: { sessionId: 's', questionId: 'q', runId: 'run', questionVersion: '2' } });
  expect(() => store.questionStates('s', undefined, ['q'])).toThrow('REMOTE_CONTROL_DECISION_BUDGET');
});


it('upgrades old tool triggers before desktop writes even when the derived membership schema is damaged', () => {
  const { store, db, create } = fixture(); create('s'); store.beginRun('s', 'run');
  db.exec(`CREATE TABLE remote_live_tool_sources(incompatible TEXT);
    DROP TRIGGER remote_live_tool_insert;
    CREATE TRIGGER remote_live_tool_insert AFTER INSERT ON cowork_messages WHEN NEW.type='tool_use' BEGIN
      INSERT INTO remote_live_tool_sources(session_id,message_id,tool_id) VALUES(NEW.session_id,NEW.id,NEW.id); END;`);
  const reopened = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
  expect(() => reopened.initializeSynchronization()).toThrow();
  expect(() => reopened.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES('tool','s','tool_use','hello','{}',2,1)").run())).not.toThrow();
  expect(db.prepare("SELECT content FROM cowork_messages WHERE id='tool'").get()).toEqual({ content: 'hello' });
  expect(db.prepare("SELECT revision FROM remote_live_tools WHERE session_id='s' AND tool_id='tool'").get()).toEqual({ revision: 1 });
  expect(reopened.run('s')?.runId).toBe('run');
  expect(reopened.owner('s')).toEqual(owner);
  expect(db.prepare('PRAGMA table_info(remote_live_tool_sources)').all()).toMatchObject([{ name: 'incompatible' }]);
});

it('keeps tool edits and message deletion durable after optional membership cache failure', () => {
  const { store, db, create } = fixture(); create('s'); store.initializeSynchronization();
  store.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES('tool','s','tool_use','hello','{}',2,1)").run());
  db.exec('DROP TABLE remote_live_tool_sources');
  expect(() => store.transaction(() => db.prepare("UPDATE cowork_messages SET content='updated' WHERE id='tool'").run())).not.toThrow();
  expect(() => store.transaction(() => db.prepare("DELETE FROM cowork_messages WHERE id='tool'").run())).not.toThrow();
  expect(db.prepare("SELECT revision,deleted FROM remote_live_revisions WHERE session_id='s' AND object_id='tool'").get()).toEqual({ revision: 3, deleted: 1 });
  expect(db.prepare("SELECT object_key FROM remote_control_pending WHERE session_id='s' AND object_key='message.deleted:tool'").get()).toBeTruthy();
  expect(db.prepare("SELECT revision FROM remote_live_tools WHERE session_id='s' AND tool_id='tool'").get()).toEqual({ revision: 3 });
});

it('preserves the local actor when remote ownership signing fails', () => {
  const { store, db, create } = fixture();
  store.setOwnershipSigner(() => { throw new Error('remote signer unavailable'); });
  expect(() => create('local-only')).not.toThrow();
  expect(store.owner('local-only')).toEqual(owner);
  expect(() => store.assertActor('local-only', owner)).not.toThrow();
  expect(() => store.assertActor('local-only', { userId: 'other', scopeKey: 'personal' })).toThrow();
  expect(store.get('ownershipProof:local-only')).toBeNull();
  expect(db.prepare('SELECT owner_user_id FROM remote_ownership_pending WHERE session_id=?').get('local-only')).toEqual({ owner_user_id: owner.userId });
});

it('rolls back a failed optional schema phase and still constructs the desktop store', () => {
  const { db } = fixture();
  db.exec('CREATE VIEW remote_projection AS SELECT 1 AS unavailable');
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_live_tool_sources'").get()).toBeUndefined();
  expect(() => store.transaction(() => db.prepare("INSERT INTO cowork_sessions VALUES('core','Core',1,1,'idle')").run())).not.toThrow();
  expect(() => store.beginRun('core')).not.toThrow();
});


it('does not run optional preference repair during desktop construction', () => {
  const { db } = fixture();
  db.prepare('INSERT INTO remote_state VALUES (?,?)').run('replyProjectionMode', '{');
  db.exec(`CREATE TRIGGER fail_optional_repair BEFORE DELETE ON remote_state
    WHEN OLD.key='replyProjectionMode' BEGIN SELECT RAISE(ABORT,'optional repair unavailable'); END;`);
  const reopened = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
  expect(() => reopened.initializeSynchronization()).toThrow('optional repair unavailable');
  expect(() => reopened.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('local','Local',1,1,'idle')").run();
    reopened.assignNew('local', owner, 'local_create');
  })).not.toThrow();
  expect(() => reopened.beginRun('local')).not.toThrow();
  expect(db.prepare("SELECT value FROM remote_state WHERE key='replyProjectionMode'").get()).toEqual({ value: '{' });
});

it('rolls back a failed core upgrade rather than leaving half-migrated execution tables', () => {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY); CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT);
    CREATE VIEW remote_sync AS SELECT 1 AS incompatible;`);
  expect(() => new RemoteStore(db, { deferredProjection: true, deferSynchronization: true })).toThrow();
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_execution_dispatch'").get()).toBeUndefined();
  expect(db.prepare("SELECT type FROM sqlite_master WHERE name='remote_sync'").get()).toEqual({ type: 'view' });
});

it('replaces pre-upgrade core triggers that still reference an optional cache', () => {
  const { db } = fixture();
  db.exec(`DROP TRIGGER remote_revision_cowork_messages_insert;
    CREATE TRIGGER remote_revision_cowork_messages_insert AFTER INSERT ON cowork_messages BEGIN
      INSERT INTO removed_optional_cache VALUES(NEW.id); END;`);
  const reopened = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
  expect(() => reopened.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES('m','s','assistant','ok',NULL,2,1)").run())).not.toThrow();
  expect(reopened.projectionRevision('s')).toBe(1);
});

 it('defers a broken history locator schema without weakening healthy desktop core writes', () => {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER)`);
  const migrate = vi.spyOn(RemoteHistoryStore, 'initializeCore').mockImplementation(() => { throw new Error('optional history schema unavailable'); });
  const store = new RemoteStore(db, { deferSynchronization: true, restoreRuns: false });
  expect(() => store.initializeSynchronization()).toThrow('optional history schema unavailable');
  migrate.mockRestore();
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'idle')"); store.assignNew('s', owner, 'local_create'); });
  expect(() => store.beginRun('s')).not.toThrow();
  expect(store.owner('s')).toEqual(owner);
 });
 it('does not rebuild unchanged core triggers on subsequent startup', () => {
  const { db } = fixture();
  const version = db.pragma('schema_version', { simple: true });
  new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
  expect(db.pragma('schema_version', { simple: true })).toBe(version);
 });
