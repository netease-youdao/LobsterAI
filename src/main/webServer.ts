import http from 'http';
import fs from 'fs';
import path from 'path';

type InvokeHandler = (event: { sender: { send: (channel: string, ...args: unknown[]) => void } }, ...args: unknown[]) => unknown;
type OnHandler = (event: Record<string, never>, ...args: unknown[]) => void;

export type RpcRegistry = {
  invokeHandlers: Map<string, InvokeHandler>;
  onHandlers: Map<string, OnHandler[]>;
};

export type WebServerOptions = {
  port: number;
  platform: string;
  allowedOrigin: string;
  rpcRegistry: RpcRegistry;
  staticDir?: string | null;
};

type SseClient = {
  id: string;
  response: http.ServerResponse;
};

const JSON_MAX_BYTES = 2 * 1024 * 1024;

const randomId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const parseRequestBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > JSON_MAX_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });

  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
};

const writeJson = (res: http.ServerResponse, statusCode: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const writeCorsHeaders = (res: http.ServerResponse, allowedOrigin: string): void => {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

const contentTypeFromExt = (ext: string): string => {
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
};

const resolveStaticPath = (staticDir: string, pathname: string): string | null => {
  const decoded = decodeURIComponent(pathname);
  const normalizedPath = decoded === '/' ? '/index.html' : decoded;
  const unsafe = path.normalize(normalizedPath).replace(/^([.][.][/\\])+/, '');
  const resolved = path.resolve(staticDir, `.${unsafe}`);
  const resolvedRoot = path.resolve(staticDir);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
};

export const startWebServer = (options: WebServerOptions): {
  stop: () => Promise<void>;
  broadcastEvent: (channel: string, ...args: unknown[]) => void;
} => {
  const clients = new Map<string, SseClient>();
  const { invokeHandlers, onHandlers } = options.rpcRegistry;

  const broadcastEvent = (channel: string, ...args: unknown[]): void => {
    if (clients.size === 0) return;
    const payload = `event: ipc\ndata: ${JSON.stringify({ channel, args })}\n\n`;
    for (const [, client] of clients) {
      client.response.write(payload);
    }
  };

  const server = http.createServer(async (req, res) => {
    writeCorsHeaders(res, options.allowedOrigin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = req.url || '/';
    const url = new URL(reqUrl, `http://127.0.0.1:${options.port}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      writeJson(res, 200, { ok: true, mode: 'web', platform: options.platform });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meta') {
      writeJson(res, 200, { ok: true, platform: options.platform });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const id = randomId();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      clients.set(id, { id, response: res });

      req.on('close', () => {
        clients.delete(id);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc/invoke') {
      try {
        const body = await parseRequestBody(req) as { channel?: string; args?: unknown[] } | null;
        const channel = typeof body?.channel === 'string' ? body.channel : '';
        const args = Array.isArray(body?.args) ? body.args : [];
        const handler = invokeHandlers.get(channel);
        if (!handler) {
          writeJson(res, 404, { ok: false, error: `Unknown RPC channel: ${channel}` });
          return;
        }

        const event = {
          sender: {
            send: (eventChannel: string, ...eventArgs: unknown[]) => {
              broadcastEvent(eventChannel, ...eventArgs);
            },
          },
        };

        const result = await handler(event, ...args);
        writeJson(res, 200, { ok: true, result });
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'RPC invoke failed',
        });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc/send') {
      try {
        const body = await parseRequestBody(req) as { channel?: string; args?: unknown[] } | null;
        const channel = typeof body?.channel === 'string' ? body.channel : '';
        const args = Array.isArray(body?.args) ? body.args : [];
        const listeners = onHandlers.get(channel) ?? [];
        listeners.forEach((listener) => {
          listener({}, ...args);
        });
        writeJson(res, 200, { ok: true });
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'RPC send failed',
        });
      }
      return;
    }

    if (req.method === 'GET' && options.staticDir) {
      const candidatePath = resolveStaticPath(options.staticDir, url.pathname);
      if (candidatePath && fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        const ext = path.extname(candidatePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': contentTypeFromExt(ext) });
        fs.createReadStream(candidatePath).pipe(res);
        return;
      }

      const indexPath = path.join(options.staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }
    }

    writeJson(res, 404, {
      ok: false,
      error: 'Not found',
    });
  });

  server.listen(options.port, '127.0.0.1', () => {
    console.log(`[Web] RPC server listening on http://127.0.0.1:${options.port}`);
  });

  return {
    stop: async () => {
      for (const [, client] of clients) {
        client.response.end();
      }
      clients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    broadcastEvent,
  };
};
