import React from 'react';

import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import { AssistantMessageMeta, getAssistantMessageCopyContent } from './AssistantMessageItem';
import {
  type ConversationTurn,
  getMessageModelLabelParts,
  getTurnEndTimestamp,
  getVisibleAssistantItems,
  resolveTurnModelMetadata,
} from './messageDisplayUtils';
import { getConversationTurnUsage } from './turnUsageDisplay';

/** The normal reply footer also serves turns stopped during thinking or a tool call. */
const AssistantTurnFooter: React.FC<{
  turn: ConversationTurn;
  turnUsageSlot: React.ReactNode;
  mapDisplayText?: (value: string) => string;
  onForkMessage?: (messageId: string) => void;
  compactMeta?: boolean;
}> = ({ turn, turnUsageSlot, mapDisplayText, onForkMessage, compactMeta = false }) => {
  const messages = turn.assistantItems.flatMap((item): CoworkMessage[] => (
    item.type === 'tool_group'
      ? [item.group.toolUse, ...(item.group.toolResult ? [item.group.toolResult] : [])]
      : [item.message]
  ));
  // Keep tool results and thinking in a fork, even when they follow the last text reply.
  const anchor = messages[messages.length - 1] ?? turn.userMessage;
  if (!anchor) return null;

  const userMetadata = turn.userMessage?.metadata as CoworkMessageMetadata | undefined;
  const lastModelMessage = [...messages].reverse().find(message => (
    message.type === 'assistant' && getMessageModelLabelParts(message.metadata)
  ));
  const turnMetadata = resolveTurnModelMetadata(lastModelMessage?.metadata, userMetadata, getConversationTurnUsage(turn));
  const copyContent = getVisibleAssistantItems(turn.assistantItems)
    .flatMap(item => item.type === 'assistant' && !item.message.metadata?.isThinking ? [item.message] : [])
    .map(message => getAssistantMessageCopyContent(mapDisplayText ? mapDisplayText(message.content) : message.content))
    .filter(content => content.trim())
    .join('\n\n');

  return (
    <AssistantMessageMeta
      message={anchor}
      timestamp={getTurnEndTimestamp(turn) ?? anchor.timestamp}
      turnMetadata={turnMetadata}
      turnUsageSlot={turnUsageSlot}
      copyContent={copyContent}
      onFork={onForkMessage}
      compactMeta={compactMeta}
    />
  );
};

export default AssistantTurnFooter;
