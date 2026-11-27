import { expect, test, vi } from 'vitest';

import { NeteaseMail, NeteaseMailAuth, NeteaseMailScope } from '../../shared/neteaseMail/constants';
import { McpOAuthManager, type McpOAuthTokenRecord } from './mcpOAuthManager';
import type { McpServerRecord } from './mcpStore';
import { createNeteaseMailAuthStore } from './neteaseMailAuthStore';
import { getNeteaseMailOAuthConfig } from './neteaseMailConfig';

function fixture() {
  const kv = new Map<string, string>();
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const manager = new McpOAuthManager({ storage: { get: key => kv.get(key) ?? null, set: (k, v) => { kv.set(k, v); },
    delete: key => { kv.delete(key); } }, fetcher });
  const invalidate = vi.fn();
  const server = { id: 'mail-id', enabled: true } as McpServerRecord;
  const config = getNeteaseMailOAuthConfig(false, { LOBSTER_NETEASE_MAIL_CLIENT_ID: 'client' })!;
  const store = createNeteaseMailAuthStore(manager, config, () => server, invalidate);
  const credential = { type: NeteaseMailAuth.CredentialType, provider: NeteaseMailAuth.Provider, clientId: 'client',
    access: 'first-access', refresh: 'first-refresh', expires: Date.now() - 1, authorizationId: 'first' };
  const refreshed = () => finish(Response.json({ token_type: 'Bearer', access_token: 'rotated', expires_in: 3600 }));
  return { manager, store, invalidate, server, credential, fetcher, refreshed };
}

test('read scopes and connection status exclude credentials and require an enabled connector', async () => {
  const f = fixture();
  f.credential.expires = Date.now() + 600_000;
  await f.store.save(f.credential);
  expect(await f.store.status()).toEqual({ connected: true, expiresAt: f.credential.expires, scopes: [NeteaseMailScope.Read] });
  expect(f.manager.getToken(f.server.id)).toMatchObject({ mailAuthorizationId: 'first', resource: NeteaseMail.Endpoint, accessToken: 'first-access' });
  f.server.enabled = false;
  expect(await f.store.status()).toEqual({ connected: false });
  await f.store.remove();
  expect(f.manager.getToken(f.server.id)).toBeNull();
  expect(f.invalidate).toHaveBeenCalledTimes(2);
});

test.each([undefined, 'https://staging.example.com/mail/mcp'])('does not use or refresh a grant for resource %s', async resource => {
  const f = fixture();
  await f.store.save(f.credential);
  f.manager.saveToken({ ...f.manager.getToken(f.server.id)!, resource });
  expect(await f.store.status()).toEqual({ connected: false });
  expect(f.fetcher).not.toHaveBeenCalled();
});

test('refresh keeps a grant bound to its original resource', async () => {
  const f = fixture();
  await f.store.save(f.credential);
  const status = f.store.status();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  f.refreshed();
  expect(await status).toMatchObject({ connected: true, scopes: [NeteaseMailScope.Read] });
  expect(f.manager.getToken(f.server.id)).toMatchObject({ resource: NeteaseMail.Endpoint, accessToken: 'rotated' });
});

test.each(['disconnect', 'reauthorize'])('%s during token rotation cannot restore an old grant', async action => {
  const f = fixture();
  await f.store.save(f.credential);
  const pending = f.manager.resolveAuthorizationHeaders(f.server.id);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  if (action === 'disconnect') await f.store.remove();
  else await f.store.save({ ...f.credential, access: 'new-account', authorizationId: 'second' });
  f.refreshed();
  await expect(pending).rejects.toThrow();
  const token: McpOAuthTokenRecord | null = f.manager.getToken(f.server.id);
  expect(token?.accessToken).toBe(action === 'disconnect' ? undefined : 'new-account');
});
