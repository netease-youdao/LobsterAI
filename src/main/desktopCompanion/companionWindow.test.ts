import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DesktopCompanionSurface } from '../../shared/desktopCompanion/constants';
import { createCompanionWindow, dismissCompanionPanelOnBlur } from './companionWindow';

const { windowOptions } = vi.hoisted(() => ({ windowOptions: [] as BrowserWindowConstructorOptions[] }));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
    setMenu = vi.fn();
    setBounds = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn(() => Promise.resolve());
    constructor(options: BrowserWindowConstructorOptions) { windowOptions.push(options); }
  },
}));

class ComposerWindow extends EventEmitter {
  visible = false;
  focused = false;
  focusable = true;
  enabled = true;
  destroyed = false;
  /** AppKit declined to make the window key. */
  refusesFocus = false;
  children: ComposerWindow[] = [];
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  isFocused = () => this.focused;
  isEnabled = () => this.enabled;
  isModal = () => true;
  getChildWindows = () => this.children;
  show() { this.visible = true; this.focused = true; this.emit('show'); }
  showInactive() { this.visible = true; this.focused = false; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  focus() {
    if (this.refusesFocus || !this.visible) return;
    this.focused = true;
    this.emit('focus');
  }
}

let win: ComposerWindow;
let dismiss: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  win = new ComposerWindow();
  dismiss = vi.fn(() => win.hide());
  dismissCompanionPanelOnBlur(win as unknown as BrowserWindow, dismiss, () => win.focusable);
});

afterEach(() => {
  win.emit('closed');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('composer outside dismissal', () => {
  test('an automatic task notification stays visible without taking focus', () => {
    win.focusable = false;
    win.showInactive();
    vi.advanceTimersByTime(5_000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(win.visible).toBe(true);
    expect(win.focused).toBe(false);

    // A stale blur must not dismiss a window switched back to notification mode.
    win.emit('blur');
    vi.advanceTimersByTime(300);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('opening a follow-up enables outside dismissal on an already visible notification', () => {
    win.focusable = false;
    win.showInactive();
    vi.advanceTimersByTime(500);
    win.focusable = true;
    win.focused = true;
    win.emit('focus');
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    win.focused = false;
    vi.advanceTimersByTime(300);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test('a macOS panel closes after losing key focus without a blur event', () => {
    win.show();
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    win.focused = false;
    vi.advanceTimersByTime(300);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(win.visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('regaining key focus without a focus event cancels dismissal', () => {
    win.show();
    win.focused = false;
    vi.advanceTimersByTime(120);
    win.focused = true;
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('a native file sheet protects the composer until focus returns', () => {
    win.show();
    win.focused = false;
    win.emit('sheet-begin');
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    win.emit('sheet-end');
    win.focused = true;
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    win.focused = false;
    vi.advanceTimersByTime(300);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test.each([true, false])('native dialogs protect the composer (disabled owner: %s)', disabled => {
    win.show();
    win.focused = false;
    if (disabled) win.enabled = false;
    else {
      const child = new ComposerWindow();
      child.show();
      win.children = [child];
    }
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    win.enabled = true;
    win.children = [];
    win.focused = true;
    vi.advanceTimersByTime(300);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('hidden windows stop checking and a rapid reopen cancels stale dismissal', () => {
    expect(vi.getTimerCount()).toBe(0);
    win.show();
    win.focused = false;
    vi.advanceTimersByTime(120);
    win.hide();
    expect(vi.getTimerCount()).toBe(0);
    win.show();
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    win.destroyed = true;
    win.emit('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a panel reopened without key focus asks for it again instead of closing', () => {
    // Closing from the orb can leave the hidden panel marked key, so the next show() opens it unfocused.
    win.emit('focus');
    win.showInactive();
    const focus = vi.spyOn(win, 'focus');
    vi.advanceTimersByTime(130);
    expect(focus).toHaveBeenCalledOnce();
    expect(win.focused).toBe(true);
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    // Once it has had focus, an outside click closes it as usual.
    win.focused = false;
    vi.advanceTimersByTime(300);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test('a panel macOS will not make key stays open rather than flashing closed', () => {
    win.refusesFocus = true;
    const focus = vi.spyOn(win, 'focus');
    win.showInactive();
    win.emit('blur');
    vi.advanceTimersByTime(2_000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(win.visible).toBe(true);
    expect(focus).toHaveBeenCalledTimes(2);
    // Clicking into it gives it focus; leaving it afterwards dismisses it.
    win.focused = true;
    vi.advanceTimersByTime(130);
    win.focused = false;
    vi.advanceTimersByTime(300);
    expect(dismiss).toHaveBeenCalledOnce();
    // The next opening gets its own attempts.
    win.showInactive();
    vi.advanceTimersByTime(2_000);
    expect(focus).toHaveBeenCalledTimes(4);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test('a delayed native hide does not stop outside dismissal after reopening', () => {
    win.show();
    win.hide();
    win.show();
    win.emit('hide');
    win.focused = false;
    vi.advanceTimersByTime(300);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test.each(['win32', 'linux'] as const)('%s still uses native blur without polling', platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    win.show();
    expect(vi.getTimerCount()).toBe(0);
    win.focused = false;
    win.emit('blur');
    vi.advanceTimersByTime(200);
    expect(dismiss).toHaveBeenCalledOnce();
  });
});

describe('companion window creation', () => {
  const env = { preloadPath: '/app/preload.js', rendererDirectory: '/app/renderer', title: 'LobsterAI' };
  const create = (surface: DesktopCompanionSurface): BrowserWindowConstructorOptions => {
    windowOptions.length = 0;
    createCompanionWindow(env, { surface, bounds: { x: 0, y: 0, width: 100, height: 100 }, focusable: false });
    return windowOptions[0];
  };

  test('hidden content-sized surfaces keep running animation frames, so they are measured before they open', () => {
    expect(create(DesktopCompanionSurface.Selection).webPreferences?.backgroundThrottling).toBe(false);
    expect(create(DesktopCompanionSurface.Stage).webPreferences?.backgroundThrottling).toBe(false);
    expect(create(DesktopCompanionSurface.Panel).webPreferences?.backgroundThrottling).toBe(false);
    expect(create(DesktopCompanionSurface.Mascot).webPreferences?.backgroundThrottling).toBeUndefined();
  });

  test('on macOS every surface, task cards included, is a panel so it stays above full-screen apps', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      for (const surface of Object.values(DesktopCompanionSurface)) expect(create(surface).type).toBe('panel');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
