import { describe, expect, test, vi } from 'vitest';

import {
  COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
  ComputerUseMcpServerName,
} from '../../../shared/computerUse/constants';
import {
  KIMI_K3_RUNTIME_PROFILE,
  LOBSTERAI_REQUEST_OPTIONS_VERSION,
  LobsterAIRequestCapability,
  ModelRuntimeProfile,
  ModelThinkingLevel,
  OpenClawApi,
  OpenClawProviderId,
  OpenClawThinkingLevel,
} from '../../../shared/providers';
import {
  buildDshMcpServerSpecs,
  buildDshProvidersPayload,
  buildDshThinkingLevelMap,
  buildModelThinkingLevelMap,
  clampModelMaxTokens,
  normalizeDshMcpServerName,
  resolveDshReasoningEffort,
} from './dshProviderSync';

describe('buildDshProvidersPayload', () => {
  test('translates standard API-key providers and routes OAuth/Plan providers through local modelAuthProxy', () => {
    const payload = buildDshProvidersPayload({
      modelAuthProxyUrl: 'http://127.0.0.1:45555',
      modelAuthProxySecret: 'proxy-secret',
      virtualAliases: {
        'yd-fast': { provider: 'lobster', model: 'deepseek-chat' },
      },
      providers: {
        openai: {
          enabled: true,
          apiKey: 'sk-openai',
          apiFormat: 'openai',
          models: [{ id: 'gpt-5', name: 'GPT-5', supportsImage: true }],
        },
        lobster: {
          enabled: true,
          authType: 'lobster_plan',
          apiFormat: 'openai',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        },
        disabledOne: {
          enabled: false,
          apiKey: 'sk-unused',
          baseUrl: 'https://example.com/v1',
          models: [{ id: 'm1' }],
        },
      },
    });

    expect(payload.providers.map((p) => p.id)).toEqual(['openai', 'lobster']);
    const openai = payload.providers.find((p) => p.id === 'openai')!;
    expect(openai.baseURL).toBe('https://api.openai.com/v1');
    expect(openai.models[0].input).toEqual(['text', 'image']);
    expect(openai.compat).toBeUndefined();

    const lobster = payload.providers.find((p) => p.id === 'lobster')!;
    expect(lobster.baseURL).toBe('http://127.0.0.1:45555/v1/lobster');
    expect(lobster.apiKey).toBe('proxy-secret');
    expect(lobster.compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
    });
    expect(payload.virtualAliases['yd-fast']).toEqual({ provider: 'lobster', model: 'deepseek-chat' });
  });

  test('disables developer role and store for non-native openai-completions endpoints while preserving native and non-completions protocols', () => {
    const payload = buildDshProvidersPayload({
      modelAuthProxyUrl: 'http://127.0.0.1:45555',
      modelAuthProxySecret: 'proxy-secret',
      providers: {
        'lobsterai-server': {
          enabled: true,
          authType: 'lobster_plan',
          apiFormat: 'openai',
          models: [{ id: 'qwen4-max-YoudaoInner', supportsThinking: true }],
        },
        qwen: {
          enabled: true,
          apiKey: 'sk-qwen',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiFormat: 'openai',
          models: [{ id: 'qwen3.8-max', supportsThinking: true }],
        },
        moonshot: {
          enabled: true,
          apiKey: 'sk-kimi',
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiFormat: 'openai',
          models: [{ id: 'kimi-for-coding', supportsThinking: true }],
        },
        openai: {
          enabled: true,
          apiKey: 'sk-proxy',
          baseUrl: 'https://proxy.example.com/v1',
          apiFormat: 'openai',
          models: [{ id: 'gpt-5', supportsThinking: true }],
        },
        anthropic: {
          enabled: true,
          apiKey: 'sk-ant',
          baseUrl: 'https://api.anthropic.com',
          apiFormat: 'anthropic',
          models: [{ id: 'claude-sonnet-4-6', supportsThinking: true }],
        },
        customResponses: {
          enabled: true,
          apiKey: 'sk-resp',
          baseUrl: 'https://proxy.example.com/v1',
          apiFormat: 'openai-responses',
          models: [{ id: 'gpt-5', supportsThinking: true }],
        },
      },
    });

    const byId = Object.fromEntries(payload.providers.map((p) => [p.id, p]));
    expect(byId['lobsterai-server'].compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
    });
    expect(byId.qwen.compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
    });
    expect(byId.moonshot.compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(byId.openai.compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
    });
    expect(byId.anthropic.compat).toBeUndefined();
    expect(byId.customResponses.compat).toBeUndefined();
  });

  test('propagates per-model Anthropic api, thinkingConfig/lobsterai-options-v1, and Kimi K3 runtime profiles', () => {
    const glmThinkingConfig = {
      options: [
        { level: ModelThinkingLevel.Off, openclawLevel: OpenClawThinkingLevel.Off },
        { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
        { level: ModelThinkingLevel.Max, openclawLevel: OpenClawThinkingLevel.XHigh },
      ],
      defaultLevel: ModelThinkingLevel.High,
    };

    const payload = buildDshProvidersPayload({
      modelAuthProxyUrl: 'http://127.0.0.1:45555',
      modelAuthProxySecret: 'proxy-secret',
      providers: {
        [OpenClawProviderId.LobsteraiServer]: {
          enabled: true,
          authType: 'lobster_plan',
          apiFormat: 'openai',
          models: [
            {
              id: 'claude-sonnet-5-5-hc-YoudaoInner',
              name: 'Claude Sonnet 5.5',
              provider: 'anthropic',
              apiFormat: 'anthropic',
              supportsImage: true,
              supportsThinking: true,
              contextWindow: 1_000_000,
            },
            {
              id: 'glm-5.3-flash-YoudaoInner',
              name: 'GLM-5.3-Flash',
              provider: 'zhipu',
              apiFormat: 'openai',
              supportsImage: true,
              supportsThinking: true,
              thinkingConfig: glmThinkingConfig,
              requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
              contextWindow: 1_000_000,
            },
            {
              id: 'glm-no-cap-YoudaoInner',
              name: 'GLM Without Capability',
              provider: 'zhipu',
              apiFormat: 'openai',
              supportsThinking: true,
              thinkingConfig: glmThinkingConfig,
              requestCapabilities: [],
              contextWindow: 1_000_000,
            },
            {
              id: 'kimi-k3-YoudaoInner',
              name: 'Kimi K3',
              provider: 'moonshot',
              apiFormat: 'openai',
              runtimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
              supportsImage: true,
              supportsThinking: true,
              contextWindow: 1_048_576,
              maxTokens: 1_048_576,
            },
            {
              id: 'kimi-k3.1-pro-YoudaoInner',
              name: 'Kimi K3.1 Pro',
              provider: 'moonshot',
              apiFormat: 'openai',
              supportsImage: true,
              supportsThinking: true,
              contextWindow: 1_048_576,
            },
          ],
        },
        custom_0: {
          enabled: true,
          apiKey: 'sk-custom',
          baseUrl: 'https://proxy.example.com/v1',
          apiFormat: 'openai',
          models: [{ id: 'kimi-k3', name: 'Custom K3' }],
        },
        anthropic_direct: {
          enabled: true,
          apiKey: 'sk-ant',
          baseUrl: 'https://api.anthropic.com/v1',
          apiFormat: 'anthropic',
          models: [{ id: 'claude-sonnet-4-6' }],
        },
      },
    });

    const server = payload.providers.find((p) => p.id === OpenClawProviderId.LobsteraiServer)!;
    const serverModels = Object.fromEntries(server.models.map((m) => [m.id, m]));

    // Claude Sonnet 5.5 keeps per-model anthropic-messages protocol and plan 32k default output cap.
    expect(serverModels['claude-sonnet-5-5-hc-YoudaoInner']).toMatchObject({
      id: 'claude-sonnet-5-5-hc-YoudaoInner',
      api: OpenClawApi.AnthropicMessages,
      contextWindow: 1_000_000,
      maxTokens: 32_768,
      reasoning: true,
    });
    expect(serverModels['claude-sonnet-5-5-hc-YoudaoInner'].compat).toBeUndefined();

    // GLM-5.3-Flash carries thinkingLevelMap + lobsterai-options-v1 protocol config.
    expect(serverModels['glm-5.3-flash-YoudaoInner']).toMatchObject({
      id: 'glm-5.3-flash-YoudaoInner',
      maxTokens: 32_768,
      thinkingConfig: glmThinkingConfig,
      requestOptionsVersion: LOBSTERAI_REQUEST_OPTIONS_VERSION,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: ModelThinkingLevel.High,
        xhigh: null,
        max: ModelThinkingLevel.Max,
      },
      compat: { supportsReasoningEffort: true },
    });
    expect(serverModels['glm-5.3-flash-YoudaoInner'].api).toBeUndefined();

    // Without lobsterai-options-v1 capability, requestOptionsVersion is withheld (fail closed).
    expect(serverModels['glm-no-cap-YoudaoInner'].requestOptionsVersion).toBeUndefined();
    expect(serverModels['glm-no-cap-YoudaoInner'].thinkingConfig).toBeUndefined();

    // Kimi K3 gets its full controlled runtime profile + safe 131,072 defaultMaxTokens cap.
    expect(serverModels['kimi-k3-YoudaoInner']).toMatchObject({
      id: 'kimi-k3-YoudaoInner',
      runtimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
      defaultMaxTokens: 131_072,
      reasoning: true,
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
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
      },
    });

    // Other Moonshot models under lobsterai-server also get assistant reasoning replay compat.
    expect(serverModels['kimi-k3.1-pro-YoudaoInner']).toMatchObject({
      maxTokens: 32_768,
      compat: { requiresReasoningContentOnAssistantMessages: true },
    });
    expect(serverModels['kimi-k3.1-pro-YoudaoInner'].runtimeProfile).toBeUndefined();

    // Custom OpenAI-compatible provider with exact kimi-k3 model ID also resolves K3 profile.
    const custom = payload.providers.find((p) => p.id === 'custom_0')!;
    expect(custom.models[0]).toMatchObject({
      id: 'kimi-k3',
      runtimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
      defaultMaxTokens: 131_072,
      compat: {
        maxTokensField: 'max_tokens',
        supportsUsageInStreaming: false,
        requiresReasoningContentOnAssistantMessages: true,
      },
    });

    // Non-proxy Anthropic baseURL strips trailing /v1 so Anthropic SDK does not hit /v1/v1/messages.
    const anthropicDirect = payload.providers.find((p) => p.id === 'anthropic_direct')!;
    expect(anthropicDirect.baseURL).toBe('https://api.anthropic.com');
  });

  test('buildDshThinkingLevelMap disables off when omitted from thinkingConfig options', () => {
    expect(buildDshThinkingLevelMap({
      options: [
        { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
        { level: ModelThinkingLevel.Max, openclawLevel: OpenClawThinkingLevel.XHigh },
      ],
      defaultLevel: ModelThinkingLevel.High,
    })).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: ModelThinkingLevel.High,
      xhigh: null,
      max: ModelThinkingLevel.Max,
    });
  });

  test('canonicalizes OpenClaw provider IDs and routes OAuth providers accurately', () => {
    const payload = buildDshProvidersPayload({
      modelAuthProxyUrl: 'http://127.0.0.1:45555',
      modelAuthProxySecret: 'proxy-secret',
      virtualAliases: {
        'zai/glm-alias': { provider: 'zai', model: 'glm-5.3' },
      },
      providers: {
        zai: {
          enabled: true,
          apiKey: 'sk-zhipu',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiFormat: 'anthropic',
          models: [{ id: 'glm-5.3' }],
        },
        google: {
          enabled: true,
          apiKey: 'sk-gem',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiFormat: 'gemini',
          models: [{ id: 'gemini-3.1-pro-preview' }],
        },
        'lobsterai-copilot': {
          enabled: true,
          apiFormat: 'openai',
          models: [{ id: 'gpt-5-mini' }],
        },
        openai: {
          enabled: true,
          authType: 'oauth',
          apiFormat: 'openai',
          models: [{ id: 'gpt-5.4', supportsThinking: true }],
        },
        xai: {
          enabled: true,
          authType: 'oauth',
          apiFormat: 'openai',
          models: [{ id: 'grok-4.5', supportsThinking: true }],
        },
        minimax: {
          enabled: true,
          authType: 'oauth',
          apiKey: 'mm-direct-oauth-token',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiFormat: 'anthropic',
          models: [{ id: 'MiniMax-M3' }],
        },
      },
    });

    const byId = Object.fromEntries(payload.providers.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual([
      'gemini',
      'github-copilot',
      'minimax',
      'openai',
      'xai',
      'zhipu',
    ]);
    expect(byId.openai).toMatchObject({
      id: 'openai',
      api: OpenClawApi.OpenAIResponses,
      baseURL: 'http://127.0.0.1:45555/v1/openai-codex',
      apiKey: 'proxy-secret',
    });
    expect(byId.xai).toMatchObject({
      id: 'xai',
      api: OpenClawApi.OpenAICompletions,
      baseURL: 'http://127.0.0.1:45555/v1/xai-oauth',
      apiKey: 'proxy-secret',
    });
    expect(byId.minimax).toMatchObject({
      id: 'minimax',
      api: OpenClawApi.AnthropicMessages,
      baseURL: 'https://api.minimaxi.com/anthropic',
      apiKey: 'mm-direct-oauth-token',
    });
    expect(byId['github-copilot']).toMatchObject({
      id: 'github-copilot',
      baseURL: 'http://127.0.0.1:45555/v1/github-copilot',
      apiKey: 'proxy-secret',
    });
    expect(payload.virtualAliases['zai/glm-alias']).toEqual({
      provider: 'zhipu',
      model: 'glm-5.3',
    });
  });

  test('strips /chat/completions and /responses suffixes, clamps maxTokens, forwards customParams, and applies Kimi K3 compat', () => {
    const payload = buildDshProvidersPayload({
      providers: {
        youdaozhiyun: {
          enabled: true,
          apiKey: 'sk-yd',
          baseUrl: 'https://openapi.youdao.com/llmgateway/api/v1/chat/completions/',
          apiFormat: 'openai',
          models: [
            {
              id: 'deepseek-reasoner',
              contextWindow: 8192,
              maxTokens: 32768,
              customParams: { top_k: 40, repetition_penalty: 1.05 },
            },
          ],
        },
        customResponses: {
          enabled: true,
          apiKey: 'sk-resp',
          baseUrl: 'https://gateway.example.com/v1/responses',
          apiFormat: 'openai-responses',
          models: [{ id: 'gpt-5.5' }],
        },
        moonshot: {
          enabled: true,
          apiKey: 'sk-kimi',
          baseUrl: 'https://api.moonshot.cn/v1',
          apiFormat: 'openai',
          models: [
            {
              id: 'kimi-k3',
              customParams: {
                temperature: 0.7,
                top_k: 32,
                requiresStringContent: false,
              },
            },
          ],
        },
      },
    });

    const byId = Object.fromEntries(payload.providers.map((p) => [p.id, p]));
    expect(byId.youdaozhiyun.baseURL).toBe('https://openapi.youdao.com/llmgateway/api/v1');
    expect(byId.youdaozhiyun.models[0]).toMatchObject({
      contextWindow: 8192,
      maxTokens: 8192,
      customParams: { top_k: 40, repetition_penalty: 1.05 },
    });

    expect(byId.customResponses.baseURL).toBe('https://gateway.example.com/v1');

    const kimiModel = byId.moonshot.models[0];
    expect(kimiModel.reasoning).toBe(true);
    expect(kimiModel.contextWindow).toBe(KIMI_K3_RUNTIME_PROFILE.contextWindow);
    expect(kimiModel.maxTokens).toBe(KIMI_K3_RUNTIME_PROFILE.maxTokens);
    expect(kimiModel.defaultMaxTokens).toBe(131_072);
    expect(kimiModel.thinkingLevelMap).toEqual(KIMI_K3_RUNTIME_PROFILE.thinkingLevelMap);
    expect(kimiModel.compat).toMatchObject({
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: false,
      requiresStringContent: true,
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    });
    // Kimi K3 reserved customParam keys (`temperature`, `requiresStringContent`) are stripped, non-reserved kept.
    expect(kimiModel.customParams).toEqual({ top_k: 32 });
  });

  test('supports per-model Anthropic vs OpenAI format and preset context windows on lobsterai-server', () => {
    const payload = buildDshProvidersPayload({
      modelAuthProxyUrl: 'http://127.0.0.1:45555',
      modelAuthProxySecret: 'proxy-secret',
      providers: {
        'lobsterai-server': {
          enabled: true,
          authType: 'lobster_plan',
          apiFormat: 'openai',
          models: [
            {
              id: 'deepseek-v4',
              apiFormat: 'openai',
              supportsThinking: true,
              contextWindow: 400_000,
              maxTokens: 500_000,
              contextWindowDefault: 'model-default',
              contextWindows: [
                { id: 'model-default', label: '400000', contextWindow: 400_000 },
                { id: 'yd-fast', label: '400000', contextWindow: 400_000 },
                { id: 'user-context:1000000', label: '1000000', contextWindow: 1_000_000 },
              ],
            },
            {
              id: 'claude-opus-4-7',
              apiFormat: 'anthropic',
              supportsThinking: true,
              contextWindow: 200_000,
              maxTokens: 16_384,
            },
          ],
        },
      },
    });

    const server = payload.providers[0];
    expect(server.id).toBe('lobsterai-server');
    expect(server.baseURL).toBe('http://127.0.0.1:45555/v1/lobsterai-server');

    const openaiModel = server.models.find((m) => m.id === 'deepseek-v4')!;
    expect(openaiModel.api).toBeUndefined();
    expect(openaiModel.baseURL).toBeUndefined();
    expect(openaiModel.maxTokens).toBe(400_000);
    expect(openaiModel.contextWindowDefault).toBe('model-default');
    expect(openaiModel.contextWindows).toHaveLength(3);

    const anthropicModel = server.models.find((m) => m.id === 'claude-opus-4-7')!;
    expect(anthropicModel.api).toBe(OpenClawApi.AnthropicMessages);
    expect(anthropicModel.baseURL).toBe('http://127.0.0.1:45555');
  });
});

