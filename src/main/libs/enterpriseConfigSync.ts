import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { SqliteStore } from '../sqliteStore';
import type { IMStore } from '../im/imStore';

export type EnterpriseUIAction = 'hide' | 'disable' | 'readonly';

export type EnterpriseManifest = {
  version: string;
  name: string;
  ui?: Record<string, EnterpriseUIAction>;
  disableUpdate?: boolean;
  sync: {
    openclaw: boolean;
    skills: boolean | 'merge' | 'overwrite';
    agents: boolean | 'force';
    mcp: boolean | 'merge' | 'overwrite';
    plugins?: boolean | 'merge' | 'overwrite';
  };
  autoAcceptPrivacy?: boolean;
};

const SANDBOX_MODE_MAP: Record<string, string> = {
  'off': 'local',
  'non-main': 'auto',
  'all': 'sandbox',
};

const ENTERPRISE_CONFIG_DIR = 'enterprise-config';
const MANIFEST_FILE = 'manifest.json';
const ACCOUNT_COMPAT_CHANNEL_KEYS = ['feishu', 'dingtalk', 'dingtalk-connector', 'qqbot', 'wecom', 'moltbot-popo'] as const;
type AccountCompatChannelKey = typeof ACCOUNT_COMPAT_CHANNEL_KEYS[number];

const ACCOUNT_COMPAT_CHANNEL_TOP_LEVEL_MAP: Record<AccountCompatChannelKey, Record<string, string>> = {
  feishu: {
    enabled: 'enabled',
    appId: 'appId',
    appSecret: 'appSecret',
    domain: 'domain',
    dmPolicy: 'dmPolicy',
    allowFrom: 'allowFrom',
    groupPolicy: 'groupPolicy',
    groupAllowFrom: 'groupAllowFrom',
    groups: 'groups',
    historyLimit: 'historyLimit',
    streaming: 'streaming',
    replyMode: 'replyMode',
    blockStreaming: 'blockStreaming',
    footer: 'footer',
    blockStreamingCoalesce: 'blockStreamingCoalesce',
    mediaMaxMb: 'mediaMaxMb',
  },
  dingtalk: {
    enabled: 'enabled',
    clientId: 'clientId',
    clientSecret: 'clientSecret',
    dmPolicy: 'dmPolicy',
    allowFrom: 'allowFrom',
    groupPolicy: 'groupPolicy',
    sessionTimeout: 'sessionTimeout',
    separateSessionByConversation: 'separateSessionByConversation',
    groupSessionScope: 'groupSessionScope',
    sharedMemoryAcrossConversations: 'sharedMemoryAcrossConversations',
    gatewayBaseUrl: 'gatewayBaseUrl',
  },
  'dingtalk-connector': {
    enabled: 'enabled',
    clientId: 'clientId',
    clientSecret: 'clientSecret',
    dmPolicy: 'dmPolicy',
    allowFrom: 'allowFrom',
    groupPolicy: 'groupPolicy',
    sessionTimeout: 'sessionTimeout',
    separateSessionByConversation: 'separateSessionByConversation',
    groupSessionScope: 'groupSessionScope',
    sharedMemoryAcrossConversations: 'sharedMemoryAcrossConversations',
    gatewayBaseUrl: 'gatewayBaseUrl',
  },
  qqbot: {
    enabled: 'enabled',
    appId: 'appId',
    clientSecret: 'appSecret',
    dmPolicy: 'dmPolicy',
    allowFrom: 'allowFrom',
    groupPolicy: 'groupPolicy',
    groupAllowFrom: 'groupAllowFrom',
    historyLimit: 'historyLimit',
    markdownSupport: 'markdownSupport',
    imageServerBaseUrl: 'imageServerBaseUrl',
  },
  wecom: {
    enabled: 'enabled',
    botId: 'botId',
    secret: 'secret',
    dmPolicy: 'dmPolicy',
    allowFrom: 'allowFrom',
    groupPolicy: 'groupPolicy',
    groupAllowFrom: 'groupAllowFrom',
    sendThinkingMessage: 'sendThinkingMessage',
  },
  'moltbot-popo': {
    enabled: 'enabled',
    connectionMode: 'connectionMode',
    appKey: 'appKey',
    appSecret: 'appSecret',
    token: 'token',
    aesKey: 'aesKey',
    webhookBaseUrl: 'webhookBaseUrl',
    webhookPath: 'webhookPath',
    webhookPort: 'webhookPort',
    dmPolicy: 'dmPolicy',
    allowFrom: 'allowFrom',
    groupPolicy: 'groupPolicy',
    groupAllowFrom: 'groupAllowFrom',
    textChunkLimit: 'textChunkLimit',
    richTextChunkLimit: 'richTextChunkLimit',
  },
};

