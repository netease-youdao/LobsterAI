import { OPENCLAW_BROWSER_CACHE_PRUNE_INTERVAL_MS, pruneOpenClawBrowserCaches } from './openclawBrowserCachePrune';
import { pruneOpenClawRepairBackups } from './openclawCompatibilityRepair';
import { pruneStaleOpenClawCompileCaches } from './openclawCompileCache';
import {
  createDiskCleanupThrottle, type DiskCleanupThrottle, isDiskCleanupStopped,
} from './openclawDiskCleanupThrottle';
import { pruneExpiredOpenClawSessionImportArchives } from './openclawSessionImportArchiveCleanup';
import { pruneOrphanOpenClawSessionStoreTemps } from './openclawSessionStoreTempCleanup';

/**
 * Delay after the gateway reports ready. The first pass after an upgrade can
 * delete hundreds of thousands of files; it must not compete with startup I/O.
 */
export const OPENCLAW_STARTUP_DISK_CLEANUP_DELAY_MS = 60_000;
/** A pass that stopped early (time budget, battery) tries again after this. */
export const OPENCLAW_STARTUP_DISK_CLEANUP_RETRY_MS = 30 * 60 * 1000;

export interface OpenClawStartupDiskCleanupParams {
  baseDir: string;
  stateDir: string;
  compileCacheDir: string;
}

export interface OpenClawStartupDiskCleanupOptions {
  /** Laptops on battery skip the pass, and a running pass stops at its next rest. */
  isOnBatteryPower?: () => boolean;
  /** Defaults to a duty-cycled throttle with the standard pass budget. */
  throttle?: DiskCleanupThrottle;
  now?: number;
}

const lastBrowserCachePruneAt = new Map<string, number>();
// State dirs with a pass pending or running; gateway restarts reuse that pass.
const activeCleanups = new Set<string>();

function onBattery(options: OpenClawStartupDiskCleanupOptions): boolean {
  try {
    return options.isOnBatteryPower?.() ?? false;
  } catch (error) {
    console.debug('[OpenClaw] could not read power source; assuming AC power:', error);
    return false;
  }
}

/**
 * Best-effort disk cleanup for an OpenClaw profile. Steps run one at a time,
 * paced by the throttle, cheapest-per-byte first, and log their own failures;
 * none touches state the running gateway or a running browser uses. Returns
 * false when the pass stopped early; every step resumes where it left off.
 */
export async function runOpenClawStartupDiskCleanup(
  params: OpenClawStartupDiskCleanupParams, options: OpenClawStartupDiskCleanupOptions = {},
): Promise<boolean> {
  if (onBattery(options)) {
    console.log('[OpenClaw] disk cleanup deferred: running on battery power.');
    return false;
  }
  const now = options.now ?? Date.now();
  const throttle = options.throttle ?? createDiskCleanupThrottle({ shouldStopForBattery: () => onBattery(options) });
  const steps: Array<{ label: string; run: () => Promise<string | null> }> = [
    {
      label: 'session store temps',
      run: async () => {
        const removed = await pruneOrphanOpenClawSessionStoreTemps(params.stateDir, { now, throttle });
        return removed.length ? `[OpenClaw] removed ${removed.length} orphan session store temp file(s).` : null;
      },
    },
    {
      label: 'session import archives',
      run: async () => {
        const removed = await pruneExpiredOpenClawSessionImportArchives(params.stateDir, { now, throttle });
        return removed.length ? `[OpenClaw] removed ${removed.length} expired session import archive(s).` : null;
      },
    },
    {
      label: 'browser caches',
      run: async () => {
        // Measuring walks the cache trees, so a completed pass is not repeated within the interval.
        if (now - (lastBrowserCachePruneAt.get(params.stateDir) ?? -Infinity) < OPENCLAW_BROWSER_CACHE_PRUNE_INTERVAL_MS) return null;
        const removed = await pruneOpenClawBrowserCaches(params.stateDir, { throttle });
        lastBrowserCachePruneAt.set(params.stateDir, now);
        return removed.length ? `[OpenClaw] removed ${removed.length} oversized agent browser cache dir(s).` : null;
      },
    },
    {
      // Bound repair snapshots left by earlier versions without waiting for another repair.
      label: 'repair backups',
      run: async () => {
        const { removedRuns, strippedPaths } = await pruneOpenClawRepairBackups(params.baseDir, { now, throttle });
        return removedRuns.length || strippedPaths.length
          ? `[OpenClawRepair] removed ${removedRuns.length} old repair backup(s); stripped ${strippedPaths.length} cache dir(s) from retained ones.`
          : null;
      },
    },
    {
      // Node keeps one subdirectory per runtime version; earlier app versions leave theirs behind.
      label: 'compile cache',
      run: async () => {
        const removed = await pruneStaleOpenClawCompileCaches(params.compileCacheDir, undefined, throttle);
        return removed.length ? `[OpenClaw] removed ${removed.length} stale compile cache dir(s).` : null;
      },
    },
  ];
  for (const step of steps) {
    try {
      const summary = await step.run();
      if (summary) console.log(summary);
    } catch (error) {
      if (isDiskCleanupStopped(error)) {
        console.log(`[OpenClaw] disk cleanup paused at "${step.label}" (${error.reason}); it resumes later.`);
        return false;
      }
      console.warn(`[OpenClaw] disk cleanup step "${step.label}" failed:`, error);
    }
  }
  return true;
}

/**
 * Run the cleanup in the background a while after the gateway is ready. A pass
 * that stops early is retried later in this app session, and the next app
 * start resumes it too. At most one pass per state dir is pending or running.
 */
export function scheduleOpenClawStartupDiskCleanup(
  params: OpenClawStartupDiskCleanupParams,
  options: Pick<OpenClawStartupDiskCleanupOptions, 'isOnBatteryPower'> & { delayMs?: number; retryMs?: number } = {},
): void {
  if (activeCleanups.has(params.stateDir)) return;
  activeCleanups.add(params.stateDir);
  const attempt = (delayMs: number) => {
    const timer = setTimeout(() => {
      void runOpenClawStartupDiskCleanup(params, { isOnBatteryPower: options.isOnBatteryPower })
        .catch((error: unknown) => {
          console.warn('[OpenClaw] disk cleanup failed:', error);
          return true;
        })
        .then((finished) => {
          if (finished) activeCleanups.delete(params.stateDir);
          else attempt(options.retryMs ?? OPENCLAW_STARTUP_DISK_CLEANUP_RETRY_MS);
        });
    }, delayMs);
    // Never keep the app alive just to clean up.
    timer.unref?.();
  };
  attempt(options.delayMs ?? OPENCLAW_STARTUP_DISK_CLEANUP_DELAY_MS);
}
