/**
 * IM Gateway Type Definitions
 * Types for DingTalk, Feishu and Telegram IM bot integration
 */

import type { Platform } from '../../shared/platform';
export type { Platform } from '../../shared/platform';

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

// ==================== DingTalk Multi-Instance Types ====================

export const MAX_DINGTALK_INSTANCES = 5;

export interface DingTalkInstanceConfig extends DingTalkOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

export interface DingTalkInstanceStatus extends DingTalkGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface DingTalkMultiInstanceConfig {
  instances: DingTalkInstanceConfig[];
}

export interface DingTalkMultiInstanceStatus {
  instances: DingTalkInstanceStatus[];
}

export const DEFAULT_DINGTALK_MULTI_INSTANCE_CONFIG: DingTalkMultiInstanceConfig = {
  instances: [],
};

// ==================== Feishu Types ====================

export interface FeishuOpenClawGroupConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

export interface FeishuOpenClawFooterConfig {
  status?: boolean;
  elapsed?: boolean;
}

export interface FeishuOpenClawBlockStreamingCoalesceConfig {
  minChars?: number;
  maxChars?: number;
  idleMs?: number;
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
  streaming: boolean;
  replyMode: 'auto' | 'static' | 'streaming';
  blockStreaming: boolean;
  footer: FeishuOpenClawFooterConfig;
  blockStreamingCoalesce?: FeishuOpenClawBlockStreamingCoalesceConfig;
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

// ==================== Feishu Multi-Instance Types ====================

export const MAX_FEISHU_INSTANCES = 5;

export interface FeishuInstanceConfig extends FeishuOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

export interface FeishuInstanceStatus extends FeishuGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface FeishuMultiInstanceConfig {
  instances: FeishuInstanceConfig[];
}

export interface FeishuMultiInstanceStatus {
  instances: FeishuInstanceStatus[];
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

// ==================== Telegram Multi-Instance Types ====================

export const MAX_TELEGRAM_INSTANCES = 5;

export interface TelegramInstanceConfig extends TelegramOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

export interface TelegramInstanceStatus extends TelegramGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface TelegramMultiInstanceConfig {
  instances: TelegramInstanceConfig[];
}

export interface TelegramMultiInstanceStatus {
  instances: TelegramInstanceStatus[];
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

export const MAX_DISCORD_INSTANCES = 5;

export interface DiscordInstanceConfig extends DiscordOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

export interface DiscordInstanceStatus extends DiscordGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface DiscordMultiInstanceConfig {
  instances: DiscordInstanceConfig[];
}

export interface DiscordMultiInstanceStatus {
  instances: DiscordInstanceStatus[];
}

// ==================== NIM (NetEase IM) Types ====================

export type NimTeamPolicy = 'open' | 'allowlist' | 'disabled';
export type NimSessionType = 'p2p' | 'team' | 'superTeam';

export interface NimP2pConfig {
  policy: 'open' | 'allowlist' | 'disabled';
  allowFrom?: (string | number)[];
}

export interface NimTeamConfig {
  policy: 'open' | 'allowlist' | 'disabled';
  allowFrom?: (string | number)[];
}

export interface NimQChatConfig {
  policy: 'open' | 'allowlist' | 'disabled';
  allowFrom?: (string | number)[];
}

export interface NimAdvancedConfig {
  mediaMaxMb?: number;
  textChunkLimit?: number;
  debug?: boolean;
  legacyLogin?: boolean;
  weblbsUrl?: string;
  link_web?: string;
  nos_uploader?: string;
  nos_downloader_v2?: string;
  nosSsl?: boolean;
  nos_accelerate?: string;
  nos_accelerate_host?: string;
}

export interface NimOpenClawConfig {
  enabled: boolean;
  nimToken?: string;
  appKey: string;
  account: string;
  token: string;
  antispamEnabled?: boolean;
  p2p?: NimP2pConfig;
  team?: NimTeamConfig;
  qchat?: NimQChatConfig;
  advanced?: NimAdvancedConfig;
}

export interface NimInstanceConfig extends NimOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

export interface NimGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// NIM supports max 3 instances (enabled or not), may use different accounts or AppKeys.
// See: https://doc.yunxin.163.com/messaging2/ai-guide/TMwNzk4MzU?platform=client#多实例配置
export const MAX_NIM_INSTANCES = 3;

export interface NimInstanceStatus extends NimGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface NimMultiInstanceConfig {
  instances: NimInstanceConfig[];
}

export interface NimMultiInstanceStatus {
  instances: NimInstanceStatus[];
}

/** @deprecated Use NimOpenClawConfig instead. */
export type NimConfig = NimOpenClawConfig;

// ==================== NeteaseBee (小蜜蜂) Types ====================

export interface NeteaseBeeChanConfig {
  enabled: boolean;
  clientId: string; // NIM 登录账号
  secret: string; // NIM 登录 token
  debug?: boolean;
}

export interface NeteaseBeeChanGatewayStatus {
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

// ==================== QQ Multi-Instance Types ====================

export const MAX_QQ_INSTANCES = 5;

export interface QQInstanceConfig extends QQOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

export interface QQInstanceStatus extends QQGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface QQMultiInstanceConfig {
  instances: QQInstanceConfig[];
}

export interface QQMultiInstanceStatus {
  instances: QQInstanceStatus[];
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

// ==================== WeCom Multi-Instance Types ====================

export const MAX_WECOM_INSTANCES = 5;

export interface WecomInstanceConfig extends WecomOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

export interface WecomInstanceStatus extends WecomGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface WecomMultiInstanceConfig {
  instances: WecomInstanceConfig[];
}

export interface WecomMultiInstanceStatus {
  instances: WecomInstanceStatus[];
}

// ==================== POPO Types ====================

export interface PopoOpenClawConfig {
  enabled: boolean;
  connectionMode: 'websocket' | 'webhook';
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

// ==================== Weixin (微信) Types ====================

export interface WeixinOpenClawConfig {
  enabled: boolean;
  accountId: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  debug: boolean;
}

export interface WeixinGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Email Channel Types ====================

export interface EmailInstanceConfig {
  instanceId: string; // "email-1", "email-2", etc.
  instanceName: string; // Display name: "Work Email"
  enabled: boolean; // Enable/disable this account

