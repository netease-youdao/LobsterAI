export const CoworkUiEvent = {
  OpenShareOptions: 'cowork:open-share-options',
  SelectSubagent: 'cowork:select-subagent',
  FocusInput: 'cowork:focus-input',
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

/** How one step renders inside an activity run. */
export const ActivityEntryVariant = {
  /** The step's own compact line, expandable for its detail. */
  Row: 'row',
} as const;

export type ActivityEntryVariant = typeof ActivityEntryVariant[keyof typeof ActivityEntryVariant];

/** What a step line's leading icon depicts; thinking lines carry no icon. */
export const ActivityStepKind = {
  Thinking: 'thinking',
  Command: 'command',
  Read: 'read',
  Edit: 'edit',
  Search: 'search',
  Web: 'web',
  Media: 'media',
  Agent: 'agent',
  Todo: 'todo',
  Schedule: 'schedule',
  Tool: 'tool',
} as const;

export type ActivityStepKind = typeof ActivityStepKind[keyof typeof ActivityStepKind];

export interface CoworkOpenShareOptionsEventDetail {
  sessionId: string;
}

export type CoworkSwitchAgentEventDetail = {
  direction: CoworkShortcutDirection;
};

export type CoworkOpenAgentTaskSlotEventDetail = {
  slot: number;
};
