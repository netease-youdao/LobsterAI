import { enqueueRemoteLog } from './remoteLogSink';

export const RemotePerformanceStage = {
  MainLoop: 'main_loop', SettingsState: 'settings_state', RemoteConfigure: 'remote_configure', RemoteConnections: 'remote_connections',
  DisplaySnapshot: 'display_snapshot', DisplayWorker: 'display_worker', Availability: 'availability', RemoteLoop: 'remote_loop',
  CoreWrite: 'core_write', AutoLaunch: 'auto_launch', BridgeAccount: 'bridge_account', BridgeDispatch: 'bridge_dispatch',
  Registration: 'registration', Capabilities: 'capabilities', WriteSettings: 'write_settings', Connect: 'connect',
  CommandRecovery: 'command_recovery', CommandClaim: 'command_claim', HistorySync: 'history_sync', HistoryPrepare: 'history_prepare',
  AvailabilityControl: 'availability_control', AvailabilityLive: 'availability_live', AvailabilityHistory: 'availability_history',
  RemoteState: 'remote_state', StateNotify: 'state_notify', NetworkWorker: 'network_worker', NetworkQueue: 'network_queue',
  NetworkRequest: 'network_request', ProjectionWorker: 'projection_worker', LiveWorker: 'live_worker', ImportWorker: 'import_worker',
  WorkerRetirement: 'worker_retirement', SettingsTempPreview: 'settings_temp_preview', RemoteInitialize: 'remote_initialize',
  SettingsPreferenceRead: 'settings_preference_read', AutoLaunchNative: 'auto_launch_native', SettingsTempCandidates: 'settings_temp_candidates',
} as const;
export type RemotePerformanceStage = typeof RemotePerformanceStage[keyof typeof RemotePerformanceStage];
export const RemotePerformanceEvent = {
  Sync: 'sync', Span: 'span', Instant: 'instant', EventLoopLag: 'event_loop_lag', Summary: 'summary',
  Spawn: 'spawn', Ready: 'ready', Exit: 'exit', Watchdog: 'watchdog', Recovery: 'recovery',
  RecoveryStarted: 'recovery_started', RecoveryCompleted: 'recovery_completed', Queued: 'queued', Dispatched: 'dispatched',
} as const;
export type RemotePerformanceEvent = typeof RemotePerformanceEvent[keyof typeof RemotePerformanceEvent];
export const RemotePerformanceOutcome = { Succeeded: 'succeeded', Failed: 'failed', Cancelled: 'cancelled', Unknown: 'unknown' } as const;
export type RemotePerformanceOutcome = typeof RemotePerformanceOutcome[keyof typeof RemotePerformanceOutcome];
export const RemotePerformanceReason = {
  None: 'none', Timeout: 'timeout', Aborted: 'aborted', Unavailable: 'unavailable', Budget: 'budget', WorkerExit: 'worker_exit', Stale: 'stale',
  Spawn: 'spawn', Ready: 'ready', Watchdog: 'watchdog', ParentDelay: 'parent_delay', ParentRecovered: 'parent_recovered', Dispose: 'dispose',
  MemoryLimit: 'memory_limit', InvalidResult: 'invalid_result', ContextChanged: 'context_changed', IpcError: 'ipc_error', ChildError: 'child_error',
} as const;
export type RemotePerformanceReason = typeof RemotePerformanceReason[keyof typeof RemotePerformanceReason];
export interface RemotePerformanceFields {
  outcome?: RemotePerformanceOutcome; reason?: RemotePerformanceReason;
  /** A supplied pid is normalized to workerPid; source pid can never be overwritten. */
  pid?: number; workerPid?: number; queueWaitMs?: number; workerWaitMs?: number; requestMs?: number; transportMs?: number; replyDeliveryMs?: number;
  exitWaitMs?: number; killToExitMs?: number; lastAliveAgeMs?: number; checkIntervalMs?: number; watchdogDelayMs?: number;
  recoveryRemainingMs?: number; elapsedMs?: number; syncMs?: number; activeCount?: number; queuedCount?: number;
  bytes?: number; rssBytes?: number; exitCode?: number; lagMs?: number; items?: number;
  current?: boolean; cancelled?: boolean; recovering?: boolean; connected?: boolean; timedOut?: boolean;
}
const Stage = RemotePerformanceStage, Event = RemotePerformanceEvent, Outcome = RemotePerformanceOutcome;
const stages = new Set<string>(Object.values(Stage)), events = new Set<string>(Object.values(Event));
const outcomes = new Set<string>(Object.values(Outcome)), reasons = new Set<string>(Object.values(RemotePerformanceReason));
const numberFields = ['workerPid', 'queueWaitMs', 'workerWaitMs', 'requestMs', 'transportMs', 'replyDeliveryMs', 'exitWaitMs', 'killToExitMs',
  'lastAliveAgeMs', 'checkIntervalMs', 'watchdogDelayMs', 'recoveryRemainingMs', 'elapsedMs', 'syncMs', 'activeCount', 'queuedCount',
  'bytes', 'rssBytes', 'exitCode', 'lagMs', 'items'] as const;
