import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { NeteaseMailAuth, NeteaseMailError, NeteaseMailFailure } from '../../shared/neteaseMail/constants';
import type { NeteaseMailOAuthConfig } from './neteaseMailConfig';

export interface NeteaseMailCredential {
  type: typeof NeteaseMailAuth.CredentialType;
  provider: typeof NeteaseMailAuth.Provider;
  access: string;
  refresh: string;
  expires: number;
  clientId: string;
}

export class NeteaseMailOAuthError extends Error {
  constructor(readonly code: NeteaseMailFailure | NeteaseMailError) { super(String(code)); }
}

/** Tokens are main-process only. Never persist a response or include it in errors. */
export function parseNeteaseMailToken(value: unknown, clientId: string, now = Date.now()): NeteaseMailCredential {
  const token = value as Record<string, unknown> | null;
  if (!token || typeof token.access_token !== 'string' || !token.access_token
    || typeof token.refresh_token !== 'string' || !token.refresh_token
    || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
    || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new NeteaseMailOAuthError(NeteaseMailFailure.Failed);
  }
  // An omitted scope means the requested scope per OAuth. Never silently accept a broader grant.
  if (token.scope !== undefined && (typeof token.scope !== 'string'
    || token.scope.trim().split(/\s+/).length !== 1 || token.scope.trim() !== NeteaseMailAuth.Scope)) {
    throw new NeteaseMailOAuthError(NeteaseMailError.InsufficientScope);
  }
  return {
    type: NeteaseMailAuth.CredentialType, provider: NeteaseMailAuth.Provider, clientId,
    access: token.access_token, refresh: token.refresh_token, expires: now + token.expires_in * 1000,
  };
}

export async function authorizeNeteaseMail(options: {
  config: NeteaseMailOAuthConfig;
  fetch: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  signal: AbortSignal;
  callbackText: string;
  timeoutMs?: number;
}): Promise<NeteaseMailCredential> {
  const { config, signal } = options;
  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== 'http:' || redirect.hostname !== 'localhost' || redirect.pathname !== '/oauth/callback') {
    throw new NeteaseMailOAuthError(NeteaseMailFailure.InvalidRequest);
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new NeteaseMailOAuthError(NeteaseMailFailure.TimedOut)), options.timeoutMs ?? NeteaseMailAuth.TimeoutMs);
  const callback = new URL(config.authorizeUrl);
  callback.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
    scope: NeteaseMailAuth.Scope, state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  const servers: http.Server[] = [];
  try {
    const code = await new Promise<string>((resolve, reject) => {
      let consumed = false;
      const onAbort = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) { onAbort(); return; }
      const listener: http.RequestListener = (req, res) => {
        let url: URL;
        try { url = new URL(req.url ?? '/', config.redirectUri); }
        catch { res.writeHead(400).end(); return; }
        const candidate = Buffer.from(url.searchParams.get('state') ?? '');
        const expected = Buffer.from(state);
        if (req.method !== 'GET' || url.origin !== redirect.origin || url.pathname !== redirect.pathname || req.headers.host !== redirect.host
          || url.searchParams.getAll('state').length !== 1
          || candidate.length !== expected.length || !timingSafeEqual(candidate, expected) || consumed) {
          res.writeHead(400, { 'Cache-Control': 'no-store' }).end();
          return;
        }
        consumed = true;
        // Plain text avoids reflecting any authorization parameters or running scripts.
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(options.callbackText);
        if (url.searchParams.has('error')) { reject(new NeteaseMailOAuthError(NeteaseMailFailure.Denied)); return; }
        const value = url.searchParams.get('code');
        if (!value || url.searchParams.getAll('code').length !== 1) reject(new NeteaseMailOAuthError(NeteaseMailFailure.InvalidRequest));
        else resolve(value);
      };
      // The registered redirect uses localhost; listen on both loopback families only.
      const bind = (host: string) => new Promise<void>((ready, failed) => {
        const server = http.createServer(listener);
        servers.push(server);
        server.on('error', (error: NodeJS.ErrnoException) => {
          if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code ?? '')) { ready(); return; }
          failed(new NeteaseMailOAuthError(error.code === 'EADDRINUSE' ? NeteaseMailFailure.PortBusy : NeteaseMailFailure.Unavailable));
        });
        server.listen({ host, port: Number(redirect.port), ipv6Only: true }, ready);
      });
      void bind('127.0.0.1').then(() => bind('::1')).then(async () => {
        controller.signal.throwIfAborted();
        await options.openExternal(callback.href);
      }).catch(reject);
    });
    controller.signal.throwIfAborted();
    const response = await options.fetch(config.tokenUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        client_id: config.clientId, redirect_uri: config.redirectUri,
      }),
    });
    if (!response.ok) throw new NeteaseMailOAuthError(response.status === 429 ? NeteaseMailError.RateLimited : NeteaseMailFailure.Failed);
    return parseNeteaseMailToken(await response.json(), config.clientId);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    for (const server of servers) { server.close(); server.closeAllConnections(); }
  }
}
