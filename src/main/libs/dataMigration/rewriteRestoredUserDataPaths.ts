import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { APP_NAME } from '../../appConstants';
import { REWRITABLE_USER_DATA_SUBDIRS } from './archiveWhitelist';

export { REWRITABLE_USER_DATA_SUBDIRS };

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
   * when `sourceUserDataPath` is absent.
   */
  existsInTarget?: (relativePosixPath: string) => boolean;
  /** Optional path-style override for cross-platform unit tests. */
  targetPathStyle?: 'posix' | 'win32';
}

export interface RewriteRestoredSqliteResult {
  updatedRows: number;
  updatedMessageRows: number;
  updatedVersionRows: number;
  updatedEditRows: number;
  updatedLibraryArtifactRows: number;
  updatedLibraryManualSourceRows: number;
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

const computeLibraryPathKey = (filePath: string, targetPathStyle?: 'posix' | 'win32'): string => {
  const style = resolvePathStyle(filePath, targetPathStyle);
  if (style === 'win32') {
    return path.win32.normalize(filePath).toLowerCase();
  }
  return path.posix.normalize(filePath.replace(/\\/g, '/'));
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

  // Strategy 1: exact sourceUserDataPath recorded in manifest.
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

  // Strategy 2: fallback when sourceUserDataPath is absent — only rewrite
  // managed userData subdirs strictly proven to belong to the restored backup.
  if (stripStrictRootPrefix(candidateNorm, targetRoot) !== null) {
    return value;
  }

  const parts = candidateNorm.split('/').filter(Boolean);
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
 * Recursively rewrites any `metadata` fields (or message objects carrying `metadata`)
 * inside message version / edit JSON payloads.
 */
const rewriteUserDataPathsInNestedJsonValue = (
  value: unknown,
  options: RewriteUserDataPathOptions,
): { value: unknown; changed: boolean } => {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const result = rewriteUserDataPathsInNestedJsonValue(item, options);
      if (result.changed) changed = true;
      return result.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  if (!isRecord(value)) {
    return { value, changed: false };
  }

  let next: UnknownRecord | null = null;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'metadata' && isRecord(child)) {
      const metaResult = rewriteUserDataPathsInMetadata(child, options);
      if (metaResult.changed) {
        next ??= { ...value };
        next[key] = metaResult.metadata;
      }
      continue;
    }
    if (key === 'metadata' && typeof child === 'string' && child.trim()) {
      try {
        const parsed: unknown = JSON.parse(child);
        if (isRecord(parsed)) {
          const metaResult = rewriteUserDataPathsInMetadata(parsed, options);
          if (metaResult.changed) {
            next ??= { ...value };
            next[key] = JSON.stringify(metaResult.metadata);
          }
        }
      } catch {
        // Ignore unparseable metadata strings.
      }
      continue;
    }
    if (Array.isArray(child) || isRecord(child)) {
      const childResult = rewriteUserDataPathsInNestedJsonValue(child, options);
      if (childResult.changed) {
        next ??= { ...value };
        next[key] = childResult.value;
      }
    }
  }

  return next ? { value: next, changed: true } : { value, changed: false };
};

const hasTableAndColumns = (
  db: Database.Database,
  tableName: string,
  requiredColumns: readonly string[],
): boolean => {
  const exists = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
  if (!exists) return false;
  const columns = new Set(
    (db.pragma(`table_info("${tableName.replace(/"/g, '""')}")`) as Array<{ name: string }>)
      .map(col => col.name),
  );
  return requiredColumns.every(col => columns.has(col));
};

const rewriteCoworkMessagesTable = (
  db: Database.Database,
  options: RewriteUserDataPathOptions,
): number => {
  if (!hasTableAndColumns(db, 'cowork_messages', ['id', 'metadata'])) return 0;

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

  if (updates.length === 0) return 0;
  const stmt = db.prepare('UPDATE cowork_messages SET metadata = ? WHERE id = ?');
  db.transaction((items: Array<{ id: string; metadata: string }>) => {
    for (const item of items) {
      stmt.run(item.metadata, item.id);
    }
  })(updates);
  return updates.length;
};

