import type { InstalledKit, MarketplaceKit } from '../types/kit';

const MARKETPLACE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface MarketplaceKitCatalog {
  kits: MarketplaceKit[];
  error: string | null;
}

function parseMarketplaceKits(data: string): MarketplaceKit[] {
  const parsed = JSON.parse(data);
  const rawValue = parsed?.data?.value;
  const value = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
  if (!Array.isArray(value?.kits)) {
    throw new Error('Unexpected kit store response structure');
  }
  return value.kits;
}

class KitService {
  private marketplaceCache: MarketplaceKit[] | null = null;
  private cacheExpiresAt = 0;
  private fetchPromise: Promise<MarketplaceKitCatalog> | null = null;

  async fetchMarketplaceKits(options: { forceRefresh?: boolean } = {}): Promise<MarketplaceKit[]> {
    return (await this.fetchMarketplaceCatalog(options)).kits;
  }

  async fetchMarketplaceCatalog(
    options: { forceRefresh?: boolean } = {},
  ): Promise<MarketplaceKitCatalog> {
    if (this.fetchPromise) {
      const result = await this.fetchPromise;
      // A reconnect can arrive while the old request is still timing out.
      // After that failure, share one new request with any other retry callers.
      return options.forceRefresh && result.error
        ? this.fetchMarketplaceCatalog()
        : result;
    }
    if (!options.forceRefresh && this.marketplaceCache && Date.now() < this.cacheExpiresAt) {
      return { kits: this.marketplaceCache, error: null };
    }
    const request = this.loadMarketplaceCatalog().finally(() => {
      this.fetchPromise = null;
    });
    this.fetchPromise = request;
    return request;
  }

  private unavailableCatalog(error: string, fallbackKits: MarketplaceKit[] = []): MarketplaceKitCatalog {
    this.cacheExpiresAt = 0;
    return {
      kits: Array.from(new Map(
        [...(this.marketplaceCache ?? []), ...fallbackKits].map(kit => [kit.id, kit]),
      ).values()),
      error,
    };
  }

  private async loadMarketplaceCatalog(): Promise<MarketplaceKitCatalog> {
    try {
      const result = await window.electron.kits.fetchStore();
      if (!result.success) {
        console.warn('[KitService] Failed to fetch kit store:', result.error);
        return this.unavailableCatalog(
          result.error,
          result.data ? parseMarketplaceKits(result.data) : [],
        );
      }
      const kits = parseMarketplaceKits(result.data);
      this.marketplaceCache = kits;
      this.cacheExpiresAt = Date.now() + MARKETPLACE_CACHE_TTL_MS;
      return { kits, error: null };
    } catch (error) {
      console.error('[KitService] Error loading marketplace kits:', error);
      return this.unavailableCatalog(error instanceof Error ? error.message : 'Failed to fetch kit store');
    }
  }

  async installKit(kit: MarketplaceKit): Promise<{ success: boolean; error?: string }> {
    if (!kit.skills?.bundle) {
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
    this.cacheExpiresAt = 0;
  }
}

export const kitService = new KitService();
