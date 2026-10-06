export const ConversationSearchShortcutTarget = {
  Conversation: 'conversation',
  History: 'history',
  None: 'none',
} as const;

export type ConversationSearchShortcutTarget =
  typeof ConversationSearchShortcutTarget[keyof typeof ConversationSearchShortcutTarget];

interface ResolveConversationSearchShortcutTargetOptions {
  isCoworkView: boolean;
  hasCurrentSession: boolean;
  isTextEditing: boolean;
  isCoworkSearchEligibleEditor: boolean;
}
export function resolveConversationSearchShortcutTarget({
  isCoworkView,
  hasCurrentSession,
  isTextEditing,
  isCoworkSearchEligibleEditor,
}: ResolveConversationSearchShortcutTargetOptions): ConversationSearchShortcutTarget {
  if (
    isCoworkView
    && hasCurrentSession
    && (!isTextEditing || isCoworkSearchEligibleEditor)
  ) {
    return ConversationSearchShortcutTarget.Conversation;
  }
  return isTextEditing
    ? ConversationSearchShortcutTarget.None
    : ConversationSearchShortcutTarget.History;
}