function resolveMergeMode(value: boolean | 'merge' | 'overwrite' | undefined): 'merge' | 'overwrite' | null {
  if (!value) return null;
  return value === 'overwrite' ? 'overwrite' : 'merge';
}

function resolveEnterprisePluginsSourceDir(configPath: string): string | null {
  const pluginsDir = path.join(configPath, 'plugins');
  return fs.existsSync(pluginsDir) ? pluginsDir : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readAccountsFromChannelConfig(cfg: unknown): Record<string, Record<string, unknown>> | null {
  if (!isRecord(cfg) || !isRecord(cfg.accounts)) return null;
  const accounts: Record<string, Record<string, unknown>> = {};
  for (const [accountId, accountCfg] of Object.entries(cfg.accounts)) {
    if (isRecord(accountCfg)) {
      accounts[accountId] = accountCfg;
    }
  }
  return accounts;
}

function buildTopLevelAccountOverlay(
  channelKey: AccountCompatChannelKey,
  cfg: unknown,
): Record<string, unknown> {
  if (!isRecord(cfg)) return {};
  const keyMap = ACCOUNT_COMPAT_CHANNEL_TOP_LEVEL_MAP[channelKey];
  const overlay: Record<string, unknown> = {};
  for (const [accountKey, topLevelKey] of Object.entries(keyMap)) {
    if (Object.prototype.hasOwnProperty.call(cfg, topLevelKey)) {
      overlay[accountKey] = cfg[topLevelKey];
    }
  }
  return overlay;
}

function normalizeMultiAccountChannelConfig(
  channelKey: AccountCompatChannelKey,
  cfg: unknown,
  fallbackAccounts?: Record<string, Record<string, unknown>> | null,
): Record<string, unknown> | unknown {
  if (!isRecord(cfg)) return cfg;

  const overlay = buildTopLevelAccountOverlay(channelKey, cfg);
  const currentAccounts = readAccountsFromChannelConfig(cfg) ?? fallbackAccounts;
  if (!currentAccounts || Object.keys(currentAccounts).length === 0) {
    return cfg;
  }
  if (Object.keys(overlay).length === 0) {
    return cfg;
  }

  const normalizedAccounts: Record<string, Record<string, unknown>> = {};
  for (const [accountId, accountCfg] of Object.entries(currentAccounts)) {
    normalizedAccounts[accountId] = { ...accountCfg, ...overlay };
  }

  return {
    ...cfg,
    accounts: normalizedAccounts,
  };
}

/**
 * Check if an enterprise config package exists at the well-known path.
 * Returns the directory path if manifest.json is found, null otherwise.
 */
export function resolveEnterpriseConfigPath(): string | null {
  const configPath = path.join(app.getPath('userData'), ENTERPRISE_CONFIG_DIR);
  const manifestPath = path.join(configPath, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    return configPath;
  }
  return null;
}

/**
 * Read the enterprise config package and sync into SQLite.
 * Called once on startup, before openclawConfigSync.
 */
export function syncEnterpriseConfig(
  configPath: string,
  store: SqliteStore,
  imStore: IMStore,
  mcpUpsertByName: (server: { name: string; description: string; transportType: string; command?: string; args?: string[]; env?: Record<string, string> }) => void,
  mcpClearAll: () => void,
  coworkSetConfig: (config: Record<string, string>) => void,
  getWorkingDirectory: () => string | undefined,
): EnterpriseManifest | null {
  const manifestPath = path.join(configPath, MANIFEST_FILE);
  let manifest: EnterpriseManifest;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as EnterpriseManifest;
  } catch (error) {
    console.error('[Enterprise] failed to parse manifest.json, skipping enterprise config:', error);
    return null;
  }

  console.log(`[Enterprise] detected enterprise config: ${manifest.name} v${manifest.version}`);
  try {
    console.log(`[Enterprise] manifest: ${JSON.stringify(manifest, null, 2)}`);
  } catch { /* ignore serialization errors */ }

  // Check if enterprise config version has changed since last sync.
  // Skip file copy operations (skills, agents) if version is unchanged.
  const previousManifest = store.get<EnterpriseManifest>('enterprise_config');
  const versionChanged = previousManifest?.version !== manifest.version;

  store.set('enterprise_config', manifest);

  if (manifest.autoAcceptPrivacy) {
    store.set('privacy_agreed', true);
  }

  // SQLite writes are cheap — always sync to ensure consistency.
  if (manifest.sync.openclaw) {
    syncModelConfig(configPath, store);
    syncIMChannels(configPath, imStore);
    syncCoworkConfig(configPath, coworkSetConfig);
  }

  const agentsForce = manifest.sync.agents === 'force';
  const pluginsMode = resolveMergeMode(manifest.sync.plugins);

  // File copy operations — only run when version changes to avoid
  // unnecessary I/O on every startup.
  if (versionChanged) {
    if (manifest.sync.skills) {
      const skillsMode = manifest.sync.skills === 'overwrite' ? 'overwrite' : 'merge';
      syncSkills(configPath, store, skillsMode);
    }

    if (manifest.sync.agents) {
      syncAgents(configPath, getWorkingDirectory(), agentsForce);
    }

    if (pluginsMode) {
      syncPlugins(configPath, pluginsMode);
    }

    if (manifest.sync.mcp) {
      const mcpMode = manifest.sync.mcp === 'overwrite' ? 'overwrite' : 'merge';
      syncMcpServers(configPath, mcpUpsertByName, mcpClearAll, mcpMode);
    }
  } else {
    // Agents: force mode always copies, default mode only copies missing files
    if (manifest.sync.agents) {
      syncAgents(configPath, getWorkingDirectory(), agentsForce);
    }
    if (pluginsMode) {
      syncPlugins(configPath, pluginsMode);
    }
    console.log('[Enterprise] version unchanged, skipping file copy for skills and MCP');
  }

  console.log('[Enterprise] config sync completed');
  return manifest;
}

