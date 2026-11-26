import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { TrustedWriteContext, withTrustedMigrationWrite } from './remoteWriteContext';

test('upgrades a protected legacy database atomically and restores its write fence after nested failure', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE remote_write_context(id INTEGER PRIMARY KEY, trusted INTEGER NOT NULL);
      INSERT INTO remote_write_context VALUES(1,0);
      CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT);
      INSERT INTO cowork_sessions VALUES('owned','old');
      CREATE TRIGGER protect_legacy BEFORE UPDATE ON cowork_sessions
        WHEN (SELECT trusted FROM remote_write_context WHERE id=1) <> 1 BEGIN SELECT RAISE(ABORT,'protected'); END;`);
    const migrate = (operation: () => void) => withTrustedMigrationWrite(db, TrustedWriteContext.Session, operation);
    const change = () => db.prepare("UPDATE cowork_sessions SET title='migrated'").run();
    expect(change).toThrow('protected');
    expect(() => migrate(() => { migrate(change); throw new Error('bad input'); })).toThrow('bad input');
    expect(db.prepare('SELECT title FROM cowork_sessions').pluck().get()).toBe('old');
    expect(change).toThrow('protected');
    migrate(change);
    expect(db.prepare('SELECT title FROM cowork_sessions').pluck().get()).toBe('migrated');
    expect(change).toThrow('protected');
  } finally { db.close(); }
});
