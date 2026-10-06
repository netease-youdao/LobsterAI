import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkStore,
} from '../../../coworkStore';
import { buildAnchoredThinkingKey } from './blocks';
import { logThinkingDiagnostic } from './diagnostics';
import { reconcileOpenClawThinkingBlocks } from './reconciliation';

export interface OpenClawThinkingTurnState {
  messageId: string | null;
  currentText: string;
  messageIdByKey: Map<string, string>;
}

export interface OpenClawThinkingTurnContext {
  assistantMessageId?: string | null;
  toolUseMessageIdByToolCallId: Map<string, string>;
  thinking: OpenClawThinkingTurnState;
}

interface OpenClawThinkingControllerDependencies {
  store: Pick<CoworkStore, 'addMessage' | 'getSession' | 'insertMessageBeforeId' | 'updateMessage'>;
  emitMessage: (sessionId: string, message: CoworkMessage, beforeMessageId?: string) => void;
  emitMessageUpdate: (
    sessionId: string,
    messageId: string,
    content: string,
    metadata?: CoworkMessageMetadata,
  ) => void;
  throttledStoreUpdate: (
    sessionId: string,
    messageId: string,
    content: string,
    metadata: { isStreaming: boolean; isFinal: boolean; isThinking?: boolean },
  ) => void;
  throttledEmitMessageUpdate: (sessionId: string, messageId: string, content: string) => void;
  flushPendingStoreUpdate: (sessionId: string, messageId: string) => void;
  clearPendingMessageUpdate: (messageId: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

export const createOpenClawThinkingTurnState = (): OpenClawThinkingTurnState => ({
  messageId: null,
  currentText: '',
  messageIdByKey: new Map(),
});

export class OpenClawThinkingController {
  constructor(private readonly dependencies: OpenClawThinkingControllerDependencies) {}

  handleStream(sessionId: string, turn: OpenClawThinkingTurnContext, data: unknown): void {
    if (!isRecord(data)) return;

    const cumulativeText = typeof data.text === 'string' ? data.text.trim() : '';
    const deltaText = typeof data.delta === 'string' ? data.delta : '';
    const nextText = cumulativeText || `${turn.thinking.currentText}${deltaText}`.trim();
    if (!nextText || nextText === turn.thinking.currentText) return;

    if (turn.thinking.currentText && !nextText.startsWith(turn.thinking.currentText)) {
      this.finalize(sessionId, turn);
    }

    turn.thinking.currentText = nextText;
    logThinkingDiagnostic(
      'adapterAction=thinking-stream-update',
      `sessionId=${sessionId}`,
      `chars=${nextText.length}`,
      `deltaChars=${deltaText.length}`,
      `thinkingMessage=${turn.thinking.messageId ?? '-'}`,
    );
    this.sync(sessionId, turn);
  }

  sync(sessionId: string, turn: OpenClawThinkingTurnContext): void {
    const thinkingText = turn.thinking.currentText;
    if (!thinkingText) return;

    if (!turn.thinking.messageId) {
      const insertBeforeId = turn.assistantMessageId || undefined;
      logThinkingDiagnostic(
        'thinking-message-create',
        `sessionId=${sessionId}`,
        `chars=${thinkingText.length}`,
        `before=${insertBeforeId ?? '-'}`,
        `toolMessages=${turn.toolUseMessageIdByToolCallId.size}`,
      );
      const payload = {
        type: 'assistant' as const,
        content: thinkingText,
        metadata: { isThinking: true, isStreaming: true, isFinal: false },
      };
      const message = insertBeforeId
        ? this.dependencies.store.insertMessageBeforeId(sessionId, insertBeforeId, payload)
        : this.dependencies.store.addMessage(sessionId, payload);
      turn.thinking.messageId = message.id;
      this.dependencies.emitMessage(sessionId, message, insertBeforeId);
      return;
    }

    logThinkingDiagnostic(
      'thinking-message-update',
      `sessionId=${sessionId}`,
      `messageId=${turn.thinking.messageId}`,
      `chars=${thinkingText.length}`,
    );
    this.dependencies.throttledStoreUpdate(
      sessionId,
      turn.thinking.messageId,
      thinkingText,
      { isThinking: true, isStreaming: true, isFinal: false },
    );
    this.dependencies.throttledEmitMessageUpdate(sessionId, turn.thinking.messageId, thinkingText);
  }

  finalize(sessionId: string, turn: OpenClawThinkingTurnContext): string | undefined {
    const messageId = turn.thinking.messageId;
    if (!messageId) return undefined;

    logThinkingDiagnostic(
      'thinking-message-finalize',
      `sessionId=${sessionId}`,
      `messageId=${messageId}`,
      `chars=${turn.thinking.currentText.length}`,
      `toolMessages=${turn.toolUseMessageIdByToolCallId.size}`,
    );
    this.dependencies.flushPendingStoreUpdate(sessionId, messageId);
    this.dependencies.clearPendingMessageUpdate(messageId);

    const existingMessage = this.dependencies.store
      .getSession(sessionId)?.messages.find((message) => message.id === messageId);
    const metadata: CoworkMessageMetadata = {
      ...existingMessage?.metadata,
      isThinking: true,
      isStreaming: false,
      isFinal: true,
    };
    this.dependencies.store.updateMessage(sessionId, messageId, {
      content: turn.thinking.currentText || undefined,
      metadata,
    });
    if (turn.thinking.currentText) {
      this.dependencies.emitMessageUpdate(
        sessionId,
        messageId,
        turn.thinking.currentText,
        metadata,
      );
    }

    turn.thinking.messageId = null;
    turn.thinking.currentText = '';
    return messageId;
  }

  finalizeBeforeTool(
    sessionId: string,
    turn: OpenClawThinkingTurnContext,
    toolCallId?: string,
  ): void {
    logThinkingDiagnostic(
      'tool-boundary-split',
      `sessionId=${sessionId}`,
      `assistantMessage=${turn.assistantMessageId ?? '-'}`,
      `thinkingMessage=${turn.thinking.messageId ?? '-'}`,
      `thinkingChars=${turn.thinking.currentText.length}`,
    );
    const messageId = this.finalize(sessionId, turn);
    if (messageId && toolCallId) {
      turn.thinking.messageIdByKey.set(buildAnchoredThinkingKey(toolCallId), messageId);
    }
  }

  reconcile(
    sessionId: string,
    turn: OpenClawThinkingTurnContext,
    historyMessages: unknown[],
    includeUnanchored: boolean,
  ): void {
    reconcileOpenClawThinkingBlocks({
      sessionId,
      historyMessages,
      includeUnanchored,
      assistantMessageId: turn.assistantMessageId ?? undefined,
      toolUseMessageIdByToolCallId: turn.toolUseMessageIdByToolCallId,
      messageIdByThinkingKey: turn.thinking.messageIdByKey,
      store: this.dependencies.store,
      emitMessage: (message, beforeMessageId) => {
        this.dependencies.emitMessage(sessionId, message, beforeMessageId);
      },
      emitMessageUpdate: (messageId, content, metadata) => {
        this.dependencies.emitMessageUpdate(sessionId, messageId, content, metadata);
      },
      onMessageCreated: ({ key, chars, beforeMessageId }) => {
        logThinkingDiagnostic(
          'history-thinking-block-create',
          `sessionId=${sessionId}`,
          `key=${key}`,
          `chars=${chars}`,
          `before=${beforeMessageId ?? '-'}`,
        );
      },
    });
  }
}
