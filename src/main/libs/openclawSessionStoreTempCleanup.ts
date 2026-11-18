import fs from 'fs';
import path from 'path';

import { type DiskCleanupThrottle, isDiskCleanupStopped, UNTHROTTLED_DISK_CLEANUP } from './openclawDiskCleanupThrottle';

// Mirrors OpenClaw v2026.8.1 isSessionStoreTempArtifactName() for the default
// store name: `sessions.json.<pid>.<uuid>.tmp` (legacy: no pid). The atomic
// writer renames these within milliseconds; one left behind is a crash orphan
// and never the live store (openclaw#56827). Recheck when bumping OpenClaw.
const SESSION_STORE_TEMP = /^sessions\.json\.(?:\d+\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
/** OpenClaw itself reclaims these after 5 minutes; stay far more conservative. */
export const OPENCLAW_SESSION_STORE_TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function listSessionDirectories(stateDir: string): Promise<string[]> {
  const directories = [path.join(stateDir, 'sessions')];
  try {
    for (const entry of await fs.promises.readdir(path.join(stateDir, 'agents'), { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(path.join(stateDir, 'agents', entry.name, 'sessions'));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return directories;
}

/**
 * Remove orphaned session-store temp files older than the age limit. OpenClaw
 * only sweeps them from `sessions cleanup`, which LobsterAI never runs.
 * Best-effort: failures are logged and skipped. Returns the removed files.
 */
export async function pruneOrphanOpenClawSessionStoreTemps(
  stateDir: string, options: { now?: number; throttle?: DiskCleanupThrottle } = {},
): Promise<string[]> {
  const cutoff = (options.now ?? Date.now()) - OPENCLAW_SESSION_STORE_TEMP_MAX_AGE_MS;
  const throttle = options.throttle ?? UNTHROTTLED_DISK_CLEANUP;
  const removed: string[] = [];
  let directories: string[];
  try {
    directories = await listSessionDirectories(stateDir);
  } catch (error) {
    console.warn('[OpenClaw] could not list agent session directories:', error);
    return removed;
  }
  for (const directory of directories) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[OpenClaw] could not read session directory ${directory}:`, error);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_STORE_TEMP.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      try {
        if ((await fs.promises.lstat(filePath)).mtimeMs > cutoff) continue;
        await fs.promises.unlink(filePath);
        removed.push(filePath);
        await throttle.step();
      } catch (error) {
        if (isDiskCleanupStopped(error)) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[OpenClaw] could not remove orphan session store temp ${filePath}:`, error);
        }
      }
    }
  }
  return removed;
}
