/**
 * Session pruning utilities for managing conversation context size.
 *
 * Provides token estimation and message pruning strategies to prevent
 * context window overflow in long-running cowork sessions.
 */

/**
 * Estimate token count from a string using character-based heuristics.
 *
 * These ratios are empirically derived from OpenAI's tiktoken and
 * Anthropic's tokenizer behavior:
 * - English/code: ~1 token per 4 characters (3.5-4.5 range)
 * - CJK (Chinese/Japanese/Korean): ~1 token per 1.5 characters
 * - Mixed content uses a weighted blend
 *
 * This is intentionally conservative (overestimates) to avoid hitting
 * the actual limit.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  // Count CJK characters (Unicode ranges for common CJK)
  let cjkChars = 0;
  let nonCjkChars = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Punctuation
      (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
      (code >= 0xac00 && code <= 0xd7af) // Korean Hangul
    ) {
      cjkChars++;
    } else {
      nonCjkChars++;
    }
  }

  // CJK: ~1 token per 1.5 chars; non-CJK: ~1 token per 3.5 chars
  const cjkTokens = Math.ceil(cjkChars / 1.5);
  const nonCjkTokens = Math.ceil(nonCjkChars / 3.5);

  return cjkTokens + nonCjkTokens;
}

/**
 * Estimate the total token count of a conversation message array.
 * Each message has role overhead (~4 tokens per message for role/formatting).
 */
export function estimateConversationTokens(
  messages: Array<{ content: string; type?: string }>,
  systemPrompt?: string,
): number {
  const MESSAGE_OVERHEAD = 4; // tokens per message for role/formatting
  let total = 0;

  if (systemPrompt) {
    total += estimateTokenCount(systemPrompt) + MESSAGE_OVERHEAD;
  }

  for (const msg of messages) {
    total += estimateTokenCount(msg.content) + MESSAGE_OVERHEAD;
  }

  return total;
}

export interface PruningResult {
  /** Messages to keep (most recent, within budget) */
  keptMessages: Array<{ content: string; type?: string; id?: string }>;
  /** Number of messages that were pruned */
  prunedCount: number;
  /** Summary of pruned messages (if generated) */
  prunedSummaryPrefix: string;
  /** Whether pruning actually occurred */
  wasPruned: boolean;
}

/**
 * Default context window sizes by model family.
 * Used when the actual context window is unknown.
 */
export const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  claude: 200_000,
  'gpt-4': 128_000,
  'gpt-3.5': 16_000,
  deepseek: 64_000,
  qwen: 128_000,
  gemini: 1_000_000,
  default: 128_000,
};

/**
 * Get the estimated context window for a model.
 */
export function getModelContextWindow(modelId: string): number {
  const lower = modelId.toLowerCase();
  for (const [prefix, window] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
    if (prefix !== 'default' && lower.includes(prefix)) {
      return window;
    }
  }
  return DEFAULT_CONTEXT_WINDOWS['default'];
}

/**
 * Prune conversation messages to fit within a token budget.
 *
 * Strategy: sliding window — keep the most recent messages that fit
 * within the budget. A brief prefix is prepended indicating that
 * earlier context was compressed.
 *
 * @param messages       All messages in chronological order
 * @param tokenBudget    Maximum tokens for the message history
 * @param systemPrompt   System prompt (counted against the budget)
 * @returns PruningResult with kept messages and metadata
 */
export function pruneMessages(
  messages: Array<{ content: string; type?: string; id?: string }>,
  tokenBudget: number,
  systemPrompt?: string,
): PruningResult {
  const MESSAGE_OVERHEAD = 4;
  const systemTokens = systemPrompt ? estimateTokenCount(systemPrompt) + MESSAGE_OVERHEAD : 0;

  // Reserve space for the summary prefix message
  const SUMMARY_PREFIX_BUDGET = 100;
  const availableBudget = tokenBudget - systemTokens - SUMMARY_PREFIX_BUDGET;

  if (availableBudget <= 0) {
    return {
      keptMessages: [],
      prunedCount: messages.length,
      prunedSummaryPrefix: '[Earlier conversation context was too large and has been omitted.]',
      wasPruned: messages.length > 0,
    };
  }

  // Check if all messages fit
  const totalTokens = estimateConversationTokens(messages);
  if (totalTokens <= availableBudget) {
    return {
      keptMessages: messages,
      prunedCount: 0,
      prunedSummaryPrefix: '',
      wasPruned: false,
    };
  }

  // Sliding window: keep most recent messages that fit
  let usedTokens = 0;
  let keepFromIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokenCount(messages[i].content) + MESSAGE_OVERHEAD;
    if (usedTokens + msgTokens > availableBudget) break;
    usedTokens += msgTokens;
    keepFromIndex = i;
  }

  const keptMessages = messages.slice(keepFromIndex);
  const prunedCount = keepFromIndex;

  const prunedSummaryPrefix =
    prunedCount > 0
      ? `[This conversation had ${messages.length} messages. The earliest ${prunedCount} messages have been omitted to fit within the context window. The conversation continues from message ${keepFromIndex + 1}.]`
      : '';

  return {
    keptMessages,
    prunedCount,
    prunedSummaryPrefix,
    wasPruned: prunedCount > 0,
  };
}

/**
 * Determine if a session needs pruning based on estimated token usage.
 *
 * @param messages     All session messages
 * @param modelId      Model identifier (for context window lookup)
 * @param systemPrompt System prompt text
 * @param threshold    Fraction of context window to trigger pruning (default 0.75)
 */
export function shouldPruneSession(
  messages: Array<{ content: string; type?: string }>,
  modelId: string,
  systemPrompt?: string,
  threshold = 0.75,
): { needsPruning: boolean; estimatedTokens: number; contextWindow: number; usageRatio: number } {
  const contextWindow = getModelContextWindow(modelId);
  const estimatedTokens = estimateConversationTokens(messages, systemPrompt);
  const usageRatio = estimatedTokens / contextWindow;

  return {
    needsPruning: usageRatio >= threshold,
    estimatedTokens,
    contextWindow,
    usageRatio,
  };
}
