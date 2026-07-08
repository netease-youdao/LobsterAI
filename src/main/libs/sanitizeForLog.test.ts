import { describe, expect, test } from 'vitest';

import { sanitizeUrlForLog, SENSITIVE_LOG_KEY_PATTERN, serializeForLog } from './sanitizeForLog';

// ---------------------------------------------------------------------------
// SENSITIVE_LOG_KEY_PATTERN — make sure every expected key variant matches
// ---------------------------------------------------------------------------
describe('SENSITIVE_LOG_KEY_PATTERN', () => {
  const shouldMatch = [
    'apiKey',
    'api_key',
    'api-key',
    'x-api-key',
    'ApiKey',
    'API_KEY',
    'token',
    'accessToken',
    'access_token',
    'access-token',
    'refreshToken',
    'refresh_token',
    'refresh-token',
    'secret',
    'password',
    'authorization',
    'Authorization',
    'cookie',
    'Cookie',
    'session',
    'sessionId',
  ];

  const shouldNotMatch = [
    'model',
    'Content-Type',
    'url',
    'method',
    'query',
    'name',
    'description',
    'anthropic-version',
    'status',
  ];

  // Known false positives: keys containing "token"/"session" substrings that
  // are not actually sensitive (e.g. "max_tokens"). Documenting so we can
  // tighten the regex later without breaking expectations.
  const knownFalsePositives = [
    'max_tokens',
  ];

  test.each(shouldMatch)('matches sensitive key: %s', (key) => {
    expect(SENSITIVE_LOG_KEY_PATTERN.test(key)).toBe(true);
  });

  test.each(shouldNotMatch)('does not match safe key: %s', (key) => {
    expect(SENSITIVE_LOG_KEY_PATTERN.test(key)).toBe(false);
  });

  test.each(knownFalsePositives)('known false positive (matches but not truly sensitive): %s', (key) => {
    expect(SENSITIVE_LOG_KEY_PATTERN.test(key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// serializeForLog — redaction in realistic structures
// ---------------------------------------------------------------------------
describe('serializeForLog', () => {
  test('redacts x-api-key in HTTP-style headers object', () => {
    const result = serializeForLog({
      'x-api-key': 'sk-ant-1234567890abcdef',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    });

    expect(result).toContain('[redacted]');
    expect(result).not.toContain('sk-ant-1234567890abcdef');
    expect(result).toContain('2023-06-01');
    expect(result).toContain('application/json');
  });

  test('redacts authorization header', () => {
    const result = serializeForLog({
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
    });

    expect(result).toContain('[redacted]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  test('redacts multiple sensitive keys in one object', () => {
    const result = serializeForLog({
      apiKey: 'key-123',
      password: 'p@ss',
      secret: 'shh',
      model: 'glm-5',
    });

    expect(result).not.toContain('key-123');
    expect(result).not.toContain('p@ss');
    expect(result).not.toContain('shh');
    expect(result).toContain('glm-5');
  });

  test('redacts sensitive values in deeply nested objects', () => {
    const result = serializeForLog({
      provider: {
        config: {
          api_key: 'deep-secret-key',
          endpoint: 'https://api.example.com',
        },
      },
    });

    expect(result).not.toContain('deep-secret-key');
    expect(result).toContain('https://api.example.com');
  });

  test('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { name: 'test' };
    obj.self = obj;

    const result = serializeForLog(obj);

    expect(result).toContain('[circular]');
    expect(result).toContain('test');
  });

  test('preserves non-sensitive primitive values', () => {
    const result = serializeForLog({
      count: 42,
      enabled: true,
      label: null,
    });

    expect(result).toContain('42');
    expect(result).toContain('true');
    expect(result).toContain('null');
  });
});

describe('sanitizeUrlForLog', () => {
  test('removes query values and fragments from valid URLs', () => {
    const result = sanitizeUrlForLog(
      'https://rlogs.youdao.com/rlog.php?action=lobsterai_app_started&log_Usid=user-1#result',
    );

    expect(result).toBe('https://rlogs.youdao.com/rlog.php?[redacted]#[redacted]');
    expect(result).not.toContain('user-1');
    expect(result).not.toContain('lobsterai_app_started');
  });

  test('returns a safe marker for invalid URLs', () => {
    expect(sanitizeUrlForLog('not a URL')).toBe('[invalid-url]');
  });
});
