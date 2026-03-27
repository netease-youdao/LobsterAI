import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AppConfig } from '../config';
import { CONFIG_KEYS, defaultConfig } from '../config';
import { configService } from './config';
import { localStore } from './store';

type ProvidersConfig = NonNullable<AppConfig['providers']>;

function createStoredConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig,
    ...overrides,
    providers: {
      ...(defaultConfig.providers as ProvidersConfig),
      ...(overrides.providers as Partial<ProvidersConfig> | undefined),
    } as ProvidersConfig,
  };
}

describe('configService speech config', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(localStore, 'setItem').mockResolvedValue();
    (configService as unknown as { config: AppConfig }).config = defaultConfig;
  });

  test('loads a normalized standalone speech config from storage', async () => {
    vi.spyOn(localStore, 'getItem').mockImplementation(async (key) => {
      if (key !== CONFIG_KEYS.APP_CONFIG) {
        return null;
      }

      return createStoredConfig({
        speech: {
          enabled: true,
          provider: 'glm',
          apiKey: '  glm-key  ',
          language: ' zh ',
        },
      });
    });

    await configService.init();

    expect(configService.getConfig().speech).toEqual({
      enabled: true,
      provider: 'glm',
      apiKey: 'glm-key',
      language: 'zh',
    });
  });

  test('disables speech when updating config without an api key', async () => {
    await configService.updateConfig({
      speech: {
        enabled: false,
        provider: 'qwen',
        apiKey: '',
        language: 'zh',
      },
    });

    await configService.updateConfig({
      speech: {
        enabled: true,
        provider: 'qwen',
        apiKey: '   ',
        language: 'zh',
      },
    });

    expect(configService.getConfig().speech).toEqual({
      enabled: false,
      provider: 'qwen',
      apiKey: '',
      language: 'zh',
    });
  });
});
