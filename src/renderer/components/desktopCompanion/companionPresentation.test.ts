import { describe, expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import { CompanionPhase, companionPhase } from './companionPresentation';
import { companionShortcutFromKeys } from './shortcut';

describe('companion task presentation', () => {
  test('confirmation takes priority over a running state', () => {
    expect(companionPhase({ status: CoworkSessionStatusValue.Running }, true).value).toBe(CompanionPhase.Waiting);
  });
  test('shortcut capture requires a global modifier and handles physical key codes', () => {
    const keys = { key: 'j', code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(companionShortcutFromKeys(keys)).toBeNull();
    expect(companionShortcutFromKeys({ ...keys, metaKey: true, shiftKey: true })).toBe('Command+Shift+J');
    expect(companionShortcutFromKeys({ ...keys, key: ' ', code: 'Space', altKey: true })).toBe('Alt+Space');
    expect(companionShortcutFromKeys({ ...keys, key: 'Control', code: 'ControlLeft', ctrlKey: true })).toBeNull();
  });
});
