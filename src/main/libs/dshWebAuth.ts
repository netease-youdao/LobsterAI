// dsh 0.1.5 serves its web UI only to browsers holding a session cookie. Once
// its plugin tree settles, `dsh web` prints
//
//   dsh web: http://127.0.0.1:<port>/?token=<launch token>
//
// and opening that URL trades the per-process token for an HttpOnly cookie
// (303 back to `/`). Every other request — the index and `/api/*` alike —
// answers 401 without the cookie. The token exists only in that stdout line, so
// the engine reads it there, proves the exchange before calling the runtime
// ready, and hands the URL to the workbench window, which repeats the exchange
// as any browser would. No Electron imports: the e2e gate drives these same
// helpers from dist-electron.

import * as http from 'http';

const DSH_WEB_HOST = '127.0.0.1';
const DSH_WEB_URL_LINE_PREFIX = 'dsh web: ';
const DSH_WEB_TOKEN_PARAM = 'token';
const DSH_WEB_TOKEN_IN_TEXT_PATTERN = new RegExp(`([?&]${DSH_WEB_TOKEN_PARAM}=)[^&#\\s()<>"']+`, 'g');
const DSH_WEB_REQUEST_TIMEOUT_MS = 2_000;

/**
 * Extract the authenticated URL from one line of dsh output. Only a loopback
 * URL on the port we assigned counts, so no other line can point the workbench
 * somewhere else.
 */
export function parseDshWebLaunchUrl(line: string, port: number): string | null {
  const start = line.indexOf(DSH_WEB_URL_LINE_PREFIX);
  if (start === -1) return null;
  const candidate = line.slice(start + DSH_WEB_URL_LINE_PREFIX.length).split(/\s/, 1)[0];
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.hostname !== DSH_WEB_HOST || url.port !== String(port)) return null;
  if (!url.searchParams.get(DSH_WEB_TOKEN_PARAM)) return null;
  return url.href;
}

/** Mask launch tokens: they are live credentials for the running runtime. */
export function redactDshWebToken(text: string): string {
  return text.replace(DSH_WEB_TOKEN_IN_TEXT_PATTERN, '$1<redacted>');
}

/**
 * Trade the launch token for the session cookie the way a browser would.
 * Resolves the Cookie header value, or null while the runtime does not answer
 * the exchange with 303 and Set-Cookie.
 */
export function exchangeDshLaunchToken(launchUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = http.get(launchUrl, { timeout: DSH_WEB_REQUEST_TIMEOUT_MS }, (response) => {
      response.resume();
      const cookie = (response.headers['set-cookie'] ?? [])
        .map((entry) => entry.split(';', 1)[0].trim())
        .filter((entry) => entry.length > 0)
        .join('; ');
      resolve(response.statusCode === 303 && cookie ? cookie : null);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(null));
  });
}

/** Status of the workbench index for a cookie holder; 0 when nothing answers. */
export function probeDshWebIndex(port: number, cookie: string): Promise<number> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: DSH_WEB_HOST, port, path: '/', timeout: DSH_WEB_REQUEST_TIMEOUT_MS, headers: { Cookie: cookie } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(0));
  });
}
