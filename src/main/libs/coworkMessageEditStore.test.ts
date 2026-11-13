import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { CoworkMessageEditPhase } from '../../shared/cowork/messageEdit';
import { type CoworkMessageEditOperation, CoworkMessageEditStore } from './coworkMessageEditStore';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER);
    CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, content TEXT, metadata TEXT, created_at INTEGER, sequence INTEGER);
    CREATE TABLE cowork_session_capsules (session_id TEXT PRIMARY KEY, version INTEGER, revision INTEGER, capsule_json TEXT, updated_at INTEGER, last_source TEXT, last_compacted_at INTEGER);
    INSERT INTO cowork_sessions VALUES ('session', 'completed', 100);
    INSERT INTO cowork_messages VALUES ('keep', 'session', 'user', 'earlier', '{}', 1, 1);
    INSERT INTO cowork_messages VALUES ('edit', 'session', 'user', 'wrong', '{"kitIds":["kit"],"openclawRequestId":"old"}', 2, 2);
    INSERT INTO cowork_messages VALUES ('tool', 'session', 'tool_use', '', '{"toolUseId":"call"}', 3, 3);
    INSERT INTO cowork_messages VALUES ('result', 'session', 'tool_result', 'old result', '{}', 4, 4);
    INSERT INTO cowork_messages VALUES ('system', 'session', 'system', 'old summary', '{}', 5, 5);
    INSERT INTO cowork_session_capsules VALUES ('session', 1, 2, '{"facts":["wrong"]}', 3, 'test', 4);`);
  const createStore = () => new CoworkMessageEditStore(db, (_sessionId, operation) => db.transaction(operation)());
  const store = createStore();
  const operation: CoworkMessageEditOperation = {
    sessionId: 'session', sessionKey: 'key', operationId: 'operation', messageId: 'edit',
    entryId: 'entry', originalLeafId: 'leaf', originalTranscriptId: 'transcript',
    runId: 'new', prefixEntryIds: ['keep'], prompt: 'correct', phase: CoworkMessageEditPhase.Prepared,
  };
  const rows = () => db.prepare('SELECT * FROM cowork_messages ORDER BY sequence').all();
  return { db, store, operation, rows, createStore };
}

describe('durable message edit recovery', () => {
  test('keeps the original projection until rewind succeeds, then removes the complete suffix', () => {
    const { db, store, operation, rows } = fixture();
    const before = rows();
    store.prepare(operation);
    expect(rows()).toEqual(before);
    expect(store.discardedRequestIds('session')).toEqual(['old']);
    store.truncate(operation);
    expect(rows()).toEqual(before.slice(0, 1));
    expect(db.prepare('SELECT * FROM cowork_session_capsules').all()).toEqual([]);
  });

  test('restores exact ids, order, context metadata and capsule after reopening the edit store', () => {
    const { db, store, operation, rows, createStore } = fixture();
    const before = rows();
    const capsule = db.prepare('SELECT * FROM cowork_session_capsules').all();
    store.prepare(operation);
    store.truncate(operation);
    db.exec("INSERT INTO cowork_messages VALUES ('new', 'session', 'user', 'correct', '{}', 6, 2)");
    const reopened = createStore();
    reopened.restore(reopened.pending('session')!);
    expect(rows()).toEqual(before);
    expect(db.prepare('SELECT * FROM cowork_session_capsules').all()).toEqual(capsule);
    expect(reopened.pending('session')).toBeNull();
  });

  test('retains recovery data when a competing edit or ambiguous legacy ordering is rejected', () => {
    const { db, store, operation, rows } = fixture();
    const before = rows();
    store.prepare(operation);
    expect(() => store.prepare({ ...operation, operationId: 'second' })).toThrow();
    expect(rows()).toEqual(before);
    store.restore(operation);
    db.exec("UPDATE cowork_messages SET sequence = NULL WHERE id = 'system'");
    expect(() => store.prepare({ ...operation, phase: CoworkMessageEditPhase.Prepared, operationId: 'third' })).toThrow();
    expect(store.pending('session')).toBeNull();
  });

  test('reconciles an accepted send without reusing the discarded user id or deleting the retained prefix', () => {
    const { db, store, operation, rows } = fixture();
    store.prepare(operation); store.truncate(operation);
    db.exec(`INSERT INTO cowork_messages VALUES ('new-user', 'session', 'user', 'correct', '{"openclawRequestId":"new","kitIds":["kit"]}', 6, 2);
      INSERT INTO cowork_messages VALUES ('partial', 'session', 'assistant', 'partial', '{}', 7, 3);`);
    store.commitRecovered(operation, [{ id: 'reply', type: 'assistant', content: 'complete', timestamp: 8 }], 'new-entry');
    expect(rows().map(row => (row as { id: string }).id)).toEqual(['keep', 'new-user', 'reply']);
    expect(store.pending('session')).toBeNull();
    expect(db.prepare('SELECT snapshot_json FROM cowork_message_edits').get()).toBeDefined();
    db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run('session');
    expect(db.prepare('SELECT * FROM cowork_message_edits').all()).toEqual([]);
  });
});
