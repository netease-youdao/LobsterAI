import type { SqliteStore } from '../sqliteStore';

/** No-op stub, kept for callers. */
export function refreshEndpointsTestMode(_store: SqliteStore): void {}

/**
 * Server API base URL — configurable via environment variable.
 * Used for auth exchange/refresh, models, proxy, etc.
 * Set LOBSTERAI_SERVER_API_BASE_URL to your own server.
 */
export const getServerApiBaseUrl = (): string => {
  const envUrl = process.env.LOBSTERAI_SERVER_API_BASE_URL?.trim();
  if (envUrl) return envUrl;
  return '';
};

export const getSkillStoreUrl = (): string => '';
export const getMcpMarketplaceUrl = (): string => '';
export const getLoginOvermindUrl = (): string => '';

export const getModelScopeMcpBaseUrl = (): string =>
  'https://www.modelscope.cn/openapi/v1/mcp/servers';
