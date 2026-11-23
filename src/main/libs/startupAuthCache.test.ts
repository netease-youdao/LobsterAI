import { describe, expect, test } from 'vitest';

import {
  clearStartupAuthCache,
  extractAuthCacheUserId,
  readStartupAuthCache,
  saveStartupAuthCachePatch,
  StartupAuthCacheKey,
  type StartupAuthCacheKvPort,
} from './startupAuthCache';

function createMemoryKv(): StartupAuthCacheKvPort & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T = unknown>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      data.set(key, value);
    },
    delete(key: string): void {
      data.delete(key);
    },
  };
}

describe('startupAuthCache', () => {
  test('extractAuthCacheUserId prioritizes yid, then userId, then string/numeric id', () => {
    expect(extractAuthCacheUserId({ yid: ' yid-1 ', userId: 'u-1', id: 99 })).toBe('yid-1');
    expect(extractAuthCacheUserId({ userId: 'u-2', id: 99 })).toBe('u-2');
    expect(extractAuthCacheUserId({ id: 'str-id' })).toBe('str-id');
    expect(extractAuthCacheUserId({ id: 42 })).toBe('42');
    expect(extractAuthCacheUserId({ id: Number.NaN })).toBeNull();
    expect(extractAuthCacheUserId(null)).toBeNull();
  });

  test('merges patches for the same account and isolates snapshots across accounts', () => {
    const kv = createMemoryKv();

    saveStartupAuthCachePatch(
      kv,
      'user-a',
      {
        subscriptionStatus: 'pro',
        mediaGenerationEntitled: true,
        quota: { remainingCredits: 500 },
      },
      () => 1_000,
    );

    saveStartupAuthCachePatch(
      kv,
      'user-a',
      {
        serverModels: [
          {
            modelId: 'deepseek-v4',
            modelName: 'DeepSeek V4',
            provider: 'deepseek',
            apiFormat: 'openai',
          },
        ],
      },
      () => 2_000,
    );

    const userACache = readStartupAuthCache(kv, 'user-a');
    expect(userACache).toEqual({
      version: 1,
      userId: 'user-a',
      savedAt: 2_000,
      subscriptionStatus: 'pro',
      mediaGenerationEntitled: true,
      quota: { remainingCredits: 500 },
      serverModels: [
        {
          modelId: 'deepseek-v4',
          modelName: 'DeepSeek V4',
          provider: 'deepseek',
          apiFormat: 'openai',
        },
      ],
    });

    // Different account must never read user-a's cached quota or models.
    expect(readStartupAuthCache(kv, 'user-b')).toBeNull();
    expect(readStartupAuthCache(kv, '')).toBeNull();

    // Saving for user-b replaces the snapshot cleanly without inheriting user-a fields.
    saveStartupAuthCachePatch(kv, 'user-b', { subscriptionStatus: 'free' }, () => 3_000);
    expect(readStartupAuthCache(kv, 'user-b')).toEqual({
      version: 1,
      userId: 'user-b',
      savedAt: 3_000,
      subscriptionStatus: 'free',
      mediaGenerationEntitled: undefined,
      quota: undefined,
      serverModels: undefined,
    });
    expect(readStartupAuthCache(kv, 'user-a')).toBeNull();

    clearStartupAuthCache(kv);
    expect(kv.data.has(StartupAuthCacheKey.Snapshot)).toBe(false);
    expect(readStartupAuthCache(kv, 'user-b')).toBeNull();
  });

  test('ignores corrupted or unknown-version cache entries', () => {
    const kv = createMemoryKv();
    kv.set(StartupAuthCacheKey.Snapshot, { version: 99, userId: 'user-a' });
    expect(readStartupAuthCache(kv, 'user-a')).toBeNull();
  });
});
