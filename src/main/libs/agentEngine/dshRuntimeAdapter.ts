// Clean CoworkRuntime adapter over DeepSeek Harness (DSH) Typert WS/HTTP API.
//
// Zero Electron imports — interacts with persistence through a narrow store
// port and with DSH through `DshHostManager` / `DshTypertClient`, keeping the
// entire runtime loop directly unit-testable under Node Vitest.

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import {
  ContextCompactionMode,
  ContextCompactionStatus,
  CoworkSystemMessageKind,
} from '../../../common/coworkSystemMessages';
import type { OpenClawSessionPatch } from '../../../common/openclawSession';
import {
  BrowserAnnotationScreenshotStatus,
  buildBrowserAnnotationPromptSection,
  type CoworkBrowserAnnotationMessageBatch,
  normalizeBrowserAnnotationBatches,
} from '../../../shared/cowork/browserAnnotations';
import type {
  CoworkBtwAbortResponse,
  CoworkBtwSubmitResponse,
} from '../../../shared/cowork/btw';
import { CoworkBtwStatus } from '../../../shared/cowork/btw';
import { ASK_USER_QUESTION_TOOL_NAME } from '../../../shared/cowork/constants';
import type { CoworkGoal } from '../../../shared/cowork/goal';
import { CoworkGoalStatus } from '../../../shared/cowork/goal';
import {
  buildCoworkImageAttachmentPreviews,
  CoworkImageAttachmentRole,
  stripDataUrlPrefix,
} from '../../../shared/cowork/imageAttachments';
import {
  buildSelectedTextPromptSection,
  CoworkSelectedTextSource,
} from '../../../shared/cowork/selectedText';
import { type CoworkSteerResponse, CoworkSteerStatus } from '../../../shared/cowork/steer';
import { isDshSubagentSpawn } from '../../../shared/cowork/subagent';
import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_APPROVAL_REQUEST_ID_PREFIX,
  DSH_QUESTION_REQUEST_ID_PREFIX,
  DSH_SESSION_ID_PREFIX,
  DshApprovalPermissionAction,
  DshPermissionPreset,
  DshProgressiveCapability,
  parseDshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import {
  modelPresetModelId,
  parseModelPresetId,
} from '../../../shared/modelPresets/constants';
import { buildOfficeAgentPrompt } from '../../../shared/office/core/officeAgentPrompt';
import {
  SHEET_EDITOR,
  SLIDES_EDITOR,
  WORD_EDITOR,
} from '../../../shared/office/editors';
import {
  canonicalizeDshProviderId,
  type ModelThinkingLevel,
  parseModelThinkingLevel,
} from '../../../shared/providers';
import { USER_CONTEXT_WINDOW_SELECTION_PREFIX } from '../../../shared/providers/modelContextWindow';
import type { CoworkMessage, CoworkSessionStatus } from '../../coworkStore';
import { getCommandDangerLevel } from '../commandSafety';
import {
  buildApprovalScopeKey,
  extractShellCommandFromArgs,
} from '../dsh/dshHostBridgeWiring';
import type {
  DshHostManager,
  DshHostSessionContext,
} from '../dsh/dshHostManager';
import { buildDshMediaTurnInstruction } from '../dsh/dshMediaGenerationTool';
import { DshChildEvent, record } from '../dsh/dshSubagentHistory';
import type { DshSubagentSessions } from '../dsh/dshSubagentSessions';
import type {
  DshCommandSubmitAttachment,
  DshPromptPart,
  DshSessionUpdateQueueParams,
  DshTypertClient,
  DshWaterfallEvent,
  DshWaterfallOutcome,
} from '../dsh/dshTypertClient';
import { createCoworkLlmTrace } from '../llmTrace';
import { registerLlmUsageContext } from '../llmUsageContext';
import {
  type CoworkContinuityCapsule,
  formatCoworkContinuityCapsuleBridge,
} from './coworkContinuityCapsule';
import type {
  CoworkContextUsage,
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkSessionPatchResult,
  CoworkStartOptions,
  CoworkStoppedTurn,
  PermissionRequest,
  PermissionResult,
} from './types';

export interface DshAdapterSessionRecord {
  id: string;
  cwd: string;
  title?: string;
  agentId?: string;
  claudeSessionId?: string | null;
  executionMode?: string;
  permissionPreset?: DshPermissionPreset | null;
  modelOverride?: string | null;
  modelPresetId?: string | null;
  thinkingLevel?: string | null;
  contextWindowOverride?: number | null;
  contextWindowOwnerKey?: string | null;
  systemPrompt?: string;
  goal?: CoworkGoal | null;
  messages?: CoworkMessage[];
}

export interface DshCoworkStorePort {
  getSession(sessionId: string, messageLimit?: number): DshAdapterSessionRecord | null | undefined;
  getLatestUserMessage?(sessionId: string): CoworkMessage | null;
  addMessage(
    sessionId: string,
    message: {
      type: CoworkMessage['type'];
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): CoworkMessage;
  updateMessageContent(
    sessionId: string,
    messageId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): void;
  deleteMessage?(sessionId: string, messageId: string): boolean;
  updateSession(
    sessionId: string,
    updates: {
      claudeSessionId?: string | null;
      status?: CoworkSessionStatus;
      modelOverride?: string | null;
      permissionPreset?: DshPermissionPreset | null;
      thinkingLevel?: ModelThinkingLevel | '';
      goal?: CoworkGoal | null;
    },
  ): void;
  getContinuityCapsule?(sessionId: string): CoworkContinuityCapsule | null;
}

export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
  modelPresetId?: string | null;
  contextWindow?: number;
}

export type DshReadBrowserAnnotationAsset = (identity: {
  draftKey: string;
  batchId: string;
  annotationId: string;
  assetId: string;
}) => { dataUrl: string; byteSize?: number } | null | undefined;

export interface DshRuntimeAdapterDeps {
  subagentSessions?: Pick<DshSubagentSessions, 'observeCatalog' | 'observeNotice' | 'getOwningSessionId' | 'setTask'>
    & Partial<Pick<DshSubagentSessions, 'setDelegatedAgent'>>;
  hostManager: Pick<
    DshHostManager,
    'start' | 'isReady' | 'getClient' | 'bindSessionContext' | 'deleteSessionFiles'
  > & Partial<Pick<DshHostManager, 'setPermissionPreset' | 'consumeApprovalCallContext'>>;
  store: DshCoworkStorePort;
  resolveModelSelection?: (
    sessionId: string,
    override?: string | null,
    thinkingLevelOverride?: string | null,
  ) => Promise<DshModelSelection | null> | DshModelSelection | null;
  resolveAllowedSkillIds?: (
    sessionId: string,
    agentId: string,
    optionSkillIds?: string[],
  ) => string[] | null;
  resolveDefaultPermissionPreset?: () => DshPermissionPreset;
  onPermissionPresetChanged?: (
    preset: DshPermissionPreset,
    coworkSessionId?: string,
  ) => Promise<void> | void;
  readBrowserAnnotationAsset?: DshReadBrowserAnnotationAsset;
}

export const DshGoalCommandKind = {
  Create: 'create',
  Edit: 'edit',
  Pause: 'pause',
  Resume: 'resume',
  Clear: 'clear',
  Show: 'show',
} as const;
export type DshGoalCommandKind = typeof DshGoalCommandKind[keyof typeof DshGoalCommandKind];

export const DshGoalOperation = {
  Create: 'create',
  Edit: 'edit',
  Pause: 'pause',
  Resume: 'resume',
  Complete: 'complete',
  Block: 'block',
  Clear: 'clear',
} as const;
export type DshGoalOperation = typeof DshGoalOperation[keyof typeof DshGoalOperation];

export interface TranslatedDshGoalCommand {
  kind: DshGoalCommandKind;
  line: string;
  objective?: string;
}

interface ActiveTurnState {
  subagentIdsByName: Map<string, string>;
  subagentTasksByCall: Map<string, string>;
  pendingSubagentResults: Set<string>;
  coworkSessionId: string;
  dshSessionId: string;
  requestId?: string;
  userMessageId?: string;
  traceId: string;
  abortController: AbortController;
  confirmationMode: 'modal' | 'text';
  autoApprove: boolean;
  startedAt: number;
  currentThinkingMessageId: string | null;
  currentThinkingText: string;
  attemptThinkingMessageId: string | null;
  reusableThinkingMessageId: string | null;
  lastFinalizedThinkingMessageId: string | null;
  lastFinalizedThinkingText: string;
  currentAssistantMessageId: string | null;
  currentAssistantText: string;
  attemptAssistantMessageId: string | null;
  reusableAssistantMessageId: string | null;
  lastFinalizedAssistantMessageId: string | null;
  lastFinalizedAssistantText: string;
  suppressedPreSteerAssistantText: string | null;
  lastCommittedAssistantSeq: number | null;
  toolCallMessageIds: Map<string, string>;
  currentDshTurnNumber: number | null;
  cancelledDshTurnNumber: number | null;
  goalArmed: boolean;
  waitingForNextGoalRound: boolean;
  disarmedBetweenRounds: boolean;
  currentGoal: CoworkGoal | null;
  turnCompleted: boolean;
  turnError: string | null;
  turnAborted: boolean;
  /** Ignore a trailing aborted `turn/end` leaked from a just-cancelled previous turn. */
  ignoreStaleAbortedTurnEnd: boolean;
  /** Latest in-flight context usage refresh kicked off by assistant/message or compaction/end. */
  pendingContextUsageRefresh: Promise<void> | null;
}

interface CancelledTurnRecord {
  cancelledAt: number;
  dshSessionId: string;
  lastSeenTurnNumber: number | null;
}

const CANCEL_GRACE_WINDOW_MS = 30_000;

interface PendingInteraction {
  requestId: string;
  coworkSessionId: string;
  dshSessionId: string;
  kind: 'approval' | 'user-questions';
  request: PermissionRequest;
  resolve: (outcome: DshWaterfallOutcome) => void;
}

const LEGACY_BRIDGE_MAX_MESSAGES = 8;
const LEGACY_BRIDGE_MAX_CHARS = 6_000;
function cancelledInteraction(kind: PendingInteraction['kind']): DshWaterfallOutcome {
  return kind === 'approval'
    ? { kind: 'result', value: 'cancelled' }
    : { kind: 'rejected', error: { name: 'UserQuestionError', code: 'ASK_ABORTED', message: 'The question was cancelled.' } };
}
const DSH_SUPPORTED_REASONING_EFFORTS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function parseContextWindowSelectionTokens(selection: string | null | undefined): number | null {
  if (typeof selection !== 'string') return null;
  const trimmed = selection.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(USER_CONTEXT_WINDOW_SELECTION_PREFIX)) {
    const rawTokens = trimmed.slice(trimmed.lastIndexOf(':') + 1);
    const parsed = Number(rawTokens);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeDshReasoningEffort(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  return DSH_SUPPORTED_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

async function selectModelWithReasoningFallback(
  client: Pick<DshTypertClient, 'selectModel'>,
  params: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
): Promise<void> {
  const provider = canonicalizeDshProviderId(params.provider);
  const effort = normalizeDshReasoningEffort(params.reasoningEffort);
  try {
    await client.selectModel({
      sessionId: params.sessionId,
      provider,
      model: params.model,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
  } catch (error) {
    if (!effort) throw error;
    // Retry without reasoningEffort when the target model does not declare
    // reasoning support or does not accept the requested effort level.
    console.warn(
      `[DshRuntimeAdapter] selectModel rejected reasoningEffort="${effort}" for ${provider}/${params.model}; retrying without reasoningEffort:`,
      error instanceof Error ? error.message : String(error),
    );
    await client.selectModel({
      sessionId: params.sessionId,
      provider,
      model: params.model,
    });
  }
}

/**
 * Determine whether a stored `claudeSessionId` already belongs to DSH (as
 * opposed to being empty or a legacy OpenClaw session key/id).
 */
export function isDshBackedSessionId(storedId: string | null | undefined): boolean {
  if (!storedId) return false;
  return storedId.startsWith(DSH_SESSION_ID_PREFIX) || storedId.startsWith('session-');
}

export function stripDshSessionPrefix(storedId: string): string {
  return storedId.startsWith(DSH_SESSION_ID_PREFIX)
    ? storedId.slice(DSH_SESSION_ID_PREFIX.length)
    : storedId;
}

export function formatStoredDshSessionId(dshSessionId: string): string {
  return dshSessionId.startsWith(DSH_SESSION_ID_PREFIX)
    ? dshSessionId
    : `${DSH_SESSION_ID_PREFIX}${dshSessionId}`;
}

function assistantEventPosition(dshSessionId: string, seq?: number): { dshSessionId?: string; seq?: number } {
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
    ? { dshSessionId: formatStoredDshSessionId(dshSessionId), seq }
    : {};
}

const SKILL_TO_PROGRESSIVE_CAPABILITY: Readonly<Record<string, DshProgressiveCapability>> = {
  'computer-use': DshProgressiveCapability.ComputerUse,
  'web-search': DshProgressiveCapability.Browser,
  docx: DshProgressiveCapability.Word,
  xlsx: DshProgressiveCapability.Excel,
  pptx: DshProgressiveCapability.Ppt,
};

const SELECTED_TEXT_SOURCE_TO_CAPABILITY: Readonly<Record<string, DshProgressiveCapability>> = {
  [CoworkSelectedTextSource.ArtifactWord]: DshProgressiveCapability.Word,
  [CoworkSelectedTextSource.ArtifactSheet]: DshProgressiveCapability.Excel,
  [CoworkSelectedTextSource.ArtifactSlides]: DshProgressiveCapability.Ppt,
};

const OFFICE_EXTENSION_CAPABILITY_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  capability: DshProgressiveCapability;
}> = [
  { pattern: /\.docx\b/i, capability: DshProgressiveCapability.Word },
  { pattern: /\.xlsx\b/i, capability: DshProgressiveCapability.Excel },
  { pattern: /\.pptx\b/i, capability: DshProgressiveCapability.Ppt },
];

const OFFICE_CAPABILITY_TO_EDITOR = [
  { capability: DshProgressiveCapability.Word, editor: WORD_EDITOR },
  { capability: DshProgressiveCapability.Excel, editor: SHEET_EDITOR },
  { capability: DshProgressiveCapability.Ppt, editor: SLIDES_EDITOR },
] as const;

function collectOfficeCapabilitiesFromText(
  text: string | undefined,
  target: Set<DshProgressiveCapability>,
): void {
  if (typeof text !== 'string' || text.length === 0) return;
  for (const { pattern, capability } of OFFICE_EXTENSION_CAPABILITY_PATTERNS) {
    if (pattern.test(text)) {
      target.add(capability);
    }
  }
}

/**
 * Determine which built-in progressive MCP capability groups should be
 * pre-unlocked for this turn based on explicit user-selected skills,
 * attached browser annotations, selected text excerpts, or Office file
 * references in the prompt/attachments/legacy bridge.
 */
export function resolveUnlockedCapabilitiesForTurn(params: {
  messageSkillIds?: string[];
  browserAnnotations?: CoworkStartOptions['browserAnnotations'];
  selectedTextSnippets?: CoworkStartOptions['selectedTextSnippets'];
  prompt?: string;
  localMediaAttachments?: CoworkStartOptions['localMediaAttachments'];
  lazyBridgePrefix?: string;
}): DshProgressiveCapability[] {
  const unlocked = new Set<DshProgressiveCapability>();
  if (Array.isArray(params.messageSkillIds)) {
    for (const rawId of params.messageSkillIds) {
      if (typeof rawId !== 'string') continue;
      const cap = SKILL_TO_PROGRESSIVE_CAPABILITY[rawId.trim().toLowerCase()];
      if (cap) unlocked.add(cap);
    }
  }
  if (Array.isArray(params.browserAnnotations) && params.browserAnnotations.length > 0) {
    unlocked.add(DshProgressiveCapability.Browser);
  }
  if (Array.isArray(params.selectedTextSnippets)) {
    for (const snippet of params.selectedTextSnippets) {
      if (!snippet || typeof snippet !== 'object') continue;
      const sourceType = snippet.sourceType ?? snippet.sourceMessageType;
      if (typeof sourceType === 'string') {
        const cap = SELECTED_TEXT_SOURCE_TO_CAPABILITY[sourceType];
        if (cap) unlocked.add(cap);
      }
      collectOfficeCapabilitiesFromText(snippet.sourcePath, unlocked);
      collectOfficeCapabilitiesFromText(snippet.sourceTitle, unlocked);
    }
  }
  collectOfficeCapabilitiesFromText(params.prompt, unlocked);
  collectOfficeCapabilitiesFromText(params.lazyBridgePrefix, unlocked);
  if (Array.isArray(params.localMediaAttachments)) {
    for (const att of params.localMediaAttachments) {
      if (!att || typeof att !== 'object') continue;
      collectOfficeCapabilitiesFromText(att.localPath, unlocked);
      collectOfficeCapabilitiesFromText(att.name, unlocked);
    }
  }
  return [...unlocked];
}

/**
 * Build concise in-place Office editing guidance from `buildOfficeAgentPrompt`
 * scoped to the Office capability groups unlocked for this session.
 */
export function resolveOfficeAgentPromptForTurn(
  unlockedCapabilities: Iterable<DshProgressiveCapability>,
): string {
  const unlockedSet = new Set(unlockedCapabilities);
  const editors = OFFICE_CAPABILITY_TO_EDITOR
    .filter(({ capability }) => unlockedSet.has(capability))
    .map(({ editor }) => editor);
  if (editors.length === 0) return '';
  return buildOfficeAgentPrompt(editors);
}

function resolveLocalTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.trim().length > 0 ? tz.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function isGoalCommandPrompt(prompt: string): boolean {
  return /^\/goal(?=$|\s)/i.test(prompt.trim());
}

/**
 * Translate LobsterAI `/goal` syntax (`/goal start <obj>`, `/goal set <obj>`,
 * `/goal edit <obj>`, `/goal pause`, `/goal resume`, `/goal clear`, `/goal status`)
 * into DSH 0.2.2's exact `dsh-command-goal` grammar (`/goal <obj>`,
 * `/goal edit <obj>`, `/goal pause`, `/goal resume`, `/goal clear`, `/goal`).
 */
export function translateLobsterGoalCommandToDsh(
  command: string,
  currentGoal?: CoworkGoal | null,
): TranslatedDshGoalCommand {
  const trimmed = command.trim();
  const normalized = /^\/goal(?=$|\s)/i.test(trimmed)
    ? trimmed
    : trimmed.length > 0
      ? `/goal ${trimmed}`
      : '/goal';
  const rest = normalized.replace(/^\/goal\b/i, '').trim();
  if (!rest) {
    return { kind: DshGoalCommandKind.Show, line: '/goal' };
  }
  const lower = rest.toLowerCase();
  if (lower === 'status') {
    return { kind: DshGoalCommandKind.Show, line: '/goal' };
  }
  if (lower === 'pause') {
    return { kind: DshGoalCommandKind.Pause, line: '/goal pause' };
  }
  if (lower === 'resume') {
    return { kind: DshGoalCommandKind.Resume, line: '/goal resume' };
  }
  if (lower === 'clear') {
    return { kind: DshGoalCommandKind.Clear, line: '/goal clear' };
  }
  const subMatch = /^(start|create|set|edit)(?=$|\s)/i.exec(rest);
  const sub = subMatch?.[1]?.toLowerCase();
  const objective = sub ? rest.slice(sub.length).trim() : rest;
  if (!objective) {
    if (sub === 'edit') {
      return { kind: DshGoalCommandKind.Edit, line: '/goal edit' };
    }
    throw new Error('Goal objective cannot be empty');
  }

  const hasNonCompleteGoal = Boolean(currentGoal && currentGoal.status !== CoworkGoalStatus.Complete);
  if (hasNonCompleteGoal) {
    return {
      kind: DshGoalCommandKind.Edit,
      line: `/goal edit ${objective}`,
      objective,
    };
  }
  return {
    kind: DshGoalCommandKind.Create,
    line: `/goal ${objective}`,
    objective,
  };
}

function normalizeBridgeToolName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[_-]/g, '') : '';
}

function extractLatestLegacyPlanSummary(messages: CoworkMessage[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.type !== 'tool_use') continue;
    const normalizedName = normalizeBridgeToolName(msg.metadata?.toolName ?? msg.content);
    if (normalizedName !== 'todowrite' && normalizedName !== 'updateplan' && normalizedName !== 'progresscard') {
      continue;
    }
    const input = msg.metadata?.toolInput;
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const rec = input as Record<string, unknown>;
    const rawItems = normalizedName === 'todowrite'
      ? (Array.isArray(rec.todos) ? rec.todos : [])
      : (Array.isArray(rec.plan) ? rec.plan : []);
    const lines: string[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const text = (
        (typeof entry.content === 'string' && entry.content.trim())
        || (typeof entry.step === 'string' && entry.step.trim())
        || (typeof entry.title === 'string' && entry.title.trim())
        || (typeof entry.activeForm === 'string' && entry.activeForm.trim())
        || ''
      );
      if (!text) continue;
      const status = typeof entry.status === 'string' && entry.status.trim()
        ? entry.status.trim()
        : 'pending';
      lines.push(`- [${status}] ${text}`);
    }
    const note = (
      (typeof rec.markdown === 'string' && rec.markdown.trim())
      || (typeof rec.explanation === 'string' && rec.explanation.trim())
      || ''
    );
    if (lines.length === 0 && !note) return '';
    return [
      '[历史任务清单/计划]',
      ...(note ? [note.slice(0, 800)] : []),
      ...lines.slice(0, 20),
    ].join('\n');
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.type !== 'assistant' || msg.metadata?.isThinking === true) continue;
    const match = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i.exec(msg.content);
    const planText = match?.[1]?.trim();
    if (planText) {
      return `[历史拟定方案]\n${planText.slice(0, 1_200)}`;
    }
  }
  return '';
}

