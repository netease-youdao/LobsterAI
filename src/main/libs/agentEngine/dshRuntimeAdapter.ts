// Clean CoworkRuntime adapter over DeepSeek Harness (DSH) Typert WS/HTTP API.
//
// Zero Electron imports — interacts with persistence through a narrow store
// port and with DSH through `DshHostManager` / `DshTypertClient`, keeping the
// entire runtime loop directly unit-testable under Node Vitest.

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import type { OpenClawSessionPatch } from '../../../common/openclawSession';
import type {
  CoworkBtwAbortResponse,
  CoworkBtwSubmitResponse,
} from '../../../shared/cowork/btw';
import { CoworkBtwStatus } from '../../../shared/cowork/btw';
import { ASK_USER_QUESTION_TOOL_NAME } from '../../../shared/cowork/constants';
import type { CoworkGoal } from '../../../shared/cowork/goal';
import { CoworkGoalStatus } from '../../../shared/cowork/goal';
import { buildCoworkImageAttachmentPreviews } from '../../../shared/cowork/imageAttachments';
import { type CoworkSteerResponse, CoworkSteerStatus } from '../../../shared/cowork/steer';
import { isDshSubagentSpawn } from '../../../shared/cowork/subagent';
import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_QUESTION_REQUEST_ID_PREFIX,
  DSH_SESSION_ID_PREFIX,
  DshApprovalPermissionAction,
  DshPermissionPreset,
  DshProgressiveCapability,
} from '../../../shared/dshEngine/hostConstants';
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
  modelOverride?: string | null;
  modelPresetId?: string | null;
  systemPrompt?: string;
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
      goal?: CoworkGoal | null;
    },
  ): void;
  getContinuityCapsule?(sessionId: string): CoworkContinuityCapsule | null;
}