const rewriteCoworkMessageVersionsTable = (
  db: Database.Database,
  options: RewriteUserDataPathOptions,
): number => {
  if (!hasTableAndColumns(db, 'cowork_message_versions', ['id', 'snapshot_json'])) return 0;

  const rows = db
    .prepare("SELECT id, snapshot_json FROM cowork_message_versions WHERE snapshot_json IS NOT NULL AND snapshot_json != ''")
    .all() as Array<{ id: string; snapshot_json: string }>;

  const updates: Array<{ id: string; snapshotJson: string }> = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.snapshot_json);
    } catch {
      continue;
    }
    const rewritten = rewriteUserDataPathsInNestedJsonValue(parsed, options);
    if (rewritten.changed) {
      updates.push({ id: row.id, snapshotJson: JSON.stringify(rewritten.value) });
    }
  }

  if (updates.length === 0) return 0;
  const stmt = db.prepare('UPDATE cowork_message_versions SET snapshot_json = ? WHERE id = ?');
  db.transaction((items: Array<{ id: string; snapshotJson: string }>) => {
    for (const item of items) {
      stmt.run(item.snapshotJson, item.id);
    }
  })(updates);
  return updates.length;
};

const rewriteCoworkMessageEditsTable = (
  db: Database.Database,
  options: RewriteUserDataPathOptions,
): number => {
  if (!hasTableAndColumns(db, 'cowork_message_edits', ['operation_id', 'operation_json', 'snapshot_json'])) {
    return 0;
  }

  const rows = db
    .prepare('SELECT operation_id, operation_json, snapshot_json FROM cowork_message_edits')
    .all() as Array<{ operation_id: string; operation_json: string; snapshot_json: string }>;

  const updates: Array<{ id: string; opJson: string; snapJson: string }> = [];
  for (const row of rows) {
    let opChanged = false;
    let snapChanged = false;
    let nextOpJson = row.operation_json;
    let nextSnapJson = row.snapshot_json;

    try {
      const parsedOp: unknown = JSON.parse(row.operation_json);
      const rewrittenOp = rewriteUserDataPathsInNestedJsonValue(parsedOp, options);
      if (rewrittenOp.changed) {
        opChanged = true;
        nextOpJson = JSON.stringify(rewrittenOp.value);
      }
    } catch {
      // Ignore unparseable JSON.
    }

    try {
      const parsedSnap: unknown = JSON.parse(row.snapshot_json);
      const rewrittenSnap = rewriteUserDataPathsInNestedJsonValue(parsedSnap, options);
      if (rewrittenSnap.changed) {
        snapChanged = true;
        nextSnapJson = JSON.stringify(rewrittenSnap.value);
      }
    } catch {
      // Ignore unparseable JSON.
    }

    if (opChanged || snapChanged) {
      updates.push({ id: row.operation_id, opJson: nextOpJson, snapJson: nextSnapJson });
    }
  }

  if (updates.length === 0) return 0;
  const stmt = db.prepare(
    'UPDATE cowork_message_edits SET operation_json = ?, snapshot_json = ? WHERE operation_id = ?',
  );
  db.transaction((items: Array<{ id: string; opJson: string; snapJson: string }>) => {
    for (const item of items) {
      stmt.run(item.opJson, item.snapJson, item.id);
    }
  })(updates);
  return updates.length;
};

const rewriteLibraryLocalArtifactsTable = (
  db: Database.Database,
  options: RewriteUserDataPathOptions,
): number => {
  if (!hasTableAndColumns(db, 'library_local_artifacts', ['id', 'path_key', 'file_path'])) return 0;

  const rows = db
    .prepare('SELECT id, path_key, file_path FROM library_local_artifacts')
    .all() as Array<{ id: string; path_key: string; file_path: string }>;

  const existingKeys = new Set(rows.map(row => row.path_key));
  const updates: Array<{ id: string; pathKey: string; filePath: string }> = [];

  for (const row of rows) {
    const rewrittenPath = rewriteUserDataPathString(row.file_path, options);
    if (rewrittenPath === row.file_path) continue;
    const nextPathKey = computeLibraryPathKey(rewrittenPath, options.targetPathStyle);
    if (nextPathKey !== row.path_key && existingKeys.has(nextPathKey)) {
      // Avoid UNIQUE constraint violation if target path_key already exists.
      continue;
    }
    existingKeys.delete(row.path_key);
    existingKeys.add(nextPathKey);
    updates.push({ id: row.id, pathKey: nextPathKey, filePath: rewrittenPath });
  }

  if (updates.length === 0) return 0;
  const stmt = db.prepare('UPDATE library_local_artifacts SET path_key = ?, file_path = ? WHERE id = ?');
  db.transaction((items: Array<{ id: string; pathKey: string; filePath: string }>) => {
    for (const item of items) {
      stmt.run(item.pathKey, item.filePath, item.id);
    }
  })(updates);
  return updates.length;
};

