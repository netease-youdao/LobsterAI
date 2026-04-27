import {
  parseScheduledReminderPrompt,
  parseSimpleScheduledReminderText,
} from '../../scheduledTask/reminderText';

type GatewayHistoryRole = 'user' | 'assistant' | 'system';

export interface GatewayHistoryEntry {
  role: GatewayHistoryRole;
  text: string;
}

const HEARTBEAT_ACK_RE = /^[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}HEARTBEAT_OK[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}$/i;
const HEARTBEAT_PROMPT_MARKERS = [
  'read heartbeat.md if it exists',
  'when reading heartbeat.md',
  'reply heartbeat_ok',
  'do not infer or repeat old tasks from prior chats',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const collectTextChunks = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextChunks(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const chunks: string[] = [];
  if (typeof value.text === 'string') {
    const text = value.text.trim();
    if (text) {
      chunks.push(text);
    }
  }

  if (value.content !== undefined) {
    chunks.push(...collectTextChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectTextChunks(value.parts));
  }

  return chunks;
};

export const extractGatewayMessageText = (message: unknown): string => {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) {
    return '';
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks = collectTextChunks(content);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }
  if (isRecord(content)) {
    const chunks = collectTextChunks(content);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }
  if (typeof message.text === 'string') {
    return message.text;
  }
  return '';
};

export const buildScheduledReminderSystemMessage = (text: string): string | null => {
  const parsed = parseScheduledReminderPrompt(text);
  if (!parsed) {
    return parseSimpleScheduledReminderText(text)?.reminderText ?? null;
  }

  return parsed.reminderText;
};

export const isHeartbeatAckText = (text: string): boolean => HEARTBEAT_ACK_RE.test(text.trim());

export const isHeartbeatPromptText = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return HEARTBEAT_PROMPT_MARKERS.every((marker) => normalized.includes(marker));
};

export const shouldSuppressHeartbeatText = (role: GatewayHistoryRole, text: string): boolean => {
  if ((role === 'assistant' || role === 'system') && isHeartbeatAckText(text)) {
    return true;
  }
  if (role === 'user' && isHeartbeatPromptText(text)) {
    return true;
  }
  return false;
};

export const extractGatewayHistoryEntry = (message: unknown): GatewayHistoryEntry | null => {
  if (!isRecord(message)) {
    return null;
  }

  const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    return null;
  }

  const text = extractGatewayMessageText(message).trim();
  if (!text) {
    return null;
  }
  if (shouldSuppressHeartbeatText(role, text)) {
    return null;
  }

  const reminderSystemMessage = role === 'user'
    ? buildScheduledReminderSystemMessage(text)
    : null;
  if (reminderSystemMessage) {
    return {
      role: 'system',
      text: reminderSystemMessage,
    };
  }

  return {
    role,
    text,
  };
};

export const extractGatewayHistoryEntries = (messages: unknown[]): GatewayHistoryEntry[] => {
  return messages
    .map((message) => extractGatewayHistoryEntry(message))
    .filter((entry): entry is GatewayHistoryEntry => entry !== null);
};
