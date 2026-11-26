import { monitorEventLoopDelay } from 'perf_hooks';

const counterNames = ['projection.completed', 'projection.failed', 'projection.bytes', 'worker.failed', 'security.recovered',
  'security.unknown', 'fence.released', 'fence.unknown', 'cache.rebuilt', 'gc.rows', 'gc.bytes', 'files.failed', 'files.completed'] as const;
const gaugeNames = ['pendingSessions', 'oldestPendingAgeMs', 'projection.queue', 'files.queue', 'files.cacheBytes', 'cache.bytes',
  'security.recoveryAttempts', 'security.nextRecoveryAt', 'security.recovering',
  'control.waitMs', 'projection.durationMs', 'files.queueWaitMs', 'files.durationMs', 'main.durationMs'] as const;
type Counter = typeof counterNames[number];
type Gauge = typeof gaugeNames[number];
const counters = new Set<string>(counterNames), gauges = new Set<string>(gaugeNames);
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Fixed, content-free local diagnostics. Never used as authorization or as proof of a successful sync. */
export class RemoteDiagnostics {
  private readonly totals = new Map<Counter, number>();
  private readonly values = new Map<Gauge, number | null>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  record(name: Counter, value = 1): void {
    if (counters.has(name) && valid(value)) this.totals.set(name, Math.min(Number.MAX_SAFE_INTEGER, (this.totals.get(name) || 0) + value));
  }
  gauge(name: Gauge, value: number | null): void {
    if (gauges.has(name)) this.values.set(name, valid(value) ? value : null);
  }
  snapshot(): Record<string, number | null> {
    return { ...Object.fromEntries(counterNames.map(name => [name, this.totals.get(name) || 0])),
      ...Object.fromEntries(gaugeNames.map(name => [name, this.values.get(name) ?? null])) };
  }
  start(sample?: () => void, log: (value: Record<string, number | null>) => void = value => console.info('[RemoteDiagnostics]', value)): void {
    if (this.timer) return;
    try { this.histogram = monitorEventLoopDelay({ resolution: 50 }); this.histogram.enable(); } catch { this.histogram = null; }
    this.timer = setInterval(() => {
      try { sample?.(); } catch { this.gauge('pendingSessions', null); this.gauge('oldestPendingAgeMs', null); }
      const histogram = this.histogram;
      const measured = !!histogram && histogram.count > 0;
      try { log({ ...this.snapshot(), eventLoopP99Ms: measured ? histogram!.percentile(99) / 1e6 : null,
        eventLoopMaxMs: measured ? histogram!.max / 1e6 : null }); } catch { /* Diagnostics must not affect local execution. */ }
      histogram?.reset();
    }, 60000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.histogram?.disable(); this.histogram = null; this.values.clear();
  }
}
export const remoteDiagnostics = new RemoteDiagnostics();
