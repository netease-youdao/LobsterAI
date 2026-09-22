import type { MarketplaceKit } from '../types/kit';
import type { MarketplaceSkill } from '../types/skill';
import { resolveLocalizedText } from './skill';

export const CapabilityKind = { All: 'all', Expert: 'expert', Plugin: 'plugin' } as const;
export type CapabilityKind = typeof CapabilityKind[keyof typeof CapabilityKind];
export const CatalogSort = { Recommended: 'recommended', Name: 'name', Downloads: 'downloads' } as const;
export type CatalogSort = typeof CatalogSort[keyof typeof CatalogSort];
export const CatalogLayout = { Grid: 'grid', List: 'list' } as const;
export type CatalogLayout = typeof CatalogLayout[keyof typeof CatalogLayout];
export const CATALOG_PAGE_SIZE = 40;

export function sortMarketplaceSkills(skills: MarketplaceSkill[], sort: CatalogSort): MarketplaceSkill[] {
  const result = [...skills];
  if (sort === CatalogSort.Name) result.sort((a, b) => resolveLocalizedText(a.displayName ?? a.name).localeCompare(resolveLocalizedText(b.displayName ?? b.name)));
  if (sort === CatalogSort.Downloads) result.sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0));
  return result;
}

export function getKitKind(kit: MarketplaceKit): Exclude<CapabilityKind, 'all'> {
  return kit.libraryKind === CapabilityKind.Plugin ? CapabilityKind.Plugin : CapabilityKind.Expert;
}

/** Accept the existing Overmind envelope and portable catalog exports. */
export function parseKitCatalog(input: unknown): MarketplaceKit[] {
  const value = input as { kits?: unknown; data?: { value?: { kits?: unknown } } } | null;
  const rows = value?.data?.value?.kits ?? value?.kits;
  if (!Array.isArray(rows)) throw new Error('Invalid kit catalog');
  const seen = new Set<string>();
  return rows.map((row: MarketplaceKit) => {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id)
      || !isLocalizedText(row.name) || !isLocalizedText(row.description)) throw new Error('Invalid kit metadata');
    seen.add(row.id);
    if (row.skills && (typeof row.skills.bundle !== 'string' || !Array.isArray(row.skills.list)
      || row.skills.list.some(skill => !skill || typeof skill.id !== 'string' || !isLocalizedText(skill.name)))) {
      throw new Error('Invalid kit skill bundle');
    }
    return {
      ...row,
      libraryKind: getKitKind(row),
      category: typeof row.category === 'string' ? row.category : undefined,
      setupNotice: typeof row.setupNotice === 'string' ? row.setupNotice : undefined,
      unavailable: row.unavailable === true || !row.skills?.bundle,
    };
  });
}

function isLocalizedText(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  const text = value as { en?: unknown; zh?: unknown };
  return typeof text.en === 'string' && typeof text.zh === 'string';
}
