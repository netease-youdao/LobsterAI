/**
 * Unit tests for coworkCompactor.ts:
 *   - estimateTokens(): token estimation heuristic
 *   - COMPACTION_CONSTANTS: constant values
 *   - parseCompactCommand(): command parsing
 *   - Cold Storage CRUD: SQLite operations
 */
import { vi, describe, test, expect, afterEach } from 'vitest';
import { estimateTokens, COMPACTION_CONSTANTS, parseCompactCommand, shouldAutoCompact, selectMessagesForCompaction, buildSummarizationPrompt, generateSummary, microCompactMessages, deleteSessionWithCleanup, isCompacting, setCompacting } from './coworkCompactor';
import type { CoworkMessage } from '../coworkStore';
import initSqlJs from 'sql.js';

describe('estimateTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('returns 2 for "hello" (5 chars / 3.5 = 1.43, ceil = 2)', () => {
    expect(estimateTokens('hello')).toBe(2);
  });

  test('returns 100 for 350 character string (350 / 3.5 = 100)', () => {
    const text = 'a'.repeat(350);
    expect(estimateTokens(text)).toBe(100);
  });

  test('returns a number >= 1 for multi-byte characters', () => {
    const text = '你好世界你好世界你好世界';
    const result = estimateTokens(text);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(1);
  });

  test('handles single character correctly', () => {
    expect(estimateTokens('a')).toBe(1); // 1 / 3.5 = 0.29, ceil = 1
  });

  test('handles whitespace without trimming', () => {
    const text = '   hello   '; // 11 chars
    expect(estimateTokens(text)).toBe(4); // 11 / 3.5 = 3.14, ceil = 4
  });
});

describe('COMPACTION_CONSTANTS', () => {
  test('CONTEXT_WINDOW_TOKENS equals 200000', () => {
    expect(COMPACTION_CONSTANTS.CONTEXT_WINDOW_TOKENS).toBe(200_000);
  });

  test('AUTO_COMPACT_THRESHOLD equals 0.85', () => {
    expect(COMPACTION_CONSTANTS.AUTO_COMPACT_THRESHOLD).toBe(0.85);
  });

  test('MICRO_COMPACT_KEEP_RECENT equals 3', () => {
    expect(COMPACTION_CONSTANTS.MICRO_COMPACT_KEEP_RECENT).toBe(3);
  });

  test('SUMMARY_MAX_INPUT_CHARS equals 80000', () => {
    expect(COMPACTION_CONSTANTS.SUMMARY_MAX_INPUT_CHARS).toBe(80_000);
  });

  test('SUMMARY_MAX_OUTPUT_CHARS equals 4000', () => {
    expect(COMPACTION_CONSTANTS.SUMMARY_MAX_OUTPUT_CHARS).toBe(4_000);
  });

  test('SUMMARY_TIMEOUT_MS equals 120000', () => {
    expect(COMPACTION_CONSTANTS.SUMMARY_TIMEOUT_MS).toBe(120_000);
  });

  test('MIN_MESSAGES_FOR_COMPACTION equals 6', () => {
    expect(COMPACTION_CONSTANTS.MIN_MESSAGES_FOR_COMPACTION).toBe(6);
  });

  test('has all 7 required keys', () => {
    const requiredKeys = [
      'CONTEXT_WINDOW_TOKENS',
      'AUTO_COMPACT_THRESHOLD',
      'MICRO_COMPACT_KEEP_RECENT',
      'SUMMARY_MAX_INPUT_CHARS',
      'SUMMARY_MAX_OUTPUT_CHARS',
      'SUMMARY_TIMEOUT_MS',
      'MIN_MESSAGES_FOR_COMPACTION',
    ];
    requiredKeys.forEach((key) => {
      expect(COMPACTION_CONSTANTS).toHaveProperty(key);
    });
  });
});

