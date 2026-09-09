import type { OpenClawSessionPatch } from '../../../common/openclawSession';
import type { CoworkBrowserAnnotationMessageBatch } from '../../../shared/cowork/browserAnnotations';
import type {
  CoworkBtwAbortResponse,
  CoworkBtwEntry,
  CoworkBtwSubmitResponse,
} from '../../../shared/cowork/btw';
import type { CoworkGoal } from '../../../shared/cowork/goal';
import type { CoworkImageAttachmentPayload } from '../../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import type { CoworkSteerResponse } from '../../../shared/cowork/steer';
import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../../../shared/kit/constants';
import type { SkinWorkflowKind } from '../../../shared/skin/constants';
import type { CoworkMessage, CoworkSessionStatus } from '../../coworkStore';

export type CoworkAgentEngine = 'openclaw';

export type PermissionResult =
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

export const ENGINE_SWITCHED_CODE = 'ENGINE_SWITCHED';

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string | null;
}

export interface CoworkRuntimeEvents {
  message: (sessionId: string, message: CoworkMessage, beforeMessageId?: string) => void;
  messageUpdate: (sessionId: string, messageId: string, content: string, metadata?: Record<string, unknown>) => void;
  sessionStatus: (sessionId: string, status: CoworkSessionStatus) => void;
  btwResult: (sessionId: string, result: CoworkBtwEntry) => void;
  goalUpdate: (sessionId: string, goal: CoworkGoal | null) => void;
  contextUsageUpdate: (sessionId: string, usage: CoworkContextUsage) => void;
  contextMaintenance: (sessionId: string, active: boolean) => void;
  permissionRequest: (sessionId: string, request: PermissionRequest) => void;
  permissionResolved: (sessionId: string, requestId: string) => void;
  complete: (sessionId: string, claudeSessionId: string | null) => void;
  error: (sessionId: string, error: string) => void;
  sessionStopped: (sessionId: string) => void;
  runTermination: (sessionId: string, gatewayRunId: string, status: 'cancelled') => void;
}

export type CoworkContextUsage = {
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
};

export type CoworkForkCompactionSummary = {
  summary: string;
  sessionKey: string;
  checkpointId?: string;
  reason?: string;
  createdAt?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  truncated?: boolean;
};

export type CoworkImageAttachment = CoworkImageAttachmentPayload;

export type CoworkMediaAttachmentRef = {
  token: string;
  mediaType: 'image' | 'video' | 'audio';
  index: number;
  fileId: string;
  fileName: string;
  mimeType: string;
  localPath?: string;
  remoteUrl?: string;
  dataUrl?: string;
  role?: 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio';
};

export type CoworkMediaSelection = {
  mode: 'auto' | 'image' | 'video' | 'none';
  modelId?: string;
  modelName?: string;
  imageModelId?: string;
  videoModelId?: string;
};

export type CoworkStartOptions = {
  skipInitialUserMessage?: boolean;
  skillIds?: string[];
  messageSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  systemPrompt?: string;
  autoApprove?: boolean;
  workspaceRoot?: string;
  confirmationMode?: 'modal' | 'text';
  imageAttachments?: CoworkImageAttachment[];
  agentId?: string;
  mediaSelection?: CoworkMediaSelection;
  workflowKind?: SkinWorkflowKind;
  mediaReferences?: CoworkMediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
};

export type CoworkContinueOptions = {
  skipInitialUserMessage?: boolean;
  systemPrompt?: string;
  skillIds?: string[];
  messageSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: CoworkImageAttachment[];
  mediaSelection?: CoworkMediaSelection;
  workflowKind?: SkinWorkflowKind;
  mediaReferences?: CoworkMediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
};

export interface CoworkSessionPatchResult {
  modelOverride?: string;
  thinkingLevel?: string;
}

export interface CoworkRuntime {
  on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this;
  off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this;
  startSession(sessionId: string, prompt: string, options?: CoworkStartOptions): Promise<void>;
  continueSession(sessionId: string, prompt: string, options?: CoworkContinueOptions): Promise<void>;
  submitBtw?(sessionId: string, question: string, runId: string): Promise<CoworkBtwSubmitResponse>;
  abortBtw?(sessionId: string, runId: string): Promise<CoworkBtwAbortResponse>;
  submitSteer?(sessionId: string, text: string, clientSteerId: string): Promise<CoworkSteerResponse>;
  runGoalCommand?(sessionId: string, command: string): Promise<CoworkGoal | null>;
  patchSession?(sessionId: string, patch: OpenClawSessionPatch): Promise<CoworkSessionPatchResult | void>;
  getContextUsage?(sessionId: string): Promise<CoworkContextUsage | null>;
  compactContext?(sessionId: string): Promise<{ compacted: boolean; reason?: string; usage?: CoworkContextUsage | null }>;
  getForkCompactionSummary?(sessionId: string, beforeCreatedAt?: number): Promise<CoworkForkCompactionSummary | null>;
  stopSession(sessionId: string): void;
  cancelSessionConfirmed?(sessionId: string): Promise<boolean>;
  respondToPermissionConfirmed?(requestId: string, result: PermissionResult): Promise<void>;
  stopAllSessions(): void;
  respondToPermission(requestId: string, result: PermissionResult): void;
  isSessionActive(sessionId: string): boolean;
  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null;
  deleteSubagentSession?(parentSessionId: string, runId: string): Promise<boolean>;
  onSessionDeleted?(sessionId: string): void;
}
