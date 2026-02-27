import {
  AppConfig,
  CONFIG_KEYS,
  defaultConfig,
  type BaseProviderConfig,
  type CustomProviderConfig,
  type ProviderModelConfig,
} from '../config';
import { localStore } from './store';

const getFixedProviderApiFormat = (providerKey: string): 'anthropic' | 'openai' | null => {
  if (providerKey === 'openai' || providerKey === 'gemini') {
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

const normalizeProviderModels = (models: unknown): ProviderModelConfig[] => {
  if (!Array.isArray(models)) {
    return [];
  }
  return models
    .filter((model): model is ProviderModelConfig => !!model && typeof model === 'object')
    .map((model) => ({
      id: String(model.id ?? '').trim(),
      name: String(model.name ?? '').trim(),
      supportsImage: !!model.supportsImage,
    }))
    .filter((model) => !!model.id && !!model.name);
};

const sanitizeCustomProviderName = (name: unknown): string => {
  if (typeof name !== 'string') {
    return '';
  }
  return name.trim().replace(/\s+/g, ' ');
};

const normalizeCustomProviderNameKey = (name: string): string => (
  sanitizeCustomProviderName(name).toLowerCase()
);

const toLegacyCustomProvider = (
  customProvider: CustomProviderConfig,
  fallback?: BaseProviderConfig
): BaseProviderConfig => ({
  ...(fallback ?? {
    enabled: false,
    apiKey: '',
    baseUrl: '',
    apiFormat: 'openai',
    models: [],
  }),
  enabled: fallback?.enabled ?? false,
  apiKey: customProvider.apiKey ?? '',
  baseUrl: normalizeProviderBaseUrl('custom', customProvider.baseUrl),
  apiFormat: normalizeProviderApiFormat('custom', customProvider.apiFormat),
  models: normalizeProviderModels(customProvider.models),
});

const createDefaultCustomProvider = (index: number, fallback?: Partial<CustomProviderConfig>): CustomProviderConfig => {
  const defaultCustom = defaultConfig.customProviders?.[0];
  return {
    id: fallback?.id?.trim() || `custom-${index + 1}`,
    name: sanitizeCustomProviderName(fallback?.name) || `Custom ${index + 1}`,
    enabled: fallback?.enabled ?? defaultCustom?.enabled ?? false,
    apiKey: fallback?.apiKey ?? defaultCustom?.apiKey ?? '',
    baseUrl: normalizeProviderBaseUrl('custom', fallback?.baseUrl ?? defaultCustom?.baseUrl ?? ''),
    apiFormat: normalizeProviderApiFormat('custom', fallback?.apiFormat ?? defaultCustom?.apiFormat),
    models: normalizeProviderModels(fallback?.models ?? defaultCustom?.models),
  };
};

const normalizeCustomProvidersConfig = (
  customProviders: AppConfig['customProviders'],
  legacyCustomProvider?: BaseProviderConfig
): CustomProviderConfig[] => {
  const source = customProviders && customProviders.length > 0
    ? customProviders
    : [createDefaultCustomProvider(0, legacyCustomProvider)];

  const usedNames = new Set<string>();
  const result = source.map((provider, index) => {
    const normalizedProvider = createDefaultCustomProvider(index, provider);
    const baseName = sanitizeCustomProviderName(normalizedProvider.name) || `Custom ${index + 1}`;
    let candidate = baseName;
    let suffix = 2;
    while (usedNames.has(normalizeCustomProviderNameKey(candidate))) {
      candidate = `${baseName} (${suffix})`;
      suffix += 1;
    }
    usedNames.add(normalizeCustomProviderNameKey(candidate));
    return {
      ...normalizedProvider,
      name: candidate,
    };
  });
  return result.length > 0 ? result : [createDefaultCustomProvider(0, legacyCustomProvider)];
};

const resolveActiveCustomProviderId = (
  customProviders: CustomProviderConfig[],
  preferredId?: string
): string => {
  if (preferredId && customProviders.some((provider) => provider.id === preferredId)) {
    return preferredId;
  }
  return customProviders[0].id;
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
                  return {
                    ...mergedProvider,
                    baseUrl: normalizeProviderBaseUrl(providerKey, mergedProvider.baseUrl),
                    apiFormat: normalizeProviderApiFormat(providerKey, mergedProvider.apiFormat),
                  };
                })(),
              ])
            )
          : defaultConfig.providers;

        const normalizedCustomProviders = normalizeCustomProvidersConfig(
          storedConfig.customProviders,
          mergedProviders?.custom
        );
        const activeCustomProviderId = resolveActiveCustomProviderId(
          normalizedCustomProviders,
          storedConfig.activeCustomProviderId
        );
        const activeCustomProvider = normalizedCustomProviders.find(
          (provider) => provider.id === activeCustomProviderId
        ) ?? normalizedCustomProviders[0];
        const providersWithCustomMirror = mergedProviders
          ? {
              ...mergedProviders,
              custom: toLegacyCustomProvider(activeCustomProvider, mergedProviders.custom),
            }
          : mergedProviders;

        this.config = {
          ...defaultConfig,
          ...storedConfig,
          api: {
            ...defaultConfig.api,
            ...storedConfig.api,
          },
          model: {
            ...defaultConfig.model,
            ...storedConfig.model,
          },
          app: {
            ...defaultConfig.app,
            ...storedConfig.app,
          },
          shortcuts: {
            ...defaultConfig.shortcuts!,
            ...(storedConfig.shortcuts ?? {}),
          } as AppConfig['shortcuts'],
          providers: providersWithCustomMirror as AppConfig['providers'],
          customProviders: normalizedCustomProviders,
          activeCustomProviderId,
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
    const nextProviders = normalizedProviders ?? this.config.providers;
    const normalizedCustomProviders = normalizeCustomProvidersConfig(
      newConfig.customProviders ?? this.config.customProviders,
      nextProviders?.custom
    );
    const activeCustomProviderId = resolveActiveCustomProviderId(
      normalizedCustomProviders,
      newConfig.activeCustomProviderId ?? this.config.activeCustomProviderId
    );
    const activeCustomProvider = normalizedCustomProviders.find(
      (provider) => provider.id === activeCustomProviderId
    ) ?? normalizedCustomProviders[0];
    const providersWithCustomMirror = nextProviders
      ? {
          ...nextProviders,
          custom: toLegacyCustomProvider(activeCustomProvider, nextProviders.custom),
        }
      : nextProviders;

    this.config = {
      ...this.config,
      ...newConfig,
      ...(providersWithCustomMirror ? { providers: providersWithCustomMirror } : {}),
      customProviders: normalizedCustomProviders,
      activeCustomProviderId,
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
