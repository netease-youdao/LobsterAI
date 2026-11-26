import { RemoteDisplaySnapshotTiming } from './remoteDisplaySnapshot';

interface Entry<T> { value: T | null; storedAt: number; requestedAt: number; nextAt: number; revision: number }
interface Job<T> { context: string; id: string; entry: Entry<T>; revision: number; epoch: number; controller: AbortController }
interface Options<T> {
  /** Must settle only after the child exits, including cancellation. */
  produce(context: string, id: string, signal: AbortSignal): Promise<T | null>;
  onChanged?(): void;
}

/** At most four displayed tasks, one readonly child. Task selection never cancels another consumer's read. */
export class RemoteOwnershipContentCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private context: string | null = null;
  private epoch = 0;
  private stopped = false;
  private job: Job<T> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly options: Options<T>) {}

  read(context: string | null, id: string): T | null {
    if (this.stopped) return null;
    if (context !== this.context) this.changeContext(context);
    if (context === null) return null;
    const now = performance.now();
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= 4) this.entries.delete(this.entries.keys().next().value!);
      entry = { value: null, storedAt: 0, requestedAt: now, nextAt: 0, revision: 0 };
    }
    this.entries.delete(id); this.entries.set(id, entry); entry.requestedAt = now;
    this.schedule();
    return entry.value !== null && now - entry.storedAt < RemoteDisplaySnapshotTiming.ttlMs ? entry.value : null;
  }

  invalidate(id?: string): void {
    for (const [key, entry] of this.entries) if (id === undefined || key === id) { entry.value = null; entry.revision++; }
    this.schedule();
  }
  start(): void { this.stopped = false; }
  stop(): void { this.stopped = true; this.changeContext(null); }

  private changeContext(context: string | null): void {
    this.context = context; this.epoch++; this.entries.clear();
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const job = this.job;
    if (job && !job.controller.signal.aborted) {
      // Keep producer abort callbacks out of the synchronous detail IPC stack.
      const timer = setTimeout(() => job.controller.abort(), 0); timer.unref?.();
    }
  }
  private schedule(): void {
    if (this.stopped || this.context === null || this.job) return;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const now = performance.now();
    let next = Infinity;
    for (const entry of this.entries.values()) if (now - entry.requestedAt < RemoteDisplaySnapshotTiming.ttlMs)
      next = Math.min(next, entry.nextAt);
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, Math.max(0, next - now)); this.timer.unref?.();
  }
  private run(): void {
    if (this.stopped || this.context === null || this.job) return;
    const now = performance.now();
    const due = [...this.entries].filter(([, entry]) => now - entry.requestedAt < RemoteDisplaySnapshotTiming.ttlMs && entry.nextAt <= now)
      .sort((a, b) => a[1].nextAt - b[1].nextAt)[0];
    if (!due) { this.schedule(); return; }
    const [id, entry] = due;
    const job: Job<T> = { context: this.context, id, entry, revision: entry.revision, epoch: this.epoch, controller: new AbortController() };
    this.job = job; entry.nextAt = now + RemoteDisplaySnapshotTiming.refreshMs;
    void this.collect(job);
  }
  private async collect(job: Job<T>): Promise<void> {
    try {
      const value = await this.options.produce(job.context, job.id, job.controller.signal);
      if (this.current(job)) { job.entry.value = value; job.entry.storedAt = performance.now(); this.notify(); }
    } catch {
      if (this.current(job)) { job.entry.value = null; this.notify(); }
    } finally {
      // A cancelled child still owns the slot until exit is confirmed by produce().
      if (this.job === job) { this.job = null; this.schedule(); }
    }
  }
  private current(job: Job<T>): boolean {
    return !this.stopped && this.job === job && this.epoch === job.epoch && this.context === job.context
      && this.entries.get(job.id) === job.entry && job.entry.revision === job.revision;
  }
  private notify(): void { try { this.options.onChanged?.(); } catch { /* Display observers cannot stop collection. */ } }
}