const booleanFields = ['current', 'cancelled', 'recovering', 'connected', 'timedOut'] as const;
const Limit = { SyncMs: 50, SpanMs: 1000, LagMs: 200, TickMs: 1000, SummaryMs: 60000,
  RateMs: 10000, GlobalLogs: 64, Active: 64, SummaryItems: 8, Number: 1e12 } as const;
const bounded = (value: number): number => Math.round(Math.min(Limit.Number, Math.max(0, value)) * 100) / 100;
interface Span { stage: RemotePerformanceStage; event: typeof Event.Sync | typeof Event.Span; spanId: number; start: number; epoch: number }
interface Recent { span: Span; elapsed: number; outcome: RemotePerformanceOutcome; finished: number }
interface Totals { count: number; syncCount: number; spanCount: number; failed: number; suppressed: number; syncMaxMs: number; spanMaxMs: number }
interface Rate { at: number; used: boolean; suppressed: number }
interface Options { now?: () => number; enqueue?: typeof enqueueRemoteLog }

/** Content-free, bounded memory only. Enqueue failures never alter business results or exceptions. */
export class RemotePerformanceTracker {
  private readonly active = new Map<number, Span>();
  private readonly recentSync: Recent[] = [];
  private readonly recentAsync: Recent[] = [];
  private readonly totals = new Map<RemotePerformanceStage, Totals>();
  private readonly rates = new Map<string, Rate>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = true;
  private epoch = 0;
  private sequence = 0;
  private lastTick = 0;
  private lastSummary = 0;
  private globalAt = 0;
  private globalCount = 0;
  private globalSuppressed = 0;
  private activeDropped = 0;
  private readonly clock: () => number;
  private readonly enqueue: typeof enqueueRemoteLog;
  constructor(options: Options = {}) { this.clock = options.now ?? (() => performance.now()); this.enqueue = options.enqueue ?? enqueueRemoteLog; }

