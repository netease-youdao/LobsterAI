export const MAIL_PROVIDER = 'netease-mail';
export const MAIL_SCOPE = 'mail:read';
export const MAIL_TOKEN_URL = 'https://mail.163.com/fgw/mailsrv-oauth2-fapi/oauth2/token';
export const MailRefreshError = { Unauthorized: 'NETEASE_MAIL_AUTH_EXPIRED', RateLimited: 'NETEASE_MAIL_RATE_LIMITED', Failed: 'NETEASE_MAIL_REFRESH_FAILED' } as const;

interface Credential { type: 'oauth'; provider: string; access: string; refresh: string; expires: number; clientId?: string }
interface Config { clientId: string }

function fetchToken(body: URLSearchParams): Promise<Response> {
  return fetch(MAIL_TOKEN_URL, {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
}

/** OpenClaw's auth-profile lease serializes refresh and persists rotated tokens. */
export async function refreshMailCredential(
  credential: Credential, config: Config,
  exchange = fetchToken, now = Date.now,
): Promise<Credential> {
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
  if (!token || typeof token.access_token !== 'string' || !token.access_token
    || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
    || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    || (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token))
    || (token.scope !== undefined && (typeof token.scope !== 'string' || token.scope.trim() !== MAIL_SCOPE))) {
    throw new Error(MailRefreshError.Failed);
  }
  return {
    ...credential, access: token.access_token,
    refresh: typeof token.refresh_token === 'string' ? token.refresh_token : credential.refresh,
    expires: now() + token.expires_in * 1000,
  };
}
