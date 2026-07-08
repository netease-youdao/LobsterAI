import { ProviderName } from '@shared/providers';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type AppConfig, CONFIG_KEYS, defaultConfig, FontPreferences, ShortcutAction } from '../config';

const makeLegacyConfigWithoutMiniMaxAddedModels = (): AppConfig => ({
  ...defaultConfig,
  providers: {
    ...defaultConfig.providers,
    [ProviderName.Minimax]: {
      ...defaultConfig.providers![ProviderName.Minimax],
      enabled: true,
      apiKey: 'sk-minimax',
      models: defaultConfig.providers![ProviderName.Minimax].models?.filter(
        model => model.id !== 'MiniMax-M3' && model.id !== 'MiniMax-M2.7'
      ),
    },
  },
});

const makeLegacyConfigWithDeepSeekV4WithoutContextWindow = (): AppConfig => ({
  ...defaultConfig,
  providers: {
    ...defaultConfig.providers,
    [ProviderName.DeepSeek]: {
      ...defaultConfig.providers![ProviderName.DeepSeek],
      enabled: true,
      apiKey: 'sk-deepseek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false },
      ],
    },
  },
});

const makeLegacyConfigWithOldMimoModels = (): AppConfig => ({
  ...defaultConfig,
  providers: {
    ...defaultConfig.providers,
    [ProviderName.Xiaomi]: {
      ...defaultConfig.providers![ProviderName.Xiaomi],
      enabled: true,
      apiKey: 'sk-xiaomi',
      models: [
        { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', supportsImage: false, contextWindow: 128_000 },
        { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', supportsImage: false, contextWindow: 64_000 },
      ],
    },
  },
});

const makeConfigWithCustomContextWindows = (): AppConfig => ({
  ...defaultConfig,
  providers: {
    ...defaultConfig.providers,
    [ProviderName.Minimax]: {
      ...defaultConfig.providers![ProviderName.Minimax],
      enabled: true,
      apiKey: 'sk-minimax',
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax M3', supportsImage: false, contextWindow: 512_000 },
      ],
    },
    [ProviderName.DeepSeek]: {
      ...defaultConfig.providers![ProviderName.DeepSeek],
      enabled: true,
      apiKey: 'sk-deepseek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 256_000 },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, contextWindow: 384_000 },
      ],
    },
    [ProviderName.Xiaomi]: {
      ...defaultConfig.providers![ProviderName.Xiaomi],
      enabled: true,
      apiKey: 'sk-xiaomi',
      models: [
        { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, contextWindow: 640_000 },
        { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, contextWindow: 768_000 },
      ],
    },
    [ProviderName.Volcengine]: {
      ...defaultConfig.providers![ProviderName.Volcengine],
      enabled: true,
      apiKey: 'sk-volcengine',
      models: [
        { id: 'ark-code-latest', name: 'Auto', supportsImage: true },
      ],
    },
  },
});

const makeConfigWithDeletedProviderModel = (
  providerName: ProviderName,
  deletedModelId: string,
): AppConfig => ({
  ...defaultConfig,
  providerModelMigrationVersions: {
    [providerName]: 1,
  },
  providers: {
    ...defaultConfig.providers,
    [providerName]: {
      ...defaultConfig.providers![providerName],
      enabled: true,
      apiKey: `sk-${providerName}`,
      models: defaultConfig.providers![providerName].models?.filter(
        model => model.id !== deletedModelId
      ),
    },
  },
});

const addedProviderMigrationCases: Array<{ providerName: ProviderName; deletedModelId: string }> = [
  { providerName: ProviderName.DeepSeek, deletedModelId: 'deepseek-v4-flash' },
  { providerName: ProviderName.Moonshot, deletedModelId: 'kimi-k2.6' },
  { providerName: ProviderName.Minimax, deletedModelId: 'MiniMax-M3' },
  { providerName: ProviderName.Zhipu, deletedModelId: 'glm-5.1' },
  { providerName: ProviderName.Qianfan, deletedModelId: 'kimi-k2.5' },
  { providerName: ProviderName.Xiaomi, deletedModelId: 'mimo-v2.5-pro' },
  { providerName: ProviderName.OpenAI, deletedModelId: 'gpt-5.4' },
  { providerName: ProviderName.Gemini, deletedModelId: 'gemini-3.1-flash-lite' },
  { providerName: ProviderName.Anthropic, deletedModelId: 'claude-opus-4-7' },
  { providerName: ProviderName.OpenRouter, deletedModelId: 'anthropic/claude-sonnet-4.6' },
];

