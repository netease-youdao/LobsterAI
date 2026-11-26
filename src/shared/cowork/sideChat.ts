import type { CoworkImageAttachmentPayload } from './imageAttachments';
import type { CoworkSelectedTextSnippet } from './selectedText';
import { stripNullChars } from './text';

export const CoworkSideChatStatus = {
  Idle: 'idle',
  Running: 'running',
  Error: 'error',
} as const;
export type CoworkSideChatStatus =
  typeof CoworkSideChatStatus[keyof typeof CoworkSideChatStatus];

export const CoworkSideChatMessageType = {
  User: 'user',
  Assistant: 'assistant',
  ToolUse: 'tool_use',
  ToolResult: 'tool_result',
  System: 'system',
} as const;
export type CoworkSideChatMessageType =
  typeof CoworkSideChatMessageType[keyof typeof CoworkSideChatMessageType];

export const CoworkSideChatIpcChannel = {
  List: 'cowork:sideChat:list',
  Get: 'cowork:sideChat:get',
  Create: 'cowork:sideChat:create',
  SendMessage: 'cowork:sideChat:sendMessage',
  Stop: 'cowork:sideChat:stop',
  Rename: 'cowork:sideChat:rename',
  Delete: 'cowork:sideChat:delete',
  Promote: 'cowork:sideChat:promote',
  RespondPermission: 'cowork:sideChat:respondPermission',
  StreamMessage: 'cowork:sideChat:stream:message',
  StreamMessageUpdate: 'cowork:sideChat:stream:messageUpdate',
  StreamStatus: 'cowork:sideChat:stream:status',
  StreamMetaChanged: 'cowork:sideChat:stream:metaChanged',
  StreamPermission: 'cowork:sideChat:stream:permission',
  StreamPermissionResolved: 'cowork:sideChat:stream:permissionResolved',
} as const;
export type CoworkSideChatIpcChannel =
  typeof CoworkSideChatIpcChannel[keyof typeof CoworkSideChatIpcChannel];

export const COWORK_SIDE_CHAT_TITLE_MAX_CHARS = 80;
export const COWORK_SIDE_CHAT_DERIVED_TITLE_MAX_CHARS = 44;

export interface CoworkSideChatMessage {
  id: string;
  sideChatId: string;
  type: CoworkSideChatMessageType;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface CoworkSideChatSummary {
  id: string;
  parentSessionId: string;
  dshSessionId: string | null;
  title: string;
  status: CoworkSideChatStatus;
  forkedFromMessageId: string | null;
  forkedAtSeq: number | null;
  lastError: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkSideChat extends CoworkSideChatSummary {
  messages: CoworkSideChatMessage[];
}

export interface CoworkSideChatPermissionRequest {
  parentSessionId: string;
  sideChatId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string | null;
}

export interface CoworkSideChatPermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}

export interface CoworkSideChatCreateRequest {
  parentSessionId: string;
  title?: string;
  forkedFromMessageId?: string | null;
}

export interface CoworkSideChatSendRequest {
  parentSessionId: string;
  sideChatId: string;
  prompt: string;
  displayPrompt?: string;
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  imageAttachments?: CoworkImageAttachmentPayload[];
  modelOverride?: string | null;
  thinkingLevel?: string | null;
}

export interface CoworkSideChatStopRequest {
  parentSessionId: string;
  sideChatId: string;
}

export interface CoworkSideChatRenameRequest {
  parentSessionId: string;
  sideChatId: string;
  title: string;
}

export interface CoworkSideChatDeleteRequest {
  parentSessionId: string;
  sideChatId: string;
}

export interface CoworkSideChatPromoteRequest {
  parentSessionId: string;
  sideChatId: string;
}

export interface CoworkSideChatRespondPermissionRequest {
  parentSessionId: string;
  sideChatId: string;
  requestId: string;
  result: CoworkSideChatPermissionResult;
}

export interface CoworkSideChatListResponse {
  success: boolean;
  sideChats?: CoworkSideChatSummary[];
  error?: string;
}

export interface CoworkSideChatGetResponse {
  success: boolean;
  sideChat?: CoworkSideChat | null;
  pendingPermissions?: CoworkSideChatPermissionRequest[];
  error?: string;
}

export interface CoworkSideChatCreateResponse {
  success: boolean;
  sideChat?: CoworkSideChat;
  error?: string;
}

export interface CoworkSideChatActionResponse {
  success: boolean;
  error?: string;
}

export interface CoworkSideChatRenameResponse {
  success: boolean;
  sideChat?: CoworkSideChatSummary;
  error?: string;
}

export interface CoworkSideChatPromoteResponse {
  success: boolean;
  sessionId?: string;
  error?: string;
}

export interface CoworkSideChatStreamMessageEvent {
  parentSessionId: string;
  sideChatId: string;
  message: CoworkSideChatMessage;
}

export interface CoworkSideChatStreamMessageUpdateEvent {
  parentSessionId: string;
  sideChatId: string;
  messageId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CoworkSideChatStreamStatusEvent {
  parentSessionId: string;
  sideChatId: string;
  status: CoworkSideChatStatus;
  error?: string | null;
}

export interface CoworkSideChatStreamMetaChangedEvent {
  parentSessionId: string;
  sideChat: CoworkSideChatSummary;
  deleted?: boolean;
}

export interface CoworkSideChatStreamPermissionResolvedEvent {
  parentSessionId: string;
  sideChatId: string;
  requestId: string;
}

export const normalizeCoworkSideChatTitle = (raw: string): string => (
  stripNullChars(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COWORK_SIDE_CHAT_TITLE_MAX_CHARS)
);

export const deriveCoworkSideChatTitle = (
  prompt: string,
  fallback: string,
  maxChars = COWORK_SIDE_CHAT_DERIVED_TITLE_MAX_CHARS,
): string => {
  const cleaned = stripNullChars(prompt).replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return normalizeCoworkSideChatTitle(fallback) || 'Side chat';
  }
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
};
