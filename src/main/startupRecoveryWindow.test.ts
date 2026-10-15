import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as any[], errors: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
  BrowserWindow: class extends EventEmitter {
    options: unknown;
    destroyed = false;
    url = '';
    show = vi.fn(); focus = vi.fn(); restore = vi.fn();
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => this.url, setWindowOpenHandler: vi.fn(),
    });
    constructor(options: unknown) { super(); this.options = options; state.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    loadURL(url: string) { this.url = url; return Promise.resolve(); }
    close() { this.destroyed = true; this.emit('closed'); }
  },
  dialog: { showErrorBox: state.errors },
  };
});

import { setLanguage } from './i18n';
import { showStartupRecoveryWindow, StartupRecoveryAction } from './startupRecoveryWindow';

afterEach(() => { for (const window of state.windows.splice(0)) if (!window.destroyed) window.close(); vi.clearAllMocks(); });
describe('startup recovery window', () => {
  it.each(['zh', 'en'] as const)('uses a sandboxed store-independent document in %s', async language => {
    setLanguage(language);
    const actions = { restart: vi.fn(), quit: vi.fn(), showLogs: vi.fn() };
    showStartupRecoveryWindow(actions); await Promise.resolve();
    const window = state.windows[0];
    expect(window.options.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false });
    expect(window.options.webPreferences).not.toHaveProperty('preload');
    const html = decodeURIComponent(window.url.slice(window.url.indexOf(',') + 1));
    expect(html).toContain("default-src 'none'"); expect(html).not.toContain('<script');
    expect(window.show).toHaveBeenCalledOnce();
    const blocked = { preventDefault: vi.fn() };
    window.webContents.emit('will-navigate', blocked, 'https://attacker.invalid/');
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(actions.restart).not.toHaveBeenCalled(); expect(actions.showLogs).not.toHaveBeenCalled();
    window.webContents.emit('will-navigate', blocked, StartupRecoveryAction.Logs);
    expect(actions.showLogs).toHaveBeenCalledOnce();
    window.webContents.emit('will-navigate', blocked, StartupRecoveryAction.Restart);
    window.webContents.emit('will-navigate', blocked, StartupRecoveryAction.Restart);
    expect(actions.restart).toHaveBeenCalledOnce();
    window.close(); expect(actions.quit).not.toHaveBeenCalled();
  });
  it('reuses its window and quits safely when the recovery window is closed', () => {
    const actions = { restart: vi.fn(), quit: vi.fn(), showLogs: vi.fn() };
    showStartupRecoveryWindow(actions); showStartupRecoveryWindow(actions);
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].focus).toHaveBeenCalledOnce();
    state.windows[0].close(); expect(actions.quit).toHaveBeenCalledOnce();
  });
});