describe('clampModelMaxTokens & reasoning helpers', () => {
  test('clamps maxTokens to contextWindow and leaves undefined untouched', () => {
    expect(clampModelMaxTokens(32768, 8192)).toBe(8192);
    expect(clampModelMaxTokens(4096, 128000)).toBe(4096);
    expect(clampModelMaxTokens(undefined, 8192)).toBeUndefined();
    expect(clampModelMaxTokens(4096, undefined)).toBe(4096);
  });

  test('maps product thinking levels to DSH reasoningEffort cleanly', () => {
    expect(resolveDshReasoningEffort({ thinkingLevel: ModelThinkingLevel.Max })).toBe(OpenClawThinkingLevel.XHigh);
    expect(resolveDshReasoningEffort({ thinkingLevel: ModelThinkingLevel.High })).toBe(OpenClawThinkingLevel.High);
    expect(resolveDshReasoningEffort({ thinkingLevel: ModelThinkingLevel.Off })).toBe(OpenClawThinkingLevel.Off);
    expect(resolveDshReasoningEffort({ thinkingLevel: '' })).toBeUndefined();

    const thinkingConfig = {
      defaultLevel: ModelThinkingLevel.Medium,
      options: [
        { level: ModelThinkingLevel.Off, openclawLevel: OpenClawThinkingLevel.Off },
        { level: ModelThinkingLevel.Medium, openclawLevel: OpenClawThinkingLevel.Medium },
        { level: ModelThinkingLevel.Max, openclawLevel: OpenClawThinkingLevel.XHigh },
      ],
    };
    expect(resolveDshReasoningEffort({ thinkingLevel: '', thinkingConfig })).toBe(OpenClawThinkingLevel.Medium);
    expect(resolveDshReasoningEffort({ thinkingLevel: ModelThinkingLevel.Max, thinkingConfig })).toBe(OpenClawThinkingLevel.XHigh);
    expect(resolveDshReasoningEffort({ thinkingLevel: ModelThinkingLevel.High, thinkingConfig })).toBe(OpenClawThinkingLevel.Medium);

    expect(resolveDshReasoningEffort({
      thinkingLevel: ModelThinkingLevel.Low,
      runtimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
    })).toBe('max');
    expect(resolveDshReasoningEffort({
      thinkingLevel: ModelThinkingLevel.Off,
      runtimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
    })).toBeUndefined();

    expect(buildModelThinkingLevelMap({ thinkingConfig })).toEqual({
      minimal: null,
      low: null,
      medium: 'medium',
      high: null,
      xhigh: 'xhigh',
      max: 'xhigh',
    });
  });
});

