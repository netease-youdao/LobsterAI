import { describe, expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import { CompanionPhase, companionPhase, companionReply } from './companionPresentation';
import { companionShortcutFromKeys } from './shortcut';
import type { CompanionSession } from './useCompanionSession';

describe('companion task presentation', () => {
  test('confirmation takes priority over a running state', () => {
    expect(companionPhase({ status: CoworkSessionStatusValue.Running }, true).value).toBe(CompanionPhase.Waiting);
  });
  test('a previous answer is not shown as the answer to a new turn', () => {
    expect(companionReply({ messages: [
      { type: 'assistant', content: 'Previous result' },
      { type: 'user', content: 'Change it' },
      { type: 'assistant', content: 'Private thinking', metadata: { isThinking: true } },
    ] } as CompanionSession)).toBe('');
  });
  test('a completed answer can be previewed without exposing thinking', () => {
    expect(companionReply({ messages: [
      { type: 'user', content: 'Summarize' },
      { type: 'assistant', content: 'Summary' },
      { type: 'assistant', content: 'Private thinking', metadata: { isThinking: true } },
    ] } as CompanionSession)).toBe('Summary');
  });
  test('shortcut capture requires a global modifier and handles physical key codes', () => {
    const keys = { key: 'j', code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(companionShortcutFromKeys(keys)).toBeNull();
    expect(companionShortcutFromKeys({ ...keys, metaKey: true, shiftKey: true })).toBe('Command+Shift+J');
    expect(companionShortcutFromKeys({ ...keys, key: ' ', code: 'Space', altKey: true })).toBe('Alt+Space');
    expect(companionShortcutFromKeys({ ...keys, key: 'Control', code: 'ControlLeft', ctrlKey: true })).toBeNull();
  });
});
