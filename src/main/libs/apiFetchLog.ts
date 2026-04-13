export type ApiFetchLogDataSummary = {
  type: 'none' | 'string' | 'json';
  length?: number;
};

export type ApiFetchRequestLogSummary = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: ApiFetchLogDataSummary;
};

export type ApiFetchResponseLogSummary = {
  method: string;
  url: string;
  status: number;
  statusText: string;
  data: ApiFetchLogDataSummary;
};

const REDACTED = '[redacted]';
const MAX_LOG_PREVIEW_CHARS = 500;
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'apikey',
  'cookie',
  'set-cookie',
]);

const SENSITIVE_FIELD_NAME_RE = /(?:api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|app[_-]?secret|bot[_-]?token|cookie)/i;

export function summarizeApiFetchRequest(options: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}): ApiFetchRequestLogSummary {
  return {
    method: options.method,
    url: options.url,
    headers: redactHeaders(options.headers),
    body: summarizeLogData(options.body),
  };
}

export function summarizeApiFetchResponse(result: {
  method: string;
  url: string;
  status: number;
  statusText: string;
  data: string | object;
}): ApiFetchResponseLogSummary {
  return {
    method: result.method,
    url: result.url,
    status: result.status,
    statusText: result.statusText,
    data: summarizeLogData(result.data),
  };
}

export function sanitizeLogPayload(value: unknown, seen?: WeakSet<object>): unknown {
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return summarizeLogText(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogPayload(entry, seen));
  }
  if (typeof value === 'object') {
    const localSeen = seen ?? new WeakSet<object>();
    if (localSeen.has(value)) {
      return '[circular]';
    }
    localSeen.add(value);
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = SENSITIVE_FIELD_NAME_RE.test(key) ? REDACTED : sanitizeLogPayload(entry, localSeen);
    }
    return sanitized;
  }
  return String(value);
}

export function summarizeLogText(value: string): string {
  const trimmed = value.length > MAX_LOG_PREVIEW_CHARS
    ? `${value.slice(0, MAX_LOG_PREVIEW_CHARS)}...[truncated]`
    : value;
  return trimmed.replace(/(Bearer\s+)[^\s"'\\]+/gi, `$1${REDACTED}`);
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED : value;
  }
  return redacted;
}

function summarizeLogData(data: string | object | undefined): ApiFetchLogDataSummary {
  if (typeof data === 'undefined') {
    return { type: 'none' };
  }
  if (typeof data === 'string') {
    return { type: 'string', length: data.length };
  }
  return { type: 'json', length: JSON.stringify(data).length };
}
