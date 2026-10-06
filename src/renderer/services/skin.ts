import {
  SkinAssetSlot,
  type SkinAssetSlot as SkinAssetSlotValue,
  SkinProtocol,
} from '../../shared/skin/constants';
import {
  parseSkinPresentation,
  type SkinPresentation,
} from '../../shared/skin/presentation';

export interface SkinAssetReference {
  url: string;
  cacheKey?: string;
}

export interface ActiveSkin {
  id: string;
  name?: string;
  baseThemeId?: string;
  boundThemeId?: string;
  presentation?: SkinPresentation;
  assets: Partial<Record<SkinAssetSlotValue, SkinAssetReference>>;
}

type RendererSkinApi = Window['electron']['skin'];

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readString = (record: UnknownRecord | null, keys: readonly string[]): string | undefined => {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

const isManagedSkinAssetUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === `${SkinProtocol.Scheme}:` && url.hostname === SkinProtocol.Host;
  } catch {
    return false;
  }
};

const unwrapActiveSkin = (value: unknown): unknown => {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(candidate)) return candidate;
    if (candidate.success === false) return null;

    const nested = candidate.activeSkin ?? candidate.skin ?? candidate.data;
    if (nested === undefined || nested === candidate) return candidate;
    candidate = nested;
  }
  return candidate;
};

const readAssetReference = (value: unknown): SkinAssetReference | undefined => {
  if (typeof value === 'string' && value.trim()) {
    const url = value.trim();
    return isManagedSkinAssetUrl(url) ? { url } : undefined;
  }
  if (!isRecord(value)) return undefined;

  const url = readString(value, ['url', 'displayUrl', 'fileUrl', 'src']);
  if (!url || !isManagedSkinAssetUrl(url)) return undefined;

  return {
    url,
    cacheKey: readString(value, ['cacheKey', 'hash', 'sha256', 'version', 'updatedAt']),
  };
};

const readAssetFromSource = (source: unknown, slot: SkinAssetSlotValue): SkinAssetReference | undefined => {
  if (isRecord(source)) {
    return readAssetReference(source[slot]);
  }
  if (!Array.isArray(source)) return undefined;

  const matchingAsset = source.find((asset) => {
    if (!isRecord(asset)) return false;
    return readString(asset, ['slot', 'id', 'key']) === slot;
  });
  return readAssetReference(matchingAsset);
};

/**
 * Keep the renderer boundary deliberately narrow: only the two managed image
 * slots and the validated presentation schema are retained. Arbitrary CSS or
 * other manifest fields never reach the view layer.
 */
export const normalizeActiveSkin = (value: unknown): ActiveSkin | null => {
  const candidate = unwrapActiveSkin(value);
  if (!isRecord(candidate)) return null;

  const manifest = isRecord(candidate.manifest) ? candidate.manifest : null;
  const assetSources = [candidate.assetUrls, candidate.assets, manifest?.assets];
  const workspaceBackdrop = assetSources
    .map(source => readAssetFromSource(source, SkinAssetSlot.WorkspaceBackdrop))
    .find((asset): asset is SkinAssetReference => Boolean(asset));
  const homeEmblem = assetSources
    .map(source => readAssetFromSource(source, SkinAssetSlot.HomeEmblem))
    .find((asset): asset is SkinAssetReference => Boolean(asset));

  if (!workspaceBackdrop && !homeEmblem) return null;

  const id = readString(candidate, ['id', 'skinId'])
    ?? readString(manifest, ['id', 'skinId'])
    ?? 'active-skin';
  const presentation = parseSkinPresentation(candidate.presentation)
    ?? parseSkinPresentation(manifest?.presentation);

  return {
    id,
    name: readString(candidate, ['name', 'title']) ?? readString(manifest, ['name', 'title']),
    baseThemeId: readString(candidate, ['baseThemeId']) ?? readString(manifest, ['baseThemeId']),
    boundThemeId: readString(candidate, ['boundThemeId'])
      ?? readString(manifest, ['boundThemeId']),
    ...(presentation ? { presentation } : {}),
    assets: {
      ...(workspaceBackdrop ? { [SkinAssetSlot.WorkspaceBackdrop]: workspaceBackdrop } : {}),
      ...(homeEmblem ? { [SkinAssetSlot.HomeEmblem]: homeEmblem } : {}),
    },
  };
};

