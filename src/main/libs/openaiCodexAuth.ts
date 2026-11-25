/**
 * OpenAI ChatGPT (Codex) OAuth login for desktop.
 *
 * Implements the same PKCE flow as the official Codex CLI:
 *   1. Open https://auth.openai.com/oauth/authorize in the user's browser
 *   2. Listen on http://127.0.0.1:1455/auth/callback for the redirect
 *   3. Exchange the authorization code for access/refresh/id tokens
 *   4. Persist the result to <CODEX_HOME>/auth.json so the OpenClaw runtime
 *      (which reads the same file) automatically routes OpenAI calls to
 *      https://chatgpt.com/backend-api/codex/responses with the OAuth bearer token.
 *
 * The fixed redirect URI (http://127.0.0.1:1455/auth/callback) is required —
 * OpenAI registered this exact value for the Codex public client; it cannot
 * be changed. If port 1455 is already taken (e.g. the user is already running
 * the Codex CLI's `codex login` flow) startOpenAICodexLogin throws a
 * descriptive error.
 */

import crypto from 'crypto';
import { app, session, shell } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';

// Codex public client ID — same value the Codex CLI and pi-ai/oauth use.
// Public, non-secret.
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_REDIRECT_PORT = 1455;
// Must match Codex CLI byte-for-byte: OpenAI's auth backend compares the
// redirect_uri against the registered value as a literal string. `localhost`
// and `127.0.0.1` are *not* interchangeable here.
const CODEX_OAUTH_REDIRECT_URI = `http://localhost:${CODEX_OAUTH_REDIRECT_PORT}/auth/callback`;
const CODEX_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_SCOPE = 'openid profile email offline_access';
// `codex_cli_rs` is the only first-party originator OpenAI's auth backend
// accepts for this client ID; substituting another value triggers a generic
// "Authentication error" in the browser.
const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs';
const CODEX_OAUTH_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  email?: string;
  /** Absolute expiry in ms epoch. 0 if unknown. */
  expiresAt: number;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  auth_mode: 'chatgpt';
  tokens: {
    id_token?: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
}

let activeLogin: {
  server: http.Server;
  abort: AbortController;
  resolve: (tokens: CodexOAuthTokens) => void;
  reject: (err: Error) => void;
} | null = null;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  const challenge = base64UrlEncode(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  const state = base64UrlEncode(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: CODEX_OAUTH_ORIGINATOR,
  });
  return `${CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    // base64url → base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The directory we point OpenClaw's CODEX_HOME at. Using a per-app subdirectory
 * (rather than the user's real ~/.codex) avoids overwriting an existing Codex
 * CLI login.
 */
export function getCodexHomeDir(): string {
  return path.join(app.getPath('userData'), 'codex');
}

export function getCodexAuthFilePath(): string {
  return path.join(getCodexHomeDir(), 'auth.json');
}

export function readOpenAICodexAuthFile(): CodexOAuthTokens | null {
  try {
    const raw = fs.readFileSync(getCodexAuthFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as CodexAuthFile;
    if (!parsed || parsed.auth_mode !== 'chatgpt') return null;
    const access = trimNonEmpty(parsed.tokens?.access_token);
    const refresh = trimNonEmpty(parsed.tokens?.refresh_token);
    if (!access || !refresh) return null;
    const idToken = trimNonEmpty(parsed.tokens?.id_token);
    const accessClaims = decodeJwtPayload(access);
    const accessAuthClaim = (accessClaims?.['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    const accountId =
      trimNonEmpty(parsed.tokens?.account_id)
      ?? trimNonEmpty(accessAuthClaim?.chatgpt_account_id)
      ?? trimNonEmpty(accessAuthClaim?.chatgpt_account_user_id);
    const claims = idToken ? decodeJwtPayload(idToken) : null;
    const email = trimNonEmpty(claims?.email);
    const exp = typeof claims?.exp === 'number' ? (claims.exp as number) * 1000 : 0;
    return {
      accessToken: access,
      refreshToken: refresh,
      idToken,
      accountId,
      email,
      expiresAt: exp,
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn('[OpenAICodexAuth] failed to read auth.json:', err);
    }
    return null;
  }
}

function writeAuthFile(tokens: {
  access: string;
  refresh: string;
  idToken?: string;
  accountId?: string;
}): void {
  const dir = getCodexHomeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: CodexAuthFile = {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  const filePath = getCodexAuthFilePath();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms where chmod is a no-op (Windows)
  }
}

function renderCallbackHtml(success: boolean, message: string): string {
  const safeMessage = message.replace(/[<>&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;',
  );
  const color = success ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>LobsterAI · ChatGPT Login</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0d10; color: #e5e7eb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #14171c; padding: 32px 40px; border-radius: 16px; border: 1px solid #262b33; max-width: 420px; }
  h1 { color: ${color}; font-size: 18px; margin: 0 0 8px; }
  p { color: #9ca3af; font-size: 14px; line-height: 1.5; margin: 0; }
</style></head>
<body><div class="card"><h1>${success ? 'Login successful' : 'Login failed'}</h1><p>${safeMessage}</p></div></body></html>`;
}

