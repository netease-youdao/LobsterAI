import type {
  CoworkContextUsageFailureReason,
  CoworkContextUsageSource,
  CoworkForkMode,
} from '../../shared/cowork/constants';
import type { CoworkGoal } from '../../shared/cowork/goal';
import type {
  CoworkImageAttachmentPayload,
  CoworkImageAttachmentPreview,
} from '../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../shared/cowork/selectedText';
import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../../shared/kit/constants';
import type {
  OpenClawEnginePhase as SharedOpenClawEnginePhase,
  OpenClawGatewayRepairErrorCode,
} from '../../shared/openclawEngine/constants';

// Cowork image attachment for vision-capable models
export type CoworkImageAttachment = CoworkImageAttachmentPayload;

// Cowork session status
export const CoworkSessionStatusValue = {
  Idle: 'idle',
  Running: 'running',
  Completed: 'completed',
  Error: 'error',
} as const;

export type CoworkSessionStatus =
  typeof CoworkSessionStatusValue[keyof typeof CoworkSessionStatusValue];

// Cowork message types
export type CoworkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

// Cowork execution mode
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';
export type CoworkAgentEngine = 'openclaw';

export const CoworkCollaborationMode = {
  Default: 'default',
  Plan: 'plan',
} as const;

export type CoworkCollaborationMode =
  typeof CoworkCollaborationMode[keyof typeof CoworkCollaborationMode];

export const OpenClawSessionKeepAlive = {
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}

// Cowork message metadata
export interface CoworkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  isThinking?: boolean;
  skillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: CoworkImageAttachment[];
  imageAttachmentPreviews?: CoworkImageAttachmentPreview[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  contextPercent?: number;
  model?: string;
  agentName?: string;
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  goalSetting?: {
    action: 'start' | 'create' | 'set';
    objective: string;
  };
  localMediaAttachments?: Array<{
    localPath: string;
    mimeType?: string;
    name?: string;
  }>;
  [key: string]: unknown;
}

export interface CoworkContextUsage {
  sessionId: string;
  sessionKey?: string;
  usedTokens?: number;
  contextTokens?: number;
  percent?: number;
  compactionCount?: number;
  status: 'unknown' | 'normal' | 'warning' | 'danger' | 'compacting';
  latestCompactionCheckpointId?: string;
  latestCompactionReason?: string;
  latestCompactionCreatedAt?: number;
  model?: string;
  updatedAt: number;
}

export type CoworkContextUsageResult =
  | {
      success: true;
      usage?: CoworkContextUsage | null;
      source?: CoworkContextUsageSource;
    }
  | {
      success: false;
      error?: string;
      reason?: CoworkContextUsageFailureReason;
    };

// Cowork message
export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
}

// Cowork session
export interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: CoworkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  cwd: string;
  systemPrompt: string;
  modelOverride: string;
  executionMode: CoworkExecutionMode;
  activeSkillIds: string[];
  activeKitIds?: string[];
  agentId: string;
  messages: CoworkMessage[];
  /** Offset of the first loaded message in the full message history. 0 means loaded from the beginning. */
  messagesOffset: number;
  /** Total number of messages stored for this session. */
  totalMessages: number;
  parentSessionId?: string | null;
  forkedFromMessageId?: string | null;
  forkedAt?: number | null;
  forkMode?: CoworkForkMode;
  forkWorkspacePath?: string | null;
  forkGitBranch?: string | null;
  forkGitBaseRef?: string | null;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

// Cowork configuration
export interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  agentEngine: CoworkAgentEngine;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  skipMissedJobs: boolean;
  openClawHeartbeatEnabled: boolean;
  embeddingEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingLocalModelPath: string;
  embeddingVectorWeight: number;
  embeddingRemoteBaseUrl: string;
  embeddingRemoteApiKey: string;
  dreamingEnabled: boolean;
  dreamingFrequency: string;
  dreamingModel: string;
  dreamingTimezone: string;
  openClawSessionPolicy: OpenClawSessionPolicyConfig;
}

export type CoworkConfigUpdate = Partial<Pick<
  CoworkConfig,
  | 'workingDirectory'
  | 'executionMode'
  | 'agentEngine'
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'skipMissedJobs'
  | 'openClawHeartbeatEnabled'
  | 'embeddingEnabled'
  | 'embeddingProvider'
  | 'embeddingModel'
  | 'embeddingLocalModelPath'
  | 'embeddingVectorWeight'
  | 'embeddingRemoteBaseUrl'
  | 'embeddingRemoteApiKey'
  | 'dreamingEnabled'
  | 'dreamingFrequency'
  | 'dreamingModel'
  | 'dreamingTimezone'
>>;

export interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

export type OpenClawEnginePhase = SharedOpenClawEnginePhase;

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  gatewayPort?: number | null;
  gatewayHttpUrl?: string | null;
  canRetry: boolean;
}

export interface OpenClawGatewayRepairResult {
  success: boolean;
  status?: OpenClawEngineStatus;
  originalPath?: string;
  backupPath?: string;
  error?: string;
  errorCode?: OpenClawGatewayRepairErrorCode;
  recoverable?: boolean;
}

export interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  section?: string;
}

export interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

// Cowork pending permission request
export interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

export type CoworkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

// Cowork permission response
export interface CoworkPermissionResponse {
  requestId: string;
  result: CoworkPermissionResult;
}

// Session summary for list display (without full messages)
export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  agentId?: string;
  parentSessionId?: string | null;
  forkedAt?: number | null;
  forkMode?: CoworkForkMode;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkForkSessionOptions {
  sessionId: string;
  forkedFromMessageId?: string | null;
  title?: string;
}

// Subagent session summary for sidebar display
export interface SubagentSessionSummary {
  id: string;
  agentId: string | null;
  task: string | null;
  label: string | null;
  sessionKey: string | null;
  parentSessionId: string;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  endedAt: number | null;
}

// Start session options
export interface CoworkStartOptions {
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  title?: string;
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  agentId?: string;
  modelOverride?: string;
  imageAttachments?: CoworkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
}

// Continue session options
export interface CoworkContinueOptions {
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: CoworkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
}

// IPC result types
export interface CoworkSessionResult {
  success: boolean;
  session?: CoworkSession;
  error?: string;
}

export interface CoworkSessionListResult {
  success: boolean;
  sessions?: CoworkSessionSummary[];
  /** Whether more sessions exist beyond the currently loaded set. */
  hasMore?: boolean;
  error?: string;
}

export interface CoworkMessageListResult {
  success: boolean;
  messages?: CoworkMessage[];
  /** Offset of the first returned message. */
  offset?: number;
  /** Total message count for the session. */
  total?: number;
  error?: string;
}

export interface CoworkConfigResult {
  success: boolean;
  config?: CoworkConfig;
  error?: string;
}

// ── Dreaming content display types ──────────────────────────────────

export interface DreamingPhaseInfo {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
}

export interface DreamingEntry {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
}

export interface DreamingStatusData {
  enabled: boolean;
  timezone?: string;
  shortTermCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  promotedToday: number;
  promotedTotal: number;
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
}

export interface DreamDiaryData {
  found: boolean;
  path: string;
  content?: string;
  updatedAtMs?: number;
}

// Stream event types for IPC communication
export type CoworkStreamEventType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'complete'
  | 'error';

export interface CoworkStreamEvent {
  type: CoworkStreamEventType;
  sessionId: string;
  data: {
    message?: CoworkMessage;
    permission?: CoworkPermissionRequest;
    error?: string;
    claudeSessionId?: string;
  };
}
