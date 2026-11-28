import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import { ASK_USER_QUESTION_TOOL_NAME, CoworkForkMode } from '../../../shared/cowork/constants';
import {
  buildCoworkImageAttachmentPreviews,
  type CoworkImageAttachmentPayload,
  stripDataUrlPrefix,
} from '../../../shared/cowork/imageAttachments';
import type { CoworkTurnUsage } from '../../../shared/cowork/llmTurnUsage';
import { buildSelectedTextPromptSection, type CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import {
  type CoworkSideChat,
  type CoworkSideChatMessage,
  CoworkSideChatMessageType,
  type CoworkSideChatPermissionRequest,
  type CoworkSideChatPermissionResult,
  CoworkSideChatStatus,
  type CoworkSideChatStreamMessageEvent,
  type CoworkSideChatStreamMessageUpdateEvent,
  type CoworkSideChatStreamMetaChangedEvent,
  type CoworkSideChatStreamPermissionResolvedEvent,
  type CoworkSideChatStreamStatusEvent,
  type CoworkSideChatSummary,
  normalizeCoworkSideChatTitle,
} from '../../../shared/cowork/sideChat';
import { CoworkTurnOutcome } from '../../../shared/cowork/turnOutcome';
import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_APPROVAL_REQUEST_ID_PREFIX,
  DSH_QUESTION_REQUEST_ID_PREFIX,
  DSH_SESSION_ID_PREFIX,
  DshPermissionPreset,
  parseDshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import { canonicalizeDshProviderId } from '../../../shared/providers';
import type { CoworkSideChatStore } from '../../coworkSideChatStore';
import type { CoworkForkSessionOptions, CoworkMessage, CoworkSession } from '../../coworkStore';
import type { DshAdapterSessionRecord, DshModelSelection } from '../agentEngine/dshRuntimeAdapter';
import { createCoworkLlmTrace } from '../llmTrace';
import { registerLlmUsageContext } from '../llmUsageContext';
import type { DshHostManager, DshHostSessionContext } from './dshHostManager';
import { DshStreamUpdateThrottler } from './dshStreamUpdateThrottler';
import { record } from './dshSubagentHistory';
import type { DshPromptPart, DshTypertClient, DshWaterfallEvent, DshWaterfallOutcome } from './dshTypertClient';

const DEFAULT_SIDE_CHAT_TITLE_PREFIX = 'Side chat';
const FALLBACK_PARENT_CONTEXT_MAX_MESSAGES = 12;
const FALLBACK_PARENT_CONTEXT_MAX_CHARS = 12_000;

export interface DshSideChatCoworkStorePort {
  getSession(sessionId: string, messageLimit?: number): (DshAdapterSessionRecord & { messages?: CoworkMessage[] }) | null | undefined;
  forkSession?: (options: CoworkForkSessionOptions) => CoworkSession;
  addMessage(
    sessionId: string,
    message: {
      type: CoworkMessage['type'];
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): CoworkMessage;
  updateSession(
    sessionId: string,
    updates: { claudeSessionId?: string | null },
    options?: { touchUpdatedAt?: boolean },
  ): void;
}

export interface DshSideChatTurnFinishedEvent {
  parentSessionId: string;
  sideChatId: string;
  userMessageId: string;
  traceId: string;
  stopped: boolean;
}

export interface DshSideChatManagerDeps {
  sideChatStore: CoworkSideChatStore;
  coworkStore: DshSideChatCoworkStorePort;
  hostManager: Pick<
    DshHostManager,
    'isReady' | 'start' | 'getClient' | 'bindSessionContext' | 'deleteSessionFiles'
  > & {
    hasLiveHost?: () => boolean;
  };
  resolveModelSelection?: (
    sessionId: string,
    modelOverride?: string | null,
    thinkingLevel?: string | null,
  ) => Promise<DshModelSelection | null> | DshModelSelection | null;
  resolveAllowedSkillIds?: (sessionId: string, agentId: string) => string[] | null;
  resolveDefaultPermissionPreset?: () => DshPermissionPreset;
  resolveParentDshSessionId?: (parentSessionId: string) => string | null;
  ensureHostReadyClient?: () => Promise<DshTypertClient>;
  onTurnFinished?: (event: DshSideChatTurnFinishedEvent) => void;
}

interface ActiveSideChatTurn {
  parentSessionId: string;
  sideChatId: string;
  dshSessionId: string;
  userMessageId: string;
  userMessageContent: string;
  traceId: string;
  resolvedModelMeta: {
    model?: string;
    resolvedModelId?: string;
    modelPresetId?: string;
  } | null;
  abortController: AbortController;
  currentThinkingMessageId: string | null;
  currentThinkingText: string;
  currentAssistantMessageId: string | null;
  currentAssistantText: string;
  lastFinalizedThinkingMessageId: string | null;
  lastFinalizedThinkingText: string;
  lastFinalizedAssistantMessageId: string | null;
  lastFinalizedAssistantText: string;
  turnError: string | null;
  turnAborted: boolean;
}

interface PendingSideChatInteraction {
  requestId: string;
  parentSessionId: string;
  sideChatId: string;
  dshSessionId: string;
  kind: 'approval' | 'user-questions';
  request: CoworkSideChatPermissionRequest;
  resolve: (outcome: DshWaterfallOutcome) => void;
}

export interface DshSideChatEvents {
  message: (event: CoworkSideChatStreamMessageEvent) => void;
  messageUpdate: (event: CoworkSideChatStreamMessageUpdateEvent) => void;
  status: (event: CoworkSideChatStreamStatusEvent) => void;
  metaChanged: (event: CoworkSideChatStreamMetaChangedEvent) => void;
  permissionRequest: (request: CoworkSideChatPermissionRequest) => void;
  permissionResolved: (event: CoworkSideChatStreamPermissionResolvedEvent) => void;
}

function stripDshPrefix(stored: string | null | undefined): string | null {
  if (!stored || typeof stored !== 'string') return null;
  const trimmed = stored.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(DSH_SESSION_ID_PREFIX)
    ? trimmed.slice(DSH_SESSION_ID_PREFIX.length)
    : trimmed;
}

function formatStoredDshId(raw: string): string {
  return raw.startsWith(DSH_SESSION_ID_PREFIX) ? raw : `${DSH_SESSION_ID_PREFIX}${raw}`;
}

function extractStreamChunkDelta(chunk: Record<string, unknown> | undefined): string {
  if (!chunk) return '';
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.delta === 'string') return chunk.delta;
  return '';
}

function extractTextFromContentBlocks(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('');
}

function extractReasoningFromContentBlocks(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if ((item.type === 'reasoning' || item.type === 'thinking') && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('');
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw };
    }
  }
  return {};
}

function isFailedAssistantStreamOutcome(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== 'object') return false;
  const kind = (outcome as { kind?: unknown }).kind;
  return kind === 'failed' || kind === 'error' || kind === 'aborted' || kind === 'abandoned';
}

