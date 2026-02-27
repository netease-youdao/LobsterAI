import { AppConfig, CONFIG_KEYS, defaultConfig } from '../config';
import { localStore } from './store';

const getFixedProviderApiFormat = (providerKey: string): 'anthropic' | 'openai' | 'antigravity' | null => {
  if (providerKey === 'openai' || providerKey === 'gemini') {
    return 'openai';
  }
  if (providerKey === 'anthropic') {
    return 'anthropic';
  }
  if (providerKey === 'antigravity') {
    return 'antigravity';
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

const normalizeProviderApiFormat = (
  providerKey: string,
  apiFormat: unknown
): 'anthropic' | 'openai' | 'antigravity' => {
  const fixed = getFixedProviderApiFormat(providerKey);
  if (fixed) {
    return fixed;
  }
  if (apiFormat === 'antigravity') {
    return 'antigravity';
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
          providers: mergedProviders as AppConfig['providers'],
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
    this.config = {
      ...this.config,
      ...newConfig,
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
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
