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
  /** Canonical PNG or validated original GIF from the local skin store. */
  dataUrl: string;
}

export const CompanionSkinImageFormat = {
  Png: 'png',
  Gif: 'gif',
} as const;

export function isCompanionGif(dataUrl: string | undefined): boolean {
  return dataUrl?.startsWith('data:image/gif;base64,') === true;
}

/** Validate every block before handing the bounded file to a browser/native decoder. */
export function validateCompanionGif(bytes: Uint8Array): { width: number; height: number; frames: number } {
  const invalid = () => { throw new Error('Invalid companion GIF.'); };
  if (bytes.length < 14 || bytes.length > CompanionCustomSkin.MaxSavedBytes) invalid();
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') invalid();
  const word = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
  const width = word(6); const height = word(8);
  if (!isCompanionSourceSizeAllowed(width, height)) invalid();
  let offset = 13;
  let frames = 0;
  const skip = (length: number) => { offset += length; if (offset > bytes.length) invalid(); };
  const blocks = () => {
    let length = 0;
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (!size) return length;
      length += size; skip(size);
    }
    return invalid();
  };
  if (bytes[10] & 0x80) skip(3 * (1 << ((bytes[10] & 7) + 1)));
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (!frames || offset !== bytes.length) invalid();
      return { width, height, frames };
    }
    if (marker === 0x21) { skip(1); blocks(); continue; }
    if (marker !== 0x2c || offset + 9 > bytes.length) invalid();
    const left = word(offset); const top = word(offset + 2);
    const frameWidth = word(offset + 4); const frameHeight = word(offset + 6);
    const packed = bytes[offset + 8];
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) invalid();
    skip(9);
    if (packed & 0x80) skip(3 * (1 << ((packed & 7) + 1)));
    const codeSize = bytes[offset++];
    if (codeSize < 2 || codeSize > 8 || !blocks()) invalid();
    frames++;
  }
  return invalid();
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
