import {
  BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  BrowserDisplayMode,
  type BrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';

const APP_CONFIG_KEY = 'app_config';

type BrowserDisplayModeMigrationConfig = Record<string, unknown> & {
  browserWebAccess?: Partial<BrowserWebAccessConfig>;
  browserDisplayModeMigrationVersion?: number;
};

interface BrowserDisplayModeMigrationStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

/**
 * Switches an existing install to the in-app browser once. The renderer
 * persists the normalized browser config on every launch, so older installs
 * carry an explicit `external` value that a new default alone cannot change.
 *
 * Run it before the first OpenClaw config sync so the gateway starts with the
 * in-app browser profile instead of restarting after the renderer loads.
 */
export const migrateBrowserDisplayModeToInApp = (
  store: BrowserDisplayModeMigrationStore,
): boolean => {
  const appConfig = store.get<BrowserDisplayModeMigrationConfig>(APP_CONFIG_KEY);
  // Fresh installs already start from the in-app default; the renderer's
  // default config records the applied version on its first write.
  if (!appConfig) return false;
  if ((appConfig.browserDisplayModeMigrationVersion ?? 0) >= BROWSER_DISPLAY_MODE_MIGRATION_VERSION) {
    return false;
  }

  store.set(APP_CONFIG_KEY, {
    ...appConfig,
    browserWebAccess: {
      ...appConfig.browserWebAccess,
      displayMode: BrowserDisplayMode.InApp,
    },
    browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  });
  return true;
};
