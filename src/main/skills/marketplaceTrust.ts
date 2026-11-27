import { isHostnameOnDomain } from '../../shared/url/hostname';

export interface TrustedMarketplaceEntry {
  id: string;
  url: string;
  version?: string;
  sha256?: string;
}

export interface MarketplaceDownloadTrust {
  trusted: boolean;
  entry?: TrustedMarketplaceEntry;
  expectedSha256?: string;
}

const TRUSTED_OFFICIAL_MARKETPLACE_DOMAINS: readonly string[] = [
  'nosdn.127.net',
  'youdao.com',
  '126.net',
  '127.net',
];

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

/**
 * Verify that a marketplace download URL points to an immutable `.zip` archive
 * hosted over HTTPS on an official Youdao / NetEase CDN domain.
 */
export function isTrustedOfficialMarketplaceUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    if (!parsed.pathname.toLowerCase().endsWith('.zip')) return false;
    const host = parsed.hostname.toLowerCase();
    return TRUSTED_OFFICIAL_MARKETPLACE_DOMAINS.some(domain => isHostnameOnDomain(host, domain));
  } catch {
    return false;
  }
}

export function normalizeSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return SHA256_HEX_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * Parse Overmind `skill-store` JSON into authoritative marketplace entries.
 */
export function parseMarketplaceCatalogEntries(rawJson: string): TrustedMarketplaceEntry[] {
  try {
    const parsed = JSON.parse(rawJson) as { data?: { value?: unknown } };
    const rawValue = parsed?.data?.value;
    if (!rawValue) return [];
    const value = typeof rawValue === 'string'
      ? JSON.parse(rawValue) as { marketplace?: unknown }
      : rawValue as { marketplace?: unknown };
    if (!Array.isArray(value?.marketplace)) return [];

    const entries: TrustedMarketplaceEntry[] = [];
    for (const item of value.marketplace) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const url = typeof record.url === 'string' ? record.url.trim() : '';
      if (!id || !url) continue;
      const version = typeof record.version === 'string' && record.version.trim()
        ? record.version.trim()
        : undefined;
      const sha256 = normalizeSha256(record.sha256);
      entries.push({
        id,
        url,
        ...(version ? { version } : {}),
        ...(sha256 ? { sha256 } : {}),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Main-process authoritative cache of official Overmind marketplace entries.
 * Only downloads matching an official catalog entry hosted on an official CDN
 * (or locked by an explicit `sha256` digest) may bypass client-side static scan.
 */
export class MarketplaceTrustRegistry {
  private entriesByUrl = new Map<string, TrustedMarketplaceEntry[]>();
  private loaded = false;

  isLoaded(): boolean {
    return this.loaded;
  }

  updateFromRawResponse(rawJson: string): void {
    const entries = parseMarketplaceCatalogEntries(rawJson);
    const nextMap = new Map<string, TrustedMarketplaceEntry[]>();
    for (const entry of entries) {
      const list = nextMap.get(entry.url) ?? [];
      list.push(entry);
      nextMap.set(entry.url, list);
    }
    this.entriesByUrl = nextMap;
    this.loaded = true;
  }

  clear(): void {
    this.entriesByUrl.clear();
    this.loaded = false;
  }

  resolveTrustedDownload(source: string, expectedSkillId?: string): MarketplaceDownloadTrust {
    const trimmed = source.trim();
    if (!trimmed) return { trusted: false };

    const candidates = this.entriesByUrl.get(trimmed);
    if (!candidates || candidates.length === 0) {
      return { trusted: false };
    }

    const match = expectedSkillId
      ? candidates.find(entry => entry.id === expectedSkillId)
      : candidates[0];
    if (!match) {
      return { trusted: false };
    }

    if (match.sha256) {
      return {
        trusted: true,
        entry: match,
        expectedSha256: match.sha256,
      };
    }

    if (isTrustedOfficialMarketplaceUrl(match.url)) {
      return {
        trusted: true,
        entry: match,
      };
    }

    return { trusted: false, entry: match };
  }
}
