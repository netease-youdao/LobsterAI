// coworkCompactor.ts — LobsterAI conversation compaction utilities

import type { CoworkMessage } from '../coworkStore';

export interface CompactionResult {
  summary: string;
  messagesCompacted: number;
  inputTokensEstimated: number;
  outputChars: number;
  originalChars: number;
  trigger: 'manual' | 'auto';
  focusHint?: string;
  compactionCount: number;
  success: boolean;
}

interface ApiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

/**
 * Estimates the token count for a given text using a heuristic formula.
 * 
 * Returns 0 for empty strings, otherwise uses the formula: Math.ceil(text.length / 3.5).
 * This is a simple heuristic and does not trim whitespace.
 * 
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 3.5);
}

/**
 * Constants for conversation compaction behavior.
 */
export const COMPACTION_CONSTANTS = {
  /** Total context window size in tokens */
  CONTEXT_WINDOW_TOKENS: 200_000,

  /** Threshold ratio (0-1) at which to trigger auto-compaction */
  AUTO_COMPACT_THRESHOLD: 0.85,

  /** Number of recent messages to keep during micro-compaction */
  MICRO_COMPACT_KEEP_RECENT: 3,

  /** Maximum character count for input to summarization */
  SUMMARY_MAX_INPUT_CHARS: 80_000,

  /** Maximum character count for summarization output */
  SUMMARY_MAX_OUTPUT_CHARS: 4_000,

  /** Timeout in milliseconds for summarization operations */
  SUMMARY_TIMEOUT_MS: 120_000,

  /** Minimum message count before compaction is considered */
  MIN_MESSAGES_FOR_COMPACTION: 6,
} as const;

/**
 * Determines whether auto-compaction should be triggered based on
 * the estimated token usage of the given messages.
 */
export function shouldAutoCompact(
  messages: { content: string }[],
  contextWindowTokens: number = COMPACTION_CONSTANTS.CONTEXT_WINDOW_TOKENS
): { shouldCompact: boolean; currentTokens: number; threshold: number; usage: number } {
  const threshold = contextWindowTokens * COMPACTION_CONSTANTS.AUTO_COMPACT_THRESHOLD;

  if (messages.length < COMPACTION_CONSTANTS.MIN_MESSAGES_FOR_COMPACTION) {
    return { shouldCompact: false, currentTokens: 0, threshold, usage: 0 };
  }

  let currentTokens = 0;
  for (const msg of messages) {
    currentTokens += estimateTokens(msg.content);
  }

  const usage = currentTokens / contextWindowTokens;
  return {
    shouldCompact: usage >= COMPACTION_CONSTANTS.AUTO_COMPACT_THRESHOLD,
    currentTokens,
    threshold,
    usage,
  };
}

/**
 * Splits messages into two groups: the oldest 70% to compact and
 * the most recent 30% (ceil) to keep intact.
 */
export function selectMessagesForCompaction<T>(
  messages: T[]
): { toCompact: T[]; toKeep: T[] } {
  const keepCount = Math.ceil(messages.length * 0.3);
  const toKeep = messages.slice(-keepCount);
  const toCompact = messages.slice(0, messages.length - keepCount);
  return { toCompact, toKeep };
}

export function parseCompactCommand(input: string): { isCompact: boolean; focusHint: string } {
  const trimmed = input.trimStart();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('/compact')) {
    return { isCompact: false, focusHint: '' };
  }
  const afterCommand = trimmed.substring(8);
  if (afterCommand.length === 0) {
    return { isCompact: true, focusHint: '' };
  }
  if (afterCommand[0] !== ' ' && afterCommand[0] !== '\t') {
    return { isCompact: false, focusHint: '' };
  }
  return { isCompact: true, focusHint: afterCommand.trim() };
}

