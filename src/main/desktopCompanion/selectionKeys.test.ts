import { describe, expect, test } from 'vitest';

import { isScreenshotApp, SelectionKeyEffect, selectionKeyEffect } from './selectionKeys';

const COMMAND = 0x100000;
const SHIFT = 0x20000;
const CONTROL = 0x40000;
const FN = 0x800000;

describe('keys pressed while the selection toolbar is up', () => {
  test('typing and caret moves dismiss it on both platforms', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(selectionKeyEffect({ uniKey: 'a' }, platform)).toBe(SelectionKeyEffect.Dismiss);
      expect(selectionKeyEffect({ uniKey: 'Backspace' }, platform)).toBe(SelectionKeyEffect.Dismiss);
      expect(selectionKeyEffect({ uniKey: 'Escape' }, platform)).toBe(SelectionKeyEffect.Dismiss);
    }
    // Shift alone types capitals.
    expect(selectionKeyEffect({ uniKey: 'A', flags: SHIFT }, 'darwin')).toBe(SelectionKeyEffect.Dismiss);
    // macOS flags arrow keys with Fn; they still move the caret.
    expect(selectionKeyEffect({ uniKey: 'ArrowDown', flags: FN, sys: true }, 'darwin')).toBe(SelectionKeyEffect.Dismiss);
  });

  test('shortcuts, function keys and Print Screen keep it, so a screenshot can include it', () => {
    expect(selectionKeyEffect({ uniKey: 'c', flags: COMMAND, sys: true }, 'darwin')).toBe(SelectionKeyEffect.Keep);
    // WeChat's screenshot on macOS.
    expect(selectionKeyEffect({ uniKey: 'a', flags: COMMAND | CONTROL, sys: true }, 'darwin')).toBe(SelectionKeyEffect.Keep);
    // Cmd+Shift+3 captures at once.
    expect(selectionKeyEffect({ uniKey: '#', vkCode: 0x14, flags: COMMAND | SHIFT, sys: true }, 'darwin')).toBe(SelectionKeyEffect.Keep);
    // Win+Shift+S and WeChat's Alt+A on Windows.
    expect(selectionKeyEffect({ uniKey: 'S', sys: true }, 'win32')).toBe(SelectionKeyEffect.Keep);
    expect(selectionKeyEffect({ uniKey: 'a', sys: true }, 'win32')).toBe(SelectionKeyEffect.Keep);
    // Snipaste's F1 and the Print Screen key.
    expect(selectionKeyEffect({ uniKey: 'F1' }, 'win32')).toBe(SelectionKeyEffect.Keep);
    expect(selectionKeyEffect({ uniKey: 'PrintScreen' }, 'win32')).toBe(SelectionKeyEffect.Keep);
    expect(selectionKeyEffect({ uniKey: 'AudioVolumeUp' }, 'darwin')).toBe(SelectionKeyEffect.Keep);
  });

  test('screenshot overlays are told apart from ordinary apps', () => {
    for (const app of ['com.apple.screencaptureui', 'com.apple.Screenshot', 'pl.maketheweb.cleanshotx', 'ScreenClippingHost.exe', 'Snipaste.exe']) {
      expect(isScreenshotApp(app)).toBe(true);
    }
    for (const app of ['com.tencent.xinWeChat', 'com.microsoft.Word', 'chrome.exe']) expect(isScreenshotApp(app)).toBe(false);
  });

  test('macOS area and toolbar screenshots are recognized by key code, whatever Shift turns the digit into', () => {
    expect(selectionKeyEffect({ uniKey: '$', vkCode: 0x15, flags: COMMAND | SHIFT, sys: true }, 'darwin')).toBe(SelectionKeyEffect.Capture);
    expect(selectionKeyEffect({ uniKey: '$', vkCode: 0x15, flags: COMMAND | SHIFT | CONTROL, sys: true }, 'darwin'))
      .toBe(SelectionKeyEffect.Capture);
    expect(selectionKeyEffect({ uniKey: '%', vkCode: 0x17, flags: COMMAND | SHIFT, sys: true }, 'darwin')).toBe(SelectionKeyEffect.CaptureToolbar);
  });
});
