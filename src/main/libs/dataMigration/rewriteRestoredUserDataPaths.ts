import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { APP_NAME } from '../../appConstants';

export const REWRITABLE_USER_DATA_SUBDIRS = [
  'cowork-image-originals',
  'generated-images',
  'generated-videos',
  'workspaces',
  'SKILLs',
  'image-editing',
] as const;

const CANONICAL_SUBDIR_BY_LOWER = new Map<string, string>(
  REWRITABLE_USER_DATA_SUBDIRS.map(dir => [dir.toLowerCase(), dir]),
);

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_PREFIX_RE = /^\/([A-Za-z]:\/)/;
const FILE_URL_RE = /^file:\/\//i;

const ATTACHMENT_OBJECT_PATH_KEYS = [
  'retainedOriginalPath',
  'localPath',
  'filePath',
  'path',
] as const;

const MEDIA_ASSET_PATH_KEYS = [
  'filePath',
  'localPath',
  'path',
  'url',
  'originalUrl',
] as const;

const MEDIA_DETAIL_CONTAINER_KEYS = [
  'toolResultDetails',
  'mediaStatusDetails',
] as const;

const ATTACHMENT_ARRAY_KEYS = [
  'imageAttachments',
  'imageAttachmentPreviews',
  'historyImageReferences',
  'localMediaAttachments',
  'attachments',
] as const;

export interface RewriteUserDataPathOptions {
  /** Absolute `userData` path recorded in the source backup manifest, when available. */
  sourceUserDataPath?: string;
  /** Target `userData` directory receiving the restored backup. */
  targetUserDataPath: string;
  /**
   * Optional predicate verifying `<subdir>/<rest>` exists in the restored backup
   * when `sourceUserDataPath` is absent (e.g. legacy v1 archives).
   */
  existsInTarget?: (relativePosixPath: string) => boolean;
  /** Optional path-style override for cross-platform unit tests. */
  targetPathStyle?: 'posix' | 'win32';
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isAbsoluteAnyPlatform = (value: string): boolean =>
  value.startsWith('/') || WINDOWS_DRIVE_RE.test(value);

const normalizeRootPosix = (rawPath: string): { normalized: string; isWin: boolean } => {
  const isWin = WINDOWS_DRIVE_RE.test(rawPath);
  let normalized = rawPath.replace(/\\/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    if (isWin && normalized.length === 3 && normalized[1] === ':') {
      break;
    }
    normalized = normalized.slice(0, -1);
  }
  return { normalized, isWin };
};

const areSameRoots = (
  left: { normalized: string; isWin: boolean },
  right: { normalized: string; isWin: boolean },
): boolean => {
  if (left.isWin || right.isWin) {
    return left.normalized.toLowerCase() === right.normalized.toLowerCase();
  }
  return left.normalized === right.normalized;
};

const stripStrictRootPrefix = (
  candidateNorm: string,
  root: { normalized: string; isWin: boolean },
): string | null => {
  const prefix = root.normalized.endsWith('/') ? root.normalized : `${root.normalized}/`;
  const matches = root.isWin
    ? candidateNorm.toLowerCase().startsWith(prefix.toLowerCase())
    : candidateNorm.startsWith(prefix);
  if (!matches) return null;
  return candidateNorm.slice(prefix.length);
};

const validateRelativeSegments = (segments: readonly string[]): string[] | null => {
  if (segments.length === 0) return null;
  const validated: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('\0')) {
      return null;
    }
    validated.push(segment);
  }
  return validated;
};

const resolvePathStyle = (
  targetUserDataPath: string,
  override?: 'posix' | 'win32',
): 'posix' | 'win32' => {
  if (override) return override;
  if (WINDOWS_DRIVE_RE.test(targetUserDataPath)) return 'win32';
  return process.platform === 'win32' ? 'win32' : 'posix';
};

const joinTargetPath = (
  targetUserDataPath: string,
  segments: readonly string[],
  targetPathStyle?: 'posix' | 'win32',
): string => {
  const style = resolvePathStyle(targetUserDataPath, targetPathStyle);
  return style === 'win32'
    ? path.win32.join(targetUserDataPath, ...segments)
    : path.posix.join(targetUserDataPath.replace(/\\/g, '/'), ...segments);
};

const decodeLocalFileUrl = (urlString: string): string | null => {
  if (!FILE_URL_RE.test(urlString)) return null;
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'file:') return null;
    if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') return null;
    const decoded = decodeURIComponent(parsed.pathname);
    return WINDOWS_DRIVE_PREFIX_RE.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
};

