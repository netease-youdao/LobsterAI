import { ProviderName } from '@shared/providers';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type AppConfig, CODE_FONT_SIZE_MIGRATION_VERSION, CONFIG_KEYS, defaultConfig, FontPreferences, resolveArtifactAutoPreviewEnabled, ShortcutAction, UI_FONT_SIZE_MIGRATION_VERSION } from '../config';

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
      getItemStrict: getItem,
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

describe('configService initialization failures', () => {
  test('rejects when the strict store read fails so startup can schedule repair', async () => {
    vi.resetModules();
    const storeError = new Error('store IPC unavailable');
    vi.doMock('./store', () => ({
      localStore: {
        getItem: vi.fn(),
        getItemStrict: vi.fn(async () => { throw storeError; }),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };

    const { configService } = await import('./config');

    await expect(configService.init()).rejects.toBe(storeError);
  });

  test('ignores an older init response that resolves after a newer response', async () => {
    vi.resetModules();
    let resolveFirst: ((value: AppConfig) => void) | undefined;
    const firstRead = new Promise<AppConfig>((resolve) => { resolveFirst = resolve; });
    const newerConfig: AppConfig = { ...defaultConfig, language: 'en' };
    const olderConfig: AppConfig = { ...defaultConfig, language: 'zh' };
    const getItemStrict = vi.fn()
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValueOnce(newerConfig);
    vi.doMock('./store', () => ({
      localStore: {
        getItem: getItemStrict,
        getItemStrict,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };
    const { configService } = await import('./config');

    const firstInit = configService.init();
    await configService.init();
    resolveFirst?.(olderConfig);
    await firstInit;

    expect(configService.getConfig().language).toBe('en');
  });

  test('keeps an explicit update when an older init response arrives late', async () => {
    vi.resetModules();
    let resolveInit: ((value: AppConfig) => void) | undefined;
    const initRead = new Promise<AppConfig>((resolve) => { resolveInit = resolve; });
    const storedConfig: AppConfig = { ...defaultConfig, language: 'zh' };
    const getItemStrict = vi.fn()
      .mockImplementationOnce(() => initRead)
      .mockResolvedValueOnce(storedConfig);
    const getItem = vi.fn(async () => storedConfig);
    vi.doMock('./store', () => ({
      localStore: {
        getItem,
        getItemStrict,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };
    const { configService } = await import('./config');

    const pendingInit = configService.init();
    await configService.updateConfig({ language: 'en' });
    resolveInit?.(storedConfig);
    await pendingInit;

    expect(configService.getConfig().language).toBe('en');
  });

  test('does not overwrite persisted config when the update pre-read fails', async () => {
    vi.resetModules();
    const readError = new Error('store IPC unavailable');
    const setItem = vi.fn();
    vi.doMock('./store', () => ({
      localStore: {
        getItem: vi.fn(),
        getItemStrict: vi.fn(async () => { throw readError; }),
        setItem,
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };
    const { configService } = await import('./config');

    await expect(configService.updateConfig({ language: 'en' })).rejects.toBe(readError);

    expect(configService.getConfig()).toEqual(defaultConfig);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('configService theme persistence', () => {
  test('preserves an exact default theme id across partial updates', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      theme: 'dark',
      themeId: 'ocean',
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();
    await configService.updateConfig({ useSystemProxy: true });

    expect(configService.getConfig()).toMatchObject({
      theme: 'dark',
      themeId: 'ocean',
    });
    expect(storeData[CONFIG_KEYS.APP_CONFIG]).toMatchObject({
      theme: 'dark',
      themeId: 'ocean',
    });
  });
});

describe('configService artifact auto-preview persistence', () => {
  test('disables auto-preview only for an explicit false value', () => {
    expect(resolveArtifactAutoPreviewEnabled(false)).toBe(false);
    expect(resolveArtifactAutoPreviewEnabled(true)).toBe(true);
    expect(resolveArtifactAutoPreviewEnabled(undefined)).toBe(true);
    expect(resolveArtifactAutoPreviewEnabled(null)).toBe(true);
  });

  test('defaults legacy configs to auto-preview enabled', async () => {
    const legacyConfig: Partial<AppConfig> = { ...defaultConfig };
    delete legacyConfig.artifactAutoPreviewEnabled;
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(
      legacyConfig as AppConfig,
    );

    await configService.init();

    expect(configService.getConfig().artifactAutoPreviewEnabled).toBe(true);
    expect((storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig).artifactAutoPreviewEnabled).toBe(true);
  });

  test('preserves a disabled auto-preview preference across partial updates', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      artifactAutoPreviewEnabled: false,
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();
    await configService.updateConfig({ useSystemProxy: true });

    expect(configService.getConfig().artifactAutoPreviewEnabled).toBe(false);
    expect((storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig).artifactAutoPreviewEnabled).toBe(false);
  });
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

  test('applies the Moonshot v2 Kimi K3 migration once', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providerModelMigrationVersions: {
        [ProviderName.Moonshot]: 1,
      },
      providers: {
        ...defaultConfig.providers,
        [ProviderName.Moonshot]: {
          ...defaultConfig.providers![ProviderName.Moonshot],
          enabled: true,
          apiKey: 'sk-moonshot',
          models: defaultConfig.providers![ProviderName.Moonshot].models?.filter(
            model => model.id !== 'kimi-k3',
          ),
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.Moonshot].models?.[0]).toEqual({
      id: 'kimi-k3',
      name: 'Kimi K3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });
    expect(savedConfig.providerModelMigrationVersions?.[ProviderName.Moonshot]).toBe(2);
  });

  test('keeps an equivalent user Kimi K3 model without adding a duplicate', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providerModelMigrationVersions: {
        [ProviderName.Moonshot]: 1,
      },
      providers: {
        ...defaultConfig.providers,
        [ProviderName.Moonshot]: {
          ...defaultConfig.providers![ProviderName.Moonshot],
          enabled: true,
          apiKey: 'sk-moonshot',
          models: [
            {
              id: 'Kimi_K3',
              name: 'My Kimi K3',
              supportsImage: false,
              customParams: { service_tier: 'priority' },
            },
            { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsImage: true },
          ],
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    const models = savedConfig.providers?.[ProviderName.Moonshot].models ?? [];
    expect(models.filter(
      model => model.id.toLowerCase().replace(/[^a-z0-9]/g, '') === 'kimik3',
    )).toEqual([
      {
        id: 'Kimi_K3',
        name: 'My Kimi K3',
        supportsImage: true,
        supportsVideo: true,
        supportsThinking: true,
        contextWindow: 1_048_576,
        maxTokens: 1_048_576,
        customParams: { service_tier: 'priority' },
      },
    ]);
    expect(savedConfig.providerModelMigrationVersions?.[ProviderName.Moonshot]).toBe(2);
  });

  test('repairs stale official Kimi K3 capability values after migration', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providerModelMigrationVersions: {
        [ProviderName.Moonshot]: 2,
      },
      providers: {
        ...defaultConfig.providers,
        [ProviderName.Moonshot]: {
          ...defaultConfig.providers![ProviderName.Moonshot],
          enabled: true,
          apiKey: 'sk-moonshot',
          models: [
            {
              id: 'kimi-k3',
              name: 'Kimi K3',
              supportsImage: false,
              supportsVideo: false,
              supportsThinking: false,
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const model = (storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig)
      .providers?.[ProviderName.Moonshot].models?.[0];
    expect(model).toMatchObject({
      id: 'kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });
  });

  test('drops legacy compatibility modes and resolves only the exact Kimi K3 ID', async () => {
    const storedConfig = {
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
              id: 'my-kimi-prod',
              name: 'My Kimi',
              supportsImage: false,
              supportsVideo: false,
              supportsThinking: false,
              contextWindow: 128_000,
              maxTokens: 4_096,
              compatibilityMode: 'moonshot-kimi-k3',
            },
            {
              id: 'kimi-k3',
              name: 'Kimi K3',
              supportsImage: false,
              compatibilityMode: 'standard',
            },
          ],
        },
      },
    } as unknown as AppConfig;
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const models = (storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig).providers?.custom_0.models ?? [];
    expect(models[0]).toMatchObject({
      supportsImage: false,
      supportsVideo: false,
      contextWindow: 128_000,
      maxTokens: 4_096,
    });
    expect(models[0]).not.toHaveProperty('compatibilityMode');
    expect(models[1]).toMatchObject({
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });
    expect(models[1]).not.toHaveProperty('compatibilityMode');
  });

  test('keeps an equivalent user GPT-5.6 Sol model while adding the other GPT-5.6 defaults', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providerModelMigrationVersions: {
        [ProviderName.OpenAI]: 1,
      },
      providers: {
        ...defaultConfig.providers,
        [ProviderName.OpenAI]: {
          ...defaultConfig.providers![ProviderName.OpenAI],
          enabled: true,
          apiKey: 'sk-openai',
          models: [
            {
              id: 'gpt5.6sol',
              name: 'My GPT 5.6 Sol',
              supportsImage: false,
              customParams: { service_tier: 'priority' },
            },
            { id: 'gpt-5.5', name: 'GPT-5.5', supportsImage: true, supportsThinking: true },
          ],
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    const models = savedConfig.providers?.[ProviderName.OpenAI].models ?? [];
    const solModels = models.filter(
      model => model.id.toLowerCase().replace(/[^a-z0-9]/g, '') === 'gpt56sol',
    );
    expect(solModels).toHaveLength(1);
    expect(solModels[0]).toMatchObject({
      id: 'gpt5.6sol',
      name: 'My GPT 5.6 Sol',
      supportsImage: true,
      supportsThinking: true,
      contextWindow: 1_050_000,
      customParams: { service_tier: 'priority' },
    });
    expect(models.map(model => model.id)).toEqual([
      'gpt5.6sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
    expect(savedConfig.providerModelMigrationVersions?.[ProviderName.OpenAI]).toBe(2);
  });

  test('keeps an equivalent user Grok 4.5 model without adding the canonical duplicate', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providerModelMigrationVersions: undefined,
      providers: {
        ...defaultConfig.providers,
        [ProviderName.Xai]: {
          ...defaultConfig.providers![ProviderName.Xai],
          enabled: true,
          apiKey: 'xai-key',
          models: [
            { id: 'grok4.5', name: 'My Grok 4.5', supportsImage: false },
            { id: 'grok-4.3', name: 'Grok 4.3', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
          ],
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    const models = savedConfig.providers?.[ProviderName.Xai].models ?? [];
    expect(models.filter(
      model => model.id.toLowerCase().replace(/[^a-z0-9]/g, '') === 'grok45',
    )).toEqual([
      {
        id: 'grok4.5',
        name: 'My Grok 4.5',
        supportsImage: true,
        supportsThinking: true,
        contextWindow: 500_000,
      },
    ]);
    expect(savedConfig.providerModelMigrationVersions?.[ProviderName.Xai]).toBe(1);
  });

  test('does not re-inject a deleted GPT-5.6 model after migration v2 is applied', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      providerModelMigrationVersions: {
        [ProviderName.OpenAI]: 2,
      },
      providers: {
        ...defaultConfig.providers,
        [ProviderName.OpenAI]: {
          ...defaultConfig.providers![ProviderName.OpenAI],
          models: defaultConfig.providers![ProviderName.OpenAI].models?.filter(
            model => model.id !== 'gpt-5.6-terra',
          ),
        },
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.providers?.[ProviderName.OpenAI].models?.map(model => model.id)).not.toContain('gpt-5.6-terra');
    expect(savedConfig.providerModelMigrationVersions?.[ProviderName.OpenAI]).toBe(2);
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
        getItemStrict: getItem,
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

  test('force-resets stored font sizes to the defaults exactly once', async () => {
    const preMigrationConfig = {
      ...defaultConfig,
      uiFontSize: 12,
      codeFontSize: 10,
    } as AppConfig;
    delete (preMigrationConfig as Partial<AppConfig>).uiFontSizeMigrationVersion;
    delete (preMigrationConfig as Partial<AppConfig>).codeFontSizeMigrationVersion;
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(preMigrationConfig);

    await configService.init();

    expect(configService.getConfig().uiFontSize).toBe(FontPreferences.UiFontSizeDefault);
    expect(configService.getConfig().codeFontSize).toBe(FontPreferences.CodeFontSizeDefault);
    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.uiFontSize).toBe(FontPreferences.UiFontSizeDefault);
    expect(savedConfig.uiFontSizeMigrationVersion).toBe(UI_FONT_SIZE_MIGRATION_VERSION);
    expect(savedConfig.codeFontSize).toBe(FontPreferences.CodeFontSizeDefault);
    expect(savedConfig.codeFontSizeMigrationVersion).toBe(CODE_FONT_SIZE_MIGRATION_VERSION);
  });

  test('keeps the stored font sizes once the forced reset has been applied', async () => {
    const migratedConfig: AppConfig = {
      ...defaultConfig,
      uiFontSize: 12,
      uiFontSizeMigrationVersion: UI_FONT_SIZE_MIGRATION_VERSION,
      codeFontSize: 10,
      codeFontSizeMigrationVersion: CODE_FONT_SIZE_MIGRATION_VERSION,
    };
    const { configService } = await loadConfigServiceWithStoredConfig(migratedConfig);

    await configService.init();

    expect(configService.getConfig().uiFontSize).toBe(12);
    expect(configService.getConfig().codeFontSize).toBe(10);
  });

  test('preserves user font size changes made after the forced reset', async () => {
    const preMigrationConfig = {
      ...defaultConfig,
      uiFontSize: 12,
      codeFontSize: 10,
    } as AppConfig;
    delete (preMigrationConfig as Partial<AppConfig>).uiFontSizeMigrationVersion;
    delete (preMigrationConfig as Partial<AppConfig>).codeFontSizeMigrationVersion;
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(preMigrationConfig);

    await configService.init();
    await configService.updateConfig({ uiFontSize: 13, codeFontSize: 16 });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.uiFontSize).toBe(13);
    expect(savedConfig.uiFontSizeMigrationVersion).toBe(UI_FONT_SIZE_MIGRATION_VERSION);
    expect(savedConfig.codeFontSize).toBe(16);
    expect(savedConfig.codeFontSizeMigrationVersion).toBe(CODE_FONT_SIZE_MIGRATION_VERSION);

    const { configService: restartedService } = await loadConfigServiceWithStoredConfig(savedConfig);
    await restartedService.init();
    expect(restartedService.getConfig().uiFontSize).toBe(13);
    expect(restartedService.getConfig().codeFontSize).toBe(16);
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
