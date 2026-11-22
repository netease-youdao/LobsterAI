import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { ContinuityCapsuleSource } from '../libs/agentEngine/coworkContinuityCapsule';
import {
  buildDshProjectKey,
  buildLegacySessionSeedLog,
  encodeDshSessionSegment,
  encodeDshV4SessionZstd,
  resolveDshSessionLogPath,
  resolveDshSessionsRoot,
  seedLegacySessionsToDsh,
} from './legacySessionSeeder';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-session-seeder-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * Minimal Zstandard frame scanner matching DSH's `scanZstdFrames` so tests can
 * verify the exact 2-frame container layout (frame 1 = header, frame 2 = events).
 */
function splitZstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    expect(buffer.readUInt32LE(offset)).toBe(0xFD2FB528);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push(buffer.subarray(start, offset));
  }
  return frames;
}

describe('DSH v4 path encoding', () => {
  test('encodes session segments and project keys identically to DSH persistence', () => {
    expect(encodeDshSessionSegment('abc-123_456.7')).toBe('abc-123_456.7');
    expect(encodeDshSessionSegment('.')).toBe('~002E');
    expect(encodeDshSessionSegment('..')).toBe('~002E~002E');
    expect(encodeDshSessionSegment('a/b~c')).toBe('a~002Fb~007Ec');

    expect(buildDshProjectKey('/Users/alice/my project')).toBe('--Users-alice-my~0020project--');
    expect(buildDshProjectKey('C:\\Work\\repo')).toBe('--C-Work-repo--');
    expect(buildDshProjectKey('/')).toBe('--root--');
  });

  test('routes undefined cwd into _no-cwd and absolute cwd into projectKey', () => {
    const root = '/tmp/dsh-profile/sessions';
    expect(resolveDshSessionLogPath(root, undefined, 'sid-1')).toBe(
      path.join(root, '_no-cwd', 'sid-1', 'session.v4.jsonl.zstd'),
    );
    expect(resolveDshSessionLogPath(root, '/Users/alice/app', 'sid-1')).toBe(
      path.join(root, '--Users-alice-app--', 'sid-1', 'session.v4.jsonl.zstd'),
    );
  });
});

