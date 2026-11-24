// Handles inbound IM messages forwarded from `@lobsterai/dsh-channels` over
// `/dsh-bridge/channel-event` by routing them through LobsterAI's
// `CoworkStore` + `IMStore` + `DshRuntimeAdapter` pipeline, then sending the
// assistant reply back via `DshChannelsBridge`.

import {
  buildCoworkImageAttachmentPreviews,
  type CoworkImageAttachmentPayload,
} from '../../shared/cowork/imageAttachments';
import {
  RetainedImPlatform,
  type RetainedImPlatform as RetainedImPlatformType,
} from '../../shared/dshEngine/hostConstants';
import { ImPeerKind } from '../../shared/platform';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import { t } from '../i18n';
import type { CoworkLocalMediaAttachment, CoworkRuntime } from '../libs/agentEngine/types';
import { isRetainedImPlatform } from './dshChannelsBridge';
import { stripThinkingBlocks } from './imReplyGuard';
import type { DirectSessionRoute } from './legacyDirectSessionMapping';
import { findLegacyPopoMapping } from './popoSessionMapping';
import type { IMSessionMapping, Platform } from './types';

export const DshImAttachmentKind = {
  Voice: 'voice',
  Image: 'image',
} as const;
export type DshImAttachmentKind =
  typeof DshImAttachmentKind[keyof typeof DshImAttachmentKind];

export interface DshImVoiceAttachment {
  kind: typeof DshImAttachmentKind.Voice;
  dataBase64?: string;
  encodeType?: number;
  sampleRate?: number;
  playtimeMs?: number;
  error?: string;
}

export interface DshImImageAttachment {
  kind: typeof DshImAttachmentKind.Image;
  mimeType: string;
  dataBase64: string;
  sizeBytes?: number;
  name?: string;
}

export type DshImInboundAttachment = DshImVoiceAttachment | DshImImageAttachment;

export interface DshImInboundEvent {
  platform: string;
  instanceId?: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  attachments?: DshImInboundAttachment[];
  messageId?: string;
  chatType?: 'direct' | 'group';
  replyContext?: Record<string, unknown>;
  agentId?: string;
  cwd?: string;
}

export interface DshImInboundCoworkStorePort {
  getSession(id: string): CoworkSession | null;
  createSession(
    title: string,
    cwd: string,
    systemPrompt?: string,
    executionMode?: 'auto' | 'local' | 'sandbox',
    activeSkillIds?: string[],
    agentId?: string,
  ): CoworkSession;
}

export interface DshImInboundIMStorePort {
  findLegacyDirectSessionMapping(route: DirectSessionRoute): IMSessionMapping | null;
  getPopoInstances?(): Array<{ instanceId: string }>;
  getSessionMapping(
    imConversationId: string,
    platform: Platform,
    agentId?: string,
  ): IMSessionMapping | null;
  createSessionMapping(
    imConversationId: string,
    platform: Platform,
    coworkSessionId: string,
    agentId?: string,
  ): IMSessionMapping;
  updateSessionMappingTarget(
    imConversationId: string,
    platform: Platform,
    newCoworkSessionId: string,
    newAgentId: string,
    newOpenClawSessionKey?: string,
    existingAgentId?: string,
  ): void;
  updateSessionLastActive(
    imConversationId: string,
    platform: Platform,
    agentId?: string,
  ): void;
}

