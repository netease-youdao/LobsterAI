import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const requireScript = createRequire(import.meta.url);
const { diagnoseReplay } = requireScript('../scripts/diagnose-openclaw-replay.cjs');
const HELPER_PATH = 'packages/ai/src/transcript-replay-validation.ts';
const RAW_ROLE = { Assistant: 'assistant', ToolResult: 'toolResult' } as const;
let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-replay-diagnostic-'));
  // Exercise the exact helper shipped in the patch, without requiring a sibling checkout in CI.
  const patch = fs.readFileSync(path.resolve(
    'scripts/patches/v2026.8.1/openclaw-transcript-replay-validation.patch',
  ), 'utf8').replace(/\r\n/g, '\n');
  const diff = patch.split(`diff --git a/${HELPER_PATH} b/${HELPER_PATH}\n`)[1]?.split('\ndiff --git ')[0];
  expect(diff).toContain('new file mode 100644');
  const source = diff!.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1)).join('\n');
  const target = path.join(tempDir, HELPER_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const brokenEvent = {
  type: 'message', id: 'event-broken', parentId: 'event-before', message: {
    role: RAW_ROLE.Assistant, timestamp: 42, content: [
      { type: 'text', text: 'DO_NOT_LOG' },
      { type: 'toolCall', name: 'read', arguments: { secret: 'DO_NOT_LOG' } },
      { type: 'thinking', thinking: 5 },
    ],
  },
};

describe('OpenClaw replay record locator', () => {
  test('locates raw JSONL blocks without modifying or disclosing their contents', async () => {
    const input = path.join(tempDir, 'raw.jsonl');
    const bytes = [JSON.stringify({ type: 'session', id: 'session-test' }), '', JSON.stringify(brokenEvent)].join('\n');
    fs.writeFileSync(input, bytes);
    const result = await diagnoseReplay(input, { openclawSource: tempDir });
    expect(result.issueCount).toBe(2);
    expect(result.issues).toEqual([
      { line: 3, entryId: 'event-broken', messageIndex: 0, blockIndex: 1, timestamp: 42, field: 'id', action: 'drop-block' },
      { line: 3, entryId: 'event-broken', messageIndex: 0, blockIndex: 2, timestamp: 42, field: 'thinking', action: 'drop-block' },
    ]);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_LOG');
    expect(fs.readFileSync(input, 'utf8')).toBe(bytes);
  });

  test('filters SQLite by session and reports the stored sequence using a read-only connection', async () => {
    const input = path.join(tempDir, 'openclaw-agent.sqlite');
    const database = new DatabaseSync(input);
    database.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)');
    const insert = database.prepare('INSERT INTO transcript_events VALUES (?, ?, ?)');
    insert.run('target-session', 17, JSON.stringify(brokenEvent));
    insert.run('different-session', 18, JSON.stringify(brokenEvent));
    database.close();
    const bytes = fs.readFileSync(input);
    const result = await diagnoseReplay(input, { sessionId: 'target-session', openclawSource: tempDir });
    expect(result.recordCount).toBe(1);
    expect(result.issueCount).toBe(2);
    expect(result.issues[0]).toMatchObject({ seq: 17, entryId: 'event-broken', blockIndex: 1, field: 'id' });
    expect(fs.readFileSync(input)).toEqual(bytes);
    await expect(diagnoseReplay(input, { openclawSource: tempDir })).rejects.toThrow('--session is required');
  });

  test('reports malformed JSON by line without echoing input', async () => {
    const input = path.join(tempDir, 'malformed.jsonl');
    fs.writeFileSync(input, 'DO_NOT_LOG\n' + JSON.stringify(brokenEvent));
    const result = await diagnoseReplay(input, { openclawSource: tempDir });
    expect(result.issues[0]).toEqual({ line: 1, field: 'json', action: 'unreadable-record' });
    expect(result.issueCount).toBe(3);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_LOG');
  });

  test('bounds output while counting every invalid record', async () => {
    const input = path.join(tempDir, 'many.jsonl');
    fs.writeFileSync(input, Array.from({ length: 205 }, () => JSON.stringify({
      role: RAW_ROLE.ToolResult, content: [], timestamp: 43,
    })).join('\n'));
    const result = await diagnoseReplay(input, { openclawSource: tempDir });
    expect(result.issueCount).toBe(205);
    expect(result.issues).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  test('rejects the display export instead of treating omitted fields as corrupt history', async () => {
    const input = path.join(tempDir, 'conversation.json');
    fs.writeFileSync(input, JSON.stringify({ messages: [{ type: 'assistant', content: 'DO_NOT_LOG' }] }));
    await expect(diagnoseReplay(input, { openclawSource: tempDir })).rejects.toThrow('display conversation JSON');
  });
});
