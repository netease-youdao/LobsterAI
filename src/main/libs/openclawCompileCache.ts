import fs from 'fs';
import path from 'path';

import { type DiskCleanupThrottle, isDiskCleanupStopped, UNTHROTTLED_DISK_CLEANUP } from './openclawDiskCleanupThrottle';
import { removeTreeNoFollow } from './removeTreeNoFollow';

/**
 * NODE_COMPILE_CACHE writes into `<dir>/<version>-<arch>-<V8 flag hash>[-<uid>]`.
 * The gateway runs on this Electron's Node, so this prefix names its cache.
 */
export function getOpenClawCompileCachePrefix(version = process.version, arch: string = process.arch): string {
  return `${version}-${arch}-`;
}

/**
 * Remove compile cache subdirectories left by other Node/Electron versions.
 * Best-effort: failures are logged and skipped. With a throttle, a stopped
 * pass throws DiskCleanupStoppedError; a partly removed directory keeps its
 * stale name, so the next pass finishes it. Returns the removed paths.
 */
export async function pruneStaleOpenClawCompileCaches(
  compileCacheDir: string, currentPrefix = getOpenClawCompileCachePrefix(),
  throttle: DiskCleanupThrottle = UNTHROTTLED_DISK_CLEANUP,
): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(compileCacheDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[OpenClaw] could not read compile cache dir ${compileCacheDir}:`, error);
    }
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(currentPrefix)) continue;
    const target = path.join(compileCacheDir, entry.name);
    try {
      await removeTreeNoFollow(target, () => throttle.step());
      removed.push(target);
    } catch (error) {
      if (isDiskCleanupStopped(error)) throw error;
      console.warn(`[OpenClaw] could not remove stale compile cache ${target}:`, error);
    }
  }
  return removed;
}
