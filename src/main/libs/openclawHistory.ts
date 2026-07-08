import { isInternalCompactionSystemText } from '../../common/coworkSystemMessages';
import {
  parseScheduledReminderPrompt,
  parseSimpleScheduledReminderText,
} from '../../scheduledTask/reminderText';

type GatewayHistoryRole = 'user' | 'assistant' | 'system';

export interface GatewayHistoryEntry {
  role: GatewayHistoryRole;
  text: string;
  timestamp?: number;
  usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
  model?: string;
  mediaAttachments?: GatewayHistoryMediaAttachment[];
}

export interface GatewayHistoryMediaAttachment {
  localPath: string;
  mimeType?: string;
}

const HEARTBEAT_ACK_RE = /^[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}HEARTBEAT_OK[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}$/i;
const SILENT_REPLY_RE = /^[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}NO_REPLY[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}$/i;
const SILENT_REPLY_TOKEN = 'NO_REPLY';
const HEARTBEAT_PROMPT_MARKERS = [
  'read heartbeat.md if it exists',
  'when reading heartbeat.md',
  'reply heartbeat_ok',
  'do not infer or repeat old tasks from prior chats',
] as const;
const PRE_COMPACTION_MEMORY_FLUSH_MARKERS = [
  'pre-compaction memory flush',
  'store durable memories only in memory/',
  'reply with no_reply',
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
  // Skip thinking blocks from regular text extraction (handled separately)
  // if (value.type === 'thinking') → see collectThinkingChunks()

  if (value.content !== undefined) {
    chunks.push(...collectTextChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectTextChunks(value.parts));
  }

  return chunks;
};

const parseGatewayTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const extractGatewayTimestamp = (message: Record<string, unknown>): number | undefined => {
  return parseGatewayTimestamp(message.timestamp)
    ?? parseGatewayTimestamp(message.createdAt)
    ?? parseGatewayTimestamp(message.created_at)
    ?? parseGatewayTimestamp(message.time);
};

const getStringArrayField = (message: Record<string, unknown>, keys: string[]): string[] => {
  for (const key of keys) {
    const value = message[key];
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    }
  }
  return [];
};

const extractGatewayMediaAttachments = (message: Record<string, unknown>): GatewayHistoryMediaAttachment[] | undefined => {
  const paths = getStringArrayField(message, ['MediaPaths', 'mediaPaths', 'MediaPath', 'mediaPath']);
  if (paths.length === 0) {
    return undefined;
  }

  const mimeTypes = getStringArrayField(message, ['MediaTypes', 'mediaTypes', 'MediaType', 'mediaType']);
  const seen = new Set<string>();
  const attachments: GatewayHistoryMediaAttachment[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const localPath = paths[index];
    const key = localPath.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const mimeType = mimeTypes[index] || mimeTypes[0];
    attachments.push({
      localPath,
      ...(mimeType ? { mimeType } : {}),
    });
  }

  return attachments.length > 0 ? attachments : undefined;
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

const collectThinkingChunks = (value: unknown): string[] => {
  if (typeof value === 'string') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectThinkingChunks(item));
  }
  if (!isRecord(value)) return [];

  const chunks: string[] = [];
  if (value.type === 'thinking' && typeof value.thinking === 'string') {
    const thinking = value.thinking.trim();
    if (thinking) {
      chunks.push(thinking);
    }
  }
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text'] as const) {
    if (typeof value[key] === 'string') {
      const thinking = value[key].trim();
      if (thinking) {
        chunks.push(thinking);
      }
    }
  }
  if (value.content !== undefined) {
    chunks.push(...collectThinkingChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectThinkingChunks(value.parts));
  }
  return chunks;
};

export const extractGatewayMessageThinking = (message: unknown): string => {
  if (!isRecord(message)) return '';
  return collectThinkingChunks(message).join('\n\n').trim();
};

export const buildScheduledReminderSystemMessage = (text: string): string | null => {
  const parsed = parseScheduledReminderPrompt(text);
  if (!parsed) {
    return parseSimpleScheduledReminderText(text)?.reminderText ?? null;
  }

  return parsed.reminderText;
};

export const isHeartbeatAckText = (text: string): boolean => HEARTBEAT_ACK_RE.test(text.trim());

export const isSilentReplyText = (text: string): boolean => SILENT_REPLY_RE.test(text.trim());

