export const AgentSidebarIndicator = {
  None: 'none',
  PendingPermission: 'pending_permission',
  Running: 'running',
  CompletedUnread: 'completed_unread',
} as const;

export type AgentSidebarIndicator =
  typeof AgentSidebarIndicator[keyof typeof AgentSidebarIndicator];

export const AgentTaskRowVariant = {
  Nested: 'nested',
  Pinned: 'pinned',
  Activity: 'activity',
} as const;

export type AgentTaskRowVariant =
  typeof AgentTaskRowVariant[keyof typeof AgentTaskRowVariant];

export const PinnedTaskSortMode = {
  UpdatedAt: 'updated_at',
  Manual: 'manual',
} as const;

export type PinnedTaskSortMode =
  typeof PinnedTaskSortMode[keyof typeof PinnedTaskSortMode];

export const AgentSidebarPreferenceKey = {
  State: 'myAgentSidebar.state',
} as const;

export const AgentSidebarPageSize = {
  Preview: 6,
  ExpandBatch: 10,
  PinnedPreview: 5,
} as const;