describe('parseCompactCommand', () => {
  test('/compact returns isCompact=true, focusHint=""', () => {
    const result = parseCompactCommand('/compact');
    expect(result).toEqual({ isCompact: true, focusHint: '' });
  });

  test('/compact focus on errors returns isCompact=true with hint', () => {
    const result = parseCompactCommand('/compact focus on errors');
    expect(result).toEqual({ isCompact: true, focusHint: 'focus on errors' });
  });

  test('/Compact (uppercase) case-insensitive', () => {
    const result = parseCompactCommand('/Compact');
    expect(result).toEqual({ isCompact: true, focusHint: '' });
  });

  test('/ compact (space after slash) is not matched', () => {
    const result = parseCompactCommand('/ compact');
    expect(result).toEqual({ isCompact: false, focusHint: '' });
  });

  test('regular message not matched', () => {
    const result = parseCompactCommand('regular message');
    expect(result).toEqual({ isCompact: false, focusHint: '' });
  });

  test('empty string is not matched', () => {
    const result = parseCompactCommand('');
    expect(result).toEqual({ isCompact: false, focusHint: '' });
  });

  test('/compactfoo (no word boundary) is not matched', () => {
    const result = parseCompactCommand('/compactfoo');
    expect(result).toEqual({ isCompact: false, focusHint: '' });
  });
});