describe('buildDshMcpServerSpecs', () => {
  test('normalizes server names, injects OAuth headers, and reports servers needing reauth', async () => {
    expect(normalizeDshMcpServerName('My Notion MCP!')).toBe('my-notion-mcp');

    const resolveAuthorizationHeaders = vi.fn(async (id: string) => {
      if (id === 'mcp-oauth-ok') return { Authorization: 'Bearer fresh-tok' };
      return null;
    });

    const result = await buildDshMcpServerSpecs(
      [
        {
          id: 'mcp-local',
          name: 'Local Files',
          enabled: true,
          transportType: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        {
          id: 'mcp-oauth-ok',
          name: 'Linear Remote',
          enabled: true,
          transportType: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
          oauthEnabled: true,
        },
        {
          id: 'mcp-oauth-expired',
          name: 'Jira Remote',
          enabled: true,
          transportType: 'streamable-http',
          url: 'https://mcp.atlassian.com/mcp',
          oauthEnabled: true,
        },
      ],
      { resolveAuthorizationHeaders },
    );

    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toMatchObject({ name: 'local-files', transport: 'stdio' });
    expect(result.servers[1]).toMatchObject({
      name: 'linear-remote',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer fresh-tok' },
    });
    expect(result.needsReauthIds).toEqual(['mcp-oauth-expired']);
  });

  test('propagates requestTimeoutMs and connectionTimeoutMs for stdio and HTTP servers', async () => {
    const result = await buildDshMcpServerSpecs([
      {
        id: ComputerUseMcpServerName.BuiltIn,
        name: ComputerUseMcpServerName.BuiltIn,
        enabled: true,
        transportType: 'stdio',
        command: '/usr/local/bin/node',
        args: ['computer-use-mcp-server.mjs'],
        requestTimeoutMs: COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
        connectionTimeoutMs: 45_000,
      },
      {
        id: 'mcp-remote-slow',
        name: 'Remote Slow',
        enabled: true,
        transportType: 'http',
        url: 'https://mcp.example.com/rpc',
        requestTimeoutMs: 240_000,
        connectionTimeoutMs: 15_000,
      },
      {
        id: 'mcp-invalid-timeouts',
        name: 'Invalid Timeouts',
        enabled: true,
        transportType: 'stdio',
        command: '/usr/local/bin/node',
        args: ['server.mjs'],
        requestTimeoutMs: 0,
        connectionTimeoutMs: -500,
      },
    ]);

    expect(result.servers).toHaveLength(3);
    expect(result.servers[0]).toMatchObject({
      name: ComputerUseMcpServerName.BuiltIn,
      transport: 'stdio',
      toolCallTimeoutMs: COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
      startupTimeoutMs: 45_000,
    });
    expect(result.servers[1]).toMatchObject({
      name: 'remote-slow',
      transport: 'streamable-http',
      toolCallTimeoutMs: 240_000,
      startupTimeoutMs: 15_000,
    });
    expect(result.servers[2].toolCallTimeoutMs).toBeUndefined();
    expect(result.servers[2].startupTimeoutMs).toBeUndefined();
  });
});
