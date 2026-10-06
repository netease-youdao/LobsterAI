import { extractGatewayMessageThinking } from '../../openclawHistory';

export const OpenClawThinkingMetadata = {
  AnchorToolCallId: 'openclawThinkingAnchorToolCallId',
  Key: 'openclawThinkingKey',
} as const;

export interface OpenClawThinkingBlock {
  key: string;
  text: string;
  assistantOrdinal: number;
  contentIndex: number;
  anchorToolCallId?: string;
}

type IndexedToolCall = {
  contentIndex: number;
  toolCallId: string;
};

type IndexedThinking = {
  contentIndex: number;
  text: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const getRole = (message: Record<string, unknown>): string => {
  return typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
};

const getToolCallId = (block: Record<string, unknown>): string => {
  for (const key of ['id', 'toolCallId', 'tool_call_id'] as const) {
    const value = block[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const isToolCallBlock = (block: Record<string, unknown>): boolean => {
  return block.type === 'toolCall'
    || block.type === 'tool_use'
    || block.type === 'tool_call';
};

const extractThinkingText = (block: Record<string, unknown>): string => {
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return block.thinking.trim();
  }
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text'] as const) {
    const value = block[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const fingerprintText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export const buildAnchoredThinkingKey = (
  toolCallId: string,
  thinkingOrdinal = 0,
): string => `tool:${toolCallId}:thinking:${thinkingOrdinal}`;

const findCurrentTurnStart = (messages: unknown[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && getRole(message) === 'user') {
      return index + 1;
    }
  }
  return 0;
};

const collectAssistantParts = (message: Record<string, unknown>): {
  thinking: IndexedThinking[];
  toolCalls: IndexedToolCall[];
} => {
  const content = Array.isArray(message.content) ? message.content : [];
  const thinking: IndexedThinking[] = [];
  const toolCalls: IndexedToolCall[] = [];

  content.forEach((value, contentIndex) => {
    if (!isRecord(value)) return;
    const thinkingText = extractThinkingText(value);
    if (thinkingText) {
      thinking.push({ contentIndex, text: thinkingText });
    }
    if (isToolCallBlock(value)) {
      const toolCallId = getToolCallId(value);
      if (toolCallId) {
        toolCalls.push({ contentIndex, toolCallId });
      }
    }
  });

  if (thinking.length === 0) {
    const fallback = extractGatewayMessageThinking(message);
    if (fallback) {
      thinking.push({ contentIndex: -1, text: fallback });
    }
  }

  return { thinking, toolCalls };
};

export const extractCurrentTurnThinkingBlocks = (messages: unknown[]): OpenClawThinkingBlock[] => {
  const blocks: OpenClawThinkingBlock[] = [];
  const duplicateKeyCount = new Map<string, number>();
  let assistantOrdinal = 0;

  for (let messageIndex = findCurrentTurnStart(messages); messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message) || getRole(message) !== 'assistant') continue;

    const parts = collectAssistantParts(message);
    parts.thinking.forEach((thinking, thinkingOrdinal) => {
      const nextToolCall = parts.toolCalls.find((toolCall) => {
        return thinking.contentIndex < 0 || toolCall.contentIndex > thinking.contentIndex;
      });
      const anchorToolCallId = nextToolCall?.toolCallId;
      const baseKey = anchorToolCallId
        ? buildAnchoredThinkingKey(anchorToolCallId, thinkingOrdinal)
        : `final:thinking:${fingerprintText(thinking.text)}`;
      const duplicateIndex = duplicateKeyCount.get(baseKey) ?? 0;
      duplicateKeyCount.set(baseKey, duplicateIndex + 1);
      const key = duplicateIndex === 0 ? baseKey : `${baseKey}:${duplicateIndex}`;

      blocks.push({
        key,
        text: thinking.text,
        assistantOrdinal,
        contentIndex: thinking.contentIndex,
        ...(anchorToolCallId ? { anchorToolCallId } : {}),
      });
    });
    assistantOrdinal += 1;
  }

  return blocks;
};
