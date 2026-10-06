export const AgentSidebarIndicator = {
  None: 'none',
  PendingPermission: 'pending_permission',
  Running: 'running',
  CompletedUnread: 'completed_unread',
} as const;

export type AgentSidebarIndicator =
  typeof AgentSidebarIndicator[keyof typeof AgentSidebarIndicator];

export const AgentSidebarPreferenceKey = {
  State: 'myAgentSidebar.state',
} as const;

export const AgentSidebarPageSize = {
  Preview: 6,
  ExpandBatch: 10,
} as const;
