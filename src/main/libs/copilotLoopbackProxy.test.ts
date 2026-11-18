import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ session: { defaultSession: { fetch: vi.fn() } } }));

import { __copilotLoopbackProxyTestUtils, isAllowedProxyHost } from './copilotLoopbackProxy';

const PROXY_TOKEN = 'test-proxy-token';
const COPILOT_BASE = 'https://api.copilot.example.test';

type Deps = Parameters<typeof __copilotLoopbackProxyTestUtils.createRequestHandler>[0];

let server: http.Server | null = null;

afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const startServer = async (overrides: Partial<Deps> = {}) => {
  const upstreamCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const deps: Deps = {
    getAuthToken: () => PROXY_TOKEN,
    getCurrentToken: async () => ({ copilotToken: 'copilot-1', baseUrl: COPILOT_BASE }),
    refreshToken: async () => ({ copilotToken: 'copilot-2', baseUrl: COPILOT_BASE }),
    fetch: async (url, init) => {
      upstreamCalls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: Buffer.from(init.body as Uint8Array).toString('utf8'),
      });
      return new Response('data: {"ok":true}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    ...overrides,
  };
  const handle = __copilotLoopbackProxyTestUtils.createRequestHandler(deps);
  server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, upstreamCalls };
};

const post = (url: string, body: string, token: string | null = PROXY_TOKEN) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body,
});

describe('Copilot loopback proxy', () => {
  test('forwards chat completions with the Copilot token and IDE headers', async () => {
    const { baseUrl, upstreamCalls } = await startServer();
    const body = JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: '你好' }], stream: true });

    const response = await post(`${baseUrl}/v1/copilot/chat/completions`, body);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe(`${COPILOT_BASE}/chat/completions`);
    expect(upstreamCalls[0].body).toBe(body);
    expect(upstreamCalls[0].headers).toMatchObject({
      Authorization: 'Bearer copilot-1',
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.96.2',
      'Openai-Intent': 'conversation-panel',
    });
  });

  test('accepts the legacy path without the /v1 prefix', async () => {
    const { baseUrl, upstreamCalls } = await startServer();
    const response = await post(`${baseUrl}/copilot/chat/completions`, '{}');
    expect(response.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  test('rejects requests without the proxy token', async () => {
    const { baseUrl, upstreamCalls } = await startServer();
    const missing = await post(`${baseUrl}/v1/copilot/chat/completions`, '{}', null);
    const wrong = await post(`${baseUrl}/v1/copilot/chat/completions`, '{}', 'wrong-token');
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('serves health checks without authentication', async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'live' });
  });

  test('returns 404 for other routes', async () => {
    const { baseUrl, upstreamCalls } = await startServer();
    const response = await post(`${baseUrl}/v1/messages`, '{}');
    expect(response.status).toBe(404);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('refreshes the Copilot token once and retries on 401 or 403', async () => {
    const tokens: string[] = [];
    const { baseUrl } = await startServer({
      fetch: async (_url, init) => {
        const token = (init.headers as Record<string, string>).Authorization;
        tokens.push(token);
        return new Response('{}', { status: token === 'Bearer copilot-1' ? 401 : 200 });
      },
    });

    const response = await post(`${baseUrl}/v1/copilot/chat/completions`, '{}');

    expect(response.status).toBe(200);
    expect(tokens).toEqual(['Bearer copilot-1', 'Bearer copilot-2']);
  });

  test('fetches a token on demand and returns 503 when none is available', async () => {
    const { baseUrl, upstreamCalls } = await startServer({
      getCurrentToken: async () => null,
      refreshToken: async () => { throw new Error('not signed in'); },
    });
    const response = await post(`${baseUrl}/v1/copilot/chat/completions`, '{}');
    expect(response.status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });
});

// ==================== DNS Rebinding protection ====================

const fakeReq = (host?: string): http.IncomingMessage =>
  ({ headers: host !== undefined ? { host } : {} }) as http.IncomingMessage;

describe('isAllowedProxyHost', () => {
  test.each([
    '127.0.0.1:54321',
    '127.0.0.1',
    'localhost:12345',
    'localhost',
    '[::1]:12345',
    '[::1]',
    '',
  ])('accepts loopback host %s', (host) => {
    expect(isAllowedProxyHost(fakeReq(host))).toBe(true);
  });

  test('allows a missing Host header', () => {
    expect(isAllowedProxyHost(fakeReq(undefined))).toBe(true);
  });

  test.each(['evil.rebind.xxx:12345', 'attacker.com', '0.0.0.0:12345'])('rejects host %s', (host) => {
    expect(isAllowedProxyHost(fakeReq(host))).toBe(false);
  });
});