const LEGACY_BRIDGE_OPEN_TAG = '<previous_conversation_context>\n';
const LEGACY_BRIDGE_CLOSE_TAG = '\n</previous_conversation_context>';
const LEGACY_BRIDGE_IMAGES_HEADER = '[历史消息中的图片] 用户询问图片内容时，请使用 read_image 读取对应文件。\n';
const LEGACY_BRIDGE_TURNS_HEADER = '[历史会话近期对话]\n';
const LEGACY_BRIDGE_MAX_GOAL_CHARS_SHARED = 600;
const LEGACY_BRIDGE_MAX_PLAN_CHARS_SHARED = 1_000;
const LEGACY_BRIDGE_MAX_IMAGES_CHARS_SHARED = 1_200;
const LEGACY_BRIDGE_CAPSULE_BUDGET_RATIO = 0.45;

function fitNewestLinesToBudget(
  header: string,
  entries: string[],
  separator: string,
  maxChars: number,
): string {
  if (entries.length === 0 || maxChars <= header.length) return '';
  const bodyBudget = maxChars - header.length;
  const kept: string[] = [];
  let used = 0;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const addition = kept.length === 0 ? entry.length : entry.length + separator.length;
    if (used + addition <= bodyBudget) {
      kept.unshift(entry);
      used += addition;
      continue;
    }
    if (kept.length === 0 && bodyBudget > 0) {
      const truncated = entry.slice(0, bodyBudget).trimEnd();
      if (truncated) kept.unshift(truncated);
    }
    break;
  }

  return kept.length > 0 ? `${header}${kept.join(separator)}` : '';
}

function truncateBridgeText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd();
}

/**
 * Build a compact one-time context bridge prefix when resuming a historical
 * OpenClaw session inside DSH for the first time ("Lazy Context Bridge").
 *
 * Reserves budget for legacy goal/plan, history images, continuity capsule,
 * and the most recent turns so oversized history drops older turns or excess
 * capsule tail instead of slicing off the newest messages from the end.
 */
export function buildLazyContextBridgePrefix(
  capsule: CoworkContinuityCapsule | null,
  messages: CoworkMessage[] | undefined,
  goal?: CoworkGoal | null,
): string {
  const maxBodyChars = LEGACY_BRIDGE_MAX_CHARS
    - LEGACY_BRIDGE_OPEN_TAG.length
    - LEGACY_BRIDGE_CLOSE_TAG.length;

  const goalSection = goal && typeof goal.objective === 'string' && goal.objective.trim().length > 0
    ? [
        '[历史会话目标]',
        `状态: ${goal.status}`,
        `目标: ${goal.objective.trim()}`,
        ...(goal.lastStatusNote?.trim() ? [`备注: ${goal.lastStatusNote.trim()}`] : []),
      ].join('\n')
    : '';

  const planSection = extractLatestLegacyPlanSummary(messages);

  const imageLines = (messages ?? [])
    .filter((message) => message.type === 'user')
    .flatMap((message) => message.metadata?.historyImageReferences ?? [])
    .slice(-LEGACY_BRIDGE_MAX_MESSAGES)
    .map((image) => JSON.stringify(image));

  const capsuleText = capsule ? formatCoworkContinuityCapsuleBridge(capsule).trim() : '';

  const turnEntries = (messages ?? [])
    .filter((m) => (
      (m.type === 'user' || m.type === 'assistant')
      && m.metadata?.isThinking !== true
      && m.content.trim().length > 0
    ))
    .slice(-LEGACY_BRIDGE_MAX_MESSAGES)
    .map((m) => `${m.type === 'user' ? '用户' : '助手'}: ${m.content.trim().slice(0, 800)}`);

  const fullImagesSection = imageLines.length > 0
    ? `${LEGACY_BRIDGE_IMAGES_HEADER}${imageLines.join('\n')}`
    : '';
  const fullTurnsSection = turnEntries.length > 0
    ? `${LEGACY_BRIDGE_TURNS_HEADER}${turnEntries.join('\n\n')}`
    : '';

  const rawParts = [
    goalSection,
    planSection,
    fullImagesSection,
    capsuleText,
    fullTurnsSection,
  ].filter(Boolean);
  if (rawParts.length === 0) return '';

  const fullBody = rawParts.join('\n\n');
  if (fullBody.length <= maxBodyChars) {
    return `${LEGACY_BRIDGE_OPEN_TAG}${fullBody}${LEGACY_BRIDGE_CLOSE_TAG}`;
  }

  const hasGoal = goalSection.length > 0;
  const hasPlan = planSection.length > 0;
  const hasImages = imageLines.length > 0;
  const hasCapsule = capsuleText.length > 0;
  const hasTurns = turnEntries.length > 0;
  const sectionCount = Number(hasGoal)
    + Number(hasPlan)
    + Number(hasImages)
    + Number(hasCapsule)
    + Number(hasTurns);
  const separatorChars = Math.max(0, sectionCount - 1) * 2;
  let remaining = Math.max(0, maxBodyChars - separatorChars);

  let fittedGoal = '';
  if (hasGoal) {
    const goalCap = hasPlan || hasImages || hasCapsule || hasTurns
      ? Math.min(goalSection.length, LEGACY_BRIDGE_MAX_GOAL_CHARS_SHARED, remaining)
      : remaining;
    fittedGoal = truncateBridgeText(goalSection, goalCap);
    remaining = Math.max(0, remaining - fittedGoal.length);
  }

  let fittedPlan = '';
  if (hasPlan) {
    const planCap = hasImages || hasCapsule || hasTurns
      ? Math.min(planSection.length, LEGACY_BRIDGE_MAX_PLAN_CHARS_SHARED, remaining)
      : remaining;
    fittedPlan = truncateBridgeText(planSection, planCap);
    remaining = Math.max(0, remaining - fittedPlan.length);
  }

  let imagesSection = '';
  if (hasImages) {
    const imagesCap = hasCapsule || hasTurns
      ? Math.min(fullImagesSection.length, LEGACY_BRIDGE_MAX_IMAGES_CHARS_SHARED, remaining)
      : remaining;
    imagesSection = fitNewestLinesToBudget(LEGACY_BRIDGE_IMAGES_HEADER, imageLines, '\n', imagesCap);
    remaining = Math.max(0, remaining - imagesSection.length);
  }

  let fittedCapsule = '';
  let fittedTurns = '';
  if (hasCapsule && hasTurns) {
    const targetCapsuleBudget = Math.floor(remaining * LEGACY_BRIDGE_CAPSULE_BUDGET_RATIO);
    const targetTurnsBudget = remaining - targetCapsuleBudget;
    let capsuleBudget: number;
    if (capsuleText.length <= targetCapsuleBudget) {
      capsuleBudget = capsuleText.length;
    } else if (fullTurnsSection.length <= targetTurnsBudget) {
      capsuleBudget = remaining - fullTurnsSection.length;
    } else {
      capsuleBudget = targetCapsuleBudget;
    }
    fittedCapsule = truncateBridgeText(capsuleText, capsuleBudget);
    const actualTurnsBudget = remaining - fittedCapsule.length;
    fittedTurns = fitNewestLinesToBudget(LEGACY_BRIDGE_TURNS_HEADER, turnEntries, '\n\n', actualTurnsBudget);
    if (fittedCapsule.length < capsuleText.length) {
      const reclaimedCapsuleBudget = remaining - fittedTurns.length;
      if (reclaimedCapsuleBudget > fittedCapsule.length) {
        fittedCapsule = truncateBridgeText(capsuleText, reclaimedCapsuleBudget);
      }
    }
  } else if (hasCapsule) {
    fittedCapsule = truncateBridgeText(capsuleText, remaining);
  } else if (hasTurns) {
    fittedTurns = fitNewestLinesToBudget(LEGACY_BRIDGE_TURNS_HEADER, turnEntries, '\n\n', remaining);
  }

  const finalParts = [fittedGoal, fittedPlan, imagesSection, fittedCapsule, fittedTurns].filter(Boolean);
  if (finalParts.length === 0) return '';
  return `${LEGACY_BRIDGE_OPEN_TAG}${finalParts.join('\n\n')}${LEGACY_BRIDGE_CLOSE_TAG}`;
}

