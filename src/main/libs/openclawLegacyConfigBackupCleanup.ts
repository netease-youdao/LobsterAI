import fs from 'fs';
import path from 'path';

import { OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS } from './openclawCompatibilityRepair';
import { type DiskCleanupThrottle, isDiskCleanupStopped, UNTHROTTLED_DISK_CLEANUP } from './openclawDiskCleanupThrottle';

// Gateway repair in LobsterAI 2026.6.10 through 2026.9.14 renamed the config
// beside itself: `openclaw-bak.json` first, then
// `openclaw-bak-<local YYYYMMDD-HHMMSS>[-N].json`, and never pruned them.
// Repair now moves it into `repair-backups/`, so no new ones appear, and
// nothing reads these back.
const LEGACY_CONFIG_BACKUP = /^openclaw-bak(?:-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?)?\.json$/;

/**
 * When the repair ran. A rename keeps the config's mtime, so the name is the
 * only record of it. The first backup's name has no time; the status change
 * time its rename set stands in.
 */
function legacyBackupCreatedAt(match: RegExpExecArray, stats: fs.Stats): number {
  if (!match[1]) return Math.max(stats.mtimeMs, stats.ctimeMs);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * Remove config backups that earlier gateway repairs left beside the config
 * once their repair is older than current repair backups are kept. Each is a
 * full config, provider keys and channel tokens included. Best-effort:
 * failures are logged and skipped. Returns the removed files.
 */
export async function pruneLegacyOpenClawConfigBackups(
  configPath: string, options: { now?: number; throttle?: DiskCleanupThrottle } = {},
): Promise<string[]> {
  const cutoff = (options.now ?? Date.now()) - OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS;
  const throttle = options.throttle ?? UNTHROTTLED_DISK_CLEANUP;
  const directory = path.dirname(configPath);
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[OpenClawRepair] could not read config directory ${directory}:`, error);
    }
    return removed;
  }
  for (const entry of entries) {
    const match = entry.isFile() ? LEGACY_CONFIG_BACKUP.exec(entry.name) : null;
    if (!match) continue;
    const filePath = path.join(directory, entry.name);
    try {
      if (legacyBackupCreatedAt(match, await fs.promises.lstat(filePath)) > cutoff) continue;
      await fs.promises.unlink(filePath);
      removed.push(filePath);
      await throttle.step();
    } catch (error) {
      if (isDiskCleanupStopped(error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[OpenClawRepair] could not remove legacy config backup ${filePath}:`, error);
      }
    }
  }
  return removed;
}
