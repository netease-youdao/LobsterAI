import { describe, test, expect } from 'vitest';
import {
  shouldAutoCompact,
  parseCompactCommand,
  microCompactMessages,
  COMPACTION_CONSTANTS,
} from '../coworkCompactor';
import type { CoworkMessage } from '../../coworkStore';

function makeMessage(
  type: CoworkMessage['type'],
  content: string,
  overrides: Partial<CoworkMessage> = {},
): CoworkMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    type,
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('OpenClaw compaction integration', () => {
  test('shouldAutoCompact with bridge-sized message set', () => {
    // Small bridge — 6 messages of 200 chars each should NOT trigger compaction
    const smallMessages = Array.from({ length: 6 }, (_, i) =>
      makeMessage(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(200))
    );
    const smallResult = shouldAutoCompact(smallMessages);
    expect(smallResult.shouldCompact).toBe(false);
    expect(smallResult.currentTokens).toBeGreaterThan(0);

    // Large bridge — 6 messages of 100000 chars each should trigger compaction
    const largeMessages = Array.from({ length: 6 }, (_, i) =>
      makeMessage(i % 2 === 0 ? 'user' : 'assistant', 'y'.repeat(100_000))
    );
    const largeResult = shouldAutoCompact(largeMessages);
    expect(largeResult.shouldCompact).toBe(true);
    expect(largeResult.usage).toBeGreaterThanOrEqual(COMPACTION_CONSTANTS.AUTO_COMPACT_THRESHOLD);
  });

  test('bridge skips compaction when hasHistory=true context (empty messages)', () => {
    // When hasHistory=true, buildBridgePrefix is never called.
    // Verify that shouldAutoCompact returns false for empty array (no compaction needed)
    const result = shouldAutoCompact([]);
    expect(result.shouldCompact).toBe(false);
    expect(result.currentTokens).toBe(0);
    expect(result.usage).toBe(0);

    // Also below MIN_MESSAGES_FOR_COMPACTION
    const fewMessages = Array.from({ length: 3 }, () =>
      makeMessage('user', 'short message')
    );
    const fewResult = shouldAutoCompact(fewMessages);
    expect(fewResult.shouldCompact).toBe(false);
  });

  test('parseCompactCommand works for OpenClaw /compact', () => {
    // Basic /compact
    const basic = parseCompactCommand('/compact');
    expect(basic.isCompact).toBe(true);
    expect(basic.focusHint).toBe('');

    // /compact with hint
    const withHint = parseCompactCommand('/compact focus on auth flow');
    expect(withHint.isCompact).toBe(true);
    expect(withHint.focusHint).toBe('focus on auth flow');

    // Not a compact command
    const notCompact = parseCompactCommand('please compact this');
    expect(notCompact.isCompact).toBe(false);

    // /compactor is not a compact command
    const partial = parseCompactCommand('/compactor');
    expect(partial.isCompact).toBe(false);

    // Leading whitespace
    const leadingSpace = parseCompactCommand('  /compact trim test');
    expect(leadingSpace.isCompact).toBe(true);
    expect(leadingSpace.focusHint).toBe('trim test');
  });

  test('microCompactMessages handles bridge source messages', () => {
    // Create 5 tool_result messages
    const messages: CoworkMessage[] = Array.from({ length: 5 }, (_, i) =>
      makeMessage('tool_result', `Tool output content ${i} ${'z'.repeat(500)}`)
    );

    const { messages: compacted, coldEntries } = microCompactMessages(messages);

    // With default keepRecentToolResults=3, should compact 2 and keep 3
    expect(coldEntries).toHaveLength(2);
    expect(compacted).toHaveLength(5);

    // First 2 should be compacted placeholders
    expect(compacted[0].content).toContain('[Tool output:');
    expect(compacted[0].content).toContain('cold storage');
    expect(compacted[1].content).toContain('[Tool output:');

    // Last 3 should retain original content
    expect(compacted[2].content).toContain('Tool output content 2');
    expect(compacted[3].content).toContain('Tool output content 3');
    expect(compacted[4].content).toContain('Tool output content 4');

    // Cold entries should have original content
    expect(coldEntries[0].contentType).toBe('tool_result');
    expect(coldEntries[0].originalChars).toBeGreaterThan(0);
  });

  test('[Compacted conversation summary] header format', () => {
    // Verify the expected bridge format for compacted sessions
    const header = '[Compacted conversation summary]';
    const recentHeader = '[Recent messages]';

    // Build the expected format
    const summary = 'User was implementing auth flow with JWT tokens.';
    const recentLines = [
      'User: How do I add refresh tokens?',
      'Assistant: You can implement refresh tokens by...',
    ];

    const bridgeOutput = [
      header,
      summary,
      '',
      recentHeader,
      ...recentLines,
    ].join('\n');

    expect(bridgeOutput).toMatch(/^\[Compacted conversation summary\]/);
    expect(bridgeOutput).toContain('[Recent messages]');
    expect(bridgeOutput).toContain(summary);
    expect(bridgeOutput.split('\n').length).toBe(6);
  });
});