  // Transport mode
  transport: 'imap' | 'ws'; // IMAP/SMTP or WebSocket

  // Account credentials
  email: string; // user@example.com
  password?: string; // Required if transport=imap
  apiKey?: string; // Required if transport=ws (format: ck_*)

  // Agent binding
  agentId: string; // Agent ID (default: "main")

  // IMAP/SMTP servers (optional, auto-detected if empty)
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;

  // Security & policy
  allowFrom?: string[]; // Whitelist: ["user@example.com", "*.trusted.com"]

  // Advanced options
  replyMode?: 'immediate' | 'accumulated' | 'complete';
  replyTo?: 'sender' | 'all';

  // Agent-to-Agent collaboration
  a2aEnabled?: boolean;
  a2aAgentDomains?: string[];
  a2aMaxPingPongTurns?: number;
}

export interface EmailMultiInstanceConfig {
  instances: EmailInstanceConfig[];
}

export interface EmailInstanceStatus {
  instanceId: string;
  instanceName: string;
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  email: string | null;
  transport: 'imap' | 'ws' | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export interface EmailMultiInstanceStatus {
  instances: EmailInstanceStatus[];
}

export const DEFAULT_EMAIL_INSTANCE_CONFIG: Partial<EmailInstanceConfig> = {
  enabled: false,
  transport: 'ws',
  agentId: 'main',
  replyMode: 'complete',
  replyTo: 'sender',
  a2aEnabled: true,
  a2aMaxPingPongTurns: 20,
};

export const DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG: EmailMultiInstanceConfig = {
  instances: [],
};

export const MAX_EMAIL_INSTANCES = 5;

// ==================== Common IM Types ====================

export interface IMGatewayConfig {
  dingtalk: DingTalkMultiInstanceConfig;
  feishu: FeishuMultiInstanceConfig;
  telegram: TelegramMultiInstanceConfig;
  qq: QQMultiInstanceConfig;
  discord: DiscordMultiInstanceConfig;
  nim: NimMultiInstanceConfig;
  'netease-bee': NeteaseBeeChanConfig;
  wecom: WecomMultiInstanceConfig;
  popo: PopoOpenClawConfig;
  weixin: WeixinOpenClawConfig;
  email: EmailMultiInstanceConfig;
  settings: IMSettings;
}

export interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
  /** Per-platform agent binding. Key = platform name, value = agent ID. Absent or 'main' = default. */
  platformAgentBindings?: Record<string, string>;
}

export interface IMGatewayStatus {
  dingtalk: DingTalkMultiInstanceStatus;
  feishu: FeishuMultiInstanceStatus;
  qq: QQMultiInstanceStatus;
  telegram: TelegramMultiInstanceStatus;
  discord: DiscordMultiInstanceStatus;
  nim: NimMultiInstanceStatus;
  'netease-bee': NeteaseBeeChanGatewayStatus;
  wecom: WecomMultiInstanceStatus;
  popo: PopoGatewayStatus;
  weixin: WeixinGatewayStatus;
  email: EmailMultiInstanceStatus;
}

// ==================== Media Attachment Types ====================

export type IMMediaType = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface IMMediaAttachment {
  type: IMMediaType;
  localPath: string; // 下载后的本地路径
  mimeType: string; // MIME 类型
  fileName?: string; // 原始文件名
  fileSize?: number; // 文件大小（字节）
  width?: number; // 图片/视频宽度
  height?: number; // 图片/视频高度
  duration?: number; // 音视频时长（秒）
}

export interface IMMessage {
  platform: Platform;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  groupName?: string; // 群名/频道名（用于会话标题）
  content: string;
  chatType: 'direct' | 'group';
  /** 子类型，用于区分同平台不同会话来源，如 'qchat' */
  chatSubType?: string;
  timestamp: number;
  attachments?: IMMediaAttachment[];
  mediaGroupId?: string; // 媒体组 ID（用于合并多张图片）
}

export interface IMReplyContext {
  platform: Platform;
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
  platform: Platform;
  coworkSessionId: string;
  agentId: string;
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
  | 'qq_guild_mention_hint'
  | 'qq_mention_hint';

export interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

export interface IMConnectivityTestResult {
  platform: Platform;
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
  groupPolicy: 'open',
  groupAllowFrom: [],
  groups: { '*': { requireMention: true } },
  historyLimit: 50,
  streaming: true,
  replyMode: 'auto',
  blockStreaming: false,
  footer: { status: true, elapsed: true },
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

export const DEFAULT_DISCORD_MULTI_INSTANCE_CONFIG: DiscordMultiInstanceConfig = {
  instances: [],
};

export const DEFAULT_NIM_OPENCLAW_CONFIG: NimOpenClawConfig = {
  enabled: false,
  nimToken: '',
  appKey: '',
  account: '',
  token: '',
  antispamEnabled: true,
};

export const DEFAULT_NIM_MULTI_INSTANCE_CONFIG: NimMultiInstanceConfig = {
  instances: [],
};

/** @deprecated Use DEFAULT_NIM_OPENCLAW_CONFIG instead. */
export const DEFAULT_NIM_CONFIG = DEFAULT_NIM_OPENCLAW_CONFIG;

// ==================== NetEase Bee Types ====================

export const DEFAULT_NETEASE_BEE_CONFIG: NeteaseBeeChanConfig = {
  enabled: false,
  clientId: '',
  secret: '',
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

export const DEFAULT_TELEGRAM_MULTI_INSTANCE_CONFIG: TelegramMultiInstanceConfig = {
  instances: [],
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

export const DEFAULT_QQ_MULTI_INSTANCE_CONFIG: QQMultiInstanceConfig = {
  instances: [],
};

export const DEFAULT_FEISHU_MULTI_INSTANCE_CONFIG: FeishuMultiInstanceConfig = {
  instances: [],
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

export const DEFAULT_WECOM_MULTI_INSTANCE_CONFIG: WecomMultiInstanceConfig = { instances: [] };

export const DEFAULT_POPO_CONFIG: PopoOpenClawConfig = {
  enabled: false,
  connectionMode: 'websocket',
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

export const DEFAULT_WEIXIN_CONFIG: WeixinOpenClawConfig = {
  enabled: false,
  accountId: '',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'open',
  groupAllowFrom: [],
  debug: true,
};

export const DEFAULT_IM_SETTINGS: IMSettings = {
  systemPrompt: '',
  skillsEnabled: true,
};

export const DEFAULT_IM_CONFIG: IMGatewayConfig = {
  dingtalk: DEFAULT_DINGTALK_MULTI_INSTANCE_CONFIG,
  feishu: DEFAULT_FEISHU_MULTI_INSTANCE_CONFIG,
  telegram: DEFAULT_TELEGRAM_MULTI_INSTANCE_CONFIG,
  qq: DEFAULT_QQ_MULTI_INSTANCE_CONFIG,
  discord: DEFAULT_DISCORD_MULTI_INSTANCE_CONFIG,
  nim: DEFAULT_NIM_MULTI_INSTANCE_CONFIG,
  'netease-bee': DEFAULT_NETEASE_BEE_CONFIG,
  wecom: DEFAULT_WECOM_MULTI_INSTANCE_CONFIG,
  popo: DEFAULT_POPO_CONFIG,
  weixin: DEFAULT_WEIXIN_CONFIG,
  email: DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG,
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

export const DEFAULT_NIM_MULTI_INSTANCE_STATUS: NimMultiInstanceStatus = {
  instances: [],
};

export const DEFAULT_NETEASE_BEE_STATUS: NeteaseBeeChanGatewayStatus = {
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

export const DEFAULT_WEIXIN_STATUS: WeixinGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: { instances: [] },
  feishu: { instances: [] },
  telegram: { instances: [] },
  qq: { instances: [] },
  discord: { instances: [] },
  nim: DEFAULT_NIM_MULTI_INSTANCE_STATUS,
  'netease-bee': DEFAULT_NETEASE_BEE_STATUS,
  wecom: { instances: [] },
  popo: DEFAULT_POPO_STATUS,
  weixin: DEFAULT_WEIXIN_STATUS,
  email: { instances: [] },
};

// ==================== Media Marker Types ====================

export interface MediaMarker {
  type: 'image' | 'video' | 'audio' | 'file';
  path: string;
  name?: string;
  originalMarker: string;
}