describe('Cold Storage CRUD (real SQL)', () => {
  test('store and retrieve content', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS compaction_cold_storage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'tool_result',
        original_chars INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const testId = 'test-id-123';
    const testContent = 'This is stored content';
    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [testId, 'session-1', 'msg-1', testContent, 'tool_result', testContent.length, Date.now()]
    );

    const result = db.exec(
      `SELECT content FROM compaction_cold_storage WHERE id = ?`,
      [testId]
    );
    expect(result[0]?.values[0][0]).toBe(testContent);
  });

  test('list entries for session in created_at DESC order', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS compaction_cold_storage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'tool_result',
        original_chars INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-1', 'session-1', 'msg-1', 'content-1', 'tool_result', 9, now - 2000]
    );
    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-2', 'session-1', 'msg-2', 'content-2', 'tool_result', 9, now - 1000]
    );
    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-3', 'session-2', 'msg-3', 'content-3', 'tool_result', 9, now]
    );

    const result = db.exec(
      `SELECT id, session_id, message_id, content, content_type, original_chars, created_at FROM compaction_cold_storage WHERE session_id = ? ORDER BY created_at DESC`,
      ['session-1']
    );
    const rows = result[0]?.values || [];
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe('id-2');
    expect(rows[1][0]).toBe('id-1');
  });

  test('delete entries for session and return count', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS compaction_cold_storage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'tool_result',
        original_chars INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-1', 'session-1', 'msg-1', 'content-1', 'tool_result', 9, Date.now()]
    );
    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-2', 'session-1', 'msg-2', 'content-2', 'tool_result', 9, Date.now()]
    );
    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-3', 'session-2', 'msg-3', 'content-3', 'tool_result', 9, Date.now()]
    );

    db.run(`DELETE FROM compaction_cold_storage WHERE session_id = ?`, ['session-1']);
    const count = db.getRowsModified();
    expect(count).toBe(2);

    const remaining = db.exec(`SELECT COUNT(*) FROM compaction_cold_storage`);
    expect(remaining[0]?.values[0][0]).toBe(1);
  });

  test('session isolation - queries return only matching session', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS compaction_cold_storage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'tool_result',
        original_chars INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-1', 'session-a', 'msg-1', 'content-1', 'tool_result', 9, Date.now()]
    );
    db.run(
      `INSERT INTO compaction_cold_storage (id, session_id, message_id, content, content_type, original_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['id-2', 'session-b', 'msg-2', 'content-2', 'tool_result', 9, Date.now()]
    );

    const resultA = db.exec(
      `SELECT id FROM compaction_cold_storage WHERE session_id = ?`,
      ['session-a']
    );
    expect(resultA[0]?.values.length).toBe(1);
    expect(resultA[0]?.values[0][0]).toBe('id-1');

    const resultB = db.exec(
      `SELECT id FROM compaction_cold_storage WHERE session_id = ?`,
      ['session-b']
    );
    expect(resultB[0]?.values.length).toBe(1);
    expect(resultB[0]?.values[0][0]).toBe('id-2');
  });

  test('retrieve returns null for missing id', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS compaction_cold_storage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'tool_result',
        original_chars INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const result = db.exec(
      `SELECT content FROM compaction_cold_storage WHERE id = ?`,
      ['nonexistent-id']
    );
    expect(result[0]?.values).toBeFalsy();
  });
});

function makeMsg(id: string, type: CoworkMessage['type'], content: string): CoworkMessage {
  return { id, type, content, timestamp: Date.now() };
}

describe('shouldAutoCompact', () => {
  test('returns false for empty messages', () => {
    const result = shouldAutoCompact([]);
    expect(result.shouldCompact).toBe(false);
    expect(result.currentTokens).toBe(0);
    expect(result.usage).toBe(0);
  });

  test('returns false for fewer than MIN_MESSAGES (5 messages)', () => {
    const msgs = Array.from({ length: 5 }, (_, i) =>
      makeMsg(`m${i}`, 'user', 'x'.repeat(100_000))
    );
    const result = shouldAutoCompact(msgs);
    expect(result.shouldCompact).toBe(false);
    expect(result.currentTokens).toBe(0);
  });

  test('returns false when usage is below threshold (80%)', () => {
    const targetTokens = 200_000 * 0.80;
    const totalChars = Math.floor(targetTokens * 3.5);
    const perMsg = Math.floor(totalChars / 7);
    const msgs = Array.from({ length: 7 }, (_, i) =>
      makeMsg(`m${i}`, 'assistant', 'a'.repeat(perMsg))
    );
    const result = shouldAutoCompact(msgs);
    expect(result.shouldCompact).toBe(false);
    expect(result.usage).toBeLessThan(0.85);
  });

  test('returns true when usage exceeds threshold (86%)', () => {
    const targetTokens = 200_000 * 0.86;
    const totalChars = Math.ceil(targetTokens * 3.5);
    const perMsg = Math.ceil(totalChars / 7);
    const msgs = Array.from({ length: 7 }, (_, i) =>
      makeMsg(`m${i}`, 'user', 'b'.repeat(perMsg))
    );
    const result = shouldAutoCompact(msgs);
    expect(result.shouldCompact).toBe(true);
    expect(result.usage).toBeGreaterThanOrEqual(0.85);
  });

  test('returns diagnostic info with correct types', () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      makeMsg(`m${i}`, 'user', 'hello world')
    );
    const result = shouldAutoCompact(msgs);
    expect(typeof result.shouldCompact).toBe('boolean');
    expect(typeof result.currentTokens).toBe('number');
    expect(typeof result.threshold).toBe('number');
    expect(typeof result.usage).toBe('number');
    expect(result.threshold).toBe(200_000 * 0.85);
  });
});

describe('selectMessagesForCompaction', () => {
  test('keeps 30% (ceil) and compacts 70%', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg(`m${i}`, 'user', `msg-${i}`)
    );
    const { toKeep, toCompact } = selectMessagesForCompaction(msgs);
    expect(toKeep).toHaveLength(3);
    expect(toCompact).toHaveLength(7);
    expect(toKeep[0].id).toBe('m7');
    expect(toCompact[0].id).toBe('m0');
  });

  test('handles single message (ceil(0.3) = 1, keeps all)', () => {
    const msgs = [makeMsg('m0', 'user', 'only one')];
    const { toKeep, toCompact } = selectMessagesForCompaction(msgs);
    expect(toKeep).toHaveLength(1);
    expect(toCompact).toHaveLength(0);
  });

  test('preserves message order in both slices', () => {
    const msgs = Array.from({ length: 5 }, (_, i) =>
      makeMsg(`m${i}`, 'assistant', `content-${i}`)
    );
    const { toKeep, toCompact } = selectMessagesForCompaction(msgs);
    expect(toCompact.map(m => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(toKeep.map(m => m.id)).toEqual(['m3', 'm4']);
  });
});

describe('microCompactMessages', () => {
  function makeMsgWithSession(id: string, type: CoworkMessage['type'], content: string, sessionId = 'sess-1'): CoworkMessage {
    return { id, sessionId, type, content, timestamp: Date.now() } as CoworkMessage;
  }

  test('keeps all when 3 or fewer tool_results', () => {
    const msgs = [
      makeMsgWithSession('t1', 'tool_result', 'output-1'),
      makeMsgWithSession('t2', 'tool_result', 'output-2'),
      makeMsgWithSession('t3', 'tool_result', 'output-3'),
    ];
    const { messages, coldEntries } = microCompactMessages(msgs);
    expect(coldEntries).toHaveLength(0);
    expect(messages.map(m => m.content)).toEqual(['output-1', 'output-2', 'output-3']);
  });

  test('compacts oldest when 4 tool_results', () => {
    const msgs = [
      makeMsgWithSession('t1', 'tool_result', 'output-1'),
      makeMsgWithSession('t2', 'tool_result', 'output-2'),
      makeMsgWithSession('t3', 'tool_result', 'output-3'),
      makeMsgWithSession('t4', 'tool_result', 'output-4'),
    ];
    const { messages, coldEntries } = microCompactMessages(msgs);
    expect(coldEntries).toHaveLength(1);
    expect(coldEntries[0].messageId).toBe('t1');
    expect(coldEntries[0].content).toBe('output-1');
    expect(messages[0].content).toContain('cold storage');
    expect(messages[1].content).toBe('output-2');
    expect(messages[2].content).toBe('output-3');
    expect(messages[3].content).toBe('output-4');
  });

  test('compacts oldest 7 when 10 tool_results', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMsgWithSession(`t${i}`, 'tool_result', `output-${i}`)
    );
    const { messages, coldEntries } = microCompactMessages(msgs);
    expect(coldEntries).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      expect(coldEntries[i].messageId).toBe(`t${i}`);
      expect(messages[i].content).toContain('cold storage');
    }
    expect(messages[7].content).toBe('output-7');
    expect(messages[8].content).toBe('output-8');
    expect(messages[9].content).toBe('output-9');
  });

  test('never compacts user or assistant messages', () => {
    const msgs = [
      makeMsgWithSession('u1', 'user', 'question'),
      makeMsgWithSession('t1', 'tool_result', 'output-1'),
      makeMsgWithSession('a1', 'assistant', 'answer'),
      makeMsgWithSession('t2', 'tool_result', 'output-2'),
      makeMsgWithSession('t3', 'tool_result', 'output-3'),
      makeMsgWithSession('t4', 'tool_result', 'output-4'),
      makeMsgWithSession('t5', 'tool_result', 'output-5'),
    ];
    const { messages, coldEntries } = microCompactMessages(msgs);
    expect(coldEntries).toHaveLength(2);
    expect(coldEntries.every(e => e.contentType === 'tool_result')).toBe(true);
    expect(messages[0].content).toBe('question');
    expect(messages[2].content).toBe('answer');
  });

  test('placeholder contains originalChars count', () => {
    const longContent = 'x'.repeat(1234);
    const msgs = [
      makeMsgWithSession('t1', 'tool_result', longContent),
      makeMsgWithSession('t2', 'tool_result', 'short'),
      makeMsgWithSession('t3', 'tool_result', 'keep-1'),
      makeMsgWithSession('t4', 'tool_result', 'keep-2'),
      makeMsgWithSession('t5', 'tool_result', 'keep-3'),
    ];
    const { messages, coldEntries } = microCompactMessages(msgs);
    expect(coldEntries).toHaveLength(2);
    expect(coldEntries[0].originalChars).toBe(1234);
    expect(messages[0].content).toBe(`[Tool output: 1234 chars \u2014 available in cold storage]`);
    expect(coldEntries[1].originalChars).toBe(5);
    expect(messages[1].content).toBe(`[Tool output: 5 chars \u2014 available in cold storage]`);
  });
});

describe('buildSummarizationPrompt', () => {
  function makeSumMsg(id: string, type: CoworkMessage['type'], content: string): CoworkMessage {
    return { id, type, content, timestamp: Date.now() };
  }

  test('includes all 6 required sections', () => {
    const msgs = [
      makeSumMsg('1', 'user', 'Build a login page'),
      makeSumMsg('2', 'assistant', 'I will create a React login component'),
    ];
    const result = buildSummarizationPrompt(msgs);
    expect(result).toContain('1. User\'s original intent and goals');
    expect(result).toContain('2. Key technical decisions made and their rationale');
    expect(result).toContain('3. Files created, modified, or referenced');
    expect(result).toContain('4. Errors encountered and how they were resolved');
    expect(result).toContain('5. Current state of pending tasks');
    expect(result).toContain('6. The exact next step to continue work');
  });

  test('includes focusHint when provided', () => {
    const msgs = [makeSumMsg('1', 'user', 'hello')];
    const result = buildSummarizationPrompt(msgs, 'authentication flow');
    expect(result).toContain('Focus especially on: authentication flow');
  });

  test('omits focusHint line when not provided', () => {
    const msgs = [makeSumMsg('1', 'user', 'hello')];
    const result = buildSummarizationPrompt(msgs);
    expect(result).not.toContain('Focus especially on:');
  });

  test('caps input at SUMMARY_MAX_INPUT_CHARS', () => {
    const bigContent = 'x'.repeat(50_000);
    const msgs = [
      makeSumMsg('1', 'user', bigContent),
      makeSumMsg('2', 'assistant', bigContent),
    ];
    const result = buildSummarizationPrompt(msgs);
    const transcriptEnd = result.indexOf('\n\n---\n');
    const transcript = result.slice(0, transcriptEnd);
    expect(transcript.length).toBeLessThanOrEqual(COMPACTION_CONSTANTS.SUMMARY_MAX_INPUT_CHARS);
  });
});

describe('generateSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeGenMsg(id: string, type: CoworkMessage['type'], content: string): CoworkMessage {
    return { id, type, content, timestamp: Date.now() };
  }

  const apiConfig = {
    baseURL: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-3-haiku-20240307',
  };

  test('returns fallback result on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit)?.signal;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 200);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('The operation was aborted', 'AbortError')); });
      });
      return new Response(JSON.stringify({ content: [{ text: 'ok' }] }), { status: 200 });
    });

    const msgs = [
      makeGenMsg('1', 'user', 'hello'),
      makeGenMsg('2', 'assistant', 'hi there'),
    ];
    const result = await generateSummary(apiConfig, msgs, { timeoutMs: 10, trigger: 'manual' });
    expect(result.trigger).toBe('manual');
    expect(result.outputChars).toBe(0);
    expect(result.messagesCompacted).toBe(2);
    expect(result.success).toBe(false);
  });

  test('returns fallback result on fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    const msgs = [
      makeGenMsg('1', 'user', 'hello'),
      makeGenMsg('2', 'assistant', 'hi there'),
    ];
    const result = await generateSummary(apiConfig, msgs, { trigger: 'auto' });
    expect(result.trigger).toBe('auto');
    expect(result.outputChars).toBe(0);
    expect(result.messagesCompacted).toBe(2);
    expect(result.success).toBe(false);
  });

  test('sets success=true on successful API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ text: 'This is a summary' }] }), { status: 200 })
    );
    const msgs = [makeGenMsg('1', 'user', 'hello'), makeGenMsg('2', 'assistant', 'hi')];
    const result = await generateSummary(apiConfig, msgs, { trigger: 'manual' });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('This is a summary');
  });

  test('sets success=false on non-200 API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    );
    const msgs = [makeGenMsg('1', 'user', 'hello'), makeGenMsg('2', 'assistant', 'hi')];
    const result = await generateSummary(apiConfig, msgs, { trigger: 'auto' });
    expect(result.success).toBe(false);
  });

  test('uses OpenAI format when apiType is openai', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OpenAI summary' } }] }), { status: 200 })
    );
    const openaiConfig = { ...apiConfig, apiType: 'openai' as const, baseURL: 'https://api.zhipu.com' };
    const msgs = [makeGenMsg('1', 'user', 'hello world'), makeGenMsg('2', 'assistant', 'hi there')];
    const result = await generateSummary(openaiConfig, msgs, { trigger: 'manual' });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('OpenAI summary');
    // Verify URL ends with /chat/completions
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/chat/completions');
    // Verify Authorization header (not x-api-key)
    const calledInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['x-api-key']).toBeUndefined();
  });

  test('uses Anthropic format by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ text: 'Anthropic summary' }] }), { status: 200 })
    );
    const msgs = [makeGenMsg('1', 'user', 'hello'), makeGenMsg('2', 'assistant', 'hi')];
    const result = await generateSummary(apiConfig, msgs, { trigger: 'manual' });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Anthropic summary');
    // Verify URL ends with /messages
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/messages');
    // Verify x-api-key header
    const calledInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  test('returns originalChars in result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ text: 'summary' }] }), { status: 200 })
    );
    const msgs = [makeGenMsg('1', 'user', 'hello world'), makeGenMsg('2', 'assistant', 'goodbye world')];
    const result = await generateSummary(apiConfig, msgs, { trigger: 'manual' });
    expect(result.originalChars).toBe('hello world'.length + 'goodbye world'.length);
    expect(result.outputChars).toBe('summary'.length);
  });

  test('sets success=false when API returns 200 with empty content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ text: '' }] }), { status: 200 })
    );
    const msgs = [makeGenMsg('1', 'user', 'hello'), makeGenMsg('2', 'assistant', 'hi')];
    const result = await generateSummary(apiConfig, msgs, { trigger: 'manual' });
    expect(result.success).toBe(false);
    expect(result.outputChars).toBe(0);
  });
});

describe('deleteSessionWithCleanup', () => {
  test('calls both deleteSession and purgeColdContentForSession', async () => {
    const mockStore = {
      deleteSession: vi.fn(),
      purgeColdContentForSession: vi.fn().mockReturnValue(0),
    };
    await deleteSessionWithCleanup(mockStore, 'sess-1');
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-1');
    expect(mockStore.purgeColdContentForSession).toHaveBeenCalledWith('sess-1');
  });

  test('does not affect other sessions', async () => {
    const mockStore = {
      deleteSession: vi.fn(),
      purgeColdContentForSession: vi.fn().mockReturnValue(0),
    };
    await deleteSessionWithCleanup(mockStore, 'sess-1');
    expect(mockStore.deleteSession).not.toHaveBeenCalledWith('sess-2');
    expect(mockStore.purgeColdContentForSession).not.toHaveBeenCalledWith('sess-2');
  });
});

describe('compaction mutex (isCompacting / setCompacting)', () => {
  test('setCompacting sets mutex, isCompacting returns true', () => {
    setCompacting('sess-mutex-1', true);
    expect(isCompacting('sess-mutex-1')).toBe(true);
    setCompacting('sess-mutex-1', false); // cleanup
  });

  test('isCompacting returns false after setCompacting(id, false)', () => {
    setCompacting('sess-mutex-2', true);
    setCompacting('sess-mutex-2', false);
    expect(isCompacting('sess-mutex-2')).toBe(false);
  });

  test('different sessions can compact simultaneously', () => {
    setCompacting('sess-A', true);
    setCompacting('sess-B', true);
    expect(isCompacting('sess-A')).toBe(true);
    expect(isCompacting('sess-B')).toBe(true);
    setCompacting('sess-A', false);
    expect(isCompacting('sess-A')).toBe(false);
    expect(isCompacting('sess-B')).toBe(true);
    setCompacting('sess-B', false); // cleanup
  });
});

describe('compaction-of-compaction safeguard', () => {
  function makeCompactMsg(id: string, type: CoworkMessage['type'], content: string, metadata?: Record<string, unknown>): CoworkMessage {
    return { id, type, content, timestamp: Date.now(), metadata };
  }

  test('buildSummarizationPrompt includes previous summary when compaction_summary present', () => {
    const messages: CoworkMessage[] = [
      makeCompactMsg('1', 'system', 'Previous summary text', { subtype: 'compaction_summary', summary: 'Key insight: user wants auth' }),
      makeCompactMsg('2', 'user', 'Continue with OAuth', undefined),
      makeCompactMsg('3', 'assistant', 'Setting up OAuth provider', undefined),
    ];
    const prompt = buildSummarizationPrompt(messages);
    expect(prompt).toContain('compacted 1 time');
    expect(prompt).toContain('Key insight: user wants auth');
    expect(prompt).toContain('preserve its key insights');
  });

  test('prompt contains "compacted N times" for multiple compactions', () => {
    const messages: CoworkMessage[] = [
      makeCompactMsg('1', 'system', 'First summary', { subtype: 'compaction_summary', summary: 'First compaction' }),
      makeCompactMsg('2', 'system', 'Second summary', { subtype: 'compaction_summary', summary: 'Second compaction' }),
      makeCompactMsg('3', 'user', 'Continue', undefined),
    ];
    const prompt = buildSummarizationPrompt(messages);
    expect(prompt).toContain('compacted 2 times');
    expect(prompt).toContain('Second compaction'); // Uses LAST summary
  });

  test('no re-compaction note when no previous summaries', () => {
    const messages: CoworkMessage[] = [
      makeCompactMsg('1', 'user', 'Hello', undefined),
      makeCompactMsg('2', 'assistant', 'Hi', undefined),
    ];
    const prompt = buildSummarizationPrompt(messages);
    expect(prompt).not.toContain('compacted');
    expect(prompt).not.toContain('previous compaction summary');
  });
});
