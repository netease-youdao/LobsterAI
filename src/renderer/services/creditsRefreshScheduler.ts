export const CreditsRefreshReason = {
  Activity: 'activity',
  Hover: 'hover',
  Manual: 'manual',
  SurfaceVisible: 'surface_visible',
} as const;

export type CreditsRefreshReason =
  typeof CreditsRefreshReason[keyof typeof CreditsRefreshReason];

export const DEFAULT_CREDITS_ACTIVITY_THROTTLE_MS = 4_000;
export const DEFAULT_CREDITS_ACTIVITY_COALESCE_MS = 600;
export const DEFAULT_CREDITS_HOVER_THROTTLE_MS = 2_000;

export interface CreditsRefreshSchedulerDeps {
  canRefresh: () => boolean;
  refresh: () => Promise<boolean>;
  isPageVisible?: () => boolean;
  now?: () => number;
  activityThrottleMs?: number;
  activityCoalesceMs?: number;
  hoverThrottleMs?: number;
  onError?: (error: unknown) => void;
}

const defaultIsPageVisible = (): boolean => (
  typeof document === 'undefined' || document.visibilityState === 'visible'
);

/**
 * Coordinates lightweight credit-balance refreshes without blind polling:
 * - While a visible surface (e.g. the home header credits pill) is mounted and
 *   the page is visible, activity signals from proxied LLM/media requests are
 *   coalesced and throttled (leading after settle + trailing edge).
 * - While no surface is mounted or the page is hidden, activity only marks the
 *   balance dirty with zero HTTP requests; returning to the surface or
 *   restoring visibility immediately flushes once.
 * - Hovering the badge calibrates with a shorter cooldown, and full quota
 *   refreshes call markSynced() to cancel redundant pending timers.
 */
export class CreditsRefreshScheduler {
  private readonly canRefresh: () => boolean;
  private readonly refresh: () => Promise<boolean>;
  private readonly isPageVisible: () => boolean;
  private readonly now: () => number;
  private readonly activityThrottleMs: number;
  private readonly activityCoalesceMs: number;
  private readonly hoverThrottleMs: number;
  private readonly onError?: (error: unknown) => void;

  private activeSurfaceCount = 0;
  private dirty = false;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private inFlight: Promise<boolean> | null = null;
  private rerunAfterInFlight = false;
  private generation = 0;
  private readonly refreshingListeners = new Set<(refreshing: boolean) => void>();

  constructor(deps: CreditsRefreshSchedulerDeps) {
    this.canRefresh = deps.canRefresh;
    this.refresh = deps.refresh;
    this.isPageVisible = deps.isPageVisible ?? defaultIsPageVisible;
    this.now = deps.now ?? (() => Date.now());
    this.activityThrottleMs = deps.activityThrottleMs ?? DEFAULT_CREDITS_ACTIVITY_THROTTLE_MS;
    this.activityCoalesceMs = deps.activityCoalesceMs ?? DEFAULT_CREDITS_ACTIVITY_COALESCE_MS;
    this.hoverThrottleMs = deps.hoverThrottleMs ?? DEFAULT_CREDITS_HOVER_THROTTLE_MS;
    this.onError = deps.onError;
  }

  isRefreshing(): boolean {
    return this.inFlight !== null;
  }

  subscribeRefreshing(listener: (refreshing: boolean) => void): () => void {
    this.refreshingListeners.add(listener);
    return () => {
      this.refreshingListeners.delete(listener);
    };
  }

  acquireSurface(options: { needsInitialLoad?: boolean } = {}): () => void {
    this.activeSurfaceCount += 1;
    let released = false;

    if (
      this.canRefresh()
      && this.isPageVisible()
      && (this.dirty || options.needsInitialLoad)
    ) {
      void this.requestRefresh(CreditsRefreshReason.SurfaceVisible);
    }

    return () => {
      if (released) return;
      released = true;
      this.activeSurfaceCount = Math.max(0, this.activeSurfaceCount - 1);
      if (this.activeSurfaceCount === 0) {
        this.clearTimer();
      }
    };
  }