export class DshRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly subagentSessions?: DshRuntimeAdapterDeps['subagentSessions'];
  private readonly hostManager: DshRuntimeAdapterDeps['hostManager'];
  private readonly store: DshCoworkStorePort;
  private readonly resolveModelSelection?: DshRuntimeAdapterDeps['resolveModelSelection'];
  private readonly resolveAllowedSkillIds?: DshRuntimeAdapterDeps['resolveAllowedSkillIds'];
  private readonly resolveDefaultPermissionPreset?: DshRuntimeAdapterDeps['resolveDefaultPermissionPreset'];
  private readonly onPermissionPresetChanged?: DshRuntimeAdapterDeps['onPermissionPresetChanged'];
  private readonly readBrowserAnnotationAsset?: DshReadBrowserAnnotationAsset;

  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly startingAbortControllers = new Map<string, AbortController>();
  private readonly pendingCancels = new Map<string, Promise<void>>();
  private readonly lastCancelledTurnBySession = new Map<string, CancelledTurnRecord>();
  private readonly dshToCoworkSession = new Map<string, string>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly btwAbortControllers = new Map<string, AbortController>();
  private readonly sessionAllowedScopes = new Map<string, Set<string>>();
  private readonly sessionPermissionPresets = new Map<string, DshPermissionPreset>();
  private readonly sessionUnlockedCapabilities = new Map<string, Set<DshProgressiveCapability>>();
  private readonly sessionThinkingLevels = new Map<string, string>();
  private readonly sessionContextWindows = new Map<string, string | null>();
  private readonly sessionResolvedContextTokens = new Map<string, number>();
  private wiredClient: DshTypertClient | null = null;
  private unwireClientHandlers: Array<() => void> = [];

  constructor(deps: DshRuntimeAdapterDeps) {
    super();
    this.subagentSessions = deps.subagentSessions;
    this.hostManager = deps.hostManager;
    this.store = deps.store;
    this.resolveModelSelection = deps.resolveModelSelection;
    this.resolveAllowedSkillIds = deps.resolveAllowedSkillIds;
    this.resolveDefaultPermissionPreset = deps.resolveDefaultPermissionPreset;
    this.onPermissionPresetChanged = deps.onPermissionPresetChanged;
    this.readBrowserAnnotationAsset = deps.readBrowserAnnotationAsset;
  }

  private getExplicitPermissionPreset(coworkSessionId?: string): DshPermissionPreset | null {
    if (!coworkSessionId) return null;
    const cached = this.sessionPermissionPresets.get(coworkSessionId);
    if (cached) return cached;
    const persisted = parseDshPermissionPreset(this.store.getSession(coworkSessionId, 0)?.permissionPreset);
    if (persisted) {
      this.sessionPermissionPresets.set(coworkSessionId, persisted);
      return persisted;
    }
    return null;
  }

  getEffectivePermissionPreset(coworkSessionId?: string): DshPermissionPreset {
    const explicit = this.getExplicitPermissionPreset(coworkSessionId);
    if (explicit) return explicit;
    return this.resolveDefaultPermissionPreset?.() ?? DEFAULT_DSH_PERMISSION_PRESET;
  }

  async setSessionPermissionPreset(
    preset: DshPermissionPreset,
    coworkSessionId?: string,
  ): Promise<void> {
    if (coworkSessionId) {
      this.sessionPermissionPresets.set(coworkSessionId, preset);
      this.store.updateSession(coworkSessionId, { permissionPreset: preset });
      const dshSessionId = this.resolveExistingDshSessionId(coworkSessionId);
      if (dshSessionId && this.hostManager.setPermissionPreset) {
        await this.hostManager.setPermissionPreset(preset, dshSessionId);
      }
      return;
    }
    // Global default updates must NOT clear explicit per-session overrides.
    if (this.hostManager.setPermissionPreset) {
      await this.hostManager.setPermissionPreset(preset);
    }
  }

  isToolAllowedInSession(params: {
    toolName: string;
    args: unknown;
    sessionId?: string;
    coworkSessionId?: string;
    scopeKey?: string;
  }): boolean {
    const coworkSessionId = params.coworkSessionId
      ?? (params.sessionId ? this.dshToCoworkSession.get(params.sessionId) : undefined);
    if (!coworkSessionId) return false;
    const allowed = this.sessionAllowedScopes.get(coworkSessionId);
    if (!allowed || allowed.size === 0) return false;
    const scopeKey = params.scopeKey ?? buildApprovalScopeKey(params.toolName, params.args);
    return allowed.has(scopeKey) || allowed.has('*');
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

  async startSession(
    sessionId: string,
    prompt: string,
    options: CoworkStartOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      isContinue: false,
      skipInitialUserMessage: options.skipInitialUserMessage,
      userMessageContent: options.userMessageContent,
      skillIds: options.skillIds,
      messageSkillIds: options.messageSkillIds,
      selectedTextSnippets: options.selectedTextSnippets,
      browserAnnotations: options.browserAnnotations,
      systemPrompt: options.systemPrompt,
      confirmationMode: options.confirmationMode ?? 'modal',
      autoApprove: options.autoApprove,
      imageAttachments: options.imageAttachments,
      mediaInstruction: buildDshMediaTurnInstruction(options.mediaSelection, options.mediaReferences, options.workflowKind),
      localMediaAttachments: options.localMediaAttachments,
      agentId: options.agentId,
      workspaceRoot: options.workspaceRoot,
    });
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: CoworkContinueOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      isContinue: true,
      requestId: options.requestId,
      onAccepted: options.onAccepted,
      skipInitialUserMessage: options.skipInitialUserMessage,
      userMessageContent: options.userMessageContent,
      skillIds: options.skillIds,
      messageSkillIds: options.messageSkillIds,
      selectedTextSnippets: options.selectedTextSnippets,
      browserAnnotations: options.browserAnnotations,
      systemPrompt: options.systemPrompt,
      confirmationMode: 'modal',
      imageAttachments: options.imageAttachments,
      mediaInstruction: buildDshMediaTurnInstruction(options.mediaSelection, options.mediaReferences, options.workflowKind),
      localMediaAttachments: options.localMediaAttachments,
    });
  }

  async submitSteer(
    sessionId: string,
    text: string,
    clientSteerId: string,
  ): Promise<CoworkSteerResponse> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Steer text cannot be empty');
    }
    const requestId = clientSteerId || randomUUID();

    const fallbackToContinuation = async (): Promise<CoworkSteerResponse> => {
      if (!this.store.getSession(sessionId)) {
        throw new Error(`No active DSH session found for ${sessionId}`);
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const rejectOnce = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        void this.continueSession(sessionId, trimmed, {
          requestId,
          onAccepted: resolveOnce,
        }).then(resolveOnce, rejectOnce);
      });
      return {
        success: true,
        status: CoworkSteerStatus.Accepted,
        clientSteerId,
      };
    };

    // Check active turn BEFORE issuing promptSession(mode:'steer'). If the prior
    // turn finished milliseconds earlier, fall back cleanly to a followed
    // continuation turn so DSH never runs an unfollowed turn that hangs in `running`.
    if (!this.activeTurns.has(sessionId)) {
      return fallbackToContinuation();
    }

    const client = await this.ensureReadyClient();
    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) {
      return fallbackToContinuation();
    }
    const dshSessionId = activeTurn.dshSessionId;

    // Finalize pre-steer thinking/assistant buffers before steering so pre-steer
    // text remains above the steer bubble and post-steer output opens a fresh bubble below it.
    this.flushTurnBuffersForSteer(activeTurn);

    const clientTimeZone = resolveLocalTimeZone();
    await client.promptSession({
      sessionId: dshSessionId,
      requestId,
      content: [{ type: 'text', text: trimmed }],
      mode: 'steer',
      ...(clientTimeZone ? { clientTimeZone } : {}),
    });

    const liveTurn = this.activeTurns.get(sessionId);
    if (liveTurn) {
      this.flushTurnBuffersForSteer(liveTurn);
    }

    const message = this.store.addMessage(sessionId, {
      type: 'user',
      content: trimmed,
      metadata: { steer: true, clientSteerId },
    });
    this.emit('message', sessionId, message);

    if (!liveTurn) {
      // Turn completed during the brief in-flight window of promptSession(mode:'steer'),
      // causing DSH to wake a new turn. Attach a follow stream immediately so the reply
      // streams cleanly and transitions back to `completed`.
      this.attachFollowWatcherForWokenTurn(client, sessionId, dshSessionId, message.id, requestId);
    }

    return {
      success: true,
      status: CoworkSteerStatus.Accepted,
      clientSteerId,
    };
  }

  /**
   * Option B queue mutation: edit, remove, or promote a queued pending message.
   */
  async updateQueuedMessage(
    sessionId: string,
    itemId: string,
    action: DshSessionUpdateQueueParams['action'],
  ): Promise<{ accepted: boolean }> {
    const client = await this.ensureReadyClient();
    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId) {
      throw new Error(`No DSH session found for ${sessionId}`);
    }
    return client.updateQueue({ sessionId: dshSessionId, itemId, action });
  }

  /**
   * Option B fork: create a new independent DSH session branched from `atSeq`
   * (or the latest completed turn when omitted).
   */
  async forkDshSession(
    sessionId: string,
    atSeq?: number,
  ): Promise<{ dshSessionId: string; storedSessionId: string }> {
    const client = await this.ensureReadyClient();
    const sourceDshId = this.resolveExistingDshSessionId(sessionId);
    if (!sourceDshId) {
      throw new Error(`Cannot fork session "${sessionId}" before it has a DSH session`);
    }
    const res = await client.forkSession({
      sessionId: sourceDshId,
      ...(atSeq !== undefined ? { atSeq } : {}),
    });
    return {
      dshSessionId: res.sessionId,
      storedSessionId: formatStoredDshSessionId(res.sessionId),
    };
  }

  async patchSession(
    sessionId: string,
    patch: OpenClawSessionPatch,
  ): Promise<CoworkSessionPatchResult | void> {
    const modelStr = typeof patch.model === 'string' ? patch.model.trim() : '';
    const hasThinkingPatch = patch.thinkingLevel !== undefined;
    const thinkingPatchValue = typeof patch.thinkingLevel === 'string'
      ? patch.thinkingLevel.trim()
      : null;
    const thinking = thinkingPatchValue ?? '';
    const hasContextWindowPatch = patch.contextWindow !== undefined;
    const normalizedContextWindow = typeof patch.contextWindow === 'string' && patch.contextWindow.trim().length > 0
      ? patch.contextWindow.trim()
      : null;

    const sessionUpdates: Parameters<DshCoworkStorePort['updateSession']>[1] = {};
    if (modelStr) {
      sessionUpdates.modelOverride = modelStr;
    }
    if (hasThinkingPatch) {
      if (thinking) {
        this.sessionThinkingLevels.set(sessionId, thinking);
        const parsedThinking = parseModelThinkingLevel(thinking.toLowerCase());
        sessionUpdates.thinkingLevel = parsedThinking ?? '';
      } else {
        this.sessionThinkingLevels.delete(sessionId);
        sessionUpdates.thinkingLevel = '';
      }
    }
    if (Object.keys(sessionUpdates).length > 0) {
      this.store.updateSession(sessionId, sessionUpdates);
    }

    if (hasContextWindowPatch) {
      this.sessionContextWindows.set(sessionId, normalizedContextWindow);
      const parsedTokens = parseContextWindowSelectionTokens(normalizedContextWindow);
      if (parsedTokens !== null) {
        this.sessionResolvedContextTokens.set(sessionId, parsedTokens);
      } else {
        this.sessionResolvedContextTokens.delete(sessionId);
      }
    }

    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId || !this.hostManager.isReady()) {
      return {
        ...(modelStr ? { modelOverride: modelStr, resolvedModelRef: modelStr } : {}),
        ...(thinkingPatchValue ? { thinkingLevel: thinkingPatchValue } : {}),
      };
    }

    if (hasContextWindowPatch) {
      await this.hostManager.bindSessionContext({
        sessionId: dshSessionId,
        coworkSessionId: sessionId,
        contextWindowSelection: normalizedContextWindow,
        contextWindowOverride: parseContextWindowSelectionTokens(normalizedContextWindow),
      });
    }

    if (patch.model !== undefined || hasThinkingPatch) {
      const session = this.store.getSession(sessionId, 0);
      const selection = this.resolveModelSelection
        ? await this.resolveModelSelection(
            sessionId,
            modelStr || undefined,
            hasThinkingPatch ? thinkingPatchValue : undefined,
          )
        : parseProviderModelRef(modelStr || session?.modelOverride || '');
      if (selection) {
        const resolverHandlesThinking = Boolean(
          this.resolveModelSelection && this.resolveModelSelection.length >= 3,
        );
        const resolvedEffort = hasThinkingPatch
          ? (resolverHandlesThinking
              ? selection.reasoningEffort
              : (selection.reasoningEffort ?? (thinking || undefined)))
          : (resolverHandlesThinking
              ? selection.reasoningEffort
              : (selection.reasoningEffort
                ?? this.sessionThinkingLevels.get(sessionId)
                ?? (typeof session?.thinkingLevel === 'string' && session.thinkingLevel.trim()
                  ? session.thinkingLevel.trim()
                  : undefined)));
        if (typeof selection.contextWindow === 'number' && selection.contextWindow > 0 && !hasContextWindowPatch) {
          this.sessionResolvedContextTokens.set(sessionId, selection.contextWindow);
        }
        await selectModelWithReasoningFallback(this.hostManager.getClient(), {
          sessionId: dshSessionId,
          provider: canonicalizeDshProviderId(selection.provider),
          model: selection.model,
          reasoningEffort: resolvedEffort,
        });
      }
    }

    return {
      ...(modelStr ? { modelOverride: modelStr, resolvedModelRef: modelStr } : {}),
      ...(thinkingPatchValue ? { thinkingLevel: thinkingPatchValue } : {}),
    };
  }

  async getContextUsage(sessionId: string): Promise<CoworkContextUsage | null> {
    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId || !this.hostManager.isReady()) return null;

    const client = this.hostManager.getClient();
    if (typeof client.getSessionProjections !== 'function') return null;

    const projections = await client.getSessionProjections(dshSessionId);
    const session = this.store.getSession(sessionId, 0);
    const patchedSelection = this.sessionContextWindows.get(sessionId);
    const patchedTokens = patchedSelection !== undefined
      ? parseContextWindowSelectionTokens(patchedSelection)
      : null;
    const persistedTokens = typeof session?.contextWindowOverride === 'number' && session.contextWindowOverride > 0
      ? session.contextWindowOverride
      : null;
    const resolvedTokens = this.sessionResolvedContextTokens.get(sessionId);
    const contextWindowOverride = patchedTokens ?? persistedTokens ?? resolvedTokens ?? null;
    return extractContextUsageFromProjections(
      sessionId,
      dshSessionId,
      projections,
      contextWindowOverride,
    );
  }

  async compactContext(
    sessionId: string,
  ): Promise<{ compacted: boolean; reason?: string; usage?: CoworkContextUsage | null }> {
    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId) {
      return { compacted: false, reason: 'Session has no active DSH history yet' };
    }
    const client = await this.ensureReadyClient();
    this.emit('contextMaintenance', sessionId, true);
    try {
      const execution = await client.executeCommand({
        agentId: dshSessionId,
        line: '/compact',
      });
      if (!execution) {
        const usage = await this.getContextUsage(sessionId).catch((): null => null);
        if (usage) this.emit('contextUsageUpdate', sessionId, usage);
        return {
          compacted: false,
          reason: 'Compaction command is unavailable for this session',
          usage,
        };
      }

      if (execution.result.kind === 'error') {
        throw new Error(execution.result.text || 'Context compaction failed');
      }

      // `@deepseek-ai/dsh-command-compact` attaches `sourceEventSeq` (the
      // `compaction/summary` seq) when compaction committed, and omits it on
      // the no-op `"No compactable history yet."` outcome.
      const summarySeq = execution.result.sourceEventSeq;
      const compacted = typeof summarySeq === 'number' && Number.isFinite(summarySeq);
      const usage = await this.getContextUsage(sessionId).catch((): null => null);
      if (usage) this.emit('contextUsageUpdate', sessionId, usage);

      if (!compacted) {
        return {
          compacted: false,
          reason: execution.result.text?.trim() || 'No compactable history yet.',
          usage,
        };
      }

      const compactionMessage = this.store.addMessage(sessionId, {
        type: 'system',
        content: '',
        metadata: {
          kind: CoworkSystemMessageKind.ContextCompaction,
          mode: ContextCompactionMode.Manual,
          status: ContextCompactionStatus.Completed,
          compacted: true,
          seq: summarySeq,
          ...(execution.result.text ? { summary: execution.result.text } : {}),
        },
      });
      this.emit('message', sessionId, compactionMessage);

      return { compacted: true, usage };
    } finally {
      this.emit('contextMaintenance', sessionId, false);
    }
  }

  private async refreshAndEmitContextUsage(sessionId: string): Promise<void> {
    try {
      const usage = await this.getContextUsage(sessionId);
      if (usage) {
        this.emit('contextUsageUpdate', sessionId, usage);
      }
    } catch {
      // Non-fatal: UI polling or the next step will retry.
    }
  }

  async runGoalCommand(sessionId: string, command: string): Promise<CoworkGoal | null> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Cowork session "${sessionId}" not found`);
    }

    const pendingCancel = this.pendingCancels.get(sessionId);
    const hadPriorCancel = Boolean(pendingCancel);
    if (pendingCancel) {
      await pendingCancel;
    }

    const client = await this.ensureReadyClient();
    const existingDshSessionId = this.resolveExistingDshSessionId(sessionId);
    let dshSessionId = existingDshSessionId;
    let lazyBridgePrefix = '';
    let boundFreshSession = false;

    if (!dshSessionId) {
      const priorMessages = [...(session.messages ?? [])];
      const created = await client.createSession({ cwd: session.cwd });
      dshSessionId = created.sessionId;
      this.store.updateSession(sessionId, {
        claudeSessionId: formatStoredDshSessionId(dshSessionId),
      });

      const hasLegacyHistory = Boolean(
        priorMessages.length > 0
        || session.goal
        || (session.claudeSessionId && !isDshBackedSessionId(session.claudeSessionId)),
      );
      if (hasLegacyHistory) {
        const capsule = this.store.getContinuityCapsule?.(sessionId) ?? null;
        lazyBridgePrefix = buildLazyContextBridgePrefix(capsule, priorMessages, session.goal);
      }
      boundFreshSession = true;
    }

    this.dshToCoworkSession.set(dshSessionId, sessionId);

    const existingProjections = existingDshSessionId
      ? await this.safeGetSessionProjections(client, dshSessionId)
      : null;
    const currentDshGoal = extractGoalFromProjections(existingProjections);

    let translated = translateLobsterGoalCommandToDsh(command, currentDshGoal);
    // Upgraded legacy session may carry a persisted SQLite goal before DSH has any
    // goal events. Translate `/goal resume` into creating that goal in DSH, and
    // settle `/goal pause` directly when DSH has not created the goal yet.
    if (!currentDshGoal && session.goal) {
      if (translated.kind === DshGoalCommandKind.Resume && session.goal.objective.trim()) {
        const legacyObjective = session.goal.objective.trim();
        translated = {
          kind: DshGoalCommandKind.Create,
          line: `/goal ${legacyObjective}`,
          objective: legacyObjective,
        };
      } else if (translated.kind === DshGoalCommandKind.Pause) {
        const now = Date.now();
        const pausedGoal: CoworkGoal = {
          ...session.goal,
          status: CoworkGoalStatus.Paused,
          updatedAt: now,
          pausedAt: now,
        };
        this.store.updateSession(sessionId, { goal: pausedGoal });
        this.emit('goalUpdate', sessionId, pausedGoal);
        return pausedGoal;
      }
    }

    const willStartGoalTurn =
      (translated.kind === DshGoalCommandKind.Create || translated.kind === DshGoalCommandKind.Resume)
      && !this.activeTurns.has(sessionId);

    let llmTraceId = '';
    if (boundFreshSession || willStartGoalTurn) {
      const llmTrace = createCoworkLlmTrace();
      llmTraceId = llmTrace.traceId;
      const modelSelection = this.resolveModelSelection
        ? await this.resolveModelSelection(sessionId, session.modelOverride)
        : null;
      registerLlmUsageContext(llmTrace.traceId, sessionId, translated.line, {
        title: session.title,
        modelPresetId: session.modelPresetId ?? undefined,
        resolvedModelId: modelSelection?.model,
      });

      const agentId = session.agentId || 'main';
      const allowedSkillIds = this.resolveAllowedSkillIds
        ? this.resolveAllowedSkillIds(sessionId, agentId)
        : null;
      const effectiveSystemPrompt = [session.systemPrompt ?? '', lazyBridgePrefix]
        .filter((part) => part.trim().length > 0)
        .join('\n\n');
      const contextPayload: DshHostSessionContext = {
        sessionId: dshSessionId,
        agentId,
        coworkSessionId: sessionId,
        traceId: llmTrace.traceId,
        workspaceDir: session.cwd,
        allowedSkillIds,
        customSystemPrompt: effectiveSystemPrompt,
        ...(session.executionMode ? { executionMode: session.executionMode } : {}),
        permissionPreset: this.getEffectivePermissionPreset(sessionId),
      };
      await this.hostManager.bindSessionContext(contextPayload);

      if (modelSelection) {
        await selectModelWithReasoningFallback(client, {
          sessionId: dshSessionId,
          provider: modelSelection.provider,
          model: modelSelection.model,
          reasoningEffort: modelSelection.reasoningEffort,
        });
      }
    }

    if (willStartGoalTurn) {
      const { hadRecentCancel, cancelledTurnNumber } = this.consumeRecentCancelState(
        sessionId,
        dshSessionId,
        hadPriorCancel,
      );
      const abortController = new AbortController();
      const turn = this.createActiveTurnState({
        coworkSessionId: sessionId,
        dshSessionId,
        traceId: llmTraceId || createCoworkLlmTrace().traceId,
        abortController,
        confirmationMode: 'modal',
        ignoreStaleAbortedTurnEnd: hadRecentCancel,
        cancelledDshTurnNumber: cancelledTurnNumber,
        goalArmed: true,
        currentGoal: currentDshGoal,
      });
      this.activeTurns.set(sessionId, turn);
      this.store.updateSession(sessionId, { status: 'running' });
      this.emit('sessionStatus', sessionId, 'running');

      const followStream = client.followSession<Record<string, unknown>>(
        {
          address: { kind: 'session', sessionId: dshSessionId },
          assistantStream: true,
          activate: true,
        },
        abortController.signal,
      );
      void this.consumeFollowStream(turn, followStream);

      let execution: Awaited<ReturnType<DshTypertClient['executeCommand']>>;
      try {
        execution = await client.executeCommand({
          agentId: dshSessionId,
          line: translated.line,
          submittedAttachments: [],
        });
        if (!execution || execution.result.kind === 'error') {
          throw new Error(execution?.result.text ?? `DSH did not recognize goal command "${translated.line}"`);
        }
      } catch (error) {
        abortController.abort(error);
        if (this.activeTurns.get(sessionId) === turn) {
          this.activeTurns.delete(sessionId);
        }
        this.store.updateSession(sessionId, { status: 'idle' });
        this.emit('sessionStatus', sessionId, 'idle');
        throw error;
      }

      const projections = await this.safeGetSessionProjections(client, dshSessionId);
      const projectedGoal = extractGoalFromProjections(projections);
      const goal = projectedGoal ?? turn.currentGoal;
      turn.currentGoal = goal;
      this.store.updateSession(sessionId, { goal });
      this.emit('goalUpdate', sessionId, goal);
      return goal;
    }

    const execution = await client.executeCommand({
      agentId: dshSessionId,
      line: translated.line,
      submittedAttachments: [],
    });
    if (!execution || execution.result.kind === 'error') {
      throw new Error(execution?.result.text ?? `DSH did not recognize goal command "${translated.line}"`);
    }

    const projections = await this.safeGetSessionProjections(client, dshSessionId);
    const goal = extractGoalFromProjections(projections);
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn) {
      activeTurn.currentGoal = goal;
      if (translated.kind === DshGoalCommandKind.Pause || translated.kind === DshGoalCommandKind.Clear) {
        activeTurn.goalArmed = false;
      }
    }
    this.store.updateSession(sessionId, { goal });
    this.emit('goalUpdate', sessionId, goal);
    return goal;
  }

  async submitBtw(
    sessionId: string,
    question: string,
    runId: string,
  ): Promise<CoworkBtwSubmitResponse> {
    const trimmed = question.trim();
    if (!trimmed) {
      throw new Error('BTW question cannot be empty');
    }
    const client = await this.ensureReadyClient();
    const sourceDshId = this.resolveExistingDshSessionId(sessionId);
    if (!sourceDshId) {
      throw new Error(`Cannot run BTW side question before session ${sessionId} starts`);
    }

    const abortController = new AbortController();
    this.btwAbortControllers.set(runId, abortController);
    const createdAt = Date.now();

    void (async () => {
      try {
        const forked = await client.forkSession({ sessionId: sourceDshId });
        const btwSessionId = forked.sessionId;
        const chunks: string[] = [];
        const followStream = client.followSession<Record<string, unknown>>(
          {
            address: { kind: 'session', sessionId: btwSessionId },
            assistantStream: true,
            activate: true,
          },
          abortController.signal,
        );
        const promptPromise = client.promptSession({
          sessionId: btwSessionId,
          requestId: runId,
          content: [{ type: 'text', text: trimmed }],
          mode: 'queue',
        });
        await promptPromise;

        for await (const frame of followStream) {
          if (frame.type === 'assistant-stream') {
            const inner = frame.frame as Record<string, unknown> | undefined;
            if (inner?.type === 'chunk') {
              const chunk = inner.chunk as Record<string, unknown> | undefined;
              const deltaText = extractStreamChunkDelta(chunk);
              if (chunk?.type === 'text-delta' && deltaText) {
                chunks.push(deltaText);
              }
            } else if (inner?.type === 'end' && isFailedAssistantStreamOutcome(inner.outcome)) {
              chunks.length = 0;
            }
          } else if (frame.type === 'event') {
            const ev = frame.event as Record<string, unknown> | undefined;
            if (ev?.type === 'assistant/message' && chunks.length === 0) {
              const evData = (ev.data as Record<string, unknown> | undefined) ?? {};
              const rawContent = (evData.message as Record<string, unknown> | undefined)?.content ?? evData.content;
              const fallback = extractTextFromContentBlocks(rawContent);
              if (fallback) chunks.push(fallback);
            }
            if (ev?.type === 'turn/end') {
              const evData = (ev.data as Record<string, unknown> | undefined) ?? {};
              const turnError = extractTurnEndError(evData.reason);
              if (turnError) {
                throw new Error(turnError);
              }
              break;
            }
          }
        }
        await this.hostManager.deleteSessionFiles(btwSessionId).catch((): void => undefined);
        this.emit('btwResult', sessionId, {
          runId,
          sessionId,
          question: trimmed,
          answer: chunks.join(''),
          status: CoworkBtwStatus.Answered,
          createdAt,
          completedAt: Date.now(),
        });
      } catch (error) {
        this.emit('btwResult', sessionId, {
          runId,
          sessionId,
          question: trimmed,
          answer: '',
          error: error instanceof Error ? error.message : String(error),
          status: abortController.signal.aborted
            ? CoworkBtwStatus.Stopped
            : CoworkBtwStatus.Failed,
          createdAt,
          completedAt: Date.now(),
        });
      } finally {
        this.btwAbortControllers.delete(runId);
      }
    })();

    return { success: true, runId };
  }

  async abortBtw(_sessionId: string, runId: string): Promise<CoworkBtwAbortResponse> {
    const controller = this.btwAbortControllers.get(runId);
    if (controller) {
      controller.abort(new Error('BTW aborted by user'));
      this.btwAbortControllers.delete(runId);
      return { success: true, aborted: true, runId };
    }
    return { success: true, aborted: false, runId };
  }

  stopSession(sessionId: string): void {
    const startingAbort = this.startingAbortControllers.get(sessionId);
    if (startingAbort) {
      this.startingAbortControllers.delete(sessionId);
      startingAbort.abort(new Error('Session stopped by user'));
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      if (startingAbort) {
        this.store.updateSession(sessionId, { status: 'idle' });
        this.emit('sessionStatus', sessionId, 'idle');
        this.emit('sessionStopped', sessionId, { runIds: [], startedAt: Date.now() });
      }
      return;
    }
    this.activeTurns.delete(sessionId);
    turn.abortController.abort(new Error('Session stopped by user'));
    this.finalizeActiveThinkingMessage(turn);
    this.finalizeActiveAssistantMessage(turn);
    this.discardReusableMessages(turn);
    this.cancelPendingInteractionsForSession(sessionId);

    this.lastCancelledTurnBySession.set(sessionId, {
      cancelledAt: Date.now(),
      dshSessionId: turn.dshSessionId,
      lastSeenTurnNumber: turn.currentDshTurnNumber,
    });

    if (this.hostManager.isReady()) {
      const cancelPromise = this.hostManager
        .getClient()
        .cancelSession(turn.dshSessionId)
        .then((): void => undefined)
        .catch((): void => undefined);
      this.pendingCancels.set(sessionId, cancelPromise);
      void cancelPromise.finally(() => {
        if (this.pendingCancels.get(sessionId) === cancelPromise) {
          this.pendingCancels.delete(sessionId);
        }
      });
    }

    const stopped: CoworkStoppedTurn = {
      runIds: [turn.dshSessionId],
      startedAt: turn.startedAt,
      ...(turn.userMessageId ? { userMessageId: turn.userMessageId } : {}),
      traceId: turn.traceId,
    };
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStatus', sessionId, 'idle');
    this.emit('sessionStopped', sessionId, stopped);
  }

  stopAllSessions(): void {
    const ids = new Set([
      ...this.activeTurns.keys(),
      ...this.startingAbortControllers.keys(),
    ]);
    for (const sessionId of ids) {
      this.stopSession(sessionId);
    }
  }

  async respondToPermission(requestId: string, result: PermissionResult): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) return;
    this.pendingInteractions.delete(requestId);

    if (pending.kind === 'approval') {
      if (result.behavior === 'allow' && Array.isArray(result.updatedPermissions)) {
        for (const entry of result.updatedPermissions) {
          if (!entry || typeof entry !== 'object') continue;
          const record = entry as Record<string, unknown>;
          if (record.type === DshApprovalPermissionAction.AllowSession) {
            const scope = typeof record.scope === 'string' && record.scope.trim()
              ? record.scope.trim()
              : typeof pending.request.toolInput?.approvalScopeKey === 'string'
                ? pending.request.toolInput.approvalScopeKey
                : '';
            if (scope) {
              let set = this.sessionAllowedScopes.get(pending.coworkSessionId);
              if (!set) {
                set = new Set<string>();
                this.sessionAllowedScopes.set(pending.coworkSessionId, set);
              }
              set.add(scope);
            }
          } else if (record.type === DshApprovalPermissionAction.SetPermissionPreset) {
            const preset = parseDshPermissionPreset(record.preset);
            if (preset) {
              const explicitSessionId = typeof record.sessionId === 'string' && record.sessionId.trim()
                ? record.sessionId.trim()
                : undefined;
              const targetSessionId = record.global === true
                ? undefined
                : (explicitSessionId ?? pending.coworkSessionId);
              // Await preset persistence & host RPC BEFORE resolving the pending
              // approval so sibling/parallel tool calls in the same turn observe
              // the upgraded preset without racing.
              try {
                await this.setSessionPermissionPreset(preset, targetSessionId);
              } catch (error) {
                console.warn('[DshRuntimeAdapter] Failed to apply permission preset from approval response:', error);
              }
              try {
                await this.onPermissionPresetChanged?.(preset, targetSessionId);
              } catch (error) {
                console.warn('[DshRuntimeAdapter] Failed to notify permission preset change:', error);
              }
            }
          }
        }
      }
      const outcomeValue = result.behavior === 'allow' ? 'allowed-once' : 'rejected';
      pending.resolve({ kind: 'result', value: outcomeValue });
    } else if (result.behavior !== 'allow') {
      pending.resolve(cancelledInteraction(pending.kind));
    } else if (Array.isArray(result.updatedInput?.answers)) {
      pending.resolve({ kind: 'result', value: { answers: result.updatedInput.answers } });
    } else {
      pending.resolve({ kind: 'rejected', error: { name: 'UserQuestionError', code: 'BAD_ANSWER', message: 'Expected answers keyed by question ID.' } });
    }

    this.emit('permissionResolved', pending.coworkSessionId, requestId);
  }

  getPendingQuestions(): Array<PermissionRequest & { sessionId: string }> {
    return [...this.pendingInteractions.values()].map((item) => ({
      ...item.request,
      sessionId: item.coworkSessionId,
    }));
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  getActiveTurnSignal(sessionId: string): AbortSignal | undefined {
    return this.activeTurns.get(sessionId)?.abortController.signal;
  }

  getTurnRunIds(sessionId: string): string[] {
    const turn = this.activeTurns.get(sessionId);
    return turn ? [turn.dshSessionId] : [];
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.activeTurns.get(sessionId)?.confirmationMode ?? null;
  }

  onSessionDeleted(sessionId: string): void {
    this.stopSession(sessionId);
    this.lastCancelledTurnBySession.delete(sessionId);
    this.sessionAllowedScopes.delete(sessionId);
    this.sessionPermissionPresets.delete(sessionId);
    this.sessionUnlockedCapabilities.delete(sessionId);
    this.sessionThinkingLevels.delete(sessionId);
    this.sessionContextWindows.delete(sessionId);
    this.sessionResolvedContextTokens.delete(sessionId);
    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (dshSessionId) {
      this.dshToCoworkSession.delete(dshSessionId);
      void this.hostManager.deleteSessionFiles(dshSessionId).catch((): void => undefined);
    }
  }

  // ── Internal Turn & Stream Lifecycle ───────────────────────────────────────

  private async ensureReadyClient(): Promise<DshTypertClient> {
    if (!this.hostManager.isReady()) {
      await this.hostManager.start();
    }
    const client = this.hostManager.getClient();
    this.ensureClientWaterfallHandlers(client);
    return client;
  }

  private ensureClientWaterfallHandlers(client: DshTypertClient): void {
    if (this.wiredClient === client) return;
    for (const unwire of this.unwireClientHandlers) unwire();
    this.unwireClientHandlers = [];
    this.wiredClient = client;

    this.unwireClientHandlers.push(
      client.onWaterfall('approval/request', (evt) => this.handleHostWaterfall('approval', evt)),
      client.onWaterfall('user-questions/request', (evt) => this.handleHostWaterfall('user-questions', evt)),
    );

    if (typeof client.on === 'function' && typeof client.off === 'function') {
      const onGoalActivationChanged = (payload: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        const rec = payload as {
          sessionId?: unknown;
          goal?: { activation?: unknown };
        };
        if (typeof rec.sessionId !== 'string') return;
        const coworkSessionId = this.dshToCoworkSession.get(rec.sessionId);
        if (!coworkSessionId) return;
        const turn = this.activeTurns.get(coworkSessionId);
        if (!turn) return;
        if (rec.goal?.activation === 'armed') {
          turn.goalArmed = true;
        } else {
          turn.goalArmed = false;
          if (turn.waitingForNextGoalRound) {
            turn.waitingForNextGoalRound = false;
            turn.disarmedBetweenRounds = true;
            turn.abortController.abort(new Error('Goal disarmed between rounds'));
          }
        }
      };
      client.on('remote:goal/activation-changed', onGoalActivationChanged);
      this.unwireClientHandlers.push(() => {
        client.off('remote:goal/activation-changed', onGoalActivationChanged);
      });
    }
  }

  private handleHostWaterfall(
    kind: 'approval' | 'user-questions',
    evt: DshWaterfallEvent,
  ): Promise<DshWaterfallOutcome> {
    const coworkSessionId = this.dshToCoworkSession.get(evt.agentId)
      ?? this.subagentSessions?.getOwningSessionId(evt.agentId);
    if (!coworkSessionId) {
      return Promise.resolve({ kind: 'next' });
    }

    if (kind === 'approval' && this.activeTurns.get(coworkSessionId)?.autoApprove) {
      const callId = typeof evt.request.callId === 'string' ? evt.request.callId : null;
      if (callId) {
        this.hostManager.consumeApprovalCallContext?.(callId);
      }
      return Promise.resolve({ kind: 'result', value: 'allowed-once' });
    }

    const requestId = `${kind === 'approval' ? DSH_APPROVAL_REQUEST_ID_PREFIX : DSH_QUESTION_REQUEST_ID_PREFIX}${evt.eventId}`;
    const toolName = kind === 'approval'
      ? String(evt.request.toolName ?? 'tool')
      : ASK_USER_QUESTION_TOOL_NAME;
    const callId = typeof evt.request.callId === 'string' ? evt.request.callId : null;
    const toolInput = kind === 'approval'
      ? this.enrichApprovalToolInput(
          toolName,
          evt.request,
          callId,
          coworkSessionId,
        )
      : evt.request;
    const permissionRequest: PermissionRequest = {
      requestId,
      toolName,
      toolInput,
      toolUseId: callId,
    };

    return new Promise<DshWaterfallOutcome>((resolve) => {
      const pending: PendingInteraction = {
        requestId,
        coworkSessionId,
        dshSessionId: evt.agentId,
        kind,
        request: permissionRequest,
        resolve,
      };
      this.pendingInteractions.set(requestId, pending);

      const onAbort = () => {
        if (this.pendingInteractions.delete(requestId)) {
          resolve(cancelledInteraction(kind));
          this.emit('permissionResolved', coworkSessionId, requestId);
        }
      };
      evt.signal.addEventListener('abort', onAbort, { once: true });

      this.emit('permissionRequest', coworkSessionId, permissionRequest);
    });
  }

  private enrichApprovalToolInput(
    toolName: string,
    rawRequest: Record<string, unknown>,
    callId: string | null,
    coworkSessionId: string,
  ): Record<string, unknown> {
    const cached = callId ? this.hostManager.consumeApprovalCallContext?.(callId) ?? null : null;
    const rawArgs = cached?.args ?? {};
    const rawReason = typeof rawRequest.reason === 'string' ? rawRequest.reason.trim() : '';

    // Extract shell command from cached args first; fall back to parsing DSH/guard reason string.
    let command = extractShellCommandFromArgs(rawArgs).trim();
    if (!command && rawReason) {
      const reasonCmdMatch = /requires confirmation \([^)]+\):\s*([\s\S]+)$/i.exec(rawReason);
      if (reasonCmdMatch?.[1]) {
        command = reasonCmdMatch[1].trim();
      }
    }

    const description = (
      (typeof rawArgs.justification === 'string' && rawArgs.justification.trim())
      || (typeof rawArgs.description === 'string' && rawArgs.description.trim())
      || ''
    );
    const filePath = (
      (typeof rawArgs.file_path === 'string' && rawArgs.file_path.trim())
      || (typeof rawArgs.path === 'string' && rawArgs.path.trim())
      || (typeof rawArgs.target_path === 'string' && rawArgs.target_path.trim())
      || ''
    );
    const workdir = (
      (typeof rawArgs.workdir === 'string' && rawArgs.workdir.trim())
      || (typeof rawArgs.cwd === 'string' && rawArgs.cwd.trim())
      || ''
    );
    const sandboxPermissions = typeof rawArgs.sandbox_permissions === 'string'
      ? rawArgs.sandbox_permissions.trim()
      : '';

    const danger = command ? getCommandDangerLevel(command) : { level: 'safe' as const, reason: '' };
    let dangerReason = danger.reason;
    if (!dangerReason && rawReason) {
      const parsedReason = /requires confirmation \(([^)]+)\)/i.exec(rawReason);
      if (parsedReason?.[1]) {
        dangerReason = parsedReason[1].trim();
      }
    }
    const dangerLevel = danger.level !== 'safe'
      ? danger.level
      : (rawReason.toLowerCase().startsWith('destructive command')
        ? 'destructive'
        : rawReason.toLowerCase().startsWith('potentially dangerous')
          ? 'caution'
          : 'safe');

    const approvalScopeKey = buildApprovalScopeKey(toolName, rawArgs, dangerReason);
    const permissionPreset = cached?.permissionPreset ?? this.getEffectivePermissionPreset(coworkSessionId);

    return {
      ...rawRequest,
      ...rawArgs,
      ...(command ? { command } : {}),
      ...(description ? { description } : {}),
      ...(filePath ? { filePath } : {}),
      ...(workdir ? { workdir } : {}),
      ...(sandboxPermissions ? { sandboxPermissions } : {}),
      ...(rawReason ? { reason: rawReason } : {}),
      dangerLevel,
      ...(dangerReason ? { dangerReason } : {}),
      approvalScopeKey,
      permissionPreset,
    };
  }

  private cancelPendingInteractionsForSession(coworkSessionId: string): void {
    for (const [requestId, pending] of [...this.pendingInteractions.entries()]) {
      if (pending.coworkSessionId !== coworkSessionId) continue;
      this.pendingInteractions.delete(requestId);
      pending.resolve(cancelledInteraction(pending.kind));
      this.emit('permissionResolved', coworkSessionId, requestId);
    }
  }

  private safeGetSessionProjections(
    client: Pick<DshTypertClient, 'getSessionProjections'>,
    dshSessionId: string,
  ): Promise<Record<string, unknown> | null> {
    if (typeof client.getSessionProjections !== 'function') {
      return Promise.resolve(null);
    }
    return client.getSessionProjections(dshSessionId).catch((): null => null);
  }

  private resolveExistingDshSessionId(coworkSessionId: string): string | null {
    const active = this.activeTurns.get(coworkSessionId);
    if (active) return active.dshSessionId;
    const session = this.store.getSession(coworkSessionId);
    if (session && isDshBackedSessionId(session.claudeSessionId)) {
      return stripDshSessionPrefix(session.claudeSessionId!);
    }
    return null;
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    params: {
      isContinue: boolean;
      requestId?: string;
      onAccepted?: () => void;
      skipInitialUserMessage?: boolean;
      userMessageContent?: string;
      skillIds?: string[];
      messageSkillIds?: string[];
      selectedTextSnippets?: CoworkStartOptions['selectedTextSnippets'];
      browserAnnotations?: CoworkStartOptions['browserAnnotations'];
      systemPrompt?: string;
      confirmationMode: 'modal' | 'text';
      autoApprove?: boolean;
      imageAttachments?: CoworkStartOptions['imageAttachments'];
      mediaInstruction?: string;
      localMediaAttachments?: CoworkStartOptions['localMediaAttachments'];
      agentId?: string;
      workspaceRoot?: string;
    },
  ): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Cowork session "${sessionId}" not found`);
    }

    const abortController = new AbortController();
    const prevStartingAbort = this.startingAbortControllers.get(sessionId);
    if (prevStartingAbort) {
      prevStartingAbort.abort(new Error('Replaced by newer turn'));
    }
    this.startingAbortControllers.set(sessionId, abortController);
    const clearStartingAbort = () => {
      if (this.startingAbortControllers.get(sessionId) === abortController) {
        this.startingAbortControllers.delete(sessionId);
      }
    };

    try {
      const pendingCancel = this.pendingCancels.get(sessionId);
      const hadPriorCancel = Boolean(pendingCancel);
      if (pendingCancel) {
        await pendingCancel;
      }
      if (abortController.signal.aborted) return;

      const client = await this.ensureReadyClient();
      if (abortController.signal.aborted) return;

      // Capture pre-existing messages BEFORE persisting the new prompt so fresh
      // sessions are never mistaken for migrated OpenClaw sessions. When the caller
      // already saved the current turn's initial user message (`skipInitialUserMessage`),
      // exclude that trailing message from prior history.
      const rawSessionMessages = [...(session.messages ?? [])];
      const priorMessages = params.skipInitialUserMessage && rawSessionMessages.at(-1)?.type === 'user'
        ? rawSessionMessages.slice(0, -1)
        : rawSessionMessages;

      // Create the per-turn W3C trace ID used by OpenClawTokenProxy and
      // CoworkTurnUsageService to correlate every LLM request and settle credits.
      const llmTrace = createCoworkLlmTrace();
      let turnUserMessage: CoworkMessage | null = null;

      const persistedContent = params.userMessageContent !== undefined
        ? params.userMessageContent
        : prompt;
      const localMediaAttachments = params.localMediaAttachments?.length
        ? params.localMediaAttachments
        : undefined;
      const selectedTextSnippets = params.selectedTextSnippets?.length
        ? params.selectedTextSnippets
        : undefined;
      const browserAnnotations = params.browserAnnotations?.length
        ? params.browserAnnotations
        : undefined;
      const imageAttachmentPreviews = !localMediaAttachments && params.imageAttachments?.length
        ? buildCoworkImageAttachmentPreviews(params.imageAttachments)
        : undefined;
      const hasPersistableUserMessage = persistedContent.trim().length > 0
        || Boolean(localMediaAttachments?.length)
        || Boolean(imageAttachmentPreviews?.length)
        || Boolean(selectedTextSnippets?.length)
        || Boolean(browserAnnotations?.length);

      if (!params.skipInitialUserMessage && hasPersistableUserMessage) {
        const userMetadata: Record<string, unknown> = {
          llmTrace,
          ...(localMediaAttachments ? { localMediaAttachments } : {}),
          ...(imageAttachmentPreviews ? { imageAttachmentPreviews } : {}),
          ...(selectedTextSnippets ? { selectedTextSnippets } : {}),
          ...(browserAnnotations ? { browserAnnotations } : {}),
        };
        turnUserMessage = this.store.addMessage(sessionId, {
          type: 'user',
          content: persistedContent,
          metadata: userMetadata,
        });
        this.emit('message', sessionId, turnUserMessage);
      } else {
        turnUserMessage = this.store.getLatestUserMessage?.(sessionId)
          ?? [...rawSessionMessages].reverse().find((m) => m.type === 'user')
          ?? null;
        if (turnUserMessage) {
          const mergedMetadata: Record<string, unknown> = {
            ...(turnUserMessage.metadata ?? {}),
            llmTrace,
          };
          this.store.updateMessageContent(sessionId, turnUserMessage.id, turnUserMessage.content, mergedMetadata);
          turnUserMessage = { ...turnUserMessage, metadata: mergedMetadata };
        }
      }

      // Resolve the target model before registering usage context so preset /
      // resolvedModelId headers and DSH selectModel stay completely aligned.
      const modelSelection = this.resolveModelSelection
        ? await this.resolveModelSelection(sessionId, session.modelOverride)
        : (session.modelOverride ? parseProviderModelRef(session.modelOverride) : null);
      if (abortController.signal.aborted) return;

      const latestSessionMeta = this.store.getSession(sessionId, 0);
      const effectiveModelPresetId =
        turnUserMessage?.metadata?.modelPresetId
        ?? modelSelection?.modelPresetId
        ?? latestSessionMeta?.modelPresetId
        ?? session.modelPresetId
        ?? undefined;
      const effectiveResolvedModelId =
        (typeof turnUserMessage?.metadata?.resolvedModelId === 'string'
          && turnUserMessage.metadata.resolvedModelId.trim()
          ? turnUserMessage.metadata.resolvedModelId
          : undefined)
        ?? modelSelection?.model;

      // Persist resolved preset attribution onto the turn's user message so
      // `llmUsageContext` recovery and `x-lobster-model-preset` stay aligned.
      if (
        turnUserMessage
        && (
          (effectiveModelPresetId && !turnUserMessage.metadata?.modelPresetId)
          || (effectiveResolvedModelId && !turnUserMessage.metadata?.resolvedModelId)
        )
      ) {
        const attributedMetadata: Record<string, unknown> = {
          ...(turnUserMessage.metadata ?? {}),
          ...(effectiveModelPresetId ? { modelPresetId: effectiveModelPresetId } : {}),
          ...(effectiveResolvedModelId ? { resolvedModelId: effectiveResolvedModelId } : {}),
        };
        this.store.updateMessageContent(sessionId, turnUserMessage.id, turnUserMessage.content, attributedMetadata);
        turnUserMessage = { ...turnUserMessage, metadata: attributedMetadata };
      }

      registerLlmUsageContext(llmTrace.traceId, sessionId, prompt, {
        title: session.title,
        modelPresetId: effectiveModelPresetId,
        resolvedModelId: effectiveResolvedModelId,
      });

      // Create or reuse DSH session, applying Lazy Context Bridge when upgrading
      // a legacy OpenClaw session for the first time.
      const existingDshSessionId = this.resolveExistingDshSessionId(sessionId);
      let dshSessionId = existingDshSessionId;
      let lazyBridgePrefix = '';
      if (!dshSessionId) {
        const created = await client.createSession({
          cwd: params.workspaceRoot || session.cwd,
        });
        if (abortController.signal.aborted) return;
        dshSessionId = created.sessionId;
        this.store.updateSession(sessionId, {
          claudeSessionId: formatStoredDshSessionId(dshSessionId),
        });

        const hasLegacyHistory = Boolean(
          priorMessages.length > 0
          || session.goal
          || (session.claudeSessionId && !isDshBackedSessionId(session.claudeSessionId)),
        );
        if (hasLegacyHistory) {
          const capsule = this.store.getContinuityCapsule?.(sessionId) ?? null;
          lazyBridgePrefix = buildLazyContextBridgePrefix(capsule, priorMessages, session.goal);
        }
      }

      this.dshToCoworkSession.set(dshSessionId, sessionId);

      const goalPrompt = isGoalCommandPrompt(prompt);
      const baseSystemPrompt = params.systemPrompt ?? session.systemPrompt ?? '';
      const boundCustomSystemPrompt = goalPrompt && lazyBridgePrefix
        ? [baseSystemPrompt, lazyBridgePrefix].filter((part) => part.trim().length > 0).join('\n\n')
        : baseSystemPrompt;

      // Bind LobsterAI session context (agent persona, skills filter, executionMode,
      // per-session contextWindow override, turn traceId). Always pass explicit
      // `customSystemPrompt` (including `''`) so turning off Plan Mode clears the
      // previous turn's `# Plan Mode` system prompt in `ops-rpc.mjs`.
      const agentId = params.agentId || session.agentId || 'main';
      const allowedSkillIds = this.resolveAllowedSkillIds
        ? this.resolveAllowedSkillIds(sessionId, agentId, params.skillIds)
        : params.skillIds ?? null;
      const turnUnlockedCapabilities = resolveUnlockedCapabilitiesForTurn({
        messageSkillIds: params.messageSkillIds,
        browserAnnotations: params.browserAnnotations,
        selectedTextSnippets: params.selectedTextSnippets,
        prompt,
        localMediaAttachments: params.localMediaAttachments,
        lazyBridgePrefix,
      });
      if (turnUnlockedCapabilities.length > 0) {
        let sessionSet = this.sessionUnlockedCapabilities.get(sessionId);
        if (!sessionSet) {
          sessionSet = new Set<DshProgressiveCapability>();
          this.sessionUnlockedCapabilities.set(sessionId, sessionSet);
        }
        for (const cap of turnUnlockedCapabilities) {
          sessionSet.add(cap);
        }
      }
      const unlockedCapabilities = [...(this.sessionUnlockedCapabilities.get(sessionId) ?? [])];
      const officeAgentPrompt = resolveOfficeAgentPromptForTurn(unlockedCapabilities);

      const patchedContextWindow = this.sessionContextWindows.get(sessionId);
      const effectivePresetId = parseModelPresetId(effectiveModelPresetId);
      const persistedContextWindowOverride =
        typeof (latestSessionMeta?.contextWindowOverride ?? session.contextWindowOverride) === 'number'
        && (latestSessionMeta?.contextWindowOverride ?? session.contextWindowOverride)! > 0
          ? (latestSessionMeta?.contextWindowOverride ?? session.contextWindowOverride)!
          : null;
      const contextWindowSelection = patchedContextWindow !== undefined
        ? patchedContextWindow
        : (!persistedContextWindowOverride && effectivePresetId
          ? modelPresetModelId(effectivePresetId)
          : undefined);
      const contextWindowOverride = patchedContextWindow !== undefined
        ? parseContextWindowSelectionTokens(patchedContextWindow)
        : (persistedContextWindowOverride
          ?? (typeof modelSelection?.contextWindow === 'number' && modelSelection.contextWindow > 0
            ? modelSelection.contextWindow
            : undefined));
      if (typeof contextWindowOverride === 'number' && contextWindowOverride > 0) {
        this.sessionResolvedContextTokens.set(sessionId, contextWindowOverride);
      } else if (contextWindowOverride === null) {
        this.sessionResolvedContextTokens.delete(sessionId);
      }

      const explicitPermissionPreset = this.getExplicitPermissionPreset(sessionId);
      const effectivePermissionPreset = params.autoApprove
        ? DshPermissionPreset.FullAccess
        : (explicitPermissionPreset ?? this.getEffectivePermissionPreset(sessionId));

      const contextPayload: DshHostSessionContext = {
        sessionId: dshSessionId,
        agentId,
        coworkSessionId: sessionId,
        traceId: llmTrace.traceId,
        workspaceDir: params.workspaceRoot || session.cwd,
        allowedSkillIds,
        customSystemPrompt: boundCustomSystemPrompt,
        ...(officeAgentPrompt ? { officeAgentPrompt } : {}),
        ...(session.executionMode ? { executionMode: session.executionMode } : {}),
        permissionPreset: effectivePermissionPreset,
        ...(!params.autoApprove && explicitPermissionPreset ? { permissionPresetExplicit: true } : {}),
        ...(unlockedCapabilities.length > 0 ? { unlockedCapabilities } : {}),
        ...(contextWindowSelection !== undefined ? { contextWindowSelection } : {}),
        ...(contextWindowOverride !== undefined ? { contextWindowOverride } : {}),
      };
      await this.hostManager.bindSessionContext(contextPayload);
      if (abortController.signal.aborted) return;

      // Ensure session uses the resolved LobsterAI model AND preserves the
      // user's thinkingLevel -> reasoningEffort across Turn 1, Turn 2, ...
      if (modelSelection) {
        const persistedThinking = typeof (latestSessionMeta?.thinkingLevel ?? session.thinkingLevel) === 'string'
          ? (latestSessionMeta?.thinkingLevel ?? session.thinkingLevel)!.trim()
          : '';
        const resolverHandlesThinking = Boolean(
          this.resolveModelSelection && this.resolveModelSelection.length >= 3,
        );
        const resolvedEffort = resolverHandlesThinking
          ? modelSelection.reasoningEffort
          : (modelSelection.reasoningEffort
            ?? this.sessionThinkingLevels.get(sessionId)
            ?? (persistedThinking || undefined));
        await selectModelWithReasoningFallback(client, {
          sessionId: dshSessionId,
          provider: canonicalizeDshProviderId(modelSelection.provider),
          model: modelSelection.model,
          reasoningEffort: resolvedEffort,
        });
        if (abortController.signal.aborted) return;
      }

      // Cancel any previous turn watcher on this session before starting a fresh one.
      const prevTurn = this.activeTurns.get(sessionId);
      if (prevTurn) {
        prevTurn.abortController.abort(new Error('Replaced by newer turn'));
      }

      const { hadRecentCancel, cancelledTurnNumber } = this.consumeRecentCancelState(
        sessionId,
        dshSessionId,
        hadPriorCancel,
      );

      if (goalPrompt) {
        const existingProjections = existingDshSessionId
          ? await this.safeGetSessionProjections(client, dshSessionId)
          : null;
        const currentDshGoal = extractGoalFromProjections(existingProjections);
        const translated = translateLobsterGoalCommandToDsh(prompt, currentDshGoal);
        const submittedAttachments = buildCommandSubmitAttachments(params.imageAttachments);
        const startsGoalTurn =
          translated.kind === DshGoalCommandKind.Create
          || translated.kind === DshGoalCommandKind.Resume;

        if (!startsGoalTurn) {
          clearStartingAbort();
          const execution = await client.executeCommand({
            agentId: dshSessionId,
            line: translated.line,
            submittedAttachments,
          });
          if (!execution || execution.result.kind === 'error') {
            const msg = execution?.result.text ?? `DSH did not recognize goal command "${translated.line}"`;
            this.store.updateSession(sessionId, { status: 'error' });
            this.emit('sessionStatus', sessionId, 'error');
            this.emit('error', sessionId, msg);
            throw new Error(msg);
          }
          params.onAccepted?.();
          const projections = await this.safeGetSessionProjections(client, dshSessionId);
          const goal = extractGoalFromProjections(projections);
          this.store.updateSession(sessionId, { goal, status: 'completed' });
          this.emit('goalUpdate', sessionId, goal);
          this.emit('sessionStatus', sessionId, 'completed');
          this.emit('complete', sessionId, formatStoredDshSessionId(dshSessionId));
          return;
        }

        const turn = this.createActiveTurnState({
          coworkSessionId: sessionId,
          dshSessionId,
          requestId: params.requestId,
          userMessageId: turnUserMessage?.id,
          traceId: llmTrace.traceId,
          abortController,
          confirmationMode: params.confirmationMode,
          autoApprove: Boolean(params.autoApprove),
          ignoreStaleAbortedTurnEnd: hadRecentCancel,
          cancelledDshTurnNumber: cancelledTurnNumber,
          goalArmed: true,
          currentGoal: currentDshGoal,
        });
        clearStartingAbort();
        this.activeTurns.set(sessionId, turn);

        this.store.updateSession(sessionId, { status: 'running' });
        this.emit('sessionStatus', sessionId, 'running');

        const followStream = client.followSession<Record<string, unknown>>(
          {
            address: { kind: 'session', sessionId: dshSessionId },
            assistantStream: true,
            activate: true,
          },
          abortController.signal,
        );
        const streamTask = this.consumeFollowStream(turn, followStream);

        try {
          const execution = await client.executeCommand({
            agentId: dshSessionId,
            line: translated.line,
            submittedAttachments,
          });
          if (!execution || execution.result.kind === 'error') {
            throw new Error(execution?.result.text ?? `DSH did not recognize goal command "${translated.line}"`);
          }
          params.onAccepted?.();
        } catch (error) {
          abortController.abort(error);
          if (this.activeTurns.get(sessionId) === turn) {
            this.activeTurns.delete(sessionId);
          }
          const msg = error instanceof Error ? error.message : String(error);
          this.store.updateSession(sessionId, { status: 'error' });
          this.emit('sessionStatus', sessionId, 'error');
          this.emit('error', sessionId, msg);
          throw error;
        }

        const projections = await this.safeGetSessionProjections(client, dshSessionId);
        const projectedGoal = extractGoalFromProjections(projections);
        const goal = projectedGoal ?? turn.currentGoal;
        turn.currentGoal = goal;
        this.store.updateSession(sessionId, { goal });
        this.emit('goalUpdate', sessionId, goal);

        await streamTask;
        return;
      }

      const requestId = params.requestId || randomUUID();
      const turn = this.createActiveTurnState({
        coworkSessionId: sessionId,
        dshSessionId,
        requestId,
        userMessageId: turnUserMessage?.id,
        traceId: llmTrace.traceId,
        abortController,
        confirmationMode: params.confirmationMode,
        autoApprove: Boolean(params.autoApprove),
        ignoreStaleAbortedTurnEnd: hadRecentCancel,
        cancelledDshTurnNumber: cancelledTurnNumber,
        goalArmed: false,
        currentGoal: session.goal ?? null,
      });
      clearStartingAbort();
      this.activeTurns.set(sessionId, turn);

      this.store.updateSession(sessionId, { status: 'running' });
      this.emit('sessionStatus', sessionId, 'running');

      // Open `session/follow` stream BEFORE calling `session/prompt` so zero
      // live tokens or tool events are ever missed.
      const followStream = client.followSession<Record<string, unknown>>(
        {
          address: { kind: 'session', sessionId: dshSessionId },
          assistantStream: true,
          activate: true,
        },
        abortController.signal,
      );

      const selectedTextSection = buildSelectedTextPromptSection(params.selectedTextSnippets);
      const preparedBrowser = prepareBrowserAnnotationsForPrompt(
        sessionId,
        params.browserAnnotations,
        params.imageAttachments,
        this.readBrowserAnnotationAsset,
      );
      const turnPrefix = [
        lazyBridgePrefix,
        params.mediaInstruction,
        selectedTextSection,
        preparedBrowser.browserAnnotationSection,
      ].filter(Boolean).join('\n\n');
      const contentParts = buildPromptContentParts(prompt, turnPrefix, preparedBrowser.imageAttachments);
      const streamTask = this.consumeFollowStream(turn, followStream);

      const clientTimeZone = resolveLocalTimeZone();
      try {
        await client.promptSession({
          sessionId: dshSessionId,
          requestId,
          content: contentParts,
          mode: 'queue',
          ...(clientTimeZone ? { clientTimeZone } : {}),
        });
        params.onAccepted?.();
      } catch (error) {
        abortController.abort(error);
        this.activeTurns.delete(sessionId);
        const msg = error instanceof Error ? error.message : String(error);
        this.store.updateSession(sessionId, { status: 'error' });
        this.emit('sessionStatus', sessionId, 'error');
        this.emit('error', sessionId, msg);
        throw error;
      }

      await streamTask;
    } finally {
      clearStartingAbort();
    }
  }

  private createActiveTurnState(params: {
    coworkSessionId: string;
    dshSessionId: string;
    requestId?: string;
    userMessageId?: string;
    traceId: string;
    abortController: AbortController;
    confirmationMode: 'modal' | 'text';
    autoApprove?: boolean;
    ignoreStaleAbortedTurnEnd: boolean;
    cancelledDshTurnNumber: number | null;
    goalArmed: boolean;
    currentGoal: CoworkGoal | null;
  }): ActiveTurnState {
    return {
      coworkSessionId: params.coworkSessionId,
      dshSessionId: params.dshSessionId,
      requestId: params.requestId,
      userMessageId: params.userMessageId,
      traceId: params.traceId,
      abortController: params.abortController,
      confirmationMode: params.confirmationMode,
      autoApprove: Boolean(params.autoApprove),
      startedAt: Date.now(),
      currentThinkingMessageId: null,
      currentThinkingText: '',
      attemptThinkingMessageId: null,
      reusableThinkingMessageId: null,
      lastFinalizedThinkingMessageId: null,
      lastFinalizedThinkingText: '',
      currentAssistantMessageId: null,
      currentAssistantText: '',
      attemptAssistantMessageId: null,
      reusableAssistantMessageId: null,
      lastFinalizedAssistantMessageId: null,
      lastFinalizedAssistantText: '',
      suppressedPreSteerAssistantText: null,
      lastCommittedAssistantSeq: null,
      toolCallMessageIds: new Map(),
      subagentIdsByName: new Map(),
      subagentTasksByCall: new Map(),
      pendingSubagentResults: new Set(),
      currentDshTurnNumber: null,
      cancelledDshTurnNumber: params.cancelledDshTurnNumber,
      goalArmed: params.goalArmed,
      waitingForNextGoalRound: false,
      disarmedBetweenRounds: false,
      currentGoal: params.currentGoal,
      turnCompleted: false,
      turnError: null,
      turnAborted: false,
      ignoreStaleAbortedTurnEnd: params.ignoreStaleAbortedTurnEnd,
      pendingContextUsageRefresh: null,
    };
  }

  private consumeRecentCancelState(
    sessionId: string,
    dshSessionId: string,
    hadPendingCancel: boolean,
  ): { hadRecentCancel: boolean; cancelledTurnNumber: number | null } {
    const lastCancel = this.lastCancelledTurnBySession.get(sessionId);
    this.lastCancelledTurnBySession.delete(sessionId);
    const matchesRecentCancel = Boolean(
      lastCancel
      && lastCancel.dshSessionId === dshSessionId
      && (Date.now() - lastCancel.cancelledAt) < CANCEL_GRACE_WINDOW_MS,
    );
    return {
      hadRecentCancel: hadPendingCancel || matchesRecentCancel,
      cancelledTurnNumber: matchesRecentCancel ? (lastCancel?.lastSeenTurnNumber ?? null) : null,
    };
  }

  private flushTurnBuffersForSteer(turn: ActiveTurnState): void {
    const flushedAssistantText = turn.currentAssistantMessageId ? turn.currentAssistantText : '';
    this.finalizeActiveThinkingMessage(turn);
    this.finalizeActiveAssistantMessage(turn);
    this.discardReusableMessages(turn);
    turn.attemptThinkingMessageId = null;
    turn.attemptAssistantMessageId = null;
    turn.lastFinalizedThinkingMessageId = null;
    turn.lastFinalizedThinkingText = '';
    turn.lastFinalizedAssistantMessageId = null;
    turn.lastFinalizedAssistantText = '';
    turn.lastCommittedAssistantSeq = null;
    if (flushedAssistantText) {
      turn.suppressedPreSteerAssistantText = flushedAssistantText;
    }
  }

  private attachFollowWatcherForWokenTurn(
    client: DshTypertClient,
    sessionId: string,
    dshSessionId: string,
    userMessageId: string,
    requestId: string,
  ): void {
    const abortController = new AbortController();
    const session = this.store.getSession(sessionId);
    const turn = this.createActiveTurnState({
      coworkSessionId: sessionId,
      dshSessionId,
      requestId,
      userMessageId,
      traceId: createCoworkLlmTrace().traceId,
      abortController,
      confirmationMode: 'modal',
      ignoreStaleAbortedTurnEnd: false,
      cancelledDshTurnNumber: null,
      goalArmed: false,
      currentGoal: session?.goal ?? null,
    });
    this.activeTurns.set(sessionId, turn);
    this.store.updateSession(sessionId, { status: 'running' });
    this.emit('sessionStatus', sessionId, 'running');
    const followStream = client.followSession<Record<string, unknown>>(
      {
        address: { kind: 'session', sessionId: dshSessionId },
        assistantStream: true,
        activate: true,
      },
      abortController.signal,
    );
    void this.consumeFollowStream(turn, followStream);
  }

  private async consumeFollowStream(
    turn: ActiveTurnState,
    stream: AsyncGenerator<Record<string, unknown>, void, void>,
  ): Promise<void> {
    const { coworkSessionId, dshSessionId } = turn;
    try {
      for await (const frame of stream) {
        if (turn.abortController.signal.aborted) break;
        const done = this.handleFollowFrame(turn, frame);
        if (done) {
          turn.turnCompleted = true;
          break;
        }
      }

      if (turn.abortController.signal.aborted && !turn.disarmedBetweenRounds) return;

      this.finalizeActiveThinkingMessage(turn);
      this.finalizeActiveAssistantMessage(turn);
      this.discardReusableMessages(turn);
      if (this.activeTurns.get(coworkSessionId) === turn) {
        this.activeTurns.delete(coworkSessionId);
      }
      if (turn.turnError) {
        this.store.updateSession(coworkSessionId, { status: 'error' });
        this.emit('sessionStatus', coworkSessionId, 'error');
        this.emit('error', coworkSessionId, turn.turnError);
        return;
      }
      if (turn.turnAborted) {
        this.store.updateSession(coworkSessionId, { status: 'idle' });
        this.emit('sessionStatus', coworkSessionId, 'idle');
        this.emit('sessionStopped', coworkSessionId, {
          runIds: [dshSessionId],
          startedAt: turn.startedAt,
          ...(turn.userMessageId ? { userMessageId: turn.userMessageId } : {}),
          traceId: turn.traceId,
        });
        return;
      }
      await (turn.pendingContextUsageRefresh ?? this.refreshAndEmitContextUsage(coworkSessionId));
      this.store.updateSession(coworkSessionId, { status: 'completed' });
      this.emit('sessionStatus', coworkSessionId, 'completed');
      this.emit('complete', coworkSessionId, formatStoredDshSessionId(dshSessionId));
    } catch (error) {
      if (turn.abortController.signal.aborted && !turn.disarmedBetweenRounds) return;
      if (turn.disarmedBetweenRounds) {
        this.finalizeActiveThinkingMessage(turn);
        this.finalizeActiveAssistantMessage(turn);
        this.discardReusableMessages(turn);
        if (this.activeTurns.get(coworkSessionId) === turn) {
          this.activeTurns.delete(coworkSessionId);
        }
        this.store.updateSession(coworkSessionId, { status: 'completed' });
        this.emit('sessionStatus', coworkSessionId, 'completed');
        this.emit('complete', coworkSessionId, formatStoredDshSessionId(dshSessionId));
        return;
      }
      this.discardReusableMessages(turn);
      if (this.activeTurns.get(coworkSessionId) === turn) {
        this.activeTurns.delete(coworkSessionId);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateSession(coworkSessionId, { status: 'error' });
      this.emit('sessionStatus', coworkSessionId, 'error');
      this.emit('error', coworkSessionId, message);
    }
  }

  /**
   * Process one frame from `session/follow`. Returns `true` when the turn ends.
   */
  private handleFollowFrame(
    turn: ActiveTurnState,
    frame: Record<string, unknown>,
  ): boolean {
    const { coworkSessionId } = turn;

    if (frame.type === 'assistant-stream') {
      const inner = frame.frame as Record<string, unknown> | undefined;
      if (!inner || typeof inner !== 'object') return false;
      const streamTurnNumber = typeof inner.turn === 'number' ? inner.turn : null;
      if (
        turn.ignoreStaleAbortedTurnEnd
        && streamTurnNumber !== null
        && turn.cancelledDshTurnNumber !== null
        && streamTurnNumber <= turn.cancelledDshTurnNumber
      ) {
        return false;
      }
      if (streamTurnNumber !== null) {
        turn.currentDshTurnNumber = streamTurnNumber;
      }
      turn.ignoreStaleAbortedTurnEnd = false;
      turn.waitingForNextGoalRound = false;

      if (inner.type === 'start') {
        turn.suppressedPreSteerAssistantText = null;
        // Lazily create thinking/assistant rows when actual deltas arrive so
        // tool-only steps and failed retry attempts never leave empty rows.
        return false;
      }

      if (inner.type === 'chunk') {
        turn.suppressedPreSteerAssistantText = null;
        const chunk = inner.chunk as Record<string, unknown> | undefined;
        if (!chunk) return false;
        const deltaText = extractStreamChunkDelta(chunk);
        if (chunk.type === 'text-delta' && deltaText) {
          if (turn.currentThinkingMessageId) {
            this.finalizeActiveThinkingMessage(turn);
          }
          const msgId = this.ensureAssistantMessage(turn);
          turn.currentAssistantText += deltaText;
          const meta = { isStreaming: true };
          this.store.updateMessageContent(coworkSessionId, msgId, turn.currentAssistantText, meta);
          this.emit('messageUpdate', coworkSessionId, msgId, turn.currentAssistantText, meta);
        } else if (
          (chunk.type === 'reasoning-delta' || chunk.type === 'thinking-delta')
          && deltaText
        ) {
          const msgId = this.ensureThinkingMessage(turn);
          turn.currentThinkingText += deltaText;
          const meta = { isThinking: true, isStreaming: true };
          this.store.updateMessageContent(coworkSessionId, msgId, turn.currentThinkingText, meta);
          this.emit('messageUpdate', coworkSessionId, msgId, turn.currentThinkingText, meta);
        }
      }

      if (inner.type === 'end') {
        if (isFailedAssistantStreamOutcome(inner.outcome)) {
          this.resetAttemptMessagesForRetry(turn);
          return false;
        }
        const outcome = inner.outcome as { seq?: unknown } | undefined;
        const seq = typeof outcome?.seq === 'number' ? outcome.seq : undefined;
        this.finalizeActiveThinkingMessage(turn, seq);
        this.finalizeActiveAssistantMessage(turn, seq);
        this.discardReusableMessages(turn);
        turn.attemptThinkingMessageId = null;
        turn.attemptAssistantMessageId = null;
        turn.lastCommittedAssistantSeq = seq ?? null;
      }
      return false;
    }

    if (frame.type === 'event' || (typeof frame.type === 'string' && frame.type.includes('/'))) {
      const ev = (frame.type === 'event' ? frame.event : frame) as Record<string, unknown> | undefined;
      if (!ev || typeof ev !== 'object') return false;
      const evType = typeof ev.type === 'string' ? ev.type : '';
      const data = (ev.data as Record<string, unknown> | undefined) ?? {};
      const eventTurnNumber = typeof data.turn === 'number' ? data.turn : null;

      if (evType === 'goal/change') {
        const op = typeof data.operation === 'string' ? data.operation : '';
        const updatedGoal = extractGoalFromDshPayload(data);
        turn.currentGoal = updatedGoal;
        this.store.updateSession(coworkSessionId, { goal: updatedGoal });
        this.emit('goalUpdate', coworkSessionId, updatedGoal);

        if (op === DshGoalOperation.Create || op === DshGoalOperation.Resume) {
          turn.goalArmed = true;
        } else if (
          op === DshGoalOperation.Pause
          || op === DshGoalOperation.Complete
          || op === DshGoalOperation.Block
          || op === DshGoalOperation.Clear
        ) {
          turn.goalArmed = false;
          if (turn.waitingForNextGoalRound) {
            turn.waitingForNextGoalRound = false;
            if (op === DshGoalOperation.Pause) {
              turn.turnAborted = true;
            }
            return true;
          }
        }
        return false;
      }

      if (evType === DshChildEvent.Catalog) {
        const id = this.subagentSessions?.observeCatalog(coworkSessionId, data);
        if (id && typeof data.name === 'string') turn.subagentIdsByName.set(data.name, id);
        return false;
      }
      if (evType === DshChildEvent.User) {
        turn.suppressedPreSteerAssistantText = null;
        const source = record(data.source);
        if (source.kind === 'goal') {
          turn.waitingForNextGoalRound = false;
          turn.ignoreStaleAbortedTurnEnd = false;
          if (typeof source.round === 'number' && turn.currentGoal) {
            const updatedGoal: CoworkGoal = {
              ...turn.currentGoal,
              continuationTurns: source.round,
              updatedAt: Date.now(),
            };
            turn.currentGoal = updatedGoal;
            this.store.updateSession(coworkSessionId, { goal: updatedGoal });
            this.emit('goalUpdate', coworkSessionId, updatedGoal);
          }
        } else if (
          !turn.ignoreStaleAbortedTurnEnd
          || (turn.requestId && source.rpcId === turn.requestId)
          || source.kind === DshChildEvent.Settled
        ) {
          turn.ignoreStaleAbortedTurnEnd = false;
        }
        this.subagentSessions?.observeNotice(coworkSessionId, data, ev.time);
        if (source.kind === DshChildEvent.Settled && typeof source.senderSessionId === 'string') {
          turn.pendingSubagentResults.delete(formatStoredDshSessionId(source.senderSessionId));
        }
        return false;
      }

      if (evType === 'turn/start') {
        if (eventTurnNumber !== null) {
          turn.currentDshTurnNumber = eventTurnNumber;
          if (turn.cancelledDshTurnNumber === null || eventTurnNumber > turn.cancelledDshTurnNumber) {
            turn.ignoreStaleAbortedTurnEnd = false;
          }
        } else {
          turn.ignoreStaleAbortedTurnEnd = false;
        }
        turn.waitingForNextGoalRound = false;
        turn.lastFinalizedThinkingMessageId = null;
        turn.lastFinalizedThinkingText = '';
        turn.lastFinalizedAssistantMessageId = null;
        turn.lastFinalizedAssistantText = '';
        turn.lastCommittedAssistantSeq = null;
        return false;
      }

      if (evType === 'tool/call') {
        if (
          turn.ignoreStaleAbortedTurnEnd
          && eventTurnNumber !== null
          && turn.cancelledDshTurnNumber !== null
          && eventTurnNumber <= turn.cancelledDshTurnNumber
        ) {
          return false;
        }
        turn.ignoreStaleAbortedTurnEnd = false;
        turn.waitingForNextGoalRound = false;
        turn.suppressedPreSteerAssistantText = null;
        this.finalizeActiveThinkingMessage(turn);
        this.finalizeActiveAssistantMessage(turn);
        this.discardReusableMessages(turn);
        turn.attemptThinkingMessageId = null;
        turn.attemptAssistantMessageId = null;
        turn.lastFinalizedThinkingMessageId = null;
        turn.lastFinalizedThinkingText = '';
        turn.lastFinalizedAssistantMessageId = null;
        turn.lastFinalizedAssistantText = '';
        turn.lastCommittedAssistantSeq = null;
        const callId = String(data.callId ?? randomUUID());
        const toolName = String(data.name ?? 'tool');
        const toolInput = parseToolArgs(data.arguments);
        if (isDshSubagentSpawn(toolName)) {
          turn.subagentTasksByCall.set(callId, typeof toolInput.prompt === 'string' ? toolInput.prompt : '');
        }
        const msg = this.store.addMessage(coworkSessionId, {
          type: 'tool_use',
          content: toolName,
          metadata: {
            toolUseId: callId,
            toolName,
            toolInput,
            seq: ev.seq,
          },
        });
        turn.toolCallMessageIds.set(callId, msg.id);
        this.emit('message', coworkSessionId, msg);
        return false;
      }

      if (evType === 'tool/result') {
        if (
          turn.ignoreStaleAbortedTurnEnd
          && eventTurnNumber !== null
          && turn.cancelledDshTurnNumber !== null
          && eventTurnNumber <= turn.cancelledDshTurnNumber
        ) {
          return false;
        }
        const messageObj = data.message as Record<string, unknown> | undefined;
        const callId = String(messageObj?.callId ?? messageObj?.toolCallId ?? data.callId ?? '');
        const text = extractTextFromContentBlocks(messageObj?.content ?? data.content);
        const resultMeta = record(data.meta);
        const hostResult = record(resultMeta.lobsterToolResult);
        const isError = Boolean(hostResult.isError || messageObj?.isError || data.isError);
        const subagentRunId = resultMeta.kind === DshChildEvent.Activation
          ? (
              (typeof resultMeta.name === 'string' ? turn.subagentIdsByName.get(resultMeta.name) : undefined)
              ?? (typeof resultMeta.childId === 'string' && resultMeta.childId.trim()
                ? formatStoredDshSessionId(resultMeta.childId.trim())
                : undefined)
            )
          : undefined;
        const task = turn.subagentTasksByCall.get(callId);
        if (subagentRunId && task !== undefined && !isError) turn.pendingSubagentResults.add(subagentRunId);
        if (subagentRunId && task) this.subagentSessions?.setTask(coworkSessionId, subagentRunId, task);
        if (subagentRunId && typeof resultMeta.agentId === 'string' && resultMeta.agentId.trim()) {
          this.subagentSessions?.setDelegatedAgent?.(coworkSessionId, subagentRunId, resultMeta.agentId.trim());
        }
        turn.subagentTasksByCall.delete(callId);
        const msg = this.store.addMessage(coworkSessionId, {
          type: 'tool_result',
          content: text,
          metadata: {
            toolUseId: callId,
            isError,
            ...(hostResult.details ? { toolResultDetails: record(hostResult.details) } : {}),
            ...(subagentRunId ? { subagentRunId } : {}),
            seq: ev.seq,
          },
        });
        this.emit('message', coworkSessionId, msg);
        return false;
      }

      if (evType === 'assistant/message') {
        // A cancelled previous turn can flush an interrupted assistant/message
        // just before its trailing aborted turn/end. Ignore it so we neither
        // duplicate the previous turn's partial bubble nor disarm the stale
        // aborted turn/end filter before turn/end arrives.
        const isStalePreviousTurnAssistant = turn.ignoreStaleAbortedTurnEnd && (
          data.interrupted === true
          || (
            eventTurnNumber !== null
            && turn.cancelledDshTurnNumber !== null
            && eventTurnNumber <= turn.cancelledDshTurnNumber
          )
        );
        if (isStalePreviousTurnAssistant) {
          return false;
        }
        if (eventTurnNumber !== null) {
          turn.currentDshTurnNumber = eventTurnNumber;
        }
        turn.ignoreStaleAbortedTurnEnd = false;
        turn.waitingForNextGoalRound = false;
        const messageObj = data.message as Record<string, unknown> | undefined;
        const rawContent = messageObj?.content ?? data.content;
        const text = extractTextFromContentBlocks(rawContent);
        const thinking = extractReasoningFromContentBlocks(rawContent);
        const seq = typeof ev.seq === 'number' ? ev.seq : undefined;
        const alreadyAppliedSeq = seq !== undefined && seq === turn.lastCommittedAssistantSeq;

        if (turn.currentThinkingMessageId) {
          if (!turn.currentThinkingText && thinking) {
            turn.currentThinkingText = thinking;
          }
          this.finalizeActiveThinkingMessage(turn, seq);
        } else if (turn.lastFinalizedThinkingMessageId) {
          const msgId = turn.lastFinalizedThinkingMessageId;
          const finalThinking = turn.lastFinalizedThinkingText || thinking;
          if (finalThinking !== turn.lastFinalizedThinkingText || (seq !== undefined && !alreadyAppliedSeq)) {
            const meta: Record<string, unknown> = {
              isThinking: true,
              isStreaming: false,
              ...(seq !== undefined ? { seq } : {}),
            };
            this.store.updateMessageContent(coworkSessionId, msgId, finalThinking, meta);
            this.emit('messageUpdate', coworkSessionId, msgId, finalThinking, meta);
          }
        } else if (thinking) {
          if (turn.reusableThinkingMessageId) {
            const msgId = turn.reusableThinkingMessageId;
            turn.reusableThinkingMessageId = null;
            const meta: Record<string, unknown> = {
              isThinking: true,
              isStreaming: false,
              ...(seq !== undefined ? { seq } : {}),
            };
            this.store.updateMessageContent(coworkSessionId, msgId, thinking, meta);
            this.emit('messageUpdate', coworkSessionId, msgId, thinking, meta);
          } else {
            const msg = this.store.addMessage(coworkSessionId, {
              type: 'assistant',
              content: thinking,
              metadata: {
                isThinking: true,
                ...(seq !== undefined ? { seq } : {}),
              },
            });
            this.emit('message', coworkSessionId, msg);
          }
        }

        if (turn.currentAssistantMessageId) {
          if (!turn.currentAssistantText && text) {
            turn.currentAssistantText = text;
          }
          this.finalizeActiveAssistantMessage(turn, seq);
        } else if (turn.lastFinalizedAssistantMessageId) {
          const msgId = turn.lastFinalizedAssistantMessageId;
          const finalText = turn.lastFinalizedAssistantText || text;
          if (finalText !== turn.lastFinalizedAssistantText || (seq !== undefined && !alreadyAppliedSeq)) {
            const meta: Record<string, unknown> = {
              isStreaming: false,
              ...assistantEventPosition(turn.dshSessionId, seq),
            };
            this.store.updateMessageContent(coworkSessionId, msgId, finalText, meta);
            this.emit('messageUpdate', coworkSessionId, msgId, finalText, meta);
          }
        } else if (text) {
          if (turn.suppressedPreSteerAssistantText !== null && text === turn.suppressedPreSteerAssistantText) {
            turn.suppressedPreSteerAssistantText = null;
          } else if (turn.reusableAssistantMessageId) {
            const msgId = turn.reusableAssistantMessageId;
            turn.reusableAssistantMessageId = null;
            const meta: Record<string, unknown> = {
              isStreaming: false,
              ...assistantEventPosition(turn.dshSessionId, seq),
            };
            this.store.updateMessageContent(coworkSessionId, msgId, text, meta);
            this.emit('messageUpdate', coworkSessionId, msgId, text, meta);
          } else {
            const msg = this.store.addMessage(coworkSessionId, {
              type: 'assistant',
              content: text,
              metadata: assistantEventPosition(turn.dshSessionId, seq),
            });
            this.emit('message', coworkSessionId, msg);
          }
        }

        this.discardReusableMessages(turn);
        turn.attemptThinkingMessageId = null;
        turn.attemptAssistantMessageId = null;
        turn.lastFinalizedThinkingMessageId = null;
        turn.lastFinalizedThinkingText = '';
        turn.lastFinalizedAssistantMessageId = null;
        turn.lastFinalizedAssistantText = '';
        turn.suppressedPreSteerAssistantText = null;
        turn.lastCommittedAssistantSeq = null;
        turn.pendingContextUsageRefresh = this.refreshAndEmitContextUsage(coworkSessionId);
        return false;
      }

      if (evType === 'compaction/start') {
        this.emit('contextMaintenance', coworkSessionId, true);
        return false;
      }

      if (evType === 'compaction/end') {
        this.emit('contextMaintenance', coworkSessionId, false);
        const isManualCommand = typeof data.sourceCommandId === 'string' && data.sourceCommandId.length > 0;
        if (!isManualCommand) {
          const hasError = data.error !== undefined && data.error !== null;
          const compactionMessage = this.store.addMessage(coworkSessionId, {
            type: 'system',
            content: '',
            metadata: {
              kind: CoworkSystemMessageKind.ContextCompaction,
              mode: ContextCompactionMode.Auto,
              status: hasError
                ? ContextCompactionStatus.Failed
                : ContextCompactionStatus.Completed,
              compacted: !hasError,
              ...(typeof data.compactionId === 'string' ? { compactionId: data.compactionId } : {}),
              ...(typeof ev.seq === 'number' ? { seq: ev.seq } : {}),
            },
          });
          this.emit('message', coworkSessionId, compactionMessage);
        }
        turn.pendingContextUsageRefresh = this.refreshAndEmitContextUsage(coworkSessionId);
        return false;
      }

      if (evType === 'turn/end') {
        const turnError = extractTurnEndError(data.reason);
        if (turnError) {
          turn.ignoreStaleAbortedTurnEnd = false;
          turn.goalArmed = false;
          turn.turnError = turnError;
        } else if (isAbortedTurnEndReason(data.reason)) {
          const isStaleCancelledTurn =
            turn.ignoreStaleAbortedTurnEnd
            || (
              eventTurnNumber !== null
              && turn.cancelledDshTurnNumber !== null
              && eventTurnNumber <= turn.cancelledDshTurnNumber
            );
          if (isStaleCancelledTurn) {
            turn.ignoreStaleAbortedTurnEnd = false;
            return false;
          }
          turn.goalArmed = false;
          turn.turnAborted = true;
        } else if (isMaxTokensTurnEndReason(data.reason)) {
          // DSH goal-round-driver disarms on max-tokens; do not wait for another round.
          turn.ignoreStaleAbortedTurnEnd = false;
          turn.goalArmed = false;
        } else {
          turn.ignoreStaleAbortedTurnEnd = false;
          // A model can yield the native turn after delegating. Each child's settlement
          // schedules another parent turn on this same stream.
          if (turn.pendingSubagentResults.size > 0) return false;
          // While a DSH goal remains active and armed, goal-round-driver immediately
          // schedules the next round after this turn ends; keep following until the
          // goal completes, blocks, pauses, clears, or disarms.
          if (turn.goalArmed) {
            turn.waitingForNextGoalRound = true;
            return false;
          }
        }
        return true;
      }
    }

    return false;
  }

  private ensureThinkingMessage(turn: ActiveTurnState): string {
    if (turn.currentThinkingMessageId) return turn.currentThinkingMessageId;
    if (turn.reusableThinkingMessageId) {
      const msgId = turn.reusableThinkingMessageId;
      turn.reusableThinkingMessageId = null;
      turn.currentThinkingMessageId = msgId;
      turn.attemptThinkingMessageId = msgId;
      turn.currentThinkingText = '';
      turn.lastFinalizedThinkingMessageId = null;
      turn.lastFinalizedThinkingText = '';
      return msgId;
    }
    const msg = this.store.addMessage(turn.coworkSessionId, {
      type: 'assistant',
      content: '',
      metadata: { isThinking: true, isStreaming: true },
    });
    turn.currentThinkingMessageId = msg.id;
    turn.attemptThinkingMessageId = msg.id;
    turn.currentThinkingText = '';
    turn.lastFinalizedThinkingMessageId = null;
    turn.lastFinalizedThinkingText = '';
    this.emit('message', turn.coworkSessionId, msg);
    return msg.id;
  }

  private finalizeActiveThinkingMessage(turn: ActiveTurnState, seq?: number): void {
    if (!turn.currentThinkingMessageId) return;
    const msgId = turn.currentThinkingMessageId;
    const thinking = turn.currentThinkingText;
    const meta: Record<string, unknown> = {
      isThinking: true,
      isStreaming: false,
      ...(seq !== undefined ? { seq } : {}),
    };
    this.store.updateMessageContent(turn.coworkSessionId, msgId, thinking, meta);
    this.emit('messageUpdate', turn.coworkSessionId, msgId, thinking, meta);
    turn.lastFinalizedThinkingMessageId = msgId;
    turn.lastFinalizedThinkingText = thinking;
    turn.currentThinkingMessageId = null;
    turn.currentThinkingText = '';
  }

  private ensureAssistantMessage(turn: ActiveTurnState): string {
    if (turn.currentAssistantMessageId) return turn.currentAssistantMessageId;
    if (turn.reusableAssistantMessageId) {
      const msgId = turn.reusableAssistantMessageId;
      turn.reusableAssistantMessageId = null;
      turn.currentAssistantMessageId = msgId;
      turn.attemptAssistantMessageId = msgId;
      turn.currentAssistantText = '';
      turn.lastFinalizedAssistantMessageId = null;
      turn.lastFinalizedAssistantText = '';
      return msgId;
    }
    const msg = this.store.addMessage(turn.coworkSessionId, {
      type: 'assistant',
      content: '',
      metadata: { isStreaming: true },
    });
    turn.currentAssistantMessageId = msg.id;
    turn.attemptAssistantMessageId = msg.id;
    turn.currentAssistantText = '';
    turn.lastFinalizedAssistantMessageId = null;
    turn.lastFinalizedAssistantText = '';
    this.emit('message', turn.coworkSessionId, msg);
    return msg.id;
  }

  private finalizeActiveAssistantMessage(turn: ActiveTurnState, seq?: number): void {
    if (!turn.currentAssistantMessageId) return;
    const msgId = turn.currentAssistantMessageId;
    const text = turn.currentAssistantText;
    const meta: Record<string, unknown> = {
      isStreaming: false,
      ...assistantEventPosition(turn.dshSessionId, seq),
    };
    this.store.updateMessageContent(turn.coworkSessionId, msgId, text, meta);
    this.emit('messageUpdate', turn.coworkSessionId, msgId, text, meta);
    turn.lastFinalizedAssistantMessageId = msgId;
    turn.lastFinalizedAssistantText = text;
    turn.currentAssistantMessageId = null;
    turn.currentAssistantText = '';
  }

  private resetAttemptMessagesForRetry(turn: ActiveTurnState): void {
    const thinkingId = turn.currentThinkingMessageId ?? turn.attemptThinkingMessageId;
    if (thinkingId) {
      const meta = { isThinking: true, isStreaming: true };
      this.store.updateMessageContent(turn.coworkSessionId, thinkingId, '', meta);
      this.emit('messageUpdate', turn.coworkSessionId, thinkingId, '', meta);
      turn.reusableThinkingMessageId = thinkingId;
      if (turn.lastFinalizedThinkingMessageId === thinkingId) {
        turn.lastFinalizedThinkingMessageId = null;
        turn.lastFinalizedThinkingText = '';
      }
    }
    turn.currentThinkingMessageId = null;
    turn.currentThinkingText = '';
    turn.attemptThinkingMessageId = null;

    const assistantId = turn.currentAssistantMessageId ?? turn.attemptAssistantMessageId;
    if (assistantId) {
      const meta = { isStreaming: true };
      this.store.updateMessageContent(turn.coworkSessionId, assistantId, '', meta);
      this.emit('messageUpdate', turn.coworkSessionId, assistantId, '', meta);
      turn.reusableAssistantMessageId = assistantId;
      if (turn.lastFinalizedAssistantMessageId === assistantId) {
        turn.lastFinalizedAssistantMessageId = null;
        turn.lastFinalizedAssistantText = '';
      }
    }
    turn.currentAssistantMessageId = null;
    turn.currentAssistantText = '';
    turn.attemptAssistantMessageId = null;
  }

  private discardReusableMessages(turn: ActiveTurnState): void {
    if (turn.reusableThinkingMessageId) {
      this.store.deleteMessage?.(turn.coworkSessionId, turn.reusableThinkingMessageId);
      turn.reusableThinkingMessageId = null;
    }
    if (turn.reusableAssistantMessageId) {
      this.store.deleteMessage?.(turn.coworkSessionId, turn.reusableAssistantMessageId);
      turn.reusableAssistantMessageId = null;
    }
  }
}

