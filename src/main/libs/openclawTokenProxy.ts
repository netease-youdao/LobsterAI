import http from 'http';
import { net } from 'electron';

const PROXY_BIND_HOST = '127.0.0.1';
const COWORK_SESSION_ID_MARKER_PATTERN = /<!--\s*lobsterai:cowork-session-id:([0-9a-fA-F-]{36})\s*-->\s*/g;

let proxyServer: http.Server | null = null;
let proxyPort: number | null = null;

// Injected dependencies
let tokenGetter: (() => { accessToken: string; refreshToken: string } | null) | null = null;
let tokenRefresher: ((reason: string) => Promise<string | null>) | null = null;
let serverBaseUrlGetter: (() => string) | null = null;

export type OpenClawTokenProxyConfig = {
  getAuthTokens: () => { accessToken: string; refreshToken: string } | null;
  refreshToken: (reason: string) => Promise<string | null>;
  getServerBaseUrl: () => string;
};

export function startOpenClawTokenProxy(config: OpenClawTokenProxyConfig): Promise<{ port: number }> {
  tokenGetter = config.getAuthTokens;
  tokenRefresher = config.refreshToken;
  serverBaseUrlGetter = config.getServerBaseUrl;

  return new Promise((resolve, reject) => {
    if (proxyServer) {
      if (proxyPort) {
        resolve({ port: proxyPort });
        return;
      }
      reject(new Error('Token proxy is starting'));
      return;
    }

    const server = http.createServer(handleRequest);

    server.listen(0, PROXY_BIND_HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        proxyPort = addr.port;
        proxyServer = server;
        console.log(`[OpenClawTokenProxy] started on ${PROXY_BIND_HOST}:${proxyPort}`);
        resolve({ port: proxyPort });
      } else {
        server.close();
        reject(new Error('Failed to bind token proxy'));
      }
    });

    server.on('error', (err) => {
      console.error('[OpenClawTokenProxy] server error:', err);
      reject(err);
    });
  });
}

export function stopOpenClawTokenProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    proxyPort = null;
    console.log('[OpenClawTokenProxy] stopped');
  }
}

export function getOpenClawTokenProxyPort(): number | null {
  return proxyPort;
}

export function buildCoworkSessionIdMarker(sessionId: string): string {
  return `<!-- lobsterai:cowork-session-id:${sessionId} -->`;
}

function collectRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const tokens = tokenGetter?.();
    const serverBaseUrl = serverBaseUrlGetter?.();

    if (!tokens?.accessToken || !serverBaseUrl) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No auth tokens available' }));
      return;
    }

    const body = await collectRequestBody(req);
    const upstreamBody = rewriteCoworkSessionBody(body);

    // Build upstream URL: serverBaseUrl + request path
    // OpenClaw sends to /v1/chat/completions, upstream is /api/proxy/v1/chat/completions
    const upstreamPath = `/api/proxy${req.url || '/'}`;
    const upstreamUrl = `${serverBaseUrl}${upstreamPath}`;

    const result = await forwardRequest(upstreamUrl, req.method || 'POST', tokens.accessToken, upstreamBody, req.headers);

    if ((result.status === 401 || result.status === 403) && tokenRefresher) {
      console.log(`[OpenClawTokenProxy] received ${result.status}, attempting token refresh`);
      const newToken = await tokenRefresher('openclaw-proxy');
      if (newToken) {
        const retryResult = await forwardRequest(upstreamUrl, req.method || 'POST', newToken, upstreamBody, req.headers);
        pipeResponse(retryResult, res);
        return;
      }
    }

    pipeResponse(result, res);
  } catch (err) {
    console.error('[OpenClawTokenProxy] request handling error:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token proxy upstream error' }));
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

function stripCoworkSessionMarker(text: string): { text: string; sessionId: string | null; changed: boolean } {
  let sessionId: string | null = null;
  COWORK_SESSION_ID_MARKER_PATTERN.lastIndex = 0;
  const nextText = text.replace(COWORK_SESSION_ID_MARKER_PATTERN, (_match, matchedSessionId: string) => {
    if (!sessionId) {
      sessionId = matchedSessionId;
    }
    return '';
  });

  return {
    text: nextText,
    sessionId,
    changed: nextText !== text,
  };
}

function rewriteMessagesForCoworkSession(messages: unknown[]): { sessionId: string | null; changed: boolean } {
  let sessionId: string | null = null;
  let changed = false;

  for (const message of messages) {
    if (!isRecord(message)) continue;

    if (typeof message.content === 'string') {
      const stripped = stripCoworkSessionMarker(message.content);
      if (stripped.changed) {
        message.content = stripped.text;
        changed = true;
      }
      if (!sessionId && stripped.sessionId) {
        sessionId = stripped.sessionId;
      }
      continue;
    }

    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || typeof part.text !== 'string') continue;
      const stripped = stripCoworkSessionMarker(part.text);
      if (stripped.changed) {
        part.text = stripped.text;
        changed = true;
      }
      if (!sessionId && stripped.sessionId) {
        sessionId = stripped.sessionId;
      }
    }
  }

  return { sessionId, changed };
}

function rewriteCoworkSessionBody(body: Buffer): Buffer {
  if (body.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    return body;
  }

  const rewritten = rewriteMessagesForCoworkSession(parsed.messages);
  if (!rewritten.changed) {
    return body;
  }

  if (rewritten.sessionId && typeof parsed.session_id !== 'string') {
    parsed.session_id = rewritten.sessionId;
  }

  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

export const __openClawTokenProxyTestUtils = {
  rewriteCoworkSessionBody,
};

type UpstreamResult = {
  status: number;
  headers: Record<string, string>;
  body: NodeJS.ReadableStream | Buffer;
  isStream: boolean;
};

async function forwardRequest(
  url: string,
  method: string,
  accessToken: string,
  body: Buffer,
  incomingHeaders: http.IncomingHttpHeaders,
): Promise<UpstreamResult> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': incomingHeaders['content-type'] || 'application/json',
  };

  // Forward accept header for SSE streaming
  if (incomingHeaders.accept) {
    headers['Accept'] = incomingHeaders.accept;
  }

  const resp = await net.fetch(url, {
    method,
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });

  const contentType = resp.headers.get('content-type') || '';
  const isStream = contentType.includes('text/event-stream');

  const responseHeaders: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  if (isStream && resp.body) {
    return {
      status: resp.status,
      headers: responseHeaders,
      body: resp.body as unknown as NodeJS.ReadableStream,
      isStream: true,
    };
  }

  const respBuffer = Buffer.from(await resp.arrayBuffer());
  return {
    status: resp.status,
    headers: responseHeaders,
    body: respBuffer,
    isStream: false,
  };
}

function pipeResponse(result: UpstreamResult, res: http.ServerResponse): void {
  res.writeHead(result.status, result.headers);

  if (result.isStream && 'pipe' in result.body && typeof (result.body as NodeJS.ReadableStream).pipe === 'function') {
    (result.body as NodeJS.ReadableStream).pipe(res);
  } else if (Buffer.isBuffer(result.body)) {
    res.end(result.body);
  } else {
    // Web ReadableStream from net.fetch — need to consume manually
    const webStream = result.body as unknown as ReadableStream<Uint8Array>;
    const reader = webStream.getReader();
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) {
          res.end();
          return;
        }
        res.write(value);
        pump();
      }).catch((err) => {
        console.error('[OpenClawTokenProxy] stream read error:', err);
        res.end();
      });
    };
    pump();
  }
}
