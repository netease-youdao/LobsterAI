/**
 * Paces background disk cleanup so it never saturates a slow disk: work runs
 * in short slices separated by rests (a duty cycle), and a pass stops once its
 * wall-clock budget is spent. Every cleanup step is idempotent, so a stopped
 * pass simply resumes on the next run.
 */

export const DiskCleanupStopReason = {
  Budget: 'budget',
  Battery: 'battery',
} as const;
export type DiskCleanupStopReason = typeof DiskCleanupStopReason[keyof typeof DiskCleanupStopReason];

/** Work this long, then rest: about 20% of wall time touches the disk. */
export const DISK_CLEANUP_WORK_SLICE_MS = 20;
export const DISK_CLEANUP_REST_MS = 80;
/** Wall-clock limit for one pass, rests included. */
export const DISK_CLEANUP_PASS_BUDGET_MS = 5 * 60 * 1000;

export class DiskCleanupStoppedError extends Error {
  constructor(readonly reason: DiskCleanupStopReason) {
    super(`Disk cleanup stopped (${reason}).`);
    this.name = 'DiskCleanupStoppedError';
  }
}

export function isDiskCleanupStopped(error: unknown): error is DiskCleanupStoppedError {
  return error instanceof DiskCleanupStoppedError;
}

export interface DiskCleanupThrottle {
  /**
   * Call after each filesystem operation. Rests once the current work slice is
   * used up, and throws DiskCleanupStoppedError when the pass must stop.
   * Callers that catch per-item errors must rethrow this one.
   */
  step(): Promise<void>;
}

/** For callers outside a paced pass, such as tests. */
export const UNTHROTTLED_DISK_CLEANUP: DiskCleanupThrottle = { step: async () => {} };

export function createDiskCleanupThrottle(options: {
  workSliceMs?: number;
  restMs?: number;
  budgetMs?: number;
  /** Checked at every rest; returning true stops the pass, e.g. on battery power. */
  shouldStopForBattery?: () => boolean;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): DiskCleanupThrottle {
  const workSliceMs = options.workSliceMs ?? DISK_CLEANUP_WORK_SLICE_MS;
  const restMs = options.restMs ?? DISK_CLEANUP_REST_MS;
  const budgetMs = options.budgetMs ?? DISK_CLEANUP_PASS_BUDGET_MS;
  const clock = options.clock ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  }));
  const startedAt = clock();
  let sliceStartedAt = startedAt;
  return {
    async step() {
      const now = clock();
      if (now - startedAt >= budgetMs) throw new DiskCleanupStoppedError(DiskCleanupStopReason.Budget);
      if (now - sliceStartedAt < workSliceMs) return;
      await sleep(restMs);
      if (options.shouldStopForBattery?.()) throw new DiskCleanupStoppedError(DiskCleanupStopReason.Battery);
      sliceStartedAt = clock();
    },
  };
}
