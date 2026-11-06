import { expect, test, vi } from 'vitest';

import { MAIL_PROVIDER, MAIL_SCOPE, MailRefreshError, refreshMailCredential } from '../openclaw-extensions/netease-mail/refresh';
import { NeteaseMailDefaultScopes, NeteaseMailScope } from '../src/shared/neteaseMail/constants';

const credential = { type: 'oauth' as const, provider: MAIL_PROVIDER, clientId: 'client-test', access: 'old-access', refresh: 'old-refresh', expires: 1 };
const config = { clientId: credential.clientId };
const token = { access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600, scope: MAIL_SCOPE };

test('refresh rotates both tokens in one response and retains refresh when omitted', async () => {
  const exchange = vi.fn(async () => Response.json(token));
  expect(await refreshMailCredential(credential, config, exchange, () => 1000)).toMatchObject({ access: 'new-access', refresh: 'new-refresh', expires: 3_601_000 });
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(credential.refresh).toBe('old-refresh');
  expect(await refreshMailCredential(credential, config, async () => Response.json({ ...token, refresh_token: undefined }))).toMatchObject({ refresh: 'old-refresh' });
});

test('rate limits and invalid grants return stable non-secret errors without retry', async () => {
  for (const [status, error] of [[429, MailRefreshError.RateLimited], [400, MailRefreshError.Unauthorized], [500, MailRefreshError.Failed]] as const) {
    const exchange = vi.fn(async () => Response.json({ error_description: 'private-upstream-value' }, { status }));
    await expect(refreshMailCredential(credential, config, exchange)).rejects.toThrow(error);
    expect(exchange).toHaveBeenCalledTimes(1);
  }
});

test('rejects broader scopes and a credential for a different client', async () => {
  await expect(refreshMailCredential(credential, config, async () => Response.json({ ...token, scope: `${MAIL_SCOPE} mail:send` }))).rejects.toThrow(MailRefreshError.Failed);
  const exchange = vi.fn(async () => Response.json(token));
  await expect(refreshMailCredential(credential, { clientId: 'another-client' }, exchange)).rejects.toThrow(MailRefreshError.Unauthorized);
  expect(exchange).not.toHaveBeenCalled();
});

test('renews the persisted write grant without silently retaining revoked permissions', async () => {
  const writeConfig = { ...config, scopes: NeteaseMailDefaultScopes };
  const renewed = await refreshMailCredential(credential, writeConfig, async () => Response.json({ ...token, scope: undefined }));
  expect(renewed.scope).toBe(NeteaseMailDefaultScopes.join(' '));
  await expect(refreshMailCredential(credential, writeConfig, async () => Response.json(token)))
    .rejects.toThrow(MailRefreshError.Unauthorized);
  await expect(refreshMailCredential(credential, writeConfig, async () => Response.json({ ...token, scope: [...NeteaseMailDefaultScopes, NeteaseMailScope.Delete].join(' ') })))
    .rejects.toThrow(MailRefreshError.Failed);
});
