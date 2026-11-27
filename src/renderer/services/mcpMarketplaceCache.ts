import { McpMarketplaceSource } from '../../shared/mcp/constants';
import type { McpMarketplaceCategoryInfo, McpMarketplaceServer } from '../types/mcp';

export const McpMarketplaceEnvironment = {
  Prod: 'prod',
  Test: 'test',
} as const;
export type McpMarketplaceEnvironment =
  typeof McpMarketplaceEnvironment[keyof typeof McpMarketplaceEnvironment];

export interface MarketplaceCachePayload {
  servers: McpMarketplaceServer[];
  categories: McpMarketplaceCategoryInfo[];
}

export interface MarketplaceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Legacy unscoped key; ignored on read and cleaned up on write so stale cross-env data cannot leak. */
export const LEGACY_MCP_MARKETPLACE_CACHE_KEY = 'mcpMarketplaceCache.v1';
const MCP_MARKETPLACE_CACHE_KEY_PREFIX = 'mcpMarketplaceCache.v2';

export function getMcpMarketplaceCacheEnvironment(testMode: boolean): McpMarketplaceEnvironment {
  return testMode ? McpMarketplaceEnvironment.Test : McpMarketplaceEnvironment.Prod;
}

export function getMcpMarketplaceCacheKey(testMode: boolean): string {
  return `${MCP_MARKETPLACE_CACHE_KEY_PREFIX}:${getMcpMarketplaceCacheEnvironment(testMode)}`;
}

export function shouldCacheMcpMarketplaceResult(source?: McpMarketplaceSource): boolean {
  return source !== McpMarketplaceSource.LocalFile;
}

export function readMcpMarketplaceCache(
  storage: MarketplaceStorageLike | undefined,
  testMode: boolean,
): MarketplaceCachePayload | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(getMcpMarketplaceCacheKey(testMode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketplaceCachePayload;
    if (!Array.isArray(parsed?.servers) || !Array.isArray(parsed?.categories)) return null;
    return parsed;
  } catch {
    // localStorage unavailable or the cache is corrupt; fetch will repopulate.
    return null;
  }
}

export function writeMcpMarketplaceCache(
  storage: MarketplaceStorageLike | undefined,
  testMode: boolean,
  payload: MarketplaceCachePayload,
): void {
  if (!storage) return;
  try {
    storage.setItem(getMcpMarketplaceCacheKey(testMode), JSON.stringify(payload));
    storage.removeItem?.(LEGACY_MCP_MARKETPLACE_CACHE_KEY);
  } catch {
    // Cache is an optimization only; failing to persist must not break fetch.
  }
}