const rewriteLibraryManualSourcesTable = (
  db: Database.Database,
  options: RewriteUserDataPathOptions,
): number => {
  if (!hasTableAndColumns(db, 'library_manual_sources', ['path_key', 'file_path'])) return 0;

  const rows = db
    .prepare('SELECT path_key, file_path FROM library_manual_sources')
    .all() as Array<{ path_key: string; file_path: string }>;

  const existingKeys = new Set(rows.map(row => row.path_key));
  const updates: Array<{ oldPathKey: string; nextPathKey: string; filePath: string }> = [];

  for (const row of rows) {
    const rewrittenPath = rewriteUserDataPathString(row.file_path, options);
    if (rewrittenPath === row.file_path) continue;
    const nextPathKey = computeLibraryPathKey(rewrittenPath, options.targetPathStyle);
    if (nextPathKey !== row.path_key && existingKeys.has(nextPathKey)) {
      continue;
    }
    existingKeys.delete(row.path_key);
    existingKeys.add(nextPathKey);
    updates.push({ oldPathKey: row.path_key, nextPathKey, filePath: rewrittenPath });
  }

  if (updates.length === 0) return 0;
  const stmt = db.prepare(
    'UPDATE library_manual_sources SET path_key = ?, file_path = ? WHERE path_key = ?',
  );
  db.transaction((items: Array<{ oldPathKey: string; nextPathKey: string; filePath: string }>) => {
    for (const item of items) {
      stmt.run(item.nextPathKey, item.filePath, item.oldPathKey);
    }
  })(updates);
  return updates.length;
};

/**
 * Rewrite stale `userData`-rooted media, attachment, and library paths across
 * `cowork_messages`, `cowork_message_versions`, `cowork_message_edits`,
 * `library_local_artifacts`, and `library_manual_sources` in a restored
 * `lobsterai.sqlite` database.
 */
export const rewriteRestoredUserDataPathsInSqliteSync = (
  dbPath: string,
  options: RewriteUserDataPathOptions,
): RewriteRestoredSqliteResult => {
  const empty: RewriteRestoredSqliteResult = {
    updatedRows: 0,
    updatedMessageRows: 0,
    updatedVersionRows: 0,
    updatedEditRows: 0,
    updatedLibraryArtifactRows: 0,
    updatedLibraryManualSourceRows: 0,
  };
  if (!fs.existsSync(dbPath)) return empty;

  if (options.sourceUserDataPath && options.sourceUserDataPath.trim()) {
    const sourceRoot = normalizeRootPosix(options.sourceUserDataPath.trim());
    const targetRoot = normalizeRootPosix(options.targetUserDataPath);
    if (areSameRoots(sourceRoot, targetRoot)) {
      return empty;
    }
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    const updatedMessageRows = rewriteCoworkMessagesTable(db, options);
    const updatedVersionRows = rewriteCoworkMessageVersionsTable(db, options);
    const updatedEditRows = rewriteCoworkMessageEditsTable(db, options);
    const updatedLibraryArtifactRows = rewriteLibraryLocalArtifactsTable(db, options);
    const updatedLibraryManualSourceRows = rewriteLibraryManualSourcesTable(db, options);

    return {
      updatedRows:
        updatedMessageRows
        + updatedVersionRows
        + updatedEditRows
        + updatedLibraryArtifactRows
        + updatedLibraryManualSourceRows,
      updatedMessageRows,
      updatedVersionRows,
      updatedEditRows,
      updatedLibraryArtifactRows,
      updatedLibraryManualSourceRows,
    };
  } finally {
    db?.close();
  }
};