const API_FORMAT_MAP: Record<string, 'anthropic' | 'openai'> = {
  'anthropic-messages': 'anthropic',
  'openai-completions': 'openai',
};

/**
 * Reverse-map openclaw.json models.providers → app_config.providers.
 * Enterprise openclaw.json should use real provider names as keys
 * (e.g., 'deepseek', 'anthropic') instead of the generic 'lobster'.
 */
function syncModelConfig(configPath: string, store: SqliteStore): void {
  const openclawPath = path.join(configPath, 'openclaw.json');
  if (!fs.existsSync(openclawPath)) {
    console.log('[Enterprise] no openclaw.json found, skipping model config sync');
    return;
  }
  try {
    const raw = fs.readFileSync(openclawPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const models = config.models as { providers?: Record<string, any> } | undefined;
    const agents = config.agents as { defaults?: { model?: { primary?: string } } } | undefined;

    if (!models?.providers || Object.keys(models.providers).length === 0) {
      console.log('[Enterprise] no models.providers in openclaw.json, skipping model config sync');
      return;
    }

    // Build app_config.providers from openclaw providers
    const appProviders: Record<string, any> = {};
    const allModels: Array<{ id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }> = [];

    for (const [providerId, providerConfig] of Object.entries(models.providers)) {
      const apiFormat = API_FORMAT_MAP[providerConfig.api] ?? 'anthropic';
      const providerModels = (providerConfig.models ?? []).map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        supportsImage: Array.isArray(m.input) && m.input.includes('image'),
      }));

      // Resolve apiKey: use plain text value, skip placeholders like ${LOBSTER_...}
      const apiKey = typeof providerConfig.apiKey === 'string' && !providerConfig.apiKey.startsWith('${')
        ? providerConfig.apiKey
        : '';

      appProviders[providerId] = {
        enabled: true,
        apiKey,
        baseUrl: providerConfig.baseUrl ?? '',
        apiFormat,
        models: providerModels,
      };

      for (const m of providerModels) {
        allModels.push({ ...m, provider: providerId, providerKey: providerId });
      }
    }

    // Resolve default model from agents.defaults.model.primary ("provider/modelId")
    let defaultModel = allModels[0]?.id ?? '';
    let defaultModelProvider = Object.keys(appProviders)[0] ?? '';
    const primary = agents?.defaults?.model?.primary;
    if (primary && primary.includes('/')) {
      const slashIdx = primary.indexOf('/');
      defaultModelProvider = primary.slice(0, slashIdx);
      defaultModel = primary.slice(slashIdx + 1);
    }

    // Resolve api config from default provider
    const defaultProvider = appProviders[defaultModelProvider];
    const apiKey = defaultProvider?.apiKey ?? '';
    const baseUrl = defaultProvider?.baseUrl ?? '';

    // Merge with existing app_config to preserve theme/language/etc
    const existing = store.get<Record<string, unknown>>('app_config') ?? {};

    const appConfig = {
      ...existing,
      api: { key: apiKey, baseUrl },
      model: {
        availableModels: allModels,
        defaultModel,
        defaultModelProvider,
      },
      providers: appProviders,
    };

    store.set('app_config', appConfig);
    console.log(`[Enterprise] synced ${Object.keys(appProviders).length} provider(s) to app_config`);
  } catch (error) {
    console.error('[Enterprise] failed to sync model config:', error);
  }
}

