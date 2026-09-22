import type { InstalledKit, MarketplaceKit } from '../types/kit';
import { parseKitCatalog } from './capabilityCatalog';

class KitService {
  private marketplaceCache: MarketplaceKit[] | null = null;
  private fetchPromise: Promise<MarketplaceKit[]> | null = null;

  async fetchMarketplaceKits(): Promise<MarketplaceKit[]> {
    if (this.marketplaceCache) {
      return this.marketplaceCache;
    }
    if (this.fetchPromise) {
      return this.fetchPromise;
    }
    this.fetchPromise = this.loadMarketplaceKits();
    try { return await this.fetchPromise; }
    finally { this.fetchPromise = null; }
  }

  private async loadMarketplaceKits(): Promise<MarketplaceKit[]> {
    try {
      const result = await window.electron.kits.fetchStore();
      if (!result.success || !result.data) {
        console.warn('[KitService] Failed to fetch kit store:', result.error);
        return [];
      }

      const parsed = JSON.parse(result.data);
      const kits = parseKitCatalog(parsed);
      this.marketplaceCache = kits;
      return kits;
    } catch (error) {
      console.error('[KitService] Error loading marketplace kits:', error);
      return [];
    }
  }

  async installKit(kit: MarketplaceKit): Promise<{ success: boolean; error?: string }> {
    if (kit.unavailable || !kit.skills?.bundle) {
      return { success: false, error: 'Kit has no skill bundle URL' };
    }

    const result = await window.electron.kits.install({
      kitId: kit.id,
      bundleUrl: kit.skills.bundle,
      version: kit.version ?? '0.0.0',
      skillListIds: kit.skills.list.map(s => s.id),
      skillList: kit.skills.list,
      mcpServers: kit.mcpServers ?? null,
      connectors: kit.connectors ?? null,
    });

    return result;
  }

  async uninstallKit(kitId: string): Promise<{ success: boolean; error?: string }> {
    return window.electron.kits.uninstall(kitId);
  }

  async getInstalledKits(): Promise<Record<string, InstalledKit>> {
    const result = await window.electron.kits.listInstalled();
    if (!result.success || !result.installed) {
      return {};
    }
    return result.installed;
  }

  clearCache(): void {
    this.marketplaceCache = null;
  }
}

export const kitService = new KitService();
