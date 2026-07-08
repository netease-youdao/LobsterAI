import { ArchiveBoxIcon, ArrowPathIcon, ArrowPathRoundedSquareIcon, ChatBubbleLeftIcon, CheckCircleIcon, CpuChipIcon, CubeIcon, EnvelopeIcon, ExclamationTriangleIcon, GlobeAltIcon, InformationCircleIcon, MagnifyingGlassIcon, SignalIcon, SunIcon, TrashIcon, WrenchScrewdriverIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback,useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { AppSettingsAutoLaunchErrorCode } from '../../shared/appSettings/constants';
import { type AppUpdateInfo,type AppUpdateRuntimeState,AppUpdateSource,AppUpdateStatus } from '../../shared/appUpdate/constants';
import {
  type BrowserWebAccessConfig,
  defaultBrowserWebAccessConfig,
  normalizeBrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';
import { DataMigrationRestoreStatus } from '../../shared/dataMigration/constants';
import { normalizeNotificationSettings } from '../../shared/notifications/constants';
import { OpenClawEnginePhase, OpenClawGatewayRepairErrorCode } from '../../shared/openclawEngine/constants';
import { ProviderAuthType, ProviderName, ProviderRegistry, resolveCodingPlanBaseUrl } from '../../shared/providers';
import { type AppConfig, defaultConfig, FontPreferences, getProviderDisplayName, getVisibleProviders, normalizeFontPreference, ShortcutAction, type ShortcutConfig } from '../config';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import { apiService } from '../services/api';
import { configService } from '../services/config';
import { coworkService } from '../services/cowork';
import { decryptSecret, decryptWithPassword, EncryptedPayload, encryptWithPassword, PasswordEncryptedPayload } from '../services/encryption';
import { i18nService, LanguageType } from '../services/i18n';
import { imService } from '../services/im';
import { LogReporterAction, reportYdAnalyzer } from '../services/logReporter';
import { formatShortcutForDisplay, getShortcutConflictSignature, matchesShortcut } from '../services/shortcuts';
import { themeService } from '../services/theme';
import { applyTypographyPreferences } from '../services/typography';
import type { RootState } from '../store';
import { selectCoworkConfig } from '../store/selectors/coworkSelectors';
import { setAvailableModels } from '../store/slices/modelSlice';
import type {
  CoworkAgentEngine,
  CoworkMemoryStats,
  CoworkUserMemoryEntry,
  OpenClawEngineStatus,
  OpenClawGatewayRepairResult,
  OpenClawSessionKeepAlive,
} from '../types/cowork';
import { OpenClawSessionKeepAlive as OpenClawSessionKeepAliveValues } from '../types/cowork';
import Modal from './common/Modal';
import DreamingSettingsSection from './cowork/DreamingSettingsSection';
import EmbeddingSettingsSection from './cowork/EmbeddingSettingsSection';
import ErrorMessage from './ErrorMessage';
import BrainIcon from './icons/BrainIcon';
import EditIcon from './icons/EditIcon';
import MessageCopyIcon from './icons/MessageCopyIcon';
import PlugIcon from './icons/PlugIcon';
import PlusCircleIcon from './icons/PlusCircleIcon';
import IMSettings from './im/IMSettings';
import PluginsSettings, { type PluginPendingChanges, type PluginsSettingsHandle } from './plugins/PluginsSettings';
import BrowserWebAccessSettings from './settings/BrowserWebAccessSettings';
import {
  buildOpenAICompatibleChatCompletionsUrl,
  buildOpenAIResponsesUrl,
  CONNECTIVITY_TEST_TOKEN_BUDGET,
  CUSTOM_PROVIDER_KEYS,
  getDefaultActiveProvider,
  getDefaultProviders,
  getEffectiveApiFormat,
  getOpenClawProviderIdForConfig,
  getProviderDefaultBaseUrl,
  hasProviderAuthConfigured,
  type Model,
  type ProviderConfig,
  providerKeys,
  providerRequiresApiKey,
  type ProvidersConfig,
  type ProviderType,
  resolveBaseUrl,
  resolveModelSupportsImageForProvider,
  shouldAutoSwitchProviderBaseUrl,
  shouldUseMaxCompletionTokensForOpenAI,
  shouldUseOpenAIResponsesForProvider,
} from './settings/modelProviderUtils';
import ModelSettingsSection, { DeleteProviderConfirmDialog, ModelEditorDialog } from './settings/ModelSettingsSection';
import EmailSkillConfig from './skills/EmailSkillConfig';
import ThemedSelect from './ui/ThemedSelect';

type TabType = 'general' | 'appearance' | 'coworkAgentEngine' | 'model' | 'browserWebAccess' | 'coworkMemory' | 'coworkDreaming' | 'shortcuts' | 'im' | 'email' | 'plugins' | 'about';

const waitForNextPaint = (): Promise<void> => new Promise(resolve => {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => resolve());
  });
});

const getAutoLaunchErrorMessage = (errorCode?: string): string => {
  if (errorCode === AppSettingsAutoLaunchErrorCode.RequiresApproval) {
    return i18nService.t('autoLaunchRequiresApproval');
  }
  if (errorCode === AppSettingsAutoLaunchErrorCode.UpdateFailed) {
    return i18nService.t('autoLaunchUpdateFailed');
  }
  return i18nService.t('autoLaunchUpdateFailed');
};

const formatBackupSize = (sizeBytes?: number): string => {
  if (!Number.isFinite(sizeBytes) || !sizeBytes || sizeBytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const normalizeProvidersForSettingsSave = (providers: ProvidersConfig): ProvidersConfig => (
  Object.fromEntries(
    Object.entries(providers).map(([providerKey, providerConfig]) => {
      const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
      const hasValidAuth = hasProviderAuthConfigured(providerKey as ProviderType, providerConfig);
      return [
        providerKey,
        {
          ...providerConfig,
          enabled: providerConfig.enabled && hasValidAuth,
          apiFormat,
          ...(providerKey === ProviderName.Copilot ? { apiKey: '' } : {}),
          baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
        },
      ];
    })
  ) as ProvidersConfig
);

const resolvePrimaryProviderForSettingsSave = (
  providers: ProvidersConfig,
  activeProvider: ProviderType,
): ProviderConfig => {
  const firstEnabledProvider = Object.entries(providers).find(
    ([_, config]) => config.enabled
  );
  return firstEnabledProvider
    ? firstEnabledProvider[1]
    : providers[activeProvider];
};

type ShortcutCommandDefinition = {
  key: ShortcutAction;
  labelKey: string;
  descriptionKey: string;
  inputType?: 'recorder' | 'send';
  slot?: number;
  tabLabelKey?: string;
};

const SETTINGS_TAB_SHORTCUT_ACTIONS: Partial<Record<ShortcutAction, TabType>> = {
  [ShortcutAction.OpenSettingsGeneral]: 'general',
  [ShortcutAction.OpenSettingsAppearance]: 'appearance',
  [ShortcutAction.OpenSettingsAgentEngine]: 'coworkAgentEngine',
  [ShortcutAction.OpenSettingsModel]: 'model',
  [ShortcutAction.OpenSettingsIm]: 'im',
  [ShortcutAction.OpenSettingsBrowser]: 'browserWebAccess',
  [ShortcutAction.OpenSettingsEmail]: 'email',
  [ShortcutAction.OpenSettingsMemory]: 'coworkMemory',
  [ShortcutAction.OpenSettingsDreaming]: 'coworkDreaming',
  [ShortcutAction.OpenSettingsPlugins]: 'plugins',
  [ShortcutAction.OpenSettingsShortcuts]: 'shortcuts',
  [ShortcutAction.OpenSettingsAbout]: 'about',
};

const SettingsAnalyticsSource = {
  AgentEngine: 'settings_agent_engine',
  Appearance: 'settings_appearance',
  Browser: 'settings_browser',
  Dreaming: 'settings_dreaming',
  General: 'settings_general',
  Memory: 'settings_memory',
  Model: 'settings_model',
  Plugins: 'settings_plugins',
  Shortcuts: 'settings_shortcuts',
  About: 'settings_about',
} as const;

type SettingsAnalyticsValue = string | boolean | number;
type ProviderAnalyticsKind = 'builtin' | 'custom' | 'local';

type MemorySettingAnalyticsSummary = {
  changedKeys: string;
  embeddingEnabled: boolean;
  embeddingProvider: string;
  embeddingVectorWeight: number;
  hasEmbeddingApiKey: boolean;
  hasEmbeddingBaseUrl: boolean;
  hasEmbeddingModel: boolean;
  memoryEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
};

type DreamingSettingAnalyticsSummary = {
  changedKeys: string;
  dreamingEnabled: boolean;
  frequencyType: 'preset' | 'custom';
};

type ShortcutSettingAnalyticsSummary = {
  changedCount: number;
  configuredCount: number;
  disabledCount: number;
  resetToDefault: boolean;
};

type PluginSettingsAnalyticsSummary = {
  changedKeys: string;
  configCount: number;
  disabledToggleCount: number;
  enabledToggleCount: number;
  toggleCount: number;
};

const DREAMING_FREQUENCY_PRESETS_FOR_ANALYTICS = new Set([
  '0 3 * * *',
  '0 0 * * *',
  '0 0,12 * * *',
  '0 */6 * * *',
  '0 3 * * 0',
]);

type CustomModelSettingsAnalyticsSummary = {
  changedKeys: string;
  changedProviderCount: number;
  customProviderCount: number;
  customProviderModelCount: number;
  enabledCustomProviderCount: number;
  enabledProviderCount: number;
  hasCodingPlanEnabled: boolean;
  hasLocalProviderEnabled: boolean;
  modelCount: number;
};

const isCustomProviderKey = (providerKey: string): boolean => (
  (CUSTOM_PROVIDER_KEYS as readonly string[]).includes(providerKey)
);

const isLocalProviderKey = (providerKey: string): boolean => (
  providerKey === ProviderName.Ollama || providerKey === ProviderName.LmStudio
);

const resolveProviderAnalyticsKind = (providerKey: string): ProviderAnalyticsKind => {
  if (isCustomProviderKey(providerKey)) {
    return 'custom';
  }
  if (isLocalProviderKey(providerKey)) {
    return 'local';
  }
  return 'builtin';
};

const countProviderModels = (providerConfig?: ProviderConfig): number => (
  Array.isArray(providerConfig?.models) ? providerConfig.models.length : 0
);

const sortAnalyticsObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortAnalyticsObject);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortAnalyticsObject((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }
  return value;
};

const serializeProviderModelsForAnalyticsDiff = (providerConfig?: ProviderConfig): string => (
  JSON.stringify((providerConfig?.models ?? []).map(model => ({
    contextWindow: model.contextWindow,
    customParams: sortAnalyticsObject(model.customParams),
    id: model.id,
    name: model.name,
    supportsImage: model.supportsImage === true,
    supportsThinking: model.supportsThinking === true,
  })))
);

const getProviderAuthTypeForAnalytics = (providerConfig?: ProviderConfig): string => (
  providerConfig?.authType || ProviderAuthType.ApiKey
);

const getProviderApiFormatForAnalytics = (providerKey: string, providerConfig?: ProviderConfig): string => (
  getEffectiveApiFormat(providerKey, providerConfig?.apiFormat)
);

const buildCustomModelSettingsAnalyticsSummary = (
  previousProviders: ProvidersConfig,
  nextProviders: ProvidersConfig,
): CustomModelSettingsAnalyticsSummary | null => {
  const changedKeys = new Set<string>();
  const changedProviders = new Set<string>();
  const providerKeysForDiff = new Set([
    ...Object.keys(previousProviders),
    ...Object.keys(nextProviders),
  ]);

  providerKeysForDiff.forEach(providerKey => {
    const previousProvider = previousProviders[providerKey];
    const nextProvider = nextProviders[providerKey];

    if (!previousProvider || !nextProvider) {
      changedKeys.add('provider_count');
      changedProviders.add(providerKey);
      return;
    }

    let providerChanged = false;
    if ((previousProvider.enabled === true) !== (nextProvider.enabled === true)) {
      changedKeys.add('provider_enabled');
      providerChanged = true;
    }
    if (getProviderApiFormatForAnalytics(providerKey, previousProvider) !== getProviderApiFormatForAnalytics(providerKey, nextProvider)) {
      changedKeys.add('api_format');
      providerChanged = true;
    }
    if (((previousProvider as ProviderConfig).codingPlanEnabled === true) !== ((nextProvider as ProviderConfig).codingPlanEnabled === true)) {
      changedKeys.add('coding_plan');
      providerChanged = true;
    }
    if (getProviderAuthTypeForAnalytics(previousProvider) !== getProviderAuthTypeForAnalytics(nextProvider)) {
      changedKeys.add('auth_type');
      providerChanged = true;
    }
    if (countProviderModels(previousProvider) !== countProviderModels(nextProvider)) {
      changedKeys.add('model_count');
      providerChanged = true;
    }
    if (serializeProviderModelsForAnalyticsDiff(previousProvider) !== serializeProviderModelsForAnalyticsDiff(nextProvider)) {
      changedKeys.add('model_config');
      providerChanged = true;
    }

    if (providerChanged) {
      changedProviders.add(providerKey);
    }
  });

  if (changedKeys.size === 0) {
    return null;
  }

  const nextProviderEntries = Object.entries(nextProviders);
  return {
    changedKeys: Array.from(changedKeys).sort().join(','),
    changedProviderCount: changedProviders.size,
    customProviderCount: nextProviderEntries.filter(([providerKey]) => isCustomProviderKey(providerKey)).length,
    customProviderModelCount: nextProviderEntries
      .filter(([providerKey]) => isCustomProviderKey(providerKey))
      .reduce((count, [, providerConfig]) => count + countProviderModels(providerConfig), 0),
    enabledCustomProviderCount: nextProviderEntries
      .filter(([providerKey, providerConfig]) => isCustomProviderKey(providerKey) && providerConfig.enabled === true)
      .length,
    enabledProviderCount: nextProviderEntries.filter(([, providerConfig]) => providerConfig.enabled === true).length,
    hasCodingPlanEnabled: nextProviderEntries.some(([, providerConfig]) => (providerConfig as ProviderConfig).codingPlanEnabled === true),
    hasLocalProviderEnabled: nextProviderEntries.some(([providerKey, providerConfig]) => (
      isLocalProviderKey(providerKey) && providerConfig.enabled === true
    )),
    modelCount: nextProviderEntries.reduce((count, [, providerConfig]) => count + countProviderModels(providerConfig), 0),
  };
};

const buildBrowserSettingAnalyticsParams = (
  previousConfig: BrowserWebAccessConfig,
  nextConfig: BrowserWebAccessConfig,
): {
  blockedHostnameCount: number;
  changedKeys: string;
  networkMode: string;
  previousBlockedHostnameCount?: number;
} | null => {
  const changedKeys = new Set<string>();
  if (previousConfig.networkMode !== nextConfig.networkMode) {
    changedKeys.add('network_mode');
  }
  if (previousConfig.blockedHostnames.length !== nextConfig.blockedHostnames.length) {
    changedKeys.add('blocked_hostnames');
  }

  if (changedKeys.size === 0) {
    return null;
  }

  return {
    blockedHostnameCount: nextConfig.blockedHostnames.length,
    changedKeys: Array.from(changedKeys).sort().join(','),
    networkMode: nextConfig.networkMode,
    previousBlockedHostnameCount: previousConfig.blockedHostnames.length,
  };
};

const buildMemorySettingAnalyticsSummary = (
  previousConfig: {
    embeddingEnabled: boolean;
    embeddingModel: string;
    embeddingProvider: string;
    embeddingRemoteApiKey: string;
    embeddingRemoteBaseUrl: string;
    embeddingVectorWeight: number;
    memoryEnabled: boolean;
    memoryLlmJudgeEnabled: boolean;
  },
  nextConfig: {
    embeddingEnabled: boolean;
    embeddingModel: string;
    embeddingProvider: string;
    embeddingRemoteApiKey: string;
    embeddingRemoteBaseUrl: string;
    embeddingVectorWeight: number;
    memoryEnabled: boolean;
    memoryLlmJudgeEnabled: boolean;
  },
): MemorySettingAnalyticsSummary | null => {
  const changedKeys = new Set<string>();
  if (previousConfig.memoryEnabled !== nextConfig.memoryEnabled) {
    changedKeys.add('memory_enabled');
  }
  if (previousConfig.memoryLlmJudgeEnabled !== nextConfig.memoryLlmJudgeEnabled) {
    changedKeys.add('llm_judge_enabled');
  }
  if (previousConfig.embeddingEnabled !== nextConfig.embeddingEnabled) {
    changedKeys.add('embedding_enabled');
  }
  if (previousConfig.embeddingProvider !== nextConfig.embeddingProvider) {
    changedKeys.add('embedding_provider');
  }
  if (previousConfig.embeddingModel !== nextConfig.embeddingModel) {
    changedKeys.add('embedding_model');
  }
  if (previousConfig.embeddingRemoteBaseUrl !== nextConfig.embeddingRemoteBaseUrl) {
    changedKeys.add('embedding_base_url');
  }
  if (previousConfig.embeddingRemoteApiKey !== nextConfig.embeddingRemoteApiKey) {
    changedKeys.add('embedding_api_key');
  }
  if (previousConfig.embeddingVectorWeight !== nextConfig.embeddingVectorWeight) {
    changedKeys.add('embedding_vector_weight');
  }

  if (changedKeys.size === 0) {
    return null;
  }

  return {
    changedKeys: Array.from(changedKeys).sort().join(','),
    embeddingEnabled: nextConfig.embeddingEnabled,
    embeddingProvider: nextConfig.embeddingProvider,
    embeddingVectorWeight: nextConfig.embeddingVectorWeight,
    hasEmbeddingApiKey: nextConfig.embeddingRemoteApiKey.trim().length > 0,
    hasEmbeddingBaseUrl: nextConfig.embeddingRemoteBaseUrl.trim().length > 0,
    hasEmbeddingModel: nextConfig.embeddingModel.trim().length > 0,
    memoryEnabled: nextConfig.memoryEnabled,
    memoryLlmJudgeEnabled: nextConfig.memoryLlmJudgeEnabled,
  };
};

const resolveDreamingFrequencyType = (frequency: string): 'preset' | 'custom' => (
  DREAMING_FREQUENCY_PRESETS_FOR_ANALYTICS.has(frequency) ? 'preset' : 'custom'
);

const buildDreamingSettingAnalyticsSummary = (
  previousConfig: {
    dreamingEnabled: boolean;
    dreamingFrequency: string;
  },
  nextConfig: {
    dreamingEnabled: boolean;
    dreamingFrequency: string;
  },
): DreamingSettingAnalyticsSummary | null => {
  const changedKeys = new Set<string>();
  if (previousConfig.dreamingEnabled !== nextConfig.dreamingEnabled) {
    changedKeys.add('dreaming_enabled');
  }
  if (previousConfig.dreamingFrequency !== nextConfig.dreamingFrequency) {
    changedKeys.add('dreaming_frequency');
  }

  if (changedKeys.size === 0) {
    return null;
  }

  return {
    changedKeys: Array.from(changedKeys).sort().join(','),
    dreamingEnabled: nextConfig.dreamingEnabled,
    frequencyType: resolveDreamingFrequencyType(nextConfig.dreamingFrequency),
  };
};

const countConfiguredShortcuts = (shortcutConfig: ShortcutConfig): number => (
  Object.values(shortcutConfig).filter(value => String(value || '').trim().length > 0).length
);

const buildShortcutSettingAnalyticsSummary = (
  previousShortcuts: ShortcutConfig,
  nextShortcuts: ShortcutConfig,
): ShortcutSettingAnalyticsSummary | null => {
  const keys = new Set([
    ...Object.keys(previousShortcuts),
    ...Object.keys(nextShortcuts),
    ...Object.keys(defaultConfig.shortcuts || {}),
  ]);
  let changedCount = 0;
  keys.forEach(key => {
    if ((previousShortcuts[key as ShortcutAction] || '') !== (nextShortcuts[key as ShortcutAction] || '')) {
      changedCount += 1;
    }
  });

  if (changedCount === 0) {
    return null;
  }

  const defaultShortcuts: ShortcutConfig = { ...defaultConfig.shortcuts! };
  const resetToDefault = Array.from(keys).every(key => (
    (nextShortcuts[key as ShortcutAction] || '') === (defaultShortcuts[key as ShortcutAction] || '')
  ));

  return {
    changedCount,
    configuredCount: countConfiguredShortcuts(nextShortcuts),
    disabledCount: Array.from(keys).filter(key => !String(nextShortcuts[key as ShortcutAction] || '').trim()).length,
    resetToDefault,
  };
};

const buildPluginSettingsAnalyticsSummary = (
  pendingChanges: PluginPendingChanges | null,
): PluginSettingsAnalyticsSummary | null => {
  if (!pendingChanges) {
    return null;
  }
  const toggleCount = pendingChanges.toggles.length;
  const configCount = pendingChanges.configs.length;
  if (toggleCount === 0 && configCount === 0) {
    return null;
  }
  const changedKeys = [
    ...(toggleCount > 0 ? ['toggle'] : []),
    ...(configCount > 0 ? ['config'] : []),
  ].join(',');

  return {
    changedKeys,
    configCount,
    disabledToggleCount: pendingChanges.toggles.filter(change => !change.enabled).length,
    enabledToggleCount: pendingChanges.toggles.filter(change => change.enabled).length,
    toggleCount,
  };
};

const reportGeneralSettingChanged = (
  settingKey: string,
  settingValue: SettingsAnalyticsValue,
  previousValue?: SettingsAnalyticsValue,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.GeneralSettingChanged,
    settingKey,
    settingValue,
    previousValue,
    source: SettingsAnalyticsSource.General,
  });
};

const reportAppearanceSettingChanged = (
  settingKey: string,
  settingValue: SettingsAnalyticsValue,
  previousValue?: SettingsAnalyticsValue,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.AppearanceSettingChanged,
    settingKey,
    settingValue,
    previousValue,
    source: SettingsAnalyticsSource.Appearance,
  });
};

const reportBrowserSettingChanged = (
  params: {
    blockedHostnameCount: number;
    changedKeys: string;
    networkMode: string;
    previousBlockedHostnameCount?: number;
  },
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.BrowserSettingChanged,
    source: SettingsAnalyticsSource.Browser,
    ...params,
  });
};

const reportMemorySettingChanged = (
  summary: MemorySettingAnalyticsSummary,
): void => {
  console.debug('[Settings] reporting memory setting analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.MemorySettingChanged,
    source: SettingsAnalyticsSource.Memory,
    ...summary,
  });
};

const reportMemoryEntryChanged = (
  operation: 'created' | 'updated' | 'deleted',
  entryCount?: number,
): void => {
  console.debug('[Settings] reporting memory entry analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.MemoryEntryChanged,
    source: SettingsAnalyticsSource.Memory,
    operation,
    entryCount,
  });
};

const reportDreamingSettingChanged = (
  summary: DreamingSettingAnalyticsSummary,
): void => {
  console.debug('[Settings] reporting dreaming setting analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.DreamingSettingChanged,
    source: SettingsAnalyticsSource.Dreaming,
    ...summary,
  });
};

const reportPluginSettingsSaved = (
  summary: PluginSettingsAnalyticsSummary,
): void => {
  console.debug('[Settings] reporting plugin settings analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.PluginSettingsSaved,
    source: SettingsAnalyticsSource.Plugins,
    ...summary,
  });
};

const reportShortcutSettingChanged = (
  summary: ShortcutSettingAnalyticsSummary,
): void => {
  console.debug('[Settings] reporting shortcut setting analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.ShortcutSettingChanged,
    source: SettingsAnalyticsSource.Shortcuts,
    ...summary,
  });
};

const reportAboutAction = (
  actionType: string,
  result: string,
  options: { missingEntryCount?: number } = {},
): void => {
  console.debug('[Settings] reporting about action analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.AboutAction,
    source: SettingsAnalyticsSource.About,
    actionType,
    result,
    missingEntryCount: options.missingEntryCount,
  });
};

