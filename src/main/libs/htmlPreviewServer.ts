import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
};

interface PreviewSession {
  rootDir: string;
  realRootDir: string;
  token: string;
  filePath: string;
  kind: 'html' | 'pptx';
  assertAccess?: (filePath: string) => void;
  responses: Set<http.ServerResponse>;
}

let server: http.Server | null = null;
let serverPort: number | null = null;
const sessions = new Map<string, PreviewSession>();

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function getPptxPreviewUmdPath(): string {
  return require.resolve('pptx-preview/dist/pptx-preview.umd.js');
}

function writePreviewHeaders(
  res: http.ServerResponse,
  statusCode: number,
  headers: Record<string, string | number> = {},
  includePreviewCsp = false,
): void {
  const responseHeaders: Record<string, string | number> = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  };

  if (includePreviewCsp) {
    responseHeaders['Content-Security-Policy'] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: http: https:",
      "font-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src 'self' data: blob:",
      "worker-src 'self' blob:",
    ].join('; ');
  }

  res.writeHead(statusCode, {
    ...responseHeaders,
  });
}

function notFound(res: http.ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  writePreviewHeaders(res, 404);
  res.end('Not Found');
}

function assertSessionAccess(sessionId: string, session: PreviewSession, filePath?: string): void {
  try {
    if (sessions.get(sessionId) !== session) throw new Error('Preview session expired');
    session.assertAccess?.(session.filePath);
    if (filePath && filePath !== session.filePath) session.assertAccess?.(filePath);
  } catch (error) {
    destroyPreviewSession(sessionId);
    throw error;
  }
}

