import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { CoworkMessageEditPhase } from '../../shared/cowork/messageEdit';
import { type CoworkMessageEditOperation, CoworkMessageEditStore } from './coworkMessageEditStore';
import { CoworkMessageVersionStore } from './coworkMessageVersionStore';

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
    INSERT INTO cowork_messages VALUES ('v1', 'session', 'user', 'first wording', '{"openclawRequestId":"run-1"}', 2, 2);
    INSERT INTO cowork_messages VALUES ('v1-reply', 'session', 'assistant', 'first answer', '{}', 3, 3);
    INSERT INTO cowork_session_capsules VALUES ('session', 1, 2, '{"facts":["first"]}', 3, 'test', 4);`);
  const write = <T>(_sessionId: string, operation: () => T): T => db.transaction(operation)();
  const edits = new CoworkMessageEditStore(db, write);
  const createVersions = () => new CoworkMessageVersionStore(db, write);
  const versions = createVersions();
  let counter = 0;
  /** Replays what a committed edit of `messageId` leaves in the database. */
  const commitEdit = (messageId: string, originalLeafId: string, replacement: string) => {
    counter += 1;
    const operation: CoworkMessageEditOperation = {
      sessionId: 'session', sessionKey: 'key', operationId: `operation-${counter}`, messageId,
      entryId: `entry-${messageId}`, originalLeafId, originalTranscriptId: 'transcript',
      runId: `run-${replacement}`, prefixEntryIds: ['keep-entry'], prompt: replacement, phase: CoworkMessageEditPhase.Prepared,
    };
    edits.prepare(operation);
    edits.truncate(operation);
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(replacement, 'session', 'user', `${replacement} wording`, JSON.stringify({ openclawRequestId: operation.runId }), 10 + counter, 2);
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`${replacement}-reply`, 'session', 'assistant', `${replacement} answer`, '{}', 20 + counter, 3);
    edits.setPhase(operation, CoworkMessageEditPhase.Committed);
    versions.recordEdit(operation);
  };
  const ids = () => (db.prepare('SELECT id FROM cowork_messages ORDER BY sequence').all() as Array<{ id: string }>).map(row => row.id);
  const versionOf = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM cowork_messages WHERE id = ?')
    .get(id) as { metadata: string }).metadata).messageVersion;
  const switchTo = (headMessageId: string, targetIndex: number, activeLeafEntryId: string) => {
    const pending = versions.beginSwitch('session', headMessageId, targetIndex, activeLeafEntryId);
    return { pending, head: versions.applySwitch('session') };
  };
  return { db, versions, createVersions, commitEdit, ids, versionOf, switchTo };
}

describe('versions left behind by message edits', () => {
  test('keeps the replaced conversation and numbers the resent message as the newest version', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    expect(f.ids()).toEqual(['keep', 'v2', 'v2-reply']);
    expect(f.versionOf('v2')).toEqual({ index: 2, count: 2 });
  });

  test('switches back to an older version with its exact messages, capsule and gateway branch', () => {
    const f = fixture();
    const capsule = f.db.prepare('SELECT * FROM cowork_session_capsules').all();
    f.commitEdit('v1', 'tip-1', 'v2');
    const back = f.switchTo('v2', 1, 'tip-2');
    expect(back.pending.targetLeafEntryId).toBe('tip-1');
    expect(back.head).toBe('v1');
    expect(f.ids()).toEqual(['keep', 'v1', 'v1-reply']);
    expect(f.versionOf('v1')).toEqual({ index: 1, count: 2 });
    expect(f.db.prepare('SELECT * FROM cowork_session_capsules').all()).toEqual(capsule);
    // The version that was left is stored with the tip it had when it was live.
    const forward = f.switchTo('v1', 2, 'tip-1');
    expect(forward.pending.targetLeafEntryId).toBe('tip-2');
    expect(f.ids()).toEqual(['keep', 'v2', 'v2-reply']);
    expect(f.versionOf('v2')).toEqual({ index: 2, count: 2 });
  });

  test('keeps the session where it sorts in the list when a version is shown', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    const updatedAt = () => (f.db.prepare("SELECT updated_at FROM cowork_sessions WHERE id = 'session'").get() as { updated_at: number }).updated_at;
    const afterEdit = updatedAt();
    expect(afterEdit).toBeGreaterThan(100);
    f.switchTo('v2', 1, 'tip-2');
    expect(updatedAt()).toBe(afterEdit);
    f.switchTo('v1', 2, 'tip-1');
    expect(updatedAt()).toBe(afterEdit);
  });

  test('adds an edit of an older version as a new version without losing the others', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    f.switchTo('v2', 1, 'tip-2');
    f.commitEdit('v1', 'tip-1', 'v3');
    expect(f.versionOf('v3')).toEqual({ index: 3, count: 3 });
    expect(f.switchTo('v3', 2, 'tip-3').pending.targetLeafEntryId).toBe('tip-2');
    expect(f.ids()).toEqual(['keep', 'v2', 'v2-reply']);
    expect(f.versionOf('v2')).toEqual({ index: 2, count: 3 });
    expect(f.switchTo('v2', 1, 'tip-2').head).toBe('v1');
    expect(f.versionOf('v1')).toEqual({ index: 1, count: 3 });
  });

  test('refuses unknown targets and keeps a recorded switch across a restart', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    expect(() => f.versions.beginSwitch('session', 'v2', 2, 'tip-2')).toThrow();
    expect(() => f.versions.beginSwitch('session', 'v2', 3, 'tip-2')).toThrow();
    expect(() => f.versions.beginSwitch('session', 'keep', 1, 'tip-2')).toThrow();
    f.versions.beginSwitch('session', 'v2', 1, 'tip-2');
    expect(() => f.versions.beginSwitch('session', 'v2', 1, 'tip-2')).toThrow();
    const reopened = f.createVersions();
    expect(reopened.pendingSwitch('session')).toMatchObject({ activeLeafEntryId: 'tip-2', targetLeafEntryId: 'tip-1' });
    expect(reopened.applySwitch('session')).toBe('v1');
    expect(reopened.pendingSwitch('session')).toBeNull();
    expect(f.ids()).toEqual(['keep', 'v1', 'v1-reply']);
  });

  test('is removed with its session', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    f.versions.beginSwitch('session', 'v2', 1, 'tip-2');
    f.db.exec("DELETE FROM cowork_sessions WHERE id = 'session'");
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_message_versions').get()).toEqual({ count: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_message_version_switches').get()).toEqual({ count: 0 });
  });
});
