import { describe, expect, test } from 'vitest';

import { McpMarketplaceSource } from '../../shared/mcp/constants';
import {
  getMcpMarketplaceCacheKey,
  LEGACY_MCP_MARKETPLACE_CACHE_KEY,
  type MarketplaceCachePayload,
  type MarketplaceStorageLike,
  readMcpMarketplaceCache,
  shouldCacheMcpMarketplaceResult,
  writeMcpMarketplaceCache,
} from './mcpMarketplaceCache';

function createMemoryStorage(): MarketplaceStorageLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: key => {
      entries.delete(key);
    },
  };
}

const prodPayload: MarketplaceCachePayload = {
  servers: [
    {
      id: 'tavily',
      name: 'Tavily',
      category: 'search',
      transportType: 'stdio',
      command: 'npx',
      defaultArgs: ['-y', 'tavily-mcp@latest'],
    },
  ],
  categories: [{ id: 'all', name_zh: '全部', name_en: 'All' }],
};

const testPayload: MarketplaceCachePayload = {
  servers: [
    {
      id: 'tdx',
      name: 'Tongdaxin',
      category: 'data-api',
      transportType: 'http',
      url: 'https://txmcp.tdx.com.cn:3001/txmcp',
      auth: 'oauth',
    },
  ],
  categories: [{ id: 'all', name_zh: '全部', name_en: 'All' }],
};

describe('mcpMarketplaceCache', () => {
  test('isolates prod and test caches under separate keys', () => {
    const storage = createMemoryStorage();

    expect(getMcpMarketplaceCacheKey(false)).not.toBe(getMcpMarketplaceCacheKey(true));

    writeMcpMarketplaceCache(storage, false, prodPayload);
    writeMcpMarketplaceCache(storage, true, testPayload);

    expect(readMcpMarketplaceCache(storage, false)).toEqual(prodPayload);
    expect(readMcpMarketplaceCache(storage, true)).toEqual(testPayload);
  });

  test('ignores legacy unscoped cache key and removes it once new cache is written', () => {
    const storage = createMemoryStorage();
    storage.setItem(LEGACY_MCP_MARKETPLACE_CACHE_KEY, JSON.stringify(testPayload));

    expect(readMcpMarketplaceCache(storage, false)).toBeNull();
    expect(readMcpMarketplaceCache(storage, true)).toBeNull();

    writeMcpMarketplaceCache(storage, false, prodPayload);
    expect(storage.entries.has(LEGACY_MCP_MARKETPLACE_CACHE_KEY)).toBe(false);
    expect(readMcpMarketplaceCache(storage, false)).toEqual(prodPayload);
  });

  test('returns null for corrupt or malformed cache entries', () => {
    const storage = createMemoryStorage();
    storage.setItem(getMcpMarketplaceCacheKey(false), '{not valid json');
    expect(readMcpMarketplaceCache(storage, false)).toBeNull();

    storage.setItem(getMcpMarketplaceCacheKey(false), JSON.stringify({ servers: 'bad' }));
    expect(readMcpMarketplaceCache(storage, false)).toBeNull();
  });

  test('skips caching local-file overrides while caching remote responses', () => {
    expect(shouldCacheMcpMarketplaceResult(McpMarketplaceSource.LocalFile)).toBe(false);
    expect(shouldCacheMcpMarketplaceResult(McpMarketplaceSource.Remote)).toBe(true);
    expect(shouldCacheMcpMarketplaceResult(undefined)).toBe(true);
  });
});
