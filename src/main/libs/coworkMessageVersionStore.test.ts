import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { CoworkMessageEditPhase } from '../../shared/cowork/messageEdit';
import { type CoworkMessageEditOperation, CoworkMessageEditStore } from './coworkMessageEditStore';
import { type CoworkGatewayActivePath, CoworkMessageVersionStore } from './coworkMessageVersionStore';

const databases: Database.Database[] = [];
/** The gateway path of a live version that reached the gateway, ending at `leaf`. */
const reached = (leaf: string): CoworkGatewayActivePath => ({ leafEntryId: leaf, entryIds: ['keep-entry', `${leaf}-message`] });
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
  const commitEdit = (messageId: string, originalLeafId: string, replacement: string, prefixEntryIds = ['keep-entry'],
    originalCutEntryId?: string) => {
    counter += 1;
    const operation: CoworkMessageEditOperation = {
      sessionId: 'session', sessionKey: 'key', operationId: `operation-${counter}`, messageId,
      entryId: `entry-${messageId}`, originalLeafId, originalCutEntryId, originalTranscriptId: 'transcript',
      runId: `run-${replacement}`, prefixEntryIds, prompt: replacement, phase: CoworkMessageEditPhase.Prepared,
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
  /** Replays a committed edit of `messageId`, a message the gateway never recorded. */
  const commitUndeliveredEdit = (messageId: string, replacement: string) => {
    const operation: CoworkMessageEditOperation = {
      sessionId: 'session', sessionKey: 'key', operationId: `undelivered-${replacement}`, messageId,
      runId: `run-${replacement}`, prefixEntryIds: ['keep-entry'], prompt: replacement, phase: CoworkMessageEditPhase.Prepared,
    };
    edits.prepare(operation);
    edits.truncate(operation);
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(replacement, 'session', 'user', `${replacement} wording`, JSON.stringify({ openclawRequestId: operation.runId }), 30, 2);
    edits.setPhase(operation, CoworkMessageEditPhase.Committed);
    versions.recordUndeliveredEdit(operation);
  };
  const editRecords = () => db.prepare('SELECT COUNT(*) AS count FROM cowork_message_edits').get();
  const ids = () => (db.prepare('SELECT id FROM cowork_messages ORDER BY sequence').all() as Array<{ id: string }>).map(row => row.id);
  const versionOf = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM cowork_messages WHERE id = ?')
    .get(id) as { metadata: string }).metadata).messageVersion;
  const switchTo = (headMessageId: string, targetIndex: number, gateway: CoworkGatewayActivePath | string) => {
    const pending = versions.beginSwitch('session', headMessageId, targetIndex, typeof gateway === 'string' ? reached(gateway) : gateway);
    return { pending, head: versions.applySwitch('session') };
  };
  const leafOf = (headMessageId: string) => (db.prepare('SELECT leaf_entry_id FROM cowork_message_versions WHERE head_message_id = ?')
    .get(headMessageId) as { leaf_entry_id: string | null }).leaf_entry_id;
  return { db, versions, createVersions, commitEdit, commitUndeliveredEdit, editRecords, ids, versionOf, switchTo, leafOf };
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
    expect(() => f.versions.beginSwitch('session', 'v2', 2, reached('tip-2'))).toThrow();
    expect(() => f.versions.beginSwitch('session', 'v2', 3, reached('tip-2'))).toThrow();
    expect(() => f.versions.beginSwitch('session', 'keep', 1, reached('tip-2'))).toThrow();
    f.versions.beginSwitch('session', 'v2', 1, reached('tip-2'));
    expect(() => f.versions.beginSwitch('session', 'v2', 1, reached('tip-2'))).toThrow();
    const reopened = f.createVersions();
    expect(reopened.pendingSwitch('session')).toMatchObject({ activeLeafEntryId: 'tip-2', targetLeafEntryId: 'tip-1' });
    expect(reopened.applySwitch('session')).toBe('v1');
    expect(reopened.pendingSwitch('session')).toBeNull();
    expect(f.ids()).toEqual(['keep', 'v1', 'v1-reply']);
  });

  test('lets the resent message head the version of a message the gateway never recorded', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    // v2 was stopped before the gateway recorded it, then edited again.
    f.commitUndeliveredEdit('v2', 'v3');
    expect(f.ids()).toEqual(['keep', 'v3']);
    expect(f.versionOf('v3')).toEqual({ index: 2, count: 2 });
    expect(f.editRecords()).toEqual({ count: 0 });
    expect(f.switchTo('v3', 1, 'tip-3').head).toBe('v1');
    expect(f.switchTo('v1', 2, 'tip-1').head).toBe('v3');
    expect(f.ids()).toEqual(['keep', 'v3']);
  });

  test('keeps no version for an undelivered message outside any version', () => {
    const f = fixture();
    f.commitUndeliveredEdit('v1', 'v2');
    expect(f.ids()).toEqual(['keep', 'v2']);
    expect(f.versionOf('v2')).toBeUndefined();
    expect(f.editRecords()).toEqual({ count: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_message_versions').get()).toEqual({ count: 0 });
  });

  test('is removed with its session', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    f.versions.beginSwitch('session', 'v2', 1, reached('tip-2'));
    f.db.exec("DELETE FROM cowork_sessions WHERE id = 'session'");
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_message_versions').get()).toEqual({ count: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM cowork_message_version_switches').get()).toEqual({ count: 0 });
  });
});