describe('buildLegacySessionSeedLog', () => {
  test('returns null for empty sessions with no messages and no continuity capsule', () => {
    expect(
      buildLegacySessionSeedLog({
        dshSessionId: 'empty-1',
        title: 'Empty',
        cwd: '/tmp/work',
        createdAt: 1_700_000_000_000,
        messages: [],
      }),
    ).toBeNull();

    expect(
      buildLegacySessionSeedLog({
        dshSessionId: 'sys-only',
        title: 'System banner only',
        cwd: '/tmp/work',
        createdAt: 1_700_000_000_000,
        messages: [{ id: 's1', type: 'system', content: 'Model changed', createdAt: 1_700_000_000_001 }],
      }),
    ).toBeNull();
  });

  test('preserves >10 messages, thinking, multi-step tool calls/results, image notes, capsule, and title with contiguous v4 seqs', () => {
    let seqId = 0;
    const messages = [
      {
        id: 'm1',
        type: 'user',
        content: 'My secret codename is ORION-99. Please check config.json.',
        metadata: {
          historyImageReferences: [
            { name: 'arch.png', path: '/tmp/images/arch.png', previewOnly: false },
          ],
        },
        createdAt: 1_700_000_001_000,
      },
      {
        id: 'm2',
        type: 'assistant',
        content: 'I should read config.json first.',
        metadata: { isThinking: true, model: 'claude-3-7-sonnet' },
        createdAt: 1_700_000_002_000,
      },
      {
        id: 'm3',
        type: 'tool_use',
        content: 'read_file',
        metadata: {
          toolUseId: 'call_read_1',
          toolName: 'read_file',
          toolInput: { path: 'config.json' },
        },
        createdAt: 1_700_000_002_100,
      },
      {
        id: 'm4',
        type: 'tool_result',
        content: '{"env":"staging","port":8443}',
        metadata: { toolUseId: 'call_read_1', isError: false },
        createdAt: 1_700_000_002_500,
      },
      {
        id: 'm5',
        type: 'assistant',
        content: 'config.json uses staging on port 8443.',
        metadata: { model: 'claude-3-7-sonnet' },
        createdAt: 1_700_000_003_000,
      },
    ];

    // Add 6 more user/assistant pairs (>10 total messages) to verify zero truncation!
    for (let i = 2; i <= 7; i += 1) {
      messages.push(
        {
          id: `u${i}`,
          type: 'user',
          content: `Follow-up question #${i}`,
          metadata: undefined,
          createdAt: 1_700_000_000_000 + i * 10_000,
        },
        {
          id: `a${i}`,
          type: 'assistant',
          content: `Detailed answer #${i}`,
          metadata: undefined,
          createdAt: 1_700_000_000_000 + i * 10_000 + 1_000,
        },
      );
    }

    const built = buildLegacySessionSeedLog({
      dshSessionId: 'dsh-test-uuid-1',
      title: '  Config   Investigation  ',
      cwd: '/tmp/workspace',
      createdAt: 1_700_000_000_000,
      messages,
      continuityCapsule: {
        version: 1,
        sessionId: 'cw-1',
        revision: 2,
        updatedAt: 1_700_000_000_500,
        lastSource: ContinuityCapsuleSource.PostCompaction,
        currentObjective: 'Audit staging port and verify ORION-99 rollout',
        recentUserRequests: ['Check config.json'],
        userConstraints: ['Do not edit production'],
        decisions: [],
        completedFacts: ['Staging runs on 8443'],
        recentActions: [],
        touchedFiles: [],
        keySymbols: [],
        verification: [],
        nextSteps: [],
        recentFailures: [],
        activeCapabilities: [],
        openQuestions: [],
      },
      createId: () => `id-${++seqId}`,
    });

    expect(built).not.toBeNull();
    const { header, events } = built!;

    // Verify exact v4 header fields.
    expect(header).toEqual({
      type: 'session',
      version: 4,
      id: 'dsh-test-uuid-1',
      createdAt: 1_700_000_001_000,
      cwd: '/tmp/workspace',
      isSeeded: false,
      delegationDepth: 0,
    });

    // Verify dense contiguous seq 0..N-1 and non-decreasing timestamps.
    for (let i = 0; i < events.length; i += 1) {
      expect(events[i].seq).toBe(i);
      if (i > 0) {
        expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time);
      }
    }

    // Turn 1 starts with empty system/message head before user/message.
    expect(events[0].type).toBe('turn/start');
    expect(events[1].type).toBe('step/start');
    expect(events[2]).toMatchObject({
      type: 'system/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'system', content: [], source: { kind: 'system-prompt' } },
      },
    });
    expect(events[3].type).toBe('user/message');
    const firstUserText = ((events[3].data.content as Array<{ text: string }>)[0]).text;
    expect(firstUserText).toContain('ORION-99');
    expect(firstUserText).toContain('Audit staging port');
    expect(firstUserText).toContain('/tmp/images/arch.png');

    // Verify thinking + tool-call + tool/call + tool/result + follow-up step 2 in Turn 1.
    const step1Assistant = events[4];
    expect(step1Assistant.type).toBe('assistant/message');
    const step1Msg = step1Assistant.data.message as {
      role: string;
      content: Array<{ type: string; id?: string; name?: string; arguments?: string; text?: string }>;
    };
    expect(step1Msg.content).toEqual([
      { type: 'reasoning', text: 'I should read config.json first.' },
      { type: 'tool-call', id: 'call_read_1', name: 'read_file', arguments: '{"path":"config.json"}' },
    ]);

    const toolCallEvent = events[5];
    expect(toolCallEvent).toMatchObject({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call_read_1', name: 'read_file', arguments: '{"path":"config.json"}' },
    });

    const toolResultEvent = events[6];
    expect(toolResultEvent).toMatchObject({
      type: 'tool/result',
      surfaceOp: 'append',
      sourceEventSeqs: [toolCallEvent.seq],
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_read_1',
          source: { kind: 'tool', callId: 'call_read_1' },
          content: [{ type: 'text', text: '{"env":"staging","port":8443}' }],
          isError: false,
        },
      },
    });

    // Verify session/title emitted after Turn 1.
    const titleEvent = events.find((e) => e.type === 'session/title');
    expect(titleEvent?.data).toEqual({
      title: 'Config Investigation',
      messageSeqs: [],
      source: { kind: 'user' },
    });

    // Verify ALL 7 turns are preserved (no 8-message truncation!).
    const userEvents = events.filter((e) => e.type === 'user/message');
    expect(userEvents).toHaveLength(7);
    expect(((userEvents[6].data.content as Array<{ text: string }>)[0]).text).toBe('Follow-up question #7');

    // Verify 2-frame Zstandard container layout.
    const zstdBytes = encodeDshV4SessionZstd(header, events);
    const frames = splitZstdFrames(zstdBytes);
    expect(frames).toHaveLength(2);
    const decodedHeader = zstdDecompressSync(frames[0]).toString('utf8');
    expect(decodedHeader.endsWith('\n')).toBe(true);
    expect(decodedHeader.indexOf('\n')).toBe(decodedHeader.length - 1);
    expect(JSON.parse(decodedHeader)).toEqual(header);

    const decodedBodyLines = zstdDecompressSync(frames[1]).toString('utf8').trim().split('\n');
    expect(decodedBodyLines).toHaveLength(events.length);
  });

  test('synthesizes fallback tool/result for unresolved tool_use, deduplicates duplicate callIds, skips orphaned tool_result, and handles non-absolute cwd', () => {
    const built = buildLegacySessionSeedLog({
      dshSessionId: 'edge-case-1',
      cwd: 'relative/path',
      createdAt: 1_700_000_000_000,
      messages: [
        { id: 'orphan', type: 'tool_result', content: 'stray output', metadata: { toolUseId: 'none' } },
        { id: 'u1', type: 'user', content: 'Run commands' },
        { id: 't1', type: 'tool_use', content: 'bash', metadata: { toolUseId: 'dup', toolName: 'bash', toolInput: { cmd: 'ls' } } },
        { id: 't2', type: 'tool_use', content: 'bash', metadata: { toolUseId: 'dup', toolName: 'bash', toolInput: { cmd: 'pwd' } } },
        { id: 'r1', type: 'tool_result', content: 'file.txt', metadata: { toolUseId: 'dup' } },
        // Second tool call intentionally missing tool_result!
      ],
    });

    expect(built).not.toBeNull();
    expect(built!.header.cwd).toBeUndefined();

    const assistant = built!.events.find((e) => e.type === 'assistant/message')!;
    const toolCalls = (assistant.data.message as { content: Array<{ id: string }> }).content;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].id).toBe('dup');
    expect(toolCalls[1].id).not.toBe('dup');

    const results = built!.events.filter((e) => e.type === 'tool/result');
    expect(results).toHaveLength(2);
    expect((results[0].data.message as { isError: boolean }).isError).toBe(false);
    expect((results[1].data.message as { isError: boolean }).isError).toBe(true);
  });
});

