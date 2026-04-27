/**
 * Unit tests for CoworkStore – resilient metadata parsing.
 *
 * Verifies that corrupt JSON in the metadata column of cowork_messages does NOT
 * prevent a session from loading.  Valid/null metadata must still work correctly.
 *
 * Mocks the `electron` module so CoworkStore can be imported outside Electron.
 */
import { beforeEach, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock electron so the import of coworkStore.ts succeeds in Node
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock' },
}));

// ---------------------------------------------------------------------------
// Now import the class under test
// ---------------------------------------------------------------------------
import BetterSqlite3 from 'better-sqlite3';

import { CoworkStore } from './coworkStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: BetterSqlite3.Database;
let store: CoworkStore;

/** Initialise a fresh in-memory database with the minimum schema. */
function setupDb(): void {
  db = new BetterSqlite3(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      pinned INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      model_override TEXT NOT NULL DEFAULT '',
      execution_mode TEXT NOT NULL DEFAULT 'local',
      active_skill_ids TEXT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      sequence INTEGER,
      FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      identity TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'custom',
      preset_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_user_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      fingerprint TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      is_explicit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
  `);

  // CoworkStore only needs (db)
  store = new CoworkStore(db);
}

/** Insert a session row directly. */
function insertSession(id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO cowork_sessions (id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids, agent_id, created_at, updated_at)
     VALUES (?, 'test', NULL, 'idle', 0, '/tmp', '', 'local', '[]', 'main', ?, ?)`,
  ).run(id, now, now);
}

/** Insert a message row directly, bypassing CoworkStore.addMessage. */
function insertMessage(
  id: string,
  sessionId: string,
  type: string,
  content: string,
  metadata: string | null,
  sequence: number,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, type, content, metadata, now, sequence);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupDb();
});

test('getSession returns all messages when one has corrupt metadata', () => {
  const sid = 'sess-1';
  insertSession(sid);

  insertMessage('msg-valid', sid, 'user', 'hello', '{"key":"value"}', 1);
  insertMessage('msg-corrupt', sid, 'tool_use', 'do something', '{broken', 2);
  insertMessage('msg-null', sid, 'assistant', 'reply', null, 3);

  const session = store.getSession(sid);
  expect(session).not.toBeNull();
  expect(session!.messages).toHaveLength(3);

  // Valid metadata preserved
  const validMsg = session!.messages.find((m) => m.id === 'msg-valid')!;
  expect(validMsg.metadata).toEqual({ key: 'value' });

  // Corrupt metadata discarded
  const corruptMsg = session!.messages.find((m) => m.id === 'msg-corrupt')!;
  expect(corruptMsg.metadata).toBeUndefined();
  expect(corruptMsg.content).toBe('do something');
  expect(corruptMsg.type).toBe('tool_use');

  // Null metadata → undefined
  const nullMsg = session!.messages.find((m) => m.id === 'msg-null')!;
  expect(nullMsg.metadata).toBeUndefined();
});

test('getSession returns all messages when ALL have corrupt metadata', () => {
  const sid = 'sess-2';
  insertSession(sid);

  insertMessage('m1', sid, 'user', 'one', '{bad1', 1);
  insertMessage('m2', sid, 'assistant', 'two', '{{bad2', 2);
  insertMessage('m3', sid, 'tool_use', 'three', 'not json at all', 3);

  const session = store.getSession(sid);
  expect(session).not.toBeNull();
  expect(session!.messages).toHaveLength(3);

  for (const msg of session!.messages) {
    expect(msg.metadata).toBeUndefined();
    expect(msg.id).toBeTruthy();
    expect(msg.content).toBeTruthy();
  }
});

test('console.warn is called exactly once for single corrupt metadata row', () => {
  const sid = 'sess-3';
  insertSession(sid);

  insertMessage('msg-ok', sid, 'user', 'hi', '{"a":1}', 1);
  insertMessage('msg-bad', sid, 'tool_use', 'oops', '{broken', 2);
  insertMessage('msg-nil', sid, 'assistant', 'reply', null, 3);

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  store.getSession(sid);

  expect(warnSpy).toHaveBeenCalledTimes(1);

  const warnMessage = warnSpy.mock.calls[0][0] as string;
  expect(warnMessage).toContain('[CoworkStore]');
  expect(warnMessage).toContain('msg-bad');
  expect(warnMessage).toContain(sid);

  warnSpy.mockRestore();
});

test('no console.warn when all metadata is valid or null', () => {
  const sid = 'sess-4';
  insertSession(sid);

  insertMessage('m1', sid, 'user', 'hi', '{"ok":true}', 1);
  insertMessage('m2', sid, 'assistant', 'reply', null, 2);

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  store.getSession(sid);

  expect(warnSpy).not.toHaveBeenCalled();

  warnSpy.mockRestore();
});

test('getConfig defaults skipMissedJobs to true when config is missing', () => {
  const config = store.getConfig();

  expect(config.skipMissedJobs).toBe(true);
});

test('backfillEmptyAgentModels assigns the current default model to empty agents only', () => {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, name, model, icon, skill_ids, enabled, is_default, source, preset_id, description, system_prompt, identity, created_at, updated_at)
     VALUES
     ('main', 'main', '', '', '[]', 1, 1, 'custom', '', '', '', '', ?, ?),
     ('writer', 'Writer', '', '', '[]', 1, 0, 'custom', '', '', '', '', ?, ?),
     ('stockexpert', 'Stock Expert', 'qwen3.5-plus', '', '[]', 1, 0, 'preset', 'stockexpert', '', '', '', ?, ?)`,
  ).run(now, now, now, now, now, now);

  expect(store.backfillEmptyAgentModels('deepseek-v3.2')).toBe(2);

  const rows = (db.prepare(`SELECT id, model FROM agents ORDER BY id`).all() as Array<{ id: string; model: string }>).map((r) => [r.id, r.model]);
  expect(rows).toEqual([
    ['main', 'deepseek-v3.2'],
    ['stockexpert', 'qwen3.5-plus'],
    ['writer', 'deepseek-v3.2'],
  ]);
});
