import path from 'node:path';

import { OPENCLAW_SESSION_IMPORT_ARCHIVE_DIRECTORY } from '../../shared/openclawEngine/constants';

// Shared by the bundled snapshot helper and the main-process backup prune; keep
// this module free of imports beyond Node and shared constants.

// Chromium rebuilds these per profile (user-data/<profile>/<name>) or per
// browser (user-data/<name>). Cookies, Local Storage, IndexedDB and every
// SQLite file are site/user state and must stay in the snapshot.
const CHROMIUM_CACHE_DIRECTORIES = [
  'Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache', 'GrShaderCache', 'ShaderCache',
  'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'DawnCache',
];
const REGENERABLE_SNAPSHOT_PATHS = [
  // Node's V8 compile cache; the next gateway start rebuilds it.
  /^\.compile-cache$/,
  new RegExp(`^browser/[^/]+/user-data/(?:[^/]+/)?(?:${CHROMIUM_CACHE_DIRECTORIES.join('|')})$`),
  /^browser\/[^/]+\/user-data\/[^/]+\/Service Worker\/CacheStorage$/,
];
// OpenClaw v2026.8.1 `doctor --fix` imports legacy transcripts into the agent
// SQLite databases and moves each one into this archive under a new, unused
// name. It never rewrites or removes an archived file; only the manual
// `doctor --session-sqlite restore|recover`, which repair does not run, moves
// them back. Recheck when bumping OpenClaw.
const SESSION_IMPORT_ARCHIVE_PATH = new RegExp(`^(?:agents/[^/]+/)?${OPENCLAW_SESSION_IMPORT_ARCHIVE_DIRECTORY}$`);
/** Deepest path segment count a regenerable path can have (browser/…/Service Worker/CacheStorage). */
export const REGENERABLE_SNAPSHOT_PATH_MAX_DEPTH = 6;

export const SnapshotSkipReason = {
  /** A cache OpenClaw or its browser rebuilds. */
  Regenerable: 'regenerable',
  /** Already-imported transcripts that repair only appends to; left in place. */
  SessionImportArchive: 'session-import-archive',
} as const;
export type SnapshotSkipReason = typeof SnapshotSkipReason[keyof typeof SnapshotSkipReason];

const toPosix = (relativePath: string) => relativePath.split(path.sep).join('/');

/** True for state-relative cache paths that a repair snapshot does not need to copy. */
export function isRegenerableSnapshotPath(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  return REGENERABLE_SNAPSHOT_PATHS.some(pattern => pattern.test(normalized));
}

/**
 * Why a repair snapshot leaves a state-relative entry out, or undefined to copy
 * it. Only a real directory counts as an import archive: a link there still
 * reaches the snapshot's link checks.
 */
export function resolveSnapshotSkipReason(relativePath: string, isDirectory: boolean): SnapshotSkipReason | undefined {
  if (isRegenerableSnapshotPath(relativePath)) return SnapshotSkipReason.Regenerable;
  if (isDirectory && SESSION_IMPORT_ARCHIVE_PATH.test(toPosix(relativePath))) return SnapshotSkipReason.SessionImportArchive;
  return undefined;
}
