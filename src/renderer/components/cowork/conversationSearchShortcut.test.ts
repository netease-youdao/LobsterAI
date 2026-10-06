import { describe, expect, test } from 'vitest';

import {
  ConversationSearchShortcutTarget,
  resolveConversationSearchShortcutTarget,
} from './conversationSearchShortcut';

describe('conversation search shortcut routing', () => {
  test('uses conversation search for an open Cowork session', () => {
    expect(resolveConversationSearchShortcutTarget({
      isCoworkView: true,
      hasCurrentSession: true,
      isTextEditing: false,
      isCoworkSearchEligibleEditor: false,
    })).toBe(ConversationSearchShortcutTarget.Conversation);
  });

  test('allows conversation search while the Cowork prompt is focused', () => {
    expect(resolveConversationSearchShortcutTarget({
      isCoworkView: true,
      hasCurrentSession: true,
      isTextEditing: true,
      isCoworkSearchEligibleEditor: true,
    })).toBe(ConversationSearchShortcutTarget.Conversation);
  });

  test('does not steal search from unrelated editors', () => {
    expect(resolveConversationSearchShortcutTarget({
      isCoworkView: true,
      hasCurrentSession: true,
      isTextEditing: true,
      isCoworkSearchEligibleEditor: false,
    })).toBe(ConversationSearchShortcutTarget.None);
  });

  test('keeps history search outside an open Cowork session', () => {
    expect(resolveConversationSearchShortcutTarget({
      isCoworkView: false,
      hasCurrentSession: true,
      isTextEditing: false,
      isCoworkSearchEligibleEditor: false,
    })).toBe(ConversationSearchShortcutTarget.History);
    expect(resolveConversationSearchShortcutTarget({
      isCoworkView: true,
      hasCurrentSession: false,
      isTextEditing: false,
      isCoworkSearchEligibleEditor: false,
    })).toBe(ConversationSearchShortcutTarget.History);
  });
});