const DSH_COMMAND_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function buildCommandSubmitAttachments(
  imageAttachments?: CoworkStartOptions['imageAttachments'],
): DshCommandSubmitAttachment[] {
  const attachments: DshCommandSubmitAttachment[] = [];
  for (const img of imageAttachments ?? []) {
    if (!img || typeof img.base64Data !== 'string' || !img.base64Data) continue;
    const rawMedia = (img.mimeType || 'image/png').toLowerCase();
    const mediaType = DSH_COMMAND_IMAGE_MEDIA_TYPES.has(rawMedia)
      ? (rawMedia as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')
      : 'image/png';
    attachments.push({
      type: 'image',
      mediaType,
      data: img.base64Data,
      ...(img.name ? { name: img.name } : {}),
    });
  }
  return attachments;
}

function extractInlineScreenshotImage(
  asset: unknown,
): { mimeType: string; base64Data: string; byteSize?: number } | null {
  if (!asset || typeof asset !== 'object') return null;
  const record = asset as Record<string, unknown>;
  const fallbackMime = typeof record.mimeType === 'string' && record.mimeType.trim()
    ? record.mimeType.trim()
    : 'image/png';
  if (typeof record.dataUrl === 'string' && record.dataUrl.trim()) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(record.dataUrl.trim());
    const base64Data = stripDataUrlPrefix(record.dataUrl);
    if (base64Data) {
      return { mimeType: match?.[1] || fallbackMime, base64Data };
    }
  }
  if (typeof record.base64Data === 'string' && record.base64Data.trim()) {
    const base64Data = stripDataUrlPrefix(record.base64Data);
    if (base64Data) {
      return { mimeType: fallbackMime, base64Data };
    }
  }
  return null;
}

