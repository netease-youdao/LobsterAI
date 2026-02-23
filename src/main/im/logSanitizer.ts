const MASK_MIN_LENGTH = 4;
const REDACTED_TEXT = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'accesskey',
  'accesstoken',
  'appkey',
  'appsecret',
  'authorization',
  'bottoken',
  'clientid',
  'clientsecret',
  'secret',
  'token',
]);

const URL_PARAM_PATTERN = /([?&](?:access_token|accesstoken|appsecret|app_secret|clientsecret|client_secret|token)=)([^&#\s]+)/gi;
const KV_PATTERN = /((?:access[_-]?token|app[_-]?secret|app[_-]?key|client[_-]?secret|client[_-]?id|bot[_-]?token|token)\s*[:=]\s*['"]?)([^'",\s}]+)/gi;
const AUTH_BEARER_PATTERN = /(authorization:\s*bearer\s+)([a-z0-9._-]+)/gi;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  return SENSITIVE_KEYS.has(normalized)
    || normalized.endsWith('secret')
    || normalized.endsWith('token');
}

export function maskSecretMiddle(value: string, keepStart = 3, keepEnd = 2): string {
  const input = value.trim();
  if (!input) return input;
  if (input.length <= keepStart + keepEnd) {
    return '*'.repeat(Math.max(1, input.length));
  }
  const maskLength = Math.max(MASK_MIN_LENGTH, input.length - keepStart - keepEnd);
  return `${input.slice(0, keepStart)}${'*'.repeat(maskLength)}${input.slice(-keepEnd)}`;
}

export function sanitizeSensitiveString(value: string): string {
  return value
    .replace(URL_PARAM_PATTERN, (_match, prefix: string, secret: string) => `${prefix}${maskSecretMiddle(secret)}`)
    .replace(KV_PATTERN, (_match, prefix: string, secret: string) => `${prefix}${maskSecretMiddle(secret)}`)
    .replace(AUTH_BEARER_PATTERN, (_match, prefix: string, secret: string) => `${prefix}${maskSecretMiddle(secret)}`);
}

function redactSensitiveValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return maskSecretMiddle(value);
  return REDACTED_TEXT;
}

function sanitizeObject(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeSensitiveString(value);
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof RegExp) return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeSensitiveString(value.message),
      stack: value.stack ? sanitizeSensitiveString(value.stack) : undefined,
    };
  }

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => sanitizeObject(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = redactSensitiveValue(nested);
    } else {
      output[key] = sanitizeObject(nested, seen);
    }
  }
  return output;
}

export function sanitizeLogArg<T>(arg: T): T {
  return sanitizeObject(arg, new WeakSet()) as T;
}

export function sanitizeLogArgs(args: unknown[]): unknown[] {
  return args.map(arg => sanitizeLogArg(arg));
}