async function loadConfigServiceWithStoredConfig(storedConfig: AppConfig) {
  vi.resetModules();
  const storeData: Record<string, unknown> = {
    [CONFIG_KEYS.APP_CONFIG]: storedConfig,
  };
  const getItem = vi.fn(async (key: string) => storeData[key] ?? null);
  const setItem = vi.fn(async (key: string, value: unknown) => {
    storeData[key] = value;
  });

  vi.doMock('./store', () => ({
    localStore: {
      getItem,
      setItem,
      removeItem: vi.fn(),
    },
  }));

  (globalThis as unknown as { window?: unknown }).window = {
    dispatchEvent: vi.fn(),
    electron: {
      store: {
        get: getItem,
        set: setItem,
        remove: vi.fn(),
      },
    },
  };

  const { configService } = await import('./config');
  return { configService, storeData, setItem };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./store');
  delete (globalThis as { window?: unknown }).window;
});

describe('configService shortcut migrations', () => {
  test('normalizes prior agent default shortcuts to unset', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      shortcuts: {
        ...defaultConfig.shortcuts!,
        [ShortcutAction.PreviousAgent]: 'CommandOrControl+Shift+[',
        [ShortcutAction.NextAgent]: 'CommandOrControl+Shift+]',
        [ShortcutAction.ShowCurrentAgentTasks]: 'CommandOrControl+Shift+H',
        [ShortcutAction.OpenAgentTask1]: 'CommandOrControl+Shift+1',
        [ShortcutAction.OpenAgentTask2]: 'CommandOrControl+Shift+2',
        [ShortcutAction.OpenAgentTask3]: 'CommandOrControl+Shift+3',
        [ShortcutAction.OpenAgentTask4]: 'CommandOrControl+Shift+4',
        [ShortcutAction.OpenAgentTask5]: 'CommandOrControl+Shift+5',
        [ShortcutAction.OpenAgentTask6]: 'CommandOrControl+Shift+6',
        [ShortcutAction.OpenAgentTask7]: 'CommandOrControl+Shift+7',
        [ShortcutAction.OpenAgentTask8]: 'CommandOrControl+Shift+8',
        [ShortcutAction.OpenAgentTask9]: 'CommandOrControl+Shift+9',
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(configService.getConfig().shortcuts?.[ShortcutAction.PreviousAgent]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.NextAgent]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.ShowCurrentAgentTasks]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.OpenAgentTask1]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.OpenAgentTask9]).toBe('');
    expect(savedConfig.shortcuts?.[ShortcutAction.PreviousAgent]).toBe('');
  });

  test('preserves customized agent shortcuts during normalization', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      shortcuts: {
        ...defaultConfig.shortcuts!,
        [ShortcutAction.PreviousAgent]: 'CommandOrControl+Alt+Left',
      },
    };
    const { configService } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    expect(configService.getConfig().shortcuts?.[ShortcutAction.PreviousAgent]).toBe('CommandOrControl+Alt+Left');
  });
});

