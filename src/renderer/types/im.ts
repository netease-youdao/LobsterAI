/**
 * IM Gateway Types for Renderer Process
 * Mirrors src/main/im/types.ts for use in React components
 */

import type { Platform } from '@shared/platform';

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

export interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Telegram OpenClaw Types ====================

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
}

export interface NimConfig {
  enabled: boolean;
  appKey: string;
  account: string;
  token: string;
  p2p?: NimP2pConfig;
  team?: NimTeamConfig;
  qchat?: NimQChatConfig;
  advanced?: NimAdvancedConfig;
}

export interface NimGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== NetEase Bee Types ====================

export interface NeteaseBeeChanConfig {
  enabled: boolean;
  clientId: string;    // 小蜜蜂平台的 NIM 账号 ID
  secret: string;      // 用于 token 中继的密钥
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

// ==================== Common IM Types ====================

export type IMPlatform = keyof Omit<IMGatewayConfig, 'settings'> | 'xiaomifeng';

export interface IMGatewayConfig {
  dingtalk: DingTalkMultiInstanceConfig;
  feishu: FeishuMultiInstanceConfig;
  telegram: TelegramOpenClawConfig;
  qq: QQMultiInstanceConfig;
  discord: DiscordOpenClawConfig;
  nim: NimConfig;
  'netease-bee': NeteaseBeeChanConfig;
  wecom: WecomOpenClawConfig;
  popo: PopoOpenClawConfig;
  weixin: WeixinOpenClawConfig;
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
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
  nim: NimGatewayStatus;
  'netease-bee': NeteaseBeeChanGatewayStatus;
  wecom: WecomGatewayStatus;
  popo: PopoGatewayStatus;
  weixin: WeixinGatewayStatus;
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
  platform: Platform;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
  attachments?: IMMediaAttachment[];
  mediaGroupId?: string;      // 媒体组 ID（用于合并多张图片）
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

// ==================== Pairing Types ====================

export interface PairingRequest {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
}

export interface PairingListResult {
  success: boolean;
  requests: PairingRequest[];
  allowFrom: string[];
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

export const DEFAULT_NIM_CONFIG: NimConfig = {
  enabled: false,
  appKey: '',
  account: '',
  token: '',
};

export const DEFAULT_NETEASE_BEE_CONFIG: NeteaseBeeChanConfig = {
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
  streaming: 'partial',
  mediaMaxMb: 100,
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
  telegram: DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
  qq: DEFAULT_QQ_MULTI_INSTANCE_CONFIG,
  discord: DEFAULT_DISCORD_OPENCLAW_CONFIG,
  nim: DEFAULT_NIM_CONFIG,
  'netease-bee': DEFAULT_NETEASE_BEE_CONFIG,
  wecom: DEFAULT_WECOM_CONFIG,
  popo: DEFAULT_POPO_CONFIG,
  weixin: DEFAULT_WEIXIN_CONFIG,
  settings: DEFAULT_IM_SETTINGS,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: {
    instances: [],
  },
  feishu: {
    instances: [],
  },
  telegram: {
    connected: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  discord: {
    connected: false,
    starting: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  nim: {
    connected: false,
    startedAt: null,
    lastError: null,
    botAccount: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  'netease-bee': {
    connected: false,
    startedAt: null,
    lastError: null,
    botAccount: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  qq: {
    instances: [],
  },
  wecom: {
    connected: false,
    startedAt: null,
    lastError: null,
    botId: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  popo: {
    connected: false,
    startedAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  weixin: {
    connected: false,
    startedAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
};
