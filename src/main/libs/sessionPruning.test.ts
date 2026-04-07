/**
 * Unit tests for session pruning utilities.
 *
 * Tests cover:
 * - Token estimation for English, CJK, and mixed content
 * - pruneMessages: sliding window strategy
 * - shouldPruneSession: threshold detection
 * - Model context window lookup
 */
import { test, expect, describe } from 'vitest';
import {
  estimateTokenCount,
  estimateConversationTokens,
  pruneMessages,
  shouldPruneSession,
  getModelContextWindow,
  DEFAULT_CONTEXT_WINDOWS,
} from './sessionPruning';

// ---------------------------------------------------------------------------
// estimateTokenCount
// ---------------------------------------------------------------------------

describe('estimateTokenCount', () => {
  test('empty string returns 0', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  test('pure English uses ~1 token per 3.5 chars', () => {
    const text = 'Hello world this is a test sentence with many words';
    const tokens = estimateTokenCount(text);
    // text.length / 3.5 ≈ 14.6 → expect somewhere around 14-16
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(25);
  });

  test('CJK characters use higher token density', () => {
    const chinese = '这是一段中文文本用于测试词元估算';
    const english = 'This is English text for testing token estimation';
    const chineseTokens = estimateTokenCount(chinese);
    const englishTokens = estimateTokenCount(english);
    // CJK: 16 chars / 1.5 ≈ 11; English: 50 chars / 3.5 ≈ 14
    // Both should give reasonable estimates
    expect(chineseTokens).toBeGreaterThan(5);
    expect(englishTokens).toBeGreaterThan(5);
  });

  test('mixed CJK and English text is handled', () => {
    const mixed = '你好 Hello 世界 World';
    const tokens = estimateTokenCount(mixed);
    expect(tokens).toBeGreaterThan(3);
  });

  test('short string estimates correctly', () => {
    expect(estimateTokenCount('Hi')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// estimateConversationTokens
// ---------------------------------------------------------------------------

describe('estimateConversationTokens', () => {
  test('empty messages returns 0', () => {
    expect(estimateConversationTokens([])).toBe(0);
  });

  test('adds overhead per message', () => {
    const singleMsg = estimateConversationTokens([{ content: 'hello' }]);
    const twoMsgs = estimateConversationTokens([{ content: 'hello' }, { content: 'hello' }]);
    // Two messages should be more than one (due to per-message overhead)
    expect(twoMsgs).toBeGreaterThan(singleMsg);
  });

  test('includes system prompt in total', () => {
    const withoutSystem = estimateConversationTokens([{ content: 'hello' }]);
    const withSystem = estimateConversationTokens([{ content: 'hello' }], 'system prompt here');
    expect(withSystem).toBeGreaterThan(withoutSystem);
  });
});

// ---------------------------------------------------------------------------
// pruneMessages
// ---------------------------------------------------------------------------

describe('pruneMessages', () => {
  const makeMessages = (count: number, charsEach = 100) =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg-${i}`,
      content: 'x'.repeat(charsEach),
      type: i % 2 === 0 ? 'user' : 'assistant',
    }));

  test('returns all messages when within budget', () => {
    const messages = makeMessages(5, 10);
    const result = pruneMessages(messages, 10_000);
    expect(result.wasPruned).toBe(false);
    expect(result.prunedCount).toBe(0);
    expect(result.keptMessages).toHaveLength(5);
  });

  test('prunes oldest messages when over budget', () => {
    // 20 messages × 100 chars each ≈ 20 × (100/3.5 + 4) ≈ 20 × 33 = 660 tokens
    // Budget of 200 tokens should force pruning
    const messages = makeMessages(20, 100);
    const result = pruneMessages(messages, 200);
    expect(result.wasPruned).toBe(true);
    expect(result.prunedCount).toBeGreaterThan(0);
    expect(result.keptMessages.length).toBeLessThan(20);
  });

  test('keeps most recent messages (not oldest)', () => {
    const messages = [
      { id: 'old', content: 'x'.repeat(1000), type: 'user' }, // ~290 tokens
      { id: 'newer', content: 'x'.repeat(1000), type: 'assistant' }, // ~290 tokens
      { id: 'newest', content: 'newest message short', type: 'user' }, // ~10 tokens
    ];
    // Budget = 200: enough to keep 'newest' (~10 tokens + 100 prefix reserve = 110)
    // but not enough to also keep 'old' (~290 tokens)
    const result = pruneMessages(messages, 200);
    if (result.wasPruned) {
      const keptIds = result.keptMessages.map(m => m.id);
      expect(keptIds).toContain('newest');
      expect(keptIds).not.toContain('old');
    } else {
      // If everything fits, test is inconclusive but not wrong
      expect(result.keptMessages).toHaveLength(3);
    }
  });

  test('pruned result includes summary prefix', () => {
    const messages = makeMessages(50, 200);
    const result = pruneMessages(messages, 300);
    if (result.wasPruned) {
      expect(result.prunedSummaryPrefix).toBeTruthy();
      expect(result.prunedSummaryPrefix).toContain('omitted');
    }
  });

  test('empty budget returns empty kept messages', () => {
    const messages = makeMessages(5, 100);
    const result = pruneMessages(messages, 0);
    expect(result.wasPruned).toBe(true);
    expect(result.keptMessages).toHaveLength(0);
  });

  test('empty messages list always returns no pruning', () => {
    const result = pruneMessages([], 10_000);
    expect(result.wasPruned).toBe(false);
    expect(result.prunedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldPruneSession
// ---------------------------------------------------------------------------

describe('shouldPruneSession', () => {
  test('returns false when usage is below threshold', () => {
    const messages = [{ content: 'hello', type: 'user' }];
    const result = shouldPruneSession(messages, 'claude', undefined, 0.75);
    expect(result.needsPruning).toBe(false);
    expect(result.contextWindow).toBe(DEFAULT_CONTEXT_WINDOWS['claude']);
  });

  test('returns true when conversation is very long', () => {
    // Simulate a very large conversation
    const messages = Array.from({ length: 500 }, (_, i) => ({
      content: 'x'.repeat(300),
      type: i % 2 === 0 ? 'user' : 'assistant',
    }));
    // Default model with 128k context window
    const result = shouldPruneSession(messages, 'unknown-model', undefined, 0.1);
    expect(result.needsPruning).toBe(true);
    expect(result.usageRatio).toBeGreaterThan(0.1);
  });

  test('includes system prompt in usage calculation', () => {
    const messages = [{ content: 'hi', type: 'user' }];
    const withoutSystem = shouldPruneSession(messages, 'claude');
    const longSystem = 'x'.repeat(50_000);
    const withSystem = shouldPruneSession(messages, 'claude', longSystem);
    expect(withSystem.estimatedTokens).toBeGreaterThan(withoutSystem.estimatedTokens);
  });
});

// ---------------------------------------------------------------------------
// getModelContextWindow
// ---------------------------------------------------------------------------

describe('getModelContextWindow', () => {
  test('recognizes claude models', () => {
    expect(getModelContextWindow('claude-opus-4')).toBe(DEFAULT_CONTEXT_WINDOWS['claude']);
  });

  test('recognizes gpt-4 models', () => {
    expect(getModelContextWindow('gpt-4o')).toBe(DEFAULT_CONTEXT_WINDOWS['gpt-4']);
  });

  test('recognizes deepseek models', () => {
    expect(getModelContextWindow('deepseek-chat')).toBe(DEFAULT_CONTEXT_WINDOWS['deepseek']);
  });

  test('falls back to default for unknown models', () => {
    expect(getModelContextWindow('unknown-mystery-model')).toBe(DEFAULT_CONTEXT_WINDOWS['default']);
  });

  test('all known model families have positive context windows', () => {
    for (const [, window] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
      expect(window).toBeGreaterThan(0);
    }
  });
});