describe('versions whose resend never reached the gateway', () => {
  describe.each([
    { label: 'an empty prefix', prefix: [] as string[] },
    { label: 'a non-empty prefix', prefix: ['keep-entry'] },
  ])('with $label', ({ prefix }) => {
    /** v2's resend was stopped before the gateway wrote it, so the active path ends at the fork point. */
    const atForkPoint: CoworkGatewayActivePath = { leafEntryId: prefix.at(-1), entryIds: prefix };
    const fork = prefix.at(-1) ?? '';

    test('keeps no tip for it, and switches back to it at the fork point', () => {
      const f = fixture();
      f.commitEdit('v1', 'tip-1', 'v2', prefix);
      const back = f.switchTo('v2', 1, atForkPoint);
      expect(back.pending).toMatchObject({ activeLeafEntryId: null, activeCutEntryId: fork, targetLeafEntryId: 'tip-1' });
      expect(back.head).toBe('v1');
      expect(f.leafOf('v2')).toBeNull();
      const forward = f.switchTo('v1', 2, { leafEntryId: 'tip-1', entryIds: [...prefix, 'entry-v1', 'tip-1'] });
      expect(forward.pending).toMatchObject({ activeLeafEntryId: 'tip-1', targetLeafEntryId: null, targetCutEntryId: fork });
      expect(forward.head).toBe('v2');
      expect(f.ids()).toEqual(['keep', 'v2', 'v2-reply']);
      expect(f.versionOf('v2')).toEqual({ index: 2, count: 2 });
      expect(f.leafOf('v1')).toBe('tip-1');
    });

    test('keeps a recorded switch to it across a restart', () => {
      const f = fixture();
      f.commitEdit('v1', 'tip-1', 'v2', prefix);
      f.switchTo('v2', 1, atForkPoint);
      f.versions.beginSwitch('session', 'v1', 2, reached('tip-1'));
      const reopened = f.createVersions();
      expect(reopened.pendingSwitch('session')).toMatchObject({ activeLeafEntryId: 'tip-1', targetLeafEntryId: null, targetCutEntryId: fork });
      expect(reopened.applySwitch('session')).toBe('v2');
      expect(f.ids()).toEqual(['keep', 'v2', 'v2-reply']);
    });
  });

  test('reads a fork point an earlier build stored as the tip as no tip', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    f.db.prepare("UPDATE cowork_message_versions SET leaf_entry_id = 'keep-entry' WHERE head_message_id = 'v1'").run();
    expect(f.versions.beginSwitch('session', 'v2', 1, reached('tip-2')))
      .toMatchObject({ targetLeafEntryId: null, targetCutEntryId: 'keep-entry' });
  });

  test('refuses to leave a version past its fork point without a tip to return to', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    expect(() => f.versions.beginSwitch('session', 'v2', 1, { entryIds: ['keep-entry', 'entry-v2'] })).toThrow();
    expect(f.versions.pendingSwitch('session')).toBeNull();
  });
});