  sync<T>(stage: RemotePerformanceStage, fn: () => T): T {
    if (!this.enabled || !stages.has(stage)) return fn();
    const span = this.open(stage, Event.Sync);
    let outcome: RemotePerformanceOutcome = Outcome.Succeeded;
    try { return fn(); } catch (error) { outcome = Outcome.Failed; throw error; }
    finally { this.finish(span, outcome); }
  }
  begin(stage: RemotePerformanceStage): (outcome?: RemotePerformanceOutcome, extra?: RemotePerformanceFields) => void {
    if (!this.enabled || !stages.has(stage)) return () => {};
    const span = this.open(stage, Event.Span); let finished = false;
    return (outcome = Outcome.Succeeded, extra) => {
      if (finished) return; finished = true; this.finish(span, outcomes.has(outcome) ? outcome : Outcome.Unknown, extra);
    };
  }
  async async<T>(stage: RemotePerformanceStage, fn: () => Promise<T>): Promise<T> {
    const end = this.begin(stage);
    try { const value = await this.sync(stage, fn); end(); return value; }
    catch (error) { end(Outcome.Failed); throw error; }
  }
  event(stage: RemotePerformanceStage, event: RemotePerformanceEvent, fields: RemotePerformanceFields = {}): void {
    if (!this.enabled || !stages.has(stage) || !events.has(event)) return;
    try {
      const clean = this.sanitize(fields), totals = this.stageTotals(stage);
      totals.count = bounded(totals.count + 1);
      if (clean.outcome === Outcome.Failed) totals.failed = bounded(totals.failed + 1);
      this.emit(stage, event, clean);
    } catch { /* Diagnostics cannot enter a caller's failure path. */ }
  }
  start(): void {
    this.enabled = true;
    if (this.timer) return;
    this.lastTick = this.lastSummary = this.now();
    this.timer = setInterval(() => this.tick(), Limit.TickMs); this.timer.unref?.();
  }
  stop(): void {
    this.enabled = false; this.epoch++;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.active.clear(); this.recentSync.length = 0; this.recentAsync.length = 0; this.totals.clear(); this.rates.clear();
    this.globalCount = 0; this.globalSuppressed = 0; this.activeDropped = 0;
  }
  private now(): number {
    try { const value = this.clock(); return Number.isFinite(value) ? Math.max(0, value) : 0; } catch { return 0; }
  }
  private open(stage: RemotePerformanceStage, event: Span['event']): Span {
    const span = { stage, event, spanId: ++this.sequence, start: this.now(), epoch: this.epoch };
    if (this.active.size < Limit.Active) this.active.set(span.spanId, span); else this.activeDropped = bounded(this.activeDropped + 1);
    return span;
  }
  private finish(span: Span, outcome: RemotePerformanceOutcome, extra: RemotePerformanceFields = {}): void {
    try {
      if (!this.enabled || span.epoch !== this.epoch) return;
      this.active.delete(span.spanId);
      const now = this.now(), elapsed = bounded(now - span.start), totals = this.stageTotals(span.stage);
      totals.count = bounded(totals.count + 1);
      if (outcome === Outcome.Failed) totals.failed = bounded(totals.failed + 1);
      const synchronous = span.event === Event.Sync;
      if (synchronous) { totals.syncCount = bounded(totals.syncCount + 1); totals.syncMaxMs = Math.max(totals.syncMaxMs, elapsed); }
      else { totals.spanCount = bounded(totals.spanCount + 1); totals.spanMaxMs = Math.max(totals.spanMaxMs, elapsed); }
      if (elapsed < (synchronous ? Limit.SyncMs : Limit.SpanMs) && outcome !== Outcome.Failed) return;
      const recent = synchronous ? this.recentSync : this.recentAsync;
      recent.push({ span, elapsed, outcome, finished: now });
      if (recent.length > Limit.SummaryItems) recent.shift();
      this.emit(span.stage, span.event, { ...this.sanitize(extra), spanId: span.spanId, outcome,
        ...(synchronous ? { syncMs: elapsed } : { elapsedMs: elapsed }) });
    } catch { /* Always preserve the original return value or exception. */ }
  }
  private sanitize(fields: RemotePerformanceFields): Record<string, number | boolean | string> {
    const clean: Record<string, number | boolean | string> = {};
    for (const key of numberFields) {
      const value = key === 'workerPid' ? fields.workerPid ?? fields.pid : fields[key];
      if (typeof value === 'number' && Number.isFinite(value) && (key !== 'replyDeliveryMs' || value >= 0)) clean[key] = key === 'exitCode'
        ? Math.trunc(Math.max(-2147483648, Math.min(2147483647, value))) : bounded(value);
    }
    for (const key of booleanFields) if (typeof fields[key] === 'boolean') clean[key] = fields[key]!;
    if (typeof fields.outcome === 'string' && outcomes.has(fields.outcome)) clean.outcome = fields.outcome;
    if (typeof fields.reason === 'string' && reasons.has(fields.reason)) clean.reason = fields.reason;
    return clean;
  }
  private stageTotals(stage: RemotePerformanceStage): Totals {
    let totals = this.totals.get(stage);
    if (!totals) { totals = { count: 0, syncCount: 0, spanCount: 0, failed: 0, suppressed: 0, syncMaxMs: 0, spanMaxMs: 0 }; this.totals.set(stage, totals); }
    return totals;
  }
  private emit(stage: RemotePerformanceStage, event: RemotePerformanceEvent, fields: Record<string, unknown>): boolean {
    const now = this.now(), key = `${stage}:${event}`;
    let rate = this.rates.get(key);
    if (!rate) { rate = { at: now, used: false, suppressed: 0 }; this.rates.set(key, rate); }
    if (now - rate.at >= Limit.RateMs) { rate.at = now; rate.used = false; }
    if (now - this.globalAt >= Limit.RateMs) { this.globalAt = now; this.globalCount = 0; }
    const totals = this.stageTotals(stage);
    if (rate.used || this.globalCount >= Limit.GlobalLogs) {
      rate.suppressed = bounded(rate.suppressed + 1); totals.suppressed = bounded(totals.suppressed + 1);
      if (this.globalCount >= Limit.GlobalLogs) this.globalSuppressed = bounded(this.globalSuppressed + 1);
      return false;
    }
    rate.used = true; this.globalCount++;
    try {
      this.enqueue('debug', '[RemotePerformance]', { ...fields, stage, event, pid: process.pid,
        monotonicMs: bounded(now), suppressed: typeof fields.suppressed === 'number' ? fields.suppressed : rate.suppressed, globalSuppressed: this.globalSuppressed });
      rate.suppressed = 0; this.globalSuppressed = 0; return true;
    } catch { rate.suppressed = bounded(rate.suppressed + 1); totals.suppressed = bounded(totals.suppressed + 1); return false; }
  }
  private tick(): void {
    if (!this.enabled) return;
    try {
      const now = this.now(), lagMs = bounded(now - this.lastTick - Limit.TickMs); this.lastTick = now;
      if (lagMs >= Limit.LagMs) this.emit(Stage.MainLoop, Event.EventLoopLag, { lagMs, activeCount: this.active.size, activeDropped: this.activeDropped,
        active: [...this.active.values()].sort((a, b) => a.start - b.start).slice(0, Limit.SummaryItems)
          .map(span => ({ stage: span.stage, event: span.event, spanId: span.spanId, elapsedMs: bounded(now - span.start) })),
        // Draining queued async completions after a stall must not evict the synchronous cause.
        recentSlow: [...this.recentSync.filter(item => now - item.finished <= Limit.SummaryMs).reverse(),
          ...this.recentAsync.filter(item => now - item.finished <= Limit.SummaryMs).reverse()].slice(0, Limit.SummaryItems)
          .map(item => ({ stage: item.span.stage, event: item.span.event, spanId: item.span.spanId, outcome: item.outcome,
          ageMs: bounded(now - item.finished), ...(item.span.event === Event.Sync ? { syncMs: item.elapsed } : { elapsedMs: item.elapsed }) })) });
      if (now - this.lastSummary >= Limit.SummaryMs) {
        this.lastSummary = now;
        for (const [stage, totals] of this.totals) if (totals.count && this.emit(stage, Event.Summary, { ...totals })) this.totals.delete(stage);
      }
    } catch { /* A logging tick must never fail the application event loop. */ }
  }
}
export const remotePerformance = new RemotePerformanceTracker();