export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshRuntimeAdapterDeps {
  subagentSessions?: Pick<DshSubagentSessions, 'observeCatalog' | 'observeNotice' | 'getOwningSessionId' | 'setTask'>;
  hostManager: Pick<
    DshHostManager,
    'start' | 'isReady' | 'getClient' | 'bindSessionContext' | 'deleteSessionFiles'
  > & Partial<Pick<DshHostManager, 'setPermissionPreset' | 'consumeApprovalCallContext'>>;
  store: DshCoworkStorePort;
  resolveModelSelection?: (
    sessionId: string,
    override?: string | null,
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
}

interface ActiveTurnState {
  subagentIdsByName: Map<string, string>;
  subagentTasksByCall: Map<string, string>;
  pendingSubagentResults: Set<string>;
  coworkSessionId: string;
  dshSessionId: string;
  userMessageId?: string;
  traceId: string;
  abortController: AbortController;
  confirmationMode: 'modal' | 'text';
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
  lastCommittedAssistantSeq: number | null;
  toolCallMessageIds: Map<string, string>;
  turnCompleted: boolean;
  turnError: string | null;
  turnAborted: boolean;
  /** Ignore a trailing aborted `turn/end` leaked from a just-cancelled previous turn. */
  ignoreStaleAbortedTurnEnd: boolean;
}

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
  const effort = normalizeDshReasoningEffort(params.reasoningEffort);
  try {
    await client.selectModel({
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
  } catch (error) {
    if (!effort) throw error;
    // Retry without reasoningEffort when the target model does not declare
    // reasoning support or does not accept the requested effort level.
    console.warn(
      `[DshRuntimeAdapter] selectModel rejected reasoningEffort="${effort}" for ${params.provider}/${params.model}; retrying without reasoningEffort:`,
      error instanceof Error ? error.message : String(error),
    );
    await client.selectModel({
      sessionId: params.sessionId,
      provider: params.provider,
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

const SKILL_TO_PROGRESSIVE_CAPABILITY: Readonly<Record<string, DshProgressiveCapability>> = {
  'computer-use': DshProgressiveCapability.ComputerUse,
  'web-search': DshProgressiveCapability.Browser,
  docx: DshProgressiveCapability.Word,
  xlsx: DshProgressiveCapability.Excel,
  pptx: DshProgressiveCapability.Ppt,
};

/**
 * Determine which built-in progressive MCP capability groups should be
 * pre-unlocked for this turn based on explicit user-selected skills or
 * attached browser annotations.
 */
export function resolveUnlockedCapabilitiesForTurn(params: {
  messageSkillIds?: string[];
  browserAnnotations?: CoworkStartOptions['browserAnnotations'];
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
  return [...unlocked];
}

function resolveLocalTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.trim().length > 0 ? tz.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a compact one-time context bridge prefix when resuming a historical
 * OpenClaw session inside DSH for the first time ("Lazy Context Bridge").
 */
export function buildLazyContextBridgePrefix(
  capsule: CoworkContinuityCapsule | null,
  messages: CoworkMessage[] | undefined,
): string {
  const parts: string[] = [];
  const images = (messages ?? [])
    .filter(message => message.type === 'user')
    .flatMap(message => message.metadata?.historyImageReferences ?? [])
    .slice(-LEGACY_BRIDGE_MAX_MESSAGES);
  if (images.length) {
    parts.push('[历史消息中的图片] 用户询问图片内容时，请使用 read_image 读取对应文件。\n'
      + images.map(image => JSON.stringify(image)).join('\n'));
  }
  if (capsule) {
    const formatted = formatCoworkContinuityCapsuleBridge(capsule).trim();
    if (formatted) parts.push(formatted);
  }
  const relevant = (messages ?? [])
    .filter((m) => (
      (m.type === 'user' || m.type === 'assistant')
      && m.metadata?.isThinking !== true
      && m.content.trim().length > 0
    ))
    .slice(-LEGACY_BRIDGE_MAX_MESSAGES);
  if (relevant.length > 0) {
    const transcript = relevant
      .map((m) => `${m.type === 'user' ? '用户' : '助手'}: ${m.content.trim().slice(0, 800)}`)
      .join('\n\n');
    parts.push(`[历史会话近期对话]\n${transcript}`);
  }
  if (parts.length === 0) return '';
  const combined = `<previous_conversation_context>\n${parts.join('\n\n')}\n</previous_conversation_context>`;
  return combined.length > LEGACY_BRIDGE_MAX_CHARS
    ? `${combined.slice(0, LEGACY_BRIDGE_MAX_CHARS)}\n</previous_conversation_context>`
    : combined;
}

export class DshRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly subagentSessions?: DshRuntimeAdapterDeps['subagentSessions'];
  private readonly hostManager: DshRuntimeAdapterDeps['hostManager'];
  private readonly store: DshCoworkStorePort;
  private readonly resolveModelSelection?: DshRuntimeAdapterDeps['resolveModelSelection'];
  private readonly resolveAllowedSkillIds?: DshRuntimeAdapterDeps['resolveAllowedSkillIds'];
  private readonly resolveDefaultPermissionPreset?: DshRuntimeAdapterDeps['resolveDefaultPermissionPreset'];
  private readonly onPermissionPresetChanged?: DshRuntimeAdapterDeps['onPermissionPresetChanged'];

  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly startingAbortControllers = new Map<string, AbortController>();
  private readonly pendingCancels = new Map<string, Promise<void>>();
  private readonly dshToCoworkSession = new Map<string, string>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly btwAbortControllers = new Map<string, AbortController>();
  private readonly sessionAllowedScopes = new Map<string, Set<string>>();
  private readonly sessionPermissionPresets = new Map<string, DshPermissionPreset>();
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
  }

  getEffectivePermissionPreset(coworkSessionId?: string): DshPermissionPreset {
    if (coworkSessionId) {
      const override = this.sessionPermissionPresets.get(coworkSessionId);
      if (override) return override;
    }
    return this.resolveDefaultPermissionPreset?.() ?? DEFAULT_DSH_PERMISSION_PRESET;
  }

  async setSessionPermissionPreset(
    preset: DshPermissionPreset,
    coworkSessionId?: string,
  ): Promise<void> {
    if (coworkSessionId) {
      this.sessionPermissionPresets.set(coworkSessionId, preset);
      const dshSessionId = this.resolveExistingDshSessionId(coworkSessionId);
      if (dshSessionId && this.hostManager.setPermissionPreset) {
        await this.hostManager.setPermissionPreset(preset, dshSessionId);
      }
      return;
    }
    this.sessionPermissionPresets.clear();
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
      browserAnnotations: options.browserAnnotations,
      systemPrompt: options.systemPrompt,
      confirmationMode: options.confirmationMode ?? 'modal',
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
    const client = await this.ensureReadyClient();
    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId) {
      throw new Error(`No active DSH session found for ${sessionId}`);
    }
    const clientTimeZone = resolveLocalTimeZone();
    await client.promptSession({
      sessionId: dshSessionId,
      requestId: clientSteerId || randomUUID(),
      content: [{ type: 'text', text: trimmed }],
      mode: 'steer',
      ...(clientTimeZone ? { clientTimeZone } : {}),
    });
    const message = this.store.addMessage(sessionId, {
      type: 'user',
      content: trimmed,
      metadata: { steer: true, clientSteerId },
    });
    this.emit('message', sessionId, message);
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
    const thinking = typeof patch.thinkingLevel === 'string' ? patch.thinkingLevel : undefined;

    if (modelStr) {
      this.store.updateSession(sessionId, { modelOverride: modelStr });
    }

    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId || !this.hostManager.isReady()) {
      return {
        ...(modelStr ? { modelOverride: modelStr, resolvedModelRef: modelStr } : {}),
        ...(thinking ? { thinkingLevel: thinking } : {}),
      };
    }

    const selection = this.resolveModelSelection
      ? await this.resolveModelSelection(sessionId, modelStr || undefined)
      : parseProviderModelRef(modelStr);
    if (selection) {
      await selectModelWithReasoningFallback(this.hostManager.getClient(), {
        sessionId: dshSessionId,
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: thinking ?? selection.reasoningEffort,
      });
    }

    return {
      ...(modelStr ? { modelOverride: modelStr, resolvedModelRef: modelStr } : {}),
      ...(thinking ? { thinkingLevel: thinking } : {}),
    };
  }

  async getContextUsage(sessionId: string): Promise<CoworkContextUsage | null> {
    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId || !this.hostManager.isReady()) return null;

    const projections = await this.hostManager.getClient().getSessionProjections(dshSessionId);
    if (!projections || typeof projections !== 'object') return null;
    const values = (projections.values as Record<string, unknown> | undefined) ?? projections;
    const meter = values.tokenMeter as Record<string, unknown> | undefined;
    if (!meter || typeof meter !== 'object') return null;

    const usedTokens = typeof meter.usedTokens === 'number'
      ? meter.usedTokens
      : typeof meter.inputTokens === 'number'
        ? meter.inputTokens
        : undefined;
    const contextTokens = typeof meter.contextWindow === 'number'
      ? meter.contextWindow
      : typeof meter.contextTokens === 'number'
        ? meter.contextTokens
        : undefined;
    const percent = usedTokens !== undefined && contextTokens && contextTokens > 0
      ? Math.min(100, Math.round((usedTokens / contextTokens) * 100))
      : undefined;
    const status: CoworkContextUsage['status'] = percent === undefined
      ? 'unknown'
      : percent >= 90
        ? 'danger'
        : percent >= 75
          ? 'warning'
          : 'normal';

    return {
      sessionId,
      sessionKey: dshSessionId,
      usedTokens,
      contextTokens,
      percent,
      status,
      updatedAt: Date.now(),
    };
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
      await client.promptSession({
        sessionId: dshSessionId,
        requestId: randomUUID(),
        content: [{ type: 'text', text: '/compact' }],
        mode: 'queue',
      });
      const usage = await this.getContextUsage(sessionId);
      if (usage) this.emit('contextUsageUpdate', sessionId, usage);
      return { compacted: true, usage };
    } finally {
      this.emit('contextMaintenance', sessionId, false);
    }
  }

  async runGoalCommand(sessionId: string, command: string): Promise<CoworkGoal | null> {
    const client = await this.ensureReadyClient();
    const dshSessionId = this.resolveExistingDshSessionId(sessionId);
    if (!dshSessionId) {
      throw new Error(`No DSH session found for goal command on ${sessionId}`);
    }
    const normalized = command.trim().startsWith('/goal')
      ? command.trim()
      : `/goal ${command.trim()}`;
    await client.promptSession({
      sessionId: dshSessionId,
      requestId: randomUUID(),
      content: [{ type: 'text', text: normalized }],
      mode: 'queue',
    });
    const projections = await client.getSessionProjections(dshSessionId);
    const goal = extractGoalFromProjections(projections);
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

  respondToPermission(requestId: string, result: PermissionResult): void {
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
            const preset = record.preset;
            if (
              preset === DshPermissionPreset.ReadOnly
              || preset === DshPermissionPreset.WorkspaceWrite
              || preset === DshPermissionPreset.FullAccess
            ) {
              const targetSessionId = record.global === true ? undefined : pending.coworkSessionId;
              void this.setSessionPermissionPreset(preset, targetSessionId).catch((): void => undefined);
              void Promise.resolve(this.onPermissionPresetChanged?.(preset, targetSessionId)).catch(
                (): void => undefined,
              );
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

  getTurnRunIds(sessionId: string): string[] {
    const turn = this.activeTurns.get(sessionId);
    return turn ? [turn.dshSessionId] : [];
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.activeTurns.get(sessionId)?.confirmationMode ?? null;
  }

  onSessionDeleted(sessionId: string): void {
    this.stopSession(sessionId);
    this.sessionAllowedScopes.delete(sessionId);
    this.sessionPermissionPresets.delete(sessionId);
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

    const requestId = `${kind === 'approval' ? 'dsh-approval:' : DSH_QUESTION_REQUEST_ID_PREFIX}${evt.eventId}`;
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
      browserAnnotations?: CoworkStartOptions['browserAnnotations'];
      systemPrompt?: string;
      confirmationMode: 'modal' | 'text';
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
      const imageAttachmentPreviews = !localMediaAttachments && params.imageAttachments?.length
        ? buildCoworkImageAttachmentPreviews(params.imageAttachments)
        : undefined;
      const hasPersistableUserMessage = persistedContent.trim().length > 0
        || Boolean(localMediaAttachments?.length)
        || Boolean(imageAttachmentPreviews?.length);

      if (!params.skipInitialUserMessage && hasPersistableUserMessage) {
        const userMetadata: Record<string, unknown> = {
          llmTrace,
          ...(localMediaAttachments ? { localMediaAttachments } : {}),
          ...(imageAttachmentPreviews ? { imageAttachmentPreviews } : {}),
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
        : null;
      if (abortController.signal.aborted) return;

      registerLlmUsageContext(llmTrace.traceId, sessionId, prompt, {
        title: session.title,
        modelPresetId: turnUserMessage?.metadata?.modelPresetId ?? session.modelPresetId ?? undefined,
        resolvedModelId: (typeof turnUserMessage?.metadata?.resolvedModelId === 'string'
          ? turnUserMessage.metadata.resolvedModelId
          : undefined) ?? modelSelection?.model,
      });

      // Create or reuse DSH session, applying Lazy Context Bridge when upgrading
      // a legacy OpenClaw session for the first time.
      let dshSessionId = this.resolveExistingDshSessionId(sessionId);
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
          || (session.claudeSessionId && !isDshBackedSessionId(session.claudeSessionId)),
        );
        if (hasLegacyHistory) {
          const capsule = this.store.getContinuityCapsule?.(sessionId) ?? null;
          lazyBridgePrefix = buildLazyContextBridgePrefix(capsule, priorMessages);
        }
      }

      this.dshToCoworkSession.set(dshSessionId, sessionId);

      // Bind LobsterAI session context (agent persona, skills filter, executionMode, turn traceId).
      const agentId = params.agentId || session.agentId || 'main';
      const allowedSkillIds = this.resolveAllowedSkillIds
        ? this.resolveAllowedSkillIds(sessionId, agentId, params.skillIds)
        : params.skillIds ?? null;
      const unlockedCapabilities = resolveUnlockedCapabilitiesForTurn({
        messageSkillIds: params.messageSkillIds,
        browserAnnotations: params.browserAnnotations,
      });
      const contextPayload: DshHostSessionContext = {
        sessionId: dshSessionId,
        agentId,
        coworkSessionId: sessionId,
        traceId: llmTrace.traceId,
        workspaceDir: params.workspaceRoot || session.cwd,
        allowedSkillIds,
        ...(params.systemPrompt || session.systemPrompt
          ? { customSystemPrompt: params.systemPrompt || session.systemPrompt }
          : {}),
        ...(session.executionMode ? { executionMode: session.executionMode } : {}),
        permissionPreset: this.getEffectivePermissionPreset(sessionId),
        ...(unlockedCapabilities.length > 0 ? { unlockedCapabilities } : {}),
      };
      await this.hostManager.bindSessionContext(contextPayload);
      if (abortController.signal.aborted) return;

      // Ensure session uses the resolved LobsterAI model before sending prompt.
      if (modelSelection) {
        await selectModelWithReasoningFallback(client, {
          sessionId: dshSessionId,
          provider: modelSelection.provider,
          model: modelSelection.model,
          reasoningEffort: modelSelection.reasoningEffort,
        });
        if (abortController.signal.aborted) return;
      }

      // Cancel any previous turn watcher on this session before starting a fresh one.
      const prevTurn = this.activeTurns.get(sessionId);
      if (prevTurn) {
        prevTurn.abortController.abort(new Error('Replaced by newer turn'));
      }

      const turn: ActiveTurnState = {
        coworkSessionId: sessionId,
        dshSessionId,
        userMessageId: turnUserMessage?.id,
        traceId: llmTrace.traceId,
        abortController,
        confirmationMode: params.confirmationMode,
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
        lastCommittedAssistantSeq: null,
        toolCallMessageIds: new Map(),
        subagentIdsByName: new Map(),
        subagentTasksByCall: new Map(),
        pendingSubagentResults: new Set(),
        turnCompleted: false,
        turnError: null,
        turnAborted: false,
        ignoreStaleAbortedTurnEnd: hadPriorCancel,
      };
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

      const turnPrefix = [lazyBridgePrefix, params.mediaInstruction].filter(Boolean).join('\n\n');
      const contentParts = buildPromptContentParts(prompt, turnPrefix, params.imageAttachments);
      const streamTask = this.consumeFollowStream(turn, followStream);

      const clientTimeZone = resolveLocalTimeZone();
      try {
        await client.promptSession({
          sessionId: dshSessionId,
          requestId: params.requestId || randomUUID(),
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

      if (turn.abortController.signal.aborted) return;

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
      this.store.updateSession(coworkSessionId, { status: 'completed' });
      this.emit('sessionStatus', coworkSessionId, 'completed');
      this.emit('complete', coworkSessionId, formatStoredDshSessionId(dshSessionId));
    } catch (error) {
      if (turn.abortController.signal.aborted) return;
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
      turn.ignoreStaleAbortedTurnEnd = false;
      const inner = frame.frame as Record<string, unknown> | undefined;
      if (!inner || typeof inner !== 'object') return false;

      if (inner.type === 'start') {
        // Lazily create thinking/assistant rows when actual deltas arrive so
        // tool-only steps and failed retry attempts never leave empty rows.
        return false;
      }

      if (inner.type === 'chunk') {
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

      if (evType === DshChildEvent.Catalog) {
        const id = this.subagentSessions?.observeCatalog(coworkSessionId, data);
        if (id && typeof data.name === 'string') turn.subagentIdsByName.set(data.name, id);
        return false;
      }
      if (evType === DshChildEvent.User) {
        turn.ignoreStaleAbortedTurnEnd = false;
        this.subagentSessions?.observeNotice(coworkSessionId, data, ev.time);
        const source = record(data.source);
        if (source.kind === DshChildEvent.Settled && typeof source.senderSessionId === 'string') {
          turn.pendingSubagentResults.delete(formatStoredDshSessionId(source.senderSessionId));
        }
        return false;
      }

      if (evType === 'turn/start') {
        turn.ignoreStaleAbortedTurnEnd = false;
        return false;
      }

      if (evType === 'tool/call') {
        turn.ignoreStaleAbortedTurnEnd = false;
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
        const messageObj = data.message as Record<string, unknown> | undefined;
        const callId = String(messageObj?.callId ?? messageObj?.toolCallId ?? data.callId ?? '');
        const text = extractTextFromContentBlocks(messageObj?.content ?? data.content);
        const resultMeta = record(data.meta);
        const hostResult = record(resultMeta.lobsterToolResult);
        const isError = Boolean(hostResult.isError || messageObj?.isError || data.isError);
        const subagentRunId = resultMeta.kind === DshChildEvent.Activation && typeof resultMeta.name === 'string'
          ? turn.subagentIdsByName.get(resultMeta.name) : undefined;
        const task = turn.subagentTasksByCall.get(callId);
        if (subagentRunId && task !== undefined && !isError) turn.pendingSubagentResults.add(subagentRunId);
        if (subagentRunId && task) this.subagentSessions?.setTask(coworkSessionId, subagentRunId, task);
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
        turn.ignoreStaleAbortedTurnEnd = false;
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
              ...(seq !== undefined ? { seq } : {}),
            };
            this.store.updateMessageContent(coworkSessionId, msgId, finalText, meta);
            this.emit('messageUpdate', coworkSessionId, msgId, finalText, meta);
          }
        } else if (text) {
          if (turn.reusableAssistantMessageId) {
            const msgId = turn.reusableAssistantMessageId;
            turn.reusableAssistantMessageId = null;
            const meta: Record<string, unknown> = {
              isStreaming: false,
              ...(seq !== undefined ? { seq } : {}),
            };
            this.store.updateMessageContent(coworkSessionId, msgId, text, meta);
            this.emit('messageUpdate', coworkSessionId, msgId, text, meta);
          } else {
            const msg = this.store.addMessage(coworkSessionId, {
              type: 'assistant',
              content: text,
              metadata: {
                ...(seq !== undefined ? { seq } : {}),
              },
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
        turn.lastCommittedAssistantSeq = null;
        return false;
      }

      if (evType === 'compaction/start') {
        this.emit('contextMaintenance', coworkSessionId, true);
        return false;
      }

      if (evType === 'compaction/end') {
        this.emit('contextMaintenance', coworkSessionId, false);
        return false;
      }

      if (evType === 'turn/end') {
        const turnError = extractTurnEndError(data.reason);
        if (turnError) {
          turn.ignoreStaleAbortedTurnEnd = false;
          turn.turnError = turnError;
        } else if (isAbortedTurnEndReason(data.reason)) {
          if (turn.ignoreStaleAbortedTurnEnd) {
            turn.ignoreStaleAbortedTurnEnd = false;
            return false;
          }
          turn.turnAborted = true;
        } else {
          turn.ignoreStaleAbortedTurnEnd = false;
          // A model can yield the native turn after delegating. Each child's settlement
          // schedules another parent turn on this same stream.
          if (turn.pendingSubagentResults.size > 0) return false;
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
      ...(seq !== undefined ? { seq } : {}),
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
    if (!img || typeof img.base64Data !== 'string' || !img.base64Data) continue;
    parts.push({
      type: 'image',
      mediaType: img.mimeType || 'image/png',
      data: img.base64Data,
    });
  }
  return parts;
}

function parseProviderModelRef(ref: string): DshModelSelection | null {
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx >= ref.length - 1) return null;
  return {
    provider: ref.slice(0, idx),
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

function extractGoalFromProjections(projections: Record<string, unknown> | null): CoworkGoal | null {
  if (!projections || typeof projections !== 'object') return null;
  const values = (projections.values as Record<string, unknown> | undefined) ?? projections;
  const raw = values.goal as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string'
    ? raw.text
    : typeof raw.objective === 'string'
      ? raw.objective
      : '';
  if (!text) return null;
  const now = Date.now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `goal-${now}`,
    objective: text,
    status: raw.status === CoworkGoalStatus.Complete || raw.status === 'completed'
      ? CoworkGoalStatus.Complete
      : raw.status === CoworkGoalStatus.Paused || raw.status === 'cancelled'
        ? CoworkGoalStatus.Paused
        : CoworkGoalStatus.Active,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: now,
    tokensUsed: typeof raw.tokensUsed === 'number' ? raw.tokensUsed : 0,
  };
}
