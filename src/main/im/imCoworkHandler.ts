/**
 * IM Cowork Handler
 * Watches CoworkRuntime events for IM sessions synced from OpenClaw channels:
 * relays async reminder replies back to the IM conversation and times out
 * permission requests raised on those sessions.
 */

import { EventEmitter } from 'events';

import type { CoworkMessage,CoworkStore } from '../coworkStore';
import type { CoworkRuntime, PermissionRequest } from '../libs/agentEngine/types';
import { DEFAULT_IM_EMPTY_REPLY, stripThinkingBlocks } from './imReplyGuard';
import { isReminderSystemTurn } from './imScheduledTaskHandler';
import type { IMStore } from './imStore';
import type { IMSessionMapping,Platform } from './types';

interface MessageAccumulator {
  messages: CoworkMessage[];
  timeoutId?: NodeJS.Timeout;
  turnStartedAt?: number;
  inboundMessageId?: string;
  seenMessageIds?: Set<string>;
  backgroundDelivery: {
    conversationId: string;
    platform: Platform;
  };
}

type CurrentTurnSelectionSource = 'store-by-id' | 'store-turn-boundary' | 'accumulator';

interface CurrentTurnSelection {
  messages: CoworkMessage[];
  source: CurrentTurnSelectionSource;
}

interface PendingIMPermission {
  key: string;
  sessionId: string;
  request: PermissionRequest;
  conversationId: string;
  platform: Platform;
  createdAt: number;
  timeoutId?: NodeJS.Timeout;
}

const PERMISSION_CONFIRM_TIMEOUT_MS = 60_000;
const ACCUMULATOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface IMCoworkHandlerOptions {
  coworkRuntime: CoworkRuntime;
  coworkStore: CoworkStore;
  imStore: IMStore;
  sendAsyncReply?: (platform: Platform, conversationId: string, text: string) => Promise<boolean>;
}

export class IMCoworkHandler extends EventEmitter {
  private coworkRuntime: CoworkRuntime;
  private coworkStore: CoworkStore;
  private imStore: IMStore;
  private sendAsyncReply?: (platform: Platform, conversationId: string, text: string) => Promise<boolean>;

  // Track active sessions' message accumulation
  private messageAccumulators: Map<string, MessageAccumulator> = new Map();

  // Track which sessions are created by IM (to filter events)
  private imSessionIds: Set<string> = new Set();
  private sessionConversationMap: Map<string, { conversationId: string; platform: Platform }> = new Map();
  private pendingPermissionByConversation: Map<string, PendingIMPermission> = new Map();
  private readonly onMessage = this.handleMessage.bind(this);
  private readonly onMessageUpdate = this.handleMessageUpdate.bind(this);
  private readonly onPermissionRequest = this.handlePermissionRequest.bind(this);
  private readonly onComplete = this.handleComplete.bind(this);
  private readonly onError = this.handleError.bind(this);
  private readonly onSessionStopped = this.handleSessionStopped.bind(this);

  constructor(options: IMCoworkHandlerOptions) {
    super();
    this.coworkRuntime = options.coworkRuntime;
    this.coworkStore = options.coworkStore;
    this.imStore = options.imStore;
    this.sendAsyncReply = options.sendAsyncReply;

    this.initializeMappedSessions();
    this.setupEventListeners();
  }

  private initializeMappedSessions(): void {
    for (const mapping of this.imStore.listSessionMappings()) {
      const session = this.coworkStore.getSession(mapping.coworkSessionId);
      if (!session) {
        continue;
      }
      this.trackSessionMapping(mapping);
    }
  }

  private trackSessionMapping(mapping: IMSessionMapping): void {
    this.imSessionIds.add(mapping.coworkSessionId);
    this.sessionConversationMap.set(mapping.coworkSessionId, {
      conversationId: mapping.imConversationId,
      platform: mapping.platform,
    });
  }

  private ensureTrackedSession(sessionId: string): boolean {
    if (this.imSessionIds.has(sessionId)) {
      return true;
    }

    const mapping = this.imStore.getSessionMappingByCoworkSessionId(sessionId);
    if (!mapping) {
      return false;
    }

    this.trackSessionMapping(mapping);
    return true;
  }

  /**
   * Set up event listeners for CoworkRuntime
   */
  private setupEventListeners(): void {
    this.coworkRuntime.on('message', this.onMessage);
    this.coworkRuntime.on('messageUpdate', this.onMessageUpdate);
    this.coworkRuntime.on('permissionRequest', this.onPermissionRequest);
    this.coworkRuntime.on('complete', this.onComplete);
    this.coworkRuntime.on('error', this.onError);
    this.coworkRuntime.on('sessionStopped', this.onSessionStopped);
  }