async function exchangeCodeForTokens(params: {
  code: string;
  verifier: string;
}): Promise<{ accessToken: string; refreshToken: string; idToken?: string; accountId?: string; email?: string; expiresAt: number; }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: params.verifier,
  });

  const resp = await session.defaultSession.fetch(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed: HTTP ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const access = trimNonEmpty(data.access_token);
  const refresh = trimNonEmpty(data.refresh_token);
  if (!access || !refresh) {
    throw new Error('Token exchange returned an incomplete payload');
  }

  const idToken = trimNonEmpty(data.id_token);
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  const email = trimNonEmpty(claims?.email);
  const authClaim = (claims?.['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const accountId =
    trimNonEmpty(authClaim?.chatgpt_account_id) ??
    trimNonEmpty(authClaim?.chatgpt_account_user_id);

  const expiresAt = typeof data.expires_in === 'number' && data.expires_in > 0
    ? Date.now() + data.expires_in * 1000
    : 0;

  return { accessToken: access, refreshToken: refresh, idToken, accountId, email, expiresAt };
}

/**
 * Run the interactive ChatGPT OAuth login. Returns the resulting tokens once
 * the user completes the flow in the browser. Side-effect: writes
 * <CODEX_HOME>/auth.json so the OpenClaw runtime can pick it up.
 */
export function startOpenAICodexLogin(): Promise<CodexOAuthTokens> {
  if (activeLogin) {
    return Promise.reject(new Error('Another ChatGPT login is already in progress'));
  }

  return new Promise<CodexOAuthTokens>((resolve, reject) => {
    const { verifier, challenge, state } = generatePkce();
    const authorizeUrl = buildAuthorizeUrl(challenge, state);
    const abort = new AbortController();
    let timeoutHandle: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (activeLogin) {
        try {
          activeLogin.server.close();
        } catch {
          /* ignore */
        }
      }
      activeLogin = null;
    };

    const finishWithError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const finishWithTokens = (tokens: CodexOAuthTokens) => {
      cleanup();
      resolve(tokens);
    };

    const server = http.createServer((req, res) => {
      const reqUrl = req.url ?? '/';
      // We only handle the registered callback path; everything else gets a 404.
      const parsed = new URL(reqUrl, CODEX_OAUTH_REDIRECT_URI);
      if (parsed.pathname !== '/auth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const errorParam = parsed.searchParams.get('error');
      const errorDescription = parsed.searchParams.get('error_description');
      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');

      if (errorParam) {
        const msg = errorDescription || errorParam;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml(false, msg));
        finishWithError(new Error(`OAuth error: ${msg}`));
        return;
      }
      if (!code || !returnedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml(false, 'Missing code or state in callback'));
        finishWithError(new Error('Missing code or state in callback'));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml(false, 'State mismatch — possible CSRF, login aborted'));
        finishWithError(new Error('OAuth state mismatch'));
        return;
      }

      // Respond first so the user's browser closes cleanly even if the token
      // exchange takes a moment.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderCallbackHtml(
          true,
          'You can now close this tab and return to LobsterAI.',
        ),
      );

      exchangeCodeForTokens({ code, verifier })
        .then((tokens) => {
          writeAuthFile({
            access: tokens.accessToken,
            refresh: tokens.refreshToken,
            idToken: tokens.idToken,
            accountId: tokens.accountId,
          });
          console.log('[OpenAICodexAuth] login successful', tokens.email ? `(${tokens.email})` : '');
          finishWithTokens(tokens);
        })
        .catch((err) => {
          finishWithError(err instanceof Error ? err : new Error(String(err)));
        });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        finishWithError(
          new Error(
            `Port ${CODEX_OAUTH_REDIRECT_PORT} is already in use. ` +
              'If the Codex CLI is running its own login flow, finish or cancel it first.',
          ),
        );
        return;
      }
      finishWithError(err);
    });

    server.listen(CODEX_OAUTH_REDIRECT_PORT, '127.0.0.1', () => {
      activeLogin = { server, abort, resolve: finishWithTokens, reject: finishWithError };

      timeoutHandle = setTimeout(() => {
        finishWithError(new Error('ChatGPT login timed out'));
      }, CODEX_OAUTH_LOGIN_TIMEOUT_MS);

      void shell.openExternal(authorizeUrl).catch((err) => {
        console.warn('[OpenAICodexAuth] failed to open browser:', err);
      });

      console.log('[OpenAICodexAuth] waiting for OAuth callback on', CODEX_OAUTH_REDIRECT_URI);
    });
  });
}

/**
 * Cancel an in-flight login (closes the local callback server). Safe to call
 * when no login is active.
 */
export function cancelOpenAICodexLogin(): void {
  if (!activeLogin) return;
  const { reject } = activeLogin;
  reject(new Error('Login cancelled by user'));
}

/**
 * Remove the persisted ChatGPT credentials. After this OpenClaw will fall back
 * to the user's API key (or no auth at all).
 */
export function logoutOpenAICodex(): void {
  try {
    fs.unlinkSync(getCodexAuthFilePath());
    console.log('[OpenAICodexAuth] auth.json removed');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn('[OpenAICodexAuth] failed to remove auth.json:', err);
    }
  }
}