function buildAnthropicUrl(baseURL: string): string {
  const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
  if (base.endsWith('/messages')) return base;
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function buildOpenAIUrl(baseURL: string): string {
  const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export function buildSummarizationPrompt(messages: CoworkMessage[], focusHint?: string): string {
  // Detect previous compaction summaries for re-compaction awareness
  const previousSummaries = messages.filter(
    m => m.type === 'system' && (m.metadata?.subtype as string) === 'compaction_summary'
  );
  const compactionCount = previousSummaries.length;

  const lines: string[] = [];
  for (const msg of messages) {
    lines.push(`[${msg.type}]: ${msg.content}`);
  }
  let transcript = lines.join('\n');

  if (transcript.length > COMPACTION_CONSTANTS.SUMMARY_MAX_INPUT_CHARS) {
    transcript = transcript.slice(transcript.length - COMPACTION_CONSTANTS.SUMMARY_MAX_INPUT_CHARS);
  }

  // If re-compacting, include previous summary context
  let recompactionNote = '';
  if (compactionCount > 0) {
    const lastSummary = previousSummaries[previousSummaries.length - 1];
    const prevSummaryText = typeof lastSummary.metadata?.summary === 'string'
      ? lastSummary.metadata.summary
      : lastSummary.content;
    recompactionNote = `\n\nThis conversation has been compacted ${compactionCount} time${compactionCount > 1 ? 's' : ''} previously. The following is the previous compaction summary — preserve its key insights while adding new information:\n${prevSummaryText}`;
  }

  const focusLine = focusHint ? `\nFocus especially on: ${focusHint}` : '';

  return `${transcript}${recompactionNote}

---

You have written a partial transcript for the conversation above. Write a detailed summary that preserves:
1. User's original intent and goals
2. Key technical decisions made and their rationale
3. Files created, modified, or referenced
4. Errors encountered and how they were resolved
5. Current state of pending tasks
6. The exact next step to continue work${focusLine}

Write the summary in a structured format. Be thorough but concise.`;
}

export async function generateSummary(
  apiConfig: ApiConfig,
  messages: CoworkMessage[],
  options: { focusHint?: string; maxInputChars?: number; timeoutMs?: number; trigger?: 'manual' | 'auto'; compactionCount?: number } = {}
): Promise<CompactionResult> {
  const prompt = buildSummarizationPrompt(messages, options.focusHint);
  const isOpenAI = apiConfig.apiType === 'openai';
  const url = isOpenAI ? buildOpenAIUrl(apiConfig.baseURL) : buildAnthropicUrl(apiConfig.baseURL);
  const maxTokens = Math.ceil(COMPACTION_CONSTANTS.SUMMARY_MAX_OUTPUT_CHARS / 4);
  const timeoutMs = options.timeoutMs ?? COMPACTION_CONSTANTS.SUMMARY_TIMEOUT_MS;
  const startTime = Date.now();

  // Calculate original conversation chars (excluding instruction template) for compression metrics
  let originalChars = 0;
  for (const msg of messages) {
    originalChars += msg.content.length;
  }

  console.log(`[Compaction] starting ${options.trigger ?? 'auto'} compaction (${isOpenAI ? 'openai' : 'anthropic'} format): ${messages.length} messages, ${originalChars} original chars, prompt ${prompt.length} chars, timeout ${timeoutMs}ms, model ${apiConfig.model}, url ${url}`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: string;

  if (isOpenAI) {
    headers['Authorization'] = `Bearer ${apiConfig.apiKey}`;
    body = JSON.stringify({
      model: apiConfig.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
  } else {
    headers['x-api-key'] = apiConfig.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({
      model: apiConfig.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(unreadable)');
      console.error(`[Compaction] API returned ${response.status} after ${elapsed}ms: ${errorBody.slice(0, 500)}`);
      return buildFallbackResult(messages, prompt, options, originalChars);
    }

    const payload = await response.json();

    // Extract summary text from response based on API format
    let text: string;
    if (isOpenAI) {
      text = payload?.choices?.[0]?.message?.content ?? '';
    } else {
      text = payload?.content?.[0]?.text ?? '';
    }

    if (!text) {
      console.warn(`[Compaction] API returned 200 but empty summary. Format: ${isOpenAI ? 'openai' : 'anthropic'}. Payload keys: ${Object.keys(payload ?? {}).join(', ')}`);
    }

    console.log(`[Compaction] succeeded in ${elapsed}ms: ${text.length} chars output from ${originalChars} original chars, ${messages.length} messages compacted`);

    return {
      summary: text,
      messagesCompacted: messages.length,
      inputTokensEstimated: estimateTokens(prompt),
      outputChars: text.length,
      originalChars,
      trigger: options.trigger ?? 'auto',
      focusHint: options.focusHint,
      compactionCount: options.compactionCount ?? 0,
      success: text.length > 0,
    };
  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    if (isAbort) {
      console.error(`[Compaction] timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`);
    } else {
      console.error(`[Compaction] failed after ${elapsed}ms:`, error);
    }
    return buildFallbackResult(messages, prompt, options, originalChars);
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackResult(
  messages: CoworkMessage[],
  prompt: string,
  options: { focusHint?: string; trigger?: 'manual' | 'auto'; compactionCount?: number },
  originalChars: number = 0
): CompactionResult {
  return {
    summary: messages.slice(-3).map(m => `[${m.type}]: ${m.content.slice(0, 200)}`).join('\n'),
    messagesCompacted: messages.length,
    inputTokensEstimated: estimateTokens(prompt),
    outputChars: 0,
    originalChars,
    trigger: options.trigger ?? 'auto',
    focusHint: options.focusHint,
    compactionCount: options.compactionCount ?? 0,
    success: false,
  };
}

export interface ColdStorageInput {
  sessionId: string;
  messageId: string;
  content: string;
  contentType: string;
  originalChars: number;
}

/**
 * Replaces older tool_result messages with compact placeholders,
 * keeping the most recent `keepRecentToolResults` tool_results intact.
 * Returns modified messages and cold storage entries for the compacted ones.
 */
export function microCompactMessages(
  messages: CoworkMessage[],
  options: { keepRecentToolResults: number } = { keepRecentToolResults: COMPACTION_CONSTANTS.MICRO_COMPACT_KEEP_RECENT }
): { messages: CoworkMessage[]; coldEntries: ColdStorageInput[] } {
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type === 'tool_result') {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= options.keepRecentToolResults) {
    return { messages: [...messages], coldEntries: [] };
  }

  const compactCount = toolResultIndices.length - options.keepRecentToolResults;
  const indicesToCompact = new Set(toolResultIndices.slice(0, compactCount));

  const coldEntries: ColdStorageInput[] = [];
  const result = messages.map((msg, idx) => {
    if (!indicesToCompact.has(idx)) {
      return msg;
    }
    const originalChars = msg.content.length;
    coldEntries.push({
      sessionId: (msg as unknown as Record<string, unknown>).sessionId as string || '',
      messageId: msg.id,
      content: msg.content,
      contentType: 'tool_result',
      originalChars,
    });
    return {
      ...msg,
      content: `[Tool output: ${originalChars} chars — available in cold storage]`,
    };
  });

  return { messages: result, coldEntries };
}

/**
 * Deletes a session and purges its cold storage entries.
 * Used during session cleanup to ensure both the session and its
 * cold storage data are fully removed.
 */
export async function deleteSessionWithCleanup(
  store: { deleteSession(id: string): void; purgeColdContentForSession(id: string): number },
  sessionId: string
): Promise<void> {
  store.deleteSession(sessionId);
  store.purgeColdContentForSession(sessionId);
}

// In-memory compaction lock per session
const compactingSet = new Set<string>();

export function isCompacting(sessionId: string): boolean {
  return compactingSet.has(sessionId);
}

export function setCompacting(sessionId: string, value: boolean): void {
  if (value) {
    compactingSet.add(sessionId);
  } else {
    compactingSet.delete(sessionId);
  }
}
