import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { classifyErrorKey, CoworkErrorI18nKey } from '../../../common/coworkErrorClassify';
import {
  ContextCompactionMode,
  ContextCompactionStatus,
  CoworkSystemMessageKind,
} from '../../../common/coworkSystemMessages';
import { buildGoalSettingMessageMetadata } from '../../../common/goalCommandDisplay';
import type { OpenClawSessionPatch } from '../../../common/openclawSession';
import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import {
  type CoworkGoal,
  normalizeCoworkGoal,
} from '../../../shared/cowork/goal';
import {
  buildCoworkImageAttachmentPreviews,
  formatCoworkImageAttachmentLimit,
  validateCoworkImageAttachmentSize,
} from '../../../shared/cowork/imageAttachments';
import {
  containsPlanModePrompt,
  isPlanImplementationApproval,
  PLAN_MODE_EXECUTION_OVERRIDE_MARKER,
} from '../../../shared/cowork/planMode';
import {
  buildSelectedTextPromptSection,
  type CoworkSelectedTextSnippet,
} from '../../../shared/cowork/selectedText';
import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../../../shared/kit/constants';
import type { Agent, CoworkExecutionMode, CoworkMessage, CoworkMessageMetadata, CoworkSession, CoworkSessionStatus, CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import { MediaGenerationTool } from '../../mediaGenerationPolicy';
import type { SubagentMessageStore } from '../../subagentMessageStore';
import type { SubagentRunStore } from '../../subagentRunStore';
import { setCoworkProxySessionId } from '../coworkOpenAICompatProxy';
import { extractOpenClawAssistantStreamParts,extractOpenClawAssistantStreamText } from '../openclawAssistantText';
import {
  buildManagedSessionKey,
  isCronSessionKey,
  isManagedSessionKey,
  type OpenClawChannelSessionSync,
  parseManagedSessionKey,
} from '../openclawChannelSessionSync';
import { OPENCLAW_AGENT_TIMEOUT_SECONDS } from '../openclawConfigSync';
import {
  OpenClawEngineManager,
  type OpenClawEngineStatus,
  type OpenClawGatewayConnectionInfo,
} from '../openclawEngineManager';
import {
  extractGatewayHistoryEntries,
  extractGatewayMessageText,
  isHeartbeatAckText,
  isPreCompactionMemoryFlushPromptText,
  isSilentReplyPrefixText,
  isSilentReplyText,
  shouldSuppressHeartbeatText,
  stripTrailingSilentReplyTail,
  stripTrailingSilentReplyToken,
} from '../openclawHistory';
import { buildOpenClawLocalTimeContextPrompt } from '../openclawLocalTimeContextPrompt';
import { consumeRecentOpenClawTokenProxyQuotaError } from '../openclawTokenProxy';
import {
  extractThinkingFromCurrentTurn,
  findMatchingThinkingMessageIdInCurrentTurn,
  findRedundantFinalPrefixMessageId,
  findReusableCommittedAssistantMessageId,
  findReusableFinalAssistantMessageId,
} from './assistantMessageReconciliation';
import { resolveChannelSessionNextStatus } from './channelSessionRunStatus';
import { AgentLifecyclePhase, type AgentLifecyclePhase as AgentLifecyclePhaseValue } from './constants';
import {
  buildCoworkContinuityCapsule,
  ContinuityCapsuleSource,
  type ContinuityCapsuleSource as ContinuityCapsuleSourceValue,
  formatCoworkContinuityCapsuleBridge,
  formatCoworkMiniContinuityCapsuleBridge,
} from './coworkContinuityCapsule';
import { buildCoworkTopKEvidenceBridgeResult } from './coworkTopKEvidence';
import { buildCoworkWorkspaceRehydrationBridge } from './coworkWorkspaceRehydration';
import { extractCronDeliveredTarget } from './cronDeliveryTarget';
import { OpenClawApprovalController } from './openclawApprovalController';
import {
  applyLocalTimestampsToEntries,
  buildGatewayMediaMetadata,
  findTailAlignment,
  getLocalMediaAttachmentsKey,
  isSameReconciledEntry,
  type ReconciledConversationEntry,
} from './openclawConversationReconciliation';
import {
  buildCronRunHistoryEntries,
  buildCronRunLocalHistoryEntries,
  findCronRunHistoryLocalMatch,
  hasCronRunHistoryForSession,
  shouldReplaceLocalConversationWithCronHistory,
} from './openclawCronRunHistorySync';
import { SubagentTracker } from './subagentTracker';
import type {
  CoworkContextUsage,
  CoworkContinueOptions,
  CoworkForkCompactionSummary,
  CoworkImageAttachment,
  CoworkMediaAttachmentRef,
  CoworkMediaSelection,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkSessionPatchResult,
  CoworkStartOptions,
  PermissionResult,
} from './types';

const OPENCLAW_GATEWAY_TOOL_EVENTS_CAP = 'tool-events';
const BRIDGE_MAX_MESSAGES = 20;
const BRIDGE_MAX_MESSAGE_CHARS = 1200;
const FORK_COMPACTION_SUMMARY_MAX_CHARS = 40_000;
// v2026.4.5 introduced a connect.challenge pre-auth step that can delay the
// initial handshake when the gateway is busy loading plugins at startup.
// The GatewayClient auto-reconnects and typically succeeds on the second
// attempt.  Keep a broad timeout to accommodate plugin loading and runtime
// warmup on slow machines.
const GATEWAY_READY_TIMEOUT_MS = 60_000;
const FINAL_HISTORY_SYNC_LIMIT = 50;
const CHANNEL_SESSION_DISCOVERY_LIMIT = 200;
export const OPENCLAW_CHAT_SEND_PAYLOAD_LIMIT_BYTES = 30 * 1000 * 1000;
export const OPENCLAW_CHAT_SEND_PAYLOAD_SAFETY_MARGIN_BYTES = 500 * 1000;
export const OPENCLAW_CHAT_SEND_PAYLOAD_SAFE_LIMIT_BYTES =
  OPENCLAW_CHAT_SEND_PAYLOAD_LIMIT_BYTES - OPENCLAW_CHAT_SEND_PAYLOAD_SAFETY_MARGIN_BYTES;
const WebSocketCloseCode = {
  MessageTooBig: 1009,
} as const;
const MediaGenerationToolAction = {
  Status: 'status',
} as const;

type OpenClawGoalCommandAction =
  | 'block'
  | 'blocked'
  | 'clear'
  | 'complete'
  | 'create'
  | 'done'
  | 'pause'
  | 'resume'
  | 'set'
  | 'start'
  | 'status';

const OPENCLAW_GOAL_ACTIONS = new Set<string>([
  'block',
  'blocked',
  'clear',
  'complete',
  'create',
  'done',
  'pause',
  'resume',
  'set',
  'start',
  'status',
]);

const GOAL_BOOTSTRAP_ACTIONS = new Set<OpenClawGoalCommandAction>([
  'create',
  'set',
  'start',
]);

const GOAL_CONTINUATION_PROMPT_PREFIX = 'Pursue this goal exactly as written from this JSON string:';
const GOAL_RESUME_NOTE_PROMPT_PREFIX =
  'Continue pursuing the current goal. Interpret this JSON string as the resume note:';

type PendingGoalContinuation = {
  action: OpenClawGoalCommandAction;
  prompt: string;
  skipInitialUserMessage: boolean;
  systemPrompt?: string;
};

type OpenClawChatSendFrameEstimate = {
  id: string;
  method: string;
  params: unknown;
};

type ChatSendAttachmentLike = {
  content?: string;
};

function parseOpenClawGoalCommand(raw: string): { action: OpenClawGoalCommandAction; text: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (commandToken.toLowerCase() !== '/goal') return null;
  const argText = commandEnd === -1 ? '' : trimmed.slice(commandEnd).trim();
  if (!argText) return { action: 'status', text: '' };
  const [rawAction = '', ...rest] = argText.split(/\s+/);
  const action = rawAction.toLowerCase();
  if (!OPENCLAW_GOAL_ACTIONS.has(action)) {
    return { action: 'start', text: argText };
  }
  return { action: action as OpenClawGoalCommandAction, text: rest.join(' ').trim() };
}

function hasCommandLikeGoalText(trimmed: string): boolean {
  return /(?:^|\s)\//.test(trimmed) || trimmed.startsWith('!');
}

function encodeGoalJsonString(trimmed: string): string {
  return JSON.stringify(trimmed).replaceAll('/', '\\/');
}

function formatGoalContinuationPrompt(objective: string): string {
  const trimmed = objective.trim();
  return hasCommandLikeGoalText(trimmed)
    ? `${GOAL_CONTINUATION_PROMPT_PREFIX} ${encodeGoalJsonString(trimmed)}`
    : trimmed;
}

function formatGoalResumeContinuationPrompt(note: string): string {
  const trimmed = note.trim();
  if (!trimmed) return 'Continue pursuing the current goal.';
  return hasCommandLikeGoalText(trimmed)
    ? `${GOAL_RESUME_NOTE_PROMPT_PREFIX} ${encodeGoalJsonString(trimmed)}`
    : `Continue pursuing the current goal. Note: ${trimmed}`;
}

function shouldBootstrapGoalFromPrompt(
  command: { action: OpenClawGoalCommandAction; text: string } | null,
): command is { action: 'create' | 'set' | 'start'; text: string } {
  return Boolean(command && GOAL_BOOTSTRAP_ACTIONS.has(command.action) && command.text.trim());
}

export function estimateOpenClawChatSendFrameBytes(params: unknown): number {
  const frame: OpenClawChatSendFrameEstimate = {
    id: 'estimate',
    method: 'chat.send',
    params,
  };
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

function sumAttachmentBase64Bytes(attachments?: ChatSendAttachmentLike[]): number {
  return (attachments ?? []).reduce((total, attachment) => {
    return total + (typeof attachment.content === 'string' ? attachment.content.length : 0);
  }, 0);
}

export function buildOpenClawChatSendPayloadTooLargeError(options: {
  estimatedFrameBytes: number;
  safeLimitBytes: number;
  attachmentCount: number;
  attachmentBase64Bytes: number;
}): Error {
  return new Error(
    `chat.send payload too large: estimated ${options.estimatedFrameBytes} bytes exceeds safe limit `
    + `${options.safeLimitBytes} bytes; attachments ${options.attachmentCount}; attachment base64 bytes `
    + `${options.attachmentBase64Bytes}`,
  );
}

function assertOpenClawChatSendPayloadWithinLimit(
  sessionId: string,
  params: unknown,
  attachments?: ChatSendAttachmentLike[],
): void {
  const estimatedFrameBytes = estimateOpenClawChatSendFrameBytes(params);
  if (estimatedFrameBytes <= OPENCLAW_CHAT_SEND_PAYLOAD_SAFE_LIMIT_BYTES) {
    return;
  }

  const attachmentCount = attachments?.length ?? 0;
  const attachmentBase64Bytes = sumAttachmentBase64Bytes(attachments);
  console.warn(
    '[OpenClawRuntime] chat.send payload exceeded safe limit.',
    `Session ${sessionId}.`,
    `Estimated ${estimatedFrameBytes} bytes.`,
    `Safe limit ${OPENCLAW_CHAT_SEND_PAYLOAD_SAFE_LIMIT_BYTES} bytes.`,
    `Attachments ${attachmentCount}.`,
    `Attachment base64 total ${attachmentBase64Bytes} bytes.`,
  );
  throw buildOpenClawChatSendPayloadTooLargeError({
    estimatedFrameBytes,
    safeLimitBytes: OPENCLAW_CHAT_SEND_PAYLOAD_SAFE_LIMIT_BYTES,
    attachmentCount,
    attachmentBase64Bytes,
  });
}

function validateRuntimeImageAttachments(
  imageAttachments?: CoworkImageAttachment[],
): { ok: true } | { ok: false; error: string } {
  for (const attachment of imageAttachments ?? []) {
    const validation = validateCoworkImageAttachmentSize(attachment);
    if (!validation.ok) {
      return {
        ok: false,
        error: `Image attachment ${attachment.name} exceeds the ${formatCoworkImageAttachmentLimit(validation.maxBytes)} limit.`,
      };
    }
  }
  return { ok: true };
}

/** How we chose assistant text to persist at chat.final (for tests and logs). */
export type PersistedSegmentPickReason =
  | 'both_empty'
  | 'previous_only'
  | 'final_only'
  | 'stream_authority_same_or_longer'
  | 'stream_shorter_prefer_chat_final'
  | 'chat_path_prefer_final';

/**
 * Prefer agent-stream segment text when it is authoritative (longer or equal vs chat.final).
 * When only the chat path updated the UI, prefer chat.final extraction.
 */
export function pickPersistedAssistantSegment(
  previousSegmentText: string,
  finalSegmentText: string,
  hasSeenAgentAssistantStream: boolean,
): { content: string; reason: PersistedSegmentPickReason } {
  const prev = previousSegmentText;
  const fin = finalSegmentText;
  if (!prev.trim() && !fin.trim()) {
    return { content: '', reason: 'both_empty' };
  }
  if (!prev.trim()) {
    return { content: fin, reason: 'final_only' };
  }
  if (!fin.trim()) {
    return { content: prev, reason: 'previous_only' };
  }
  if (hasSeenAgentAssistantStream) {
    if (prev.length >= fin.length) {
      return { content: prev, reason: 'stream_authority_same_or_longer' };
    }
    return { content: fin, reason: 'stream_shorter_prefer_chat_final' };
  }
  return { content: fin, reason: 'chat_path_prefer_final' };
}

type GatewayEventFrame = {
  event: string;
  seq?: number;
  payload?: unknown;
};

type GatewayClientLike = {
  start: () => void;
  stop: () => void;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean; timeoutMs?: number | null },
  ) => Promise<T>;
};

type GatewayClientCtor = new (options: Record<string, unknown>) => GatewayClientLike;

type OpenClawRuntimeAdapterOptions = {
  normalizeModelRef?: (modelRef: string) => string;
  onGatewayClientReady?: () => void;
};

const SessionModelPatchSource = {
  SessionOverride: 'sessionOverride',
  AgentModel: 'agentModel',
} as const;

type SessionModelPatchSource = typeof SessionModelPatchSource[keyof typeof SessionModelPatchSource];

type SessionModelPatchState = {
  model: string;
  confirmedAt: number;
  source: SessionModelPatchSource;
  sessionKey: string;
};

type ChannelSessionModelSyncSource =
  | 'sessions-list'
  | 'history'
  | 'session-status'
  | 'patchSession';

type ChannelSessionModelState = {
  modelRef: string | null;
  explicitOverride: boolean;
  source: ChannelSessionModelSyncSource;
};

type OpenClawSessionPatchGatewayResult = {
  entry?: unknown;
  resolved?: unknown;
};

type GatewayRpcHealth = {
  degradedUntil: number;
  consecutiveTimeouts: number;
  lastTimeoutMethod?: string;
  lastTimeoutAt?: number;
};

type OpenClawCompactionCheckpoint = {
  checkpointId?: string;
  sessionKey?: string;
  sessionId?: string;
  createdAt?: number;
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
};

type ContextCompactionDiagnosticMode = 'manual' | 'auto';

type ContextCompactionDiagnosticInput = {
  sessionId: string;
  sessionKey?: string;
  mode: ContextCompactionDiagnosticMode;
  reason?: string;
  compacted?: boolean;
};

type ContextCompactionDiagnostic = {
  sessionId: string;
  sessionKey?: string;
  mode: ContextCompactionDiagnosticMode;
  reason?: string;
  checkpointId?: string;
  checkpointCreatedAt?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  summaryChars?: number;
  hasSummary: boolean;
  compacted?: boolean;
  updatedAt: number;
};

type ChatEventState = 'delta' | 'final' | 'aborted' | 'error';

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: ChatEventState;
  message?: unknown;
  errorMessage?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
  failoverReason?: string;
  providerRuntimeFailureKind?: string;
  providerErrorType?: string;
  rawErrorPreview?: string;
  rawErrorHash?: string;
};

type AgentEventPayload = {
  seq?: number;
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: unknown;
};

type TextStreamMode = 'unknown' | 'snapshot' | 'delta';

const GatewayStopReason = {
  Error: 'error',
  ToolUse: 'toolUse',
  ToolUseSnake: 'tool_use',
} as const;

const OpenClawKnownRuntimeError = {
  UnexpectedEndOfJsonInput: 'Unexpected end of JSON input',
  OnlyEmptySseDataFrames: 'Provider stream emitted too many empty SSE data frames.',
} as const;
const OPENCLAW_GENERIC_LLM_REQUEST_FAILED = 'LLM request failed.';

const OpenClawFailureFinalText = {
  AgentFailedBeforeReply: 'Agent failed before reply:',
  SessionFileLocked: 'session file locked (timeout',
} as const;

const OpenClawHistoryRole = {
  Tool: 'tool',
  ToolResult: 'toolResult',
} as const;

type ActiveTurn = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  model: string;
  turnToken: number;
  planMode: boolean;
  /** Prevents repeated model retries when a plan response is incomplete. */
  planModeRecoveryAttempted?: boolean;
  /** Expected abort while replacing a blocked mutating tool run with a plan-only recovery. */
  planModeSafetyRecoveryPending?: boolean;
  /** Run id that must fully end before plan safety recovery can reuse the session file. */
  planModeSafetyRecoveryAbortedRunId?: string;
  /** Delayed recovery timer waiting for OpenClaw to release the aborted run's session file lock. */
  planModeSafetyRecoveryTimer?: ReturnType<typeof setTimeout>;
  /** Timestamp when this turn was created (for abort diagnostics). */
  startedAtMs: number;
  firstResponseTiming: FirstResponseTiming;
  knownRunIds: Set<string>;
  assistantMessageId: string | null;
  committedAssistantText: string;
  /** Last visible assistant segment finalized before a tool call. */
  lastCommittedAssistantMessageId?: string | null;
  currentAssistantSegmentText: string;
  currentText: string;
  /** Highest text length from agent assistant events (immune to chat delta noise). */
  agentAssistantTextLength: number;
  /**
   * Once true for the current assistant segment, chat.delta must not overwrite
   * `currentAssistantSegmentText` (even if agentAssistantTextLength is reset).
   */
  hasSeenAgentAssistantStream: boolean;
  /** Dedup debug log when chat.delta tries to overwrite an agent-owned segment. */
  chatDeltaOverwriteSkipLogged?: boolean;
  currentContentText: string;
  currentContentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  textStreamMode: TextStreamMode;
  toolUseMessageIdByToolCallId: Map<string, string>;
  toolResultMessageIdByToolCallId: Map<string, string>;
  toolResultTextByToolCallId: Map<string, string>;
  mediaStatusPollCountByToolCallId: Map<string, number>;
  mediaStatusPollCountByTaskId: Map<string, number>;
  mediaStatusPollBaseByToolCallId: Map<string, number>;
  contextMaintenanceToolCallIds: Set<string>;
  planModeSuppressedToolCallIds: Set<string>;
  stopRequested: boolean;
  /** Thinking message state — separate from main assistant message. */
  thinkingMessageId: string | null;
  currentThinkingText: string;
  /** True while async user message prefetch is in progress for channel sessions. */
  pendingUserSync: boolean;
  /** Chat events buffered while pendingUserSync is true. */
  bufferedChatPayloads: BufferedChatEvent[];
  /** Agent events buffered while pendingUserSync is true. */
  bufferedAgentPayloads: BufferedAgentEvent[];
  /** Client-side timeout watchdog timer (fallback for missing gateway abort events). */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Lifecycle-end fallback while waiting for chat.final or an OpenClaw retry path. */
  lifecycleEndFallbackTimer?: ReturnType<typeof setTimeout>;
  /** Last chat.final that represented a tool-use boundary instead of a completed turn. */
  lastToolUseChatFinalAtMs?: number;
  /** True when this run is OpenClaw's internal memory/context maintenance path. */
  hasContextMaintenanceTool?: boolean;
  /** True while OpenClaw has reported an active context compaction stream. */
  hasContextCompactionEvent?: boolean;
  /** Structured system message that marks the current compaction position in the chat. */
  contextCompactionMessageId?: string;
  /** Timestamp for the current compaction event, used in message metadata. */
  contextCompactionStartedAt?: number;
  /** True while a final may still be followed by OpenClaw compaction/retry work. */
  pendingRecoverableFollowup?: boolean;
  /** True while OpenClaw may retry the same run after an attempt-level final/end. */
  pendingOpenClawRetry?: boolean;
  /** True while a short visible final is being held open for a possible retry continuation. */
  pendingVisibleFinalContinuation?: boolean;
  /** True after a recoverable wait has accepted visible continuation text. */
  hasRecoverableContinuationText?: boolean;
  /** Most recent recoverable final timestamp, used for diagnostics and retry guards. */
  lastRecoverableFinalAtMs?: number;
  /** Most recent lifecycle=end timestamp for this turn. */
  lastAttemptEndedAtMs?: number;
  /** True when a retry reopened a run that had already passed cleanup. */
  reopenedFromClosedRun?: boolean;
  /** Tool-work signals seen in the latest chat.history sync. */
  lastHistoryHadToolWork?: boolean;
  /** Tool-result size seen in the latest chat.history sync. */
  lastHistoryToolResultCharCount?: number;
  /** True when a delayed empty-output fallback should be shown if no follow-up arrives. */
  pendingThinkingOnlyHint?: boolean;
  /**
   * Delayed completion after chat.final. OpenClaw can emit chat.final before
   * an overflow auto-compaction/retry path continues the same run.
   */
  finalCompletionTimer?: ReturnType<typeof setTimeout>;
  finalCompletionRunId?: string;
  finalCompletionFlushOnLifecycleEnd?: boolean;
  finalCompletionAllowLateContinuation?: boolean;
  allowRecentlyClosedRunRetryReopenOnCleanup?: boolean;
  suppressRecentlyClosedRunIdsOnCleanup?: boolean;
};

const PLAN_MODE_BLOCKED_TOOL_NAMES = new Set([
  'apply_patch',
  'bash',
  'cmd',
  'copy',
  'create_file',
  'delete_file',
  'edit',
  'mkdir',
  'move',
  'move_file',
  'patch',
  'powershell',
  'remove',
  'rename',
  'replace',
  'shell',
  'terminal',
  'write',
  'write_file',
]);
const PLAN_MODE_SAFE_EXEC_COMMANDS = new Set([
  'cat',
  'dir',
  'dirname',
  'du',
  'echo',
  'file',
  'find',
  'findstr',
  'gc',
  'gci',
  'get-childitem',
  'get-content',
  'get-location',
  'grep',
  'head',
  'ls',
  'printf',
  'pwd',
  'realpath',
  'rg',
  'sed',
  'select-string',
  'select-object',
  'sort',
  'stat',
  'tail',
  'tree',
  'type',
  'uniq',
  'where',
  'which',
  'wc',
]);
const PLAN_MODE_SAFE_GIT_COMMANDS = new Set([
  'diff',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
]);
const ASSISTANT_STREAM_RESET_MIN_DROP_CHARS = 40;
const ASSISTANT_STREAM_RESET_RATIO = 0.7;

function isPlanModeSystemPrompt(systemPrompt: string): boolean {
  return containsPlanModePrompt(systemPrompt)
    && !systemPrompt.includes(PLAN_MODE_EXECUTION_OVERRIDE_MARKER);
}

function sessionHasProposedPlan(messages: CoworkMessage[]): boolean {
  return messages.some((message) => (
    message.type === 'assistant'
    && /<proposed_plan\b[^>]*>[\s\S]*<\/proposed_plan\s*>/i.test(message.content)
  ));
}

function buildPlanModeExecutionOverridePrompt(): string {
  return [
    PLAN_MODE_EXECUTION_OVERRIDE_MARKER,
    '',
    'The user explicitly approved the existing proposed plan and asked you to implement it.',
    'For this turn, Plan Mode is disabled. Ignore earlier Plan Mode restrictions and do not output another proposed plan.',
    'Implement the approved plan now, including file changes and validation requested by the plan.',
  ].join('\n');
}

function getStringArg(args: unknown, key: string): string {
  if (!isRecord(args)) return '';
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getPlanModeExecCommand(args: unknown): string {
  return getStringArg(args, 'command') || getStringArg(args, 'cmd');
}

function getShellCommandName(command: string): string {
  const [firstToken = ''] = command.trim().split(/\s+/, 1);
  return firstToken.replace(/^["']|["']$/g, '').toLowerCase();
}

function getGitSubcommand(command: string): string {
  const [, subcommand = ''] = command.trim().split(/\s+/, 2);
  return subcommand.toLowerCase();
}

function splitPlanModeShellCommands(command: string): string[] | null {
  const commands: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const pushCurrent = (): boolean => {
    const segment = current.trim();
    current = '';
    if (!segment) return false;
    commands.push(segment);
    return true;
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '`' || (character === '$' && command[index + 1] === '(')) {
      return null;
    }
    if (character === '&' && command[index + 1] !== '&') {
      return null;
    }
    if (character === ';' || character === '|' || character === '\n' || character === '\r' || character === '&') {
      if (!pushCurrent()) return null;
      if ((character === '|' || character === '&') && command[index + 1] === character) {
        index++;
      }
      continue;
    }
    current += character;
  }

  if (quote || escaped || !pushCurrent()) return null;
  return commands;
}

function stripPlanModeNullRedirections(command: string): string | null {
  let normalized = command;
  const nullRedirectionPattern = /(?:^|\s)\d*>\s*(?:\/dev\/null|nul|\$null)(?=\s|$)/gi;
  normalized = normalized.replace(nullRedirectionPattern, ' ');
  if (/[<>]/.test(normalized)) return null;
  return normalized.trim();
}

function isPlanModeSafeSedCommand(command: string): boolean {
  return !/(?:^|\s)(?:-i(?:\S*)?|--in-place(?:=\S*)?)(?:\s|$)/i.test(command)
    && !/(?:^|[;'"\s])(?:w|e)(?:\s|$)/i.test(command);
}

function isPlanModeSafeShellSegment(command: string): boolean {
  const normalized = stripPlanModeNullRedirections(command);
  if (!normalized) return false;
  if (/(?:^|\s)-(?:delete|exec|execdir|ok|fprint|fprint0|fprintf|fls)(?:\s|$)/i.test(normalized)) {
    return false;
  }

  const commandName = getShellCommandName(normalized);
  if (commandName === 'git') {
    if (/(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/i.test(normalized)) return false;
    return PLAN_MODE_SAFE_GIT_COMMANDS.has(getGitSubcommand(normalized));
  }
  if (commandName === 'sed' && !isPlanModeSafeSedCommand(normalized)) return false;
  if (
    commandName === 'sort'
    && /(?:^|\s)(?:--output(?:=|\s)|-o(?:\S+|\s)|\/o(?::|\s))/i.test(normalized)
  ) return false;
  if (
    commandName === 'tree'
    && /(?:^|\s)(?:--output(?:=|\s)|-o(?:\S+|\s))/i.test(normalized)
  ) return false;
  return PLAN_MODE_SAFE_EXEC_COMMANDS.has(commandName);
}

export function isPlanModeSafeExecCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const commands = splitPlanModeShellCommands(trimmed);
  return Boolean(commands?.length && commands.every(isPlanModeSafeShellSegment));
}

function getPlanModeBlockedToolReason(toolNameRaw: string, args: unknown): string | null {
  const toolName = toolNameRaw.trim().toLowerCase();
  if (PLAN_MODE_BLOCKED_TOOL_NAMES.has(toolName)) {
    return `blocked mutating tool ${toolNameRaw || 'Tool'}`;
  }

  if (toolName === 'exec') {
    const command = getPlanModeExecCommand(args);
    if (isPlanModeSafeExecCommand(command)) return null;
    return 'blocked shell command in plan mode';
  }

  return null;
}

function shouldSuppressPlanModeToolEvent(toolNameRaw: string, args: unknown): boolean {
  const toolName = toolNameRaw.trim().toLowerCase();
  if (toolName === 'read') return true;
  if (toolName === 'exec') {
    return isPlanModeSafeExecCommand(getPlanModeExecCommand(args));
  }
  return false;
}

export function ensurePlanModeProposedPlanBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || /<proposed_plan\b[^>]*>[\s\S]*<\/proposed_plan\s*>/i.test(trimmed)) return text;
  if (/<proposed_plan\b[^>]*>/i.test(trimmed)) {
    return `${trimmed}\n</proposed_plan>`;
  }
  return `<proposed_plan>\n${trimmed}\n</proposed_plan>`;
}

export function isPlanModeResponseComplete(text: string): boolean {
  const content = text
    .replace(/<proposed_plan\b[^>]*>/gi, '')
    .replace(/<\/proposed_plan\s*>/gi, '')
    .trim();
  if (content.length < 220) return false;

  const structuralLineCount = content
    .split('\n')
    .filter((line) => /^\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+)/.test(line))
    .length;
  const sectionPatterns = [
    /(?:summary|overview|概述|概览|摘要|总览|目标)/i,
    /(?:implementation approach|implementation|architecture|实施|实现|技术|架构)/i,
    /(?:key changes|changes|改动|变更|页面|功能|交互)/i,
    /(?:validation|verification|验证|测试|验收|检查)/i,
    /(?:assumptions? or questions?|assumptions?|假设|前提|待确认|问题|风险)/i,
  ];
  const sectionCount = sectionPatterns.filter((pattern) => pattern.test(content)).length;
  return structuralLineCount >= 8 || (structuralLineCount >= 5 && sectionCount >= 3);
}

function isOpenClawFailureFinalText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes(OpenClawFailureFinalText.AgentFailedBeforeReply)
    || trimmed.includes(OpenClawFailureFinalText.SessionFileLocked);
}

export function isSignificantAssistantStreamReset(previousLength: number, nextLength: number): boolean {
  if (previousLength <= 5 || nextLength >= previousLength) return false;
  const drop = previousLength - nextLength;
  return drop >= ASSISTANT_STREAM_RESET_MIN_DROP_CHARS
    && nextLength <= previousLength * ASSISTANT_STREAM_RESET_RATIO;
}

function buildPlanModeOutboundReminder(): string {
  return [
    '[Plan Mode reminder]',
    'Plan Mode is active for this turn.',
    'Only use read-only exploration when needed; do not implement, create, modify, write, edit, or run shell commands that can change files or system state.',
    'Write the plan in the same language as the user request.',
    'Return one complete proposed plan wrapped in <proposed_plan> and </proposed_plan> tags.',
    'Do not stop after a preface; include Summary, Implementation Approach, Key Changes, Validation, and Assumptions or Questions.',
  ].join('\n');
}

type FirstResponseTiming = {
  turnStartedAtMs: number;
  gatewayReadyStartedAtMs?: number;
  gatewayReadyEndedAtMs?: number;
  modelPatchStartedAtMs?: number;
  modelPatchEndedAtMs?: number;
  promptBuildStartedAtMs?: number;
  promptBuildEndedAtMs?: number;
  chatHistoryStartedAtMs?: number;
  chatHistoryEndedAtMs?: number;
  chatSendStartedAtMs?: number;
  chatSendAckAtMs?: number;
  lifecycleStartedAtMs?: number;
  firstVisibleAssistantAtMs?: number;
  firstVisibleAssistantSource?: 'agent' | 'chat';
};

type RecentlyClosedRunInfo = {
  expiresAt: number;
  closedAt: number;
  sessionId?: string;
  sessionKey?: string;
  allowRetryReopen?: boolean;
};

type BufferedChatEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

type BufferedAgentEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

type ChannelHistorySyncEntry = {
  role: 'user' | 'assistant';
  text: string;
  metadata?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const MODEL_SNAPSHOT_CUSTOM_TYPE = 'model-snapshot';
const SESSION_STATUS_TOOL_NAME = 'session_status';

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const readNonEmptyString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const buildModelRef = (provider: string | null | undefined, model: string | null | undefined): string | null => {
  const normalizedModel = model?.trim();
  if (!normalizedModel) return null;
  const normalizedProvider = provider?.trim();
  if (!normalizedProvider || normalizedModel.includes('/')) return normalizedModel;
  return `${normalizedProvider}/${normalizedModel}`;
};

const readModelRefFromRecord = (
  record: Record<string, unknown>,
  options: { modelKeys: readonly string[]; providerKeys?: readonly string[] },
): string | null => {
  const model = options.modelKeys
    .map((key) => readNonEmptyString(record, key))
    .find((value): value is string => Boolean(value));
  if (!model) return null;
  const provider = (options.providerKeys ?? [])
    .map((key) => readNonEmptyString(record, key))
    .find((value): value is string => Boolean(value));
  return buildModelRef(provider, model);
};

const readExplicitModelOverrideState = (
  record: Record<string, unknown>,
  source: ChannelSessionModelSyncSource,
): ChannelSessionModelState | null => {
  if (!hasOwn(record, 'modelOverride')) return null;
  const value = record.modelOverride;
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return { modelRef: null, explicitOverride: true, source };
  }
  if (typeof value !== 'string') return null;
  const provider = readNonEmptyString(record, 'providerOverride')
    ?? readNonEmptyString(record, 'modelProvider')
    ?? readNonEmptyString(record, 'provider')
    ?? readNonEmptyString(record, 'providerId');
  return {
    modelRef: buildModelRef(provider, value),
    explicitOverride: true,
    source,
  };
};

const extractChannelSessionModelStateFromRow = (row: Record<string, unknown>): ChannelSessionModelState | null => {
  const explicit = readExplicitModelOverrideState(row, 'sessions-list');
  if (explicit) return explicit;
  const effectiveModelRef = readModelRefFromRecord(row, {
    providerKeys: ['modelProvider', 'provider', 'providerId'],
    modelKeys: ['model', 'modelId'],
  });
  return effectiveModelRef
    ? { modelRef: effectiveModelRef, explicitOverride: false, source: 'sessions-list' }
    : null;
};

const unwrapGatewayHistoryMessageRecord = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  return isRecord(value.message) ? value.message : value;
};

const extractModelSnapshotState = (value: unknown): ChannelSessionModelState | null => {
  if (!isRecord(value) || value.type !== 'custom' || value.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) {
    return null;
  }
  const data = isRecord(value.data) ? value.data : null;
  if (!data) return null;
  const modelRef = readModelRefFromRecord(data, {
    providerKeys: ['provider', 'modelProvider', 'providerId'],
    modelKeys: ['modelId', 'model'],
  });
  return modelRef
    ? { modelRef, explicitOverride: false, source: 'history' }
    : null;
};

const extractSessionStatusModelState = (value: unknown): ChannelSessionModelState | null => {
  const message = unwrapGatewayHistoryMessageRecord(value);
  if (!message) return null;
  const role = typeof message.role === 'string' ? message.role.trim() : '';
  const toolName = typeof message.toolName === 'string' ? message.toolName.trim() : '';
  if (role !== 'toolResult' || toolName !== SESSION_STATUS_TOOL_NAME) return null;

  let details: Record<string, unknown> | null = null;
  if (isRecord(message.details)) {
    details = message.details;
  } else if (isRecord(value) && isRecord(value.details)) {
    details = value.details;
  }
  if (!details) return null;

  const explicit = readExplicitModelOverrideState(details, 'session-status');
  if (explicit) return explicit;
  if (details.changedModel !== true) return null;
  const modelRef = readModelRefFromRecord(details, {
    providerKeys: ['modelProvider', 'provider', 'providerId'],
    modelKeys: ['model', 'modelId'],
  });
  return modelRef
    ? { modelRef, explicitOverride: true, source: 'session-status' }
    : null;
};

const extractChannelSessionModelStateFromHistory = (messages: unknown[]): ChannelSessionModelState | null => {
  let latest: ChannelSessionModelState | null = null;
  for (const message of messages) {
    const sessionStatus = extractSessionStatusModelState(message);
    if (sessionStatus) {
      latest = sessionStatus;
      continue;
    }
    const snapshot = extractModelSnapshotState(message);
    if (snapshot) {
      latest = snapshot;
    }
  }
  return latest;
};

const extractModelOverrideFromPatchResult = (
  response: unknown,
  fallbackModel: string | null | undefined,
): string | null | undefined => {
  if (isRecord(response)) {
    const entry = isRecord(response.entry) ? response.entry : null;
    if (entry) {
      const explicit = readExplicitModelOverrideState(entry, 'patchSession');
      if (explicit) return explicit.modelRef;
    }
    const resolved = isRecord(response.resolved) ? response.resolved : null;
    if (resolved) {
      const resolvedModelRef = readModelRefFromRecord(resolved, {
        providerKeys: ['modelProvider', 'provider', 'providerId'],
        modelKeys: ['model', 'modelId'],
      });
      if (resolvedModelRef) return resolvedModelRef;
    }
  }
  if (fallbackModel === null || fallbackModel === undefined) return fallbackModel;
  return fallbackModel.trim() || null;
};

export const resolveToolEventIsError = (data: unknown): boolean => {
  if (!isRecord(data)) return false;
  if (data.isError) return true;
  return isRecord(data.result) && data.result.isError === true;
};

const extractAgentNameFromSessionKey = (sessionKey: string | undefined | null): string | undefined => {
  const parsed = parseManagedSessionKey(sessionKey);
  if (parsed?.agentId) return parsed.agentId;
  if (sessionKey && !parsed) return 'main';
  return undefined;
};

const isSameChannelHistoryEntry = (
  left: ChannelHistorySyncEntry,
  right: ChannelHistorySyncEntry,
): boolean => {
  return left.role === right.role && left.text === right.text;
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
};

const normalizeAgentLifecyclePhase = (value: unknown): AgentLifecyclePhaseValue | '' => {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  const phases = Object.values(AgentLifecyclePhase) as string[];
  return phases.includes(normalized) ? normalized as AgentLifecyclePhaseValue : '';
};

const getAgentLifecyclePhase = (data: unknown): AgentLifecyclePhaseValue | '' => {
  if (!isRecord(data)) return '';
  return normalizeAgentLifecyclePhase(data.phase);
};

/** Strip Discord mention markup: <@userId>, <@!userId>, <#channelId>, <@&roleId>, and rendered @Username mentions */
const stripDiscordMentions = (text: string): string =>
  text
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .replace(/^(?:@\S+\s*)+/, '')  // strip leading rendered @mentions (e.g. "@OctoBot ")
    .trim();

/**
 * Strip the Feishu plugin's system header line from user messages.
 *
 * The Feishu (Lark) plugin prepends a one-line header before the user's actual
 * text:
 *   System: [2026-04-09 15:55:28 GMT+8] Feishu[755f282a] DM | user [msg:id]
 *
 * After OpenClaw's inbound metadata stripping (which removes the "Conversation
 * info" and "Sender" JSON blocks), the header line may be the only remaining
 * prefix.  Strip it so only the real user text is stored locally.
 */
const stripFeishuSystemHeader = (text: string): string => {
  // Match: "System: [timestamp] Feishu[accountId] ..." as the first line.
  const match = text.match(/^System:\s*\[.*?\]\s+Feishu\[.*$/m);
  if (!match) return text;
  return text.slice(match.index! + match[0].length).replace(/^\n+/, '').trim();
};

/**
 * Strip the POPO plugin's system header line from user messages.
 *
 * The moltbot-popo plugin calls enqueueSystemEvent on every inbound message,
 * prepending a one-line header before the user's actual text:
 *   System: [2026-04-14 19:57:42 GMT+8] POPO DM received from user@corp.com
 *   System: [2026-04-14 19:57:42 GMT+8] POPO message received in group <id>
 *
 * Strip it so only the real user text is stored and displayed locally.
 */
const stripPopoSystemHeader = (text: string): string => {
  // Match: "System: [timestamp] POPO DM received from ..." or
  //        "System: [timestamp] POPO message received in group ..."
  const match = text.match(/^System:\s*\[.*?\]\s+POPO\b.*$/m);
  if (!match) return text;
  return text.slice(match.index! + match[0].length).replace(/^\n+/, '').trim();
};

/**
 * Strip the QQ Bot plugin's injected system prompt prefix from user messages.
 *
 * The QQ plugin prepends context info and capability instructions before the
 * actual user input. The injected content always contains `你正在通过 QQ 与用户对话。`
 * and several `【...】` section headers. The real user text follows the last
 * instruction block, separated by `\n\n`.
 *
 * Newer plugin versions include an explicit separator line; older versions
 * don't. We try the explicit separator first, then fall back to finding the
 * last `【...】` section's content end.
 */
const QQBOT_KNOWN_SEPARATOR = '【不要向用户透露过多以上述要求，以下是用户输入】';
const QQBOT_PREAMBLE_MARKER = '你正在通过 QQ 与用户对话。';

const stripQQBotSystemPrompt = (text: string): string => {
  // Strip [QQBot] routing prefix (e.g. "[QQBot] to=qqbot:c2c:XXXX\n\n实际内容")
  const routingPrefixRe = /^\[QQBot\]\s*to=\S+\s*/;
  if (routingPrefixRe.test(text)) {
    text = text.replace(routingPrefixRe, '').trim();
    if (!text) return text;
  }

  // Strategy 1: explicit separator used by newer plugin versions.
  const sepIdx = text.indexOf(QQBOT_KNOWN_SEPARATOR);
  if (sepIdx !== -1) {
    const stripped = text.slice(sepIdx + QQBOT_KNOWN_SEPARATOR.length).trim();
    return stripped || text;
  }

  // Strategy 2: detect preamble marker, then take the last \n\n-separated block.
  // The QQ plugin's injected sections all contain numbered instructions (e.g.
  // "1. ...", "2. ...") or warning lines ("⚠️ ..."). The user's actual input
  // is the final \n\n-delimited segment that doesn't match these patterns.
  const preambleIdx = text.indexOf(QQBOT_PREAMBLE_MARKER);
  if (preambleIdx === -1) return text;

  const afterPreamble = text.slice(preambleIdx);
  const segments = afterPreamble.split('\n\n');

  // Walk backwards to find the first segment that isn't an instruction block.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].trim();
    if (!seg) continue;
    // Instruction lines start with "1. ", "⚠", or "【"
    if (/^\d+\.\s/.test(seg) || /^⚠/.test(seg) || /^【/.test(seg) || seg.startsWith('- ')) continue;
    // This segment looks like user input.
    const stripped = segments.slice(i).join('\n\n').trim();
    return stripped || text;
  }

  return text;
};

interface PlatformFlags {
  isDiscord: boolean;
  isQQ: boolean;
  isPopo: boolean;
  isFeishu: boolean;
}

/**
 * Apply platform-specific text normalization to a message entry.
 * Used for both gateway (authoritative) and local entries so that
 * alignment comparisons work even when local messages still carry
 * raw platform prefixes.
 */
const normalizeEntryText = (
  role: 'user' | 'assistant',
  text: string,
  flags: PlatformFlags,
): string => {
  let result = text.trim();
  if (!result) return result;
  if (flags.isDiscord) result = stripDiscordMentions(result);
  if (flags.isQQ && role === 'user') result = stripQQBotSystemPrompt(result);
  if (flags.isPopo && role === 'user') result = stripPopoSystemHeader(result);
  if (flags.isFeishu && role === 'user') result = stripFeishuSystemHeader(result);
  return result;
};

const extractMessageText = extractGatewayMessageText;

const summarizeGatewayMessageShape = (message: unknown): string => {
  if (!isRecord(message)) {
    return `non-record:${typeof message}`;
  }

  const role = typeof message.role === 'string' ? message.role : '?';
  const content = message.content;
  if (typeof content === 'string') {
    return `role=${role} content=string(${content.length}) text="${truncate(content, 120)}"`;
  }
  if (Array.isArray(content)) {
    const parts = content.map((item) => {
      if (!isRecord(item)) return typeof item;
      const type = typeof item.type === 'string' ? item.type : 'object';
      const text = typeof item.text === 'string' ? `:${truncate(item.text, 60)}` : '';
      return `${type}${text}`;
    });
    return `role=${role} content=[${parts.join(', ')}]`;
  }
  if (isRecord(content)) {
    return `role=${role} contentKeys=${Object.keys(content).join(',')}`;
  }
  if (typeof message.text === 'string') {
    return `role=${role} text=${truncate(message.text, 120)}`;
  }
  return `role=${role} keys=${Object.keys(message).join(',')}`;
};

const messageHasToolCallBlock = (message: unknown): boolean => {
  if (!isRecord(message)) return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type === 'toolCall');
};

const isToolUseStopReason = (stopReason: string | undefined): boolean => {
  return stopReason === GatewayStopReason.ToolUse || stopReason === GatewayStopReason.ToolUseSnake;
};

export function normalizeOpenClawRuntimeErrorMessage(errorMessage: string): string {
  const normalized = errorMessage.trim();
  switch (normalized) {
    case OpenClawKnownRuntimeError.UnexpectedEndOfJsonInput:
      return t('coworkErrorModelStreamEmptySseData');
    case OpenClawKnownRuntimeError.OnlyEmptySseDataFrames:
      return t('coworkErrorModelStreamOnlyEmptySseData');
    default:
      return errorMessage;
  }
}

function isOpenClawGenericLlmRequestFailed(errorMessage: string): boolean {
  return errorMessage.trim() === OPENCLAW_GENERIC_LLM_REQUEST_FAILED;
}

export type OpenClawSafeRuntimeErrorMetadata = {
  error?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  failoverReason?: string;
  providerRuntimeFailureKind?: string;
  providerErrorType?: string;
  rawErrorPreview?: string;
  rawErrorHash?: string;
};

const COWORK_ERROR_KEY_BY_OPENCLAW_FAILOVER_REASON: Record<string, string> = {
  auth: CoworkErrorI18nKey.AuthInvalid,
  billing: CoworkErrorI18nKey.InsufficientBalance,
  rate_limit: CoworkErrorI18nKey.RateLimit,
  overloaded: CoworkErrorI18nKey.RateLimit,
  timeout: CoworkErrorI18nKey.NetworkError,
  server_error: CoworkErrorI18nKey.ServerError,
};

const COWORK_ERROR_KEY_BY_OPENCLAW_RUNTIME_FAILURE_KIND: Record<string, string> = {
  auth_scope: CoworkErrorI18nKey.ModelAccessDenied,
  auth_refresh: CoworkErrorI18nKey.OAuthInvalid,
  refresh_timeout: CoworkErrorI18nKey.OAuthInvalid,
  refresh_contention: CoworkErrorI18nKey.OAuthInvalid,
  callback_timeout: CoworkErrorI18nKey.OAuthInvalid,
  callback_validation: CoworkErrorI18nKey.OAuthInvalid,
  auth_html: CoworkErrorI18nKey.OAuthInvalid,
  auth_invalid_token: CoworkErrorI18nKey.OAuthInvalid,
  rate_limit: CoworkErrorI18nKey.RateLimit,
  dns: CoworkErrorI18nKey.NetworkError,
  timeout: CoworkErrorI18nKey.NetworkError,
  upstream_html: CoworkErrorI18nKey.ServerError,
  proxy: CoworkErrorI18nKey.NetworkError,
  empty_response: CoworkErrorI18nKey.ServerError,
};

const pickStringField = (
  record: Record<string, unknown>,
  key: keyof OpenClawSafeRuntimeErrorMetadata,
): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

function normalizeOpenClawSafeRuntimeErrorMetadata(
  metadata: unknown,
): OpenClawSafeRuntimeErrorMetadata | undefined {
  if (!isRecord(metadata)) return undefined;
  const normalized: OpenClawSafeRuntimeErrorMetadata = {};
  for (const key of [
    'error',
    'errorMessage',
    'provider',
    'model',
    'failoverReason',
    'providerRuntimeFailureKind',
    'providerErrorType',
    'rawErrorPreview',
    'rawErrorHash',
  ] as const) {
    const value = pickStringField(metadata, key);
    if (value) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function classifyOpenClawSafeRuntimeErrorMetadata(
  metadata: OpenClawSafeRuntimeErrorMetadata | undefined,
): string | null {
  if (!metadata) return null;

  const failureKind = metadata.providerRuntimeFailureKind?.trim();
  if (failureKind && COWORK_ERROR_KEY_BY_OPENCLAW_RUNTIME_FAILURE_KIND[failureKind]) {
    return COWORK_ERROR_KEY_BY_OPENCLAW_RUNTIME_FAILURE_KIND[failureKind];
  }

  const failoverReason = metadata.failoverReason?.trim();
  if (failoverReason && COWORK_ERROR_KEY_BY_OPENCLAW_FAILOVER_REASON[failoverReason]) {
    return COWORK_ERROR_KEY_BY_OPENCLAW_FAILOVER_REASON[failoverReason];
  }

  for (const candidate of [
    metadata.rawErrorPreview,
    metadata.errorMessage,
    metadata.error,
    metadata.providerErrorType,
  ]) {
    if (!candidate) continue;
    const classifiedKey = classifyErrorKey(candidate);
    if (classifiedKey) return classifiedKey;
  }

  return null;
}

export function resolveOpenClawRuntimeErrorMessage(
  errorMessage: string,
  metadata?: OpenClawSafeRuntimeErrorMetadata,
): string {
  const normalized = normalizeOpenClawRuntimeErrorMessage(errorMessage);
  const classifiedKey = classifyErrorKey(normalized);

  if (classifiedKey) {
    if (classifiedKey === CoworkErrorI18nKey.QuotaExhausted) {
      consumeRecentOpenClawTokenProxyQuotaError();
    }
    return t(classifiedKey);
  }

  if (isOpenClawGenericLlmRequestFailed(normalized)) {
    const metadataClassifiedKey = classifyOpenClawSafeRuntimeErrorMetadata(metadata);
    if (metadataClassifiedKey) {
      consumeRecentOpenClawTokenProxyQuotaError();
      return t(metadataClassifiedKey);
    }
    const recentQuotaError = consumeRecentOpenClawTokenProxyQuotaError();
    if (recentQuotaError) {
      return t(CoworkErrorI18nKey.QuotaExhausted);
    }
  }

  return normalized;
}

const extractTextBlocksAndSignals = (
  message: unknown,
): { textBlocks: string[]; thinkingText: string; sawNonTextContentBlocks: boolean } => {
  if (!isRecord(message)) {
    return {
      textBlocks: [],
      thinkingText: '',
      sawNonTextContentBlocks: false,
    };
  }

  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return {
      textBlocks: text ? [text] : [],
      thinkingText: '',
      sawNonTextContentBlocks: false,
    };
  }
  if (!Array.isArray(content)) {
    return {
      textBlocks: [],
      thinkingText: '',
      sawNonTextContentBlocks: false,
    };
  }

  const textBlocks: string[] = [];
  const thinkingParts: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const thinkingText = block.thinking.trim();
      if (thinkingText) {
        thinkingParts.push(thinkingText);
      }
      continue;
    }
    if (typeof block.type === 'string') {
      sawNonTextContentBlocks = true;
    }
  }

  return {
    textBlocks,
    thinkingText: thinkingParts.join('\n\n'),
    sawNonTextContentBlocks,
  };
};

/**
 * Extract file paths from assistant "message" tool calls in chat.history.
 * Only scans messages after the last user message (current turn).
 * The model sends files to Telegram using: toolCall { name: "message", arguments: { action: "send", filePath: "..." } }
 */
const extractSentFilePathsFromHistory = (messages: unknown[]): string[] => {
  // Find the last user message index to scope to current turn only
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const filePaths: string[] = [];
  const seen = new Set<string>();
  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!isRecord(block)) continue;
      if (block.type !== 'toolCall' || block.name !== 'message') continue;
      const args = block.arguments;
      if (!isRecord(args)) continue;
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        filePaths.push(filePath);
      }
    }
  }
  return filePaths;
};

/**
 * Extract and concatenate all assistant text from the current turn in chat.history.
 * The current turn starts after the last user message.
 */
const extractCurrentTurnAssistantText = (messages: unknown[]): string => {
  // Find the last user message index (turn boundary)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const textParts: string[] = [];
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    let text = extractMessageText(msg).trim();
    text = stripTrailingSilentReplyToken(text);
    if (text && !shouldSuppressHeartbeatText('assistant', text)) {
      textParts.push(text);
    }
  }
  return textParts.join('\n\n');
};

/**
 * Extract the text of the LAST assistant message in the current turn from chat.history.
 * Unlike extractCurrentTurnAssistantText (which concatenates ALL assistant segments),
 * this returns only the final segment — suitable for replacing the last assistant message
 * in managed sessions without relying on committedAssistantText for prefix slicing.
 */
const extractLastAssistantSegmentInTurn = (messages: unknown[]): string => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  let lastAssistantText = '';
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    let text = extractMessageText(msg).trim();
    text = stripTrailingSilentReplyToken(text);
    if (text && !shouldSuppressHeartbeatText('assistant', text)) {
      lastAssistantText = text;
    }
  }
  return lastAssistantText;
};

const inspectCurrentTurnToolWork = (
  messages: unknown[],
): { hasToolWork: boolean; toolResultChars: number } => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && msg.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  let hasToolWork = false;
  let toolResultChars = 0;
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim() : '';
    if (role === OpenClawHistoryRole.Tool || role === OpenClawHistoryRole.ToolResult) {
      hasToolWork = true;
      toolResultChars += extractMessageText(msg).length;
      continue;
    }
    if (role !== 'assistant' || !Array.isArray(msg.content)) continue;
    if ((msg.content as unknown[]).some((block) => isRecord(block) && block.type === 'toolCall')) {
      hasToolWork = true;
    }
  }

  return { hasToolWork, toolResultChars };
};

const isDroppedBoundaryTextBlockSubset = (streamedTextBlocks: string[], finalTextBlocks: string[]): boolean => {
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }
  if (finalTextBlocks.every((block, index) => streamedTextBlocks[index] === block)) {
    return true;
  }
  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
};

const extractToolText = (payload: unknown): string => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    const lines = payload
      .map((item) => extractToolText(item).trim())
      .filter(Boolean);
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  if (!isRecord(payload)) {
    if (payload === undefined || payload === null) return '';
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text;
  }
  if (typeof payload.output === 'string' && payload.output.trim()) {
    return payload.output;
  }
  if (typeof payload.stdout === 'string' || typeof payload.stderr === 'string') {
    const chunks = [
      typeof payload.stdout === 'string' ? payload.stdout : '',
      typeof payload.stderr === 'string' ? payload.stderr : '',
    ].filter(Boolean);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  const content = payload.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (typeof item === 'string' && item.trim()) {
        chunks.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (typeof item.text === 'string' && item.text.trim()) {
        chunks.push(item.text);
        continue;
      }
      if (typeof item.content === 'string' && item.content.trim()) {
        chunks.push(item.content);
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const isContextMaintenanceToolEvent = (data: Record<string, unknown>): boolean => {
  const toolName = typeof data.name === 'string' ? data.name.trim().toLowerCase() : '';
  if (toolName !== 'read' && toolName !== 'write') {
    return false;
  }
  const args = isRecord(data.args) ? data.args : null;
  const toolPath = typeof args?.path === 'string' ? args.path : '';
  return /(?:^|\/)memory\/\d{4}-\d{2}-\d{2}\.md$/.test(toolPath);
};

const messageHasContextMaintenanceToolCall = (message: unknown): boolean => {
  if (!isRecord(message) || !Array.isArray(message.content)) return false;
  return message.content.some((block) => (
    isRecord(block)
    && block.type === 'toolCall'
    && isContextMaintenanceToolEvent({
      name: block.name,
      args: isRecord(block.arguments) ? block.arguments : undefined,
    })
  ));
};

const historyTailLooksLikeContextMaintenance = (historyMessages: unknown[]): boolean => {
  let sawMaintenanceAssistant = false;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const message = historyMessages[i];
    if (!isRecord(message)) continue;
    const role = typeof message.role === 'string' ? message.role : '';
    if (role === 'assistant') {
      const text = extractGatewayMessageText(message).trim();
      sawMaintenanceAssistant = sawMaintenanceAssistant
        || messageHasContextMaintenanceToolCall(message)
        || isSilentReplyText(text);
      continue;
    }
    if (role === 'toolResult') {
      continue;
    }
    if (role === 'user') {
      return sawMaintenanceAssistant && isPreCompactionMemoryFlushPromptText(extractGatewayMessageText(message));
    }
    if (role === 'system') {
      continue;
    }
    return false;
  }
  return false;
};

const extractToolDetails = (payload: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(payload)) return undefined;
  return isRecord(payload.details) ? payload.details : undefined;
};

const readMediaPollCount = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
);

const getMediaStatusToolArgs = (
  toolName: string,
  args: unknown,
): { taskId: string; mediaType: 'image' | 'video' } | null => {
  if (toolName !== MediaGenerationTool.Image && toolName !== MediaGenerationTool.Video) {
    return null;
  }
  if (!isRecord(args) || args.action !== MediaGenerationToolAction.Status) {
    return null;
  }
  const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  if (!taskId) return null;
  return {
    taskId,
    mediaType: toolName === MediaGenerationTool.Video ? 'video' : 'image',
  };
};

const extractMediaStatusFromText = (text: string): string | undefined => {
  const match = text.match(/^Status:\s*(\S+)/m);
  return match?.[1];
};

const extractMediaTaskIdFromText = (text: string): string | undefined => {
  const match = text.match(/^Task ID:\s*(\S+)/m);
  return match?.[1];
};

const resolveMediaStatusToolDetails = (
  turn: ActiveTurn,
  toolCallId: string,
  toolName: string,
  args: unknown,
  payload: unknown,
  phase: 'update' | 'result',
  text: string,
): Record<string, unknown> | undefined => {
  const details = extractToolDetails(payload);
  const mediaArgs = getMediaStatusToolArgs(toolName, args);
  if (!mediaArgs) return details;

  const existingPollCount = turn.mediaStatusPollCountByToolCallId.get(toolCallId) ?? 0;
  const existingTaskPollCount = turn.mediaStatusPollCountByTaskId.get(mediaArgs.taskId) ?? 0;
  const detailPollCount = readMediaPollCount(details?.pollCount);
  let basePollCount = turn.mediaStatusPollBaseByToolCallId.get(toolCallId);
  if (basePollCount == null) {
    basePollCount = detailPollCount != null && detailPollCount > existingTaskPollCount
      ? 0
      : existingTaskPollCount;
    turn.mediaStatusPollBaseByToolCallId.set(toolCallId, basePollCount);
  }
  const nextPollCount = phase === 'update'
    ? (detailPollCount != null
      ? basePollCount + detailPollCount
      : Math.max(existingPollCount, existingTaskPollCount) + 1)
    : (detailPollCount != null
      ? basePollCount + detailPollCount
      : (Math.max(existingPollCount, existingTaskPollCount) || undefined));

  let resolvedPollCount = nextPollCount;
  if (nextPollCount != null) {
    const mergedPollCount = Math.max(existingPollCount, existingTaskPollCount, nextPollCount);
    resolvedPollCount = mergedPollCount;
    turn.mediaStatusPollCountByToolCallId.set(
      toolCallId,
      mergedPollCount,
    );
    turn.mediaStatusPollCountByTaskId.set(mediaArgs.taskId, mergedPollCount);
  }

  const status = typeof details?.status === 'string'
    ? details.status
    : extractMediaStatusFromText(text);
  const textTaskId = extractMediaTaskIdFromText(text);
  const upstreamTaskId = typeof details?.upstreamTaskId === 'string'
    ? details.upstreamTaskId
    : textTaskId;
  const nextDetails = {
    ...(details ?? {}),
  };
  delete nextDetails.pollCount;

  return {
    ...nextDetails,
    taskId: typeof details?.taskId === 'string' ? details.taskId : mediaArgs.taskId,
    ...(upstreamTaskId ? { upstreamTaskId } : {}),
    ...(status ? { status } : {}),
    ...(resolvedPollCount != null && resolvedPollCount > 1 ? { pollCount: resolvedPollCount } : {}),
    isMediaStatusPolling: true,
    mediaType: mediaArgs.mediaType,
  };
};

const toToolInputRecord = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { value };
};

const buildMediaGenerationTurnInstruction = (selection?: CoworkMediaSelection, hasMediaSkillActive?: boolean): string => {
  if (!selection || selection.mode === 'none') {
    if (hasMediaSkillActive) {
      return [
        '[LobsterAI media generation tools — NOT AVAILABLE]',
        'The lobsterai_image_generate and lobsterai_video_generate tools are NOT available for this turn.',
        'Do NOT call lobsterai_image_generate or lobsterai_video_generate.',
        'However, a media generation skill (e.g. seedream, seedance) is provided in the system prompt. You may use it to fulfill image or video generation requests.',
      ].join('\n');
    }
    return '';
  }

  const lines = [
    '[LobsterAI media generation turn instruction]',
    'The user selected a LobsterAI media generation model for this turn.',
    'IMPORTANT: Do NOT read or use the "seedance" or "seedream" skills for this request.',
    'The LobsterAI media generation tools (lobsterai_image_generate / lobsterai_video_generate) replace those skills when a media model is selected.',
    'Do not run any skill scripts for image or video generation. Use only the lobsterai_* tools specified below.',
  ];

  if (selection.mode === 'image') {
    lines.push('If the current user request asks to create, generate, draw, render, or make an image/photo/picture, you must call the lobsterai_image_generate tool exactly once with action="generate".');
    lines.push('Use the current user request and relevant prior conversation as the image prompt.');
    lines.push('Do not answer with only a text prompt when the user asked for an image.');
    const imageModel = selection.imageModelId?.trim() || selection.modelId?.trim();
    if (imageModel) {
      lines.push(`You MUST use model "${imageModel}" for image generation. Do NOT use any other model for the generate action, even if other models appear in the available model list.`);
    }
  } else if (selection.mode === 'video') {
    lines.push('If the current user request asks to create, generate, render, or make a video, you must call the lobsterai_video_generate tool exactly once with action="generate".');
    lines.push('Use the current user request and relevant prior conversation as the video prompt.');
    lines.push('Do not answer with only a text prompt when the user asked for a video.');
    const videoModel = selection.videoModelId?.trim() || selection.modelId?.trim();
    if (videoModel) {
      lines.push(`You MUST use model "${videoModel}" for video generation. Do NOT use any other model for the generate action, even if other models appear in the available model list.`);
    }
  } else {
    lines.push('If the current user request asks for image generation, call lobsterai_image_generate with action="generate".');
    lines.push('If the current user request asks for video generation, call lobsterai_video_generate with action="generate".');
    lines.push('Use the current user request and relevant prior conversation as the media prompt.');
    if (selection.imageModelId?.trim()) {
      lines.push(`For image generation, you MUST use model "${selection.imageModelId.trim()}". Do NOT use a different model.`);
    }
    if (selection.videoModelId?.trim()) {
      lines.push(`For video generation, you MUST use model "${selection.videoModelId.trim()}". Do NOT use a different model.`);
    }
  }

  if (!selection.imageModelId && !selection.videoModelId && selection.modelId?.trim()) {
    lines.push(`You MUST use model "${selection.modelId.trim()}" for media generation. Do NOT use a different model unless the user explicitly requests a different LobsterAI media model by name.`);
  }

  return lines.join('\n');
};

const MediaReferenceTypeLabel = {
  Image: 'image',
  Video: 'video',
  Audio: 'audio',
} as const;

const sanitizeMediaReferenceText = (value: string): string => (
  value.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
);

const buildMediaReferencePromptSection = (mediaReferences?: CoworkMediaAttachmentRef[]): string => {
  const refs = mediaReferences?.filter(ref => ref.token.trim()) ?? [];
  if (refs.length === 0) return '';

  const lines = [
    '[LobsterAI media reference mapping]',
    'The current user request contains explicit @ media tokens. Treat these mappings as authoritative and do not guess which uploaded attachment a token means.',
    'When calling lobsterai_image_generate or lobsterai_video_generate, pass mapped file paths or URLs as tool arguments. Do not pass @ media tokens as image, images, firstFrame, lastFrame, referenceImages, media.url, video, or videos values.',
    'For lobsterai_image_generate, prefer image with the mapped path for one referenced image and images for multiple referenced images.',
  ];

  for (const ref of refs) {
    const mediaType = ref.mediaType === MediaReferenceTypeLabel.Image
      ? MediaReferenceTypeLabel.Image
      : ref.mediaType === MediaReferenceTypeLabel.Video
        ? MediaReferenceTypeLabel.Video
        : MediaReferenceTypeLabel.Audio;
    const locations = [
      ref.localPath ? `localPath "${sanitizeMediaReferenceText(ref.localPath)}"` : '',
      ref.remoteUrl ? `remoteUrl "${sanitizeMediaReferenceText(ref.remoteUrl)}"` : '',
      !ref.localPath && !ref.remoteUrl && ref.dataUrl ? 'dataUrl fallback available through LobsterAI host' : '',
    ].filter(Boolean);
    const locationText = locations.length > 0 ? `, ${locations.join(', ')}` : '';
    lines.push(`- ${ref.token}: ${mediaType} attachment #${ref.index}, file "${sanitizeMediaReferenceText(ref.fileName)}", MIME ${sanitizeMediaReferenceText(ref.mimeType)}${locationText}.`);
  }

  return lines.join('\n');
};

const mergeStreamingText = (
  previousText: string,
  incomingText: string,
  mode: TextStreamMode,
): { text: string; mode: TextStreamMode } => {
  if (!incomingText) {
    return { text: previousText, mode };
  }
  if (!previousText) {
    return { text: incomingText, mode };
  }
  if (incomingText === previousText) {
    return { text: previousText, mode };
  }

  if (mode === 'snapshot') {
    if (previousText.startsWith(incomingText) && incomingText.length < previousText.length) {
      return { text: previousText, mode };
    }
    return { text: incomingText, mode };
  }

  if (mode === 'delta') {
    if (incomingText.startsWith(previousText)) {
      return { text: incomingText, mode: 'snapshot' };
    }
    return { text: previousText + incomingText, mode };
  }

  if (incomingText.startsWith(previousText)) {
    return { text: incomingText, mode: 'snapshot' };
  }
  if (previousText.startsWith(incomingText)) {
    return { text: previousText, mode: 'snapshot' };
  }
  if (incomingText.includes(previousText) && incomingText.length > previousText.length) {
    return { text: incomingText, mode: 'snapshot' };
  }

  // Overlap detection removed: coincidental suffix-prefix matches (e.g. "...p" + "ptx")
  // would incorrectly strip characters. Once snapshot detection above has failed,
  // treat the incoming text as a pure delta append.
  return { text: previousText + incomingText, mode: 'delta' };
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const waitWithTimeout = async (promise: Promise<void>, timeoutMs: number): Promise<void> => {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`OpenClaw gateway client connect timeout after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const formatTimingDuration = (startedAtMs?: number, endedAtMs?: number): string => {
  if (!startedAtMs || !endedAtMs) {
    return 'n/a';
  }
  return `${endedAtMs - startedAtMs}ms`;
};

const formatTimingOffset = (baseStartedAtMs: number, endedAtMs?: number): string => {
  if (!endedAtMs) {
    return 'n/a';
  }
  return `${endedAtMs - baseStartedAtMs}ms`;
};

export class OpenClawRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: OpenClawEngineManager;
  private readonly options: OpenClawRuntimeAdapterOptions;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingGoalContinuations = new Map<string, PendingGoalContinuation>();
  private readonly sessionIdBySessionKey = new Map<string, string>();
  private readonly sessionIdByRunId = new Map<string, string>();
  private readonly pendingAgentEventsByRunId = new Map<string, AgentEventPayload[]>();
  private readonly lastChatSeqByRunId = new Map<string, number>();
  private readonly lastAgentSeqByRunId = new Map<string, number>();
  // Tracks runIds that have received a lifecycle phase=error, so gateway retries
  // (which reuse the same runId) don't re-create an ActiveTurn and surface duplicate errors.
  private readonly terminatedRunIds = new Set<string>();
  /**
   * Recently completed/aborted/errored runIds are kept briefly so late gateway
   * events cannot re-create a ghost turn or attach to the next user turn.
   */
  private readonly recentlyClosedRunIds = new Map<string, RecentlyClosedRunInfo>();
  private readonly pendingTurns = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();
  private readonly bridgedSessions = new Set<string>();
  private readonly continuityFullBridgeCompactedAtBySession = new Map<string, number>();
  private readonly workspaceRehydrationBridgeCompactedAtBySession = new Map<string, number>();
  private readonly lastSystemPromptBySession = new Map<string, string>();
  private readonly sessionModelPatchStateBySession = new Map<string, SessionModelPatchState>();
  private readonly sessionModelPatchQueue = new Map<string, Promise<void>>();
  private readonly gatewayHistoryCountBySession = new Map<string, number>();
  private readonly latestTurnTokenBySession = new Map<string, number>();

  /**
   * Sessions that were manually stopped by the user via stopSession().
   * Maps sessionId → timestamp of when stop was requested.
   * Used to suppress automatic ActiveTurn re-creation from late-arriving
   * OpenClaw Gateway events (e.g. POPO/Telegram channel events that arrive
   * after the user clicked Stop).  Entries expire after STOP_COOLDOWN_MS.
   */
  private readonly stoppedSessions = new Map<string, number>();
  private static readonly STOP_COOLDOWN_MS = 10_000; // 10 seconds
  private static readonly RECENTLY_CLOSED_RUN_ID_TTL_MS = 120_000;
  private static readonly RECENTLY_CLOSED_RUN_ID_LIMIT = 1000;
  private static readonly LIFECYCLE_ERROR_FALLBACK_DELAY_MS = 20_000;
  private static readonly CHAT_FINAL_COMPLETION_GRACE_MS = 800;
  private static readonly PLAN_MODE_RECOVERY_FOLLOWUP_GRACE_MS = 15_000;
  private static readonly TOOL_USE_FINAL_LIFECYCLE_END_GRACE_MS = 45_000;
  private static readonly SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS = 60_000;
  private static readonly VISIBLE_FINAL_CONTINUATION_GRACE_MS = 120_000;
  private static readonly VISIBLE_FINAL_LARGE_TOOL_CONFIRMATION_GRACE_MS = 8_000;
  private static readonly VISIBLE_FINAL_TOOL_RESULT_CHAR_THRESHOLD = 20_000;
  private static readonly VISIBLE_FINAL_SHORT_TEXT_CHAR_THRESHOLD = 600;
  private static readonly GATEWAY_SESSION_DELETE_TIMEOUT_MS = 5_000;
  private static readonly PLAN_MODE_SAFETY_RECOVERY_AFTER_ABORT_FALLBACK_MS = 10_000;
  private static readonly PLAN_MODE_SAFETY_RECOVERY_AFTER_LIFECYCLE_END_MS = 1_500;

  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  /** Holds the client between start() and onHelloOk so stopGatewayClient can clean it up. */
  private pendingGatewayClient: GatewayClientLike | null = null;
  private gatewayReadyPromise: Promise<void> | null = null;
  private gatewayReadyReject: ((error: Error) => void) | null = null;
  /** Serializes concurrent calls to ensureGatewayClientReady to prevent duplicate clients. */
  private gatewayClientInitLock: Promise<void> | null = null;
  private channelSessionSync: OpenClawChannelSessionSync | null = null;
  private readonly knownChannelSessionIds = new Set<string>();
  private readonly fullySyncedSessions = new Set<string>();
  /** Per-session cursor: number of gateway history entries (user+assistant) already synced locally. */
  private readonly channelSyncCursor = new Map<string, number>();
  /** Sessions re-created after user deletion — use latestOnly sync to avoid replaying old history. */
  private readonly reCreatedChannelSessionIds = new Set<string>();
  /** Channel sessionKeys explicitly deleted by the user. Polling will not re-create these. */
  private readonly deletedChannelKeys = new Set<string>();
  /** Sessions that were manually stopped by the user. Used to suppress the timeout hint
   *  when the gateway sends back a late 'aborted' event after stopSession() already cleaned up the turn. */
  private readonly manuallyStoppedSessions = new Set<string>();
  /** Session keys whose origin is "heartbeat" — discovered via polling, used to filter real-time events. */
  private readonly heartbeatSessionKeys = new Set<string>();
  private channelPollingTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly CHANNEL_POLL_INTERVAL_MS = 10_000;
  /** Delay before pulling a cron delivery mirror into the mapped conversation,
   *  giving the gateway time to flush the transcript append. */
  private static readonly CRON_DELIVERY_SYNC_DELAY_MS = 2_000;
  private static readonly FULL_HISTORY_SYNC_LIMIT = 50;
  private browserPrewarmAttempted = false;

  /** Gateway WS auto-reconnect state */
  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;
  /** Set to true before intentionally stopping the client (e.g. version upgrade) to suppress auto-reconnect. */
  private gatewayStoppingIntentionally = false;
  private gatewayReconnectSuppressed = false;
  private static readonly GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
  private static readonly GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000]; // ms

  /** Gateway tick heartbeat watchdog state */
  private lastTickTimestamp = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly TICK_WATCHDOG_INTERVAL_MS = 60_000; // check every 60s
  private static readonly TICK_TIMEOUT_MS = 90_000; // 3 tick cycles (30s each) without response → dead

  /** Throttle state for messageUpdate IPC emissions during streaming */
  private lastMessageUpdateEmitTime: Map<string, number> = new Map();
  private pendingMessageUpdateTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly MESSAGE_UPDATE_THROTTLE_MS = 200;

  /** Throttle state for SQLite store writes during streaming */
  private lastStoreUpdateTime: Map<string, number> = new Map();
  private pendingStoreUpdateTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly STORE_UPDATE_THROTTLE_MS = 250;

  /** Debounced incremental backfill of tool result text from chat.history. */
  private incrementalBackfillTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingBackfillToolCallIds: Map<string, Set<string>> = new Map();
  private static readonly INCREMENTAL_BACKFILL_DEBOUNCE_MS = 2000;

  // ── Subagent tracking (delegated) ───────────────────────────────────────
  private readonly subagentTracker: SubagentTracker;
  private readonly approvalController: OpenClawApprovalController;

  /**
   * Server-side agent timeout in seconds (mirrors agents.defaults.timeoutSeconds in openclaw config).
   * Used to set a client-side fallback timer that fires slightly after the server timeout,
   * so LobsterAI can recover even when the gateway fails to deliver the abort event.
   */
  agentTimeoutSeconds = OPENCLAW_AGENT_TIMEOUT_SECONDS;
  private static readonly CLIENT_TIMEOUT_GRACE_MS = 30_000;

  private contextWindowCache: Map<string, number> = new Map();
  private contextWindowCacheLoaded = false;

  // Authoritative contextTokens from sessions.list (per sessionKey).
  // Updated by pollChannelSessions and refreshSessionContextTokens.
  private sessionContextTokensCache: Map<string, number> = new Map();
  private readonly goalSnapshotBySessionId = new Map<string, string>();
  private readonly contextUsageInFlightBySession = new Map<string, Promise<CoworkContextUsage | null>>();
  private readonly contextUsageListInFlight = new Map<string, Promise<Record<string, unknown>[]>>();
  private gatewayRpcHealth: GatewayRpcHealth = {
    degradedUntil: 0,
    consecutiveTimeouts: 0,
  };

  private static readonly CONTEXT_USAGE_LIST_LIMIT = 120;
  private static readonly CONTEXT_USAGE_TARGETED_TIMEOUT_MS = 2_000;
  private static readonly CONTEXT_USAGE_LIST_TIMEOUT_MS = 5_000;
  private static readonly GATEWAY_RPC_DEGRADED_MS = 30_000;
  private static readonly SESSION_MODEL_PATCH_CONFIRMED_TTL_MS = 10 * 60_000;
  private static readonly SESSION_PATCH_TIMEOUT_MS = 30_000;
  // Pre-send model sync tolerates slow gateways (cold start / process stalls
  // of 35-107s observed in the field); the patch is idempotent and the
  // gateway recovers on its own, so waiting beats dropping the message.
  private static readonly SESSION_PATCH_SEND_TIMEOUT_MS = 90_000;
  private static readonly SESSION_PATCH_SLOW_LOG_MS = 5_000;

  private emitSessionStatus(sessionId: string, status: CoworkSessionStatus): void {
    this.emit('sessionStatus', sessionId, status);
  }

  private emitContextMaintenance(sessionId: string, active: boolean): void {
    console.log(`[OpenClawRuntime] context maintenance ${active ? 'started' : 'ended'} for session ${sessionId}.`);
    this.emit('contextMaintenance', sessionId, active);
  }

  private refreshContinuityCapsule(
    sessionId: string,
    source: ContinuityCapsuleSourceValue,
    options: {
      sourceMessageId?: string;
      compactedAt?: number;
    } = {},
  ): void {
    try {
      if (
        typeof this.store.getSession !== 'function'
        || typeof this.store.getContinuityCapsule !== 'function'
        || typeof this.store.upsertContinuityCapsule !== 'function'
      ) {
        return;
      }
      const session = this.store.getSession(sessionId);
      if (!session) {
        console.debug(`[CoworkContinuityCapsule] skipped refresh because session ${sessionId} was not found.`);
        return;
      }
      const previous = this.store.getContinuityCapsule(sessionId);
      const capsule = buildCoworkContinuityCapsule({
        sessionId,
        messages: session.messages,
        previous,
        source,
        ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
        ...(options.compactedAt ? { compactedAt: options.compactedAt } : {}),
      });
      this.store.upsertContinuityCapsule(sessionId, capsule);
      const logMessage = [
        `[CoworkContinuityCapsule] refreshed capsule for session ${sessionId}.`,
        `Source ${source}.`,
        `Revision ${capsule.revision}.`,
        `Touched files ${capsule.touchedFiles.length}.`,
        `Next steps ${capsule.nextSteps.length}.`,
      ] as const;
      if (source === ContinuityCapsuleSource.PreCompaction || source === ContinuityCapsuleSource.PostCompaction) {
        console.log(...logMessage);
      } else {
        console.debug(...logMessage);
      }
    } catch (error) {
      console.warn(`[CoworkContinuityCapsule] failed to refresh capsule for session ${sessionId}:`, error);
    }
  }

  private buildContinuityCapsuleBridge(sessionId: string): string {
    try {
      if (typeof this.store.getContinuityCapsule !== 'function') {
        return '';
      }
      const capsule = this.store.getContinuityCapsule(sessionId);
      if (!capsule?.lastCompactedAt) {
        return '';
      }
      const shouldInjectFullBridge = this.continuityFullBridgeCompactedAtBySession.get(sessionId) !== capsule.lastCompactedAt;
      const bridge = shouldInjectFullBridge
        ? formatCoworkContinuityCapsuleBridge(capsule)
        : formatCoworkMiniContinuityCapsuleBridge(capsule);
      if (!bridge.trim()) {
        return '';
      }
      if (shouldInjectFullBridge) {
        this.continuityFullBridgeCompactedAtBySession.set(sessionId, capsule.lastCompactedAt);
      }
      console.debug(
        `[CoworkContinuityCapsule] injected capsule bridge for session ${sessionId}.`,
        `Mode ${shouldInjectFullBridge ? 'full' : 'mini'}.`,
        `Revision ${capsule.revision}.`,
        `Bridge length ${bridge.length}.`,
      );
      return bridge;
    } catch (error) {
      console.warn(`[CoworkContinuityCapsule] failed to build capsule bridge for session ${sessionId}; continuing without it.`, error);
      return '';
    }
  }

  private async buildWorkspaceRehydrationBridge(sessionId: string): Promise<string> {
    try {
      if (typeof this.store.getSession !== 'function' || typeof this.store.getContinuityCapsule !== 'function') {
        return '';
      }
      const session = this.store.getSession(sessionId);
      const capsule = this.store.getContinuityCapsule(sessionId);
      const compactedAt = capsule?.lastCompactedAt;
      if (!compactedAt || this.workspaceRehydrationBridgeCompactedAtBySession.get(sessionId) === compactedAt) {
        return '';
      }
      const bridge = await buildCoworkWorkspaceRehydrationBridge({
        sessionId,
        cwd: session?.cwd,
        capsule,
      });
      this.workspaceRehydrationBridgeCompactedAtBySession.set(sessionId, compactedAt);
      if (!bridge.trim()) {
        return '';
      }
      console.debug(
        `[CoworkWorkspaceRehydration] injected workspace bridge for session ${sessionId}.`,
        `Bridge length ${bridge.length}.`,
      );
      return bridge;
    } catch (error) {
      console.warn(`[CoworkWorkspaceRehydration] failed to build workspace bridge for session ${sessionId}; continuing without it.`, error);
      return '';
    }
  }

  private buildTopKEvidenceBridge(sessionId: string, prompt: string): string {
    try {
      if (typeof this.store.getSession !== 'function' || typeof this.store.getContinuityCapsule !== 'function') {
        return '';
      }
      const session = this.store.getSession(sessionId, 300);
      const capsule = this.store.getContinuityCapsule(sessionId);
      if (!session || !capsule?.lastCompactedAt) {
        return '';
      }
      const result = buildCoworkTopKEvidenceBridgeResult({
        sessionId,
        messages: session.messages,
        prompt,
        capsule,
      });
      const bridge = result.bridge;
      if (!bridge.trim()) {
        return '';
      }
      console.debug(
        `[CoworkTopKEvidence] injected retrieved evidence bridge for session ${sessionId}.`,
        `Candidates ${result.diagnostics.candidateCount}.`,
        `Matched ${result.diagnostics.matchedCount}.`,
        `Injected ${result.diagnostics.injectedCount}.`,
        `Bridge length ${result.diagnostics.bridgeLength}.`,
      );
      return bridge;
    } catch (error) {
      console.warn(`[CoworkTopKEvidence] failed to build evidence bridge for session ${sessionId}; continuing without it.`, error);
      return '';
    }
  }

  private isWaitingForRecoverableFollowup(turn: ActiveTurn): boolean {
    return Boolean(
      turn.hasContextMaintenanceTool
      || turn.hasContextCompactionEvent
      || turn.pendingRecoverableFollowup
      || turn.pendingOpenClawRetry
      || turn.pendingVisibleFinalContinuation
      || turn.finalCompletionFlushOnLifecycleEnd === false
    );
  }

  private clearContextMaintenanceState(sessionId: string, turn: ActiveTurn, reason: string): void {
    const wasActive = this.isWaitingForRecoverableFollowup(turn);
    turn.hasContextMaintenanceTool = false;
    turn.hasContextCompactionEvent = false;
    turn.pendingRecoverableFollowup = false;
    turn.pendingOpenClawRetry = false;
    turn.pendingVisibleFinalContinuation = false;
    turn.pendingThinkingOnlyHint = false;
    if (wasActive) {
      this.emitContextMaintenance(sessionId, false);
      console.debug(`[OpenClawRuntime] context maintenance ended because ${reason}.`);
    }
  }

  private getLocalTurnToolWork(sessionId: string): { hasToolWork: boolean; toolResultChars: number } {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return { hasToolWork: false, toolResultChars: 0 };
    }

    let lastUserIdx = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].type === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
    let hasToolWork = false;
    let toolResultChars = 0;
    for (let i = startIdx; i < session.messages.length; i++) {
      const message = session.messages[i];
      if (message.type === 'tool_use') {
        hasToolWork = true;
        continue;
      }
      if (message.type === 'tool_result') {
        hasToolWork = true;
        toolResultChars += message.content.length;
      }
    }

    return { hasToolWork, toolResultChars };
  }

  private hasTurnToolWork(sessionId: string, turn: ActiveTurn): boolean {
    return turn.toolUseMessageIdByToolCallId.size > 0
      || turn.toolResultMessageIdByToolCallId.size > 0
      || turn.toolResultTextByToolCallId.size > 0
      || turn.lastHistoryHadToolWork === true
      || this.getLocalTurnToolWork(sessionId).hasToolWork;
  }

  private getTurnToolResultCharCount(sessionId: string, turn: ActiveTurn): number {
    let total = 0;
    for (const text of turn.toolResultTextByToolCallId.values()) {
      total += text.length;
    }
    const localToolWork = this.getLocalTurnToolWork(sessionId);
    total = Math.max(total, localToolWork.toolResultChars);
    total = Math.max(total, turn.lastHistoryToolResultCharCount ?? 0);
    return total;
  }

  private shouldWaitForVisibleFinalContinuation(
    sessionId: string,
    turn: ActiveTurn,
    finalText: string,
    options: { forceForEmptyFinal?: boolean } = {},
  ): { wait: boolean; reason: string; toolResultChars: number; graceMs: number } {
    const visibleText = finalText.trim();
    const toolResultChars = this.getTurnToolResultCharCount(sessionId, turn);
    const hasToolWork = this.hasTurnToolWork(sessionId, turn);

    if (!visibleText || !hasToolWork) {
      return {
        wait: false,
        reason: 'not a visible tool final risk',
        toolResultChars,
        graceMs: OpenClawRuntimeAdapter.CHAT_FINAL_COMPLETION_GRACE_MS,
      };
    }

    const hasMaintenanceSignal = Boolean(
      turn.hasContextCompactionEvent
      || turn.hasContextMaintenanceTool
      || turn.pendingRecoverableFollowup
      || turn.pendingOpenClawRetry
      || turn.pendingVisibleFinalContinuation
    );
    if (hasMaintenanceSignal) {
      return {
        wait: true,
        reason: 'context maintenance signal is active',
        toolResultChars,
        graceMs: OpenClawRuntimeAdapter.VISIBLE_FINAL_CONTINUATION_GRACE_MS,
      };
    }

    if (options.forceForEmptyFinal) {
      return {
        wait: true,
        reason: 'empty final recovered short history text after tool work',
        toolResultChars,
        graceMs: OpenClawRuntimeAdapter.VISIBLE_FINAL_CONTINUATION_GRACE_MS,
      };
    }

    const isShortVisibleFinal = visibleText.length <= OpenClawRuntimeAdapter.VISIBLE_FINAL_SHORT_TEXT_CHAR_THRESHOLD;
    const hasLargeToolResults = toolResultChars >= OpenClawRuntimeAdapter.VISIBLE_FINAL_TOOL_RESULT_CHAR_THRESHOLD;
    if (isShortVisibleFinal && hasLargeToolResults) {
      return {
        wait: true,
        reason: 'short visible final followed large tool results',
        toolResultChars,
        graceMs: OpenClawRuntimeAdapter.VISIBLE_FINAL_LARGE_TOOL_CONFIRMATION_GRACE_MS,
      };
    }

    return {
      wait: false,
      reason: 'visible final does not look recoverable',
      toolResultChars,
      graceMs: OpenClawRuntimeAdapter.CHAT_FINAL_COMPLETION_GRACE_MS,
    };
  }

  private shouldWaitForLifecycleFallbackContinuation(
    sessionId: string,
    turn: ActiveTurn,
  ): {
      wait: boolean;
      reason: string;
      graceMs: number;
      pendingThinkingOnlyHint?: boolean;
      pendingVisibleFinalContinuation?: boolean;
      toolResultChars: number;
      visibleTextLen: number;
    } {
    const toolResultChars = this.getTurnToolResultCharCount(sessionId, turn);
    if (!this.hasTurnToolWork(sessionId, turn)) {
      return {
        wait: false,
        reason: 'fallback turn has no tool work',
        graceMs: OpenClawRuntimeAdapter.CHAT_FINAL_COMPLETION_GRACE_MS,
        toolResultChars,
        visibleTextLen: 0,
      };
    }

    const visibleText = (turn.currentAssistantSegmentText.trim() || turn.currentText.trim());
    if (!visibleText) {
      return {
        wait: true,
        reason: 'missing chat.final after tool work',
        graceMs: OpenClawRuntimeAdapter.SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS,
        pendingThinkingOnlyHint: true,
        toolResultChars,
        visibleTextLen: 0,
      };
    }

    const visibleRisk = this.shouldWaitForVisibleFinalContinuation(sessionId, turn, visibleText);
    if (visibleRisk.wait) {
      return {
        wait: true,
        reason: `missing chat.final lifecycle fallback: ${visibleRisk.reason}`,
        graceMs: visibleRisk.graceMs,
        pendingVisibleFinalContinuation: true,
        toolResultChars: visibleRisk.toolResultChars,
        visibleTextLen: visibleText.length,
      };
    }

    return {
      wait: false,
      reason: visibleRisk.reason,
      graceMs: OpenClawRuntimeAdapter.CHAT_FINAL_COMPLETION_GRACE_MS,
      toolResultChars: visibleRisk.toolResultChars,
      visibleTextLen: visibleText.length,
    };
  }

  private waitForRecoverableOpenClawRetry(
    sessionId: string,
    turn: ActiveTurn,
    runId: string,
    options: {
      reason: string;
      graceMs: number;
      pendingThinkingOnlyHint?: boolean;
      pendingVisibleFinalContinuation?: boolean;
    },
  ): void {
    if (this.activeTurns.get(sessionId) !== turn || turn.stopRequested) {
      console.debug(
        '[OpenClawRuntime] skipped recoverable follow-up wait for stale turn.',
        `sessionId=${sessionId}`,
        `runId=${runId}`,
        `reason=${options.reason}`,
      );
      return;
    }

    turn.pendingRecoverableFollowup = true;
    turn.pendingOpenClawRetry = true;
    turn.lastRecoverableFinalAtMs = Date.now();
    if (options.pendingThinkingOnlyHint) {
      turn.pendingThinkingOnlyHint = true;
    }
    if (options.pendingVisibleFinalContinuation) {
      turn.pendingVisibleFinalContinuation = true;
    }
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    this.emitContextMaintenance(sessionId, true);
    this.deferChatFinalCompletion(sessionId, turn, runId, {
      graceMs: options.graceMs,
      flushOnLifecycleEnd: false,
      allowLateContinuation: true,
    });
    console.debug(
      '[OpenClawRuntime] delayed chat.final while waiting for OpenClaw retry.',
      `sessionId=${sessionId}`,
      `runId=${runId}`,
      `reason=${options.reason}`,
    );
  }

  private readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isGatewayRequestTimeout(error: unknown, method?: string): boolean {
    const message = this.getErrorMessage(error);
    if (method) {
      return new RegExp(`gateway request timeout for ${method.replace('.', '\\.')}`, 'i').test(message);
    }
    return /gateway request timeout for /i.test(message);
  }

  private isGatewayRpcDegraded(now = Date.now()): boolean {
    if (this.gatewayRpcHealth.degradedUntil <= now) {
      return false;
    }
    return true;
  }

  private markGatewayRpcTimeout(method: string, error: unknown): void {
    const now = Date.now();
    const consecutiveTimeouts = this.gatewayRpcHealth.consecutiveTimeouts + 1;
    this.gatewayRpcHealth = {
      degradedUntil: now + OpenClawRuntimeAdapter.GATEWAY_RPC_DEGRADED_MS,
      consecutiveTimeouts,
      lastTimeoutMethod: method,
      lastTimeoutAt: now,
    };
    console.warn(`[OpenClawRuntime] gateway RPC timed out for ${method}; session RPCs are degraded for ${OpenClawRuntimeAdapter.GATEWAY_RPC_DEGRADED_MS}ms:`, error);
  }

  private markGatewayRpcSuccess(): void {
    if (this.gatewayRpcHealth.consecutiveTimeouts === 0 && this.gatewayRpcHealth.degradedUntil <= Date.now()) {
      return;
    }
    this.gatewayRpcHealth = {
      degradedUntil: 0,
      consecutiveTimeouts: 0,
    };
  }

  private recordGatewayRpcFailure(method: string, error: unknown): void {
    if (this.isGatewayRequestTimeout(error, method)) {
      this.markGatewayRpcTimeout(method, error);
    }
  }

  private async requestSessionPatchWithProfile(options: {
    sessionId: string;
    sessionKey: string;
    patch: OpenClawSessionPatch;
    source: string;
    reason: string;
    timeoutMs?: number;
  }): Promise<OpenClawSessionPatchGatewayResult | undefined> {
    const { sessionId, sessionKey, patch, source, reason } = options;
    const timeoutMs = options.timeoutMs ?? OpenClawRuntimeAdapter.SESSION_PATCH_TIMEOUT_MS;
    const patchKeys = Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    const model = typeof patch.model === 'string' && patch.model ? patch.model : '-';
    const startedAtMs = Date.now();

    console.debug(
      '[OpenClawRuntime] sessions.patch started.',
      `Session ${sessionId}.`,
      `OpenClaw key ${sessionKey}.`,
      `Reason ${reason}.`,
      `Source ${source}.`,
      `Patch fields ${patchKeys.join(',') || 'none'}.`,
      `Model ${model}.`,
      `Timeout ${timeoutMs}ms.`,
    );

    let response: OpenClawSessionPatchGatewayResult | undefined;
    try {
      const client = this.requireGatewayClient();
      response = await client.request<OpenClawSessionPatchGatewayResult>('sessions.patch', {
        key: sessionKey,
        ...patch,
      }, { timeoutMs });
    } catch (error) {
      const elapsedMs = Date.now() - startedAtMs;
      console.warn(
        `[OpenClawRuntime] sessions.patch failed after ${elapsedMs}ms.`,
        `Session ${sessionId}.`,
        `OpenClaw key ${sessionKey}.`,
        `Reason ${reason}.`,
        `Source ${source}.`,
        `Patch fields ${patchKeys.join(',') || 'none'}.`,
        `Model ${model}.`,
        `Timeout ${timeoutMs}ms.`,
        error,
      );
      throw error;
    }

    const elapsedMs = Date.now() - startedAtMs;
    const message = elapsedMs >= OpenClawRuntimeAdapter.SESSION_PATCH_SLOW_LOG_MS
      ? `[OpenClawRuntime] sessions.patch completed slowly in ${elapsedMs}ms.`
      : `[OpenClawRuntime] sessions.patch completed in ${elapsedMs}ms.`;
    const details = [
      `Session ${sessionId}.`,
      `OpenClaw key ${sessionKey}.`,
      `Reason ${reason}.`,
      `Source ${source}.`,
      `Patch fields ${patchKeys.join(',') || 'none'}.`,
      `Model ${model}.`,
      `Timeout ${timeoutMs}ms.`,
    ];
    if (elapsedMs >= OpenClawRuntimeAdapter.SESSION_PATCH_SLOW_LOG_MS) {
      console.warn(message, ...details);
    } else {
      console.debug(message, ...details);
    }
    return response;
  }

  private resetGatewayRpcHealth(): void {
    this.gatewayRpcHealth = {
      degradedUntil: 0,
      consecutiveTimeouts: 0,
    };
  }

  private getConfirmedSessionModelPatch(
    sessionId: string,
    sessionKey: string,
    model: string,
    source: SessionModelPatchSource,
  ): SessionModelPatchState | null {
    const state = this.sessionModelPatchStateBySession.get(sessionId);
    if (!state) return null;
    if (state.model !== model || state.sessionKey !== sessionKey || state.source !== source) {
      return null;
    }
    if (Date.now() - state.confirmedAt > OpenClawRuntimeAdapter.SESSION_MODEL_PATCH_CONFIRMED_TTL_MS) {
      this.sessionModelPatchStateBySession.delete(sessionId);
      return null;
    }
    return state;
  }

  private rememberSessionModelPatch(
    sessionId: string,
    sessionKey: string,
    model: string,
    source: SessionModelPatchSource,
  ): void {
    this.sessionModelPatchStateBySession.set(sessionId, {
      model,
      sessionKey,
      source,
      confirmedAt: Date.now(),
    });
  }

  private resolveContextUsageStatus(percent: number | undefined): CoworkContextUsage['status'] {
    if (percent === undefined) return 'unknown';
    if (percent >= 90) return 'danger';
    if (percent >= 70) return 'warning';
    return 'normal';
  }

  private async listGatewaySessionsForUsage(options: {
    activeMinutes?: number;
    limit?: number;
    search?: string;
    timeoutMs?: number;
  } = {}): Promise<Record<string, unknown>[]> {
    const client = this.gatewayClient;
    if (!client) return [];
    if (this.isGatewayRpcDegraded()) {
      console.debug('[OpenClawRuntime] skipped context usage session lookup because gateway session RPCs are degraded.');
      return [];
    }
    const params: Record<string, unknown> = {
      limit: options.limit ?? OpenClawRuntimeAdapter.CONTEXT_USAGE_LIST_LIMIT,
    };
    if (typeof options.activeMinutes === 'number') {
      params.activeMinutes = options.activeMinutes;
    }
    if (options.search?.trim()) {
      params.search = options.search.trim();
    }
    const timeoutMs = options.timeoutMs ?? OpenClawRuntimeAdapter.CONTEXT_USAGE_LIST_TIMEOUT_MS;
    const inFlightKey = JSON.stringify({ ...params, timeoutMs });
    const existing = this.contextUsageListInFlight.get(inFlightKey);
    if (existing) {
      return existing;
    }
    let request: Promise<Record<string, unknown>[]>;
    request = client.request<{ sessions?: unknown[] }>('sessions.list', {
      ...params,
    }, { timeoutMs })
      .then((result) => {
        this.markGatewayRpcSuccess();
        const sessions = result?.sessions;
        return Array.isArray(sessions)
          ? sessions.filter(isRecord) as Record<string, unknown>[]
          : [];
      })
      .catch((error) => {
        this.recordGatewayRpcFailure('sessions.list', error);
        throw error;
      })
      .finally(() => {
        if (this.contextUsageListInFlight.get(inFlightKey) === request) {
          this.contextUsageListInFlight.delete(inFlightKey);
        }
      });
    this.contextUsageListInFlight.set(inFlightKey, request);
    return request;
  }

  private buildContextUsageFromSessionRow(sessionId: string, row: Record<string, unknown>): CoworkContextUsage {
    const sessionKey = typeof row.key === 'string' ? row.key : undefined;
    const contextTokens = this.readNumber(row, ['contextTokens', 'contextWindow']);
    const usedTokens = this.readNumber(row, ['totalTokens', 'tokenCount', 'tokens', 'inputTokens']);
    const compactionCount = this.readNumber(row, ['compactionCheckpointCount']);
    const latestCheckpoint = isRecord(row.latestCompactionCheckpoint)
      ? row.latestCompactionCheckpoint as Record<string, unknown>
      : undefined;
    const percent = usedTokens !== undefined && contextTokens && contextTokens > 0
      ? Math.min(Math.round((usedTokens / contextTokens) * 100), 100)
      : undefined;

    if (sessionKey && typeof contextTokens === 'number') {
      this.sessionContextTokensCache.set(sessionKey, contextTokens);
    }
    this.syncGoalFromSessionRow(row);

    return {
      sessionId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(percent !== undefined ? { percent } : {}),
      ...(compactionCount !== undefined ? { compactionCount } : {}),
      status: this.resolveContextUsageStatus(percent),
      ...(typeof latestCheckpoint?.checkpointId === 'string'
        ? { latestCompactionCheckpointId: latestCheckpoint.checkpointId }
        : {}),
      ...(typeof latestCheckpoint?.reason === 'string'
        ? { latestCompactionReason: latestCheckpoint.reason }
        : {}),
      ...(typeof latestCheckpoint?.createdAt === 'number'
        ? { latestCompactionCreatedAt: latestCheckpoint.createdAt }
        : {}),
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
      updatedAt: Date.now(),
    };
  }

  private syncGoalFromSessionRow(row: Record<string, unknown>): void {
    if (!Object.prototype.hasOwnProperty.call(row, 'goal')) return;
    const sessionKey = typeof row.key === 'string' ? row.key.trim() : '';
    if (!sessionKey) return;
    const sessionId = this.resolveSessionIdBySessionKey(sessionKey)
      ?? this.resolveLocalSessionIdFromGatewaySessionKey(sessionKey);
    if (!sessionId) return;

    const goal = normalizeCoworkGoal(row.goal);
    this.rememberSessionKey(sessionId, sessionKey);
    this.emitGoalUpdateIfChanged(sessionId, goal);
  }

  private emitGoalUpdateIfChanged(sessionId: string, goal: CoworkGoal | null): void {
    const snapshot = goal ? JSON.stringify(goal) : '';
    if (this.goalSnapshotBySessionId.get(sessionId) === snapshot) return;
    this.goalSnapshotBySessionId.set(sessionId, snapshot);
    try {
      this.store.updateSession(sessionId, { goal }, { touchUpdatedAt: false });
    } catch (error) {
      console.warn(`[OpenClawRuntime] failed to persist goal display cache for session ${sessionId}; continuing with streamed update.`, error);
    }
    console.debug(
      `[OpenClawRuntime] goal update for session ${sessionId}: status=${goal?.status ?? 'none'}, hasGoal=${goal ? 'yes' : 'no'}.`,
    );
    this.emit('goalUpdate', sessionId, goal);
  }

  private addGoalSettingUserMessageFromCommand(
    sessionId: string,
    command: { action: OpenClawGoalCommandAction; text: string },
  ): void {
    if (!GOAL_BOOTSTRAP_ACTIONS.has(command.action) || !command.text.trim()) return;
    const goalCommand = `/goal ${command.action} ${command.text.trim()}`;
    const metadata = buildGoalSettingMessageMetadata(goalCommand);
    const userMessage = this.store.addMessage(sessionId, {
      type: 'user',
      content: command.text.trim(),
      ...(metadata ? { metadata } : {}),
    });
    this.refreshContinuityCapsule(sessionId, ContinuityCapsuleSource.UserMessage, {
      sourceMessageId: userMessage.id,
    });
    console.debug(
      '[OpenClawRuntime] persisted goal setting user message.',
      `Session ${sessionId}.`,
      `Action ${command.action}.`,
    );
    this.emit('message', sessionId, userMessage);
  }

  async getContextUsage(sessionId: string): Promise<CoworkContextUsage | null> {
    const existing = this.contextUsageInFlightBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    let request: Promise<CoworkContextUsage | null>;
    request = this.resolveContextUsage(sessionId).finally(() => {
      if (this.contextUsageInFlightBySession.get(sessionId) === request) {
        this.contextUsageInFlightBySession.delete(sessionId);
      }
    });
    this.contextUsageInFlightBySession.set(sessionId, request);
    return request;
  }

  private async resolveContextUsage(sessionId: string): Promise<CoworkContextUsage | null> {
    const keys = this.getSessionKeysForSession(sessionId);
    if (keys.length === 0) return null;
    const startedAt = Date.now();

    for (const key of keys) {
      try {
        const rows = await this.listGatewaySessionsForUsage({
          search: key,
          limit: 5,
          timeoutMs: OpenClawRuntimeAdapter.CONTEXT_USAGE_TARGETED_TIMEOUT_MS,
        });
        const row = rows.find(item => item.key === key);
        if (row) {
          console.log(`[OpenClawRuntime] context usage was resolved by targeted lookup for session ${sessionId} in ${Date.now() - startedAt}ms.`);
          return this.buildContextUsageFromSessionRow(sessionId, row);
        }
      } catch (error) {
        console.warn(`[OpenClawRuntime] context usage lookup failed for session ${sessionId}; returning no usage.`, error);
        return null;
      }
    }
    console.debug(`[OpenClawRuntime] context usage was unavailable for session ${sessionId} after ${Date.now() - startedAt}ms.`);
    return null;
  }

  async compactContext(sessionId: string): Promise<{ compacted: boolean; reason?: string; usage?: CoworkContextUsage | null }> {
    const client = this.requireGatewayClient();
    const sessionKey = this.getSessionKeysForSession(sessionId)[0];
    if (!sessionKey) {
      throw new Error(`Session ${sessionId} has no OpenClaw session key.`);
    }

    console.log(`[OpenClawRuntime] starting manual context compaction for session ${sessionId}.`);
    this.refreshContinuityCapsule(sessionId, ContinuityCapsuleSource.PreCompaction);
    const result = await client.request<Record<string, unknown>>('sessions.compact', {
      key: sessionKey,
    }, { timeoutMs: 120_000 });
    const compacted = result?.compacted === true;
    const reason = typeof result?.reason === 'string' ? result.reason : undefined;
    const usage = await this.getContextUsage(sessionId);
    console.log(`[OpenClawRuntime] manual context compaction finished for session ${sessionId}, compacted=${compacted}, reason=${reason ?? 'none'}.`);
    if (compacted) {
      this.refreshContinuityCapsule(sessionId, ContinuityCapsuleSource.PostCompaction, {
        compactedAt: Date.now(),
      });
    }
    void this.logContextCompactionDiagnostic({
      sessionId,
      sessionKey,
      mode: 'manual',
      ...(reason ? { reason } : {}),
      compacted,
    });
    return { compacted, ...(reason ? { reason } : {}), usage };
  }

  private async lookupLatestCompactionCheckpoint(
    client: GatewayClientLike,
    sessionKey: string,
    options: {
      beforeCreatedAt?: number;
      preferSummary?: boolean;
    } = {},
  ): Promise<OpenClawCompactionCheckpoint | null> {
    const listResult = await client.request<{ checkpoints?: OpenClawCompactionCheckpoint[] } | OpenClawCompactionCheckpoint[]>(
      'sessions.compaction.list',
      { key: sessionKey },
      { timeoutMs: 3_000 },
    );
    const checkpoints = Array.isArray(listResult)
      ? listResult
      : Array.isArray(listResult?.checkpoints)
        ? listResult.checkpoints
        : [];
    const eligibleCheckpoints = typeof options.beforeCreatedAt === 'number'
      ? checkpoints.filter((checkpoint) => (
        typeof checkpoint.createdAt === 'number' && checkpoint.createdAt <= options.beforeCreatedAt
      ))
      : checkpoints;
    const viableCheckpoints = eligibleCheckpoints
      .filter((checkpoint) => (
        typeof checkpoint?.summary === 'string'
        || typeof checkpoint?.checkpointId === 'string'
        || typeof checkpoint?.createdAt === 'number'
      ))
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
    const latest = options.preferSummary
      ? viableCheckpoints.find((checkpoint) => checkpoint.summary?.trim()) ?? viableCheckpoints[0]
      : viableCheckpoints[0];

    if (!latest) {
      return null;
    }

    if (!latest.summary?.trim() && latest.checkpointId) {
      const checkpoint = await client.request<OpenClawCompactionCheckpoint>(
        'sessions.compaction.get',
        { key: sessionKey, checkpointId: latest.checkpointId },
        { timeoutMs: 3_000 },
      );
      return {
        ...latest,
        ...checkpoint,
        checkpointId: checkpoint.checkpointId ?? latest.checkpointId,
        createdAt: checkpoint.createdAt ?? latest.createdAt,
      };
    }

    return latest;
  }

  private recordContextCompactionDiagnostic(diagnostic: ContextCompactionDiagnostic): void {
    console.log(
      `[OpenClawRuntime] recorded safe context compaction diagnostic for session ${diagnostic.sessionId}: `
      + `mode ${diagnostic.mode}, compacted ${diagnostic.compacted ?? 'unknown'}, `
      + `reason ${diagnostic.reason ?? 'none'}, checkpoint ${diagnostic.checkpointId ?? 'none'}, `
      + `created at ${diagnostic.checkpointCreatedAt ?? 'unknown'}, `
      + `summary length ${diagnostic.summaryChars ?? 0} characters, `
      + `has summary ${diagnostic.hasSummary}, `
      + `tokens ${diagnostic.tokensBefore ?? 'unknown'} to ${diagnostic.tokensAfter ?? 'unknown'}.`,
    );
  }

  private async logContextCompactionDiagnostic(input: ContextCompactionDiagnosticInput): Promise<void> {
    const sessionKey = input.sessionKey ?? this.getSessionKeysForSession(input.sessionId)[0];
    if (!sessionKey) {
      console.warn(`[OpenClawRuntime] skipped context compaction diagnostic for session ${input.sessionId} because no OpenClaw session key was available.`);
      return;
    }

    if (input.compacted === false) {
      this.recordContextCompactionDiagnostic({
        sessionId: input.sessionId,
        sessionKey,
        mode: input.mode,
        ...(input.reason ? { reason: input.reason } : {}),
        summaryChars: 0,
        hasSummary: false,
        compacted: false,
        updatedAt: Date.now(),
      });
      return;
    }

    const client = this.gatewayClient;
    if (!client) {
      console.debug(`[OpenClawRuntime] skipped context compaction diagnostic for session ${input.sessionId} because the gateway client is unavailable.`);
      return;
    }

    try {
      const checkpoint = await this.lookupLatestCompactionCheckpoint(client, sessionKey);
      const summary = typeof checkpoint?.summary === 'string' ? checkpoint.summary.trim() : '';
      this.recordContextCompactionDiagnostic({
        sessionId: input.sessionId,
        sessionKey,
        mode: input.mode,
        reason: input.reason ?? checkpoint?.reason,
        checkpointId: checkpoint?.checkpointId,
        checkpointCreatedAt: checkpoint?.createdAt,
        tokensBefore: checkpoint?.tokensBefore,
        tokensAfter: checkpoint?.tokensAfter,
        summaryChars: summary.length,
        hasSummary: summary.length > 0,
        compacted: input.compacted,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.warn(`[OpenClawRuntime] context compaction diagnostic lookup failed for session ${input.sessionId}; continuing without checkpoint metadata.`, error);
    }
  }

  async getForkCompactionSummary(sessionId: string, beforeCreatedAt?: number): Promise<CoworkForkCompactionSummary | null> {
    const client = this.gatewayClient;
    if (!client) {
      console.debug(`[OpenClawRuntime] skipped fork compaction lookup for session ${sessionId} because the gateway client is unavailable.`);
      return null;
    }

    for (const sessionKey of this.getSessionKeysForSession(sessionId)) {
      try {
        const checkpoint = await this.lookupLatestCompactionCheckpoint(client, sessionKey, {
          beforeCreatedAt,
          preferSummary: true,
        });
        if (!checkpoint) {
          continue;
        }

        const summary = checkpoint.summary?.trim();
        if (!summary) {
          continue;
        }

        const truncated = summary.length > FORK_COMPACTION_SUMMARY_MAX_CHARS;
        console.log(`[OpenClawRuntime] found a compaction checkpoint for forked session ${sessionId}.`);
        return {
          summary: truncated ? summary.slice(0, FORK_COMPACTION_SUMMARY_MAX_CHARS) : summary,
          sessionKey,
          ...(checkpoint.checkpointId ? { checkpointId: checkpoint.checkpointId } : {}),
          ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
          ...(typeof checkpoint.createdAt === 'number' ? { createdAt: checkpoint.createdAt } : {}),
          ...(typeof checkpoint.tokensBefore === 'number' ? { tokensBefore: checkpoint.tokensBefore } : {}),
          ...(typeof checkpoint.tokensAfter === 'number' ? { tokensAfter: checkpoint.tokensAfter } : {}),
          ...(truncated ? { truncated } : {}),
        };
      } catch (error) {
        console.warn(`[OpenClawRuntime] fork compaction lookup failed for session ${sessionId}; continuing without a summary.`, error);
        return null;
      }
    }

    console.debug(`[OpenClawRuntime] no compaction checkpoint was available for forked session ${sessionId}.`);
    return null;
  }

  private getContextWindowForModel(modelId: string): number | undefined {
    if (!this.contextWindowCacheLoaded) {
      this.contextWindowCacheLoaded = true;
      try {
        const stateDir = this.engineManager.getStateDir();
        for (const agentDir of ['main', 'a']) {
          const modelsPath = path.join(stateDir, 'agents', agentDir, 'agent', 'models.json');
          if (!fs.existsSync(modelsPath)) continue;
          const config = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
          if (config?.providers && typeof config.providers === 'object') {
            for (const provider of Object.values(config.providers) as any[]) {
              if (!Array.isArray(provider?.models)) continue;
              for (const m of provider.models) {
                if (typeof m?.id === 'string' && typeof m?.contextWindow === 'number') {
                  this.contextWindowCache.set(m.id, m.contextWindow);
                }
              }
            }
          }
        }
      } catch {
        // non-fatal
      }
    }
    if (this.contextWindowCache.has(modelId)) return this.contextWindowCache.get(modelId);
    const slashIdx = modelId.indexOf('/');
    if (slashIdx >= 0) {
      const bare = modelId.slice(slashIdx + 1);
      if (this.contextWindowCache.has(bare)) return this.contextWindowCache.get(bare);
    }
    return undefined;
  }

  private async refreshSessionContextTokens(sessionKey: string): Promise<number | undefined> {
    if (this.sessionContextTokensCache.has(sessionKey)) {
      return this.sessionContextTokensCache.get(sessionKey);
    }
    const client = this.gatewayClient;
    if (!client) return undefined;
    if (this.isGatewayRpcDegraded()) {
      console.debug('[OpenClawRuntime] skipped context token refresh because gateway session RPCs are degraded.');
      return undefined;
    }
    try {
      const result = await client.request<{ sessions?: unknown[] }>('sessions.list', {
        activeMinutes: 60, limit: 50,
      }, { timeoutMs: OpenClawRuntimeAdapter.CONTEXT_USAGE_LIST_TIMEOUT_MS });
      this.markGatewayRpcSuccess();
      const sessions = result?.sessions;
      if (Array.isArray(sessions)) {
        for (const row of sessions) {
          if (isRecord(row)) {
            const k = typeof (row as Record<string, unknown>).key === 'string'
              ? (row as Record<string, unknown>).key as string : '';
            if (k && typeof (row as Record<string, unknown>).contextTokens === 'number') {
              this.sessionContextTokensCache.set(k, (row as Record<string, unknown>).contextTokens as number);
            }
          }
        }
      }
      const resolved = this.sessionContextTokensCache.get(sessionKey);
      console.debug('[OpenClawRuntime] refreshSessionContextTokens:', sessionKey, resolved ? `contextTokens=${resolved}` : 'not found in sessions.list');
      return resolved;
    } catch (error) {
      this.recordGatewayRpcFailure('sessions.list', error);
      console.debug('[OpenClawRuntime] refreshSessionContextTokens failed:', sessionKey, error);
      return undefined;
    }
  }

  constructor(
    store: CoworkStore,
    engineManager: OpenClawEngineManager,
    options: OpenClawRuntimeAdapterOptions = {},
    subagentRunStore?: SubagentRunStore,
    subagentMessageStore?: SubagentMessageStore,
  ) {
    super();
    this.store = store;
    this.engineManager = engineManager;
    this.options = options;
    this.approvalController = new OpenClawApprovalController({
      getGatewayClient: () => this.gatewayClient,
      resolveSessionId: (sessionKey) => this.resolveApprovalSessionId(sessionKey),
      isSessionInStopCooldown: (sessionId) => this.isSessionInStopCooldown(sessionId),
      isManualStopSuppressed: (sessionId, sessionKey) => (
        this.manuallyStoppedSessions.has(sessionId) && isManagedSessionKey(sessionKey)
      ),
      sessionExists: (sessionId) => Boolean(this.store.getSession(sessionId)),
      isSessionActive: (sessionId) => this.isSessionActive(sessionId),
      continueSession: (sessionId, prompt) => this.continueSession(sessionId, prompt),
      emitPermissionRequest: (sessionId, request) => this.emit('permissionRequest', sessionId, request),
      emitError: (sessionId, error) => this.emit('error', sessionId, error),
    });
    if (subagentRunStore) {
      this.subagentTracker = new SubagentTracker(subagentRunStore, subagentMessageStore ?? null, () => this.gatewayClient);
    } else {
      // Fallback: create a no-op tracker (should not happen in production)
      this.subagentTracker = new SubagentTracker(null as unknown as SubagentRunStore, null, () => this.gatewayClient);
    }
  }

  private normalizeModelRef(modelRef: string): string {
    const normalized = modelRef.trim();
    if (!normalized) return normalized;
    return this.options.normalizeModelRef?.(normalized) ?? normalized;
  }

  private resolveAgentDefaultModelRef(session: CoworkSession): string {
    const agent = this.store.getAgent(session.agentId || 'main') as Agent | null;
    const rawModel = agent?.model?.trim() ?? '';
    return rawModel ? this.normalizeModelRef(rawModel) : '';
  }

  private notifySessionModelOverrideChanged(sessionId: string, modelOverride: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CoworkIpcChannel.SessionModelOverrideChanged, {
          sessionId,
          modelOverride,
        });
      }
    }
  }

  private syncChannelSessionModelOverride(options: {
    coworkSessionId: string;
    openClawSessionKey: string;
    state: ChannelSessionModelState | null;
  }): boolean {
    const { coworkSessionId, openClawSessionKey, state } = options;
    if (!state) return false;
    const session = this.store.getSession(coworkSessionId);
    if (!session) return false;

    const normalizedModelRef = state.modelRef ? this.normalizeModelRef(state.modelRef) : '';
    const agentDefaultModel = this.resolveAgentDefaultModelRef(session);
    const nextModelOverride =
      normalizedModelRef && (state.explicitOverride || normalizedModelRef !== agentDefaultModel)
        ? normalizedModelRef
        : '';

    if ((session.modelOverride || '') === nextModelOverride) {
      if (nextModelOverride) {
        this.rememberSessionModelPatch(
          coworkSessionId,
          openClawSessionKey,
          nextModelOverride,
          SessionModelPatchSource.SessionOverride,
        );
      }
      return false;
    }

    this.store.updateSession(
      coworkSessionId,
      { modelOverride: nextModelOverride },
      { touchUpdatedAt: false },
    );
    if (nextModelOverride) {
      this.rememberSessionModelPatch(
        coworkSessionId,
        openClawSessionKey,
        nextModelOverride,
        SessionModelPatchSource.SessionOverride,
      );
    } else {
      this.sessionModelPatchStateBySession.delete(coworkSessionId);
    }
    console.log(
      '[ChannelSync] synced channel session model override.',
      `Session ${coworkSessionId}.`,
      `OpenClaw key ${openClawSessionKey}.`,
      `Source ${state.source}.`,
      `Model ${nextModelOverride || 'agent/default'}.`,
    );
    this.notifySessionModelOverrideChanged(coworkSessionId, nextModelOverride);
    return true;
  }

  private syncChannelSessionRunStatus(options: {
    coworkSessionId: string;
    openClawSessionKey: string;
    row: Record<string, unknown>;
  }): boolean {
    const { coworkSessionId, openClawSessionKey, row } = options;
    const session = this.store.getSession(coworkSessionId);
    if (!session) return false;

    const hasActiveRun =
      row.hasActiveRun === true
        ? true
        : row.hasActiveRun === false
          ? false
          : null;
    const rawStatus = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
    const nextStatus = resolveChannelSessionNextStatus({
      hasActiveRun,
      rawStatus,
      currentStatus: session.status,
    });

    if (!nextStatus || session.status === nextStatus) return false;
    if (nextStatus !== 'running' && this.activeTurns.has(coworkSessionId)) {
      return false;
    }

    this.store.updateSession(coworkSessionId, { status: nextStatus });
    console.log(
      '[ChannelSync] synced channel session run status.',
      `Session ${coworkSessionId}.`,
      `OpenClaw key ${openClawSessionKey}.`,
      `Status ${session.status} -> ${nextStatus}.`,
      `Active run ${hasActiveRun === null ? 'unknown' : String(hasActiveRun)}.`,
    );
    this.emitSessionStatus(coworkSessionId, nextStatus);
    return true;
  }

  setChannelSessionSync(sync: OpenClawChannelSessionSync): void {
    this.channelSessionSync = sync;
  }

  clearChannelSessionCache(): void {
    if (!this.channelSessionSync) {
      return;
    }

    this.channelSessionSync.clearCache();
    for (const [sessionKey] of this.sessionIdBySessionKey.entries()) {
      if (this.channelSessionSync.isChannelSessionKey(sessionKey)) {
        this.sessionIdBySessionKey.delete(sessionKey);
      }
    }
  }

  /**
   * Fetch session history from OpenClaw by sessionKey and return a transient
   * CoworkSession object (not persisted to local database).
   * First checks if a local session already exists via channel sync.
   * Returns a CoworkSession if successful, or null.
   */
  async fetchSessionByKey(
    sessionKey: string,
    options?: { sessionId?: string | null },
  ): Promise<CoworkSession | null> {
    const managedSession = parseManagedSessionKey(sessionKey);
    if (managedSession) {
      return this.store.getSession(managedSession.sessionId) ?? null;
    }

    // 1. Try existing local session via channel/main-agent resolution
    if (this.channelSessionSync) {
      const existingId = this.channelSessionSync.resolveSession(sessionKey);
      if (existingId) {
        const session = this.store.getSession(existingId);
        if (session && session.messages.length > 0) {
          return session;
        }
      }
    }

    // 2. Fetch history from OpenClaw server and build a transient session object
    const client = this.gatewayClient;
    if (!client) {
      return (
        await this.readFromTranscript(sessionKey, options?.sessionId)
        ?? await this.readFromDeletedTranscript(sessionKey, options?.sessionId)
      );
    }

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT,
      }, { timeoutMs: 10_000 });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        return (
          await this.readFromTranscript(sessionKey, options?.sessionId)
          ?? await this.readFromDeletedTranscript(sessionKey, options?.sessionId)
        );
      }

      const now = Date.now();
      const messages: CoworkMessage[] = [];
      let msgIndex = 0;

      for (const entry of extractGatewayHistoryEntries(history.messages)) {
        const mediaMetadata = entry.role === 'user' ? buildGatewayMediaMetadata(entry) : undefined;
        messages.push({
          id: `transient-${msgIndex++}`,
          type: entry.role,
          content: entry.text,
          timestamp: now,
          metadata: entry.role === 'assistant'
            ? { isStreaming: false, isFinal: true }
            : mediaMetadata ?? {},
        });
      }

      if (messages.length === 0) return null;

      // Return a transient session (not saved to database)
      return {
        id: `transient-${sessionKey}`,
        title: sessionKey.split(':').pop() || 'Cron Session',
        claudeSessionId: null,
        status: 'completed' as CoworkSessionStatus,
        pinned: false,
        cwd: '',
        systemPrompt: '',
        modelOverride: '',
        executionMode: 'local' as CoworkExecutionMode,
        activeSkillIds: [],
        messages,
        agentId: 'main',
        createdAt: now,
        updatedAt: now,
        messagesOffset: 0,
        totalMessages: messages.length,
      };
    } catch (error) {
      console.error('[OpenClawRuntime] fetchSessionByKey: failed to fetch history:', error);
      return null;
    }
  }

  /**
   * Fallback for fetchSessionByKey when chat.history returns no messages.
   *
   * openclaw's maintenance logic may archive a session transcript by renaming
   * `{sessionId}.jsonl` → `{sessionId}.jsonl.deleted.{timestamp}` while the
   * session entry remains in sessions.json. In that case chat.history cannot
   * find the file (it only looks for the plain `.jsonl` path) and returns [].
   * This method reads the archived file directly from disk.
   */
  private resolveTranscriptSessionId(sessionKey: string, sessionId?: string | null): string | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (/^[0-9a-f-]{36}$/i.test(normalizedSessionId)) {
      return normalizedSessionId;
    }

    const runMatch = sessionKey.match(/(?:^|:)run:([0-9a-f-]{36})(?:$|:)/i);
    return runMatch?.[1] ?? null;
  }

  private async readTranscriptFile(
    sessionKey: string,
    filePath: string,
  ): Promise<CoworkSession | null> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    const messages: CoworkMessage[] = [];
    let msgIndex = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed?.type !== 'message' || !parsed.message) continue;
        const msg = parsed.message as { role?: string; content?: unknown; timestamp?: number };
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;

        const msgContent = msg.content;
        const text = Array.isArray(msgContent)
          ? (msgContent as Array<Record<string, unknown>>)
              .filter(b => b?.type === 'text')
              .map(b => b.text as string)
              .join('\n')
          : typeof msgContent === 'string' ? msgContent : '';

        if (!text.trim()) continue;

        const timestamp = typeof msg.timestamp === 'number'
          ? msg.timestamp
          : typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Date.now();

        messages.push({
          id: `transient-${msgIndex++}`,
          type: role as 'user' | 'assistant',
          content: text,
          timestamp,
          metadata: role === 'assistant' ? { isStreaming: false, isFinal: true } : {},
        });
      } catch {
        // skip malformed lines
      }
    }

    if (messages.length === 0) return null;

    const firstTimestamp = messages[0]?.timestamp ?? Date.now();
    return {
      id: `transient-${sessionKey}`,
      agentId: '',
      title: sessionKey.split(':').pop() || 'Cron Session',
      claudeSessionId: null,
      status: 'completed' as CoworkSessionStatus,
      pinned: false,
      cwd: '',
      systemPrompt: '',
      modelOverride: '',
      executionMode: 'local' as CoworkExecutionMode,
      activeSkillIds: [],
      messages,
      messagesOffset: 0,
      totalMessages: messages.length,
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    };
  }

  private async readFromTranscript(
    sessionKey: string,
    sessionId?: string | null,
  ): Promise<CoworkSession | null> {
    try {
      const agentMatch = sessionKey.match(/^agent:([^:]+):/);
      const agentId = agentMatch?.[1] ?? 'main';
      const resolvedSessionId = this.resolveTranscriptSessionId(sessionKey, sessionId);
      if (!resolvedSessionId) return null;

      const stateDir = this.engineManager.getStateDir();
      const filePath = path.join(
        stateDir,
        'agents',
        agentId,
        'sessions',
        `${resolvedSessionId}.jsonl`,
      );

      if (!fs.existsSync(filePath)) {
        console.log('[OpenClawRuntime] readFromTranscript: no transcript found for sessionId:', resolvedSessionId);
        return null;
      }

      console.log('[OpenClawRuntime] readFromTranscript: reading transcript:', filePath);
      return await this.readTranscriptFile(sessionKey, filePath);
    } catch (error) {
      console.warn('[OpenClawRuntime] readFromTranscript failed:', error);
      return null;
    }
  }

  private async readFromDeletedTranscript(
    sessionKey: string,
    sessionId?: string | null,
  ): Promise<CoworkSession | null> {
    try {
      // Extract agentId from "agent:{agentId}:..." pattern
      const agentMatch = sessionKey.match(/^agent:([^:]+):/);
      const agentId = agentMatch?.[1] ?? 'main';

      const resolvedSessionId = this.resolveTranscriptSessionId(sessionKey, sessionId);
      if (!resolvedSessionId) return null;

      const stateDir = this.engineManager.getStateDir();
      const sessionsDir = path.join(stateDir, 'agents', agentId, 'sessions');

      const files = await fs.promises.readdir(sessionsDir).catch(() => [] as string[]);
      const deletedFile = files.find(f => f.startsWith(`${resolvedSessionId}.jsonl.deleted.`));
      if (!deletedFile) {
        console.log('[OpenClawRuntime] readFromDeletedTranscript: no archived transcript found for sessionId:', resolvedSessionId);
        return null;
      }

      console.log('[OpenClawRuntime] readFromDeletedTranscript: reading archived transcript:', deletedFile);
      const filePath = path.join(sessionsDir, deletedFile);
      return await this.readTranscriptFile(sessionKey, filePath);
    } catch (error) {
      console.warn('[OpenClawRuntime] readFromDeletedTranscript failed:', error);
      return null;
    }
  }

  /**
   * Ensure the gateway WebSocket client is connected.
   * Called when IM channels (e.g. Telegram) are enabled in OpenClaw mode
   * so that channel-originated events can be received without waiting
   * for a LobsterAI-initiated session.
   */
  async connectGatewayIfNeeded(): Promise<void> {
    this.gatewayReconnectSuppressed = false;
    if (this.gatewayClient) {
      console.log('[ChannelSync] connectGatewayIfNeeded: gateway client already exists, skipping');
      return;
    }
    console.log('[ChannelSync] connectGatewayIfNeeded: no gateway client, initializing...');
    try {
      await this.ensureGatewayClientReady();
      console.log('[ChannelSync] connectGatewayIfNeeded: gateway client ready, starting channel polling');
      this.startChannelPolling();
    } catch (error) {
      console.error('[ChannelSync] connectGatewayIfNeeded: failed to initialize gateway client:', error);
      throw error;
    }
  }

  /**
   * Force-reconnect the gateway WebSocket client.
   * Used after the OpenClaw gateway process has been restarted (e.g. after config sync).
   * Unlike `connectGatewayIfNeeded`, this always tears down the old client first
   * to avoid a race where the old client's `onClose` fires after a new client is created.
   */
  async reconnectGateway(): Promise<void> {
    console.log('[ChannelSync] reconnectGateway: tearing down old client and reconnecting...');
    this.gatewayReconnectSuppressed = false;
    this.stopGatewayClient();
    try {
      await this.ensureGatewayClientReady();
      console.log('[ChannelSync] reconnectGateway: gateway client ready, starting channel polling');
      this.startChannelPolling();
    } catch (error) {
      console.error('[ChannelSync] reconnectGateway: failed to initialize gateway client:', error);
      throw error;
    }
  }

  /**
   * Explicitly disconnect the gateway WebSocket client.
   * Called before the OpenClaw gateway process is restarted so that the old
   * client's async `onClose` handler cannot interfere with a subsequently
   * created client.
   */
  disconnectGatewayClient(): void {
    console.log('[ChannelSync] disconnectGatewayClient: explicitly tearing down gateway client');
    this.gatewayReconnectSuppressed = true;
    this.stopGatewayClient();
  }


  /**
   * Start periodic polling for channel-originated sessions (e.g. Telegram).
   * Uses the gateway `sessions.list` RPC to discover sessions that may not
   * have been delivered via WebSocket events.
   */
  startChannelPolling(): void {
    if (!this.channelSessionSync) {
      console.warn('[ChannelSync] startChannelPolling: no channelSessionSync set, skipping');
      return;
    }
    // Already running
    if (this.channelPollingTimer) { console.log('[ChannelSync] startChannelPolling: already running, skipping'); return; }

    console.log('[ChannelSync] startChannelPolling: starting periodic channel session discovery');
    // Run once immediately, then at interval
    void this.pollChannelSessions();
    this.channelPollingTimer = setInterval(() => {
      void this.pollChannelSessions();
    }, OpenClawRuntimeAdapter.CHANNEL_POLL_INTERVAL_MS);
  }

  stopChannelPolling(): void {
    if (this.channelPollingTimer) {
      clearInterval(this.channelPollingTimer);
      this.channelPollingTimer = null;
    }
  }

  private async pollChannelSessions(): Promise<void> {
    if (!this.gatewayClient || !this.channelSessionSync) {
      console.warn('[ChannelSync] pollChannelSessions: skipped — gatewayClient:', !!this.gatewayClient, 'channelSessionSync:', !!this.channelSessionSync);
      return;
    }
    if (this.isGatewayRpcDegraded()) {
      console.debug('[ChannelSync] skipped channel session polling because gateway session RPCs are degraded.');
      return;
    }
    try {
      const params = { activeMinutes: 60, limit: CHANNEL_SESSION_DISCOVERY_LIMIT };
      const result = await this.gatewayClient.request('sessions.list', params, {
        timeoutMs: OpenClawRuntimeAdapter.CONTEXT_USAGE_LIST_TIMEOUT_MS,
      });
      this.markGatewayRpcSuccess();
      const sessions = (result as Record<string, unknown>)?.sessions;
      if (!Array.isArray(sessions)) {
        console.warn('[ChannelSync] pollChannelSessions: sessions.list returned non-array sessions:', typeof sessions, 'full result keys:', Object.keys(result as Record<string, unknown>));
        return;
      }
      let hasNew = false;
      let channelCount = 0;
      const newSessionsToSync: Array<{ sessionId: string; sessionKey: string }> = [];
      for (const row of sessions) {
        const key = typeof row?.key === 'string' ? row.key : '';
        if (!key) continue;

        // Cache contextTokens for all sessions returned by sessions.list
        if (isRecord(row) && typeof (row as Record<string, unknown>).contextTokens === 'number') {
          this.sessionContextTokensCache.set(key, (row as Record<string, unknown>).contextTokens as number);
        }
        if (isRecord(row)) {
          this.syncGoalFromSessionRow(row as Record<string, unknown>);
        }
        // Skip heartbeat-originated sessions (origin.label === 'heartbeat')
        if (isRecord(row)) {
          const rowOrigin = (row as Record<string, unknown>).origin;
          if (isRecord(rowOrigin) && (rowOrigin as Record<string, unknown>).label === 'heartbeat') {
            this.heartbeatSessionKeys.add(key);
            continue;
          }
        }
        const isChannel = this.channelSessionSync.isChannelSessionKey(key);
        if (!isChannel) continue;
        // Skip keys that were explicitly deleted by the user — only real-time events re-create them
        if (this.deletedChannelKeys.has(key)) continue;
        // Skip gateway sessions belonging to a previously-bound agent.
        // After an agent binding change, the gateway retains old sessions under the old agentId.
        // Only process sessions matching the current platformAgentBindings.
        if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
        channelCount++;
        // Use resolveOrCreateSession so new channel sessions are auto-created
        const sessionId = this.channelSessionSync.resolveOrCreateSession(key);
        if (sessionId && isRecord(row)) {
          this.syncChannelSessionRunStatus({
            coworkSessionId: sessionId,
            openClawSessionKey: key,
            row: row as Record<string, unknown>,
          });
          this.syncChannelSessionModelOverride({
            coworkSessionId: sessionId,
            openClawSessionKey: key,
            state: extractChannelSessionModelStateFromRow(row as Record<string, unknown>),
          });
        }
        if (sessionId && isRecord(row) && Object.prototype.hasOwnProperty.call(row, 'goal')) {
          this.emitGoalUpdateIfChanged(sessionId, normalizeCoworkGoal((row as Record<string, unknown>).goal));
        }
        if (sessionId && !this.knownChannelSessionIds.has(sessionId)) {
          this.knownChannelSessionIds.add(sessionId);
          this.rememberSessionKey(sessionId, key);
          hasNew = true;
          // Queue full history sync for newly discovered sessions
          if (!this.fullySyncedSessions.has(sessionId)) {
            newSessionsToSync.push({ sessionId, sessionKey: key });
          }
        }
      }
      if (hasNew) {
        let notified = 0;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('cowork:sessions:changed');
            notified++;
          }
        }
        console.log('[ChannelSync] discovered', channelCount, 'channel sessions, notified', notified, 'windows');
      }
      // Sync full history for newly discovered sessions
      for (const { sessionId, sessionKey } of newSessionsToSync) {
        await this.syncFullChannelHistory(sessionId, sessionKey);
      }

      // Incremental sync for already-known sessions: check if the gateway has messages
      // that weren't picked up during initial sync or real-time events.
      if (channelCount > 0) {
        const syncedThisCycle = new Set<string>();
        for (const row of sessions) {
          const key = typeof row?.key === 'string' ? row.key : '';
          if (!key) continue;
          if (!this.channelSessionSync.isChannelSessionKey(key)) continue;
          if (this.deletedChannelKeys.has(key)) continue;
          if (this.heartbeatSessionKeys.has(key)) continue;
          // Skip sessions belonging to a previously-bound agent
          if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
          const sessionId = this.sessionIdBySessionKey.get(key);
          if (!sessionId || !this.fullySyncedSessions.has(sessionId)) continue;
          // Safety net: only sync each sessionId once per poll cycle
          if (syncedThisCycle.has(sessionId)) continue;
          syncedThisCycle.add(sessionId);
          // Skip sessions with an active turn (they handle their own sync)
          if (this.activeTurns.has(sessionId)) continue;
          try {
            await this.incrementalChannelSync(sessionId, key);
          } catch (err) {
            console.warn('[ChannelSync] incremental sync failed for', key, err);
          }
        }
      }
    } catch (error) {
      this.recordGatewayRpcFailure('sessions.list', error);
      if (this.isGatewayRequestTimeout(error, 'sessions.list')) {
        console.warn('[ChannelSync] channel session polling timed out; polling will back off temporarily:', error);
        return;
      }
      console.error('[ChannelSync] pollChannelSessions: error during polling:', error);
    }
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(sessionId: string, prompt: string, options: CoworkStartOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: options.skipInitialUserMessage,
      skillIds: options.skillIds,
      messageSkillIds: options.messageSkillIds,
      kitIds: options.kitIds,
      kitReferences: options.kitReferences,
      resolvedKitCapabilities: options.resolvedKitCapabilities,
      systemPrompt: options.systemPrompt,
      confirmationMode: options.confirmationMode,
      imageAttachments: options.imageAttachments,
      agentId: options.agentId,
      mediaSelection: options.mediaSelection,
      mediaReferences: options.mediaReferences,
      selectedTextSnippets: options.selectedTextSnippets,
    });
  }

  async continueSession(sessionId: string, prompt: string, options: CoworkContinueOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: options.skipInitialUserMessage ?? false,
      systemPrompt: options.systemPrompt,
      skillIds: options.skillIds,
      messageSkillIds: options.messageSkillIds,
      kitIds: options.kitIds,
      kitReferences: options.kitReferences,
      resolvedKitCapabilities: options.resolvedKitCapabilities,
      imageAttachments: options.imageAttachments,
      mediaSelection: options.mediaSelection,
      mediaReferences: options.mediaReferences,
      selectedTextSnippets: options.selectedTextSnippets,
    });
  }

  async runGoalCommand(sessionId: string, command: string): Promise<CoworkGoal | null> {
    const parsed = parseOpenClawGoalCommand(command);
    if (!parsed) {
      throw new Error('Invalid goal command.');
    }

    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const agentId = session.agentId || 'main';
    const activeTurnSessionKey = this.activeTurns.get(sessionId)?.sessionKey?.trim();
    const rememberedSessionKey = this.getSessionKeysForSession(sessionId)
      .find((key) => !isManagedSessionKey(key));
    const persistedChannelSession = this.channelSessionSync
      ?.getOpenClawSessionKeyForCoworkSession(sessionId);
    const persistedChannelSessionKey = persistedChannelSession?.sessionKey
      && !isManagedSessionKey(persistedChannelSession.sessionKey)
      ? persistedChannelSession.sessionKey
      : '';
    const sessionKey = activeTurnSessionKey
      || rememberedSessionKey
      || persistedChannelSessionKey
      || this.toSessionKey(sessionId, agentId);
    this.rememberSessionKey(sessionId, sessionKey);

    console.debug(
      '[OpenClawRuntime] running goal command.',
      `Session ${sessionId}.`,
      `OpenClaw key ${sessionKey}.`,
      `Action ${parsed.action}.`,
      `Active ${this.activeTurns.has(sessionId) ? 'yes' : 'no'}.`,
    );
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const response = await client.request<{ ok?: boolean; goal?: unknown }>('sessions.goal', {
      key: sessionKey,
      action: parsed.action,
      text: parsed.text,
    }, { timeoutMs: OpenClawRuntimeAdapter.SESSION_PATCH_TIMEOUT_MS });
    const goal = normalizeCoworkGoal(response?.goal);
    this.emitGoalUpdateIfChanged(sessionId, goal);
    this.addGoalSettingUserMessageFromCommand(sessionId, parsed);

    const shouldContinueForGoalAction =
      parsed.action === 'start'
      || parsed.action === 'create'
      || parsed.action === 'set'
      || parsed.action === 'resume';
    if (!shouldContinueForGoalAction) {
      this.pendingGoalContinuations.delete(sessionId);
    }
    if (shouldContinueForGoalAction) {
      const continuationPrompt = parsed.action === 'resume'
        ? formatGoalResumeContinuationPrompt(parsed.text)
        : formatGoalContinuationPrompt(goal?.objective || parsed.text);
      if (continuationPrompt.trim()) {
        const pendingContinuation: PendingGoalContinuation = {
          action: parsed.action,
          prompt: continuationPrompt,
          skipInitialUserMessage: GOAL_BOOTSTRAP_ACTIONS.has(parsed.action),
          systemPrompt: session.systemPrompt,
        };
        if (this.activeTurns.has(sessionId)) {
          this.pendingGoalContinuations.set(sessionId, pendingContinuation);
          console.debug(
            '[OpenClawRuntime] queued goal continuation until active turn completes.',
            `Session ${sessionId}.`,
            `Action ${parsed.action}.`,
          );
          return goal;
        }
        console.debug(
          '[OpenClawRuntime] continuing after goal command.',
          `Session ${sessionId}.`,
          `Action ${parsed.action}.`,
        );
        void this.continueSession(sessionId, pendingContinuation.prompt, {
          skipInitialUserMessage: pendingContinuation.skipInitialUserMessage,
          systemPrompt: pendingContinuation.systemPrompt,
        })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[OpenClawRuntime] failed to continue after goal command:', error);
            this.store.updateSession(sessionId, { status: 'error' });
            this.emit('error', sessionId, message);
          });
      }
    }
    return goal;
  }

  async patchSession(sessionId: string, patch: OpenClawSessionPatch): Promise<CoworkSessionPatchResult> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const activeTurnSessionKey = this.activeTurns.get(sessionId)?.sessionKey?.trim();
    const rememberedSessionKey = this.getSessionKeysForSession(sessionId)
      .find((key) => !isManagedSessionKey(key));
    const persistedChannelSession = this.channelSessionSync
      ?.getOpenClawSessionKeyForCoworkSession(sessionId);
    const persistedChannelSessionKey = persistedChannelSession?.sessionKey
      && !isManagedSessionKey(persistedChannelSession.sessionKey)
      ? persistedChannelSession.sessionKey
      : '';
    const agentId = session.agentId || 'main';
    const sessionKey = activeTurnSessionKey
      || rememberedSessionKey
      || persistedChannelSessionKey;
    if (!sessionKey && persistedChannelSession?.isChannelSession) {
      throw new Error('Cannot patch IM channel session because the OpenClaw session key is missing.');
    }
    const targetSessionKey = sessionKey || this.toSessionKey(sessionId, agentId);
    this.rememberSessionKey(sessionId, targetSessionKey);
    await this.ensureGatewayClientReady();

    const normalizedPatch: OpenClawSessionPatch = {
      ...patch,
      ...(patch.model !== undefined
        ? { model: patch.model ? this.normalizeModelRef(patch.model) : patch.model }
        : {}),
    };

    const sendPatch = async (): Promise<OpenClawSessionPatchGatewayResult | undefined> => {
      try {
        const response = await this.requestSessionPatchWithProfile({
          sessionId,
          sessionKey: targetSessionKey,
          patch: normalizedPatch,
          source: 'patchSession',
          reason: 'user-requested session patch',
          timeoutMs: OpenClawRuntimeAdapter.SESSION_PATCH_TIMEOUT_MS,
        });
        this.markGatewayRpcSuccess();
        return response;
      } catch (error) {
        this.recordGatewayRpcFailure('sessions.patch', error);
        throw error;
      }
    };

    if (normalizedPatch.model !== undefined) {
      let response: OpenClawSessionPatchGatewayResult | undefined;
      await this.enqueueSessionModelPatch(sessionId, async () => {
        response = await sendPatch();
      });
      const modelOverride = extractModelOverrideFromPatchResult(
        response,
        typeof normalizedPatch.model === 'string' ? normalizedPatch.model : null,
      );
      if (typeof modelOverride === 'string' && modelOverride) {
        this.rememberSessionModelPatch(
          sessionId,
          targetSessionKey,
          modelOverride,
          SessionModelPatchSource.SessionOverride,
        );
      } else {
        this.sessionModelPatchStateBySession.delete(sessionId);
      }
      return { modelOverride: modelOverride ?? '' };
    }

    await sendPatch();
    return {};
  }

  stopSession(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.stopRequested = true;
      this.manuallyStoppedSessions.add(sessionId);
      this.finalizeStoppedStreamingMessages(sessionId, turn);
      const client = this.gatewayClient;
      if (client) {
        console.log(`[OpenClawRuntime] user requested stop, aborting gateway run ${turn.runId}.`);
        void client.request('chat.abort', {
          sessionKey: turn.sessionKey,
          runId: turn.runId,
        }).catch((error) => {
          console.warn('[OpenClawRuntime] Failed to abort chat run:', error);
        });
      }
    } else {
      console.log(
        '[OpenClawRuntime] received stop before a gateway run became active.',
        `Session ${sessionId}.`,
      );
    }

    // Record the stop timestamp so that late-arriving gateway events
    // (e.g. from POPO/Telegram channels) don't re-create the ActiveTurn.
    this.stoppedSessions.set(sessionId, Date.now());

    this.cleanupSessionTurn(sessionId);
    this.approvalController.clearBySession(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emitSessionStatus(sessionId, 'idle');
    this.emit('sessionStopped', sessionId);
    this.resolveTurn(sessionId);
  }

  private cancelTurnStartupIfStopped(sessionId: string, checkpoint: string): boolean {
    if (!this.stoppedSessions.has(sessionId)) {
      return false;
    }
    console.log(
      '[OpenClawRuntime] cancelled turn startup after user stop.',
      `Session ${sessionId}.`,
      `Checkpoint ${checkpoint}.`,
    );
    this.cleanupSessionTurn(sessionId);
    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emitSessionStatus(sessionId, 'idle');
    this.resolveTurn(sessionId);
    return true;
  }

  stopAllSessions(): void {
    const activeSessionIds = Array.from(this.activeTurns.keys());
    activeSessionIds.forEach((sessionId) => {
      this.stopSession(sessionId);
    });
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    this.approvalController.respondToPermission(requestId, result);
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  hasActiveSessions(): boolean {
    return this.activeTurns.size > 0;
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.confirmationModeBySession.get(sessionId) ?? null;
  }

  private async enqueueSessionModelPatch(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.sessionModelPatchQueue.get(sessionId) ?? Promise.resolve();
    const next = previous.catch((): void => undefined).then(task);
    this.sessionModelPatchQueue.set(sessionId, next);

    try {
      await next;
    } finally {
      if (this.sessionModelPatchQueue.get(sessionId) === next) {
        this.sessionModelPatchQueue.delete(sessionId);
      }
    }
  }

  private async ensureSessionModelForTurn(options: {
    sessionId: string;
    sessionKey: string;
    model: string;
    source: SessionModelPatchSource;
  }): Promise<void> {
    const { sessionId, sessionKey, model, source } = options;
    if (!model) {
      this.sessionModelPatchStateBySession.delete(sessionId);
      return;
    }

    const confirmedState = this.getConfirmedSessionModelPatch(sessionId, sessionKey, model, source);
    if (source === SessionModelPatchSource.AgentModel && confirmedState) {
      console.debug(
        '[OpenClawRuntime] skipped sessions.patch before chat.send because the agent model is already confirmed.',
        `Session ${sessionId}.`,
        `OpenClaw key ${sessionKey}.`,
        `Model ${model}.`,
      );
      return;
    }
    if (confirmedState && this.isGatewayRpcDegraded()) {
      console.warn(
        '[OpenClawRuntime] skipped redundant sessions.patch before chat.send because gateway session RPCs are degraded.',
        `Session ${sessionId}.`,
        `OpenClaw key ${sessionKey}.`,
        `Model ${model}.`,
        `Source ${source}.`,
      );
      return;
    }

    try {
      await this.enqueueSessionModelPatch(sessionId, async () => {
        const currentConfirmedState = this.getConfirmedSessionModelPatch(sessionId, sessionKey, model, source);
        if (source === SessionModelPatchSource.AgentModel && currentConfirmedState) {
          console.debug(
            '[OpenClawRuntime] skipped queued sessions.patch before chat.send because the agent model is already confirmed.',
            `Session ${sessionId}.`,
            `OpenClaw key ${sessionKey}.`,
            `Model ${model}.`,
          );
          return;
        }
        if (currentConfirmedState && this.isGatewayRpcDegraded()) {
          console.warn(
            '[OpenClawRuntime] skipped queued redundant sessions.patch before chat.send because gateway session RPCs are degraded.',
            `Session ${sessionId}.`,
            `OpenClaw key ${sessionKey}.`,
            `Model ${model}.`,
            `Source ${source}.`,
          );
          return;
        }

        await this.requestSessionPatchWithProfile({
          sessionId,
          sessionKey,
          patch: { model },
          source,
          reason: 'model sync before chat.send',
          timeoutMs: OpenClawRuntimeAdapter.SESSION_PATCH_SEND_TIMEOUT_MS,
        });
        this.markGatewayRpcSuccess();
        this.rememberSessionModelPatch(sessionId, sessionKey, model, source);
      });
    } catch (error) {
      this.recordGatewayRpcFailure('sessions.patch', error);
      console.warn('[OpenClawRuntime] failed to patch the session model before chat.send:', error);
      const confirmedAfterFailure = this.getConfirmedSessionModelPatch(sessionId, sessionKey, model, source);
      if (confirmedAfterFailure && this.isGatewayRequestTimeout(error, 'sessions.patch')) {
        console.warn(`[OpenClawRuntime] continuing chat.send for session ${sessionId} after a redundant session model patch timed out.`);
        return;
      }
      this.sessionModelPatchStateBySession.delete(sessionId);
      if (source === SessionModelPatchSource.SessionOverride) {
        throw error;
      }
    }
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    options: {
      skipInitialUserMessage?: boolean;
      systemPrompt?: string;
      skillIds?: string[];
      messageSkillIds?: string[];
      kitIds?: string[];
      kitReferences?: KitReference[];
      resolvedKitCapabilities?: ResolvedKitCapabilities;
      confirmationMode?: 'modal' | 'text';
      imageAttachments?: CoworkImageAttachment[];
      agentId?: string;
      mediaSelection?: CoworkMediaSelection;
      mediaReferences?: CoworkMediaAttachmentRef[];
      selectedTextSnippets?: CoworkSelectedTextSnippet[];
    },
  ): Promise<void> {
    if (!prompt.trim() && (!options.imageAttachments || options.imageAttachments.length === 0)) {
      throw new Error('Prompt is required.');
    }
    const imageAttachmentValidation = validateRuntimeImageAttachments(options.imageAttachments);
    if (imageAttachmentValidation.ok === false) {
      throw new Error(imageAttachmentValidation.error);
    }
    const firstResponseTiming: FirstResponseTiming = { turnStartedAtMs: Date.now() };
    console.log(
      '[OpenClawRuntimeTiming] turn started.',
      `Session ${sessionId}.`,
      `Prompt length ${prompt.length}.`,
      `Image attachments ${options.imageAttachments?.length ?? 0}.`,
    );
    // Clear stop cooldown when user explicitly starts/continues a session
    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`Session ${sessionId} is still running.`);
    }

    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const confirmationMode = options.confirmationMode
      ?? this.confirmationModeBySession.get(sessionId)
      ?? 'modal';
    this.confirmationModeBySession.set(sessionId, confirmationMode);

    if (!options.skipInitialUserMessage) {
      const messageSkillIds = options.messageSkillIds ?? options.skillIds;
      const imageAttachmentPreviews = buildCoworkImageAttachmentPreviews(options.imageAttachments);
      const goalSettingMetadata = buildGoalSettingMessageMetadata(prompt);
      const metadata = (
        messageSkillIds?.length
        || options.kitIds?.length
        || imageAttachmentPreviews?.length
        || options.selectedTextSnippets?.length
        || goalSettingMetadata
      )
        ? {
          ...goalSettingMetadata,
          ...(messageSkillIds?.length ? { skillIds: messageSkillIds } : {}),
          ...(options.kitIds?.length ? {
            kitIds: options.kitIds,
            ...(options.kitReferences?.length ? { kitReferences: options.kitReferences } : {}),
            ...(options.resolvedKitCapabilities ? { resolvedKitCapabilities: options.resolvedKitCapabilities } : {}),
          } : {}),
          ...(imageAttachmentPreviews?.length ? { imageAttachmentPreviews } : {}),
          ...(options.selectedTextSnippets?.length ? { selectedTextSnippets: options.selectedTextSnippets } : {}),
        }
        : undefined;
      if (options.selectedTextSnippets?.length) {
        console.log(
          `[OpenClawRuntime] persisted ${options.selectedTextSnippets.length} selected text excerpts in `
          + `local metadata for session ${sessionId}`,
        );
      }
      const userMessage = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata,
      });
      this.refreshContinuityCapsule(sessionId, ContinuityCapsuleSource.UserMessage, {
        sourceMessageId: userMessage.id,
      });
      this.emit('message', sessionId, userMessage);
    }

    const agentId = options.agentId || session.agentId || 'main';
    const sessionKey = this.toSessionKey(sessionId, agentId);
    this.rememberSessionKey(sessionId, sessionKey);
    const parsedGoalBootstrapCommand = parseOpenClawGoalCommand(prompt);
    const goalBootstrapCommand = shouldBootstrapGoalFromPrompt(parsedGoalBootstrapCommand)
      ? parsedGoalBootstrapCommand
      : null;
    let effectivePrompt = prompt;

    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    setCoworkProxySessionId(sessionId);
    firstResponseTiming.gatewayReadyStartedAtMs = Date.now();
    await this.ensureGatewayClientReady();
    if (this.cancelTurnStartupIfStopped(sessionId, 'gateway client became ready')) {
      return;
    }
    firstResponseTiming.gatewayReadyEndedAtMs = Date.now();
    console.log(
      '[OpenClawRuntimeTiming] gateway client ready.',
      `Session ${sessionId}.`,
      `Elapsed ${formatTimingDuration(firstResponseTiming.gatewayReadyStartedAtMs, firstResponseTiming.gatewayReadyEndedAtMs)}.`,
      `Total ${formatTimingOffset(firstResponseTiming.turnStartedAtMs, firstResponseTiming.gatewayReadyEndedAtMs)}.`,
    );
    this.startChannelPolling();

    const runId = randomUUID();
    const turnToken = this.nextTurnToken(sessionId);

    const agent = this.store.getAgent(agentId);
    const rawCurrentModel = session.modelOverride || agent?.model || '';
    // Normalize only agent-level model refs (may need provider migration).
    // Session modelOverride is user-selected and must not be rewritten.
    const currentModel = session.modelOverride
      ? rawCurrentModel
      : (rawCurrentModel ? this.normalizeModelRef(rawCurrentModel) : '');
    if (!session.modelOverride && currentModel && currentModel !== rawCurrentModel && agent?.id) {
      this.store.updateAgent(agent.id, { model: currentModel });
    }
    try {
      firstResponseTiming.modelPatchStartedAtMs = Date.now();
      await this.ensureSessionModelForTurn({
        sessionId,
        sessionKey,
        model: currentModel,
        source: session.modelOverride
          ? SessionModelPatchSource.SessionOverride
          : SessionModelPatchSource.AgentModel,
      });
      if (this.cancelTurnStartupIfStopped(sessionId, 'session model sync finished')) {
        return;
      }
      firstResponseTiming.modelPatchEndedAtMs = Date.now();
      console.log(
        '[OpenClawRuntimeTiming] session model sync finished.',
        `Session ${sessionId}.`,
        `Model ${currentModel || 'none'}.`,
        `Elapsed ${formatTimingDuration(firstResponseTiming.modelPatchStartedAtMs, firstResponseTiming.modelPatchEndedAtMs)}.`,
        `Total ${formatTimingOffset(firstResponseTiming.turnStartedAtMs, firstResponseTiming.modelPatchEndedAtMs)}.`,
      );
    } catch (error) {
      this.store.updateSession(sessionId, { status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', sessionId, message);
      throw error;
    }

    // The model sync may wait up to SESSION_PATCH_SEND_TIMEOUT_MS on a slow
    // gateway. stoppedSessions was cleared at turn start, so an entry here
    // means the user stopped the session while we were waiting.
    if (this.stoppedSessions.has(sessionId)) {
      console.log(`[OpenClawRuntime] turn aborted after model sync because the user stopped session ${sessionId} while waiting.`);
      return;
    }

    if (shouldBootstrapGoalFromPrompt(goalBootstrapCommand)) {
      try {
        const client = this.requireGatewayClient();
        console.debug(
          '[OpenClawRuntime] bootstrapping goal before first turn.',
          `Session ${sessionId}.`,
          `OpenClaw key ${sessionKey}.`,
          `Action ${goalBootstrapCommand.action}.`,
        );
        const response = await client.request<{ ok?: boolean; goal?: unknown }>('sessions.goal', {
          key: sessionKey,
          action: goalBootstrapCommand.action,
          text: goalBootstrapCommand.text,
        }, { timeoutMs: OpenClawRuntimeAdapter.SESSION_PATCH_TIMEOUT_MS });
        const goal = normalizeCoworkGoal(response?.goal);
        this.emitGoalUpdateIfChanged(sessionId, goal);
        effectivePrompt = formatGoalContinuationPrompt(goal?.objective || goalBootstrapCommand.text);
      } catch (error) {
        console.error('[OpenClawRuntime] failed to bootstrap goal before first turn:', error);
        this.store.updateSession(sessionId, { status: 'error' });
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', sessionId, message);
        throw error;
      }
    }

    const systemPromptText = options.systemPrompt ?? session.systemPrompt ?? '';
    const hasMediaSkillActive = /\bseedream\b|\bseedance\b/i.test(systemPromptText);
    const planModeExecutionApproved = containsPlanModePrompt(systemPromptText)
      && isPlanImplementationApproval(effectivePrompt)
      && sessionHasProposedPlan(session.messages);
    const outboundSystemPrompt = [
      systemPromptText,
      planModeExecutionApproved ? buildPlanModeExecutionOverridePrompt() : '',
      buildMediaGenerationTurnInstruction(options.mediaSelection, hasMediaSkillActive),
    ].filter(p => p?.trim()).join('\n\n');
    const planMode = isPlanModeSystemPrompt(outboundSystemPrompt);
    if (planModeExecutionApproved) {
      console.log(
        `[OpenClawRuntime] exited plan mode for an approved implementation in session ${sessionId}.`,
      );
    }

    firstResponseTiming.promptBuildStartedAtMs = Date.now();
    const outboundMessage = await this.buildOutboundPrompt(
      sessionId,
      effectivePrompt,
      outboundSystemPrompt,
      agentId,
      options.mediaReferences,
      options.selectedTextSnippets,
      firstResponseTiming,
    );
    if (this.cancelTurnStartupIfStopped(sessionId, 'outbound prompt built')) {
      return;
    }
    firstResponseTiming.promptBuildEndedAtMs = Date.now();
    console.log(
      '[OpenClawRuntimeTiming] outbound prompt built.',
      `Session ${sessionId}.`,
      `Message length ${outboundMessage.length}.`,
      `System prompt length ${outboundSystemPrompt.length}.`,
      `Elapsed ${formatTimingDuration(firstResponseTiming.promptBuildStartedAtMs, firstResponseTiming.promptBuildEndedAtMs)}.`,
      `Total ${formatTimingOffset(firstResponseTiming.turnStartedAtMs, firstResponseTiming.promptBuildEndedAtMs)}.`,
    );
    const runCwd = session.cwd?.trim() ? path.resolve(session.cwd.trim()) : undefined;
    const completionPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurns.set(sessionId, { resolve, reject });
    });
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId,
      model: currentModel,
      turnToken,
      planMode,
      knownRunIds: new Set([runId]),
      assistantMessageId: null,
      committedAssistantText: '',
      lastCommittedAssistantMessageId: null,
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      hasSeenAgentAssistantStream: false,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      mediaStatusPollCountByToolCallId: new Map(),
      mediaStatusPollCountByTaskId: new Map(),
      mediaStatusPollBaseByToolCallId: new Map(),
      contextMaintenanceToolCallIds: new Set(),
      planModeSuppressedToolCallIds: new Set(),
      startedAtMs: Date.now(),
      firstResponseTiming,
      stopRequested: false,
      thinkingMessageId: null,
      currentThinkingText: '',
      pendingUserSync: false,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
    });
    this.sessionIdByRunId.set(runId, sessionId);

    // Start client-side timeout watchdog.
    // OpenClaw gateway has a known issue where embedded run timeouts may not
    // produce a WS abort/final event (the subscription is torn down before the
    // lifecycle event fires). This timer fires slightly after the server-side
    // timeout to recover the UI from a stuck "running" state.
    this.startTurnTimeoutWatchdog(sessionId);

    const client = this.requireGatewayClient();
    try {
      console.log('[OpenClawRuntime] chat.send params:', { sessionKey, messageLength: outboundMessage.length, runId });
      console.log('[OpenClawRuntime] chat.send imageAttachments diagnosis:', {
        hasImageAttachments: !!options.imageAttachments,
        imageAttachmentsCount: options.imageAttachments?.length ?? 0,
        imageAttachmentsDetail: options.imageAttachments?.map(img => ({
          name: img.name,
          mimeType: img.mimeType,
          base64Length: img.base64Data?.length ?? 0,
        })) ?? [],
      });
      const attachments = options.imageAttachments?.length
        ? options.imageAttachments.map((img) => ({
          type: 'image',
          mimeType: img.mimeType,
          content: img.base64Data,
        }))
        : undefined;
      if (attachments) {
        console.log('[OpenClawRuntime] chat.send with attachments:', attachments.length, 'images,', attachments.map(a => ({ type: a.type, mimeType: a.mimeType, contentLength: a.content?.length ?? 0 })));
      }
      const chatSendParams = {
        sessionKey,
        message: outboundMessage,
        deliver: false,
        idempotencyKey: runId,
        ...(runCwd ? { cwd: runCwd } : {}),
        ...(attachments ? { attachments } : {}),
      };
      assertOpenClawChatSendPayloadWithinLimit(sessionId, chatSendParams, attachments);
      const chatSendStartMs = Date.now();
      firstResponseTiming.chatSendStartedAtMs = chatSendStartMs;
      const sendResult = await client.request<Record<string, unknown>>(
        'chat.send',
        chatSendParams,
        { timeoutMs: 90_000 },
      );
      const chatSendElapsedMs = Date.now() - chatSendStartMs;
      firstResponseTiming.chatSendAckAtMs = Date.now();
      console.log(
        '[OpenClawRuntimeTiming] chat.send acknowledged.',
        `Session ${sessionId}.`,
        `Run ${runId}.`,
        `Elapsed ${chatSendElapsedMs}ms.`,
        `Total ${formatTimingOffset(firstResponseTiming.turnStartedAtMs, firstResponseTiming.chatSendAckAtMs)}.`,
      );
      if (chatSendElapsedMs > 10_000) {
        console.warn(`[OpenClawRuntime] chat.send took ${chatSendElapsedMs}ms — gateway may still be initializing`);
      }
      const returnedRunId = typeof sendResult?.runId === 'string' ? sendResult.runId.trim() : '';
      if (returnedRunId) {
        this.bindRunIdToTurn(sessionId, returnedRunId);
      }
    } catch (error) {
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', sessionId, message);
      this.pendingTurns.delete(sessionId);
      throw error;
    }

    await completionPromise;
  }

  private async buildOutboundPrompt(
    sessionId: string,
    prompt: string,
    systemPrompt?: string,
    agentId?: string,
    mediaReferences?: CoworkMediaAttachmentRef[],
    selectedTextSnippets?: CoworkSelectedTextSnippet[],
    firstResponseTiming?: FirstResponseTiming,
  ): Promise<string> {
    const normalizedSystemPrompt = (systemPrompt ?? '').trim();
    const planMode = isPlanModeSystemPrompt(normalizedSystemPrompt);
    const previousSystemPrompt = this.lastSystemPromptBySession.get(sessionId) ?? '';
    const shouldInjectSystemPrompt = Boolean(
      normalizedSystemPrompt
      && normalizedSystemPrompt !== previousSystemPrompt,
    );

    if (normalizedSystemPrompt) {
      this.lastSystemPromptBySession.set(sessionId, normalizedSystemPrompt);
    } else {
      this.lastSystemPromptBySession.delete(sessionId);
    }

    const session = this.store.getSession(sessionId);
    const agent = agentId ? this.store.getAgent(agentId) : null;
    const rawCurrentModel = session?.modelOverride || agent?.model || '';
    const currentModel = rawCurrentModel ? this.normalizeModelRef(rawCurrentModel) : '';

    const sections: string[] = [];
    if (shouldInjectSystemPrompt) {
      sections.push(this.buildSystemPromptPrefix(normalizedSystemPrompt));
    }
    sections.push(buildOpenClawLocalTimeContextPrompt());
    if (currentModel) {
      sections.push(`[Session info]\nCurrent model: ${currentModel}`);
    }
    const mediaReferenceSection = buildMediaReferencePromptSection(mediaReferences);
    if (mediaReferenceSection) {
      sections.push(mediaReferenceSection);
    }
    const selectedTextSection = buildSelectedTextPromptSection(selectedTextSnippets);
    if (selectedTextSnippets?.length && selectedTextSection) {
      console.log(
        `[OpenClawRuntime] appended ${selectedTextSnippets.length} selected text excerpts with `
        + `${selectedTextSnippets.reduce((total, snippet) => total + snippet.text.length, 0)} characters `
        + `to the outbound message for session ${sessionId}`,
      );
    }
    const continuityCapsuleBridge = this.buildContinuityCapsuleBridge(sessionId);
    const workspaceRehydrationBridge = await this.buildWorkspaceRehydrationBridge(sessionId);
    const topKEvidenceBridge = this.buildTopKEvidenceBridge(sessionId, prompt);

    if (this.bridgedSessions.has(sessionId)) {
      if (continuityCapsuleBridge) {
        sections.push(continuityCapsuleBridge);
      }
      if (workspaceRehydrationBridge) {
        sections.push(workspaceRehydrationBridge);
      }
      if (topKEvidenceBridge) {
        sections.push(topKEvidenceBridge);
      }
      if (selectedTextSection) {
        sections.push(selectedTextSection);
      }
      if (prompt.trim()) {
        sections.push(`[Current user request]\n${prompt}`);
      }
      if (planMode) {
        sections.push(buildPlanModeOutboundReminder());
      }
      return sections.join('\n\n');
    }

    const client = this.requireGatewayClient();
    const sessionKey = this.toSessionKey(sessionId, agentId);
    let hasHistory = false;
    try {
      if (firstResponseTiming) {
        firstResponseTiming.chatHistoryStartedAtMs = Date.now();
      }
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: 1,
      }, { timeoutMs: 3_000 });
      if (firstResponseTiming) {
        firstResponseTiming.chatHistoryEndedAtMs = Date.now();
      }
      hasHistory = Array.isArray(history?.messages) && history.messages.length > 0;
      console.log(
        '[OpenClawRuntimeTiming] chat.history probe finished.',
        `Session ${sessionId}.`,
        `Has history ${hasHistory}.`,
        `Elapsed ${formatTimingDuration(firstResponseTiming?.chatHistoryStartedAtMs, firstResponseTiming?.chatHistoryEndedAtMs)}.`,
        `Total ${firstResponseTiming ? formatTimingOffset(firstResponseTiming.turnStartedAtMs, firstResponseTiming.chatHistoryEndedAtMs) : 'n/a'}.`,
      );
    } catch (error) {
      if (firstResponseTiming) {
        firstResponseTiming.chatHistoryEndedAtMs = Date.now();
      }
      console.warn('[OpenClawRuntime] chat.history check failed, continuing without history guard:', error);
    }

    this.bridgedSessions.add(sessionId);

    if (!hasHistory) {
      if (session) {
        const bridgePrefix = this.buildBridgePrefix(session.messages, prompt);
        if (bridgePrefix) {
          sections.push(bridgePrefix);
        }
      }
    }

    if (continuityCapsuleBridge) {
      sections.push(continuityCapsuleBridge);
    }
    if (workspaceRehydrationBridge) {
      sections.push(workspaceRehydrationBridge);
    }
    if (topKEvidenceBridge) {
      sections.push(topKEvidenceBridge);
    }
    if (selectedTextSection) {
      sections.push(selectedTextSection);
    }
    if (prompt.trim()) {
      sections.push(`[Current user request]\n${prompt}`);
    }
    if (planMode) {
      sections.push(buildPlanModeOutboundReminder());
    }
    return sections.join('\n\n');
  }

  private buildSystemPromptPrefix(systemPrompt: string): string {
    return [
      '[LobsterAI system instructions]',
      'Apply the instructions below as the highest-priority guidance for this session.',
      'If earlier LobsterAI system instructions exist, replace them with this version.',
      systemPrompt,
    ].join('\n');
  }

  private buildBridgePrefix(messages: CoworkMessage[], currentPrompt: string): string {
    const normalizedCurrentPrompt = currentPrompt.trim();
    if (!normalizedCurrentPrompt) return '';
    const compactionSummaries = messages
      .filter((message) => (
        message.type === 'system'
        && message.metadata?.kind === CoworkSystemMessageKind.ForkCompactionSummary
        && message.content.trim()
      ))
      .map((message) => message.content.trim());

    const source = messages
      .filter((message) => {
        if (message.type !== 'user' && message.type !== 'assistant') {
          return false;
        }
        if (!message.content.trim()) {
          return false;
        }
        if (message.metadata?.isThinking) {
          return false;
        }
        return true;
      })
      .map((message) => ({
        type: message.type,
        content: message.content.trim(),
      }));

    if (source[source.length - 1]?.type === 'user'
      && source[source.length - 1]?.content === normalizedCurrentPrompt) {
      source.pop();
    }

    const recent = source.slice(-BRIDGE_MAX_MESSAGES);
    if (recent.length === 0 && compactionSummaries.length === 0) {
      return '';
    }

    const sections = [
      '[Context bridge from previous LobsterAI conversation]',
      'Use this prior context for continuity. Focus your final answer on the current request.',
    ];

    for (const summary of compactionSummaries) {
      sections.push(
        '[OpenClaw compaction summary from the fork source]',
        truncate(summary, FORK_COMPACTION_SUMMARY_MAX_CHARS),
      );
    }
    if (compactionSummaries.length > 0) {
      console.debug(`[OpenClawRuntime] injected ${compactionSummaries.length} fork compaction summary bridge message(s).`);
    }

    const lines = recent.map((entry) => {
      const role = entry.type === 'user' ? 'User' : 'Assistant';
      return `${role}: ${truncate(entry.content, BRIDGE_MAX_MESSAGE_CHARS)}`;
    });
    if (lines.length > 0) {
      sections.push('[Recent visible conversation before the fork]', ...lines);
    }

    return sections.join('\n');
  }

  private async ensureGatewayClientReady(): Promise<void> {
    // Serialize concurrent calls: if another init is already in progress, wait for it.
    if (this.gatewayClientInitLock) {
      await this.gatewayClientInitLock;
      return;
    }
    this.gatewayClientInitLock = this._ensureGatewayClientReadyImpl();
    try {
      await this.gatewayClientInitLock;
    } finally {
      this.gatewayClientInitLock = null;
    }
  }

  private async _ensureGatewayClientReadyImpl(): Promise<void> {
    console.log('[ChannelSync] ensureGatewayClientReady: starting engine gateway...');
    const engineStatus = await this.engineManager.startGateway('channel-sync-ensure-ready');
    console.log('[ChannelSync] ensureGatewayClientReady: engine phase=', engineStatus.phase, 'message=', engineStatus.message);
    if (engineStatus.phase !== 'running') {
      const message = engineStatus.message || 'OpenClaw engine is not running.';
      throw new Error(message);
    }

    const connection = this.engineManager.getGatewayConnectionInfo();
    console.log('[ChannelSync] ensureGatewayClientReady: connection info — url=', connection.url ? '✓' : '✗', 'token=', connection.token ? '✓' : '✗', 'version=', connection.version, 'clientEntryPath=', connection.clientEntryPath ? '✓' : '✗');
    const missing: string[] = [];
    if (!connection.url) missing.push('url');
    if (!connection.token) missing.push('token');
    if (!connection.version) missing.push('version');
    if (!connection.clientEntryPath) missing.push('clientEntryPath');
    if (missing.length > 0) {
      throw new Error(`OpenClaw gateway connection info is incomplete (missing: ${missing.join(', ')})`);
    }

    const needsNewClient = !this.gatewayClient
      || this.gatewayClientVersion !== connection.version
      || this.gatewayClientEntryPath !== connection.clientEntryPath;
    console.log('[ChannelSync] ensureGatewayClientReady: needsNewClient=', needsNewClient, 'hasExistingClient=', !!this.gatewayClient);
    if (!needsNewClient && this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      return;
    }

    this.stopGatewayClient();
    console.log('[ChannelSync] ensureGatewayClientReady: creating gateway client, url=', connection.url);
    await this.createGatewayClient(connection);
    console.log('[ChannelSync] ensureGatewayClientReady: createGatewayClient returned, waiting for handshake...');
    if (this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
    }
    console.log('[ChannelSync] ensureGatewayClientReady: gateway client created and ready');

    // Browser pre-warm disabled: the empty browser window is disruptive.
    // The browser will start on-demand when the AI agent first calls the browser tool.
    // this.prewarmBrowserIfNeeded(connection);
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const GatewayClient = await this.loadGatewayClientCtor(connection.clientEntryPath);

    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    let settled = false;

    this.gatewayReadyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      this.gatewayReadyReject = reject;
    });

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      this.gatewayReadyReject = null;
      resolveReady?.();
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      this.gatewayReadyReject = null;
      rejectReady?.(error);
    };

    const client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      clientDisplayName: 'LobsterAI',
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: [OPENCLAW_GATEWAY_TOOL_EVENTS_CAP],
      role: 'operator',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        console.log('[ChannelSync] GatewayClient: onHelloOk — handshake succeeded');
        // Expose the client only after the connect handshake completes.
        // Setting gatewayClient earlier would let concurrent code send
        // request frames before the connect frame, causing 1008 rejection.
        this.gatewayClient = client;
        this.gatewayClientVersion = connection.version;
        this.gatewayClientEntryPath = connection.clientEntryPath;
        this.resetGatewayRpcHealth();
        settleResolve();
        try {
          this.options.onGatewayClientReady?.();
        } catch (error) {
          console.warn('[OpenClawRuntime] gateway ready callback failed:', error);
        }
        this.lastTickTimestamp = Date.now();
        this.startTickWatchdog();
      },
      onConnectError: (error: Error) => {
        console.error('[ChannelSync] GatewayClient: onConnectError —', error.message);
        // Don't reject on transient connect errors — the GatewayClient has
        // built-in reconnection logic and will retry automatically.  Let the
        // outer waitWithTimeout be the single authority on giving up.  Only
        // reject immediately for definitive auth failures that won't resolve
        // on retry (e.g. invalid token, access denied).
        const msg = error.message.toLowerCase();
        const isAuthFailure = msg.includes('auth') || msg.includes('denied') || msg.includes('forbidden');
        if (isAuthFailure) {
          settleReject(error);
        } else {
          console.log('[ChannelSync] GatewayClient: transient connect error, waiting for auto-reconnect...');
        }
      },
      onClose: (_code: number, reason: string) => {
        console.log('[ChannelSync] GatewayClient: onClose — code:', _code, 'reason:', reason, 'settled:', settled);
        if (!settled) {
          // v2026.4.5+: The initial handshake may fail due to the gateway
          // being busy with plugin loading (connect.challenge timeout on the
          // server side).  The GatewayClient internally reconnects and
          // typically succeeds on the next attempt.  Don't reject the promise
          // or discard the client here — let waitWithTimeout handle the
          // overall deadline.  The onHelloOk callback will settle the promise
          // when the reconnection succeeds.
          console.log('[ChannelSync] GatewayClient: connection closed before handshake, waiting for auto-reconnect...');
          return;
        }

        // If stopGatewayClient() triggered this onClose, don't do anything —
        // the caller is already handling cleanup and may be creating a new client.
        if (this.gatewayStoppingIntentionally) {
          return;
        }

        console.warn('[OpenClawRuntime] gateway WS disconnected — code:', _code, 'reason:', reason);
        const disconnectedMessage = _code === WebSocketCloseCode.MessageTooBig
          ? (reason || 'gateway closed (1009):')
          : (reason || 'OpenClaw gateway client disconnected');
        const disconnectedError = new Error(disconnectedMessage);
        const activeSessionIds = Array.from(this.activeTurns.keys());
        activeSessionIds.forEach((sessionId) => {
          this.store.updateSession(sessionId, { status: 'error' });
          this.emit('error', sessionId, disconnectedError.message);
          this.cleanupSessionTurn(sessionId);
          this.rejectTurn(sessionId, disconnectedError);
        });
        this.stopGatewayClient();
        this.gatewayReadyPromise = Promise.reject(disconnectedError);
        this.gatewayReadyPromise.catch(() => {
          // suppress unhandled rejection noise; auto-reconnect will re-establish
        });

        // Auto-reconnect after unexpected disconnect
        this.scheduleGatewayReconnect();
      },
      onEvent: (event: GatewayEventFrame) => {
        this.handleGatewayEvent(event);
      },
    });

    // gatewayClient/version/entryPath are now set inside onHelloOk,
    // after the connect handshake succeeds. We only keep a local ref
    // for stopGatewayClient() cleanup if start() fails synchronously.
    this.pendingGatewayClient = client;
    client.start();
  }

  private stopGatewayClient(): void {
    this.gatewayStoppingIntentionally = true;
    this.stopChannelPolling();
    this.cancelGatewayReconnect();
    this.stopTickWatchdog();
    // Stop whichever client exists — the promoted one or the pending one.
    const clientToStop = this.gatewayClient ?? this.pendingGatewayClient;
    try {
      clientToStop?.stop();
    } catch (error) {
      console.warn('[OpenClawRuntime] Failed to stop gateway client:', error);
    }
    this.gatewayClient = null;
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    if (this.gatewayReadyReject) {
      const stoppedBeforeReadyError = new Error('OpenClaw gateway client stopped before handshake completed.');
      this.gatewayReadyPromise?.catch(() => {
        // suppress unhandled rejection when no caller is currently awaiting readiness
      });
      this.gatewayReadyReject(stoppedBeforeReadyError);
      this.gatewayReadyReject = null;
    }
    this.gatewayReadyPromise = null;
    this.channelSessionSync?.clearCache();
    this.sessionModelPatchStateBySession.clear();
    this.goalSnapshotBySessionId.clear();
    this.contextUsageInFlightBySession.clear();
    this.contextUsageListInFlight.clear();
    this.resetGatewayRpcHealth();
    this.knownChannelSessionIds.clear();
    this.heartbeatSessionKeys.clear();
    this.stoppedSessions.clear();
    this.recentlyClosedRunIds.clear();
    this.browserPrewarmAttempted = false;
    this.lastTickTimestamp = 0;
    // Clear messageUpdate throttle state
    for (const timer of this.pendingMessageUpdateTimer.values()) {
      clearTimeout(timer);
    }
    this.pendingMessageUpdateTimer.clear();
    this.lastMessageUpdateEmitTime.clear();
    // Clear incremental backfill state
    for (const timer of this.incrementalBackfillTimer.values()) {
      clearTimeout(timer);
    }
    this.incrementalBackfillTimer.clear();
    this.pendingBackfillToolCallIds.clear();
    this.gatewayStoppingIntentionally = false;
  }

  private pruneRecentlyClosedRunIds(now = Date.now()): void {
    for (const [runId, info] of this.recentlyClosedRunIds.entries()) {
      if (info.expiresAt <= now) {
        this.recentlyClosedRunIds.delete(runId);
      }
    }

    while (this.recentlyClosedRunIds.size > OpenClawRuntimeAdapter.RECENTLY_CLOSED_RUN_ID_LIMIT) {
      const oldestRunId = this.recentlyClosedRunIds.keys().next().value as string | undefined;
      if (!oldestRunId) return;
      this.recentlyClosedRunIds.delete(oldestRunId);
    }
  }

  private rememberRecentlyClosedRunId(
    runId: string,
    options: { sessionId?: string; sessionKey?: string; allowRetryReopen?: boolean } = {},
  ): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    const now = Date.now();
    this.recentlyClosedRunIds.set(normalizedRunId, {
      closedAt: now,
      expiresAt: now + OpenClawRuntimeAdapter.RECENTLY_CLOSED_RUN_ID_TTL_MS,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      ...(options.allowRetryReopen ? { allowRetryReopen: true } : {}),
    });
    this.pruneRecentlyClosedRunIds(now);
  }

  private getRecentlyClosedRunInfo(runId: string): RecentlyClosedRunInfo | null {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return null;
    const info = this.recentlyClosedRunIds.get(normalizedRunId);
    if (!info) return null;
    if (info.expiresAt <= Date.now()) {
      this.recentlyClosedRunIds.delete(normalizedRunId);
      return null;
    }
    return info;
  }

  private isRecentlyClosedRunId(runId: string): boolean {
    return this.getRecentlyClosedRunInfo(runId) !== null;
  }

  private canReopenRecentlyClosedRunForRetry(
    runId: string,
    sessionId: string,
    sessionKey: string,
  ): boolean {
    const info = this.getRecentlyClosedRunInfo(runId);
    if (!info?.allowRetryReopen) {
      return false;
    }
    if (info.sessionId && info.sessionId !== sessionId) {
      return false;
    }
    if (info.sessionKey && info.sessionKey !== sessionKey) {
      return false;
    }
    if (this.terminatedRunIds.has(runId)) {
      return false;
    }
    if (this.isSessionInStopCooldown(sessionId)) {
      return false;
    }
    if (this.manuallyStoppedSessions.has(sessionId) && isManagedSessionKey(sessionKey)) {
      return false;
    }
    return true;
  }

  private reopenRecentlyClosedRunForRetry(sessionId: string, sessionKey: string, runId: string): boolean {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId || !this.canReopenRecentlyClosedRunForRetry(normalizedRunId, sessionId, sessionKey)) {
      return false;
    }

    this.recentlyClosedRunIds.delete(normalizedRunId);
    this.lastChatSeqByRunId.delete(normalizedRunId);
    this.lastAgentSeqByRunId.delete(normalizedRunId);
    this.pendingAgentEventsByRunId.delete(normalizedRunId);
    this.ensureActiveTurn(sessionId, sessionKey, normalizedRunId);
    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      return false;
    }
    turn.pendingRecoverableFollowup = true;
    turn.pendingOpenClawRetry = true;
    turn.reopenedFromClosedRun = true;
    this.bindRunIdToTurn(sessionId, normalizedRunId);
    console.log(`[OpenClawRuntime] reopened recently closed run ${normalizedRunId} for a same-run retry in session ${sessionId}.`);
    return true;
  }

  private cancelGatewayReconnect(): void {
    if (this.gatewayReconnectTimer) {
      clearTimeout(this.gatewayReconnectTimer);
      this.gatewayReconnectTimer = null;
    }
  }

  /**
   * Throttled emit for messageUpdate during streaming.
   * OpenClaw sends full-replacement deltas, so intermediate updates can be safely skipped.
   * Uses leading + trailing pattern: emit immediately if enough time has passed,
   * otherwise schedule a trailing emit to deliver the latest content.
   */
  private throttledEmitMessageUpdate(sessionId: string, messageId: string, content: string): void {
    const now = Date.now();
    const lastEmit = this.lastMessageUpdateEmitTime.get(messageId) ?? 0;
    const elapsed = now - lastEmit;

    if (elapsed >= OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS) {
      this.clearPendingMessageUpdate(messageId);
      this.lastMessageUpdateEmitTime.set(messageId, now);
      this.emit('messageUpdate', sessionId, messageId, content);
      return;
    }

    // Schedule a trailing emit to ensure the latest content is delivered
    this.clearPendingMessageUpdate(messageId);
    this.pendingMessageUpdateTimer.set(messageId, setTimeout(() => {
      this.pendingMessageUpdateTimer.delete(messageId);
      this.lastMessageUpdateEmitTime.set(messageId, Date.now());
      this.emit('messageUpdate', sessionId, messageId, content);
    }, OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS - elapsed));
  }

  private clearPendingMessageUpdate(messageId: string): void {
    const timer = this.pendingMessageUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingMessageUpdateTimer.delete(messageId);
    }
  }

  /**
   * Throttled SQLite store write for streaming message updates.
   * Uses leading + trailing pattern identical to throttledEmitMessageUpdate.
   * Final correctness is guaranteed by syncFinalAssistantWithHistory.
   */
  private throttledStoreUpdateMessage(
    sessionId: string,
    messageId: string,
    content: string,
    metadata: { isStreaming: boolean; isFinal: boolean; isThinking?: boolean },
  ): void {
    const now = Date.now();
    const lastUpdate = this.lastStoreUpdateTime.get(messageId) ?? 0;
    const elapsed = now - lastUpdate;

    if (elapsed >= OpenClawRuntimeAdapter.STORE_UPDATE_THROTTLE_MS) {
      this.clearPendingStoreUpdate(messageId);
      this.lastStoreUpdateTime.set(messageId, now);
      this.store.updateMessage(sessionId, messageId, { content, metadata });
      return;
    }

    // Schedule a trailing write to ensure the latest content is persisted
    this.clearPendingStoreUpdate(messageId);
    this.pendingStoreUpdateTimer.set(messageId, setTimeout(() => {
      this.pendingStoreUpdateTimer.delete(messageId);
      this.lastStoreUpdateTime.set(messageId, Date.now());
      // Guard: skip write if the session turn has already been cleaned up
      const activeTurn = this.activeTurns.get(sessionId);
      if (activeTurn?.assistantMessageId === messageId || activeTurn?.thinkingMessageId === messageId) {
        this.store.updateMessage(sessionId, messageId, { content, metadata });
      }
    }, OpenClawRuntimeAdapter.STORE_UPDATE_THROTTLE_MS - elapsed));
  }

  private clearPendingStoreUpdate(messageId: string): void {
    const timer = this.pendingStoreUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingStoreUpdateTimer.delete(messageId);
    }
  }

  private resolveCurrentModelForSession(sessionId: string): string {
    const session = this.store.getSession(sessionId);
    if (session?.modelOverride) {
      return session.modelOverride;
    }
    const agent = session?.agentId ? this.store.getAgent(session.agentId) : null;
    const rawCurrentModel = agent?.model || '';
    if (!rawCurrentModel) return '';
    return this.normalizeModelRef(rawCurrentModel);
  }

  private finalizeStoppedStreamingMessage(
    sessionId: string,
    messageId: string | null,
    content: string,
    model: string,
  ): void {
    if (!messageId) return;

    this.clearPendingStoreUpdate(messageId);
    this.clearPendingMessageUpdate(messageId);
    this.lastStoreUpdateTime.delete(messageId);
    this.lastMessageUpdateEmitTime.delete(messageId);

    const session = this.store.getSession(sessionId);
    const message = session?.messages.find((item) => item.id === messageId);
    if (!message) return;

    const finalContent = content || message.content;
    const existingModel = typeof message.metadata?.model === 'string' && message.metadata.model.trim()
      ? message.metadata.model
      : '';
    const metadata: CoworkMessageMetadata = {
      ...message.metadata,
      isStreaming: false,
      isFinal: true,
      ...(existingModel ? { model: existingModel } : model ? { model } : {}),
    };

    this.store.updateMessage(sessionId, messageId, {
      content: finalContent,
      metadata,
    });
    console.debug(
      `[OpenClawRuntime] finalized stopped streaming message for session ${sessionId}.`,
      `Message ${messageId}.`,
      `Model ${metadata.model ?? 'none'}.`,
    );
    this.emit('messageUpdate', sessionId, messageId, finalContent, metadata);
  }

  private finalizeStoppedStreamingMessages(sessionId: string, turn: ActiveTurn): void {
    const model = turn.model || this.resolveCurrentModelForSession(sessionId);
    this.finalizeStoppedStreamingMessage(
      sessionId,
      turn.thinkingMessageId,
      turn.currentThinkingText,
      model,
    );
    this.finalizeStoppedStreamingMessage(
      sessionId,
      turn.assistantMessageId,
      turn.currentAssistantSegmentText || turn.currentText,
      model,
    );
  }

  private syncToolResultsFromHistory(
    sessionId: string,
    turn: ActiveTurn,
    historyMessages: unknown[],
  ): void {
    for (const msg of historyMessages) {
      if (!isRecord(msg)) continue;

      const msgRole = typeof msg.role === 'string' ? msg.role.trim() : '';
      if (msgRole !== OpenClawHistoryRole.ToolResult && msgRole !== OpenClawHistoryRole.Tool) {
        continue;
      }

      const msgToolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId.trim()
        : typeof msg.tool_call_id === 'string' ? (msg.tool_call_id as string).trim()
          : '';
      if (!msgToolCallId) continue;

      const text = extractMessageText(msg);
      if (!text.trim()) continue;

      const existingResultMsgId = turn.toolResultMessageIdByToolCallId.get(msgToolCallId);
      const hasKnownToolUse = turn.toolUseMessageIdByToolCallId.has(msgToolCallId);
      if (!hasKnownToolUse && !existingResultMsgId) {
        console.debug(
          '[OpenClawRuntime] skipped a tool result from chat history because it is not part of the current turn.',
          `sessionId=${sessionId}`,
          `toolCallId=${msgToolCallId}`,
        );
        continue;
      }

      const existingText = turn.toolResultTextByToolCallId.get(msgToolCallId) ?? '';
      if (text.length <= existingText.length) continue;

      const isError = Boolean(msg.isError);
      const metadata = {
        toolResult: text,
        toolUseId: msgToolCallId,
        isError,
        isStreaming: false,
        isFinal: true,
      };

      if (existingResultMsgId) {
        this.store.updateMessage(sessionId, existingResultMsgId, {
          content: text,
          metadata,
        });
        turn.toolResultTextByToolCallId.set(msgToolCallId, text);
        this.emit('messageUpdate', sessionId, existingResultMsgId, text);
      } else {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: text,
          metadata,
        });
        turn.toolResultMessageIdByToolCallId.set(msgToolCallId, resultMessage.id);
        turn.toolResultTextByToolCallId.set(msgToolCallId, text);
        this.emit('message', sessionId, resultMessage);
      }

      console.debug(
        '[OpenClawRuntime] backfilled a tool result from chat history.',
        `sessionId=${sessionId}`,
        `toolCallId=${msgToolCallId}`,
        `len=${text.length}`,
        `prevLen=${existingText.length}`,
      );
    }
  }

  /** Flush any pending throttled store write immediately (e.g. before segment split or final sync). */
  private flushPendingStoreUpdate(sessionId: string, messageId: string): void {
    const timer = this.pendingStoreUpdateTimer.get(messageId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingStoreUpdateTimer.delete(messageId);
    this.lastStoreUpdateTime.set(messageId, Date.now());
    // Persist the latest in-memory content only; caller is responsible for metadata.
    const turn = this.activeTurns.get(sessionId);
    if (turn?.assistantMessageId === messageId && turn.currentAssistantSegmentText) {
      this.store.updateMessage(sessionId, messageId, {
        content: turn.currentAssistantSegmentText,
      });
    }
  }

  // ─── Incremental Tool Result Backfill ─────────────────────────────────────────

  /**
   * Schedule a debounced incremental backfill of tool result text from chat.history.
   * Called when a tool result event arrives with empty text (gateway stripped it).
   * Multiple tool results arriving within INCREMENTAL_BACKFILL_DEBOUNCE_MS are
   * batched into a single chat.history call.
   */
  private scheduleIncrementalBackfill(sessionId: string, toolCallId: string): void {
    let pending = this.pendingBackfillToolCallIds.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.pendingBackfillToolCallIds.set(sessionId, pending);
    }
    pending.add(toolCallId);

    // Trailing-edge debounce: reset timer on each new arrival
    const existingTimer = this.incrementalBackfillTimer.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.incrementalBackfillTimer.set(sessionId, setTimeout(() => {
      this.incrementalBackfillTimer.delete(sessionId);
      void this.executeIncrementalBackfill(sessionId);
    }, OpenClawRuntimeAdapter.INCREMENTAL_BACKFILL_DEBOUNCE_MS));
  }

  /**
   * Execute a single incremental backfill: fetch chat.history and update
   * any tool results whose currently stored text is shorter than the authoritative text.
   */
  private async executeIncrementalBackfill(sessionId: string): Promise<void> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn?.sessionKey) {
      this.pendingBackfillToolCallIds.delete(sessionId);
      return;
    }

    const pending = this.pendingBackfillToolCallIds.get(sessionId);
    if (!pending || pending.size === 0) return;

    const client = this.gatewayClient;
    if (!client) return;

    // Snapshot and clear — new arrivals during the fetch create a fresh batch.
    const toolCallIdsToBackfill = new Set(pending);
    pending.clear();

    const turnToken = turn.turnToken;
    const limit = Math.min(toolCallIdsToBackfill.size * 3 + 5, 30);

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey: turn.sessionKey,
        limit,
      }, { timeoutMs: 5_000 });

      // Re-check turn is still active after the await
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turnToken) return;

      if (Array.isArray(history?.messages)) {
        for (const msg of history.messages) {
          if (!isRecord(msg)) continue;

          const msgRole = typeof msg.role === 'string' ? msg.role : '';
          const msgToolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId.trim()
            : typeof msg.tool_call_id === 'string' ? (msg.tool_call_id as string).trim()
              : '';

          if (!msgToolCallId || (msgRole !== 'toolResult' && msgRole !== 'tool')) continue;

          const text = extractMessageText(msg);
          if (!text.trim()) continue;

          // Opportunistically backfill any tool result found, not just pending ones
          const existingResultMsgId = currentTurn.toolResultMessageIdByToolCallId.get(msgToolCallId);
          const existingText = currentTurn.toolResultTextByToolCallId.get(msgToolCallId) ?? '';

          if (text.length > existingText.length && existingResultMsgId) {
            const isError = Boolean(msg.isError);
            this.store.updateMessage(sessionId, existingResultMsgId, {
              content: text,
              metadata: {
                toolResult: text,
                toolUseId: msgToolCallId,
                isError,
                isStreaming: false,
                isFinal: true,
              },
            });
            currentTurn.toolResultTextByToolCallId.set(msgToolCallId, text);
            this.emit('messageUpdate', sessionId, existingResultMsgId, text);
            console.log(
              '[OpenClawRuntime] incremental backfill from chat.history',
              `toolCallId=${msgToolCallId}`, `len=${text.length}`, `prevLen=${existingText.length}`,
            );

            // Extract childSessionKey from backfilled sessions_spawn results
            this.subagentTracker.onBackfillResult(msgToolCallId, text);
          }
        }
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] incremental backfill chat.history fetch failed:', err);
      // Re-add toolCallIds so handleChatFinal or next round can retry
      const currentPending = this.pendingBackfillToolCallIds.get(sessionId);
      if (currentPending) {
        for (const id of toolCallIdsToBackfill) currentPending.add(id);
      } else {
        this.pendingBackfillToolCallIds.set(sessionId, toolCallIdsToBackfill);
      }
    } finally {
      // If more toolCallIds accumulated during the fetch, schedule another round
      const remainingPending = this.pendingBackfillToolCallIds.get(sessionId);
      if (remainingPending && remainingPending.size > 0 && this.activeTurns.has(sessionId)) {
        this.incrementalBackfillTimer.set(sessionId, setTimeout(() => {
          this.incrementalBackfillTimer.delete(sessionId);
          void this.executeIncrementalBackfill(sessionId);
        }, OpenClawRuntimeAdapter.INCREMENTAL_BACKFILL_DEBOUNCE_MS));
      }
    }
  }

  private startTickWatchdog(): void {
    this.stopTickWatchdog();
    console.log('[TickWatchdog] started');
    this.tickWatchdogTimer = setInterval(() => {
      this.checkTickHealth();
    }, OpenClawRuntimeAdapter.TICK_WATCHDOG_INTERVAL_MS);
  }

  private stopTickWatchdog(): void {
    if (this.tickWatchdogTimer) {
      clearInterval(this.tickWatchdogTimer);
      this.tickWatchdogTimer = null;
    }
  }

  private checkTickHealth(): void {
    if (this.lastTickTimestamp <= 0) return;
    const elapsed = Date.now() - this.lastTickTimestamp;
    if (elapsed <= OpenClawRuntimeAdapter.TICK_TIMEOUT_MS) return;

    console.warn(`[TickWatchdog] no tick received for ${Math.round(elapsed / 1000)}s (threshold: ${OpenClawRuntimeAdapter.TICK_TIMEOUT_MS / 1000}s) — connection is likely dead, triggering reconnect`);
    this.cancelGatewayReconnect();
    this.stopGatewayClient();
    this.gatewayReconnectAttempt = 0;
    this.scheduleGatewayReconnect();
  }

  /**
   * Called when the system resumes from sleep/suspend.
   * Resets the reconnect counter and triggers an immediate reconnect or health check.
   */
  onSystemResume(): void {
    if (this.gatewayReconnectSuppressed) {
      console.log('[GatewayReconnect] skipped system resume reconnect because gateway reconnect is suppressed');
      return;
    }
    console.log('[GatewayReconnect] system resumed from sleep');
    this.cancelGatewayReconnect();
    this.gatewayReconnectAttempt = 0;
    if (!this.gatewayClient) {
      void this.attemptGatewayReconnect();
    } else {
      this.checkTickHealth();
    }
  }

  /**
   * Schedule an automatic gateway WS reconnection attempt with exponential backoff.
   * Called from onClose when the connection drops unexpectedly after a successful handshake.
   */
  private scheduleGatewayReconnect(): void {
    if (this.gatewayReconnectSuppressed) {
      console.log('[GatewayReconnect] skipped reconnect scheduling because gateway reconnect is suppressed');
      return;
    }
    if (this.gatewayReconnectAttempt >= OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS) {
      console.error('[GatewayReconnect] max attempts reached (' + OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS + '), giving up. Restart the app to reconnect.');
      return;
    }

    const delays = OpenClawRuntimeAdapter.GATEWAY_RECONNECT_DELAYS;
    const delay = delays[Math.min(this.gatewayReconnectAttempt, delays.length - 1)];
    this.gatewayReconnectAttempt++;

    console.log(`[GatewayReconnect] scheduling reconnect attempt ${this.gatewayReconnectAttempt}/${OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS} in ${delay}ms`);

    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = null;
      void this.attemptGatewayReconnect();
    }, delay);
  }

  private async attemptGatewayReconnect(): Promise<void> {
    if (this.gatewayReconnectSuppressed) {
      console.log('[GatewayReconnect] skipped reconnect attempt because gateway reconnect is suppressed');
      return;
    }
    console.log(`[GatewayReconnect] attempting reconnect (attempt ${this.gatewayReconnectAttempt})`);
    try {
      // connectGatewayIfNeeded checks if client already exists, so safe to call
      await this.connectGatewayIfNeeded();
      console.log('[GatewayReconnect] reconnected successfully');
      this.gatewayReconnectAttempt = 0; // reset counter on success
    } catch (error) {
      console.warn('[GatewayReconnect] reconnect failed:', error);
      this.scheduleGatewayReconnect(); // retry with next backoff
    }
  }

  private prewarmBrowserIfNeeded(connection: OpenClawGatewayConnectionInfo): void {
    if (this.browserPrewarmAttempted) return;
    if (!connection.port || !connection.token) return;
    this.browserPrewarmAttempted = true;

    const browserControlPort = connection.port + 2;
    const token = connection.token;
    console.log(`[OpenClawRuntime] browser pre-warm: gatewayPort=${connection.port}, browserControlPort=${browserControlPort}`);
    void this.prewarmBrowserWithRetry(browserControlPort, token);
  }

  private probeBrowserControlService(toolCallId: string, phase: string): void {
    const connection = this.engineManager.getGatewayConnectionInfo();
    if (!connection.port || !connection.token) {
      console.log(`[OpenClawRuntime] browser probe (${toolCallId}/${phase}): no gateway connection info`);
      return;
    }
    const browserControlPort = connection.port + 2;
    const token = connection.token;
    const probeStartTime = Date.now();
    console.log(`[OpenClawRuntime] browser probe (${toolCallId}/${phase}): checking port ${browserControlPort} ...`);

    // Probe multiple endpoints to diagnose reachability
    const endpoints = [`http://127.0.0.1:${browserControlPort}/status`, `http://127.0.0.1:${browserControlPort}/`];
    for (const probeUrl of endpoints) {
      fetch(probeUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then(async (response) => {
          const body = await response.text().catch(() => '');
          console.log(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → HTTP ${response.status} (${Date.now() - probeStartTime}ms) body=${body.slice(0, 500)}`,
          );
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → FAILED (${Date.now() - probeStartTime}ms) error=${message}`,
          );
        });
    }
  }

  private async prewarmBrowserWithRetry(
    port: number,
    token: string,
    maxRetries = 5,
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}/start?profile=openclaw`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      console.log(
        `[OpenClawRuntime] browser pre-warm attempt ${attempt}/${maxRetries} → POST http://127.0.0.1:${port}/start?profile=openclaw`,
      );

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();
        if (response.ok) {
          console.log(
            `[OpenClawRuntime] browser pre-warm succeeded (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
          );
          return;
        }
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} returned HTTP ${response.status} (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} failed (${Date.now() - startTime}ms): ${message}`,
        );
      }

      if (attempt < maxRetries) {
        const delayMs = Math.min(5000, 2000 * attempt);
        console.log(`[OpenClawRuntime] browser pre-warm retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    console.warn('[OpenClawRuntime] browser pre-warm exhausted all retries (non-fatal, browser will start on first tool use)');
  }

  private async loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    // Use require() with file path directly. TypeScript's CJS output downgrades
    // dynamic import() to require(), which doesn't support file:// URLs.
    const loaded = require(clientEntryPath) as Record<string, unknown>;
    const direct = loaded.GatewayClient;
    if (typeof direct === 'function') {
      return direct as GatewayClientCtor;
    }

    const exportedValues = Object.values(loaded);
    for (const candidate of exportedValues) {
      if (typeof candidate !== 'function') {
        continue;
      }
      const maybeCtor = candidate as {
        name?: string;
        prototype?: {
          start?: unknown;
          stop?: unknown;
          request?: unknown;
        };
      };
      if (maybeCtor.name === 'GatewayClient') {
        return candidate as GatewayClientCtor;
      }
      const proto = maybeCtor.prototype;
      if (proto
        && typeof proto.start === 'function'
        && typeof proto.stop === 'function'
        && typeof proto.request === 'function') {
        return candidate as GatewayClientCtor;
      }
    }

    const exportKeysPreview = Object.keys(loaded).slice(0, 20).join(', ');
    throw new Error(
      `Invalid OpenClaw gateway client module: ${clientEntryPath} (exports: ${exportKeysPreview || 'none'})`,
    );
  }

  private handleGatewayEvent(event: GatewayEventFrame): void {
    // Any event from the gateway proves the connection is alive.
    // Previously only 'tick' updated this timestamp, but during heavy exec
    // streaming the gateway's tick timer gets starved by I/O while other
    // events (agent, tool updates) keep flowing — causing false-positive
    // disconnect from the TickWatchdog.
    this.lastTickTimestamp = Date.now();

    if (event.event === 'tick') {
      return;
    }

    if (event.event === 'chat') {
      this.handleChatEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'agent') {
      // Process assistant text updates here (before handleAgentEvent) because
      // handleAgentEvent may enqueue events when sessionId mapping isn't ready.
      this.processAgentAssistantText(event.payload);
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'exec.approval.requested') {
      this.approvalController.handleExecApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'exec.approval.resolved') {
      this.approvalController.handleExecApprovalResolved(event.payload);
      return;
    }

    if (event.event === 'plugin.approval.requested') {
      this.approvalController.handlePluginApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'plugin.approval.resolved') {
      this.approvalController.handlePluginApprovalResolved(event.payload);
    }

    if (event.event === 'cron') {
      console.debug('[OpenClawRuntime] received cron event:', JSON.stringify(event));
      this.scheduleImConversationSyncAfterCronDelivery(event.payload);
    }
  }

  /**
   * Cron announce deliveries mirror into the target conversation's gateway
   * transcript without bumping the session's activity timestamp, so the
   * active-window incremental poll never picks them up. Pull the mirrored
   * message into the mapped IM conversation record right after a delivered
   * run instead.
   */
  private scheduleImConversationSyncAfterCronDelivery(payload: unknown): void {
    const target = extractCronDeliveredTarget(payload);
    if (!target || !this.channelSessionSync) return;
    const conversation = this.channelSessionSync.resolveConversationByDeliveryTarget(
      target.channel,
      target.to,
      target.accountId,
    );
    if (!conversation) {
      console.debug(
        '[ChannelSync] no local conversation mapped for cron delivery target:',
        target.channel,
        target.to,
      );
      return;
    }
    // Delay so the gateway finishes flushing the delivery mirror into the
    // transcript before we reconcile against chat.history.
    setTimeout(() => {
      void this.syncSessionHistoryFromGateway(conversation.sessionId, conversation.sessionKey)
        .then(() => {
          // The delivered mirror is assistant-only and message writes
          // deliberately never advance updated_at (streaming reorder guard),
          // so surface the fresh delivery in the session list explicitly.
          this.store.updateSession(conversation.sessionId, {}, { touchUpdatedAt: true });
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('cowork:sessions:changed');
            }
          }
          console.log(
            '[ChannelSync] synced IM conversation after cron delivery.',
            `Session ${conversation.sessionId}.`,
            `Channel ${target.channel}.`,
          );
        })
        .catch((error) => {
          console.warn('[ChannelSync] failed to sync IM conversation after cron delivery:', error);
        });
    }, OpenClawRuntimeAdapter.CRON_DELIVERY_SYNC_DELAY_MS);
  }

  private handleAgentEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const agentPayload = payload as AgentEventPayload;
    const runId = typeof agentPayload.runId === 'string' ? agentPayload.runId.trim() : '';
    const sessionKey = typeof agentPayload.sessionKey === 'string' ? agentPayload.sessionKey.trim() : '';
    const stream = typeof agentPayload.stream === 'string' ? agentPayload.stream.trim() : '';
    const lifecyclePhase = stream === 'lifecycle' ? getAgentLifecyclePhase(agentPayload.data) : '';
    let reopenedSessionId: string | undefined;

    if (runId && this.isRecentlyClosedRunId(runId)) {
      if (stream !== 'lifecycle' || lifecyclePhase !== AgentLifecyclePhase.Start || !sessionKey) {
        console.debug('[OpenClawRuntime] dropped late agent event for a closed run.');
        return;
      }
      const retrySessionId = this.resolveSessionIdBySessionKey(sessionKey);
      if (!retrySessionId || !this.reopenRecentlyClosedRunForRetry(retrySessionId, sessionKey, runId)) {
        console.debug('[OpenClawRuntime] dropped closed run lifecycle start because it was not a valid retry.');
        return;
      }
      reopenedSessionId = retrySessionId;
    }

    if (lifecyclePhase === AgentLifecyclePhase.Fallback) {
      console.debug('[OpenClawRuntime] ignored agent lifecycle fallback event.');
      return;
    }

    if (stream === 'lifecycle'
      && (lifecyclePhase === AgentLifecyclePhase.End || lifecyclePhase === AgentLifecyclePhase.Error)
      && sessionKey
      && this.subagentTracker.tryMarkTerminalFromSessionKey(
        sessionKey,
        lifecyclePhase === AgentLifecyclePhase.Error ? 'error' : 'done',
      )) {
      return;
    }

    const sessionIdByRunId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    const sessionIdBySessionKey = sessionKey ? this.resolveSessionIdBySessionKey(sessionKey) ?? undefined : undefined;
    let sessionId = reopenedSessionId ?? sessionIdByRunId ?? sessionIdBySessionKey;

    // Re-create ActiveTurn for channel session follow-up turns.
    // Exclude stream=error events (e.g. seq gap notifications) — they are diagnostic alerts,
    // not new run events, and must not create a ghost ActiveTurn that blocks the next user turn.
    // Also exclude runIds that have already been terminated (lifecycle phase=error received),
    // which prevents gateway retries from spawning new turns and surfacing duplicate errors.
    if (sessionId && !this.activeTurns.has(sessionId) && sessionKey && stream !== 'error' && !this.terminatedRunIds.has(runId)) {
      // Desktop sessions (lobsterai:*) that were manually stopped must not be
      // re-activated by late-arriving gateway events (e.g. MCP tool results that
      // arrive after the user clicked Stop).  Only channel/cron sessions are
      // allowed to re-create turns after the stop cooldown expires.
      if (this.manuallyStoppedSessions.has(sessionId) && isManagedSessionKey(sessionKey)) {
        console.log('[Debug:handleAgentEvent] suppressed — desktop session was manually stopped, sessionId:', sessionId);
        return;
      }
      console.log('[Debug:handleAgentEvent] re-creating ActiveTurn for follow-up turn, sessionId:', sessionId);
      this.ensureActiveTurn(sessionId, sessionKey, runId);
    }

    // Try to resolve channel-originated sessions (e.g. Telegram via OpenClaw)
    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId = this.channelSessionSync.resolveOrCreateSession(sessionKey)
        || (!this.heartbeatSessionKeys.has(sessionKey) && this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey))
        || this.channelSessionSync.resolveOrCreateCronSession(sessionKey)
        || null;
      console.log('[Debug:handleAgentEvent] channel resolve — channelSessionId:', channelSessionId);
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.deletedChannelKeys.has(sessionKey)) {
          this.deletedChannelKeys.delete(sessionKey);
          this.fullySyncedSessions.add(channelSessionId);
          this.reCreatedChannelSessionIds.add(channelSessionId);
          console.log('[Debug:handleAgentEvent] re-created after delete, skipping history sync for:', sessionKey);
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
        this.ensureActiveTurn(channelSessionId, sessionKey, runId);
      }
    }

    if (!sessionId) {
      if (stream === 'lifecycle'
        && (lifecyclePhase === AgentLifecyclePhase.End || lifecyclePhase === AgentLifecyclePhase.Error)) {
        console.warn(
          '[OpenClawRuntime] dropping terminal agent lifecycle event because no sessionId resolved',
          `phase=${lifecyclePhase}`,
          `runId=${runId || 'unknown'}`,
          `sessionKey=${sessionKey || 'unknown'}`,
        );
      }
      console.log('[Debug:handleAgentEvent] no sessionId, dropping event. runId:', runId, 'sessionKey:', sessionKey);
      if (runId) {
        this.enqueuePendingAgentEvent(runId, agentPayload, seq);
      }
      return;
    }
    if (sessionIdByRunId && sessionIdBySessionKey && sessionIdByRunId !== sessionIdBySessionKey) {
      console.log('[Debug:handleAgentEvent] sessionId mismatch, dropping. byRunId:', sessionIdByRunId, 'bySessionKey:', sessionIdBySessionKey);
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      if (stream === 'lifecycle'
        && (lifecyclePhase === AgentLifecyclePhase.End || lifecyclePhase === AgentLifecyclePhase.Error)) {
        console.warn(
          '[OpenClawRuntime] dropping terminal agent lifecycle event because no active turn exists',
          `phase=${lifecyclePhase}`,
          `sessionId=${sessionId}`,
          `runId=${runId || 'unknown'}`,
          `sessionKey=${sessionKey || 'unknown'}`,
        );
      }
      console.log('[Debug:handleAgentEvent] no active turn for sessionId:', sessionId);
      return;
    }

    if (sessionKey && !runId && turn.sessionKey !== sessionKey) {
      console.log('[Debug:handleAgentEvent] sessionKey mismatch, dropping. event:', sessionKey, 'turn:', turn.sessionKey);
      return;
    }

    if (runId) {
      const mappedSessionId = this.sessionIdByRunId.get(runId);
      if (mappedSessionId && mappedSessionId !== sessionId) {
        console.log('[Debug:handleAgentEvent] runId mapped to different session, dropping. mapped:', mappedSessionId, 'current:', sessionId);
        return;
      }
      this.bindRunIdToTurn(sessionId, runId);
    }

    // Buffer agent events while user messages are being prefetched for channel sessions.
    // Must be checked BEFORE seq dedup so that replayed events are not dropped.
    if (turn.pendingUserSync) {
      console.log('[Debug:handleAgentEvent] buffering agent event (pendingUserSync), sessionId:', sessionId, 'buffered:', turn.bufferedAgentPayloads.length + 1);
      turn.bufferedAgentPayloads.push({ payload: agentPayload, seq, bufferedAt: Date.now() });
      return;
    }

    // Sequence-based dedup (placed after buffer check to match handleChatEvent pattern)
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastAgentSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastAgentSeqByRunId.set(runId, seq);
    }

    if (stream !== 'lifecycle' || lifecyclePhase !== AgentLifecyclePhase.End) {
      this.cancelLifecycleEndFallback(sessionId, turn, 'agent stream continued');
    }

    // Fast-path: skip assistant-stream events — they carry the same text as
    // chat deltas and dispatchAgentEvent() has no handler for stream=assistant.
    if (stream === 'assistant') {
      const dataField = isRecord(agentPayload.data) ? agentPayload.data as Record<string, unknown> : {};
      const assistantText = extractOpenClawAssistantStreamText(dataField) || extractOpenClawAssistantStreamText(agentPayload);
      if (!isHeartbeatAckText(assistantText) && !isSilentReplyText(assistantText) && !isSilentReplyPrefixText(assistantText)) {
        this.postponeChatFinalCompletion(sessionId, turn, 'assistant stream continued');
      }
      return;
    }

    const shouldKeepRunningAfterFinal = stream === 'tool'
      || stream === 'tools'
      || stream === 'compaction'
      || (!stream && isRecord(agentPayload.data) && typeof agentPayload.data.toolCallId === 'string')
      || (stream === 'lifecycle' && getAgentLifecyclePhase(agentPayload.data) !== AgentLifecyclePhase.End);
    if (shouldKeepRunningAfterFinal) {
      this.cancelChatFinalCompletion(sessionId, turn, 'agent stream continued');
    }

    this.dispatchAgentEvent(sessionId, turn, {
      ...agentPayload,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
  }

  private dispatchAgentEvent(sessionId: string, turn: ActiveTurn, agentPayload: AgentEventPayload): void {
    const stream = typeof agentPayload.stream === 'string' ? agentPayload.stream.trim() : '';
    const hasToolShape = isRecord(agentPayload.data) && typeof agentPayload.data.toolCallId === 'string';
    if (stream === 'tool' || stream === 'tools' || (!stream && hasToolShape)) {
      if (Array.isArray(agentPayload.data)) {
        for (const entry of agentPayload.data) {
          this.handleAgentToolEvent(sessionId, turn, entry);
        }
      } else {
        this.handleAgentToolEvent(sessionId, turn, agentPayload.data);
      }
      return;
    }
    if (stream === 'lifecycle') {
      // Mark runId as terminated immediately on phase=error so that subsequent retries
      // (which reuse the same runId) are blocked from re-creating an ActiveTurn.
      const lifecycleData = agentPayload.data;
      const lifecycleRunId = typeof agentPayload.runId === 'string' ? agentPayload.runId.trim() : '';
      if (getAgentLifecyclePhase(lifecycleData) === AgentLifecyclePhase.Error && lifecycleRunId) {
        this.terminatedRunIds.add(lifecycleRunId);
      }
      this.handleAgentLifecycleEvent(sessionId, agentPayload.data, lifecycleRunId || undefined);
      return;
    }
    if (stream === 'compaction') {
      const compactionData = isRecord(agentPayload.data) ? agentPayload.data : {};
      const phase = typeof compactionData.phase === 'string' && compactionData.phase.trim()
        ? compactionData.phase.trim()
        : 'unknown';
      const runId = typeof agentPayload.runId === 'string' && agentPayload.runId.trim()
        ? agentPayload.runId.trim()
        : 'unknown';
      console.log(`[OpenClawRuntime] received a compaction stream event for session ${sessionId}, run ${runId}, phase ${phase}.`);
      this.handleAgentCompactionEvent(sessionId, agentPayload.data);
    }
  }

  private enqueuePendingAgentEvent(runId: string, payload: AgentEventPayload, seq?: number): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    if (this.isRecentlyClosedRunId(normalizedRunId)) return;

    const stream = typeof payload.stream === 'string' ? payload.stream.trim() : '';
    if (stream === 'lifecycle' && getAgentLifecyclePhase(payload.data) === AgentLifecyclePhase.Fallback) {
      return;
    }
    const hasToolShape = isRecord(payload.data) && typeof payload.data.toolCallId === 'string';
    const isSupportedStream = stream === 'tool'
      || stream === 'tools'
      || stream === 'lifecycle'
      || stream === 'compaction'
      || (!stream && hasToolShape);
    if (!isSupportedStream) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId) ?? [];
    queued.push({
      runId: normalizedRunId,
      sessionKey: payload.sessionKey,
      stream: payload.stream,
      data: payload.data,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
    if (queued.length > 240) {
      queued.shift();
    }
    this.pendingAgentEventsByRunId.set(normalizedRunId, queued);

    if (this.pendingAgentEventsByRunId.size > 400) {
      const oldestRunId = this.pendingAgentEventsByRunId.keys().next().value as string | undefined;
      if (oldestRunId) {
        this.pendingAgentEventsByRunId.delete(oldestRunId);
      }
    }
  }

  private flushPendingAgentEvents(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId);
    if (!queued || queued.length === 0) return;
    this.pendingAgentEventsByRunId.delete(normalizedRunId);

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    for (const event of queued) {
      this.dispatchAgentEvent(sessionId, turn, event);
    }
  }

  private rememberSessionKey(sessionId: string, sessionKey: string): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.sessionIdBySessionKey.set(normalizedSessionKey, sessionId);
  }

  private resolveSessionIdBySessionKey(sessionKey: string): string | null {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return null;

    const mappedSessionId = this.sessionIdBySessionKey.get(normalizedSessionKey);
    if (mappedSessionId) {
      return mappedSessionId;
    }

    const parsedManagedSession = parseManagedSessionKey(normalizedSessionKey);
    if (!parsedManagedSession) {
      return this.resolveLocalSessionIdFromGatewaySessionKey(normalizedSessionKey);
    }

    const session = this.store.getSession(parsedManagedSession.sessionId);
    if (!session) {
      return null;
    }

    this.rememberSessionKey(session.id, normalizedSessionKey);
    this.rememberSessionKey(session.id, this.toSessionKey(session.id, session.agentId));
    return session.id;
  }

  private resolveLocalSessionIdFromGatewaySessionKey(sessionKey: string): string | null {
    const match = /^agent:([^:]+):([^:]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(sessionKey);
    if (!match) {
      return null;
    }

    const [, agentId, source, candidateSessionId] = match;
    const session = this.store.getSession(candidateSessionId);
    if (!session) {
      console.debug(
        '[OpenClawRuntime] ignored gateway session key with unknown local session id',
        `sessionKey=${sessionKey}`,
        `agentId=${agentId}`,
        `source=${source}`,
      );
      return null;
    }
    const localAgentId = typeof session.agentId === 'string' && session.agentId.trim()
      ? session.agentId.trim()
      : 'main';
    if (agentId !== localAgentId) {
      console.debug(
        '[OpenClawRuntime] ignored gateway session key with mismatched local agent id',
        `sessionId=${candidateSessionId}`,
        `sessionKeyAgentId=${agentId}`,
        `localAgentId=${localAgentId}`,
        `source=${source}`,
      );
      return null;
    }

    this.rememberSessionKey(session.id, sessionKey);
    this.rememberSessionKey(session.id, this.toSessionKey(session.id, session.agentId));
    console.warn(
      '[OpenClawRuntime] resolved non-managed gateway session key to local session by id fallback',
      `sessionId=${session.id}`,
      `agentId=${agentId}`,
      `source=${source}`,
    );
    return session.id;
  }

  private nextTurnToken(sessionId: string): number {
    const nextToken = (this.latestTurnTokenBySession.get(sessionId) ?? 0) + 1;
    this.latestTurnTokenBySession.set(sessionId, nextToken);
    return nextToken;
  }

  private isCurrentTurnToken(sessionId: string, turnToken: number): boolean {
    return (this.latestTurnTokenBySession.get(sessionId) ?? 0) === turnToken;
  }

  private ensureFirstResponseTiming(turn: ActiveTurn): FirstResponseTiming {
    if (!turn.firstResponseTiming) {
      turn.firstResponseTiming = { turnStartedAtMs: turn.startedAtMs || Date.now() };
    }
    return turn.firstResponseTiming;
  }

  private logFirstResponseTiming(
    sessionId: string,
    turn: ActiveTurn,
    source: 'agent' | 'chat',
    visibleTextLength: number,
  ): void {
    const timing = this.ensureFirstResponseTiming(turn);
    if (timing.firstVisibleAssistantAtMs) {
      return;
    }

    const now = Date.now();
    timing.firstVisibleAssistantAtMs = now;
    timing.firstVisibleAssistantSource = source;
    console.log(
      '[OpenClawRuntimeTiming] first visible assistant content received.',
      `Session ${sessionId}.`,
      `Run ${turn.runId}.`,
      `Source ${source}.`,
      `Visible text length ${visibleTextLength}.`,
      `Total ${formatTimingOffset(timing.turnStartedAtMs, now)}.`,
      `Gateway ready ${formatTimingDuration(timing.gatewayReadyStartedAtMs, timing.gatewayReadyEndedAtMs)}.`,
      `Model patch ${formatTimingDuration(timing.modelPatchStartedAtMs, timing.modelPatchEndedAtMs)}.`,
      `Prompt build ${formatTimingDuration(timing.promptBuildStartedAtMs, timing.promptBuildEndedAtMs)}.`,
      `History probe ${formatTimingDuration(timing.chatHistoryStartedAtMs, timing.chatHistoryEndedAtMs)}.`,
      `Chat send ack ${formatTimingDuration(timing.chatSendStartedAtMs, timing.chatSendAckAtMs)}.`,
      `Ack to lifecycle ${formatTimingDuration(timing.chatSendAckAtMs, timing.lifecycleStartedAtMs)}.`,
      `Lifecycle to first content ${formatTimingDuration(timing.lifecycleStartedAtMs, now)}.`,
      `Ack to first content ${formatTimingDuration(timing.chatSendAckAtMs, now)}.`,
    );
  }

  private reuseFinalAssistantMessage(sessionId: string, content: string): string | null {
    const session = this.store.getSession(sessionId);
    const messages = session?.messages ?? [];
    const messageId = findReusableFinalAssistantMessageId(messages, content);
    if (!messageId) {
      return null;
    }

    this.store.updateMessage(sessionId, messageId, {
      content,
      metadata: {
        isStreaming: false,
        isFinal: true,
      },
    });
    return messageId;
  }

  private reuseCommittedAssistantMessage(
    sessionId: string,
    turn: ActiveTurn,
    content: string,
  ): string | null {
    const session = this.store.getSession(sessionId);
    const messageId = findReusableCommittedAssistantMessageId(
      session?.messages ?? [],
      turn.lastCommittedAssistantMessageId,
      content,
    );
    if (!messageId) {
      return null;
    }

    const finalMetadata = {
      isStreaming: false,
      isFinal: true,
    };
    this.store.updateMessage(sessionId, messageId, {
      content,
      metadata: finalMetadata,
    });
    this.emit('messageUpdate', sessionId, messageId, content, finalMetadata);
    return messageId;
  }

  private removeRedundantFinalPrefixSegment(
    sessionId: string,
    finalMessageId: string | null | undefined,
    finalText: string,
  ): void {
    const session = this.store.getSession(sessionId);
    const messages = session?.messages ?? [];
    const redundantMessageId = findRedundantFinalPrefixMessageId(messages, finalMessageId, finalText);
    if (!redundantMessageId) {
      return;
    }

    console.debug(
      '[OpenClawRuntime] removing redundant assistant prefix segment before final.',
      `sessionId=${sessionId}`,
      `messageId=${redundantMessageId}`,
      `finalMessageId=${finalMessageId ?? 'pending'}`,
    );
    this.deleteAssistantMessage(sessionId, redundantMessageId);
  }

  private resolveAssistantMessageIdForUsage(sessionId: string, preferredMessageId?: string | null): string | undefined {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const isVisibleAssistant = (message: CoworkMessage): boolean =>
      message.type === 'assistant' && !isSilentReplyText(message.content);
    if (
      preferredMessageId
      && session.messages.some((message) => message.id === preferredMessageId && isVisibleAssistant(message))
    ) {
      return preferredMessageId;
    }
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (isVisibleAssistant(session.messages[i])) {
        return session.messages[i].id;
      }
    }
    return undefined;
  }

  private handleAgentLifecycleEvent(sessionId: string, data: unknown, eventRunId?: string): void {
    if (!isRecord(data)) return;
    const phase = getAgentLifecyclePhase(data);
    if (phase === AgentLifecyclePhase.Fallback) {
      return;
    }
    if (phase === AgentLifecyclePhase.Start) {
      this.store.updateSession(sessionId, { status: 'running' });
      this.emitSessionStatus(sessionId, 'running');
      const startingTurn = this.activeTurns.get(sessionId);
      if (startingTurn) {
        const timing = this.ensureFirstResponseTiming(startingTurn);
        if (timing.lifecycleStartedAtMs) {
          return;
        }
        timing.lifecycleStartedAtMs = Date.now();
        console.log(
          '[OpenClawRuntimeTiming] agent lifecycle started.',
          `Session ${sessionId}.`,
          `Run ${eventRunId ?? startingTurn.runId}.`,
          `Total ${formatTimingOffset(timing.turnStartedAtMs, timing.lifecycleStartedAtMs)}.`,
          `Ack to lifecycle ${formatTimingDuration(timing.chatSendAckAtMs, timing.lifecycleStartedAtMs)}.`,
        );
      }
    }
    if (phase === AgentLifecyclePhase.End) {
      // Detect announce completion — mark subagent done and skip parent turn
      // lifecycle handling (announce is an embedded run, not the parent's end).
      if (eventRunId && this.subagentTracker.tryMarkDoneFromAnnounceRunId(eventRunId)) {
        return;
      }
      const endingTurn = this.activeTurns.get(sessionId);
      if (endingTurn) {
        endingTurn.lastAttemptEndedAtMs = Date.now();
      }
      const endingRunId = eventRunId
        ?? endingTurn?.runId
        ?? (isRecord(data) && typeof data.runId === 'string' ? data.runId : null);
      if (
        endingTurn?.planMode
        && endingTurn.planModeSafetyRecoveryPending
        && (!endingRunId || !endingTurn.planModeSafetyRecoveryAbortedRunId || endingRunId === endingTurn.planModeSafetyRecoveryAbortedRunId)
      ) {
        this.schedulePlanModeSafetyRecovery(
          sessionId,
          endingTurn,
          OpenClawRuntimeAdapter.PLAN_MODE_SAFETY_RECOVERY_AFTER_LIFECYCLE_END_MS,
          'aborted run lifecycle ended',
        );
        return;
      }
      if (endingTurn && this.isWaitingForRecoverableFollowup(endingTurn)) {
        this.scheduleLifecycleEndFallback(
          sessionId,
          endingTurn,
          endingRunId ?? undefined,
          OpenClawRuntimeAdapter.TOOL_USE_FINAL_LIFECYCLE_END_GRACE_MS,
        );
        return;
      }
      if (
        endingTurn?.finalCompletionTimer &&
        endingTurn.finalCompletionFlushOnLifecycleEnd !== false &&
        (!endingRunId || endingTurn.knownRunIds.has(endingRunId))
      ) {
        void this.completeDeferredChatFinalNow(
          sessionId,
          endingTurn,
          endingRunId ?? endingTurn.finalCompletionRunId ?? endingTurn.runId,
        );
        return;
      }
      if (endingTurn?.finalCompletionTimer && endingTurn.finalCompletionFlushOnLifecycleEnd === false) {
        // Silent memory-maintenance turns intentionally outlive the maintenance
        // run's lifecycle=end so the original user request can continue in the
        // follow-up run. Completing here would mark that follow-up run as closed.
        return;
      }
      // Deferred completion fallback: the gateway should send a `chat state=final`
      // event that triggers handleChatFinal(). But after the OpenClaw upgrade, this
      // event may not arrive reliably for IM channel sessions.  The agent lifecycle
      // `phase=end` event IS reliable.  Wait a short window for handleChatFinal() to
      // run; if the turn is still active after that, complete it ourselves.
      const fallbackDelayMs = endingTurn?.lastToolUseChatFinalAtMs
        ? OpenClawRuntimeAdapter.TOOL_USE_FINAL_LIFECYCLE_END_GRACE_MS
        : OpenClawRuntimeAdapter.CHAT_FINAL_COMPLETION_GRACE_MS;
      this.scheduleLifecycleEndFallback(sessionId, endingTurn, endingRunId ?? undefined, fallbackDelayMs);
    }

    if (phase === AgentLifecyclePhase.Error) {
      // Deferred error fallback: the gateway should also send a `chat state=error`
      // event that triggers handleChatError().  But after the OpenClaw upgrade, this
      // event may not arrive reliably — similar to the phase=end / chat final gap.
      // Wait for the gateway chat error or retry/compaction path to settle first;
      // if the turn is still active after that, surface the error ourselves.
      const rawErrorMessage = typeof data.error === 'string' ? data.error.trim() : 'OpenClaw run failed';
      const errorMetadata = normalizeOpenClawSafeRuntimeErrorMetadata(data);
      const errorTurn = this.activeTurns.get(sessionId);
      const errorRunId = eventRunId
        ?? errorTurn?.runId
        ?? (typeof data.runId === 'string' ? data.runId : null);
      setTimeout(() => {
        const turn = this.activeTurns.get(sessionId);
        if (!turn) return; // Already handled by handleChatError
        // If a different run started while the fallback was pending, leave it alone.
        if (errorRunId && !turn.knownRunIds.has(errorRunId)) return;
        const errorMessage = resolveOpenClawRuntimeErrorMessage(rawErrorMessage, errorMetadata);
        console.log(`[OpenClawRuntime] lifecycle error fallback surfaced an error after waiting for the gateway chat error event in session ${sessionId}: ${errorMessage}`);
        // Abort the retrying run on the gateway so the session is freed for new messages.
        // Without this, the gateway continues retrying indefinitely and rejects subsequent chat.send requests.
        const client = this.gatewayClient;
        if (client) {
          console.log(`[OpenClawRuntime] lifecycle error fallback is aborting gateway run ${turn.runId} after the retry grace window for ${turn.sessionKey}.`);
          void client.request('chat.abort', {
            sessionKey: turn.sessionKey,
            runId: turn.runId,
          }).catch((err) => {
            console.warn('[OpenClawRuntime] lifecycle error fallback: chat.abort failed:', err);
          });
        }
        const erroredSessionKey = turn.sessionKey;
        this.store.updateSession(sessionId, { status: 'error' });
        const errorMsg = this.store.addMessage(sessionId, {
          type: 'system',
          content: errorMessage,
          metadata: { error: errorMessage },
        });
        this.emit('message', sessionId, errorMsg);
        this.emit('error', sessionId, errorMessage);
        this.cleanupSessionTurn(sessionId);
        this.rejectTurn(sessionId, new Error(errorMessage));
        void this.syncSessionHistoryFromGateway(sessionId, erroredSessionKey);
      }, OpenClawRuntimeAdapter.LIFECYCLE_ERROR_FALLBACK_DELAY_MS);
    }
  }

  private getContextCompactionContent(status: ContextCompactionStatus): string {
    switch (status) {
      case ContextCompactionStatus.Running:
        return 'Context compaction in progress';
      case ContextCompactionStatus.Retrying:
        return 'Context compaction completed, continuing task';
      case ContextCompactionStatus.Failed:
        return 'Context compaction did not complete';
      case ContextCompactionStatus.Completed:
      default:
        return 'Context compaction completed';
    }
  }

  private getSessionMessage(sessionId: string, messageId: string | undefined): CoworkMessage | null {
    if (!messageId) return null;
    const session = this.store.getSession(sessionId);
    return session?.messages.find((message) => message.id === messageId) ?? null;
  }

  private buildContextCompactionMetadata(
    turn: ActiveTurn,
    status: ContextCompactionStatus,
    timestamp: number,
  ): CoworkMessageMetadata {
    return {
      kind: CoworkSystemMessageKind.ContextCompaction,
      mode: ContextCompactionMode.Auto,
      status,
      runId: turn.runId,
      startedAt: turn.contextCompactionStartedAt ?? timestamp,
      ...(status !== ContextCompactionStatus.Running ? { completedAt: timestamp } : {}),
    };
  }

  private createContextCompactionMessage(sessionId: string, turn: ActiveTurn, timestamp: number): void {
    turn.contextCompactionStartedAt = timestamp;
    const metadata = this.buildContextCompactionMetadata(turn, ContextCompactionStatus.Running, timestamp);
    const message = this.store.addMessage(sessionId, {
      type: 'system',
      content: this.getContextCompactionContent(ContextCompactionStatus.Running),
      metadata,
    }, timestamp);
    turn.contextCompactionMessageId = message.id;
    this.emit('message', sessionId, message);
  }

  private markContextCompactionRunning(sessionId: string, turn: ActiveTurn, timestamp: number): void {
    const existingMessage = this.getSessionMessage(sessionId, turn.contextCompactionMessageId);
    if (existingMessage?.metadata?.status !== ContextCompactionStatus.Running) {
      this.createContextCompactionMessage(sessionId, turn, timestamp);
      return;
    }

    const metadata = this.buildContextCompactionMetadata(turn, ContextCompactionStatus.Running, timestamp);
    const content = this.getContextCompactionContent(ContextCompactionStatus.Running);
    this.store.updateMessage(sessionId, existingMessage.id, {
      content,
      metadata,
    });
    this.emit('messageUpdate', sessionId, existingMessage.id, content, metadata);
  }

  private updateContextCompactionMessage(
    sessionId: string,
    turn: ActiveTurn,
    status: ContextCompactionStatus,
    timestamp: number,
  ): void {
    const existingMessage = this.getSessionMessage(sessionId, turn.contextCompactionMessageId);
    if (!existingMessage) {
      return;
    }

    const metadata = this.buildContextCompactionMetadata(turn, status, timestamp);
    const content = this.getContextCompactionContent(status);
    this.store.updateMessage(sessionId, existingMessage.id, {
      content,
      metadata,
    });
    this.emit('messageUpdate', sessionId, existingMessage.id, content, metadata);
  }

  private handleAgentCompactionEvent(sessionId: string, data: unknown): void {
    if (!isRecord(data)) {
      console.warn(`[OpenClawRuntime] ignored a context compaction event for session ${sessionId} because the payload was invalid.`);
      return;
    }
    const phase = typeof data.phase === 'string' ? data.phase.trim() : '';
    const turn = this.activeTurns.get(sessionId);
    if (phase === 'start') {
      if (turn) {
        turn.hasContextCompactionEvent = true;
        this.markContextCompactionRunning(sessionId, turn, Date.now());
      }
      this.store.updateSession(sessionId, { status: 'running' });
      this.emitSessionStatus(sessionId, 'running');
      this.emitContextMaintenance(sessionId, true);
      this.refreshContinuityCapsule(sessionId, ContinuityCapsuleSource.PreCompaction);
      console.log(`[OpenClawRuntime] context compaction started for session ${sessionId}.`);
      return;
    }
    if (phase !== 'end') {
      console.debug(`[OpenClawRuntime] ignored a context compaction event for session ${sessionId} because phase ${phase || 'unknown'} is unsupported.`);
      return;
    }

    if (turn) {
      turn.hasContextCompactionEvent = false;
    }
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    const completed = data.completed === true;
    const willRetry = data.willRetry === true;
    let compactionStatus: ContextCompactionStatus = ContextCompactionStatus.Failed;
    if (willRetry) {
      compactionStatus = ContextCompactionStatus.Retrying;
    } else if (completed) {
      compactionStatus = ContextCompactionStatus.Completed;
    }
    if (turn) {
      this.updateContextCompactionMessage(sessionId, turn, compactionStatus, Date.now());
    }
    if (turn && willRetry) {
      this.waitForRecoverableOpenClawRetry(sessionId, turn, turn.runId, {
        reason: 'context compaction requested retry',
        graceMs: OpenClawRuntimeAdapter.VISIBLE_FINAL_CONTINUATION_GRACE_MS,
      });
    } else {
      this.emitContextMaintenance(sessionId, false);
    }
    console.log(`[OpenClawRuntime] context compaction ended for session ${sessionId}, completed=${completed}, willRetry=${willRetry}.`);
    if (completed) {
      this.refreshContinuityCapsule(sessionId, ContinuityCapsuleSource.PostCompaction, {
        compactedAt: Date.now(),
      });
      void this.logContextCompactionDiagnostic({
        sessionId,
        mode: 'auto',
        compacted: true,
      });
      this.refreshAndEmitContextUsage(sessionId);
      setTimeout(() => {
        this.refreshAndEmitContextUsage(sessionId);
      }, 1500);
    }
  }

  private refreshAndEmitContextUsage(sessionId: string): void {
    void this.getContextUsage(sessionId).then((usage) => {
      if (usage) {
        this.emit('contextUsageUpdate', sessionId, usage);
      }
    }).catch((error) => {
      console.warn('[OpenClawRuntime] context usage refresh after compaction failed:', error);
    });
  }

  private scheduleLifecycleEndFallback(
    sessionId: string,
    turn: ActiveTurn | undefined,
    endingRunId: string | undefined,
    delayMs: number,
  ): void {
    if (!turn) return;
    if (turn.lifecycleEndFallbackTimer) {
      clearTimeout(turn.lifecycleEndFallbackTimer);
    }
    const turnToken = turn.turnToken;
    turn.lifecycleEndFallbackTimer = setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turnToken) return;
      currentTurn.lifecycleEndFallbackTimer = undefined;
      if (endingRunId && !currentTurn.knownRunIds.has(endingRunId)) return;
      if (this.isWaitingForRecoverableFollowup(currentTurn) || currentTurn.finalCompletionTimer) {
        console.debug('[OpenClawRuntime] lifecycle end fallback stayed open while waiting for retry follow-up.');
        return;
      }
      console.log('[OpenClawRuntime] agent lifecycle end fallback completed a turn that missed chat final.');
      void this.completeChannelTurnFallback(sessionId, currentTurn);
    }, delayMs);
    console.debug('[OpenClawRuntime] scheduled lifecycle end fallback for missing chat.final.');
  }

  private cancelLifecycleEndFallback(sessionId: string, turn: ActiveTurn, reason: string): void {
    if (!turn.lifecycleEndFallbackTimer) return;
    clearTimeout(turn.lifecycleEndFallbackTimer);
    turn.lifecycleEndFallbackTimer = undefined;
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    console.debug(`[OpenClawRuntime] canceled lifecycle end fallback because ${reason}.`);
  }

  /**
   * Fallback completion for turns that never received a `chat state=final`
   * event. Called from handleAgentLifecycleEvent after a delay to give the normal
   * handleChatFinal path time to run first.
   */
  private async completeChannelTurnFallback(sessionId: string, turn: ActiveTurn): Promise<void> {
    if (!this.activeTurns.has(sessionId)) return;

    try {
      if (isManagedSessionKey(turn.sessionKey)) {
        await this.syncFinalAssistantWithHistory(sessionId, turn);
      } else {
        await this.syncSessionHistoryFromGateway(sessionId, turn.sessionKey);
      }
    } catch (error) {
      console.warn('[OpenClawRuntime] fallback final sync failed:', error);
    }

    // Re-check after async final sync — handleChatFinal may have run in the meantime
    if (!this.activeTurns.has(sessionId)) return;
    if (this.isWaitingForRecoverableFollowup(turn) || turn.finalCompletionTimer) return;

    const fallbackContinuation = this.shouldWaitForLifecycleFallbackContinuation(sessionId, turn);
    if (fallbackContinuation.wait) {
      this.waitForRecoverableOpenClawRetry(sessionId, turn, turn.runId, {
        reason: fallbackContinuation.reason,
        graceMs: fallbackContinuation.graceMs,
        pendingThinkingOnlyHint: fallbackContinuation.pendingThinkingOnlyHint,
        pendingVisibleFinalContinuation: fallbackContinuation.pendingVisibleFinalContinuation,
      });
      console.debug(
        '[OpenClawRuntime] lifecycle fallback stayed open after history sync because a retry may follow.',
        `sessionId=${sessionId}`,
        `runId=${turn.runId}`,
        `reason=${fallbackContinuation.reason}`,
        `toolResultChars=${fallbackContinuation.toolResultChars}`,
        `visibleTextLen=${fallbackContinuation.visibleTextLen}`,
      );
      return;
    }

    // Sync usage metadata (same logic as handleChatFinal)
    if (turn.sessionKey) {
      const targetMessageId = this.resolveAssistantMessageIdForUsage(sessionId, turn.assistantMessageId);
      if (targetMessageId) {
        void this.syncUsageMetadata(sessionId, turn.sessionKey, targetMessageId);
      }
    }

    if (this.hasTurnToolWork(sessionId, turn)) {
      turn.allowRecentlyClosedRunRetryReopenOnCleanup = true;
    }

    this.store.updateSession(sessionId, { status: 'completed' });
    this.emit('complete', sessionId, turn.runId);
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
  }

  private handleAgentToolEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    const rawPhase = typeof data.phase === 'string' ? data.phase.trim() : '';
    const phase = rawPhase === 'end' ? 'result' : rawPhase;
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';

    if (isContextMaintenanceToolEvent(data)) {
      turn.hasContextMaintenanceTool = true;
      if (toolCallId) {
        turn.contextMaintenanceToolCallIds.add(toolCallId);
      }
      this.store.updateSession(sessionId, { status: 'running' });
      this.emitSessionStatus(sessionId, 'running');
      this.emitContextMaintenance(sessionId, true);
      return;
    }
    if (toolCallId && turn.contextMaintenanceToolCallIds.has(toolCallId)) {
      return;
    }
    if (toolCallId && turn.planModeSuppressedToolCallIds?.has(toolCallId)) {
      return;
    }

    if (!toolCallId) return;
    if (phase !== 'start' && phase !== 'update' && phase !== 'result') return;

    const toolNameRaw = typeof data.name === 'string' ? data.name.trim() : '';
    const toolName = toolNameRaw || 'Tool';

    if (phase === 'start' && turn.planMode) {
      const blockedReason = getPlanModeBlockedToolReason(toolNameRaw, data.args);
      if (blockedReason) {
        console.warn(
          `[OpenClawRuntime] blocked ${toolName} in plan mode for session ${sessionId}: ${blockedReason}.`,
        );
        (turn.planModeSuppressedToolCallIds ??= new Set()).add(toolCallId);
        if (turn.planModeRecoveryAttempted || turn.planModeSafetyRecoveryPending) {
          console.warn(
            `[OpenClawRuntime] stopped plan mode session ${sessionId} after a repeated blocked tool call.`,
          );
          this.stopSession(sessionId);
          return;
        }
        turn.planModeRecoveryAttempted = true;
        turn.planModeSafetyRecoveryPending = true;
        turn.planModeSafetyRecoveryAbortedRunId = turn.runId;
        void Promise.resolve().then(() => this.requireGatewayClient().request('chat.abort', {
          sessionKey: turn.sessionKey,
          runId: turn.runId,
        })).catch((error) => {
          if (this.activeTurns.get(sessionId) !== turn || !turn.planModeSafetyRecoveryPending) return;
          turn.planModeSafetyRecoveryPending = false;
          console.error(
            `[OpenClawRuntime] failed to abort a blocked plan mode tool for session ${sessionId}:`,
            error,
          );
          this.stopSession(sessionId);
        });
        return;
      }
      if (shouldSuppressPlanModeToolEvent(toolNameRaw, data.args)) {
        (turn.planModeSuppressedToolCallIds ??= new Set()).add(toolCallId);
        console.debug(
          `[OpenClawRuntime] suppressed a read-only ${toolName} event from the plan mode transcript for session ${sessionId}.`,
        );
        return;
      }
    }

    if (toolNameRaw.toLowerCase() === 'browser') {
      const isError = resolveToolEventIsError(data);
      // Log full data keys and values for diagnosis
      const dataKeys = Object.keys(data);
      const resultType = data.result === undefined ? 'undefined'
        : data.result === null ? 'null'
          : typeof data.result === 'string' ? `string(len=${data.result.length})`
            : Array.isArray(data.result) ? `array(len=${data.result.length})`
              : `object(keys=${Object.keys(data.result as Record<string, unknown>).join(',')})`;
      console.log(
        `[OpenClawRuntime] browser tool event: phase=${phase} toolCallId=${toolCallId}`
        + ` dataKeys=[${dataKeys.join(',')}] resultType=${resultType}`
        + (phase === 'start' ? ` args=${JSON.stringify(data.args ?? {}).slice(0, 500)}` : '')
        + (phase === 'result' ? ` isError=${isError}` : ''),
      );
      if (phase === 'result') {
        // Log full result for browser events (may contain error details)
        try {
          const fullResult = JSON.stringify(data.result, null, 2);
          console.log(`[OpenClawRuntime] browser tool result (${toolCallId}): ${fullResult?.slice(0, 2000) ?? '(null)'}`);
        } catch {
          console.log(`[OpenClawRuntime] browser tool result (${toolCallId}): [unstringifiable] ${String(data.result).slice(0, 500)}`);
        }
        if (isError) {
          // Log any additional error-related fields
          const errorFields: Record<string, unknown> = {};
          for (const key of dataKeys) {
            if (/error|reason|message|detail|status/i.test(key)) {
              errorFields[key] = data[key];
            }
          }
          if (Object.keys(errorFields).length > 0) {
            console.log(`[OpenClawRuntime] browser tool error fields (${toolCallId}): ${JSON.stringify(errorFields).slice(0, 1000)}`);
          }
        }
      }
      // Probe browser control service reachability from Electron main process
      this.probeBrowserControlService(toolCallId, phase);
    }

    if (!turn.toolUseMessageIdByToolCallId.has(toolCallId)) {
      this.splitAssistantSegmentBeforeTool(sessionId, turn);
      turn.agentAssistantTextLength = 0;

      const toolUseMessage = this.store.addMessage(sessionId, {
        type: 'tool_use',
        content: `Using tool: ${toolName}`,
        metadata: {
          toolName,
          toolInput: toToolInputRecord(data.args),
          toolUseId: toolCallId,
        },
      });
      turn.toolUseMessageIdByToolCallId.set(toolCallId, toolUseMessage.id);
      this.emit('message', sessionId, toolUseMessage);

      // Track sessions_spawn tool calls for subagent visualization
      if (toolNameRaw.toLowerCase() === 'sessions_spawn') {
        this.subagentTracker.onToolStart(toolCallId, toToolInputRecord(data.args), sessionId);
      }
    }

    if (phase === 'update') {
      const incoming = extractToolText(data.partialResult);
      const updateDetails = resolveMediaStatusToolDetails(
        turn,
        toolCallId,
        toolName,
        data.args,
        data.partialResult,
        'update',
        incoming,
      );
      if (!incoming.trim() && !updateDetails) return;

      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      let merged = previous;
      if (incoming.trim()) {
        merged = updateDetails
          ? incoming
          : mergeStreamingText(previous, incoming, 'unknown').text;
      }

      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
      const updateMetadata = {
        toolResult: merged,
        toolUseId: toolCallId,
        isError: false,
        isStreaming: true,
        isFinal: false,
        ...(updateDetails ? { toolResultDetails: updateDetails } : {}),
      };
      if (!existingResultMessageId) {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: merged,
          metadata: updateMetadata,
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('message', sessionId, resultMessage);
        return;
      }

      if (merged !== previous || updateDetails) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: merged,
          metadata: updateMetadata,
        });
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('messageUpdate', sessionId, existingResultMessageId, merged, updateMetadata);
      }
      return;
    }

    if (phase === 'result') {
      const incoming = extractToolText(data.result);
      const toolDetails = resolveMediaStatusToolDetails(
        turn,
        toolCallId,
        toolName,
        data.args,
        data.result,
        'result',
        incoming,
      );
      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const isError = resolveToolEventIsError(data);
      const finalContent = incoming.trim() ? incoming : previous;
      const finalError = isError ? (finalContent || 'Tool execution failed') : undefined;
      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
      const finalMetadata = {
        toolResult: finalContent,
        toolUseId: toolCallId,
        error: finalError,
        isError,
        isStreaming: false,
        isFinal: true,
        ...(toolDetails ? { toolResultDetails: toolDetails } : {}),
      };

      if (existingResultMessageId) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: finalContent,
          metadata: finalMetadata,
        });
        this.emit('messageUpdate', sessionId, existingResultMessageId, finalContent, finalMetadata);
      } else {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: finalContent,
          metadata: finalMetadata,
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        this.emit('message', sessionId, resultMessage);
      }
      turn.toolResultTextByToolCallId.set(toolCallId, finalContent);

      // Track subagent session keys from sessions_spawn results
      if (toolNameRaw.toLowerCase() === 'sessions_spawn' && finalContent) {
        this.subagentTracker.onSpawnResult(toolCallId, finalContent, toToolInputRecord(data.args));
      }

      // Mark subagent as done when parent retrieves result via sessions_resume/sessions_read
      if (toolNameRaw.toLowerCase() === 'sessions_resume' || toolNameRaw.toLowerCase() === 'sessions_read') {
        this.subagentTracker.onResumeOrReadResult(toToolInputRecord(data.args));
      }

      // Schedule incremental backfill if the result text is empty (gateway stripped it).
      // The authoritative text will be fetched from chat.history after a debounce window.
      if (!finalContent.trim()) {
        this.scheduleIncrementalBackfill(sessionId, toolCallId);
      }
    }
  }

  private handleChatEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const chatPayload = payload as ChatEventPayload;
    const state = chatPayload.state;
    if (!state) return;
    const runId = typeof chatPayload.runId === 'string' ? chatPayload.runId.trim() : '';
    console.debug(
      '[OpenClawRuntime] handleChatEvent:',
      `state=${state}`,
      `runId=${typeof chatPayload.runId === 'string' ? chatPayload.runId : ''}`,
      `sessionKey=${typeof chatPayload.sessionKey === 'string' ? chatPayload.sessionKey : ''}`,
      `message=${summarizeGatewayMessageShape(chatPayload.message)}`
    );

    if (runId && this.isRecentlyClosedRunId(runId)) {
      console.debug('[OpenClawRuntime] dropped late chat event for a closed run.');
      return;
    }

    const sessionId = this.resolveSessionIdFromChatPayload(chatPayload);
    if (!sessionId) {
      const sessionKey = typeof chatPayload.sessionKey === 'string' ? chatPayload.sessionKey.trim() : '';
      if ((state === 'final' || state === 'aborted' || state === 'error')
        && sessionKey
        && this.subagentTracker.tryMarkTerminalFromSessionKey(
          sessionKey,
          state === 'final' ? 'done' : 'error',
        )) {
        return;
      }
      if (state === 'final' || state === 'aborted' || state === 'error') {
        console.warn(
          '[OpenClawRuntime] dropping terminal chat event because no sessionId resolved',
          `state=${state}`,
          `runId=${runId || 'unknown'}`,
          `sessionKey=${typeof chatPayload.sessionKey === 'string' ? chatPayload.sessionKey : 'unknown'}`,
          `message=${summarizeGatewayMessageShape(chatPayload.message)}`,
        );
      }
      console.debug('[OpenClawRuntime] handleChatEvent — no sessionId resolved, dropping event');
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.debug('[OpenClawRuntime] handleChatEvent — no active turn for sessionId:', sessionId);
      return;
    }

    // Buffer chat events while user messages are being prefetched for channel sessions
    if (turn.pendingUserSync) {
      console.debug('[OpenClawRuntime] handleChatEvent — buffering (pendingUserSync), sessionId:', sessionId);
      turn.bufferedChatPayloads.push({ payload, seq, bufferedAt: Date.now() });
      return;
    }

    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastChatSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastChatSeqByRunId.set(runId, seq);
    }

    if (state === 'delta') {
      const deltaText = extractGatewayMessageText(chatPayload.message).trim();
      if (!isHeartbeatAckText(deltaText) && !isSilentReplyText(deltaText) && !isSilentReplyPrefixText(deltaText)) {
        this.cancelLifecycleEndFallback(sessionId, turn, 'chat delta continued');
        this.postponeChatFinalCompletion(sessionId, turn, 'chat delta continued');
      }
      this.handleChatDelta(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'final') {
      this.cancelLifecycleEndFallback(sessionId, turn, 'chat final arrived');
      // Detect announce chat final — mark subagent done as backup
      if (runId) {
        this.subagentTracker.tryMarkDoneFromAnnounceRunId(runId);
      }
      this.handleChatFinal(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'aborted') {
      const elapsedSec = ((Date.now() - turn.startedAtMs) / 1000).toFixed(1);
      console.warn(
        `[AbortDiag] chat aborted event received`,
        `sessionId=${sessionId}`,
        `runId=${turn.runId}`,
        `sessionKey=${turn.sessionKey}`,
        `elapsed=${elapsedSec}s`,
        `stopReason=${(chatPayload as Record<string, unknown>).stopReason ?? 'unknown'}`,
        `stopRequested=${turn.stopRequested}`,
        `manuallyStoppedSession=${this.manuallyStoppedSessions.has(sessionId)}`,
        `payload=${JSON.stringify(chatPayload).slice(0, 500)}`,
      );
      this.handleChatAborted(sessionId, turn);
      return;
    }

    if (state === 'error') {
      this.handleChatError(sessionId, turn, chatPayload);
    }
  }

  private updateTurnTextState(
    turn: ActiveTurn,
    message: unknown,
    options: { protectBoundaryDrops?: boolean; forceReplace?: boolean } = {},
  ): void {
    const contentText = extractMessageText(message).trim();
    const { textBlocks, thinkingText, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    // Update thinking text on the turn
    if (thinkingText) {
      turn.currentThinkingText = thinkingText;
    }

    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const shouldProtectBoundaryDrop = Boolean(
        options.protectBoundaryDrops
        && (turn.sawNonTextContentBlocks || sawNonTextContentBlocks)
        && isDroppedBoundaryTextBlockSubset(turn.currentContentBlocks, nextContentBlocks),
      );
      if (!shouldProtectBoundaryDrop) {
        if (options.forceReplace) {
          turn.currentContentText = contentText;
          turn.currentContentBlocks = nextContentBlocks;
          turn.textStreamMode = 'snapshot';
        } else {
          const merged = mergeStreamingText(turn.currentContentText, contentText, turn.textStreamMode);
          turn.currentContentText = merged.text;
          turn.textStreamMode = merged.mode;
          if (merged.mode === 'snapshot') {
            turn.currentContentBlocks = nextContentBlocks;
          } else {
            const mergedText = merged.text.trim();
            if (mergedText) {
              turn.currentContentBlocks = [mergedText];
            }
          }
        }
      }
    }

    if (sawNonTextContentBlocks) {
      turn.sawNonTextContentBlocks = true;
    }
    turn.currentText = turn.currentContentText.trim();
  }

  private resolveFinalTurnText(turn: ActiveTurn, message: unknown): string {
    const streamedText = turn.currentText.trim();
    const streamedTextBlocks = [...turn.currentContentBlocks];
    const streamedSawNonTextContentBlocks = turn.sawNonTextContentBlocks;

    this.updateTurnTextState(turn, message, { forceReplace: true });
    const finalText = turn.currentText.trim();

    if (!finalText) {
      return streamedText;
    }

    const shouldFallbackToStreamedText = streamedSawNonTextContentBlocks
      && isDroppedBoundaryTextBlockSubset(streamedTextBlocks, turn.currentContentBlocks);
    if (shouldFallbackToStreamedText && streamedText) {
      turn.currentContentText = streamedText;
      turn.currentContentBlocks = streamedTextBlocks;
      turn.currentText = streamedText;
      return streamedText;
    }

    return finalText;
  }

  private resolveAssistantSegmentText(turn: ActiveTurn, fullText: string): string {
    const normalizedFullText = fullText.trim();
    const committed = turn.committedAssistantText;
    if (!normalizedFullText) {
      return '';
    }
    if (!committed) {
      return normalizedFullText;
    }
    if (normalizedFullText.startsWith(committed)) {
      return normalizedFullText.slice(committed.length).trimStart();
    }
    return normalizedFullText;
  }

  private deleteAssistantMessage(sessionId: string, messageId: string): void {
    this.clearPendingStoreUpdate(messageId);
    this.clearPendingMessageUpdate(messageId);
    this.store.deleteMessage(sessionId, messageId);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('cowork:sessions:changed');
      }
    }
  }

  private deleteSilentAssistantMessages(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const silentAssistantIds = session.messages
      .filter((message) => message.type === 'assistant' && isSilentReplyText(message.content))
      .map((message) => message.id);
    for (const messageId of silentAssistantIds) {
      this.deleteAssistantMessage(sessionId, messageId);
    }
  }

  /**
   * Process agent assistant-stream text directly from handleGatewayEvent.
   * This bypasses handleAgentEvent's session resolution (which may enqueue events),
   * ensuring text updates and reset detection always work.
   */
  private processAgentAssistantText(payload: unknown): void {
    if (!isRecord(payload)) return;
    const p = payload as Record<string, unknown>;
    if (p.stream !== 'assistant') return;

    const dataField = isRecord(p.data) ? p.data as Record<string, unknown> : p;

    const parts = extractOpenClawAssistantStreamParts(dataField);
    if (!parts.text && !parts.thinking) {
      const fallback = extractOpenClawAssistantStreamParts(p);
      parts.text = parts.text || fallback.text;
      parts.thinking = parts.thinking || fallback.thinking;
    }
    const text = parts.text || extractOpenClawAssistantStreamText(p);

    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    const sessionKey = typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '';
    if (runId && this.isRecentlyClosedRunId(runId)) {
      console.debug('[OpenClawRuntime] dropped late assistant text for a closed run.');
      return;
    }
    let sessionId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey) ?? undefined;
      if (!sessionId && this.channelSessionSync) {
        sessionId = this.channelSessionSync.resolveOrCreateSession(sessionKey)
          || (!this.heartbeatSessionKeys.has(sessionKey) && this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey))
          || this.channelSessionSync.resolveOrCreateCronSession(sessionKey)
          || undefined;
        if (sessionId) {
          this.rememberSessionKey(sessionId, sessionKey);
        }
      }
      if (sessionId && !this.activeTurns.has(sessionId)) {
        this.ensureActiveTurn(sessionId, sessionKey, runId);
      }
      if (sessionId && runId) {
        this.bindRunIdToTurn(sessionId, runId);
      }
    }
    const turn = sessionId ? this.activeTurns.get(sessionId) : undefined;

    // Sync thinking message if thinking content is available
    if (parts.thinking && turn && sessionId) {
      if (parts.thinking !== turn.currentThinkingText) {
        turn.currentThinkingText = parts.thinking;
        this.syncThinkingMessage(sessionId, turn);
      }
    }

    if (!text || !turn || !sessionId) {
      if (text) {
        console.debug(
          '[Debug:processAssistant] skipped: text.len:',
          text.length,
          'runId:',
          runId.slice(0, 8),
          'sessionKey:',
          sessionKey,
          'sid:',
          !!sessionId,
          'turn:',
          !!turn
        );
      }
      return;
    }
    if (isHeartbeatAckText(text) || isSilentReplyText(text)) {
      turn.currentText = text;
      turn.currentAssistantSegmentText = '';
      if (turn.assistantMessageId) {
        this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
        turn.assistantMessageId = null;
      }
      return;
    }
    if (isSilentReplyPrefixText(text)) {
      turn.currentText = text;
      turn.currentAssistantSegmentText = '';
      if (turn.assistantMessageId) {
        this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
        turn.assistantMessageId = null;
      }
      return;
    }
    if (this.isWaitingForRecoverableFollowup(turn)) {
      turn.hasRecoverableContinuationText = true;
    }
    this.postponeChatFinalCompletion(sessionId, turn, 'assistant text continued');
    this.clearContextMaintenanceState(sessionId, turn, 'assistant text continued');

    // Detect text reset: new model call starts → text length drops significantly.
    // Only trigger when hwm is meaningful (> 5 chars) to avoid false positives
    // from early chat delta / agent event interleaving.
    if (isSignificantAssistantStreamReset(turn.agentAssistantTextLength, text.length)
        && turn.assistantMessageId) {
      console.debug('[Debug:textReset] detected:', turn.agentAssistantTextLength, '->',
        text.length, 'splitting. prevText:', turn.currentText.slice(0, 80));
      this.splitAssistantSegmentBeforeTool(sessionId, turn);
      turn.agentAssistantTextLength = 0;
    }

    // Track high-water mark.
    turn.agentAssistantTextLength = Math.max(turn.agentAssistantTextLength, text.length);

    if (text.trim().length > 0) {
      turn.hasSeenAgentAssistantStream = true;
    }

    // Update turn text state and push to store.
    turn.currentText = text;
    const displayText = stripTrailingSilentReplyTail(text);
    turn.currentAssistantSegmentText = this.resolveAssistantSegmentText(turn, displayText);
    if (turn.currentAssistantSegmentText) {
      this.logFirstResponseTiming(sessionId, turn, 'agent', turn.currentAssistantSegmentText.length);
    }

    if (!turn.assistantMessageId && turn.currentAssistantSegmentText) {
      // Create a new message for the new text segment (after split).
      const msgTimestamp = isRecord(payload.message) && typeof (payload.message as Record<string, unknown>).timestamp === 'number'
        ? (payload.message as Record<string, unknown>).timestamp as number : undefined;
      const assistantMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: turn.currentAssistantSegmentText,
        metadata: { isStreaming: true, isFinal: false },
      }, msgTimestamp);
      turn.assistantMessageId = assistantMessage.id;
      this.emit('message', sessionId, assistantMessage);
    } else if (turn.assistantMessageId && turn.currentAssistantSegmentText) {
      this.throttledStoreUpdateMessage(sessionId, turn.assistantMessageId,
        turn.currentAssistantSegmentText, { isStreaming: true, isFinal: false });
      this.throttledEmitMessageUpdate(sessionId, turn.assistantMessageId, turn.currentAssistantSegmentText);
    }
  }

  private syncThinkingMessage(sessionId: string, turn: ActiveTurn): void {
    const thinkingText = turn.currentThinkingText;
    if (!thinkingText) return;

    if (!turn.thinkingMessageId) {
      const messagePayload = {
        type: 'assistant' as const,
        content: thinkingText,
        metadata: {
          isThinking: true,
          isStreaming: true,
          isFinal: false,
        },
      };
      // If assistant message already exists, insert thinking BEFORE it
      // (agent stream may deliver text before chat delta delivers thinking)
      const insertBeforeId = turn.assistantMessageId || undefined;
      console.log('[ThinkingOrder] syncThinkingMessage CREATE: assistantMessageId=', turn.assistantMessageId, 'insertBeforeId=', insertBeforeId, 'sessionId=', sessionId);
      const thinkingMessage = insertBeforeId
        ? this.store.insertMessageBeforeId(sessionId, insertBeforeId, messagePayload)
        : this.store.addMessage(sessionId, messagePayload);
      turn.thinkingMessageId = thinkingMessage.id;
      console.log('[ThinkingOrder] emitting message with beforeMessageId=', insertBeforeId, 'thinkingMessageId=', thinkingMessage.id);
      this.emit('message', sessionId, thinkingMessage, insertBeforeId);
      return;
    }

    this.throttledStoreUpdateMessage(sessionId, turn.thinkingMessageId,
      thinkingText, { isThinking: true, isStreaming: true, isFinal: false });
    this.throttledEmitMessageUpdate(sessionId, turn.thinkingMessageId, thinkingText);
  }

  private reuseFinalThinkingMessage(sessionId: string, turn: ActiveTurn): boolean {
    const thinkingText = turn.currentThinkingText;
    if (!thinkingText) return false;
    const session = this.store.getSession(sessionId);
    const messageId = findMatchingThinkingMessageIdInCurrentTurn(session?.messages ?? [], thinkingText);
    if (!messageId) return false;

    const finalMetadata = { isThinking: true, isStreaming: false, isFinal: true };
    this.store.updateMessage(sessionId, messageId, {
      content: thinkingText,
      metadata: finalMetadata,
    });
    this.emit('messageUpdate', sessionId, messageId, thinkingText, finalMetadata);
    turn.thinkingMessageId = null;
    turn.currentThinkingText = '';
    return true;
  }

  private finalizeThinkingMessage(sessionId: string, turn: ActiveTurn): void {
    if (!turn.thinkingMessageId) return;
    const messageId = turn.thinkingMessageId;

    this.flushPendingStoreUpdate(sessionId, messageId);
    this.clearPendingMessageUpdate(messageId);

    const finalMetadata = { isThinking: true, isStreaming: false, isFinal: true };
    this.store.updateMessage(sessionId, messageId, {
      content: turn.currentThinkingText || undefined,
      metadata: finalMetadata,
    });
    if (turn.currentThinkingText) {
      this.emit('messageUpdate', sessionId, messageId, turn.currentThinkingText, finalMetadata);
    }

    turn.thinkingMessageId = null;
    turn.currentThinkingText = '';
  }

  private splitAssistantSegmentBeforeTool(sessionId: string, turn: ActiveTurn): void {
    if (!turn.assistantMessageId) return;
    const messageId = turn.assistantMessageId;

    // Flush pending throttled updates so store content is current before reading.
    this.flushPendingStoreUpdate(sessionId, messageId);
    this.clearPendingMessageUpdate(messageId);

    // Committed text: use agentAssistantTextLength as the reliable segment length,
    // since currentText/currentAssistantSegmentText may be overwritten by chat deltas.
    // Read the actual content from the store (which was updated by processAgentAssistantText).
    const session = this.store.getSession(sessionId);
    const currentMsg = session?.messages.find((m) => m.id === messageId);
    const storeContent = currentMsg?.content?.trim() || '';

    if (storeContent) {
      turn.committedAssistantText = `${turn.committedAssistantText}${storeContent}`;
      turn.lastCommittedAssistantMessageId = messageId;
    }

    const finalMetadata = { isStreaming: false, isFinal: true };
    this.store.updateMessage(sessionId, messageId, {
      metadata: finalMetadata,
    });
    if (storeContent) {
      this.emit('messageUpdate', sessionId, messageId, storeContent, finalMetadata);
    }

    turn.assistantMessageId = null;
    turn.currentAssistantSegmentText = '';
    turn.hasSeenAgentAssistantStream = false;
    turn.chatDeltaOverwriteSkipLogged = false;

    // Finalize thinking message when splitting before tool
    this.finalizeThinkingMessage(sessionId, turn);
  }

  private handleChatDelta(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    const previousText = turn.currentText;
    const previousContentText = turn.currentContentText;
    const previousContentBlocks = [...turn.currentContentBlocks];
    const previousSawNonTextContentBlocks = turn.sawNonTextContentBlocks;
    const previousTextStreamMode = turn.textStreamMode;
    const previousSegmentText = turn.currentAssistantSegmentText;

    this.updateTurnTextState(turn, payload.message, { protectBoundaryDrops: true });

    // Handle thinking message independently of regular text flow
    this.syncThinkingMessage(sessionId, turn);

    const streamedText = turn.currentText;
    if (previousText && streamedText && streamedText.length < previousText.length) {
      turn.currentText = previousText;
      turn.currentContentText = previousContentText;
      turn.currentContentBlocks = previousContentBlocks;
      turn.sawNonTextContentBlocks = previousSawNonTextContentBlocks;
      turn.textStreamMode = previousTextStreamMode;
      return;
    }

    if (!streamedText) return;
    if (isHeartbeatAckText(streamedText) || isSilentReplyText(streamedText)) {
      turn.currentAssistantSegmentText = '';
      if (turn.assistantMessageId) {
        this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
        turn.assistantMessageId = null;
      }
      return;
    }
    if (isSilentReplyPrefixText(streamedText)) {
      turn.currentAssistantSegmentText = '';
      if (turn.assistantMessageId) {
        this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
        turn.assistantMessageId = null;
      }
      return;
    }
    if (this.isWaitingForRecoverableFollowup(turn)) {
      turn.hasRecoverableContinuationText = true;
    }
    this.clearContextMaintenanceState(sessionId, turn, 'chat delta continued');
    const displayStreamedText = stripTrailingSilentReplyTail(streamedText);
    const segmentText = this.resolveAssistantSegmentText(turn, displayStreamedText);
    if (!segmentText) return;
    if (segmentText === previousSegmentText && streamedText === previousText) return;
    this.logFirstResponseTiming(sessionId, turn, 'chat', segmentText.length);

    if (!turn.assistantMessageId) {
      const msgTimestamp = isRecord(payload.message) && typeof (payload.message as Record<string, unknown>).timestamp === 'number'
        ? (payload.message as Record<string, unknown>).timestamp as number : undefined;
      const assistantMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: segmentText,
        metadata: {
          isStreaming: true,
          isFinal: false,
        },
      }, msgTimestamp);
      turn.assistantMessageId = assistantMessage.id;
      turn.currentAssistantSegmentText = segmentText;
      this.emit('message', sessionId, assistantMessage);
      return;
    }

    if (turn.assistantMessageId && segmentText !== previousSegmentText) {
      // Only update segment text from chat delta if this segment has NOT yet received
      // agent assistant stream text. Agent stream preserves formatting; chat delta uses
      // extractGatewayMessageText (multi-block trim/join), which can break GFM tables.
      // hasSeenAgentAssistantStream stays true across agentAssistantTextLength resets
      // (e.g. split before tool) until a new assistant segment begins.
      if (!turn.hasSeenAgentAssistantStream) {
        turn.currentAssistantSegmentText = segmentText;
      } else if (!turn.chatDeltaOverwriteSkipLogged) {
        turn.chatDeltaOverwriteSkipLogged = true;
        console.debug('[OpenClawRuntime] skipping further chat.delta segment overwrite; agent stream owns this assistant segment until split');
      }
    }
  }

  private async handleChatFinal(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): Promise<void> {
    const previousText = turn.currentText;
    const previousSegmentText = turn.currentAssistantSegmentText;
    const wasWaitingForRecoverableFinal = this.isWaitingForRecoverableFollowup(turn);
    const rawFinalText = this.resolveFinalTurnText(turn, payload.message);
    const messageRecord = isRecord(payload.message) ? payload.message : null;
    const stopReason = payload.stopReason
      ?? (messageRecord && typeof messageRecord.stopReason === 'string' ? messageRecord.stopReason : undefined);
    const errorMessageFromMessage = messageRecord && typeof messageRecord.errorMessage === 'string'
      ? messageRecord.errorMessage
      : undefined;
    const stoppedByToolUse = isToolUseStopReason(stopReason) || messageHasToolCallBlock(messageRecord);
    const rawVisibleFinalText = stripTrailingSilentReplyToken(rawFinalText);
    const finalTextIsOpenClawFailure = isOpenClawFailureFinalText(rawVisibleFinalText);
    const finalText = turn.planMode && !stoppedByToolUse && !finalTextIsOpenClawFailure
      ? ensurePlanModeProposedPlanBlock(rawVisibleFinalText)
      : rawVisibleFinalText;
    console.debug(
      '[OpenClawRuntime] handleChatFinal:',
      `sessionId=${sessionId}`,
      `runId=${payload.runId ?? turn.runId}`,
      `message=${summarizeGatewayMessageShape(payload.message)}`,
      `previousTextLen=${previousText.length}`,
      `finalTextLen=${finalText.length}`,
      `finalText="${truncate(finalText, 200)}"`
    );
    if (isHeartbeatAckText(finalText)) {
      turn.currentText = finalText;
      turn.currentAssistantSegmentText = '';
      if (turn.assistantMessageId) {
        this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
        turn.assistantMessageId = null;
      }
      this.finalizeThinkingMessage(sessionId, turn);
      this.store.updateSession(sessionId, { status: 'completed' });
      this.emit('complete', sessionId, payload.runId ?? turn.runId);
      this.cleanupSessionTurn(sessionId);
      this.resolveTurn(sessionId);
      return;
    }
    if (isSilentReplyText(finalText) || isSilentReplyPrefixText(finalText)) {
      turn.currentText = finalText;
      turn.currentAssistantSegmentText = '';
      if (turn.assistantMessageId) {
        this.deleteAssistantMessage(sessionId, turn.assistantMessageId);
        turn.assistantMessageId = null;
      }
      this.deleteSilentAssistantMessages(sessionId);
      if (!turn.hasContextMaintenanceTool) {
        await this.syncFinalAssistantWithHistory(sessionId, turn);
      }
      if (turn.hasContextMaintenanceTool) {
        this.store.updateSession(sessionId, { status: 'running' });
        this.emitSessionStatus(sessionId, 'running');
        this.emitContextMaintenance(sessionId, true);
        this.deferChatFinalCompletion(sessionId, turn, payload.runId ?? turn.runId, {
          graceMs: OpenClawRuntimeAdapter.SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS,
          flushOnLifecycleEnd: false,
          allowLateContinuation: true,
        });
        return;
      }
      await this.syncSessionHistoryFromGateway(sessionId, turn.sessionKey);
      this.store.updateSession(sessionId, { status: 'completed' });
      this.emit('complete', sessionId, payload.runId ?? turn.runId);
      this.cleanupSessionTurn(sessionId);
      this.resolveTurn(sessionId);
      return;
    }
    if (finalTextIsOpenClawFailure) {
      const errorMessage = resolveOpenClawRuntimeErrorMessage(
        finalText.trim() || 'OpenClaw run failed',
        normalizeOpenClawSafeRuntimeErrorMetadata(payload),
      );
      const erroredSessionKey = turn.sessionKey;
      this.store.updateSession(sessionId, { status: 'error' });
      const errorMsg = this.store.addMessage(sessionId, {
        type: 'system',
        content: errorMessage,
        metadata: { error: errorMessage },
      });
      this.emit('message', sessionId, errorMsg);
      this.emit('error', sessionId, errorMessage);
      this.cleanupSessionTurn(sessionId);
      this.rejectTurn(sessionId, new Error(errorMessage));
      void this.syncSessionHistoryFromGateway(sessionId, erroredSessionKey);
      return;
    }
    turn.currentText = finalText;
    if (wasWaitingForRecoverableFinal && finalText.trim()) {
      turn.hasRecoverableContinuationText = true;
    }
    if (finalText && turn.currentContentBlocks.length === 0) {
      turn.currentContentText = finalText;
      turn.currentContentBlocks = [finalText];
    }
    const finalSegmentText = this.resolveAssistantSegmentText(turn, finalText);
    turn.currentAssistantSegmentText = finalSegmentText;
    if (finalSegmentText) {
      this.logFirstResponseTiming(sessionId, turn, 'chat', finalSegmentText.length);
    }

    // Collect media URLs and backfill tool result text from chat.history.
    // The agent tool event does not carry the result text (gateway strips it),
    // so we fetch it from the authoritative transcript via chat.history.
    if (turn.toolUseMessageIdByToolCallId.size > 0
        && turn.sessionKey
        && this.gatewayClient) {
      try {
        const history = await this.gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: turn.sessionKey,
          limit: 20,
        }, { timeoutMs: 5_000 });
        if (Array.isArray(history?.messages)) {
          this.syncToolResultsFromHistory(sessionId, turn, history.messages);
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] chat history tool result backfill failed:', err);
      }
    }

    if (turn.assistantMessageId) {
      // Flush any pending throttled updates so store content is current.
      this.flushPendingStoreUpdate(sessionId, turn.assistantMessageId);
      this.clearPendingMessageUpdate(turn.assistantMessageId);

      const { content: persistedSegmentText, reason: persistPickReason } = pickPersistedAssistantSegment(
        previousSegmentText,
        finalSegmentText,
        turn.hasSeenAgentAssistantStream,
      );
      if (persistedSegmentText) {
        const finalMetadata = {
          isStreaming: false,
          isFinal: true,
        };
        console.debug(
          '[OpenClawRuntime] persisting assistant segment at chat.final',
          `sessionId=${sessionId}`,
          `messageId=${turn.assistantMessageId}`,
          `reason=${persistPickReason}`,
          `previousLen=${previousSegmentText.length}`,
          `finalLen=${finalSegmentText.length}`,
          `persistedLen=${persistedSegmentText.length}`,
          `hadAgentStreamAuthority=${turn.hasSeenAgentAssistantStream}`,
        );
        this.store.updateMessage(sessionId, turn.assistantMessageId, {
          content: persistedSegmentText,
          metadata: finalMetadata,
        });
        this.emit('messageUpdate', sessionId, turn.assistantMessageId, persistedSegmentText, finalMetadata);
      }
    } else if (finalSegmentText) {
      const reusedMessageId = this.reuseFinalAssistantMessage(sessionId, finalSegmentText);
      if (reusedMessageId) {
        turn.assistantMessageId = reusedMessageId;
      } else {
        const msgTimestamp = isRecord(payload.message) && typeof (payload.message as Record<string, unknown>).timestamp === 'number'
          ? (payload.message as Record<string, unknown>).timestamp as number : undefined;
        const assistantMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: finalSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
        }, msgTimestamp);
        turn.assistantMessageId = assistantMessage.id;
        this.emit('message', sessionId, assistantMessage);
      }
    }

    if (!finalText.trim()) {
      console.debug(
        '[OpenClawRuntime] handleChatFinal: final payload had no text, falling back to chat.history sync',
        `sessionId=${sessionId}`,
        `runId=${payload.runId ?? turn.runId}`
      );
      await this.syncFinalAssistantWithHistory(sessionId, turn);
      const syncedVisibleText = turn.currentAssistantSegmentText.trim() || turn.currentText.trim();
      if (this.hasTurnToolWork(sessionId, turn)) {
        const visibleRetryRisk = this.shouldWaitForVisibleFinalContinuation(
          sessionId,
          turn,
          syncedVisibleText,
          { forceForEmptyFinal: Boolean(syncedVisibleText) },
        );
        this.waitForRecoverableOpenClawRetry(sessionId, turn, payload.runId ?? turn.runId, {
          reason: syncedVisibleText
            ? visibleRetryRisk.reason
            : 'empty final after tool work',
          graceMs: syncedVisibleText
            ? visibleRetryRisk.graceMs
            : OpenClawRuntimeAdapter.SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS,
          pendingThinkingOnlyHint: !syncedVisibleText,
          pendingVisibleFinalContinuation: Boolean(syncedVisibleText),
        });
        return;
      }
      if (turn.hasContextMaintenanceTool && !turn.currentAssistantSegmentText.trim()) {
        this.waitForRecoverableOpenClawRetry(sessionId, turn, payload.runId ?? turn.runId, {
          reason: 'context maintenance history tail',
          graceMs: OpenClawRuntimeAdapter.SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS,
        });
        return;
      }
    }

    if (stoppedByToolUse) {
      turn.lastToolUseChatFinalAtMs = Date.now();
      this.cancelChatFinalCompletion(sessionId, turn, 'chat final requested tool work');
      this.store.updateSession(sessionId, { status: 'running' });
      this.emitSessionStatus(sessionId, 'running');
      console.debug(
        '[OpenClawRuntime] kept session running after tool-use chat.final.',
        `sessionId=${sessionId}`,
        `runId=${payload.runId ?? turn.runId}`,
      );
      return;
    }

    const stoppedByError = stopReason === GatewayStopReason.Error;
    if (stoppedByError) {
      const rawErrorMessage = payload.errorMessage?.trim()
        || errorMessageFromMessage?.trim()
        || 'OpenClaw run failed';
      const errorMessage = resolveOpenClawRuntimeErrorMessage(
        rawErrorMessage,
        normalizeOpenClawSafeRuntimeErrorMetadata(payload),
      );
      const erroredSessionKey = turn.sessionKey;
      this.store.updateSession(sessionId, { status: 'error' });
      const errorMsg = this.store.addMessage(sessionId, {
        type: 'system',
        content: errorMessage,
        metadata: { error: errorMessage },
      });
      this.emit('message', sessionId, errorMsg);
      this.emit('error', sessionId, errorMessage);
      this.cleanupSessionTurn(sessionId);
      this.rejectTurn(sessionId, new Error(errorMessage));
      // Reconcile even on error so the UI shows messages already delivered.
      void this.syncSessionHistoryFromGateway(sessionId, erroredSessionKey);
      return;
    }

    // Reconcile local messages with authoritative gateway history.
    // Managed sessions keep local tool messages as the source of truth, but the
    // final assistant text should still be corrected from chat.history because
    // streaming merge heuristics can lose repeated boundary characters.
    if (isManagedSessionKey(turn.sessionKey)) {
      await this.syncFinalAssistantWithHistory(sessionId, turn);
    } else {
      // Awaited so that IM handlers reading from the store see reconciled data.
      await this.syncSessionHistoryFromGateway(sessionId, turn.sessionKey);
    }

    const reconciledPlanText = turn.currentAssistantSegmentText.trim()
      || turn.currentText.trim()
      || rawFinalText;
    if (await this.retryIncompletePlanModeResponse(sessionId, turn, reconciledPlanText)) {
      return;
    }
    if (
      turn.planMode
      && turn.planModeRecoveryAttempted
      && !isPlanModeResponseComplete(reconciledPlanText)
    ) {
      this.waitForRecoverableOpenClawRetry(sessionId, turn, payload.runId ?? turn.runId, {
        reason: 'plan mode recovery returned an incomplete final response',
        graceMs: OpenClawRuntimeAdapter.PLAN_MODE_RECOVERY_FOLLOWUP_GRACE_MS,
        pendingThinkingOnlyHint: !reconciledPlanText.trim(),
        pendingVisibleFinalContinuation: Boolean(reconciledPlanText.trim()),
      });
      console.warn(
        `[OpenClawRuntime] kept plan mode recovery open for an automatic continuation in session ${sessionId}.`,
      );
      return;
    }

    // Finalize thinking message at end of turn
    this.finalizeThinkingMessage(sessionId, turn);

    // Detect thinking-only response: the last API call returned no visible text
    // (only a thinking block), causing the run to complete silently without output.
    // This happens with qwen3.5-plus under very large context (~380K tokens).
    // Signal: turn.currentText is empty AND there was at least one tool call in THIS turn.
    // Scoped to the current turn to avoid false positives when previous turns had tool calls
    // but the current turn returned empty (e.g. session busy, network error).
    const sessionAfterReconcile = this.store.getSession(sessionId);
    if (sessionAfterReconcile) {
      const hadToolCall = this.hasTurnToolWork(sessionId, turn);
      const lastApiResponseHadNoText = !turn.currentText.trim();
      console.debug('[OpenClawRuntime] run end diagnostics, sessionId:', sessionId,
        'turn.currentText:', JSON.stringify(turn.currentText?.slice(0, 100)),
        'turn.committedAssistantText:', JSON.stringify(turn.committedAssistantText?.slice(0, 100)),
        'hadToolCall:', hadToolCall,
        'lastApiResponseHadNoText:', lastApiResponseHadNoText);
      if (hadToolCall && lastApiResponseHadNoText) {
        this.waitForRecoverableOpenClawRetry(sessionId, turn, payload.runId ?? turn.runId, {
          reason: 'thinking-only tool final',
          graceMs: OpenClawRuntimeAdapter.SILENT_MAINTENANCE_FOLLOWUP_GRACE_MS,
          pendingThinkingOnlyHint: true,
        });
        console.debug(`[OpenClawRuntime] delayed empty tool final while waiting for a recoverable follow-up in session ${sessionId}.`);
        return;
      }
    }

    // Sync usage metadata to the latest assistant message. Reconciliation can replace
    // message IDs even for managed sessions, so resolve against the current store.
    if (turn.sessionKey) {
      const targetMessageId = this.resolveAssistantMessageIdForUsage(sessionId, turn.assistantMessageId);
      if (targetMessageId) {
        // Extract usage/model directly from the chat.final payload to avoid race condition
        // (chat.history may not yet have usage for the just-completed message).
        const finalUsageRecord = messageRecord && isRecord(messageRecord.usage)
          ? messageRecord.usage as Record<string, unknown> : null;
        const finalModel = messageRecord && typeof messageRecord.model === 'string'
          ? messageRecord.model : undefined;
        const finalInputTokens = finalUsageRecord
          ? (typeof finalUsageRecord.input === 'number' ? finalUsageRecord.input
            : typeof finalUsageRecord.inputTokens === 'number' ? finalUsageRecord.inputTokens
            : undefined)
          : undefined;
        const finalOutputTokens = finalUsageRecord
          ? (typeof finalUsageRecord.output === 'number' ? finalUsageRecord.output
            : typeof finalUsageRecord.outputTokens === 'number' ? finalUsageRecord.outputTokens
            : undefined)
          : undefined;
        const finalTotalTokens = finalUsageRecord && typeof finalUsageRecord.totalTokens === 'number'
          ? finalUsageRecord.totalTokens : undefined;
        const finalCacheReadTokens = finalUsageRecord
          ? (typeof finalUsageRecord.cacheRead === 'number' ? finalUsageRecord.cacheRead
            : typeof finalUsageRecord.cacheReadTokens === 'number' ? finalUsageRecord.cacheReadTokens
            : undefined)
          : undefined;

        if (finalInputTokens != null || finalOutputTokens != null || finalModel) {
          void this.applyUsageMetadataFromFinal(
            sessionId, turn.sessionKey, targetMessageId,
            finalInputTokens, finalOutputTokens, finalModel,
            finalTotalTokens, finalCacheReadTokens,
          );
        } else {
          // Fallback: fetch from chat.history after a delay to give gateway time
          // to commit usage data for the just-completed message.
          const sk = turn.sessionKey;
          const mid = targetMessageId;
          setTimeout(() => {
            void this.syncUsageMetadata(sessionId, sk, mid);
          }, 2000);
        }
      }
    }

    const visibleFinalTextForDecision = turn.currentText.trim() ? turn.currentText : finalText;
    const visibleFinalContinuation = this.shouldWaitForVisibleFinalContinuation(
      sessionId,
      turn,
      visibleFinalTextForDecision,
    );
    if (visibleFinalContinuation.wait) {
      this.waitForRecoverableOpenClawRetry(sessionId, turn, payload.runId ?? turn.runId, {
        reason: visibleFinalContinuation.reason,
        graceMs: visibleFinalContinuation.graceMs,
        pendingVisibleFinalContinuation: true,
      });
      console.debug(
        '[OpenClawRuntime] delayed visible tool final while waiting for a recoverable continuation.',
        `sessionId=${sessionId}`,
        `runId=${payload.runId ?? turn.runId}`,
        `reason=${visibleFinalContinuation.reason}`,
        `toolResultChars=${visibleFinalContinuation.toolResultChars}`,
        `visibleTextLen=${visibleFinalTextForDecision.trim().length}`,
      );
      return;
    }

    this.deferChatFinalCompletion(sessionId, turn, payload.runId ?? turn.runId);
  }

  private async retryIncompletePlanModeResponse(
    sessionId: string,
    turn: ActiveTurn,
    rawFinalText: string,
  ): Promise<boolean> {
    if (!turn.planMode || turn.planModeRecoveryAttempted || isPlanModeResponseComplete(rawFinalText)) {
      return false;
    }

    turn.planModeRecoveryAttempted = true;
    const recoveryRunId = randomUUID();
    const previousRunId = turn.runId;
    const previousState = {
      currentText: turn.currentText,
      currentAssistantSegmentText: turn.currentAssistantSegmentText,
      currentContentText: turn.currentContentText,
      currentContentBlocks: [...turn.currentContentBlocks],
      sawNonTextContentBlocks: turn.sawNonTextContentBlocks,
      textStreamMode: turn.textStreamMode,
      agentAssistantTextLength: turn.agentAssistantTextLength,
      hasSeenAgentAssistantStream: turn.hasSeenAgentAssistantStream,
      currentThinkingText: turn.currentThinkingText,
    };
    const recoveryPrompt = [
      '[Plan Mode recovery instruction]',
      'Your previous visible response was incomplete and ended after a short preface.',
      'Do not call any tools and do not repeat environment exploration.',
      'Output the complete plan now in the same language as the original user request.',
      'Wrap it in <proposed_plan> and </proposed_plan>.',
      'Include Summary, Implementation Approach, Key Changes, Validation, and Assumptions or Questions.',
      'Use at least 8 concrete bullets or short paragraphs; do not output introductory text outside the tags.',
    ].join('\n');
    const session = this.store.getSession(sessionId);
    const runCwd = session?.cwd?.trim() ? path.resolve(session.cwd.trim()) : undefined;
    const chatSendParams = {
      sessionKey: turn.sessionKey,
      message: recoveryPrompt,
      deliver: false,
      idempotencyKey: recoveryRunId,
      ...(runCwd ? { cwd: runCwd } : {}),
    };

    turn.runId = recoveryRunId;
    turn.currentText = '';
    turn.currentAssistantSegmentText = '';
    turn.currentContentText = '';
    turn.currentContentBlocks = [];
    turn.sawNonTextContentBlocks = false;
    turn.textStreamMode = 'unknown';
    turn.agentAssistantTextLength = 0;
    turn.hasSeenAgentAssistantStream = false;
    turn.chatDeltaOverwriteSkipLogged = false;
    turn.currentThinkingText = '';
    turn.pendingRecoverableFollowup = true;
    turn.pendingOpenClawRetry = true;
    this.bindRunIdToTurn(sessionId, recoveryRunId);
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    console.warn(
      `[OpenClawRuntime] requested one plan mode recovery for incomplete output in session ${sessionId}.`,
    );

    try {
      assertOpenClawChatSendPayloadWithinLimit(sessionId, chatSendParams);
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.activeTurns.get(sessionId) !== turn || turn.stopRequested) {
        return true;
      }
      const sendResult = await this.requireGatewayClient().request<Record<string, unknown>>(
        'chat.send',
        chatSendParams,
        { timeoutMs: 90_000 },
      );
      const returnedRunId = typeof sendResult?.runId === 'string' ? sendResult.runId.trim() : '';
      if (returnedRunId) this.bindRunIdToTurn(sessionId, returnedRunId);
      return true;
    } catch (error) {
      this.sessionIdByRunId.delete(recoveryRunId);
      turn.knownRunIds.delete(recoveryRunId);
      turn.runId = previousRunId;
      turn.currentText = previousState.currentText;
      turn.currentAssistantSegmentText = previousState.currentAssistantSegmentText;
      turn.currentContentText = previousState.currentContentText;
      turn.currentContentBlocks = previousState.currentContentBlocks;
      turn.sawNonTextContentBlocks = previousState.sawNonTextContentBlocks;
      turn.textStreamMode = previousState.textStreamMode;
      turn.agentAssistantTextLength = previousState.agentAssistantTextLength;
      turn.hasSeenAgentAssistantStream = previousState.hasSeenAgentAssistantStream;
      turn.currentThinkingText = previousState.currentThinkingText;
      this.clearContextMaintenanceState(sessionId, turn, 'plan mode recovery request failed');
      console.warn(
        `[OpenClawRuntime] plan mode recovery request failed for session ${sessionId}; using the original response.`,
        error,
      );
      return false;
    }
  }

  private postponeChatFinalCompletion(sessionId: string, turn: ActiveTurn, reason: string): void {
    if (!turn.finalCompletionTimer) return;
    const runId = turn.finalCompletionRunId ?? turn.runId;
    const isSilentMaintenanceWait = turn.finalCompletionFlushOnLifecycleEnd === false;
    clearTimeout(turn.finalCompletionTimer);
    turn.finalCompletionTimer = undefined;
    turn.finalCompletionRunId = undefined;
    turn.finalCompletionFlushOnLifecycleEnd = undefined;
    turn.finalCompletionAllowLateContinuation = undefined;
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    if (isSilentMaintenanceWait) {
      this.clearContextMaintenanceState(sessionId, turn, reason);
      console.debug(`[OpenClawRuntime] canceled silent maintenance completion because ${reason}.`);
      return;
    }
    this.clearContextMaintenanceState(sessionId, turn, reason);
    this.deferChatFinalCompletion(sessionId, turn, runId);
    console.debug(`[OpenClawRuntime] postponed deferred chat.final completion because ${reason}.`);
  }

  private cancelChatFinalCompletion(sessionId: string, turn: ActiveTurn, reason: string): void {
    if (!turn.finalCompletionTimer) return;
    clearTimeout(turn.finalCompletionTimer);
    turn.finalCompletionTimer = undefined;
    turn.finalCompletionRunId = undefined;
    turn.finalCompletionFlushOnLifecycleEnd = undefined;
    turn.finalCompletionAllowLateContinuation = undefined;
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    this.clearContextMaintenanceState(sessionId, turn, reason);
    console.debug(`[OpenClawRuntime] canceled deferred chat.final completion because ${reason}.`);
  }

  private deferChatFinalCompletion(
    sessionId: string,
    turn: ActiveTurn,
    runId: string,
    options: { graceMs?: number; flushOnLifecycleEnd?: boolean; allowLateContinuation?: boolean } = {},
  ): void {
    if (turn.finalCompletionTimer) {
      clearTimeout(turn.finalCompletionTimer);
    }
    const graceMs = options.graceMs ?? OpenClawRuntimeAdapter.CHAT_FINAL_COMPLETION_GRACE_MS;
    const turnToken = turn.turnToken;
    turn.finalCompletionRunId = runId;
    turn.finalCompletionFlushOnLifecycleEnd = options.flushOnLifecycleEnd;
    turn.finalCompletionAllowLateContinuation = options.allowLateContinuation;
    turn.finalCompletionTimer = setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turnToken) return;
      void this.completeDeferredChatFinalNow(sessionId, currentTurn, runId);
    }, graceMs);
    console.debug('[OpenClawRuntime] deferred chat.final completion to allow retry or compaction follow-up.');
  }

  private async completeDeferredChatFinalNow(sessionId: string, turn: ActiveTurn, runId: string): Promise<void> {
    if (turn.finalCompletionTimer) {
      clearTimeout(turn.finalCompletionTimer);
      turn.finalCompletionTimer = undefined;
    }
    const currentPlanText = turn.currentAssistantSegmentText.trim() || turn.currentText.trim();
    if (turn.planMode && !isPlanModeResponseComplete(currentPlanText)) {
      await this.syncFinalAssistantWithHistory(sessionId, turn);
      if (this.activeTurns.get(sessionId) !== turn) {
        return;
      }
      console.debug(
        `[OpenClawRuntime] synchronized plan mode recovery from history before completing session ${sessionId}.`,
      );
    }
    if (turn.pendingThinkingOnlyHint && !turn.currentText.trim()) {
      await this.syncFinalAssistantWithHistory(sessionId, turn);
      if (this.activeTurns.get(sessionId) !== turn) {
        return;
      }
      if (!turn.currentText.trim()) {
        const hintMessage = this.store.addMessage(sessionId, {
          type: 'system',
          content: t('taskThinkingOnly'),
        });
        this.emit('message', sessionId, hintMessage);
        console.warn(`[OpenClawRuntime] thinking-only response detected after waiting for follow-up in session ${sessionId}.`);
      }
    }
    if (turn.finalCompletionAllowLateContinuation) {
      turn.allowRecentlyClosedRunRetryReopenOnCleanup = true;
    }
    turn.finalCompletionRunId = undefined;
    turn.finalCompletionFlushOnLifecycleEnd = undefined;
    turn.finalCompletionAllowLateContinuation = undefined;
    this.clearContextMaintenanceState(sessionId, turn, 'deferred completion finished');
    this.store.updateSession(sessionId, { status: 'completed' });
    this.emit('complete', sessionId, runId);
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
  }

  private async recoverPlanModeAfterSafetyAbort(sessionId: string, turn: ActiveTurn): Promise<void> {
    if (this.activeTurns.get(sessionId) !== turn || turn.stopRequested) return;

    if (turn.planModeSafetyRecoveryTimer) {
      clearTimeout(turn.planModeSafetyRecoveryTimer);
      turn.planModeSafetyRecoveryTimer = undefined;
    }
    turn.planModeSafetyRecoveryPending = false;
    turn.planModeSafetyRecoveryAbortedRunId = undefined;
    const recoveryRunId = randomUUID();
    const session = this.store.getSession(sessionId);
    const runCwd = session?.cwd?.trim() ? path.resolve(session.cwd.trim()) : undefined;
    const chatSendParams = {
      sessionKey: turn.sessionKey,
      message: [
        '[Plan Mode safety recovery instruction]',
        'A mutating tool call was blocked and the previous run was stopped.',
        'Do not call any tools. Use only the read-only context already gathered in this conversation.',
        'Output the complete plan now in the same language as the original user request.',
        'Wrap it in <proposed_plan> and </proposed_plan>.',
        'Include Summary, Implementation Approach, Key Changes, Validation, and Assumptions or Questions.',
        'Use at least 8 concrete bullets or short paragraphs; do not output introductory text outside the tags.',
      ].join('\n'),
      deliver: false,
      idempotencyKey: recoveryRunId,
      ...(runCwd ? { cwd: runCwd } : {}),
    };

    turn.runId = recoveryRunId;
    turn.currentText = '';
    turn.currentAssistantSegmentText = '';
    turn.currentContentText = '';
    turn.currentContentBlocks = [];
    turn.sawNonTextContentBlocks = false;
    turn.textStreamMode = 'unknown';
    turn.agentAssistantTextLength = 0;
    turn.hasSeenAgentAssistantStream = false;
    turn.chatDeltaOverwriteSkipLogged = false;
    turn.currentThinkingText = '';
    turn.pendingRecoverableFollowup = true;
    turn.pendingOpenClawRetry = true;
    this.bindRunIdToTurn(sessionId, recoveryRunId);
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');

    try {
      assertOpenClawChatSendPayloadWithinLimit(sessionId, chatSendParams);
      const sendResult = await this.requireGatewayClient().request<Record<string, unknown>>(
        'chat.send',
        chatSendParams,
        { timeoutMs: 90_000 },
      );
      const returnedRunId = typeof sendResult?.runId === 'string' ? sendResult.runId.trim() : '';
      if (returnedRunId) this.bindRunIdToTurn(sessionId, returnedRunId);
      console.warn(
        `[OpenClawRuntime] resumed plan generation without tools after a safety abort in session ${sessionId}.`,
      );
    } catch (error) {
      this.sessionIdByRunId.delete(recoveryRunId);
      turn.knownRunIds.delete(recoveryRunId);
      console.error(
        `[OpenClawRuntime] failed to resume plan generation after a safety abort in session ${sessionId}:`,
        error,
      );
      this.store.updateSession(sessionId, { status: 'idle' });
      this.emit('complete', sessionId, recoveryRunId);
      this.cleanupSessionTurn(sessionId);
      this.resolveTurn(sessionId);
    }
  }

  private schedulePlanModeSafetyRecovery(
    sessionId: string,
    turn: ActiveTurn,
    delayMs: number,
    reason: string,
  ): void {
    if (this.activeTurns.get(sessionId) !== turn || !turn.planModeSafetyRecoveryPending) return;
    if (turn.planModeSafetyRecoveryTimer) {
      clearTimeout(turn.planModeSafetyRecoveryTimer);
    }
    const turnToken = turn.turnToken;
    turn.planModeSafetyRecoveryTimer = setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turnToken || !currentTurn.planModeSafetyRecoveryPending) return;
      currentTurn.planModeSafetyRecoveryTimer = undefined;
      void this.recoverPlanModeAfterSafetyAbort(sessionId, currentTurn);
    }, delayMs);
    console.debug(
      `[OpenClawRuntime] scheduled plan mode safety recovery after ${delayMs}ms because ${reason} for session ${sessionId}.`,
    );
  }

  private handleChatAborted(sessionId: string, turn: ActiveTurn): void {
    if (turn.planMode && turn.planModeSafetyRecoveryPending) {
      console.warn(
        `[OpenClawRuntime] received the expected safety abort for plan mode session ${sessionId}.`,
      );
      this.schedulePlanModeSafetyRecovery(
        sessionId,
        turn,
        OpenClawRuntimeAdapter.PLAN_MODE_SAFETY_RECOVERY_AFTER_ABORT_FALLBACK_MS,
        'waiting for aborted run lifecycle end',
      );
      return;
    }
    const elapsedSec = ((Date.now() - turn.startedAtMs) / 1000).toFixed(1);
    this.store.updateSession(sessionId, { status: 'idle' });
    if (!turn.stopRequested && !this.manuallyStoppedSessions.has(sessionId)) {
      // The run was aborted without user request — most likely a timeout.
      // Add a visible hint so the user knows the task was interrupted.
      console.warn(
        `[AbortDiag] showing timeout hint to user`,
        `sessionId=${sessionId}`,
        `runId=${turn.runId}`,
        `elapsed=${elapsedSec}s`,
        `turnToken=${turn.turnToken}`,
      );
      const hintMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: t('taskTimedOut'),
        metadata: { isTimeout: true },
      });
      this.emit('message', sessionId, hintMessage);
      this.emit('complete', sessionId, turn.runId);
    }
    const abortedSessionKey = turn.sessionKey;
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
    void this.syncSessionHistoryFromGateway(sessionId, abortedSessionKey);
  }

  /**
   * Fetch the last assistant message from chat.history to extract usage metadata
   * (inputTokens, outputTokens, contextPercent, model) and update the local message.
   */
  private async syncUsageMetadata(
    sessionId: string,
    sessionKey: string,
    assistantMessageId: string,
  ): Promise<void> {
    const client = this.gatewayClient;
    if (!client) return;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: 10,
      }, { timeoutMs: 8_000 });

      if (!Array.isArray(history?.messages) || history.messages.length === 0) return;

      // Find the LAST assistant message (must be the most recent one).
      // Only use its usage if present — never fall back to an earlier message's usage,
      // which would cause metadata to appear on the wrong message.
      let usageMsg: Record<string, unknown> | null = null;
      for (let i = history.messages.length - 1; i >= 0; i--) {
        const msg = history.messages[i];
        if (isRecord(msg) && msg.role === 'assistant') {
          const text = extractGatewayMessageText(msg).trim();
          if (!text || shouldSuppressHeartbeatText('assistant', text)) {
            return;
          }
          if (isRecord(msg.usage)) {
            usageMsg = msg as Record<string, unknown>;
          }
          break;
        }
      }
      if (!usageMsg) return;

      const usage = usageMsg.usage as Record<string, unknown>;
      const inputTokens = (typeof usage.input === 'number' ? usage.input : undefined)
        ?? (typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined);
      const outputTokens = (typeof usage.output === 'number' ? usage.output : undefined)
        ?? (typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined);
      const cacheReadTokens = (typeof usage.cacheRead === 'number' ? usage.cacheRead : undefined)
        ?? (typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined)
        ?? (typeof (usage as any).cache_read_input_tokens === 'number' ? (usage as any).cache_read_input_tokens : undefined);
      const model = typeof usageMsg.model === 'string' ? usageMsg.model : undefined;

      // Compute contextPercent: input / contextTokens (matches OpenClaw web UI)
      // Primary source: sessions.list contextTokens (authoritative, matches gateway resolution)
      // Fallback: local models.json contextWindow cache
      let contextPercent: number | undefined;
      if (typeof inputTokens === 'number' && inputTokens > 0) {
        let contextTokens = this.sessionContextTokensCache.get(sessionKey);
        if (!contextTokens) {
          contextTokens = await this.refreshSessionContextTokens(sessionKey);
        }
        if (!contextTokens) {
          contextTokens = this.getContextWindowForModel(model ?? '');
        }
        if (contextTokens && contextTokens > 0) {
          contextPercent = Math.min(Math.round((inputTokens / contextTokens) * 100), 100);
        }
      }

      // Extract agent name from sessionKey
      const agentName = extractAgentNameFromSessionKey(sessionKey);

      if (inputTokens == null && outputTokens == null && !model) return;

      const usageMetadata: Record<string, unknown> = {
        isStreaming: false,
        isFinal: true,
        ...(inputTokens != null || outputTokens != null || cacheReadTokens != null ? {
          usage: {
            ...(inputTokens != null && { inputTokens }),
            ...(outputTokens != null && { outputTokens }),
            ...(cacheReadTokens != null && { cacheReadTokens }),
          },
        } : {}),
        ...(contextPercent != null && { contextPercent }),
        ...(model && { model }),
        ...(agentName && { agentName }),
      };

      const targetMessageId = this.resolveAssistantMessageIdForUsage(sessionId, assistantMessageId);
      if (!targetMessageId) return;

      this.store.updateMessage(sessionId, targetMessageId, {
        metadata: usageMetadata as CoworkMessageMetadata,
      });

      console.debug('[OpenClawRuntime] syncUsageMetadata success:', sessionId, model ?? 'unknown-model', `in=${inputTokens ?? '-'} out=${outputTokens ?? '-'} ctx=${contextPercent ?? '-'}% cacheRead=${cacheReadTokens ?? '-'} agent=${agentName ?? '-'}`);

      // Notify renderer to re-render the message with usage data
      const session = this.store.getSession(sessionId);
      if (session) {
        const msg = session.messages.find(m => m.id === targetMessageId);
        if (msg) {
          this.emit('messageUpdate', sessionId, targetMessageId, msg.content, usageMetadata);
        }
      }
    } catch (error) {
      console.debug('[OpenClawRuntime] syncUsageMetadata failed:', error);
    }
  }

  private async applyUsageMetadataFromFinal(
    sessionId: string,
    sessionKey: string,
    assistantMessageId: string,
    inputTokens: number | undefined,
    outputTokens: number | undefined,
    model: string | undefined,
    totalTokens?: number | undefined,
    cacheReadTokens?: number | undefined,
  ): Promise<void> {
    let contextPercent: number | undefined;
    if (typeof inputTokens === 'number' && inputTokens > 0) {
      let contextTokens = this.sessionContextTokensCache.get(sessionKey);
      if (!contextTokens) {
        contextTokens = await this.refreshSessionContextTokens(sessionKey);
      }
      if (!contextTokens) {
        contextTokens = this.getContextWindowForModel(model ?? '');
      }
      if (contextTokens && contextTokens > 0) {
        contextPercent = Math.min(Math.round((inputTokens / contextTokens) * 100), 100);
      }
    }

    const agentName = extractAgentNameFromSessionKey(sessionKey);

    const usageMetadata: Record<string, unknown> = {
      isStreaming: false,
      isFinal: true,
      ...(inputTokens != null || outputTokens != null || cacheReadTokens != null ? {
        usage: {
          ...(inputTokens != null && { inputTokens }),
          ...(outputTokens != null && { outputTokens }),
          ...(cacheReadTokens != null && { cacheReadTokens }),
        },
      } : {}),
      ...(contextPercent != null && { contextPercent }),
      ...(model && { model }),
      ...(agentName && { agentName }),
    };

    const targetMessageId = this.resolveAssistantMessageIdForUsage(sessionId, assistantMessageId);
    if (!targetMessageId) return;

    this.store.updateMessage(sessionId, targetMessageId, {
      metadata: usageMetadata as CoworkMessageMetadata,
    });

    console.debug('[OpenClawRuntime] applyUsageMetadataFromFinal:', sessionId, model ?? 'unknown-model', `in=${inputTokens ?? '-'} out=${outputTokens ?? '-'} ctx=${contextPercent ?? '-'}% cacheRead=${cacheReadTokens ?? '-'} agent=${agentName ?? '-'}`);

    const session = this.store.getSession(sessionId);
    if (session) {
      const msg = session.messages.find(m => m.id === targetMessageId);
      if (msg) {
        this.emit('messageUpdate', sessionId, targetMessageId, msg.content, usageMetadata);
      }
    }
  }

  private handleChatError(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    console.log('[OpenClawRuntime] handleChatError payload:', JSON.stringify(payload).slice(0, 1000));
    const rawErrorMessage = payload.errorMessage?.trim() || 'OpenClaw run failed';
    let errorMessage = resolveOpenClawRuntimeErrorMessage(
      rawErrorMessage,
      normalizeOpenClawSafeRuntimeErrorMetadata(payload),
    );

    // Detect model API errors that are likely caused by unsupported image content
    // in tool results (e.g., Read tool returning image blocks for non-vision models).
    // Only match 400 Bad Request — other 4xx codes (403 forbidden, 429 rate limit, etc.)
    // have unrelated causes and should show their original error message.
    if (/^400\b/.test(errorMessage)) {
      errorMessage += '\n\n[Hint: If the model attempted to read an image file, this may be because the model does not support image input. Consider using a vision-capable model or avoid sending image files.]';
    }

    const erroredSessionKey = turn.sessionKey;
    this.clearContextMaintenanceState(sessionId, turn, 'chat error');
    this.store.updateSession(sessionId, { status: 'error' });
    // Persist error message to SQLite so it survives session switches
    const errorMsg = this.store.addMessage(sessionId, {
      type: 'system',
      content: errorMessage,
      metadata: { error: errorMessage },
    });
    this.emit('message', sessionId, errorMsg);
    this.emit('error', sessionId, errorMessage);
    this.cleanupSessionTurn(sessionId);
    this.rejectTurn(sessionId, new Error(errorMessage));
    void this.syncSessionHistoryFromGateway(sessionId, erroredSessionKey);
  }

  private resolveApprovalSessionId(sessionKey: string): string | undefined {
    let sessionId = sessionKey ? this.resolveSessionIdBySessionKey(sessionKey) ?? undefined : undefined;

    // Try to resolve channel-originated sessions for approval requests
    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId = this.channelSessionSync.resolveOrCreateSession(sessionKey)
        || (!this.heartbeatSessionKeys.has(sessionKey) && this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey))
        || this.channelSessionSync.resolveOrCreateCronSession(sessionKey)
        || null;
      if (channelSessionId) {
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
      }
    }

    return sessionId;
  }

  private resolveSessionIdFromChatPayload(payload: ChatEventPayload): string | null {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    if (runId && this.sessionIdByRunId.has(runId)) {
      const sid = this.sessionIdByRunId.get(runId) ?? null;
      return sid;
    }

    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (sessionKey) {
      const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
      if (sessionId) {
        // Re-create ActiveTurn for channel session follow-up turns
        this.ensureActiveTurn(sessionId, sessionKey, runId);
        if (runId) {
          this.bindRunIdToTurn(sessionId, runId);
        }
        return sessionId;
      }
    }

    // Try to resolve channel-originated sessions
    if (sessionKey && this.channelSessionSync) {
      const channelSessionId = this.channelSessionSync.resolveOrCreateSession(sessionKey)
        || (!this.heartbeatSessionKeys.has(sessionKey) && this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey))
        || this.channelSessionSync.resolveOrCreateCronSession(sessionKey)
        || null;
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.deletedChannelKeys.has(sessionKey)) {
          this.deletedChannelKeys.delete(sessionKey);
          this.fullySyncedSessions.add(channelSessionId);
          this.reCreatedChannelSessionIds.add(channelSessionId);
          console.debug('[resolveSessionId] re-created after delete, skipping history sync for:', sessionKey);
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        this.ensureActiveTurn(channelSessionId, sessionKey, runId);
        if (runId) {
          this.bindRunIdToTurn(channelSessionId, runId);
        }
        return channelSessionId;
      }
    }

    console.warn('[resolveSessionId] failed — runId:', runId, 'sessionKey:', sessionKey);
    return null;
  }

  private syncSystemMessagesFromHistory(
    sessionId: string,
    historyMessages: unknown[],
    options: { previousCountKnown: boolean; previousCount: number },
  ): void {
    if (historyMessages.length === 0) {
      this.gatewayHistoryCountBySession.set(sessionId, 0);
      return;
    }

    const canUseCursor = options.previousCountKnown
      && options.previousCount >= 0
      && options.previousCount <= historyMessages.length;
    const entries = extractGatewayHistoryEntries(
      canUseCursor ? historyMessages.slice(options.previousCount) : historyMessages,
    );
    this.gatewayHistoryCountBySession.set(sessionId, historyMessages.length);

    const systemEntries = entries.filter((entry) => entry.role === 'system');
    if (systemEntries.length === 0) {
      return;
    }

    const session = this.store.getSession(sessionId);
    const existingSystemTexts = new Set(
      (session?.messages ?? [])
        .filter((message) => message.type === 'system')
        .map((message) => message.content.trim())
        .filter(Boolean),
    );

    for (const entry of systemEntries) {
      if (isHeartbeatAckText(entry.text) || isSilentReplyText(entry.text)) {
        continue;
      }
      if (existingSystemTexts.has(entry.text)) {
        continue;
      }

      const systemMessage = this.store.addMessage(sessionId, {
        type: 'system',
        content: entry.text,
        metadata: {},
      });
      existingSystemTexts.add(entry.text);
      this.emit('message', sessionId, systemMessage);
    }
  }

  /**
   * Channel history prefetch/full-sync intentionally skips historical system entries.
   * Seed the raw gateway history cursor so those older reminders are not replayed
   * under the next assistant reply during final-history sync.
   */
  private markGatewayHistoryWindowConsumed(sessionId: string, historyMessages: unknown[]): void {
    if (historyMessages.length === 0) {
      return;
    }
    this.gatewayHistoryCountBySession.set(sessionId, historyMessages.length);
  }

  private async syncSessionHistoryFromGateway(
    sessionId: string,
    sessionKey: string,
    options?: { isFullSync?: boolean },
  ): Promise<void> {
    if (isCronSessionKey(sessionKey)) {
      await this.syncCronRunHistory(sessionId, sessionKey, options);
      return;
    }

    await this.reconcileWithHistory(sessionId, sessionKey, options);
  }

  /**
   * Cron run sessions are not a stable full-conversation source of truth:
   * each run-scoped sessionKey only describes one execution, while the local
   * Cowork session can later contain user follow-up turns under a managed key.
   * Sync cron history non-destructively so missed run output can be backfilled
   * without deleting follow-up messages from the local conversation.
   */
  private async syncCronRunHistory(
    sessionId: string,
    sessionKey: string,
    _options?: { isFullSync?: boolean },
  ): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      console.log('[CronHistorySync] no gateway client, skipping - sessionId:', sessionId);
      return;
    }

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: FINAL_HISTORY_SYNC_LIMIT,
      }, { timeoutMs: 10_000 });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        console.log('[CronHistorySync] empty history - sessionId:', sessionId);
        this.channelSyncCursor.set(sessionId, 0);
        return;
      }

      const previousHistoryCountKnown = this.gatewayHistoryCountBySession.has(sessionId);
      const previousHistoryCount = this.gatewayHistoryCountBySession.get(sessionId) ?? 0;
      this.gatewayHistoryCountBySession.set(sessionId, history.messages.length);
      this.syncSystemMessagesFromHistory(sessionId, history.messages, {
        previousCountKnown: previousHistoryCountKnown,
        previousCount: previousHistoryCount,
      });

      const authoritativeEntries = buildCronRunHistoryEntries(history.messages, sessionKey);
      if (authoritativeEntries.length === 0) {
        console.log('[CronHistorySync] no user/assistant entries in history - sessionId:', sessionId);
        this.channelSyncCursor.set(sessionId, 0);
        return;
      }

      const session = this.store.getSession(sessionId);
      if (!session) return;

      if (hasCronRunHistoryForSession(session.messages, sessionKey)) {
        this.channelSyncCursor.set(sessionId, authoritativeEntries.length);
        return;
      }

      const localEntries = buildCronRunLocalHistoryEntries(session.messages);
      if (shouldReplaceLocalConversationWithCronHistory(localEntries, authoritativeEntries, sessionKey)) {
        this.store.replaceConversationMessages(
          sessionId,
          applyLocalTimestampsToEntries(authoritativeEntries, localEntries),
        );
        this.channelSyncCursor.set(sessionId, authoritativeEntries.length);
        return;
      }

      const usedLocalMessageIds = new Set<string>();
      for (const authoritative of authoritativeEntries) {
        const matchingLocal = findCronRunHistoryLocalMatch(
          authoritative,
          localEntries,
          usedLocalMessageIds,
          sessionKey,
        );

        if (matchingLocal) {
          usedLocalMessageIds.add(matchingLocal.id);
          this.store.updateMessage(sessionId, matchingLocal.id, {
            metadata: {
              ...(matchingLocal.metadata ?? {}),
              ...(authoritative.metadata ?? {}),
            },
          });
          continue;
        }

        this.store.addMessage(sessionId, {
          type: authoritative.role,
          content: authoritative.text,
          metadata: {
            isStreaming: false,
            isFinal: true,
            ...(authoritative.metadata ?? {}),
          },
        });
      }

      this.channelSyncCursor.set(sessionId, authoritativeEntries.length);
    } catch (error) {
      console.warn('[CronHistorySync] failed - sessionId:', sessionId, 'error:', error);
    }
  }

  /**
   * Reconcile local session messages with the authoritative gateway chat.history.
   *
   * This is the single source-of-truth sync method: after a turn completes,
   * it fetches the full conversation from OpenClaw and overwrites local
   * user/assistant messages to match exactly.  Tool messages (tool_use,
   * tool_result, system) are kept as-is because the gateway does not
   * expose them in chat.history.
   *
   * The reconciliation is idempotent — calling it multiple times produces
   * the same result.
   */
  private async reconcileWithHistory(
    sessionId: string,
    sessionKey: string,
    options?: { isFullSync?: boolean },
  ): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      console.log('[Reconcile] no gateway client, skipping — sessionId:', sessionId);
      return;
    }

    // Skip reconciliation for main-window (managed) sessions — local store is
    // the source of truth; only channel/IM sessions need gateway reconciliation.
    if (isManagedSessionKey(sessionKey)) {
      return;
    }

    const limit = options?.isFullSync
      ? OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT
      : FINAL_HISTORY_SYNC_LIMIT;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit,
      }, { timeoutMs: 10_000 });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        console.log('[Reconcile] empty history — sessionId:', sessionId);
        this.channelSyncCursor.set(sessionId, 0);
        return;
      }

      // Update gateway history cursor for system message tracking
      this.gatewayHistoryCountBySession.set(sessionId, history.messages.length);

      // Sync system messages (reminders etc.)
      const previousHistoryCountKnown = this.gatewayHistoryCountBySession.has(sessionId);
      const previousHistoryCount = this.gatewayHistoryCountBySession.get(sessionId) ?? 0;
      this.syncSystemMessagesFromHistory(sessionId, history.messages, {
        previousCountKnown: previousHistoryCountKnown,
        previousCount: previousHistoryCount,
      });

      // Determine if this is a channel session (for Discord/QQ text normalization)
      const isChannel = this.channelSessionSync
        && !isManagedSessionKey(sessionKey)
        && this.channelSessionSync.isChannelSessionKey(sessionKey);
      const isDiscord = sessionKey.includes(':discord:');
      const isQQ = sessionKey.includes(':qqbot:');
      const isPopo = sessionKey.includes(':moltbot-popo:');
      const isFeishu = sessionKey.includes(':feishu:');

      // Platform flags for text normalization (shared by auth + local)
      const platformFlags: PlatformFlags = { isDiscord, isQQ, isPopo, isFeishu };

      if (isChannel) {
        this.syncChannelSessionModelOverride({
          coworkSessionId: sessionId,
          openClawSessionKey: sessionKey,
          state: extractChannelSessionModelStateFromHistory(history.messages),
        });
      }

      // Extract authoritative user/assistant entries from gateway history
      const authoritativeEntries: ReconciledConversationEntry[] = [];
      for (const entry of extractGatewayHistoryEntries(history.messages)) {
        const role = entry.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = normalizeEntryText(role, entry.text, platformFlags);
        const mediaMetadata = role === 'user' ? buildGatewayMediaMetadata(entry) : undefined;
        if ((!text && !mediaMetadata) || shouldSuppressHeartbeatText(role, text)) continue;
        // Carry usage/model metadata for assistant messages and local media refs for user messages.
        let metadata: Record<string, unknown> | undefined;
        if (role === 'user') {
          metadata = mediaMetadata;
        } else if (role === 'assistant' && (entry.usage || entry.model)) {
          metadata = {};
          if (entry.usage) {
            metadata.usage = {
              ...(entry.usage.input != null && { inputTokens: entry.usage.input }),
              ...(entry.usage.output != null && { outputTokens: entry.usage.output }),
            };
          }
          if (entry.model) {
            metadata.model = entry.model;
          }
        }
        authoritativeEntries.push({
          role: role as 'user' | 'assistant',
          text,
          ...(metadata && { metadata }),
          ...(entry.timestamp != null && { timestamp: entry.timestamp }),
        });
      }

      // For channel sessions, append file paths from "message" tool calls
      if (isChannel && authoritativeEntries.length > 0) {
        const sentFilePaths = extractSentFilePathsFromHistory(history.messages);
        if (sentFilePaths.length > 0) {
          const lastAssistantIdx = authoritativeEntries.findLastIndex(e => e.role === 'assistant');
          if (lastAssistantIdx >= 0) {
            const fileLinks = sentFilePaths
              .map((fp) => `[${path.basename(fp)}](${fp})`)
              .join('\n');
            authoritativeEntries[lastAssistantIdx] = {
              ...authoritativeEntries[lastAssistantIdx],
              text: `${authoritativeEntries[lastAssistantIdx].text}\n\n${fileLinks}`,
            };
          }
        }
      }

      if (authoritativeEntries.length === 0) {
        console.log('[Reconcile] no user/assistant entries in history — sessionId:', sessionId);
        this.channelSyncCursor.set(sessionId, 0);
        return;
      }

      // Collect local user/assistant messages for comparison
      // Apply the same normalization as authoritativeEntries so alignment
      // works even when local messages still carry raw platform prefixes.
      const session = this.store.getSession(sessionId);
      const localEntries: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number; metadata?: Record<string, unknown> }> = [];
      if (session) {
        for (const msg of session.messages) {
          if (msg.type !== 'user' && msg.type !== 'assistant') continue;
          const text = normalizeEntryText(msg.type, msg.content, platformFlags);
          const mediaKey = getLocalMediaAttachmentsKey(msg.metadata);
          if ((!text && !mediaKey) || shouldSuppressHeartbeatText(msg.type, text)) continue;
          localEntries.push({ role: msg.type, text, timestamp: msg.timestamp, metadata: msg.metadata });
        }
      }

      // Fast path: if already in sync, skip
      const isInSync = localEntries.length === authoritativeEntries.length
        && localEntries.every((entry, idx) =>
          entry.role === authoritativeEntries[idx].role
          && entry.text === authoritativeEntries[idx].text
          && isSameReconciledEntry(entry, authoritativeEntries[idx]),
        );

      if (isInSync) {
        console.log('[Reconcile] already in sync — sessionId:', sessionId, 'entries:', localEntries.length);
        this.channelSyncCursor.set(sessionId, authoritativeEntries.length);
        return;
      }

      // Tail-alignment: find where the gateway window overlaps local history.
      const alignment = findTailAlignment(localEntries, authoritativeEntries);

      let entriesToStore: ReconciledConversationEntry[];

      if (alignment && (alignment.localIdx > 0 || alignment.authIdx > 0)) {
        // Gateway covers only the tail — preserve older local messages
        const authoritativeTail = authoritativeEntries.slice(alignment.authIdx);
        const tail = localEntries.slice(alignment.localIdx);
        const tailInSync = tail.length === authoritativeTail.length
          && tail.every((entry, idx) =>
            isSameReconciledEntry(entry, authoritativeTail[idx]),
          );
        if (tailInSync) {
          console.log(
            '[Reconcile] tail in sync — sessionId:', sessionId,
            'preserved:', alignment.localIdx, 'tail:', tail.length,
            'authSkipped:', alignment.authIdx,
          );
          this.channelSyncCursor.set(sessionId, authoritativeEntries.length);
          return;
        }
        // Concat preserved prefix with authoritative tail
        entriesToStore = [...localEntries.slice(0, alignment.localIdx), ...authoritativeTail];
        console.log(
          '[Reconcile] tail replace — sessionId:', sessionId,
          'preserved:', alignment.localIdx, 'auth:', authoritativeTail.length,
          'authSkipped:', alignment.authIdx,
          'total:', entriesToStore.length,
        );
      } else {
        // alignment.localIdx === 0 (gateway covers full range) or no overlap
        // In both cases: full replace to ensure dashboard consistency
        entriesToStore = authoritativeEntries;
        console.log(
          '[Reconcile] full replace — sessionId:', sessionId,
          'local:', localEntries.length, '→ auth:', authoritativeEntries.length,
          'alignIdx:', alignment?.localIdx ?? -1,
        );
      }

      this.store.replaceConversationMessages(sessionId, applyLocalTimestampsToEntries(entriesToStore, localEntries));
      this.channelSyncCursor.set(sessionId, authoritativeEntries.length);

      // Notify renderer to refresh
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:sessions:changed');
        }
      }
    } catch (error) {
      console.warn('[Reconcile] failed — sessionId:', sessionId, 'error:', error);
    }
  }

  private async syncLatestChannelUserMessage(sessionId: string, sessionKey: string): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      console.log('[ChannelSync] no gateway client, skipping latest channel user sync');
      return;
    }

    const history = await client.request<{ messages?: unknown[] }>('chat.history', {
      sessionKey,
      limit: FINAL_HISTORY_SYNC_LIMIT,
    }, { timeoutMs: 10_000 });
    if (!Array.isArray(history?.messages) || history.messages.length === 0) {
      this.channelSyncCursor.set(sessionId, 0);
      return;
    }

    this.markGatewayHistoryWindowConsumed(sessionId, history.messages);
    this.syncChannelUserMessages(
      sessionId,
      history.messages,
      true,
      sessionKey.includes(':discord:'),
      sessionKey.includes(':qqbot:'),
      sessionKey.includes(':moltbot-popo:'),
      sessionKey.includes(':feishu:'),
    );
  }

  private async syncFinalAssistantWithHistory(sessionId: string, turn: ActiveTurn): Promise<void> {
    console.debug('[OpenClawRuntime] syncFinalAssistant — sessionId:', sessionId);
    const client = this.gatewayClient;
    if (!client) {
      console.debug('[OpenClawRuntime] syncFinalAssistant — no gateway client, skipping');
      return;
    }

    try {
      const retryDelaysMs = [0, 120, 250, 500];
      let historyMessages: unknown[] | null = null;
      let canonicalText = '';
      let isChannel = false;

      for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) {
          await sleep(delayMs);
        }

        const history = await client.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: turn.sessionKey,
          limit: FINAL_HISTORY_SYNC_LIMIT,
        }, { timeoutMs: 8_000 });
        const msgCount = Array.isArray(history?.messages) ? history.messages.length : 0;
        console.debug('[OpenClawRuntime] syncFinalAssistant — chat.history returned', msgCount, 'messages');
        if (!Array.isArray(history?.messages) || history.messages.length === 0) {
          this.gatewayHistoryCountBySession.set(sessionId, 0);
          continue;
        }

        historyMessages = history.messages;
        const previousHistoryCountKnown = this.gatewayHistoryCountBySession.has(sessionId);
        const previousHistoryCount = this.gatewayHistoryCountBySession.get(sessionId) ?? 0;
        this.syncSystemMessagesFromHistory(sessionId, history.messages, {
          previousCountKnown: previousHistoryCountKnown,
          previousCount: previousHistoryCount,
        });

        isChannel = Boolean(
          this.channelSessionSync
          && !isManagedSessionKey(turn.sessionKey)
          && this.channelSessionSync.isChannelSessionKey(turn.sessionKey)
        );
        if (isChannel) {
          const latestOnly = this.reCreatedChannelSessionIds.has(sessionId);
          this.syncChannelUserMessages(sessionId, history.messages, latestOnly, turn.sessionKey.includes(':discord:'), turn.sessionKey.includes(':qqbot:'), turn.sessionKey.includes(':moltbot-popo:'), turn.sessionKey.includes(':feishu:'));
        }

        if (!this.isCurrentTurnToken(sessionId, turn.turnToken)) {
          console.debug('[OpenClawRuntime] syncFinalAssistant — stale turn token, skipping');
          return;
        }

        this.syncToolResultsFromHistory(sessionId, turn, history.messages);
        const historyToolWork = inspectCurrentTurnToolWork(history.messages);
        turn.lastHistoryHadToolWork = historyToolWork.hasToolWork;
        turn.lastHistoryToolResultCharCount = historyToolWork.toolResultChars;

        // Use turn-aware extraction for ALL session types.
        // The previous non-channel backward scan could return stale assistant text
        // from a prior turn when the gateway rejected the current run (empty final).
        canonicalText = extractCurrentTurnAssistantText(history.messages);

        if (!canonicalText && historyTailLooksLikeContextMaintenance(history.messages)) {
          turn.hasContextMaintenanceTool = true;
          console.debug('[OpenClawRuntime] detected context maintenance from final history tail.');
          break;
        }

        if (canonicalText) {
          break;
        }
      }

      if (!historyMessages || !canonicalText) {
        console.debug('[OpenClawRuntime] syncFinalAssistant — no canonical text found');
        return;
      }

      // Extract thinking from history messages and sync thinking message
      const thinkingFromHistory = extractThinkingFromCurrentTurn(historyMessages);
      if (thinkingFromHistory && thinkingFromHistory !== turn.currentThinkingText) {
        turn.currentThinkingText = thinkingFromHistory;
        if (!this.reuseFinalThinkingMessage(sessionId, turn)) {
          this.syncThinkingMessage(sessionId, turn);
          this.finalizeThinkingMessage(sessionId, turn);
        }
      }

      // For channel sessions, append file paths from "message" tool calls as clickable links
      if (isChannel) {
        const sentFilePaths = extractSentFilePathsFromHistory(historyMessages);
        if (sentFilePaths.length > 0) {
          console.debug('[OpenClawRuntime] syncFinalAssistant — found sent file paths:', sentFilePaths);
          const fileLinks = sentFilePaths
            .map((fp) => `[${path.basename(fp)}](${fp})`)
            .join('\n');
          canonicalText = `${canonicalText}\n\n${fileLinks}`;
        }
      }

      if (turn.planMode) {
        canonicalText = ensurePlanModeProposedPlanBlock(canonicalText);
      }

      console.debug('[OpenClawRuntime] syncFinalAssistant — canonicalText.length:', canonicalText.length);

      // For managed sessions: extract the last assistant segment directly from history
      // instead of using committedAssistantText for prefix slicing.
      // committedAssistantText is built from streaming data which may have been corrupted
      // by the gateway's appendUniqueSuffix overlap detection.
      let canonicalSegmentText = isManagedSessionKey(turn.sessionKey)
        ? extractLastAssistantSegmentInTurn(historyMessages!)
        : this.resolveAssistantSegmentText(turn, canonicalText);
      if (turn.planMode) {
        canonicalSegmentText = ensurePlanModeProposedPlanBlock(canonicalSegmentText);
      }
      console.debug('[Debug:syncFinal] canonicalSegmentText length:', canonicalSegmentText.length,
        'committed.length:', turn.committedAssistantText.length,
        'segment:', canonicalSegmentText.slice(0, 80));
      turn.currentText = canonicalText;
      turn.currentAssistantSegmentText = canonicalSegmentText;

      if (!canonicalSegmentText) {
        return;
      }

      if (!turn.planMode) {
        this.removeRedundantFinalPrefixSegment(sessionId, turn.assistantMessageId, canonicalSegmentText);
      }

      if (!turn.assistantMessageId) {
        const committedMessageId = this.reuseCommittedAssistantMessage(sessionId, turn, canonicalSegmentText);
        if (committedMessageId) {
          turn.assistantMessageId = committedMessageId;
          return;
        }

        const reusedMessageId = this.reuseFinalAssistantMessage(sessionId, canonicalSegmentText);
        if (reusedMessageId) {
          turn.assistantMessageId = reusedMessageId;
          return;
        }

        const assistantMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: canonicalSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
        });
        turn.assistantMessageId = assistantMessage.id;
        this.emit('message', sessionId, assistantMessage);
        return;
      }

      const session = this.store.getSession(sessionId);
      const currentMessage = session?.messages.find((message) => message.id === turn.assistantMessageId);
      const currentText = currentMessage?.content.trim() ?? '';
      const finalMetadata = {
        isStreaming: false,
        isFinal: true,
      };
      if (canonicalSegmentText === currentText) {
        // Content matches but renderer may not have received the last throttled update.
        // Force-emit so the UI shows the final text.
        this.store.updateMessage(sessionId, turn.assistantMessageId, {
          metadata: finalMetadata,
        });
        this.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText, finalMetadata);
        return;
      }

      console.debug('[Debug:syncFinal] updating last segment:', currentText.length, '->', canonicalSegmentText.length);
      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        content: canonicalSegmentText,
        metadata: finalMetadata,
      });
      this.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText, finalMetadata);
    } catch (error) {
      console.warn('[OpenClawRuntime] chat.history sync after final failed:', error);
    }
  }

  private collectChannelHistoryEntries(
    historyMessages: unknown[],
    isDiscord: boolean,
    isQQ: boolean,
    isPopo: boolean = false,
    isFeishu: boolean = false,
  ): ChannelHistorySyncEntry[] {
    const historyEntries: ChannelHistorySyncEntry[] = [];
    for (const message of historyMessages) {
      const entry = extractGatewayHistoryEntries([message])[0];
      if (!entry) continue;
      const role = entry.role;
      if (role !== 'user' && role !== 'assistant') continue;
      let text = entry.text.trim();
      // POPO's moltbot-popo plugin converts newlines to HTML break tags (<br />),
      // causing raw <br /> to appear in the UI and AI conversation.
      if (isPopo) text = text.replace(/<br\s*\/?>/gi, '\n');
      if (isPopo && role === 'user') text = stripPopoSystemHeader(text);
      if (isDiscord) text = stripDiscordMentions(text);
      if (isQQ && role === 'user') text = stripQQBotSystemPrompt(text);
      if (isFeishu && role === 'user') text = stripFeishuSystemHeader(text);
      const metadata = role === 'user' ? buildGatewayMediaMetadata(entry) : undefined;
      if ((text || metadata) && !shouldSuppressHeartbeatText(role, text)) {
        historyEntries.push({
          role: role as 'user' | 'assistant',
          text,
          ...(metadata ? { metadata } : {}),
        });
      }
    }
    return historyEntries;
  }

  private collectLocalChannelEntries(sessionId: string): ChannelHistorySyncEntry[] {
    const session = this.store.getSession(sessionId);
    if (!session) return [];

    const localEntries: ChannelHistorySyncEntry[] = [];
    for (const msg of session.messages) {
      if (msg.type !== 'user' && msg.type !== 'assistant') continue;
      const text = msg.content.trim();
      const mediaKey = getLocalMediaAttachmentsKey(msg.metadata);
      if (!text && !mediaKey) continue;
      localEntries.push({ role: msg.type, text, metadata: msg.metadata });
    }
    return localEntries;
  }

  private computeChannelHistoryFirstNewIndex(
    localEntries: ChannelHistorySyncEntry[],
    historyEntries: ChannelHistorySyncEntry[],
    cursor: number,
  ): { firstNewIdx: number; strategy: string } {
    if (localEntries.length === 0) {
      return { firstNewIdx: 0, strategy: 'empty-local' };
    }

    // `chat.history` is byte-bounded in OpenClaw, so the returned window can slide
    // long before it reaches our requested count. Match the local tail against the
    // current history prefix to find the continuation point without trusting length.
    const maxOverlap = Math.min(localEntries.length, historyEntries.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matched = true;
      for (let idx = 0; idx < overlap; idx += 1) {
        const localEntry = localEntries[localEntries.length - overlap + idx];
        const historyEntry = historyEntries[idx];
        if (!isSameChannelHistoryEntry(localEntry, historyEntry)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { firstNewIdx: overlap, strategy: 'tail-overlap' };
      }
    }

    let lastLocalUserIdx = -1;
    for (let idx = localEntries.length - 1; idx >= 0; idx -= 1) {
      if (localEntries[idx].role === 'user') {
        lastLocalUserIdx = idx;
        break;
      }
    }

    if (lastLocalUserIdx >= 0) {
      const lastLocalUser = localEntries[lastLocalUserIdx];
      let prevLocalUserText: string | undefined;
      for (let idx = lastLocalUserIdx - 1; idx >= 0; idx -= 1) {
        if (localEntries[idx].role === 'user') {
          prevLocalUserText = localEntries[idx].text;
          break;
        }
      }

      for (let idx = historyEntries.length - 1; idx >= 0; idx -= 1) {
        if (historyEntries[idx].role !== 'user' || historyEntries[idx].text !== lastLocalUser.text) {
          continue;
        }
        if (prevLocalUserText !== undefined && idx > 0) {
          let prevHistUserText: string | undefined;
          for (let histIdx = idx - 1; histIdx >= 0; histIdx -= 1) {
            if (historyEntries[histIdx].role === 'user') {
              prevHistUserText = historyEntries[histIdx].text;
              break;
            }
          }
          if (prevHistUserText !== prevLocalUserText) {
            continue;
          }
        }
        return { firstNewIdx: idx + 1, strategy: 'last-user-anchor' };
      }
    }

    // When cursor > 0, tail-overlap and last-user-anchor (above) are the correct
    // content-based strategies for detecting a sliding history window.  If both
    // failed the mismatch is caused by duplicates in the local store, not by
    // genuinely new gateway messages.  Trust the cursor — it was set to
    // historyEntries.length at the end of the previous sync — instead of falling
    // through to forward-match, which can produce wildly wrong firstNewIdx values
    // when local entries are polluted (causing either an infinite re-sync loop
    // when cursor == historyEntries.length, or a burst of old messages being
    // re-synced when cursor < historyEntries.length).
    //
    // forward-match is still used when cursor == 0 (initial sync / after restart)
    // because there is no cursor history to rely on.
    if (cursor > 0) {
      if (cursor >= historyEntries.length) {
        return { firstNewIdx: historyEntries.length, strategy: 'cursor-stable' };
      }
      return { firstNewIdx: cursor, strategy: 'cursor-fallback' };
    }

    let localIdx = 0;
    let forwardFirstNewIdx = 0;
    for (let idx = 0; idx < historyEntries.length; idx += 1) {
      if (localIdx < localEntries.length && isSameChannelHistoryEntry(historyEntries[idx], localEntries[localIdx])) {
        localIdx += 1;
        forwardFirstNewIdx = idx + 1;
      }
    }
    if (forwardFirstNewIdx > 0) {
      return { firstNewIdx: forwardFirstNewIdx, strategy: 'forward-match' };
    }

    if (historyEntries.length < cursor) {
      return { firstNewIdx: 0, strategy: 'history-rewrite' };
    }

    return {
      firstNewIdx: Math.min(cursor, historyEntries.length),
      strategy: 'cursor-fallback',
    };
  }

  /**
   * Sync user messages from gateway chat.history that haven't been added to the local store yet.
   * Used for channel-originated sessions (e.g. Telegram) where user messages arrive via the
   * gateway rather than the LobsterAI UI.
   *
   * Called at the start of a new turn (via prefetchChannelUserMessages) so that user messages
   * appear before the assistant's streaming response. Both chat and agent events are buffered
   * during prefetch, so the replay order matches direct cowork sessions.
   *
   * Reconciles against the local tail instead of trusting history length/cursor alone,
   * because OpenClaw's `chat.history` window can slide due to byte limits well before
   * the requested message count is reached.
   */
  private syncChannelUserMessages(sessionId: string, historyMessages: unknown[], latestOnly = false, isDiscord = false, isQQ = false, isPopo = false, isFeishu = false): void {
    const historyEntries = this.collectChannelHistoryEntries(historyMessages, isDiscord, isQQ, isPopo, isFeishu);

    const cursor = this.channelSyncCursor.get(sessionId) ?? 0;

    // When latestOnly is true (e.g. session re-created after deletion),
    // only sync the last user message — the one that triggered this turn.
    // Advance cursor to end so subsequent syncs don't replay old history.
    if (latestOnly) {
      if (historyEntries.length > 0) {
        const lastUser = [...historyEntries].reverse().find((entry) => entry.role === 'user');
        if (lastUser) {
          // Dedup: skip if this message already exists locally
          const session = this.store.getSession(sessionId);
          const existingUser = session?.messages.find(
            (m: CoworkMessage) => m.type === 'user' && m.content.trim() === lastUser.text,
          );
          if (existingUser) {
            if (getLocalMediaAttachmentsKey(existingUser.metadata) !== getLocalMediaAttachmentsKey(lastUser.metadata)) {
              const nextMetadata = {
                ...(existingUser.metadata ?? {}),
                ...(lastUser.metadata ?? {}),
              };
              this.store.updateMessage(sessionId, existingUser.id, { metadata: nextMetadata });
              this.emit('messageUpdate', sessionId, existingUser.id, existingUser.content, nextMetadata);
            }
          } else {
            const userMessage = this.store.addMessage(sessionId, {
              type: 'user',
              content: lastUser.text,
              metadata: lastUser.metadata ?? {},
            });
            this.emit('message', sessionId, userMessage);
          }
        }
      }
      this.channelSyncCursor.set(sessionId, historyEntries.length);
      return;
    }

    const localEntries = this.collectLocalChannelEntries(sessionId);
    const { firstNewIdx } = this.computeChannelHistoryFirstNewIndex(localEntries, historyEntries, cursor);

    // Sync user messages from gateway history.
    // Only sync user messages here — assistant messages are already added by the
    // real-time streaming pipeline (handleChatDelta / handleAgentEvent) and by
    // syncFinalAssistantWithHistory's own addMessage/updateMessage logic.
    //
    // When syncing a user message, check whether the corresponding assistant response
    // was already created locally (e.g. due to prefetch timeout where the assistant
    // streamed before user messages were synced). If so, use insertMessageBeforeId
    // to place the user message before the assistant — preserving correct chronological
    // order. This handles the race condition where gateway chat.history lags behind
    // the real-time streaming events.
    // Collect all user message indices that need syncing:
    // 1. Normal: user messages from firstNewIdx onwards (definitely new, no dedup)
    // 2. Repair: user messages before firstNewIdx that are missing locally
    //    (can happen when computeChannelHistoryFirstNewIndex's forward-match
    //    strategy matches the assistant but skips the preceding user message)
    const currentSession = this.store.getSession(sessionId);

    // Build a count-based map of local user texts for the repair range.
    // A simple Set<text> is wrong because users can send the same text
    // multiple times (e.g. "你好" in turn 1 and turn 4) — the Set would
    // dedup the second occurrence.  A count map tracks how many times each
    // text already exists locally so we only add genuinely missing entries.
    const localUserTextCounts = new Map<string, number>();
    if (currentSession) {
      for (const msg of currentSession.messages) {
        if (msg.type === 'user') {
          const text = msg.content.trim();
          localUserTextCounts.set(text, (localUserTextCounts.get(text) ?? 0) + 1);
        }
      }
    }

    const userIndicesToSync: number[] = [];
    // Normal range: from firstNewIdx onwards — these are definitively new messages
    // identified by the reconciliation algorithm, sync unconditionally.
    for (let i = firstNewIdx; i < historyEntries.length; i++) {
      if (historyEntries[i].role === 'user') {
        userIndicesToSync.push(i);
      }
    }
    // Repair range: before firstNewIdx, check for entries missing locally.
    // Use count-based matching: consume one local occurrence per history entry.
    // Entries with no remaining local count are missing and need to be synced.
    const repairCounts = new Map(localUserTextCounts);
    for (let i = 0; i < firstNewIdx; i++) {
      if (historyEntries[i].role !== 'user') continue;
      const remaining = repairCounts.get(historyEntries[i].text) ?? 0;
      if (remaining > 0) {
        repairCounts.set(historyEntries[i].text, remaining - 1);
      } else {
        userIndicesToSync.push(i);
      }
    }

    for (const idx of userIndicesToSync) {
      const entry = historyEntries[idx];

      // Find the next assistant entry in history after this user entry, then
      // look for a matching local assistant message. If found, insert the user
      // message before it to maintain correct chronological order.
      let insertBeforeId: string | null = null;
      if (currentSession) {
        for (let j = idx + 1; j < historyEntries.length; j++) {
          if (historyEntries[j].role !== 'assistant') continue;
          const assistantText = historyEntries[j].text;
          // Match by content prefix — local text may be segmented or truncated
          const matchPrefix = assistantText.slice(0, 100);
          const localMatch = currentSession.messages.find(
            (m: CoworkMessage) => m.type === 'assistant' && m.content.trim().startsWith(matchPrefix),
          );
          if (localMatch) {
            insertBeforeId = localMatch.id;
          }
          break;
        }
      }

      let userMessage;
      if (insertBeforeId) {
        userMessage = this.store.insertMessageBeforeId(sessionId, insertBeforeId, {
          type: 'user',
          content: entry.text,
          metadata: entry.metadata ?? {},
        });
        console.debug('[syncChannelUserMessages] inserted user message before assistant, sessionId:', sessionId);
      } else {
        userMessage = this.store.addMessage(sessionId, {
          type: 'user',
          content: entry.text,
          metadata: entry.metadata ?? {},
        });
      }
      this.emit('message', sessionId, userMessage);
    }

    this.channelSyncCursor.set(sessionId, historyEntries.length);
  }

  private getUserMessageCount(sessionId: string): number {
    const session = this.store.getSession(sessionId);
    if (!session) return 0;
    return session.messages.filter((m: CoworkMessage) => m.type === 'user').length;
  }

  /**
   * Sync full conversation history for a newly discovered channel session.
   * Adds both user and assistant messages to the local CoworkStore in order.
   * Skipped if the session has already been fully synced.
   *
   * Uses position-based matching to avoid false dedup of identical-content messages.
   */

  private async syncFullChannelHistory(sessionId: string, sessionKey: string): Promise<void> {
    if (this.fullySyncedSessions.has(sessionId)) return;
    this.fullySyncedSessions.add(sessionId);

    try {
      await this.syncSessionHistoryFromGateway(sessionId, sessionKey, { isFullSync: true });
    } catch (error) {
      console.error('[ChannelSync] syncFullChannelHistory: error:', error);
      // Remove from synced set so retry is possible
      this.fullySyncedSessions.delete(sessionId);
    }
  }

  /**
   * Incremental sync for an already-known channel session.
   * Delegates to reconcileWithHistory which handles diff and update.
   */
  private async incrementalChannelSync(sessionId: string, sessionKey: string): Promise<void> {
    if (this.reCreatedChannelSessionIds.has(sessionId)) {
      await this.syncLatestChannelUserMessage(sessionId, sessionKey);
      return;
    }

    await this.syncSessionHistoryFromGateway(sessionId, sessionKey);
  }

  /**
   * Trigger an immediate incremental sync after a channel session turn completes,
   * so that the renderer sees the latest messages without waiting for the next poll.
   */
  private syncChannelAfterTurn(sessionId: string, sessionKey: string): void {
    if (!this.channelSessionSync || !sessionKey) return;
    if (!this.channelSessionSync.isChannelSessionKey(sessionKey)) return;
    if (!this.fullySyncedSessions.has(sessionId)) return;

    void this.syncSessionHistoryFromGateway(sessionId, sessionKey).catch((err) => {
      console.warn('[ChannelSync] post-turn incremental sync failed for', sessionKey, err);
    });
  }

  private cleanupSessionTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      // Clear client-side timeout watchdog
      if (turn.timeoutTimer) {
        clearTimeout(turn.timeoutTimer);
        turn.timeoutTimer = undefined;
      }
      if (turn.lifecycleEndFallbackTimer) {
        clearTimeout(turn.lifecycleEndFallbackTimer);
        turn.lifecycleEndFallbackTimer = undefined;
      }
      if (turn.planModeSafetyRecoveryTimer) {
        clearTimeout(turn.planModeSafetyRecoveryTimer);
        turn.planModeSafetyRecoveryTimer = undefined;
      }
      if (turn.finalCompletionTimer) {
        clearTimeout(turn.finalCompletionTimer);
        turn.finalCompletionTimer = undefined;
        turn.finalCompletionRunId = undefined;
        turn.finalCompletionFlushOnLifecycleEnd = undefined;
        turn.finalCompletionAllowLateContinuation = undefined;
      }
      if (turn.hasContextMaintenanceTool || turn.hasContextCompactionEvent || turn.pendingRecoverableFollowup || turn.pendingOpenClawRetry) {
        this.emitContextMaintenance(sessionId, false);
      }
      // Cancel any pending throttled messageUpdate timer for this turn
      if (turn.assistantMessageId) {
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        this.lastMessageUpdateEmitTime.delete(turn.assistantMessageId);
        this.clearPendingStoreUpdate(turn.assistantMessageId);
        this.lastStoreUpdateTime.delete(turn.assistantMessageId);
      }
      // Cancel any pending incremental backfill timer for this session
      const backfillTimer = this.incrementalBackfillTimer.get(sessionId);
      if (backfillTimer) {
        clearTimeout(backfillTimer);
        this.incrementalBackfillTimer.delete(sessionId);
      }
      this.pendingBackfillToolCallIds.delete(sessionId);
      const shouldRememberClosedRunIds = !turn.suppressRecentlyClosedRunIdsOnCleanup;
      const allowRetryReopen = Boolean(
        turn.allowRecentlyClosedRunRetryReopenOnCleanup
        || turn.suppressRecentlyClosedRunIdsOnCleanup
      );
      turn.knownRunIds.forEach((knownRunId) => {
        if (shouldRememberClosedRunIds || allowRetryReopen) {
          this.rememberRecentlyClosedRunId(knownRunId, {
            sessionId,
            sessionKey: turn.sessionKey,
            allowRetryReopen,
          });
        }
        this.sessionIdByRunId.delete(knownRunId);
        this.pendingAgentEventsByRunId.delete(knownRunId);
        this.lastChatSeqByRunId.delete(knownRunId);
        this.lastAgentSeqByRunId.delete(knownRunId);
      });
    }
    const completedNormally = typeof this.store.getSession === 'function'
      && this.store.getSession(sessionId)?.status === 'completed';
    if (completedNormally) {
      this.refreshContinuityCapsule(sessionId, ContinuityCapsuleSource.PostRun);
    }
    this.activeTurns.delete(sessionId);
    setCoworkProxySessionId(null);
    if (completedNormally) {
      setTimeout(() => this.startPendingGoalContinuation(sessionId), 0);
    } else {
      this.pendingGoalContinuations.delete(sessionId);
    }
    // NOTE: Do NOT clear lastSystemPromptBySession here — it must persist
    // across turns so that the system prompt is only injected on the first
    // turn of a session (or when it actually changes).  Cleanup happens in
    // onSessionDeleted() when the session is removed entirely.
    this.reCreatedChannelSessionIds.delete(sessionId);
  }

  private startPendingGoalContinuation(sessionId: string): void {
    const pending = this.pendingGoalContinuations.get(sessionId);
    if (!pending) return;
    this.pendingGoalContinuations.delete(sessionId);
    const session = this.store.getSession(sessionId);
    if (!session) return;
    if (this.activeTurns.has(sessionId)) {
      this.pendingGoalContinuations.set(sessionId, pending);
      return;
    }
    console.debug(
      '[OpenClawRuntime] starting queued goal continuation after active turn completed.',
      `Session ${sessionId}.`,
      `Action ${pending.action}.`,
    );
    void this.continueSession(sessionId, pending.prompt, {
      skipInitialUserMessage: pending.skipInitialUserMessage,
      systemPrompt: pending.systemPrompt ?? session.systemPrompt,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[OpenClawRuntime] failed to start queued goal continuation:', error);
      this.store.updateSession(sessionId, { status: 'error' });
      this.emit('error', sessionId, message);
    });
  }

  /**
   * Start a client-side timeout watchdog for a turn.
   * Fires after the server-side timeout + grace period, recovering the UI
   * if the gateway fails to deliver the abort/final event.
   */
  private startTurnTimeoutWatchdog(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    const timeoutMs = this.agentTimeoutSeconds * 1000
      + OpenClawRuntimeAdapter.CLIENT_TIMEOUT_GRACE_MS;
    turn.timeoutTimer = setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turn.turnToken) return;
      const elapsedSec = ((Date.now() - currentTurn.startedAtMs) / 1000).toFixed(1);
      console.warn(
        `[AbortDiag] client-side timeout watchdog fired`,
        `sessionId=${sessionId}`,
        `runId=${currentTurn.runId}`,
        `elapsed=${elapsedSec}s`,
        `watchdogMs=${timeoutMs}`,
        `— gateway did not deliver abort event`,
      );
      this.handleChatAborted(sessionId, currentTurn);
    }, timeoutMs);
  }

  // ── Subagent public API (delegated to SubagentTracker) ──────────────────

  listSubagentRuns(parentSessionId: string) {
    return this.subagentTracker.listSubagentRuns(parentSessionId);
  }

  async getSubTaskHistory(
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ) {
    return this.subagentTracker.getSubTaskHistory(parentSessionId, agentId, sessionKey);
  }

  async deleteSubagentSession(parentSessionId: string, runId: string): Promise<boolean> {
    return this.subagentTracker.deleteSubagentRun(parentSessionId, runId);
  }

  /**
   * Called when a session is deleted from the store.
   * Purges all in-memory references so that new channel messages
   * with the same sessionKey can create a fresh session.
   */
  onSessionDeleted(sessionId: string): void {
    // Remove sessionIdBySessionKey entries pointing to this session
    const removedKeys: string[] = [];
    for (const [key, id] of this.sessionIdBySessionKey.entries()) {
      if (id === sessionId) {
        this.sessionIdBySessionKey.delete(key);
        removedKeys.push(key);
      }
    }

    const removedChannelKeys = removedKeys.filter((key) =>
      this.channelSessionSync?.isChannelSessionKey(key) ?? false,
    );

    // Suppress polling re-creation for deleted channel keys.
    // Only real-time events (new IM messages) will re-create the session.
    for (const key of removedChannelKeys) {
      this.deletedChannelKeys.add(key);
    }

    if (removedKeys.length > 0) {
      void this.deleteGatewaySessionTranscripts(removedKeys);
    }

    // Allow polling to rediscover channel sessions
    this.knownChannelSessionIds.delete(sessionId);

    // Allow full history re-sync when session is re-created
    this.fullySyncedSessions.delete(sessionId);
    this.channelSyncCursor.delete(sessionId);
    this.reCreatedChannelSessionIds.delete(sessionId);
    this.gatewayHistoryCountBySession.delete(sessionId);
    this.latestTurnTokenBySession.delete(sessionId);
    this.stoppedSessions.delete(sessionId);
    this.goalSnapshotBySessionId.delete(sessionId);

    // Clean up active turn and related run-id mappings
    this.cleanupSessionTurn(sessionId);

    // Clean up pending approvals, bridged state, confirmation mode
    this.approvalController.clearBySession(sessionId);
    this.bridgedSessions.delete(sessionId);
    this.continuityFullBridgeCompactedAtBySession.delete(sessionId);
    this.workspaceRehydrationBridgeCompactedAtBySession.delete(sessionId);
    this.confirmationModeBySession.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);
    this.sessionModelPatchStateBySession.delete(sessionId);
    this.contextUsageInFlightBySession.delete(sessionId);
    this.sessionModelPatchQueue.delete(sessionId);

    // Propagate to channel session sync
    if (this.channelSessionSync) {
      this.channelSessionSync.onSessionDeleted(sessionId);
    }

    // Clean up subagent tracking state and persisted messages
    this.subagentTracker.onSessionDeleted(sessionId);
  }

  private async deleteGatewaySessionTranscripts(sessionKeys: string[]): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      console.warn('[OpenClawRuntime] could not delete gateway session transcripts because the gateway client is unavailable');
      return;
    }

    const uniqueKeys = Array.from(new Set(sessionKeys.filter(Boolean)));
    for (const sessionKey of uniqueKeys) {
      try {
        await client.request('sessions.delete', {
          key: sessionKey,
          deleteTranscript: true,
        }, { timeoutMs: OpenClawRuntimeAdapter.GATEWAY_SESSION_DELETE_TIMEOUT_MS });
        console.log(`[OpenClawRuntime] deleted gateway session transcript for ${sessionKey}`);
      } catch (error) {
        console.warn(`[OpenClawRuntime] failed to delete gateway session transcript for ${sessionKey}:`, error);
      }
    }
  }

  /**
   * Ensure an ActiveTurn exists for a session. Used for channel-originated sessions
   * where new turns arrive after the previous turn was cleaned up.
   */
  private isSessionInStopCooldown(sessionId: string): boolean {
    const stoppedAt = this.stoppedSessions.get(sessionId);
    if (stoppedAt === undefined) return false;
    if (Date.now() - stoppedAt < OpenClawRuntimeAdapter.STOP_COOLDOWN_MS) {
      return true;
    }
    // Cooldown expired, remove the entry
    this.stoppedSessions.delete(sessionId);
    return false;
  }

  private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
    if (this.activeTurns.has(sessionId)) return;
    if (runId && this.isRecentlyClosedRunId(runId)) {
      console.debug('[OpenClawRuntime] suppressed active turn creation for a closed run.');
      return;
    }
    // Suppress automatic turn re-creation for sessions that are still within
    // the stop cooldown window.  This prevents late-arriving OpenClaw events
    // (e.g. from POPO/Telegram) from restarting a stopped session.
    if (this.isSessionInStopCooldown(sessionId)) {
      console.log('[Debug:ensureActiveTurn] suppressed — session in stop cooldown, sessionId:', sessionId);
      return;
    }
    // Once the cooldown has expired, clear the manual-stop marker so that
    // genuinely new channel messages can create a fresh turn.  Without this,
    // `manuallyStoppedSessions` (a permanent Set) would block all future
    // channel events for this session until `runTurn` or `onSessionDeleted`
    // happens to clear it.
    // Only clear for channel/cron sessions.  Desktop sessions (lobsterai:*)
    // must stay suppressed — the gateway may still push late MCP tool results
    // long after the 10s cooldown expires.
    if (this.manuallyStoppedSessions.has(sessionId)) {
      const isChannel = this.channelSessionSync
        && !isManagedSessionKey(sessionKey)
        && this.channelSessionSync.isChannelSessionKey(sessionKey);
      if (isChannel) {
        console.log('[Debug:ensureActiveTurn] cooldown expired, clearing manuallyStoppedSessions for channel re-activation, sessionId:', sessionId);
        this.manuallyStoppedSessions.delete(sessionId);
      } else {
        console.log('[Debug:ensureActiveTurn] suppressed — desktop session was manually stopped, sessionId:', sessionId);
        return;
      }
    }
    const turnRunId = runId || randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const isChannel = this.channelSessionSync
      && !isManagedSessionKey(sessionKey)
      && this.channelSessionSync.isChannelSessionKey(sessionKey);
    console.log('[Debug:ensureActiveTurn] creating turn — sessionId:', sessionId, 'sessionKey:', sessionKey, 'runId:', turnRunId, 'isChannel:', !!isChannel, 'pendingUserSync:', !!isChannel);
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId: turnRunId,
      model: this.resolveCurrentModelForSession(sessionId),
      turnToken,
      planMode: false,
      knownRunIds: new Set(runId ? [runId] : [turnRunId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      hasSeenAgentAssistantStream: false,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      mediaStatusPollCountByToolCallId: new Map(),
      mediaStatusPollCountByTaskId: new Map(),
      mediaStatusPollBaseByToolCallId: new Map(),
      contextMaintenanceToolCallIds: new Set(),
      planModeSuppressedToolCallIds: new Set(),
      startedAtMs: Date.now(),
      firstResponseTiming: { turnStartedAtMs: Date.now() },
      stopRequested: false,
      thinkingMessageId: null,
      currentThinkingText: '',
      pendingUserSync: !!isChannel,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
    });
    if (runId) {
      this.sessionIdByRunId.set(runId, sessionId);
    }
    this.store.updateSession(sessionId, { status: 'running' });
    this.emitSessionStatus(sessionId, 'running');
    this.startTurnTimeoutWatchdog(sessionId);

    // For channel sessions, prefetch user messages before streaming starts
    if (isChannel) {
      void this.prefetchChannelUserMessages(sessionId, sessionKey);
    }
  }

  /**
   * Prefetch user messages from gateway history at the start of a channel session turn.
   * This ensures user messages appear before the assistant's streaming response.
   * Delta/final events are buffered until this completes.
   */
  private async prefetchChannelUserMessages(sessionId: string, sessionKey: string): Promise<void> {
    console.log('[Debug:prefetch] start — sessionId:', sessionId, 'sessionKey:', sessionKey);

    // Use reconcileWithHistory for prefetch — it does an authoritative full
    // comparison against chat.history and replaces local messages on mismatch.
    // This is simpler and more accurate than incremental syncChannelUserMessages:
    // - Handles duplicate user texts correctly (position-based, not text-based)
    // - No cursor drift or dedup heuristic issues
    // - replaceConversationMessages preserves tool_use/tool_result/system messages
    //
    // At turn start the assistant hasn't streamed yet, so full replacement is safe.
    // Final correctness is still ensured by reconcileWithHistory at turn end.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const beforeCount = this.getUserMessageCount(sessionId);
        if (this.reCreatedChannelSessionIds.has(sessionId)) {
          await this.syncLatestChannelUserMessage(sessionId, sessionKey);
        } else {
          await this.syncSessionHistoryFromGateway(sessionId, sessionKey);
        }
        const afterCount = this.getUserMessageCount(sessionId);
        const newUserMessages = afterCount - beforeCount;
        console.log('[Debug:prefetch] reconciled (attempt', attempt, ') synced user messages:', newUserMessages, '(before:', beforeCount, 'after:', afterCount, ')');

        // Emit 'message' events for newly added user messages so the renderer
        // updates the active session view in real-time.  reconcileWithHistory
        // writes to SQLite and sends cowork:sessions:changed, but that only
        // refreshes the session list sidebar — not the active conversation.
        if (newUserMessages > 0) {
          const session = this.store.getSession(sessionId);
          if (session) {
            const userMessages = session.messages.filter((m: CoworkMessage) => m.type === 'user');
            const newMsgs = userMessages.slice(-newUserMessages);
            for (const msg of newMsgs) {
              this.emit('message', sessionId, msg);
            }
          }
          break;
        }

        // Retry once if buffered events suggest history hasn't caught up yet
        if (attempt < MAX_ATTEMPTS - 1) {
          const turn = this.activeTurns.get(sessionId);
          if (turn && (turn.bufferedChatPayloads.length > 0 || turn.bufferedAgentPayloads.length > 0)) {
            console.log('[Debug:prefetch] no new user messages but have buffered events, retrying after 500ms...');
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
        }
        break;
      } catch (error) {
        console.warn('[OpenClawRuntime] prefetchChannelUserMessages attempt', attempt, 'failed:', error);
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log('[Debug:prefetch] turn was removed during prefetch, cannot replay. sessionId:', sessionId);
      return;
    }
    turn.pendingUserSync = false;

    const chatBuffered = turn.bufferedChatPayloads.length;
    const agentBuffered = turn.bufferedAgentPayloads.length;
    console.log('[Debug:prefetch] replaying buffered events — chat:', chatBuffered, 'agent:', agentBuffered);

    // Merge and replay both chat and agent events in sequence order
    // so that tool use/result messages are interleaved with assistant text segments
    // just like in direct cowork sessions.
    const allBuffered: Array<{ type: 'chat' | 'agent'; payload: unknown; seq?: number; bufferedAt: number; idx: number }> = [];
    let bufIdx = 0;
    for (const event of turn.bufferedChatPayloads) {
      allBuffered.push({ type: 'chat', payload: event.payload, seq: event.seq, bufferedAt: event.bufferedAt, idx: bufIdx++ });
    }
    for (const event of turn.bufferedAgentPayloads) {
      allBuffered.push({ type: 'agent', payload: event.payload, seq: event.seq, bufferedAt: event.bufferedAt, idx: bufIdx++ });
    }
    turn.bufferedChatPayloads = [];
    turn.bufferedAgentPayloads = [];

    allBuffered.sort((a, b) => {
      // Primary: sort by seq if both have it
      const hasSeqA = typeof a.seq === 'number';
      const hasSeqB = typeof b.seq === 'number';
      if (hasSeqA && hasSeqB) return a.seq! - b.seq!;
      // Events with seq come before events without
      if (hasSeqA !== hasSeqB) return hasSeqA ? -1 : 1;
      // Fallback: preserve arrival order via bufferedAt, then insertion index
      if (a.bufferedAt !== b.bufferedAt) return a.bufferedAt - b.bufferedAt;
      return a.idx - b.idx;
    });

    for (const event of allBuffered) {
      if (event.type === 'chat') {
        this.handleChatEvent(event.payload, event.seq);
      } else {
        this.handleAgentEvent(event.payload, event.seq);
      }
    }
    console.log('[Debug:prefetch] replay complete, sessionId:', sessionId);
  }

  private bindRunIdToTurn(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    if (this.isRecentlyClosedRunId(normalizedRunId)) {
      console.debug('[OpenClawRuntime] suppressed run binding for a closed run.');
      return;
    }
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    turn.knownRunIds.add(normalizedRunId);
    this.sessionIdByRunId.set(normalizedRunId, sessionId);
    this.flushPendingAgentEvents(sessionId, normalizedRunId);
  }

  private resolveTurn(sessionId: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.resolve();
  }

  private rejectTurn(sessionId: string, error: Error): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.reject(error);
  }

  private toSessionKey(sessionId: string, agentId?: string): string {
    return buildManagedSessionKey(sessionId, agentId);
  }

  private requireGatewayClient(): GatewayClientLike {
    if (!this.gatewayClient) {
      throw new Error('OpenClaw gateway client is unavailable.');
    }
    return this.gatewayClient;
  }

  /**
   * Return the current gateway client instance, or null if not yet connected.
   * Used by CronJobService to call cron.* APIs on the same gateway.
   */
  getGatewayClient(): GatewayClientLike | null {
    return this.gatewayClient;
  }

  /**
   * Current engine status without starting or waiting for anything.
   * Lets IPC handlers report not-ready quickly instead of blocking on
   * gateway startup.
   */
  getEngineStatusSnapshot(): OpenClawEngineStatus {
    return this.engineManager.getStatus();
  }

  getSessionKeysForSession(sessionId: string): string[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return [];
    }

    const keys: string[] = [];
    for (const [key, mappedSessionId] of this.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === normalizedSessionId) {
        keys.push(key);
      }
    }

    const session = this.store.getSession(normalizedSessionId);
    const managedKey = this.toSessionKey(normalizedSessionId, session?.agentId);
    if (!keys.includes(managedKey)) {
      keys.push(managedKey);
    }

    keys.sort((left, right) => {
      const leftManaged = isManagedSessionKey(left);
      const rightManaged = isManagedSessionKey(right);
      if (leftManaged !== rightManaged) {
        return leftManaged ? 1 : -1;
      }
      return left.localeCompare(right);
    });

    return keys;
  }

  /**
   * Ensure the gateway client is connected and ready.
   * Resolves when the WebSocket connection is established and authenticated.
   */
  async ensureReady(): Promise<void> {
    await this.ensureGatewayClientReady();
  }
}