const reportAgentEngineSettingChanged = (
  settingKey: string,
  settingValue: SettingsAnalyticsValue,
  previousValue?: SettingsAnalyticsValue,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.AgentEngineSettingChanged,
    settingKey,
    settingValue,
    previousValue,
    source: SettingsAnalyticsSource.AgentEngine,
  });
};

const reportAgentEngineMaintenanceAction = (
  actionType: string,
  result: string,
  options: { errorCode?: string; sizeBytes?: number } = {},
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.AgentEngineMaintenanceAction,
    actionType,
    result,
    errorCode: options.errorCode,
    sizeBytes: options.sizeBytes,
    source: SettingsAnalyticsSource.AgentEngine,
  });
};

const reportCustomModelSettingsSaved = (
  summary: CustomModelSettingsAnalyticsSummary,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.CustomModelSettingsSaved,
    source: SettingsAnalyticsSource.Model,
    ...summary,
  });
};

const reportCustomModelConnectionTested = (
  providerKey: ProviderType,
  apiFormat: string,
  result: 'success' | 'failed',
  options: { failureReason?: string; statusCode?: number } = {},
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.CustomModelConnectionTested,
    source: SettingsAnalyticsSource.Model,
    providerKey,
    providerKind: resolveProviderAnalyticsKind(providerKey),
    apiFormat,
    result,
    failureReason: options.failureReason,
    statusCode: options.statusCode,
  });
};

const AGENT_TASK_SLOT_COMMANDS: ShortcutCommandDefinition[] = [
  ShortcutAction.OpenAgentTask1,
  ShortcutAction.OpenAgentTask2,
  ShortcutAction.OpenAgentTask3,
  ShortcutAction.OpenAgentTask4,
  ShortcutAction.OpenAgentTask5,
  ShortcutAction.OpenAgentTask6,
  ShortcutAction.OpenAgentTask7,
  ShortcutAction.OpenAgentTask8,
  ShortcutAction.OpenAgentTask9,
].map((key, index) => ({
  key,
  labelKey: 'shortcutOpenAgentTaskSlot',
  descriptionKey: 'shortcutDescOpenAgentTaskSlot',
  slot: index + 1,
}));

const SETTINGS_TAB_SHORTCUT_COMMANDS: ShortcutCommandDefinition[] = [
  { key: ShortcutAction.OpenSettingsGeneral, tabLabelKey: 'general' },
  { key: ShortcutAction.OpenSettingsAppearance, tabLabelKey: 'appearance' },
  { key: ShortcutAction.OpenSettingsAgentEngine, tabLabelKey: 'coworkAgentEngine' },
  { key: ShortcutAction.OpenSettingsModel, tabLabelKey: 'settingsCustomModel' },
  { key: ShortcutAction.OpenSettingsIm, tabLabelKey: 'imBot' },
  { key: ShortcutAction.OpenSettingsBrowser, tabLabelKey: 'browserWebAccessTab' },
  { key: ShortcutAction.OpenSettingsEmail, tabLabelKey: 'emailTab' },
  { key: ShortcutAction.OpenSettingsMemory, tabLabelKey: 'coworkMemoryTitle' },
  { key: ShortcutAction.OpenSettingsDreaming, tabLabelKey: 'coworkMemoryTabDreaming' },
  { key: ShortcutAction.OpenSettingsPlugins, tabLabelKey: 'pluginsTab' },
  { key: ShortcutAction.OpenSettingsShortcuts, tabLabelKey: 'shortcuts' },
  { key: ShortcutAction.OpenSettingsAbout, tabLabelKey: 'about' },
].map(command => ({
  ...command,
  labelKey: 'shortcutOpenSettingsTab',
  descriptionKey: 'shortcutDescOpenSettingsTab',
}));

const SHORTCUT_COMMAND_GROUPS: Array<{
  titleKey: string;
  commands: ShortcutCommandDefinition[];
}> = [
  {
    titleKey: 'shortcutGroupCowork',
    commands: [
      { key: ShortcutAction.NewChat, labelKey: 'newChat', descriptionKey: 'shortcutDescNewChat' },
      { key: ShortcutAction.FocusPrompt, labelKey: 'shortcutFocusPrompt', descriptionKey: 'shortcutDescFocusPrompt' },
      { key: ShortcutAction.StopCurrentTask, labelKey: 'shortcutStopCurrentTask', descriptionKey: 'shortcutDescStopCurrentTask' },
      { key: ShortcutAction.Search, labelKey: 'search', descriptionKey: 'shortcutDescSearch' },
      { key: ShortcutAction.ToggleArtifacts, labelKey: 'shortcutToggleArtifacts', descriptionKey: 'shortcutDescToggleArtifacts' },
      {
        key: ShortcutAction.SendMessage,
        labelKey: 'sendMessageShortcut',
        descriptionKey: 'shortcutDescSendMessage',
        inputType: 'send',
      },
    ],
  },
  {
    titleKey: 'shortcutGroupNavigation',
    commands: [
      { key: ShortcutAction.OpenCowork, labelKey: 'shortcutOpenCowork', descriptionKey: 'shortcutDescOpenCowork' },
      { key: ShortcutAction.OpenScheduledTasks, labelKey: 'shortcutOpenScheduledTasks', descriptionKey: 'shortcutDescOpenScheduledTasks' },
      { key: ShortcutAction.OpenKits, labelKey: 'shortcutOpenKits', descriptionKey: 'shortcutDescOpenKits' },
      { key: ShortcutAction.OpenSkills, labelKey: 'shortcutOpenSkills', descriptionKey: 'shortcutDescOpenSkills' },
      { key: ShortcutAction.OpenMcp, labelKey: 'shortcutOpenMcp', descriptionKey: 'shortcutDescOpenMcp' },
      { key: ShortcutAction.ToggleSidebar, labelKey: 'shortcutToggleSidebar', descriptionKey: 'shortcutDescToggleSidebar' },
    ],
  },
  {
    titleKey: 'shortcutGroupApp',
    commands: [
      { key: ShortcutAction.Settings, labelKey: 'openSettings', descriptionKey: 'shortcutDescSettings' },
      { key: ShortcutAction.ShowShortcuts, labelKey: 'shortcutShowShortcuts', descriptionKey: 'shortcutDescShowShortcuts' },
    ],
  },
  {
    titleKey: 'shortcutGroupAgent',
    commands: [
      { key: ShortcutAction.PreviousAgent, labelKey: 'shortcutPreviousAgent', descriptionKey: 'shortcutDescPreviousAgent' },
      { key: ShortcutAction.NextAgent, labelKey: 'shortcutNextAgent', descriptionKey: 'shortcutDescNextAgent' },
      {
        key: ShortcutAction.ShowCurrentAgentTasks,
        labelKey: 'shortcutShowCurrentAgentTasks',
        descriptionKey: 'shortcutDescShowCurrentAgentTasks',
      },
      ...AGENT_TASK_SLOT_COMMANDS,
    ],
  },
  {
    titleKey: 'shortcutGroupSettingsTabs',
    commands: SETTINGS_TAB_SHORTCUT_COMMANDS,
  },
];

const SHORTCUT_COMMANDS = SHORTCUT_COMMAND_GROUPS.flatMap(group => group.commands);

const getShortcutCommandText = (
  command: ShortcutCommandDefinition,
  field: 'labelKey' | 'descriptionKey',
) => {
  const value = i18nService.t(command[field]);
  return value
    .replace('{slot}', String(command.slot ?? ''))
    .replace('{tab}', command.tabLabelKey ? i18nService.t(command.tabLabelKey) : '');
};

const SettingsSlidersIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M14 17H5" />
    <path d="M19 7h-9" />
    <circle cx="17" cy="17" r="3" />
    <circle cx="7" cy="7" r="3" />
  </svg>
);

const DreamingTabIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="34"
    height="34"
    viewBox="0 0 34 34"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <path
      d="M27.9219 21.9648L29.014 22.4621L29.8552 20.6145L27.831 20.7683L27.9219 21.9648ZM16.0762 5.03516L17.1683 5.53234L18.0095 3.68449L15.9851 3.83862L16.0762 5.03516ZM27.9219 21.9648L26.8297 21.4676C25.1281 25.205 21.3674 27.8 17 27.8V29V30.2C22.3442 30.2 26.9378 27.0221 29.014 22.4621L27.9219 21.9648ZM17 29V27.8C11.0353 27.8 6.2 22.9647 6.2 17H5H3.8C3.8 24.2902 9.70984 30.2 17 30.2V29ZM5 17H6.2C6.2 11.3157 10.5923 6.65614 16.1673 6.23169L16.0762 5.03516L15.9851 3.83862C9.16855 4.35759 3.8 10.0512 3.8 17H5ZM16.0762 5.03516L14.984 4.53798C14.2262 6.20275 13.8 8.052 13.8 10H15H16.2C16.2 8.40537 16.5483 6.8944 17.1683 5.53234L16.0762 5.03516ZM15 10H13.8C13.8 17.2902 19.7098 23.2 27 23.2V22V20.8C21.0353 20.8 16.2 15.9647 16.2 10H15ZM27 22V23.2C27.3413 23.2 27.679 23.1868 28.0128 23.1614L27.9219 21.9648L27.831 20.7683C27.5562 20.7892 27.2791 20.8 27 20.8V22Z"
      fill="currentColor"
    />
  </svg>
);

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
  noticeI18nKey?: string;
  noticeExtra?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
  initialTabRequestId?: number;
  onUpdateFound?: (info: AppUpdateInfo) => void;
  enterpriseConfig?: {
    ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
    disableUpdate?: boolean;
  } | null;
}


type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
};

interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'gemini';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersExportPayload {
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

interface ProvidersImportEntry {
  enabled?: boolean;
  apiKey?: EncryptedPayload | PasswordEncryptedPayload | string;
  apiKeyEncrypted?: string;
  apiKeyIv?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersImportPayload {
  type?: string;
  version?: number;
  encryption?: {
    algorithm?: string;
    keySource?: string;
    keyDerivation?: string;
  };
  providers?: Record<string, ProvidersImportEntry>;
}

const ABOUT_CONTACT_EMAIL = 'lobsterai.project@rd.netease.com';
const ABOUT_USER_MANUAL_URL = 'https://lobsterai.youdao.com/#/docs/lobsterai_user_manual';
const ABOUT_USER_COMMUNITY_URL = 'https://lobsterai.youdao.com/#/about';
const ABOUT_SERVICE_TERMS_URL = 'https://c.youdao.com/dict/hardware/lobsterai/lobsterai_service.html';

// MiniMax Portal OAuth constants
const MINIMAX_OAUTH_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113';
const MINIMAX_OAUTH_SCOPE = 'group_id profile model.completion';
const MINIMAX_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:user_code';
const MINIMAX_BASE_URL_CN = 'https://api.minimaxi.com/anthropic';
const MINIMAX_BASE_URL_GLOBAL = 'https://api.minimax.io/anthropic';
const MINIMAX_CODE_ENDPOINT_CN = 'https://api.minimaxi.com/oauth/code';
const MINIMAX_CODE_ENDPOINT_GLOBAL = 'https://api.minimax.io/oauth/code';
const MINIMAX_TOKEN_ENDPOINT_CN = 'https://api.minimaxi.com/oauth/token';
const MINIMAX_TOKEN_ENDPOINT_GLOBAL = 'https://api.minimax.io/oauth/token';

type MiniMaxRegion = 'cn' | 'global';
type MiniMaxOAuthPhase =
  | { kind: 'idle' }
  | { kind: 'requesting_code' }
  | { kind: 'pending'; userCode: string; verificationUri: string }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

async function generateMiniMaxPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifierArray = new Uint8Array(32);
  crypto.getRandomValues(verifierArray);
  const verifier = btoa(String.fromCharCode(...verifierArray))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const stateArray = new Uint8Array(16);
  crypto.getRandomValues(stateArray);
  const state = btoa(String.fromCharCode(...stateArray))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { verifier, challenge, state };
}

const copyTextFallback = (text: string): boolean => {
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

const copyTextToClipboard = async (text: string): Promise<boolean> => {
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

const getUpdateCheckStatusFromRuntimeStatus = (
  state: AppUpdateRuntimeState,
): 'idle' | 'checking' | 'upToDate' | 'error' | 'downloading' | 'ready' => {
  if (state.source !== AppUpdateSource.Manual) {
    return 'idle';
  }
  switch (state.status) {
    case AppUpdateStatus.Checking:
      return 'checking';
    case AppUpdateStatus.Downloading:
      return 'downloading';
    case AppUpdateStatus.Ready:
      return 'ready';
    case AppUpdateStatus.Error:
      return 'error';
    default:
      return 'idle';
  }
};

// System shortcuts that should not be captured (clipboard, undo, select-all, quit, etc.)
const isSystemShortcut = (e: KeyboardEvent): boolean => {
  const key = e.key.toLowerCase();
  if (e.metaKey && ['c', 'v', 'x', 'z', 'y', 'a', 'q', 'w'].includes(key)) return true;
  if (e.metaKey && e.shiftKey && key === 'z') return true;
  if (e.ctrlKey && ['c', 'v', 'x', 'z', 'y', 'a', 'w'].includes(key)) return true;
  return false;
};

const isShortcutInputActive = () => {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  return activeElement.dataset.shortcutInput === 'true';
};

const isTextEditingActive = () => {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (activeElement.isContentEditable) return true;
  if (activeElement instanceof HTMLTextAreaElement) return true;
  if (activeElement instanceof HTMLSelectElement) return true;
  return activeElement instanceof HTMLInputElement;
};

const formatShortcutFromEvent = (e: React.KeyboardEvent): string | null => {
  // Skip standalone modifier keys
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  // Require at least one non-Shift modifier
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
  if (isSystemShortcut(e.nativeEvent)) return null;

  const parts: string[] = [];
  if (e.metaKey) parts.push('Cmd');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push(isMacPlatform ? 'Option' : 'Alt');
  if (e.shiftKey) parts.push('Shift');

  const keyMap: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    ' ': 'Space', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace',
    Delete: 'Delete', Tab: 'Tab',
  };
  const key = keyMap[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);
  return parts.join('+');
};

const SEND_SHORTCUT_OPTIONS = [
  { value: 'Enter', label: 'Enter', labelMac: 'Enter' },
  { value: 'Shift+Enter', label: 'Shift+Enter', labelMac: 'Shift+Enter' },
  { value: 'Ctrl+Enter', label: 'Ctrl+Enter', labelMac: 'Cmd+Enter' },
  { value: 'Alt+Enter', label: 'Alt+Enter', labelMac: 'Option+Enter' },
] as const;

const isMacPlatform = navigator.platform.includes('Mac');

const ShortcutRecorder: React.FC<{
  value: string;
  label: string;
  onChange: (v: string) => void;
}> = ({ value, label, onChange }) => {
  const [recording, setRecording] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<HTMLButtonElement>(null);
  const displayValue = formatShortcutForDisplay(value, { isMac: isMacPlatform });
  const editLabel = i18nService.t('shortcutEditCommand').replace('{command}', label);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { setRecording(false); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { onChange(''); setRecording(false); return; }
    const shortcut = formatShortcutFromEvent(e);
    if (shortcut) { onChange(shortcut); setRecording(false); }
  };

  useEffect(() => {
    if (!recording) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setRecording(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    window.setTimeout(() => recorderRef.current?.focus(), 0);
  }, [recording]);

  if (recording) {
    return (
      <div ref={containerRef} className="flex items-center gap-3">
        <button
          ref={recorderRef}
          type="button"
          data-shortcut-input="true"
          onKeyDown={handleKeyDown}
          className="h-8 min-w-[8rem] rounded-xl border border-border bg-surface px-4 text-xs font-medium text-foreground shadow-sm outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/25"
        >
          {i18nService.t('shortcutPressShortcut')}
        </button>
        <button
          type="button"
          data-shortcut-input="true"
          onClick={() => setRecording(false)}
          className="text-xs font-medium text-secondary transition-colors hover:text-foreground"
        >
          {i18nService.t('cancel')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        title={displayValue || i18nService.t('shortcutNotSet')}
        className="min-w-[5.5rem] max-w-[9rem] truncate rounded-full bg-surface-raised px-3 py-1 text-center text-xs font-medium text-secondary"
      >
        {displayValue || i18nService.t('shortcutNotSet')}
      </span>
      <button
        type="button"
        onClick={() => setRecording(true)}
        title={editLabel}
        aria-label={editLabel}
        className="pointer-events-none inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary opacity-0 transition-colors hover:bg-surface-raised hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        <EditIcon className="h-4 w-4" />
      </button>
    </div>
  );
};

const SendShortcutSelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const currentLabel = (() => {
    const opt = SEND_SHORTCUT_OPTIONS.find(o => o.value === value);
    if (!value) return i18nService.t('shortcutNotSet');
    if (!opt) return formatShortcutForDisplay(value, { isMac: isMacPlatform });
    return isMacPlatform ? opt.labelMac : opt.label;
  })();

  return (
    <div ref={containerRef} className="flex items-center gap-2">
      <div className="relative">
        <div
          onClick={() => setOpen(!open)}
          className={`w-28 rounded-lg border px-2.5 py-1 text-xs cursor-pointer select-none text-center outline-none transition-colors
            dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:text-claude-darkText text-claude-text
            ${open
              ? 'border-claude-accent ring-1 ring-claude-accent/30'
              : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50'
            }`}
        >
          {currentLabel}
        </div>
        {open && (
          <div className="absolute right-0 mt-1 z-50 min-w-[160px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset shadow-elevated py-1">
            {SEND_SHORTCUT_OPTIONS.map((option) => {
              const label = isMacPlatform ? option.labelMac : option.label;
              const isActive = value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => { onChange(option.value); setOpen(false); }}
                  className={`flex items-center justify-between w-full px-3 py-1.5 text-xs transition-colors
                    ${isActive
                      ? 'dark:text-claude-accent text-claude-accent font-medium'
                      : 'dark:text-claude-darkText text-claude-text'
                    } hover:bg-claude-accent/10`}
                >
                  <span>{label}</span>
                  {isActive && <span className="text-claude-accent">✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <span className="h-6 w-6 shrink-0" aria-hidden="true" />
    </div>
  );
};

const SettingsSwitch: React.FC<{
  checked: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}> = ({ checked, label, disabled, onClick }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => {
      void onClick();
    }}
    disabled={disabled}
    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
      disabled ? 'opacity-50 cursor-not-allowed' : ''
    } ${
      checked
        ? 'bg-primary'
        : 'bg-gray-300 dark:bg-gray-600'
    }`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
);

const SettingsToggleRow: React.FC<{
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void | Promise<void>;
}> = ({ title, description, checked, disabled, onToggle }) => (
  <div>
    <div className="flex items-center justify-between gap-4">
      <h4 className="min-w-0 flex-1 text-sm font-medium text-foreground">
        {title}
      </h4>
      <SettingsSwitch
        checked={checked}
        label={title}
        disabled={disabled}
        onClick={onToggle}
      />
    </div>
    <p className="mt-3 text-sm text-secondary">
      {description}
    </p>
  </div>
);

const SettingsNumberInputRow: React.FC<{
  id: string;
  title: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}> = ({ id, title, description, value, min, max, onChange }) => (
  <div className="flex items-center justify-between gap-4">
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {title}
      </label>
      <p className="mt-1 text-sm text-secondary">
        {description}
      </p>
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => {
          onChange(normalizeFontPreference(event.currentTarget.value, value, min, max));
        }}
        onBlur={(event) => {
          onChange(normalizeFontPreference(event.currentTarget.value, value, min, max));
        }}
        className="h-8 w-16 rounded-lg border border-border bg-surface px-2 text-center text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      <span className="text-sm text-secondary">px</span>
    </div>
  </div>
);

const Settings: React.FC<SettingsProps> = ({
  onClose,
  initialTab,
  initialTabRequestId,
  notice,
  noticeI18nKey,
  noticeExtra,
  onUpdateFound,
  enterpriseConfig,
}) => {
  const dispatch = useDispatch();
  // 状态
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'general');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [themeId, setThemeId] = useState<string>(themeService.getThemeId());
  const [uiFontSize, setUiFontSize] = useState<number>(FontPreferences.UiFontSizeDefault);
  const [codeFontSize, setCodeFontSize] = useState<number>(FontPreferences.CodeFontSizeDefault);
  const [language, setLanguage] = useState<LanguageType>('zh');
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [useSystemProxy, setUseSystemProxy] = useState(false);
  const [sqliteAutoBackupEnabled, setSqliteAutoBackupEnabled] = useState(false);
  const [usageAnalyticsEnabled, setUsageAnalyticsEnabled] = useState(true);
  const [taskCompletionNotificationsEnabled, setTaskCompletionNotificationsEnabled] = useState(true);
  const [browserWebAccess, setBrowserWebAccess] = useState<BrowserWebAccessConfig>(() => ({
    ...defaultBrowserWebAccessConfig,
    webFetch: { ...defaultBrowserWebAccessConfig.webFetch },
  }));
  const [isUpdatingAutoLaunch, setIsUpdatingAutoLaunch] = useState(false);
  const [preventSleep, setPreventSleepState] = useState(false);
  const [isUpdatingPreventSleep, setIsUpdatingPreventSleep] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buildNoticeMessage = useCallback((): string | null => {
    if (noticeI18nKey) {
      const base = i18nService.t(noticeI18nKey);
      return noticeExtra ? `${base} (${noticeExtra})` : base;
    }
    return notice ?? null;
  }, [notice, noticeExtra, noticeI18nKey]);

  const [noticeMessage, setNoticeMessage] = useState<string | null>(() => buildNoticeMessage());
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | null>(null);
  const [isTestResultModalOpen, setIsTestResultModalOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<ProviderType | null>(null);
  const [isImportingProviders, setIsImportingProviders] = useState(false);
  const [isExportingProviders, setIsExportingProviders] = useState(false);
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialThemeIdRef = useRef<string>(themeService.getThemeId());
  const initialUiFontSizeRef = useRef<number>(FontPreferences.UiFontSizeDefault);
  const initialCodeFontSizeRef = useRef<number>(FontPreferences.CodeFontSizeDefault);
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const didSaveRef = useRef(false);

  // Plugin settings handle (deferred save)
  const pluginsSettingsRef = useRef<PluginsSettingsHandle>(null);

  // Add state for active provider
  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());
  const [showApiKey, setShowApiKey] = useState(false);

  // MiniMax OAuth state
  const [minimaxOAuthPhase, setMinimaxOAuthPhase] = useState<MiniMaxOAuthPhase>({ kind: 'idle' });
  const [minimaxOAuthRegion, setMinimaxOAuthRegion] = useState<MiniMaxRegion>('cn');
  const minimaxOAuthCancelRef = useRef(false);

  // OpenAI ChatGPT (Codex) OAuth state
  type OpenAIOAuthPhase =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'success'; email?: string }
    | { kind: 'error'; message: string };
  const [openaiOAuthPhase, setOpenaiOAuthPhase] = useState<OpenAIOAuthPhase>({ kind: 'idle' });
  // Mirrors <CODEX_HOME>/auth.json on disk; refreshed on tab focus and after
  // login/logout. `null` = not yet checked.
  const [openaiOAuthStatus, setOpenaiOAuthStatus] = useState<
    { loggedIn: false } | { loggedIn: true; email?: string } | null
  >(null);

  // xAI (Grok) OAuth state
  type XaiOAuthPhase =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'device_code'; userCode: string; verificationUri: string }
    | { kind: 'success'; email?: string }
    | { kind: 'error'; message: string };
  const [xaiOAuthPhase, setXaiOAuthPhase] = useState<XaiOAuthPhase>({ kind: 'idle' });
  // Mirrors the OpenClaw auth-profiles store on disk; refreshed whenever the
  // xAI provider tab becomes active and after login/logout. `null` = not yet checked.
  const [xaiOAuthStatus, setXaiOAuthStatus] = useState<
    { loggedIn: false } | { loggedIn: true; email?: string } | null
  >(null);

  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());


  // authType defaults to undefined on first open, which should behave as OAuth mode
  const minimaxIsOAuthMode = providers.minimax.authType !== 'apikey';
  // OpenAI defaults to API key mode unless the user explicitly opts in to OAuth
  const openaiIsOAuthMode = providers.openai.authType === 'oauth';
  // xAI likewise defaults to API key mode; OAuth is an explicit opt-in
  const xaiIsOAuthMode = providers.xai.authType === 'oauth';
  const isBaseUrlLocked = (activeProvider === 'zhipu' && providers.zhipu.codingPlanEnabled) || (activeProvider === 'qwen' && providers.qwen.codingPlanEnabled) || (activeProvider === 'volcengine' && providers.volcengine.codingPlanEnabled) || (activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled) || (activeProvider === 'qianfan' && providers.qianfan.codingPlanEnabled) || (activeProvider === 'xiaomi' && providers.xiaomi.codingPlanEnabled) || (activeProvider === 'minimax' && minimaxIsOAuthMode) || (activeProvider === 'openai' && openaiIsOAuthMode) || (activeProvider === 'xai' && xaiIsOAuthMode);

  // 创建引用来确保内容区域的滚动
  const contentRef = useRef<HTMLDivElement>(null);
  // 内容区下方仍有未滚出的内容时，在底部按钮区上方显示渐隐遮罩
  const [footerFadeVisible, setFooterFadeVisible] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const emailCopiedTimerRef = useRef<number | null>(null);
  const openClawGatewayCopiedTimerRef = useRef<number | null>(null);
  const updateCheckTimerRef = useRef<number | null>(null);

  // 快捷键设置
  const [shortcuts, setShortcuts] = useState<ShortcutConfig>(() => ({ ...defaultConfig.shortcuts! }));
  const [shortcutSearchQuery, setShortcutSearchQuery] = useState('');

  // GitHub Copilot device code auth state
  const [copilotAuthStatus, setCopilotAuthStatus] = useState<'idle' | 'requesting' | 'awaiting_user' | 'polling' | 'authenticated' | 'error'>('idle');
  const [copilotUserCode, setCopilotUserCode] = useState('');
  const [copilotVerificationUri, setCopilotVerificationUri] = useState('');
  const [copilotGithubUser, setCopilotGithubUser] = useState('');
  const [copilotError, setCopilotError] = useState<string | null>(null);

  // State for model editing
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newModelSupportsImage, setNewModelSupportsImage] = useState(false);
  const [newModelSupportsThinking, setNewModelSupportsThinking] = useState(false);
  const [newModelContextWindow, setNewModelContextWindow] = useState<number | undefined>(undefined);
  const [newModelCustomParams, setNewModelCustomParams] = useState<string>('');
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  // About tab
  const [appVersion, setAppVersion] = useState('');
  const [emailCopied, setEmailCopied] = useState(false);
  const [isExportingLogs, setIsExportingLogs] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [logoClickCount, setLogoClickCount] = useState(0);
  const [testModeUnlocked, setTestModeUnlocked] = useState(false);
  const [updateCheckStatus, setUpdateCheckStatus] = useState<'idle' | 'checking' | 'upToDate' | 'error' | 'downloading' | 'ready'>('idle');
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateRuntimeState | null>(null);

  useEffect(() => {
    window.electron.appInfo.getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    setShowApiKey(false);
  }, [activeProvider]);

  useEffect(() => {
    let mounted = true;

    const syncUpdateStatus = async () => {
      try {
        const state = await window.electron.appUpdate.getState();
        if (!mounted) {
          return;
        }
        setAppUpdateState(state);
        setUpdateCheckStatus(getUpdateCheckStatusFromRuntimeStatus(state));
      } catch (error) {
        console.error('Failed to load app update state in settings:', error);
      }
    };

    void syncUpdateStatus();

    const unsubscribe = window.electron.appUpdate.onStateChanged((state) => {
      if (
        updateCheckTimerRef.current != null &&
        state.source === AppUpdateSource.Manual &&
        state.status !== AppUpdateStatus.Idle
      ) {
        window.clearTimeout(updateCheckTimerRef.current);
        updateCheckTimerRef.current = null;
      }
      setAppUpdateState(state);
      setUpdateCheckStatus(getUpdateCheckStatusFromRuntimeStatus(state));
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleCopyContactEmail = useCallback(async () => {
    const copied = await copyTextToClipboard(ABOUT_CONTACT_EMAIL);
    reportAboutAction('copy_contact_email', copied ? 'success' : 'failed');
    if (copied) {
      setEmailCopied(true);
      if (emailCopiedTimerRef.current != null) {
        window.clearTimeout(emailCopiedTimerRef.current);
      }
      emailCopiedTimerRef.current = window.setTimeout(() => {
        setEmailCopied(false);
        emailCopiedTimerRef.current = null;
      }, 1200);
    }
  }, []);

  const authUser = useSelector((state: RootState) => state.auth.user);

  const handleCheckUpdate = useCallback(async () => {
    if (updateCheckStatus === 'checking' || !appVersion) return;
    setUpdateCheckStatus('checking');
    try {
      const result = await window.electron.appUpdate.checkNow({ manual: true, userId: authUser?.yid });
      if (!result.success) {
        throw new Error(result.error || 'Update check failed');
      }

      if (!result.updateFound) {
        setUpdateCheckStatus('upToDate');
        reportAboutAction('check_update', 'up_to_date');
        if (updateCheckTimerRef.current != null) {
          window.clearTimeout(updateCheckTimerRef.current);
        }
        updateCheckTimerRef.current = window.setTimeout(() => {
          setUpdateCheckStatus('idle');
          updateCheckTimerRef.current = null;
        }, 3000);
        return;
      }

      if (result.state.status === AppUpdateStatus.Ready) {
        setUpdateCheckStatus('ready');
        reportAboutAction('check_update', 'ready');
      } else if (result.state.status === AppUpdateStatus.Downloading) {
        setUpdateCheckStatus('downloading');
        reportAboutAction('check_update', 'downloading');
      } else {
        setUpdateCheckStatus('idle');
        reportAboutAction('check_update', 'update_found');
      }

      if (result.state.info) {
        onUpdateFound?.(result.state.info);
      }
    } catch {
      reportAboutAction('check_update', 'failed');
      setUpdateCheckStatus('error');
      if (updateCheckTimerRef.current != null) {
        window.clearTimeout(updateCheckTimerRef.current);
      }
      updateCheckTimerRef.current = window.setTimeout(() => {
        setUpdateCheckStatus('idle');
        updateCheckTimerRef.current = null;
      }, 3000);
    }
  }, [appVersion, authUser, updateCheckStatus, onUpdateFound]);

  const updateButtonLabel = useMemo(() => {
    if (
      updateCheckStatus === 'downloading' &&
      appUpdateState?.progress?.percent != null &&
      Number.isFinite(appUpdateState.progress.percent)
    ) {
      return `${i18nService.t('updateDownloadingBackground')} ${Math.round(appUpdateState.progress.percent * 100)}%`;
    }
    if (updateCheckStatus === 'checking') return i18nService.t('updateChecking');
    if (updateCheckStatus === 'downloading') return i18nService.t('updateDownloadingBackground');
    if (updateCheckStatus === 'ready') return i18nService.t('updateReadyTitle');
    if (updateCheckStatus === 'upToDate') return i18nService.t('updateUpToDate');
    if (updateCheckStatus === 'error') return i18nService.t('updateCheckFailed');
    return i18nService.t('checkForUpdate');
  }, [appUpdateState?.progress?.percent, updateCheckStatus]);

  const handleOpenUserManual = useCallback(() => {
    reportAboutAction('open_user_manual', 'success');
    void window.electron.shell.openExternal(ABOUT_USER_MANUAL_URL);
  }, []);

  const handleOpenUserCommunity = useCallback(() => {
    reportAboutAction('open_user_community', 'success');
    void window.electron.shell.openExternal(ABOUT_USER_COMMUNITY_URL);
  }, []);

  const handleOpenServiceTerms = useCallback(() => {
    reportAboutAction('open_service_terms', 'success');
    void window.electron.shell.openExternal(ABOUT_SERVICE_TERMS_URL);
  }, []);

  const handleExportLogs = useCallback(async () => {
    if (isExportingLogs) {
      return;
    }

    setError(null);
    setNoticeMessage(null);
    setIsExportingLogs(true);
    try {
      const result = await window.electron.log.exportZip();
      if (!result.success) {
        setError(result.error || i18nService.t('aboutExportLogsFailed'));
        reportAboutAction('export_logs', 'failed');
        return;
      }
      if (result.canceled) {
        reportAboutAction('export_logs', 'canceled');
        return;
      }

      if (result.path) {
        await window.electron.shell.showItemInFolder(result.path);
      }

      if ((result.missingEntries?.length ?? 0) > 0) {
        const missingList = result.missingEntries?.join(', ') || '';
        setNoticeMessage(`${i18nService.t('aboutExportLogsPartial')}: ${missingList}`);
      } else {
        setNoticeMessage(i18nService.t('aboutExportLogsSuccess'));
      }
      reportAboutAction('export_logs', 'success', {
        missingEntryCount: result.missingEntries?.length ?? 0,
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : i18nService.t('aboutExportLogsFailed'));
      reportAboutAction('export_logs', 'failed');
    } finally {
      setIsExportingLogs(false);
    }
  }, [isExportingLogs]);

  const coworkConfig = useSelector(selectCoworkConfig);

  const [coworkAgentEngine, setCoworkAgentEngine] = useState<CoworkAgentEngine>(coworkConfig.agentEngine || 'openclaw');
  const [coworkMemoryEnabled, setCoworkMemoryEnabled] = useState<boolean>(coworkConfig.memoryEnabled ?? true);
  const [coworkMemoryLlmJudgeEnabled, setCoworkMemoryLlmJudgeEnabled] = useState<boolean>(coworkConfig.memoryLlmJudgeEnabled ?? false);
  const [skipMissedJobs, setSkipMissedJobs] = useState<boolean>(coworkConfig.skipMissedJobs ?? true);
  const [openClawHeartbeatEnabled, setOpenClawHeartbeatEnabled] = useState<boolean>(coworkConfig.openClawHeartbeatEnabled ?? true);
  const [embeddingEnabled, setEmbeddingEnabled] = useState<boolean>(coworkConfig.embeddingEnabled ?? false);
  const [embeddingProvider, setEmbeddingProvider] = useState<string>(coworkConfig.embeddingProvider ?? 'openai');
  const [embeddingModel, setEmbeddingModel] = useState<string>(coworkConfig.embeddingModel ?? '');
  const [embeddingLocalModelPath, setEmbeddingLocalModelPath] = useState<string>(coworkConfig.embeddingLocalModelPath ?? '');
  const [embeddingVectorWeight, setEmbeddingVectorWeight] = useState<number>(coworkConfig.embeddingVectorWeight ?? 0.7);
  const [embeddingRemoteBaseUrl, setEmbeddingRemoteBaseUrl] = useState<string>(coworkConfig.embeddingRemoteBaseUrl ?? '');
  const [embeddingRemoteApiKey, setEmbeddingRemoteApiKey] = useState<string>(coworkConfig.embeddingRemoteApiKey ?? '');
  const [dreamingEnabled, setDreamingEnabled] = useState<boolean>(coworkConfig.dreamingEnabled ?? false);
  const [dreamingFrequency, setDreamingFrequency] = useState<string>(coworkConfig.dreamingFrequency ?? '0 3 * * *');
  const [dreamingModel, setDreamingModel] = useState<string>(coworkConfig.dreamingModel ?? '');
  const [dreamingTimezone, setDreamingTimezone] = useState<string>(coworkConfig.dreamingTimezone ?? '');
  const [memoryTab, setMemoryTab] = useState<'entries' | 'embedding'>('entries');
  const [openClawSessionKeepAlive, setOpenClawSessionKeepAlive] = useState<OpenClawSessionKeepAlive>(
    coworkConfig.openClawSessionPolicy?.keepAlive || OpenClawSessionKeepAliveValues.ThirtyDays,
  );
  const [coworkMemoryEntries, setCoworkMemoryEntries] = useState<CoworkUserMemoryEntry[]>([]);
  const [coworkMemoryStats, setCoworkMemoryStats] = useState<CoworkMemoryStats | null>(null);
  const [coworkMemoryListLoading, setCoworkMemoryListLoading] = useState<boolean>(false);
  const [coworkMemoryQuery, setCoworkMemoryQuery] = useState<string>('');
  const [coworkMemoryEditingId, setCoworkMemoryEditingId] = useState<string | null>(null);
  const [coworkMemoryDraftText, setCoworkMemoryDraftText] = useState<string>('');
  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [coworkMemoryRawMode, setCoworkMemoryRawMode] = useState<boolean>(false);
  const [coworkMemoryRawText, setCoworkMemoryRawText] = useState<string>('');
  const [coworkMemoryRawSaving, setCoworkMemoryRawSaving] = useState<boolean>(false);
  const [coworkMemoryExpandedIds, setCoworkMemoryExpandedIds] = useState<Set<string>>(new Set());
  const [openClawEngineStatus, setOpenClawEngineStatus] = useState<OpenClawEngineStatus | null>(null);
  const [showOpenClawRepairConfirm, setShowOpenClawRepairConfirm] = useState<boolean>(false);
  const [isRepairingOpenClaw, setIsRepairingOpenClaw] = useState<boolean>(false);
  const [openClawRepairResult, setOpenClawRepairResult] = useState<OpenClawGatewayRepairResult | null>(null);
  const [openClawGatewayCopied, setOpenClawGatewayCopied] = useState<boolean>(false);
  const [isBackingUpOpenClawData, setIsBackingUpOpenClawData] = useState<boolean>(false);
  const [isRestoringOpenClawData, setIsRestoringOpenClawData] = useState<boolean>(false);
  const [openClawDataBackupResult, setOpenClawDataBackupResult] = useState<{ path: string; sizeBytes?: number } | null>(null);
  const [showOpenClawDataRestoreConfirm, setShowOpenClawDataRestoreConfirm] = useState<boolean>(false);

  useEffect(() => {
    setCoworkAgentEngine(coworkConfig.agentEngine || 'openclaw');
    setCoworkMemoryEnabled(coworkConfig.memoryEnabled ?? true);
    setCoworkMemoryLlmJudgeEnabled(coworkConfig.memoryLlmJudgeEnabled ?? false);
    setSkipMissedJobs(coworkConfig.skipMissedJobs ?? true);
    setOpenClawHeartbeatEnabled(coworkConfig.openClawHeartbeatEnabled ?? true);
    setEmbeddingEnabled(coworkConfig.embeddingEnabled ?? false);
    setEmbeddingProvider(coworkConfig.embeddingProvider ?? 'openai');
    setEmbeddingModel(coworkConfig.embeddingModel ?? '');
    setEmbeddingLocalModelPath(coworkConfig.embeddingLocalModelPath ?? '');
    setEmbeddingVectorWeight(coworkConfig.embeddingVectorWeight ?? 0.7);
    setEmbeddingRemoteBaseUrl(coworkConfig.embeddingRemoteBaseUrl ?? '');
    setEmbeddingRemoteApiKey(coworkConfig.embeddingRemoteApiKey ?? '');
    setDreamingEnabled(coworkConfig.dreamingEnabled ?? false);
    setDreamingFrequency(coworkConfig.dreamingFrequency ?? '0 3 * * *');
    setDreamingModel(coworkConfig.dreamingModel ?? '');
    setDreamingTimezone(coworkConfig.dreamingTimezone ?? '');
    setOpenClawSessionKeepAlive(coworkConfig.openClawSessionPolicy?.keepAlive || OpenClawSessionKeepAliveValues.ThirtyDays);
  }, [
    coworkConfig.agentEngine,
    coworkConfig.memoryEnabled,
    coworkConfig.memoryLlmJudgeEnabled,
    coworkConfig.openClawSessionPolicy?.keepAlive,
    coworkConfig.skipMissedJobs,
    coworkConfig.openClawHeartbeatEnabled,
    coworkConfig.embeddingEnabled,
    coworkConfig.embeddingProvider,
    coworkConfig.embeddingModel,
    coworkConfig.embeddingLocalModelPath,
    coworkConfig.embeddingVectorWeight,
    coworkConfig.embeddingRemoteBaseUrl,
    coworkConfig.embeddingRemoteApiKey,
    coworkConfig.dreamingEnabled,
    coworkConfig.dreamingFrequency,
    coworkConfig.dreamingModel,
    coworkConfig.dreamingTimezone,
  ]);

  useEffect(() => () => {
    if (emailCopiedTimerRef.current != null) {
      window.clearTimeout(emailCopiedTimerRef.current);
    }
    if (openClawGatewayCopiedTimerRef.current != null) {
      window.clearTimeout(openClawGatewayCopiedTimerRef.current);
    }
    if (updateCheckTimerRef.current != null) {
      window.clearTimeout(updateCheckTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void window.electron.openclaw.dataMigration.getLastRestoreResult().then((response) => {
      if (!active || !response.success || !response.result) return;
      if (response.result.status === DataMigrationRestoreStatus.Success) {
        setNoticeMessage(i18nService.t('openClawDataMigrationSuccess'));
        return;
      }
      const message = response.result.error
        ? `${i18nService.t('openClawDataMigrationFailed')}: ${response.result.error}`
        : i18nService.t('openClawDataMigrationFailed');
      setError(message);
    }).catch((loadError) => {
      if (!active) return;
      setError(loadError instanceof Error ? loadError.message : i18nService.t('openClawDataMigrationFailed'));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void coworkService.getOpenClawEngineStatus().then((status) => {
      if (!active || !status) return;
      setOpenClawEngineStatus(status);
    });
    const unsubscribe = coworkService.onOpenClawEngineStatus((status) => {
      if (!active) return;
      setOpenClawEngineStatus(status);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    try {
      const config = configService.getConfig();

      // Set general settings
      const resolvedUiFontSize = normalizeFontPreference(
        config.uiFontSize,
        FontPreferences.UiFontSizeDefault,
        FontPreferences.UiFontSizeMin,
        FontPreferences.UiFontSizeMax,
      );
      const resolvedCodeFontSize = normalizeFontPreference(
        config.codeFontSize,
        FontPreferences.CodeFontSizeDefault,
        FontPreferences.CodeFontSizeMin,
        FontPreferences.CodeFontSizeMax,
      );
      initialThemeRef.current = config.theme;
      initialUiFontSizeRef.current = resolvedUiFontSize;
      initialCodeFontSizeRef.current = resolvedCodeFontSize;
      initialLanguageRef.current = config.language;
      setTheme(config.theme);
      setUiFontSize(resolvedUiFontSize);
      setCodeFontSize(resolvedCodeFontSize);
      setLanguage(config.language);
      setUseSystemProxy(config.useSystemProxy ?? false);
      setSqliteAutoBackupEnabled(config.sqliteAutoBackupEnabled === true);
      setUsageAnalyticsEnabled(config.usageAnalyticsEnabled !== false);
      setTaskCompletionNotificationsEnabled(
        normalizeNotificationSettings(config.notificationSettings).taskCompletionNotificationsEnabled,
      );
      setBrowserWebAccess(normalizeBrowserWebAccessConfig(config.browserWebAccess));
      const savedTestMode = config.app?.testMode ?? false;
      setTestMode(savedTestMode);
      if (savedTestMode) setTestModeUnlocked(true);

      // Load auto-launch setting
      window.electron.autoLaunch.get().then(({ enabled }) => {
        console.log(`[Renderer][Settings] loaded auto-launch setting: enabled=${enabled}`);
        setAutoLaunchState(enabled);
      }).catch(err => {
        console.error('Failed to load auto-launch setting:', err);
      });

      // Load prevent-sleep setting
      window.electron.preventSleep.get().then(({ enabled }) => {
        setPreventSleepState(enabled);
      }).catch(err => {
        console.error('Failed to load prevent-sleep setting:', err);
      });

      // Set up providers based on saved config
      if (config.api) {
        // For backward compatibility with older config
        // Initialize active provider based on baseUrl
        const normalizedApiBaseUrl = config.api.baseUrl.toLowerCase();
        if (normalizedApiBaseUrl.includes('openai')) {
          setActiveProvider('openai');
          setProviders(prev => ({
            ...prev,
            openai: {
              ...prev.openai,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('deepseek')) {
          setActiveProvider('deepseek');
          setProviders(prev => ({
            ...prev,
            deepseek: {
              ...prev.deepseek,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('moonshot.ai') || normalizedApiBaseUrl.includes('moonshot.cn')) {
          setActiveProvider('moonshot');
          setProviders(prev => ({
            ...prev,
            moonshot: {
              ...prev.moonshot,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('bigmodel.cn')) {
          setActiveProvider('zhipu');
          setProviders(prev => ({
            ...prev,
            zhipu: {
              ...prev.zhipu,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('minimax')) {
          setActiveProvider('minimax');
          setProviders(prev => ({
            ...prev,
            minimax: {
              ...prev.minimax,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('openapi.youdao.com')) {
          setActiveProvider('youdaozhiyun');
          setProviders(prev => ({
            ...prev,
            youdaozhiyun: {
              ...prev.youdaozhiyun,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('dashscope')) {
          setActiveProvider('qwen');
          setProviders(prev => ({
            ...prev,
            qwen: {
              ...prev.qwen,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('stepfun')) {
          setActiveProvider('stepfun');
          setProviders(prev => ({
            ...prev,
            stepfun: {
              ...prev.stepfun,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('openrouter.ai')) {
          setActiveProvider('openrouter');
          setProviders(prev => ({
            ...prev,
            openrouter: {
              ...prev.openrouter,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('googleapis')) {
          setActiveProvider('gemini');
          setProviders(prev => ({
            ...prev,
            gemini: {
              ...prev.gemini,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('anthropic')) {
          setActiveProvider('anthropic');
          setProviders(prev => ({
            ...prev,
            anthropic: {
              ...prev.anthropic,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('ollama') || normalizedApiBaseUrl.includes('11434')) {
          setActiveProvider('ollama');
          setProviders(prev => ({
            ...prev,
            ollama: {
              ...prev.ollama,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('lm-studio') || normalizedApiBaseUrl.includes(':1234')) {
          setActiveProvider('lm-studio');
          setProviders(prev => ({
            ...prev,
            'lm-studio': {
              ...prev['lm-studio'],
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        }
      }

      // Load provider-specific configurations if available
      // 合并已保存的配置和默认配置，确保新添加的 provider 能被显示
      if (config.providers) {
        setProviders(prev => {
          const merged = {
            ...prev,  // 保留默认的 providers（包括新添加的 anthropic）
            ...config.providers,  // 覆盖已保存的配置
          };

          // After merging, find the first enabled provider to set as activeProvider
          // This ensures we don't use stale activeProvider from old config.api.baseUrl
          const firstEnabledProvider = providerKeys.find(providerKey => merged[providerKey]?.enabled);
          if (firstEnabledProvider) {
            setActiveProvider(firstEnabledProvider);
          }

          return Object.fromEntries(
            Object.entries(merged).map(([providerKey, providerConfig]) => {
              const models = providerConfig.models?.map((model, idx) => {
                let id = model.id;
                // Fix corrupted model IDs from previous OAuth mutation bug
                if (providerKey === 'qwen' && (id === 'vision-model' || id === 'coder-model')) {
                  const defaultModel = defaultConfig.providers?.qwen?.models?.[idx];
                  id = defaultModel?.id || 'qwen3.5-plus';
                }
                return {
                  ...model,
                  id,
                  supportsImage: ProviderRegistry.resolveModelSupportsImage(
                    providerKey,
                    id,
                    model.supportsImage,
                  ),
                };
              });
              return [
                providerKey,
                {
                  ...providerConfig,
                  apiFormat: getEffectiveApiFormat(providerKey, (providerConfig as ProviderConfig).apiFormat),
                  ...(providerKey === ProviderName.Copilot && providerConfig.apiKey?.trim()
                    ? { authType: ProviderAuthType.OAuth, apiKey: '' }
                    : {}),
                  models,
                },
              ];
            })
          ) as ProvidersConfig;
        });
      }

      // 加载快捷键设置
      if (config.shortcuts) {
        setShortcuts(prev => ({
          ...prev,
          ...config.shortcuts,
        }));
      }
    } catch {
      setError('Failed to load settings');
    }
  }, []);

  useEffect(() => {
    const initialThemeId = initialThemeIdRef.current;
    const initialTheme = initialThemeRef.current;
    const initialUiFontSize = initialUiFontSizeRef.current;
    const initialCodeFontSize = initialCodeFontSizeRef.current;
    const initialLanguage = initialLanguageRef.current;
    return () => {
      if (didSaveRef.current) {
        return;
      }
      themeService.restoreTheme(initialThemeId, initialTheme);
      applyTypographyPreferences({
        uiFontSize: initialUiFontSize,
        codeFontSize: initialCodeFontSize,
      });
      i18nService.setLanguage(initialLanguage, { persist: false });
    };
  }, []);

  // 监听标签页切换，确保内容区域滚动到顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  // 跟踪内容区滚动/尺寸/内容变化，决定底部渐隐遮罩是否显示
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setFooterFadeVisible(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };
    scheduleUpdate();
    el.addEventListener('scroll', scheduleUpdate, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(el);
    const mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    setNoticeMessage(buildNoticeMessage());
  }, [buildNoticeMessage]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab, initialTabRequestId]);

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
      // Re-translate notice message on language change
      if (noticeI18nKey) {
        const base = i18nService.t(noticeI18nKey);
        setNoticeMessage(noticeExtra ? `${base} (${noticeExtra})` : base);
      }
    });
    return unsubscribe;
  }, [noticeI18nKey, noticeExtra]);

  // Compute visible providers based on language, including active custom_N entries
  const visibleProviders = useMemo(() => {
    const visibleKeys = getVisibleProviders(language);
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of visibleKeys) {
      if (providers[key as keyof ProvidersConfig]) {
        filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
      }
    }
    // Append custom_N providers that exist in state, sorted by numeric suffix
    for (const key of CUSTOM_PROVIDER_KEYS) {
      if (providers[key]) {
        filtered[key] = providers[key];
      }
    }
    return filtered as ProvidersConfig;
  }, [language, providers]);

  // Ensure activeProvider is always in visibleProviders when language changes
  useEffect(() => {
    const visibleKeys = Object.keys(visibleProviders) as ProviderType[];
    if (visibleKeys.length > 0 && !visibleKeys.includes(activeProvider)) {
      // If current activeProvider is not visible, switch to first visible provider
      const firstEnabledVisible = visibleKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider(firstEnabledVisible ?? visibleKeys[0]);
    }
  }, [visibleProviders, activeProvider]);

  // Handle adding a new custom provider
  const handleAddCustomProvider = () => {
    // Find the first unused custom slot
    const usedKeys = new Set(Object.keys(providers));
    const newKey = CUSTOM_PROVIDER_KEYS.find(k => !usedKeys.has(k));
    if (!newKey) return; // All 10 slots used
    setProviders(prev => ({
      ...prev,
      [newKey]: {
        enabled: false,
        apiKey: '',
        baseUrl: '',
        apiFormat: 'openai' as const,
        models: [],
        displayName: undefined,
      },
    }));
    setActiveProvider(newKey);
    setShowApiKey(false);
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  // Handle deleting a custom provider
  const handleDeleteCustomProvider = (key: ProviderType) => {
    setPendingDeleteProvider(key);
  };

  const confirmDeleteCustomProvider = async () => {
    const key = pendingDeleteProvider;
    if (!key) return;
    setPendingDeleteProvider(null);
    const currentConfig = configService.getConfig();
    setProviders(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    // If the deleted provider was active, switch to first visible BEFORE the
    // await below. Otherwise the intermediate render triggered while awaiting
    // would still have activeProvider pointing at the just-deleted key, and the
    // model settings render accesses providers[activeProvider].* without guards,
    // crashing the whole view (white screen).
    if (activeProvider === key) {
      const visibleKeys = Object.keys(visibleProviders).filter(k => k !== key) as ProviderType[];
      const firstEnabled = visibleKeys.find(k => visibleProviders[k]?.enabled);
      setActiveProvider(firstEnabled ?? visibleKeys[0] ?? providerKeys[0]);
    }
    // Persist the deletion immediately so it survives window close
    const updatedProviders = { ...currentConfig.providers };
    delete updatedProviders[key];
    try {
      await configService.updateConfig({ providers: updatedProviders as AppConfig['providers'] });
      if (usageAnalyticsEnabled) {
        const customModelSettingsSummary = buildCustomModelSettingsAnalyticsSummary(
          (currentConfig.providers ?? providers) as ProvidersConfig,
          updatedProviders as ProvidersConfig,
        );
        if (customModelSettingsSummary) {
          reportCustomModelSettingsSaved(customModelSettingsSummary);
        }
      }
    } catch (deleteError) {
      console.warn('[Settings] failed to persist custom provider deletion:', deleteError);
    }
  };

  // Handle provider change
  const handleProviderChange = (provider: ProviderType) => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
    setActiveProvider(provider);
    // 切换 provider 时清除测试结果
    setIsTestResultModalOpen(false);
    setTestResult(null);
  };

  // Handle provider configuration change
  const handleProviderConfigChange = (provider: ProviderType, field: string, value: string) => {
    setProviders(prev => {
      if (field === 'apiFormat') {
        const nextApiFormat = getEffectiveApiFormat(provider, value);
        const nextProviderConfig: ProviderConfig = {
          ...prev[provider],
          apiFormat: nextApiFormat,
        };

        // Only auto-switch URL when current value is still a known default URL.
        if (shouldAutoSwitchProviderBaseUrl(provider, prev[provider].baseUrl)) {
          const defaultBaseUrl = getProviderDefaultBaseUrl(provider, nextApiFormat);
          if (defaultBaseUrl) {
            nextProviderConfig.baseUrl = defaultBaseUrl;
          }
        }

        return {
          ...prev,
          [provider]: nextProviderConfig,
        };
      }

      // Handle codingPlanEnabled toggle for all supported providers
      if (field === 'codingPlanEnabled') {
        const def = ProviderRegistry.get(provider);
        if (def?.codingPlanSupported) {
          const enabled = value === 'true';
          const nextModels = enabled && def.codingPlanModels
            ? def.codingPlanModels.map(m => ({ ...m }))
            : def.defaultModels.map(m => ({ ...m }));
          return {
            ...prev,
            [provider]: {
              ...prev[provider],
              codingPlanEnabled: enabled,
              models: nextModels,
            },
          };
        }
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          [field]: value,
        },
      };
    });
  };

  const handleMiniMaxDeviceLogin = async (region: MiniMaxRegion) => {
    minimaxOAuthCancelRef.current = false;
    setMinimaxOAuthPhase({ kind: 'requesting_code' });

    const codeEndpoint = region === 'cn' ? MINIMAX_CODE_ENDPOINT_CN : MINIMAX_CODE_ENDPOINT_GLOBAL;
    const tokenEndpoint = region === 'cn' ? MINIMAX_TOKEN_ENDPOINT_CN : MINIMAX_TOKEN_ENDPOINT_GLOBAL;
    const defaultBaseUrl = region === 'cn' ? MINIMAX_BASE_URL_CN : MINIMAX_BASE_URL_GLOBAL;

    try {
      const { verifier, challenge, state } = await generateMiniMaxPkce();

      const codeBody = [
        'response_type=code',
        `client_id=${encodeURIComponent(MINIMAX_OAUTH_CLIENT_ID)}`,
        `scope=${encodeURIComponent(MINIMAX_OAUTH_SCOPE)}`,
        `code_challenge=${encodeURIComponent(challenge)}`,
        'code_challenge_method=S256',
        `state=${encodeURIComponent(state)}`,
      ].join('&');

      const codeRes = await window.electron.api.fetch({
        url: codeEndpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: codeBody,
      });

      if (!codeRes.ok) {
        throw new Error(`MiniMax OAuth authorization failed: ${codeRes.status}`);
      }

      const codePayload = (codeRes.data ?? {}) as {
        user_code?: string;
        verification_uri?: string;
        expired_in?: number;
        interval?: number;
        state?: string;
        error?: string;
      };

      if (!codePayload.user_code || !codePayload.verification_uri) {
        throw new Error(codePayload.error ?? 'MiniMax OAuth returned incomplete authorization payload');
      }

      if (codePayload.state !== state) {
        throw new Error('MiniMax OAuth state mismatch: possible CSRF attack or session corruption');
      }

      try {
        await window.electron.shell.openExternal(codePayload.verification_uri);
      } catch { /* ignore: user can open manually */ }

      setMinimaxOAuthPhase({
        kind: 'pending',
        userCode: codePayload.user_code,
        verificationUri: codePayload.verification_uri,
      });

      let pollIntervalMs = codePayload.interval ?? 2000;
      const expireTimeMs = codePayload.expired_in ?? (Date.now() + 5 * 60 * 1000);

      while (Date.now() < expireTimeMs) {
        if (minimaxOAuthCancelRef.current) {
          setMinimaxOAuthPhase({ kind: 'idle' });
          return;
        }

        await new Promise(r => setTimeout(r, pollIntervalMs));

        if (minimaxOAuthCancelRef.current) {
          setMinimaxOAuthPhase({ kind: 'idle' });
          return;
        }

        const tokenBody = [
          `grant_type=${encodeURIComponent(MINIMAX_OAUTH_GRANT_TYPE)}`,
          `client_id=${encodeURIComponent(MINIMAX_OAUTH_CLIENT_ID)}`,
          `user_code=${encodeURIComponent(codePayload.user_code)}`,
          `code_verifier=${encodeURIComponent(verifier)}`,
        ].join('&');

        const tokenRes = await window.electron.api.fetch({
          url: tokenEndpoint,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: tokenBody,
        });

        const tokenPayload = (tokenRes.data ?? {}) as {
          status?: string;
          access_token?: string;
          refresh_token?: string;
          expired_in?: number;
          resource_url?: string;
          notification_message?: string;
          base_resp?: { status_code?: number; status_msg?: string };
        };

        if (tokenPayload.status === 'error') {
          throw new Error(tokenPayload.base_resp?.status_msg ?? 'MiniMax OAuth error');
        }

        if (tokenPayload.status === 'success') {
          if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
            throw new Error('MiniMax OAuth returned incomplete token payload');
          }

          let baseUrl = (tokenPayload.resource_url ?? '').trim();
          if (baseUrl && !baseUrl.startsWith('http')) {
            baseUrl = `https://${baseUrl}`;
          }
          if (!baseUrl) {
            baseUrl = defaultBaseUrl;
          }

          setProviders(prev => ({
            ...prev,
            minimax: {
              ...prev.minimax,
              enabled: true,
              oauthAccessToken: tokenPayload.access_token!,
              oauthBaseUrl: baseUrl,
              apiFormat: 'anthropic',
              authType: 'oauth',
              oauthRefreshToken: tokenPayload.refresh_token,
              oauthTokenExpiresAt: tokenPayload.expired_in,
              models: [...(defaultConfig.providers?.minimax.models ?? [])],
            },
          }));

          setMinimaxOAuthPhase({ kind: 'success' });
          setTimeout(() => setMinimaxOAuthPhase({ kind: 'idle' }), 1500);
          return;
        }

        // Still pending — back off gradually
        pollIntervalMs = Math.min(pollIntervalMs * 1.5, 10000);
      }

      throw new Error('MiniMax OAuth timed out waiting for authorization');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMinimaxOAuthPhase({ kind: 'error', message });
    }
  };

  const handleCancelMiniMaxLogin = () => {
    minimaxOAuthCancelRef.current = true;
    setMinimaxOAuthPhase({ kind: 'idle' });
  };

  const handleMiniMaxOAuthLogout = () => {
    setProviders(prev => ({
      ...prev,
      minimax: {
        ...prev.minimax,
        enabled: false,
        oauthAccessToken: undefined,
        oauthBaseUrl: undefined,
        oauthRefreshToken: undefined,
        oauthTokenExpiresAt: undefined,
      },
    }));
    setMinimaxOAuthPhase({ kind: 'idle' });
  };

  // Sync the persisted ChatGPT login state into local UI state on mount and
  // whenever the OpenAI provider tab becomes active. Also reconciles stale
  // providers config (e.g. auth.json deleted externally).
  useEffect(() => {
    let cancelled = false;
    if (activeProvider !== 'openai') return;
    void window.electron.openaiCodexOAuth.status().then((status) => {
      if (cancelled) return;
      if (status.loggedIn) {
        setOpenaiOAuthStatus({ loggedIn: true, email: status.email ?? undefined });
      } else {
        setOpenaiOAuthStatus({ loggedIn: false });
        setProviders(prev => {
          if (prev.openai.authType !== 'oauth') return prev;
          return { ...prev, openai: { ...prev.openai, authType: 'apikey' } };
        });
      }
    }).catch(() => {
      if (!cancelled) setOpenaiOAuthStatus({ loggedIn: false });
    });
    return () => { cancelled = true; };
  }, [activeProvider]);

  const persistProviderAuthConfigInBackground = useCallback((nextProviders: ProvidersConfig) => {
    void configService.updateConfig({ providers: nextProviders }).catch((saveError) => {
      console.error('[Settings] failed to save provider auth state:', saveError);
      setError(i18nService.t('failedToSaveSettings'));
    });
  }, []);

  const handleOpenAIOAuthLogin = async () => {
    setOpenaiOAuthPhase({ kind: 'pending' });
    try {
      const result = await window.electron.openaiCodexOAuth.start();
      if (!result.success) {
        setOpenaiOAuthPhase({ kind: 'error', message: result.error });
        return;
      }
      const nextProviders: ProvidersConfig = {
        ...providers,
        openai: {
          ...providers.openai,
          enabled: true,
          authType: 'oauth',
        },
      };
      setProviders(nextProviders);
      setOpenaiOAuthStatus({ loggedIn: true, email: result.email ?? undefined });
      setOpenaiOAuthPhase({ kind: 'success', email: result.email ?? undefined });
      persistProviderAuthConfigInBackground(nextProviders);
      setTimeout(() => setOpenaiOAuthPhase({ kind: 'idle' }), 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOpenaiOAuthPhase({ kind: 'error', message });
    }
  };

  const handleCancelOpenAIOAuthLogin = async () => {
    try {
      await window.electron.openaiCodexOAuth.cancel();
    } catch {
      /* ignore — we still want to reset the UI */
    }
    setOpenaiOAuthPhase({ kind: 'idle' });
  };

  const handleOpenAIOAuthLogout = async () => {
    const nextOpenAIProvider = {
      ...providers.openai,
      enabled: providers.openai.apiKey.trim().length > 0,
      authType: 'apikey' as const,
    };
    const nextProviders: ProvidersConfig = {
      ...providers,
      openai: {
        ...nextOpenAIProvider,
      },
    };
    setProviders(nextProviders);
    setOpenaiOAuthStatus({ loggedIn: false });
    setOpenaiOAuthPhase({ kind: 'idle' });
    persistProviderAuthConfigInBackground(nextProviders);
    try {
      await window.electron.openaiCodexOAuth.logout();
    } catch {
      /* ignore — file may already be gone */
    }
  };

  // Sync the persisted xAI login state (OpenClaw auth-profiles store) into
  // local UI state whenever the xAI provider tab becomes active. Also
  // reconciles stale providers config (e.g. credential removed externally).
  useEffect(() => {
    let cancelled = false;
    if (activeProvider !== 'xai') return;
    void window.electron.xaiOAuth.status().then((status) => {
      if (cancelled) return;
      if (status.loggedIn) {
        setXaiOAuthStatus({ loggedIn: true, email: status.email });
      } else {
        setXaiOAuthStatus({ loggedIn: false });
        setProviders(prev => {
          if (prev.xai.authType !== 'oauth') return prev;
          return { ...prev, xai: { ...prev.xai, authType: 'apikey' } };
        });
      }
    }).catch(() => {
      if (!cancelled) setXaiOAuthStatus({ loggedIn: false });
    });
    return () => { cancelled = true; };
  }, [activeProvider]);

  const handleXaiOAuthLogin = async () => {
    setXaiOAuthPhase({ kind: 'pending' });
    // The main process falls back to the device-code flow when the loopback
    // callback port is taken — surface the user code as soon as it arrives.
    const unsubscribeDeviceCode = window.electron.xaiOAuth.onDeviceCode((info) => {
      setXaiOAuthPhase({
        kind: 'device_code',
        userCode: info.userCode,
        verificationUri: info.verificationUriComplete ?? info.verificationUri,
      });
    });
    try {
      const result = await window.electron.xaiOAuth.start();
      if (!result.success) {
        if (/cancelled/i.test(result.error)) {
          setXaiOAuthPhase({ kind: 'idle' });
        } else {
          setXaiOAuthPhase({ kind: 'error', message: result.error });
        }
        return;
      }
      const nextProviders: ProvidersConfig = {
        ...providers,
        xai: {
          ...providers.xai,
          enabled: true,
          authType: 'oauth',
        },
      };
      setProviders(nextProviders);
      setXaiOAuthStatus({ loggedIn: true, email: result.email ?? undefined });
      setXaiOAuthPhase({ kind: 'success', email: result.email ?? undefined });
      persistProviderAuthConfigInBackground(nextProviders);
      setTimeout(() => setXaiOAuthPhase({ kind: 'idle' }), 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setXaiOAuthPhase({ kind: 'error', message });
    } finally {
      unsubscribeDeviceCode();
    }
  };

  const handleCancelXaiOAuthLogin = async () => {
    try {
      await window.electron.xaiOAuth.cancel();
    } catch {
      /* ignore — we still want to reset the UI */
    }
    setXaiOAuthPhase({ kind: 'idle' });
  };

  const handleXaiOAuthLogout = async () => {
    const nextProviders: ProvidersConfig = {
      ...providers,
      xai: {
        ...providers.xai,
        enabled: providers.xai.apiKey.trim().length > 0,
        authType: 'apikey' as const,
      },
    };
    setProviders(nextProviders);
    setXaiOAuthStatus({ loggedIn: false });
    setXaiOAuthPhase({ kind: 'idle' });
    persistProviderAuthConfigInBackground(nextProviders);
    try {
      await window.electron.xaiOAuth.logout();
    } catch {
      /* ignore — credential may already be gone */
    }
  };

  const hasCoworkConfigChanges = coworkAgentEngine !== coworkConfig.agentEngine
    || coworkMemoryEnabled !== coworkConfig.memoryEnabled
    || coworkMemoryLlmJudgeEnabled !== coworkConfig.memoryLlmJudgeEnabled
    || skipMissedJobs !== (coworkConfig.skipMissedJobs ?? true)
    || openClawHeartbeatEnabled !== (coworkConfig.openClawHeartbeatEnabled ?? true)
    || openClawSessionKeepAlive !== (coworkConfig.openClawSessionPolicy?.keepAlive || OpenClawSessionKeepAliveValues.ThirtyDays)
    || embeddingEnabled !== (coworkConfig.embeddingEnabled ?? false)
    || embeddingProvider !== (coworkConfig.embeddingProvider ?? 'openai')
    || embeddingModel !== (coworkConfig.embeddingModel ?? '')
    || embeddingLocalModelPath !== (coworkConfig.embeddingLocalModelPath ?? '')
    || embeddingVectorWeight !== (coworkConfig.embeddingVectorWeight ?? 0.7)
    || embeddingRemoteBaseUrl !== (coworkConfig.embeddingRemoteBaseUrl ?? '')
    || embeddingRemoteApiKey !== (coworkConfig.embeddingRemoteApiKey ?? '')
    || dreamingEnabled !== (coworkConfig.dreamingEnabled ?? false)
    || dreamingFrequency !== (coworkConfig.dreamingFrequency ?? '0 3 * * *');
  const isOpenClawAgentEngine = coworkAgentEngine === 'openclaw';

  const openClawProgressPercent = useMemo(() => {
    if (typeof openClawEngineStatus?.progressPercent !== 'number' || !Number.isFinite(openClawEngineStatus.progressPercent)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(openClawEngineStatus.progressPercent)));
  }, [openClawEngineStatus]);

  const openClawStatusTone = useMemo(() => {
    const phase = openClawEngineStatus?.phase;

    if (phase === OpenClawEnginePhase.Error) {
      return {
        Icon: ExclamationTriangleIcon,
        iconClassName: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
        progressClassName: 'bg-red-500',
        spinIcon: false,
        inProgress: false,
        badgeLabelKey: 'openClawStatusBadgeError',
        badgeClassName: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
        badgeDotClassName: 'bg-red-500',
      };
    }

    if (phase === OpenClawEnginePhase.Running || phase === OpenClawEnginePhase.Ready) {
      return {
        Icon: CheckCircleIcon,
        iconClassName: 'bg-primary-muted text-primary',
        progressClassName: 'bg-primary',
        spinIcon: false,
        inProgress: false,
        badgeLabelKey: phase === OpenClawEnginePhase.Running
          ? 'openClawStatusBadgeRunning'
          : 'openClawStatusBadgeReady',
        badgeClassName: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
        badgeDotClassName: 'bg-emerald-500',
      };
    }

    if (phase === OpenClawEnginePhase.Installing || phase === OpenClawEnginePhase.Starting) {
      return {
        Icon: ArrowPathIcon,
        iconClassName: 'bg-primary-muted text-primary',
        progressClassName: 'bg-primary',
        spinIcon: true,
        inProgress: true,
        badgeLabelKey: phase === OpenClawEnginePhase.Installing
          ? 'openClawStatusBadgeInstalling'
          : 'openClawStatusBadgeStarting',
        badgeClassName: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
        badgeDotClassName: 'bg-amber-500',
      };
    }

    return {
      Icon: CpuChipIcon,
      iconClassName: 'bg-surface-raised text-secondary',
      progressClassName: 'bg-primary',
      spinIcon: false,
      inProgress: false,
      badgeLabelKey: 'openClawStatusBadgeNotInstalled',
      badgeClassName: 'bg-surface-raised text-secondary',
      badgeDotClassName: 'bg-secondary/60',
    };
  }, [openClawEngineStatus?.phase]);

  const OpenClawStatusIcon = openClawStatusTone.Icon;
  const openClawGatewayHttpUrl = openClawEngineStatus?.gatewayHttpUrl?.trim() || null;

  const handleCopyOpenClawGatewayUrl = useCallback(async () => {
    if (!openClawGatewayHttpUrl) return;
    const copied = await copyTextToClipboard(openClawGatewayHttpUrl);
    if (!copied) return;

    setOpenClawGatewayCopied(true);
    if (openClawGatewayCopiedTimerRef.current != null) {
      window.clearTimeout(openClawGatewayCopiedTimerRef.current);
    }
    openClawGatewayCopiedTimerRef.current = window.setTimeout(() => {
      setOpenClawGatewayCopied(false);
      openClawGatewayCopiedTimerRef.current = null;
    }, 1200);
  }, [openClawGatewayHttpUrl]);

  useEffect(() => {
    setOpenClawGatewayCopied(false);
  }, [openClawGatewayHttpUrl]);

  const resolveOpenClawStatusText = (status: OpenClawEngineStatus | null): string => {
    if (!status) {
      return i18nService.t('coworkOpenClawNotInstalledNotice');
    }
    switch (status.phase) {
      case OpenClawEnginePhase.NotInstalled:
        return i18nService.t('coworkOpenClawNotInstalledNotice');
      case OpenClawEnginePhase.Installing:
        return i18nService.t('coworkOpenClawInstalling');
      case OpenClawEnginePhase.Ready:
        return i18nService.t('coworkOpenClawReadyNotice');
      case OpenClawEnginePhase.Starting:
        return i18nService.t('coworkOpenClawStarting');
      case OpenClawEnginePhase.Error:
        return i18nService.t('coworkOpenClawError');
      case OpenClawEnginePhase.Running:
        return i18nService.t('coworkOpenClawRunning');
      default:
        return status.message?.trim() || i18nService.t('coworkOpenClawRunning');
    }
  };

  const resolveOpenClawStatusDescription = (status: OpenClawEngineStatus | null): string => {
    return status?.gatewayHttpUrl || i18nService.t('coworkOpenClawInstallHint');
  };

  const resolveOpenClawRepairMessage = (result: OpenClawGatewayRepairResult): string => {
    if (result.success) {
      return result.backupPath
        ? i18nService.t('openClawRepairSuccess')
        : i18nService.t('openClawRepairSuccessNoBackup');
    }
    if (result.errorCode === OpenClawGatewayRepairErrorCode.Busy) {
      return i18nService.t('openClawRepairBusyError');
    }
    if (result.errorCode === OpenClawGatewayRepairErrorCode.ConfigApplyPending) {
      return i18nService.t('openClawRepairConfigApplyPendingError');
    }
    return result.error?.trim() || i18nService.t('openClawRepairFailed');
  };

  const handleConfirmOpenClawRepair = useCallback(async () => {
    if (isRepairingOpenClaw) return;
    setShowOpenClawRepairConfirm(false);
    setOpenClawRepairResult(null);
    setError(null);
    setIsRepairingOpenClaw(true);
    try {
      const result = await coworkService.repairOpenClawGatewayState();
      setOpenClawRepairResult(result);
      reportAgentEngineMaintenanceAction(
        'repair_gateway_state',
        result.success ? 'success' : 'failed',
        result.success ? {} : { errorCode: result.errorCode ?? 'unknown' },
      );
    } catch (repairError) {
      setOpenClawRepairResult({
        success: false,
        error: repairError instanceof Error ? repairError.message : i18nService.t('openClawRepairFailed'),
      });
      reportAgentEngineMaintenanceAction('repair_gateway_state', 'failed', { errorCode: 'unknown' });
    } finally {
      setIsRepairingOpenClaw(false);
    }
  }, [isRepairingOpenClaw]);

  const handleRevealOpenClawRepairBackup = useCallback(async () => {
    const backupPath = openClawRepairResult?.backupPath;
    if (!backupPath) return;
    try {
      const result = await window.electron.shell.showItemInFolder(backupPath);
      if (!result?.success) {
        setError(result?.error || i18nService.t('showInFolderFailed'));
      }
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : i18nService.t('showInFolderFailed'));
    }
  }, [openClawRepairResult?.backupPath]);

  const handleRevealOpenClawDataBackup = useCallback(async () => {
    const backupPath = openClawDataBackupResult?.path;
    if (!backupPath) return;
    try {
      const result = await window.electron.shell.showItemInFolder(backupPath);
      if (!result?.success) {
        setError(result?.error || i18nService.t('showInFolderFailed'));
      }
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : i18nService.t('showInFolderFailed'));
    }
  }, [openClawDataBackupResult?.path]);

  const persistModelSettingsBeforeDataBackup = useCallback(async () => {
    const normalizedProviders = normalizeProvidersForSettingsSave(providers);
    const primaryProvider = resolvePrimaryProviderForSettingsSave(normalizedProviders, activeProvider);
    await configService.updateConfig({
      api: {
        key: primaryProvider.apiKey,
        baseUrl: primaryProvider.baseUrl,
      },
      providers: normalizedProviders,
    });
  }, [activeProvider, providers]);

  const handleOpenClawDataBackup = useCallback(async () => {
    if (isBackingUpOpenClawData) return;
    setError(null);
    setNoticeMessage(null);
    setOpenClawDataBackupResult(null);
    setIsBackingUpOpenClawData(true);
    try {
      await waitForNextPaint();
      await persistModelSettingsBeforeDataBackup();
      const result = await window.electron.openclaw.dataMigration.backup();
      if (!result.success) {
        setError(result.error || i18nService.t('openClawDataBackupFailed'));
        reportAgentEngineMaintenanceAction('backup_data', 'failed', { errorCode: 'unknown' });
        return;
      }
      if (result.canceled) {
        return;
      }
      if (result.path) {
        setOpenClawDataBackupResult({ path: result.path, sizeBytes: result.sizeBytes });
      }
      setNoticeMessage(i18nService.t('openClawDataBackupSuccess'));
      reportAgentEngineMaintenanceAction('backup_data', 'success', {
        sizeBytes: result.sizeBytes,
      });
    } catch (backupError) {
      setError(backupError instanceof Error ? backupError.message : i18nService.t('openClawDataBackupFailed'));
      reportAgentEngineMaintenanceAction('backup_data', 'failed', { errorCode: 'unknown' });
    } finally {
      setIsBackingUpOpenClawData(false);
    }
  }, [isBackingUpOpenClawData, persistModelSettingsBeforeDataBackup]);

  const handleConfirmOpenClawDataRestore = useCallback(async () => {
    if (isRestoringOpenClawData) return;
    setShowOpenClawDataRestoreConfirm(false);
    setError(null);
    setNoticeMessage(null);
    setIsRestoringOpenClawData(true);
    let keepLoadingUntilRestart = false;
    try {
      await waitForNextPaint();
      const result = await window.electron.openclaw.dataMigration.restore();
      if (!result.success) {
        setError(result.error || i18nService.t('openClawDataMigrationFailed'));
        reportAgentEngineMaintenanceAction('restore_data', 'failed', { errorCode: 'unknown' });
        return;
      }
      if (result.canceled) {
        return;
      }
      if (result.scheduledRestart) {
        keepLoadingUntilRestart = true;
        setNoticeMessage(i18nService.t('openClawDataMigrationRestarting'));
      }
      reportAgentEngineMaintenanceAction('restore_data', 'success');
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : i18nService.t('openClawDataMigrationFailed'));
      reportAgentEngineMaintenanceAction('restore_data', 'failed', { errorCode: 'unknown' });
    } finally {
      if (!keepLoadingUntilRestart) {
        setIsRestoringOpenClawData(false);
      }
    }
  }, [isRestoringOpenClawData]);

  const loadCoworkMemoryData = useCallback(async () => {
    setCoworkMemoryListLoading(true);
    try {
      const [entries, stats] = await Promise.all([
        coworkService.listMemoryEntries({
          query: coworkMemoryQuery.trim() || undefined,
        }),
        coworkService.getMemoryStats(),
      ]);
      setCoworkMemoryEntries(entries);
      setCoworkMemoryStats(stats);
    } catch (loadError) {
      console.error('Failed to load cowork memory data:', loadError);
      setCoworkMemoryEntries([]);
      setCoworkMemoryStats(null);
    } finally {
      setCoworkMemoryListLoading(false);
    }
  }, [
    coworkMemoryQuery,
  ]);

  useEffect(() => {
    if (activeTab !== 'coworkMemory') return;
    void loadCoworkMemoryData();
  }, [activeTab, loadCoworkMemoryData]);

  const resetCoworkMemoryEditor = () => {
    setCoworkMemoryEditingId(null);
    setCoworkMemoryDraftText('');
    setShowMemoryModal(false);
  };

  const handleSaveCoworkMemoryEntry = async () => {
    const text = coworkMemoryDraftText.trim();
    if (!text) return;

    setCoworkMemoryListLoading(true);
    try {
      const operation = coworkMemoryEditingId ? 'updated' : 'created';
      if (coworkMemoryEditingId) {
        await coworkService.updateMemoryEntry({
          id: coworkMemoryEditingId,
          text,
        });
      } else {
        await coworkService.createMemoryEntry({
          text,
        });
      }
      resetCoworkMemoryEditor();
      await loadCoworkMemoryData();
      reportMemoryEntryChanged(
        operation,
        operation === 'created'
          ? (coworkMemoryStats?.total ?? coworkMemoryEntries.length) + 1
          : coworkMemoryStats?.total,
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('coworkMemoryCrudSaveFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleEditCoworkMemoryEntry = (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryEditingId(entry.id);
    setCoworkMemoryDraftText(entry.text);
    setShowMemoryModal(true);
  };

  const handleDeleteCoworkMemoryEntry = async (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryListLoading(true);
    try {
      await coworkService.deleteMemoryEntry({ id: entry.id });
      if (coworkMemoryEditingId === entry.id) {
        resetCoworkMemoryEditor();
      }
      await loadCoworkMemoryData();
      reportMemoryEntryChanged(
        'deleted',
        Math.max(0, (coworkMemoryStats?.total ?? coworkMemoryEntries.length) - 1),
      );
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : i18nService.t('coworkMemoryCrudDeleteFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleOpenCoworkMemoryModal = () => {
    resetCoworkMemoryEditor();
    setShowMemoryModal(true);
  };

  const handleEnterCoworkMemoryRawMode = async () => {
    setError(null);
    const content = await coworkService.readMemoryFileRaw();
    if (content === null) {
      setError(i18nService.t('coworkMemoryRawLoadFailed'));
      return;
    }
    setCoworkMemoryRawText(content);
    setCoworkMemoryRawMode(true);
  };

  const handleSaveCoworkMemoryRaw = async () => {
    if (coworkMemoryRawSaving) return;
    setError(null);
    setCoworkMemoryRawSaving(true);
    try {
      const result = await coworkService.writeMemoryFileRaw(coworkMemoryRawText);
      if (!result.success) {
        setError(result.error || i18nService.t('coworkMemoryRawSaveFailed'));
        return;
      }
      setCoworkMemoryRawMode(false);
      await loadCoworkMemoryData();
    } finally {
      setCoworkMemoryRawSaving(false);
    }
  };

  const toggleCoworkMemoryExpandedId = (id: string) => {
    setCoworkMemoryExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Toggle provider enabled status
  const toggleProviderEnabled = (provider: ProviderType) => {
    const providerConfig = providers[provider];
    const isEnabling = !providerConfig.enabled;
    const hasValidAuth = hasProviderAuthConfigured(provider, providerConfig);

    // GitHub Copilot requires device code auth — redirect to sign-in flow
    if (provider === ProviderName.Copilot && isEnabling && !hasValidAuth) {
      handleCopilotSignIn();
      return;
    }

    if (isEnabling && !hasValidAuth) {
      setError(i18nService.t('apiKeyRequired'));
      return;
    }

    setProviders(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        enabled: !prev[provider].enabled
      }
    }));
  };

  const enableProvider = (provider: ProviderType) => {
    setProviders(prev => {
      if (prev[provider].enabled) {
        return prev;
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          enabled: true,
        },
      };
    });
  };

  // GitHub Copilot device code authentication
  const handleCopilotSignIn = async () => {
    try {
      setCopilotAuthStatus('requesting');
      setCopilotError(null);

      // Step 1: Request device code
      const { userCode, verificationUri, deviceCode, interval, expiresIn } =
        await window.electron.githubCopilot.requestDeviceCode();

      setCopilotUserCode(userCode);
      setCopilotVerificationUri(verificationUri);
      setCopilotAuthStatus('awaiting_user');

      // Open verification URL in browser
      await window.electron.shell.openExternal(verificationUri);

      // Step 2: Poll for token
      setCopilotAuthStatus('polling');
      const result = await window.electron.githubCopilot.pollForToken(deviceCode, interval, expiresIn);

      if (result.success && result.token) {
        setCopilotGithubUser(result.githubUser || '');
        setCopilotAuthStatus('authenticated');

        apiService.setProviderRuntimeCredential(ProviderName.Copilot, {
          apiKey: result.token,
          ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
        });
        setProviders(prev => ({
          ...prev,
          [ProviderName.Copilot]: {
            ...prev[ProviderName.Copilot],
            enabled: true,
            authType: ProviderAuthType.OAuth,
            apiKey: '',
          },
        }));
      } else {
        setCopilotError(result.error || 'Authentication failed');
        setCopilotAuthStatus('error');
      }
    } catch (error: unknown) {
      setCopilotError(error instanceof Error ? error.message : 'Authentication failed');
      setCopilotAuthStatus('error');
    }
  };

  const handleCopilotSignOut = async () => {
    try {
      await window.electron.githubCopilot.signOut();
      setCopilotAuthStatus('idle');
      setCopilotGithubUser('');
      setCopilotUserCode('');
      setCopilotError(null);
      apiService.setProviderRuntimeCredential(ProviderName.Copilot, null);
      setProviders(prev => ({
        ...prev,
        [ProviderName.Copilot]: {
          ...prev[ProviderName.Copilot],
          enabled: false,
          authType: ProviderAuthType.ApiKey,
          apiKey: '',
        },
      }));
    } catch (error) {
      console.error('[Settings] GitHub Copilot sign-out failed:', error);
    }
  };

  const handleCopilotCancelAuth = async () => {
    try {
      await window.electron.githubCopilot.cancelPolling();
      setCopilotAuthStatus('idle');
      setCopilotUserCode('');
      setCopilotError(null);
    } catch (error) {
      console.error('[Settings] GitHub Copilot cancel polling failed:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const normalizedProviders = normalizeProvidersForSettingsSave(providers);
      const primaryProvider = resolvePrimaryProviderForSettingsSave(normalizedProviders, activeProvider);
      const normalizedBrowserWebAccess = normalizeBrowserWebAccessConfig({
        ...browserWebAccess,
        browserEnabled: true,
        profileMode: defaultBrowserWebAccessConfig.profileMode,
        followGlobalProxy: defaultBrowserWebAccessConfig.followGlobalProxy,
        snapshotMode: defaultBrowserWebAccessConfig.snapshotMode,
        executablePath: undefined,
        cdpUrl: undefined,
        attachOnly: undefined,
        remoteCdpTimeoutMs: undefined,
        remoteCdpHandshakeTimeoutMs: undefined,
        extraArgs: [],
        webFetch: defaultBrowserWebAccessConfig.webFetch,
      });
      const previousConfig = configService.getConfig();
      const previousBrowserWebAccess = normalizeBrowserWebAccessConfig(previousConfig.browserWebAccess);
      const previousShortcuts: ShortcutConfig = {
        ...defaultConfig.shortcuts!,
        ...(previousConfig.shortcuts || {}),
      };
      const previousProviders = previousConfig.providers
        ? normalizeProvidersForSettingsSave(previousConfig.providers as ProvidersConfig)
        : normalizedProviders;
      const previousSkipMissedJobs = coworkConfig.skipMissedJobs ?? true;
      const previousOpenClawHeartbeatEnabled = coworkConfig.openClawHeartbeatEnabled ?? true;
      const previousAgentEngine = coworkConfig.agentEngine || 'openclaw';
      const previousOpenClawSessionKeepAlive = coworkConfig.openClawSessionPolicy?.keepAlive
        || OpenClawSessionKeepAliveValues.ThirtyDays;
      const previousMemorySettings = {
        embeddingEnabled: coworkConfig.embeddingEnabled ?? false,
        embeddingModel: coworkConfig.embeddingModel ?? '',
        embeddingProvider: coworkConfig.embeddingProvider ?? 'openai',
        embeddingRemoteApiKey: coworkConfig.embeddingRemoteApiKey ?? '',
        embeddingRemoteBaseUrl: coworkConfig.embeddingRemoteBaseUrl ?? '',
        embeddingVectorWeight: coworkConfig.embeddingVectorWeight ?? 0.7,
        memoryEnabled: coworkConfig.memoryEnabled ?? true,
        memoryLlmJudgeEnabled: coworkConfig.memoryLlmJudgeEnabled ?? false,
      };
      const nextMemorySettings = {
        embeddingEnabled,
        embeddingModel,
        embeddingProvider,
        embeddingRemoteApiKey,
        embeddingRemoteBaseUrl,
        embeddingVectorWeight,
        memoryEnabled: coworkMemoryEnabled,
        memoryLlmJudgeEnabled: coworkMemoryLlmJudgeEnabled,
      };
      const previousDreamingSettings = {
        dreamingEnabled: coworkConfig.dreamingEnabled ?? false,
        dreamingFrequency: coworkConfig.dreamingFrequency ?? '0 3 * * *',
      };
      const nextDreamingSettings = {
        dreamingEnabled,
        dreamingFrequency,
      };
      const previousTaskCompletionNotificationsEnabled = normalizeNotificationSettings(
        previousConfig.notificationSettings,
      ).taskCompletionNotificationsEnabled;
      const previousThemeId = initialThemeIdRef.current;
      const previousUiFontSize = normalizeFontPreference(
        previousConfig.uiFontSize,
        FontPreferences.UiFontSizeDefault,
        FontPreferences.UiFontSizeMin,
        FontPreferences.UiFontSizeMax,
      );
      const previousCodeFontSize = normalizeFontPreference(
        previousConfig.codeFontSize,
        FontPreferences.CodeFontSizeDefault,
        FontPreferences.CodeFontSizeMin,
        FontPreferences.CodeFontSizeMax,
      );
      let savedPluginPendingChanges: PluginPendingChanges | null = null;

      await configService.updateConfig({
        api: {
          key: primaryProvider.apiKey,
          baseUrl: primaryProvider.baseUrl,
        },
        providers: normalizedProviders, // Save all providers configuration
        theme,
        uiFontSize,
        codeFontSize,
        language,
        useSystemProxy,
        sqliteAutoBackupEnabled,
        usageAnalyticsEnabled,
        notificationSettings: {
          taskCompletionNotificationsEnabled,
        },
        browserWebAccess: normalizedBrowserWebAccess,
        shortcuts,
        app: {
          ...previousConfig.app,
          testMode,
        },
      });

      // 应用主题
      themeService.setTheme(theme);
      applyTypographyPreferences({ uiFontSize, codeFontSize });

      // 应用语言
      i18nService.setLanguage(language, { persist: false });

      // Set API with the primary provider - handle Qwen OAuth
      let apiKeyToUse = primaryProvider.apiKey;
      let baseUrlToUse = primaryProvider.baseUrl;


      apiService.setConfig({
        apiKey: apiKeyToUse,
        baseUrl: baseUrlToUse,
      });

      // 更新 Redux store 中的可用模型列表
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; openClawProviderId?: string; supportsImage?: boolean }[] = [];
      Object.entries(normalizedProviders).forEach(([providerName, config]) => {
        if (config.enabled && config.models) {
          const openClawProviderId = getOpenClawProviderIdForConfig(providerName, config);
          config.models.forEach(model => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: getProviderDisplayName(providerName, config),
              providerKey: providerName,
              openClawProviderId,
              supportsImage: resolveModelSupportsImageForProvider(providerName, model),
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));

      if (hasCoworkConfigChanges) {
        const updated = await coworkService.updateConfig({
          agentEngine: coworkAgentEngine,
          memoryEnabled: coworkMemoryEnabled,
          memoryLlmJudgeEnabled: coworkMemoryLlmJudgeEnabled,
          skipMissedJobs,
          openClawHeartbeatEnabled,
          embeddingEnabled,
          embeddingProvider,
          embeddingModel,
          embeddingLocalModelPath,
          embeddingVectorWeight,
          embeddingRemoteBaseUrl,
          embeddingRemoteApiKey,
          dreamingEnabled,
          dreamingFrequency,
          dreamingModel,
          dreamingTimezone,
        });
        if (!updated) {
          throw new Error(i18nService.t('coworkConfigSaveFailed'));
        }
        const savedSessionPolicy = await coworkService.updateSessionPolicy({
          keepAlive: openClawSessionKeepAlive,
        });
        if (!savedSessionPolicy) {
          throw new Error(i18nService.t('coworkConfigSaveFailed'));
        }
      }

      // Ask main to sync IM/OpenClaw config. The main process skips this when
      // the IM fingerprint has not changed, so unrelated settings saves do not
      // restart the gateway.
      const syncSucceeded = await imService.saveAndSyncConfig();
      if (!syncSucceeded) {
        throw new Error(i18nService.t('settingsSavedButOpenClawSyncFailed'));
      }

      // Batch save plugin changes (toggles + configs) if any pending
      if (activeTab === 'plugins' && pluginsSettingsRef.current) {
        const pendingChanges = pluginsSettingsRef.current.getPendingChanges();
        if (pendingChanges) {
          await window.electron?.plugins.batchSave(pendingChanges);
          savedPluginPendingChanges = pendingChanges;
          pluginsSettingsRef.current.resetDirty();
        }
      }

      if (usageAnalyticsEnabled) {
        if (previousConfig.language !== language) {
          reportGeneralSettingChanged('language', language, previousConfig.language);
        }
        if ((previousConfig.useSystemProxy ?? false) !== useSystemProxy) {
          reportGeneralSettingChanged('useSystemProxy', useSystemProxy, previousConfig.useSystemProxy ?? false);
        }
        if ((previousConfig.sqliteAutoBackupEnabled === true) !== sqliteAutoBackupEnabled) {
          reportGeneralSettingChanged(
            'sqliteAutoBackupEnabled',
            sqliteAutoBackupEnabled,
            previousConfig.sqliteAutoBackupEnabled === true,
          );
        }
        if (previousTaskCompletionNotificationsEnabled !== taskCompletionNotificationsEnabled) {
          reportGeneralSettingChanged(
            'taskCompletionNotificationsEnabled',
            taskCompletionNotificationsEnabled,
            previousTaskCompletionNotificationsEnabled,
          );
        }
        if (previousSkipMissedJobs !== skipMissedJobs) {
          reportGeneralSettingChanged('skipMissedJobs', skipMissedJobs, previousSkipMissedJobs);
        }
        if (previousConfig.theme !== theme) {
          reportAppearanceSettingChanged('theme', theme, previousConfig.theme);
        }
        if (previousThemeId !== themeId) {
          reportAppearanceSettingChanged('themeId', themeId, previousThemeId);
        }
        if (previousUiFontSize !== uiFontSize) {
          reportAppearanceSettingChanged('uiFontSize', uiFontSize, previousUiFontSize);
        }
        if (previousCodeFontSize !== codeFontSize) {
          reportAppearanceSettingChanged('codeFontSize', codeFontSize, previousCodeFontSize);
        }
        const browserSettingParams = buildBrowserSettingAnalyticsParams(
          previousBrowserWebAccess,
          normalizedBrowserWebAccess,
        );
        if (browserSettingParams) {
          reportBrowserSettingChanged(browserSettingParams);
        }
        if (previousAgentEngine !== coworkAgentEngine) {
          reportAgentEngineSettingChanged('agentEngine', coworkAgentEngine, previousAgentEngine);
        }
        if (previousOpenClawHeartbeatEnabled !== openClawHeartbeatEnabled) {
          reportAgentEngineSettingChanged(
            'openClawHeartbeatEnabled',
            openClawHeartbeatEnabled,
            previousOpenClawHeartbeatEnabled,
          );
        }
        if (previousOpenClawSessionKeepAlive !== openClawSessionKeepAlive) {
          reportAgentEngineSettingChanged(
            'openClawSessionKeepAlive',
            openClawSessionKeepAlive,
            previousOpenClawSessionKeepAlive,
          );
        }
        const memorySettingsSummary = buildMemorySettingAnalyticsSummary(
          previousMemorySettings,
          nextMemorySettings,
        );
        if (memorySettingsSummary) {
          reportMemorySettingChanged(memorySettingsSummary);
        }
        const dreamingSettingsSummary = buildDreamingSettingAnalyticsSummary(
          previousDreamingSettings,
          nextDreamingSettings,
        );
        if (dreamingSettingsSummary) {
          reportDreamingSettingChanged(dreamingSettingsSummary);
        }
        const shortcutSettingsSummary = buildShortcutSettingAnalyticsSummary(
          previousShortcuts,
          shortcuts,
        );
        if (shortcutSettingsSummary) {
          reportShortcutSettingChanged(shortcutSettingsSummary);
        }
        const pluginSettingsSummary = buildPluginSettingsAnalyticsSummary(savedPluginPendingChanges);
        if (pluginSettingsSummary) {
          reportPluginSettingsSaved(pluginSettingsSummary);
        }
        const customModelSettingsSummary = buildCustomModelSettingsAnalyticsSummary(
          previousProviders,
          normalizedProviders,
        );
        if (customModelSettingsSummary) {
          reportCustomModelSettingsSaved(customModelSettingsSummary);
        }
        if (previousConfig.usageAnalyticsEnabled === false) {
          void reportYdAnalyzer({
            action: LogReporterAction.UsageAnalyticsEnabled,
            source: SettingsAnalyticsSource.General,
          });
        }
      }

      didSaveRef.current = true;
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // 标签页切换处理
  const doTabChange = useCallback((tab: TabType) => {
    if (tab !== 'model') {
      setIsAddingModel(false);
      setIsEditingModel(false);
      setEditingModelId(null);
      setNewModelName('');
      setNewModelId('');
      setNewModelSupportsImage(false);
      setModelFormError(null);
    }
    setActiveTab(tab);
  }, []);

  const handleTabChange = useCallback((tab: TabType) => {
    if (isBackingUpOpenClawData || isRestoringOpenClawData) return;
    if (activeTab === 'plugins' && pluginsSettingsRef.current?.guardLeave(() => doTabChange(tab))) {
      return;
    }
    doTabChange(tab);
  }, [activeTab, doTabChange, isBackingUpOpenClawData, isRestoringOpenClawData]);

  // Guarded close: check plugin dirty state before closing
  const guardedClose = useCallback(() => {
    if (isBackingUpOpenClawData || isRestoringOpenClawData) return;
    if (activeTab === 'plugins' && pluginsSettingsRef.current?.guardLeave(() => onClose())) {
      return;
    }
    onClose();
  }, [activeTab, isBackingUpOpenClawData, isRestoringOpenClawData, onClose]);

  const shortcutCommandMap = useMemo(
    () => new Map(SHORTCUT_COMMANDS.map(command => [command.key, command])),
    [],
  );

  const filteredShortcutGroups = useMemo(() => {
    const query = shortcutSearchQuery.trim().toLowerCase();
    if (!query) return SHORTCUT_COMMAND_GROUPS;

    return SHORTCUT_COMMAND_GROUPS
      .map(group => ({
        ...group,
        commands: group.commands.filter(command => {
          const haystack = [
            getShortcutCommandText(command, 'labelKey'),
            getShortcutCommandText(command, 'descriptionKey'),
            shortcuts[command.key] ?? '',
            formatShortcutForDisplay(shortcuts[command.key], { isMac: isMacPlatform }),
          ].join(' ').toLowerCase();
          return haystack.includes(query);
        }),
      }))
      .filter(group => group.commands.length > 0);
  }, [shortcutSearchQuery, shortcuts]);

  // 快捷键更新处理
  const handleShortcutChange = (key: ShortcutAction, value: string) => {
    const normalizedValue = value.trim();
    // Check for conflicts with other shortcuts
    const normalizedSignature = getShortcutConflictSignature(normalizedValue, { isMac: isMacPlatform });
    const conflictKey = normalizedSignature
      ? Object.values(ShortcutAction).find((action) => {
          if (action === key) return false;
          return getShortcutConflictSignature(shortcuts[action], { isMac: isMacPlatform }) === normalizedSignature;
        })
      : undefined;
    if (conflictKey) {
      const conflictCommand = shortcutCommandMap.get(conflictKey);
      const conflictLabel = conflictCommand
        ? getShortcutCommandText(conflictCommand, 'labelKey')
        : conflictKey;
      setNoticeMessage(
        i18nService
          .t('shortcutConflict')
          .replace('{0}', formatShortcutForDisplay(normalizedValue, { isMac: isMacPlatform }))
          .replace('{1}', conflictLabel)
      );
      return;
    }
    setShortcuts(prev => ({
      ...prev,
      [key]: normalizedValue
    }));
  };

  const handleResetShortcuts = () => {
    setShortcuts({ ...defaultConfig.shortcuts! });
  };

  // 阻止点击设置窗口时事件传播到背景
  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Handlers for model operations
  const handleAddModel = () => {
    setIsAddingModel(true);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelSupportsThinking(false);
    setNewModelContextWindow(undefined);
    setNewModelCustomParams('');
    setModelFormError(null);
  };

  const handleEditModel = (modelId: string, modelName: string, supportsImage?: boolean, supportsThinking?: boolean, contextWindow?: number, customParams?: Record<string, unknown>) => {
    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    setNewModelSupportsImage(!!supportsImage);
    setNewModelSupportsThinking(!!supportsThinking);
    setNewModelContextWindow(contextWindow);
    setNewModelCustomParams(
      customParams && Object.keys(customParams).length > 0
        ? JSON.stringify(customParams, null, 2)
        : '',
    );
    setModelFormError(null);
  };

  const handleDeleteModel = (modelId: string) => {
    if (!providers[activeProvider].models) return;

    const updatedModels = providers[activeProvider].models.filter(
      model => model.id !== modelId
    );

    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));
  };

  const handleSaveNewModel = () => {
    const modelId = newModelId.trim();

    if (activeProvider === 'ollama' || activeProvider === 'lm-studio') {
      // For Ollama/LM Studio, only the model name (stored as modelId) is required
      if (!modelId) {
        setModelFormError(i18nService.t(activeProvider === 'lm-studio' ? 'lmStudioModelNameRequired' : 'ollamaModelNameRequired'));
        return;
      }
    } else {
      const modelName = newModelName.trim();
      if (!modelName || !modelId) {
        setModelFormError(i18nService.t('modelNameAndIdRequired'));
        return;
      }
    }

    // For Ollama, auto-fill display name from modelId if not provided
    const modelName = activeProvider === 'ollama' || activeProvider === 'lm-studio'
      ? (newModelName.trim() && newModelName.trim() !== modelId ? newModelName.trim() : modelId)
      : newModelName.trim();

    const currentModels = providers[activeProvider].models ?? [];
    const duplicateModel = currentModels.find(
      model => model.id === modelId && (!isEditingModel || model.id !== editingModelId)
    );
    if (duplicateModel) {
      setModelFormError(i18nService.t('modelIdExists'));
      return;
    }

    // Parse custom params JSON (validate before saving)
    let parsedCustomParams: Record<string, unknown> | undefined;
    const trimmedParams = newModelCustomParams.trim();
    if (trimmedParams) {
      try {
        parsedCustomParams = JSON.parse(trimmedParams);
        if (typeof parsedCustomParams !== 'object' || parsedCustomParams === null || Array.isArray(parsedCustomParams)) {
          setModelFormError(i18nService.t('customParamsInvalidJson'));
          return;
        }
      } catch {
        setModelFormError(i18nService.t('customParamsInvalidJson'));
        return;
      }
    }

    const nextModel = {
      id: modelId,
      name: modelName,
      supportsImage: ProviderRegistry.resolveModelSupportsImage(
        activeProvider,
        modelId,
        newModelSupportsImage,
      ),
      ...(ProviderRegistry.resolveModelSupportsThinking(
        activeProvider,
        modelId,
        newModelSupportsThinking,
      ) ? { supportsThinking: true } : {}),
      ...(newModelContextWindow !== undefined ? { contextWindow: newModelContextWindow } : {}),
      ...(parsedCustomParams && Object.keys(parsedCustomParams).length > 0
        ? { customParams: parsedCustomParams }
        : {}),
    };
    const updatedModels = isEditingModel && editingModelId
      ? currentModels.map(model => (model.id === editingModelId ? nextModel : model))
      : [...currentModels, nextModel];

    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));

    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelSupportsThinking(false);
    setNewModelCustomParams('');
    setModelFormError(null);
  };

  const handleCancelModelEdit = () => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelSupportsThinking(false);
    setNewModelContextWindow(undefined);
    setNewModelCustomParams('');
    setModelFormError(null);
  };

  const handleModelDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelModelEdit();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveNewModel();
    }
  };

  const showTestResultModal = (
    result: Omit<ProviderConnectionTestResult, 'provider'>,
    provider: ProviderType
  ) => {
    setTestResult({
      ...result,
      provider,
    });
    setIsTestResultModalOpen(true);
  };

  // 测试 API 连接
  const handleTestConnection = async () => {
    const testingProvider = activeProvider;
    const providerConfig = providers[testingProvider];
    const testingApiFormat = getEffectiveApiFormat(testingProvider, providerConfig.apiFormat);
    setIsTesting(true);
    setIsTestResultModalOpen(false);
    setTestResult(null);

    const hasValidAuth = providerConfig.apiKey;


    if (providerRequiresApiKey(testingProvider) && !hasValidAuth) {
      reportCustomModelConnectionTested(testingProvider, testingApiFormat, 'failed', {
        failureReason: 'missing_api_key',
      });
      showTestResultModal({ success: false, message: i18nService.t('apiKeyRequired') }, testingProvider);
      setIsTesting(false);
      return;
    }

    // 获取第一个可用模型 - use a shallow copy to avoid mutating state
    const originalModel = providerConfig.models?.[0];
    if (!originalModel) {
      reportCustomModelConnectionTested(testingProvider, testingApiFormat, 'failed', {
        failureReason: 'missing_model',
      });
      showTestResultModal({ success: false, message: i18nService.t('noModelsConfigured') }, testingProvider);
      setIsTesting(false);
      return;
    }

    const firstModel = { ...originalModel };

    try {
      let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
      // Apply Coding Plan endpoint switch
      let effectiveBaseUrl = resolveBaseUrl(testingProvider, providerConfig.baseUrl, testingApiFormat);
      let effectiveApiFormat = testingApiFormat;

      // Handle Coding Plan endpoint switch for supported providers
      if ((providerConfig as { codingPlanEnabled?: boolean }).codingPlanEnabled && (effectiveApiFormat === 'anthropic' || effectiveApiFormat === 'openai')) {
        const resolved = resolveCodingPlanBaseUrl(testingProvider, true, effectiveApiFormat, effectiveBaseUrl);
        effectiveBaseUrl = resolved.baseUrl;
        effectiveApiFormat = resolved.effectiveFormat;
      }

      let normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');

      // Determine effective API key
      let effectiveApiKey = providerConfig.apiKey;

      if (testingProvider === ProviderName.Copilot) {
        const result = await window.electron.githubCopilot.refreshToken();
        if (!result.success || !result.token) {
          reportCustomModelConnectionTested(testingProvider, effectiveApiFormat, 'failed', {
            failureReason: 'unknown',
          });
          showTestResultModal({
            success: false,
            message: result.error || i18nService.t('apiKeyRequired'),
          }, testingProvider);
          return;
        }
        effectiveApiKey = result.token;
        if (result.baseUrl) {
          effectiveBaseUrl = result.baseUrl;
          normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
        }
        apiService.setProviderRuntimeCredential(ProviderName.Copilot, {
          apiKey: result.token,
          ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
        });
      }

      if (testingProvider === 'qwen') {
        // Use regular API Key mode
        effectiveApiKey = providerConfig.apiKey;
        // Ensure model ID is not an OAuth-mapped name (vision-model/coder-model)
        // This can happen if a previous OAuth test mutated the model in state and it got persisted
        if (firstModel.id === 'vision-model' || firstModel.id === 'coder-model') {
          // Restore from defaultConfig's first qwen model
          const defaultQwenModel = defaultConfig.providers?.qwen?.models?.[0];
          firstModel.id = defaultQwenModel?.id || 'qwen3.5-plus';
        }
      }

      // Determine format after all overrides (OAuth may switch to openai)
      // 统一为两种协议格式：
      // - anthropic: /v1/messages
      // - openai provider: /v1/responses
      // - other openai-compatible providers: /v1/chat/completions
      const useAnthropicFormat = effectiveApiFormat === 'anthropic';

      if (useAnthropicFormat) {
        const anthropicUrl = normalizedBaseUrl.endsWith('/v1')
          ? `${normalizedBaseUrl}/messages`
          : `${normalizedBaseUrl}/v1/messages`;
        response = await window.electron.api.fetch({
          url: anthropicUrl,
          method: 'POST',
          headers: {
            'x-api-key': effectiveApiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: firstModel.id,
            max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else {
        const useResponsesApi = shouldUseOpenAIResponsesForProvider(testingProvider);
        const openaiUrl = useResponsesApi
          ? buildOpenAIResponsesUrl(normalizedBaseUrl)
          : buildOpenAICompatibleChatCompletionsUrl(normalizedBaseUrl, testingProvider);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (effectiveApiKey) {
          headers.Authorization = `Bearer ${effectiveApiKey}`;
        }
        if (testingProvider === ProviderName.Copilot) {
          headers['Copilot-Integration-Id'] = 'vscode-chat';
          headers['Editor-Version'] = 'vscode/1.96.2';
          headers['Editor-Plugin-Version'] = 'copilot-chat/0.26.7';
          headers['User-Agent'] = 'GitHubCopilotChat/0.26.7';
          headers['Openai-Intent'] = 'conversation-panel';
        }
        const openAIRequestBody: Record<string, unknown> = useResponsesApi
          ? {
              model: firstModel.id,
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
              max_output_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            }
          : {
              model: firstModel.id,
              messages: [{ role: 'user', content: 'Hi' }],
            };
        if (!useResponsesApi && shouldUseMaxCompletionTokensForOpenAI(testingProvider, firstModel.id)) {
          openAIRequestBody.max_completion_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
        } else {
          if (!useResponsesApi) {
            openAIRequestBody.max_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
          }
        }
        response = await window.electron.api.fetch({
          url: openaiUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody),
        });
      }

      if (response.ok) {
        enableProvider(testingProvider);
        reportCustomModelConnectionTested(testingProvider, effectiveApiFormat, 'success');
        showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
      } else {
        const data = response.data || {};
        // 提取错误信息
        const errorMessage = data.error?.message || data.message || `${i18nService.t('connectionFailed')}: ${response.status}`;
        if (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('model output limit was reached')) {
          enableProvider(testingProvider);
          reportCustomModelConnectionTested(testingProvider, effectiveApiFormat, 'success');
          showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
          return;
        }
        reportCustomModelConnectionTested(testingProvider, effectiveApiFormat, 'failed', {
          failureReason: 'http_error',
          statusCode: response.status,
        });
        showTestResultModal({ success: false, message: errorMessage }, testingProvider);
      }
    } catch (err) {
      reportCustomModelConnectionTested(testingProvider, testingApiFormat, 'failed', {
        failureReason: 'network_error',
      });
      showTestResultModal({
        success: false,
        message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
      }, testingProvider);
    } finally {
      setIsTesting(false);
    }
  };

  const buildProvidersExport = async (password: string): Promise<ProvidersExportPayload> => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([providerKey, providerConfig]) => {
        const apiKey = await encryptWithPassword(providerConfig.apiKey, password);
        const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
        return [
          providerKey,
          {
            enabled: providerConfig.enabled,
            apiKey,
            baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
            apiFormat,
            codingPlanEnabled: (providerConfig as ProviderConfig).codingPlanEnabled,
            models: normalizeModels(providerKey, providerConfig.models),
          },
        ] as const;
      })
    );

    return {
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      exportedAt: new Date().toISOString(),
      encryption: {
        algorithm: 'AES-GCM',
        keySource: 'password',
        keyDerivation: 'PBKDF2',
      },
      providers: Object.fromEntries(entries),
    };
  };

  const normalizeModels = (providerKey: string, models?: Model[]) =>
    models?.map(model => ({
      ...model,
      supportsImage: resolveModelSupportsImageForProvider(providerKey, model),
    }));

  const DEFAULT_EXPORT_PASSWORD = EXPORT_PASSWORD;

  const handleExportProviders = async () => {
    setError(null);
    setIsExportingProviders(true);

    try {
      const payload = await buildProvidersExport(DEFAULT_EXPORT_PASSWORD);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_ID}-providers-${date}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.error('Failed to export providers:', err);
      setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExportingProviders(false);
    }
  };

  const handleImportProvidersClick = () => {
    importInputRef.current?.click();
  };

  const handleImportProviders = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    setError(null);

    try {
      const raw = await file.text();
      console.log(`[Settings] importing providers from file: ${file.name}, size: ${file.size}`);
      let payload: ProvidersImportPayload;
      try {
        payload = JSON.parse(raw) as ProvidersImportPayload;
      } catch {
        console.warn('[Settings] import failed: invalid JSON in file');
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      if (!payload || payload.type !== EXPORT_FORMAT_TYPE || !payload.providers) {
        console.warn(`[Settings] import failed: invalid format, type=${payload?.type}, hasProviders=${!!payload?.providers}`);
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if it's version 2 (password-based encryption)
      if (payload.version === 2 && payload.encryption?.keySource === 'password') {
        console.log('[Settings] import: detected v2 password-based encryption');
        await processImportPayloadWithPassword(payload);
        return;
      }

      // Version 1 (legacy local-store key) - try to decrypt with local key
      if (payload.version === 1) {
        console.log('[Settings] import: detected v1 local-key encryption');
        await processImportPayloadWithLocalKey(payload);
        return;
      }

      console.warn(`[Settings] import failed: unsupported version=${payload.version}`);
      setError(i18nService.t('invalidProvidersFile'));
    } catch (err) {
      console.error('[Settings] import failed:', err);
      setError(i18nService.t('importProvidersFailed'));
    }
  };

  const processImportPayloadWithLocalKey = async (payload: ProvidersImportPayload) => {
    setIsImportingProviders(true);
    try {
      const fileKeys = Object.keys(payload.providers ?? {});
      console.log(`[Settings] v1 import: processing ${fileKeys.length} providers from file`);
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;
      for (const providerKey of providerKeys) {
        const providerData = payload.providers?.[providerKey];
        if (!providerData) {
          continue;
        }

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          try {
            apiKey = await decryptSecret(providerData.apiKey as EncryptedPayload);
            console.log(`[Settings] v1 import: decrypted key for ${providerKey}`);
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`[Settings] v1 import: failed to decrypt key for ${providerKey}`, error);
          }
        } else if (typeof providerData.apiKeyEncrypted === 'string' && typeof providerData.apiKeyIv === 'string') {
          try {
            apiKey = await decryptSecret({ encrypted: providerData.apiKeyEncrypted, iv: providerData.apiKeyIv });
            console.log(`[Settings] v1 import: decrypted key for ${providerKey}`);
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`[Settings] v1 import: failed to decrypt key for ${providerKey}`, error);
          }
        }

        const models = normalizeModels(providerKey, providerData.models);
        const existing = providers[providerKey];

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : existing?.enabled ?? false,
          apiKey: apiKey ?? existing?.apiKey ?? '',
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : existing?.baseUrl ?? '',
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? existing?.apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (existing as ProviderConfig)?.codingPlanEnabled,
          models: models ?? existing?.models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        console.warn(`[Settings] v1 import failed: no matching providers found, file keys: ${fileKeys.join(', ')}`);
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      console.log(`[Settings] v1 import complete: updated ${Object.keys(providerUpdates).length} providers`);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('[Settings] v1 import failed:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  const processImportPayloadWithPassword = async (payload: ProvidersImportPayload) => {
    if (!payload.providers) {
      return;
    }

    setIsImportingProviders(true);

    try {
      const fileKeys = Object.keys(payload.providers);
      console.log(`[Settings] v2 import: processing ${fileKeys.length} providers from file`);
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;

      for (const providerKey of providerKeys) {
        const providerData = payload.providers[providerKey];
        if (!providerData) {
          continue;
        }

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          const apiKeyObj = providerData.apiKey as PasswordEncryptedPayload;
          if (apiKeyObj.salt) {
            // Version 2 password-based encryption
            try {
              apiKey = await decryptWithPassword(apiKeyObj, DEFAULT_EXPORT_PASSWORD);
              console.log(`[Settings] v2 import: decrypted key for ${providerKey}`);
            } catch (error) {
              hadDecryptFailure = true;
              console.warn(`[Settings] v2 import: failed to decrypt key for ${providerKey}`, error);
            }
          }
        }

        const models = normalizeModels(providerKey, providerData.models);
        const existing = providers[providerKey];

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : existing?.enabled ?? false,
          apiKey: apiKey ?? existing?.apiKey ?? '',
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : existing?.baseUrl ?? '',
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? existing?.apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (existing as ProviderConfig)?.codingPlanEnabled,
          models: models ?? existing?.models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        console.warn(`[Settings] v2 import failed: no matching providers found, file keys: ${fileKeys.join(', ')}`);
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if any key was successfully decrypted
      const anyKeyDecrypted = Object.entries(providerUpdates).some(
        ([key, update]) => update?.apiKey && update.apiKey !== providers[key]?.apiKey
      );

      if (!anyKeyDecrypted && hadDecryptFailure) {
        // All decryptions failed - likely wrong password
        console.warn('[Settings] v2 import failed: all key decryptions failed, likely wrong password');
        setError(i18nService.t('decryptProvidersFailed'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      console.log(`[Settings] v2 import complete: updated ${Object.keys(providerUpdates).length} providers`);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('[Settings] v2 import failed:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  // 渲染标签页
  const sidebarTabs: { key: TabType; label: string; icon: React.ReactNode }[] = (() => {
    const allTabs = [
      { key: 'general' as TabType,        label: i18nService.t('general'),        icon: <SettingsSlidersIcon className="h-5 w-5" /> },
      { key: 'appearance' as TabType,     label: i18nService.t('appearance'),     icon: <SunIcon className="h-5 w-5" /> },
      { key: 'coworkAgentEngine' as TabType, label: i18nService.t('coworkAgentEngine'), icon: <CpuChipIcon className="h-5 w-5" /> },
      { key: 'model' as TabType,          label: i18nService.t('settingsCustomModel'), icon: <CubeIcon className="h-5 w-5" /> },
      { key: 'im' as TabType,             label: i18nService.t('imBot'),          icon: <ChatBubbleLeftIcon className="h-5 w-5" /> },
      { key: 'browserWebAccess' as TabType, label: i18nService.t('browserWebAccessTab'), icon: <GlobeAltIcon className="h-5 w-5" /> },
      { key: 'email' as TabType,          label: i18nService.t('emailTab'),       icon: <EnvelopeIcon className="h-5 w-5" /> },
      { key: 'coworkMemory' as TabType,   label: i18nService.t('coworkMemoryTitle'), icon: <BrainIcon className="h-5 w-5" /> },
      { key: 'coworkDreaming' as TabType, label: i18nService.t('coworkMemoryTabDreaming'), icon: <DreamingTabIcon className="h-5 w-5" /> },
      { key: 'plugins' as TabType,        label: i18nService.t('pluginsTab'),     icon: <PlugIcon className="h-5 w-5" /> },
      { key: 'shortcuts' as TabType,      label: i18nService.t('shortcuts'),      icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5"><rect x="2" y="4" width="20" height="14" rx="2" /><line x1="6" y1="8" x2="8" y2="8" /><line x1="10" y1="8" x2="12" y2="8" /><line x1="14" y1="8" x2="16" y2="8" /><line x1="6" y1="12" x2="8" y2="12" /><line x1="10" y1="12" x2="14" y2="12" /><line x1="16" y1="12" x2="18" y2="12" /><line x1="8" y1="15.5" x2="16" y2="15.5" /></svg> },
      { key: 'about' as TabType,          label: i18nService.t('about'),          icon: <InformationCircleIcon className="h-5 w-5" /> },
    ];
    // Filter out tabs hidden by enterprise config
    // Filter out tabs with 'hide' action in enterprise config
    // e.g., ui: { "settings.im": "hide" } → hide the 'im' tab
    const ui = enterpriseConfig?.ui;
    if (ui) {
      return allTabs.filter(tab => ui[`settings.${tab.key}`] !== 'hide');
    }
    return allTabs;
  })();

  const activeTabLabel = useMemo(() => {
    return sidebarTabs.find(t => t.key === activeTab)?.label ?? '';
  }, [activeTab, sidebarTabs]);

  useEffect(() => {
    const handleSettingsTabShortcut = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive() || isTextEditingActive()) return;

      const command = SETTINGS_TAB_SHORTCUT_COMMANDS.find((candidate) => {
        return matchesShortcut(event, shortcuts[candidate.key]);
      });
      if (!command) return;

      const targetTab = SETTINGS_TAB_SHORTCUT_ACTIONS[command.key];
      if (!targetTab || !sidebarTabs.some(tab => tab.key === targetTab)) return;

      event.preventDefault();
      handleTabChange(targetTab);
    };

    document.addEventListener('keydown', handleSettingsTabShortcut);
    return () => document.removeEventListener('keydown', handleSettingsTabShortcut);
  }, [shortcuts, sidebarTabs, handleTabChange]);

  const handleUiFontSizeChange = useCallback((nextValue: number) => {
    setUiFontSize(nextValue);
    applyTypographyPreferences({
      uiFontSize: nextValue,
      codeFontSize,
    });
  }, [codeFontSize]);

  const handleCodeFontSizeChange = useCallback((nextValue: number) => {
    setCodeFontSize(nextValue);
    applyTypographyPreferences({
      uiFontSize,
      codeFontSize: nextValue,
    });
  }, [uiFontSize]);

  const renderAppearanceSettings = () => (
    <div className="space-y-8">
      <div>
        <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--lobster-text-primary)' }}>
          {i18nService.t('appearance')}
        </h4>

        <div className="grid grid-cols-3 gap-3 mb-4">
          {(['light', 'dark', 'system'] as const).map((mode) => {
            const isSelected = theme === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setTheme(mode);
                  themeService.setTheme(mode);
                  setThemeId(themeService.getThemeId());
                }}
                className="flex flex-col items-center rounded-xl border-2 p-3 transition-colors cursor-pointer"
                style={{
                  borderColor: isSelected ? 'var(--lobster-primary)' : 'var(--lobster-border)',
                  backgroundColor: isSelected ? 'var(--lobster-primary-muted)' : undefined,
                }}
              >
                <svg viewBox="0 0 120 80" className="w-full h-auto rounded-md mb-2 overflow-hidden" xmlns="http://www.w3.org/2000/svg">
                  {mode === 'light' && (
                    <>
                      <rect width="120" height="80" fill="#F8F9FB" />
                      <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                      <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                      <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                      <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                      <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                      <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#E2E4E7" />
                    </>
                  )}
                  {mode === 'dark' && (
                    <>
                      <rect width="120" height="80" fill="#0F1117" />
                      <rect x="0" y="0" width="30" height="80" fill="#151820" />
                      <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                      <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#252930" />
                    </>
                  )}
                  {mode === 'system' && (
                    <>
                      <defs>
                        <clipPath id="left-half">
                          <rect x="0" y="0" width="60" height="80" />
                        </clipPath>
                        <clipPath id="right-half">
                          <rect x="60" y="0" width="60" height="80" />
                        </clipPath>
                      </defs>
                      <g clipPath="url(#left-half)">
                        <rect width="120" height="80" fill="#F8F9FB" />
                        <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                        <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                        <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                        <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                        <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                        <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      </g>
                      <g clipPath="url(#right-half)">
                        <rect width="120" height="80" fill="#0F1117" />
                        <rect x="0" y="0" width="30" height="80" fill="#151820" />
                        <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                        <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                      </g>
                      <line x1="60" y1="0" x2="60" y2="80" stroke="#888" strokeWidth="0.5" />
                    </>
                  )}
                </svg>
                <span className="text-xs font-medium" style={{ color: isSelected ? 'var(--lobster-primary)' : 'var(--lobster-text-primary)' }}>
                  {i18nService.t(mode)}
                </span>
              </button>
            );
          })}
        </div>

        <h4 className="text-sm font-medium mb-3 mt-5" style={{ color: 'var(--lobster-text-primary)' }}>
          {i18nService.t('themeColor')}
        </h4>
        {(() => {
          const allThemes = themeService.getAllThemes();
          const classicThemes = allThemes.filter(t => t.meta.id === 'classic-light' || t.meta.id === 'classic-dark');
          const otherThemes = allThemes.filter(t => t.meta.id !== 'classic-light' && t.meta.id !== 'classic-dark');
          const renderTile = (t: import('../theme').ThemeDefinition) => {
            const isSelected = themeId === t.meta.id;
            const [bg, c1, c2, c3] = t.meta.preview;
            return (
              <button
                key={t.meta.id}
                type="button"
                onClick={() => {
                  themeService.setThemeById(t.meta.id);
                  setThemeId(t.meta.id);
                  setTheme(t.meta.appearance as 'light' | 'dark');
                }}
                className="flex flex-col items-center rounded-xl border-2 p-2 transition-colors cursor-pointer"
                style={{
                  borderColor: isSelected ? 'var(--lobster-primary)' : 'var(--lobster-border)',
                  backgroundColor: isSelected ? 'var(--lobster-primary-muted)' : undefined,
                }}
              >
                <svg viewBox="0 0 80 48" className="w-full h-auto rounded-md mb-1.5 overflow-hidden" xmlns="http://www.w3.org/2000/svg">
                  <rect width="80" height="48" fill={bg} />
                  <rect x="4" y="6" width="20" height="36" rx="3" fill={c1} opacity="0.7" />
                  <rect x="28" y="6" width="48" height="36" rx="3" fill={c2} opacity="0.5" />
                  <circle cx="52" cy="24" r="8" fill={c3} opacity="0.8" />
                  <rect x="32" y="34" width="40" height="4" rx="2" fill={c1} opacity="0.6" />
                </svg>
                <span className="text-[10px] font-medium truncate w-full text-center" style={{ color: isSelected ? 'var(--lobster-primary)' : 'var(--lobster-text-primary)' }}>
                  {i18nService.t('theme-name-' + t.meta.id) || t.meta.name}
                </span>
              </button>
            );
          };
          return (
            <>
              <div className="grid grid-cols-2 gap-3 mb-3">
                {classicThemes.map(renderTile)}
              </div>
              <div className="grid grid-cols-4 gap-3">
                {otherThemes.map(renderTile)}
              </div>
            </>
          );
        })()}

        <div className="mt-5 divide-y divide-border rounded-xl border border-border bg-surface">
          <div className="px-4 py-3">
            <SettingsNumberInputRow
              id="ui-font-size"
              title={i18nService.t('uiFontSize')}
              description={i18nService.t('uiFontSizeDescription')}
              value={uiFontSize}
              min={FontPreferences.UiFontSizeMin}
              max={FontPreferences.UiFontSizeMax}
              onChange={handleUiFontSizeChange}
            />
          </div>
          <div className="px-4 py-3">
            <SettingsNumberInputRow
              id="code-font-size"
              title={i18nService.t('codeFontSize')}
              description={i18nService.t('codeFontSizeDescription')}
              value={codeFontSize}
              min={FontPreferences.CodeFontSizeMin}
              max={FontPreferences.CodeFontSizeMax}
              onChange={handleCodeFontSizeChange}
            />
          </div>
        </div>
      </div>
    </div>
  );

  const renderTabContent = () => {
    switch(activeTab) {
      case 'general':
        return (
          <div className="space-y-8">
            {/* Language Section */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-foreground">
                {i18nService.t('language')}
              </h4>
              <div className="w-[140px] shrink-0">
                <ThemedSelect
                  id="language"
                  value={language}
                  onChange={(value) => {
                    const nextLanguage = value as LanguageType;
                    setLanguage(nextLanguage);
                    i18nService.setLanguage(nextLanguage, { persist: false });
                  }}
                  options={[
                    { value: 'zh', label: i18nService.t('chinese') },
                    { value: 'en', label: i18nService.t('english') }
                  ]}
                />
              </div>
            </div>

            <SettingsToggleRow
              title={i18nService.t('autoLaunch')}
              description={i18nService.t('autoLaunchDescription')}
              checked={autoLaunch}
              disabled={isUpdatingAutoLaunch}
              onToggle={async () => {
                if (isUpdatingAutoLaunch) return;
                const next = !autoLaunch;
                setIsUpdatingAutoLaunch(true);
                try {
                  console.log(`[Renderer][Settings] updating auto-launch setting: requested=${next}`);
                  const result = await window.electron.autoLaunch.set(next);
                  console.log(
                    `[Renderer][Settings] auto-launch update result: success=${result.success}, enabled=${result.enabled ?? 'unknown'}, error=${result.error ?? 'none'}`,
                  );
                  if (result.success) {
                    const previous = autoLaunch;
                    const actualEnabled = result.enabled ?? next;
                    setAutoLaunchState(actualEnabled);
                    reportGeneralSettingChanged('autoLaunch', actualEnabled, previous);
                  } else {
                    if (typeof result.enabled === 'boolean') {
                      setAutoLaunchState(result.enabled);
                    }
                    setError(getAutoLaunchErrorMessage(result.errorCode));
                  }
                } catch (err) {
                  console.error('Failed to set auto-launch:', err);
                  setError(i18nService.t('autoLaunchUpdateFailed'));
                } finally {
                  setIsUpdatingAutoLaunch(false);
                }
              }}
            />

            <SettingsToggleRow
              title={i18nService.t('preventSleep')}
              description={i18nService.t('preventSleepDescription')}
              checked={preventSleep}
              disabled={isUpdatingPreventSleep}
              onToggle={async () => {
                if (isUpdatingPreventSleep) return;
                const next = !preventSleep;
                setIsUpdatingPreventSleep(true);
                try {
                  const result = await window.electron.preventSleep.set(next);
                  if (result.success) {
                    const previous = preventSleep;
                    setPreventSleepState(next);
                    reportGeneralSettingChanged('preventSleep', next, previous);
                  } else {
                    setError(result.error || 'Failed to update prevent-sleep setting');
                  }
                } catch (err) {
                  console.error('Failed to set prevent-sleep:', err);
                  setError('Failed to update prevent-sleep setting');
                } finally {
                  setIsUpdatingPreventSleep(false);
                }
              }}
            />

            <SettingsToggleRow
              title={i18nService.t('useSystemProxy')}
              description={i18nService.t('useSystemProxyDescription')}
              checked={useSystemProxy}
              onToggle={() => {
                setUseSystemProxy((prev) => !prev);
              }}
            />

            <SettingsToggleRow
              title={i18nService.t('sqliteAutoBackupEnabled')}
              description={i18nService.t('sqliteAutoBackupEnabledDescription')}
              checked={sqliteAutoBackupEnabled}
              onToggle={() => {
                setSqliteAutoBackupEnabled((prev) => !prev);
              }}
            />

            <SettingsToggleRow
              title={i18nService.t('taskCompletionNotifications')}
              description={i18nService.t('taskCompletionNotificationsDescription')}
              checked={taskCompletionNotificationsEnabled}
              onToggle={() => {
                setTaskCompletionNotificationsEnabled((prev) => !prev);
              }}
            />

            <SettingsToggleRow
              title={i18nService.t('skipMissedJobs')}
              description={i18nService.t('skipMissedJobsDescription')}
              checked={skipMissedJobs}
              onToggle={() => {
                setSkipMissedJobs((prev) => !prev);
              }}
            />

            <SettingsToggleRow
              title={i18nService.t('usageAnalyticsEnabled')}
              description={i18nService.t('usageAnalyticsEnabledDescription')}
              checked={usageAnalyticsEnabled}
              onToggle={() => {
                setUsageAnalyticsEnabled((prev) => !prev);
              }}
            />

          </div>
        );

      case 'appearance':
        return renderAppearanceSettings();

      case 'email':
        return <EmailSkillConfig />;

      case 'coworkAgentEngine':
        return (
          <div className="space-y-8 pb-2">
            {isOpenClawAgentEngine && (
              <>
                <section className="space-y-3">
                  <h4 className="text-sm font-medium text-foreground">
                    {i18nService.t('openClawRuntimeStatusTitle')}
                  </h4>

                  <div className="rounded-xl border border-border bg-surface p-4">
                    <div className="flex items-start gap-3.5">
                      <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${openClawStatusTone.iconClassName}`}>
                        <OpenClawStatusIcon className={`h-5 w-5 ${openClawStatusTone.spinIcon ? 'animate-spin' : ''}`} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 text-sm font-medium leading-5 text-foreground">
                            {resolveOpenClawStatusText(openClawEngineStatus)}
                          </div>
                          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${openClawStatusTone.badgeClassName}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${openClawStatusTone.badgeDotClassName} ${openClawStatusTone.inProgress ? 'animate-pulse' : ''}`} />
                            {i18nService.t(openClawStatusTone.badgeLabelKey)}
                          </span>
                        </div>

                        {openClawGatewayHttpUrl ? (
                          <div className="mt-3 flex max-w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised/60 p-1.5">
                            <span className="shrink-0 rounded-md bg-background px-2 py-1 text-[11px] font-medium text-secondary">
                              {i18nService.t('openClawGatewayAddress')}
                            </span>
                            <code
                              className="min-w-0 flex-1 select-all truncate px-1 font-mono text-[13px] leading-6 text-foreground"
                              title={openClawGatewayHttpUrl}
                            >
                              {openClawGatewayHttpUrl}
                            </code>
                            <button
                              type="button"
                              onClick={handleCopyOpenClawGatewayUrl}
                              title={openClawGatewayCopied ? i18nService.t('copied') : i18nService.t('copyToClipboard')}
                              aria-label={openClawGatewayCopied ? i18nService.t('copied') : i18nService.t('copyToClipboard')}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-background hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
                            >
                              {openClawGatewayCopied
                                ? <CheckCircleIcon className="h-4 w-4 text-primary" />
                                : <MessageCopyIcon className="h-4 w-4" />}
                            </button>
                          </div>
                        ) : (
                          <p className="mt-2 text-sm text-secondary">
                            {resolveOpenClawStatusDescription(openClawEngineStatus)}
                          </p>
                        )}

                        {openClawStatusTone.inProgress && openClawProgressPercent !== null && (
                          <div className="mt-3 space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-secondary">{i18nService.t('openClawStartupProgressLabel')}</span>
                              <span className="font-medium tabular-nums text-foreground">{openClawProgressPercent}%</span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
                              <div
                                className={`h-full rounded-full transition-all ${openClawStatusTone.progressClassName}`}
                                style={{ width: `${openClawProgressPercent}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-3">
                  <h4 className="text-sm font-medium text-foreground">
                    {i18nService.t('openClawBackgroundRuntimeTitle')}
                  </h4>

                  <div className="rounded-xl border border-border bg-surface p-4">
                    <div className="flex items-start gap-3.5">
                      <span
                        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                          openClawHeartbeatEnabled
                            ? 'bg-primary-muted text-primary'
                            : 'bg-surface-raised text-secondary'
                        }`}
                      >
                        <SignalIcon className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <h4 className="min-w-0 text-sm font-medium leading-5 text-foreground">
                            {i18nService.t('openClawHeartbeatEnabled')}
                          </h4>
                          <SettingsSwitch
                            checked={openClawHeartbeatEnabled}
                            label={i18nService.t('openClawHeartbeatEnabled')}
                            onClick={() => {
                              setOpenClawHeartbeatEnabled((prev) => !prev);
                            }}
                          />
                        </div>
                        <p className="mt-1.5 text-[13px] leading-5 text-secondary">
                          {i18nService.t('openClawHeartbeatEnabledDescription')}
                        </p>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-3">
                  <h4 className="text-sm font-medium text-foreground">
                    {i18nService.t('openClawMaintenanceTitle')}
                  </h4>

                  <div className="overflow-hidden rounded-xl border border-border bg-surface divide-y divide-border">
                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
                          <WrenchScrewdriverIcon className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">
                            {i18nService.t('openClawRepairGatewayStateTitle')}
                          </div>
                          <div className="mt-0.5 text-[13px] leading-5 text-secondary">
                            {i18nService.t('openClawRepairGatewayStateDesc')}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowOpenClawRepairConfirm(true)}
                        disabled={isRepairingOpenClaw}
                        className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98] sm:self-auto"
                      >
                        {isRepairingOpenClaw && (
                          <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {isRepairingOpenClaw
                          ? i18nService.t('openClawRepairRunning')
                          : i18nService.t('openClawRepairConfirmAction')}
                      </button>
                    </div>

                    {openClawDataBackupResult && (
                      <div className="flex flex-col gap-3 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="font-medium text-foreground">
                            {i18nService.t('openClawDataBackupSavedTitle')}
                          </div>
                          <div className="break-all font-mono text-xs leading-5 text-secondary">
                            {openClawDataBackupResult.path}
                          </div>
                          {formatBackupSize(openClawDataBackupResult.sizeBytes) && (
                            <div className="text-xs text-secondary">
                              {i18nService.t('openClawDataBackupSize')}: {formatBackupSize(openClawDataBackupResult.sizeBytes)}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => { void handleRevealOpenClawDataBackup(); }}
                          className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised active:scale-[0.98]"
                        >
                          {i18nService.t('showInFolder')}
                        </button>
                      </div>
                    )}

                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
                          <ArchiveBoxIcon className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">
                            {i18nService.t('openClawDataBackupTitle')}
                          </div>
                          <div className="mt-0.5 text-[13px] leading-5 text-secondary">
                            {i18nService.t('openClawDataBackupDesc')}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => { void handleOpenClawDataBackup(); }}
                        disabled={isBackingUpOpenClawData || isRestoringOpenClawData}
                        className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98] sm:self-auto"
                      >
                        {isBackingUpOpenClawData && (
                          <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {isBackingUpOpenClawData
                          ? i18nService.t('openClawDataBackupRunning')
                          : i18nService.t('openClawDataBackupAction')}
                      </button>
                    </div>

                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
                          <ArrowPathRoundedSquareIcon className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">
                            {i18nService.t('openClawDataMigrationTitle')}
                          </div>
                          <div className="mt-0.5 text-[13px] leading-5 text-secondary">
                            {i18nService.t('openClawDataMigrationDesc')}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowOpenClawDataRestoreConfirm(true)}
                        disabled={isBackingUpOpenClawData || isRestoringOpenClawData}
                        className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98] sm:self-auto"
                      >
                        {isRestoringOpenClawData && (
                          <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {isRestoringOpenClawData
                          ? i18nService.t('openClawDataMigrationRunning')
                          : i18nService.t('openClawDataMigrationAction')}
                      </button>
                    </div>
                  </div>
                </section>

                {openClawRepairResult && (
                  <div className={`rounded-lg border px-3 py-3 text-sm ${openClawRepairResult.success
                    ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300'
                    : 'border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'}`}
                  >
                    <div className="font-medium">
                      {resolveOpenClawRepairMessage(openClawRepairResult)}
                    </div>
                    {openClawRepairResult.backupPath && (
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 text-xs opacity-90">
                          <span>{i18nService.t('openClawRepairBackupPath')}: </span>
                          <span className="font-mono break-all">{openClawRepairResult.backupPath}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => { void handleRevealOpenClawRepairBackup(); }}
                          className="inline-flex shrink-0 items-center justify-center rounded-lg border border-current/30 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-current/10"
                        >
                          {i18nService.t('showInFolder')}
                        </button>
                      </div>
                    )}
                    {!openClawRepairResult.success && (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => { void coworkService.restartOpenClawGateway(); }}
                          className="inline-flex items-center justify-center rounded-lg border border-current/30 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-current/10"
                        >
                          {i18nService.t('coworkOpenClawRestartGateway')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        );

      case 'coworkMemory': {
        const memoryTabs = [
          { key: 'entries' as const, titleKey: 'coworkMemoryTabEntries' },
          { key: 'embedding' as const, titleKey: 'coworkMemoryTabEmbedding' },
        ];
        const coworkMemoryGroups: Array<{ section?: string; entries: CoworkUserMemoryEntry[] }> = [];
        for (const entry of coworkMemoryEntries) {
          const lastGroup = coworkMemoryGroups[coworkMemoryGroups.length - 1];
          if (lastGroup && (lastGroup.section ?? '') === (entry.section ?? '')) {
            lastGroup.entries.push(entry);
          } else {
            coworkMemoryGroups.push({ section: entry.section, entries: [entry] });
          }
        }
        return (
          <div className="flex flex-col h-full space-y-4">
            <div
              className="flex gap-6 border-b border-border shrink-0"
              role="tablist"
              aria-label={i18nService.t('coworkMemoryTitle')}
            >
              {memoryTabs.map((tab) => (
                <button
                  type="button"
                  key={tab.key}
                  role="tab"
                  aria-selected={memoryTab === tab.key}
                  onClick={() => setMemoryTab(tab.key)}
                  className={`-mb-px border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors ${
                    memoryTab === tab.key
                      ? 'border-primary text-primary'
                      : 'border-transparent text-secondary hover:text-foreground'
                  }`}
                >
                  {i18nService.t(tab.titleKey)}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {memoryTab === 'entries' && (
                <div className="space-y-4 rounded-xl border px-4 py-4 border-border">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-foreground">
                        {i18nService.t('coworkMemoryCrudTitle')}
                      </div>
                      <div className="text-xs text-secondary">
                        {i18nService.t('coworkMemoryManageHint')}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => { void handleEnterCoworkMemoryRawMode(); }}
                          disabled={coworkMemoryListLoading}
                          className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg border border-border text-sm text-foreground hover:bg-surface-raised disabled:opacity-60 transition-colors"
                        >
                          {i18nService.t('coworkMemoryRawButton')}
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenCoworkMemoryModal}
                          className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors active:scale-[0.98]"
                        >
                          <PlusCircleIcon className="h-4 w-4 mr-1.5" />
                          {i18nService.t('coworkMemoryCrudCreate')}
                        </button>
                    </div>
                  </div>

                    <>
                      {coworkMemoryStats && (
                        <div className="text-xs text-secondary">
                          {`${i18nService.t('coworkMemoryTotalLabel')}: ${coworkMemoryStats.total}`}
                        </div>
                      )}

                      <input
                        type="text"
                        value={coworkMemoryQuery}
                        onChange={(event) => setCoworkMemoryQuery(event.target.value)}
                        placeholder={i18nService.t('coworkMemorySearchPlaceholder')}
                        className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface"
                      />

                      <div className="rounded-lg border border-border">
                        {coworkMemoryListLoading ? (
                          <div className="px-3 py-3 text-xs text-secondary">
                            {i18nService.t('loading')}
                          </div>
                        ) : coworkMemoryEntries.length === 0 ? (
                          <div className="px-3 py-3 text-xs text-secondary">
                            {i18nService.t('coworkMemoryEmpty')}
                          </div>
                        ) : (
                          <div className="divide-y divide-border">
                            {coworkMemoryGroups.map((group, groupIndex) => (
                              <React.Fragment key={group.section ?? `ungrouped-${groupIndex}`}>
                                {group.section && (
                                  <div className="flex items-baseline gap-1.5 px-3 pb-1.5 pt-3 text-[11px] font-medium text-secondary">
                                    <span className="truncate">{group.section}</span>
                                    <span className="font-normal opacity-70">{group.entries.length}</span>
                                  </div>
                                )}
                                {group.entries.map((entry) => {
                                  const isLongMemoryText =
                                    entry.text.split('\n').length > 3 || entry.text.length > 240;
                                  const isMemoryTextExpanded = coworkMemoryExpandedIds.has(entry.id);
                                  return (
                                    <div key={entry.id} className="group px-3 py-3 text-xs transition-colors hover:bg-surface-raised/60">
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                          <div
                                            className={`text-foreground break-words whitespace-pre-wrap leading-relaxed ${
                                              isLongMemoryText && !isMemoryTextExpanded ? 'line-clamp-3' : ''
                                            }`}
                                          >
                                            {entry.text}
                                          </div>
                                          {isLongMemoryText && (
                                            <button
                                              type="button"
                                              onClick={() => toggleCoworkMemoryExpandedId(entry.id)}
                                              className="mt-1.5 text-[11px] text-primary hover:underline"
                                            >
                                              {i18nService.t(isMemoryTextExpanded ? 'coworkMemoryCollapse' : 'coworkMemoryExpand')}
                                            </button>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                          <button
                                            type="button"
                                            onClick={() => handleEditCoworkMemoryEntry(entry)}
                                            title={i18nService.t('edit')}
                                            aria-label={i18nService.t('edit')}
                                            className="rounded-md p-1.5 text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
                                          >
                                            <EditIcon className="h-4 w-4" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => { void handleDeleteCoworkMemoryEntry(entry); }}
                                            title={i18nService.t('delete')}
                                            aria-label={i18nService.t('delete')}
                                            className="rounded-md p-1.5 text-secondary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60 transition-colors"
                                            disabled={coworkMemoryListLoading}
                                          >
                                            <TrashIcon className="h-4 w-4" />
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </React.Fragment>
                            ))}
                          </div>
                        )}
                      </div>
                    </>

                  {coworkMemoryRawMode && (
                    <Modal
                      isOpen
                      onClose={() => setCoworkMemoryRawMode(false)}
                      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/10 dark:bg-black/50 p-6"
                      className="flex h-[min(720px,calc(100vh-48px))] w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden rounded-xl border border-surface bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.16)]"
                    >
                      <div className="flex shrink-0 items-start justify-between gap-3 px-5 py-4">
                        <div className="min-w-0">
                          <h2 className="text-lg font-semibold text-foreground">
                            {i18nService.t('coworkMemoryRawButton')}
                          </h2>
                          <p className="mt-0.5 text-sm text-secondary">
                            {i18nService.t('coworkMemoryRawHint')}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCoworkMemoryRawMode(false)}
                          title={i18nService.t('close')}
                          aria-label={i18nService.t('close')}
                          className="p-2 rounded-lg hover:bg-surface-raised transition-colors"
                        >
                          <XMarkIcon className="h-5 w-5 text-secondary" />
                        </button>
                      </div>
                      <textarea
                        value={coworkMemoryRawText}
                        onChange={(event) => setCoworkMemoryRawText(event.target.value)}
                        spellCheck={false}
                        autoFocus
                        className="min-h-0 w-full flex-1 resize-none bg-transparent px-5 pt-1 pb-4 text-xs font-mono leading-relaxed text-foreground focus:outline-none"
                      />
                      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
                        <button
                          type="button"
                          onClick={() => setCoworkMemoryRawMode(false)}
                          className="px-3.5 py-1.5 text-sm text-foreground hover:bg-surface-raised rounded-lg border border-border transition-colors"
                        >
                          {i18nService.t('cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { void handleSaveCoworkMemoryRaw(); }}
                          disabled={coworkMemoryRawSaving}
                          className="px-3.5 py-1.5 text-sm text-white bg-primary hover:bg-primary-hover rounded-lg disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                        >
                          {i18nService.t('save')}
                        </button>
                      </div>
                    </Modal>
                  )}
                </div>
              )}

              {memoryTab === 'embedding' && (
                <EmbeddingSettingsSection
                  embeddingEnabled={embeddingEnabled}
                  embeddingProvider={embeddingProvider}
                  embeddingModel={embeddingModel}
                  embeddingVectorWeight={embeddingVectorWeight}
                  embeddingRemoteBaseUrl={embeddingRemoteBaseUrl}
                  embeddingRemoteApiKey={embeddingRemoteApiKey}
                  onEmbeddingEnabledChange={setEmbeddingEnabled}
                  onEmbeddingProviderChange={setEmbeddingProvider}
                  onEmbeddingModelChange={setEmbeddingModel}
                  onEmbeddingVectorWeightChange={setEmbeddingVectorWeight}
                  onEmbeddingRemoteBaseUrlChange={setEmbeddingRemoteBaseUrl}
                  onEmbeddingRemoteApiKeyChange={setEmbeddingRemoteApiKey}
                />
              )}

            </div>
          </div>
        );
      }

      case 'coworkDreaming':
        return (
          <div className="min-h-full">
            <DreamingSettingsSection
              dreamingEnabled={dreamingEnabled}
              dreamingFrequency={dreamingFrequency}
              onDreamingEnabledChange={setDreamingEnabled}
              onDreamingFrequencyChange={setDreamingFrequency}
            />
          </div>
        );

      case 'browserWebAccess':
        return (
          <BrowserWebAccessSettings
            value={browserWebAccess}
            onChange={setBrowserWebAccess}
          />
        );

      case 'model':
        return (
          <ModelSettingsSection
            providers={providers}
            activeProvider={activeProvider}
            visibleProviders={visibleProviders}
            showApiKey={showApiKey}
            setShowApiKey={setShowApiKey}
            isImportingProviders={isImportingProviders}
            isExportingProviders={isExportingProviders}
            minimaxIsOAuthMode={minimaxIsOAuthMode}
            openaiIsOAuthMode={openaiIsOAuthMode}
            isBaseUrlLocked={isBaseUrlLocked}
            minimaxOAuthPhase={minimaxOAuthPhase}
            minimaxOAuthRegion={minimaxOAuthRegion}
            setMinimaxOAuthRegion={setMinimaxOAuthRegion}
            setMinimaxOAuthPhase={setMinimaxOAuthPhase}
            openaiOAuthPhase={openaiOAuthPhase}
            setOpenaiOAuthPhase={setOpenaiOAuthPhase}
            openaiOAuthStatus={openaiOAuthStatus}
            xaiIsOAuthMode={xaiIsOAuthMode}
            xaiOAuthPhase={xaiOAuthPhase}
            setXaiOAuthPhase={setXaiOAuthPhase}
            xaiOAuthStatus={xaiOAuthStatus}
            copilotAuthStatus={copilotAuthStatus}
            copilotUserCode={copilotUserCode}
            copilotVerificationUri={copilotVerificationUri}
            copilotGithubUser={copilotGithubUser}
            copilotError={copilotError}
            isTesting={isTesting}
            testResult={testResult}
            isTestResultModalOpen={isTestResultModalOpen}
            setIsTestResultModalOpen={setIsTestResultModalOpen}
            importInputRef={importInputRef}
            handleImportProvidersClick={handleImportProvidersClick}
            handleExportProviders={handleExportProviders}
            handleImportProviders={handleImportProviders}
            handleProviderChange={handleProviderChange}
            toggleProviderEnabled={toggleProviderEnabled}
            handleAddCustomProvider={handleAddCustomProvider}
            handleDeleteCustomProvider={handleDeleteCustomProvider}
            handleProviderConfigChange={handleProviderConfigChange}
            setProviders={setProviders}
            handleMiniMaxDeviceLogin={handleMiniMaxDeviceLogin}
            handleCancelMiniMaxLogin={handleCancelMiniMaxLogin}
            handleMiniMaxOAuthLogout={handleMiniMaxOAuthLogout}
            handleOpenAIOAuthLogin={handleOpenAIOAuthLogin}
            handleCancelOpenAIOAuthLogin={handleCancelOpenAIOAuthLogin}
            handleOpenAIOAuthLogout={handleOpenAIOAuthLogout}
            handleXaiOAuthLogin={handleXaiOAuthLogin}
            handleCancelXaiOAuthLogin={handleCancelXaiOAuthLogin}
            handleXaiOAuthLogout={handleXaiOAuthLogout}
            handleCopilotSignIn={handleCopilotSignIn}
            handleCopilotSignOut={handleCopilotSignOut}
            handleCopilotCancelAuth={handleCopilotCancelAuth}
            handleTestConnection={handleTestConnection}
            handleAddModel={handleAddModel}
            handleEditModel={handleEditModel}
            handleDeleteModel={handleDeleteModel}
          />
        );

      case 'shortcuts':
        return (
          <div className="space-y-4">
            <div className="relative">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
              <input
                value={shortcutSearchQuery}
                onChange={(event) => setShortcutSearchQuery(event.target.value)}
                placeholder={i18nService.t('shortcutSearchPlaceholder')}
                className="h-9 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-xs text-foreground outline-none transition-colors placeholder:text-secondary/70 focus:border-primary focus:ring-1 focus:ring-primary/25"
              />
            </div>
            <p className="text-xs leading-5 text-secondary">
              {i18nService.t('shortcutScopeHint')}
            </p>
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              {filteredShortcutGroups.length > 0 ? filteredShortcutGroups.map((group, groupIndex) => (
                <div key={group.titleKey}>
                  <div className={`border-border-subtle bg-surface-raised/60 px-4 py-2 text-xs font-medium uppercase tracking-wide text-secondary ${
                    groupIndex === 0 ? '' : 'border-t'
                  }`}>
                    {i18nService.t(group.titleKey)}
                  </div>
                  {group.commands.map((command, commandIndex) => {
                    const value = shortcuts[command.key] ?? '';
                    const commandLabel = getShortcutCommandText(command, 'labelKey');
                    return (
                      <div
                        key={command.key}
                        className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 ${
                          commandIndex === 0 ? '' : 'border-t border-border-subtle'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-foreground">
                            {commandLabel}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-xs text-secondary">
                            {getShortcutCommandText(command, 'descriptionKey')}
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          {command.inputType === 'send' ? (
                            <SendShortcutSelect
                              value={value}
                              onChange={(nextValue) => handleShortcutChange(command.key, nextValue)}
                            />
                          ) : (
                            <ShortcutRecorder
                              value={value}
                              label={commandLabel}
                              onChange={(nextValue) => handleShortcutChange(command.key, nextValue)}
                            />
                          )}
                          {value ? (
                            <button
                              type="button"
                              onClick={() => handleShortcutChange(command.key, '')}
                              title={i18nService.t('shortcutClear')}
                              aria-label={i18nService.t('shortcutClear')}
                              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <span className="h-6 w-6 shrink-0" aria-hidden="true" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )) : (
                <div className="px-4 py-8 text-center text-sm text-secondary">
                  {i18nService.t('shortcutNoResults')}
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleResetShortcuts}
                className="rounded-xl bg-surface-raised px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-border/60"
              >
                {i18nService.t('shortcutResetAll')}
              </button>
            </div>
          </div>
        );

      case 'im':
        return <IMSettings />;

      case 'plugins':
        return (
          <PluginsSettings
            handleRef={pluginsSettingsRef}
          />
        );

      case 'about':
        return (
          <div className="flex min-h-full flex-col items-center pt-6 pb-3">
            {/* Logo & App Name */}
            <img
              src="logo.png"
              alt="LobsterAI"
              className="w-16 h-16 mb-3 cursor-pointer select-none"
              onClick={(e) => {
                if (!e.altKey || !e.shiftKey) return;

                const next = logoClickCount + 1;
                setLogoClickCount(next);
                if (next >= 10 && !testModeUnlocked) {
                  setTestModeUnlocked(true);
                }
              }}
            />
            <h3 className="text-lg font-semibold text-foreground">LobsterAI</h3>
            <span className="text-xs text-secondary mt-1">v{appVersion}</span>

            {/* Info Card */}
            <div className="w-full mt-8 rounded-xl border border-border overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 border-b border-border">
                <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutVersion')}</span>
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  <span className="text-sm text-secondary">{appVersion}</span>
                  {!enterpriseConfig?.disableUpdate && (
                  <button
                    type="button"
                    disabled={updateCheckStatus === 'checking' || updateCheckStatus === 'downloading'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCheckUpdate();
                    }}
                    className="text-xs px-2 py-0.5 rounded-md border border-border text-secondary hover:text-primary dark:hover:text-primary hover:border-primary dark:hover:border-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {updateButtonLabel}
                  </button>
                  )}
                  {enterpriseConfig?.disableUpdate && (
                  <span className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('settings.enterprise.managed')}
                  </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 border-b border-border">
                <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutContactEmail')}</span>
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCopyContactEmail();
                    }}
                    title={i18nService.t('copyToClipboard')}
                    className="min-w-0 break-all text-right text-sm text-secondary bg-transparent border-none appearance-none p-0 m-0 cursor-pointer focus:outline-none"
                  >
                    {ABOUT_CONTACT_EMAIL}
                  </button>
                  {emailCopied && (
                    <span className="text-[11px] leading-4 text-emerald-600 dark:text-emerald-400">
                      {i18nService.t('copied')}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 border-b border-border">
                <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutUserCommunity')}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenUserCommunity();
                  }}
                  className="min-w-0 break-all text-right text-sm text-secondary hover:text-primary dark:hover:text-primary bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer focus:outline-none hover:bg-surface-raised transition-colors"
                >
                  {ABOUT_USER_COMMUNITY_URL}
                </button>
              </div>
              <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3${testModeUnlocked ? ' border-b border-border' : ''}`}>
                <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutUserManual')}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenUserManual();
                  }}
                  className="min-w-0 break-all text-right text-sm text-secondary hover:text-primary dark:hover:text-primary bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer focus:outline-none hover:bg-surface-raised transition-colors"
                >
                  {ABOUT_USER_MANUAL_URL}
                </button>
              </div>
              {testModeUnlocked && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                  <span className="shrink-0 text-sm text-foreground">{i18nService.t('testMode')}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={testMode}
                    onClick={() => setTestMode((prev) => !prev)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                      testMode ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        testMode ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-auto w-full pt-14 pb-2 flex flex-col items-center">
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-secondary">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenServiceTerms();
                  }}
                  className="bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer hover:text-primary dark:hover:text-primary transition-colors"
                >
                  {i18nService.t('aboutServiceTerms')}
                </button>
                <span className="text-xs opacity-40">|</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleExportLogs();
                  }}
                  disabled={isExportingLogs}
                  className="bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer hover:text-primary dark:hover:text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isExportingLogs ? i18nService.t('aboutExportingLogs') : i18nService.t('aboutExportLogs')}
                </button>
              </div>

              <p className="mt-5 text-center text-xs text-secondary">
                {i18nService.t('copyrightHolder')}
              </p>
              <p className="mt-1 text-center text-xs text-secondary">
                Copyright &copy; {new Date().getFullYear()} NetEase Youdao. All Rights Reserved.
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      onClose={guardedClose}
      overlayClassName="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-3 sm:p-4"
      className="w-[calc(100vw-1.5rem)] max-w-[900px] min-w-0 sm:w-[calc(100vw-2rem)]"
    >
      <div
        className="relative flex h-[80vh] max-h-[calc(100vh-2rem)] w-full min-w-0 rounded-2xl border-border border shadow-modal overflow-hidden modal-content"
        onClick={handleSettingsClick}
      >
        {/* Left sidebar */}
        <div className="w-[220px] shrink-0 flex flex-col bg-surface-raised border-r border-border rounded-l-2xl overflow-y-auto">
          <div className="px-5 pt-5 pb-3">
            <h2 className="text-lg font-semibold text-foreground">{i18nService.t('settings')}</h2>
          </div>
          <nav className="flex flex-col gap-0.5 px-3 pb-4">
            {sidebarTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  activeTab === tab.key
                    ? 'bg-primary-muted text-primary'
                    : 'text-secondary hover:text-foreground hover:bg-surface-raised'
                }`}
              >
                <span className="shrink-0">{tab.icon}</span>
                <span className="min-w-0 truncate">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right content */}
        <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-background rounded-r-2xl">
          {/* Content header */}
          <div className="flex justify-between items-center gap-3 px-6 pt-5 pb-3 shrink-0">
            <h3 className="min-w-0 truncate text-lg font-semibold text-foreground">{activeTabLabel}</h3>
            <button
              onClick={guardedClose}
              className="text-secondary hover:text-foreground p-1.5 hover:bg-surface-raised rounded-lg transition-colors"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {noticeMessage && (
            <div className="px-6">
              <ErrorMessage
                message={noticeMessage}
                onClose={() => setNoticeMessage(null)}
              />
            </div>
          )}

          {error && (
            <div className="px-6">
              <ErrorMessage
                message={error}
                onClose={() => setError(null)}
              />
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
            {/* Tab content */}
            <div
              ref={contentRef}
              className="px-6 py-4 flex-1 overflow-y-auto"
              style={{ scrollbarGutter: 'stable' }}
            >
              {renderTabContent()}
            </div>

            {/* Footer buttons */}
            <div className="relative shrink-0">
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 bottom-full h-10 bg-gradient-to-t from-background to-transparent transition-opacity duration-200 ${
                  footerFadeVisible ? 'opacity-100' : 'opacity-0'
                }`}
              />
              <div className="flex justify-end space-x-4 px-6 pb-5 pt-3 bg-background">
                <button
                  type="button"
                  onClick={guardedClose}
                  className="px-4 py-2 rounded-xl transition-colors text-sm font-medium border border-border text-foreground hover:bg-surface-raised active:scale-[0.98]"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
                >
                  {isSaving ? i18nService.t('saving') : i18nService.t('save')}
                </button>
              </div>
            </div>
          </form>

        </div>

        <ModelEditorDialog
          activeProvider={activeProvider}
          isAddingModel={isAddingModel}
          isEditingModel={isEditingModel}
          newModelName={newModelName}
          setNewModelName={setNewModelName}
          newModelId={newModelId}
          setNewModelId={setNewModelId}
          newModelSupportsImage={newModelSupportsImage}
          setNewModelSupportsImage={setNewModelSupportsImage}
          newModelSupportsThinking={newModelSupportsThinking}
          setNewModelSupportsThinking={setNewModelSupportsThinking}
          newModelContextWindow={newModelContextWindow}
          setNewModelContextWindow={setNewModelContextWindow}
          newModelCustomParams={newModelCustomParams}
          setNewModelCustomParams={setNewModelCustomParams}
          modelFormError={modelFormError}
          setModelFormError={setModelFormError}
          handleSaveNewModel={handleSaveNewModel}
          handleCancelModelEdit={handleCancelModelEdit}
          handleModelDialogKeyDown={handleModelDialogKeyDown}
        />

        <DeleteProviderConfirmDialog
          pendingDeleteProvider={pendingDeleteProvider}
          providers={providers}
          onCancel={() => setPendingDeleteProvider(null)}
          onConfirm={confirmDeleteCustomProvider}
        />

          {showOpenClawRepairConfirm && (
            <div
              className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
              onClick={() => {
                if (!isRepairingOpenClaw) setShowOpenClawRepairConfirm(false);
              }}
            >
              <div
                className="bg-surface border-border border rounded-2xl shadow-xl w-full max-w-md"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-5 pt-5 pb-4 border-b border-border">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
                      <WrenchScrewdriverIcon className="h-5 w-5" />
                    </span>
                    <h3 className="text-base font-semibold text-foreground">
                      {i18nService.t('openClawRepairConfirmTitle')}
                    </h3>
                  </div>
                </div>

                <div className="space-y-3 px-5 py-4 text-sm text-secondary">
                  <p>{i18nService.t('openClawRepairConfirmDesc')}</p>
                  <p>{i18nService.t('openClawRepairConfirmSafeDesc')}</p>
                </div>

                <div className="flex justify-end space-x-2 px-5 pb-5">
                  <button
                    type="button"
                    onClick={() => setShowOpenClawRepairConfirm(false)}
                    disabled={isRepairingOpenClaw}
                    className="px-3 py-1.5 text-sm text-foreground hover:bg-surface-raised rounded-xl border border-border disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleConfirmOpenClawRepair(); }}
                    disabled={isRepairingOpenClaw}
                    className="inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm text-white bg-primary hover:bg-primary-hover rounded-xl disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    <WrenchScrewdriverIcon className="h-4 w-4" />
                    {isRepairingOpenClaw
                      ? i18nService.t('openClawRepairRunning')
                      : i18nService.t('openClawRepairConfirmAction')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {showOpenClawDataRestoreConfirm && (
            <div
              className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
              onClick={() => {
                if (!isRestoringOpenClawData) setShowOpenClawDataRestoreConfirm(false);
              }}
            >
              <div
                className="bg-surface border-border border rounded-2xl shadow-xl w-full max-w-md"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-5 pt-5 pb-4 border-b border-border">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
                      <ArrowPathRoundedSquareIcon className="h-5 w-5" />
                    </span>
                    <h3 className="text-base font-semibold text-foreground">
                      {i18nService.t('openClawDataMigrationConfirmTitle')}
                    </h3>
                  </div>
                </div>

                <div className="space-y-3 px-5 py-4 text-sm text-secondary">
                  <p>{i18nService.t('openClawDataMigrationConfirmDesc')}</p>
                  <p>{i18nService.t('openClawDataMigrationConfirmSafeDesc')}</p>
                </div>

                <div className="flex justify-end space-x-2 px-5 pb-5">
                  <button
                    type="button"
                    onClick={() => setShowOpenClawDataRestoreConfirm(false)}
                    disabled={isRestoringOpenClawData}
                    className="px-3 py-1.5 text-sm text-foreground hover:bg-surface-raised rounded-xl border border-border disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleConfirmOpenClawDataRestore(); }}
                    disabled={isRestoringOpenClawData}
                    className="inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm text-white bg-primary hover:bg-primary-hover rounded-xl disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {isRestoringOpenClawData
                      ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
                      : <ArrowPathRoundedSquareIcon className="h-4 w-4" />}
                    {isRestoringOpenClawData
                      ? i18nService.t('openClawDataMigrationRunning')
                      : i18nService.t('openClawDataMigrationConfirmAction')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {(isBackingUpOpenClawData || isRestoringOpenClawData) && (
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4">
              <div className="w-full max-w-md rounded-2xl border border-border bg-surface px-5 py-5 text-center shadow-xl">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary-muted text-primary">
                  <ArrowPathIcon className="h-5 w-5 animate-spin" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-foreground">
                  {i18nService.t(isBackingUpOpenClawData
                    ? 'openClawDataBackupBlockingTitle'
                    : 'openClawDataMigrationBlockingTitle')}
                </h3>
                <p className="mt-2 text-sm leading-6 text-secondary">
                  {i18nService.t(isBackingUpOpenClawData
                    ? 'openClawDataBackupBlockingDesc'
                    : 'openClawDataMigrationBlockingDesc')}
                </p>
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {i18nService.t(isBackingUpOpenClawData
                      ? 'openClawDataBackupBlockingWarning'
                      : 'openClawDataMigrationBlockingWarning')}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Memory Modal */}
          {showMemoryModal && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
              onClick={resetCoworkMemoryEditor}
            >
              <div
                className="bg-surface border-border border rounded-2xl shadow-xl w-full max-w-lg"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
                  <h3 className="text-base font-semibold text-foreground">
                    {coworkMemoryEditingId ? i18nService.t('coworkMemoryCrudUpdate') : i18nService.t('coworkMemoryCrudCreate')}
                  </h3>
                  {coworkMemoryEditingId && (
                    <span className="inline-flex items-center rounded-md bg-primary-muted px-2 py-0.5 text-[11px] text-primary">
                      {i18nService.t('coworkMemoryEditingTag')}
                    </span>
                  )}
                </div>

                <div className="px-5 pb-1">
                  <label className="block text-xs font-medium text-secondary mb-1.5">
                    {i18nService.t('coworkMemoryCrudContentLabel')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
                  </label>
                  <textarea
                    value={coworkMemoryDraftText}
                    onChange={(event) => setCoworkMemoryDraftText(event.target.value)}
                    placeholder={i18nService.t('coworkMemoryCrudTextPlaceholder')}
                    autoFocus
                    className="min-h-[220px] w-full resize-y rounded-lg border px-3.5 py-3 text-sm leading-relaxed border-border bg-surface text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                  />
                  <div className="mt-1.5 text-[11px] leading-relaxed text-secondary">
                    {i18nService.t('coworkMemoryCrudMultilineHint')}
                  </div>
                </div>

                <div className="flex justify-end space-x-2 px-5 py-4">
                  <button
                    type="button"
                    onClick={resetCoworkMemoryEditor}
                    className="px-3.5 py-1.5 text-sm text-foreground hover:bg-surface-raised rounded-lg border border-border transition-colors"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleSaveCoworkMemoryEntry(); }}
                    disabled={!coworkMemoryDraftText.trim() || coworkMemoryListLoading}
                    className="px-3.5 py-1.5 text-sm text-white bg-primary hover:bg-primary-hover rounded-lg disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {coworkMemoryEditingId ? i18nService.t('save') : i18nService.t('coworkMemoryCrudCreate')}
                  </button>
                </div>
              </div>
            </div>
          )}

      </div>
    </Modal>
  );
};

export default Settings;
