import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ProviderName } from '../../shared/providers';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => {
      if (name === 'home') return os.homedir();
      return os.tmpdir();
    },
  },
}));

const mockRuntimeState = vi.hoisted(() => ({
  proxyPort: null as number | null,
  modelCompatPluginAvailable: true,
  serverModels: [] as Array<{
    modelId: string;
    modelName?: string;
    provider?: string;
    apiFormat?: string;
    runtimeProfile?: string;
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    supportsToolCalling?: boolean;
    agenticReady?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    explicitContextCache?: boolean;
  }>,
  enabledProviders: [] as Array<{
    providerName: string;
    baseURL: string;
    apiKey: string;
    apiType: 'anthropic' | 'openai';
    authType?: 'apikey' | 'oauth';
    codingPlanEnabled: boolean;
    models: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsThinking?: boolean;
      contextWindow?: number;
      maxTokens?: number;
      customParams?: Record<string, unknown>;
    }>;
  }>,
  providerSourceEntries: [] as Array<{
    providerName: string;
    codingPlanEnabled: boolean;
    authType?: 'apikey' | 'oauth';
    displayName?: string;
  }>,
  rawApiConfig: {
    config: {
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: 'openai',
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'GPT Test',
    },
  } as {
    config: {
      baseURL: string;
      apiKey: string;
      model: string;
      apiType: 'anthropic' | 'openai';
    };
    providerMetadata: {
      providerName: string;
      authType?: 'apikey' | 'oauth';
      codingPlanEnabled: boolean;
      runtimeProfile?: string;
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsThinking?: boolean;
      modelName?: string;
      contextWindow?: number;
      maxTokens?: number;
    };
  },
}));

vi.mock('./claudeSettings', () => ({
  getAllServerModelMetadata: () => mockRuntimeState.serverModels,
  listProviderSourceEntries: () => mockRuntimeState.providerSourceEntries,
  resolveAllEnabledProviderConfigs: () => mockRuntimeState.enabledProviders,
  resolveAllProviderApiKeys: () => ({}),
  resolveRawApiConfig: () => mockRuntimeState.rawApiConfig,
}));

vi.mock('./openclawLocalExtensions', () => ({
  findBundledExtensionsDir: () => null,
  findThirdPartyExtensionsDir: () => null,
  hasBundledOpenClawExtension: (id: string) => (
    id !== 'qwen-portal-auth'
    && (id !== 'lobsterai-model-compat' || mockRuntimeState.modelCompatPluginAvailable)
  ),
  hasRuntimeBundledOpenClawExtension: (id: string) => id === 'xai',
  resolveOpenClawExtensionPluginId: (id: string) => {
    const manifestIds: Record<string, string> = {
      'clawemail-email': 'email',
      'openclaw-nim-channel': 'nimsuite-openclaw-nim-channel',
    };
    if (id === 'qwen-portal-auth') return null;
    return manifestIds[id] ?? id;
  },
}));

vi.mock('./openclawTokenProxy', () => ({
  getOpenClawTokenProxyPort: () => mockRuntimeState.proxyPort,
}));

