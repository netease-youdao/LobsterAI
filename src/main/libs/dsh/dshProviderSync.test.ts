import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshMcpTransport } from '../../../shared/dshEngine/hostConstants';
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
  findInvalidDshTemplateToken,
  normalizeDshMcpServerName,
  resolveDshMcpTransport,
} from './dshProviderSync';

const DSH_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(result.servers[0]).toMatchObject({ name: 'local-files', transport: DshMcpTransport.Stdio });
    expect(result.servers[1]).toMatchObject({
      name: 'linear-remote',
      transport: DshMcpTransport.StreamableHttp,
      headers: { Authorization: 'Bearer fresh-tok' },
    });
    expect(result.needsReauthIds).toEqual(['mcp-oauth-expired']);
    expect(result.warnings).toEqual([]);
  });

  test('enforces DSH <=32 char pattern, truncates long names deterministically, and differentiates non-ASCII names', async () => {
    const longAlpha = 'enterprise-filesystem-connector-production-alpha-v2';
    const longBeta = 'enterprise-filesystem-connector-production-beta-v2';
    const normAlpha = normalizeDshMcpServerName(longAlpha);
    const normBeta = normalizeDshMcpServerName(longBeta);

    expect(normAlpha).toMatch(DSH_SERVER_NAME_PATTERN);
    expect(normBeta).toMatch(DSH_SERVER_NAME_PATTERN);
    expect(normAlpha.length).toBeLessThanOrEqual(32);
    expect(normBeta.length).toBeLessThanOrEqual(32);
    expect(normAlpha).not.toBe(normBeta);
    expect(normalizeDshMcpServerName(longAlpha)).toBe(normAlpha);

    const exact32 = 'a'.repeat(32);
    expect(normalizeDshMcpServerName(exact32)).toBe(exact32);

    const result = await buildDshMcpServerSpecs([
      {
        id: 'uuid-gaode-1',
        name: '高德地图',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['gaode.js'],
      },
      {
        id: 'uuid-baidu-2',
        name: '百度地图',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['baidu.js'],
      },
      {
        id: 'uuid-weather-3',
        name: '天气查询',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['weather.js'],
      },
      {
        id: 'uuid-dup-1',
        name: exact32,
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['dup1.js'],
      },
      {
        id: 'uuid-dup-2',
        name: exact32,
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['dup2.js'],
      },
      {
        id: 'uuid-long-zh-ascii',
        name: '超长中文前缀-my-enterprise-mcp-server-with-very-long-name-exceeding-limit',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['long.js'],
      },
    ]);

    expect(result.servers).toHaveLength(6);
    const names = result.servers.map((s) => s.name);
    expect(new Set(names).size).toBe(6);
    for (const name of names) {
      expect(name).toMatch(DSH_SERVER_NAME_PATTERN);
      expect(name.length).toBeLessThanOrEqual(32);
      expect(name).not.toBe('mcp-server-2');
    }
    // Non-ASCII servers keep deterministic names regardless of input ordering.
    const reversed = await buildDshMcpServerSpecs([
      {
        id: 'uuid-weather-3',
        name: '天气查询',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['weather.js'],
      },
      {
        id: 'uuid-gaode-1',
        name: '高德地图',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['gaode.js'],
      },
    ]);
    expect(reversed.servers[0].name).toBe(names[2]);
    expect(reversed.servers[1].name).toBe(names[0]);
  });

  test('detects invalid DSH template tokens, skips bad template/URL entries with warnings, and forwards per-server timeouts', async () => {
    expect(findInvalidDshTemplateToken('Bearer ${credential:API_KEY_1}')).toBeNull();
    expect(findInvalidDshTemplateToken('$PLAIN_VAR')).toBeNull();
    expect(findInvalidDshTemplateToken('${API_KEY}')).toBe('${API_KEY}');
    expect(findInvalidDshTemplateToken('$${API_KEY}')).toBe('${API_KEY}');
    expect(findInvalidDshTemplateToken('${x${credential:A}')).toBe('${x${credential:A}');
    expect(findInvalidDshTemplateToken('${credential:123}')).toBe('${credential:123}');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await buildDshMcpServerSpecs([
      {
        id: 'valid-stdio',
        name: 'Valid Stdio',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: '${credential:VALID_REF}' },
        requestTimeoutMs: 90_000,
        connectionTimeoutMs: 15_000,
      },
      {
        id: 'bad-env-template',
        name: 'Bad Env Template',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: '${UNSUPPORTED_ENV_REF}' },
      },
      {
        id: 'bad-arg-template',
        name: 'Bad Arg Template',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['--fmt', '$${ESCAPED_STILL_REJECTED}'],
      },
      {
        id: 'malformed-url',
        name: 'Broken Legacy URL',
        enabled: true,
        transportType: 'http',
        url: 'not-a-valid-url',
      },
      {
        id: 'non-http-url',
        name: 'FTP URL',
        enabled: true,
        transportType: 'http',
        url: 'ftp://example.com/mcp',
      },
      {
        id: 'bad-header-template',
        name: 'Bad Header Template',
        enabled: true,
        transportType: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer ${LEGACY_TOKEN}' },
      },
      {
        id: 'valid-http',
        name: 'Valid Remote',
        enabled: true,
        transportType: 'http',
        url: 'https://mcp.example.com/v1',
        headers: { 'X-Api-Key': 'literal-key' },
        requestTimeoutMs: 120_000,
        connectionTimeoutMs: 45_000,
      },
    ]);

    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toMatchObject({
      name: 'valid-stdio',
      transport: 'stdio',
      toolCallTimeoutMs: 90_000,
      startupTimeoutMs: 15_000,
    });
    expect(result.servers[1]).toMatchObject({
      name: 'valid-remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/v1',
      toolCallTimeoutMs: 120_000,
      startupTimeoutMs: 45_000,
    });
    expect(result.warnings).toHaveLength(5);
    expect(result.warnings[0]).toContain('env.API_KEY');
    expect(result.warnings[0]).not.toContain('UNSUPPORTED_ENV_REF');
    expect(result.warnings[1]).toContain('args[1]');
    expect(result.warnings[2]).toContain('malformed or unsupported URL');
    expect(result.warnings[3]).toContain('malformed or unsupported URL');
    expect(result.warnings[4]).toContain('headers.Authorization');
    expect(result.warnings[4]).not.toContain('LEGACY_TOKEN');
    expect(warnSpy).toHaveBeenCalledTimes(5);
  });

  test('strips case-insensitive existing authorization headers before injecting OAuth token keyed by server UUID id', async () => {
    const serverUuid = '8b4b4d2a-1234-4a5b-9c6d-111122223333';
    const resolveAuthorizationHeaders = vi.fn(async (id: string) => {
      if (id === serverUuid) return { Authorization: 'Bearer oauth-live-token' };
      throw new Error('refresh failed');
    });

    const result = await buildDshMcpServerSpecs(
      [
        {
          id: serverUuid,
          name: 'Notion Remote',
          enabled: true,
          transportType: 'http',
          url: 'https://mcp.notion.com/mcp',
          headers: {
            authorization: 'Bearer stale-lowercase-token',
            AUTHORIZATION: 'Bearer stale-uppercase-token',
            'X-Workspace': 'acme',
          },
          oauthEnabled: true,
        },
        {
          id: 'uuid-failing-refresh',
          name: 'Broken OAuth',
          enabled: true,
          transportType: 'http',
          url: 'https://mcp.broken.example/mcp',
          oauthEnabled: true,
        },
      ],
      { resolveAuthorizationHeaders },
    );

    expect(resolveAuthorizationHeaders).toHaveBeenCalledWith(serverUuid);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].headers).toEqual({
      'X-Workspace': 'acme',
      Authorization: 'Bearer oauth-live-token',
    });
    expect(Object.keys(result.servers[0].headers ?? {}).filter((k) => k.toLowerCase() === 'authorization')).toEqual([
      'Authorization',
    ]);
    expect(result.needsReauthIds).toEqual(['uuid-failing-refresh']);
  });

  test('preserves legacy sse transport, custom headers, OAuth headers, and timeouts without coercing to streamable-http', async () => {
    expect(resolveDshMcpTransport('stdio')).toBe(DshMcpTransport.Stdio);
    expect(resolveDshMcpTransport('sse')).toBe(DshMcpTransport.Sse);
    expect(resolveDshMcpTransport(' SSE ')).toBe(DshMcpTransport.Sse);
    expect(resolveDshMcpTransport('http')).toBe(DshMcpTransport.StreamableHttp);
    expect(resolveDshMcpTransport('streamable-http')).toBe(DshMcpTransport.StreamableHttp);

    const resolveAuthorizationHeaders = vi.fn(async (id: string) => {
      if (id === 'uuid-sse-oauth') return { Authorization: 'Bearer sse-oauth-tok' };
      return null;
    });

    const result = await buildDshMcpServerSpecs(
      [
        {
          id: 'uuid-legacy-sse',
          name: 'Legacy Warehouse SSE',
          enabled: true,
          transportType: 'sse',
          url: 'https://legacy.example.com/sse',
          headers: {
            Authorization: 'Bearer static-sse-key',
            'X-Tenant-Id': 'warehouse-cn',
          },
          connectionTimeoutMs: 15_000,
          requestTimeoutMs: 45_000,
        },
        {
          id: 'uuid-sse-oauth',
          name: 'OAuth SSE',
          enabled: true,
          transportType: 'sse',
          url: 'https://oauth-sse.example.com/sse',
          headers: { 'X-Custom': 'yes' },
          oauthEnabled: true,
        },
        {
          id: 'uuid-sse-oauth-expired',
          name: 'Expired OAuth SSE',
          enabled: true,
          transportType: 'sse',
          url: 'https://expired-sse.example.com/sse',
          oauthEnabled: true,
        },
        {
          id: 'uuid-modern-http',
          name: 'Modern HTTP',
          enabled: true,
          transportType: 'http',
          url: 'https://modern.example.com/mcp',
          headers: { 'X-Api-Key': 'modern-key' },
        },
        {
          id: 'uuid-disabled-sse',
          name: 'Disabled SSE',
          enabled: false,
          transportType: 'sse',
          url: 'https://disabled.example.com/sse',
        },
      ],
      { resolveAuthorizationHeaders },
    );

    expect(resolveAuthorizationHeaders).toHaveBeenCalledWith('uuid-sse-oauth');
    expect(resolveAuthorizationHeaders).toHaveBeenCalledWith('uuid-sse-oauth-expired');
    expect(result.needsReauthIds).toEqual(['uuid-sse-oauth-expired']);
    expect(result.servers).toEqual([
      {
        name: 'legacy-warehouse-sse',
        enabled: true,
        transport: DshMcpTransport.Sse,
        url: 'https://legacy.example.com/sse',
        headers: {
          Authorization: 'Bearer static-sse-key',
          'X-Tenant-Id': 'warehouse-cn',
        },
        startupTimeoutMs: 15_000,
        toolCallTimeoutMs: 45_000,
      },
      {
        name: 'oauth-sse',
        enabled: true,
        transport: DshMcpTransport.Sse,
        url: 'https://oauth-sse.example.com/sse',
        headers: {
          'X-Custom': 'yes',
          Authorization: 'Bearer sse-oauth-tok',
        },
      },
      {
        name: 'modern-http',
        enabled: true,
        transport: DshMcpTransport.StreamableHttp,
        url: 'https://modern.example.com/mcp',
        headers: { 'X-Api-Key': 'modern-key' },
      },
    ]);
  });

  test('propagates and normalizes toolFilter for stdio and remote servers while omitting empty filters', async () => {
    const result = await buildDshMcpServerSpecs([
      {
        id: 'srv-stdio-filtered',
        name: 'Filter Demo',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        toolFilter: {
          include: [' allowed_echo ', 'sheet.*', '', 'allowed_echo'],
          exclude: [' blocked_secret '],
        },
      },
      {
        id: 'srv-http-filtered',
        name: 'Docs HTTP',
        enabled: true,
        transportType: 'http',
        url: 'https://mcp.example.com/mcp',
        toolFilter: {
          exclude: ['dangerous_delete', '  '],
        },
      },
      {
        id: 'srv-sse-filtered',
        name: 'Legacy SSE Filtered',
        enabled: true,
        transportType: 'sse',
        url: 'https://legacy.example.com/sse',
        toolFilter: {
          exclude: ['secret_tool'],
        },
      },
      {
        id: 'srv-empty-filter',
        name: 'No Filter',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['plain.mjs'],
        toolFilter: { include: ['  '], exclude: [] },
      },
    ]);

    expect(result.servers).toHaveLength(4);
    expect(result.servers[0]).toMatchObject({
      name: 'filter-demo',
      transport: 'stdio',
      toolFilter: {
        include: ['allowed_echo', 'sheet.*'],
        exclude: ['blocked_secret'],
      },
    });
    expect(result.servers[1]).toMatchObject({
      name: 'docs-http',
      transport: 'streamable-http',
      toolFilter: {
        exclude: ['dangerous_delete'],
      },
    });
    expect(result.servers[2]).toMatchObject({
      name: 'legacy-sse-filtered',
      transport: DshMcpTransport.Sse,
      toolFilter: {
        exclude: ['secret_tool'],
      },
    });
    expect(result.servers[3].toolFilter).toBeUndefined();
  });
});
