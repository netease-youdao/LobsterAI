import { type ProviderConfig,ProviderRegistry } from '@shared/providers';

import {
  type BrowserWebAccessConfig,
  defaultBrowserWebAccessConfig,
} from '../shared/browserWebAccess/constants';
import {
  defaultNotificationSettings,
  type NotificationSettings,
} from '../shared/notifications/constants';

export const ShortcutAction = {
  NewChat: 'newChat',
  Search: 'search',
  Settings: 'settings',
  SendMessage: 'sendMessage',
  ShowShortcuts: 'showShortcuts',
  FocusPrompt: 'focusPrompt',
  StopCurrentTask: 'stopCurrentTask',
  ToggleSidebar: 'toggleSidebar',
  ToggleArtifacts: 'toggleArtifacts',
  PreviousAgent: 'previousAgent',
  NextAgent: 'nextAgent',
  ShowCurrentAgentTasks: 'showCurrentAgentTasks',
  OpenAgentTask1: 'openAgentTask1',
  OpenAgentTask2: 'openAgentTask2',
  OpenAgentTask3: 'openAgentTask3',
  OpenAgentTask4: 'openAgentTask4',
  OpenAgentTask5: 'openAgentTask5',
  OpenAgentTask6: 'openAgentTask6',
  OpenAgentTask7: 'openAgentTask7',
  OpenAgentTask8: 'openAgentTask8',
  OpenAgentTask9: 'openAgentTask9',
  OpenCowork: 'openCowork',
  OpenScheduledTasks: 'openScheduledTasks',
  OpenKits: 'openKits',
  OpenSkills: 'openSkills',
  OpenMcp: 'openMcp',
  OpenSettingsGeneral: 'openSettingsGeneral',
  OpenSettingsAppearance: 'openSettingsAppearance',
  OpenSettingsAgentEngine: 'openSettingsAgentEngine',
  OpenSettingsModel: 'openSettingsModel',
  OpenSettingsIm: 'openSettingsIm',
  OpenSettingsBrowser: 'openSettingsBrowser',
  OpenSettingsEmail: 'openSettingsEmail',
  OpenSettingsMemory: 'openSettingsMemory',
  OpenSettingsDreaming: 'openSettingsDreaming',
  OpenSettingsPlugins: 'openSettingsPlugins',
  OpenSettingsShortcuts: 'openSettingsShortcuts',
  OpenSettingsAbout: 'openSettingsAbout',
} as const;

export type ShortcutAction = typeof ShortcutAction[keyof typeof ShortcutAction];

export type ShortcutConfig = Record<ShortcutAction, string> & {
  [key: string]: string | undefined;
};

export const FontPreferences = {
  UiFontSizeDefault: 14,
  UiFontSizeMin: 11,
  UiFontSizeMax: 16,
  CodeFontSizeDefault: 12,
  CodeFontSizeMin: 8,
  CodeFontSizeMax: 24,
} as const;

export const normalizeFontPreference = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const numericValue = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numericValue)));
};

// 配置类型定义
export interface AppConfig {
  // API 配置
  api: {
    key: string;
    baseUrl: string;
  };
  // 模型配置
  model: {
    availableModels: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
    }>;
    defaultModel: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, ProviderConfig>;
  providerModelMigrationVersions?: Record<string, number>;
  // 主题配置
  theme: 'light' | 'dark' | 'system';
  // UI 字号配置
  uiFontSize?: number;
  // 代码字体大小配置
  codeFontSize?: number;
  // 语言配置
  language: 'zh' | 'en';
  // 是否使用系统代理
  useSystemProxy: boolean;
  // 是否启用 SQLite 自动备份与恢复
  sqliteAutoBackupEnabled?: boolean;
  // 是否允许发送基础产品使用统计
  usageAnalyticsEnabled?: boolean;
  // 通知配置
  notificationSettings?: NotificationSettings;
  // 浏览器与网页访问配置
  browserWebAccess: BrowserWebAccessConfig;
  // 语言初始化标记 (用于判断是否是首次启动)
  language_initialized?: boolean;
  // 应用配置
  app: {
    port: number;
    isDevelopment: boolean;
    testMode?: boolean;
  };
  // 快捷键配置
  shortcuts?: ShortcutConfig;
}

