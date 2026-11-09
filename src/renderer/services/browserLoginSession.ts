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
  /** The OS refused or stalled the browser launch. */
  OpenFailed: 'open_failed',
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
    setState(null);
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

  /** A login attempt started. A retry keeps the previous URL on screen. */
  start(): void {
    clearExpiry();
    setState({ status: BrowserLoginStatus.Opening, url: currentState?.url ?? null });
  },

  /** The browser accepted the login page. */
  handOff(url: string | null): void {
    settle(BrowserLoginStatus.Waiting, url);
  },

  /** The browser could not be opened. Without a URL there is nothing to offer. */
  fail(url: string | null): void {
    if (!url) {
      browserLoginSession.clear();
      return;
    }
    settle(BrowserLoginStatus.OpenFailed, url);
  },

  /** The login completed, was cancelled, or can no longer complete. */
  clear(): void {
    clearExpiry();
    if (currentState) setState(null);
  },
};
