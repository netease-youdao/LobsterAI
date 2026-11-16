/**
 * The browser login currently in flight, shared by every login entry point.
 *
 * Login leaves the app: the page opens in the system browser and the result
 * comes back through a callback minutes later. This session keeps that wait
 * visible (the account button and its status card read it) instead of the
 * app looking idle after the click, and it carries the login URL so the user
 * can open it by hand when the browser never shows up.
 */

export const BrowserLoginStatus = {
  /** Resolving the login URL and asking the OS to open the browser. */
  Opening: 'opening',
  /** The browser has the login page; waiting for the login callback. */
  Waiting: 'waiting',
  /** A callback arrived; the client is exchanging it for an account session. */
  Verifying: 'verifying',
  /** The OS refused or stalled the browser launch. */
  OpenFailed: 'open_failed',
  Failed: 'failed',
  Expired: 'expired',
} as const;

export type BrowserLoginStatus = typeof BrowserLoginStatus[keyof typeof BrowserLoginStatus];

export interface BrowserLoginSessionState {
  status: BrowserLoginStatus;
  /** Login page URL for manual use; null until the main process returns one. */
  url: string | null;
}

/**
 * The main process closes its loopback callback server five minutes after
 * the last login click, after which the URL can no longer complete a login.
 */
export const BROWSER_LOGIN_SESSION_TTL_MS = 4.5 * 60 * 1000;

type Listener = () => void;

let currentState: BrowserLoginSessionState | null = null;
let cancelled = false;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

const clearExpiry = (): void => {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
};

const setState = (next: BrowserLoginSessionState | null): void => {
  currentState = next;
  listeners.forEach(listener => listener());
};

const settle = (status: BrowserLoginStatus, url: string | null): void => {
  clearExpiry();
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    setState({ status: BrowserLoginStatus.Expired, url: null });
  }, BROWSER_LOGIN_SESSION_TTL_MS);
  setState({ status, url });
};

export const browserLoginSession = {
  getSnapshot(): BrowserLoginSessionState | null {
    return currentState;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** A retry invalidates the previous link immediately. */
  start(): void {
    cancelled = false;
    clearExpiry();
    setState({ status: BrowserLoginStatus.Opening, url: null });
  },

  /** The browser accepted the login page. */
  handOff(url: string | null): void {
    settle(BrowserLoginStatus.Waiting, url);
  },

  /** Keep the failure actionable even if no manual URL was available. */
  fail(url: string | null): void {
    settle(BrowserLoginStatus.OpenFailed, url);
  },

  verify(): void {
    clearExpiry();
    setState({ status: BrowserLoginStatus.Verifying, url: null });
  },

  verificationFailed(): void {
    clearExpiry();
    setState({ status: BrowserLoginStatus.Failed, url: null });
  },

  isCancelled(): boolean {
    return cancelled || currentState?.status === BrowserLoginStatus.Expired;
  },

  cancel(): void {
    cancelled = true;
    clearExpiry();
    if (currentState) setState(null);
  },

  /** Login completed, or the session was reset. Cancellation is explicit. */
  clear(): void {
    cancelled = false;
    clearExpiry();
    if (currentState) setState(null);
  },
};
