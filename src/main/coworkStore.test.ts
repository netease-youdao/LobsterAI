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

import { CoworkSystemMessageKind } from '../common/coworkSystemMessages';
import { AgentAvatarSvg, DefaultAgentAvatarIcon, encodeAgentAvatarIcon } from '../shared/agent/avatar';
import { CoworkForkMode } from '../shared/cowork/constants';
import { CoworkStore } from './coworkStore';
import { ContinuityCapsuleSource } from './libs/agentEngine/coworkContinuityCapsule';

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
      pin_order INTEGER,
      cwd TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      model_override TEXT NOT NULL DEFAULT '',
      execution_mode TEXT NOT NULL DEFAULT 'local',
      active_skill_ids TEXT,
      agent_id TEXT DEFAULT 'main',
      parent_session_id TEXT,
      forked_from_message_id TEXT,
      forked_at INTEGER,
      fork_mode TEXT NOT NULL DEFAULT 'none',
      fork_workspace_path TEXT,
      fork_git_branch TEXT,
      fork_git_base_ref TEXT,
      goal_json TEXT,
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
      working_directory TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      pin_order INTEGER,
      is_default INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'custom',
      preset_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.75,
      is_explicit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memory_sources (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      role TEXT NOT NULL DEFAULT 'system',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
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
function insertSession(
  id: string,
  agentId: string | null = 'main',
  title = 'test',
  updatedAt = Date.now(),
  pinned = 0,
  pinOrder: number | null = null,
): void {
  const now = updatedAt;
  db.prepare(
    `INSERT INTO cowork_sessions (id, title, claude_session_id, status, pinned, pin_order, cwd, system_prompt, execution_mode, active_skill_ids, agent_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'idle', ?, ?, '/tmp', '', 'local', '[]', ?, ?, ?)`,
  ).run(id, title, pinned, pinOrder, agentId, now, now);
}

/** Insert a message row directly, bypassing CoworkStore.addMessage. */
function insertMessage(
  id: string,
  sessionId: string,
  type: string,
  content: string,
  metadata: string | null,
  sequence: number,
  createdAt = Date.now(),
): void {
  db.prepare(
    `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, type, content, metadata, createdAt, sequence);
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

test('searchSessions finds matching titles beyond the recent page', () => {
  for (let index = 0; index < 105; index += 1) {
    insertSession(`recent-${index}`, 'main', `Recent filler ${index}`, 2000 + index);
  }
  insertSession('deep-match', 'main', 'Deep history search needle', 1000);

  expect(store.listSessions(100, 0).some((session) => session.id === 'deep-match')).toBe(false);

  const results = store.searchSessions({
    query: 'history search needle',
    limit: 10,
    offset: 0,
  });

  expect(results.map((session) => session.id)).toEqual(['deep-match']);
  expect(store.countSearchSessions({ query: 'history search needle' })).toBe(1);
});

test('searchSessions preserves pinned ordering and pagination', () => {
  insertSession('unpinned-old', 'main', 'Shared searchable task', 1000);
  insertSession('unpinned-new', 'main', 'Shared searchable task', 3000);
  insertSession('pinned-second', 'main', 'Shared searchable task', 2000, 1, 20);
  insertSession('pinned-first', 'main', 'Shared searchable task', 1500, 1, 10);

  const firstPage = store.searchSessions({
    query: 'searchable',
    limit: 3,
    offset: 0,
  });
  const secondPage = store.searchSessions({
    query: 'searchable',
    limit: 3,
    offset: 3,
  });

  expect(firstPage.map((session) => session.id)).toEqual([
    'pinned-first',
    'pinned-second',
    'unpinned-new',
  ]);
  expect(secondPage.map((session) => session.id)).toEqual(['unpinned-old']);
});

test('searchSessions treats LIKE wildcard characters as literal input', () => {
  insertSession('literal-wildcards', 'main', 'Report 100%_complete marker', 1000);
  insertSession('expanded-match', 'main', 'Report 100AAcomplete marker', 2000);

  const results = store.searchSessions({
    query: '100%_complete',
    limit: 10,
    offset: 0,
  });

  expect(results.map((session) => session.id)).toEqual(['literal-wildcards']);
  expect(store.countSearchSessions({ query: '100%_complete' })).toBe(1);
});

test('searchSessions can be limited to one agent', () => {
  insertSession('main-task', 'main', 'Agent scoped search task', 1000);
  insertSession('writer-task', 'writer', 'Agent scoped search task', 2000);

  const results = store.searchSessions({
    query: 'scoped search',
    agentId: 'writer',
    limit: 10,
    offset: 0,
  });

  expect(results.map((session) => session.id)).toEqual(['writer-task']);
  expect(store.countSearchSessions({ query: 'scoped search', agentId: 'writer' })).toBe(1);
});

test('continuity capsule upsert stores one rolling capsule per session', () => {
  const sid = 'capsule-session';
  insertSession(sid);

  store.upsertContinuityCapsule(sid, {
    version: 1,
    sessionId: sid,
    revision: 1,
    updatedAt: 100,
    lastSource: ContinuityCapsuleSource.UserMessage,
    currentObjective: 'Improve compaction continuity.',
    userConstraints: ['Do not change user model.'],
    decisions: [],
    recentActions: [],
    touchedFiles: [],
    keySymbols: [],
    verification: [],
    nextSteps: ['Add bridge injection.'],
    recentFailures: [],
    activeCapabilities: [],
    openQuestions: [],
  });
  store.upsertContinuityCapsule(sid, {
    version: 1,
    sessionId: sid,
    revision: 2,
    updatedAt: 200,
    lastSource: ContinuityCapsuleSource.PreCompaction,
    lastCompactedAt: 200,
    currentObjective: 'Improve compaction continuity.',
    userConstraints: ['Do not change user model.'],
    decisions: ['Use a session capsule row.'],
    recentActions: [],
    touchedFiles: [{ path: 'src/main/coworkStore.ts' }],
    keySymbols: [],
    verification: [],
    nextSteps: ['Inject bridge.'],
    recentFailures: [],
    activeCapabilities: [],
    openQuestions: [],
  });

  const rows = db.prepare('SELECT COUNT(*) AS count FROM cowork_session_capsules WHERE session_id = ?').get(sid) as { count: number };
  const capsule = store.getContinuityCapsule(sid);

  expect(rows.count).toBe(1);
  expect(capsule?.revision).toBe(2);
  expect(capsule?.lastCompactedAt).toBe(200);
  expect(capsule?.touchedFiles[0]?.path).toBe('src/main/coworkStore.ts');
});

test('deleteSession removes the continuity capsule row', () => {
  const sid = 'capsule-delete';
  insertSession(sid);
  store.upsertContinuityCapsule(sid, {
    version: 1,
    sessionId: sid,
    revision: 1,
    updatedAt: 100,
    lastSource: ContinuityCapsuleSource.UserMessage,
    userConstraints: [],
    decisions: [],
    recentActions: [],
    touchedFiles: [],
    keySymbols: [],
    verification: [],
    nextSteps: [],
    recentFailures: [],
    activeCapabilities: [],
    openQuestions: [],
  });

  store.deleteSession(sid);

  const rows = db.prepare('SELECT COUNT(*) AS count FROM cowork_session_capsules WHERE session_id = ?').get(sid) as { count: number };
  expect(rows.count).toBe(0);
});

test('forkSession copies the source continuity capsule to the forked session', () => {
  const source = store.createSession('Source', '/tmp');
  store.upsertContinuityCapsule(source.id, {
    version: 1,
    sessionId: source.id,
    revision: 3,
    updatedAt: 100,
    lastSource: ContinuityCapsuleSource.PostRun,
    currentObjective: 'Keep context after compaction.',
    userConstraints: [],
    decisions: ['Use a dedicated capsule table.'],
    recentActions: [],
    touchedFiles: [{ path: 'src/main/libs/agentEngine/openclawRuntimeAdapter.ts' }],
    keySymbols: [],
    verification: [],
    nextSteps: ['Inject capsule bridge.'],
    recentFailures: [],
    activeCapabilities: [],
    openQuestions: [],
  });

  const forked = store.forkSession({
    sourceSessionId: source.id,
    forkMode: CoworkForkMode.Conversation,
  });
  const capsule = store.getContinuityCapsule(forked.id);

  expect(capsule?.sessionId).toBe(forked.id);
  expect(capsule?.revision).toBe(1);
  expect(capsule?.lastSource).toBe(ContinuityCapsuleSource.Fork);
  expect(capsule?.currentObjective).toBe('Keep context after compaction.');
});

test('main agent lists legacy sessions with null agent id', () => {
  insertSession('legacy-main', null);
  insertSession('empty-main', '');
  insertSession('explicit-main', 'main');

  expect(store.countSessions('main')).toBe(3);
  expect(store.listSessions(20, 0, 'main').map(session => session.id).sort()).toEqual([
    'empty-main',
    'explicit-main',
    'legacy-main',
  ]);
});

test('replaceConversationMessages preserves existing timestamps and uses gateway timestamps', () => {
  const sid = 'sess-replace-timestamps';
  insertSession(sid, 'main', 'test', 500);

  insertMessage('msg-user', sid, 'user', 'old user', '{}', 1, 1000);
  insertMessage('msg-assistant', sid, 'assistant', 'old assistant', '{}', 2, 2000);

  store.replaceConversationMessages(sid, [
    { role: 'user', text: 'old user' },
    { role: 'assistant', text: 'old assistant' },
    { role: 'user', text: 'new user', timestamp: 3000 },
  ]);

  const session = store.getSession(sid);
  expect(session?.messages.map((message) => ({
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
  }))).toEqual([
    { type: 'user', content: 'old user', timestamp: 1000 },
    { type: 'assistant', content: 'old assistant', timestamp: 2000 },
    { type: 'user', content: 'new user', timestamp: 3000 },
  ]);
  expect(session?.updatedAt).toBe(3000);
});

test('replaceConversationMessages never moves the session updated time backwards', () => {
  const sid = 'sess-replace-backwards';
  insertSession(sid, 'main', 'test', 5000);

  store.replaceConversationMessages(sid, [
    { role: 'user', text: 'old prompt', timestamp: 3000 },
    { role: 'assistant', text: 'old reply', timestamp: 3500 },
  ]);

  expect(store.getSession(sid)?.updatedAt).toBe(5000);
});

test('replaceConversationMessages ignores assistant-only entries for the updated time', () => {
  const sid = 'sess-replace-assistant-only';
  insertSession(sid, 'main', 'test', 2000);

  store.replaceConversationMessages(sid, [
    { role: 'assistant', text: 'streamed reply', timestamp: 9000 },
  ]);

  expect(store.getSession(sid)?.updatedAt).toBe(2000);
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

test('updateMessage preserves the session updated time', () => {
  const sid = 'sess-update-time';
  insertSession(sid);
  insertMessage('msg-edit', sid, 'assistant', 'draft', null, 1);
  db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(1000, sid);
  db.prepare('UPDATE cowork_messages SET created_at = ? WHERE id = ?').run(1000, 'msg-edit');

  store.updateMessage(sid, 'msg-edit', { content: 'final' });

  const session = store.getSession(sid);
  expect(session?.updatedAt).toBe(1000);
  expect(session?.messages[0]?.content).toBe('final');
});

test('addMessage refreshes the session updated time only for user messages', () => {
  const sid = 'sess-add-message-time';
  insertSession(sid);
  db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(1000, sid);

  store.addMessage(sid, { type: 'assistant', content: 'streamed reply' });
  expect(store.getSession(sid)?.updatedAt).toBe(1000);

  store.addMessage(sid, { type: 'tool_use', content: 'tool call' });
  expect(store.getSession(sid)?.updatedAt).toBe(1000);

  const beforeUserMessage = Date.now();
  store.addMessage(sid, { type: 'user', content: 'follow up' });
  expect(store.getSession(sid)?.updatedAt).toBeGreaterThanOrEqual(beforeUserMessage);
});

test('updateSession refreshes the session updated time on a status transition', () => {
  const sid = 'sess-update-session-time';
  insertSession(sid);
  db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(1000, sid);

  const beforeUpdate = Date.now();

  store.updateSession(sid, { status: 'completed' });

  const session = store.getSession(sid);
  expect(session?.status).toBe('completed');
  expect(session?.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
});

test('updateSession keeps the session updated time when status is unchanged', () => {
  const sid = 'sess-status-noop';
  insertSession(sid);
  db.prepare("UPDATE cowork_sessions SET status = 'running', updated_at = ? WHERE id = ?").run(1000, sid);

  store.updateSession(sid, { status: 'running' });

  const session = store.getSession(sid);
  expect(session?.status).toBe('running');
  expect(session?.updatedAt).toBe(1000);
});

test('updateSession leaves the session updated time by default for non-status updates', () => {
  const sid = 'sess-title-default';
  insertSession(sid);
  db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(1000, sid);

  store.updateSession(sid, { title: 'Renamed without touch' });

  const session = store.getSession(sid);
  expect(session?.title).toBe('Renamed without touch');
  expect(session?.updatedAt).toBe(1000);
});

test('updateSession can patch model override without refreshing the session updated time', () => {
  const sid = 'sess-model-only';
  insertSession(sid);
  db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(1000, sid);

  store.updateSession(
    sid,
    { modelOverride: 'lobsterai-server/qwen3.6-plus-YoudaoInner' },
    { touchUpdatedAt: false },
  );

  const session = store.getSession(sid);
  expect(session?.modelOverride).toBe('lobsterai-server/qwen3.6-plus-YoudaoInner');
  expect(session?.updatedAt).toBe(1000);
});

test('updateSession can rename without refreshing the session updated time', () => {
  const sid = 'sess-title-only';
  insertSession(sid);
  db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(1000, sid);

  store.updateSession(sid, { title: 'Renamed task' }, { touchUpdatedAt: false });

  const session = store.getSession(sid);
  expect(session?.title).toBe('Renamed task');
  expect(session?.updatedAt).toBe(1000);
});

test('deleteSession removes messages without relying on foreign key cascade', () => {
  const sid = 'sess-delete-hard';
  insertSession(sid);
  insertMessage('msg-delete-hard', sid, 'user', 'remove me', '{}', 1);

  store.deleteSession(sid);

  expect(store.getSession(sid)).toBeNull();
  const messageCount = db
    .prepare('SELECT COUNT(*) AS count FROM cowork_messages WHERE session_id = ?')
    .get(sid) as { count: number };
  expect(messageCount.count).toBe(0);
});

test('forkSession copies stable history and records fork metadata', () => {
  const sid = 'sess-fork-source';
  insertSession(sid);
  insertMessage('msg-user', sid, 'user', 'start here', '{"keep":true}', 1, 1000);
  insertMessage(
    'msg-streaming',
    sid,
    'assistant',
    'unfinished draft',
    '{"isStreaming":true,"toolUseId":"tool-live"}',
    2,
    2000,
  );
  insertMessage(
    'msg-assistant',
    sid,
    'assistant',
    'finished answer',
    '{"toolUseId":"tool-done","requestId":"req-1","keep":"yes"}',
    3,
    3000,
  );

  const fork = store.forkSession({
    sourceSessionId: sid,
    forkedFromMessageId: 'msg-assistant',
  });

  expect(fork.id).not.toBe(sid);
  expect(fork.title).toBe('test (fork)');
  expect(fork.cwd).toBe('/tmp');
  expect(fork.status).toBe('idle');
  expect(fork.parentSessionId).toBe(sid);
  expect(fork.forkedFromMessageId).toBe('msg-assistant');
  expect(fork.forkMode).toBe(CoworkForkMode.Conversation);
  expect(fork.messages).toHaveLength(2);
  expect(fork.messages.map((message) => message.content)).toEqual(['start here', 'finished answer']);
  expect(fork.messages.every((message) => !['msg-user', 'msg-assistant'].includes(message.id))).toBe(true);
  expect(fork.messages[0].metadata).toEqual({ keep: true });
  expect(fork.messages[1].metadata).toEqual({ keep: 'yes' });

  const forkRows = db
    .prepare('SELECT content, sequence FROM cowork_messages WHERE session_id = ? ORDER BY sequence ASC')
    .all(fork.id) as Array<{ content: string; sequence: number | null }>;
  expect(forkRows).toEqual([
    { content: 'start here', sequence: 1 },
    { content: 'finished answer', sequence: 3 },
  ]);
});

test('forkSession keeps the selected plan message when its streaming flag is stale', () => {
  const sid = 'sess-fork-stale-plan';
  insertSession(sid);
  insertMessage('msg-user-plan', sid, 'user', 'Create a plan', null, 1, 1000);
  insertMessage(
    'msg-plan',
    sid,
    'assistant',
    '<proposed_plan>\n## Summary\n- Build the page.\n</proposed_plan>',
    '{"isStreaming":true,"isFinal":false}',
    2,
    2000,
  );

  const fork = store.forkSession({
    sourceSessionId: sid,
    forkedFromMessageId: 'msg-plan',
  });

  expect(fork.messages).toHaveLength(2);
  expect(fork.messages[1].content).toContain('<proposed_plan>');
  expect(fork.messages[1].metadata).toEqual({ isFinal: true });
});

test('forkSession remaps selected text source message ids', () => {
  const sid = 'sess-fork-selected-text';
  insertSession(sid);
  insertMessage('msg-assistant-source', sid, 'assistant', 'source answer', null, 1, 1000);
  insertMessage(
    'msg-user-selected-text',
    sid,
    'user',
    'follow up',
    JSON.stringify({
      selectedTextSnippets: [{
        id: 'snippet-1',
        text: 'source answer',
        sourceMessageId: 'msg-assistant-source',
        sourceMessageType: 'assistant',
        createdAt: 2000,
      }],
    }),
    2,
    2000,
  );

  const fork = store.forkSession({
    sourceSessionId: sid,
    forkedFromMessageId: 'msg-user-selected-text',
  });

  expect(fork.messages[1].metadata?.selectedTextSnippets?.[0].sourceMessageId).toBe(fork.messages[0].id);
});

test('forkSession can persist hidden compaction bridge messages', () => {
  const sid = 'sess-fork-compacted-source';
  insertSession(sid);
  insertMessage('msg-user', sid, 'user', 'continue the plan', null, 1, 1000);

  const fork = store.forkSession({
    sourceSessionId: sid,
    contextMessages: [{
      content: 'The source session was compacted after deciding the implementation plan.',
      metadata: {
        kind: CoworkSystemMessageKind.ForkCompactionSummary,
        sourceSessionId: sid,
        sourceSessionKey: 'agent:main:session:sess-fork-compacted-source',
        checkpointId: 'checkpoint-1',
      },
    }],
  });

  expect(fork.messages).toHaveLength(2);
  const summaryMessage = fork.messages.find((message) => (
    message.metadata?.kind === CoworkSystemMessageKind.ForkCompactionSummary
  ));
  expect(summaryMessage?.type).toBe('system');
  expect(summaryMessage?.content).toContain('source session was compacted');
  expect(summaryMessage?.metadata).toMatchObject({
    hidden: true,
    kind: CoworkSystemMessageKind.ForkCompactionSummary,
    sourceSessionId: sid,
    checkpointId: 'checkpoint-1',
  });
  expect(fork.messages.some((message) => message.content === 'continue the plan')).toBe(true);
});

test('forkSession skips compaction bridge messages newer than the fork point', () => {
  const sid = 'sess-fork-compaction-boundary';
  insertSession(sid);
  insertMessage('msg-early', sid, 'assistant', 'early answer', null, 1, 1000);
  insertMessage('msg-late', sid, 'assistant', 'late answer', null, 2, 3000);

  const fork = store.forkSession({
    sourceSessionId: sid,
    forkedFromMessageId: 'msg-early',
    contextMessages: [{
      content: 'This summary was created after the selected fork point.',
      metadata: {
        kind: CoworkSystemMessageKind.ForkCompactionSummary,
        checkpointCreatedAt: 2000,
      },
    }],
  });

  expect(fork.messages.map((message) => message.content)).toEqual(['early answer']);
  expect(fork.messages.every((message) => (
    message.metadata?.kind !== CoworkSystemMessageKind.ForkCompactionSummary
  ))).toBe(true);
});

test('forkSession inherits one compaction bridge message when a fork is forked again', () => {
  const sid = 'sess-fork-compaction-inheritance';
  insertSession(sid);
  insertMessage('msg-answer', sid, 'assistant', 'original answer', null, 1, 1000);

  const firstFork = store.forkSession({
    sourceSessionId: sid,
    contextMessages: [{
      content: 'Inherited compacted context.',
      metadata: {
        kind: CoworkSystemMessageKind.ForkCompactionSummary,
        checkpointCreatedAt: 500,
      },
    }],
  });

  const secondFork = store.forkSession({
    sourceSessionId: firstFork.id,
    forkedFromMessageId: firstFork.messages.find((message) => message.content === 'original answer')?.id,
  });
  const summaries = secondFork.messages.filter((message) => (
    message.metadata?.kind === CoworkSystemMessageKind.ForkCompactionSummary
  ));

  expect(summaries).toHaveLength(1);
  expect(summaries[0].content).toBe('Inherited compacted context.');
});

test('forkSession prefers a new compaction bridge over an inherited summary', () => {
  const sid = 'sess-fork-compaction-replacement';
  insertSession(sid);
  insertMessage('msg-answer', sid, 'assistant', 'original answer', null, 1, 1000);

  const firstFork = store.forkSession({
    sourceSessionId: sid,
    contextMessages: [{
      content: 'Older compacted context.',
      metadata: {
        kind: CoworkSystemMessageKind.ForkCompactionSummary,
        checkpointCreatedAt: 500,
      },
    }],
  });
  const secondFork = store.forkSession({
    sourceSessionId: firstFork.id,
    contextMessages: [{
      content: 'Newer compacted context.',
      metadata: {
        kind: CoworkSystemMessageKind.ForkCompactionSummary,
        checkpointCreatedAt: 1500,
      },
    }],
  });
  const summaries = secondFork.messages.filter((message) => (
    message.metadata?.kind === CoworkSystemMessageKind.ForkCompactionSummary
  ));

  expect(summaries).toHaveLength(1);
  expect(summaries[0].content).toBe('Newer compacted context.');
});

test('agent CRUD stores working directory independently', () => {
  const agent = store.createAgent({
    name: 'Docs Agent',
    model: 'openai/gpt-4o',
    workingDirectory: '/tmp/docs-project',
  });

  expect(agent.workingDirectory).toBe('/tmp/docs-project');

  const updated = store.updateAgent(agent.id, {
    workingDirectory: '/tmp/docs-next',
  });

  expect(updated?.workingDirectory).toBe('/tmp/docs-next');
  expect(store.getAgent(agent.id)?.workingDirectory).toBe('/tmp/docs-next');
});

test('deleteAgent removes its task history before an agent with the same name is recreated', () => {
  const agent = store.createAgent({ name: 'Docs Agent' });
  const session = store.createSession('Old Docs Task', '/tmp/docs-project', '', 'local', [], agent.id);
  insertMessage('msg-agent-delete', session.id, 'assistant', 'old result', '{}', 1);

  expect(store.listSessionIdsByAgent(agent.id)).toEqual([session.id]);
  expect(store.deleteAgent(agent.id)).toBe(true);

  expect(store.getAgent(agent.id)).toBeNull();
  expect(store.listSessions(20, 0, agent.id)).toEqual([]);
  const messageCount = db
    .prepare('SELECT COUNT(*) AS count FROM cowork_messages WHERE session_id = ?')
    .get(session.id) as { count: number };
  expect(messageCount.count).toBe(0);

  const recreated = store.createAgent({ name: 'Docs Agent' });
  expect(recreated.id).toBe(agent.id);
  expect(store.listSessions(20, 0, recreated.id)).toEqual([]);
});

test('createAgent clears orphaned task history left by legacy agent deletion', () => {
  const agent = store.createAgent({ name: 'Legacy Deleted Agent' });
  const session = store.createSession('Legacy Orphan Task', '/tmp/docs-project', '', 'local', [], agent.id);
  insertMessage('msg-legacy-orphan', session.id, 'assistant', 'legacy result', '{}', 1);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);

  const recreated = store.createAgent({ name: 'Legacy Deleted Agent' });

  expect(recreated.id).toBe(agent.id);
  expect(store.listSessions(20, 0, recreated.id)).toEqual([]);
  const messageCount = db
    .prepare('SELECT COUNT(*) AS count FROM cowork_messages WHERE session_id = ?')
    .get(session.id) as { count: number };
  expect(messageCount.count).toBe(0);
});

test('agent CRUD normalizes legacy icons to the default svg avatar', () => {
  const designedIcon = encodeAgentAvatarIcon({
    svg: AgentAvatarSvg.Artboard,
  });

  const missingIconAgent = store.createAgent({ name: 'Missing Icon Agent' });
  const legacyIconAgent = store.createAgent({ name: 'Legacy Icon Agent', icon: 'legacy-icon' });
  const legacyDesignedIconAgent = store.createAgent({
    name: 'Legacy Designed Icon Agent',
    icon: 'agent-avatar:blue:code',
  });
  const designedIconAgent = store.createAgent({ name: 'Designed Icon Agent', icon: designedIcon });

  expect(missingIconAgent.icon).toBe(DefaultAgentAvatarIcon);
  expect(legacyIconAgent.icon).toBe(DefaultAgentAvatarIcon);
  expect(legacyDesignedIconAgent.icon).toBe(DefaultAgentAvatarIcon);
  expect(designedIconAgent.icon).toBe(designedIcon);

  const updated = store.updateAgent(designedIconAgent.id, { icon: 'legacy-icon' });
  expect(updated?.icon).toBe(DefaultAgentAvatarIcon);
});

test('agent pinning stores first-pinned-first order', () => {
  const first = store.createAgent({ name: 'First Agent' });
  const second = store.createAgent({ name: 'Second Agent' });

  const pinnedFirst = store.updateAgent(first.id, { pinned: true });
  const pinnedSecond = store.updateAgent(second.id, { pinned: true });

  expect(pinnedFirst?.pinned).toBe(true);
  expect(pinnedSecond?.pinned).toBe(true);
  expect(pinnedFirst?.pinOrder).toBe(1);
  expect(pinnedSecond?.pinOrder).toBe(2);
});

test('agent unpinning clears pin order', () => {
  const agent = store.createAgent({ name: 'Pinned Agent' });
  store.updateAgent(agent.id, { pinned: true });

  const unpinned = store.updateAgent(agent.id, { pinned: false });

  expect(unpinned?.pinned).toBe(false);
  expect(unpinned?.pinOrder).toBeNull();
});

test('getConfig defaults skipMissedJobs to true when config is missing', () => {
  const config = store.getConfig();

  expect(config.skipMissedJobs).toBe(true);
});

test('getConfig defaults OpenClaw heartbeat to enabled when config is missing', () => {
  const config = store.getConfig();

  expect(config.openClawHeartbeatEnabled).toBe(true);
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