describe('a version that stops at the fork point of a version group inside it', () => {
  test('is kept with a tip of the inner group and that fork point, whenever it is left', () => {
    const f = fixture();
    // Inner group at keep-entry: v1 grew to tip-1, v2's resend never reached the gateway.
    f.commitEdit('v1', 'tip-1', 'v2');
    const original = f.versions.gatewayPosition('session', { leafEntryId: 'keep-entry', entryIds: ['keep-entry'] });
    expect(original).toEqual({ leafEntryId: 'tip-1', cutEntryId: 'keep-entry' });
    // An edit of the first message files that conversation as a version of the outer group.
    f.commitEdit('keep', 'tip-1', 'o2', [], 'keep-entry');
    expect(f.ids()).toEqual(['o2', 'o2-reply']);
    const back = f.switchTo('o2', 1, 'o2-tip');
    expect(back.pending).toMatchObject({ activeLeafEntryId: 'o2-tip', targetLeafEntryId: 'tip-1', targetCutEntryId: 'keep-entry' });
    expect(f.ids()).toEqual(['keep', 'v2', 'v2-reply']);
    expect(f.versionOf('v2')).toEqual({ index: 2, count: 2 });
    // Leaving it again, with the gateway back at the inner fork point, records the same way back.
    const forward = f.switchTo('keep', 2, { leafEntryId: 'keep-entry', entryIds: ['keep-entry'] });
    expect(forward.pending).toMatchObject({ activeLeafEntryId: 'tip-1', activeCutEntryId: 'keep-entry', targetLeafEntryId: 'o2-tip' });
    expect(f.ids()).toEqual(['o2', 'o2-reply']);
    expect(f.switchTo('o2', 1, 'o2-tip').pending).toMatchObject({ targetLeafEntryId: 'tip-1', targetCutEntryId: 'keep-entry' });
  });

  test('repairs such a version an earlier build kept with the inner fork point as its tip', () => {
    const f = fixture();
    f.commitEdit('v1', 'tip-1', 'v2');
    // The earlier build filed the outer version with the gateway's leaf at the time: the inner fork point.
    f.commitEdit('keep', 'keep-entry', 'o2', []);
    expect(f.switchTo('o2', 1, 'o2-tip').pending).toMatchObject({ targetLeafEntryId: 'tip-1', targetCutEntryId: 'keep-entry' });
    expect(f.ids()).toEqual(['keep', 'v2', 'v2-reply']);
    // An inner version that is itself such a record still yields a tip through the inner fork point.
    f.db.prepare("UPDATE cowork_message_versions SET leaf_entry_id = 'deeper-fork' WHERE head_message_id = 'v1'").run();
    f.db.prepare(`INSERT INTO cowork_message_versions (id, session_id, fork_key, ordinal, active, head_message_id, leaf_entry_id, snapshot_json)
      VALUES ('deep', 'session', 'deeper-fork', 1, 0, 'd1', 'tip-deep', '{"messages":[]}')`).run();
    expect(f.versions.gatewayPosition('session', { leafEntryId: 'keep-entry', entryIds: ['keep-entry'] }))
      .toEqual({ leafEntryId: 'tip-deep', cutEntryId: 'keep-entry' });
  });

  test('returns to a plain tip when no kept version of that group has one', () => {
    const f = fixture();
    expect(f.versions.gatewayPosition('session', { leafEntryId: 'reply', entryIds: ['keep-entry', 'reply'] }))
      .toEqual({ leafEntryId: 'reply' });
    expect(f.versions.gatewayPosition('session', { entryIds: [] })).toBeUndefined();
  });
});

describe('a database from an earlier build', () => {
  test('gains the fork point column and keeps its versions switchable', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER);
      CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, content TEXT, metadata TEXT, created_at INTEGER, sequence INTEGER);
      INSERT INTO cowork_sessions VALUES ('session', 'completed', 100);
      CREATE TABLE cowork_message_versions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fork_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL, active INTEGER NOT NULL, head_message_id TEXT NOT NULL, leaf_entry_id TEXT, snapshot_json TEXT);
      INSERT INTO cowork_message_versions VALUES ('old', 'session', 'keep-entry', 1, 0, 'v1', 'tip-1', '{"messages":[]}');
      INSERT INTO cowork_message_versions VALUES ('new', 'session', 'keep-entry', 2, 1, 'v2', NULL, NULL);`);
    const versions = new CoworkMessageVersionStore(db, <T>(_sessionId: string, operation: () => T): T => db.transaction(operation)());
    expect((db.prepare('PRAGMA table_info(cowork_message_versions)').all() as Array<{ name: string }>).map(column => column.name))
      .toContain('cut_entry_id');
    expect(versions.beginSwitch('session', 'v2', 1, reached('tip-2'))).toMatchObject({ targetLeafEntryId: 'tip-1', activeLeafEntryId: 'tip-2' });
  });
});
