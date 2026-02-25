import { join } from 'path';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import {
  configureCoworkOpenAICompatProxy,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, type AnthropicApiFormat } from './coworkFormatTransform';

type ProviderModel = {
  id: string;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'antigravity' | 'native';
  authMode?: 'api-key' | 'oauth';
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    defaultModel?: string;
  };
  providers?: Record<string, ProviderConfig>;
};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
};

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;
let antigravityAuthResolver: ((forceRefresh?: boolean) => Promise<string>) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

export function setAntigravityAuthResolver(
  resolver: ((forceRefresh?: boolean) => Promise<string>) | null
): void {
  antigravityAuthResolver = resolver;
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

export function getClaudeCodePath(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }

  // In development, try to find the SDK in the project root node_modules
  // app.getAppPath() might point to dist-electron or other build output directories
  // We need to look in the project root
  const appPath = app.getAppPath();
  // If appPath ends with dist-electron, go up one level
  const rootDir = appPath.endsWith('dist-electron') 
    ? join(appPath, '..') 
    : appPath;

  return join(rootDir, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
};

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'antigravity' || apiFormat === 'antigravity') {
    return 'antigravity';
  }
  if (providerName === 'openai' || providerName === 'gemini') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function resolveMatchedProvider(appConfig: AppConfig): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};

  const resolveFallbackModel = (): string | undefined => {
    for (const provider of Object.values(providers)) {
      if (!provider?.enabled || !provider.models || provider.models.length === 0) {
        continue;
      }
      return provider.models[0].id;
    }
    return undefined;
  };

  const modelId = appConfig.model?.defaultModel || resolveFallbackModel();
  if (!modelId) {
    return { matched: null, error: 'No available model configured in enabled providers.' };
  }

  const providerEntry = Object.entries(providers).find(([, provider]) => {
    if (!provider?.enabled || !provider.models) {
      return false;
    }
    return provider.models.some((model) => model.id === modelId);
  });

  if (!providerEntry) {
    return { matched: null, error: `No enabled provider found for model: ${modelId}` };
  }

  const [providerName, providerConfig] = providerEntry;
  const apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  const baseURL = providerConfig.baseUrl?.trim();

  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (apiFormat === 'anthropic' && providerConfig.authMode !== 'oauth' && !providerConfig.apiKey?.trim()) {
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  return {
    matched: {
      providerName,
      providerConfig,
      modelId,
      apiFormat,
    },
  };
}

export function resolveCurrentApiConfig(): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
    };
  }

  const resolvedBaseURL = matched.providerConfig.baseUrl.trim();
  const resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: resolvedApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
      },
    };
  }

  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (!proxyStatus.running) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy is not running.',
    };
  }

  if (matched.apiFormat === 'antigravity') {
    if (!antigravityAuthResolver) {
      return {
        config: null,
        error: 'Antigravity OAuth resolver is not initialized.',
      };
    }

    const normalizeAntigravityModel = (modelId: string): string => {
      const trimmed = modelId.trim();
      return trimmed.startsWith('google-antigravity/')
        ? trimmed.slice('google-antigravity/'.length)
        : trimmed;
    };

    configureCoworkOpenAICompatProxy({
      baseURL: resolvedBaseURL,
      model: normalizeAntigravityModel(matched.modelId),
      providerModelId: matched.modelId,
      provider: matched.providerName,
      upstreamKind: 'antigravity',
      resolveAuthApiKey: async (forceRefresh?: boolean) => antigravityAuthResolver?.(forceRefresh ?? false),
    });

    const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL();
    if (!proxyBaseURL) {
      return {
        config: null,
        error: 'OpenAI compatibility proxy base URL is unavailable.',
      };
    }

    return {
      config: {
        apiKey: 'lobsterai-antigravity-oauth',
        baseURL: proxyBaseURL,
        model: matched.modelId,
        apiType: 'openai',
      },
    };
  }

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
    upstreamKind: 'openai',
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL();
  if (!proxyBaseURL) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy base URL is unavailable.',
    };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'lobsterai-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
  };
}

export function getCurrentApiConfig(): CoworkApiConfig | null {
  return resolveCurrentApiConfig().config;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;

  return baseEnv;
}
