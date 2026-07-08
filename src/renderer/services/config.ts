import { ApiFormat, type ProviderConfig, ProviderName, ProviderRegistry } from '@shared/providers';

import { normalizeBrowserWebAccessConfig } from '../../shared/browserWebAccess/constants';
import { normalizeNotificationSettings } from '../../shared/notifications/constants';
import {
  AppConfig,
  CONFIG_KEYS,
  defaultConfig,
  FontPreferences,
  isCustomProvider,
  normalizeFontPreference,
  ShortcutAction,
  type ShortcutConfig,
} from '../config';
import { localStore } from './store';

type ProviderModel = NonNullable<ProviderConfig['models']>[number];

const getFixedProviderApiFormat = (providerKey: string): ApiFormat | null => {
  const def = ProviderRegistry.get(providerKey);
  if (def && !def.switchableBaseUrls) {
    return def.defaultApiFormat;
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

  // Strip the /openai suffix for native Gemini API
  if (normalized.endsWith('/v1beta/openai')) {
    return normalized.slice(0, -'/openai'.length);
  }
  if (normalized.endsWith('/v1/openai')) {
    return normalized.slice(0, -'/openai'.length);
  }
  if (normalized.endsWith('/v1beta')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}v1beta`;
  }

  return 'https://generativelanguage.googleapis.com/v1beta';
};

const normalizeProviderApiFormat = (providerKey: string, apiFormat: unknown): 'anthropic' | 'openai' | 'gemini' => {
  const fixed = getFixedProviderApiFormat(providerKey);
  if (fixed) {
    return fixed;
  }
  if (apiFormat === ApiFormat.OpenAI) {
    return ApiFormat.OpenAI;
  }
  return ApiFormat.Anthropic;
};

const normalizeProviderModels = (
  providerKey: string,
  models: ProviderConfig['models'],
): ProviderConfig['models'] => models?.map(model => {
  const contextWindow = ProviderRegistry.resolveModelContextWindow(
    providerKey,
    model.id,
    model.contextWindow,
  );
  const supportsThinking = ProviderRegistry.resolveModelSupportsThinking(
    providerKey,
    model.id,
    model.supportsThinking,
  );
  return {
    ...model,
    supportsImage: ProviderRegistry.resolveModelSupportsImage(
      providerKey,
      model.id,
      model.supportsImage,
    ),
    ...(supportsThinking ? { supportsThinking } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
});

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
        models: normalizeProviderModels(providerKey, providerConfig.models),
      },
    ])
  ) as AppConfig['providers'];
};

const legacyShortcutDefaults: Partial<Record<ShortcutAction, string[]>> = {
  [ShortcutAction.NewChat]: ['Ctrl+N'],
  [ShortcutAction.Search]: ['Ctrl+F'],
  [ShortcutAction.Settings]: ['Ctrl+,'],
  [ShortcutAction.ShowShortcuts]: ['Ctrl+/'],
  [ShortcutAction.FocusPrompt]: ['Ctrl+K'],
  [ShortcutAction.StopCurrentTask]: ['Ctrl+.'],
  [ShortcutAction.ToggleSidebar]: ['Ctrl+B'],
  [ShortcutAction.ToggleArtifacts]: ['Ctrl+Shift+B'],
  [ShortcutAction.PreviousAgent]: ['Ctrl+Alt+Left', 'CommandOrControl+Shift+['],
  [ShortcutAction.NextAgent]: ['Ctrl+Alt+Right', 'CommandOrControl+Shift+]'],
  [ShortcutAction.ShowCurrentAgentTasks]: ['Ctrl+Alt+H', 'CommandOrControl+Shift+H'],
  [ShortcutAction.OpenAgentTask1]: ['Ctrl+Alt+1', 'CommandOrControl+Shift+1'],
  [ShortcutAction.OpenAgentTask2]: ['Ctrl+Alt+2', 'CommandOrControl+Shift+2'],
  [ShortcutAction.OpenAgentTask3]: ['Ctrl+Alt+3', 'CommandOrControl+Shift+3'],
  [ShortcutAction.OpenAgentTask4]: ['Ctrl+Alt+4', 'CommandOrControl+Shift+4'],
  [ShortcutAction.OpenAgentTask5]: ['Ctrl+Alt+5', 'CommandOrControl+Shift+5'],
  [ShortcutAction.OpenAgentTask6]: ['Ctrl+Alt+6', 'CommandOrControl+Shift+6'],
  [ShortcutAction.OpenAgentTask7]: ['Ctrl+Alt+7', 'CommandOrControl+Shift+7'],
  [ShortcutAction.OpenAgentTask8]: ['Ctrl+Alt+8', 'CommandOrControl+Shift+8'],
  [ShortcutAction.OpenAgentTask9]: ['Ctrl+Alt+9', 'CommandOrControl+Shift+9'],
  [ShortcutAction.OpenCowork]: ['Ctrl+1'],
  [ShortcutAction.OpenScheduledTasks]: ['Ctrl+2'],
  [ShortcutAction.OpenKits]: ['Ctrl+3'],
  [ShortcutAction.OpenSkills]: ['Ctrl+4'],
  [ShortcutAction.OpenMcp]: ['Ctrl+5'],
};

const normalizeShortcutsConfig = (storedShortcuts?: AppConfig['shortcuts']): ShortcutConfig => {
  const shortcuts = {
    ...defaultConfig.shortcuts!,
    ...(storedShortcuts ?? {}),
  } as ShortcutConfig;

  if (!storedShortcuts) {
    return shortcuts;
  }

  Object.values(ShortcutAction).forEach((action) => {
    if (legacyShortcutDefaults[action]?.includes(storedShortcuts[action] ?? '')) {
      shortcuts[action] = defaultConfig.shortcuts![action];
    }
  });

  return shortcuts;
};

const LEGACY_PROVIDER_API_FORMAT_DEFAULTS: Record<string, {
  fromBaseUrl: string;
  fromApiFormat: typeof ApiFormat.Anthropic;
  toBaseUrl: string;
  toApiFormat: typeof ApiFormat.OpenAI;
}> = {
  [ProviderName.DeepSeek]: {
    fromBaseUrl: 'https://api.deepseek.com/anthropic',
    fromApiFormat: ApiFormat.Anthropic,
    toBaseUrl: 'https://api.deepseek.com',
    toApiFormat: ApiFormat.OpenAI,
  },
  [ProviderName.Xiaomi]: {
    fromBaseUrl: 'https://api.xiaomimimo.com/anthropic',
    fromApiFormat: ApiFormat.Anthropic,
    toBaseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    toApiFormat: ApiFormat.OpenAI,
  },
};

const migrateProviderDefaultApiFormat = (
  providerKey: string,
  providerConfig: Record<string, unknown>,
): Record<string, unknown> => {
  const migration = LEGACY_PROVIDER_API_FORMAT_DEFAULTS[providerKey];
  if (!migration) {
    return providerConfig;
  }

  const normalizedBaseUrl = normalizeProviderBaseUrl(providerKey, providerConfig.baseUrl);
  if (
    normalizedBaseUrl !== migration.fromBaseUrl
    || (
      providerConfig.apiFormat !== undefined
      && providerConfig.apiFormat !== migration.fromApiFormat
    )
  ) {
    return providerConfig;
  }

  return {
    ...providerConfig,
    baseUrl: migration.toBaseUrl,
    apiFormat: migration.toApiFormat,
  };
};

/**
 * Migrate legacy single `custom` provider to `custom_0`.
 */
const migrateCustomProviders = (config: AppConfig): AppConfig => {
  const providers = config.providers;
  if (!providers) return config;

  // Migrate legacy `custom` key (without underscore) to `custom_0`
  if ('custom' in providers && !isCustomProvider('custom')) {
    const legacyCustom = providers['custom'];
    if (legacyCustom) {
      const updatedProviders = { ...providers } as Record<string, unknown>;
      updatedProviders['custom_0'] = { ...legacyCustom };
      delete updatedProviders['custom'];
      return {
        ...config,
        providers: updatedProviders as AppConfig['providers'],
      };
    }
  }

  return config;
};

// Model IDs that have been removed from specific providers.
// These will be filtered out from saved configs during migration.
const REMOVED_PROVIDER_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-chat'],
  qwen: ['qwen3-coder-plus'],
  youdaozhiyun: ['deepseek-chat', 'deepseek-inhouse-chat'],
  qianfan: ['deepseek-v3.2', 'deepseek-r1', 'ernie-4.5-8k', 'ernie-4.5-turbo-8k'],
  openai: ['gpt-5.2-2025-12-11', 'gpt-5.2', 'gpt-5.3-codex', 'gpt-5.2-codex'],
  gemini: ['gemini-3-pro-preview'],
  anthropic: ['claude-sonnet-4-5-20250929'],
  openrouter: [
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-opus-4.6',
    'openai/gpt-5.2-codex',
    'google/gemini-3-pro-preview',
  ],
};

// Models to inject into existing saved configs once per migration version.
// After the migration marker is persisted, user edits to these model lists
// must be respected across restarts.
// position: 'start' inserts at the beginning, 'end' appends at the end.
const ADDED_PROVIDER_MODELS_MIGRATION_VERSION = 1;
const ADDED_PROVIDER_MODELS: Record<string, { models: ProviderModel[]; position: 'start' | 'end' }> = {
  deepseek: {
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, supportsThinking: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, supportsThinking: true },
    ],
    position: 'start',
  },
  moonshot: {
    models: [
      { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsImage: true, supportsThinking: true },
    ],
    position: 'start',
  },
  minimax: {
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false },
    ],
    position: 'start',
  },
  zhipu: {
    models: [
      { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, supportsThinking: true },
    ],
    position: 'start',
  },
  qianfan: {
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: false },
      { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, supportsThinking: true },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5', supportsImage: false },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, supportsThinking: true },
      { id: 'ernie-4.5-turbo-20260402', name: 'ERNIE 4.5 Turbo', supportsImage: false },
    ],
    position: 'start',
  },
  [ProviderName.Xiaomi]: {
    models: [
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
    ],
    position: 'start',
  },
  openai: {
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true, supportsThinking: true },
      { id: 'gpt-5.5', name: 'GPT-5.5', supportsImage: true, supportsThinking: true },
    ],
    position: 'start',
  },
  gemini: {
    models: [
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', supportsImage: true, supportsThinking: true },
    ],
    position: 'end',
  },
  anthropic: {
    models: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, supportsThinking: true },
    ],
    position: 'start',
  },
  openrouter: {
    models: [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', supportsImage: true, supportsThinking: true },
      { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', supportsImage: true, supportsThinking: true },
      { id: 'openai/gpt-5.5', name: 'GPT 5.5', supportsImage: true, supportsThinking: true },
      { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, supportsThinking: true },
    ],
    position: 'start',
  },
};

const markCurrentProviderModelMigrationsApplied = (
  versions: AppConfig['providerModelMigrationVersions'],
): NonNullable<AppConfig['providerModelMigrationVersions']> => {
  const nextVersions = { ...(versions ?? {}) };
  Object.keys(ADDED_PROVIDER_MODELS).forEach((providerKey) => {
    nextVersions[providerKey] = Math.max(
      nextVersions[providerKey] ?? 0,
      ADDED_PROVIDER_MODELS_MIGRATION_VERSION,
    );
  });
  return nextVersions;
};

const getNewlyAppliedProviderModelMigrations = (
  previousVersions: AppConfig['providerModelMigrationVersions'],
  nextVersions: AppConfig['providerModelMigrationVersions'],
): string[] => Object.keys(ADDED_PROVIDER_MODELS).filter(
  providerKey => (previousVersions?.[providerKey] ?? 0) < ADDED_PROVIDER_MODELS_MIGRATION_VERSION
    && (nextVersions?.[providerKey] ?? 0) >= ADDED_PROVIDER_MODELS_MIGRATION_VERSION
);

const PROVIDER_MODEL_CONTEXT_WINDOW_OVERRIDES: Record<string, Record<string, number>> = {
  [ProviderName.Minimax]: {
    'MiniMax-M3': 1_000_000,
  },
  [ProviderName.Xiaomi]: {
    'mimo-v2.5-pro': 1_000_000,
    'mimo-v2.5': 1_000_000,
  },
};

const applyProviderModelContextWindowOverrides = (
  providerKey: string,
  models: ProviderConfig['models'],
): ProviderConfig['models'] => {
  const overrides = PROVIDER_MODEL_CONTEXT_WINDOW_OVERRIDES[providerKey];
  if (!models || !overrides) {
    return models;
  }

  return models.map(model => {
    const contextWindow = overrides[model.id];
    if (
      contextWindow === undefined
      || (typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow) && model.contextWindow > 0)
    ) {
      return model;
    }
    return { ...model, contextWindow };
  });
};

const REORDER_PROVIDER_MODELS = new Set([
  'qwen',
  'zhipu',
  'youdaozhiyun',
  'qianfan',
  'openai',
  'gemini',
  'anthropic',
  'openrouter',
]);

const alignProviderModelOrder = (
  providerKey: string,
  models: ProviderConfig['models'],
): ProviderConfig['models'] => {
  if (!models || !REORDER_PROVIDER_MODELS.has(providerKey)) {
    return models;
  }

  const defaultModels = defaultConfig.providers?.[providerKey]?.models;
  if (!defaultModels?.length) {
    return models;
  }

  const defaultOrder = new Map(defaultModels.map((model, index) => [model.id, index]));
  return [...models].sort((a, b) => {
    const aOrder = defaultOrder.get(a.id);
    const bOrder = defaultOrder.get(b.id);
    if (aOrder === undefined && bOrder === undefined) return 0;
    if (aOrder === undefined) return 1;
    if (bOrder === undefined) return -1;
    return aOrder - bOrder;
  });
};

const omitLegacyVoiceInputConfig = (config: AppConfig): AppConfig => {
  const { voiceInput: _legacyVoiceInput, ...nextConfig } = config as AppConfig & {
    voiceInput?: unknown;
  };
  return nextConfig;
};

const hydrateStoredConfig = (storedConfig: AppConfig): AppConfig => {
  const storedWithoutLegacyVoiceInput = omitLegacyVoiceInputConfig(storedConfig);
  const providerModelMigrationVersions = {
    ...(storedConfig.providerModelMigrationVersions ?? {}),
  };
  const mergedProviders = storedConfig.providers
    ? Object.fromEntries(
        Object.entries({
          ...(defaultConfig.providers ?? {}),
          ...storedConfig.providers,
        }).map(([providerKey, providerConfig]) => [
          providerKey,
          (() => {
            const mergedProvider = {
              ...((defaultConfig.providers as Record<string, unknown>)?.[providerKey] as Record<string, unknown> ?? {}),
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
            const existingIds = new Set(
              (mergedProvider.models as Array<{ id: string }> | undefined)?.map(model => model.id) ?? []
            );
            const hasAnyAddedModel = addedConfig?.models.some(model => existingIds.has(model.id)) ?? false;
            const hasAppliedAddedModelsMigration =
              (providerModelMigrationVersions[providerKey] ?? 0) >= ADDED_PROVIDER_MODELS_MIGRATION_VERSION
              || hasAnyAddedModel;
            if (addedConfig && mergedProvider.models && !hasAppliedAddedModelsMigration) {
              const newModels = addedConfig.models.filter(m => !existingIds.has(m.id));
              if (newModels.length > 0) {
                mergedProvider.models = addedConfig.position === 'start'
                  ? [...newModels, ...mergedProvider.models]
                  : [...mergedProvider.models, ...newModels];
              }
            }
            if (addedConfig && mergedProvider.models) {
              providerModelMigrationVersions[providerKey] = ADDED_PROVIDER_MODELS_MIGRATION_VERSION;
            }
            if (mergedProvider.models) {
              mergedProvider.models = applyProviderModelContextWindowOverrides(
                providerKey,
                mergedProvider.models as ProviderConfig['models'],
              );
              mergedProvider.models = alignProviderModelOrder(
                providerKey,
                mergedProvider.models as ProviderConfig['models'],
              );
            }
            const migratedProvider = migrateProviderDefaultApiFormat(providerKey, mergedProvider);
            return {
              ...migratedProvider,
              baseUrl: normalizeProviderBaseUrl(providerKey, migratedProvider.baseUrl),
              apiFormat: normalizeProviderApiFormat(providerKey, migratedProvider.apiFormat),
              models: normalizeProviderModels(
                providerKey,
                migratedProvider.models as ProviderConfig['models'],
              ),
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

  return migrateCustomProviders({
    ...defaultConfig,
    ...storedWithoutLegacyVoiceInput,
    api: {
      ...defaultConfig.api,
      ...storedConfig.api,
    },
    model: migratedModel,
    app: {
      ...defaultConfig.app,
      ...storedConfig.app,
    },
    shortcuts: normalizeShortcutsConfig(storedConfig.shortcuts),
    providers: mergedProviders as AppConfig['providers'],
    providerModelMigrationVersions,
    uiFontSize: normalizeFontPreference(
      storedConfig.uiFontSize,
      FontPreferences.UiFontSizeDefault,
      FontPreferences.UiFontSizeMin,
      FontPreferences.UiFontSizeMax,
    ),
    codeFontSize: normalizeFontPreference(
      storedConfig.codeFontSize,
      FontPreferences.CodeFontSizeDefault,
      FontPreferences.CodeFontSizeMin,
      FontPreferences.CodeFontSizeMax,
    ),
    browserWebAccess: normalizeBrowserWebAccessConfig(storedConfig.browserWebAccess),
    notificationSettings: normalizeNotificationSettings(storedConfig.notificationSettings),
  });
};

class ConfigService {
  private config: AppConfig = defaultConfig;

  async init() {
    try {
      const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
      if (!storedConfig) {
        console.warn('[ConfigService] init: no stored config found, using defaults');
      }
      if (storedConfig) {
        const previousMigrationVersions = storedConfig.providerModelMigrationVersions;
        this.config = hydrateStoredConfig(storedConfig);
        if (JSON.stringify(this.config) !== JSON.stringify(storedConfig)) {
          try {
            await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
            const appliedProviders = getNewlyAppliedProviderModelMigrations(
              previousMigrationVersions,
              this.config.providerModelMigrationVersions,
            );
            if (appliedProviders.length > 0) {
              console.log(`[ConfigService] applied provider model migrations for ${appliedProviders.join(', ')}`);
            }
          } catch (persistError) {
            console.warn('[ConfigService] init: failed to persist migrated config:', persistError);
          }
        }
      }
    } catch (error) {
      console.error('[ConfigService] init failed:', error);
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const normalizedProviders = normalizeProvidersConfig(newConfig.providers as AppConfig['providers'] | undefined);

    // Read-modify-write: use the latest stored value as the base to avoid
    // overwriting fields (e.g. providers) with stale in-memory defaults when
    // only a subset of config is being updated.
    const stored = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
    const base = stored ? hydrateStoredConfig(stored) : this.config;

    this.config = omitLegacyVoiceInputConfig({
      ...base,
      ...newConfig,
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
      ...(normalizedProviders
        ? { providerModelMigrationVersions: markCurrentProviderModelMigrationsApplied(base.providerModelMigrationVersions) }
        : {}),
      uiFontSize: normalizeFontPreference(
        newConfig.uiFontSize ?? base.uiFontSize,
        FontPreferences.UiFontSizeDefault,
        FontPreferences.UiFontSizeMin,
        FontPreferences.UiFontSizeMax,
      ),
      codeFontSize: normalizeFontPreference(
        newConfig.codeFontSize ?? base.codeFontSize,
        FontPreferences.CodeFontSizeDefault,
        FontPreferences.CodeFontSizeMin,
        FontPreferences.CodeFontSizeMax,
      ),
      browserWebAccess: normalizeBrowserWebAccessConfig(
        newConfig.browserWebAccess ?? base.browserWebAccess,
      ),
      notificationSettings: normalizeNotificationSettings(
        newConfig.notificationSettings ?? base.notificationSettings,
      ),
    } as AppConfig);
    await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
    window.dispatchEvent(new CustomEvent('config-updated'));
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService(); 
