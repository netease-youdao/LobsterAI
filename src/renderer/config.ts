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
      inputPrice?: number | null;
      outputPrice?: number | null;
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
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
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
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    moonshot: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** 是否启用 Moonshot Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    zhipu: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** 是否启用 GLM Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
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
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    youdaozhiyun: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    qwen: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** 是否启用 Qwen Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
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
        inputPrice?: number | null;
        outputPrice?: number | null;
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
        inputPrice?: number | null;
        outputPrice?: number | null;
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
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    volcengine: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** 是否启用 Volcengine Coding Plan 模式（使用专属 Coding API 端点） */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    xiaomi: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    stepfun: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
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
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    custom: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
      }>;
    };
    [key: string]: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
        inputPrice?: number | null;
        outputPrice?: number | null;
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

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
  model: {
    availableModels: [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false, inputPrice: 2.03, outputPrice: 3.05 },
    ],
    defaultModel: 'deepseek-reasoner',
    defaultModelProvider: 'deepseek',
  },
  providers: {
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai',
      models: [
        { id: 'gpt-5.2-2025-12-11', name: 'GPT-5.2', supportsImage: true, inputPrice: null, outputPrice: null },
        { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', supportsImage: true, inputPrice: null, outputPrice: null }
      ]
    },
    gemini: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      models: [
        { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true, inputPrice: null, outputPrice: null },
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, inputPrice: null, outputPrice: null },
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', supportsImage: true, inputPrice: null, outputPrice: null }
      ]
    },
    anthropic: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic',
      models: [
        { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', supportsImage: true, inputPrice: 21.75, outputPrice: 108.75 },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true, inputPrice: 21.75, outputPrice: 108.75 },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true, inputPrice: 36.25, outputPrice: 181.25 }
      ]
    },
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false, inputPrice: 2.03, outputPrice: 3.05 }
      ]
    },
    moonshot: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true, inputPrice: null, outputPrice: null }
      ]
    },
    zhipu: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'glm-5', name: 'GLM 5', supportsImage: false, inputPrice: null, outputPrice: null },
        { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false, inputPrice: null, outputPrice: null }
      ]
    },
    minimax: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false, inputPrice: 2.1, outputPrice: 8.4 },
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false, inputPrice: 2.1, outputPrice: 8.4 },
        { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', supportsImage: false, inputPrice: 2.1, outputPrice: 8.4 }
      ]
    },
    youdaozhiyun: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://openapi.youdao.com/llmgateway/api/v1/chat/completions',
      apiFormat: 'openai',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false, inputPrice: null, outputPrice: null },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false, inputPrice: null, outputPrice: null },
        { id: 'deepseek-inhouse-chat', name: 'DeepSeek Chat (安全)', supportsImage: false, inputPrice: null, outputPrice: null },
        { id: 'deepseek-inhouse-reasoner', name: 'DeepSeek Reasoner (安全)', supportsImage: false, inputPrice: null, outputPrice: null }
      ]
    },
    qwen: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true, inputPrice: 0.8, outputPrice: 4.8 },
        { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', supportsImage: false, inputPrice: 4.0, outputPrice: 16.0 }
      ]
    },
    xiaomi: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', supportsImage: false, inputPrice: null, outputPrice: null }
      ]
    },
    stepfun: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.stepfun.com/v1',
      apiFormat: 'openai',
      models: [
        { id: 'step-3.5-flash', name: 'Step 3.5 Flash', supportsImage: false, inputPrice: null, outputPrice: null }
      ]
    },
    volcengine: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'ark-code-latest', name: 'Auto', supportsImage: false, inputPrice: null, outputPrice: null },
        { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao-Seed-2.0-pro', supportsImage: false, inputPrice: null, outputPrice: null },
        { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao-Seed-2.0-lite', supportsImage: false, inputPrice: null, outputPrice: null },
        { id: 'doubao-seed-2-0-mini-260215', name: 'Doubao-Seed-2.0-mini', supportsImage: false, inputPrice: null, outputPrice: null }
      ]
    },
    openrouter: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api',
      apiFormat: 'anthropic',
      models: [
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsImage: true, inputPrice: null, outputPrice: null },
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', supportsImage: true, inputPrice: null, outputPrice: null },
        { id: 'openai/gpt-5.2-codex', name: 'GPT 5.2 Codex', supportsImage: true, inputPrice: null, outputPrice: null },
        { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true, inputPrice: null, outputPrice: null },
      ]
    },
    ollama: {
      enabled: false,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      apiFormat: 'openai',
      models: [
        { id: 'qwen3-coder-next', name: 'Qwen3-Coder-Next', supportsImage: false, inputPrice: 0, outputPrice: 0 },
        { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', supportsImage: false, inputPrice: 0, outputPrice: 0 }
      ]
    },
    custom: {
      enabled: false,
      apiKey: '',
      baseUrl: '',
      apiFormat: 'openai',
      models: []
    }
  },
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

// 模型提供商分类
export const CHINA_PROVIDERS = ['deepseek', 'moonshot', 'qwen', 'zhipu', 'minimax', 'volcengine', 'youdaozhiyun', 'stepfun', 'xiaomi', 'ollama', 'custom'] as const;
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
  // Move ollama and custom to the end, with custom last
  for (const key of ['ollama', 'custom'] as const) {
    const idx = uniqueProviders.indexOf(key);
    if (idx !== -1) {
      uniqueProviders.splice(idx, 1);
      uniqueProviders.push(key);
    }
  }
  return uniqueProviders;
};
