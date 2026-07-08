/** Default page size for session list pagination. */
export const COWORK_SESSION_PAGE_SIZE = 50;

/** Default page size for message history pagination. */
export const COWORK_MESSAGE_PAGE_SIZE = 30;

export const CoworkIpcChannel = {
  MediaStatusPollUpdate: 'cowork:media:statusPollUpdate',
  ForkSession: 'cowork:session:fork',
  SubTaskHistory: 'cowork:subTask:history',
  SubagentList: 'cowork:subagent:list',
  SubagentDelete: 'cowork:subagent:delete',
  MarkSessionViewed: 'cowork:session:markViewed',
  ExportSessionDiagnostics: 'cowork:session:exportDiagnostics',
  GetSessionMessageRailIndex: 'cowork:session:getMessageRailIndex',
  OpenSessionFromNotification: 'cowork:session:openFromNotification',
  OpenSessionFromNotificationReady: 'cowork:session:openFromNotificationReady',
  GoalCommand: 'cowork:session:goalCommand',
  SessionModelOverrideChanged: 'cowork:session:modelOverrideChanged',
  StreamGoal: 'cowork:stream:goal',
  MemoryReadRaw: 'cowork:memory:readRaw',
  MemoryWriteRaw: 'cowork:memory:writeRaw',
} as const;
export type CoworkIpcChannel = typeof CoworkIpcChannel[keyof typeof CoworkIpcChannel];

export const CoworkForkMode = {
  None: 'none',
  Conversation: 'conversation',
  Worktree: 'worktree',
} as const;
export type CoworkForkMode = typeof CoworkForkMode[keyof typeof CoworkForkMode];

export const CoworkContextUsageSource = {
  Live: 'live',
  Cache: 'cache',
  Unavailable: 'unavailable',
} as const;
export type CoworkContextUsageSource =
  typeof CoworkContextUsageSource[keyof typeof CoworkContextUsageSource];

export const CoworkContextUsageFailureReason = {
  Timeout: 'timeout',
  GatewayError: 'gateway_error',
} as const;
export type CoworkContextUsageFailureReason =
  typeof CoworkContextUsageFailureReason[keyof typeof CoworkContextUsageFailureReason];

export const CoworkContextUsageRefreshMode = {
  Auto: 'auto',
  Manual: 'manual',
  PostRun: 'postRun',
} as const;
export type CoworkContextUsageRefreshMode =
  typeof CoworkContextUsageRefreshMode[keyof typeof CoworkContextUsageRefreshMode];
