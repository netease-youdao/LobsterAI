import { AppConfig, CONFIG_KEYS, defaultConfig, type SpeechConfig, type SpeechProviderType } from '../config';
import { localStore } from './store';

const getFixedProviderApiFormat = (providerKey: string): 'anthropic' | 'openai' | null => {
  if (providerKey === 'openai' || providerKey === 'gemini' || providerKey === 'stepfun' || providerKey === 'youdaozhiyun') {
    return 'openai';
  }
  if (providerKey === 'anthropic') {
    return 'anthropic';
  }
  return null;
};

const normalizeProviderBaseUrl = (providerKey: string, baseUrl: unknown): string => {
  if (typeof baseUrl !== 'string') {
    return '';
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (providerKey !== 'gemini') {
    return normalized;
  }

  if (!normalized || !normalized.includes('generativelanguage.googleapis.com')) {
    return normalized;
  }

  if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
    return normalized;
  }
  if (normalized.endsWith('/v1beta')) {
    return `${normalized}/openai`;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}v1beta/openai`;
  }

  return 'https://generativelanguage.googleapis.com/v1beta/openai';
};

const normalizeProviderApiFormat = (providerKey: string, apiFormat: unknown): 'anthropic' | 'openai' => {
  const fixed = getFixedProviderApiFormat(providerKey);
  if (fixed) {
    return fixed;
  }
  if (apiFormat === 'openai') {
    return 'openai';
  }
  return 'anthropic';
};

const normalizeProvidersConfig = (providers: AppConfig['providers']): AppConfig['providers'] => {
  if (!providers) {
    return providers;
  }

  return Object.fromEntries(
    Object.entries(providers).map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        baseUrl: normalizeProviderBaseUrl(providerKey, providerConfig.baseUrl),
        apiFormat: normalizeProviderApiFormat(providerKey, providerConfig.apiFormat),
      },
    ])
  ) as AppConfig['providers'];
};

const normalizeSpeechProvider = (value: unknown): SpeechProviderType => {
  if (value === 'glm' || value === 'qwen') {
    return value;
  }
  return '';
};

const normalizeSpeechConfig = (speech: AppConfig['speech']): SpeechConfig => {
  const fallback: SpeechConfig = {
    enabled: defaultConfig.speech?.enabled ?? false,
    provider: defaultConfig.speech?.provider ?? '',
    apiKey: defaultConfig.speech?.apiKey ?? '',
    language: defaultConfig.speech?.language ?? '',
  };

  const normalizedProvider = normalizeSpeechProvider(speech?.provider);
  const apiKey = typeof speech?.apiKey === 'string'
    ? speech.apiKey.trim()
    : '';
  const language = typeof speech?.language === 'string'
    ? speech.language.trim()
    : fallback.language ?? '';
  const enabled = speech?.enabled === true;

  if (!enabled || !normalizedProvider || !apiKey) {
    return {
      ...fallback,
      provider: normalizedProvider,
      apiKey,
      language,
      enabled: false,
    };
  }

  return {
    ...fallback,
    provider: normalizedProvider,
    apiKey,
    language,
    enabled: true,
  };
};

// Model IDs that have been removed from specific providers.
// These will be filtered out from saved configs during migration.
const REMOVED_PROVIDER_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-chat'],
};

// Models to inject into existing saved configs (for existing users).
// These models will be added on every startup if missing from the stored config.
// Note: users cannot permanently remove these models — they will be re-injected
// on next launch. Once all users have upgraded, entries here should be removed
// so the models follow normal user-editable behavior (same as other models).
// position: 'start' inserts at the beginning, 'end' appends at the end.
const ADDED_PROVIDER_MODELS: Record<string, { models: Array<{ id: string; name: string; supportsImage?: boolean }>; position: 'start' | 'end' }> = {
  minimax: {
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false },
    ],
    position: 'start',
  },
};

class ConfigService {
  private config: AppConfig = defaultConfig;

  async init() {
    try {
      const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
      if (storedConfig) {
        const mergedProviders = storedConfig.providers
          ? Object.fromEntries(
              Object.entries({
                ...(defaultConfig.providers ?? {}),
                ...storedConfig.providers,
              }).map(([providerKey, providerConfig]) => [
                providerKey,
                (() => {
                  const mergedProvider = {
                    ...(defaultConfig.providers as Record<string, any>)?.[providerKey],
                    ...providerConfig,
                  };
                  // Filter out removed models
                  const removedIds = REMOVED_PROVIDER_MODELS[providerKey];
                  if (removedIds && mergedProvider.models) {
                    mergedProvider.models = mergedProvider.models.filter(
                      (m: { id: string }) => !removedIds.includes(m.id)
                    );
                  }
                  // Inject added models (for existing users who already have saved config)
                  const addedConfig = ADDED_PROVIDER_MODELS[providerKey];
                  if (addedConfig && mergedProvider.models) {
                    const existingIds = new Set(mergedProvider.models.map((m: { id: string }) => m.id));
                    const newModels = addedConfig.models.filter(m => !existingIds.has(m.id));
                    if (newModels.length > 0) {
                      mergedProvider.models = addedConfig.position === 'start'
                        ? [...newModels, ...mergedProvider.models]
                        : [...mergedProvider.models, ...newModels];
                    }
                  }
                  return {
                    ...mergedProvider,
                    baseUrl: normalizeProviderBaseUrl(providerKey, mergedProvider.baseUrl),
                    apiFormat: normalizeProviderApiFormat(providerKey, mergedProvider.apiFormat),
                  };
                })(),
              ])
            )
          : defaultConfig.providers;

        // Migrate model.defaultModel if it was removed
        const allRemovedIds = Object.values(REMOVED_PROVIDER_MODELS).flat();
        const migratedModel = { ...defaultConfig.model, ...storedConfig.model };
        if (allRemovedIds.includes(migratedModel.defaultModel)) {
          migratedModel.defaultModel = defaultConfig.model.defaultModel;
        }
        if (migratedModel.availableModels) {
          migratedModel.availableModels = migratedModel.availableModels.filter(
            (m: { id: string }) => !allRemovedIds.includes(m.id)
          );
        }

        this.config = {
          ...defaultConfig,
          ...storedConfig,
          api: {
            ...defaultConfig.api,
            ...storedConfig.api,
          },
          model: migratedModel,
          app: {
            ...defaultConfig.app,
            ...storedConfig.app,
          },
          shortcuts: {
            ...defaultConfig.shortcuts!,
            ...(storedConfig.shortcuts ?? {}),
          } as AppConfig['shortcuts'],
          providers: mergedProviders as AppConfig['providers'],
          speech: normalizeSpeechConfig(storedConfig.speech),
        };
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const normalizedProviders = normalizeProvidersConfig(newConfig.providers as AppConfig['providers'] | undefined);
    const mergedSpeech = normalizeSpeechConfig(newConfig.speech ?? this.config.speech);
    this.config = {
      ...this.config,
      ...newConfig,
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
      speech: mergedSpeech,
    };
    await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService(); 
