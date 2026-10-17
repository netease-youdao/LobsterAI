export const CompanionCustomSkin = {
  IdPrefix: 'custom-',
  Directory: 'desktop-companion-skins',
  MinDimension: 128,
  MaxDimension: 2048,
  OutputDimension: 512,
  MaxSourceBytes: 5 * 1024 * 1024,
  MaxSavedBytes: 2 * 1024 * 1024,
  MaxNameLength: 40,
} as const;

export interface CompanionCustomSkinAsset {
  id: string;
  name?: string;
  /** Canonical, decoded and re-encoded PNG from the local skin store. */
  dataUrl: string;
}

export interface CompanionCustomSkinEntry { id: string; name?: string }

export function normalizeCompanionSkinName(value: unknown): string {
  return typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, CompanionCustomSkin.MaxNameLength).join('') : '';
}

export function normalizeCompanionSkinEntries(value: unknown): CompanionCustomSkinEntry[] {
  const entries = new Map<string, CompanionCustomSkinEntry>();
  if (Array.isArray(value)) for (const item of value) {
    if (item && isCustomCompanionSkin(item.id)) entries.set(item.id, { id: item.id, ...(normalizeCompanionSkinName(item.name) ? { name: normalizeCompanionSkinName(item.name) } : {}) });
  }
  return [...entries.values()];
}

export function isCustomCompanionSkin(id: unknown): id is string {
  return typeof id === 'string' && /^custom-[a-f0-9]{64}$/.test(id);
}

export function isCompanionSourceSizeAllowed(width: number, height: number): boolean {
  return [width, height].every(value => Number.isInteger(value)
    && value >= CompanionCustomSkin.MinDimension && value <= CompanionCustomSkin.MaxDimension);
}

/** Fit the complete silhouette at default zoom; never impose a circular mask. */
export function companionFitRect(width: number, height: number, zoom: number, x: number, y: number) {
  const scale = CompanionCustomSkin.OutputDimension / Math.max(width, height) * Math.max(0.5, Math.min(3, zoom));
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  return {
    x: (CompanionCustomSkin.OutputDimension - fittedWidth) * Math.max(0, Math.min(1, x)),
    y: (CompanionCustomSkin.OutputDimension - fittedHeight) * Math.max(0, Math.min(1, y)),
    width: fittedWidth,
    height: fittedHeight,
  };
}
