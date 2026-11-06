import { describe, expect, test, vi } from 'vitest';

import { setInstalledKits, setMarketplaceKits } from '../../store/slices/kitSlice';
import type { InstalledKit, MarketplaceKit } from '../../types/kit';
import { loadKitDetailCatalog } from './useKitDetailCatalog';

const hrKit: MarketplaceKit = { id: 'human-resources', name: '人力资源', description: 'HR workflows' };
const installedHrKit: InstalledKit = {
  id: 'human-resources',
  version: '1.0.0',
  installedAt: 1,
  skills: null,
  mcpServers: [],
  connectors: [],
};

describe('loadKitDetailCatalog', () => {
  test('stores the kit store and installed kits, and reports the kit as found', async () => {
    const dispatch = vi.fn();
    const found = await loadKitDetailCatalog('human-resources', dispatch, {
      fetchMarketplaceKits: async () => [hrKit],
      getInstalledKits: async () => ({ 'human-resources': installedHrKit }),
    });

    expect(found).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(setMarketplaceKits([hrKit]));
    expect(dispatch).toHaveBeenCalledWith(setInstalledKits({ 'human-resources': installedHrKit }));
  });

  test('keeps loaded data when the store is unavailable', async () => {
    const dispatch = vi.fn();
    const found = await loadKitDetailCatalog('human-resources', dispatch, {
      fetchMarketplaceKits: async () => [],
      getInstalledKits: async () => ({}),
    });

    expect(found).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('reports a kit that left the store as not found', async () => {
    const dispatch = vi.fn();
    const found = await loadKitDetailCatalog('retired-kit', dispatch, {
      fetchMarketplaceKits: async () => [hrKit],
      getInstalledKits: async () => ({}),
    });

    expect(found).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
