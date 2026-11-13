import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import {
  getCoworkParentSessionId,
  isCoworkSessionBoundToIm,
  resolveCoworkSessionIdByOpenClawSessionKey,
  resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey,
  resolveOpenClawSessionKeyForCoworkSession,
  resolveSubagentRequesterCoworkSessionId,
} from './openclawLocalSessionResolver';

const dbs: Database.Database[] = [];

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      parent_session_id TEXT
    );
    CREATE TABLE im_session_mappings (
      cowork_session_id TEXT
    );
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      session_key TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
};

const insertSession = (
  db: Database.Database,
  id: string,
  claudeSessionId: string | null = null,
  parentSessionId: string | null = null,
) => {
  db.prepare('INSERT INTO cowork_sessions (id, claude_session_id, parent_session_id) VALUES (?, ?, ?)')
    .run(id, claudeSessionId, parentSessionId);
};

afterEach(() => {
  while (dbs.length > 0) {
    dbs.pop()?.close();
  }
});

describe('openclaw local session resolver', () => {
  test('resolves new desktop session keys and preserves persisted subagent keys', () => {
    expect(resolveOpenClawSessionKeyForCoworkSession(null)).toBeUndefined();
    for (const agentId of ['main', 'qa-reviewer']) {
      const session = { id: 'session-1', agentId, claudeSessionId: null };
      const key = resolveOpenClawSessionKeyForCoworkSession(session);
      const db = createDb();
      insertSession(db, session.id);
      expect(key).toBe(`agent:${agentId}:lobsterai:session-1`);
      expect(resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey(db, key)).toBe(session.id);
      expect(resolveOpenClawSessionKeyForCoworkSession({ ...session, claudeSessionId: '  ' })).toBe(key);
      expect(resolveOpenClawSessionKeyForCoworkSession({ ...session, claudeSessionId: 'agent:qa-reviewer:subagent:run-1' }))
        .toBe('agent:qa-reviewer:subagent:run-1');
    }
  });

  test('resolves managed desktop session keys across agents', () => {
    const db = createDb();
    insertSession(db, 'session-1');

    expect(resolveCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:lobsterai:session-1',
    )).toBe('session-1');
  });

  test('resolves materialized subagent child session keys', () => {
    const db = createDb();
    insertSession(db, 'parent-1');
    insertSession(db, 'child-1', 'agent:qa-reviewer:subagent:run-1', 'parent-1');

    expect(resolveCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:subagent:run-1',
    )).toBe('child-1');
    expect(getCoworkParentSessionId(db, 'child-1')).toBe('parent-1');
  });

  test('rejects IM-bound sessions and descendants for desktop callbacks', () => {
    const db = createDb();
    insertSession(db, 'im-parent');
    insertSession(db, 'im-child', 'agent:qa-reviewer:subagent:run-2', 'im-parent');
    db.prepare('INSERT INTO im_session_mappings (cowork_session_id) VALUES (?)').run('im-parent');

    expect(isCoworkSessionBoundToIm(db, 'im-child')).toBe(true);
    expect(resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:subagent:run-2',
    )).toBe(null);
  });
});

describe('resolveSubagentRequesterCoworkSessionId', () => {
  const childKey = 'agent:main:dashboard:child-uuid';
  const insertRun = (db: Database.Database, id: string, parentSessionId: string, createdAt: number) => {
    db.prepare('INSERT INTO subagent_runs (id, parent_session_id, session_key, created_at) VALUES (?, ?, ?, ?)')
      .run(id, parentSessionId, childKey, createdAt);
  };

  test('maps a spawned child without a Cowork row to its latest requester session', () => {
    const db = createDb();
    insertSession(db, 'old-parent', 'agent:main:lobsterai:old-parent');
    insertSession(db, 'parent', 'agent:main:lobsterai:parent');
    insertRun(db, 'run-old', 'old-parent', 1);
    insertRun(db, 'run-new', 'parent', 2);

    expect(resolveCoworkSessionIdByOpenClawSessionKey(db, childKey)).toBeNull();
    expect(resolveSubagentRequesterCoworkSessionId(db, childKey)).toBe('parent');
  });

  test('ignores unknown keys and requester sessions that no longer exist', () => {
    const db = createDb();
    insertRun(db, 'run-deleted', 'deleted-parent', 1);

    expect(resolveSubagentRequesterCoworkSessionId(db, childKey)).toBeNull();
    expect(resolveSubagentRequesterCoworkSessionId(db, 'agent:main:dashboard:unknown')).toBeNull();
    expect(resolveSubagentRequesterCoworkSessionId(db, '  ')).toBeNull();
  });
});
