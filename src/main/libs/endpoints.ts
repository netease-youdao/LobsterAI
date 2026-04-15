import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';

let cachedTestMode: boolean | null = null;

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
const isTestMode = (): boolean => {
  return cachedTestMode ?? !app.isPackaged;
};

/**
 * Server API base URL — switches based on testMode.
 * Used for auth exchange/refresh, models, proxy, etc.
 */
export const getServerApiBaseUrl = (): string => {
  return isTestMode()
    ? 'https://lobsterai-server.inner.youdao.com'
    : 'https://lobsterai-server.youdao.com';
};

const PORTAL_BASE_TEST = 'https://c.youdao.com/dict/hardware/cowork/lobsterai-portal.html#';
const PORTAL_BASE_PROD = 'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal.html#';

const getPortalBase = () => isTestMode() ? PORTAL_BASE_TEST : PORTAL_BASE_PROD;

export const getPortalPricingUrl = () => `${getPortalBase()}/pricing`;

// Pricing URL (overmind remote config)
export const getPricingOvermindUrl = () => isTestMode()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/pricing-url'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/pricing-url';

let cachedPricingUrl: string | null = null;

/**
 * Fetch pricing URL from overmind and cache it.
 * Falls back to portal pricing URL on failure.
 */
export async function fetchAndCachePricingUrl(): Promise<string> {
  try {
    const resp = await fetch(getPricingOvermindUrl());
    if (resp.ok) {
      const data = await resp.json();
      if (typeof data?.result === 'string' && data.result) {
        cachedPricingUrl = data.result;
        console.log(`[Endpoints] cached pricing URL from overmind: ${cachedPricingUrl}`);
        return cachedPricingUrl;
      }
    }
    console.warn(`[Endpoints] overmind pricing URL request failed (${resp.status}), using fallback`);
  } catch (err) {
    console.warn('[Endpoints] failed to fetch pricing URL from overmind, using fallback:', err);
  }
  cachedPricingUrl = getPortalPricingUrl();
  return cachedPricingUrl;
}

/**
 * Get the cached pricing URL, or fall back to portal pricing URL if not yet fetched.
 */
export function getCachedPricingUrl(): string {
  return cachedPricingUrl || getPortalPricingUrl();
}
