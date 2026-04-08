/**
 * Unit tests for chat command parsing and handling.
 *
 * Tests cover:
 * - parseSlashCommand: detection, normalization, arg splitting
 * - handleSlashCommand: each command's response via mocked deps
 */
import { test, expect, describe, vi } from 'vitest';
import { parseSlashCommand, handleSlashCommand, type ChatCommandDeps } from './chatCommandHandler';
import type { IMMessage } from './types';

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

describe('parseSlashCommand', () => {
  test('returns null for non-command messages', () => {
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('  hello')).toBeNull();
  });

  test('parses simple command', () => {
    const result = parseSlashCommand('/help');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('help');
    expect(result?.args).toHaveLength(0);
  });

  test('parses command with args', () => {
    const result = parseSlashCommand('/status foo bar');
    expect(result?.name).toBe('status');
    expect(result?.args).toEqual(['foo', 'bar']);
  });

  test('lowercases command name', () => {
    expect(parseSlashCommand('/HELP')?.name).toBe('help');
    expect(parseSlashCommand('/New')?.name).toBe('new');
  });

  test('handles leading whitespace', () => {
    expect(parseSlashCommand('  /help')?.name).toBe('help');
  });

  test('returns null for bare slash', () => {
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/  ')).toBeNull();
  });

  test('preserves raw content', () => {
    const result = parseSlashCommand('/status');
    expect(result?.raw).toBe('/status');
  });
});

// ---------------------------------------------------------------------------
// handleSlashCommand
// ---------------------------------------------------------------------------

function makeMessage(content: string): IMMessage {
  return {
    platform: 'telegram' as any,
    messageId: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-1',
    content,
    chatType: 'direct',
    timestamp: Date.now(),
  };
}

function makeDeps(overrides: Partial<ChatCommandDeps> = {}): ChatCommandDeps {
  return {
    coworkRuntime: {
      isSessionActive: vi.fn().mockReturnValue(false),
      stopSession: vi.fn(),
    } as any,
    coworkStore: {
      getSession: vi.fn().mockReturnValue({
        id: 'session-123',
        title: 'Test Session',
        messages: [{ id: 'm1' }, { id: 'm2' }],
        status: 'idle',
        claudeSessionId: null,
      }),
      updateSession: vi.fn(),
    } as any,
    imStore: {
      getSessionMapping: vi.fn().mockReturnValue({
        coworkSessionId: 'session-123',
        imConversationId: 'conv-1',
        platform: 'telegram',
      }),
    } as any,
    forceNewSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

test('returns null for non-command message', async () => {
  const result = await handleSlashCommand(makeMessage('hello'), makeDeps());
  expect(result).toBeNull();
});

test('/help returns a string with command list', async () => {
  const result = await handleSlashCommand(makeMessage('/help'), makeDeps());
  expect(result).not.toBeNull();
  expect(result).toContain('/status');
  expect(result).toContain('/new');
  expect(result).toContain('/compact');
  expect(result).toContain('/stop');
});

test('/帮助 also shows help (Chinese alias)', async () => {
  const result = await handleSlashCommand(makeMessage('/帮助'), makeDeps());
  expect(result).not.toBeNull();
  expect(result).toContain('/status');
});

test('/status returns session info when session exists', async () => {
  const result = await handleSlashCommand(makeMessage('/status'), makeDeps());
  expect(result).not.toBeNull();
  expect(result).toContain('session-');
  expect(result).toContain('2'); // message count
});

test('/status returns no-session message when no mapping', async () => {
  const deps = makeDeps({
    imStore: { getSessionMapping: vi.fn().mockReturnValue(null) } as any,
  });
  const result = await handleSlashCommand(makeMessage('/status'), deps);
  expect(result).not.toBeNull();
});

test('/new calls forceNewSession', async () => {
  const deps = makeDeps();
  await handleSlashCommand(makeMessage('/new'), deps);
  expect(deps.forceNewSession).toHaveBeenCalled();
});

test('/compact resets claudeSessionId', async () => {
  const deps = makeDeps();
  const result = await handleSlashCommand(makeMessage('/compact'), deps);
  expect(deps.coworkStore.updateSession).toHaveBeenCalledWith('session-123', {
    claudeSessionId: null,
  });
  expect(result).toContain('2'); // message count in response
});

test('/stop stops running session', async () => {
  const deps = makeDeps({
    coworkRuntime: {
      isSessionActive: vi.fn().mockReturnValue(true),
      stopSession: vi.fn(),
    } as any,
  });
  const result = await handleSlashCommand(makeMessage('/stop'), deps);
  expect(deps.coworkRuntime.stopSession).toHaveBeenCalledWith('session-123');
  expect(result).not.toBeNull();
});

test('/stop returns not-running when session is idle', async () => {
  const deps = makeDeps({
    coworkRuntime: {
      isSessionActive: vi.fn().mockReturnValue(false),
      stopSession: vi.fn(),
    } as any,
  });
  const result = await handleSlashCommand(makeMessage('/stop'), deps);
  expect(deps.coworkRuntime.stopSession).not.toHaveBeenCalled();
  expect(result).not.toBeNull();
});

test('/version returns version string', async () => {
  const result = await handleSlashCommand(makeMessage('/version'), makeDeps());
  expect(result).not.toBeNull();
  expect(result).toMatch(/\d+\.\d+/);
});

test('unknown command returns helpful message', async () => {
  const result = await handleSlashCommand(makeMessage('/unknownxyz'), makeDeps());
  expect(result).not.toBeNull();
  expect(result).toContain('unknownxyz');
});
