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
    duration?: string;
    videoType?: string;
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
  mediaKey?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaDuration?: number;
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

export type NimTeamPolicy = 'open' | 'allowlist' | 'disabled';
export type NimSessionType = 'p2p' | 'team' | 'superTeam';

export interface NimConfig {
  enabled: boolean;
  appKey: string;
  account: string;
  token: string;
  accountWhitelist: string;
  debug?: boolean;
  // 群组消息配置
  teamPolicy?: NimTeamPolicy;      // 群消息策略，默认 'disabled'
  teamAllowlist?: string;          // 逗号分隔的群 ID 白名单
  // QChat 圈组配置
  qchatEnabled?: boolean;          // 是否启用圈组
  qchatServerIds?: string;         // 逗号分隔的服务器 ID，空则自动发现
}

export interface NimGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Xiaomifeng (小蜜蜂) Types ====================

export interface XiaomifengConfig {
  enabled: boolean;
  clientId: string;    // 用于 NIM 登录的账号 (appKey)
  secret: string;      // 用于 NIM 登录的 token (appSecret)
  debug?: boolean;
}

export interface XiaomifengGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== QQ Types ====================

export interface QQConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  debug?: boolean;
}

export interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== WeCom (企业微信) Types ====================

export interface WecomConfig {
  enabled: boolean;
  botId: string;
  secret: string;
  debug?: boolean;
}

export interface WecomGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botId: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Common IM Types ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'nim' | 'xiaomifeng' | 'wecom';

export interface IMGatewayConfig {
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  qq: QQConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  nim: NimConfig;
  xiaomifeng: XiaomifengConfig;
  wecom: WecomConfig;
  settings: IMSettings;
}

export interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
}

export interface IMGatewayStatus {
  dingtalk: DingTalkGatewayStatus;
  feishu: FeishuGatewayStatus;
  qq: QQGatewayStatus;
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
  nim: NimGatewayStatus;
  xiaomifeng: XiaomifengGatewayStatus;
  wecom: WecomGatewayStatus;
}

// ==================== Media Attachment Types ====================

export type IMMediaType = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface IMMediaAttachment {
  type: IMMediaType;
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
  groupName?: string;         // 群名/频道名（用于会话标题）
  content: string;
  chatType: 'direct' | 'group';
  /** 子类型，用于区分同平台不同会话来源，如 'qchat' */
  chatSubType?: string;
  timestamp: number;
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
  | 'nim_p2p_only_hint'
  | 'qq_guild_mention_hint';

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
  accountWhitelist: '',
  debug: true,
  teamPolicy: 'disabled',
  teamAllowlist: '',
  qchatEnabled: false,
  qchatServerIds: '',
};

export const DEFAULT_XIAOMIFENG_CONFIG: XiaomifengConfig = {
  enabled: false,
  clientId: '',
  secret: '',
  debug: true,
};

export const DEFAULT_QQ_CONFIG: QQConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  debug: true,
};

export const DEFAULT_WECOM_CONFIG: WecomConfig = {
  enabled: false,
  botId: '',
  secret: '',
  debug: true,
};

export const DEFAULT_IM_SETTINGS: IMSettings = {
  systemPrompt: '',
  skillsEnabled: true,
};

export const DEFAULT_IM_CONFIG: IMGatewayConfig = {
  dingtalk: DEFAULT_DINGTALK_CONFIG,
  feishu: DEFAULT_FEISHU_CONFIG,
  qq: DEFAULT_QQ_CONFIG,
  telegram: DEFAULT_TELEGRAM_CONFIG,
  discord: DEFAULT_DISCORD_CONFIG,
  nim: DEFAULT_NIM_CONFIG,
  xiaomifeng: DEFAULT_XIAOMIFENG_CONFIG,
  wecom: DEFAULT_WECOM_CONFIG,
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

export const DEFAULT_XIAOMIFENG_STATUS: XiaomifengGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  botAccount: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_QQ_STATUS: QQGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_WECOM_STATUS: WecomGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  botId: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: DEFAULT_DINGTALK_STATUS,
  feishu: DEFAULT_FEISHU_STATUS,
  qq: DEFAULT_QQ_STATUS,
  telegram: DEFAULT_TELEGRAM_STATUS,
  discord: DEFAULT_DISCORD_STATUS,
  nim: DEFAULT_NIM_STATUS,
  xiaomifeng: DEFAULT_XIAOMIFENG_STATUS,
  wecom: DEFAULT_WECOM_STATUS,
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
