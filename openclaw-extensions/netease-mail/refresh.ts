export const MAIL_PROVIDER = 'netease-mail';
export const MAIL_SCOPE = 'mail:read';
export const MAIL_TOKEN_URL = 'https://mail.163.com/fgw/mailsrv-oauth2-fapi/oauth2/token';
export const MailRefreshError = { Unauthorized: 'NETEASE_MAIL_AUTH_EXPIRED', RateLimited: 'NETEASE_MAIL_RATE_LIMITED', Failed: 'NETEASE_MAIL_REFRESH_FAILED' } as const;

export interface MailCredential { type: 'oauth'; provider: string; access: string; refresh: string; expires: number; clientId?: string; scope?: string; authorizationId?: string }
interface Config { clientId: string; scopes?: readonly string[] }

function fetchToken(body: URLSearchParams): Promise<Response> {
  return fetch(MAIL_TOKEN_URL, {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
}

/** OpenClaw's auth-profile lease serializes refresh and persists rotated tokens. */
export async function refreshMailCredential(
  credential: MailCredential, config: Config,
  exchange = fetchToken, now = Date.now,
): Promise<MailCredential> {
  if (credential.provider !== MAIL_PROVIDER || !credential.refresh || credential.clientId !== config.clientId) {
    throw new Error(MailRefreshError.Unauthorized);
  }
  let response: Response;
  try {
    response = await exchange(new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: config.clientId,
    }));
  } catch { throw new Error(MailRefreshError.Failed); }
  if (response.status === 429) throw new Error(MailRefreshError.RateLimited);
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401
    ? MailRefreshError.Unauthorized : MailRefreshError.Failed);
  let token: Record<string, unknown>;
  try { token = await response.json() as Record<string, unknown>; } catch { throw new Error(MailRefreshError.Failed); }
  const previousScopes = config.scopes ?? (credential.scope ?? MAIL_SCOPE).trim().split(/\s+/);
  const grantedScopes = token?.scope === undefined ? previousScopes
    : typeof token.scope === 'string' ? [...new Set(token.scope.trim().split(/\s+/))] : [];
  if (!token || typeof token.access_token !== 'string' || !token.access_token
    || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
    || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    || (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token))
    || !grantedScopes.includes(MAIL_SCOPE) || grantedScopes.some(scope => !previousScopes.includes(scope))) {
    throw new Error(MailRefreshError.Failed);
  }
  // A changed grant needs a new desktop authorization. Do not leave persisted
  // permission metadata broader than the renewed credential (SDK strips scope).
  if (previousScopes.some(scope => !grantedScopes.includes(scope))) throw new Error(MailRefreshError.Unauthorized);
  return {
    ...credential, access: token.access_token,
    refresh: typeof token.refresh_token === 'string' ? token.refresh_token : credential.refresh,
    expires: now() + token.expires_in * 1000,
    scope: grantedScopes.join(' '),
  };
}