function readAnnotationAssetData(
  readAsset: DshReadBrowserAnnotationAsset | undefined,
  sessionId: string,
  batchId: string,
  annotationId: string,
  assetId: string,
  fallbackMime: string,
): { mimeType: string; base64Data: string; byteSize?: number } | null {
  if (!readAsset || !batchId || !annotationId || !assetId) return null;
  const candidateDraftKeys = sessionId && sessionId !== 'home' ? [sessionId, 'home'] : ['home'];
  for (const draftKey of candidateDraftKeys) {
    try {
      const loaded = readAsset({ draftKey, batchId, annotationId, assetId });
      if (!loaded || typeof loaded.dataUrl !== 'string' || !loaded.dataUrl.trim()) continue;
      const match = /^data:([^;]+);base64,(.*)$/s.exec(loaded.dataUrl.trim());
      const base64Data = stripDataUrlPrefix(loaded.dataUrl);
      if (!base64Data) continue;
      return {
        mimeType: match?.[1] || fallbackMime,
        base64Data,
        ...(typeof loaded.byteSize === 'number' ? { byteSize: loaded.byteSize } : {}),
      };
    } catch {
      // Try next fallback draftKey or continue without screenshot attachment.
    }
  }
  return null;
}

function prepareBrowserAnnotationsForPrompt(
  sessionId: string,
  browserAnnotations: CoworkStartOptions['browserAnnotations'],
  imageAttachments: CoworkStartOptions['imageAttachments'],
  readBrowserAnnotationAsset?: DshReadBrowserAnnotationAsset,
): {
  browserAnnotationSection: string;
  imageAttachments: NonNullable<CoworkStartOptions['imageAttachments']>;
} {
  const effectiveImages = [...(imageAttachments ?? [])];
  const normalized = normalizeBrowserAnnotationBatches(browserAnnotations);
  if (normalized.length === 0) {
    return { browserAnnotationSection: '', imageAttachments: effectiveImages };
  }

  const preparedBatches: CoworkBrowserAnnotationMessageBatch[] = normalized.map((batch) => ({
    ...batch,
    annotations: batch.annotations.map((annotation) => {
      if (annotation.screenshot.status !== BrowserAnnotationScreenshotStatus.Ready) {
        return annotation;
      }
      const existingIndex = annotation.screenshot.asset.transportImageIndex;
      const alreadyAttached = typeof existingIndex === 'number'
        && Number.isInteger(existingIndex)
        && existingIndex >= 1
        && existingIndex <= effectiveImages.length;
      if (alreadyAttached) {
        return annotation;
      }

      const fallbackMime = annotation.screenshot.asset.mimeType || 'image/png';
      const resolved = extractInlineScreenshotImage(annotation.screenshot.asset)
        ?? readAnnotationAssetData(
          readBrowserAnnotationAsset,
          sessionId,
          batch.id,
          annotation.id,
          annotation.screenshot.asset.assetId,
          fallbackMime,
        );
      if (!resolved) {
        return annotation;
      }

      const nextIndex = effectiveImages.length + 1;
      effectiveImages.push({
        name: `browser-annotation-${nextIndex}.png`,
        mimeType: resolved.mimeType,
        base64Data: resolved.base64Data,
        ...(typeof resolved.byteSize === 'number' && resolved.byteSize > 0 ? { sizeBytes: resolved.byteSize } : {}),
        role: CoworkImageAttachmentRole.BrowserAnnotation,
      });

      return {
        ...annotation,
        screenshot: {
          ...annotation.screenshot,
          asset: {
            ...annotation.screenshot.asset,
            transportImageIndex: nextIndex,
          },
        },
      };
    }),
  }));

  return {
    browserAnnotationSection: buildBrowserAnnotationPromptSection(preparedBatches),
    imageAttachments: effectiveImages,
  };
}