const encodeLocalFileUrl = (
  targetFilePath: string,
  targetPathStyle?: 'posix' | 'win32',
): string => {
  const style = resolvePathStyle(targetFilePath, targetPathStyle);
  const posixPath = targetFilePath.replace(/\\/g, '/');
  if (style === 'win32' && WINDOWS_DRIVE_RE.test(targetFilePath)) {
    const [drive, ...rest] = posixPath.split('/');
    return `file:///${drive}/${rest.map(encodeURIComponent).join('/')}`;
  }
  const normalized = posixPath.startsWith('/') ? posixPath : `/${posixPath}`;
  const encoded = normalized
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `file://${encoded}`;
};

const rewritePlainAbsolutePath = (
  value: string,
  options: RewriteUserDataPathOptions,
): string => {
  if (!isAbsoluteAnyPlatform(value)) return value;

  const targetRoot = normalizeRootPosix(options.targetUserDataPath);
  const candidateNorm = value.replace(/\\/g, '/');

  // Strategy 1: exact sourceUserDataPath recorded in manifest v2.
  if (options.sourceUserDataPath && options.sourceUserDataPath.trim()) {
    const sourceRoot = normalizeRootPosix(options.sourceUserDataPath.trim());
    if (areSameRoots(sourceRoot, targetRoot)) return value;

    const relativeTail = stripStrictRootPrefix(candidateNorm, sourceRoot);
    if (relativeTail === null) return value;

    const segments = validateRelativeSegments(relativeTail.split('/'));
    if (!segments || segments.length < 2) return value;

    const canonicalSubdir = CANONICAL_SUBDIR_BY_LOWER.get(segments[0].toLowerCase());
    if (!canonicalSubdir) return value;

    return joinTargetPath(
      options.targetUserDataPath,
      [canonicalSubdir, ...segments.slice(1)],
      options.targetPathStyle,
    );
  }

  // Strategy 2: legacy manifest without sourceUserDataPath — only rewrite managed
  // userData subdirs strictly proven to belong to the restored userData directory.
  if (stripStrictRootPrefix(candidateNorm, targetRoot) !== null) {
    return value;
  }

  const parts = candidateNorm.split('/').filter(Boolean);
  // Require at least `<root>/<subdir>/<child>` (3 non-empty segments).
  for (let index = parts.length - 2; index >= 1; index -= 1) {
    const canonicalSubdir = CANONICAL_SUBDIR_BY_LOWER.get(parts[index].toLowerCase());
    if (!canonicalSubdir) continue;

    const restSegments = validateRelativeSegments(parts.slice(index + 1));
    if (!restSegments) continue;

    const relPosix = [canonicalSubdir, ...restSegments].join('/');
    if (options.existsInTarget) {
      if (!options.existsInTarget(relPosix)) continue;
    } else if (parts[index - 1].toLowerCase() !== APP_NAME.toLowerCase()) {
      continue;
    }

    return joinTargetPath(
      options.targetUserDataPath,
      [canonicalSubdir, ...restSegments],
      options.targetPathStyle,
    );
  }

  return value;
};

/**
 * Pure helper rewriting a single stale `userData`-rooted path (or `file://` URL)
 * to `options.targetUserDataPath` while leaving unrelated paths (e.g. user project
 * `cwd` files, `https://`, `data:`) untouched.
 */
export const rewriteUserDataPathString = (
  value: string,
  options: RewriteUserDataPathOptions,
): string => {
  if (!value || !value.trim()) return value;

  if (FILE_URL_RE.test(value)) {
    const decoded = decodeLocalFileUrl(value);
    if (!decoded) return value;
    const rewritten = rewritePlainAbsolutePath(decoded, options);
    if (rewritten === decoded) return value;
    return encodeLocalFileUrl(rewritten, options.targetPathStyle);
  }

  return rewritePlainAbsolutePath(value, options);
};

const rewriteRecordPathKeys = (
  record: UnknownRecord,
  keys: readonly string[],
  options: RewriteUserDataPathOptions,
): { record: UnknownRecord; changed: boolean } => {
  let next: UnknownRecord | null = null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const rewritten = rewriteUserDataPathString(value, options);
    if (rewritten === value) continue;
    next ??= { ...record };
    next[key] = rewritten;
  }
  return next ? { record: next, changed: true } : { record, changed: false };
};

const rewriteMediaDetailContainer = (
  details: UnknownRecord,
  options: RewriteUserDataPathOptions,
): { details: UnknownRecord; changed: boolean } => {
  let next: UnknownRecord | null = null;

  if (Array.isArray(details.assets)) {
    let assetsChanged = false;
    const nextAssets = details.assets.map(asset => {
      if (!isRecord(asset)) return asset;
      const result = rewriteRecordPathKeys(asset, MEDIA_ASSET_PATH_KEYS, options);
      if (result.changed) assetsChanged = true;
      return result.record;
    });
    if (assetsChanged) {
      next ??= { ...details };
      next.assets = nextAssets;
    }
  }

  if (Array.isArray(details.resultUrls)) {
    let urlsChanged = false;
    const nextUrls = details.resultUrls.map(url => {
      if (typeof url !== 'string') return url;
      const rewritten = rewriteUserDataPathString(url, options);
      if (rewritten !== url) urlsChanged = true;
      return rewritten;
    });
    if (urlsChanged) {
      next ??= { ...details };
      next.resultUrls = nextUrls;
    }
  }

  return next ? { details: next, changed: true } : { details, changed: false };
};

