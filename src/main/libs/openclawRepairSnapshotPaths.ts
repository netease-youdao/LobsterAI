import path from 'node:path';

// Shared by the bundled snapshot helper and the main-process backup prune; keep
// this module dependency-free.

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
/** Deepest path segment count a regenerable path can have (browser/…/Service Worker/CacheStorage). */
export const REGENERABLE_SNAPSHOT_PATH_MAX_DEPTH = 6;

/** True for state-relative cache paths that a repair snapshot does not need to copy. */
export function isRegenerableSnapshotPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  return REGENERABLE_SNAPSHOT_PATHS.some(pattern => pattern.test(normalized));
}
