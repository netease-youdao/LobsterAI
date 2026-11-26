import { remotePerformance, RemotePerformanceEvent, RemotePerformanceOutcome, RemotePerformanceReason, RemotePerformanceStage } from './remotePerformanceLog';

export const RemoteDisplaySnapshotTiming = { refreshMs: 5000, ttlMs: 15000 } as const;

interface SnapshotJob {
  contextKey: string;
  revision: number;
  controller: AbortController;
  cancellationScheduled?: boolean;
}
interface Snapshot<T> { value: T; storedAt: number; retained: boolean }
interface RemoteDisplaySnapshotOptions<T> {
  /** Owns the worker's five-second deadline and must settle only after cancellation/exit is confirmed. */
  produce(contextKey: string, signal: AbortSignal): Promise<T | null>;
  /** Only for quiescent state whose writes explicitly invalidate this cache. */
  retainUntilInvalidated?(value: T): boolean;
  onChanged?(): void;
}

/** Display-only cache. Reading never starts synchronous producer/worker or storage work. */
export class RemoteDisplaySnapshot<T> {
  private contextKey: string | null = null;
  private revision = 0;
  private stopped = false;
  private snapshot: Snapshot<T> | null = null;
  private job: SnapshotJob | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRefreshAt = 0;

  constructor(private readonly options: RemoteDisplaySnapshotOptions<T>) {}

  read(contextKey: string | null): T | null {
    if (this.stopped) return null;
    if (contextKey !== this.contextKey) {
      this.contextKey = contextKey;
      this.nextRefreshAt = 0;
      this.invalidate();
    }
    this.schedule();
    return this.snapshot && (this.snapshot.retained || performance.now() - this.snapshot.storedAt < RemoteDisplaySnapshotTiming.ttlMs)
      ? this.snapshot.value : null;
  }

  /** Invalidate the same scope without bypassing its minimum refresh interval. */
  invalidate(): void {
    remotePerformance.event(RemotePerformanceStage.DisplaySnapshot, RemotePerformanceEvent.Instant, { reason: RemotePerformanceReason.ContextChanged, activeCount: this.job ? 1 : 0 });
    this.revision++;
    this.clearSnapshot();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const job = this.job;
    if (job && !job.cancellationScheduled) {
      job.cancellationScheduled = true;
      // Abort listeners belong to the producer, so even cancellation stays out of the read stack.
      const timer = setTimeout(() => job.controller.abort(), 0);
      timer.unref?.();
    }
    this.schedule();
  }

  start(): void { this.stopped = false; }

  stop(): void {
    this.stopped = true;
    this.contextKey = null;
    this.invalidate();
  }

  private schedule(): void {
    if (this.stopped || this.contextKey === null || this.job || this.refreshTimer || this.snapshot?.retained) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.stopped || this.contextKey === null || this.job) return;
      const job: SnapshotJob = { contextKey: this.contextKey, revision: this.revision, controller: new AbortController() };
      this.job = job;
      this.nextRefreshAt = performance.now() + RemoteDisplaySnapshotTiming.refreshMs;
      void this.collect(job);
    }, Math.max(0, this.nextRefreshAt - performance.now()));
    this.refreshTimer.unref?.();
  }

  private current(job: SnapshotJob): boolean {
    return !this.stopped && this.job === job && this.contextKey === job.contextKey && this.revision === job.revision;
  }

  private async collect(job: SnapshotJob): Promise<void> {
    try {
      const value = await this.options.produce(job.contextKey, job.controller.signal);
      if (!this.current(job)) { remotePerformance.event(RemotePerformanceStage.DisplaySnapshot, RemotePerformanceEvent.Instant, { reason: RemotePerformanceReason.ContextChanged, outcome: RemotePerformanceOutcome.Cancelled }); return; }
      this.clearSnapshot();
      if (value !== null) {
        const snapshot = this.snapshot = { value, storedAt: performance.now(), retained: this.options.retainUntilInvalidated?.(value) === true };
        if (!snapshot.retained) this.expiryTimer = setTimeout(() => {
          this.expiryTimer = null;
          if (this.snapshot !== snapshot || !this.currentScope(job)) return;
          this.snapshot = null;
          remotePerformance.event(RemotePerformanceStage.DisplaySnapshot, RemotePerformanceEvent.Instant, { reason: RemotePerformanceReason.Stale, outcome: RemotePerformanceOutcome.Unknown });
          this.notify();
        }, RemoteDisplaySnapshotTiming.ttlMs);
        this.expiryTimer?.unref?.();
      }
      this.notify();
    } catch {
      if (this.current(job)) { this.clearSnapshot(); this.notify(); }
    } finally {
      // Abort is only a request: never release the single-flight slot before the producer settles.
      if (this.job === job) { this.job = null; this.schedule(); }
    }
  }

  private currentScope(job: SnapshotJob): boolean {
    return !this.stopped && this.contextKey === job.contextKey && this.revision === job.revision;
  }

  private clearSnapshot(): void {
    this.snapshot = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private notify(): void {
    try { this.options.onChanged?.(); } catch { /* A display observer cannot fail or stop sampling. */ }
  }
}
