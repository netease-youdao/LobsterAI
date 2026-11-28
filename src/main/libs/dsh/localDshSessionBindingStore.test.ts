import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

import { CoworkSessionSource } from '../../../shared/cowork/constants';
import {
  ensureLocalDshSessionBindingsTable,
  LocalDshSessionBindingStore,
} from './localDshSessionBindingStore';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      scheduled_task_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureLocalDshSessionBindingsTable(db);
  return db;
}

describe('LocalDshSessionBindingStore', () => {
  test('upserts bindings, strips dsh: prefix, and monotonically advances synced_seq', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO cowork_sessions (id, updated_at) VALUES (?, ?)').run('cw-1', 1000);
    const store = new LocalDshSessionBindingStore(db);

    const created = store.upsertBinding({
      coworkSessionId: 'cw-1',
      dshSessionId: 'dsh:sess-alpha',
      origin: CoworkSessionSource.DshExternal,
    });
    expect(created.coworkSessionId).toBe('cw-1');
    expect(created.dshSessionId).toBe('sess-alpha');
    expect(created.syncedSeq).toBe(-1);
    expect(created.origin).toBe(CoworkSessionSource.DshExternal);

    expect(store.getByDshSessionId('dsh:sess-alpha')?.coworkSessionId).toBe('cw-1');
    expect(store.getByDshSessionId('sess-alpha')?.coworkSessionId).toBe('cw-1');

    expect(store.advanceSyncedSeq('sess-alpha', 0)).toBe(true);
    expect(store.getByCoworkSessionId('cw-1')?.syncedSeq).toBe(0);

    expect(store.advanceSyncedSeq('dsh:sess-alpha', 5)).toBe(true);
    expect(store.getByCoworkSessionId('cw-1')?.syncedSeq).toBe(5);

    // Older seq must never regress synced_seq.
    expect(store.advanceSyncedSeq('sess-alpha', 2)).toBe(true);
    expect(store.getByCoworkSessionId('cw-1')?.syncedSeq).toBe(5);

    // Re-upserting with a smaller syncedSeq preserves the higher watermark.
    const reupserted = store.upsertBinding({
      coworkSessionId: 'cw-1',
      dshSessionId: 'sess-alpha',
      syncedSeq: 1,
    });
    expect(reupserted.syncedSeq).toBe(5);
  });

  test('rebinds cleanly when a cowork session switches to a new DSH session', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO cowork_sessions (id, updated_at) VALUES (?, ?)').run('cw-1', 1000);
    const store = new LocalDshSessionBindingStore(db);

    store.upsertBinding({ coworkSessionId: 'cw-1', dshSessionId: 'dsh-old', syncedSeq: 12 });
    const rebound = store.upsertBinding({ coworkSessionId: 'cw-1', dshSessionId: 'dsh-new' });

    expect(rebound.dshSessionId).toBe('dsh-new');
    expect(rebound.syncedSeq).toBe(-1);
    expect(store.getByDshSessionId('dsh-old')).toBeNull();
    expect(store.getByDshSessionId('dsh-new')?.coworkSessionId).toBe('cw-1');
  });

  test('backfillFromCoworkSessions seeds synced_seq from message metadata and skips non-dsh sessions', () => {
    const db = createTestDb();
    db.prepare(
      'INSERT INTO cowork_sessions (id, claude_session_id, scheduled_task_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('cw-with-seq', 'dsh:sess-1', null, 2000);
    db.prepare(
      'INSERT INTO cowork_sessions (id, claude_session_id, scheduled_task_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('cw-scheduled', 'dsh:sess-2', 'task-1', 3000);
    db.prepare(
      'INSERT INTO cowork_sessions (id, claude_session_id, scheduled_task_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('cw-legacy', 'oc-legacy-id', null, 4000);

    db.prepare(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m-1', 'cw-with-seq', 'assistant', 'hello', JSON.stringify({ seq: 3 }), 2001);
    db.prepare(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m-2', 'cw-with-seq', 'assistant', 'world', JSON.stringify({ seq: 9 }), 2002);

    const store = new LocalDshSessionBindingStore(db);
    const inserted = store.backfillFromCoworkSessions();
    expect(inserted).toBe(2);

    // Idempotent second call inserts 0.
    expect(store.backfillFromCoworkSessions()).toBe(0);

    const b1 = store.getByCoworkSessionId('cw-with-seq');
    expect(b1).toMatchObject({
      coworkSessionId: 'cw-with-seq',
      dshSessionId: 'sess-1',
      syncedSeq: 9,
      origin: CoworkSessionSource.Desktop,
    });

    const b2 = store.getByCoworkSessionId('cw-scheduled');
    expect(b2).toMatchObject({
      coworkSessionId: 'cw-scheduled',
      dshSessionId: 'sess-2',
      syncedSeq: -1,
      origin: CoworkSessionSource.Scheduled,
    });

    expect(store.getByCoworkSessionId('cw-legacy')).toBeNull();
  });

  test('cascades deletion when the parent cowork_sessions row is removed', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO cowork_sessions (id, updated_at) VALUES (?, ?)').run('cw-del', 1000);
    const store = new LocalDshSessionBindingStore(db);
    store.upsertBinding({ coworkSessionId: 'cw-del', dshSessionId: 'dsh-del', syncedSeq: 4 });

    db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run('cw-del');
    expect(store.getByCoworkSessionId('cw-del')).toBeNull();
    expect(store.getByDshSessionId('dsh-del')).toBeNull();
  });
});
