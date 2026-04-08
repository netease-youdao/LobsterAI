/**
 * Google OAuth2 authorization-code + PKCE flow for Gmail API.
 *
 * Follows the same pattern as qwenOAuth.ts and githubCopilotAuth.ts:
 * open system browser → user consents → redirect to loopback with auth code
 * → exchange code for tokens.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { shell } from 'electron';
import crypto from 'crypto';
import { GoogleOAuthEndpoint, GMAIL_SCOPES, type GmailOAuthTokens } from './constants';

const REDIRECT_PORT = 19876;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Start the Google OAuth2 authorization-code + PKCE flow.
 * Opens the system browser for user consent and waits for the callback.
 */
export async function startGmailOAuth(
  clientId: string,
  clientSecret: string,
): Promise<GmailOAuthTokens> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise<GmailOAuthTokens>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error('Gmail OAuth timed out after 5 minutes'));
      }
    }, 5 * 60_000);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body><h2>Authorization denied</h2><p>You can close this window.</p></body></html>',
        );
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(new Error(`Google OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Invalid callback</h2></body></html>');
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(clientId, clientSecret, code, codeVerifier);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body><h2>Gmail connected successfully!</h2><p>You can close this window and return to LobsterAI.</p></body></html>',
        );
        settled = true;
        clearTimeout(timeout);
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<html><body><h2>Token exchange failed</h2><p>${err instanceof Error ? err.message : 'Unknown error'}</p></body></html>`,
        );
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      });
      const authUrl = `${GoogleOAuthEndpoint.AuthUrl}?${params.toString()}`;
      console.log('[GmailOAuth] opening browser for authorization');
      shell.openExternal(authUrl);
    });

    server.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      }
    });
  });
}

async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
): Promise<GmailOAuthTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });

  const response = await fetch(GoogleOAuthEndpoint.TokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Refresh the access token using the refresh token.
 */
export async function refreshGmailAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(GoogleOAuthEndpoint.TokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