export interface DshImInboundHandlerDeps {
  coworkStore: DshImInboundCoworkStorePort;
  imStore: DshImInboundIMStorePort;
  runtime: Pick<CoworkRuntime, 'startSession' | 'continueSession' | 'on' | 'off'>
    & Partial<Pick<CoworkRuntime, 'stopSession'>>;
  sendReply: (params: {
    platform: string;
    instanceId?: string;
    chatId: string;
    text: string;
    replyContext?: Record<string, unknown>;
  }) => Promise<unknown>;
  getDefaultCwd: (agentId?: string) => string;
  notifySessionsChanged?: (sessionId: string) => void;
  transcribeVoice?: (attachment: {
    dataBase64: string;
    encodeType?: number;
    sampleRate?: number;
  }) => Promise<string>;
  persistInboundImage?: (
    sessionId: string,
    attachment: Pick<CoworkImageAttachmentPayload, 'mimeType' | 'base64Data' | 'localPath' | 'name'>,
  ) => string | null;
  turnTimeoutMs?: number;
  /** Delay (ms) to coalesce rapid multi-image / image+text bursts before starting a turn. */
  mediaCoalesceMs?: number;
  /** Maximum total coalesce wait (ms) for a continuous burst before dispatching. */
  maxCoalesceWaitMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MEDIA_COALESCE_MS = 1_200;
const DEFAULT_MAX_COALESCE_WAIT_MS = 4_000;
const MAX_SEEN_MESSAGE_IDS = 512;

interface ActiveImRun {
  sessionId: string | null;
  interrupted: boolean;
  dispatchedToRuntime: boolean;
  events: DshImInboundEvent[];
}

interface ConversationQueueState {
  pendingEvents: DshImInboundEvent[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  firstPendingAt: number | null;
  activeRun: ActiveImRun | null;
  waiters: Array<() => void>;
}

function getPlatformTitlePrefix(platform: RetainedImPlatformType): string {
  switch (platform) {
    case RetainedImPlatform.Weixin:
      return t('channelPrefixWeixin');
    case RetainedImPlatform.Feishu:
      return t('channelPrefixFeishu');
    case RetainedImPlatform.DingTalk:
      return t('channelPrefixDingtalk');
    case RetainedImPlatform.WeCom:
      return t('channelPrefixWecom');
    case RetainedImPlatform.Popo:
      return 'POPO';
    case RetainedImPlatform.QQ:
      return 'QQ';
    case RetainedImPlatform.Telegram:
      return 'Telegram';
    case RetainedImPlatform.Discord:
      return 'Discord';
  }
}

function buildMappingPlatform(platform: RetainedImPlatformType, instanceId: string): Platform {
  if (platform === RetainedImPlatform.Weixin || !instanceId || instanceId === 'default') {
    return platform as Platform;
  }
  return `${platform}:${instanceId}` as Platform;
}

function extractTurnReplyText(
  messages: CoworkMessage[],
  beforeMessageIds: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (beforeMessageIds.has(msg.id)) continue;
    if (msg.type !== 'assistant') continue;
    if (msg.metadata?.isThinking === true) continue;
    const cleaned = stripThinkingBlocks(msg.content || '').trim();
    if (cleaned) parts.push(cleaned);
  }
  return parts.join('\n\n').trim();
}

function parseAttachments(raw: unknown): DshImInboundAttachment[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const parsed: DshImInboundAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (rec.kind === DshImAttachmentKind.Voice) {
      const dataBase64 = typeof rec.dataBase64 === 'string' && rec.dataBase64.trim()
        ? rec.dataBase64.trim()
        : undefined;
      const error = typeof rec.error === 'string' && rec.error.trim()
        ? rec.error.trim()
        : undefined;
      if (!dataBase64 && !error) continue;
      parsed.push({
        kind: DshImAttachmentKind.Voice,
        ...(dataBase64 ? { dataBase64 } : {}),
        ...(typeof rec.encodeType === 'number' && Number.isFinite(rec.encodeType) ? { encodeType: rec.encodeType } : {}),
        ...(typeof rec.sampleRate === 'number' && Number.isFinite(rec.sampleRate) ? { sampleRate: rec.sampleRate } : {}),
        ...(typeof rec.playtimeMs === 'number' && Number.isFinite(rec.playtimeMs) ? { playtimeMs: rec.playtimeMs } : {}),
        ...(error ? { error } : {}),
      });
    } else if (rec.kind === DshImAttachmentKind.Image) {
      const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType.trim() : '';
      const dataBase64 = typeof rec.dataBase64 === 'string' ? rec.dataBase64.trim() : '';
      if (!mimeType || !dataBase64) continue;
      parsed.push({
        kind: DshImAttachmentKind.Image,
        mimeType,
        dataBase64,
        ...(typeof rec.sizeBytes === 'number' && Number.isFinite(rec.sizeBytes) && rec.sizeBytes > 0
          ? { sizeBytes: rec.sizeBytes }
          : {}),
        ...(typeof rec.name === 'string' && rec.name.trim() ? { name: rec.name.trim() } : {}),
      });
    }
  }
  return parsed;
}

