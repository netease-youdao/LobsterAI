import crypto from 'crypto';
import { pathToFileURL } from 'url';

/**
 * Generated media arrives from the server as `data:` URLs of several megabytes. Once the bytes
 * are written to disk the URL is dead weight, yet media details are copied into tool_use,
 * tool_result and delivery messages and re-written on every status poll. Stored copies keep a
 * reference instead: the saved file's URL, or a content hash where the inline URL served as an
 * identity key.
 */
export const INLINE_MEDIA_SOURCE_KEY_PREFIX = 'inline:sha256:';

const INLINE_DATA_URL_PATTERN = /^\s*data:/i;
const MEDIA_DETAILS_TYPES = new Set(['image', 'video']);
/** Message metadata fields that hold media task details. */
export const MEDIA_DETAILS_FIELDS = ['toolResultDetails', 'mediaStatusDetails'] as const;

type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isInlineDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && INLINE_DATA_URL_PATTERN.test(value);

/** Stable identity for a generated media source; inline payloads are reduced to their hash. */
export function mediaSourceKey(url: string): string {
  const trimmed = url.trim();
  if (!isInlineDataUrl(trimmed)) return trimmed;
  return `${INLINE_MEDIA_SOURCE_KEY_PREFIX}${crypto.createHash('sha256').update(trimmed).digest('hex')}`;
}

export const mediaAssetFilePath = (asset: UnknownRecord): string => {
  for (const value of [asset.filePath, asset.localPath]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

/**
 * Replaces inline URLs of an asset that has been saved to disk. Assets without a file keep their
 * URL: it is the only copy of the image left to display.
 */
export function compactPersistedMediaAsset<T>(asset: T): T {
  if (!isRecord(asset)) return asset;
  const filePath = mediaAssetFilePath(asset);
  if (!filePath) return asset;
  const inlineUrl = isInlineDataUrl(asset.url);
  const inlineOriginalUrl = isInlineDataUrl(asset.originalUrl);
  if (!inlineUrl && !inlineOriginalUrl) return asset;
  return {
    ...asset,
    ...(inlineUrl ? { url: pathToFileURL(filePath).href } : {}),
    ...(inlineOriginalUrl ? { originalUrl: mediaSourceKey(asset.originalUrl as string) } : {}),
  } as T;
}

const replaceInlineDataUrls = (value: unknown): unknown => {
  if (isInlineDataUrl(value)) return mediaSourceKey(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const replaced = replaceInlineDataUrls(item);
      if (replaced !== item) changed = true;
      return replaced;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;
  let next: UnknownRecord | undefined;
  for (const [key, item] of Object.entries(value)) {
    const replaced = replaceInlineDataUrls(item);
    if (replaced === item) continue;
    next ??= { ...value };
    next[key] = replaced;
  }
  return next ?? value;
};

const isMediaDetails = (details: UnknownRecord): boolean =>
  (typeof details.mediaType === 'string' && MEDIA_DETAILS_TYPES.has(details.mediaType))
  || Array.isArray(details.assets)
  || Array.isArray(details.resultUrls);

/**
 * Compacts the details of a media generation task for storage and IPC. Saved assets point at their
 * files; `resultUrls` entries point at the matching saved file, or at the source hash when nothing
 * was saved. Details of other tools are returned unchanged.
 */
export function compactMediaDetails<T>(details: T): T {
  if (!isRecord(details) || !isMediaDetails(details)) return details;

  let changed = false;
  const compacted: UnknownRecord = { ...details };
  const originalAssets = Array.isArray(details.assets) ? details.assets : undefined;

  if (originalAssets) {
    const assets = originalAssets.map(compactPersistedMediaAsset);
    if (assets.some((asset, index) => asset !== originalAssets[index])) {
      compacted.assets = assets;
      changed = true;
    }
  }

  if (Array.isArray(details.resultUrls) && details.resultUrls.some(isInlineDataUrl)) {
    const fileUrlBySourceKey = new Map<string, string>();
    for (const asset of originalAssets ?? []) {
      if (!isRecord(asset)) continue;
      const filePath = mediaAssetFilePath(asset);
      if (!filePath) continue;
      for (const source of [asset.originalUrl, asset.url]) {
        if (typeof source === 'string' && source.trim()) {
          fileUrlBySourceKey.set(mediaSourceKey(source), pathToFileURL(filePath).href);
        }
      }
    }
    compacted.resultUrls = details.resultUrls.map((url) => {
      if (!isInlineDataUrl(url)) return url;
      const key = mediaSourceKey(url);
      return fileUrlBySourceKey.get(key) ?? key;
    });
    changed = true;
  }

  // Server task objects are spread into poll details; no other field needs inline bytes.
  for (const [key, value] of Object.entries(details)) {
    if (key === 'assets' || key === 'resultUrls') continue;
    const replaced = replaceInlineDataUrls(value);
    if (replaced === value) continue;
    compacted[key] = replaced;
    changed = true;
  }

  return (changed ? compacted : details) as T;
}

/** Applies {@link compactMediaDetails} to the media details a cowork message may carry. */
export function compactMessageMetadataMedia<T>(metadata: T): T {
  if (!isRecord(metadata)) return metadata;
  let next: UnknownRecord | undefined;
  for (const field of MEDIA_DETAILS_FIELDS) {
    const details = metadata[field];
    const compacted = compactMediaDetails(details);
    if (compacted === details) continue;
    next ??= { ...metadata };
    next[field] = compacted;
  }
  return (next ?? metadata) as T;
}