function buildPromptContentParts(
  prompt: string,
  turnPrefix: string,
  imageAttachments?: CoworkStartOptions['imageAttachments'],
): DshPromptPart[] {
  const parts: DshPromptPart[] = [];
  const fullText = turnPrefix
    ? `${turnPrefix}\n\n${prompt}`.trim()
    : prompt;
  if (fullText.length > 0) {
    parts.push({ type: 'text', text: fullText });
  }
  for (const img of imageAttachments ?? []) {
    if (!img || typeof img.base64Data !== 'string') continue;
    const data = stripDataUrlPrefix(img.base64Data);
    if (!data) continue;
    parts.push({
      type: 'image',
      mediaType: img.mimeType || 'image/png',
      data,
    });
  }
  return parts;
}

function parseProviderModelRef(ref: string): DshModelSelection | null {
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx >= ref.length - 1) return null;
  return {
    provider: canonicalizeDshProviderId(ref.slice(0, idx)),
    model: ref.slice(idx + 1),
  };
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw };
    }
  }
  return {};
}

function extractStreamChunkDelta(chunk: Record<string, unknown> | undefined): string {
  if (!chunk) return '';
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.delta === 'string') return chunk.delta;
  return '';
}

function isFailedAssistantStreamOutcome(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== 'object') return false;
  const record = outcome as { kind?: unknown; eventType?: unknown };
  if (record.kind === 'abandoned') return true;
  return record.kind === 'committed' && record.eventType === 'assistant/attempt';
}

