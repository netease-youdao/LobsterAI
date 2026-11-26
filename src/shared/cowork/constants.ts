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

/**
 * How long an AskUserQuestion request waits for the user, matching OpenClaw's
 * native ask_user default (900 s): it carries choice questions as well as
 * delete confirmations, and a user who steps away must not read as a refusal.
 * The plugin (openclaw-extensions/ask-user-question) mirrors this value.
 */
export const ASK_USER_QUESTION_TIMEOUT_MS = 15 * 60_000;

/**
 * Id prefix of the optimistic session the renderer shows while a new task's
 * start request is in flight. It is never stored: the started session
 * replaces it, so a session carrying it has not reached the runtime yet.
 */
export const COWORK_TEMP_SESSION_ID_PREFIX = 'temp-';

export const CoworkSessionStatusValue = {
  Idle: 'idle',
  Running: 'running',
  Completed: 'completed',
  Error: 'error',
} as const;
export type CoworkSessionStatus = typeof CoworkSessionStatusValue[keyof typeof CoworkSessionStatusValue];

/**
 * Machine-readable codes on failed session start/continue IPC results. The
 * paired `error` text is already localized and must be shown as-is.
 */
export const CoworkSessionErrorCode = {
  WorkingDirectoryUnavailable: 'WORKING_DIRECTORY_UNAVAILABLE',
} as const;
export type CoworkSessionErrorCode = typeof CoworkSessionErrorCode[keyof typeof CoworkSessionErrorCode];

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

export const CoworkTempDirKind = {
  SessionTemp: 'session-temp',
  LegacySqliteBackup: 'legacy-sqlite-backup',
} as const;
export type CoworkTempDirKind = typeof CoworkTempDirKind[keyof typeof CoworkTempDirKind];

export const CoworkIpcChannel = {
  StreamMessage: 'cowork:stream:message',
  StreamMessageUpdate: 'cowork:stream:messageUpdate',
  StreamSessionStatus: 'cowork:stream:sessionStatus',
  StreamContextUsage: 'cowork:stream:contextUsage',
  StreamContextMaintenance: 'cowork:stream:contextMaintenance',
  StreamPermission: 'cowork:stream:permission',
  PermissionList: 'cowork:permission:list',
  SessionStart: 'cowork:session:start',
  SessionContinue: 'cowork:session:continue',
  EditMessage: 'cowork:message:edit',
  CheckMessageEdit: 'cowork:message:checkEdit',
  GetMessageEdit: 'cowork:message:editState',
  RecoverMessageEdit: 'cowork:message:recoverEdit',
  SwitchMessageVersion: 'cowork:message:switchVersion',
  ListSessions: 'cowork:session:list',
  GenerateSessionTitle: 'cowork:session:generateTitle',
  RenameSession: 'cowork:session:rename',
  PermissionRespond: 'cowork:permission:respond',
  StreamPermissionState: 'cowork:stream:permissionState',
  MediaConfirmation: 'cowork:media:confirmation',
  StreamPermissionDismiss: 'cowork:stream:permissionDismiss',
  StreamComplete: 'cowork:stream:complete',
  StreamError: 'cowork:stream:error',
  GetSession: 'cowork:session:get',
  GetSessionMessages: 'cowork:session:getMessages',
  GetSessionContextUsage: 'cowork:session:contextUsage',
  CompactSessionContext: 'cowork:session:compactContext',
  IsSessionRemoteManaged: 'cowork:session:remoteManaged',
  ConfigSet: 'cowork:config:set',
  GetPendingQuestions: 'cowork:question:pending',
  CancelMediaTask: 'cowork:media:cancel',
  GetMediaModels: 'media:getModels',
  GetMediaPreferences: 'media:getPreferences',
  SetMediaPreference: 'media:setPreference',
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
  SearchSessionContent: 'cowork:session:searchContent',
  ListFilteredSessions: 'cowork:session:listFiltered',
  ReorderPinnedSessions: 'cowork:session:reorderPinned',
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
  StreamTurnUsage: 'cowork:stream:turnUsage',
  RefreshTurnUsage: 'cowork:turnUsage:refresh',
  MemoryListEntries: 'cowork:memory:listEntries',
  MemoryCreateEntry: 'cowork:memory:createEntry',
  MemoryUpdateEntry: 'cowork:memory:updateEntry',
  MemoryDeleteEntry: 'cowork:memory:deleteEntry',
  MemoryDeleteEntries: 'cowork:memory:deleteEntries',
  MemoryGetStats: 'cowork:memory:getStats',
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
  deletedSessionIds?: string[];
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

export const CoworkMemoryStatus = {
  Created: 'created',
  Stale: 'stale',
  Deleted: 'deleted',
} as const;
export type CoworkMemoryStatus = typeof CoworkMemoryStatus[keyof typeof CoworkMemoryStatus];

export const CoworkMemoryStatusFilter = {
  All: 'all',
  Created: CoworkMemoryStatus.Created,
  Stale: CoworkMemoryStatus.Stale,
  Deleted: CoworkMemoryStatus.Deleted,
} as const;
export type CoworkMemoryStatusFilter =
  typeof CoworkMemoryStatusFilter[keyof typeof CoworkMemoryStatusFilter];

export interface CoworkUserMemorySourceSummary {
  count: number;
  activeCount: number;
  roles: string[];
  sessionIds: string[];
  sessionTitles?: string[];
  latestSessionId?: string | null;
  latestSessionTitle?: string | null;
  latestMessageId?: string | null;
  latestRole?: string | null;
  latestCreatedAt?: number | null;
}

export interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  section?: string;
  projectKeys?: string[];
  agentId?: string;
  status?: CoworkMemoryStatus;
  confidence?: number;
  isExplicit?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number | null;
  sourceCount?: number;
  sourceLabel?: string;
  sources?: CoworkUserMemorySourceSummary;
  /** True for SQLite-only historical deleted/stale audit entries not stored in MEMORY.md. */
  isLegacyReadOnly?: boolean;
}

export interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}