  /**
   * Handle message event from CoworkRuntime
   */
  private handleMessage(sessionId: string, message: CoworkMessage): void {
    // Only process messages from IM sessions
    const tracked = this.ensureTrackedSession(sessionId);
    console.debug('[IMCoworkHandler:handleMessage] sessionId:', sessionId, 'tracked:', tracked, 'messageType:', message.type);
    if (!tracked) return;

    const accumulator = this.messageAccumulators.get(sessionId) ?? this.ensureBackgroundAccumulator(sessionId);
    console.debug('[IMCoworkHandler:handleMessage] accumulator exists:', !!accumulator, 'backgroundDelivery:', !!accumulator?.backgroundDelivery);
    if (accumulator) {
      accumulator.messages.push(message);
      accumulator.seenMessageIds?.add(message.id);
      if (message.type === 'user' || message.type === 'system') {
        accumulator.inboundMessageId = message.id;
      }
    }
  }

  /**
   * Handle message update event (streaming content)
   */
  private handleMessageUpdate(sessionId: string, messageId: string, content: string): void {
    // Only process updates from IM sessions
    if (!this.ensureTrackedSession(sessionId)) return;

    const accumulator = this.messageAccumulators.get(sessionId);
    if (accumulator) {
      // Update the message content in the accumulator
      const existingIndex = accumulator.messages.findIndex(m => m.id === messageId);
      if (existingIndex >= 0) {
        accumulator.messages[existingIndex].content = content;
      }
    }
  }

  private createConversationKey(conversationId: string, platform: Platform): string {
    return `${platform}:${conversationId}`;
  }

  private ensureBackgroundAccumulator(sessionId: string): MessageAccumulator | null {
    const conversation = this.sessionConversationMap.get(sessionId);
    if (!conversation) {
      return null;
    }

    const existing = this.messageAccumulators.get(sessionId);
    if (existing) {
      return existing;
    }

    const timeoutId = setTimeout(() => {
      const accumulator = this.messageAccumulators.get(sessionId);
      if (accumulator?.timeoutId !== timeoutId) {
        return;
      }
      this.cleanupAccumulator(sessionId);
    }, ACCUMULATOR_TIMEOUT_MS);

    const nextAccumulator: MessageAccumulator = {
      messages: [],
      timeoutId,
      turnStartedAt: Date.now(),
      seenMessageIds: new Set<string>(),
      backgroundDelivery: {
        conversationId: conversation.conversationId,
        platform: conversation.platform,
      },
    };
    this.messageAccumulators.set(sessionId, nextAccumulator);
    return nextAccumulator;
  }

  private clearPendingPermissionByKey(key: string): PendingIMPermission | null {
    const pending = this.pendingPermissionByConversation.get(key);
    if (!pending) return null;

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingPermissionByConversation.delete(key);
    return pending;
  }

