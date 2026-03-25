/**
 * Tests for context management logic in coworkRunner.
 *
 * Since CoworkRunner is tightly coupled to Electron and Claude SDK,
 * these tests exercise the pure-logic helpers that can be tested in isolation.
 * The helpers are extracted here mirroring the logic in coworkRunner.ts.
 */
import { test, expect, describe } from 'vitest';

// --- Extracted logic mirrors from coworkRunner.ts ---

interface TestMessage {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Assign turn numbers to messages. Each user message starts a new turn.
 */
function assignMessageTurns(messages: TestMessage[]): number[] {
  const turns: number[] = [];
  let currentTurn = 0;
  for (const msg of messages) {
    if (msg.type === 'user') {
      currentTurn += 1;
    }
    turns.push(currentTurn);
  }
  return turns;
}

/**
 * Estimate context size from messages.
 */
function estimateContextSize(messages: TestMessage[]): number {
  return messages.reduce((sum, msg) => sum + msg.content.length, 0);
}

/**
 * Legacy turn count estimation from user message count.
 */
function estimateLegacyTurnCount(messages: TestMessage[]): number {
  return messages.filter(m => m.type === 'user').length;
}

/**
 * Determine per-message char limit based on turn age (compression logic).
 */
function getMessageCharLimit(
  messageTurn: number,
  currentTurn: number,
  recentTurnsWindow: number,
  defaultMaxChars: number,
  mediumMaxChars: number,
  oldMaxChars: number,
): number {
  const turnsAgo = currentTurn - messageTurn;
  if (turnsAgo <= recentTurnsWindow) {
    return defaultMaxChars; // Full content for recent turns
  } else if (turnsAgo <= recentTurnsWindow + 10) {
    return mediumMaxChars; // 6-15 turns ago
  } else {
    return oldMaxChars; // 16+ turns ago
  }
}

// --- Tests ---

describe('assignMessageTurns', () => {
  test('assigns turn 0 for non-user messages before first user message', () => {
    const messages: TestMessage[] = [
      { type: 'system', content: 'welcome' },
      { type: 'assistant', content: 'hello' },
    ];
    expect(assignMessageTurns(messages)).toEqual([0, 0]);
  });

  test('increments turn on each user message', () => {
    const messages: TestMessage[] = [
      { type: 'user', content: 'first' },
      { type: 'assistant', content: 'response 1' },
      { type: 'user', content: 'second' },
      { type: 'assistant', content: 'response 2' },
    ];
    expect(assignMessageTurns(messages)).toEqual([1, 1, 2, 2]);
  });

  test('handles consecutive user messages', () => {
    const messages: TestMessage[] = [
      { type: 'user', content: 'a' },
      { type: 'user', content: 'b' },
      { type: 'assistant', content: 'response' },
    ];
    expect(assignMessageTurns(messages)).toEqual([1, 2, 2]);
  });

  test('handles empty messages array', () => {
    expect(assignMessageTurns([])).toEqual([]);
  });
});

describe('estimateContextSize', () => {
  test('returns 0 for empty messages', () => {
    expect(estimateContextSize([])).toBe(0);
  });

  test('sums content lengths', () => {
    const messages: TestMessage[] = [
      { type: 'user', content: 'hello' },        // 5
      { type: 'assistant', content: 'world!' },   // 6
    ];
    expect(estimateContextSize(messages)).toBe(11);
  });

  test('handles large content', () => {
    const bigContent = 'x'.repeat(100_000);
    const messages: TestMessage[] = [
      { type: 'user', content: bigContent },
      { type: 'assistant', content: bigContent },
    ];
    expect(estimateContextSize(messages)).toBe(200_000);
  });
});

describe('estimateLegacyTurnCount', () => {
  test('returns 0 for no messages', () => {
    expect(estimateLegacyTurnCount([])).toBe(0);
  });

  test('counts only user messages', () => {
    const messages: TestMessage[] = [
      { type: 'user', content: 'a' },
      { type: 'assistant', content: 'b' },
      { type: 'tool_use', content: 'c' },
      { type: 'user', content: 'd' },
      { type: 'assistant', content: 'e' },
    ];
    expect(estimateLegacyTurnCount(messages)).toBe(2);
  });

  test('handles all user messages', () => {
    const messages: TestMessage[] = [
      { type: 'user', content: 'a' },
      { type: 'user', content: 'b' },
      { type: 'user', content: 'c' },
    ];
    expect(estimateLegacyTurnCount(messages)).toBe(3);
  });

  test('handles no user messages', () => {
    const messages: TestMessage[] = [
      { type: 'system', content: 'welcome' },
      { type: 'assistant', content: 'hello' },
    ];
    expect(estimateLegacyTurnCount(messages)).toBe(0);
  });
});

describe('getMessageCharLimit (turn-age-based compression)', () => {
  const DEFAULT_MAX = 120_000;
  const MEDIUM_MAX = 8_000;
  const OLD_MAX = 2_000;
  const RECENT_WINDOW = 5;

  test('returns full limit for message in current turn', () => {
    expect(getMessageCharLimit(20, 20, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(DEFAULT_MAX);
  });

  test('returns full limit for messages within recent window', () => {
    // Turn 16, current is 20, turnsAgo = 4 (within window of 5)
    expect(getMessageCharLimit(16, 20, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(DEFAULT_MAX);
  });

  test('returns full limit at boundary of recent window', () => {
    // Turn 15, current is 20, turnsAgo = 5 (exactly at window boundary)
    expect(getMessageCharLimit(15, 20, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(DEFAULT_MAX);
  });

  test('returns medium limit for turns 6-15 ago', () => {
    // Turn 14, current is 20, turnsAgo = 6 (just past recent window)
    expect(getMessageCharLimit(14, 20, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(MEDIUM_MAX);
  });

  test('returns medium limit at boundary of medium window', () => {
    // Turn 5, current is 20, turnsAgo = 15 (at boundary of recent + 10)
    expect(getMessageCharLimit(5, 20, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(MEDIUM_MAX);
  });

  test('returns old limit for turns 16+ ago', () => {
    // Turn 4, current is 20, turnsAgo = 16
    expect(getMessageCharLimit(4, 20, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(OLD_MAX);
  });

  test('returns old limit for very old turns', () => {
    // Turn 1, current is 50, turnsAgo = 49
    expect(getMessageCharLimit(1, 50, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(OLD_MAX);
  });

  test('handles turn 0 (pre-user messages)', () => {
    // Turn 0, current is 10, turnsAgo = 10
    expect(getMessageCharLimit(0, 10, RECENT_WINDOW, DEFAULT_MAX, MEDIUM_MAX, OLD_MAX))
      .toBe(MEDIUM_MAX);
  });
});
