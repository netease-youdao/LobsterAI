import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

const AUTH_CALLBACK_PATH = '/auth/callback';
const AUTH_LOCAL_CALLBACK_HOST = '127.0.0.1';
const AUTH_LOCAL_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface AuthLocalCallbackOptions {
  onCode: (code: string) => void;
  timeoutMs?: number;
}

export interface AuthLocalCallback {
  redirectUri: string;
  state: string;
  close: () => Promise<void>;
}

interface ActiveAuthLocalCallback extends AuthLocalCallback {
  refreshTimeout: (timeoutMs: number) => void;
}

let activeCallback: ActiveAuthLocalCallback | null = null;
let startingCallback: Promise<ActiveAuthLocalCallback> | null = null;

const escapeHtml = (value: string): string =>
  value.replace(/[<>&"]/g, (char) => {
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '&') return '&amp;';
    return '&quot;';
  });

const renderCallbackHtml = (success: boolean, message: string): string => {
  return renderCallbackHtmlWithRedirect(success, message, null);
};

const renderCallbackHtmlWithRedirect = (
  success: boolean,
  message: string,
  redirectUrl: string | null,
): string => {
  const color = success ? '#16a34a' : '#dc2626';
  const safeRedirectScript = redirectUrl
    ? `<script>setTimeout(function(){ window.location.replace(${JSON.stringify(redirectUrl)}); }, 900);</script>`
    : '';
  const redirectHint = redirectUrl
    ? '<p class="hint">页面将自动返回 LobsterAI 登录页。</p>'
    : '';
  const redirectAction = redirectUrl
    ? `<a class="action" href="${escapeHtml(redirectUrl)}">立即返回</a>`
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>LobsterAI 登录</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f4; color: #14120b; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid rgba(20,18,11,.08); border-radius: 10px; padding: 30px 34px; max-width: 420px; box-shadow: 0 18px 50px rgba(20,18,11,.08); }
  h1 { color: ${color}; font-size: 20px; line-height: 1.3; margin: 0 0 10px; font-weight: 600; }
  p { color: #666; font-size: 14px; line-height: 1.6; margin: 0; }
  .hint { margin-top: 8px; color: #999; }
  .action { display: inline-flex; margin-top: 18px; color: #f26522; font-size: 14px; text-decoration: none; }
</style></head>
<body><div class="card"><h1>${success ? '登录成功' : '登录失败'}</h1><p>${escapeHtml(message)}</p>${redirectHint}${redirectAction}</div>${safeRedirectScript}</body></html>`;
};

const sendHtml = (
  res: http.ServerResponse,
  statusCode: number,
  success: boolean,
  message: string,
): void => {
  const html = renderCallbackHtml(success, message);
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
};

const sendHtmlWithRedirect = (
  res: http.ServerResponse,
  statusCode: number,
  success: boolean,
  message: string,
  redirectUrl: string | null,
): void => {
  const html = renderCallbackHtmlWithRedirect(success, message, redirectUrl);
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
};

const closeServer = (server: http.Server): Promise<void> =>
  new Promise(resolve => {
    server.close(() => resolve());
  });

export function appendLoginParams(baseUrl: string, params: Record<string, string>): string {
  const parsed = new URL(baseUrl);

  if (parsed.hash) {
    const hash = parsed.hash.slice(1);
    const queryStart = hash.indexOf('?');
    const hashPath = queryStart >= 0 ? hash.slice(0, queryStart) : hash;
    const hashQuery = queryStart >= 0 ? hash.slice(queryStart + 1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    Object.entries(params).forEach(([key, value]) => {
      hashParams.set(key, value);
    });
    const nextQuery = hashParams.toString();
    parsed.hash = nextQuery ? `${hashPath}?${nextQuery}` : hashPath;
    return parsed.toString();
  }

  Object.entries(params).forEach(([key, value]) => {
    parsed.searchParams.set(key, value);
  });
  return parsed.toString();
}

export function appendCallbackReturnTo(redirectUri: string, returnTo: string): string {
  const parsed = new URL(redirectUri);
  parsed.searchParams.set('return_to', returnTo);
  return parsed.toString();
}

function resolveSafeReturnTo(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const isYoudaoHost = url.hostname.endsWith('.youdao.com') || url.hostname === 'youdao.com';
    const isLoopbackHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!isYoudaoHost && !isLoopbackHost) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function createAuthLocalCallback(
  options: AuthLocalCallbackOptions,
): Promise<ActiveAuthLocalCallback> {
  const state = crypto.randomBytes(24).toString('base64url');
  const server = http.createServer();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const callback: ActiveAuthLocalCallback = {
    redirectUri: '',
    state,
    refreshTimeout: (timeoutMs: number) => {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        console.warn(`[AuthLocalCallback] login callback timed out at ${callback.redirectUri}`);
        void callback.close();
      }, timeoutMs);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (activeCallback === callback) {
        activeCallback = null;
      }
      await closeServer(server);
      console.debug(`[AuthLocalCallback] closed local callback server at ${callback.redirectUri}`);
    },
  };

  server.on('request', (req, res) => {
    if (req.method !== 'GET') {
      sendHtml(res, 405, false, '登录回调请求方法不支持，请返回 LobsterAI 后重试。');
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${AUTH_LOCAL_CALLBACK_HOST}`);
    if (reqUrl.pathname !== AUTH_CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const code = reqUrl.searchParams.get('code')?.trim();
    const returnedState = reqUrl.searchParams.get('state')?.trim();
    const returnTo = resolveSafeReturnTo(reqUrl.searchParams.get('return_to'));

    if (!code) {
      console.warn('[AuthLocalCallback] callback was rejected because the auth code was missing');
      sendHtml(res, 400, false, '登录回调缺少授权码，请返回 LobsterAI 后重试。');
      void callback.close();
      return;
    }

    if (returnedState !== state) {
      console.warn('[AuthLocalCallback] callback was rejected because the state did not match');
      sendHtml(res, 400, false, '登录状态校验失败，请返回 LobsterAI 后重试。');
      void callback.close();
      return;
    }

    try {
      console.log('[AuthLocalCallback] received login callback, delivering auth code');
      options.onCode(code);
      sendHtmlWithRedirect(
        res,
        200,
        true,
        '登录已完成，正在返回 LobsterAI 登录页。',
        returnTo,
      );
    } catch (error) {
      console.error('[AuthLocalCallback] failed to deliver auth code:', error);
      sendHtml(res, 500, false, '登录回调处理失败，请返回 LobsterAI 后重试。');
    } finally {
      void callback.close();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, AUTH_LOCAL_CALLBACK_HOST);
  });

  const address = server.address() as AddressInfo | null;
  if (!address?.port) {
    await callback.close();
    throw new Error('Local auth callback server did not expose a port');
  }

  callback.redirectUri = `http://${AUTH_LOCAL_CALLBACK_HOST}:${address.port}${AUTH_CALLBACK_PATH}`;
  activeCallback = callback;
  server.on('error', error => {
    console.error(`[AuthLocalCallback] local callback server failed at ${callback.redirectUri}:`, error);
    void callback.close();
  });
  console.log(`[AuthLocalCallback] started local callback server on ${AUTH_LOCAL_CALLBACK_HOST}:${address.port}`);

  callback.refreshTimeout(options.timeoutMs ?? AUTH_LOCAL_CALLBACK_TIMEOUT_MS);

  return callback;
}

export async function startAuthLocalCallback(
  options: AuthLocalCallbackOptions,
): Promise<AuthLocalCallback> {
  const timeoutMs = options.timeoutMs ?? AUTH_LOCAL_CALLBACK_TIMEOUT_MS;

  if (activeCallback) {
    // Existing browser tabs still target this URL, so keep it valid across repeated login clicks.
    activeCallback.refreshTimeout(timeoutMs);
    console.log(`[AuthLocalCallback] reusing active local callback server at ${activeCallback.redirectUri}`);
    return activeCallback;
  }

  if (startingCallback) {
    // Coalesce clicks that arrive before the first server has finished binding its port.
    const callback = await startingCallback;
    callback.refreshTimeout(timeoutMs);
    console.log(`[AuthLocalCallback] reusing starting local callback server at ${callback.redirectUri}`);
    return callback;
  }

  const callbackPromise = createAuthLocalCallback(options);
  startingCallback = callbackPromise;

  try {
    return await callbackPromise;
  } finally {
    if (startingCallback === callbackPromise) {
      startingCallback = null;
    }
  }
}