function extractTurnEndError(reason: unknown): string | null {
  if (!reason || typeof reason !== 'object') return null;
  const record = reason as {
    kind?: unknown;
    error?: { message?: unknown; code?: unknown } | string;
  };
  if (record.kind !== 'error') return null;
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error.trim();
  }
  if (record.error && typeof record.error === 'object') {
    if (typeof record.error.message === 'string' && record.error.message.trim()) {
      return record.error.message.trim();
    }
    if (typeof record.error.code === 'string' && record.error.code.trim()) {
      return record.error.code.trim();
    }
  }
  return 'Agent turn failed';
}

function isAbortedTurnEndReason(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  return (reason as { kind?: unknown }).kind === 'aborted';
}

function isMaxTokensTurnEndReason(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  return (reason as { kind?: unknown }).kind === 'max-tokens';
}

function extractTextFromContentBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type?: string; text?: string } => Boolean(block && typeof block === 'object'))
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('');
}

function extractReasoningFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type?: string; text?: string; thinking?: string } => Boolean(block && typeof block === 'object'))
    .filter((block) => block.type === 'reasoning' || block.type === 'thinking')
    .map((block) => (typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : ''))
    .filter(Boolean)
    .join('');
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractContextUsageFromProjections(
  sessionId: string,
  dshSessionId: string,
  projections: Record<string, unknown> | null,
  contextWindowOverride?: number | null,
): CoworkContextUsage | null {
  if (!projections || typeof projections !== 'object') return null;
  const values = asPlainRecord(projections.values) ?? projections;

  const contextPressure = asPlainRecord(values.contextPressure);
  const tokenUsage = asPlainRecord(values.tokenUsage);
  const contextBreakdown = asPlainRecord(values.contextBreakdown);
  const legacyMeter = asPlainRecord(values.tokenMeter);

  const projectedTokens = asNonNegativeNumber(contextPressure?.projectedTokens);
  const pressureTokens = asNonNegativeNumber(contextPressure?.pressureTokens);
  const pressureContextWindow = asPositiveNumber(contextPressure?.contextWindow);

  const legacyUsed = asNonNegativeNumber(legacyMeter?.usedTokens)
    ?? asNonNegativeNumber(legacyMeter?.inputTokens);
  const legacyContextWindow = asPositiveNumber(legacyMeter?.contextWindow)
    ?? asPositiveNumber(legacyMeter?.contextTokens);

  let breakdownTotal: number | undefined;
  if (contextBreakdown) {
    const sys = asNonNegativeNumber(contextBreakdown.systemTokens);
    const tools = asNonNegativeNumber(contextBreakdown.toolsTokens);
    const msgs = asNonNegativeNumber(contextBreakdown.messageTokens);
    if (sys !== undefined || tools !== undefined || msgs !== undefined) {
      const sum = (sys ?? 0) + (tools ?? 0) + (msgs ?? 0);
      if (sum > 0) breakdownTotal = sum;
    }
  }

  let tokenUsageFallback: number | undefined;
  if (tokenUsage) {
    const uncached = asNonNegativeNumber(tokenUsage.uncachedInputTokens) ?? 0;
    const cacheRead = asNonNegativeNumber(tokenUsage.cacheReadTokens) ?? 0;
    const cacheWrite = asNonNegativeNumber(tokenUsage.cacheWriteTokens) ?? 0;
    const output = asNonNegativeNumber(tokenUsage.outputTokens) ?? 0;
    const promptSide = uncached + cacheRead + cacheWrite;
    if (promptSide > 0) {
      tokenUsageFallback = promptSide;
    } else if (output > 0) {
      tokenUsageFallback = output;
    }
  }

  const usedTokens = projectedTokens
    ?? pressureTokens
    ?? legacyUsed
    ?? breakdownTotal
    ?? tokenUsageFallback;

  const overrideWindow = asPositiveNumber(contextWindowOverride);
  const resolvedProjectionWindow = pressureContextWindow ?? legacyContextWindow;
  if (usedTokens === undefined && resolvedProjectionWindow === undefined) {
    return null;
  }

  const contextTokens = overrideWindow ?? resolvedProjectionWindow;
  const percent = usedTokens !== undefined && contextTokens && contextTokens > 0
    ? Math.min(100, Math.max(0, Math.round((usedTokens / contextTokens) * 100)))
    : undefined;
  const status: CoworkContextUsage['status'] = percent === undefined
    ? 'unknown'
    : percent >= 90
      ? 'danger'
      : percent >= 75
        ? 'warning'
        : 'normal';

  const modelSelection = asPlainRecord(values.modelSelection);
  const selectedModel = asPlainRecord(modelSelection?.lastUsed) ?? asPlainRecord(modelSelection?.next);
  const model = typeof selectedModel?.model === 'string' && selectedModel.model.trim()
    ? (typeof selectedModel.provider === 'string' && selectedModel.provider.trim()
        ? `${selectedModel.provider.trim()}/${selectedModel.model.trim()}`
        : selectedModel.model.trim())
    : undefined;

  return {
    sessionId,
    sessionKey: dshSessionId,
    usedTokens,
    contextTokens,
    percent,
    status,
    ...(model ? { model } : {}),
    updatedAt: Date.now(),
  };
}

