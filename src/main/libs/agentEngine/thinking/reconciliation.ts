import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkStore,
} from '../../../coworkStore';
import {
  extractCurrentTurnThinkingBlocks,
  OpenClawThinkingMetadata,
} from './blocks';

type ThinkingMessagePayload = Omit<CoworkMessage, 'id' | 'timestamp'>;

export type OpenClawThinkingReconciliationStore = Pick<
  CoworkStore,
  'addMessage' | 'getSession' | 'insertMessageBeforeId' | 'updateMessage'
>;

export interface ReconcileOpenClawThinkingBlocksOptions {
  sessionId: string;
  historyMessages: unknown[];
  includeUnanchored: boolean;
  assistantMessageId?: string;
  toolUseMessageIdByToolCallId: ReadonlyMap<string, string>;
  messageIdByThinkingKey: Map<string, string>;
  store: OpenClawThinkingReconciliationStore;
  emitMessage: (message: CoworkMessage, beforeMessageId?: string) => void;
  emitMessageUpdate: (
    messageId: string,
    content: string,
    metadata: CoworkMessageMetadata,
  ) => void;
  onMessageCreated?: (details: {
    key: string;
    chars: number;
    beforeMessageId?: string;
  }) => void;
}

const getCurrentTurnMessages = (messages: CoworkMessage[]): CoworkMessage[] => {
  const lastUserIndex = messages.findLastIndex((message) => message.type === 'user');
  return messages.slice(lastUserIndex + 1);
};

const selectCanonicalBlocks = (
  historyMessages: unknown[],
  toolUseMessageIdByToolCallId: ReadonlyMap<string, string>,
  includeUnanchored: boolean,
) => {
  const extractedBlocks = extractCurrentTurnThinkingBlocks(historyMessages);
  const anchoredBlocks = extractedBlocks.filter((block) => {
    return block.anchorToolCallId
      && toolUseMessageIdByToolCallId.has(block.anchorToolCallId);
  });
  const unanchoredBlocks = extractedBlocks.filter((block) => !block.anchorToolCallId);
  const lastUnanchoredAssistantOrdinal = unanchoredBlocks.reduce(
    (latest, block) => Math.max(latest, block.assistantOrdinal),
    -1,
  );

  return [
    ...anchoredBlocks,
    ...(includeUnanchored
      ? unanchoredBlocks.filter((block) => {
        return block.assistantOrdinal === lastUnanchoredAssistantOrdinal;
      })
      : []),
  ].sort((left, right) => {
    return left.assistantOrdinal - right.assistantOrdinal
      || left.contentIndex - right.contentIndex;
  });
};

/**
 * Reconciles structured gateway thinking into local messages for one active turn.
 *
 * The key-to-message index is deliberately owned by the active turn instead of
 * being reconstructed only from `getSession()`: that API returns a paginated
 * tail, so early thinking messages can disappear from its window during long
 * tool-heavy turns even though they still exist in SQLite.
 */
export const reconcileOpenClawThinkingBlocks = (
  options: ReconcileOpenClawThinkingBlocksOptions,
): void => {
  const canonicalBlocks = selectCanonicalBlocks(
    options.historyMessages,
    options.toolUseMessageIdByToolCallId,
    options.includeUnanchored,
  );
  if (canonicalBlocks.length === 0) return;

  const session = options.store.getSession(options.sessionId);
  if (!session) return;

  const currentTurnMessages = getCurrentTurnMessages(session.messages);
  const claimedMessageIds = new Set<string>();

  for (const block of canonicalBlocks) {
    const anchorMessageId = block.anchorToolCallId
      ? options.toolUseMessageIdByToolCallId.get(block.anchorToolCallId)
      : options.assistantMessageId;
    const indexedMessageId = options.messageIdByThinkingKey.get(block.key);
    let message = indexedMessageId
      ? currentTurnMessages.find((candidate) => candidate.id === indexedMessageId)
      : undefined;
    let messageId = indexedMessageId;

    if (!messageId) {
      message = currentTurnMessages.find((candidate) => {
        return candidate.type === 'assistant'
          && candidate.metadata?.isThinking === true
          && candidate.metadata?.[OpenClawThinkingMetadata.Key] === block.key
          && !claimedMessageIds.has(candidate.id);
      });
      messageId = message?.id;
    }

    if (!messageId) {
      const anchorIndex = anchorMessageId
        ? currentTurnMessages.findIndex((candidate) => candidate.id === anchorMessageId)
        : currentTurnMessages.length;
      const reusableCandidates = currentTurnMessages.filter((candidate, index) => {
        return candidate.type === 'assistant'
          && candidate.metadata?.isThinking === true
          && !candidate.metadata?.[OpenClawThinkingMetadata.Key]
          && candidate.content.trim() === block.text
          && !claimedMessageIds.has(candidate.id)
          && (anchorIndex < 0 || index < anchorIndex);
      });
      message = reusableCandidates.at(-1);
      messageId = message?.id;
    }

    const metadata: CoworkMessageMetadata = {
      ...message?.metadata,
      isThinking: true,
      isStreaming: false,
      isFinal: true,
      [OpenClawThinkingMetadata.Key]: block.key,
      ...(block.anchorToolCallId
        ? { [OpenClawThinkingMetadata.AnchorToolCallId]: block.anchorToolCallId }
        : {}),
    };

    if (messageId) {
      claimedMessageIds.add(messageId);
      options.messageIdByThinkingKey.set(block.key, messageId);
      if (!message
          || message.content !== block.text
          || message.metadata?.[OpenClawThinkingMetadata.Key] !== block.key
          || message.metadata?.isStreaming !== false
          || message.metadata?.isFinal !== true) {
        options.store.updateMessage(options.sessionId, messageId, {
          content: block.text,
          metadata,
        });
        options.emitMessageUpdate(messageId, block.text, metadata);
      }
      continue;
    }

    const messagePayload: ThinkingMessagePayload = {
      type: 'assistant',
      content: block.text,
      metadata,
    };
    const thinkingMessage = anchorMessageId
      ? options.store.insertMessageBeforeId(options.sessionId, anchorMessageId, messagePayload)
      : options.store.addMessage(options.sessionId, messagePayload);
    claimedMessageIds.add(thinkingMessage.id);
    options.messageIdByThinkingKey.set(block.key, thinkingMessage.id);

    const localAnchorIndex = anchorMessageId
      ? currentTurnMessages.findIndex((candidate) => candidate.id === anchorMessageId)
      : -1;
    if (localAnchorIndex >= 0) {
      currentTurnMessages.splice(localAnchorIndex, 0, thinkingMessage);
    } else {
      currentTurnMessages.push(thinkingMessage);
    }

    options.emitMessage(thinkingMessage, anchorMessageId);
    options.onMessageCreated?.({
      key: block.key,
      chars: block.text.length,
      beforeMessageId: anchorMessageId,
    });
  }
};
