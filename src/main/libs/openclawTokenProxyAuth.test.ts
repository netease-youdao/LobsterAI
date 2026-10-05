import http from 'http';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

import {
  getOpenClawTokenProxyPort,
  getOpenClawTokenProxyToken,
  startOpenClawTokenProxy,
  stopOpenClawTokenProxy,
} from './openclawTokenProxy';

afterEach(() => {
  stopOpenClawTokenProxy();
});

function baseConfig() {
  return {
    getAuthTokens: () => null,
    refreshToken: vi.fn(),
    getServerBaseUrl: () => 'https://example.invalid',
    getClientVersion: () => '0.0.0',
  };
}

function request(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const port = getOpenClawTokenProxyPort();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('rejects a request with no Authorization header', async () => {
  await startOpenClawTokenProxy(baseConfig());

  const { status, body } = await request('/v1/chat/completions', {});

  expect(status).toBe(401);
  expect(body).toContain('Unauthorized');
});

test('rejects a request bearing the wrong token', async () => {
  await startOpenClawTokenProxy(baseConfig());

  const { status } = await request('/v1/chat/completions', { Authorization: 'Bearer not-the-right-token' });

  expect(status).toBe(401);
});

test('accepts a request bearing the proxy own generated token', async () => {
  await startOpenClawTokenProxy(baseConfig());
  const token = getOpenClawTokenProxyToken();
  expect(token).toBeTruthy();

  const { status, body } = await request('/v1/chat/completions', { Authorization: `Bearer ${token}` });

  // getAuthTokens() returns null in baseConfig, so a request that gets past
  // the auth check hits the "no auth tokens available" branch next, not a
  // 401 - that distinguishes "authenticated, nothing to forward to yet"
  // from "rejected at the door" for this test's purposes.
  expect(status).toBe(503);
  expect(body).toContain('No auth tokens available');
});
