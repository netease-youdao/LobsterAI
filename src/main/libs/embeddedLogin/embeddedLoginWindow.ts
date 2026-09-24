import crypto from 'crypto';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';

import { AuthLoginFailureReason } from '../../../shared/auth/constants';
import {
  decideNavigation,
  isExternalLinkAllowed,
  matchCompletion,
  type NavigationPolicy,
} from './loginUrlPolicy';

export const EMBEDDED_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** Chromium's net::ERR_ABORTED, reported when a navigation is cancelled or superseded. */
const ERR_ABORTED = -3;

export class EmbeddedLoginError extends Error {
  constructor(readonly reason: AuthLoginFailureReason) {
    super(`Embedded login ended: ${reason}`);
    this.name = 'EmbeddedLoginError';
  }
}

export interface EmbeddedLoginCompletion {
  code: string | null;
  state: string | null;
}

export interface EmbeddedLoginWindowHandle {
  result: Promise<EmbeddedLoginCompletion>;
  focus(): void;
}

export interface EmbeddedLoginWindowOptions {
  loginUrl: string;
  policy: NavigationPolicy;
  timeoutMs: number;
  title: string;
  isDev: boolean;
  parent: BrowserWindow | null;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  sessionFromPartition: (partition: string) => Session;
  openExternal: (url: string) => void;
}

interface NavigationEvent {
  url: string;
  isMainFrame: boolean;
  preventDefault(): void;
}

const originForLog = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
};

/**
 * Hosts the official Portal login page in a throwaway session. The page gets no preload, no Node
 * access and no permissions; the only way it can hand back a result is by navigating to the
 * completion URL, which is intercepted here and never reaches the network.
 */
export function openEmbeddedLoginWindow(options: EmbeddedLoginWindowOptions): EmbeddedLoginWindowHandle {
  const partition = `lobsterai-login-${crypto.randomUUID()}`;
  const loginSession = options.sessionFromPartition(partition);
  const { origin, completionPath } = options.policy.target;
  loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  loginSession.setPermissionCheckHandler(() => false);
  loginSession.on('will-download', event => event.preventDefault());
  loginSession.webRequest.onBeforeRequest(
    { urls: [`${origin}${completionPath}*`] },
    (_details, callback) => callback({ cancel: true }),
  );

  // Not modal: a macOS sheet has no close button, and the Portal page has no cancel control.
  const window = options.createWindow({
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 560,
    parent: options.parent ?? undefined,
    title: options.title,
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: options.isDev,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  window.setMenu(null);

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (completion: EmbeddedLoginCompletion) => void;
  let rejectResult!: (error: EmbeddedLoginError) => void;
  const result = new Promise<EmbeddedLoginCompletion>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const settle = (outcome: EmbeddedLoginCompletion | EmbeddedLoginError): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (outcome instanceof EmbeddedLoginError) rejectResult(outcome);
    else resolveResult(outcome);
    if (!window.isDestroyed()) window.close();
  };

  const handleNavigation = (event: NavigationEvent): void => {
    const decision = decideNavigation(event.url, event.isMainFrame, options.policy);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'complete') {
      const match = matchCompletion(event.url, options.policy.target);
      if (match.kind === 'completion') settle({ code: match.code, state: match.state });
      return;
    }
    console.warn(
      `[EmbeddedLogin] blocked a ${event.isMainFrame ? 'top-level' : 'frame'} navigation to ${originForLog(event.url)}`,
    );
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLinkAllowed(url)) options.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', details => handleNavigation(details));
  window.webContents.on('will-redirect', details => handleNavigation(details));
  window.webContents.on('will-frame-navigate', details => {
    // will-navigate already covers the main frame.
    if (!details.isMainFrame) handleNavigation(details);
  });
  window.webContents.on('did-fail-load', (_event, errorCode, _description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED || settled) return;
    if (matchCompletion(validatedURL, options.policy.target).kind === 'completion') return;
    console.warn(`[EmbeddedLogin] login page failed to load (code=${errorCode})`);
    settle(new EmbeddedLoginError(AuthLoginFailureReason.LoadFailed));
  });
  window.on('closed', () => {
    void loginSession.clearStorageData().catch(() => undefined);
    void loginSession.clearCache().catch(() => undefined);
    settle(new EmbeddedLoginError(AuthLoginFailureReason.Cancelled));
  });

  timer = setTimeout(
    () => settle(new EmbeddedLoginError(AuthLoginFailureReason.Timeout)),
    options.timeoutMs,
  );
  window.loadURL(options.loginUrl).catch(error => {
    // did-fail-load reports real failures; a superseded initial navigation also rejects here.
    console.debug('[EmbeddedLogin] initial navigation did not finish:', error instanceof Error ? error.message : error);
  });

  return {
    result,
    focus: () => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.focus();
    },
  };
}
