import { describe, expect, test, vi } from 'vitest';

import { SkinPackKitId, SkinPackKitMetadata } from '../../shared/skin/kit';
import type { InstalledKit, MarketplaceKit } from '../types/kit';
import { prepareSkinKitOnboarding } from './skinKitOnboarding';

const skinKit: MarketplaceKit = {
  id: SkinPackKitId.BuiltIn,
  name: 'AI Skin Designer',
  description: 'Design a skin',
  tryAsking: ['Create a calm ocean skin'],
  skills: {
    bundle: 'builtin://ai-skin-designer',
    list: [],
  },
};

const installedSkinKit: InstalledKit = {
  id: SkinPackKitId.BuiltIn,
  version: SkinPackKitMetadata.Version,
  installedAt: 1,
  skills: { skillIds: ['skin-creator'] },
  mcpServers: [],
  connectors: [],
};

describe('prepareSkinKitOnboarding', () => {
  test('uses the first starter prompt without reinstalling an installed kit', async () => {
    const installKit = vi.fn();
    const result = await prepareSkinKitOnboarding({
      fetchMarketplaceKits: vi.fn().mockResolvedValue([skinKit]),
      getInstalledKits: vi.fn().mockResolvedValue({
        [SkinPackKitId.BuiltIn]: installedSkinKit,
      }),
      installKit,
    });

    expect(result).toEqual({
      installedKits: {
        [SkinPackKitId.BuiltIn]: installedSkinKit,
      },
      kitId: SkinPackKitId.BuiltIn,
      marketplaceKits: [skinKit],
      prompt: 'Create a calm ocean skin',
    });
    expect(installKit).not.toHaveBeenCalled();
  });

  test('installs the kit before returning the starter prompt', async () => {
    const getInstalledKits = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        [SkinPackKitId.BuiltIn]: installedSkinKit,
      });
    const installKit = vi.fn().mockResolvedValue({ success: true });

    const result = await prepareSkinKitOnboarding({
      fetchMarketplaceKits: vi.fn().mockResolvedValue([skinKit]),
      getInstalledKits,
      installKit,
    });

    expect(installKit).toHaveBeenCalledWith(skinKit);
    expect(getInstalledKits).toHaveBeenCalledTimes(2);
    expect(result.installedKits[SkinPackKitId.BuiltIn]).toEqual(installedSkinKit);
  });

  test('stops when kit installation fails', async () => {
    await expect(prepareSkinKitOnboarding({
      fetchMarketplaceKits: vi.fn().mockResolvedValue([skinKit]),
      getInstalledKits: vi.fn().mockResolvedValue({}),
      installKit: vi.fn().mockResolvedValue({
        success: false,
        error: 'install failed',
      }),
    })).rejects.toThrow('install failed');
  });

  test('stops when the built-in kit has no starter prompt', async () => {
    await expect(prepareSkinKitOnboarding({
      fetchMarketplaceKits: vi.fn().mockResolvedValue([{
        ...skinKit,
        tryAsking: [],
      }]),
      getInstalledKits: vi.fn().mockResolvedValue({}),
      installKit: vi.fn(),
    })).rejects.toThrow('starter prompt');
  });
});
