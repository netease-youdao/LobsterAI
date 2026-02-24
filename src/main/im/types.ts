/**
 * IM Gateway Type Definitions
 * Types for DingTalk, Feishu and Telegram IM bot integration
 */

// ==================== DingTalk Types ====================

export interface DingTalkConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  messageType: 'markdown' | 'card';
  cardTemplateId?: string;
  debug?: boolean;
}

export interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export interface DingTalkInboundMessage {
  msgId: string;
  msgtype: 'text' | 'richText' | 'audio' | string;
  createAt: number;
  text?: { content: string };
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    richText?: Array<{ text?: string }>;
  };
  conversationType: '1' | '2'; // 1: DM, 2: Group
  conversationId: string;
  senderId: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId: string;
  sessionWebhook: string;
}

// ==================== Feishu Types ====================

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark' | string;
  encryptKey?: string;
  verificationToken?: string;
  renderMode: 'text' | 'card';
  debug?: boolean;
}

export interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export interface FeishuMessageContext {
  chatId: string;
  messageId: string;
  senderId: string;
  senderOpenId: string;
  chatType: 'p2p' | 'group';
  mentionedBot: boolean;
  rootId?: string;
  parentId?: string;
  content: string;
  contentType: string;
}

// ==================== Telegram Types ====================

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUserIds?: string[];
  debug?: boolean;
}

export interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Discord Types ====================

export interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  debug?: boolean;
}

export interface DiscordGatewayStatus {
  connected: boolean;
  starting: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== NIM (NetEase IM) Types ====================

export interface NimConfig {
  enabled: boolean;
  appKey: string;
  account: string;
  token: string;
  debug?: boolean;
}

export interface NimGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Common IM Types ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'nim';

export interface IMGatewayConfig {
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  nim: NimConfig;
  settings: IMSettings;
}

export interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
}

export interface IMGatewayStatus {
  dingtalk: DingTalkGatewayStatus;
  feishu: FeishuGatewayStatus;
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
  nim: NimGatewayStatus;
}

// ==================== Media Attachment Types ====================

export type TelegramMediaType = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface IMMediaAttachment {
  type: TelegramMediaType;
  localPath: string;          // 下载后的本地路径
  mimeType: string;           // MIME 类型
  fileName?: string;          // 原始文件名
  fileSize?: number;          // 文件大小（字节）
  width?: number;             // 图片/视频宽度
  height?: number;            // 图片/视频高度
  duration?: number;          // 音视频时长（秒）
}

export interface IMMessage {
  platform: IMPlatform;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
  // 媒体附件（Telegram 支持）
  attachments?: IMMediaAttachment[];
  mediaGroupId?: string;      // 媒体组 ID（用于合并多张图片）
}

export interface IMReplyContext {
  platform: IMPlatform;
  conversationId: string;
  messageId?: string;
  // DingTalk specific
  sessionWebhook?: string;
  // Feishu specific
  chatId?: string;
}

// ==================== IM Session Mapping ====================

export interface IMSessionMapping {
  imConversationId: string;
  platform: IMPlatform;
  coworkSessionId: string;
  createdAt: number;
  lastActiveAt: number;
}

// ==================== IPC Result Types ====================

export interface IMConfigResult {
  success: boolean;
  config?: IMGatewayConfig;
  error?: string;
}

export interface IMStatusResult {
  success: boolean;
  status?: IMGatewayStatus;
  error?: string;
}

export interface IMGatewayResult {
  success: boolean;
  error?: string;
}

// ==================== Connectivity Test Types ====================

export type IMConnectivityVerdict = 'pass' | 'warn' | 'fail';

export type IMConnectivityCheckLevel = 'pass' | 'info' | 'warn' | 'fail';

export type IMConnectivityCheckCode =
  | 'missing_credentials'
  | 'auth_check'
  | 'gateway_running'
  | 'inbound_activity'
  | 'outbound_activity'
  | 'platform_last_error'
  | 'feishu_group_requires_mention'
  | 'feishu_event_subscription_required'
  | 'discord_group_requires_mention'
  | 'telegram_privacy_mode_hint'
  | 'dingtalk_bot_membership_hint'
  | 'nim_p2p_only_hint';

export interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

export interface IMConnectivityTestResult {
  platform: IMPlatform;
  testedAt: number;
  verdict: IMConnectivityVerdict;
  checks: IMConnectivityCheck[];
}

export interface IMConnectivityTestResponse {
  success: boolean;
  result?: IMConnectivityTestResult;
  error?: string;
}

// ==================== Default Configurations ====================

export const DEFAULT_DINGTALK_CONFIG: DingTalkConfig = {
  enabled: false,
  clientId: '',
  clientSecret: '',
  messageType: 'markdown',
  debug: true,
};

export const DEFAULT_FEISHU_CONFIG: FeishuConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  domain: 'feishu',
  renderMode: 'card',
  debug: true,
};

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  botToken: '',
  allowedUserIds: [],
  debug: true,
};

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  botToken: '',
  debug: true,
};

export const DEFAULT_NIM_CONFIG: NimConfig = {
  enabled: false,
  appKey: '',
  account: '',
  token: '',
  debug: true,
};

export const DEFAULT_IM_SETTINGS: IMSettings = {
  systemPrompt: '',
  skillsEnabled: true,
};

export const DEFAULT_IM_CONFIG: IMGatewayConfig = {
  dingtalk: DEFAULT_DINGTALK_CONFIG,
  feishu: DEFAULT_FEISHU_CONFIG,
  telegram: DEFAULT_TELEGRAM_CONFIG,
  discord: DEFAULT_DISCORD_CONFIG,
  nim: DEFAULT_NIM_CONFIG,
  settings: DEFAULT_IM_SETTINGS,
};

export const DEFAULT_DINGTALK_STATUS: DingTalkGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_FEISHU_STATUS: FeishuGatewayStatus = {
  connected: false,
  startedAt: null,
  botOpenId: null,
  error: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_TELEGRAM_STATUS: TelegramGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  botUsername: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_DISCORD_STATUS: DiscordGatewayStatus = {
  connected: false,
  starting: false,
  startedAt: null,
  lastError: null,
  botUsername: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_NIM_STATUS: NimGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  botAccount: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: DEFAULT_DINGTALK_STATUS,
  feishu: DEFAULT_FEISHU_STATUS,
  telegram: DEFAULT_TELEGRAM_STATUS,
  discord: DEFAULT_DISCORD_STATUS,
  nim: DEFAULT_NIM_STATUS,
};

// ==================== DingTalk Media Types ====================

// Session Webhook 使用 msgKey + msgParam 格式
export interface DingTalkImageMessage {
  msgKey: 'sampleImageMsg';
  sampleImageMsg: { photoURL: string };
}

export interface DingTalkVoiceMessage {
  msgKey: 'sampleAudio';
  sampleAudio: { mediaId: string; duration?: string };
}

export interface DingTalkVideoMessage {
  msgKey: 'sampleVideo';
  sampleVideo: { mediaId: string; duration?: string; videoType?: string };
}

export interface DingTalkFileMessage {
  msgKey: 'sampleFile';
  sampleFile: { mediaId: string; fileName?: string };
}

export type DingTalkMediaMessage =
  | DingTalkImageMessage
  | DingTalkVoiceMessage
  | DingTalkVideoMessage
  | DingTalkFileMessage;

export interface MediaMarker {
  type: 'image' | 'video' | 'audio' | 'file';
  path: string;
  name?: string;
  originalMarker: string;
}