describe('configService provider migrations', () => {
  test('persists injected provider models during init', async () => {
    const { configService, storeData, setItem } = await loadConfigServiceWithStoredConfig(
      makeLegacyConfigWithoutMiniMaxAddedModels()
    );

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.Minimax].models?.[0]).toMatchObject({
      id: 'MiniMax-M3',
      contextWindow: 1_000_000,
    });
    expect(setItem).toHaveBeenCalledWith(CONFIG_KEYS.APP_CONFIG, expect.any(Object));
  });

  test('preserves injected provider models when saving partial config updates', async () => {
    const legacyConfig = makeLegacyConfigWithoutMiniMaxAddedModels();
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(legacyConfig);

    await configService.updateConfig({
      model: {
        ...legacyConfig.model,
        defaultModel: 'MiniMax-M3',
        defaultModelProvider: ProviderName.Minimax,
      },
    });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.Minimax].models?.map(model => model.id)).toContain('MiniMax-M3');
    expect(savedConfig.model.defaultModel).toBe('MiniMax-M3');
    expect(savedConfig.model.defaultModelProvider).toBe(ProviderName.Minimax);
  });

  test('fills DeepSeek V4 context windows when saving partial config updates', async () => {
    const legacyConfig = makeLegacyConfigWithDeepSeekV4WithoutContextWindow();
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(legacyConfig);

    await configService.updateConfig({
      model: {
        ...legacyConfig.model,
        defaultModel: 'deepseek-v4-flash',
        defaultModelProvider: ProviderName.DeepSeek,
      },
    });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.DeepSeek].models).toEqual([
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
    ]);
  });

  test('preserves old MiMo models while injecting V2.5 models and 1M contexts', async () => {
    const legacyConfig = {
      ...makeLegacyConfigWithOldMimoModels(),
      model: {
        ...defaultConfig.model,
        defaultModel: 'mimo-v2-pro',
        defaultModelProvider: ProviderName.Xiaomi,
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(legacyConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.Xiaomi].models).toEqual([
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', supportsImage: false, contextWindow: 128_000 },
      { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', supportsImage: false, contextWindow: 64_000 },
    ]);
    expect(savedConfig.model.defaultModel).toBe('mimo-v2-pro');
    expect(savedConfig.model.defaultModelProvider).toBe(ProviderName.Xiaomi);
  });

  test('preserves user-configured context windows for known models', async () => {
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(
      makeConfigWithCustomContextWindows()
    );

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.Minimax].models?.find(model => model.id === 'MiniMax-M3')?.contextWindow).toBe(512_000);
    expect(savedConfig.providers?.[ProviderName.Minimax].models?.find(model => model.id === 'MiniMax-M3')?.supportsThinking).toBe(true);
    expect(savedConfig.providers?.[ProviderName.DeepSeek].models?.find(model => model.id === 'deepseek-v4-flash')?.contextWindow).toBe(256_000);
    expect(savedConfig.providers?.[ProviderName.DeepSeek].models?.find(model => model.id === 'deepseek-v4-pro')?.contextWindow).toBe(384_000);
    expect(savedConfig.providers?.[ProviderName.Xiaomi].models?.find(model => model.id === 'mimo-v2.5-pro')?.contextWindow).toBe(640_000);
    expect(savedConfig.providers?.[ProviderName.Xiaomi].models?.find(model => model.id === 'mimo-v2.5')?.contextWindow).toBe(768_000);
    expect(savedConfig.providers?.[ProviderName.Volcengine].models?.find(model => model.id === 'ark-code-latest')?.supportsThinking).toBe(true);
  });

  test('preserves custom model thinking metadata and custom params', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        custom_0: {
          enabled: true,
          apiKey: 'sk-custom',
          baseUrl: 'https://custom.example.com/v1',
          apiFormat: 'openai',
          models: [
            {
              id: 'qwen3.6-plus',
              name: 'Qwen3.6 Plus',
              supportsImage: true,
              supportsThinking: true,
              customParams: { enable_thinking: true },
            },
          ],
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.updateConfig({
      model: {
        ...storedConfig.model,
        defaultModel: 'qwen3.6-plus',
        defaultModelProvider: 'custom_0',
      },
    });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.custom_0.models?.[0]).toMatchObject({
      id: 'qwen3.6-plus',
      supportsImage: true,
      supportsThinking: true,
      customParams: { enable_thinking: true },
    });
  });

  test.each(addedProviderMigrationCases)(
    'does not re-inject a deleted $providerName model after migration is applied',
    async ({ providerName, deletedModelId }) => {
      const { configService, storeData } = await loadConfigServiceWithStoredConfig(
        makeConfigWithDeletedProviderModel(providerName, deletedModelId)
      );

      await configService.init();

      const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
      expect(savedConfig.providers?.[providerName].models?.map(model => model.id)).not.toContain(deletedModelId);
    }
  );

  test('treats a provider with any migrated model as already migrated', async () => {
    const deletedModelId = 'kimi-k2.5';
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providerModelMigrationVersions: undefined,
      providers: {
        ...defaultConfig.providers,
        [ProviderName.Qianfan]: {
          ...defaultConfig.providers![ProviderName.Qianfan],
          enabled: true,
          apiKey: 'sk-qianfan',
          models: defaultConfig.providers![ProviderName.Qianfan].models?.filter(
            model => model.id !== deletedModelId
          ),
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providerModelMigrationVersions?.[ProviderName.Qianfan]).toBe(1);
    expect(savedConfig.providers?.[ProviderName.Qianfan].models?.map(model => model.id)).not.toContain(deletedModelId);
  });

  test('does not re-inject a deleted Xiaomi model after migration is applied', async () => {
    const deletedModelId = 'mimo-v2.5-pro';
    const legacyConfig = makeConfigWithDeletedProviderModel(ProviderName.Xiaomi, deletedModelId);
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(legacyConfig);

    await configService.updateConfig({
      model: {
        ...legacyConfig.model,
        defaultModel: 'mimo-v2.5',
        defaultModelProvider: ProviderName.Xiaomi,
      },
    });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.Xiaomi].models?.map(model => model.id)).not.toContain(deletedModelId);
    expect(savedConfig.model.defaultModel).toBe('mimo-v2.5');
    expect(savedConfig.model.defaultModelProvider).toBe(ProviderName.Xiaomi);
  });

  test('marks provider model migrations when saving provider edits from default config', async () => {
    vi.resetModules();
    const storeData: Record<string, unknown> = {};
    const getItem = vi.fn(async (key: string) => storeData[key] ?? null);
    const setItem = vi.fn(async (key: string, value: unknown) => {
      storeData[key] = value;
    });

    vi.doMock('./store', () => ({
      localStore: {
        getItem,
        setItem,
        removeItem: vi.fn(),
      },
    }));

    (globalThis as unknown as { window?: unknown }).window = {
      dispatchEvent: vi.fn(),
      electron: {
        store: {
          get: getItem,
          set: setItem,
          remove: vi.fn(),
        },
      },
    };

    const { configService } = await import('./config');
    const deletedModelId = 'kimi-k2.5';
    await configService.updateConfig({
      providers: {
        ...defaultConfig.providers,
        [ProviderName.Qianfan]: {
          ...defaultConfig.providers![ProviderName.Qianfan],
          models: defaultConfig.providers![ProviderName.Qianfan].models?.filter(
            model => model.id !== deletedModelId
          ),
        },
      },
    });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providerModelMigrationVersions?.[ProviderName.Qianfan]).toBe(1);
    expect(savedConfig.providers?.[ProviderName.Qianfan].models?.map(model => model.id)).not.toContain(deletedModelId);
  });

  test('hydrates font preferences with defaults for legacy configs', async () => {
    const legacyConfig: AppConfig = {
      ...defaultConfig,
      uiFontSize: undefined,
      codeFontSize: undefined,
    };
    const { configService } = await loadConfigServiceWithStoredConfig(legacyConfig);

    await configService.init();

    expect(configService.getConfig().uiFontSize).toBe(FontPreferences.UiFontSizeDefault);
    expect(configService.getConfig().codeFontSize).toBe(FontPreferences.CodeFontSizeDefault);
  });

  test('clamps font preferences when saving config updates', async () => {
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(defaultConfig);

    await configService.updateConfig({
      uiFontSize: 100,
      codeFontSize: 1,
    });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.uiFontSize).toBe(FontPreferences.UiFontSizeMax);
    expect(savedConfig.codeFontSize).toBe(FontPreferences.CodeFontSizeMin);
  });
});
