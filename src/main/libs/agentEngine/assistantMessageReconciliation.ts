import type { CoworkMessage } from '../../coworkStore';
import { extractGatewayMessageThinking } from '../openclawHistory';

type GatewayHistoryMessage = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const isThinkingAssistantMessage = (message: CoworkMessage): boolean => {
  return message.type === 'assistant'
    && isRecord(message.metadata)
    && message.metadata.isThinking === true;
};

export const isRedundantFinalPrefixSegment = (candidate: string, finalText: string): boolean => {
  const normalizedCandidate = candidate.replace(/\s+/g, ' ').trim();
  const normalizedFinal = finalText.replace(/\s+/g, ' ').trim();
  if (normalizedCandidate.length < 80 || normalizedFinal.length <= normalizedCandidate.length) {
    return false;
  }
  if (!normalizedFinal.startsWith(normalizedCandidate)) {
    return false;
  }
  return normalizedCandidate.length / normalizedFinal.length >= 0.35;
};

export const extractThinkingFromCurrentTurn = (messages: unknown[]): string => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as GatewayHistoryMessage).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const thinkingParts: string[] = [];
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    const thinking = extractGatewayMessageThinking(msg);
    if (thinking) {
      thinkingParts.push(thinking);
    }
  }
  return thinkingParts.join('\n\n').trim();
};

export const findMatchingThinkingMessageIdInCurrentTurn = (
  messages: CoworkMessage[],
  thinkingText: string,
): string | null => {
  const targetText = thinkingText.trim();
  if (!targetText) return null;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === 'user') break;
    if (!isThinkingAssistantMessage(message)) continue;
    if (message.content.trim() === targetText) {
      return message.id;
    }
  }
  return null;
};

export const findReusableFinalAssistantMessageId = (
  messages: CoworkMessage[],
  content: string,
): string | null => {
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return null;
  }

  // Scan backward: in normal flow the assistant message is last; after a skill
  // switch one user message may sit between the previous assistant reply and
  // this sync. Allow at most one non-assistant message before giving up.
  let nonAssistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'assistant') {
      return !isThinkingAssistantMessage(msg) && msg.content.trim() === normalizedContent ? msg.id : null;
    }
    nonAssistantCount++;
    if (nonAssistantCount > 1) {
      return null;
    }
  }
  return null;
};

export const findReusableCommittedAssistantMessageId = (
  messages: CoworkMessage[],
  messageId: string | null | undefined,
  content: string,
): string | null => {
  const normalizedContent = content.trim();
  if (!messageId || !normalizedContent) {
    return null;
  }

  const message = messages.find((candidate) => candidate.id === messageId);
  if (
    !message
    || message.type !== 'assistant'
    || isThinkingAssistantMessage(message)
    || message.content.trim() !== normalizedContent
  ) {
    return null;
  }
  return message.id;
};

export const findRedundantFinalPrefixMessageId = (
  messages: CoworkMessage[],
  finalMessageId: string | null | undefined,
  finalText: string,
): string | null => {
  const normalizedFinalText = finalText.trim();
  if (!normalizedFinalText) return null;

  const finalIndex = finalMessageId
    ? messages.findIndex((message) => message.id === finalMessageId)
    : messages.length;
  const scanStart = finalIndex >= 0 ? finalIndex - 1 : messages.length - 1;

  for (let i = scanStart; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type === 'user') {
      return null;
    }
    if (message.type !== 'assistant' || message.id === finalMessageId) {
      continue;
    }
    if (isThinkingAssistantMessage(message)) {
      continue;
    }
    return isRedundantFinalPrefixSegment(message.content, normalizedFinalText)
      ? message.id
      : null;
  }
  return null;
};
