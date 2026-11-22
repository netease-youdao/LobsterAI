import { describe, expect, test, vi } from 'vitest';

import {
  OpenClawApi,
  OpenClawProviderId,
} from '../../../shared/providers/constants';
import {
  LOBSTERAI_REQUEST_OPTIONS_VERSION,
  LobsterAIRequestCapability,
} from '../../../shared/providers/lobsterAIRequestOptions';
import { ModelRuntimeProfile } from '../../../shared/providers/modelRuntimeProfiles';
import {
  ModelThinkingLevel,
  OpenClawThinkingLevel,
} from '../../../shared/providers/modelThinking';
import {
  buildDshMcpServerSpecs,
  buildDshProvidersPayload,
  buildDshThinkingLevelMap,
  normalizeDshMcpServerName,
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
});
