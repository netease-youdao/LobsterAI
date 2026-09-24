import { EventEmitter } from 'node:events';

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AuthLoginFailureReason } from '../../../shared/auth/constants';
import { EmbeddedLoginError, openEmbeddedLoginWindow } from './embeddedLoginWindow';
import type { NavigationPolicy } from './loginUrlPolicy';

class FakeWebContents extends EventEmitter {
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.windowOpenHandler = handler;
  }
}

class FakeWindow extends EventEmitter {
  webContents = new FakeWebContents();
  destroyed = false;
  loadedUrl: string | null = null;
  focused = false;
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
  }
  isDestroyed() { return this.destroyed; }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  loadURL(url: string) {
    this.loadedUrl = url;
    return Promise.resolve();
  }
  setMenu() {}
  isMinimized() { return false; }
  restore() {}
  focus() { this.focused = true; }
}

type PermissionRequestHandler = (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void;
type BeforeRequestListener = (details: unknown, callback: (response: { cancel: boolean }) => void) => void;

class FakeSession extends EventEmitter {
  permissionRequestHandler: PermissionRequestHandler | null = null;
  permissionCheckHandler: (() => boolean) | null = null;
  beforeRequestFilter: { urls: string[] } | null = null;
  beforeRequest: BeforeRequestListener | null = null;
  cleared = false;
  webRequest = {
    onBeforeRequest: (filter: { urls: string[] }, listener: BeforeRequestListener) => {
      this.beforeRequestFilter = filter;
      this.beforeRequest = listener;
    },
  };
  setPermissionRequestHandler(handler: PermissionRequestHandler) { this.permissionRequestHandler = handler; }
  setPermissionCheckHandler(handler: () => boolean) { this.permissionCheckHandler = handler; }
  clearStorageData() {
    this.cleared = true;
    return Promise.resolve();
  }
  clearCache() { return Promise.resolve(); }
}

const policy: NavigationPolicy = {
  target: { origin: 'https://lobsterai.youdao.com', completionPath: '/portal/desktop-login/complete' },
  allowedTopLevelOrigins: new Set(['https://lobsterai.youdao.com', 'https://login.netease.com']),
};
const COMPLETION = 'https://lobsterai.youdao.com/portal/desktop-login/complete#code=abc&state=xyz';

function navigation(url: string, isMainFrame = true) {
  return {
    url,
    isMainFrame,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function open(overrides: { timeoutMs?: number; isDev?: boolean } = {}) {
  let window!: FakeWindow;
  let partition = '';
  const loginSession = new FakeSession();
  const openExternal = vi.fn();
  const handle = openEmbeddedLoginWindow({
    loginUrl: 'https://lobsterai.youdao.com/portal#/login?transport=embedded',
    policy,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    title: 'Sign in',
    isDev: overrides.isDev ?? false,
    parent: null,
    createWindow: options => {
      window = new FakeWindow(options);
      return window as unknown as BrowserWindow;
    },
    sessionFromPartition: name => {
      partition = name;
      return loginSession as unknown as Session;
    },
    openExternal,
  });
  return { handle, window, loginSession, openExternal, partition };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('openEmbeddedLoginWindow', () => {
  test('uses an isolated in-memory session with hardened preferences', () => {
    const { handle, window, partition } = open();
    handle.result.catch(() => undefined);

    expect(partition).toMatch(/^lobsterai-login-[0-9a-f-]{36}$/);
    expect(window.options.webPreferences).toMatchObject({
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    });
    expect(window.options.webPreferences?.preload).toBeUndefined();
    expect(window.loadedUrl).toBe('https://lobsterai.youdao.com/portal#/login?transport=embedded');
    window.close();
  });

  test('resolves the completion, cancels the navigation and clears the session', async () => {
    const { handle, window, loginSession } = open();
    const event = navigation(COMPLETION);

    window.webContents.emit('will-navigate', event);

    await expect(handle.result).resolves.toEqual({ code: 'abc', state: 'xyz' });
    expect(event.defaultPrevented).toBe(true);
    expect(window.destroyed).toBe(true);
    expect(loginSession.cleared).toBe(true);
  });

  test('blocks top-level navigation outside the sign-in origins and keeps waiting', () => {
    const { handle, window } = open();
    handle.result.catch(() => undefined);
    const blocked = navigation('https://evil.example/');
    const allowed = navigation('https://login.netease.com/connect/authorize');
    const frameScript = navigation('javascript:alert(1)', false);
    const frameWeb = navigation('https://dl.reg.163.com/index.html', false);

    window.webContents.emit('will-navigate', blocked);
    window.webContents.emit('will-navigate', allowed);
    window.webContents.emit('will-frame-navigate', frameScript);
    window.webContents.emit('will-frame-navigate', frameWeb);

    expect(blocked.defaultPrevented).toBe(true);
    expect(allowed.defaultPrevented).toBe(false);
    expect(frameScript.defaultPrevented).toBe(true);
    expect(frameWeb.defaultPrevented).toBe(false);
    expect(window.destroyed).toBe(false);
    window.close();
  });

  test('also completes on a server redirect to the completion URL', async () => {
    const { handle, window } = open();

    window.webContents.emit('will-redirect', navigation(COMPLETION));

    await expect(handle.result).resolves.toEqual({ code: 'abc', state: 'xyz' });
  });

  test('treats closing the window as a cancellation', async () => {
    const { handle, window } = open();

    window.close();

    await expect(handle.result).rejects.toEqual(new EmbeddedLoginError(AuthLoginFailureReason.Cancelled));
  });

  test('times out and closes the window', async () => {
    vi.useFakeTimers();
    const { handle, window } = open({ timeoutMs: 1_000 });
    const outcome = handle.result.catch(error => error);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toEqual(new EmbeddedLoginError(AuthLoginFailureReason.Timeout));
    expect(window.destroyed).toBe(true);
  });

  test('fails when the login page cannot load, ignoring aborted navigations', async () => {
    const { handle, window } = open();

    window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://lobsterai.youdao.com/portal', true);
    expect(window.destroyed).toBe(false);
    window.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://lobsterai.youdao.com/portal', true);

    await expect(handle.result).rejects.toEqual(new EmbeddedLoginError(AuthLoginFailureReason.LoadFailed));
  });

  test('denies permissions, downloads and any request to the completion URL', () => {
    const { handle, window, loginSession } = open();
    handle.result.catch(() => undefined);
    const granted = vi.fn();
    const download = { preventDefault: vi.fn() };
    const cancel = vi.fn();

    loginSession.permissionRequestHandler?.({}, 'media', granted);
    loginSession.emit('will-download', download);
    loginSession.beforeRequest?.({}, cancel);

    expect(granted).toHaveBeenCalledWith(false);
    expect(loginSession.permissionCheckHandler?.()).toBe(false);
    expect(download.preventDefault).toHaveBeenCalled();
    expect(loginSession.beforeRequestFilter).toEqual({
      urls: ['https://lobsterai.youdao.com/portal/desktop-login/complete*'],
    });
    expect(cancel).toHaveBeenCalledWith({ cancel: true });
    window.close();
  });

  test('never opens new windows and sends only official links to the system browser', () => {
    const { handle, window, openExternal } = open();
    handle.result.catch(() => undefined);
    const handler = window.webContents.windowOpenHandler!;

    expect(handler({ url: 'https://c.youdao.com/terms.html' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://c.youdao.com/terms.html');
    window.close();
  });

  test('focuses the open window on a repeated request', () => {
    const { handle, window } = open();
    handle.result.catch(() => undefined);

    handle.focus();

    expect(window.focused).toBe(true);
    window.close();
  });
});
