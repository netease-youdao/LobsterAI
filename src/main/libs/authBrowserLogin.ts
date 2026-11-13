import {
  AuthLoginFailureReason,
  type AuthLoginResult,
} from '../../shared/auth/constants';
import {
  appendCallbackReturnTo,
  appendLoginParams,
  type AuthLocalCallback,
} from './authLocalCallbackServer';

/**
 * How long the OS gets to accept the request to open the browser. On Windows
 * shell.openExternal is a ShellExecute call that normally returns in well
 * under a second; it can block much longer when security software holds the
 * launch behind its own prompt, and the login button would look dead.
 */
export const AUTH_BROWSER_OPEN_TIMEOUT_MS = 10_000;

const OpenAttemptStatus = {
  Opened: 'opened',
  Failed: 'failed',
  TimedOut: 'timed_out',
} as const;

type OpenAttemptResult =
  | { status: typeof OpenAttemptStatus.Opened }
  | { status: typeof OpenAttemptStatus.Failed; error: unknown }
  | { status: typeof OpenAttemptStatus.TimedOut };

interface OpenBrowserLoginOptions {
  baseUrl: string;
  openExternal: (url: string) => Promise<void>;
  startLocalCallback: () => Promise<AuthLocalCallback>;
  openTimeoutMs?: number;
}

const describeError = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const openWithTimeout = (
  openExternal: (url: string) => Promise<void>,
  url: string,
  timeoutMs: number,
): Promise<OpenAttemptResult> => new Promise(resolve => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve({ status: OpenAttemptStatus.TimedOut });
  }, timeoutMs);

  let pending: Promise<void>;
  try {
    pending = openExternal(url);
  } catch (error) {
    pending = Promise.reject(error);
  }

  pending.then(
    () => {
      if (settled) {
        console.log('[Auth] browser open request returned after the timeout');
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: OpenAttemptStatus.Opened });
    },
    (error: unknown) => {
      if (settled) {
        console.warn(`[Auth] browser open request failed after the timeout: ${describeError(error)}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: OpenAttemptStatus.Failed, error });
    },
  );
});

/**
 * Open the portal login page in the system browser.
 *
 * The preferred URL redirects back to a loopback callback server; when that
 * server cannot start, or the browser refuses the URL, the deep-link login URL
 * is tried instead. A failed result still carries the best login URL so the
 * renderer can let the user open it by hand.
 */
export async function openBrowserLogin(options: OpenBrowserLoginOptions): Promise<AuthLoginResult> {
  const { baseUrl, openExternal, startLocalCallback } = options;
  const openTimeoutMs = options.openTimeoutMs ?? AUTH_BROWSER_OPEN_TIMEOUT_MS;
  const deepLinkUrl = appendLoginParams(baseUrl, { source: 'electron' });
  let callbackUrl: string | null = null;

  try {
    console.log('[Auth] starting browser login with local callback server');
    const localCallback = await startLocalCallback();
    const returnTo = appendLoginParams(baseUrl, {
      source: 'electron',
      electronLogin: 'success',
    });
    callbackUrl = appendLoginParams(baseUrl, {
      source: 'electron',
      redirect_uri: appendCallbackReturnTo(localCallback.redirectUri, returnTo),
      state: localCallback.state,
    });
  } catch (error) {
    console.warn('[Auth] local callback server failed to start, falling back to deep link login:', error);
  }

  // The manual link prefers the loopback callback: it completes the login
  // even when the app's protocol handler is not registered.
  const manualUrl = callbackUrl ?? deepLinkUrl;
  const candidates = callbackUrl ? [callbackUrl, deepLinkUrl] : [deepLinkUrl];
  let lastError: unknown = null;

  for (const url of candidates) {
    console.log(url === callbackUrl
      ? '[Auth] opening portal login with local callback redirect'
      : '[Auth] opening portal login with deep link redirect');
    const attempt = await openWithTimeout(openExternal, url, openTimeoutMs);
    if (attempt.status === OpenAttemptStatus.Opened) {
      return { success: true, redirectUrl: url };
    }
    if (attempt.status === OpenAttemptStatus.TimedOut) {
      // A second request would queue behind the stuck one, so stop here and
      // hand the link to the user instead.
      console.warn(`[Auth] browser open request did not return within ${openTimeoutMs}ms`);
      return {
        success: false,
        reason: AuthLoginFailureReason.OpenTimedOut,
        error: `Opening the browser did not finish within ${openTimeoutMs}ms`,
        redirectUrl: manualUrl,
      };
    }
    lastError = attempt.error;
    console.warn('[Auth] browser open request failed:', attempt.error);
  }

  console.error('[Auth] login failed: could not open the system browser:', lastError);
  return {
    success: false,
    reason: AuthLoginFailureReason.OpenFailed,
    error: lastError ? describeError(lastError) : 'Failed to open login',
    redirectUrl: manualUrl,
  };
}
