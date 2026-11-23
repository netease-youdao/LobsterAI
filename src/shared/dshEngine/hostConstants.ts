// Cross-process constants for LobsterAI's primary DeepSeek Harness (DSH) host.

export const DSH_PROFILE_DIR_NAME = 'dsh-profile';
export const DSH_PROFILE_NAME = 'lobsterai';
export const DSH_HOST_BUNDLE_NAME = '@lobsterai/dsh-bundle';
export const DSH_CHANNELS_BUNDLE_NAME = '@lobsterai/dsh-channels';
export const DSH_BASE_BUNDLE_NAME = '@deepseek-ai/dsh-base';
export const DSH_WEB_APP_BUNDLE_NAME = '@deepseek-ai/dsh-web-app';
export const DSH_OPS_ROUTE_PATH = '/api/lobsterai/ops';
export const DSH_CHANNELS_ROUTE_PATH = '/api/lobsterai/channels';
export const DSH_SESSION_ID_PREFIX = 'dsh:';
export const DSH_QUESTION_REQUEST_ID_PREFIX = 'dsh-question:';
export const DSH_APPROVAL_REQUEST_ID_PREFIX = 'dsh-approval:';
export const DSH_SKILL_INSTALL_TOOL = 'lobster_skill_install';
export const DshSkillInstallAction = { Inspect: 'inspect', Install: 'install' } as const;
export const DSH_HTML_RENDER_TOOL = 'lobsterai_render_html_to_image' as const;
export const HtmlRenderFormat = {
  Png: 'png',
  Jpeg: 'jpeg',
} as const;
export type HtmlRenderFormat = typeof HtmlRenderFormat[keyof typeof HtmlRenderFormat];
export const HTML_RENDER_LIMITS = {
  MaxItems: 20,
  MinDimension: 64,
  MaxDimension: 4096,
  DefaultWidth: 1242,
  DefaultHeight: 1656,
  DefaultQuality: 92,
  MaxWaitMs: 5000,
  DefaultTimeoutMs: 60_000,
} as const;
export const DSH_DELEGATE_AGENT_TOOL = 'delegate_agent';
export const DSH_DELEGATE_MAX_DEPTH = 2;
export const DSH_BRIDGE_SUBAGENT_BINDING_PATH = '/dsh-bridge/subagent-binding';
export const DSH_BRIDGE_WEB_SEARCH_PATH = '/dsh-bridge/web-search';

export const RetainedImPlatform = {
  Feishu: 'feishu',
  Weixin: 'weixin',
  DingTalk: 'dingtalk',
  WeCom: 'wecom',
  QQ: 'qq',
  Telegram: 'telegram',
  Discord: 'discord',
} as const;
export type RetainedImPlatform = typeof RetainedImPlatform[keyof typeof RetainedImPlatform];

export const RETAINED_IM_PLATFORM_LIST: readonly RetainedImPlatform[] = [
  RetainedImPlatform.Feishu,
  RetainedImPlatform.Weixin,
  RetainedImPlatform.DingTalk,
  RetainedImPlatform.WeCom,
  RetainedImPlatform.QQ,
  RetainedImPlatform.Telegram,
  RetainedImPlatform.Discord,
];

export const RetiredImPlatform = {
  Popo: 'popo',
  Nim: 'nim',
  NeteaseBee: 'netease-bee',
  Email: 'email',
} as const;
export type RetiredImPlatform = typeof RetiredImPlatform[keyof typeof RetiredImPlatform];

export const WORKSPACES_DIR_NAME = 'workspaces';
export const LEGACY_OPENCLAW_BACKUP_DIR_NAME = 'legacy-openclaw-backup';

export const DSH_REQUIRED_DISABLED_TELEMETRY_IDS = [
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
  'session-telemetry-otel',
  'deepseek-account',
  'llm-deepseek-account',
  'desktop-product-telemetry',
  'product-analytics',
] as const;

export const DshHostPhase = {
  Stopped: 'stopped',
  Starting: 'starting',
  Ready: 'ready',
  Failed: 'failed',
  Restarting: 'restarting',
} as const;
export type DshHostPhase = typeof DshHostPhase[keyof typeof DshHostPhase];

export const DshHostBundleEnvVar = {
  BridgeUrl: 'LOBSTERAI_DSH_BRIDGE_URL',
  BridgeSecret: 'LOBSTERAI_DSH_BRIDGE_SECRET',
  ProxyUrl: 'LOBSTERAI_DSH_PROXY_URL',
  WorkspacesDir: 'LOBSTERAI_WORKSPACES_DIR',
  SkillsDir: 'LOBSTERAI_SKILLS_DIR',
  InstanceId: 'LOBSTERAI_DSH_INSTANCE_ID',
  SearchPolicy: 'LOBSTERAI_DSH_SEARCH_POLICY',
} as const;
export type DshHostBundleEnvVar = typeof DshHostBundleEnvVar[keyof typeof DshHostBundleEnvVar];

