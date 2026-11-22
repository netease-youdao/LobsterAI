import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  FEISHU_ENV_URLS,
  FEISHU_REGISTRATION_PATH,
  FeishuAuth,
  FeishuPollError,
  FeishuTenantBrand,
  LARK_ENV_URLS,
  validateAppCredentials,
} from './feishuInstallAuth';

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface MockServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (req: RecordedRequest, res: http.ServerResponse) => void,
): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

describe('feishuInstallAuth', () => {
  const servers: MockServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  test('setDomain switches between Feishu and Lark registration hosts', async () => {
    const capturedUrls: string[] = [];
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      capturedUrls.push(String(input));
      return new Response(JSON.stringify({ nonce: 'n-1', supported_auth_methods: ['client_secret'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const auth = new FeishuAuth({ fetchImpl: mockFetch });
    expect(auth.getBaseUrl()).toBe(FEISHU_ENV_URLS.prod);

    await auth.init();
    auth.setDomain(true);
    expect(auth.getBaseUrl()).toBe(LARK_ENV_URLS.prod);
    await auth.init();

    auth.setDomain(false);
    expect(auth.getBaseUrl()).toBe(FEISHU_ENV_URLS.prod);
    await auth.init();

    expect(capturedUrls).toEqual([
      `${FEISHU_ENV_URLS.prod}${FEISHU_REGISTRATION_PATH}`,
      `${LARK_ENV_URLS.prod}${FEISHU_REGISTRATION_PATH}`,
      `${FEISHU_ENV_URLS.prod}${FEISHU_REGISTRATION_PATH}`,
    ]);
  });

  test('init and begin send form-urlencoded requests and return registration payloads', async () => {
    const server = await startMockServer((req, res) => {
      const params = new URLSearchParams(req.body);
      const action = params.get('action');
      res.setHeader('Content-Type', 'application/json');
      if (action === 'init') {
        res.statusCode = 200;
        res.end(JSON.stringify({ nonce: 'nonce-123', supported_auth_methods: ['client_secret'] }));
        return;
      }
      if (action === 'begin') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          device_code: 'dev-code-456',
          verification_uri: 'https://accounts.feishu.cn/verify',
          user_code: 'ABCD-1234',
          verification_uri_complete: 'https://accounts.feishu.cn/verify?code=ABCD-1234',
          interval: 5,
          expire_in: 300,
        }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'unsupported_action' }));
    });
    servers.push(server);

    const auth = new FeishuAuth({ baseUrl: server.baseUrl, lane: 'boe_test_lane' });
    const initResp = await auth.init();
    const beginResp = await auth.begin();

    expect(initResp).toEqual({
      nonce: 'nonce-123',
      supported_auth_methods: ['client_secret'],
    });
    expect(beginResp).toEqual({
      device_code: 'dev-code-456',
      verification_uri: 'https://accounts.feishu.cn/verify',
      user_code: 'ABCD-1234',
      verification_uri_complete: 'https://accounts.feishu.cn/verify?code=ABCD-1234',
      interval: 5,
      expire_in: 300,
    });

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].method).toBe('POST');
    expect(server.requests[0].url).toBe(FEISHU_REGISTRATION_PATH);
    expect(server.requests[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(server.requests[0].headers['x-tt-env']).toBe('boe_test_lane');
    expect(new URLSearchParams(server.requests[0].body).get('action')).toBe('init');

    const beginParams = new URLSearchParams(server.requests[1].body);
    expect(beginParams.get('action')).toBe('begin');
    expect(beginParams.get('archetype')).toBe('PersonalAgent');
    expect(beginParams.get('auth_method')).toBe('client_secret');
    expect(beginParams.get('request_user_info')).toBe('open_id');
  });

  test('poll handles pending, slow_down, denied, expired (HTTP 400 JSON), and approved (HTTP 200)', async () => {
    const server = await startMockServer((req, res) => {
      const params = new URLSearchParams(req.body);
      expect(params.get('action')).toBe('poll');
      const code = params.get('device_code');
      res.setHeader('Content-Type', 'application/json');

      if (code === 'pending') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: FeishuPollError.AuthorizationPending }));
        return;
      }
      if (code === 'slow') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: FeishuPollError.SlowDown }));
        return;
      }
      if (code === 'denied') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: FeishuPollError.AccessDenied,
          error_description: 'User rejected authorization',
        }));
        return;
      }
      if (code === 'expired') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: FeishuPollError.ExpiredToken,
          error_description: 'Device code expired',
        }));
        return;
      }
      if (code === 'approved-feishu') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          client_id: 'cli_a1b2c3',
          client_secret: 'sec_x9y8z7',
          user_info: { open_id: 'ou_12345', tenant_brand: FeishuTenantBrand.Feishu },
        }));
        return;
      }
      if (code === 'approved-lark') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          client_id: 'cli_lark99',
          client_secret: 'sec_lark88',
          user_info: { open_id: 'ou_99999', tenant_brand: FeishuTenantBrand.Lark },
        }));
        return;
      }

      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Bad Gateway');
    });
    servers.push(server);

    const auth = new FeishuAuth({ baseUrl: server.baseUrl });

    expect(await auth.poll('pending')).toEqual({ error: FeishuPollError.AuthorizationPending });
    expect(await auth.poll('slow')).toEqual({ error: FeishuPollError.SlowDown });
    expect(await auth.poll('denied')).toEqual({
      error: FeishuPollError.AccessDenied,
      error_description: 'User rejected authorization',
    });
    expect(await auth.poll('expired')).toEqual({
      error: FeishuPollError.ExpiredToken,
      error_description: 'Device code expired',
    });
    expect(await auth.poll('approved-feishu')).toEqual({
      client_id: 'cli_a1b2c3',
      client_secret: 'sec_x9y8z7',
      user_info: { open_id: 'ou_12345', tenant_brand: FeishuTenantBrand.Feishu },
    });
    expect(await auth.poll('approved-lark')).toEqual({
      client_id: 'cli_lark99',
      client_secret: 'sec_lark88',
      user_info: { open_id: 'ou_99999', tenant_brand: FeishuTenantBrand.Lark },
    });

    await expect(auth.poll('gateway-error')).rejects.toThrow(/HTTP 502/);
  });

  test('init and begin throw on HTTP error responses', async () => {
    const server = await startMockServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error', error_description: 'upstream unavailable' }));
    });
    servers.push(server);

    const auth = new FeishuAuth({ baseUrl: server.baseUrl });
    await expect(auth.init()).rejects.toThrow(/HTTP 500.*upstream unavailable/);
    await expect(auth.begin()).rejects.toThrow(/HTTP 500.*upstream unavailable/);
  });

  test('validateAppCredentials verifies tenant access token response and handles failures safely', async () => {
    const server = await startMockServer((req, res) => {
      const payload = JSON.parse(req.body) as { app_id?: string; app_secret?: string };
      res.setHeader('Content-Type', 'application/json');
      if (payload.app_id === 'cli_valid' && payload.app_secret === 'sec_valid') {
        res.statusCode = 200;
        res.end(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't-token-123' }));
        return;
      }
      if (payload.app_id === 'cli_http500') {
        res.statusCode = 500;
        res.end('server error');
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ code: 10003, msg: 'invalid app secret' }));
    });
    servers.push(server);

    const endpointUrl = `${server.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;

    expect(await validateAppCredentials('  cli_valid  ', ' sec_valid ', { endpointUrl })).toBe(true);
    expect(await validateAppCredentials('cli_valid', 'wrong', { endpointUrl })).toBe(false);
    expect(await validateAppCredentials('cli_http500', 'sec', { endpointUrl })).toBe(false);
    expect(await validateAppCredentials('', 'sec_valid', { endpointUrl })).toBe(false);
    expect(await validateAppCredentials('cli_valid', '   ', { endpointUrl })).toBe(false);

    const failingFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    expect(await validateAppCredentials('cli_valid', 'sec_valid', { fetchImpl: failingFetch })).toBe(false);
  });
});