export function parseDshImInboundEvent(payload: unknown): DshImInboundEvent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const rec = payload as Record<string, unknown>;
  const platform = typeof rec.platform === 'string' ? rec.platform.trim().toLowerCase() : '';
  const chatId = typeof rec.chatId === 'string' ? rec.chatId.trim() : '';
  const text = typeof rec.text === 'string' ? rec.text.trim() : '';
  const attachments = parseAttachments(rec.attachments);
  if (!platform || !isRetainedImPlatform(platform) || !chatId || (!text && attachments.length === 0)) {
    return null;
  }
  return {
    platform,
    instanceId: typeof rec.instanceId === 'string' && rec.instanceId.trim()
      ? rec.instanceId.trim()
      : 'default',
    chatId,
    senderId: typeof rec.senderId === 'string' ? rec.senderId.trim() : undefined,
    senderName: typeof rec.senderName === 'string' ? rec.senderName.trim() : undefined,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    messageId: typeof rec.messageId === 'string' ? rec.messageId.trim() : undefined,
    chatType: rec.chatType === 'group' ? 'group' : 'direct',
    replyContext: rec.replyContext && typeof rec.replyContext === 'object' && !Array.isArray(rec.replyContext)
      ? (rec.replyContext as Record<string, unknown>)
      : undefined,
    agentId: typeof rec.agentId === 'string' && rec.agentId.trim() ? rec.agentId.trim() : 'main',
    cwd: typeof rec.cwd === 'string' && rec.cwd.trim() ? rec.cwd.trim() : undefined,
  };
}

export class DshImInboundHandler {
  private readonly deps: DshImInboundHandlerDeps;
  private readonly turnTimeoutMs: number;
  private readonly mediaCoalesceMs: number;
  private readonly maxCoalesceWaitMs: number;
  private readonly conversations = new Map<string, ConversationQueueState>();
  private readonly seenMessageIds = new Set<string>();

  constructor(deps: DshImInboundHandlerDeps) {
    this.deps = deps;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.mediaCoalesceMs = deps.mediaCoalesceMs ?? DEFAULT_MEDIA_COALESCE_MS;
    this.maxCoalesceWaitMs = deps.maxCoalesceWaitMs ?? DEFAULT_MAX_COALESCE_WAIT_MS;
  }

  enqueue(event: DshImInboundEvent): Promise<void> {
    const platform = event.platform.trim().toLowerCase();
    const instanceId = event.instanceId?.trim() || 'default';
    const agentId = event.agentId?.trim() || 'main';

    if (event.messageId) {
      const dedupeKey = `${platform}:${instanceId}:${event.messageId}`;
      if (this.seenMessageIds.has(dedupeKey)) {
        return Promise.resolve();
      }
      this.seenMessageIds.add(dedupeKey);
      while (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
        const oldest = this.seenMessageIds.values().next().value;
        if (oldest === undefined) break;
        this.seenMessageIds.delete(oldest);
      }
    }

    const queueKey = `${platform}:${instanceId}:${event.chatId}:${agentId}`;
    let state = this.conversations.get(queueKey);
    if (!state) {
      state = {
        pendingEvents: [],
        debounceTimer: null,
        firstPendingAt: null,
        activeRun: null,
        waiters: [],
      };
      this.conversations.set(queueKey, state);
    }

    const completion = new Promise<void>((resolve) => {
      state!.waiters.push(resolve);
    });

    state.pendingEvents.push(event);
    if (state.firstPendingAt === null) {
      state.firstPendingAt = Date.now();
    }

    if (state.activeRun) {
      // Interrupt the in-flight turn immediately so rapid multi-image bursts or
      // follow-up corrections don't wait for the stale reply to finish.
      if (!state.activeRun.interrupted) {
        state.activeRun.interrupted = true;
        if (state.activeRun.sessionId) {
          console.log(
            `[DshImInbound] Interrupting active turn for ${queueKey} session=${state.activeRun.sessionId} due to new inbound message`,
          );
          this.deps.runtime.stopSession?.(state.activeRun.sessionId);
        }
      }
    } else {
      this.scheduleDrain(queueKey, state);
    }

    return completion;
  }

