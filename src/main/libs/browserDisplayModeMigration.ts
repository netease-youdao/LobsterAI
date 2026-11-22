import {
  BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  BrowserDisplayMode,
  type BrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';

export const APP_CONFIG_KEY = 'app_config';

export const EXTERNAL_BROWSER_ONLY_CONFIG_KEYS = [
  'executablePath',
  'cdpUrl',
  'headless',
  'attachOnly',
  'remoteCdpTimeoutMs',
  'remoteCdpHandshakeTimeoutMs',
  'extraArgs',
] as const;

export type BrowserDisplayModeMigrationConfig = Record<string, unknown> & {
  browserWebAccess?: Partial<BrowserWebAccessConfig>;
  browserDisplayModeMigrationVersion?: number;
};

export interface BrowserDisplayModeMigrationResult {
  changed: boolean;
  /** True when the persisted config actively used external mode or configured external-only fields. */
  migratedExternalConfig: boolean;
  /** Snapshot of the removed external-browser fields when `migratedExternalConfig` is true. */
  archivedExternalConfig?: Record<string, unknown>;
  nextConfig: BrowserDisplayModeMigrationConfig;
}

interface BrowserDisplayModeMigrationStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

const isNonEmptyString = (value: unknown): boolean => (
  typeof value === 'string' && value.trim().length > 0
);

const isPositiveFiniteNumber = (value: unknown): boolean => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

const hasConfiguredExternalBrowserFields = (
  browserWebAccess: Record<string, unknown> | undefined,
): boolean => {
  if (!browserWebAccess) return false;
  if (browserWebAccess.displayMode === BrowserDisplayMode.External) return true;
  if (browserWebAccess.displayMode === undefined && browserWebAccess.headless === false) return true;
  if (isNonEmptyString(browserWebAccess.executablePath)) return true;
  if (isNonEmptyString(browserWebAccess.cdpUrl)) return true;
  if (browserWebAccess.attachOnly === true) return true;
  if (isPositiveFiniteNumber(browserWebAccess.remoteCdpTimeoutMs)) return true;
  if (isPositiveFiniteNumber(browserWebAccess.remoteCdpHandshakeTimeoutMs)) return true;
  if (
    Array.isArray(browserWebAccess.extraArgs)
    && browserWebAccess.extraArgs.some(isNonEmptyString)
  ) {
    return true;
  }
  return false;
};

/**
 * Pure migration helper for persisted `app_config` records.
 *
 * On DSH, external browser control is unavailable and the UI offers no toggle
 * to switch back from `external` to `in-app`. Always migrate any persisted
 * non-in-app `displayMode` (regardless of `browserDisplayModeMigrationVersion`)
 * and strip dead external-only fields while preserving all reusable browser web
 * access settings (`networkMode`, `credentialUseMode`, `credentialSaveMode`,
 * `blockedHostnames`, etc.).
 */
export const migrateBrowserDisplayModeConfig = (
  appConfig: BrowserDisplayModeMigrationConfig,
): BrowserDisplayModeMigrationResult => {
  const rawBrowser = appConfig.browserWebAccess;
  const existingBrowser: Record<string, unknown> | undefined = (
    rawBrowser && typeof rawBrowser === 'object' && !Array.isArray(rawBrowser)
      ? (rawBrowser as Record<string, unknown>)
      : undefined
  );
  const currentVersion = (
    typeof appConfig.browserDisplayModeMigrationVersion === 'number'
    && Number.isFinite(appConfig.browserDisplayModeMigrationVersion)
      ? appConfig.browserDisplayModeMigrationVersion
      : 0
  );
  const presentExternalKeys = existingBrowser
    ? EXTERNAL_BROWSER_ONLY_CONFIG_KEYS.filter(key => key in existingBrowser)
    : [];

  const needsDisplayModeReset = existingBrowser?.displayMode !== BrowserDisplayMode.InApp;
  const needsVersionBump = currentVersion < BROWSER_DISPLAY_MODE_MIGRATION_VERSION;
  const needsExternalFieldCleanup = presentExternalKeys.length > 0;

  if (!needsDisplayModeReset && !needsVersionBump && !needsExternalFieldCleanup) {
    return {
      changed: false,
      migratedExternalConfig: false,
      nextConfig: appConfig,
    };
  }

  const migratedExternalConfig = hasConfiguredExternalBrowserFields(existingBrowser);
  let archivedExternalConfig: Record<string, unknown> | undefined;
  if (migratedExternalConfig && existingBrowser) {
    archivedExternalConfig = {};
    if ('displayMode' in existingBrowser && existingBrowser.displayMode !== undefined) {
      archivedExternalConfig.displayMode = existingBrowser.displayMode;
    }
    for (const key of presentExternalKeys) {
      if (existingBrowser[key] !== undefined) {
        archivedExternalConfig[key] = existingBrowser[key];
      }
    }
  }

  const cleanedBrowser: Record<string, unknown> = existingBrowser ? { ...existingBrowser } : {};
  for (const key of EXTERNAL_BROWSER_ONLY_CONFIG_KEYS) {
    delete cleanedBrowser[key];
  }
  cleanedBrowser.displayMode = BrowserDisplayMode.InApp;

  const nextConfig: BrowserDisplayModeMigrationConfig = {
    ...appConfig,
    browserWebAccess: cleanedBrowser as Partial<BrowserWebAccessConfig>,
    browserDisplayModeMigrationVersion: Math.max(
      currentVersion,
      BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    ),
  };

  return {
    changed: true,
    migratedExternalConfig,
    ...(archivedExternalConfig ? { archivedExternalConfig } : {}),
    nextConfig,
  };
};

/**
 * Ensures any existing install uses the in-app browser on startup and removes
 * dead external-browser-only fields while preserving reusable web access
 * settings.
 *
 * Run it before engine startup and window creation so both main-process browser
 * hosts and renderer state start cleanly in `in-app` mode.
 */
export const migrateBrowserDisplayModeToInApp = (
  store: BrowserDisplayModeMigrationStore,
): boolean => {
  const appConfig = store.get<BrowserDisplayModeMigrationConfig>(APP_CONFIG_KEY);
  // Fresh installs already start from the in-app default; the renderer's
  // default config records the applied version on its first write.
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    return false;
  }

  const result = migrateBrowserDisplayModeConfig(appConfig);
  if (!result.changed) {
    return false;
  }

  store.set(APP_CONFIG_KEY, result.nextConfig);
  return true;
};
