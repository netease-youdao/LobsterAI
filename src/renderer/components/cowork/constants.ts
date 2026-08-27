export const CoworkUiEvent = {
  OpenShareOptions: 'cowork:open-share-options',
  SelectSubagent: 'cowork:select-subagent',
  FocusInput: 'cowork:focus-input',
  PrepareImageEditDraft: 'cowork:prepare-image-edit-draft',
  ShortcutSearch: 'cowork:shortcut:search',
  ShortcutConversationSearch: 'cowork:shortcut:conversation-search',
  ShortcutNewSession: 'cowork:shortcut:new-session',
  ShortcutStopSession: 'cowork:shortcut:stop-session',
  ShortcutToggleArtifacts: 'cowork:shortcut:toggle-artifacts',
  ShortcutSwitchAgent: 'cowork:shortcut:switch-agent',
  ShortcutShowCurrentAgentTasks: 'cowork:shortcut:show-current-agent-tasks',
  ShortcutCollapseCurrentAgentTasks: 'cowork:shortcut:collapse-current-agent-tasks',
  ShortcutOpenAgentTaskSlot: 'cowork:shortcut:open-agent-task-slot',
} as const;

export type CoworkUiEvent = typeof CoworkUiEvent[keyof typeof CoworkUiEvent];

export const CoworkTaskSearchRequestSource = {
  SidebarHeader: 'sidebar_header',
  WindowsTitleBar: 'windows_title_bar',
  KeyboardShortcut: 'keyboard_shortcut',
  UiEvent: 'ui_event',
} as const;

export type CoworkTaskSearchRequestSource =
  typeof CoworkTaskSearchRequestSource[keyof typeof CoworkTaskSearchRequestSource];

export interface CoworkTaskSearchRequestEventDetail {
  source?: CoworkTaskSearchRequestSource;
}

export const CoworkShortcutDirection = {
  Previous: 'previous',
  Next: 'next',
} as const;

export type CoworkShortcutDirection =
  typeof CoworkShortcutDirection[keyof typeof CoworkShortcutDirection];

export interface CoworkOpenShareOptionsEventDetail {
  sessionId: string;
}

export interface CoworkPrepareImageEditDraftEventDetail {
  draftKey: string;
  prompt: string;
  handled: boolean;
}

export type CoworkSwitchAgentEventDetail = {
  direction: CoworkShortcutDirection;
};

export type CoworkOpenAgentTaskSlotEventDetail = {
  slot: number;
};
