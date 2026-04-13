import { expect, test } from 'vitest';

import {
  sanitizeLogPayload,
  summarizeApiFetchRequest,
  summarizeApiFetchResponse,
  summarizeLogText,
} from './apiFetchLog';

test('api fetch request summary redacts credentials and omits body content', () => {
  const summary = summarizeApiFetchRequest({
    method: 'POST',
    url: 'https://api.example.com/v1/messages',
    headers: {
      Authorization: 'Bearer sk-lobster-log-test-DO-NOT-USE-123456',
      'x-api-key': 'sk-anthropic-test-123456',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: 'secret-access-token', prompt: 'hello' }),
  });

  const serialized = JSON.stringify(summary);

  expect(summary.headers.Authorization).toBe('[redacted]');
  expect(summary.headers['x-api-key']).toBe('[redacted]');
  expect(summary.headers['Content-Type']).toBe('application/json');
  expect(summary.body).toEqual({ type: 'string', length: 55 });
  expect(serialized).not.toContain('sk-lobster-log-test-DO-NOT-USE-123456');
  expect(serialized).not.toContain('sk-anthropic-test-123456');
  expect(serialized).not.toContain('secret-access-token');
  expect(serialized).not.toContain('hello');
});

test('api fetch response summary omits response payload content', () => {
  const summary = summarizeApiFetchResponse({
    method: 'POST',
    url: 'https://api.example.com/oauth/token',
    status: 200,
    statusText: 'OK',
    data: {
      access_token: 'secret-access-token',
      refresh_token: 'secret-refresh-token',
    },
  });

  const serialized = JSON.stringify(summary);

  expect(summary.data.type).toBe('json');
  expect(summary.data.length).toBeGreaterThan(0);
  expect(serialized).not.toContain('secret-access-token');
  expect(serialized).not.toContain('secret-refresh-token');
});

test('generic log sanitizer redacts nested secret fields', () => {
  const summary = sanitizeLogPayload({
    payload: {
      message: 'daily reminder',
      apiKey: 'sk-provider-secret',
      oauthRefreshToken: 'refresh-token-secret',
      clientSecret: 'client-secret-value',
    },
    delivery: {
      to: 'user@example.com',
      accountId: 'bot-main',
    },
  });

  const serialized = JSON.stringify(summary);

  expect(serialized).toContain('daily reminder');
  expect(serialized).toContain('user@example.com');
  expect(serialized).not.toContain('sk-provider-secret');
  expect(serialized).not.toContain('refresh-token-secret');
  expect(serialized).not.toContain('client-secret-value');
});

test('text log sanitizer redacts bearer tokens and truncates long provider errors', () => {
  const sanitized = summarizeLogText(`failed Authorization: Bearer sk-provider-secret ${'x'.repeat(600)}`);

  expect(sanitized).toContain('Bearer [redacted]');
  expect(sanitized).toContain('[truncated]');
  expect(sanitized).not.toContain('sk-provider-secret');
});
