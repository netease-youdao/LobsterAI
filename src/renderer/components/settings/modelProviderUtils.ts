/**
 * Shared types, constants, and utility functions for model/provider settings.
 * Used by both Settings.tsx and ModelSettingsSection.tsx.
 */
import { ProviderAuthType, ProviderName, ProviderRegistry } from '../../../shared/providers';
import { type AppConfig, defaultConfig } from '../../config';
import { i18nService } from '../../services/i18n';

export const CUSTOM_PROVIDER_KEYS = [
  'custom_0', 'custom_1', 'custom_2', 'custom_3', 'custom_4',
  'custom_5', 'custom_6', 'custom_7', 'custom_8', 'custom_9',
] as const;

export const providerKeys = [
  ...Object.values(ProviderName).filter(id => id !== ProviderName.Custom && id !== ProviderName.LobsteraiServer),
  ...CUSTOM_PROVIDER_KEYS,
] as const;

type BuiltinProviderType = ProviderName;
type CustomProviderType = (typeof CUSTOM_PROVIDER_KEYS)[number];
export type ProviderType = BuiltinProviderType | CustomProviderType;
export type ProvidersConfig = NonNullable<AppConfig['providers']>;
export type ProviderConfig = ProvidersConfig[string];
export type Model = NonNullable<ProviderConfig['models']>[number];

export const resolveModelSupportsImageForProvider = (
  providerName: string,
  model: { id: string; supportsImage?: boolean },
): boolean => ProviderRegistry.resolveModelSupportsImage(providerName, model.id, model.supportsImage);

export const getOpenClawProviderIdForConfig = (
  providerName: string,
  providerConfig: ProviderConfig,
): string => ProviderRegistry.getOpenClawProviderIdForConfig(providerName, providerConfig);

export const providerRequiresApiKey = (provider: ProviderType) => provider !== ProviderName.Ollama
  && provider !== ProviderName.LmStudio
  && provider !== ProviderName.Copilot;

export const hasProviderAuthConfigured = (provider: ProviderType, config: ProviderConfig): boolean => {
  if (provider === ProviderName.Ollama || provider === ProviderName.LmStudio) {
    return true;
  }

  if (provider === ProviderName.Minimax) {
    if (config.authType === ProviderAuthType.ApiKey) {
      return config.apiKey.trim().length > 0;
    }
    return (config.oauthAccessToken?.trim().length ?? 0) > 0;
  }

  if (provider === ProviderName.OpenAI && config.authType === ProviderAuthType.OAuth) {
    return true;
  }

  // xAI OAuth: the credential lives in the OpenClaw auth-profiles store, not
  // in the renderer config. Settings reconciles authType back to apikey when
  // no credential exists (same pattern as OpenAI ChatGPT OAuth).
  if (provider === ProviderName.Xai && config.authType === ProviderAuthType.OAuth) {
    return true;
  }

  if (provider === ProviderName.Copilot) {
    return config.authType === ProviderAuthType.OAuth;
  }

  return config.apiKey.trim().length > 0;
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '').toLowerCase();

export const normalizeApiFormat = (value: unknown): 'anthropic' | 'openai' => (
  value === 'openai' ? 'openai' : 'anthropic'
);

export const getFixedApiFormatForProvider = (provider: string): 'anthropic' | 'openai' | 'gemini' | null => {
  if (provider === 'openai' || provider === 'stepfun') {
    return 'openai';
  }
  if (provider === ProviderName.Youdaozhiyun || provider === ProviderName.Copilot || provider === ProviderName.Qianfan || provider === ProviderName.Xai) {
    return 'openai';
  }
  if (provider === 'moonshot') {
    return 'openai';
  }
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  if (provider === 'gemini') {
    return 'gemini';
  }
  return null;
};

export const getEffectiveApiFormat = (provider: string, value: unknown): 'anthropic' | 'openai' | 'gemini' => (
  getFixedApiFormatForProvider(provider) ?? normalizeApiFormat(value)
);

export const shouldShowApiFormatSelector = (provider: string): boolean => (
  getFixedApiFormatForProvider(provider) === null
);

export const getProviderDefaultBaseUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai' | 'gemini'
): string | null => {
  if (apiFormat === 'gemini') return null;
  return ProviderRegistry.getSwitchableBaseUrl(provider, apiFormat) ?? null;
};

export const shouldAutoSwitchProviderBaseUrl = (provider: ProviderType, currentBaseUrl: string): boolean => {
  const anthropicUrl = ProviderRegistry.getSwitchableBaseUrl(provider, 'anthropic');
  const openaiUrl = ProviderRegistry.getSwitchableBaseUrl(provider, 'openai');
  if (!anthropicUrl && !openaiUrl) {
    return false;
  }

  const normalizedCurrent = normalizeBaseUrl(currentBaseUrl);
  return (
    (anthropicUrl ? normalizedCurrent === normalizeBaseUrl(anthropicUrl) : false)
    || (openaiUrl ? normalizedCurrent === normalizeBaseUrl(openaiUrl) : false)
  );
};

export const resolveBaseUrl = (
  provider: ProviderType,
  baseUrl: string,
  apiFormat: 'anthropic' | 'openai' | 'gemini'
): string => {
  if (baseUrl.trim()) {
    if (shouldAutoSwitchProviderBaseUrl(provider, baseUrl) && (apiFormat === 'anthropic' || apiFormat === 'openai')) {
      const switchedUrl = ProviderRegistry.getSwitchableBaseUrl(provider, apiFormat);
      if (switchedUrl) return switchedUrl;
    }
    return baseUrl;
  }
  return getProviderDefaultBaseUrl(provider, apiFormat)
    || defaultConfig.providers?.[provider]?.baseUrl
    || '';
};

export const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  const secureSuffix = i18nService.t('modelSuffixSecure');
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          name: model.name.replace('(Secure)', secureSuffix),
          supportsImage: resolveModelSupportsImageForProvider(providerKey, model),
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

  if (provider === ProviderName.Copilot) {
    return `${normalized}/chat/completions`;
  }

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
