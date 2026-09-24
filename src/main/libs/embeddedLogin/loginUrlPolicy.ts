import type { LoginTransaction } from './loginTransaction';

export const EMBEDDED_LOGIN_COMPLETION_PATH = 'desktop-login/complete';

export const PortalLoginOrigin = {
  Production: 'https://lobsterai.youdao.com',
  Test: 'https://lobsterai.inner.youdao.com',
} as const;

/** NetEase employee sign-in pages the login window may show at the top level. */
export const NETEASE_LOGIN_ORIGINS: readonly string[] = ['https://login.netease.com'];

const DEFAULT_PORTAL_LOGIN_PATH = '/portal#/login';
const EXTERNAL_LINK_DOMAINS = ['youdao.com', '163.com', 'netease.com'];
const AUTH_CODE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LoginUrlOptions {
  testMode: boolean;
  /** Honored only by unpackaged development builds. */
  developmentLoginUrl?: string | null;
}

export interface EmbeddedLoginTarget {
  loginUrl: string;
  origin: string;
  completionPath: string;
}

export interface NavigationPolicy {
  target: Pick<EmbeddedLoginTarget, 'origin' | 'completionPath'>;
  allowedTopLevelOrigins: ReadonlySet<string>;
}

export type NavigationDecision = 'complete' | 'allow' | 'block';

export type CompletionMatch =
  | { kind: 'other' }
  | { kind: 'completion'; code: string | null; state: string | null };

const parseWebUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
};

/** The login page is remotely configurable, but only on the official Portal origin. */
export function resolvePortalLoginUrl(candidate: string | null | undefined, options: LoginUrlOptions): string {
  if (options.developmentLoginUrl) {
    const development = parseWebUrl(options.developmentLoginUrl);
    if (development) return development.toString();
  }
  const allowedOrigin = options.testMode ? PortalLoginOrigin.Test : PortalLoginOrigin.Production;
  const configured = candidate ? parseWebUrl(candidate) : null;
  if (configured && configured.protocol === 'https:' && configured.origin === allowedOrigin) {
    return configured.toString();
  }
  return `${allowedOrigin}${DEFAULT_PORTAL_LOGIN_PATH}`;
}

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

/** Hash-routed Portal builds live below the login pathname; history-routed dev builds live at "/". */
export function resolveCompletionPath(loginUrl: URL): string {
  if (!loginUrl.hash.startsWith('#/')) return `/${EMBEDDED_LOGIN_COMPLETION_PATH}`;
  const base = loginUrl.pathname.endsWith('/') ? loginUrl.pathname : `${loginUrl.pathname}/`;
  return `${base}${EMBEDDED_LOGIN_COMPLETION_PATH}`;
}

export function buildEmbeddedLoginTarget(
  loginUrl: string,
  transaction: Pick<LoginTransaction, 'state' | 'codeChallenge'>,
): EmbeddedLoginTarget {
  const url = new URL(loginUrl);
  return {
    loginUrl: appendLoginParams(loginUrl, {
      source: 'electron',
      transport: 'embedded',
      state: transaction.state,
      code_challenge: transaction.codeChallenge,
      code_challenge_method: 'S256',
    }),
    origin: url.origin,
    completionPath: resolveCompletionPath(url),
  };
}

export function matchCompletion(rawUrl: string, target: NavigationPolicy['target']): CompletionMatch {
  const url = parseWebUrl(rawUrl);
  if (!url || url.origin !== target.origin || url.pathname !== target.completionPath) return { kind: 'other' };
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  return { kind: 'completion', code: fragment.get('code'), state: fragment.get('state') };
}

/** Top-level pages are limited to sign-in origins; frames may load any web page the login form embeds. */
export function decideNavigation(rawUrl: string, isMainFrame: boolean, policy: NavigationPolicy): NavigationDecision {
  if (matchCompletion(rawUrl, policy.target).kind === 'completion') return 'complete';
  if (!isMainFrame && (rawUrl === 'about:blank' || rawUrl === 'about:srcdoc')) return 'allow';
  const url = parseWebUrl(rawUrl);
  if (!url) return 'block';
  if (!isMainFrame) return 'allow';
  return url.protocol === 'https:' && policy.allowedTopLevelOrigins.has(url.origin) ? 'allow' : 'block';
}

export function isExternalLinkAllowed(rawUrl: string): boolean {
  const url = parseWebUrl(rawUrl);
  if (!url || url.protocol !== 'https:') return false;
  return EXTERNAL_LINK_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

export function isAuthCodeFormat(value: string | null | undefined): value is string {
  return typeof value === 'string' && AUTH_CODE_PATTERN.test(value);
}
