/**
 * Shared types, constants, and utility functions for the Settings component tree.
 * Extracted from Settings.tsx to reduce file size and improve reusability.
 */
import React from 'react';
import { defaultConfig, type AppConfig } from '../../config';
import type { EncryptedPayload, PasswordEncryptedPayload } from '../../services/encryption';
import { EXPORT_FORMAT_TYPE } from '../../constants/app';
import {
  OpenAIIcon,
  DeepSeekIcon,
  GeminiIcon,
  AnthropicIcon,
  MoonshotIcon,
  ZhipuIcon,
  MiniMaxIcon,
  YouDaoZhiYunIcon,
  QwenIcon,
  XiaomiIcon,
  StepfunIcon,
  VolcengineIcon,
  OpenRouterIcon,
  OllamaIcon,
  CustomProviderIcon,
} from '../icons/providers';

// ==================== Tab Types ====================

export type TabType = 'general' | 'coworkAgentEngine' | 'model' | 'coworkMemory' | 'coworkAgent' | 'shortcuts' | 'im' | 'email' | 'about';

// ==================== Provider Types ====================

export const providerKeys = [
  'openai',
  'gemini',
  'anthropic',
  'deepseek',
  'moonshot',
  'zhipu',
  'minimax',
  'volcengine',
  'qwen',
  'youdaozhiyun',
  'stepfun',
  'xiaomi',
  'openrouter',
  'ollama',
  'custom',
] as const;

export type ProviderType = (typeof providerKeys)[number];
export type ProvidersConfig = NonNullable<AppConfig['providers']>;
export type ProviderConfig = ProvidersConfig[string];
export type Model = NonNullable<ProviderConfig['models']>[number];
export type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
};

export interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

export interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: 2;
  exportedAt: string;
  encryption: {
    algorithm: 'AES-GCM';
    keySource: 'password';
    keyDerivation: 'PBKDF2';
  };
  providers: Record<string, ProviderExportEntry>;
}

export interface ProvidersImportEntry {
  enabled?: boolean;
  apiKey?: EncryptedPayload | PasswordEncryptedPayload | string;
  apiKeyEncrypted?: string;
  apiKeyIv?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

export interface ProvidersImportPayload {
  type?: string;
  version?: number;
  encryption?: {
    algorithm?: string;
    keySource?: string;
    keyDerivation?: string;
  };
  providers?: Record<string, ProvidersImportEntry>;
}

// ==================== Provider Metadata ====================

export const providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }> = {
  openai: { label: 'OpenAI', icon: React.createElement(OpenAIIcon) },
  deepseek: { label: 'DeepSeek', icon: React.createElement(DeepSeekIcon) },
  gemini: { label: 'Gemini', icon: React.createElement(GeminiIcon) },
  anthropic: { label: 'Anthropic', icon: React.createElement(AnthropicIcon) },
  moonshot: { label: 'Moonshot', icon: React.createElement(MoonshotIcon) },
  zhipu: { label: 'Zhipu', icon: React.createElement(ZhipuIcon) },
  minimax: { label: 'MiniMax', icon: React.createElement(MiniMaxIcon) },
  youdaozhiyun: { label: 'Youdao', icon: React.createElement(YouDaoZhiYunIcon) },
  qwen: { label: 'Qwen', icon: React.createElement(QwenIcon) },
  xiaomi: { label: 'Xiaomi', icon: React.createElement(XiaomiIcon) },
  stepfun: { label: 'StepFun', icon: React.createElement(StepfunIcon) },
  volcengine: { label: 'Volcengine', icon: React.createElement(VolcengineIcon) },
  openrouter: { label: 'OpenRouter', icon: React.createElement(OpenRouterIcon) },
  ollama: { label: 'Ollama', icon: React.createElement(OllamaIcon) },
  custom: { label: 'Custom', icon: React.createElement(CustomProviderIcon) },
};

