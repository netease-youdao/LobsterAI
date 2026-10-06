import { SkinPackKitId } from '../../shared/skin/kit';
import type { InstalledKit, MarketplaceKit } from '../types/kit';
import { kitService } from './kit';
import { resolveLocalizedText } from './skill';

interface SkinKitOnboardingService {
  fetchMarketplaceKits(): Promise<MarketplaceKit[]>;
  getInstalledKits(): Promise<Record<string, InstalledKit>>;
  installKit(kit: MarketplaceKit): Promise<{ success: boolean; error?: string }>;
}

export interface PreparedSkinKitOnboarding {
  installedKits: Record<string, InstalledKit>;
  kitId: string;
  marketplaceKits: MarketplaceKit[];
  prompt: string;
}

export async function prepareSkinKitOnboarding(
  service: SkinKitOnboardingService = kitService,
): Promise<PreparedSkinKitOnboarding> {
  const [marketplaceKits, currentInstalledKits] = await Promise.all([
    service.fetchMarketplaceKits(),
    service.getInstalledKits(),
  ]);
  const skinKit = marketplaceKits.find(kit => kit.id === SkinPackKitId.BuiltIn);
  if (!skinKit) {
    throw new Error('AI Skin Designer kit is unavailable');
  }

  const prompt = resolveLocalizedText(skinKit.tryAsking?.[0] ?? '').trim();
  if (!prompt) {
    throw new Error('AI Skin Designer kit has no starter prompt');
  }

  let installedKits = currentInstalledKits;
  if (!installedKits[skinKit.id]) {
    const installResult = await service.installKit(skinKit);
    if (!installResult.success) {
      throw new Error(installResult.error || 'AI Skin Designer kit installation failed');
    }

    installedKits = await service.getInstalledKits();
    if (!installedKits[skinKit.id]) {
      throw new Error('AI Skin Designer kit was not found after installation');
    }
  }

  return {
    installedKits,
    kitId: skinKit.id,
    marketplaceKits,
    prompt,
  };
}
