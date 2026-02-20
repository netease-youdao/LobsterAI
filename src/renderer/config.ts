// 配置类型定义
export interface AppConfig {
  // API 配置
  api: {
    key: string;
    baseUrl: string;
  };
  // 模型配置
  model: {
    availableModels: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
    }>;
    defaultModel: string;
  };
  // 多模型提供商配置
  providers?: {
    openai: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      // API 协议格式：anthropic 为 Anthropic 兼容，openai 为 OpenAI 兼容
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
      apiFormat?: 'anthropic' | 'openai';
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
  // 语言初始化标记 (用于判断是否是首次启动)
  language_initialized?: boolean;
  // 应用配置
  app: {
    port: number;
    isDevelopment: boolean;
  };
  // 快捷键配置
  shortcuts?: {
    newChat: string;
    search: string;
    settings: string;
    [key: string]: string | undefined;
  };
}

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
  model: {
    availableModels: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
    ],
    defaultModel: 'deepseek-chat',
  },
  providers: {
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai',
      models: [
        { id: 'gpt-5.2-2025-12-11', name: 'GPT-5.2', supportsImage: true },
        { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', supportsImage: true }
      ]
    },
    gemini: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      models: [
        { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true },
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', supportsImage: true }
      ]
    },
    anthropic: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic',
      models: [
        { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', supportsImage: true },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true }
      ]
    },
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
        { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false }
      ]
    },
    moonshot: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true }
      ]
    },
    zhipu: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'glm-5', name: 'GLM 5', supportsImage: false },
        { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false }
      ]
    },
    minimax: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false },
        { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', supportsImage: false }
      ]
    },
    qwen: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
        { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', supportsImage: false }
      ]
    },
    openrouter: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api',
      apiFormat: 'anthropic',
      models: [
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsImage: true },
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', supportsImage: true },
        { id: 'openai/gpt-5.2-codex', name: 'GPT 5.2 Codex', supportsImage: true },
        { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
      ]
    },
    ollama: {
      enabled: false,
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      apiFormat: 'anthropic',
      models: [
        { id: 'qwen3-coder-next', name: 'Qwen3-Coder-Next', supportsImage: false },
        { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', supportsImage: false }
      ]
    }
  },
  theme: 'system',
  language: 'zh',
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
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

// 模型提供商分类
export const CHINA_PROVIDERS = ['deepseek', 'moonshot', 'qwen', 'zhipu', 'minimax', 'ollama'] as const;
export const GLOBAL_PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter'] as const;
export const EN_PRIORITY_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;

/**
 * 根据语言获取可见的模型提供商
 */
export const getVisibleProviders = (language: 'zh' | 'en'): readonly string[] => {
  // 开发环境下显示所有提供商
  // if (import.meta.env.DEV) {
  //   return [...CHINA_PROVIDERS, ...GLOBAL_PROVIDERS];
  // }

  // 中文 → 中国版，英文 → 国际版
  if (language === 'zh') {
    return CHINA_PROVIDERS;
  }

  const orderedProviders = [
    ...EN_PRIORITY_PROVIDERS,
    ...CHINA_PROVIDERS,
    ...GLOBAL_PROVIDERS,
  ];
  const uniqueProviders = [...new Set(orderedProviders)];
  const ollamaIndex = uniqueProviders.indexOf('ollama');
  if (ollamaIndex === -1) {
    return uniqueProviders;
  }

  uniqueProviders.splice(ollamaIndex, 1);
  uniqueProviders.push('ollama');
  return uniqueProviders;
};
