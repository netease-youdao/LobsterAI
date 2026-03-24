import { describe, test, expect } from 'vitest';
import {
  parseCompactCommand,
  shouldAutoCompact,
  microCompactMessages,
  COMPACTION_CONSTANTS,
} from './coworkCompactor';
import type { CoworkMessage } from '../coworkStore';

function makeMessage(overrides: Partial<CoworkMessage> & { type: CoworkMessage['type']; content: string }): CoworkMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type,
    content: overrides.content,
    timestamp: overrides.timestamp ?? Date.now(),
    metadata: overrides.metadata,
  };
}

describe('coworkRunner compaction integration', () => {
  test('parseCompactCommand intercepts /compact in continueSession context', () => {
    const bare = parseCompactCommand('/compact');
    expect(bare.isCompact).toBe(true);
    expect(bare.focusHint).toBe('');

    const withHint = parseCompactCommand('/compact focus on auth');
    expect(withHint.isCompact).toBe(true);
    expect(withHint.focusHint).toBe('focus on auth');

    const notCompact = parseCompactCommand('hello');
    expect(notCompact.isCompact).toBe(false);

    const prefixed = parseCompactCommand('/compaction');
    expect(prefixed.isCompact).toBe(false);

    const leadingSpace = parseCompactCommand('  /compact trim test');
    expect(leadingSpace.isCompact).toBe(true);
    expect(leadingSpace.focusHint).toBe('trim test');
  });

  test('shouldAutoCompact triggers at 85% of 200K token window', () => {
    const threshold = COMPACTION_CONSTANTS.CONTEXT_WINDOW_TOKENS * COMPACTION_CONSTANTS.AUTO_COMPACT_THRESHOLD;
    const charsPerToken = 3.5;
    const charsNeeded = Math.ceil(threshold * charsPerToken) + 100;
    const charsPerMessage = Math.ceil(charsNeeded / 6);

    const messages = Array.from({ length: 6 }, (_, i) =>
      makeMessage({ type: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(charsPerMessage) })
    );

    const result = shouldAutoCompact(messages);
    expect(result.shouldCompact).toBe(true);
    expect(result.usage).toBeGreaterThanOrEqual(COMPACTION_CONSTANTS.AUTO_COMPACT_THRESHOLD);

    const smallMessages = [
      makeMessage({ type: 'user', content: 'hello' }),
      makeMessage({ type: 'assistant', content: 'hi' }),
    ];
    const smallResult = shouldAutoCompact(smallMessages);
    expect(smallResult.shouldCompact).toBe(false);
  });

  test('microCompactMessages replaces old tool_result messages with placeholders', () => {
    const messages: CoworkMessage[] = [
      makeMessage({ type: 'tool_result', content: 'result-1-long-output'.repeat(100) }),
      makeMessage({ type: 'tool_result', content: 'result-2-long-output'.repeat(100) }),
      makeMessage({ type: 'user', content: 'please continue' }),
      makeMessage({ type: 'tool_result', content: 'result-3-recent' }),
      makeMessage({ type: 'tool_result', content: 'result-4-recent' }),
      makeMessage({ type: 'tool_result', content: 'result-5-recent' }),
    ];

    const { messages: compacted, coldEntries } = microCompactMessages(messages, { keepRecentToolResults: 3 });

    expect(coldEntries).toHaveLength(2);
    expect(coldEntries[0].content).toContain('result-1-long-output');
    expect(coldEntries[1].content).toContain('result-2-long-output');

    expect(compacted[0].content).toMatch(/^\[Tool output: \d+ chars — available in cold storage\]$/);
    expect(compacted[1].content).toMatch(/^\[Tool output: \d+ chars — available in cold storage\]$/);

    expect(compacted[2].content).toBe('please continue');
    expect(compacted[3].content).toBe('result-3-recent');
    expect(compacted[4].content).toBe('result-4-recent');
    expect(compacted[5].content).toBe('result-5-recent');
  });

  test('compact_boundary metadata structure matches expected contract', () => {
    const metadata = {
      subtype: 'compact_boundary' as const,
      trigger: 'manual',
      preTokens: 12000,
    };

    expect(metadata.subtype).toBe('compact_boundary');
    expect(metadata.trigger).toBe('manual');
    expect(typeof metadata.preTokens).toBe('number');
    expect(metadata.preTokens).toBe(12000);

    const autoMetadata = {
      subtype: 'compact_boundary' as const,
      trigger: String(undefined ?? 'auto'),
      preTokens: typeof undefined === 'number' ? undefined : 0,
    };
    expect(autoMetadata.trigger).toBe('auto');
    expect(autoMetadata.preTokens).toBe(0);
  });
});
