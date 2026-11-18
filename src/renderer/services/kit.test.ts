import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { KitStoreResponse } from '../../shared/kit/constants';
import type { MarketplaceKit } from '../types/kit';
import { kitService } from './kit';

const builtInKit: MarketplaceKit = { id: 'builtin', name: 'Built in', description: 'Available offline' };
const onlineKit: MarketplaceKit = { id: 'online', name: 'Online', description: 'From the catalog' };
const catalogData = (kits: MarketplaceKit[]) => JSON.stringify({ data: { value: { kits } } });
const onlineResponse: KitStoreResponse = { success: true, data: catalogData([onlineKit, builtInKit]) };
const offlineResponse: KitStoreResponse = {
  success: false,
  data: catalogData([builtInKit]),
  error: 'Request timeout',
};
const fetchStore = vi.fn<() => Promise<KitStoreResponse>>();

beforeEach(() => {
  kitService.clearCache();
  fetchStore.mockReset();
  vi.stubGlobal('window', { electron: { kits: { fetchStore } } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('marketplace kit recovery', () => {
  test('keeps built-in kits on failure and retries when the catalog is reopened', async () => {
    fetchStore.mockResolvedValueOnce(offlineResponse).mockResolvedValueOnce(onlineResponse);

    expect(await kitService.fetchMarketplaceCatalog()).toEqual({ kits: [builtInKit], error: 'Request timeout' });
    expect(await kitService.fetchMarketplaceCatalog()).toEqual({ kits: [onlineKit, builtInKit], error: null });
    expect(fetchStore).toHaveBeenCalledTimes(2);
  });

  test('retains the last online catalog during an outage without treating it as fresh', async () => {
    fetchStore.mockResolvedValueOnce(onlineResponse).mockResolvedValueOnce(offlineResponse)
      .mockResolvedValueOnce(onlineResponse);

    await kitService.fetchMarketplaceKits();
    expect(await kitService.fetchMarketplaceCatalog({ forceRefresh: true })).toEqual({
      kits: [onlineKit, builtInKit], error: 'Request timeout',
    });
    expect((await kitService.fetchMarketplaceCatalog()).error).toBeNull();
    expect(fetchStore).toHaveBeenCalledTimes(3);
  });

  test('expires successful caches and lets manual refresh bypass a fresh cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
    fetchStore.mockResolvedValue(onlineResponse);

    await kitService.fetchMarketplaceKits();
    await kitService.fetchMarketplaceKits();
    expect(fetchStore).toHaveBeenCalledTimes(1);
    await kitService.fetchMarketplaceCatalog({ forceRefresh: true });
    expect(fetchStore).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 60 * 1000);
    await kitService.fetchMarketplaceKits();
    expect(fetchStore).toHaveBeenCalledTimes(3);
  });

  test('retries once after a failing in-flight request when connectivity returns', async () => {
    let resolvePending!: (result: KitStoreResponse) => void;
    fetchStore.mockImplementationOnce(() => new Promise(resolve => { resolvePending = resolve; }))
      .mockResolvedValueOnce(onlineResponse);

    const initial = kitService.fetchMarketplaceCatalog();
    const reconnect = kitService.fetchMarketplaceCatalog({ forceRefresh: true });
    const overlappingRetry = kitService.fetchMarketplaceCatalog({ forceRefresh: true });
    resolvePending(offlineResponse);

    expect((await initial).error).toBe('Request timeout');
    expect((await reconnect).kits).toEqual([onlineKit, builtInKit]);
    expect((await overlappingRetry).error).toBeNull();
    expect(fetchStore).toHaveBeenCalledTimes(2);
  });

  test('shares a successful in-flight request with refresh callers', async () => {
    fetchStore.mockResolvedValue(onlineResponse);
    const results = await Promise.all([
      kitService.fetchMarketplaceCatalog(),
      kitService.fetchMarketplaceCatalog({ forceRefresh: true }),
    ]);
    expect(results.every(result => result.error === null)).toBe(true);
    expect(fetchStore).toHaveBeenCalledTimes(1);
  });

  test.each([
    { success: true, data: 'not JSON' },
    { success: true, data: JSON.stringify({ data: { value: {} } }) },
  ] as KitStoreResponse[])('does not cache a malformed response: %j', async response => {
    fetchStore.mockResolvedValueOnce(response).mockResolvedValueOnce(onlineResponse);
    expect((await kitService.fetchMarketplaceCatalog()).error).toBeTruthy();
    expect(await kitService.fetchMarketplaceKits()).toEqual([onlineKit, builtInKit]);
    expect(fetchStore).toHaveBeenCalledTimes(2);
  });

  test('preserves the previous catalog if the IPC request rejects', async () => {
    fetchStore.mockResolvedValueOnce(onlineResponse).mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValueOnce(onlineResponse);
    await kitService.fetchMarketplaceKits();
    expect(await kitService.fetchMarketplaceCatalog({ forceRefresh: true })).toEqual({
      kits: [onlineKit, builtInKit], error: 'IPC unavailable',
    });
    expect((await kitService.fetchMarketplaceCatalog()).error).toBeNull();
  });

  test('accepts a string-encoded Overmind value', async () => {
    fetchStore.mockResolvedValue({
      success: true,
      data: JSON.stringify({ data: { value: JSON.stringify({ kits: [onlineKit] }) } }),
    });
    expect(await kitService.fetchMarketplaceKits()).toEqual([onlineKit]);
  });
});
