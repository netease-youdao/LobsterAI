export const RemoteReplyModelLabelCapability = 'reply_model_label_v1';

/** Versioned public conversation content, shared by the desktop transport and App contract. */
export const RemoteReply = {
  Capability: 'reply_content_v1', ProjectionVersion: 4, DeltaEvent: 'message.delta',
  InlineBytes: 16 * 1024, ChunkBytes: 32 * 1024, MaximumContentBytes: 16 * 1024 * 1024,
} as const;
export const RemoteReplyBlockType = {
  Text: 'text', Markdown: 'markdown', Thinking: 'thinking', ToolInput: 'tool_input',
  ToolOutput: 'tool_output', Notice: 'notice', Error: 'error',
} as const;
export type RemoteReplyFormat = 'text' | 'markdown' | 'json';
export interface RemoteReplyContentRef {
  contentId: string; version: string; sizeBytes: string; sha256: string; format: RemoteReplyFormat;
}
export interface RemoteReplyUpload extends RemoteReplyContentRef {
  messageId: string; blockId: string;
  chunks: Array<{ sha256: string; sizeBytes: string; text: string }>;
}
export interface RemoteReplyBlock {
  blockId: string; type: typeof RemoteReplyBlockType[keyof typeof RemoteReplyBlockType];
  text?: string; contentRef?: RemoteReplyContentRef; toolCallId?: string; toolName?: string;
  display?: Record<string, string | number | boolean>;
}

export const RemoteReplyCapability = RemoteReply.Capability;
export const REMOTE_REPLY_PROJECTION_VERSION = RemoteReply.ProjectionVersion;
export const REMOTE_REPLY_SYNC_DELAY_MS = 300;
export type ReplyContentUpload = RemoteReplyUpload;
