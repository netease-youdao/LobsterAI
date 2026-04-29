import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  serverModels: [] as Array<{ modelId: string; supportsImage?: boolean }>,
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
  },
}));

vi.mock('./claudeSettings', () => ({
  getAllServerModelMetadata: () => mockRuntimeState.serverModels,
  resolveAllEnabledProviderConfigs: () => [],
  resolveAllProviderApiKeys: () => ({}),
  resolveRawApiConfig: () => mockRuntimeState.rawApiConfig,
}));

vi.mock('./openclawLocalExtensions', () => ({
  findThirdPartyExtensionsDir: () => null,
  hasBundledOpenClawExtension: (id: string) => id !== 'qwen-portal-auth',
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

vi.mock('./openaiCodexAuth', () => ({
  readOpenAICodexAuthFile: () => ({ accountId: 'acct-test' }),
}));

describe('OpenClawConfigSync runtime config output', () => {
  let tmpDir: string;
  let configPath: string;
  let stateDir: string;

  beforeEach(() => {
    mockRuntimeState.proxyPort = null;
    mockRuntimeState.serverModels = [];
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
    const { setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(false);
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
      getPopoConfig: () => null,
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

  test('merges all server models into existing lobsterai provider and updates image input', async () => {
    mockRuntimeState.proxyPort = 56646;
    mockRuntimeState.serverModels = [
      { modelId: 'qwen3.5-plus-YoudaoInner', supportsImage: true },
      { modelId: 'qwen3.6-plus-YoudaoInner', supportsImage: true },
      { modelId: 'deepseek-v3.2-YoudaoInner', supportsImage: false },
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
      getPopoConfig: () => null,
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
    expect(provider.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'qwen3.5-plus-YoudaoInner',
        input: ['text', 'image'],
      }),
      expect.objectContaining({
        id: 'qwen3.6-plus-YoudaoInner',
        input: ['text', 'image'],
      }),
      expect.objectContaining({
        id: 'deepseek-v3.2-YoudaoInner',
        input: ['text'],
      }),
    ]));
    expect(provider.models).toHaveLength(3);
  });

  test('maps OpenAI OAuth mode to the OpenAI Codex provider', async () => {
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

    expect(selection.providerId).toBe(OpenClawProviderId.OpenAICodex);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.OpenAICodex}/gpt-5.4`);
    expect(selection.providerConfig.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAICodexResponses);
    expect(selection.providerConfig.auth).toBe(AuthType.OAuth);
    expect(selection.providerConfig.headers).toEqual({
      'chatgpt-account-id': 'acct-test',
      originator: 'pi',
      'OpenAI-Beta': 'responses=experimental',
    });
    expect(selection.providerConfig).not.toHaveProperty('apiKey');
  });

  test('repairs stale image capability for known Qwen models before writing OpenClaw input', async () => {
    const { ProviderName } = await import('../../shared/providers');
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

  test('adds missing array items in MCP bridge tool schemas for OpenAI compatibility', async () => {
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
      getPopoConfig: () => null,
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
      getMcpBridgeConfig: () => ({
        callbackUrl: 'http://127.0.0.1:12345/mcp',
        askUserCallbackUrl: 'http://127.0.0.1:12345/ask',
        secret: 'test-secret',
        tools: [{
          server: 'github',
          name: 'create_issue',
          description: 'Create an issue',
          inputSchema: {
            type: 'object',
            properties: {
              attachments: {
                type: 'array',
                description: 'Optional issue attachments',
              },
            },
          },
        }],
      }),
    });

    const result = sync.sync('test');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const [tool] = config.plugins.entries['mcp-bridge'].config.tools;
    expect(tool.inputSchema.properties.attachments.items).toEqual({});
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
      getPopoConfig: () => null,
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
      getPopoConfig: () => null,
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
      getPopoConfig: () => null,
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
    expect(config.plugins.entries).not.toHaveProperty('openclaw-qqbot');
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
      getPopoConfig: () => null,
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
      getPopoConfig: () => null,
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
});