export const normalizeSkinList = (value: unknown): ActiveSkin[] => {
  let candidates: unknown[] = [];
  if (Array.isArray(value)) {
    candidates = value;
  } else if (isRecord(value) && Array.isArray(value.skins)) {
    candidates = value.skins;
  } else if (isRecord(value) && isRecord(value.data) && Array.isArray(value.data.skins)) {
    candidates = value.data.skins;
  }

  return candidates
    .map(normalizeActiveSkin)
    .filter((skin): skin is ActiveSkin => skin !== null);
};

export const buildSkinAssetUrl = (
  asset: SkinAssetReference | undefined,
  refreshVersion: number,
): string | null => {
  if (!asset?.url) return null;
  if (/^(?:data|blob):/i.test(asset.url)) return asset.url;
  if (asset.url.toLowerCase().startsWith(`${SkinProtocol.Scheme.toLowerCase()}:`)) return asset.url;

  const cacheKey = asset.cacheKey ?? String(refreshVersion);
  const hashIndex = asset.url.indexOf('#');
  const baseUrl = hashIndex >= 0 ? asset.url.slice(0, hashIndex) : asset.url;
  const fragment = hashIndex >= 0 ? asset.url.slice(hashIndex) : '';
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}skin_v=${encodeURIComponent(cacheKey)}${fragment}`;
};

const getRendererSkinApi = (): RendererSkinApi | null => {
  if (typeof window === 'undefined') return null;
  return window.electron?.skin ?? null;
};

class SkinService {
  async getActive(): Promise<ActiveSkin | null> {
    const api = getRendererSkinApi();
    if (!api) return null;
    const result = await api.getActive();
    if (isRecord(result) && result.success === false) {
      throw new Error(readString(result, ['error', 'message']) ?? 'Failed to load active skin');
    }
    return normalizeActiveSkin(result);
  }

  async list(): Promise<ActiveSkin[]> {
    const api = getRendererSkinApi();
    if (!api) return [];
    const result = await api.list();
    if (isRecord(result) && result.success === false) {
      throw new Error(readString(result, ['error', 'message']) ?? 'Failed to list skins');
    }
    return normalizeSkinList(result);
  }

  async apply(skinId: string, boundThemeId?: string): Promise<ActiveSkin | null> {
    const api = getRendererSkinApi();
    if (!api) return null;
    const result = await api.apply(skinId, boundThemeId);
    if (isRecord(result) && result.success === false) {
      throw new Error(readString(result, ['error', 'message']) ?? 'Failed to apply skin');
    }
    return normalizeActiveSkin(result);
  }

  async bindTheme(skinId: string, themeId: string): Promise<ActiveSkin | null> {
    const api = getRendererSkinApi();
    if (!api) return null;
    const result = await api.bindTheme(skinId, themeId);
    if (isRecord(result) && result.success === false) {
      throw new Error(readString(result, ['error', 'message']) ?? 'Failed to bind skin theme');
    }
    return normalizeActiveSkin(result);
  }

  async deactivate(): Promise<void> {
    const api = getRendererSkinApi();
    if (!api) return;
    const result = await api.deactivate();
    if (isRecord(result) && result.success === false) {
      throw new Error(readString(result, ['error', 'message']) ?? 'Failed to deactivate skin');
    }
  }

  async delete(skinId: string): Promise<void> {
    const api = getRendererSkinApi();
    if (!api) return;
    const result = await api.delete(skinId);
    if (isRecord(result) && result.success === false) {
      throw new Error(readString(result, ['error', 'message']) ?? 'Failed to delete skin');
    }
  }

  subscribe(listener: () => void): () => void {
    const unsubscribe = getRendererSkinApi()?.onChanged?.(listener);
    return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
  }
}

export const skinService = new SkinService();
