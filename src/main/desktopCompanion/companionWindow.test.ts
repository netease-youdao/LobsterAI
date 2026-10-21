import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { dismissCompanionPanelOnBlur } from './companionWindow';

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

class ComposerWindow extends EventEmitter {
  visible = false;
  focused = false;
  focusable = true;
  enabled = true;
  destroyed = false;
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