export const DshMcpTransport = {
  Stdio: 'stdio',
  StreamableHttp: 'streamable-http',
  Sse: 'sse',
} as const;
export type DshMcpTransport = typeof DshMcpTransport[keyof typeof DshMcpTransport];

export const DshOpsAction = {
  Health: 'health',
  SyncProviders: 'syncProviders',
  SyncMcpServers: 'syncMcpServers',
  SyncSkillsPolicy: 'syncSkillsPolicy',
  SyncMemoryPolicy: 'syncMemoryPolicy',
  SyncAgents: 'syncAgents',
  SyncSubagentBindings: 'syncSubagentBindings',
  BindSessionContext: 'bindSessionContext',
  DeleteSessionFiles: 'deleteSessionFiles',
  SyncHostTools: 'syncHostTools',
  SyncWebAccessPolicy: 'syncWebAccessPolicy',
  SetPermissionPreset: 'setPermissionPreset',
} as const;
export type DshOpsAction = typeof DshOpsAction[keyof typeof DshOpsAction];

export const DshChannelsAction = {
  ListStatus: 'listStatus',
  SyncInstances: 'syncInstances',
  Send: 'send',
  WeixinQrStart: 'weixinQrStart',
  WeixinQrPoll: 'weixinQrPoll',
} as const;
export type DshChannelsAction = typeof DshChannelsAction[keyof typeof DshChannelsAction];

export const DshChannelState = {
  Stopped: 'stopped',
  Connecting: 'connecting',
  Connected: 'connected',
  Reconnecting: 'reconnecting',
  Error: 'error',
} as const;
export type DshChannelState = typeof DshChannelState[keyof typeof DshChannelState];

export const DshPermissionPreset = {
  ReadOnly: 'read-only',
  WorkspaceWrite: 'workspace-write',
  FullAccess: 'danger-full-access',
} as const;
export type DshPermissionPreset = typeof DshPermissionPreset[keyof typeof DshPermissionPreset];

export const DEFAULT_DSH_PERMISSION_PRESET: DshPermissionPreset = DshPermissionPreset.WorkspaceWrite;
export const DSH_PERMISSION_PRESET_KV_KEY = 'dsh.permissionPreset.default';

export function parseDshPermissionPreset(value: unknown): DshPermissionPreset | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed === DshPermissionPreset.ReadOnly
    || trimmed === DshPermissionPreset.WorkspaceWrite
    || trimmed === DshPermissionPreset.FullAccess
  ) {
    return trimmed;
  }
  return null;
}

export function mapLegacyExecutionModeToPermissionPreset(
  executionMode: unknown,
): DshPermissionPreset | null {
  if (typeof executionMode !== 'string') return null;
  const normalized = executionMode.trim().toLowerCase();
  if (normalized === 'auto') return DshPermissionPreset.FullAccess;
  if (normalized === 'local' || normalized === 'sandbox') {
    return DshPermissionPreset.WorkspaceWrite;
  }
  return null;
}

export const DshApprovalPermissionAction = {
  AllowSession: 'allow-session',
  SetPermissionPreset: 'set-permission-preset',
} as const;
export type DshApprovalPermissionAction =
  typeof DshApprovalPermissionAction[keyof typeof DshApprovalPermissionAction];

export const DshSearchPolicy = {
  DeepSeekNativeOnly: 'deepseek_native_only',
  LobsterWebSearchOnly: 'lobster_web_search_only',
  AllowAll: 'allow_all',
} as const;
export type DshSearchPolicy = typeof DshSearchPolicy[keyof typeof DshSearchPolicy];

export const DshProgressiveCapability = {
  ComputerUse: 'computer-use',
  Browser: 'browser',
  Word: 'word',
  Excel: 'excel',
  Ppt: 'ppt',
} as const;
export type DshProgressiveCapability =
  typeof DshProgressiveCapability[keyof typeof DshProgressiveCapability];

export const DshHostIpc = {
  GetStatus: 'dshHost:getStatus',
  Restart: 'dshHost:restart',
  GetWebUrl: 'dshHost:getWebUrl',
  OpenEcosystemView: 'dshHost:openEcosystemView',
  CloseEcosystemView: 'dshHost:closeEcosystemView',
  ListPlugins: 'dshHost:listPlugins',
  InstallPlugin: 'dshHost:installPlugin',
  RemovePlugin: 'dshHost:removePlugin',
  SetPluginEnabled: 'dshHost:setPluginEnabled',
  OpenProfileDir: 'dshHost:openProfileDir',
  CopyCliShimCommand: 'dshHost:copyCliShimCommand',
  GetPermissionPreset: 'dshHost:getPermissionPreset',
  SetPermissionPreset: 'dshHost:setPermissionPreset',
} as const;
export type DshHostIpc = typeof DshHostIpc[keyof typeof DshHostIpc];
