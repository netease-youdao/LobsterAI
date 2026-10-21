import { describe, expect, test } from 'vitest';

import { DEFAULT_DESKTOP_COMPANION_PREFERENCES } from '../../shared/desktopCompanion/constants';
import { formatShortcutForDisplay, isTextEditingSafeShortcut, matchesShortcut } from './shortcuts';

describe('quick panel shortcut display', () => {
  test.each([
    { isMac: true, expected: 'Option+Space' },
    { isMac: false, expected: 'Alt+Space' },
  ])('formats the default shortcut for isMac=$isMac', ({ isMac, expected }) => {
    expect(formatShortcutForDisplay(DEFAULT_DESKTOP_COMPANION_PREFERENCES.shortcut, { isMac })).toBe(expected);
  });
});

describe('isTextEditingSafeShortcut', () => {
  test('returns false for empty or missing bindings', () => {
    expect(isTextEditingSafeShortcut(undefined)).toBe(false);
    expect(isTextEditingSafeShortcut('')).toBe(false);
  });

  test('accepts bindings carrying a Cmd/Ctrl modifier', () => {
    expect(isTextEditingSafeShortcut('CommandOrControl+Shift+H')).toBe(true);
    expect(isTextEditingSafeShortcut('CommandOrControl+/')).toBe(true);
    expect(isTextEditingSafeShortcut('Ctrl+Alt+H')).toBe(true);
    expect(isTextEditingSafeShortcut('Cmd+K')).toBe(true);
  });

  test('rejects bindings that plain typing could produce', () => {
    expect(isTextEditingSafeShortcut('Enter')).toBe(false);
    expect(isTextEditingSafeShortcut('Shift+H')).toBe(false);
    // Alt alone is unsafe: Option+key inserts special characters on macOS.
    expect(isTextEditingSafeShortcut('Alt+H')).toBe(false);
  });
});

describe('matchesShortcut', () => {
  test('matches macOS Option letter bindings when the event key is a symbol', () => {
    const event = {
      key: '√', code: 'KeyV', ctrlKey: false, altKey: true, metaKey: false, shiftKey: false,
    } as KeyboardEvent;
    expect(matchesShortcut(event, 'Option+V')).toBe(true);
  });

  test('preserves the typed letter for shortcuts without Alt on other keyboard layouts', () => {
    const event = {
      key: 'a', code: 'KeyQ', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
    } as KeyboardEvent;
    expect(matchesShortcut(event, 'Ctrl+A')).toBe(true);
    expect(matchesShortcut(event, 'Ctrl+Q')).toBe(false);
  });

  test('does not trigger Ctrl+Alt shortcuts while Windows AltGr is composing text', () => {
    const event = {
      key: 'e',
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
      getModifierState: (modifier: string) => modifier === 'AltGraph',
    } as unknown as KeyboardEvent;

    expect(matchesShortcut(event, 'Ctrl+Alt+E')).toBe(false);
  });
});