function extractTurnEndError(reason: unknown): { error: string | null; aborted: boolean } {
  if (!reason || typeof reason !== 'object') return { error: null, aborted: false };
  const obj = reason as Record<string, unknown>;
  if (obj.kind === 'aborted') {
    return { error: null, aborted: true };
  }
  if (obj.kind === 'error') {
    const err = obj.error as Record<string, unknown> | undefined;
    const msg = typeof err?.message === 'string' && err.message.trim()
      ? err.message.trim()
      : 'Side chat turn failed';
    return { error: msg, aborted: false };
  }
  return { error: null, aborted: false };
}

function isErrorCode(error: unknown, expectedCode: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code === expectedCode) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(expectedCode);
}

function cancelledInteraction(kind: 'approval' | 'user-questions'): DshWaterfallOutcome {
  return kind === 'approval'
    ? { kind: 'result', value: 'rejected' }
    : { kind: 'rejected', error: { name: 'UserQuestionError', code: 'CANCELLED', message: 'Side chat cancelled.' } };
}

function buildFallbackParentSnapshotPreamble(messages: CoworkMessage[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const lines: string[] = [];
  let totalChars = 0;
  const recent = messages
    .filter((m) => (m.type === 'user' || m.type === 'assistant') && !m.metadata?.isThinking && m.content.trim().length > 0)
    .slice(-FALLBACK_PARENT_CONTEXT_MAX_MESSAGES);

  for (const msg of recent) {
    const roleLabel = msg.type === 'user' ? 'User' : 'Assistant';
    const text = msg.content.trim().slice(0, 2_000);
    const entry = `${roleLabel}: ${text}`;
    if (totalChars + entry.length > FALLBACK_PARENT_CONTEXT_MAX_CHARS) break;
    lines.push(entry);
    totalChars += entry.length;
  }
  if (lines.length === 0) return '';
  return [
    '<parent-conversation-snapshot>',
    'Reference context from the main conversation (do not continue or execute tasks from it):',
    lines.join('\n\n'),
    '</parent-conversation-snapshot>',
  ].join('\n');
}

function buildPriorSideChatReplayPreamble(messages: CoworkSideChatMessage[]): string {
  const recent = messages
    .filter((m) => (m.type === CoworkSideChatMessageType.User || m.type === CoworkSideChatMessageType.Assistant)
      && !m.metadata?.isThinking
      && m.content.trim().length > 0)
    .slice(-10);
  if (recent.length === 0) return '';
  const body = recent
    .map((m) => `${m.type === CoworkSideChatMessageType.User ? 'User' : 'Assistant'}: ${m.content.trim().slice(0, 2_000)}`)
    .join('\n\n');
  return `<previous-side-chat-turns>\n${body}\n</previous-side-chat-turns>`;
}

function extractLastEventSeq(eventsResponse: Record<string, unknown> | null | undefined): number | null {
  if (!eventsResponse || typeof eventsResponse !== 'object') return null;
  const records = Array.isArray(eventsResponse.records)
    ? eventsResponse.records
    : Array.isArray(eventsResponse.events)
      ? eventsResponse.events
      : [];
  let maxSeq: number | null = null;
  for (const item of records) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const ev = (rec.event && typeof rec.event === 'object' ? rec.event : rec) as Record<string, unknown>;
    if (typeof ev.seq === 'number' && Number.isInteger(ev.seq) && ev.seq >= 0) {
      maxSeq = maxSeq === null ? ev.seq : Math.max(maxSeq, ev.seq);
    }
  }
  return maxSeq;
}

export class DshSideChatManager extends EventEmitter {
  private readonly sideChatStore: CoworkSideChatStore;
  private readonly coworkStore: DshSideChatCoworkStorePort;
  private readonly hostManager: DshSideChatManagerDeps['hostManager'];
  private readonly resolveModelSelection?: DshSideChatManagerDeps['resolveModelSelection'];
  private readonly resolveAllowedSkillIds?: DshSideChatManagerDeps['resolveAllowedSkillIds'];
  private readonly resolveDefaultPermissionPreset?: DshSideChatManagerDeps['resolveDefaultPermissionPreset'];
  private readonly resolveParentDshSessionId?: DshSideChatManagerDeps['resolveParentDshSessionId'];
  private readonly ensureHostReadyClient?: DshSideChatManagerDeps['ensureHostReadyClient'];
  private readonly onTurnFinished?: DshSideChatManagerDeps['onTurnFinished'];

  private readonly activeTurns = new Map<string, ActiveSideChatTurn>();
  private readonly dshToSideChat = new Map<string, { parentSessionId: string; sideChatId: string }>();
  private readonly pendingInteractions = new Map<string, PendingSideChatInteraction>();
  private readonly streamUpdateThrottler: DshStreamUpdateThrottler<{
    sessionId: string;
    parentSessionId: string;
    messageId: string;
    content: string;
    metadata: Record<string, unknown>;
  }>;

  constructor(deps: DshSideChatManagerDeps) {
    super();
    this.sideChatStore = deps.sideChatStore;
    this.coworkStore = deps.coworkStore;
    this.hostManager = deps.hostManager;
    this.resolveModelSelection = deps.resolveModelSelection;
    this.resolveAllowedSkillIds = deps.resolveAllowedSkillIds;
    this.resolveDefaultPermissionPreset = deps.resolveDefaultPermissionPreset;
    this.resolveParentDshSessionId = deps.resolveParentDshSessionId;
    this.ensureHostReadyClient = deps.ensureHostReadyClient;
    this.onTurnFinished = deps.onTurnFinished;
    this.streamUpdateThrottler = new DshStreamUpdateThrottler({
      onPersist: ({ sessionId, messageId, content, metadata }) => {
        this.sideChatStore.updateMessageContent(sessionId, messageId, content, metadata);
      },
      onEmit: ({ parentSessionId, sessionId, messageId, content, metadata }) => {
        this.emit('messageUpdate', {
          parentSessionId,
          sideChatId: sessionId,
          messageId,
          content,
          metadata,
        });
      },
    });
  }

  isSideChatActive(sideChatId: string): boolean {
    return this.activeTurns.has(sideChatId);
  }

  emitTurnUsageUpdate(sideChatId: string, messageId: string, turnUsage: CoworkTurnUsage): void {
    const summary = this.sideChatStore.getSideChatSummary(sideChatId);
    const message = this.sideChatStore.getMessage(sideChatId, messageId);
    if (!summary || !message) return;
    this.emit('messageUpdate', {
      parentSessionId: summary.parentSessionId,
      sideChatId,
      messageId,
      content: message.content,
      metadata: { turnUsage },
    });
  }

  override on<K extends keyof DshSideChatEvents>(event: K, listener: DshSideChatEvents[K]): this {
    return super.on(event, listener);
  }

