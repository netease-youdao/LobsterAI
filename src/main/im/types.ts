/**
 * IM Gateway Type Definitions
 * Types for DingTalk, Feishu and Telegram IM bot integration
 */

// ==================== DingTalk Types ====================

export interface DingTalkOpenClawConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist';
  /** @deprecated since dingtalk-connector v0.7.5 – use Gateway session.reset.idleMinutes instead */
  sessionTimeout: number;
  separateSessionByConversation: boolean;
  groupSessionScope: 'group' | 'group_sender';
  sharedMemoryAcrossConversations: boolean;
  gatewayBaseUrl: string;
  debug: boolean;
}

export interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Feishu Types ====================

export interface FeishuOpenClawGroupConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

export interface FeishuOpenClawConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark' | string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  groups: Record<string, FeishuOpenClawGroupConfig>;
  historyLimit: number;
  replyMode: 'auto' | 'static' | 'streaming';
  mediaMaxMb: number;
  debug: boolean;
}

export interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Telegram Types ====================

export interface TelegramOpenClawGroupConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

export interface TelegramOpenClawConfig {
  enabled: boolean;
  botToken: string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  groups: Record<string, TelegramOpenClawGroupConfig>;
  historyLimit: number;
  replyToMode: 'off' | 'first' | 'all';
  linkPreview: boolean;
  streaming: 'off' | 'partial' | 'block' | 'progress';
  mediaMaxMb: number;
  proxy: string;
  webhookUrl: string;
  webhookSecret: string;
  debug: boolean;
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

export interface DiscordOpenClawGuildConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

export interface DiscordOpenClawConfig {
  enabled: boolean;
  botToken: string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  guilds: Record<string, DiscordOpenClawGuildConfig>;
  historyLimit: number;
  streaming: 'off' | 'partial' | 'block' | 'progress';
  mediaMaxMb: number;
  proxy: string;
  debug: boolean;
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

export interface QQOpenClawConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  historyLimit: number;
  markdownSupport: boolean;
  imageServerBaseUrl: string;
  debug: boolean;
}

/** @deprecated Use QQOpenClawConfig instead */
export type QQConfig = QQOpenClawConfig;

export interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== WeCom (企业微信) Types ====================

export interface WecomOpenClawConfig {
  enabled: boolean;
  botId: string;
  secret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  sendThinkingMessage: boolean;
  debug: boolean;
}

/** @deprecated Use WecomOpenClawConfig instead */
export type WecomConfig = WecomOpenClawConfig;

export interface WecomGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botId: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== POPO Types ====================

export interface PopoOpenClawConfig {
  enabled: boolean;
  appKey: string;
  appSecret: string;
  token: string;
  aesKey: string;
  webhookBaseUrl: string;
  webhookPath: string;
  webhookPort: number;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  textChunkLimit: number;
  richTextChunkLimit: number;
  debug: boolean;
}

export interface PopoGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Common IM Types ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'nim' | 'xiaomifeng' | 'wecom' | 'popo';

export interface IMGatewayConfig {
  dingtalk: DingTalkOpenClawConfig;
  feishu: FeishuOpenClawConfig;
  telegram: TelegramOpenClawConfig;
  qq: QQOpenClawConfig;
  discord: DiscordOpenClawConfig;
  nim: NimConfig;
  xiaomifeng: XiaomifengConfig;
  wecom: WecomOpenClawConfig;
  popo: PopoOpenClawConfig;
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
  popo: PopoGatewayStatus;
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
  | 'openclaw_gateway_not_running'
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

export const DEFAULT_DINGTALK_OPENCLAW_CONFIG: DingTalkOpenClawConfig = {
  enabled: false,
  clientId: '',
  clientSecret: '',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'open',
  sessionTimeout: 1800000,
  separateSessionByConversation: true,
  groupSessionScope: 'group',
  sharedMemoryAcrossConversations: false,
  gatewayBaseUrl: '',
  debug: false,
};

export const DEFAULT_FEISHU_OPENCLAW_CONFIG: FeishuOpenClawConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  domain: 'feishu',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'allowlist',
  groupAllowFrom: [],
  groups: { '*': { requireMention: true } },
  historyLimit: 50,
  replyMode: 'auto',
  mediaMaxMb: 30,
  debug: false,
};

export const DEFAULT_DISCORD_OPENCLAW_CONFIG: DiscordOpenClawConfig = {
  enabled: false,
  botToken: '',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'allowlist',
  groupAllowFrom: [],
  guilds: { '*': { requireMention: true } },
  historyLimit: 50,
  streaming: 'off',
  mediaMaxMb: 25,
  proxy: '',
  debug: false,
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

export const DEFAULT_TELEGRAM_OPENCLAW_CONFIG: TelegramOpenClawConfig = {
  enabled: false,
  botToken: '',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'allowlist',
  groupAllowFrom: [],
  groups: { '*': { requireMention: true } },
  historyLimit: 50,
  replyToMode: 'off',
  linkPreview: true,
  streaming: 'off',
  mediaMaxMb: 5,
  proxy: '',
  webhookUrl: '',
  webhookSecret: '',
  debug: false,
};

export const DEFAULT_QQ_CONFIG: QQOpenClawConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'open',
  groupAllowFrom: [],
  historyLimit: 50,
  markdownSupport: true,
  imageServerBaseUrl: '',
  debug: false,
};

export const DEFAULT_WECOM_CONFIG: WecomOpenClawConfig = {
  enabled: false,
  botId: '',
  secret: '',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'open',
  groupAllowFrom: [],
  sendThinkingMessage: true,
  debug: true,
};

export const DEFAULT_POPO_CONFIG: PopoOpenClawConfig = {
  enabled: false,
  appKey: '',
  appSecret: '',
  token: '',
  aesKey: '',
  webhookBaseUrl: '',
  webhookPath: '/popo/callback',
  webhookPort: 3100,
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'open',
  groupAllowFrom: [],
  textChunkLimit: 3000,
  richTextChunkLimit: 5000,
  debug: true,
};

export const DEFAULT_IM_SETTINGS: IMSettings = {
  systemPrompt: '',
  skillsEnabled: true,
};

export const DEFAULT_IM_CONFIG: IMGatewayConfig = {
  dingtalk: DEFAULT_DINGTALK_OPENCLAW_CONFIG,
  feishu: DEFAULT_FEISHU_OPENCLAW_CONFIG,
  telegram: DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
  qq: DEFAULT_QQ_CONFIG,
  discord: DEFAULT_DISCORD_OPENCLAW_CONFIG,
  nim: DEFAULT_NIM_CONFIG,
  xiaomifeng: DEFAULT_XIAOMIFENG_CONFIG,
  wecom: DEFAULT_WECOM_CONFIG,
  popo: DEFAULT_POPO_CONFIG,
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

export const DEFAULT_POPO_STATUS: PopoGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: DEFAULT_DINGTALK_STATUS,
  feishu: DEFAULT_FEISHU_STATUS,
  telegram: {
    connected: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  qq: DEFAULT_QQ_STATUS,
  discord: DEFAULT_DISCORD_STATUS,
  nim: DEFAULT_NIM_STATUS,
  xiaomifeng: DEFAULT_XIAOMIFENG_STATUS,
  wecom: DEFAULT_WECOM_STATUS,
  popo: DEFAULT_POPO_STATUS,
};

// ==================== Media Marker Types ====================

export interface MediaMarker {
  type: 'image' | 'video' | 'audio' | 'file';
  path: string;
  name?: string;
  originalMarker: string;
}