describe('OpenClawConfigSync runtime config output', () => {
  let tmpDir: string;
  let configPath: string;
  let stateDir: string;

  beforeEach(() => {
    mockRuntimeState.proxyPort = null;
    mockRuntimeState.modelCompatPluginAvailable = true;
    mockRuntimeState.serverModels = [];
    mockRuntimeState.enabledProviders = [];
    mockRuntimeState.providerSourceEntries = [];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'openai',
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'GPT Test',
      },
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-'));
    stateDir = path.join(tmpDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const { restoreOriginalProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(false);
    restoreOriginalProxyEnv();
  });

  const createSync = async (overrides: Record<string, unknown> = {}) => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    return new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
      ...overrides,
    } as never);
  };

  test('keys OpenClaw skill entries by frontmatter name, not directory id', async () => {
    const sync = await createSync({
      // Mirrors bundled skills whose SKILL.md frontmatter name differs from
      // the directory-derived id (see issue #2441): OpenClaw resolves
      // skills.entries overrides by frontmatter name only.
      getSkillsList: () => [
        { id: 'technology-news-search', name: 'technology-search', enabled: false },
        { id: 'remotion', name: 'remotion-best-practices', enabled: false },
        { id: 'weather', name: 'weather', enabled: true },
      ],
    });

    const result = sync.sync('skill-entry-keys');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.skills.entries).toMatchObject({
      'technology-search': { enabled: false },
      'remotion-best-practices': { enabled: false },
      weather: { enabled: true },
    });
    expect(config.skills.entries).not.toHaveProperty('technology-news-search');
    expect(config.skills.entries).not.toHaveProperty('remotion');
  });

  test('writes OpenClaw config fields required by LobsterAI patches', async () => {
    const legacyWorkingDirectory = path.join(tmpDir, 'legacy-working-directory');
    const mainAgentWorkingDirectory = path.join(tmpDir, 'main-agent-working-directory');

    const sync = await createSync({
      getCoworkConfig: () => ({
        workingDirectory: legacyWorkingDirectory,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: true,
      }),
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: mainAgentWorkingDirectory,
          icon: '',
          skillIds: [],
          enabled: true,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = sync.sync('lobsterai-patch-dependent-fields');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const mainEntry = config.agents.list.find((entry: { id?: string }) => entry.id === 'main');

    expect(config.cron.skipMissedJobs).toBe(true);
    expect(config.cron.store).toBe(path.join(stateDir, 'cron', 'jobs.json'));
    expect(config.agents.defaults.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
    expect(mainEntry.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
  });

  test('disables OpenClaw remote model pricing refresh in generated config', async () => {
    const sync = await createSync();

    const result = sync.sync('disable-model-pricing');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.pricing).toEqual({ enabled: false });
  });

  test('strips plugin-index-managed plugins.installs while preserving other plugins keys', async () => {
    // A leaked plugins.installs on disk poisons config.set hot delivery
    // (the gateway rejects the key) and makes the gateway self-restart on
    // the file diff — sync must scrub it on every write.
    fs.writeFileSync(configPath, `${JSON.stringify({
      gateway: { mode: 'local', port: 18789 },
      plugins: {
        entries: { 'runtime-injected-plugin': { enabled: true } },
        allow: ['runtime-injected-plugin'],
        slots: { memory: 'memory-core' },
        installs: { xai: { source: 'npm', version: '1.0.0' } },
      },
    }, null, 2)}\n`, 'utf8');
    const sync = await createSync();

    const result = sync.sync('installs-scrub');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.installs).toBeUndefined();
    expect(config.plugins.entries['runtime-injected-plugin']).toEqual({ enabled: true });
    expect(config.plugins.allow).toContain('runtime-injected-plugin');
    expect(config.plugins.slots.memory).toBe('memory-core');
    expect(config.gateway.port).toBe(18789);
  });

  test('defaults memory search to local FTS-only when embeddings are disabled', async () => {
    const sync = await createSync({
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: true,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        embeddingEnabled: false,
        embeddingProvider: 'openai',
        embeddingModel: '',
        embeddingLocalModelPath: '',
        embeddingVectorWeight: 0.7,
        embeddingRemoteBaseUrl: '',
        embeddingRemoteApiKey: '',
      }),
    });

    const result = sync.sync('memory-search-default-fts');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.memorySearch).toMatchObject({
      enabled: true,
      provider: 'none',
      fallback: 'none',
      store: {
        fts: { tokenizer: 'trigram' },
        vector: { enabled: false },
      },
    });
    expect(config.agents.defaults.memorySearch.remote).toBeUndefined();
  });

  test('configures OpenClaw chat image attachment limit to 30MB', async () => {
    const sync = await createSync();

    const result = sync.sync('chat-image-attachment-limit');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.mediaMaxMb).toBe(30);
  });

  test('enables physical transcript rotation with a managed size threshold', async () => {
    const sync = await createSync();

    const result = sync.sync('transcript-rotation');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.compaction).toEqual({
      truncateAfterCompaction: true,
      maxActiveTranscriptBytes: '32mb',
    });
  });

  test('disables optimized OpenClaw heartbeat by default', async () => {
    const sync = await createSync();

    const result = sync.sync('heartbeat-disabled-default');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.heartbeat).toEqual({
      every: '0m',
      target: 'none',
      lightContext: true,
      isolatedSession: true,
      skipWhenBusy: true,
    });
  });

  test('writes enabled OpenClaw heartbeat cadence when user enables heartbeat', async () => {
    const sync = await createSync({
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        openClawHeartbeatEnabled: true,
      }),
    });

    const result = sync.sync('heartbeat-enabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.heartbeat).toEqual({
      every: '1h',
      target: 'none',
      lightContext: true,
      isolatedSession: true,
      skipWhenBusy: true,
    });
  });

  test('writes model provider env-proxy transport when system proxy is enabled', async () => {
    const { setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('test');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers.openai.request.proxy).toEqual({ mode: 'env-proxy' });
  });

  test('writes managed browser proxy args when system proxy is enabled', async () => {
    const { applySystemProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    applySystemProxyEnv('http://127.0.0.1:7890');

    const sync = await createSync();

    const result = sync.sync('browser-system-proxy');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser.extraArgs).toEqual(['--proxy-server=http://127.0.0.1:7890']);
  });

  test('does not write managed browser proxy args in strict browser network mode', async () => {
    const { BrowserNetworkMode } = await import('../../shared/browserWebAccess/constants');
    const { applySystemProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    applySystemProxyEnv('http://127.0.0.1:7890');

    const sync = await createSync({
      getBrowserWebAccessConfig: () => ({
        networkMode: BrowserNetworkMode.Strict,
      }),
    });

    const result = sync.sync('browser-system-proxy-strict');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser.extraArgs).toBeUndefined();
    expect(config.browser.ssrfPolicy.dangerouslyAllowPrivateNetwork).toBe(false);
  });

  test('does not write managed browser proxy args when browser proxy following is disabled', async () => {
    const { applySystemProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    applySystemProxyEnv('http://127.0.0.1:7890');

    const sync = await createSync({
      getBrowserWebAccessConfig: () => ({
        followGlobalProxy: false,
      }),
    });

    const result = sync.sync('browser-system-proxy-disabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser.extraArgs).toBeUndefined();
  });

  test('does not create an agent model allowlist for OpenAI OAuth when system proxy is enabled', async () => {
    const { ProviderName } = await import('../../shared/providers');
    const { setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-5.4',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.OpenAI,
        authType: 'oauth',
        codingPlanEnabled: false,
        supportsImage: true,
        modelName: 'GPT-5.4',
      },
    };
    mockRuntimeState.enabledProviders = [
      {
        providerName: ProviderName.OpenAI,
        baseURL: 'https://api.openai.com/v1',
        apiKey: '',
        apiType: 'openai',
        authType: 'oauth',
        codingPlanEnabled: false,
        models: [{ id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true }],
      },
      {
        providerName: ProviderName.DeepSeek,
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false }],
      },
    ];

    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('openai-oauth-system-proxy');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers.openai).toBeDefined();
    expect(config.models.providers.openai.api).toBe('openai-chatgpt-responses');
    expect(config.models.providers['openai-codex']).toBeUndefined();
    expect(config.models.providers.deepseek).toBeDefined();
    expect(config.agents.defaults.models).toBeUndefined();
    expect(config.agents.defaults.workspace).toBe(path.join(stateDir, 'workspace-main'));
    expect(config.agents.defaults.cwd).toBe(path.resolve(tmpDir));
  });

  test('uses the main agent working directory for default agent cwd', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');
    const legacyWorkingDirectory = path.join(tmpDir, 'legacy-working-directory');
    const mainAgentWorkingDirectory = path.join(tmpDir, 'main-agent-working-directory');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: legacyWorkingDirectory,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: mainAgentWorkingDirectory,
          icon: '',
          skillIds: [],
          enabled: true,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = sync.sync('main-agent-cwd');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const mainEntry = config.agents.list.find((entry: { id?: string }) => entry.id === 'main');

    expect(config.agents.defaults.workspace).toBe(path.join(stateDir, 'workspace-main'));
    expect(config.agents.defaults.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
    expect(mainEntry.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
  });

  test('does not copy main USER.md into non-main agent workspaces during sync', async () => {
    const mainWorkspace = path.join(stateDir, 'workspace-main');
    fs.mkdirSync(mainWorkspace, { recursive: true });
    fs.writeFileSync(path.join(mainWorkspace, 'USER.md'), 'main user profile\n', 'utf8');

    const sync = await createSync({
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'writer',
          name: 'Writer',
          description: '',
          systemPrompt: 'writer soul',
          identity: 'writer identity',
          model: '',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    const result = sync.sync('agent-user-md-isolation');
    expect(result.ok).toBe(true);

    const writerWorkspace = path.join(stateDir, 'workspace-writer');
    expect(fs.readFileSync(path.join(writerWorkspace, 'SOUL.md'), 'utf8')).toBe('writer soul\n');
    expect(fs.readFileSync(path.join(writerWorkspace, 'IDENTITY.md'), 'utf8')).toBe('writer identity\n');
    expect(fs.existsSync(path.join(writerWorkspace, 'USER.md'))).toBe(false);
  });

  test('merges all server models into existing lobsterai provider and updates image input', async () => {
    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.serverModels = [
      {
        modelId: 'qwen3.5-plus-YoudaoInner',
        modelName: 'qwen3.5-plus-YoudaoInner',
        provider: 'YoudaoInner',
        apiFormat: 'openai',
        supportsImage: true,
        explicitContextCache: true,
      },
      {
        modelId: 'qwen3.6-plus-YoudaoInner',
        modelName: 'qwen3.6-plus-YoudaoInner',
        provider: 'YoudaoInner',
        apiFormat: 'openai',
        supportsImage: true,
        explicitContextCache: true,
      },
      {
        modelId: 'claude-sonnet-4-6-YoudaoInner',
        modelName: 'claude-sonnet-4-6-YoudaoInner',
        provider: 'YoudaoInner',
        apiFormat: 'anthropic',
        supportsImage: true,
        supportsThinking: true,
        contextWindow: 1_000_000,
        explicitContextCache: true,
      },
      {
        modelId: 'claude-opus-4-YoudaoInner',
        modelName: 'claude-opus-4-YoudaoInner',
        provider: 'YoudaoInner',
        apiFormat: 'anthropic',
        supportsImage: true,
        supportsThinking: true,
      },
      {
        modelId: 'claude-sonnet-4-6',
        modelName: 'Claude Sonnet 4.6 OpenAI Compat',
        provider: 'YoudaoInner',
        apiFormat: 'openai',
        supportsImage: true,
        supportsThinking: true,
        contextWindow: 1_000_000,
        explicitContextCache: true,
      },
      {
        modelId: 'glm-5.1-YoudaoInner',
        provider: 'YoudaoInner',
        apiFormat: 'openai',
        supportsImage: false,
        supportsThinking: true,
      },
      {
        modelId: 'deepseek-v3.2-YoudaoInner',
        provider: 'YoudaoInner',
        apiFormat: 'openai',
        supportsImage: false,
      },
    ];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://lobsterai-server.youdao.com/api/proxy/v1',
        apiKey: 'access-token',
        model: 'qwen3.5-plus-YoudaoInner',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'lobsterai-server',
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'Qwen3.5 Plus',
      },
    };

    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('server-models-updated');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const provider = config.models.providers['lobsterai-server'];
    expect(provider.baseUrl).toBe('http://127.0.0.1:56646/v1');
    expect(provider.apiKey).toBe('${LOBSTER_PROXY_TOKEN}');
    expect(JSON.stringify(config)).not.toContain('LOBSTER_APIKEY_SERVER');
    expect(provider.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'qwen3.5-plus-YoudaoInner',
        api: 'openai-completions',
        input: ['text', 'image'],
      }),
      expect.objectContaining({
        id: 'qwen3.6-plus-YoudaoInner',
        api: 'openai-completions',
        input: ['text', 'image'],
      }),
      expect.objectContaining({
        id: 'claude-sonnet-4-6-YoudaoInner',
        api: 'anthropic-messages',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({
        id: 'claude-opus-4-YoudaoInner',
        api: 'anthropic-messages',
        input: ['text', 'image'],
        reasoning: true,
      }),
      expect.objectContaining({
        id: 'claude-sonnet-4-6',
        api: 'openai-completions',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({
        id: 'glm-5.1-YoudaoInner',
        api: 'openai-completions',
        input: ['text'],
        reasoning: true,
      }),
      expect.objectContaining({
        id: 'deepseek-v3.2-YoudaoInner',
        api: 'openai-completions',
        input: ['text'],
      }),
    ]));
    expect(provider.models).toHaveLength(7);
    expect(JSON.stringify(provider.models)).not.toContain('cacheControlFormat');
    expect(JSON.stringify(provider.models)).not.toContain('supportsLongCacheRetention');
    expect(config.agents.defaults.models).toEqual(expect.objectContaining({
      'lobsterai-server/qwen3.5-plus-YoudaoInner': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'lobsterai-server/qwen3.6-plus-YoudaoInner': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'lobsterai-server/claude-sonnet-4-6-YoudaoInner': {
        params: {
          cacheRetention: 'short',
        },
      },
      'lobsterai-server/claude-opus-4-YoudaoInner': {
        params: {
          cacheRetention: 'short',
        },
      },
      'lobsterai-server/claude-sonnet-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
        },
      },
    }));
  });

  test('writes Claude OpenAI-compatible explicit cache params when server metadata is not loaded', async () => {
    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.serverModels = [];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://lobsterai-server.youdao.com/api/proxy/v1',
        apiKey: 'access-token',
        model: 'claude-sonnet-4-6',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'lobsterai-server',
        codingPlanEnabled: false,
        supportsImage: true,
        supportsThinking: true,
        modelName: 'Claude Sonnet 4.6',
      },
    };

    const sync = await createSync();

    const result = sync.sync('server-model-cache-default-without-metadata');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers['lobsterai-server'].models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'claude-sonnet-4-6',
        api: 'openai-completions',
      }),
    ]));
    expect(config.agents.defaults.models).toEqual(expect.objectContaining({
      'lobsterai-server/claude-sonnet-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
        },
      },
    }));
  });

  test('writes explicit cache params for Anthropic, Qwen, and custom providers', async () => {
    const { ProviderName } = await import('../../shared/providers');

    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-qwen',
        model: 'qwen3.5-plus',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.Qwen,
        codingPlanEnabled: false,
        supportsImage: true,
        modelName: 'Qwen3.5 Plus',
      },
    };
    mockRuntimeState.enabledProviders = [
      {
        providerName: ProviderName.Qwen,
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-qwen',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
          { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true },
          { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', supportsImage: true },
        ],
      },
      {
        providerName: ProviderName.Anthropic,
        baseURL: 'https://api.anthropic.com',
        apiKey: 'sk-anthropic',
        apiType: 'anthropic',
        codingPlanEnabled: false,
        models: [
          { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, supportsThinking: true },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true, supportsThinking: true },
        ],
      },
      {
        providerName: 'custom_0',
        baseURL: 'https://example.com/v1',
        apiKey: 'sk-custom',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            supportsImage: true,
            customParams: { metadata: 'custom-cache' },
          },
          { id: 'anthropic/claude-sonnet-4-6', name: 'Namespaced Claude Sonnet 4.6', supportsImage: true },
          { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
          { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false },
          { id: 'gpt-5.5-2026-04-24', name: 'GPT 5.5', supportsImage: true },
        ],
      },
    ];

    const sync = await createSync();

    const result = sync.sync('provider-explicit-cache-defaults');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const modelDefaults = config.agents.defaults.models;

    expect(modelDefaults).toEqual(expect.objectContaining({
      'qwen/qwen3.5-plus': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'qwen/qwen3.6-plus': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'qwen/qwen3.7-plus': {},
      'anthropic/claude-opus-4-7': {
        params: {
          cacheRetention: 'short',
        },
      },
      'anthropic/claude-sonnet-4-6': {
        params: {
          cacheRetention: 'short',
        },
      },
      'custom_0/claude-opus-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
          extra_body: {
            metadata: 'custom-cache',
          },
        },
      },
      'custom_0/anthropic/claude-sonnet-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
        },
      },
      'custom_0/qwen3.5-plus': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'custom_0/qwen3.6-plus': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'custom_0/deepseek-v4-pro': {},
      'custom_0/gpt-5.5-2026-04-24': {},
    }));
  });

  test('writes a complete agent model allowlist when any model has custom params', async () => {
    const { ProviderName } = await import('../../shared/providers');

    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.serverModels = [
      { modelId: 'MiniMax-M2.7-YoudaoInner', supportsImage: false },
      { modelId: 'kimi-k2.6-inhouse-ZhiYun', supportsImage: true },
    ];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        model: 'deepseek-v4-flash',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.DeepSeek,
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'DeepSeek V4 Flash',
      },
    };
    mockRuntimeState.enabledProviders = [
      {
        providerName: ProviderName.DeepSeek,
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            supportsImage: false,
            customParams: { reasoning_effort: 'high' },
          },
          {
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            supportsImage: false,
          },
        ],
      },
      {
        providerName: 'custom_0',
        baseURL: 'https://example.com/v1',
        apiKey: 'sk-custom',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          {
            id: 'custom-thinking-model',
            name: 'Custom Thinking Model',
            supportsImage: false,
            supportsThinking: true,
            customParams: { reasoning_effort: 'high' },
          },
        ],
      },
    ];

    const sync = await createSync();

    const result = sync.sync('custom-params-complete-model-allowlist');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers.deepseek.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({
        id: 'deepseek-v4-pro',
        contextWindow: 1_000_000,
      }),
    ]));
    expect(config.models.providers.custom_0.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'custom-thinking-model',
        reasoning: true,
      }),
    ]));
    const modelDefaults = config.agents.defaults.models;

    expect(modelDefaults).toEqual(expect.objectContaining({
      'deepseek/deepseek-v4-flash': {
        params: {
          extra_body: {
            reasoning_effort: 'high',
          },
        },
      },
      'custom_0/custom-thinking-model': {
        params: {
          extra_body: {
            reasoning_effort: 'high',
          },
        },
      },
      'deepseek/deepseek-v4-pro': {},
      'lobsterai-server/MiniMax-M2.7-YoudaoInner': {},
      'lobsterai-server/kimi-k2.6-inhouse-ZhiYun': {},
    }));
    expect(Object.keys(modelDefaults)).toEqual(expect.arrayContaining([
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-pro',
      'custom_0/custom-thinking-model',
      'lobsterai-server/MiniMax-M2.7-YoudaoInner',
      'lobsterai-server/kimi-k2.6-inhouse-ZhiYun',
    ]));
  });

  test('activates deterministic Kimi K3 ownership for exact custom and package models', async () => {
    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'sk-custom',
        model: 'kimi-k3',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'custom_0',
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'Kimi K3',
      },
    };
    mockRuntimeState.enabledProviders = [{
      providerName: 'custom_0',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'sk-custom',
      apiType: 'openai',
      codingPlanEnabled: false,
      models: [
        {
          id: 'plain-model',
          name: 'Plain Model',
          customParams: { temperature: 0.4 },
        },
        {
          id: 'kimi-k3',
          name: 'Kimi K3',
          customParams: {
            metadata: 'kept',
            temperature: 0.1,
            reasoning_effort: 'low',
            thinking: { type: 'disabled' },
          },
        },
      ],
    }];
    mockRuntimeState.serverModels = [
      {
        modelId: 'kimi-k3-package',
        modelName: 'Kimi K3 Package',
        apiFormat: 'openai',
        runtimeProfile: 'moonshot-kimi-k3',
        supportsImage: false,
        supportsVideo: false,
        supportsThinking: false,
        supportsToolCalling: true,
        agenticReady: true,
        contextWindow: 128_000,
        maxTokens: 1024,
      },
    ];

    const sync = await createSync();
    const { OpenClawConfigImpact } = await import('./openclawConfigImpact');
    const firstSync = sync.sync('kimi-k3-compat');
    expect(firstSync).toMatchObject({
      ok: true,
      restartImpact: OpenClawConfigImpact.Restart,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const customProvider = config.models.providers.custom_0;
    const serverProvider = config.models.providers['lobsterai-server'];
    const customK3 = customProvider.models.find((model: { id: string }) =>
      model.id === 'kimi-k3');
    const serverK3 = serverProvider.models.find((model: { id: string }) =>
      model.id === 'kimi-k3-package');

    expect(customProvider.api).toBe('lobsterai-model-compat');
    expect(serverProvider.api).toBe('lobsterai-model-compat');
    expect(customProvider.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plain-model', api: 'openai-completions' }),
      expect.objectContaining({ id: 'kimi-k3', api: 'openai-completions' }),
    ]));
    expect(customK3).toMatchObject({
      reasoning: true,
      input: ['text', 'image', 'video'],
      contextWindow: 1_048_576,
      maxTokens: 8192,
      thinkingLevelMap: {
        off: null,
        minimal: 'max',
        low: 'max',
        medium: 'max',
        high: 'max',
        xhigh: 'max',
        max: 'max',
      },
      compat: {
        maxTokensField: 'max_tokens',
        supportsUsageInStreaming: false,
        requiresStringContent: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    });
    expect(serverK3).toMatchObject({
      api: 'openai-completions',
      reasoning: true,
      input: ['text', 'image', 'video'],
      contextWindow: 1_048_576,
      maxTokens: 8192,
    });
    expect(config.agents.defaults.models['custom_0/kimi-k3']).toEqual({
      params: {
        extra_body: {
          metadata: 'kept',
        },
      },
    });
    expect(config.agents.defaults.models['custom_0/plain-model']).toEqual({
      params: {
        extra_body: {
          temperature: 0.4,
        },
      },
    });
    expect(config.plugins.entries['lobsterai-model-compat']).toEqual({
      enabled: true,
      config: {
        modelProfiles: {
          'custom_0/kimi-k3': 'moonshot-kimi-k3',
          'lobsterai-server/kimi-k3-package': 'moonshot-kimi-k3',
        },
      },
    });
    expect(config.plugins.allow).toContain('lobsterai-model-compat');

    const unchangedSync = sync.sync('kimi-k3-compat-unchanged');
    expect(unchangedSync.ok).toBe(true);
    expect(unchangedSync.restartImpact).toBeUndefined();
    const stableSync = sync.sync('kimi-k3-compat-stable');
    expect(stableSync.changed).toBe(false);
    expect(stableSync.restartImpact).toBeUndefined();
  });

  test('restarts only when Kimi K3 compatibility ownership or profile mapping changes', async () => {
    const { modelCompatConfigChangeRequiresRestart } = await import('./openclawConfigSync');
    const ordinaryConfig = {
      models: {
        providers: {
          custom_0: {
            api: 'openai-completions',
          },
        },
      },
      plugins: {
        entries: {},
      },
    };
    const compatConfig = {
      models: {
        providers: {
          custom_0: {
            api: 'lobsterai-model-compat',
            models: [{ id: 'plain-model', api: 'openai-completions' }],
          },
        },
      },
      plugins: {
        entries: {
          'lobsterai-model-compat': {
            enabled: true,
            config: {
              modelProfiles: {
                'custom_0/my-kimi-prod': 'moonshot-kimi-k3',
              },
            },
          },
        },
      },
    };

    expect(modelCompatConfigChangeRequiresRestart(ordinaryConfig, compatConfig)).toBe(true);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, ordinaryConfig)).toBe(true);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, {
      ...compatConfig,
      plugins: {
        entries: {
          'lobsterai-model-compat': {
            enabled: true,
            config: {
              modelProfiles: {
                'custom_0/next-kimi': 'moonshot-kimi-k3',
              },
            },
          },
        },
      },
    })).toBe(true);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, {
      ...compatConfig,
      models: {
        providers: {
          custom_0: {
            api: 'lobsterai-model-compat',
            models: [
              { id: 'another-plain-model', api: 'openai-completions' },
              { id: 'plain-model', api: 'openai-completions' },
            ],
          },
        },
      },
    })).toBe(false);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, {
      ...compatConfig,
      plugins: {
        entries: {
          'lobsterai-model-compat': {
            enabled: true,
            config: {
              modelProfiles: compatConfig.plugins.entries['lobsterai-model-compat'].config.modelProfiles,
              thinkingProfiles: {
                'lobsterai-server/deepseek-v4-flash': {
                  options: [
                    { level: 'off', openclawLevel: 'off' },
                    { level: 'high', openclawLevel: 'high' },
                    { level: 'max', openclawLevel: 'xhigh' },
                  ],
                  defaultLevel: 'high',
                },
              },
            },
          },
        },
      },
    })).toBe(true);
  });

  test('assigns mixed-provider compatibility ownership independently of model order', async () => {
    const { finalizeModelCompatibilityOwners } = await import('./openclawConfigSync');
    const buildProviders = (modelIds: string[]) => ({
      custom_0: {
        baseUrl: 'https://gateway.example.com/v1',
        api: 'openai-completions',
        apiKey: '${LOBSTER_APIKEY_CUSTOM_0}',
        auth: 'api_key',
        models: modelIds.map(id => ({
          id,
          name: id,
          api: 'openai-completions',
          input: ['text'],
        })),
      },
    });
    const modelProfiles = {
      'custom_0/my-kimi-prod': 'moonshot-kimi-k3',
    };
    const forward = buildProviders(['plain-model', 'my-kimi-prod']);
    const reverse = buildProviders(['my-kimi-prod', 'plain-model']);

    const forwardResult = finalizeModelCompatibilityOwners(forward as never, modelProfiles);
    const reverseResult = finalizeModelCompatibilityOwners(reverse as never, modelProfiles);

    expect(forwardResult).toEqual(reverseResult);
    expect(forwardResult).toEqual({
      modelProfiles,
      rejectedModelRefs: [],
    });
    for (const providers of [forward, reverse]) {
      expect(providers.custom_0.api).toBe('lobsterai-model-compat');
      expect(Object.fromEntries(
        providers.custom_0.models.map(model => [model.id, model.api]),
      )).toEqual({
        'plain-model': 'openai-completions',
        'my-kimi-prod': 'openai-completions',
      });
    }
  });

  test.each([
    [undefined, 'missing'],
    ['unknown', 'unknown'],
    ['anthropic', 'anthropic'],
  ])(
    'fails closed for Kimi K3 package apiFormat %s',
    async (apiFormat, expectedFormat) => {
      mockRuntimeState.serverModels = [{
        modelId: `package-k3-${expectedFormat}`,
        apiFormat,
        runtimeProfile: 'moonshot-kimi-k3',
      }];

      const sync = await createSync();
      const result = sync.sync(`kimi-k3-package-${expectedFormat}`);

      expect(result).toMatchObject({
        ok: false,
        changed: false,
      });
      expect(result.error).toContain('require apiFormat "openai"');
      expect(result.error).toContain(`package-k3-${expectedFormat} (${expectedFormat})`);
      expect(fs.existsSync(configPath)).toBe(false);
    },
  );

  test('preserves the legacy OpenAI fallback for ordinary package models without apiFormat', async () => {
    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.serverModels = [{
      modelId: 'ordinary-package-model',
      modelName: 'Ordinary Package Model',
    }];

    const sync = await createSync();
    expect(sync.sync('ordinary-package-api-fallback')).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers['lobsterai-server'].models).toContainEqual(
      expect.objectContaining({
        id: 'ordinary-package-model',
        api: 'openai-completions',
      }),
    );
  });

  test('writes server thinking profiles without taking over the provider transport', async () => {
    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.serverModels = [{
      modelId: 'deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      apiFormat: 'openai',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      requestCapabilities: ['lobsterai-options-v1'],
    }];

    const sync = await createSync();
    expect(sync.sync('server-thinking-profile')).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers['lobsterai-server'].api).toBe('openai-completions');
    expect(config.models.providers['lobsterai-server'].models[0]).toEqual(
      expect.objectContaining({
        thinkingLevelMap: {
          off: 'off',
          minimal: null,
          low: null,
          medium: null,
          high: 'high',
          xhigh: 'xhigh',
        },
        compat: expect.objectContaining({
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ['high', 'xhigh'],
        }),
      }),
    );
    expect(config.plugins.entries['lobsterai-model-compat']).toEqual({
      enabled: true,
      config: {
        thinkingProfiles: {
          'lobsterai-server/deepseek-v4-flash': {
            options: [
              { level: 'off', openclawLevel: 'off' },
              { level: 'high', openclawLevel: 'high' },
              { level: 'max', openclawLevel: 'xhigh' },
            ],
            defaultLevel: 'high',
            requestOptionsVersion: 1,
          },
        },
      },
    });
    expect(config.plugins.allow).toContain('lobsterai-model-compat');
  });

  test('keeps legacy thinking transport when the server does not advertise request options', async () => {
    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.serverModels = [{
      modelId: 'deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      apiFormat: 'openai',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
    }];

    const sync = await createSync();
    expect(sync.sync('legacy-server-thinking-profile')).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(
      config.plugins.entries['lobsterai-model-compat']
        .config.thinkingProfiles['lobsterai-server/deepseek-v4-flash'],
    ).toEqual({
      options: [
        { level: 'off', openclawLevel: 'off' },
        { level: 'high', openclawLevel: 'high' },
        { level: 'max', openclawLevel: 'xhigh' },
      ],
      defaultLevel: 'high',
    });
  });

  test('fails closed when the Kimi K3 compatibility extension is unavailable', async () => {
    mockRuntimeState.modelCompatPluginAvailable = false;
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'sk-custom',
        model: 'kimi-k3',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'custom_0',
        codingPlanEnabled: false,
      },
    };
    mockRuntimeState.enabledProviders = [{
      providerName: 'custom_0',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'sk-custom',
      apiType: 'openai',
      codingPlanEnabled: false,
      models: [{ id: 'kimi-k3', name: 'Kimi K3' }],
    }];

    const sync = await createSync();
    const result = sync.sync('kimi-k3-plugin-missing');

    expect(result).toMatchObject({
      ok: false,
      changed: false,
    });
    expect(result.error).toContain('lobsterai-model-compat');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test('rejects compatibility ownership when the configured model ref is absent', async () => {
    const { finalizeModelCompatibilityOwners } = await import('./openclawConfigSync');
    const providers = {
      custom_0: {
        baseUrl: 'https://gateway.example.com/v1',
        api: 'openai-completions',
        apiKey: '${LOBSTER_APIKEY_CUSTOM_0}',
        auth: 'api_key',
        models: [{
          id: 'plain-model',
          name: 'Plain Model',
          api: 'openai-completions',
          input: ['text'],
        }],
      },
    };

    const result = finalizeModelCompatibilityOwners(providers as never, {
      'custom_0/missing-kimi': 'moonshot-kimi-k3',
    });

    expect(result).toEqual({
      modelProfiles: {},
      rejectedModelRefs: ['custom_0/missing-kimi'],
    });
    expect(providers.custom_0.api).toBe('openai-completions');
  });

  test('removes stale agent model allowlist when no model has custom params', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          models: {
            'lobsterai-server/MiniMax-M2.7-YoudaoInner': {},
          },
        },
      },
    }, null, 2));

    const sync = await createSync();

    const result = sync.sync('remove-stale-model-allowlist');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.models).toBeUndefined();
  });

  test('enables media generation plugin when media entitlement is available', async () => {
    const sync = await createSync({
      canUseMediaGeneration: () => true,
      getMediaCallbackUrl: () => 'http://127.0.0.1:5175/media-callback',
    });

    const result = sync.sync('media-entitlement-enabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['lobster-media-generation']).toEqual({
      enabled: true,
      config: {
        callbackUrl: 'http://127.0.0.1:5175/media-callback',
        secret: '${LOBSTER_MCP_BRIDGE_SECRET}',
        requestTimeoutMs: 150000,
      },
    });
    expect(config.tools.deny).not.toContain('image_generate');
    expect(config.tools.deny).not.toContain('video_generate');
  });

  test('keeps media generation plugin configured without media entitlement', async () => {
    const sync = await createSync({
      canUseMediaGeneration: () => false,
      getMediaCallbackUrl: () => 'http://127.0.0.1:5175/media-callback',
    });

    const result = sync.sync('media-entitlement-disabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['lobster-media-generation']).toEqual({
      enabled: true,
      config: {
        callbackUrl: 'http://127.0.0.1:5175/media-callback',
        secret: '${LOBSTER_MCP_BRIDGE_SECRET}',
        requestTimeoutMs: 150000,
      },
    });
    expect(config.tools.deny).not.toContain('image_generate');
    expect(config.tools.deny).not.toContain('video_generate');
  });

  test('declares and allowlists the bundled xai plugin so its compat hooks load', async () => {
    const sync = await createSync();

    const result = sync.sync('xai-plugin-declared');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries.xai).toEqual({ enabled: true });
    // plugins.allow is a strict allowlist once non-empty — without this entry
    // the xai plugin never loads and grok models lose their reasoningEffort
    // compat (xAI rejects the parameter for every model except grok-4.3).
    expect(config.plugins.allow).toContain('xai');
  });

  test('keeps memory-core selected and explicitly disables dreaming when dreaming is off', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'memory-core': {
            enabled: true,
            config: {
              retention: {
                shortTermDays: 14,
              },
              dreaming: {
                enabled: true,
                frequency: '0 3 * * *',
              },
            },
          },
        },
      },
    }, null, 2));

    const sync = await createSync({
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        dreamingEnabled: false,
        dreamingFrequency: '0 3 * * *',
      }),
    });

    const result = sync.sync('dreaming-disabled-cleanup');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.slots.memory).toBe('memory-core');
    expect(config.plugins.allow).toContain('memory-core');
    expect(config.plugins.entries['memory-core']).toEqual({
      enabled: true,
      config: {
        retention: {
          shortTermDays: 14,
        },
        dreaming: {
          enabled: false,
        },
      },
    });
  });

  test('writes enabled memory-core dreaming config when dreaming is on', async () => {
    const sync = await createSync({
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        dreamingEnabled: true,
        dreamingFrequency: '0 4 * * *',
      }),
    });

    const result = sync.sync('dreaming-enabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.slots.memory).toBe('memory-core');
    expect(config.plugins.allow).toContain('memory-core');
    expect(config.plugins.entries['memory-core']).toEqual({
      enabled: true,
      config: {
        dreaming: {
          enabled: true,
          frequency: '0 4 * * *',
        },
      },
    });
  });

  test('maps OpenAI OAuth mode to the ChatGPT Responses provider', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://api.openai.com/v1',
      modelId: 'gpt-5.4',
      apiType: 'openai',
      providerName: ProviderName.OpenAI,
      authType: 'oauth',
      codingPlanEnabled: false,
      supportsImage: true,
      modelName: 'GPT-5.4',
    });

    expect(selection.providerId).toBe(OpenClawProviderId.OpenAI);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.OpenAI}/gpt-5.4`);
    expect(selection.providerConfig.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAIChatGPTResponses);
    expect(selection.providerConfig.auth).toBe(AuthType.OAuth);
    expect(selection.providerConfig).not.toHaveProperty('headers');
    expect(selection.providerConfig).not.toHaveProperty('apiKey');
  });

  test('maps MiniMax OAuth mode to the MiniMax portal provider', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'oauth-token',
      baseURL: 'https://api.minimaxi.com/anthropic',
      modelId: 'MiniMax-M3',
      apiType: 'anthropic',
      providerName: ProviderName.Minimax,
      authType: 'oauth',
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      modelName: 'MiniMax M3',
    });

    expect(selection.providerId).toBe(OpenClawProviderId.MinimaxPortal);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.MinimaxPortal}/MiniMax-M3`);
    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.auth).toBe(AuthType.OAuth);
    expect(selection.providerConfig.apiKey).toBe('${LOBSTER_APIKEY_MINIMAX}');
    expect(selection.providerConfig.models[0].maxTokens).toBe(131_072);
  });

  test('maps xAI OAuth mode to the xai provider without an apiKey', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://api.x.ai/v1',
      modelId: 'grok-4.3',
      apiType: 'openai',
      providerName: ProviderName.Xai,
      authType: 'oauth',
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      modelName: 'Grok 4.3',
    });

    expect(selection.providerId).toBe(OpenClawProviderId.Xai);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.Xai}/grok-4.3`);
    expect(selection.providerConfig.baseUrl).toBe('https://api.x.ai/v1');
    expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAIResponses);
    expect(selection.providerConfig.auth).toBe(AuthType.OAuth);
    expect(selection.providerConfig).not.toHaveProperty('apiKey');
  });

  test('keeps xAI API key mode on the env-var placeholder', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'xai-key',
      baseURL: 'https://api.x.ai/v1',
      modelId: 'grok-4.3',
      apiType: 'openai',
      providerName: ProviderName.Xai,
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: true,
      modelName: 'Grok 4.3',
    });

    expect(selection.providerId).toBe(OpenClawProviderId.Xai);
    expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAIResponses);
    expect(selection.providerConfig.auth).toBe(AuthType.ApiKey);
    expect(selection.providerConfig.apiKey).toBe('${LOBSTER_APIKEY_XAI}');
  });

  test.each([
    [ProviderName.OpenAI, 'gpt-5.6-sol', 'https://api.openai.com/v1', 1_050_000],
    [ProviderName.OpenAI, 'gpt-5.6-terra', 'https://api.openai.com/v1', 1_050_000],
    [ProviderName.OpenAI, 'gpt-5.6-luna', 'https://api.openai.com/v1', 1_050_000],
    [ProviderName.Xai, 'grok-4.5', 'https://api.x.ai/v1', 500_000],
  ])('writes official context metadata for %s/%s', async (providerName, modelId, baseURL, contextWindow) => {
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'test-key',
      baseURL,
      modelId,
      apiType: 'openai',
      providerName,
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: false,
      supportsThinking: false,
      modelName: modelId,
    });

    expect(selection.providerConfig.models[0]).toMatchObject({
      id: modelId,
      input: ['text', 'image'],
      reasoning: true,
      contextWindow,
    });
  });

  test('keeps MiniMax API key mode on the standard MiniMax provider', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'sk-minimax',
      baseURL: 'https://api.minimaxi.com/anthropic',
      modelId: 'MiniMax-M2.7',
      apiType: 'anthropic',
      providerName: ProviderName.Minimax,
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'MiniMax M2.7',
    });

    expect(selection.providerId).toBe(OpenClawProviderId.Minimax);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.Minimax}/MiniMax-M2.7`);
    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.auth).toBe(AuthType.ApiKey);
    expect(selection.providerConfig.models[0].contextWindow).toBe(204_800);
    expect(selection.providerConfig.models[0].maxTokens).toBe(131_072);
  });

  test('resolves OpenClaw catalog maxTokens by provider and model id', async () => {
    const { resolveOpenClawCatalogModelMaxTokens } = await import('./openclawModelCatalog');

    expect(resolveOpenClawCatalogModelMaxTokens('minimax', 'MiniMax-M3')).toBe(131_072);
    expect(resolveOpenClawCatalogModelMaxTokens('minimax-portal', 'MiniMax-M3')).toBe(131_072);
    expect(resolveOpenClawCatalogModelMaxTokens('anthropic', 'claude-sonnet-4-6')).toBe(64_000);
    expect(resolveOpenClawCatalogModelMaxTokens('custom_0', 'MiniMax-M3')).toBeUndefined();
  });

  test('writes OpenClaw default maxTokens for unknown Anthropic-format custom providers', async () => {
    const { OpenClawApi } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'sk-custom',
      baseURL: 'https://api.example.com/anthropic',
      modelId: 'custom-claude-compatible',
      apiType: 'anthropic',
      providerName: 'custom_0',
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'Custom Claude Compatible',
      contextWindow: 1_000_000,
    });

    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.models[0].contextWindow).toBe(1_000_000);
    expect(selection.providerConfig.models[0].maxTokens).toBe(8192);
  });

  test('does not use OpenClaw catalog maxTokens when custom provider id does not match', async () => {
    const { OpenClawApi } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'sk-custom',
      baseURL: 'https://api.example.com/anthropic',
      modelId: 'MiniMax-M3',
      apiType: 'anthropic',
      providerName: 'custom_0',
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      modelName: 'MiniMax M3',
    });

    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.models[0].contextWindow).toBe(1_000_000);
    expect(selection.providerConfig.models[0].maxTokens).toBe(8192);
  });

  test('repairs stale image capability for known Qwen models before writing OpenClaw input', async () => {
    const { OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const qwenSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelId: 'qwen3.6-plus',
      apiType: 'openai',
      providerName: ProviderName.Qwen,
      codingPlanEnabled: true,
      supportsImage: false,
      modelName: 'qwen3.6-plus',
    });
    expect(qwenSelection.providerId).toBe(OpenClawProviderId.Qwen);
    expect(qwenSelection.primaryModel).toBe(`${OpenClawProviderId.Qwen}/qwen3.6-plus`);
    expect(qwenSelection.providerId).not.toBe('qwen-portal');
    expect(qwenSelection.providerId).not.toBe('qwen-oauth');
    expect(qwenSelection.providerConfig.models[0].input).toEqual(['text', 'image']);

    const customSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://example.com/v1',
      modelId: 'qwen3.6-plus',
      apiType: 'openai',
      providerName: 'custom_0',
      supportsImage: false,
      modelName: 'qwen3.6-plus',
    });
    expect(customSelection.providerId).toBe('custom_0');
    expect(customSelection.primaryModel).toBe('custom_0/qwen3.6-plus');
    expect(customSelection.providerConfig.models[0].input).toEqual(['text', 'image']);
  });

  test('marks DeepSeek, Xiaomi, and known GLM models as reasoning-capable', async () => {
    const { OpenClawApi, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const deepseekSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
      modelId: 'deepseek-v4-pro',
      apiType: 'openai',
      providerName: ProviderName.DeepSeek,
      supportsImage: false,
      modelName: 'DeepSeek V4 Pro',
    });
    expect(deepseekSelection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(deepseekSelection.providerConfig.models[0].reasoning).toBe(true);

    const xiaomiSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.xiaomimimo.com/v1/chat/completions',
      modelId: 'mimo-any-model',
      apiType: 'openai',
      providerName: ProviderName.Xiaomi,
      supportsImage: false,
      modelName: 'MiMo Any Model',
    });
    expect(xiaomiSelection.providerConfig.baseUrl).toBe('https://api.xiaomimimo.com/v1');
    expect(xiaomiSelection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(xiaomiSelection.providerConfig.models[0].reasoning).toBe(true);

    const zhipuGlmSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      modelId: 'glm-5.1',
      apiType: 'openai',
      providerName: ProviderName.Zhipu,
      supportsImage: false,
      modelName: 'GLM 5.1',
    });
    expect(zhipuGlmSelection.providerId).toBe('zai');
    expect(zhipuGlmSelection.providerConfig.models[0].reasoning).toBe(true);

    const qianfanGlmSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://qianfan.baidubce.com/v2',
      modelId: 'glm-5.1',
      apiType: 'openai',
      providerName: ProviderName.Qianfan,
      supportsImage: false,
      modelName: 'GLM 5.1',
    });
    expect(qianfanGlmSelection.providerId).toBe('qianfan');
    expect(qianfanGlmSelection.providerConfig.models[0].reasoning).toBe(true);

    const openAiSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      modelId: 'gpt-5.5',
      apiType: 'openai',
      providerName: ProviderName.OpenAI,
      supportsImage: true,
      modelName: 'GPT-5.5',
    });
    expect(openAiSelection.providerConfig.models[0].reasoning).toBe(true);

    const anthropicSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.anthropic.com',
      modelId: 'claude-opus-4-7',
      apiType: 'anthropic',
      providerName: ProviderName.Anthropic,
      supportsImage: true,
      modelName: 'Claude Opus 4.7',
    });
    expect(anthropicSelection.providerConfig.models[0].reasoning).toBe(true);

    const geminiSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-3.1-flash-lite',
      apiType: undefined,
      providerName: ProviderName.Gemini,
      supportsImage: true,
      modelName: 'Gemini 3.1 Flash Lite',
    });
    expect(geminiSelection.providerConfig.models[0].reasoning).toBe(true);

    const customSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://example.com/v1',
      modelId: 'custom-thinking-model',
      apiType: 'openai',
      providerName: 'custom_0',
      supportsImage: false,
      supportsThinking: true,
      modelName: 'Custom Thinking Model',
    });
    expect(customSelection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(customSelection.providerConfig.models[0].reasoning).toBe(true);

    const customParamsOnlySelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://example.com/v1',
      modelId: 'custom-thinking-model',
      apiType: 'openai',
      providerName: 'custom_0',
      supportsImage: false,
      modelName: 'Custom Params Only Model',
    });
    expect(customParamsOnlySelection.providerConfig.models[0].reasoning).toBeUndefined();
  });

  test('writes Telegram streaming in the nested schema expected by current OpenClaw', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [{
        enabled: true,
        botToken: 'tg-token',
        instanceId: 'tg-inst-001',
        instanceName: 'Test Telegram',
        dmPolicy: 'open',
        allowFrom: ['*'],
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
      }],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('test');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const accounts = config.channels.telegram.accounts;
    const accountKey = Object.keys(accounts)[0];
    expect(accounts[accountKey].streaming).toEqual({ mode: 'off' });
  });

  test('does not inject unsupported _agentBinding channel metadata and requests restart when bindings change', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const baseDeps = {
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [{
        enabled: true,
        clientId: 'ding-client-id',
        clientSecret: 'ding-secret',
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'open',
        sessionTimeout: 0,
        separateSessionByConversation: false,
        groupSessionScope: 'group',
        sharedMemoryAcrossConversations: false,
        gatewayBaseUrl: '',
        debug: false,
        instanceId: 'b8a32c47-c852-4ad2-bbfa-631797fc56ea',
        instanceName: 'DingTalk Bot 1',
      }],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getSkillsList: () => [],
      getAgents: () => [{
        id: 'worker-agent',
        enabled: true,
        name: 'Worker Agent',
        prompt: '',
        model: 'openai/gpt-test',
        source: 'user',
      }],
    };

    let currentBindings: Record<string, string> = {};
    const sync = new OpenClawConfigSync({
      ...baseDeps,
      getIMSettings: () => ({
        platformAgentBindings: currentBindings,
      }),
    } as never);

    expect(sync.sync('baseline').ok).toBe(true);

    currentBindings = {
      'dingtalk:b8a32c47-c852-4ad2-bbfa-631797fc56ea': 'worker-agent',
    };
    const result = sync.sync('binding-changed');

    expect(result.ok).toBe(true);
    expect(result.bindingsChanged).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels['dingtalk-connector']).not.toHaveProperty('_agentBinding');
    expect(config.channels).not.toHaveProperty('dingtalk');
    expect(config.bindings).toEqual([
      {
        agentId: 'worker-agent',
        match: {
          channel: 'dingtalk-connector',
          accountId: 'b8a32c47',
        },
      },
    ]);
  });

  test('writes platform-level agent bindings with account wildcard and keeps instance bindings exact', async () => {
    const {
      OpenClawConfigSync,
      OPENCLAW_BINDING_ANY_ACCOUNT_ID,
    } = await import('./openclawConfigSync');

    const dingTalkInstance = {
      enabled: true,
      clientId: 'ding-client-id',
      clientSecret: 'ding-secret',
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'open',
      sessionTimeout: 0,
      separateSessionByConversation: false,
      groupSessionScope: 'group',
      sharedMemoryAcrossConversations: false,
      gatewayBaseUrl: '',
      debug: false,
      instanceId: 'b8a32c47-c852-4ad2-bbfa-631797fc56ea',
      instanceName: 'DingTalk Bot 1',
    };

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [dingTalkInstance],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => ({
        enabled: true,
        accountId: '97a130e3b62f@im.bot',
        dmPolicy: 'open',
        allowFrom: [],
        debug: false,
      }),
      getIMSettings: () => ({
        platformAgentBindings: {
          'dingtalk:b8a32c47-c852-4ad2-bbfa-631797fc56ea': 'instance-agent',
          dingtalk: 'platform-agent',
          weixin: 'weixin-agent',
        },
      }),
      getSkillsList: () => [],
      getAgents: () => [
        {
          id: 'instance-agent',
          enabled: true,
          name: 'Instance Agent',
          prompt: '',
          model: 'openai/gpt-test',
          source: 'user',
        },
        {
          id: 'platform-agent',
          enabled: true,
          name: 'Platform Agent',
          prompt: '',
          model: 'openai/gpt-test',
          source: 'user',
        },
        {
          id: 'weixin-agent',
          enabled: true,
          name: 'Weixin Agent',
          prompt: '',
          model: 'openai/gpt-test',
          source: 'user',
        },
      ],
    } as never);

    const result = sync.sync('platform-binding-wildcard');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.bindings).toEqual([
      {
        agentId: 'instance-agent',
        match: {
          channel: 'dingtalk-connector',
          accountId: 'b8a32c47',
        },
      },
      {
        agentId: 'platform-agent',
        match: {
          channel: 'dingtalk-connector',
          accountId: OPENCLAW_BINDING_ANY_ACCOUNT_ID,
        },
      },
      {
        agentId: 'weixin-agent',
        match: {
          channel: 'openclaw-weixin',
          accountId: OPENCLAW_BINDING_ANY_ACCOUNT_ID,
        },
      },
    ]);
  });

  test('prefers external lark for feishu without stale feishu entry and keeps bundled qqbot entry', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          feishu: { enabled: false },
          'openclaw-qqbot': { enabled: false },
          qqbot: { enabled: false },
        },
      },
    }, null, 2));

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [{
        enabled: true,
        appId: 'cli_feishu_app',
        appSecret: 'secret',
        instanceId: 'feishu-instance-1',
        instanceName: 'Feishu Bot 1',
        domain: 'feishu',
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'allowlist',
        groupAllowFrom: [],
        groups: { '*': { requireMention: true } },
        historyLimit: 50,
        streaming: true,
        replyMode: 'auto',
        blockStreaming: false,
        mediaMaxMb: 30,
      }],
      getQQInstances: () => [{
        enabled: true,
        appId: 'qq-app-id',
        clientSecret: 'qq-secret',
        instanceId: 'qq-instance-1',
        instanceName: 'QQ Bot 1',
        allowFrom: ['*'],
        dmPolicy: 'open',
        markdownSupport: true,
      }],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    const result = sync.sync('feishu-lark-qqbot');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['openclaw-lark']).toEqual({ enabled: true });
    expect(config.plugins.entries).not.toHaveProperty('feishu');
    expect(config.plugins.entries.qqbot).toEqual({ enabled: true });
    expect(config.plugins.entries.discord).toEqual({ enabled: false });
    expect(config.plugins.entries.browser).toEqual({ enabled: true });
    expect(config.plugins.entries).not.toHaveProperty('openclaw-qqbot');
    expect(config.plugins.allow).toContain('browser');
    expect(config.plugins.allow).toContain('qqbot');
    expect(config.plugins.allow).toContain('discord');
  });

  test('writes plugin entries using manifest ids and removes stale package ids', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'clawemail-email': { enabled: true },
          'openclaw-nim-channel': { enabled: true },
        },
      },
    }, null, 2));

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getEmailOpenClawConfig: () => ({
        instances: [{
          instanceId: 'email-work',
          instanceName: 'Work Email',
          enabled: true,
          transport: 'ws',
          email: 'user@example.com',
          apiKey: 'ck_test',
          agentId: 'main',
        }],
      }),
      getNimInstances: () => [{
        instanceId: 'nim-work',
        instanceName: 'NIM Work',
        enabled: true,
        appKey: 'nim-app-key',
        account: 'nim-account',
        token: 'nim-token',
      }],
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    const result = sync.sync('manifest-plugin-ids');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries).not.toHaveProperty('clawemail-email');
    expect(config.plugins.entries).not.toHaveProperty('openclaw-nim-channel');
    expect(config.plugins.entries.email).toEqual({ enabled: true });
    expect(config.plugins.entries['nimsuite-openclaw-nim-channel']).toEqual({ enabled: true });
  });

  test('writes NIM env vars with the same indexes as enabled channel accounts', async () => {
    const sync = await createSync({
      getNimInstances: () => [
        {
          instanceId: 'nim-disabled',
          instanceName: 'NIM Disabled',
          enabled: false,
          appKey: 'disabled-app',
          account: 'disabled-account',
          token: 'disabled-token',
        },
        {
          instanceId: 'nim-packed',
          instanceName: 'NIM Packed',
          enabled: true,
          nimToken: 'packed-app|packed-account|packed-token',
        },
        {
          instanceId: 'nim-work',
          instanceName: 'NIM Work',
          enabled: true,
          appKey: 'work-app',
          account: 'work-account',
          token: 'work-token',
        },
      ],
    });

    const result = sync.sync('nim-secret-env-indexes');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels.nim.accounts).not.toHaveProperty('nim-disa');
    expect(config.channels.nim.accounts['nim-pack'].nimToken).toBe(
      'packed-app|packed-account|packed-token',
    );
    expect(config.channels.nim.accounts['nim-work'].nimToken).toBe(
      'work-app|work-account|${LOBSTER_NIM_TOKEN_1}',
    );

    const env = sync.collectSecretEnvVars();
    expect(env).not.toHaveProperty('LOBSTER_NIM_TOKEN');
    expect(env.LOBSTER_NIM_TOKEN_1).toBe('work-token');
  });

  test('writes weixin channel config using dmPolicy and allowFrom instead of unsupported accountId', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => ({
        enabled: true,
        accountId: '97a130e3b62f@im.bot',
        dmPolicy: 'open',
        allowFrom: [],
        debug: false,
      }),
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('weixin-schema');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels['openclaw-weixin']).toEqual({
      enabled: true,
      dmPolicy: 'open',
      allowFrom: ['*'],
    });
    expect(config.channels['openclaw-weixin']).not.toHaveProperty('accountId');
  });

  test('writes managed browser policy forcing host target', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getPopoInstances: () => [],
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    const result = sync.sync('browser-policy');
    expect(result.ok).toBe(true);

    const agentsMdPath = path.join(stateDir, 'workspace-main', 'AGENTS.md');
    const agentsMd = fs.readFileSync(agentsMdPath, 'utf8');
    expect(agentsMd).toContain('LobsterAI does not support sandbox browser execution in this version.');
    expect(agentsMd).toContain('For every `browser` tool call, set `target="host"` explicitly.');
  });

  test('enables managed OpenClaw tool loop detection', async () => {
    const sync = await createSync();

    const result = sync.sync('tool-loop-detection');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tools.loopDetection).toEqual({
      enabled: true,
      historySize: 48,
      warningThreshold: 6,
      unknownToolThreshold: 6,
      criticalThreshold: 10,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: false,
        pingPong: true,
      },
    });
  });

  test('writes browser and web fetch access settings', async () => {
    const { setSystemProxyEnabled } = await import('./systemProxy');
    const {
      BrowserNetworkMode,
      BrowserProfileMode,
      BrowserRuntimeProfile,
      BrowserSnapshotMode,
    } = await import('../../shared/browserWebAccess/constants');
    const { OpenClawConfigSync } = await import('./openclawConfigSync');
    setSystemProxyEnabled(true);

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      getBrowserWebAccessConfig: () => ({
        browserEnabled: true,
        profileMode: BrowserProfileMode.User,
        networkMode: BrowserNetworkMode.Strict,
        followGlobalProxy: true,
        allowedHostnames: ['https://Localhost:8443/path'],
        blockedHostnames: ['https://www.baidu.com/search'],
        snapshotMode: BrowserSnapshotMode.Efficient,
        evaluateEnabled: false,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        cdpUrl: 'http://127.0.0.1:9222',
        attachOnly: true,
        remoteCdpTimeoutMs: 1500,
        remoteCdpHandshakeTimeoutMs: 3000,
        extraArgs: ['--disable-infobars'],
        webFetch: {
          enabled: true,
          followGlobalProxy: true,
          timeoutSeconds: 25,
          maxRedirects: 4,
          maxChars: 12000,
          userAgent: 'LobsterAI Test',
          readability: false,
          allowRfc2544BenchmarkRange: true,
        },
      }),
      isEnterprise: () => false,
      getPopoInstances: () => [],
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local' },
      tools: {
        web: {
          fetch: {
            enabled: true,
            useEnvProxy: true,
            useTrustedEnvProxy: true,
          },
        },
      },
    }, null, 2));

    const result = sync.sync('browser-web-access');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser).toMatchObject({
      enabled: true,
      defaultProfile: BrowserRuntimeProfile.Managed,
      evaluateEnabled: false,
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ['localhost'],
        hostnameAllowlist: ['localhost'],
        blockedHostnames: ['www.baidu.com'],
      },
    });
    expect(config.browser.cdpUrl).toBeUndefined();
    expect(config.browser.executablePath).toBeUndefined();
    expect(config.browser.attachOnly).toBeUndefined();
    expect(config.browser.remoteCdpTimeoutMs).toBeUndefined();
    expect(config.browser.remoteCdpHandshakeTimeoutMs).toBeUndefined();
    expect(config.browser.extraArgs).toBeUndefined();
    expect(config.browser.snapshotDefaults).toBeUndefined();
    expect(config.tools.web.fetch).toMatchObject({
      enabled: true,
      readability: false,
      timeoutSeconds: 25,
      maxRedirects: 4,
      maxChars: 12000,
      userAgent: 'LobsterAI Test',
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    expect(config.tools.web.fetch.useEnvProxy).toBeUndefined();
    expect(config.tools.web.fetch.useTrustedEnvProxy).toBeUndefined();
  });

  test('marks MCP server config changes as restart impact', async () => {
    const { OpenClawConfigImpact } = await import('./openclawConfigImpact');
    const sync = await createSync({
      getResolvedMcpServers: () => [{
        name: 'Tavily',
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { TAVILY_API_KEY: '${LOBSTER_TAVILY_API_KEY}' },
      }],
    });

    const result = sync.sync('mcp-server-toggled');

    expect(result.ok).toBe(true);
    expect(result.changedTopLevelKeys).toContain('mcp');
    expect(result.restartImpact).toBe(OpenClawConfigImpact.Restart);
  });

  test('writes all remote MCP headers to openclaw config', async () => {
    const sync = await createSync({
      getResolvedMcpServers: () => [{
        name: 'Remote MCP',
        transportType: 'http',
        url: 'https://mcp.example.com/stream',
        headers: {
          Authorization: 'Bearer test-token',
          'X-Tenant-Id': 'tenant-123',
          'X-Client-Id': 'client-456',
        },
      }],
    });

    const result = sync.sync('mcp-server-updated');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcp.servers['Remote MCP']).toMatchObject({
      url: 'https://mcp.example.com/stream',
      transport: 'streamable-http',
      headers: {
        authorization: 'Bearer test-token',
        'x-tenant-id': 'tenant-123',
        'x-client-id': 'client-456',
      },
    });
  });

  test('skips invalid stdio MCP servers while keeping valid ones', async () => {
    const sync = await createSync({
      getResolvedMcpServers: () => [
        {
          name: 'Evil',
          transportType: 'stdio',
          command: 'npx -y evil',
          args: [],
        },
        {
          name: 'Tavily',
          transportType: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      ],
    });

    const result = sync.sync('mcp-server-updated');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcp.servers.Tavily).toMatchObject({
      command: 'node',
      args: ['server.js'],
    });
    expect(config.mcp.servers.Evil).toBeUndefined();
  });
});