const buildDefaultProviders = (): AppConfig['providers'] => {
  const providers: Record<string, ProviderConfig> = {};

  for (const id of ProviderRegistry.providerIds) {
    const def = ProviderRegistry.get(id)!;
    providers[id] = {
      enabled: false,
      apiKey: '',
      baseUrl: def.defaultBaseUrl,
      apiFormat: def.defaultApiFormat,
      ...(def.codingPlanSupported ? { codingPlanEnabled: false } : {}),
      models: def.defaultModels.map(m => ({ ...m })),
    };
  }

  return providers;
};

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://api.deepseek.com',
  },
  model: {
    availableModels: [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
    ],
    defaultModel: 'deepseek-reasoner',
    defaultModelProvider: 'deepseek',
  },
  providers: buildDefaultProviders(),
  theme: 'system',
  uiFontSize: FontPreferences.UiFontSizeDefault,
  codeFontSize: FontPreferences.CodeFontSizeDefault,
  language: 'zh',
  useSystemProxy: false,
  sqliteAutoBackupEnabled: false,
  usageAnalyticsEnabled: true,
  notificationSettings: defaultNotificationSettings,
  browserWebAccess: defaultBrowserWebAccessConfig,
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
    // Default to production (official) services. Source-launched dev builds run
    // with NODE_ENV=development, but must not auto-target the internal-only test
    // endpoints (*.inner.youdao.com) — external/open-source users can't reach
    // them. Flip test mode via the hidden switch in Settings → About when the
    // internal endpoints are actually needed.
    testMode: false,
  },
  shortcuts: {
    [ShortcutAction.NewChat]: 'CommandOrControl+N',
    [ShortcutAction.Search]: 'CommandOrControl+F',
    [ShortcutAction.Settings]: 'CommandOrControl+,',
    [ShortcutAction.SendMessage]: 'Enter',
    [ShortcutAction.ShowShortcuts]: 'CommandOrControl+/',
    [ShortcutAction.FocusPrompt]: 'CommandOrControl+K',
    [ShortcutAction.StopCurrentTask]: 'CommandOrControl+.',
    [ShortcutAction.ToggleSidebar]: 'CommandOrControl+B',
    [ShortcutAction.ToggleArtifacts]: 'CommandOrControl+Shift+B',
    [ShortcutAction.PreviousAgent]: '',
    [ShortcutAction.NextAgent]: '',
    [ShortcutAction.ShowCurrentAgentTasks]: '',
    [ShortcutAction.OpenAgentTask1]: '',
    [ShortcutAction.OpenAgentTask2]: '',
    [ShortcutAction.OpenAgentTask3]: '',
    [ShortcutAction.OpenAgentTask4]: '',
    [ShortcutAction.OpenAgentTask5]: '',
    [ShortcutAction.OpenAgentTask6]: '',
    [ShortcutAction.OpenAgentTask7]: '',
    [ShortcutAction.OpenAgentTask8]: '',
    [ShortcutAction.OpenAgentTask9]: '',
    [ShortcutAction.OpenCowork]: 'CommandOrControl+1',
    [ShortcutAction.OpenScheduledTasks]: 'CommandOrControl+2',
    [ShortcutAction.OpenKits]: 'CommandOrControl+3',
    [ShortcutAction.OpenSkills]: 'CommandOrControl+4',
    [ShortcutAction.OpenMcp]: 'CommandOrControl+5',
    [ShortcutAction.OpenSettingsGeneral]: '',
    [ShortcutAction.OpenSettingsAppearance]: '',
    [ShortcutAction.OpenSettingsAgentEngine]: '',
    [ShortcutAction.OpenSettingsModel]: '',
    [ShortcutAction.OpenSettingsIm]: '',
    [ShortcutAction.OpenSettingsBrowser]: '',
    [ShortcutAction.OpenSettingsEmail]: '',
    [ShortcutAction.OpenSettingsMemory]: '',
    [ShortcutAction.OpenSettingsDreaming]: '',
    [ShortcutAction.OpenSettingsPlugins]: '',
    [ShortcutAction.OpenSettingsShortcuts]: '',
    [ShortcutAction.OpenSettingsAbout]: '',
  }
};

// 配置存储键
export const CONFIG_KEYS = {
  APP_CONFIG: 'app_config',
  AUTH: 'auth_state',
  CONVERSATIONS: 'conversations',
  PROVIDERS_EXPORT_KEY: 'providers_export_key',
  SKILLS: 'skills',
};

// 模型提供商分类
export const EN_PRIORITY_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
// Provider lists derived from ProviderRegistry — single source of truth
export const CHINA_PROVIDERS = [...ProviderRegistry.idsByRegion('china')] as const;
export const GLOBAL_PROVIDERS = ProviderRegistry.idsByRegion('global');

export const getVisibleProviders = (language: 'zh' | 'en'): readonly string[] => {
  if (language === 'zh') {
    return [...CHINA_PROVIDERS];
  }
  return ProviderRegistry.idsForEnLocale();
};

/**
 * 判断 provider key 是否为自定义提供商（custom_0, custom_1, ...）
 */
export const isCustomProvider = (key: string): boolean => key.startsWith('custom_');

/**
 * 从 custom_N key 中提取默认显示名称（如 custom_0 → "Custom0"）
 */
export const getCustomProviderDefaultName = (key: string): string => {
  const suffix = key.replace('custom_', '');
  return `Custom${suffix}`;
};

/**
 * 获取 provider 的显示名称，自定义 provider 优先使用 displayName，
 * 内置 provider 使用首字母大写的 key。
 */
export const getProviderDisplayName = (
  providerKey: string,
  providerConfig?: { displayName?: string },
): string => {
  if (isCustomProvider(providerKey)) {
    const name = providerConfig && typeof providerConfig.displayName === 'string'
      ? providerConfig.displayName
      : '';
    return name || getCustomProviderDefaultName(providerKey);
  }
  const def = ProviderRegistry.get(providerKey);
  if (def) return def.label;
  return providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
};
