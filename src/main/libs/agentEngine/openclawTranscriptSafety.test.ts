import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  OpenClawTranscriptSafetyLimit,
  OpenClawTranscriptSafetyStatus,
} from '../../../shared/openclawTranscript/constants';
import {
  buildOpenClawTranscriptOversizedError,
  classifyOpenClawTranscriptSize,
  inspectOpenClawTranscriptSafety,
} from './openclawTranscriptSafety';

const tempDirs: string[] = [];

const createFixture = async (options: {
  transcriptBytes: number;
  sessionFile?: string;
  sessionId?: string;
}) => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-transcript-safety-'));
  tempDirs.push(stateDir);
  const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
  await fs.promises.mkdir(sessionsDir, { recursive: true });
  const sessionId = options.sessionId ?? 'session-1';
  const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  await fs.promises.writeFile(transcriptPath, '');
  await fs.promises.truncate(transcriptPath, options.transcriptBytes);
  await fs.promises.writeFile(path.join(sessionsDir, 'sessions.json'), JSON.stringify({
    'agent:main:cowork:test-session': {
      sessionId,
      ...(options.sessionFile !== undefined ? { sessionFile: options.sessionFile } : {}),
    },
  }));
  return {
    stateDir,
    sessionsDir,
    transcriptPath: await fs.promises.realpath(transcriptPath),
  };
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, {
    recursive: true,
    force: true,
  })));
});

describe('classifyOpenClawTranscriptSize', () => {
  test('uses the soft and hard limits at exact byte boundaries', () => {
    expect(classifyOpenClawTranscriptSize(OpenClawTranscriptSafetyLimit.SoftBytes - 1))
      .toBe(OpenClawTranscriptSafetyStatus.Safe);
    expect(classifyOpenClawTranscriptSize(OpenClawTranscriptSafetyLimit.SoftBytes))
      .toBe(OpenClawTranscriptSafetyStatus.CompactionRequired);
    expect(classifyOpenClawTranscriptSize(OpenClawTranscriptSafetyLimit.HardBytes - 1))
      .toBe(OpenClawTranscriptSafetyStatus.CompactionRequired);
    expect(classifyOpenClawTranscriptSize(OpenClawTranscriptSafetyLimit.HardBytes))
      .toBe(OpenClawTranscriptSafetyStatus.Blocked);
  });
});

describe('inspectOpenClawTranscriptSafety', () => {
  test('stats the active transcript without reading its contents', async () => {
    const fixture = await createFixture({ transcriptBytes: OpenClawTranscriptSafetyLimit.SoftBytes });

    const result = await inspectOpenClawTranscriptSafety({
      stateDir: fixture.stateDir,
      agentId: 'main',
      sessionKey: 'agent:main:cowork:test-session',
    });

    expect(result).toEqual({
      status: OpenClawTranscriptSafetyStatus.CompactionRequired,
      transcriptBytes: OpenClawTranscriptSafetyLimit.SoftBytes,
      transcriptPath: fixture.transcriptPath,
    });
  });

  test('uses a contained persisted successor transcript path', async () => {
    const fixture = await createFixture({
      transcriptBytes: 1,
      sessionFile: 'successor.jsonl',
    });
    const successorPath = path.join(fixture.sessionsDir, 'successor.jsonl');
    await fs.promises.writeFile(successorPath, 'successor');
    const realSuccessorPath = await fs.promises.realpath(successorPath);

    const result = await inspectOpenClawTranscriptSafety({
      stateDir: fixture.stateDir,
      agentId: 'main',
      sessionKey: 'agent:main:cowork:test-session',
    });

    expect(result.status).toBe(OpenClawTranscriptSafetyStatus.Safe);
    expect(result.transcriptBytes).toBe(9);
    expect(result.transcriptPath).toBe(realSuccessorPath);
  });

  test('rejects an escaped session file and falls back to the contained session id path', async () => {
    const fixture = await createFixture({
      transcriptBytes: OpenClawTranscriptSafetyLimit.HardBytes,
      sessionFile: path.join('..', '..', '..', 'outside.jsonl'),
    });

    const result = await inspectOpenClawTranscriptSafety({
      stateDir: fixture.stateDir,
      agentId: 'main',
      sessionKey: 'agent:main:cowork:test-session',
    });

    expect(result.status).toBe(OpenClawTranscriptSafetyStatus.Blocked);
    expect(result.transcriptPath).toBe(fixture.transcriptPath);
  });

  test('returns unknown for a new session without persisted metadata', async () => {
    const fixture = await createFixture({ transcriptBytes: 1 });

    const result = await inspectOpenClawTranscriptSafety({
      stateDir: fixture.stateDir,
      agentId: 'main',
      sessionKey: 'agent:main:cowork:new-session',
    });

    expect(result).toEqual({
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: 'session_entry_missing',
    });
  });

  test('does not allow an agent id to escape the state agents directory', async () => {
    const fixture = await createFixture({ transcriptBytes: 1 });

    const result = await inspectOpenClawTranscriptSafety({
      stateDir: fixture.stateDir,
      agentId: '../../outside',
      sessionKey: 'agent:main:cowork:test-session',
    });

    expect(result).toEqual({
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: 'invalid_agent_sessions_path',
    });
  });
});

test('buildOpenClawTranscriptOversizedError includes a stable error code and limits', () => {
  const error = buildOpenClawTranscriptOversizedError({
    transcriptBytes: OpenClawTranscriptSafetyLimit.HardBytes + 1,
  });

  expect(error.message).toContain('OPENCLAW_ACTIVE_TRANSCRIPT_OVERSIZED');
  expect(error.message).toContain(String(OpenClawTranscriptSafetyLimit.HardBytes + 1));
  expect(error.message).toContain(String(OpenClawTranscriptSafetyLimit.HardBytes));
});
