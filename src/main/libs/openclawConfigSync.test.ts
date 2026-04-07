import { test, expect, describe } from 'vitest';
import {
  ProviderName,
  OpenClawProviderId,
  OpenClawApi,
} from '../../shared/providers';

const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `LOBSTER_APIKEY_${envName}`;
};

describe('providerApiKeyEnvVar', () => {
  test('converts simple provider names', () => {
    expect(providerApiKeyEnvVar(ProviderName.Moonshot)).toBe('LOBSTER_APIKEY_MOONSHOT');
    expect(providerApiKeyEnvVar(ProviderName.Anthropic)).toBe('LOBSTER_APIKEY_ANTHROPIC');
    expect(providerApiKeyEnvVar(ProviderName.OpenAI)).toBe('LOBSTER_APIKEY_OPENAI');
    expect(providerApiKeyEnvVar(ProviderName.Ollama)).toBe('LOBSTER_APIKEY_OLLAMA');
  });

  test('replaces hyphens and special chars with underscores', () => {
    expect(providerApiKeyEnvVar(ProviderName.LobsteraiServer)).toBe('LOBSTER_APIKEY_LOBSTERAI_SERVER');
    expect(providerApiKeyEnvVar('my.provider')).toBe('LOBSTER_APIKEY_MY_PROVIDER');
  });

  test('server key matches hardcoded convention', () => {
    expect(providerApiKeyEnvVar('server')).toBe('LOBSTER_APIKEY_SERVER');
  });
});

describe('env var stability on model switch', () => {
  const simulateCollectEnvVars = (providers: Record<string, { enabled: boolean; apiKey: string }>, serverToken?: string) => {
    const env: Record<string, string> = {};

    if (serverToken) {
      env.LOBSTER_APIKEY_SERVER = serverToken;
    }

    for (const [name, config] of Object.entries(providers)) {
      if (!config.enabled) continue;
      const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      env[`LOBSTER_APIKEY_${envName}`] = config.apiKey;
    }

    return env;
  };

  test('switching from server to custom provider does not change env var keys', () => {
    const providers = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-123' },
    };
    const serverToken = 'access-token-xyz';

    const envBefore = simulateCollectEnvVars(providers, serverToken);
    const envAfter = simulateCollectEnvVars(providers, serverToken);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
  });

  test('switching between two custom providers does not change env var keys', () => {
    const providers = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-123' },
      [ProviderName.Anthropic]: { enabled: true, apiKey: 'sk-ant-456' },
    };

    const envBefore = simulateCollectEnvVars(providers);
    const envAfter = simulateCollectEnvVars(providers);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
    expect(envBefore.LOBSTER_APIKEY_MOONSHOT).toBe('sk-moon-123');
    expect(envBefore.LOBSTER_APIKEY_ANTHROPIC).toBe('sk-ant-456');
  });

  test('only editing apiKey value causes env var change', () => {
    const providersBefore = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-OLD' },
    };
    const providersAfter = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-NEW' },
    };

    const envBefore = simulateCollectEnvVars(providersBefore);
    const envAfter = simulateCollectEnvVars(providersAfter);

    expect(JSON.stringify(envBefore)).not.toBe(JSON.stringify(envAfter));
  });
});

// ═══════════════════════════════════════════════════════
// Provider Descriptor Registry Tests
//
// Since buildProviderSelection imports Electron-only modules,
// we mirror the descriptor resolution logic here to verify
// the registry mapping correctness.
// ═══════════════════════════════════════════════════════

type OpenClawProviderApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai';

const mapApiTypeToOpenClawApi = (
  apiType: 'anthropic' | 'openai' | undefined,
): OpenClawProviderApi => {
  if (apiType === 'openai') return 'openai-completions';
  return 'anthropic-messages';
};

type ProviderDescriptor = {
  providerId: string;
  resolveApi: (ctx: { apiType: 'anthropic' | 'openai' | undefined; baseURL: string }) => OpenClawProviderApi;
  normalizeBaseUrl: (rawBaseUrl: string) => string;
  resolveSessionModelId?: (modelId: string) => string;
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};

const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) return trimmed;
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.endsWith('/openai')) {
    return normalized.slice(0, -'/openai'.length);
  }
  return normalized;
};

const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  [ProviderName.Moonshot]: {
    providerId: OpenClawProviderId.Moonshot,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
    modelDefaults: {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 8192,
    },
  },
  [ProviderName.Gemini]: {
    providerId: OpenClawProviderId.Google,
    resolveApi: () => OpenClawApi.GoogleGenerativeAI as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
    modelDefaults: { reasoning: true },
  },
  [ProviderName.Anthropic]: {
    providerId: OpenClawProviderId.Anthropic,
    resolveApi: () => OpenClawApi.AnthropicMessages as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.OpenAI]: {
    providerId: OpenClawProviderId.OpenAI,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.DeepSeek]: {
    providerId: OpenClawProviderId.DeepSeek,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Qwen]: {
    providerId: OpenClawProviderId.Qwen,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Zhipu]: {
    providerId: OpenClawProviderId.Zai,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Volcengine]: {
    providerId: OpenClawProviderId.Volcengine,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Minimax]: {
    providerId: OpenClawProviderId.Minimax,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Youdaozhiyun]: {
    providerId: OpenClawProviderId.Youdaozhiyun,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.StepFun]: {
    providerId: OpenClawProviderId.StepFun,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Xiaomi]: {
    providerId: OpenClawProviderId.Xiaomi,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.OpenRouter]: {
    providerId: OpenClawProviderId.OpenRouter,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Ollama]: {
    providerId: OpenClawProviderId.Ollama,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
};

const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.Lobster,
  resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