describe('resolveModelSourceForOpenClawProvider', () => {
  beforeEach(() => {
    mockRuntimeState.providerSourceEntries = [];
  });

  test('classifies the LobsterAI plan without any Settings entry', async () => {
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    expect(resolveModelSourceForOpenClawProvider('lobsterai-server')).toEqual({
      source: 'lobsterai-plan',
      providerName: ProviderName.LobsteraiServer,
    });
  });

  test('classifies a custom provider with its display name', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.Custom, codingPlanEnabled: false, displayName: '我的中转' },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    expect(resolveModelSourceForOpenClawProvider('custom')).toEqual({
      source: 'custom-provider',
      providerName: ProviderName.Custom,
      providerDisplayName: '我的中转',
    });
  });

  test('classifies a vendor coding plan through the descriptor provider id', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.Zhipu, codingPlanEnabled: true },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    // Zhipu maps to the OpenClaw provider id "zai".
    expect(resolveModelSourceForOpenClawProvider('zai')).toEqual({
      source: 'coding-plan',
      providerName: ProviderName.Zhipu,
      providerDisplayName: 'Zhipu',
    });
  });

  test('classifies OAuth-mode builtin providers via their oauth descriptor id', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.Minimax, codingPlanEnabled: false, authType: 'oauth' },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    expect(resolveModelSourceForOpenClawProvider('minimax-portal')).toEqual({
      source: 'builtin-oauth',
      providerName: ProviderName.Minimax,
      providerDisplayName: 'MiniMax',
    });
    // The api-key descriptor id no longer matches while OAuth mode is active.
    expect(resolveModelSourceForOpenClawProvider('minimax')).toBeUndefined();
  });

  test('classifies plain builtin providers and unknown ids', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.DeepSeek, codingPlanEnabled: false },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    expect(resolveModelSourceForOpenClawProvider('deepseek')).toEqual({
      source: 'builtin-provider',
      providerName: ProviderName.DeepSeek,
      providerDisplayName: 'DeepSeek',
    });
    expect(resolveModelSourceForOpenClawProvider('never-configured')).toBeUndefined();
    expect(resolveModelSourceForOpenClawProvider('')).toBeUndefined();
  });
});