  private scheduleDrain(queueKey: string, state: ConversationQueueState): void {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
    if (state.activeRun || state.pendingEvents.length === 0) return;

    const hasImageAttachment = state.pendingEvents.some((ev) =>
      (ev.attachments ?? []).some((att) => att.kind === DshImAttachmentKind.Image),
    );
    let delayMs = 0;
    if (hasImageAttachment && this.mediaCoalesceMs > 0) {
      const elapsed = Date.now() - (state.firstPendingAt ?? Date.now());
      const remainingCap = Math.max(0, this.maxCoalesceWaitMs - elapsed);
      delayMs = Math.min(this.mediaCoalesceMs, remainingCap);
    }

    if (delayMs > 0) {
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void this.drainConversation(queueKey);
      }, delayMs);
      state.debounceTimer.unref?.();
    } else {
      void this.drainConversation(queueKey);
    }
  }

  private settleIfIdle(queueKey: string, state: ConversationQueueState): void {
    if (state.activeRun || state.pendingEvents.length > 0 || state.debounceTimer) {
      return;
    }
    if (this.conversations.get(queueKey) === state) {
      this.conversations.delete(queueKey);
    }
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async drainConversation(queueKey: string): Promise<void> {
    const state = this.conversations.get(queueKey);
    if (!state || state.activeRun) return;
    if (state.pendingEvents.length === 0) {
      this.settleIfIdle(queueKey, state);
      return;
    }

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }

    const batch = state.pendingEvents.splice(0);
    state.firstPendingAt = null;
    const run: ActiveImRun = {
      sessionId: null,
      interrupted: false,
      dispatchedToRuntime: false,
      events: batch,
    };
    state.activeRun = run;

    try {
      await this.processBatch(batch, run);
    } catch (error: unknown) {
      console.error(`[DshImInbound] Unhandled error processing ${queueKey}:`, error);
    } finally {
      if (state.activeRun === run) {
        state.activeRun = null;
      }
      // If interrupted before this batch even dispatched to the runtime (e.g.
      // during voice ASR), preserve its events ahead of the newer pending ones.
      if (run.interrupted && !run.dispatchedToRuntime) {
        state.pendingEvents.unshift(...run.events);
        if (state.firstPendingAt === null) {
          state.firstPendingAt = Date.now();
        }
      }
      if (state.pendingEvents.length > 0) {
        this.scheduleDrain(queueKey, state);
      } else {
        this.settleIfIdle(queueKey, state);
      }
    }
  }

  private async sendReplySafe(
    platform: string,
    instanceId: string,
    chatId: string,
    text: string,
    replyContext?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.deps.sendReply({
        platform,
        instanceId,
        chatId,
        text,
        replyContext,
      });
      return true;
    } catch (sendErr) {
      console.error(`[DshImInbound] Failed to send reply to ${platform}:${instanceId}:`, sendErr);
      return false;
    }
  }

  private async processBatch(batch: DshImInboundEvent[], run: ActiveImRun): Promise<void> {
    if (batch.length === 0) return;
    const latestEvent = batch[batch.length - 1];
    const platform = latestEvent.platform.trim().toLowerCase();
    if (!isRetainedImPlatform(platform)) return;

    const instanceId = latestEvent.instanceId?.trim() || 'default';
    const agentId = latestEvent.agentId?.trim() || 'main';
    const chatId = latestEvent.chatId.trim();
    if (!chatId) return;

    const latestReplyContext = [...batch].reverse().find((ev) => ev.replyContext)?.replyContext;
    const senderName = [...batch].reverse().find((ev) => ev.senderName)?.senderName;
    const eventCwd = [...batch].reverse().find((ev) => ev.cwd)?.cwd;

    const textParts: string[] = [];
    const imageAttachments: CoworkImageAttachmentPayload[] = [];
    let lastVoiceErrorKind: 'download' | 'transcribe' | null = null;

    for (const event of batch) {
      if (run.interrupted) return;

      let eventText = event.text.trim();
      const voiceAttachment = event.attachments?.find(
        (att): att is DshImVoiceAttachment => att.kind === DshImAttachmentKind.Voice,
      );

      if (!eventText && voiceAttachment) {
        if (voiceAttachment.error || !voiceAttachment.dataBase64) {
          console.warn(
            `[DshImInbound] Voice attachment unavailable for ${platform}:${instanceId} chat=${chatId}: ${voiceAttachment.error || 'missing audio data'}`,
          );
          lastVoiceErrorKind = 'download';
        } else if (!this.deps.transcribeVoice) {
          console.warn(
            `[DshImInbound] Voice transcription is not configured for ${platform}:${instanceId} chat=${chatId}`,
          );
          lastVoiceErrorKind = 'transcribe';
        } else {
          try {
            const transcript = (
              await this.deps.transcribeVoice({
                dataBase64: voiceAttachment.dataBase64,
                encodeType: voiceAttachment.encodeType,
                sampleRate: voiceAttachment.sampleRate,
              })
            ).trim();
            if (run.interrupted) return;
            if (!transcript) {
              throw new Error('ASR returned empty transcript');
            }
            eventText = transcript;
            console.log(
              `[DshImInbound] Transcribed voice message for ${platform}:${instanceId} chat=${chatId} chars=${eventText.length}`,
            );
          } catch (err) {
            console.warn(
              `[DshImInbound] Voice transcription failed for ${platform}:${instanceId} chat=${chatId}:`,
              err instanceof Error ? err.message : String(err),
            );
            lastVoiceErrorKind = 'transcribe';
          }
        }
      }

      if (eventText) {
        textParts.push(eventText);
      }

      for (const att of event.attachments ?? []) {
        if (att.kind === DshImAttachmentKind.Image && att.dataBase64) {
          imageAttachments.push({
            name: att.name || `${platform}-image-${imageAttachments.length + 1}.jpg`,
            mimeType: att.mimeType,
            base64Data: att.dataBase64,
            ...(typeof att.sizeBytes === 'number' && att.sizeBytes > 0 ? { sizeBytes: att.sizeBytes } : {}),
          });
        }
      }
    }

    if (run.interrupted) return;

    const userDisplayText = textParts.join('\n').trim();
    if (!userDisplayText && imageAttachments.length === 0) {
      if (lastVoiceErrorKind === 'download') {
        await this.sendReplySafe(
          platform,
          instanceId,
          chatId,
          `⚠️ ${t('imWeixinVoiceDownloadFailed')}`,
          latestReplyContext,
        );
      } else if (lastVoiceErrorKind === 'transcribe') {
        await this.sendReplySafe(
          platform,
          instanceId,
          chatId,
          `⚠️ ${t('imWeixinVoiceTranscribeFailed')}`,
          latestReplyContext,
        );
      }
      return;
    }

    const modelPrompt = userDisplayText || t('imImageDefaultPrompt');

    const mappingPlatform = buildMappingPlatform(platform, instanceId);
    const resolvedCwd = eventCwd || this.deps.getDefaultCwd(agentId);

    // Prefer the verified original even if an earlier DSH build already split
    // the conversation. Its separate transcript remains available on desktop.
    const legacyDirect = (latestEvent.chatType ?? ImPeerKind.Direct) === ImPeerKind.Direct
      ? this.deps.imStore.findLegacyDirectSessionMapping({
          platform, instanceId, agentId, chatId, senderId: latestEvent.senderId,
        })
      : null;
    const existingMapping = legacyDirect ?? this.deps.imStore.getSessionMapping(chatId, mappingPlatform, agentId)
      ?? (platform === RetainedImPlatform.Popo
        ? findLegacyPopoMapping(this.deps.imStore, instanceId, latestEvent.chatType ?? 'direct', chatId, agentId)
        : null);
    const storedChatId = existingMapping?.imConversationId ?? chatId;
    const storedPlatform = existingMapping?.platform ?? mappingPlatform;
    let session = existingMapping
      ? this.deps.coworkStore.getSession(existingMapping.coworkSessionId)
      : null;
    const isExistingSession = Boolean(session);

    if (!session) {
      const prefix = getPlatformTitlePrefix(platform);
      const label = (senderName || chatId).slice(0, 32);
      session = this.deps.coworkStore.createSession(
        `[${prefix}] ${label}`,
        resolvedCwd,
        '',
        'auto',
        undefined,
        agentId,
      );
      if (existingMapping) {
        this.deps.imStore.updateSessionMappingTarget(
          storedChatId,
          storedPlatform,
          session.id,
          agentId,
          undefined,
          existingMapping.agentId,
        );
      } else {
        this.deps.imStore.createSessionMapping(chatId, mappingPlatform, session.id, agentId);
      }
      this.deps.notifySessionsChanged?.(session.id);
    } else {
      this.deps.imStore.updateSessionLastActive(storedChatId, storedPlatform, agentId);
    }

    const sessionId = session.id;
    run.sessionId = sessionId;
    if (run.interrupted) return;

    const beforeMessageIds = new Set((session.messages ?? []).map((m) => m.id));

    const localMediaAttachments: CoworkLocalMediaAttachment[] = [];
    const resolvedImageAttachments: CoworkImageAttachmentPayload[] = imageAttachments.map((att) => {
      const localPath = this.deps.persistInboundImage?.(sessionId, att) ?? att.localPath;
      if (localPath) {
        localMediaAttachments.push({
          localPath,
          mimeType: att.mimeType,
          name: att.name,
        });
        return { ...att, localPath };
      }
      return att;
    });

    const hasDisplayableImages = localMediaAttachments.length > 0
      || Boolean(buildCoworkImageAttachmentPreviews(resolvedImageAttachments)?.length);
    const userMessageContent = resolvedImageAttachments.length > 0
      ? (userDisplayText || (hasDisplayableImages ? '' : modelPrompt))
      : undefined;

    console.log(
      `[DshImInbound] Dispatching ${platform}:${instanceId} chat=${chatId} session=${sessionId} existing=${isExistingSession} events=${batch.length} images=${resolvedImageAttachments.length} persistedLocalMedia=${localMediaAttachments.length}`,
    );

    run.dispatchedToRuntime = true;
    const outcome = await this.runTurnAndAwaitOutcome(sessionId, modelPrompt, {
      isExistingSession,
      agentId,
      cwd: resolvedCwd,
      ...(resolvedImageAttachments.length > 0 ? { imageAttachments: resolvedImageAttachments } : {}),
      ...(localMediaAttachments.length > 0 ? { localMediaAttachments } : {}),
      ...(userMessageContent !== undefined ? { userMessageContent } : {}),
    });

    this.deps.notifySessionsChanged?.(sessionId);

    if (run.interrupted || outcome.kind === 'stopped') {
      console.log(
        `[DshImInbound] Suppressed reply for interrupted turn ${platform}:${instanceId} chat=${chatId} session=${sessionId}`,
      );
      return;
    }

    if (outcome.kind === 'error') {
      console.warn(
        `[DshImInbound] Turn failed for ${platform}:${instanceId} chat=${chatId} session=${sessionId}: ${outcome.error}`,
      );
      const errorReply = `⚠️ ${outcome.error.slice(0, 300)}`;
      await this.sendReplySafe(platform, instanceId, chatId, errorReply, latestReplyContext);
      return;
    }

    const updatedSession = this.deps.coworkStore.getSession(sessionId);
    const replyText = extractTurnReplyText(updatedSession?.messages ?? [], beforeMessageIds);
    if (!replyText) {
      console.warn(
        `[DshImInbound] Turn completed with empty assistant reply for ${platform}:${instanceId} session=${sessionId}`,
      );
      return;
    }

    const sent = await this.sendReplySafe(platform, instanceId, chatId, replyText, latestReplyContext);
    if (sent) {
      console.log(
        `[DshImInbound] Replied to ${platform}:${instanceId} chat=${chatId} session=${sessionId} chars=${replyText.length}`,
      );
    }
  }

  private runTurnAndAwaitOutcome(
    sessionId: string,
    prompt: string,
    options: {
      isExistingSession: boolean;
      agentId: string;
      cwd: string;
      imageAttachments?: CoworkImageAttachmentPayload[];
      localMediaAttachments?: CoworkLocalMediaAttachment[];
      userMessageContent?: string;
    },
  ): Promise<{ kind: 'complete' } | { kind: 'stopped' } | { kind: 'error'; error: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: { kind: 'complete' } | { kind: 'stopped' } | { kind: 'error'; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.deps.runtime.off('complete', onComplete);
        this.deps.runtime.off('error', onError);
        this.deps.runtime.off('sessionStopped', onStopped);
        resolve(outcome);
      };

      const onComplete = (completedId: string) => {
        if (completedId === sessionId) finish({ kind: 'complete' });
      };
      const onError = (erroredId: string, errMsg: string) => {
        if (erroredId === sessionId) finish({ kind: 'error', error: errMsg || 'Unknown error' });
      };
      const onStopped = (stoppedId: string) => {
        if (stoppedId === sessionId) finish({ kind: 'stopped' });
      };

      const timer = setTimeout(() => {
        finish({ kind: 'error', error: 'Response timed out' });
      }, this.turnTimeoutMs);
      timer.unref?.();

      this.deps.runtime.on('complete', onComplete);
      this.deps.runtime.on('error', onError);
      this.deps.runtime.on('sessionStopped', onStopped);

      const mediaOptions = {
        ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
        ...(options.localMediaAttachments?.length ? { localMediaAttachments: options.localMediaAttachments } : {}),
        ...(options.userMessageContent !== undefined ? { userMessageContent: options.userMessageContent } : {}),
      };
      const hasMediaOptions = Object.keys(mediaOptions).length > 0;

      const startPromise = options.isExistingSession
        ? (hasMediaOptions
            ? this.deps.runtime.continueSession(sessionId, prompt, mediaOptions)
            : this.deps.runtime.continueSession(sessionId, prompt))
        : this.deps.runtime.startSession(sessionId, prompt, {
            agentId: options.agentId,
            workspaceRoot: options.cwd,
            ...mediaOptions,
          });

      void startPromise.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        finish({ kind: 'error', error: msg });
      });
    });
  }
}
