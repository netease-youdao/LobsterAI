/**
 * Unit tests for formatShortcutForDisplay.
 *
 * Bug covered (issue #973):
 *   On macOS the Settings > Shortcuts panel displayed "Ctrl+N" instead of
 *   the platform-conventional "⌘+N". The fix introduces a display formatter
 *   that maps modifier names to macOS symbols when running on darwin.
 */
import { test, expect, afterEach } from 'vitest';
import { formatShortcutForDisplay } from './shortcuts';

// Helper: stub window.electron.platform
const setPlatform = (platform: string) => {
  (globalThis as any).window = { electron: { platform } };
};
const clearPlatform = () => {
  delete (globalThis as any).window;
};

afterEach(() => clearPlatform());

// ---------------------------------------------------------------------------
// macOS (darwin) — modifiers are replaced with symbols
// ---------------------------------------------------------------------------

test('macOS: Cmd is replaced with ⌘', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay('Cmd+N')).toBe('⌘+N');
});

test('macOS: Ctrl is replaced with ⌃', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay('Ctrl+N')).toBe('⌃+N');
});

test('macOS: Alt is replaced with ⌥', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay('Alt+Tab')).toBe('⌥+Tab');
});

test('macOS: Shift is replaced with ⇧', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay('Shift+A')).toBe('⇧+A');
});

test('macOS: multiple modifiers are all replaced', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay('Cmd+Shift+N')).toBe('⌘+⇧+N');
});

test('macOS: Cmd+Alt+Shift combo', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay('Cmd+Alt+Shift+Z')).toBe('⌘+⌥+⇧+Z');
});

// ---------------------------------------------------------------------------
// Windows / Linux — modifiers are left as-is
// ---------------------------------------------------------------------------

test('Windows: Ctrl stays as Ctrl', () => {
  setPlatform('win32');
  expect(formatShortcutForDisplay('Ctrl+N')).toBe('Ctrl+N');
});

test('Linux: Ctrl stays as Ctrl', () => {
  setPlatform('linux');
  expect(formatShortcutForDisplay('Ctrl+F')).toBe('Ctrl+F');
});

test('Windows: Shift+Alt stays unchanged', () => {
  setPlatform('win32');
  expect(formatShortcutForDisplay('Shift+Alt+D')).toBe('Shift+Alt+D');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('empty string returns empty', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay('')).toBe('');
});

test('undefined returns empty', () => {
  setPlatform('darwin');
  expect(formatShortcutForDisplay(undefined)).toBe('');
});

test('no window object falls back to no replacement', () => {
  clearPlatform();
  expect(formatShortcutForDisplay('Cmd+N')).toBe('Cmd+N');
});
