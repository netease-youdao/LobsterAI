import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

import { deriveForkToolUseId, repairForkedSessionToolUseIds } from './coworkForkToolUseIds';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      forked_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      sequence INTEGER
    );
  `);
});

const insertSession = (id: string, parentSessionId: string | null, forkedAt: number | null, createdAt = forkedAt ?? 0): void => {
  db.prepare('INSERT INTO cowork_sessions (id, parent_session_id, forked_at, created_at) VALUES (?, ?, ?, ?)')
    .run(id, parentSessionId, forkedAt, createdAt);
};

const insertMessage = (
  id: string,
  sessionId: string,
  type: string,
  metadata: Record<string, unknown> | string | null,
  sequence: number | null,
  createdAt: number,
): void => {
  const metadataJson = metadata === null || typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  db.prepare(`
    INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
    VALUES (?, ?, ?, '', ?, ?, ?)
  `).run(id, sessionId, type, metadataJson, createdAt, sequence);
};

const getToolUseId = (messageId: string): unknown => {
  const row = db.prepare('SELECT metadata FROM cowork_messages WHERE id = ?').get(messageId) as { metadata: string | null };
  return row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>).toolUseId : undefined;
};

/** Parallel calls: both calls are stored before either result, and results arrive out of order. */
const insertParallelToolCalls = (sessionId: string, prefix: string, toolUseIds: [string, string] | null): void => {
  const [first, second] = toolUseIds ?? [null, null];
  const withId = (toolUseId: string | null, extra: Record<string, unknown>) => (
    toolUseId ? { ...extra, toolUseId } : extra
  );
  insertMessage(`${prefix}-use-1`, sessionId, 'tool_use', withId(first, { toolName: 'write' }), 2, 2000);
  insertMessage(`${prefix}-use-2`, sessionId, 'tool_use', withId(second, { toolName: 'write' }), 3, 2001);
  insertMessage(`${prefix}-result-2`, sessionId, 'tool_result', withId(second, { toolResult: 'wrote 2' }), 4, 2002);
  insertMessage(`${prefix}-result-1`, sessionId, 'tool_result', withId(first, { toolResult: 'wrote 1' }), 5, 2003);
};

describe('deriveForkToolUseId', () => {
  test('maps one source id to one fork id, distinct per fork and per source id', () => {
    const id = deriveForkToolUseId('fork-a', 'call_00_abc');
    expect(deriveForkToolUseId('fork-a', 'call_00_abc')).toBe(id);
    expect(deriveForkToolUseId('fork-b', 'call_00_abc')).not.toBe(id);
    expect(deriveForkToolUseId('fork-a', 'call_01_abc')).not.toBe(id);
    expect(id).not.toContain('call_00_abc');
  });
});

describe('repairForkedSessionToolUseIds', () => {
  test('restores pairs for parallel tool calls copied into a fork', () => {
    insertSession('source', null, null, 1000);
    insertParallelToolCalls('source', 'src', ['call-1', 'call-2']);
    insertSession('fork', 'source', 5000);
    insertParallelToolCalls('fork', 'fork', null);

    expect(repairForkedSessionToolUseIds(db)).toBe(4);

    expect(getToolUseId('fork-use-1')).toBe(deriveForkToolUseId('fork', 'call-1'));
    expect(getToolUseId('fork-result-1')).toBe(deriveForkToolUseId('fork', 'call-1'));
    expect(getToolUseId('fork-use-2')).toBe(deriveForkToolUseId('fork', 'call-2'));
    expect(getToolUseId('fork-result-2')).toBe(deriveForkToolUseId('fork', 'call-2'));
    const repaired = db.prepare('SELECT metadata FROM cowork_messages WHERE id = ?').get('fork-use-1') as { metadata: string };
    expect(JSON.parse(repaired.metadata)).toMatchObject({ toolName: 'write' });
    expect(getToolUseId('src-use-1')).toBe('call-1');
  });

  test('repairs a fork of a fork from ids its parent got back', () => {
    insertSession('source', null, null, 1000);
    insertParallelToolCalls('source', 'src', ['call-1', 'call-2']);
    insertSession('fork-child', 'fork-parent', 6000);
    insertParallelToolCalls('fork-child', 'child', null);
    insertSession('fork-parent', 'source', 5000);
    insertParallelToolCalls('fork-parent', 'parent', null);

    expect(repairForkedSessionToolUseIds(db)).toBe(8);

    const parentId = deriveForkToolUseId('fork-parent', 'call-1');
    expect(getToolUseId('parent-use-1')).toBe(parentId);
    expect(getToolUseId('child-use-1')).toBe(deriveForkToolUseId('fork-child', parentId));
    expect(getToolUseId('child-result-1')).toBe(deriveForkToolUseId('fork-child', parentId));
  });

  test('leaves rows without a single parent match, and rows that already have an id', () => {
    insertSession('source', null, null, 1000);
    insertMessage('src-dup-a', 'source', 'tool_use', { toolUseId: 'call-a' }, null, 2000);
    insertMessage('src-dup-b', 'source', 'tool_use', { toolUseId: 'call-b' }, null, 2000);
    insertSession('fork', 'source', 5000);
    insertMessage('fork-ambiguous', 'fork', 'tool_use', { toolName: 'read' }, null, 2000);
    insertMessage('fork-no-source', 'fork', 'tool_result', { toolResult: 'x' }, 9, 3000);
    insertMessage('fork-own', 'fork', 'tool_use', { toolUseId: 'call-new' }, 10, 6000);
    insertMessage('fork-after-boundary', 'fork', 'tool_result', { toolResult: 'y' }, 11, 6001);
    insertMessage('fork-bad-json', 'fork', 'tool_use', '{"toolName":', 12, 2000);

    expect(repairForkedSessionToolUseIds(db)).toBe(0);
    expect(getToolUseId('fork-ambiguous')).toBeUndefined();
    expect(getToolUseId('fork-own')).toBe('call-new');
  });

  test('skips forks whose parent session was deleted, and is idempotent', () => {
    insertSession('orphan-fork', 'deleted-source', 5000);
    insertParallelToolCalls('orphan-fork', 'orphan', null);
    insertSession('source', null, null, 1000);
    insertParallelToolCalls('source', 'src', ['call-1', 'call-2']);
    insertSession('fork', 'source', 5000);
    insertParallelToolCalls('fork', 'fork', null);

    expect(repairForkedSessionToolUseIds(db)).toBe(4);
    expect(repairForkedSessionToolUseIds(db)).toBe(0);
    expect(getToolUseId('orphan-use-1')).toBeUndefined();
  });

  test('treats a database without fork columns as having nothing to repair', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        content TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL);
    `);
    expect(repairForkedSessionToolUseIds(legacyDb)).toBe(0);
    legacyDb.close();
  });

  test('restores ids on copied rows whose metadata was dropped entirely', () => {
    insertSession('source', null, null, 1000);
    insertMessage('src-use', 'source', 'tool_use', { toolUseId: 'call-1' }, 2, 2000);
    insertSession('fork', 'source', 5000);
    insertMessage('fork-use', 'fork', 'tool_use', null, 2, 2000);

    expect(repairForkedSessionToolUseIds(db)).toBe(1);
    expect(getToolUseId('fork-use')).toBe(deriveForkToolUseId('fork', 'call-1'));
  });
});
