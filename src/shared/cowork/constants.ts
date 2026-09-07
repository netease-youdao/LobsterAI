/**
 * Sentinel sessionId for permission requests that arrive without a resolvable
 * OpenClaw session key (e.g. AskUserQuestion callbacks missing sessionKey).
 * The renderer must surface these in whichever session is currently open —
 * they can never match a real session id.
 */
export const SESSION_AGNOSTIC_PERMISSION_SESSION_ID = '__askuser__';

/**
 * Tool name carried by AskUserQuestion requests when they are surfaced through
 * the permission-request channel. Used to classify "waiting for input"
 * requests apart from regular approval requests.
 */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Default page size for session list pagination. */
export const COWORK_SESSION_PAGE_SIZE = 50;

/** Default page size for message history pagination. */
export const COWORK_MESSAGE_PAGE_SIZE = 30;

/**
 * Number of rows from the full mixed-message timeline inspected per
 * conversation-search request. Search pages intentionally use a separate,
 * bounded projection so tool/system payloads and message metadata never cross
 * the renderer IPC boundary.
 */
export const COWORK_SEARCH_MESSAGE_PAGE_SIZE = 200;

/** Defensive upper bound for renderer-supplied conversation-search page sizes. */
export const COWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE = 500;

/** Maximum aggregate searchable UTF-8 content returned by one IPC page. */
export const COWORK_SEARCH_MESSAGE_PAGE_MAX_CONTENT_BYTES = 16_777_216;

/** Maximum number of rows inspected from the complete mixed-message timeline. */
export const COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS = 100_000;

/** Maximum searchable content retained by the renderer, measured in UTF-16 code units. */
export const COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS = 16_777_216;

/** Maximum searchable content retained for one message, measured in UTF-16 code units. */
export const COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS = 1_048_576;

/**
 * Per-working-directory scratch directory for intermediate files (model
 * helper scripts, pasted attachments, drafts). Swept by the cowork temp
 * janitor; user-facing deliverables must not live here.
 */
export const COWORK_TEMP_DIR_NAME = '.cowork-temp';

/**
 * Subdirectory of the cowork temp dir holding pasted/manual attachments.
 * Attachment originals are referenced by message metadata (re-edit restores
 * them), so the janitor never deletes this subtree.
 */
export const COWORK_TEMP_ATTACHMENTS_DIR_NAME = 'attachments';

export const CoworkIpcChannel = {
  CancelMediaTask: 'cowork:media:cancel',
  GetMediaModels: 'media:getModels',
  MediaStatusPollUpdate: 'cowork:media:statusPollUpdate',
  ForkSession: 'cowork:session:fork',
  DeleteSession: 'cowork:session:delete',
  DeleteSessions: 'cowork:session:deleteBatch',
  StopSession: 'cowork:session:stop',
  SubTaskHistory: 'cowork:subTask:history',
  SubagentList: 'cowork:subagent:list',
  SubagentListByAgent: 'cowork:subagent:listByAgent',
  SubagentDelete: 'cowork:subagent:delete',
  MarkSessionViewed: 'cowork:session:markViewed',
  SetActiveSession: 'cowork:session:setActive',
  SeedNewUserWelcomeTask: 'cowork:session:seedNewUserWelcomeTask',
  ExportSessionDiagnostics: 'cowork:session:exportDiagnostics',
  GetSessionMessageRailIndex: 'cowork:session:getMessageRailIndex',
  GetSessionSearchMessages: 'cowork:session:getSearchMessages',
  OpenSessionFromNotification: 'cowork:session:openFromNotification',
  OpenSessionFromNotificationReady: 'cowork:session:openFromNotificationReady',
  GoalCommand: 'cowork:session:goalCommand',
  SubmitBtw: 'cowork:session:submitBtw',
  AbortBtw: 'cowork:session:abortBtw',
  SubmitSteer: 'cowork:session:submitSteer',
  SessionModelOverrideChanged: 'cowork:session:modelOverrideChanged',
  SessionsChanged: 'cowork:sessions:changed',
  StreamBtwResult: 'cowork:stream:btwResult',
  StreamGoal: 'cowork:stream:goal',
  MemoryReadRaw: 'cowork:memory:readRaw',
  MemoryWriteRaw: 'cowork:memory:writeRaw',
  BootstrapRead: 'cowork:bootstrap:read',
  BootstrapWrite: 'cowork:bootstrap:write',
  TempStorageUsage: 'cowork:tempStorage:usage',
  TempStorageClean: 'cowork:tempStorage:clean',
} as const;
export type CoworkIpcChannel = typeof CoworkIpcChannel[keyof typeof CoworkIpcChannel];

export interface CoworkSessionsChangedPayload {
  sessionIds: string[];
}

export const CoworkOnboardingMessageKind = {
  NewUserWelcome: 'new_user_welcome',
} as const;
export type CoworkOnboardingMessageKind =
  typeof CoworkOnboardingMessageKind[keyof typeof CoworkOnboardingMessageKind];

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