export const isSilentReplyPrefixText = (text: string): boolean => {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.length < 2) return false;
  if (isSilentReplyText(trimmed)) return false;
  if (trimmed !== trimmed.toUpperCase()) return false;
  if (/[^A-Z_]/.test(trimmed)) return false;
  const tokenUpper = SILENT_REPLY_TOKEN.toUpperCase();
  if (!tokenUpper.startsWith(trimmed)) return false;
  if (trimmed.includes('_')) return true;
  return trimmed === 'NO';
};

const TRAILING_SILENT_REPLY_RE = /\n\s*NO_REPLY\s*$/i;

export const stripTrailingSilentReplyToken = (text: string): string => {
  return text.replace(TRAILING_SILENT_REPLY_RE, '').trimEnd();
};

const TRAILING_SILENT_REPLY_PARTIAL_TOKENS = [
  'NO_REPLY', 'NO_REPL', 'NO_REP', 'NO_RE', 'NO_R', 'NO_', 'NO',
];

export const stripTrailingSilentReplyTail = (text: string): string => {
  const stripped = text.replace(TRAILING_SILENT_REPLY_RE, '');
  if (stripped !== text) return stripped.trimEnd();
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return text;
  const tail = text.slice(lastNewline + 1).trim().toUpperCase();
  if (!tail) return text;
  for (const token of TRAILING_SILENT_REPLY_PARTIAL_TOKENS) {
    if (tail === token) {
      return text.slice(0, lastNewline).trimEnd();
    }
  }
  return text;
};

export const isHeartbeatPromptText = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return HEARTBEAT_PROMPT_MARKERS.every((marker) => normalized.includes(marker));
};

export const isPreCompactionMemoryFlushPromptText = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return PRE_COMPACTION_MEMORY_FLUSH_MARKERS.every((marker) => normalized.includes(marker));
};

export const shouldSuppressHeartbeatText = (role: GatewayHistoryRole, text: string): boolean => {
  if ((role === 'assistant' || role === 'system') && (isHeartbeatAckText(text) || isSilentReplyText(text))) {
    return true;
  }
  if (role === 'user' && (isHeartbeatPromptText(text) || isPreCompactionMemoryFlushPromptText(text))) {
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

  let text = extractGatewayMessageText(message).trim();
  const mediaAttachments = extractGatewayMediaAttachments(message);
  if (!text && !(role === 'user' && mediaAttachments?.length)) {
    return null;
  }
  if (role === 'assistant') {
    text = stripTrailingSilentReplyToken(text);
    if (!text) {
      return null;
    }
  }
  if (shouldSuppressHeartbeatText(role, text)) {
    return null;
  }
  if (role === 'system' && isInternalCompactionSystemText(text)) {
    return null;
  }

  const reminderSystemMessage = role === 'user'
    ? buildScheduledReminderSystemMessage(text)
    : null;
  const timestamp = extractGatewayTimestamp(message);
  if (reminderSystemMessage) {
    return {
      role: 'system',
      text: reminderSystemMessage,
      ...(timestamp != null && { timestamp }),
    };
  }

  // Extract usage and model for assistant messages
  let usage: { input?: number; output?: number; cacheRead?: number; totalTokens?: number } | undefined;
  let model: string | undefined;
  if (role === 'assistant') {
    if (isRecord(message.usage)) {
      const u = message.usage as Record<string, unknown>;
      const input = typeof u.input === 'number' ? u.input
        : typeof u.inputTokens === 'number' ? u.inputTokens : undefined;
      const output = typeof u.output === 'number' ? u.output
        : typeof u.outputTokens === 'number' ? u.outputTokens : undefined;
      const cacheRead = typeof u.cacheRead === 'number' ? u.cacheRead
        : typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : undefined;
      const totalTokens = typeof u.totalTokens === 'number' ? u.totalTokens : undefined;
      if (input != null || output != null || cacheRead != null || totalTokens != null) {
        usage = {
          ...(input != null && { input }),
          ...(output != null && { output }),
          ...(cacheRead != null && { cacheRead }),
          ...(totalTokens != null && { totalTokens }),
        };
      }
    }
    if (typeof message.model === 'string') {
      model = message.model;
    }
  }

  return {
    role,
    text,
    ...(timestamp != null && { timestamp }),
    ...(usage && { usage }),
    ...(model && { model }),
    ...(mediaAttachments && { mediaAttachments }),
  };
};

export const extractGatewayHistoryEntries = (messages: unknown[]): GatewayHistoryEntry[] => {
  return messages
    .map((message) => extractGatewayHistoryEntry(message))
    .filter((entry): entry is GatewayHistoryEntry => entry !== null);
};