  private clearPendingPermissionsBySessionId(sessionId: string): void {
    const keysToRemove: string[] = [];
    this.pendingPermissionByConversation.forEach((pending, key) => {
      if (pending.sessionId === sessionId) {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach((key) => this.clearPendingPermissionByKey(key));
  }

  /**
   * Track permission requests on IM sessions: deny one after 60s, or as soon as
   * a newer request in the same conversation supersedes it.
   */
  private handlePermissionRequest(sessionId: string, request: PermissionRequest): void {
    // Only process permission requests from IM sessions
    if (!this.ensureTrackedSession(sessionId)) return;
    const conversation = this.sessionConversationMap.get(sessionId);
    if (!conversation) {
      this.coworkRuntime.respondToPermission(request.requestId, {
        behavior: 'deny',
        message: 'IM session mapping missing for permission request.',
      });
      return;
    }

    const key = this.createConversationKey(conversation.conversationId, conversation.platform);
    const existingPending = this.clearPendingPermissionByKey(key);
    if (existingPending) {
      this.coworkRuntime.respondToPermission(existingPending.request.requestId, {
        behavior: 'deny',
        message: 'Superseded by a newer permission request.',
      });
    }

    const timeoutId = setTimeout(() => {
      const currentPending = this.pendingPermissionByConversation.get(key);
      if (!currentPending || currentPending.request.requestId !== request.requestId) {
        return;
      }
      this.clearPendingPermissionByKey(key);
      this.coworkRuntime.respondToPermission(request.requestId, {
        behavior: 'deny',
        message: 'Permission request timed out after 60s',
      });
    }, PERMISSION_CONFIRM_TIMEOUT_MS);

    this.pendingPermissionByConversation.set(key, {
      key,
      sessionId,
      request,
      conversationId: conversation.conversationId,
      platform: conversation.platform,
      createdAt: Date.now(),
      timeoutId,
    });

    // Reset the turn accumulator; the next runtime message starts a new one.
    this.cleanupAccumulator(sessionId);
  }

  /**
   * Handle session complete event
   */
  private handleComplete(sessionId: string): void {
    // Only process complete events from IM sessions
    const tracked = this.ensureTrackedSession(sessionId);
    console.debug('[IMCoworkHandler:handleComplete] sessionId:', sessionId, 'tracked:', tracked, 'hasAccumulator:', this.messageAccumulators.has(sessionId));
    if (!tracked) return;

    this.clearPendingPermissionsBySessionId(sessionId);
    const accumulator = this.messageAccumulators.get(sessionId);
    if (!accumulator) {
      return;
    }

    const session = this.coworkStore.getSession(sessionId);
    const storeMessages = session?.messages ?? [];
    const selection = this.selectCurrentTurnMessages(accumulator, storeMessages);
    const messages = selection.messages;

    const replyText = this.formatReplyRaw(messages);

    console.debug('[IMCoworkHandler] session completed:', JSON.stringify({
      sessionId,
      messageCount: messages.length,
      replyLength: replyText.length,
      backgroundDelivery: accumulator.backgroundDelivery,
      replySelection: {
        source: selection.source,
        selectedMessages: messages.length,
        storeMessages: storeMessages.length,
        accumulatorMessages: accumulator.messages.length,
      },
    }));

    this.cleanupAccumulator(sessionId);

    if (!this.sendAsyncReply || !replyText || replyText === '处理完成，但没有生成回复。') {
      console.warn('[IMCoworkHandler] cannot send async IM reminder reply', replyText);
      return;
    }
    if (!isReminderSystemTurn(messages)) {
      console.debug('[IMCoworkHandler] not a reminder system turn, skipping async reply');
      return;
    }
    const { platform, conversationId } = accumulator.backgroundDelivery;
    void this.sendAsyncReply(platform, conversationId, replyText).then((sent) => {
      if (!sent) {
        console.warn('[IMCoworkHandler] Failed to relay async IM reminder reply', JSON.stringify({
          sessionId,
          platform,
          conversationId,
        }));
      }
    }).catch((error) => {
      console.error('[IMCoworkHandler] Async IM reminder reply failed:', error);
    });
  }

  /**
   * Handle session error event
   */
  private handleError(sessionId: string): void {
    // Only process error events from IM sessions
    if (!this.ensureTrackedSession(sessionId)) return;

    this.clearPendingPermissionsBySessionId(sessionId);
    this.cleanupAccumulator(sessionId);
  }

  private handleSessionStopped(sessionId: string): void {
    if (!this.ensureTrackedSession(sessionId)) return;

    this.clearPendingPermissionsBySessionId(sessionId);
    this.cleanupAccumulator(sessionId);
  }

  /**
   * Clean up accumulator
   */
  private cleanupAccumulator(sessionId: string): void {
    const accumulator = this.messageAccumulators.get(sessionId);
    if (accumulator?.timeoutId) {
      clearTimeout(accumulator.timeoutId);
    }
    this.messageAccumulators.delete(sessionId);
  }

  private selectCurrentTurnMessages(
    accumulator: MessageAccumulator,
    storeMessages: CoworkMessage[],
  ): CurrentTurnSelection {
    const byId = this.selectStoreMessagesByAccumulatorIds(accumulator, storeMessages);
    if (byId.length > 0 && (byId.length === accumulator.messages.length || this.hasVisibleAssistantMessage(byId))) {
      return { messages: byId, source: 'store-by-id' };
    }

    const byTurnBoundary = this.selectStoreMessagesByTurnBoundary(accumulator, storeMessages);
    if (byTurnBoundary.length > 0) {
      return { messages: byTurnBoundary, source: 'store-turn-boundary' };
    }

    return { messages: accumulator.messages, source: 'accumulator' };
  }

  private selectStoreMessagesByAccumulatorIds(
    accumulator: MessageAccumulator,
    storeMessages: CoworkMessage[],
  ): CoworkMessage[] {
    if (storeMessages.length === 0 || accumulator.messages.length === 0) {
      return [];
    }

    const storeById = new Map(storeMessages.map((message) => [message.id, message]));
    const selected: CoworkMessage[] = [];
    const seen = new Set<string>();
    for (const message of accumulator.messages) {
      if (!message.id || seen.has(message.id)) continue;
      const storeMessage = storeById.get(message.id);
      if (!storeMessage) continue;
      selected.push(storeMessage);
      seen.add(message.id);
    }
    return selected;
  }

  private selectStoreMessagesByTurnBoundary(
    accumulator: MessageAccumulator,
    storeMessages: CoworkMessage[],
  ): CoworkMessage[] {
    const boundaryIndex = this.findCurrentTurnBoundary(accumulator, storeMessages);
    if (boundaryIndex < 0) {
      return [];
    }

    const scopedMessages = storeMessages.slice(boundaryIndex).filter((message) => (
      message.type === 'user'
      || message.type === 'system'
      || message.type === 'assistant'
      || message.type === 'tool_use'
      || message.type === 'tool_result'
    ));

    return this.hasTurnOutputMessages(scopedMessages) ? scopedMessages : [];
  }

  private findCurrentTurnBoundary(
    accumulator: MessageAccumulator,
    storeMessages: CoworkMessage[],
  ): number {
    if (storeMessages.length === 0) {
      return -1;
    }

    if (accumulator.inboundMessageId) {
      const byId = storeMessages.findIndex((message) => message.id === accumulator.inboundMessageId);
      if (byId >= 0) {
        return byId;
      }
    }

    const accumulatorBoundary = this.findLastInputMessage(accumulator.messages);
    if (accumulatorBoundary) {
      const boundaryContent = this.normalizeBoundaryContent(accumulatorBoundary.content);
      for (let index = storeMessages.length - 1; index >= 0; index -= 1) {
        const candidate = storeMessages[index];
        if (!this.isInputMessage(candidate)) continue;
        if (candidate.type !== accumulatorBoundary.type) continue;
        if (this.normalizeBoundaryContent(candidate.content) === boundaryContent) {
          return index;
        }
      }
    }

    if (typeof accumulator.turnStartedAt === 'number') {
      for (let index = storeMessages.length - 1; index >= 0; index -= 1) {
        const candidate = storeMessages[index];
        if (!this.isInputMessage(candidate)) continue;
        if (candidate.timestamp >= accumulator.turnStartedAt) {
          return index;
        }
      }
    }

    return -1;
  }

  private findLastInputMessage(messages: CoworkMessage[]): CoworkMessage | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (this.isInputMessage(message)) {
        return message;
      }
    }
    return null;
  }

  private isInputMessage(message: CoworkMessage): boolean {
    return message.type === 'user' || message.type === 'system';
  }

  private hasTurnOutputMessages(messages: CoworkMessage[]): boolean {
    return messages.some((message) => (
      message.type === 'assistant'
      || message.type === 'tool_use'
      || message.type === 'tool_result'
    ));
  }

  private hasVisibleAssistantMessage(messages: CoworkMessage[]): boolean {
    return messages.some((message) => (
      message.type === 'assistant'
      && !message.metadata?.isThinking
      && Boolean(stripThinkingBlocks(message.content))
    ));
  }

  private normalizeBoundaryContent(content: string): string {
    return content.replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract the assistant text of a turn for an async reminder relay. The
   * reply IS the scheduled reminder, so it is sent as-is.
   */
  private formatReplyRaw(messages: CoworkMessage[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      if (message.type === 'assistant' && message.content && !message.metadata?.isThinking) {
        const text = stripThinkingBlocks(message.content);
        if (text) parts.push(text);
      }
    }
    return parts.join('\n\n') || DEFAULT_IM_EMPTY_REPLY;
  }

  /**
   * Cleanup when handler is destroyed
   */
  destroy(): void {
    // Clear all pending accumulators
    this.messageAccumulators.forEach((accumulator) => {
      if (accumulator.timeoutId) {
        clearTimeout(accumulator.timeoutId);
      }
    });
    this.messageAccumulators.clear();
    this.imSessionIds.clear();
    this.sessionConversationMap.clear();

    this.pendingPermissionByConversation.forEach((pending) => {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
    });
    this.pendingPermissionByConversation.clear();

    // Remove event listeners
    this.coworkRuntime.off('message', this.onMessage);
    this.coworkRuntime.off('messageUpdate', this.onMessageUpdate);
    this.coworkRuntime.off('permissionRequest', this.onPermissionRequest);
    this.coworkRuntime.off('complete', this.onComplete);
    this.coworkRuntime.off('error', this.onError);
    this.coworkRuntime.off('sessionStopped', this.onSessionStopped);
  }
}