  handleVisibilityChange(): void {
    if (!this.isPageVisible()) {
      if (this.timer !== null) {
        this.dirty = true;
        this.clearTimer();
      }
      return;
    }

    if (this.activeSurfaceCount > 0 && this.dirty && this.canRefresh()) {
      void this.requestRefresh(CreditsRefreshReason.SurfaceVisible);
    }
  }

  notifyActivity(): void {
    if (!this.canRefresh()) return;
    this.dirty = true;

    if (this.activeSurfaceCount === 0 || !this.isPageVisible()) {
      return;
    }

    if (this.inFlight) {
      this.rerunAfterInFlight = true;
      return;
    }

    this.scheduleActivityRefresh();
  }

  requestRefresh(reason: CreditsRefreshReason): Promise<boolean> {
    if (!this.canRefresh()) {
      return Promise.resolve(false);
    }

    if (reason === CreditsRefreshReason.Activity) {
      this.notifyActivity();
      return this.inFlight ?? Promise.resolve(false);
    }

    if (reason === CreditsRefreshReason.Hover) {
      const elapsed = this.now() - this.lastRefreshAt;
      if (!this.dirty && elapsed < this.hoverThrottleMs) {
        return this.inFlight ?? Promise.resolve(false);
      }
    }

    this.clearTimer();
    return this.executeRefresh();
  }

  cancelPending(): void {
    this.clearTimer();
    this.rerunAfterInFlight = false;
  }

  markSynced(timestamp = this.now()): void {
    this.lastRefreshAt = Math.max(this.lastRefreshAt, timestamp);
    this.dirty = false;
    this.rerunAfterInFlight = false;
    this.clearTimer();
  }

  reset(): void {
    this.generation += 1;
    this.clearTimer();
    this.dirty = false;
    this.rerunAfterInFlight = false;
    this.lastRefreshAt = Number.NEGATIVE_INFINITY;
    if (this.inFlight) {
      this.inFlight = null;
      this.emitRefreshing(false);
    }
  }

  private scheduleActivityRefresh(): void {
    const currentNow = this.now();
    const elapsed = currentNow - this.lastRefreshAt;
    const delayMs = elapsed >= this.activityThrottleMs
      ? this.activityCoalesceMs
      : Math.max(this.activityCoalesceMs, this.activityThrottleMs - elapsed);
    const dueAt = currentNow + delayMs;

    if (this.timer !== null && this.timerDueAt <= dueAt) {
      return;
    }

    this.clearTimer();
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = Number.POSITIVE_INFINITY;
      if (this.activeSurfaceCount === 0 || !this.isPageVisible() || !this.canRefresh()) {
        return;
      }
      void this.executeRefresh();
    }, delayMs);
  }

  private executeRefresh(): Promise<boolean> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const runGeneration = this.generation;
    this.dirty = false;
    this.rerunAfterInFlight = false;

    const run = async (): Promise<boolean> => {
      try {
        const succeeded = await this.refresh();
        if (runGeneration !== this.generation) return false;
        if (succeeded) {
          this.lastRefreshAt = this.now();
        } else {
          this.dirty = true;
        }
        return succeeded;
      } catch (error) {
        if (runGeneration === this.generation) {
          this.dirty = true;
        }
        this.onError?.(error);
        return false;
      }
    };

    const promise = run().finally(() => {
      if (this.inFlight !== promise) return;
      this.inFlight = null;
      this.emitRefreshing(false);
      if (
        runGeneration === this.generation
        && this.rerunAfterInFlight
        && this.activeSurfaceCount > 0
        && this.isPageVisible()
        && this.canRefresh()
      ) {
        this.rerunAfterInFlight = false;
        this.scheduleActivityRefresh();
      }
    });

    this.inFlight = promise;
    this.emitRefreshing(true);
    return promise;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.timerDueAt = Number.POSITIVE_INFINITY;
    }
  }

  private emitRefreshing(refreshing: boolean): void {
    for (const listener of this.refreshingListeners) {
      try {
        listener(refreshing);
      } catch {
        // Ignore observer errors so scheduling stays resilient.
      }
    }
  }
}
