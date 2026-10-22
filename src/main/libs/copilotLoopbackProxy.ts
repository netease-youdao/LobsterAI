import crypto from 'crypto';
import http from 'http';

import { listenOnLoopback } from './loopbackListen';

/**
 * Loopback passthrough for GitHub Copilot.
 *
 * OpenClaw's lobsterai-copilot provider points at
 * http://127.0.0.1:<port>/v1/copilot with the stable ${LOBSTER_PROXY_TOKEN}.
 * The short-lived Copilot API token (refreshed every ~30 minutes) is injected
 * here per request, so token refreshes never change openclaw.json and never
 * restart the gateway.
 */

const BIND_HOST = '127.0.0.1';
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const COPILOT_ROUTE_PATHS = new Set(['/v1/copilot/chat/completions', '/copilot/chat/completions']);

const COPILOT_IDE_HEADERS: Record<string, string> = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'Openai-Intent': 'conversation-panel',
};

// ── DNS rebinding protection: only loopback Host headers are accepted ──

const ALLOWED_PROXY_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Validate that the request Host header refers to a loopback address.
 * Requests without a Host header are allowed because browsers always send one.
 */
export function isAllowedProxyHost(req: http.IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (!hostHeader) {
    return true;
  }
  let hostName: string;
  if (hostHeader.startsWith('[')) {
    const bracketEnd = hostHeader.indexOf(']');
    hostName = bracketEnd >= 0 ? hostHeader.slice(0, bracketEnd + 1) : hostHeader;
  } else {
    const colonIndex = hostHeader.lastIndexOf(':');
    hostName = colonIndex >= 0 ? hostHeader.slice(0, colonIndex) : hostHeader;
  }
  return ALLOWED_PROXY_HOSTS.has(hostName);
}

type CopilotTokenState = { copilotToken: string; baseUrl: string };

type CopilotProxyDeps = {
  getAuthToken: () => string | null;
  getCurrentToken: () => Promise<CopilotTokenState | null>;
  refreshToken: () => Promise<CopilotTokenState>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};

const writeJsonError = (res: http.ServerResponse, statusCode: number, type: string, message: string): void => {
  const payload = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readRequestBody = (req: http.IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let settled = false;
  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      settled = true;
      reject(new Error('Request body too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    resolve(Buffer.concat(chunks));
  });
  req.on('error', (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  });
});

const buildCopilotChatCompletionsUrl = (baseUrl: string): string => {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
};

const pipeResponse = async (upstream: Response, res: http.ServerResponse): Promise<void> => {
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
};

const createRequestHandler = (deps: CopilotProxyDeps) => async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  if (!isAllowedProxyHost(req)) {
    console.warn(`[CopilotProxy] Rejected request with disallowed Host header: ${req.headers.host}`);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const method = (req.method || 'GET').toUpperCase();
  const pathname = new URL(req.url || '/', `http://${BIND_HOST}`).pathname;

  if (method === 'GET' && pathname === '/healthz') {
    const payload = JSON.stringify({ ok: true, status: 'live' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
    return;
  }

  const authToken = deps.getAuthToken();
  if (authToken) {
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (bearerToken !== authToken) {
      writeJsonError(res, 401, 'authentication_error', 'Unauthorized: invalid or missing proxy token');
      return;
    }
  }

  if (method !== 'POST' || !COPILOT_ROUTE_PATHS.has(pathname)) {
    writeJsonError(res, 404, 'not_found_error', 'Not found');
    return;
  }

  let body: Buffer;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    writeJsonError(res, 400, 'invalid_request_error', error instanceof Error ? error.message : 'Invalid request body');
    return;
  }

  let tokenState = await deps.getCurrentToken();
  if (!tokenState) {
    try {
      tokenState = await deps.refreshToken();
    } catch (error) {
      console.warn('[CopilotProxy] No Copilot token available and refresh failed:', error);
      writeJsonError(res, 503, 'service_unavailable', 'Copilot token unavailable');
      return;
    }
  }

  const send = (state: CopilotTokenState) => deps.fetch(buildCopilotChatCompletionsUrl(state.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.copilotToken}`,
      ...COPILOT_IDE_HEADERS,
    },
    body: new Uint8Array(body),
  });

  let upstream = await send(tokenState);
  // The short-lived token can expire between refreshes: refresh once and retry.
  if (upstream.status === 401 || upstream.status === 403) {
    console.log('[CopilotProxy] Auth error from Copilot, refreshing token and retrying');
    try {
      upstream = await send(await deps.refreshToken());
    } catch (error) {
      console.warn('[CopilotProxy] Copilot token refresh failed:', error);
    }
  }

  await pipeResponse(upstream, res);
};

let server: http.Server | null = null;
let port: number | null = null;
let authToken: string | null = null;

const defaultDeps = (): CopilotProxyDeps => ({
  getAuthToken: () => authToken,
  // The token manager is loaded lazily: it pulls in Electron-only modules.
  getCurrentToken: async () => {
    const { getCurrentCopilotToken } = await import('./copilotTokenManager');
    return getCurrentCopilotToken();
  },
  refreshToken: async () => {
    const { refreshCopilotTokenNow } = await import('./copilotTokenManager');
    return refreshCopilotTokenNow();
  },
  fetch: async (url, init) => {
    // Electron's session fetch follows the user's system proxy settings.
    const { session } = await import('electron');
    return session.defaultSession.fetch(url, init);
  },
});

export async function startCopilotLoopbackProxy(options: {
  /** Persisted secret; OpenClaw config references it as ${LOBSTER_PROXY_TOKEN}. */
  authToken?: string;
  /** Port from the previous launch; keeps the Copilot baseUrl in openclaw.json stable. */
  preferredPort?: number | null;
} = {}): Promise<void> {
  if (server) {
    return;
  }
  authToken = options.authToken || crypto.randomBytes(24).toString('hex');
  const handle = createRequestHandler(defaultDeps());
  const nextServer = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      console.error('[CopilotProxy] Request failed:', error);
      if (!res.headersSent) {
        writeJsonError(res, 500, 'api_error', error instanceof Error ? error.message : 'Internal proxy error');
      } else {
        res.end();
      }
    });
  });
  const { port: boundPort, reused } = await listenOnLoopback(nextServer, BIND_HOST, options.preferredPort);
  nextServer.on('error', (error) => {
    console.error('[CopilotProxy] Server error:', error);
  });
  console.log(`[CopilotProxy] Started on port ${boundPort}${reused ? ' (reused port)' : ''}`);
  server = nextServer;
  port = boundPort;
}

export async function stopCopilotLoopbackProxy(): Promise<void> {
  if (!server) {
    return;
  }
  const closing = server;
  server = null;
  port = null;
  authToken = null;
  // The gateway keeps keep-alive sockets open: drain briefly, then force-close,
  // with a hard deadline so shutdown never hangs.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve();
    };
    const drainTimer = setTimeout(() => closing.closeAllConnections(), 1_000);
    const deadlineTimer = setTimeout(() => settle(), 3_000);
    closing.close((error) => settle(error ?? undefined));
  });
}

export function getCopilotLoopbackPort(): number | null {
  return port;
}

/** Base URL OpenClaw's Copilot provider uses, e.g. http://127.0.0.1:<port>/v1/copilot. */
export function getCopilotLoopbackBaseUrl(): string | null {
  return port ? `http://${BIND_HOST}:${port}/v1/copilot` : null;
}

export function getCopilotLoopbackAuthToken(): string | null {
  return authToken;
}

export const __copilotLoopbackProxyTestUtils = {
  createRequestHandler,
};
