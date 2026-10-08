import { app } from 'electron';

import { HtmlSharePublicRoute } from '../../shared/htmlShare/constants';
import type { SqliteStore } from '../sqliteStore';
import { resolveDevelopmentServerBaseUrl } from './developmentServerBaseUrl';

let cachedTestMode: boolean | null = null;
let loggedDevelopmentServerBaseUrl: string | null = null;

/**
 * Read testMode from store and cache it.
 * Call once at startup and again whenever app_config changes.
 */
export function refreshEndpointsTestMode(store: SqliteStore): void {
  const appConfig = store.get<any>('app_config');
  cachedTestMode = appConfig?.app?.testMode === true;
}

/**
 * Whether the app is in test mode.
 * Uses cached value after init; falls back to !app.isPackaged before init.
 */
export const isTestModeEnabled = (): boolean => {
  return cachedTestMode ?? !app.isPackaged;
};

/**
 * Server API base URL — switches based on testMode.
 * Used for auth exchange/refresh, models, proxy, etc.
 */
export const getServerApiBaseUrl = (): string => {
  const defaultBaseUrl = isTestModeEnabled()
    ? 'https://lobsterai-server.inner.youdao.com'
    : 'https://lobsterai-server.youdao.com';
  const serverBaseUrl = resolveDevelopmentServerBaseUrl({
    defaultBaseUrl,
    developmentOverride: process.env.LOBSTER_SERVER_BASE_URL,
    isDev: process.env.NODE_ENV === 'development',
    isPackaged: app.isPackaged,
  });
  if (serverBaseUrl !== defaultBaseUrl
      && loggedDevelopmentServerBaseUrl !== serverBaseUrl) {
    console.warn(
      `[Endpoints] routing all Lobster server traffic to development origin ${serverBaseUrl}`,
    );
    loggedDevelopmentServerBaseUrl = serverBaseUrl;
  }
  return serverBaseUrl;
};

export const getHtmlSharePublicBaseUrl = (): string => {
  return `${getServerApiBaseUrl()}${HtmlSharePublicRoute.Root}`;
};

export const getUpdateCheckUrl = (): string => (
  isTestModeEnabled()
    ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/update'
    : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update'
);

export const getManualUpdateCheckUrl = (): string => (
  isTestModeEnabled()
    ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/update-manual'
    : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update-manual'
);

export const getFallbackDownloadUrl = (): string => (
  isTestModeEnabled()
    ? 'https://lobsterai.inner.youdao.com/#/download-list'
    : 'https://lobsterai.youdao.com/#/download-list'
);

export const getSkillStoreUrl = (): string => (
  isTestModeEnabled()
    ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/skill-store'
    : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/skill-store'
);

// Portal 页面
const PORTAL_BASE_TEST = 'https://lobsterai.inner.youdao.com/portal#';
const PORTAL_BASE_PROD = 'https://lobsterai.youdao.com/portal#';

const getPortalBase = (): string => isTestModeEnabled() ? PORTAL_BASE_TEST : PORTAL_BASE_PROD;

export const getPortalTasksUrl = (): string => `${getPortalBase()}/profile/detail?tab=tasks`;

export const getKitStoreUrl = (): string => (
  isTestModeEnabled()
    ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/kit-store'
    : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/kit-store'
);