/**
 * Pure helper that rewrites stale `userData`-rooted media/attachment paths inside
 * a parsed `cowork_messages.metadata` object without mutating the input.
 */
export const rewriteUserDataPathsInMetadata = (
  metadata: UnknownRecord,
  options: RewriteUserDataPathOptions,
): { metadata: UnknownRecord; changed: boolean } => {
  let next: UnknownRecord | null = null;

  if (typeof metadata.retainedOriginalPath === 'string') {
    const rewritten = rewriteUserDataPathString(metadata.retainedOriginalPath, options);
    if (rewritten !== metadata.retainedOriginalPath) {
      next ??= { ...metadata };
      next.retainedOriginalPath = rewritten;
    }
  }

  for (const arrayKey of ATTACHMENT_ARRAY_KEYS) {
    const items = metadata[arrayKey];
    if (!Array.isArray(items)) continue;
    let arrayChanged = false;
    const nextItems = items.map(item => {
      if (typeof item === 'string') {
        const rewritten = rewriteUserDataPathString(item, options);
        if (rewritten !== item) arrayChanged = true;
        return rewritten;
      }
      if (!isRecord(item)) return item;
      const result = rewriteRecordPathKeys(item, ATTACHMENT_OBJECT_PATH_KEYS, options);
      if (result.changed) arrayChanged = true;
      return result.record;
    });
    if (arrayChanged) {
      next ??= { ...metadata };
      next[arrayKey] = nextItems;
    }
  }

  for (const containerKey of MEDIA_DETAIL_CONTAINER_KEYS) {
    const container = metadata[containerKey];
    if (!isRecord(container)) continue;
    const result = rewriteMediaDetailContainer(container, options);
    if (result.changed) {
      next ??= { ...metadata };
      next[containerKey] = result.details;
    }
  }

  if (Array.isArray(metadata.imageEdits)) {
    let editsChanged = false;
    const nextEdits = metadata.imageEdits.map(entry => {
      if (!isRecord(entry) || !isRecord(entry.source)) return entry;
      const sourceResult = rewriteRecordPathKeys(entry.source, ['filePath', 'originalPath'], options);
      if (!sourceResult.changed) return entry;
      editsChanged = true;
      return { ...entry, source: sourceResult.record };
    });
    if (editsChanged) {
      next ??= { ...metadata };
      next.imageEdits = nextEdits;
    }
  }

  return next ? { metadata: next, changed: true } : { metadata, changed: false };
};

/**
 * Rewrite stale `userData`-rooted media/attachment paths across `cowork_messages.metadata`
 * in a restored `lobsterai.sqlite` database.
 */
export const rewriteRestoredUserDataPathsInSqliteSync = (
  dbPath: string,
  options: RewriteUserDataPathOptions,
): { updatedRows: number } => {
  if (!fs.existsSync(dbPath)) return { updatedRows: 0 };

  if (options.sourceUserDataPath && options.sourceUserDataPath.trim()) {
    const sourceRoot = normalizeRootPosix(options.sourceUserDataPath.trim());
    const targetRoot = normalizeRootPosix(options.targetUserDataPath);
    if (areSameRoots(sourceRoot, targetRoot)) {
      return { updatedRows: 0 };
    }
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    const hasTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cowork_messages'").get(),
    );
    if (!hasTable) return { updatedRows: 0 };

    const columns = new Set(
      (db.pragma('table_info("cowork_messages")') as Array<{ name: string }>).map(col => col.name),
    );
    if (!columns.has('id') || !columns.has('metadata')) {
      return { updatedRows: 0 };
    }

    const rows = db
      .prepare("SELECT id, metadata FROM cowork_messages WHERE metadata IS NOT NULL AND metadata != ''")
      .all() as Array<{ id: string; metadata: string }>;

    const updates: Array<{ id: string; metadata: string }> = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.metadata);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const rewritten = rewriteUserDataPathsInMetadata(parsed, options);
      if (rewritten.changed) {
        updates.push({ id: row.id, metadata: JSON.stringify(rewritten.metadata) });
      }
    }

    if (updates.length === 0) {
      return { updatedRows: 0 };
    }

    const updateStmt = db.prepare('UPDATE cowork_messages SET metadata = ? WHERE id = ?');
    const applyUpdates = db.transaction((items: Array<{ id: string; metadata: string }>) => {
      for (const item of items) {
        updateStmt.run(item.metadata, item.id);
      }
    });
    applyUpdates(updates);

    return { updatedRows: updates.length };
  } finally {
    db?.close();
  }
};
