import fs from 'fs';
import path from 'path';

import { type DiskCleanupThrottle, isDiskCleanupStopped, UNTHROTTLED_DISK_CLEANUP } from './openclawDiskCleanupThrottle';

// Mirrors OpenClaw v2026.8.1 forensic copies of its config: a read that looks
// clobbered saves `<config>.clobbered.<time>[-NN]` (io.clobber-snapshot.ts,
// capped at 32) and a refused write saves `<config>.rejected.<time>`
// (io.write.ts, uncapped). `<time>` is an ISO timestamp with ':' and '.'
// replaced by '-'. OpenClaw never reads either back. Recheck when bumping OpenClaw.
const SNAPSHOT_TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
const SNAPSHOT_KINDS = [
  { kind: 'clobbered', attemptSuffix: String.raw`(?:-\d{2})?` },
  { kind: 'rejected', attemptSuffix: '' },
];

/** The newest snapshots of each kind are kept whatever their age, for diagnosis. */
export const OPENCLAW_CONFIG_SNAPSHOT_KEEP_COUNT = 3;
/** Matches main log retention: an older snapshot has lost the log lines that explain it. */
export const OPENCLAW_CONFIG_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bound the forensic copies OpenClaw leaves next to its config: per kind, keep
 * the newest few and remove the rest once they pass the age limit. Each copy
 * is a full config, provider keys and channel tokens included, so stale ones
 * keep credentials the user has since removed. A copy being written is the
 * newest of its kind and never a candidate. Best-effort: failures are logged
 * and skipped. Returns the removed files.
 */
export async function pruneOpenClawConfigSnapshots(
  configPath: string, options: { now?: number; throttle?: DiskCleanupThrottle } = {},
): Promise<string[]> {
  const cutoff = (options.now ?? Date.now()) - OPENCLAW_CONFIG_SNAPSHOT_MAX_AGE_MS;
  const throttle = options.throttle ?? UNTHROTTLED_DISK_CLEANUP;
  const directory = path.dirname(configPath);
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[OpenClaw] could not read config directory ${directory}:`, error);
    }
    return removed;
  }
  const baseName = escapeRegExp(path.basename(configPath));
  for (const { kind, attemptSuffix } of SNAPSHOT_KINDS) {
    const pattern = new RegExp(`^${baseName}\\.${kind}\\.${SNAPSHOT_TIMESTAMP}${attemptSuffix}$`);
    // Names end in the creation time (then a collision counter), so a name sort is chronological.
    const names = entries.filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => (left < right ? 1 : -1));
    for (const name of names.slice(OPENCLAW_CONFIG_SNAPSHOT_KEEP_COUNT)) {
      const filePath = path.join(directory, name);
      try {
        if ((await fs.promises.lstat(filePath)).mtimeMs > cutoff) continue;
        await fs.promises.unlink(filePath);
        removed.push(filePath);
        await throttle.step();
      } catch (error) {
        if (isDiskCleanupStopped(error)) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[OpenClaw] could not remove config snapshot ${filePath}:`, error);
        }
      }
    }
  }
  return removed;
}
