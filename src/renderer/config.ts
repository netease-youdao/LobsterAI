import { ProviderRegistry } from '@shared/providers';

// 配置类型定义
export interface AppConfig {
  // API 配置
  api: {
    key: string;
    baseUrl: string;
  };
  // 自定义模型提供商递增 ID 计数器（单调递增，删除后不复用）
  customProviderNextId?: number;
  // 模型配置
  model: {
    availableModels: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
    }>;
    defaultModel: string;
    defaultModelProvider?: string;
  };
  // 多模型提供商配置
  providers?: {
    openai: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      // API 协议格式：anthropic 为 Anthropic 兼容，openai 为 OpenAI 兼容
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    deepseek: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    moonshot: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 Moonshot Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    zhipu: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 GLM Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    minimax: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** OAuth auth type: 'apikey' (default) or 'oauth' (MiniMax Portal OAuth) */
      authType?: 'apikey' | 'oauth';
      /** OAuth refresh token for automatic token renewal */
      oauthRefreshToken?: string;
      /** OAuth token expiry as Unix timestamp in milliseconds */
      oauthTokenExpiresAt?: number;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    youdaozhiyun: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    qwen: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 Qwen Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    openrouter: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    gemini: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    anthropic: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    volcengine: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      /** 是否启用 Volcengine Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    xiaomi: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    stepfun: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    ollama: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    [key: string]: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'gemini';
      codingPlanEnabled?: boolean;
      authType?: 'apikey' | 'oauth';
      oauthRefreshToken?: string;
      oauthTokenExpiresAt?: number;
      displayName?: string;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
  };
  // 主题配置
  theme: 'light' | 'dark' | 'system';
  // 语言配置
  language: 'zh' | 'en';
  // 是否使用系统代理
  useSystemProxy: boolean;
  // 语言初始化标记 (用于判断是否是首次启动)
  language_initialized?: boolean;
  // 应用配置
  app: {
    port: number;
    isDevelopment: boolean;
    testMode?: boolean;
  };
  // 快捷键配置
  shortcuts?: {
    newChat: string;
    search: string;
    settings: string;
    [key: string]: string | undefined;
  };
}

/**
 * Build default provider configs from the shared registry.
 * Each provider gets: enabled=false, empty apiKey, default baseUrl/apiFormat/models.
 * Providers with codingPlan support also get codingPlanEnabled=false.
 * The 'custom' provider is not in the registry and is hardcoded separately.
 */
const buildDefaultProviders = (): AppConfig['providers'] => {
  const providers: Record<string, {
    enabled: boolean;
    apiKey: string;
    baseUrl: string;
    apiFormat?: 'anthropic' | 'openai' | 'gemini';
    codingPlanEnabled?: boolean;
    models?: Array<{ id: string; name: string; supportsImage?: boolean }>;
  }> = {};

  for (const id of ProviderRegistry.providerIds) {
    const def = ProviderRegistry.get(id)!;
    providers[id] = {
      enabled: false,
      apiKey: '',
      baseUrl: def.defaultBaseUrl,
      apiFormat: def.defaultApiFormat,
      ...(def.codingPlanSupported ? { codingPlanEnabled: false } : {}),
      models: def.defaultModels.map(m => ({ ...m })),
    };
  }

  return providers as AppConfig['providers'];
};

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
  model: {
    availableModels: [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
    ],
    defaultModel: 'deepseek-reasoner',
    defaultModelProvider: 'deepseek',
  },
  providers: buildDefaultProviders(),
  theme: 'system',
  language: 'zh',
  useSystemProxy: false,
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
    testMode: process.env.NODE_ENV === 'development',
  },
  shortcuts: {
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  }
};

// 配置存储键
export const CONFIG_KEYS = {
  APP_CONFIG: 'app_config',
  AUTH: 'auth_state',
  CONVERSATIONS: 'conversations',
  PROVIDERS_EXPORT_KEY: 'providers_export_key',
  SKILLS: 'skills',
};

// Provider lists derived from ProviderRegistry — single source of truth
export const CHINA_PROVIDERS = [...ProviderRegistry.idsByRegion('china')] as const;
export const GLOBAL_PROVIDERS = ProviderRegistry.idsByRegion('global');

export const getVisibleProviders = (language: 'zh' | 'en'): readonly string[] => {
  if (language === 'zh') {
    return [...CHINA_PROVIDERS];
  }
  return ProviderRegistry.idsForEnLocale();
};

/**
 * 判断 provider key 是否为自定义提供商（custom_0, custom_1, ...）
 */
export const isCustomProvider = (key: string): boolean => key.startsWith('custom_');

/**
 * 从 custom_N key 中提取默认显示名称（如 custom_0 → "Custom0"）
 */
export const getCustomProviderDefaultName = (key: string): string => {
  const suffix = key.replace('custom_', '');
  return `Custom${suffix}`;
};

/**
 * 获取 provider 的显示名称，自定义 provider 优先使用 displayName，
 * 内置 provider 使用首字母大写的 key。
 */
export const getProviderDisplayName = (
  providerKey: string,
  providerConfig?: Record<string, unknown>,
): string => {
  if (isCustomProvider(providerKey)) {
    const name = providerConfig && typeof providerConfig.displayName === 'string'
      ? providerConfig.displayName
      : '';
    return name || getCustomProviderDefaultName(providerKey);
  }
  return providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
};
