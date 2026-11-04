import { createHash } from 'node:crypto';
import http from 'node:http';

import { afterEach, expect, test, vi } from 'vitest';

import { NeteaseMail, NeteaseMailAuth, NeteaseMailError, NeteaseMailFailure } from '../../shared/neteaseMail/constants';
import { getNeteaseMailOAuthConfig } from './neteaseMailConfig';
import { authorizeNeteaseMail, parseNeteaseMailToken } from './neteaseMailOAuth';

const token = { access_token: 'access-test', refresh_token: 'refresh-test', token_type: 'Bearer', expires_in: 3600, scope: NeteaseMailAuth.Scope };
const controllers: AbortController[] = [];
afterEach(() => { for (const controller of controllers) controller.abort(); controllers.length = 0; });
async function options() {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const controller = new AbortController();
  controllers.push(controller);
  return { controller, config: { ...getNeteaseMailOAuthConfig(false, { LOBSTER_NETEASE_MAIL_CLIENT_ID: 'client-test' })!, redirectUri: `http://localhost:${port}/oauth/callback` },
    signal: controller.signal, callbackText: 'Return to LobsterAI', fetch: vi.fn<typeof fetch>(async () => Response.json(token)) };
}
function callbackUrl(auth: URL, state = auth.searchParams.get('state')!) {
  const url = new URL(auth.searchParams.get('redirect_uri')!);
  url.search = new URLSearchParams({ state, code: 'code-test' }).toString();
  return url;
}

test('PKCE callback rejects forged state, then exchanges once with read-only scope and no secret', async () => {
  const opts = await options();
  let challenge = '';
  const result = await authorizeNeteaseMail({ ...opts, openExternal: async value => {
    const url = new URL(value);
    expect(url.searchParams.get('scope')).toBe(NeteaseMailAuth.Scope);
    expect(url.searchParams.get('client_id')).toBe(opts.config.clientId);
    challenge = url.searchParams.get('code_challenge')!;
    expect((await fetch(callbackUrl(url, 'wrong-state'))).status).toBe(400);
    const response = await fetch(callbackUrl(url));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('code-test');
  } });
  expect(result).toMatchObject({ access: token.access_token, provider: NeteaseMailAuth.Provider });
  expect(opts.fetch).toHaveBeenCalledTimes(1);
  const body = opts.fetch.mock.calls[0][1]!.body as URLSearchParams;
  expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
  expect(body.has('client_secret')).toBe(false);
});

test('cancels pending authorization and releases the callback listener', async () => {
  const opts = await options();
  await expect(authorizeNeteaseMail({ ...opts, openExternal: async () => { opts.controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(opts.fetch).not.toHaveBeenCalled();
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(opts.config.redirectUri).port), '127.0.0.1', resolve); });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('reports port conflicts before opening the browser and times out without token calls', async () => {
  const opts = await options();
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(Number(new URL(opts.config.redirectUri).port), '127.0.0.1', resolve));
  const openExternal = vi.fn(async () => {});
  try {
    await expect(authorizeNeteaseMail({ ...opts, openExternal })).rejects.toMatchObject({ code: NeteaseMailFailure.PortBusy });
    expect(openExternal).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  await expect(authorizeNeteaseMail({ ...opts, openExternal, timeoutMs: 50 })).rejects.toMatchObject({ code: NeteaseMailFailure.TimedOut });
  expect(opts.fetch).not.toHaveBeenCalled();
});

test('denied authorization does not exchange a token and token grants cannot broaden scope', async () => {
  const opts = await options();
  await expect(authorizeNeteaseMail({ ...opts, openExternal: async value => {
    const url = callbackUrl(new URL(value));
    url.searchParams.set('error', 'access_denied');
    await fetch(url);
  } })).rejects.toMatchObject({ code: NeteaseMailFailure.Denied });
  expect(opts.fetch).not.toHaveBeenCalled();
  expect(() => parseNeteaseMailToken({ ...token, scope: 'mail:read mail:send' }, 'id')).toThrow(String(NeteaseMailError.InsufficientScope));
  expect(() => parseNeteaseMailToken({ ...token, expires_in: -1 }, 'id')).toThrow();
});

test('requires explicit client registration and ignores local endpoint overrides in packaged apps', () => {
  expect(getNeteaseMailOAuthConfig(false, {})).toBeUndefined();
  expect(getNeteaseMailOAuthConfig(true, {})).toBeUndefined();
  const env = { LOBSTER_NETEASE_MAIL_CLIENT_ID: 'client-test', LOBSTER_NETEASE_MAIL_MCP_URL: 'https://mail.example.com/mcp' };
  expect(getNeteaseMailOAuthConfig(false, env)).toMatchObject({ clientId: env.LOBSTER_NETEASE_MAIL_CLIENT_ID, mcpUrl: env.LOBSTER_NETEASE_MAIL_MCP_URL });
  expect(getNeteaseMailOAuthConfig(true, env)).toMatchObject({ mcpUrl: NeteaseMail.Endpoint });
  for (const mcpUrl of ['not-a-url', 'http://mail.example.com/mcp', 'https://user:password@mail.example.com/mcp']) {
    expect(getNeteaseMailOAuthConfig(false, { ...env, LOBSTER_NETEASE_MAIL_MCP_URL: mcpUrl })).toBeUndefined();
  }
});