export const providerSwitchableDefaultBaseUrls: Partial<Record<ProviderType, { anthropic: string; openai: string }>> = {
  deepseek: {
    anthropic: 'https://api.deepseek.com/anthropic',
    openai: 'https://api.deepseek.com',
  },
  moonshot: {
    anthropic: 'https://api.moonshot.cn/anthropic',
    openai: 'https://api.moonshot.cn/v1',
  },
  zhipu: {
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
    openai: 'https://open.bigmodel.cn/api/paas/v4',
  },
  minimax: {
    anthropic: 'https://api.minimaxi.com/anthropic',
    openai: 'https://api.minimaxi.com/v1',
  },
  qwen: {
    anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  xiaomi: {
    anthropic: 'https://api.xiaomimimo.com/anthropic',
    openai: 'https://api.xiaomimimo.com/v1/chat/completions',
  },
  volcengine: {
    anthropic: 'https://ark.cn-beijing.volces.com/api/compatible',
    openai: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  openrouter: {
    anthropic: 'https://openrouter.ai/api',
    openai: 'https://openrouter.ai/api/v1',
  },
  ollama: {
    anthropic: 'http://localhost:11434',
    openai: 'http://localhost:11434/v1',
  },
  custom: {
    anthropic: '',
    openai: '',
  },
};

// ==================== Provider Utility Functions ====================

export const providerRequiresApiKey = (provider: ProviderType) => provider !== 'ollama';
export const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '').toLowerCase();
export const normalizeApiFormat = (value: unknown): 'anthropic' | 'openai' => (
  value === 'openai' ? 'openai' : 'anthropic'
);

export const ABOUT_CONTACT_EMAIL = 'lobsterai.project@rd.netease.com';
export const ABOUT_USER_MANUAL_URL = 'https://lobsterai.youdao.com/#/docs/lobsterai_user_manual';
export const ABOUT_SERVICE_TERMS_URL = 'https://c.youdao.com/dict/hardware/lobsterai/lobsterai_service.html';

export const copyTextFallback = (text: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
};

export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (clipboardError) {
      console.warn('Navigator clipboard write failed, trying fallback:', clipboardError);
    }
  }

  try {
    return copyTextFallback(text);
  } catch (fallbackError) {
    console.error('Fallback clipboard copy failed:', fallbackError);
    return false;
  }
};

export const getFixedApiFormatForProvider = (provider: string): 'anthropic' | 'openai' | null => {
  if (provider === 'openai' || provider === 'gemini' || provider === 'stepfun') {
    return 'openai';
  }
  if (provider === 'youdaozhiyun') {
    return 'openai';
  }
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  return null;
};

export const getEffectiveApiFormat = (provider: string, value: unknown): 'anthropic' | 'openai' => (
  getFixedApiFormatForProvider(provider) ?? normalizeApiFormat(value)
);

export const shouldShowApiFormatSelector = (provider: string): boolean => (
  getFixedApiFormatForProvider(provider) === null
);

export const getProviderDefaultBaseUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai'
): string | null => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  return defaults ? defaults[apiFormat] : null;
};

export const resolveBaseUrl = (
  provider: ProviderType,
  baseUrl: string,
  apiFormat: 'anthropic' | 'openai'
): string => {
  if (baseUrl.trim()) return baseUrl;
  return getProviderDefaultBaseUrl(provider, apiFormat)
    || defaultConfig.providers?.[provider]?.baseUrl
    || '';
};

export const shouldAutoSwitchProviderBaseUrl = (provider: ProviderType, currentBaseUrl: string): boolean => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  if (!defaults) {
    return false;
  }

  const normalizedCurrent = normalizeBaseUrl(currentBaseUrl);
  return (
    normalizedCurrent === normalizeBaseUrl(defaults.anthropic)
    || normalizedCurrent === normalizeBaseUrl(defaults.openai)
  );
};

export const buildOpenAICompatibleChatCompletionsUrl = (baseUrl: string, provider: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }

  const isGeminiLike = provider === 'gemini' || normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1')
        ? `${normalized.slice(0, -3)}v1beta`
        : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  // Handle /v1, /v4 etc. versioned paths
  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};

export const buildOpenAIResponsesUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/responses';
  }
  if (normalized.endsWith('/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/v1/responses`;
};

export const shouldUseOpenAIResponsesForProvider = (provider: string): boolean => (
  provider === 'openai'
);

export const shouldUseMaxCompletionTokensForOpenAI = (provider: string, modelId?: string): boolean => {
  if (provider !== 'openai') {
    return false;
  }
  const normalizedModel = (modelId ?? '').toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return resolvedModel.startsWith('gpt-5')
    || resolvedModel.startsWith('o1')
    || resolvedModel.startsWith('o3')
    || resolvedModel.startsWith('o4');
};

export const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

export const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ])
  ) as ProvidersConfig;
};

export const getDefaultActiveProvider = (): ProviderType => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = providerKeys.find(providerKey => providers[providerKey]?.enabled);
  return firstEnabledProvider ?? providerKeys[0];
};

/** Join workspace directory with a filename using platform-aware separator. */
export const joinWorkspacePath = (dir: string | undefined, filename: string): string => {
  const base = dir?.trim() || '~/.openclaw/workspace';
  const sep = window.electron.platform === 'win32' ? '\\' : '/';
  // Normalize: if base already ends with a separator, don't double it
  return base.endsWith(sep) || base.endsWith('/') || base.endsWith('\\')
    ? `${base}${filename}`
    : `${base}${sep}${filename}`;
};
