import { expect, test } from 'vitest';

import { matchesSendShortcut, SendShortcut } from './sendShortcut';

const enter = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
test('inline and bottom editors honor the same user shortcut including disabled and platform-specific control', () => {
  expect(matchesSendShortcut(SendShortcut.Enter, enter, true)).toBe(true);
  expect(matchesSendShortcut(SendShortcut.Enter, { ...enter, shiftKey: true }, true)).toBe(false);
  expect(matchesSendShortcut(SendShortcut.Disabled, enter, false)).toBe(false);
  expect(matchesSendShortcut(SendShortcut.ShiftEnter, { ...enter, shiftKey: true }, false)).toBe(true);
  expect(matchesSendShortcut(SendShortcut.ControlEnter, { ...enter, metaKey: true }, true)).toBe(true);
  expect(matchesSendShortcut(SendShortcut.ControlEnter, { ...enter, ctrlKey: true }, false)).toBe(true);
  expect(matchesSendShortcut(SendShortcut.ControlEnter, { ...enter, ctrlKey: true }, true)).toBe(false);
});