function mapDshGoalPhaseToStatus(rawStatus: unknown): CoworkGoalStatus {
  if (rawStatus === CoworkGoalStatus.Complete || rawStatus === 'completed') {
    return CoworkGoalStatus.Complete;
  }
  if (rawStatus === CoworkGoalStatus.Paused || rawStatus === 'cancelled') {
    return CoworkGoalStatus.Paused;
  }
  if (rawStatus === CoworkGoalStatus.Blocked) {
    return CoworkGoalStatus.Blocked;
  }
  if (rawStatus === CoworkGoalStatus.UsageLimited) {
    return CoworkGoalStatus.UsageLimited;
  }
  if (rawStatus === CoworkGoalStatus.BudgetLimited) {
    return CoworkGoalStatus.BudgetLimited;
  }
  return CoworkGoalStatus.Active;
}

export function extractGoalFromDshPayload(raw: unknown): CoworkGoal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const container = raw as Record<string, unknown>;
  if (container.operation === DshGoalOperation.Clear) return null;

  // DSH 0.2.2-rc.5 real shape:
  // `{ goal: { id, revision, objective, phase, maxGoalRounds, blockedReason? }, roundsStarted, createdAt, updatedAt }`
  // Also stays tolerant of flat legacy mock shapes (`{ id, text/objective, status, createdAt, tokensUsed }`).
  const nested = container.goal && typeof container.goal === 'object' && !Array.isArray(container.goal)
    ? container.goal as Record<string, unknown>
    : null;
  const source = nested ?? container;

  const objective = typeof source.objective === 'string' && source.objective.trim()
    ? source.objective.trim()
    : typeof source.text === 'string' && source.text.trim()
      ? source.text.trim()
      : '';
  if (!objective) return null;

  const now = Date.now();
  const status = mapDshGoalPhaseToStatus(source.phase ?? source.status ?? container.phase ?? container.status);
  const createdAt = typeof container.createdAt === 'number'
    ? container.createdAt
    : typeof source.createdAt === 'number'
      ? source.createdAt
      : now;
  const updatedAt = typeof container.updatedAt === 'number'
    ? container.updatedAt
    : typeof source.updatedAt === 'number'
      ? source.updatedAt
      : now;
  const roundsStarted = typeof container.roundsStarted === 'number'
    ? container.roundsStarted
    : typeof source.roundsStarted === 'number'
      ? source.roundsStarted
      : typeof container.continuationTurns === 'number'
        ? container.continuationTurns
        : undefined;
  const rawBlocked = source.blockedReason && typeof source.blockedReason === 'object' && !Array.isArray(source.blockedReason)
    ? source.blockedReason as Record<string, unknown>
    : null;
  const blockedNote = rawBlocked
    ? (typeof rawBlocked.message === 'string' && rawBlocked.message.trim()
        ? rawBlocked.message.trim()
        : typeof rawBlocked.code === 'string' && rawBlocked.code.trim()
          ? rawBlocked.code.trim()
          : undefined)
    : undefined;
  const lastStatusNote = blockedNote
    ?? (typeof container.lastStatusNote === 'string' && container.lastStatusNote.trim()
      ? container.lastStatusNote.trim()
      : undefined);

  return {
    id: typeof source.id === 'string' && source.id ? source.id : `goal-${now}`,
    objective,
    status,
    createdAt,
    updatedAt,
    tokensUsed: typeof container.tokensUsed === 'number'
      ? container.tokensUsed
      : typeof source.tokensUsed === 'number'
        ? source.tokensUsed
        : 0,
    ...(roundsStarted !== undefined ? { continuationTurns: Math.max(0, Math.floor(roundsStarted)) } : {}),
    ...(lastStatusNote ? { lastStatusNote } : {}),
    ...(status === CoworkGoalStatus.Paused ? { pausedAt: updatedAt } : {}),
    ...(status === CoworkGoalStatus.Blocked ? { blockedAt: updatedAt } : {}),
    ...(status === CoworkGoalStatus.Complete ? { completedAt: updatedAt } : {}),
  };
}

export function extractGoalFromProjections(projections: Record<string, unknown> | null): CoworkGoal | null {
  if (!projections || typeof projections !== 'object') return null;
  const values = (projections.values as Record<string, unknown> | undefined) ?? projections;
  if (!values || typeof values !== 'object') return null;
  return extractGoalFromDshPayload(values.goal);
}