  override off<K extends keyof DshSideChatEvents>(event: K, listener: DshSideChatEvents[K]): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof DshSideChatEvents>(
    event: K,
    ...args: Parameters<DshSideChatEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  listSideChats(parentSessionId: string): CoworkSideChatSummary[] {
    return this.sideChatStore.listSideChats(parentSessionId);
  }

  getSideChat(sideChatId: string): {
    sideChat: CoworkSideChat | null;
    pendingPermissions: CoworkSideChatPermissionRequest[];
  } {
    const sideChat = this.sideChatStore.getSideChat(sideChatId);
    if (sideChat?.dshSessionId) {
      this.dshToSideChat.set(sideChat.dshSessionId, {
        parentSessionId: sideChat.parentSessionId,
        sideChatId: sideChat.id,
      });
    }
    const pendingPermissions = [...this.pendingInteractions.values()]
      .filter((item) => item.sideChatId === sideChatId)
      .map((item) => item.request);
    return { sideChat, pendingPermissions };
  }

  createSideChat(options: {
    parentSessionId: string;
    title?: string;
    forkedFromMessageId?: string | null;
  }): CoworkSideChat {
    const parent = this.coworkStore.getSession(options.parentSessionId, 0);
    if (!parent) {
      throw new Error(`Parent session ${options.parentSessionId} not found`);
    }
    const existingCount = this.sideChatStore.listSideChats(options.parentSessionId).length;
    const defaultTitle = `${DEFAULT_SIDE_CHAT_TITLE_PREFIX} ${existingCount + 1}`;
    const created = this.sideChatStore.createSideChat({
      parentSessionId: options.parentSessionId,
      title: options.title?.trim() || defaultTitle,
      forkedFromMessageId: options.forkedFromMessageId ?? null,
    });
    const summary: CoworkSideChatSummary = {
      id: created.id,
      parentSessionId: created.parentSessionId,
      dshSessionId: created.dshSessionId,
      title: created.title,
      status: created.status,
      forkedFromMessageId: created.forkedFromMessageId,
      forkedAtSeq: created.forkedAtSeq,
      lastError: created.lastError,
      messageCount: created.messageCount,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
    this.emit('metaChanged', { parentSessionId: created.parentSessionId, sideChat: summary });
    return created;
  }

  async sendMessage(options: {
    parentSessionId: string;
    sideChatId: string;
    prompt: string;
    displayPrompt?: string;
    selectedTextSnippets?: CoworkSelectedTextSnippet[];
    imageAttachments?: CoworkImageAttachmentPayload[];
    modelOverride?: string | null;
    thinkingLevel?: string | null;
  }): Promise<void> {
    const sideChat = this.sideChatStore.getSideChat(options.sideChatId);
    if (!sideChat || sideChat.parentSessionId !== options.parentSessionId) {
      throw new Error(`Side chat ${options.sideChatId} not found`);
    }
    if (this.activeTurns.has(options.sideChatId)) {
      throw new Error('Side chat is already running a turn');
    }

    const parent = this.coworkStore.getSession(options.parentSessionId, 40);
    if (!parent) {
      throw new Error(`Parent session ${options.parentSessionId} not found`);
    }

    const trimmedPrompt = options.prompt.trim();
    const snippets = options.selectedTextSnippets ?? [];
    const imageAttachments = options.imageAttachments ?? [];
    const selectedTextSection = buildSelectedTextPromptSection(snippets);
    if (!trimmedPrompt && !selectedTextSection && imageAttachments.length === 0) {
      throw new Error('Side chat prompt cannot be empty');
    }

    const displayText = (options.displayPrompt ?? trimmedPrompt).trim();
    const llmTrace = createCoworkLlmTrace();
    const imagePreviews = buildCoworkImageAttachmentPreviews(imageAttachments);
    const userMetadata: Record<string, unknown> = {
      llmTrace,
    };
    if (snippets.length > 0) {
      userMetadata.selectedTextSnippets = snippets;
    }
    if (imagePreviews && imagePreviews.length > 0) {
      userMetadata.imageAttachments = imagePreviews;
    }
    const userMessage = this.sideChatStore.addMessage(sideChat.id, {
      type: CoworkSideChatMessageType.User,
      content: displayText,
      metadata: userMetadata,
    });
    this.emit('message', {
      parentSessionId: sideChat.parentSessionId,
      sideChatId: sideChat.id,
      message: userMessage,
    });

    const runningSummary = this.sideChatStore.updateSideChat(sideChat.id, {
      status: CoworkSideChatStatus.Running,
      lastError: null,
    });
    this.emit('status', {
      parentSessionId: sideChat.parentSessionId,
      sideChatId: sideChat.id,
      status: CoworkSideChatStatus.Running,
      error: null,
    });
    if (runningSummary) {
      this.emit('metaChanged', {
        parentSessionId: sideChat.parentSessionId,
        sideChat: runningSummary,
      });
    }

    const abortController = new AbortController();
    const turn: ActiveSideChatTurn = {
      parentSessionId: sideChat.parentSessionId,
      sideChatId: sideChat.id,
      dshSessionId: sideChat.dshSessionId ?? '',
      userMessageId: userMessage.id,
      userMessageContent: displayText,
      traceId: llmTrace.traceId,
      resolvedModelMeta: null,
      abortController,
      currentThinkingMessageId: null,
      currentThinkingText: '',
      currentAssistantMessageId: null,
      currentAssistantText: '',
      lastFinalizedThinkingMessageId: null,
      lastFinalizedThinkingText: '',
      lastFinalizedAssistantMessageId: null,
      lastFinalizedAssistantText: '',
      turnError: null,
      turnAborted: false,
    };
    this.activeTurns.set(sideChat.id, turn);

    void this.runTurnAsync(turn, sideChat, parent, trimmedPrompt, selectedTextSection, {
      imageAttachments,
      modelOverride: options.modelOverride,
      thinkingLevel: options.thinkingLevel,
    });
  }

  async stopSideChat(sideChatId: string): Promise<boolean> {
    const turn = this.activeTurns.get(sideChatId);
    this.cancelPendingPermissionsForSideChat(sideChatId);

    if (!turn) {
      this.streamUpdateThrottler.clearSession(sideChatId);
      const existing = this.sideChatStore.getSideChatSummary(sideChatId);
      if (existing?.status === CoworkSideChatStatus.Running) {
        const updated = this.sideChatStore.updateSideChat(sideChatId, { status: CoworkSideChatStatus.Idle });
        this.emit('status', {
          parentSessionId: existing.parentSessionId,
          sideChatId,
          status: CoworkSideChatStatus.Idle,
        });
        if (updated) {
          this.emit('metaChanged', { parentSessionId: existing.parentSessionId, sideChat: updated });
        }
      }
      return false;
    }

    turn.turnAborted = true;
    turn.abortController.abort(new Error('Side chat stopped by user'));
    this.finalizeActiveMessages(turn);
    this.streamUpdateThrottler.clearSession(sideChatId);
    this.activeTurns.delete(sideChatId);
    this.stampUserTurnMetadata(turn, { turnOutcome: CoworkTurnOutcome.Stopped });

    if (turn.dshSessionId) {
      await this.cancelDshSessionBestEffort(turn.dshSessionId);
    }

    const updated = this.sideChatStore.updateSideChat(sideChatId, {
      status: CoworkSideChatStatus.Idle,
      lastError: null,
    });
    this.emit('status', {
      parentSessionId: turn.parentSessionId,
      sideChatId,
      status: CoworkSideChatStatus.Idle,
      error: null,
    });
    if (updated) {
      this.emit('metaChanged', { parentSessionId: turn.parentSessionId, sideChat: updated });
    }
    this.onTurnFinished?.({
      parentSessionId: turn.parentSessionId,
      sideChatId,
      userMessageId: turn.userMessageId,
      traceId: turn.traceId,
      stopped: true,
    });
    return true;
  }

  stopAll(): void {
    for (const sideChatId of [...this.activeTurns.keys()]) {
      void this.stopSideChat(sideChatId);
    }
    this.streamUpdateThrottler.clearAll();
  }

  renameSideChat(sideChatId: string, title: string): CoworkSideChatSummary {
    const normalized = normalizeCoworkSideChatTitle(title);
    if (!normalized) {
      throw new Error('Side chat title cannot be empty');
    }
    const updated = this.sideChatStore.updateSideChat(sideChatId, { title: normalized });
    if (!updated) {
      throw new Error(`Side chat ${sideChatId} not found`);
    }
    this.emit('metaChanged', {
      parentSessionId: updated.parentSessionId,
      sideChat: updated,
    });
    return updated;
  }

  async deleteSideChat(sideChatId: string): Promise<boolean> {
    await this.stopSideChat(sideChatId);
    const deleted = this.sideChatStore.deleteSideChat(sideChatId);
    if (!deleted) return false;

    if (deleted.dshSessionId) {
      this.dshToSideChat.delete(deleted.dshSessionId);
      await this.hostManager.deleteSessionFiles(deleted.dshSessionId).catch((): void => undefined);
    }
    this.emit('metaChanged', {
      parentSessionId: deleted.parentSessionId,
      sideChat: deleted,
      deleted: true,
    });
    return true;
  }

  async deleteSideChatsForParent(parentSessionId: string): Promise<void> {
    const existing = this.sideChatStore.listSideChats(parentSessionId);
    for (const item of existing) {
      if (this.activeTurns.has(item.id)) {
        await this.stopSideChat(item.id);
      } else {
        this.cancelPendingPermissionsForSideChat(item.id);
      }
    }
    const deleted = this.sideChatStore.deleteSideChatsByParentSession(parentSessionId);
    for (const item of deleted) {
      if (item.dshSessionId) {
        this.dshToSideChat.delete(item.dshSessionId);
        void this.hostManager.deleteSessionFiles(item.dshSessionId).catch((): void => undefined);
      }
      this.emit('metaChanged', {
        parentSessionId,
        sideChat: item,
        deleted: true,
      });
    }
  }

  async promoteSideChat(parentSessionId: string, sideChatId: string): Promise<CoworkSession> {
    if (this.activeTurns.has(sideChatId)) {
      throw new Error('Wait for the side chat to finish before promoting it to a conversation');
    }
    const sideChat = this.sideChatStore.getSideChat(sideChatId);
    if (!sideChat || sideChat.parentSessionId !== parentSessionId) {
      throw new Error(`Side chat ${sideChatId} not found`);
    }
    if (sideChat.messages.length === 0) {
      throw new Error('Cannot promote an empty side chat');
    }

    const parent = this.coworkStore.getSession(parentSessionId, 0);
    if (!parent) {
      throw new Error(`Parent session ${parentSessionId} not found`);
    }

    if (!this.coworkStore.forkSession) {
      throw new Error('Conversation fork is not supported by the current store');
    }

    const promoted = this.coworkStore.forkSession({
      sourceSessionId: parentSessionId,
      forkMode: CoworkForkMode.Conversation,
      forkedFromMessageId: sideChat.forkedFromMessageId ?? undefined,
      title: sideChat.title,
    });

    for (const msg of sideChat.messages) {
      const safeMeta = msg.metadata
        ? { ...msg.metadata, isStreaming: false }
        : undefined;
      this.coworkStore.addMessage(promoted.id, {
        type: msg.type,
        content: msg.content,
        metadata: safeMeta,
      });
    }

    if (sideChat.dshSessionId) {
      try {
        const client = await this.getReadyClient();
        const forked = await client.forkSession({ sessionId: sideChat.dshSessionId });
        const promotedDshId = forked.sessionId;
        await this.hostManager.bindSessionContext({
          sessionId: promotedDshId,
          sideChat: false,
          coworkSessionId: promoted.id,
          agentId: parent.agentId || 'main',
          workspaceDir: parent.cwd,
        });
        const storedId = formatStoredDshId(promotedDshId);
        this.coworkStore.updateSession(promoted.id, { claudeSessionId: storedId }, { touchUpdatedAt: false });
        promoted.claudeSessionId = storedId;
      } catch (error) {
        console.warn(
          `[DshSideChat] Failed to fork native DSH session when promoting ${sideChatId}; promoted session will resume from local history:`,
          error,
        );
      }
    }

    return promoted;
  }

  resolveSideChatOwner(dshSessionId: string): { parentSessionId: string; sideChatId: string } | null {
    const cached = this.dshToSideChat.get(dshSessionId);
    if (cached) return cached;

    for (const turn of this.activeTurns.values()) {
      if (turn.dshSessionId === dshSessionId) {
        const owner = { parentSessionId: turn.parentSessionId, sideChatId: turn.sideChatId };
        this.dshToSideChat.set(dshSessionId, owner);
        return owner;
      }
    }

    const persisted = this.sideChatStore.findByDshSessionId(dshSessionId);
    if (persisted) {
      const owner = { parentSessionId: persisted.parentSessionId, sideChatId: persisted.id };
      this.dshToSideChat.set(dshSessionId, owner);
      return owner;
    }
    return null;
  }

  handleWaterfall(
    kind: 'approval' | 'user-questions',
    evt: DshWaterfallEvent,
    owner: { parentSessionId: string; sideChatId: string },
    enrichToolInput?: (
      toolName: string,
      rawRequest: Record<string, unknown>,
      callId: string | null,
      parentSessionId: string,
    ) => Record<string, unknown>,
  ): Promise<DshWaterfallOutcome> {
    const requestId = `${kind === 'approval' ? DSH_APPROVAL_REQUEST_ID_PREFIX : DSH_QUESTION_REQUEST_ID_PREFIX}sc-${evt.eventId}`;
    const toolName = kind === 'approval'
      ? String(evt.request.toolName ?? 'tool')
      : ASK_USER_QUESTION_TOOL_NAME;
    const callId = typeof evt.request.callId === 'string' ? evt.request.callId : null;
    const toolInput = kind === 'approval' && enrichToolInput
      ? enrichToolInput(toolName, evt.request, callId, owner.parentSessionId)
      : evt.request;

    const permissionRequest: CoworkSideChatPermissionRequest = {
      parentSessionId: owner.parentSessionId,
      sideChatId: owner.sideChatId,
      requestId,
      toolName,
      toolInput,
      toolUseId: callId,
    };

    return new Promise<DshWaterfallOutcome>((resolve) => {
      const pending: PendingSideChatInteraction = {
        requestId,
        parentSessionId: owner.parentSessionId,
        sideChatId: owner.sideChatId,
        dshSessionId: evt.agentId,
        kind,
        request: permissionRequest,
        resolve,
      };
      this.pendingInteractions.set(requestId, pending);

      const onAbort = () => {
        if (this.pendingInteractions.delete(requestId)) {
          resolve(cancelledInteraction(kind));
          this.emit('permissionResolved', {
            parentSessionId: owner.parentSessionId,
            sideChatId: owner.sideChatId,
            requestId,
          });
        }
      };
      evt.signal.addEventListener('abort', onAbort, { once: true });

      this.emit('permissionRequest', permissionRequest);
    });
  }

  respondToPermission(requestId: string, result: CoworkSideChatPermissionResult): boolean {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) return false;
    this.pendingInteractions.delete(requestId);

    if (pending.kind === 'approval') {
      const outcomeValue = result.behavior === 'allow' ? 'allowed-once' : 'rejected';
      pending.resolve({ kind: 'result', value: outcomeValue });
    } else if (result.behavior !== 'allow') {
      pending.resolve(cancelledInteraction(pending.kind));
    } else if (Array.isArray(result.updatedInput?.answers)) {
      pending.resolve({ kind: 'result', value: { answers: result.updatedInput.answers } });
    } else {
      pending.resolve({
        kind: 'rejected',
        error: { name: 'UserQuestionError', code: 'BAD_ANSWER', message: 'Expected answers keyed by question ID.' },
      });
    }

    this.emit('permissionResolved', {
      parentSessionId: pending.parentSessionId,
      sideChatId: pending.sideChatId,
      requestId,
    });
    return true;
  }

  // ── Internal Execution ─────────────────────────────────────────────────────

  private async runTurnAsync(
    turn: ActiveSideChatTurn,
    sideChat: CoworkSideChat,
    parent: DshAdapterSessionRecord & { messages?: CoworkMessage[] },
    trimmedPrompt: string,
    selectedTextSection: string,
    turnOptions?: {
      imageAttachments?: CoworkImageAttachmentPayload[];
      modelOverride?: string | null;
      thinkingLevel?: string | null;
    },
  ): Promise<void> {
    try {
      const client = await this.getReadyClient();
      if (turn.abortController.signal.aborted) return;

      let { dshSessionId, fallbackPreamble } = await this.ensureSideChatDshSession(
        client,
        sideChat,
        parent,
      );
      if (turn.abortController.signal.aborted) return;

      turn.dshSessionId = dshSessionId;
      this.dshToSideChat.set(dshSessionId, {
        parentSessionId: turn.parentSessionId,
        sideChatId: turn.sideChatId,
      });

      await this.bindContextAndModel(
        client,
        dshSessionId,
        parent,
        turn,
        turnOptions?.modelOverride,
        turnOptions?.thinkingLevel,
      );
      if (turn.abortController.signal.aborted) return;

      const imageAttachments = turnOptions?.imageAttachments ?? [];
      const fallbackText = selectedTextSection
        ? 'Analyze the selected text excerpt and answer it directly if it contains a question.'
        : imageAttachments.length > 0
          ? 'Analyze the attached image(s).'
          : '';
      const effectivePrompt = [
        fallbackPreamble,
        selectedTextSection,
        trimmedPrompt || fallbackText,
      ].filter(Boolean).join('\n\n');

      const buildContentParts = (text: string): DshPromptPart[] => {
        const parts: DshPromptPart[] = [];
        if (text.length > 0) {
          parts.push({ type: 'text', text });
        }
        for (const img of imageAttachments) {
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
      };

      const requestId = `sc-${randomUUID()}`;
      let followStream = client.followSession<Record<string, unknown>>(
        {
          address: { kind: 'session', sessionId: dshSessionId },
          assistantStream: true,
          activate: true,
        },
        turn.abortController.signal,
      );

      try {
        await client.promptSession({
          sessionId: dshSessionId,
          requestId,
          content: buildContentParts(effectivePrompt),
          mode: 'queue',
        });
      } catch (promptError) {
        // Cold DSH session files may have been pruned externally; recover once by
        // re-forking from parent and carrying prior side-chat turns as context.
        if (!sideChat.dshSessionId || !isErrorCode(promptError, 'session/not-found')) {
          throw promptError;
        }
        const recreated = await this.forkOrCreateSideChatDshSession(client, sideChat, parent);
        dshSessionId = recreated.dshSessionId;
        turn.dshSessionId = dshSessionId;
        this.dshToSideChat.set(dshSessionId, {
          parentSessionId: turn.parentSessionId,
          sideChatId: turn.sideChatId,
        });
        await this.bindContextAndModel(
          client,
          dshSessionId,
          parent,
          turn,
          turnOptions?.modelOverride,
          turnOptions?.thinkingLevel,
        );
        const replayPreamble = [
          recreated.fallbackPreamble,
          buildPriorSideChatReplayPreamble(sideChat.messages),
        ].filter(Boolean).join('\n\n');
        const recoveryPrompt = [replayPreamble, effectivePrompt].filter(Boolean).join('\n\n');
        followStream = client.followSession<Record<string, unknown>>(
          {
            address: { kind: 'session', sessionId: dshSessionId },
            assistantStream: true,
            activate: true,
          },
          turn.abortController.signal,
        );
        await client.promptSession({
          sessionId: dshSessionId,
          requestId: `sc-${randomUUID()}`,
          content: buildContentParts(recoveryPrompt),
          mode: 'queue',
        });
      }

      for await (const frame of followStream) {
        if (turn.abortController.signal.aborted) break;
        const done = this.handleFollowFrame(turn, frame);
        if (done) break;
      }

      if (turn.abortController.signal.aborted) return;

      this.finalizeActiveMessages(turn);
      if (this.activeTurns.get(turn.sideChatId) === turn) {
        this.activeTurns.delete(turn.sideChatId);
      }

      if (turn.turnError) {
        this.stampUserTurnMetadata(turn, { turnOutcome: CoworkTurnOutcome.Failed });
        const updated = this.sideChatStore.updateSideChat(turn.sideChatId, {
          status: CoworkSideChatStatus.Error,
          lastError: turn.turnError,
        });
        this.emit('status', {
          parentSessionId: turn.parentSessionId,
          sideChatId: turn.sideChatId,
          status: CoworkSideChatStatus.Error,
          error: turn.turnError,
        });
        if (updated) {
          this.emit('metaChanged', { parentSessionId: turn.parentSessionId, sideChat: updated });
        }
        this.onTurnFinished?.({
          parentSessionId: turn.parentSessionId,
          sideChatId: turn.sideChatId,
          userMessageId: turn.userMessageId,
          traceId: turn.traceId,
          stopped: false,
        });
        return;
      }

      this.stampUserTurnMetadata(turn, {
        turnOutcome: turn.turnAborted ? CoworkTurnOutcome.Stopped : CoworkTurnOutcome.Completed,
      });
      const updated = this.sideChatStore.updateSideChat(turn.sideChatId, {
        status: CoworkSideChatStatus.Idle,
        lastError: null,
      });
      this.emit('status', {
        parentSessionId: turn.parentSessionId,
        sideChatId: turn.sideChatId,
        status: CoworkSideChatStatus.Idle,
        error: null,
      });
      if (updated) {
        this.emit('metaChanged', { parentSessionId: turn.parentSessionId, sideChat: updated });
      }
      this.onTurnFinished?.({
        parentSessionId: turn.parentSessionId,
        sideChatId: turn.sideChatId,
        userMessageId: turn.userMessageId,
        traceId: turn.traceId,
        stopped: turn.turnAborted,
      });
    } catch (error) {
      if (turn.abortController.signal.aborted) return;
      this.finalizeActiveMessages(turn);
      if (this.activeTurns.get(turn.sideChatId) === turn) {
        this.activeTurns.delete(turn.sideChatId);
      }
      this.stampUserTurnMetadata(turn, { turnOutcome: CoworkTurnOutcome.Failed });
      const message = error instanceof Error ? error.message : String(error);
      const updated = this.sideChatStore.updateSideChat(turn.sideChatId, {
        status: CoworkSideChatStatus.Error,
        lastError: message,
      });
      this.emit('status', {
        parentSessionId: turn.parentSessionId,
        sideChatId: turn.sideChatId,
        status: CoworkSideChatStatus.Error,
        error: message,
      });
      if (updated) {
        this.emit('metaChanged', { parentSessionId: turn.parentSessionId, sideChat: updated });
      }
      this.onTurnFinished?.({
        parentSessionId: turn.parentSessionId,
        sideChatId: turn.sideChatId,
        userMessageId: turn.userMessageId,
        traceId: turn.traceId,
        stopped: false,
      });
    } finally {
      this.cancelPendingPermissionsForSideChat(turn.sideChatId);
    }
  }

  private async ensureSideChatDshSession(
    client: DshTypertClient,
    sideChat: CoworkSideChat,
    parent: DshAdapterSessionRecord & { messages?: CoworkMessage[] },
  ): Promise<{ dshSessionId: string; fallbackPreamble: string }> {
    if (sideChat.dshSessionId) {
      return { dshSessionId: sideChat.dshSessionId, fallbackPreamble: '' };
    }
    return this.forkOrCreateSideChatDshSession(client, sideChat, parent);
  }

  private async forkOrCreateSideChatDshSession(
    client: DshTypertClient,
    sideChat: CoworkSideChat,
    parent: DshAdapterSessionRecord & { messages?: CoworkMessage[] },
  ): Promise<{ dshSessionId: string; fallbackPreamble: string }> {
    const sourceDshId = this.resolveParentDshSessionId?.(parent.id)
      ?? stripDshPrefix(parent.claudeSessionId);

    let dshSessionId: string | null = null;
    let forkedAtSeq: number | null = sideChat.forkedAtSeq;
    let fallbackPreamble = '';

    if (sourceDshId) {
      try {
        const forked = await client.forkSession({ sessionId: sourceDshId });
        dshSessionId = forked.sessionId;
      } catch (forkError) {
        // When Turn 1 is still in progress there is no `turn/end` yet; try
        // explicit `atSeq` at the latest logged event so DSH `buildForkSeed`
        // closes the open turn cleanly.
        if (isErrorCode(forkError, 'session/fork-unavailable')) {
          try {
            const events = await client.getSessionEvents(sourceDshId, { maxMessages: 20 });
            const lastSeq = extractLastEventSeq(events);
            if (lastSeq !== null) {
              const forked = await client.forkSession({ sessionId: sourceDshId, atSeq: lastSeq });
              dshSessionId = forked.sessionId;
              forkedAtSeq = lastSeq;
            }
          } catch (openForkError) {
            console.warn(
              `[DshSideChat] Explicit atSeq fork fallback failed for parent ${parent.id}:`,
              openForkError,
            );
          }
        } else {
          console.warn(
            `[DshSideChat] Fork failed for parent ${parent.id}; falling back to snapshot session:`,
            forkError,
          );
        }
      }
    }

    if (!dshSessionId) {
      const created = await client.createSession({ cwd: parent.cwd });
      dshSessionId = created.sessionId;
      fallbackPreamble = buildFallbackParentSnapshotPreamble(parent.messages);
    }

    const updated = this.sideChatStore.updateSideChat(sideChat.id, {
      dshSessionId,
      forkedAtSeq,
    });
    if (updated) {
      this.emit('metaChanged', {
        parentSessionId: sideChat.parentSessionId,
        sideChat: updated,
      });
    }

    return { dshSessionId, fallbackPreamble };
  }

  private stampUserTurnMetadata(
    turn: ActiveSideChatTurn,
    metadataPatch: Record<string, unknown>,
  ): void {
    const updated = this.sideChatStore.updateMessageMetadata(
      turn.sideChatId,
      turn.userMessageId,
      metadataPatch,
    );
    if (!updated) return;
    this.emit('messageUpdate', {
      parentSessionId: turn.parentSessionId,
      sideChatId: turn.sideChatId,
      messageId: turn.userMessageId,
      content: updated.content,
      metadata: metadataPatch,
    });
  }

  private async bindContextAndModel(
    client: DshTypertClient,
    dshSessionId: string,
    parent: DshAdapterSessionRecord,
    turn: ActiveSideChatTurn,
    modelOverride?: string | null,
    thinkingLevelOverride?: string | null,
  ): Promise<void> {
    const agentId = parent.agentId || 'main';
    const allowedSkillIds = this.resolveAllowedSkillIds
      ? this.resolveAllowedSkillIds(parent.id, agentId)
      : null;
    const permissionPreset = parseDshPermissionPreset(parent.permissionPreset)
      ?? this.resolveDefaultPermissionPreset?.()
      ?? DEFAULT_DSH_PERMISSION_PRESET;

    const effectiveModelOverride = modelOverride?.trim() ? modelOverride.trim() : parent.modelOverride;
    const effectiveThinkingLevel = thinkingLevelOverride !== undefined
      ? thinkingLevelOverride
      : parent.thinkingLevel;
    const modelSelection = await this.resolveModelSelection?.(
      parent.id,
      effectiveModelOverride,
      effectiveThinkingLevel,
    );

    registerLlmUsageContext(turn.traceId, turn.sideChatId, turn.userMessageContent, {
      title: parent.title,
      modelPresetId: modelSelection?.modelPresetId ?? undefined,
      resolvedModelId: modelSelection?.model,
    });

    if (modelSelection) {
      const resolvedModelMeta = {
        model: modelSelection.model,
        resolvedModelId: modelSelection.model,
        ...(modelSelection.modelPresetId ? { modelPresetId: modelSelection.modelPresetId } : {}),
      };
      turn.resolvedModelMeta = resolvedModelMeta;
      this.stampUserTurnMetadata(turn, resolvedModelMeta);
    }

    const contextPayload: DshHostSessionContext = {
      sessionId: dshSessionId,
      sideChat: true,
      agentId,
      coworkSessionId: parent.id,
      traceId: turn.traceId,
      workspaceDir: parent.cwd,
      userQuestionsDisabled: parent.userQuestionsDisabled,
      allowedSkillIds,
      customSystemPrompt: '',
      ...(parent.executionMode ? { executionMode: parent.executionMode } : {}),
      permissionPreset,
    };
    await this.hostManager.bindSessionContext(contextPayload);
    if (modelSelection) {
      const provider = canonicalizeDshProviderId(modelSelection.provider);
      try {
        await client.selectModel({
          sessionId: dshSessionId,
          provider,
          model: modelSelection.model,
          ...(modelSelection.reasoningEffort ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
        });
      } catch (error) {
        if (modelSelection.reasoningEffort) {
          await client.selectModel({
            sessionId: dshSessionId,
            provider,
            model: modelSelection.model,
          });
        } else {
          console.warn(`[DshSideChat] selectModel failed for side chat ${dshSessionId}:`, error);
        }
      }
    }
  }

  private handleFollowFrame(
    turn: ActiveSideChatTurn,
    frame: Record<string, unknown>,
  ): boolean {
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame as Record<string, unknown> | undefined;
      if (!inner || typeof inner !== 'object') return false;

      if (inner.type === 'chunk') {
        const chunk = inner.chunk as Record<string, unknown> | undefined;
        const deltaText = extractStreamChunkDelta(chunk);
        if (!deltaText || !chunk) return false;

        if (chunk.type === 'text-delta') {
          if (turn.currentThinkingMessageId) {
            this.finalizeThinkingMessage(turn);
          }
          const msgId = this.ensureAssistantMessage(turn);
          turn.currentAssistantText += deltaText;
          const meta = { isStreaming: true };
          this.streamUpdateThrottler.schedule({
            sessionId: turn.sideChatId,
            parentSessionId: turn.parentSessionId,
            messageId: msgId,
            content: turn.currentAssistantText,
            metadata: meta,
          });
        } else if (chunk.type === 'reasoning-delta' || chunk.type === 'thinking-delta') {
          const msgId = this.ensureThinkingMessage(turn);
          turn.currentThinkingText += deltaText;
          const meta = { isThinking: true, isStreaming: true };
          this.streamUpdateThrottler.schedule({
            sessionId: turn.sideChatId,
            parentSessionId: turn.parentSessionId,
            messageId: msgId,
            content: turn.currentThinkingText,
            metadata: meta,
          });
        }
        return false;
      }

      if (inner.type === 'end') {
        if (isFailedAssistantStreamOutcome(inner.outcome)) {
          this.resetFailedStreamBuffers(turn);
          return false;
        }
        const outcome = inner.outcome as { seq?: unknown } | undefined;
        const seq = typeof outcome?.seq === 'number' ? outcome.seq : undefined;
        this.finalizeThinkingMessage(turn, seq);
        this.finalizeAssistantMessage(turn, seq);
      }
      return false;
    }

    if (frame.type === 'event' || (typeof frame.type === 'string' && frame.type.includes('/'))) {
      const ev = (frame.type === 'event' ? frame.event : frame) as Record<string, unknown> | undefined;
      if (!ev || typeof ev !== 'object') return false;
      const evType = typeof ev.type === 'string' ? ev.type : '';
      const data = (ev.data as Record<string, unknown> | undefined) ?? {};

      if (evType === 'tool/call') {
        this.finalizeActiveMessages(turn);
        turn.lastFinalizedThinkingMessageId = null;
        turn.lastFinalizedThinkingText = '';
        turn.lastFinalizedAssistantMessageId = null;
        turn.lastFinalizedAssistantText = '';

        const callId = String(data.callId ?? randomUUID());
        const toolName = String(data.name ?? 'tool');
        const toolInput = parseToolArgs(data.arguments);
        const msg = this.sideChatStore.addMessage(turn.sideChatId, {
          type: CoworkSideChatMessageType.ToolUse,
          content: toolName,
          metadata: {
            toolUseId: callId,
            toolName,
            toolInput,
            ...(typeof ev.seq === 'number' ? { seq: ev.seq } : {}),
          },
        });
        this.emit('message', {
          parentSessionId: turn.parentSessionId,
          sideChatId: turn.sideChatId,
          message: msg,
        });
        return false;
      }

      if (evType === 'tool/result') {
        const messageObj = data.message as Record<string, unknown> | undefined;
        const callId = String(messageObj?.callId ?? messageObj?.toolCallId ?? data.callId ?? '');
        const text = extractTextFromContentBlocks(messageObj?.content ?? data.content);
        const resultMeta = record(data.meta);
        const hostResult = record(resultMeta.lobsterToolResult);
        const isError = Boolean(hostResult.isError || messageObj?.isError || data.isError);
        const msg = this.sideChatStore.addMessage(turn.sideChatId, {
          type: CoworkSideChatMessageType.ToolResult,
          content: text,
          metadata: {
            toolUseId: callId,
            isError,
            ...(hostResult.details ? { toolResultDetails: record(hostResult.details) } : {}),
            ...(typeof ev.seq === 'number' ? { seq: ev.seq } : {}),
          },
        });
        this.emit('message', {
          parentSessionId: turn.parentSessionId,
          sideChatId: turn.sideChatId,
          message: msg,
        });
        return false;
      }

      if (evType === 'assistant/message') {
        const messageObj = data.message as Record<string, unknown> | undefined;
        const rawContent = messageObj?.content ?? data.content;
        const text = extractTextFromContentBlocks(rawContent);
        const thinking = extractReasoningFromContentBlocks(rawContent);
        const seq = typeof ev.seq === 'number' ? ev.seq : undefined;

        if (turn.currentThinkingMessageId) {
          if (!turn.currentThinkingText && thinking) turn.currentThinkingText = thinking;
          this.finalizeThinkingMessage(turn, seq);
        } else if (!turn.lastFinalizedThinkingMessageId && thinking) {
          const msg = this.sideChatStore.addMessage(turn.sideChatId, {
            type: CoworkSideChatMessageType.Assistant,
            content: thinking,
            metadata: { isThinking: true, isStreaming: false, ...(seq !== undefined ? { seq } : {}) },
          });
          this.emit('message', {
            parentSessionId: turn.parentSessionId,
            sideChatId: turn.sideChatId,
            message: msg,
          });
        }

        if (turn.currentAssistantMessageId) {
          if (!turn.currentAssistantText && text) turn.currentAssistantText = text;
          this.finalizeAssistantMessage(turn, seq);
        } else if (!turn.lastFinalizedAssistantMessageId && text) {
          const msg = this.sideChatStore.addMessage(turn.sideChatId, {
            type: CoworkSideChatMessageType.Assistant,
            content: text,
            metadata: {
              isStreaming: false,
              ...(turn.resolvedModelMeta ?? {}),
              ...(seq !== undefined ? { seq } : {}),
            },
          });
          this.emit('message', {
            parentSessionId: turn.parentSessionId,
            sideChatId: turn.sideChatId,
            message: msg,
          });
        }

        turn.lastFinalizedThinkingMessageId = null;
        turn.lastFinalizedThinkingText = '';
        turn.lastFinalizedAssistantMessageId = null;
        turn.lastFinalizedAssistantText = '';
        return false;
      }

      if (evType === 'turn/end') {
        const outcome = extractTurnEndError(data.reason);
        turn.turnError = outcome.error;
        turn.turnAborted = outcome.aborted;
        return true;
      }
    }

    return false;
  }

  private ensureThinkingMessage(turn: ActiveSideChatTurn): string {
    if (turn.currentThinkingMessageId) return turn.currentThinkingMessageId;
    const msg = this.sideChatStore.addMessage(turn.sideChatId, {
      type: CoworkSideChatMessageType.Assistant,
      content: '',
      metadata: { isThinking: true, isStreaming: true },
    });
    turn.currentThinkingMessageId = msg.id;
    turn.currentThinkingText = '';
    this.emit('message', {
      parentSessionId: turn.parentSessionId,
      sideChatId: turn.sideChatId,
      message: msg,
    });
    return msg.id;
  }

  private ensureAssistantMessage(turn: ActiveSideChatTurn): string {
    if (turn.currentAssistantMessageId) return turn.currentAssistantMessageId;
    const msg = this.sideChatStore.addMessage(turn.sideChatId, {
      type: CoworkSideChatMessageType.Assistant,
      content: '',
      metadata: {
        isStreaming: true,
        ...(turn.resolvedModelMeta ?? {}),
      },
    });
    turn.currentAssistantMessageId = msg.id;
    turn.currentAssistantText = '';
    this.emit('message', {
      parentSessionId: turn.parentSessionId,
      sideChatId: turn.sideChatId,
      message: msg,
    });
    return msg.id;
  }

  private finalizeThinkingMessage(turn: ActiveSideChatTurn, seq?: number): void {
    const msgId = turn.currentThinkingMessageId;
    if (!msgId) return;
    this.streamUpdateThrottler.clearMessage(msgId);
    const text = turn.currentThinkingText;
    turn.currentThinkingMessageId = null;
    turn.currentThinkingText = '';
    const meta: Record<string, unknown> = {
      isThinking: true,
      isStreaming: false,
      ...(seq !== undefined ? { seq } : {}),
    };
    this.sideChatStore.updateMessageContent(turn.sideChatId, msgId, text, meta);
    this.emit('messageUpdate', {
      parentSessionId: turn.parentSessionId,
      sideChatId: turn.sideChatId,
      messageId: msgId,
      content: text,
      metadata: meta,
    });
    turn.lastFinalizedThinkingMessageId = msgId;
    turn.lastFinalizedThinkingText = text;
  }

  private finalizeAssistantMessage(turn: ActiveSideChatTurn, seq?: number): void {
    const msgId = turn.currentAssistantMessageId;
    if (!msgId) return;
    this.streamUpdateThrottler.clearMessage(msgId);
    const text = turn.currentAssistantText;
    turn.currentAssistantMessageId = null;
    turn.currentAssistantText = '';
    const meta: Record<string, unknown> = {
      isStreaming: false,
      ...(turn.resolvedModelMeta ?? {}),
      ...(seq !== undefined ? { seq } : {}),
    };
    this.sideChatStore.updateMessageContent(turn.sideChatId, msgId, text, meta);
    this.emit('messageUpdate', {
      parentSessionId: turn.parentSessionId,
      sideChatId: turn.sideChatId,
      messageId: msgId,
      content: text,
      metadata: meta,
    });
    turn.lastFinalizedAssistantMessageId = msgId;
    turn.lastFinalizedAssistantText = text;
  }

  private finalizeActiveMessages(turn: ActiveSideChatTurn): void {
    this.finalizeThinkingMessage(turn);
    this.finalizeAssistantMessage(turn);
  }

  private resetFailedStreamBuffers(turn: ActiveSideChatTurn): void {
    if (turn.currentThinkingMessageId) {
      this.streamUpdateThrottler.clearMessage(turn.currentThinkingMessageId);
      this.sideChatStore.deleteMessage(turn.sideChatId, turn.currentThinkingMessageId);
      turn.currentThinkingMessageId = null;
      turn.currentThinkingText = '';
    }
    if (turn.currentAssistantMessageId) {
      this.streamUpdateThrottler.clearMessage(turn.currentAssistantMessageId);
      this.sideChatStore.deleteMessage(turn.sideChatId, turn.currentAssistantMessageId);
      turn.currentAssistantMessageId = null;
      turn.currentAssistantText = '';
    }
  }

  private cancelPendingPermissionsForSideChat(sideChatId: string): void {
    for (const [requestId, pending] of [...this.pendingInteractions.entries()]) {
      if (pending.sideChatId !== sideChatId) continue;
      this.pendingInteractions.delete(requestId);
      pending.resolve(cancelledInteraction(pending.kind));
      this.emit('permissionResolved', {
        parentSessionId: pending.parentSessionId,
        sideChatId,
        requestId,
      });
    }
  }

  private async getReadyClient(): Promise<DshTypertClient> {
    if (this.ensureHostReadyClient) {
      return this.ensureHostReadyClient();
    }
    if (!this.hostManager.isReady()) {
      await this.hostManager.start();
    }
    return this.hostManager.getClient();
  }

  private async cancelDshSessionBestEffort(dshSessionId: string): Promise<void> {
    try {
      if (this.hostManager.isReady() || this.hostManager.hasLiveHost?.()) {
        await this.hostManager.getClient().cancelSession(dshSessionId);
        return;
      }
      const client = await this.getReadyClient();
      await client.cancelSession(dshSessionId);
    } catch (error) {
      console.warn(`[DshSideChat] Failed to cancel DSH session ${dshSessionId}:`, error);
    }
  }
}