function syncIMChannels(configPath: string, imStore: IMStore): void {
  const openclawPath = path.join(configPath, 'openclaw.json');
  if (!fs.existsSync(openclawPath)) {
    console.log('[Enterprise] no openclaw.json found, skipping IM channel sync');
    return;
  }
  try {
    const raw = fs.readFileSync(openclawPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const channels = config.channels as Record<string, unknown> | undefined;
    if (!channels) {
      console.log('[Enterprise] no channels in openclaw.json, skipping IM sync');
      return;
    }

    const resolveInstanceId = (
      accountId: string,
      instances: Array<{ instanceId: string }>,
    ): string => {
      const existing = instances.find((inst) => (
        inst.instanceId === accountId
        || inst.instanceId.startsWith(accountId)
        || inst.instanceId.slice(0, 8) === accountId
      ));
      return existing?.instanceId ?? accountId;
    };

    const syncAccountConfigs = (
      cfg: unknown,
      instances: Array<{ instanceId: string }>,
      setInstanceConfig: (instanceId: string, config: Record<string, unknown>) => void,
      mapAccountConfig: (accountId: string, accountCfg: Record<string, unknown>) => Record<string, unknown>,
      channelKey: AccountCompatChannelKey,
    ): boolean => {
      const accounts = readAccountsFromChannelConfig(normalizeMultiAccountChannelConfig(channelKey, cfg));
      if (!accounts) return false;
      for (const [accountId, accountCfg] of Object.entries(accounts)) {
        setInstanceConfig(resolveInstanceId(accountId, instances), mapAccountConfig(accountId, accountCfg));
      }
      return true;
    };

    // Use platform-specific setters so values are merged with defaults.
    // For multi-instance platforms (feishu, dingtalk, qq, wecom), update existing
    // instances when present so enterprise config changes propagate correctly.
    const PLATFORM_SETTERS: Record<string, (cfg: any) => void> = {
      'telegram': (cfg) => {
        if (cfg && Array.isArray(cfg.instances)) {
          imStore.setTelegramMultiInstanceConfig(cfg);
          return;
        }
        imStore.setTelegramOpenClawConfig(cfg);
      },
      'discord': (cfg) => {
        if (cfg && Array.isArray(cfg.instances)) {
          imStore.setDiscordMultiInstanceConfig(cfg);
          return;
        }
        imStore.setDiscordOpenClawConfig(cfg);
      },
      'feishu': (cfg) => {
        const instances = imStore.getFeishuInstances();
        if (syncAccountConfigs(
          cfg,
          instances,
          (instanceId, config) => imStore.setFeishuInstanceConfig(instanceId, config),
          (accountId, accountCfg) => ({
            enabled: accountCfg.enabled,
            instanceName: typeof accountCfg.name === 'string' ? accountCfg.name : accountId,
            appId: accountCfg.appId,
            appSecret: accountCfg.appSecret,
            domain: accountCfg.domain,
            dmPolicy: accountCfg.dmPolicy,
            allowFrom: accountCfg.allowFrom,
            groupPolicy: accountCfg.groupPolicy,
            groupAllowFrom: accountCfg.groupAllowFrom,
            groups: accountCfg.groups,
            historyLimit: accountCfg.historyLimit,
            streaming: accountCfg.streaming,
            replyMode: accountCfg.replyMode,
            blockStreaming: accountCfg.blockStreaming,
            footer: accountCfg.footer,
            blockStreamingCoalesce: accountCfg.blockStreamingCoalesce,
            mediaMaxMb: accountCfg.mediaMaxMb,
          }),
          'feishu',
        )) {
          return;
        }
        if (instances.length > 0) {
          for (const inst of instances) {
            imStore.setFeishuInstanceConfig(inst.instanceId, cfg);
          }
        } else {
          imStore.setFeishuOpenClawConfig(cfg);
        }
      },
      'dingtalk': (cfg) => {
        const instances = imStore.getDingTalkInstances();
        if (syncAccountConfigs(
          cfg,
          instances,
          (instanceId, config) => imStore.setDingTalkInstanceConfig(instanceId, config),
          (accountId, accountCfg) => ({
            enabled: accountCfg.enabled,
            instanceName: typeof accountCfg.name === 'string' ? accountCfg.name : accountId,
            clientId: accountCfg.clientId,
            clientSecret: accountCfg.clientSecret,
            dmPolicy: accountCfg.dmPolicy,
            allowFrom: accountCfg.allowFrom,
            groupPolicy: accountCfg.groupPolicy,
            sessionTimeout: accountCfg.sessionTimeout,
            separateSessionByConversation: accountCfg.separateSessionByConversation,
            groupSessionScope: accountCfg.groupSessionScope,
            sharedMemoryAcrossConversations: accountCfg.sharedMemoryAcrossConversations,
            gatewayBaseUrl: accountCfg.gatewayBaseUrl,
          }),
          'dingtalk',
        )) {
          return;
        }
        if (instances.length > 0) {
          for (const inst of instances) {
            imStore.setDingTalkInstanceConfig(inst.instanceId, cfg);
          }
        } else {
          imStore.setDingTalkOpenClawConfig(cfg);
        }
      },
      'dingtalk-connector': (cfg) => {
        const instances = imStore.getDingTalkInstances();
        if (syncAccountConfigs(
          cfg,
          instances,
          (instanceId, config) => imStore.setDingTalkInstanceConfig(instanceId, config),
          (accountId, accountCfg) => ({
            enabled: accountCfg.enabled,
            instanceName: typeof accountCfg.name === 'string' ? accountCfg.name : accountId,
            clientId: accountCfg.clientId,
            clientSecret: accountCfg.clientSecret,
            dmPolicy: accountCfg.dmPolicy,
            allowFrom: accountCfg.allowFrom,
            groupPolicy: accountCfg.groupPolicy,
            sessionTimeout: accountCfg.sessionTimeout,
            separateSessionByConversation: accountCfg.separateSessionByConversation,
            groupSessionScope: accountCfg.groupSessionScope,
            sharedMemoryAcrossConversations: accountCfg.sharedMemoryAcrossConversations,
            gatewayBaseUrl: accountCfg.gatewayBaseUrl,
          }),
          'dingtalk-connector',
        )) {
          return;
        }
        if (instances.length > 0) {
          for (const inst of instances) {
            imStore.setDingTalkInstanceConfig(inst.instanceId, cfg);
          }
        } else {
          imStore.setDingTalkOpenClawConfig(cfg);
        }
      },
      'qqbot': (cfg) => {
        const instances = imStore.getQQInstances();
        if (syncAccountConfigs(
          cfg,
          instances,
          (instanceId, config) => imStore.setQQInstanceConfig(instanceId, config),
          (accountId, accountCfg) => ({
            enabled: accountCfg.enabled,
            instanceName: typeof accountCfg.name === 'string' ? accountCfg.name : accountId,
            appId: accountCfg.appId,
            appSecret: accountCfg.clientSecret ?? accountCfg.appSecret,
            dmPolicy: accountCfg.dmPolicy,
            allowFrom: accountCfg.allowFrom,
            groupPolicy: accountCfg.groupPolicy,
            groupAllowFrom: accountCfg.groupAllowFrom,
            historyLimit: accountCfg.historyLimit,
            markdownSupport: accountCfg.markdownSupport,
            imageServerBaseUrl: accountCfg.imageServerBaseUrl,
          }),
          'qqbot',
        )) {
          return;
        }
        if (instances.length > 0) {
          for (const inst of instances) {
            imStore.setQQInstanceConfig(inst.instanceId, cfg);
          }
        } else {
          imStore.setQQConfig(cfg);
        }
      },
      'wecom': (cfg) => {
        const instances = imStore.getWecomInstances();
        if (syncAccountConfigs(
          cfg,
          instances,
          (instanceId, config) => imStore.setWecomInstanceConfig(instanceId, config),
          (accountId, accountCfg) => ({
            enabled: accountCfg.enabled,
            instanceName: typeof accountCfg.name === 'string' ? accountCfg.name : accountId,
            botId: accountCfg.botId,
            secret: accountCfg.secret,
            dmPolicy: accountCfg.dmPolicy,
            allowFrom: accountCfg.allowFrom,
            groupPolicy: accountCfg.groupPolicy,
            groupAllowFrom: accountCfg.groupAllowFrom,
            sendThinkingMessage: accountCfg.sendThinkingMessage,
          }),
          'wecom',
        )) {
          return;
        }
        if (instances.length > 0) {
          for (const inst of instances) {
            imStore.setWecomInstanceConfig(inst.instanceId, cfg);
          }
        } else {
          imStore.setWecomConfig(cfg);
        }
      },
      'moltbot-popo': (cfg) => {
        const normalizedCfg = normalizeMultiAccountChannelConfig('moltbot-popo', cfg);
        const accounts = readAccountsFromChannelConfig(normalizedCfg);
        if (accounts) {
          const firstAccount = Object.values(accounts)[0];
          if (firstAccount) {
            imStore.setPopoConfig(firstAccount);
            return;
          }
        }
        imStore.setPopoConfig(cfg);
      },
      'nim': (cfg) => {
        if (cfg && typeof cfg.accounts === 'object' && !Array.isArray(cfg.accounts)) {
          imStore.setNimMultiInstanceConfig({ instances: Object.values(cfg.accounts) });
          return;
        }
        if (cfg && Array.isArray(cfg.instances)) {
          imStore.setNimMultiInstanceConfig(cfg);
          return;
        }
        imStore.setNimConfig(cfg);
      },
      'openclaw-weixin': (cfg) => imStore.setWeixinConfig(cfg),
      'netease-bee': (cfg) => imStore.setNeteaseBeeChanConfig(cfg),
    };

    let syncedCount = 0;
    for (const [channelKey, channelConfig] of Object.entries(channels)) {
      const setter = PLATFORM_SETTERS[channelKey];
      if (!setter) {
        console.warn(`[Enterprise] unknown channel key "${channelKey}", skipping`);
        continue;
      }
      setter(channelConfig);
      syncedCount++;
    }
    console.log(`[Enterprise] synced ${syncedCount} IM channel(s) to im_config`);
  } catch (error) {
    console.error('[Enterprise] failed to sync IM channels:', error);
  }
}

function syncCoworkConfig(
  configPath: string,
  setConfig: (config: Record<string, string>) => void,
): void {
  const openclawPath = path.join(configPath, 'openclaw.json');
  if (!fs.existsSync(openclawPath)) return;

  try {
    const raw = fs.readFileSync(openclawPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const agents = config.agents as { defaults?: { sandbox?: { mode?: string }; workspace?: string } } | undefined;
    const updates: Record<string, string> = {};

    updates.agentEngine = 'openclaw';

    if (agents?.defaults?.sandbox?.mode) {
      const mapped = SANDBOX_MODE_MAP[agents.defaults.sandbox.mode];
      if (mapped) {
        updates.executionMode = mapped;
      }
    }

    if (agents?.defaults?.workspace) {
      updates.workingDirectory = agents.defaults.workspace;
    }

    setConfig(updates);
    console.log(`[Enterprise] synced cowork config: ${JSON.stringify(updates)}`);
  } catch (error) {
    console.error('[Enterprise] failed to sync cowork config:', error);
  }
}

function syncSkills(configPath: string, store: SqliteStore, mode: 'merge' | 'overwrite'): void {
  const skillsDir = path.join(configPath, 'skills');
  if (!fs.existsSync(skillsDir)) {
    console.log('[Enterprise] no skills/ directory found, skipping skills sync');
    return;
  }

  const userDataSkillsDir = path.join(app.getPath('userData'), 'SKILLs');
  if (!fs.existsSync(userDataSkillsDir)) {
    fs.mkdirSync(userDataSkillsDir, { recursive: true });
  }

  // In overwrite mode, remove all existing non-bundled skills first
  if (mode === 'overwrite') {
    const existingEntries = fs.readdirSync(userDataSkillsDir, { withFileTypes: true });
    for (const entry of existingEntries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(userDataSkillsDir, entry.name);
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[Enterprise] failed to remove existing skill "${entry.name}":`, error);
      }
    }
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skillNames: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(skillsDir, entry.name);
    const dest = path.join(userDataSkillsDir, entry.name);
    try {
      copyDirRecursive(src, dest);
      skillNames.push(entry.name);
    } catch (error) {
      console.warn(`[Enterprise] failed to copy skill "${entry.name}":`, error);
    }
  }

  if (skillNames.length > 0) {
    try {
      const existing = mode === 'overwrite'
        ? {} as Record<string, { enabled: boolean }>
        : (store.get<Record<string, { enabled: boolean }>>('skills_state') ?? {});
      for (const name of skillNames) {
        existing[name] = { enabled: true };
      }
      store.set('skills_state', existing);
    } catch (error) {
      console.warn('[Enterprise] failed to update skills_state:', error);
    }
  }

  console.log(`[Enterprise] synced ${skillNames.length} skill(s) (mode: ${mode})`);
}

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function syncAgents(configPath: string, workspaceDir: string | undefined, force: boolean): void {
  const agentsDir = path.join(configPath, 'agents');
  if (!fs.existsSync(agentsDir)) {
    console.log('[Enterprise] no agents/ directory found, skipping agents sync');
    return;
  }

  const targetDir = workspaceDir || path.join(app.getPath('home'), '.openclaw', 'workspace');
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (error) {
      console.warn(`[Enterprise] failed to prepare agents workspace at ${targetDir}, skipping agents sync:`, error);
      return;
    }
  }

  // Copy all files from enterprise agents/ to workspace directory
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  let copiedCount = 0;

  for (const entry of entries) {
    const src = path.join(agentsDir, entry.name);
    const dest = path.join(targetDir, entry.name);
    // Default: only copy if target does not exist (preserve user modifications)
    // Force: always overwrite
    if (!force && fs.existsSync(dest)) continue;
    try {
      if (entry.isDirectory()) {
        copyDirRecursive(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
      copiedCount++;
    } catch (error) {
      console.warn(`[Enterprise] failed to copy agent file "${entry.name}":`, error);
    }
  }

  console.log(`[Enterprise] synced ${copiedCount} agent file(s) to ${targetDir}`);
}

function syncMcpServers(
  configPath: string,
  upsertByName: (server: { name: string; description: string; transportType: string; command?: string; args?: string[]; env?: Record<string, string> }) => void,
  clearAll: () => void,
  mode: 'merge' | 'overwrite',
): void {
  const mcpPath = path.join(configPath, 'mcp', 'servers.json');
  if (!fs.existsSync(mcpPath)) {
    console.log('[Enterprise] no mcp/servers.json found, skipping MCP sync');
    return;
  }

  try {
    const raw = fs.readFileSync(mcpPath, 'utf-8');
    const servers = JSON.parse(raw) as Array<{
      name: string;
      description: string;
      transportType: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }>;

    if (!Array.isArray(servers)) {
      console.warn('[Enterprise] mcp/servers.json is not an array, skipping');
      return;
    }

    if (mode === 'overwrite') {
      clearAll();
    }

    let syncedCount = 0;
    for (const server of servers) {
      if (!server.name) {
        console.warn('[Enterprise] MCP server entry missing name, skipping');
        continue;
      }
      try {
        upsertByName({
          name: server.name,
          description: server.description || '',
          transportType: server.transportType || 'stdio',
          command: server.command,
          args: server.args,
          env: server.env,
        });
        syncedCount++;
      } catch (error) {
        console.warn(`[Enterprise] failed to upsert MCP server "${server.name}":`, error);
      }
    }
    console.log(`[Enterprise] synced ${syncedCount} MCP server(s) (mode: ${mode})`);
  } catch (error) {
    console.error('[Enterprise] failed to sync MCP servers:', error);
  }
}

function syncPlugins(configPath: string, mode: 'merge' | 'overwrite'): void {
  const pluginsDir = resolveEnterprisePluginsSourceDir(configPath);
  if (!pluginsDir) {
    console.log('[Enterprise] no plugins/ directory found, skipping plugin sync');
    return;
  }

  const pluginCount = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  console.log(`[Enterprise] registered ${pluginCount} plugin(s) from ${pluginsDir} (mode: ${mode})`);
}

/**
 * Deep merge source into target. Source values win on conflict.
 * Arrays are replaced (not concatenated).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function readPluginLoadPaths(config: Record<string, unknown>): string[] {
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return [];
  }

  const load = (plugins as Record<string, unknown>).load;
  if (!load || typeof load !== 'object' || Array.isArray(load)) {
    return [];
  }

  const paths = (load as Record<string, unknown>).paths;
  if (!Array.isArray(paths)) {
    return [];
  }

  return paths.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function mergeOpenClawConfigs(
  runtimeConfig: Record<string, unknown>,
  enterpriseConfig: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedEnterpriseConfig: Record<string, unknown> = { ...enterpriseConfig };
  const runtimeChannels = isRecord(runtimeConfig.channels) ? runtimeConfig.channels : null;
  const enterpriseChannels = isRecord(enterpriseConfig.channels) ? enterpriseConfig.channels : null;
  if (enterpriseChannels) {
    const normalizedChannels: Record<string, unknown> = { ...enterpriseChannels };
    for (const channelKey of ACCOUNT_COMPAT_CHANNEL_KEYS) {
      const enterpriseChannelCfg = enterpriseChannels[channelKey];
      if (!enterpriseChannelCfg) continue;
      const runtimeChannelCfg = runtimeChannels?.[channelKey];
      normalizedChannels[channelKey] = normalizeMultiAccountChannelConfig(
        channelKey,
        enterpriseChannelCfg,
        readAccountsFromChannelConfig(runtimeChannelCfg),
      );
    }
    normalizedEnterpriseConfig.channels = normalizedChannels;
  }

  const merged = deepMerge(runtimeConfig, normalizedEnterpriseConfig);

  const mergedPluginLoadPaths = Array.from(new Set([
    ...readPluginLoadPaths(runtimeConfig),
    ...readPluginLoadPaths(normalizedEnterpriseConfig),
  ]));

  if (mergedPluginLoadPaths.length === 0) {
    return merged;
  }

  const existingPlugins = merged.plugins;
  const plugins = existingPlugins && typeof existingPlugins === 'object' && !Array.isArray(existingPlugins)
    ? { ...(existingPlugins as Record<string, unknown>) }
    : {};
  const existingLoad = plugins.load;
  const load = existingLoad && typeof existingLoad === 'object' && !Array.isArray(existingLoad)
    ? { ...(existingLoad as Record<string, unknown>) }
    : {};

  load.paths = mergedPluginLoadPaths;
  plugins.load = load;
  merged.plugins = plugins;

  return merged;
}

/**
 * Merge enterprise openclaw.json fields into the runtime-generated openclaw.json.
 * Called AFTER openclawConfigSync generates the runtime config.
 * Enterprise values override generated values; fields not in enterprise config are preserved.
 */
export function mergeEnterpriseOpenclawConfig(runtimeConfigPath: string): void {
  const enterprisePath = resolveEnterpriseConfigPath();
  if (!enterprisePath) return;

  const enterpriseOpenclawPath = path.join(enterprisePath, 'openclaw.json');
  if (!fs.existsSync(enterpriseOpenclawPath) || !fs.existsSync(runtimeConfigPath)) return;

  try {
    const runtimeRaw = fs.readFileSync(runtimeConfigPath, 'utf-8');
    const runtimeConfig = JSON.parse(runtimeRaw) as Record<string, unknown>;

    const enterpriseRaw = fs.readFileSync(enterpriseOpenclawPath, 'utf-8');
    const enterpriseConfig = JSON.parse(enterpriseRaw) as Record<string, unknown>;

    const merged = mergeOpenClawConfigs(runtimeConfig, enterpriseConfig);
    fs.writeFileSync(runtimeConfigPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log('[Enterprise] merged enterprise openclaw.json into runtime config');
  } catch (error) {
    console.error('[Enterprise] failed to merge enterprise openclaw.json:', error);
  }
}
