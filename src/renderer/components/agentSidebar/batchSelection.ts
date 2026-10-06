export const AgentSidebarBatchItemKind = {
  Session: 'session',
} as const;
export type AgentSidebarBatchItemKind =
  typeof AgentSidebarBatchItemKind[keyof typeof AgentSidebarBatchItemKind];

export interface AgentSidebarSessionBatchItem {
  kind: typeof AgentSidebarBatchItemKind.Session;
  key: string;
  sessionId: string;
}

export type AgentSidebarBatchItem = AgentSidebarSessionBatchItem;

export const createSessionBatchKey = (sessionId: string): string => (
  `${AgentSidebarBatchItemKind.Session}:${encodeURIComponent(sessionId)}`
);

export const createSessionBatchItem = (sessionId: string): AgentSidebarSessionBatchItem => ({
  kind: AgentSidebarBatchItemKind.Session,
  key: createSessionBatchKey(sessionId),
  sessionId,
});