describe('seedLegacySessionsToDsh', () => {
  test('seeds legacy sessions into dsh-profile/sessions, binds dsh:<id>, leaves empty sessions for lazy bridge, and skips already-dsh sessions', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        claude_session_id TEXT,
        cwd TEXT,
        created_at INTEGER
      );
      CREATE TABLE cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER,
        sequence INTEGER
      );
    `);

    const projectDir = path.join(userDataDir, 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });

    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)').run(
      'cw-legacy-rich',
      'Legacy Chat',
      'agent:main:old-1',
      projectDir,
      1_700_000_000_000,
    );
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)').run(
      'cw-legacy-empty',
      'Empty Chat',
      null,
      projectDir,
      1_700_000_000_100,
    );
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)').run(
      'cw-already-dsh',
      'Already DSH',
      'dsh:existing-dsh-id',
      projectDir,
      1_700_000_000_200,
    );

    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'm1', 'cw-legacy-rich', 'user', 'Hello from OpenClaw', null, 1_700_000_001_000, 1,
    );
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'm2', 'cw-legacy-rich', 'assistant', 'Hello back!', null, 1_700_000_002_000, 2,
    );

    const res = seedLegacySessionsToDsh({ db, userDataDir, nowMs: 1_700_000_010_000 });
    expect(res.sessionsPreSeeded).toBe(1);
    expect(res.sessionsPreservedForLazyBridge).toBe(1);
    expect(res.errors).toEqual([]);
    expect(res.createdSessionDirs).toHaveLength(1);

    const rows = db
      .prepare('SELECT id, claude_session_id FROM cowork_sessions ORDER BY id ASC')
      .all() as Array<{ id: string; claude_session_id: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r.claude_session_id]));

    expect(byId.get('cw-already-dsh')).toBe('dsh:existing-dsh-id');
    expect(byId.get('cw-legacy-empty')).toBeNull();
    const seededRef = byId.get('cw-legacy-rich');
    expect(seededRef).toMatch(/^dsh:[0-9a-f-]{36}$/);

    const dshSessionId = seededRef!.slice('dsh:'.length);
    const logPath = resolveDshSessionLogPath(resolveDshSessionsRoot(userDataDir), projectDir, dshSessionId);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.statSync(logPath).size).toBeGreaterThan(0);

    db.close();
  });

  test('isolates per-session seeding failures without aborting remaining sessions', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        claude_session_id TEXT,
        cwd TEXT,
        created_at INTEGER
      );
      CREATE TABLE cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER,
        sequence INTEGER
      );
    `);

    const blockedProjectDir = path.join(userDataDir, 'blocked-proj');
    const goodProjectDir = path.join(userDataDir, 'good-proj');
    fs.mkdirSync(goodProjectDir, { recursive: true });

    // Sabotage ONLY the project directory path for `cw-bad` by placing a regular file where its project dir belongs.
    const sessionsRoot = resolveDshSessionsRoot(userDataDir);
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, buildDshProjectKey(blockedProjectDir)), 'blocker');

    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)').run(
      'cw-bad', 'Blocked Session', 'agent:main:bad', blockedProjectDir, 1_700_000_000_000,
    );
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)').run(
      'cw-good', 'Good Session', 'agent:main:good', goodProjectDir, 1_700_000_001_000,
    );
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'mb1', 'cw-bad', 'user', 'Should fail gracefully', null, 1_700_000_000_100, 1,
    );
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'mg1', 'cw-good', 'user', 'Should succeed cleanly', null, 1_700_000_001_100, 1,
    );

    const res = seedLegacySessionsToDsh({ db, userDataDir });
    expect(res.sessionsPreSeeded).toBe(1);
    expect(res.sessionsPreservedForLazyBridge).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].sessionId).toBe('cw-bad');

    const badRow = db.prepare('SELECT claude_session_id FROM cowork_sessions WHERE id = ?').get('cw-bad') as { claude_session_id: string };
    const goodRow = db.prepare('SELECT claude_session_id FROM cowork_sessions WHERE id = ?').get('cw-good') as { claude_session_id: string };
    expect(badRow.claude_session_id).toBe('agent:main:bad');
    expect(goodRow.claude_session_id).toMatch(/^dsh:[0-9a-f-]{36}$/);

    db.close();
  });
});
