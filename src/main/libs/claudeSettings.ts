import { join } from 'path';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import {
  configureCoworkOpenAICompatProxy,
  type OpenAICompatProxyTarget,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, type AnthropicApiFormat } from './coworkFormatTransform';

const ZHIPU_CODING_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
// Qwen Coding Plan 专属端点 (OpenAI 兼容和 Anthropic 兼容)
const QWEN_CODING_PLAN_OPENAI_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
const QWEN_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
// Volcengine Coding Plan 专属端点 (OpenAI 兼容和 Anthropic 兼容)
const VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding';

type ProviderModel = {
  id: string;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
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

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
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
  baseURL: string;
};

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'openai' || providerName === 'gemini') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerName: string): boolean {
  return providerName !== 'ollama';
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
  let apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  let baseURL = providerConfig.baseUrl?.trim();

  // Handle Zhipu GLM Coding Plan endpoint switch
  if (providerName === 'zhipu' && providerConfig.codingPlanEnabled) {
    baseURL = ZHIPU_CODING_PLAN_BASE_URL;
    apiFormat = 'openai';
  }

  // Handle Qwen Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'qwen' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = QWEN_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = QWEN_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  // Handle Volcengine Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'volcengine' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim()) {
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  return {
    matched: {
      providerName,
      providerConfig,
      modelId,
      apiFormat,
      baseURL,
    },
  };
}

export function resolveCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): ApiConfigResolution {
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

  const resolvedBaseURL = matched.baseURL;
  const resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';
  const effectiveApiKey = matched.providerName === 'ollama'
    && matched.apiFormat === 'anthropic'
    && !resolvedApiKey
    ? 'sk-ollama-local'
    : resolvedApiKey;

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
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

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
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

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;

  return baseEnv;
}
