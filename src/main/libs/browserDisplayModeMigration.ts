import {
  BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  type BrowserWebAccessConfig,
  normalizeBrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';

export const APP_CONFIG_KEY = 'app_config';

export type BrowserDisplayModeMigrationConfig = Record<string, unknown> & {
  browserWebAccess?: Partial<BrowserWebAccessConfig>;
  browserDisplayModeMigrationVersion?: number;
};

interface BrowserDisplayModeMigrationStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

export function migrateBrowserDisplayModeConfig(config: BrowserDisplayModeMigrationConfig): BrowserDisplayModeMigrationConfig {
  const browser = config.browserWebAccess;
  const displayMode = normalizeBrowserWebAccessConfig(browser).displayMode;
  const version = config.browserDisplayModeMigrationVersion ?? 0;
  if (browser?.displayMode === displayMode && version >= BROWSER_DISPLAY_MODE_MIGRATION_VERSION) {
    return config;
  }

  return {
    ...config,
    browserWebAccess: { ...browser, displayMode },
    browserDisplayModeMigrationVersion: Math.max(version, BROWSER_DISPLAY_MODE_MIGRATION_VERSION),
  };
}

export function migrateBrowserDisplayMode(store: BrowserDisplayModeMigrationStore): boolean {
  const config = store.get<BrowserDisplayModeMigrationConfig>(APP_CONFIG_KEY);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const migrated = migrateBrowserDisplayModeConfig(config);
  if (migrated === config) return false;
  store.set(APP_CONFIG_KEY, migrated);
  return true;
}
