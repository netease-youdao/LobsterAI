import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteStore } from './remoteStore';

const owner = { userId: 'owner', scopeKey: 'personal' };
const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
  const committed = vi.fn();
  const create = (id: string) => store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES(?,?,1,1,'idle')").run(id, id);
    store.assignNew(id, owner, 'local_create');
    store.afterCommit(committed);
  });
  return { db, store, create, committed };
}
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('core transaction failures do not leak ownership or poison later writes', () => {
  it.each([1, 0])('recovers after the trusted=%i marker fails', trusted => {
    const { db, store, create, committed } = fixture();
    db.exec(`CREATE TRIGGER fail_context BEFORE UPDATE ON remote_write_context WHEN NEW.trusted=${trusted}
      BEGIN SELECT RAISE(ABORT,'injected marker failure'); END;`);
    expect(() => create('failed')).toThrow('injected marker failure');
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT * FROM cowork_sessions').all()).toEqual([]);
    expect(store.ownershipRecord('failed')).toBeNull();
    expect(store.sync('failed')).toBeNull();
    expect(committed).not.toHaveBeenCalled();
    db.exec('DROP TRIGGER fail_context');
    expect(() => create('healthy')).not.toThrow();
    expect(store.owner('healthy')).toEqual(owner);
    expect(() => store.assertActor('healthy', { ...owner, userId: 'other' })).toThrow();
    expect(committed).toHaveBeenCalledOnce();
    expect(() => store.transaction(() => {
      db.prepare("UPDATE cowork_sessions SET title='rolled back' WHERE id='healthy'").run();
      throw new Error('rollback edit');
    })).toThrow('rollback edit');
    expect(db.prepare("SELECT title FROM cowork_sessions WHERE id='healthy'").get()).toEqual({ title: 'healthy' });
    expect(store.owner('healthy')).toEqual(owner);
    expect(db.prepare('SELECT trusted FROM remote_write_context').get()).toEqual({ trusted: 0 });
  });

  it('rejects nested and completed callbacks after SQLite has rolled back the real transaction', () => {
    const { db, store, create, committed } = fixture();
    db.exec(`CREATE TRIGGER abort_transaction BEFORE INSERT ON cowork_sessions WHEN NEW.id='rollback'
      BEGIN SELECT RAISE(ROLLBACK,'injected automatic rollback'); END;`);
    const nested = vi.fn();
    expect(() => store.transaction(() => {
      expect(() => create('rollback')).toThrow('injected automatic rollback');
      expect(db.inTransaction).toBe(false);
      expect(() => store.transaction(nested)).toThrow('Core transaction is no longer active');
    })).toThrow('Core transaction is no longer active');
    expect(nested).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    expect(() => create('healthy')).not.toThrow();
    expect(store.owner('healthy')).toEqual(owner);
    expect(db.prepare('SELECT id FROM cowork_sessions').all()).toEqual([{ id: 'healthy' }]);
    expect(committed).toHaveBeenCalledOnce();
  });
});