function isWithinDirectory(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function streamFile(
  filePath: string,
  res: http.ServerResponse,
  sessionId: string,
  session: PreviewSession,
  trustedAsset = false,
): void {
  const assertAccess = () => {
    assertSessionAccess(sessionId, session, trustedAsset ? undefined : filePath);
    if (!trustedAsset && !isWithinDirectory(session.realRootDir, fs.realpathSync(filePath))) {
      throw new Error('Preview resource is outside the session directory');
    }
  };
  assertAccess();
  fs.stat(filePath, (err, stat) => {
    if (res.destroyed || res.writableEnded) return;
    if (err || !stat.isFile()) {
      notFound(res);
      return;
    }
    try {
      assertAccess();
      const stream = fs.createReadStream(filePath);
      res.once('close', () => stream.destroy());
      stream.once('open', () => {
        try {
          assertAccess();
          if (res.destroyed || res.writableEnded) {
            stream.destroy();
            return;
          }
          writePreviewHeaders(res, 200, {
            'Content-Type': getMimeType(filePath),
            'Content-Length': stat.size,
          });
          stream.pipe(res);
        } catch {
          stream.destroy();
          notFound(res);
        }
      });
      stream.on('error', () => notFound(res));
    } catch {
      notFound(res);
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPptxPreviewPage(sessionId: string, token: string, fileName: string): string {
  const sourceUrl = `/${sessionId}/__office_preview__/source.pptx?token=${encodeURIComponent(token)}`;
  const vendorUrl = `/${sessionId}/__office_preview__/pptx-preview.umd.js?token=${encodeURIComponent(token)}`;
  const title = escapeHtml(fileName);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #f3f4f6; color: #111827; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { padding: 16px; overflow-y: auto; }
    #status { min-height: 40px; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 13px; }
    #pptx-wrapper { width: 100%; min-height: 100px; }
    .pptx-preview-wrapper { background: transparent !important; width: 100% !important; max-width: 100% !important; margin: 0 auto !important; overflow: visible !important; }
    .pptx-preview-slide-wrapper { max-width: 100% !important; margin: 0 auto 16px !important; box-shadow: 0 2px 8px rgba(0,0,0,0.12); border-radius: 4px; overflow: hidden; background: #fff; }
    .pptx-preview-slide-wrapper img { max-width: none; }
    .error { color: #dc2626; white-space: pre-wrap; padding: 16px; }
  </style>
</head>
<body>
  <div id="status">Loading...</div>
  <div id="pptx-wrapper"></div>
  <script src="${vendorUrl}"></script>
  <script>
    (function () {
      var status = document.getElementById('status');
      var wrapper = document.getElementById('pptx-wrapper');
      var sourceUrl = ${JSON.stringify(sourceUrl)};
      var previewer = null;

      function setStatus(message, isError) {
        status.textContent = message;
        status.className = isError ? 'error' : '';
      }

      function getRenderWidth() {
        return Math.max(320, Math.min(1200, document.documentElement.clientWidth - 32));
      }

      async function render() {
        try {
          var api = window.pptxPreview;
          if (!api || typeof api.init !== 'function') {
            throw new Error('pptx-preview runtime failed to load');
          }
          var response = await fetch(sourceUrl, { cache: 'no-store' });
          if (!response.ok) {
            throw new Error('failed to load PPTX: ' + response.status + ' ' + response.statusText);
          }
          var data = await response.arrayBuffer();
          wrapper.innerHTML = '';
          previewer = api.init(wrapper, { width: getRenderWidth(), mode: 'list' });
          await previewer.preview(data);
          status.remove();
        } catch (error) {
          setStatus(error && error.message ? error.message : String(error), true);
        }
      }

      window.addEventListener('beforeunload', function () {
        if (previewer && typeof previewer.destroy === 'function') previewer.destroy();
      });
      render();
    })();
  </script>
</body>
</html>`;
}

function handlePptxPreviewRequest(
  relativePath: string,
  sessionId: string,
  session: PreviewSession,
  res: http.ServerResponse,
): void {
  if (relativePath === '__office_preview__/index.html') {
    const html = buildPptxPreviewPage(sessionId, session.token, path.basename(session.filePath));
    writePreviewHeaders(res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    }, true);
    res.end(html);
    return;
  }

  if (relativePath === '__office_preview__/source.pptx') {
    streamFile(session.filePath, res, sessionId, session);
    return;
  }

  if (relativePath === '__office_preview__/pptx-preview.umd.js') {
    streamFile(getPptxPreviewUmdPath(), res, sessionId, session, true);
    return;
  }

  notFound(res);
}

function extractTokenFromReferer(req: http.IncomingMessage): string | null {
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    const refererUrl = new URL(referer);
    return refererUrl.searchParams.get('token');
  } catch {
    return null;
  }
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!req.url) {
    notFound(res);
    return;
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${serverPort}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  const token = parsedUrl.searchParams.get('token') || extractTokenFromReferer(req);

  // URL format: /{sessionId}/relative/path/to/file
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 1) {
    notFound(res);
    return;
  }

  const sessionId = parts[0];
  const session = sessions.get(sessionId);
  if (!session) {
    notFound(res);
    return;
  }

  if (token !== session.token) {
    notFound(res);
    return;
  }

  assertSessionAccess(sessionId, session);
  session.responses.add(res);
  res.once('close', () => session.responses.delete(res));

  const relativePath = parts.slice(1).join('/') || path.basename(session.filePath);

  if (session.kind === 'pptx' && relativePath.startsWith('__office_preview__/')) {
    handlePptxPreviewRequest(relativePath, sessionId, session, res);
    return;
  }

  const resolvedPath = path.resolve(session.rootDir, relativePath);

  // Path traversal protection
  if (!isWithinDirectory(session.rootDir, resolvedPath)) {
    notFound(res);
    return;
  }

  streamFile(resolvedPath, res, sessionId, session);
}

export async function startHtmlPreviewServer(): Promise<number> {
  if (server && serverPort) {
    return serverPort;
  }

  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      try {
        handleRequest(req, res);
      } catch {
        notFound(res);
      }
    });

    s.on('error', (err) => {
      console.error('[HtmlPreviewServer] Server error:', err);
      reject(err);
    });

    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
        server = s;
        console.log(`[HtmlPreviewServer] Started on port ${serverPort}`);
        resolve(serverPort);
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

export async function stopHtmlPreviewServer(): Promise<void> {
  if (!server) return;

  const activeServer = server;
  server = null;
  serverPort = null;
  for (const sessionId of sessions.keys()) destroyPreviewSession(sessionId);

  // Bounded shutdown: server.close() waits for open preview connections
  // (e.g. a renderer webview keeping keep-alive sockets), so force-close
  // stragglers after a short drain window and cap the total wait.
  return new Promise((resolve) => {
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      console.log('[HtmlPreviewServer] Stopped');
      resolve();
    };
    drainTimer = setTimeout(() => activeServer.closeAllConnections(), 1_000);
    deadlineTimer = setTimeout(settle, 3_000);
    activeServer.close(() => settle());
  });
}

export async function createPreviewSession(
  filePath: string,
  assertAccess?: (filePath: string) => void,
): Promise<{ sessionId: string; url: string }> {
  const requestedFilePath = path.resolve(filePath);
  assertAccess?.(requestedFilePath);
  const resolvedFilePath = fs.realpathSync(requestedFilePath);
  assertAccess?.(resolvedFilePath);
  const stat = await fs.promises.stat(resolvedFilePath);
  assertAccess?.(resolvedFilePath);
  if (!stat.isFile()) {
    throw new Error('Preview target is not a file');
  }

  const port = await startHtmlPreviewServer();
  assertAccess?.(resolvedFilePath);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const rootDir = path.dirname(resolvedFilePath) + path.sep;
  const fileName = path.basename(resolvedFilePath);

  sessions.set(sessionId, {
    rootDir, realRootDir: fs.realpathSync(rootDir), token, filePath: resolvedFilePath,
    kind: 'html', assertAccess, responses: new Set(),
  });

  const url = `http://127.0.0.1:${port}/${sessionId}/${encodeURIComponent(fileName)}?token=${token}`;
  return { sessionId, url };
}

export async function createOfficePreviewSession(
  filePath: string,
  assertAccess?: (filePath: string) => void,
): Promise<{ sessionId: string; url: string }> {
  const requestedFilePath = path.resolve(filePath);
  assertAccess?.(requestedFilePath);
  const resolvedFilePath = fs.realpathSync(requestedFilePath);
  assertAccess?.(resolvedFilePath);
  const stat = await fs.promises.stat(resolvedFilePath);
  assertAccess?.(resolvedFilePath);
  if (!stat.isFile()) throw new Error('Preview target is not a file');
  const port = await startHtmlPreviewServer();
  assertAccess?.(resolvedFilePath);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const rootDir = path.dirname(resolvedFilePath) + path.sep;

  sessions.set(sessionId, {
    rootDir, realRootDir: fs.realpathSync(rootDir), token, filePath: resolvedFilePath,
    kind: 'pptx', assertAccess, responses: new Set(),
  });

  const url = `http://127.0.0.1:${port}/${sessionId}/__office_preview__/index.html?token=${token}`;
  return { sessionId, url };
}

export function destroyPreviewSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  session?.responses.forEach(notFound);
}

export function revalidatePreviewSessions(): void {
  for (const [sessionId, session] of sessions) {
    try {
      assertSessionAccess(sessionId, session);
    } catch {
      // The assertion destroys the session and all its active responses.
    }
  }
}

export function isPreviewServerUrl(url: string): boolean {
  if (!serverPort) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' && parsed.port === String(serverPort);
  } catch {
    return false;
  }
}