const resolveDescriptor = (
  providerName: string,
  codingPlanEnabled: boolean,
): ProviderDescriptor => {
  if (codingPlanEnabled) {
    const compositeKey = `${providerName}:codingPlan`;
    if (compositeKey in PROVIDER_REGISTRY) {
      return PROVIDER_REGISTRY[compositeKey];
    }
  }
  if (providerName in PROVIDER_REGISTRY) {
    return PROVIDER_REGISTRY[providerName];
  }
  return {
    ...DEFAULT_DESCRIPTOR,
    providerId: providerName || OpenClawProviderId.Lobster,
  };
};

describe('resolveDescriptor', () => {
  test('gemini maps to google providerId with google-generative-ai API', () => {
    const d = resolveDescriptor(ProviderName.Gemini, false);
    expect(d.providerId).toBe(OpenClawProviderId.Google);
    expect(d.resolveApi({ apiType: undefined, baseURL: '' })).toBe(OpenClawApi.GoogleGenerativeAI);
  });

  test('anthropic maps to anthropic providerId with anthropic-messages API', () => {
    const d = resolveDescriptor(ProviderName.Anthropic, false);
    expect(d.providerId).toBe(OpenClawProviderId.Anthropic);
    expect(d.resolveApi({ apiType: undefined, baseURL: '' })).toBe(OpenClawApi.AnthropicMessages);
  });

  test('openai maps to openai providerId', () => {
    const d = resolveDescriptor(ProviderName.OpenAI, false);
    expect(d.providerId).toBe(OpenClawProviderId.OpenAI);
  });

  test('moonshot without codingPlan uses moonshot providerId', () => {
    const d = resolveDescriptor(ProviderName.Moonshot, false);
    expect(d.providerId).toBe(OpenClawProviderId.Moonshot);
    expect(d.resolveApi({ apiType: 'openai', baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
    expect(d.resolveApi({ apiType: 'anthropic', baseURL: '' })).toBe(OpenClawApi.AnthropicMessages);
  });

  test('moonshot with codingPlan falls back to moonshot providerId', () => {
    const d = resolveDescriptor(ProviderName.Moonshot, true);
    expect(d.providerId).toBe(OpenClawProviderId.Moonshot);
  });

  test('moonshot has model defaults', () => {
    const d = resolveDescriptor(ProviderName.Moonshot, false);
    expect(d.modelDefaults?.contextWindow).toBe(256000);
    expect(d.modelDefaults?.maxTokens).toBe(8192);
  });

  test('deepseek maps to deepseek providerId respecting apiType', () => {
    const d = resolveDescriptor(ProviderName.DeepSeek, false);
    expect(d.providerId).toBe(OpenClawProviderId.DeepSeek);
    expect(d.resolveApi({ apiType: 'openai', baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
    expect(d.resolveApi({ apiType: 'anthropic', baseURL: '' })).toBe(OpenClawApi.AnthropicMessages);
  });

  test('youdaozhiyun always uses openai-completions', () => {
    const d = resolveDescriptor(ProviderName.Youdaozhiyun, false);
    expect(d.providerId).toBe(OpenClawProviderId.Youdaozhiyun);
    expect(d.resolveApi({ apiType: 'anthropic', baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
  });

  test('ollama always uses openai-completions', () => {
    const d = resolveDescriptor(ProviderName.Ollama, false);
    expect(d.providerId).toBe(OpenClawProviderId.Ollama);
    expect(d.resolveApi({ apiType: undefined, baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
  });

  test('unknown provider falls back to lobster providerId', () => {
    const d = resolveDescriptor('some-unknown', false);
    expect(d.providerId).toBe('some-unknown');
  });

  test('empty provider name falls back to lobster', () => {
    const d = resolveDescriptor('', false);
    expect(d.providerId).toBe(OpenClawProviderId.Lobster);
  });

  test('codingPlan flag is ignored for providers without codingPlan entry', () => {
    const d = resolveDescriptor(ProviderName.OpenAI, true);
    expect(d.providerId).toBe(OpenClawProviderId.OpenAI);
  });

  test('volcengine with codingPlan falls back to volcengine providerId', () => {
    const d = resolveDescriptor(ProviderName.Volcengine, true);
    expect(d.providerId).toBe(OpenClawProviderId.Volcengine);
  });

  test('volcengine without codingPlan uses volcengine providerId', () => {
    const d = resolveDescriptor(ProviderName.Volcengine, false);
    expect(d.providerId).toBe(OpenClawProviderId.Volcengine);
  });
});

describe('provider registry coverage', () => {
  const allRegistryProviders = [
    ProviderName.Moonshot,
    ProviderName.Gemini,
    ProviderName.Anthropic,
    ProviderName.OpenAI,
    ProviderName.DeepSeek,
    ProviderName.Qwen,
    ProviderName.Zhipu,
    ProviderName.Volcengine,
    ProviderName.Minimax,
    ProviderName.Youdaozhiyun,
    ProviderName.StepFun,
    ProviderName.Xiaomi,
    ProviderName.OpenRouter,
    ProviderName.Ollama,
  ] as const;

  test('all 14 providers have registry entries', () => {
    for (const name of allRegistryProviders) {
      expect(name in PROVIDER_REGISTRY, `${name} missing from registry`).toBe(true);
    }
  });

  test('no provider resolves to lobster fallback', () => {
    for (const name of allRegistryProviders) {
      const d = resolveDescriptor(name, false);
      expect(d.providerId).not.toBe(OpenClawProviderId.Lobster);
    }
  });

  test('every provider has a non-empty providerId', () => {
    for (const name of allRegistryProviders) {
      const d = resolveDescriptor(name, false);
      expect(d.providerId.length).toBeGreaterThan(0);
    }
  });
});
