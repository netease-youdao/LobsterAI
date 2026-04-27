const LOG_PREVIEW_MAX_CHARS = 400;
const MAX_LOG_ARRAY_ITEMS = 10;
const MAX_LOG_OBJECT_KEYS = 20;
const REDACTED_VALUE = '[redacted]';
const CIRCULAR_VALUE = '[circular]';
const TRUNCATED_ITEMS_KEY = '__truncatedItems';
const TRUNCATED_KEYS_KEY = '__truncatedKeys';

const SENSITIVE_LOG_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie|session|refresh[-_]?token|access[-_]?token)/i;

const TRANSPORT_ERROR_TEXT_PATTERNS = [
  /fetch failed/i,
  /\bECONN(?:ABORTED|REFUSED|RESET)\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bETIMEDOUT\b/i,
  /network error/i,
  /socket hang up/i,
  /connection refused/i,
  /connection reset/i,
  /timed out/i,
  /certificate/i,
  /tls/i,
] as const;

function sanitizeForLogInternal(value: unknown, seen: WeakSet<object>, keyName?: string): unknown {
  if (typeof value === 'string') {
    return SENSITIVE_LOG_KEY_PATTERN.test(keyName || '')
      ? REDACTED_VALUE
      : truncateForLog(value);
  }

  if (
    value === null
    || value === undefined
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    const next = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeForLogInternal(item, seen));
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      next.push(`${TRUNCATED_ITEMS_KEY}:${value.length - MAX_LOG_ARRAY_ITEMS}`);
    }
    return next;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return CIRCULAR_VALUE;
    }
    seen.add(value);

    const entries = Object.entries(value as Record<string, unknown>);
    const next: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
      next[entryKey] = sanitizeForLogInternal(entryValue, seen, entryKey);
    }
    if (entries.length > MAX_LOG_OBJECT_KEYS) {
      next[TRUNCATED_KEYS_KEY] = entries.length - MAX_LOG_OBJECT_KEYS;
    }
    return next;
  }

  return String(value);
}

export function truncateForLog(value: string, maxChars = LOG_PREVIEW_MAX_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

export function serializeForLog(value: unknown, maxChars = LOG_PREVIEW_MAX_CHARS): string {
  try {
    const sanitized = sanitizeForLogInternal(value, new WeakSet<object>());
    return truncateForLog(JSON.stringify(sanitized), maxChars);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return truncateForLog(`"[log-serialization-failed:${message}]"`, maxChars);
  }
}

export function serializeToolContentForLog(
  content: Array<{ type?: string; text?: string; [key: string]: unknown }>,
  maxChars = LOG_PREVIEW_MAX_CHARS,
): string {
  return serializeForLog(content, maxChars);
}

export function getToolTextPreview(
  content: Array<{ type?: string; text?: string; [key: string]: unknown }>,
  maxChars = LOG_PREVIEW_MAX_CHARS,
): string {
  const text = content
    .map((block) => (typeof block.text === 'string' ? block.text.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return truncateForLog(text, maxChars);
}

export function looksLikeTransportErrorText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return TRANSPORT_ERROR_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}
