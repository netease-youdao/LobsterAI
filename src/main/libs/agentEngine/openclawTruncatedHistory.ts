import { OpenClawGatewayMethod } from './constants';

// OpenClaw's chat.history returns display previews: every text block is capped
// (8000 chars by default) and suffixed with this marker, and the message is
// flagged `__openclaw.truncated`. chat.message.get returns the full stored row.
export const OPENCLAW_HISTORY_TRUNCATION_MARKER = '...(truncated)...';
export const OPENCLAW_FULL_MESSAGE_MAX_CHARS = 1_000_000;

const FULL_MESSAGE_FETCH_LIMIT = 16;
const FULL_MESSAGE_CACHE_LIMIT = 64;
const FULL_MESSAGE_TIMEOUT_MS = 5_000;

type GatewayRequest = <T>(
  method: string,
  params?: unknown,
  opts?: { timeoutMs?: number | null },
) => Promise<T>;

type ChatMessageGetResult = {
  ok?: boolean;
  message?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Returns the transcript id of a user/assistant history message that the gateway truncated. */
export const readTruncatedHistoryMessageId = (message: unknown): string | undefined => {
  if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant')) {
    return undefined;
  }
  const meta = message.__openclaw;
  if (!isRecord(meta) || meta.truncated !== true || typeof meta.id !== 'string') {
    return undefined;
  }
  return meta.id.trim() || undefined;
};

/** Cheap pre-check so history sync only awaits a restore when the gateway truncated something. */
export const hasTruncatedHistoryMessages = (messages: unknown): messages is unknown[] =>
  Array.isArray(messages) && messages.some((message) => readTruncatedHistoryMessageId(message) !== undefined);

/** True when `preview` is a chat.history preview whose visible prefix `full` extends. */
export const isTruncatedHistoryPreviewOf = (preview: string, full: string): boolean => {
  const trimmedPreview = preview.trim();
  if (!trimmedPreview.endsWith(OPENCLAW_HISTORY_TRUNCATION_MARKER)) return false;
  const prefix = trimmedPreview.slice(0, -OPENCLAW_HISTORY_TRUNCATION_MARKER.length).trim();
  const trimmedFull = full.trim();
  return prefix.length > 0 && trimmedFull.length > prefix.length && trimmedFull.startsWith(prefix);
};

/**
 * Replaces truncated chat.history previews with their full rows so history
 * sync never stores the preview over complete local text. Transcript rows are
 * immutable by id, so fetched rows (and definitive misses) are cached.
 */
export class OpenClawTruncatedHistoryRestorer {
  private readonly fullMessages = new Map<string, Record<string, unknown> | null>();

  async restore(request: GatewayRequest, sessionKey: string, messages: unknown[]): Promise<unknown[]> {
    let restored: unknown[] | null = null;
    const pending: Array<{ index: number; messageId: string; cacheKey: string }> = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const messageId = readTruncatedHistoryMessageId(messages[index]);
      if (!messageId) continue;
      const cacheKey = `${sessionKey}\n${messageId}`;
      if (this.fullMessages.has(cacheKey)) {
        const cached = this.fullMessages.get(cacheKey);
        if (cached) {
          restored ??= [...messages];
          restored[index] = cached;
        }
        continue;
      }
      if (pending.length < FULL_MESSAGE_FETCH_LIMIT) {
        pending.push({ index, messageId, cacheKey });
      }
    }
    if (pending.length === 0) {
      return restored ?? messages;
    }

    const output = restored ?? [...messages];
    let failedCount = 0;
    let lastError: unknown;
    await Promise.all(pending.map(async ({ index, messageId, cacheKey }) => {
      try {
        const result = await request<ChatMessageGetResult>(OpenClawGatewayMethod.ChatMessageGet, {
          sessionKey,
          messageId,
          maxChars: OPENCLAW_FULL_MESSAGE_MAX_CHARS,
        }, { timeoutMs: FULL_MESSAGE_TIMEOUT_MS });
        const fullMessage = result?.ok === true && isRecord(result.message) ? result.message : null;
        this.remember(cacheKey, fullMessage);
        if (fullMessage) {
          output[index] = fullMessage;
        }
      } catch (error) {
        failedCount += 1;
        lastError = error;
      }
    }));
    if (failedCount > 0) {
      console.warn(
        `[OpenClawRuntime] chat.message.get failed for ${failedCount} truncated history message(s), keeping previews:`,
        lastError,
      );
    }
    return output;
  }

  private remember(cacheKey: string, fullMessage: Record<string, unknown> | null): void {
    this.fullMessages.delete(cacheKey);
    this.fullMessages.set(cacheKey, fullMessage);
    while (this.fullMessages.size > FULL_MESSAGE_CACHE_LIMIT) {
      const oldestKey = this.fullMessages.keys().next().value;
      if (oldestKey === undefined) break;
      this.fullMessages.delete(oldestKey);
    }
  }
}
