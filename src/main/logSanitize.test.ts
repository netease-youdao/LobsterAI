import { describe, expect, test } from 'vitest';

import { redactHeadersForLog, sanitizeUrlForLog } from './logSanitize';

describe('sanitizeUrlForLog', () => {
  test('strips query string from valid URL', () => {
    expect(sanitizeUrlForLog('https://api.example.com/v1/foo?token=secret')).toBe(
      'https://api.example.com/v1/foo',
    );
  });

  test('strips fragment from valid URL', () => {
    expect(sanitizeUrlForLog('https://api.example.com/v1/foo#section')).toBe(
      'https://api.example.com/v1/foo',
    );
  });

  test('preserves origin and pathname', () => {
    expect(sanitizeUrlForLog('https://api.example.com:8443/v1/foo/bar')).toBe(
      'https://api.example.com:8443/v1/foo/bar',
    );
  });

  test('handles deep-link style URLs without losing scheme', () => {
    expect(sanitizeUrlForLog('lobsterai://auth/callback?code=abc')).toBe(
      'lobsterai://auth/callback',
    );
  });

  test('returns sentinel for empty input', () => {
    expect(sanitizeUrlForLog('')).toBe('<empty-url>');
    expect(sanitizeUrlForLog(undefined as unknown as string)).toBe('<empty-url>');
  });

  test('falls back gracefully for malformed URLs', () => {
    expect(sanitizeUrlForLog('not a url?token=x')).toBe('not a url');
  });

  test('keeps non-special schemes intact', () => {
    expect(sanitizeUrlForLog('mailto:foo@example.com?subject=hi')).toBe('mailto:foo@example.com');
    expect(sanitizeUrlForLog('ws://srv.example.com:8080/path?token=secret')).toBe(
      'ws://srv.example.com:8080/path',
    );
  });
});

describe('redactHeadersForLog', () => {
  test('redacts Authorization header regardless of case', () => {
    const out = redactHeadersForLog({
      Authorization: 'Bearer abc',
      'content-type': 'application/json',
    });
    expect(out.Authorization).toBe('***');
    expect(out['content-type']).toBe('application/json');
  });

  test('redacts API key style headers', () => {
    const out = redactHeadersForLog({
      'x-api-key': 'sk-123',
      'X-Anthropic-Api-Key': 'sk-anthropic',
      'x-openai-api-key': 'sk-openai',
      'X-Goog-Api-Key': 'sk-goog',
      cookie: 'session=foo',
      'set-cookie': 'token=bar',
    });
    expect(out['x-api-key']).toBe('***');
    expect(out['X-Anthropic-Api-Key']).toBe('***');
    expect(out['x-openai-api-key']).toBe('***');
    expect(out['X-Goog-Api-Key']).toBe('***');
    expect(out.cookie).toBe('***');
    expect(out['set-cookie']).toBe('***');
  });

  test('returns empty object for null or undefined input', () => {
    expect(redactHeadersForLog(null)).toEqual({});
    expect(redactHeadersForLog(undefined)).toEqual({});
  });

  test('keeps non-sensitive headers untouched', () => {
    const out = redactHeadersForLog({
      'user-agent': 'lobsterai/1.0',
      accept: 'application/json',
    });
    expect(out['user-agent']).toBe('lobsterai/1.0');
    expect(out.accept).toBe('application/json');
  });
});
