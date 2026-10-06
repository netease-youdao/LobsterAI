import { LogReporterEndpoint } from '../../shared/analytics/constants';

const LOG_PREVIEW_MAX_CHARS = 400;
const MAX_LOG_ARRAY_ITEMS = 10;
const MAX_LOG_OBJECT_KEYS = 20;
const REDACTED_VALUE = '[redacted]';
const CIRCULAR_VALUE = '[circular]';
const TRUNCATED_ITEMS_KEY = '__truncatedItems';
const TRUNCATED_KEYS_KEY = '__truncatedKeys';

export const SENSITIVE_LOG_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie|session|refresh[-_]?token|access[-_]?token|verifier)/i;

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

/**
 * Redacts a request/response body before it reaches the log. serializeForLog
 * only redacts object keys it can see, but a request body is usually a raw
 * string (JSON or application/x-www-form-urlencoded) at the point api:fetch
 * logs it, before anything has parsed it into an object; passing such a
 * string through serializeForLog directly does nothing, since there is no
 * key name for SENSITIVE_LOG_KEY_PATTERN to match against. This parses the
 * string into a key/value shape first wherever possible, so the same
 * key-based redaction applies to a credential-bearing OAuth token request
 * body or response the same way it already does for structured logging
 * elsewhere in this file.
 */
export function redactBodyForLog(body: unknown, maxChars = LOG_PREVIEW_MAX_CHARS): string {
  if (body === null || body === undefined) {
    return String(body);
  }
  if (typeof body !== 'string') {
    return serializeForLog(body, maxChars);
  }
  const trimmed = body.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    return serializeForLog(JSON.parse(trimmed), maxChars);
  } catch {
    // Not JSON; fall through to the form-encoded attempt below.
  }
  if (/^[^=&\s]+=[^\s]*(&[^=&\s]+=[^\s]*)*$/.test(trimmed)) {
    const asObject: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(trimmed)) {
      asObject[key] = value;
    }
    if (Object.keys(asObject).length > 0) {
      return serializeForLog(asObject, maxChars);
    }
  }
  // Could not identify a key/value structure (e.g. a streamed SSE/plain-text
  // response body): no per-field redaction is possible, so this behaves the
  // same as logging did before this function existed. Request/response
  // bodies that actually carry structured credentials (JSON, form-encoded)
  // are handled by the branches above.
  return truncateForLog(trimmed, maxChars);
}

// Usage-analytics beacons are fire-and-forget and arrive dozens to hundreds of
// times a day; the reporter already writes its own one-line trace per event,
// so the generic request/response logging would only duplicate it.
const ANALYTICS_ENDPOINT = new URL(LogReporterEndpoint.YoudaoAnalyzer);

export function isAnalyticsEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === ANALYTICS_ENDPOINT.origin && url.pathname === ANALYTICS_ENDPOINT.pathname;
  } catch {
    return false;
  }
}

export function sanitizeUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    const hasQuery = Boolean(url.search);
    const hasHash = Boolean(url.hash);
    url.search = '';
    url.hash = '';
    return `${url.href}${hasQuery ? '?[redacted]' : ''}${hasHash ? '#[redacted]' : ''}`;
  } catch {
    return '[invalid-url]';
  }
}

export function looksLikeTransportErrorText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return TRANSPORT_ERROR_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}
