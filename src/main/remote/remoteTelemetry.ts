import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  RemoteTelemetryAction as A, RemoteTelemetryEvent as E, remoteTelemetryHasRequired, RemoteTelemetryLimit as L, RemoteTelemetryResult as R,
  RemoteTelemetrySummary as S, sanitizeRemoteTelemetryFields, telemetryCounterNames,
  telemetryEvents, type TelemetryFields,
telemetryResults, telemetrySummaries, } from '../../shared/remote/telemetry';
import { buildMainLogUrl, FrozenLogOutcome, type MainLogEventParams, type MainLogReporterOptions, type MainLogUrlContext, sendFrozenMainLogEvent } from '../libs/mainLogReporter';
import { RemoteTelemetrySpool } from './remoteTelemetrySpool';

export interface RemoteTelemetryContext {
  epoch: string; enabled: boolean; contextReady?: boolean; installationId: string | null; appVersion: string; environment: 'production' | 'test' | 'development';
  userId?: string; identityNamespace?: 'yid' | 'server_user_id' | 'anonymous'; remoteEnvironment?: string;
  remoteOwnerId?: string; scopeKind?: string; ownerScopeId?: string; deviceId?: string; dataSpaceId?: string;
  dataGeneration?: string; syncProtocolVersion?: string; platform?: string; arch?: string; buildId?: string;
  firstKeyfrom?: string; latestKeyfrom?: string; language?: string;
}
export interface RemoteTelemetryOptions {
  context: RemoteTelemetryContext; fetch: MainLogReporterOptions['fetch']; directory?: string;
  now?: () => number; monotonicNow?: () => number; random?: () => number; autoStart?: boolean;
}
export interface RemoteTelemetryRequestTracker {
  logicalAttemptId: string; transportStarted(): void; finish(result: string, fields?: Record<string, unknown>): void;
}
export interface RemoteTelemetryCapture {
  emit(event: string, fields?: Record<string, unknown>): void;
  request(fields: Record<string, unknown>): RemoteTelemetryRequestTracker;
}
interface Snapshot { epoch: string; common: TelemetryFields; main: MainLogUrlContext; }
interface RecordEntry {
  eventId: string; epoch: string; createdAt: number; fields: TelemetryFields; context: MainLogUrlContext;
  priority: number; attempts: number; nextAt: number; expiresAt: number;
}
interface WindowEntry {
  kind: string; snapshot: Snapshot; fields: TelemetryFields; counts: Record<string, number>; start: number; mono: number;
  inflight: number; inflightStart: number; observed: boolean;
}
interface Group { event: string; fields: TelemetryFields; snapshot: Snapshot; at: number; last: number; duplicates: number; }
const RetryDelays = [5000, 30000, 120000, 600000, 1800000];
const Priorities = { Detail: 0, Summary: 1, Critical: 2 } as const;
const SummaryReserve = 64;
const Schedule = [Priorities.Critical, Priorities.Summary, Priorities.Critical, Priorities.Detail, Priorities.Critical];
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(v);
const opaque = (v: unknown, max = 64): v is string => typeof v === 'string' && new RegExp(max === 96 ? `^[A-Za-z0-9_:-]{1,${max}}$` : `^[A-Za-z0-9_-]{1,${max}}$`, 'u').test(v);
const text = (v: unknown, max = 64): string => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9._+-]+$/u.test(v) ? v : '';
const digest = (v: string): string => createHash('sha256').update(v).digest('hex');
const sampled = (id: string): boolean => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 100 === 0; };
const isFailure = (f: TelemetryFields): boolean => (typeof f.result === 'string' && telemetryResults.has(f.result) && f.result !== R.ApiOk && f.result !== R.TransferOk)
  || [f.outcome, f.result, f.business_status, f.to_state].some(value => ['failed', 'unknown', 'deferred', 'rejected', 'isolated', 'blocked', 'degraded'].includes(String(value)));
const noopTracker = (): RemoteTelemetryRequestTracker => ({ logicalAttemptId: randomUUID(), transportStarted() {}, finish() {} });
const noopCapture: RemoteTelemetryCapture = { emit() {}, request: noopTracker };

/** Every entry owns its immutable account context. No storage or auth read occurs on the capture path. */
export class RemoteTelemetry {
  private snapshotContext: Snapshot | null = null;
  private generation = 0;
  private readonly processId = randomUUID();
  private eventSeq = 0;
  private windowSeq = 0;
  private readonly queue: RecordEntry[] = [];
  private readonly windows = new Map<string, WindowEntry>();
  private readonly groups = new Map<string, Group>();
  private readonly stats: Record<string, number> = {};
  private queueBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private abort: AbortController | null = null;
  private activeId: string | null = null;
  private tokens = 4;
  private tokenAt: number;
  private scheduleIndex = 0;
  private readonly laneCursor = new Map<number, number>();
  private failures = 0;
  private circuitUntil = 0;
  private lastWindow: number;
  private lastHealth: number;
  private readonly spool: RemoteTelemetrySpool<RecordEntry> | null;
  private restoring = false;
  private restorePromise: Promise<void> | null = null;
  private storageReady = false;
  private diskInitialized = false;
  private stopping = false;
  private closed = false;
  private readonly now: () => number;
  private readonly mono: () => number;

  constructor(private readonly options: RemoteTelemetryOptions) {
    this.now = options.now ?? Date.now; this.mono = options.monotonicNow ?? (() => performance.now());
    this.lastWindow = this.lastHealth = this.tokenAt = this.now();
    this.spool = options.directory ? new RemoteTelemetrySpool(options.directory, () => this.increment('cache_failed')) : null;
    this.updateContext(options.context, true);
    if (options.autoStart !== false) {
      this.timer = setInterval(() => { try { this.tick(); } catch { /* Never escape into Electron's event loop. */ } }, 1000);
      this.timer.unref?.();
    }
  }

  updateContext(context: RemoteTelemetryContext, initial = false): void {
    try {
      const next = this.captureContext(context);
      const changed = next?.epoch !== this.snapshotContext?.epoch || !next;
      if (changed) {
        this.generation++; this.abort?.abort(); this.queue.length = 0; this.queueBytes = 0;
        this.windows.clear(); this.groups.clear(); this.failures = 0; this.circuitUntil = 0;
        for (const key of Object.keys(this.stats)) delete this.stats[key];
        if (!initial && this.diskInitialized) this.spool?.replace([]);
      }
      this.snapshotContext = next;
      this.storageReady = !!next && context.contextReady !== false;
      if (!next) { this.diskInitialized = true; this.spool?.replace([]); }
      else if (this.storageReady && !this.diskInitialized && this.spool) {
        this.diskInitialized = true; this.restoring = true; this.restorePromise = this.restore(this.generation);
      } else if (this.storageReady && !this.restoring) this.persist();
    } catch { this.snapshotContext = null; this.generation++; this.abort?.abort(); this.queue.length = 0; this.queueBytes = 0; this.spool?.replace([]); }
  }

  private captureContext(c: RemoteTelemetryContext): Snapshot | null {
    if (!c.enabled || !c.epoch || c.epoch.length > 4096 || !text(c.appVersion) || !['production', 'test', 'development'].includes(c.environment)) return null;
    const userId = opaque(c.userId) ? c.userId : '';
    const common: TelemetryFields = { environment: c.environment, remote_environment: ['production', 'test', 'development'].includes(c.remoteEnvironment ?? '') ? c.remoteEnvironment! : 'unknown',
      identity_namespace: userId ? ['yid', 'server_user_id'].includes(c.identityNamespace ?? '') ? c.identityNamespace! : 'server_user_id' : 'anonymous', identity_trust: 'client_asserted' };
    for (const [name, value] of Object.entries({ remote_owner_id: c.remoteOwnerId, owner_scope_id: c.ownerScopeId,
      device_id: c.deviceId, data_space_id: c.dataSpaceId })) if (opaque(value, name === 'owner_scope_id' ? 96 : 64)) common[name] = value;
    if (['personal', 'enterprise', 'anonymous', 'installation', 'unknown'].includes(c.scopeKind ?? '')) common.scope_kind = c.scopeKind!;
    for (const [name, value] of Object.entries({ data_generation: c.dataGeneration, sync_protocol_version: c.syncProtocolVersion })) {
      if (typeof value === 'string' && /^\d{1,20}$/u.test(value)) common[name] = value;
    }
    if (text(c.buildId)) common.build_id = c.buildId!;
    return { epoch: digest(c.epoch), common: Object.freeze(common), main: Object.freeze({ appVersion: c.appVersion,
      arch: text(c.arch), platform: text(c.platform), language: text(c.language, 16), firstKeyfrom: text(c.firstKeyfrom),
      latestKeyfrom: text(c.latestKeyfrom), installationId: opaque(c.installationId) ? c.installationId : null, userId, timestamp: this.now() }) };
  }

  capture(base: Record<string, unknown> = {}): RemoteTelemetryCapture {
    try {
      const snapshot = this.snapshotContext, generation = this.generation, defaults = sanitizeRemoteTelemetryFields(base);
      if (!snapshot || this.closed || this.stopping || this.identityMismatch(snapshot, base)) return noopCapture;
      const current = () => !this.closed && !this.stopping && generation === this.generation && snapshot.epoch === this.snapshotContext?.epoch;
      return {
        emit: (event, fields = {}) => { try { if (current() && !this.identityMismatch(snapshot, fields)) this.emit(snapshot, event, { ...defaults, ...sanitizeRemoteTelemetryFields(fields) }); } catch { this.increment('invalid_event'); } },
        request: (fields) => {
          try {
            if (!current() || this.identityMismatch(snapshot, fields)) return noopTracker();
            const clean = { ...defaults, ...sanitizeRemoteTelemetryFields(fields) }, logicalAttemptId = randomUUID();
            clean.logical_attempt_id = logicalAttemptId;
            const window = this.getWindow(S.Request, snapshot, { lane: clean.lane ?? 'unknown', request_family: clean.request_family ?? 'remote_json' });
            this.add(window, 'attempt_started'); window.inflight++;
            let finished = false, started = false;
            const at = this.mono();
            return { logicalAttemptId,
              transportStarted: () => { if (!current() || finished) return; const w = this.getWindow(S.Request, snapshot, window.fields);
                if (!started) this.add(w, 'transport_started'); this.add(w, 'transport_attempt_count'); started = true; },
              finish: (result, fields = {}) => {
                try {
                  if (!current() || finished || this.identityMismatch(snapshot, fields)) return; finished = true;
                  const outcome = telemetryResults.has(result) ? result : R.Unknown;
                  const w = this.getWindow(S.Request, snapshot, window.fields); w.inflight = Math.max(0, w.inflight - 1); this.add(w, outcome);
                  this.addMeasurements(w, { ...clean, ...sanitizeRemoteTelemetryFields(fields) });
                  this.emit(snapshot, E.Request, { ...clean, ...sanitizeRemoteTelemetryFields(fields), result: outcome,
                    failure_stage: outcome === R.Deferred ? 'local_admission' : sanitizeRemoteTelemetryFields(fields).failure_stage ?? (outcome === R.ApiOk || outcome === R.TransferOk ? 'none'
                      : outcome === R.Deferred ? 'local_admission' : outcome === R.Preflight ? 'before_send'
                        : outcome === R.Processing ? 'local_processing' : outcome === R.ContextChanged ? 'context' : 'transport'),
                    logical_attempt_id: logicalAttemptId, duration_ms: Math.max(0, this.mono() - at) }, true);
                } catch { this.increment('invalid_event'); }
              } };
          } catch { return noopTracker(); }
        },
      };
    } catch { return noopCapture; }
  }

  private identityMismatch(snapshot: Snapshot, fields: Record<string, unknown>): boolean {
    for (const [camel, key] of Object.entries({ remoteOwnerId: 'remote_owner_id', ownerScopeId: 'owner_scope_id', deviceId: 'device_id', dataSpaceId: 'data_space_id' })) {
      const value = fields[camel] ?? fields[key];
      if (value !== undefined && value !== null && value !== snapshot.common[key]) return true;
    }
    return false;
  }

  private getWindow(kind: string, snapshot: Snapshot, fields: TelemetryFields = {}): WindowEntry {
    const dimensions: TelemetryFields = {};
    for (const key of ['lane', 'request_family', 'direction', 'stage', 'phase', 'operation_kind', 'publication_kind', 'representation']) if (fields[key] !== undefined) dimensions[key] = fields[key];
    const key = JSON.stringify([kind, dimensions]);
    let entry = this.windows.get(key);
    if (!entry) {
      const counts: Record<string, number> = kind === S.Request ? Object.fromEntries(['attempt_started', 'transport_started', 'transport_attempt_count', ...telemetryResults].map(key => [key, 0])) : {};
      entry = { kind, snapshot, fields: dimensions, counts, start: this.now(), mono: this.mono(), inflight: 0, inflightStart: 0, observed: false };
      if (this.windows.size >= L.Groups) this.increment('overflow'); else this.windows.set(key, entry);
    }
    return entry;
  }
  private add(window: WindowEntry, name: string, value = 1): void {
    window.observed = true; window.counts[name] = Math.min(Number.MAX_SAFE_INTEGER, (window.counts[name] ?? 0) + value);
  }
  private addMeasurements(window: WindowEntry, fields: TelemetryFields): void {
    // Only observed quantities are accumulated; missing measurements remain absent.
    for (const key of ['bytes', 'request_bytes', 'response_bytes', 'attachment_count', 'part_count', 'record_count', 'count', 'scanned', 'processed', 'skipped_count', 'valid_count', 'invalid_count']) {
      const value = fields[key];
      if (typeof value === 'number') this.add(window, key, value);
    }
  }
  private increment(name: string, value = 1): void { this.stats[name] = Math.min(Number.MAX_SAFE_INTEGER, (this.stats[name] ?? 0) + value); }

  private emit(snapshot: Snapshot, event: string, fields: TelemetryFields, requestCounted = false): void {
    if (!telemetryEvents.has(event) && !telemetrySummaries.has(event)) { this.increment('invalid_event'); return; }
    for (const key of ['remote_owner_id', 'owner_scope_id', 'device_id', 'data_space_id']) {
      if (fields[key] !== undefined && snapshot.common[key] !== undefined && fields[key] !== snapshot.common[key]) { this.increment('invalid_event'); return; }
    }
    this.increment('accepted');
    if (event === E.Health || telemetrySummaries.has(event)) {
      const kind = event === E.Health ? S.SyncHealth : event;
      const w = this.getWindow(kind, snapshot, fields); w.fields = { ...w.fields, ...fields }; w.observed = true; return;
    }
    if (event === E.Request && !requestCounted) { this.increment('invalid_event'); return; }
    const kind = event.startsWith('desktop.') ? S.Execution : event.startsWith('remote.publication.') ? S.Publication
      : event === E.File || event === E.Preparation ? S.File : S.SyncStage;
    if (event !== E.Request && event !== E.Ui) {
      const w = this.getWindow(kind, snapshot, fields);
      let counter = String(kind === S.Publication ? fields.business_status ?? fields.outcome ?? 'unknown' : fields.outcome ?? fields.business_status ?? fields.to_state ?? 'observed_count');
      if (event === E.CommandPrepared) counter = 'command_prepared'; else if (event === E.CommandDuplicate) counter = 'command_duplicate';
      else if (event === E.CommandUnknown) counter = 'command_unknown'; else if (event === E.CommandReceipt) counter = 'command_receipt_confirmed';
      else if (event === E.OutcomeUnknown) counter = 'run_unknown'; else if (event === E.Dispatch) counter = 'dispatch_attempted'; else if (event === E.EngineAccepted) counter = 'engine_accepted';
      else if (event === E.Terminal) counter = `run_${fields.business_status ?? 'unknown'}`;
      else if (event === E.PersistFailed) counter = 'persist_failed'; else if (event === E.MessagePersisted) counter = 'persisted'; else if (event === E.FinalPersisted) counter = 'persisted';
      else if (event === E.Sealed) counter = 'sealed'; else if (event === E.PublicationUnknown) counter = 'unknown'; else if (event === E.Quarantined) counter = 'isolated'; else if (event === E.Recovered) counter = 'recovered';
      this.add(w, telemetryCounterNames.has(counter) ? counter : 'observed_count');
      this.addMeasurements(w, fields);
    }
    if (event === E.MessagePersisted) { this.increment('aggregated'); return; }
    const failure = isFailure(fields) || event.includes('unknown') || event.includes('failed') || event === E.Quarantined;
    const aggregateSuccess = [E.SyncStage, E.File, E.Preparation].includes(event as typeof E.SyncStage) && !failure;
    if (aggregateSuccess) { this.increment('aggregated'); return; }
    if (!remoteTelemetryHasRequired(event, fields)) { this.increment('invalid_event'); return; }
    // Business correlation IDs are emitted only with trustworthy owner context.
    const correlated = ['command_id', 'run_id', 'local_session_id', 'session_id', 'operation_id', 'asset_id', 'preparation_id'].some(key => fields[key] !== undefined);
    if (correlated && !snapshot.common.remote_owner_id) { this.increment('invalid_event'); return; }
    let probability = 1;
    if ((event === E.Request && [R.ApiOk, R.TransferOk].includes(fields.result as typeof R.ApiOk))
      || ([E.Sealed, E.Acknowledged].includes(event as typeof E.Sealed) && fields.lane === 'live' && fields.phase !== 'final' && !failure)) {
      probability = 0.01;
      if (!sampled(String(fields.operation_id ?? fields.command_id ?? fields.request_id ?? fields.logical_attempt_id))) { this.increment('sampled_out'); return; }
    }
    if (failure) {
      const key = JSON.stringify([event, fields.lane, fields.operation, fields.stage, fields.failure_scope, fields.reason, fields.transport_failure,
        fields.local_session_id ?? fields.session_id ?? fields.command_id ?? fields.operation_id,
        fields.result, fields.failure_stage, fields.http_status, fields.business_code]);
      const existing = this.groups.get(key);
      if (existing && this.now() - existing.at < L.WindowMs) { existing.duplicates++; existing.last = this.now(); this.increment('aggregated'); return; }
      if (this.groups.size >= L.Groups) { this.increment('overflow'); this.increment('aggregated'); return; }
      this.groups.set(key, { event, fields, snapshot, at: this.now(), last: this.now(), duplicates: 0 });
    }
    const priority = probability < 1 ? Priorities.Detail : Priorities.Critical;
    this.enqueue(this.createEntry(snapshot, event, fields, probability, 1, priority));
  }

  private createEntry(snapshot: Snapshot, event: string, fields: TelemetryFields, probability: number, represented: number, priority: number): RecordEntry {
    const now = this.now(), eventId = randomUUID(), summary = telemetrySummaries.has(event), ui = event === E.Ui;
    const clean: TelemetryFields = { ...fields, ...snapshot.common, action: summary ? A.Summary : ui ? A.Ui : A.Runtime,
      telemetry_schema_version: 1, sampling_policy_version: 1, eventId, process_instance_id: this.processId, event_seq: String(++this.eventSeq),
      sample_probability: probability, represented_count: represented, sampling_unit: summary ? 'window' : probability < 1 ? 'operation' : 'event' };
    if (summary) clean.summary_kind = event; else if (!ui) clean.event_name = event;
    return { eventId, epoch: snapshot.epoch, createdAt: now, fields: clean,
      context: { ...snapshot.main, timestamp: now }, priority, attempts: 0, nextAt: now, expiresAt: now + L.TtlMs };
  }

  private encode(entry: RecordEntry): string | null {
    if (!entry.context.installationId) return null;
    const url = new URL(buildMainLogUrl(entry.fields as MainLogEventParams, entry.context));
    for (const key of ['firstKeyfrom', 'latestKeyfrom', 'keyfrom', 'language']) if (!url.searchParams.get(key)) url.searchParams.delete(key);
    const optional = ['firstKeyfrom', 'latestKeyfrom', 'keyfrom', 'language', 'build_id', 'request_bytes', 'response_bytes', 'bytes', 'duration_ms'];
    for (const key of optional) {
      if (Buffer.byteLength(url.href) <= L.UrlBytes) break;
      if (key === 'duration_ms' && entry.fields.event_name === E.Request) continue;
      url.searchParams.delete(key);
    }
    return Buffer.byteLength(url.href) <= L.UrlBytes ? url.href : null;
  }

  private enqueue(entry: RecordEntry, restored = false): boolean {
    if (this.closed || !this.snapshotContext || entry.epoch !== this.snapshotContext.epoch) return false;
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (size > L.EventBytes || (entry.context.installationId && !this.encode(entry))) { this.increment('oversized'); return false; }
    const capacity = (): boolean => {
      const summaries = this.queue.filter(v => v.priority === Priorities.Summary).length;
      const reserved = entry.priority === Priorities.Summary ? 0 : Math.max(0, SummaryReserve - summaries);
      const ordinary = this.queue.filter(v => v.priority !== Priorities.Critical).length;
      return this.queue.length < L.Queue - reserved && this.queueBytes + size <= L.QueueBytes - reserved * L.EventBytes
        && (entry.priority === Priorities.Critical || ordinary < L.Ordinary);
    };
    while (!capacity() && entry.priority > Priorities.Detail) {
      // Do not evict denominator/quality summaries when critical detail floods the queue.
      const index = this.queue.findIndex(v => v.eventId !== this.activeId && v.priority === Priorities.Detail);
      if (index < 0) break;
      this.remove(index); this.increment('dropped');
    }
    if (!capacity()) {
      this.increment(entry.priority === Priorities.Critical ? 'critical_dropped' : 'dropped'); return false;
    }
    if (this.queue.some(v => v.eventId === entry.eventId)) return true;
    this.queue.push(entry); this.queueBytes += size; this.increment(restored ? 'cached_recovered' : 'queued');
    this.persist(); return true;
  }
  private remove(index: number): void {
    if (index < 0) return;
    const [entry] = this.queue.splice(index, 1);
    if (entry) this.queueBytes = Math.max(0, this.queueBytes - Buffer.byteLength(JSON.stringify(entry)));
  }
  private persist(): void { if (this.storageReady && !this.restoring) this.spool?.replace(this.queue.filter(v => v.priority >= Priorities.Summary)); }

  flushWindows(): void {
    try {
      if (!this.snapshotContext || this.closed) return;
      const now = this.now();
      for (const [key, group] of this.groups) if (now - group.at >= L.WindowMs) {
        if (group.duplicates) this.enqueue(this.createEntry(group.snapshot, group.event, { ...group.fields, first_ts_ms: group.at, last_ts_ms: group.last }, 1, group.duplicates, Priorities.Summary));
        this.groups.delete(key);
      }
      for (const w of this.windows.values()) {
        if (!w.observed && !w.inflight) continue;
        const duration = Math.max(0, this.mono() - w.mono);
        if (duration < L.WindowMs) continue;
        const values: TelemetryFields = { ...w.fields, ...w.counts, coverage: 'partial', window_seq: String(++this.windowSeq),
          window_start_ms: w.start, window_ms: duration, clock_quality: Math.abs(now - w.start - duration) > 5000 ? 'jumped' : 'normal' };
        if (w.kind === S.Request) { values.inflight_start = w.inflightStart; values.inflight_end = w.inflight; }
        if (this.enqueue(this.createEntry(w.snapshot, w.kind, values, 1, 1, Priorities.Summary)) || duration >= L.HealthMs) {
          if (duration >= L.HealthMs) this.increment('summary_merged');
          w.counts = w.kind === S.Request ? Object.fromEntries(Object.keys(w.counts).map(key => [key, 0])) : {}; w.start = now; w.mono = this.mono(); w.inflightStart = w.inflight; w.observed = false;
        }
      }
      this.lastWindow = now;
    } catch { this.increment('invalid_event'); }
  }

  private emitHealth(): void {
    const snapshot = this.snapshotContext; if (!snapshot) return;
    const values: TelemetryFields = { ...this.stats, coverage: 'partial', coverage_profile: 'partial', queue_size: this.queue.length,
      queue_bytes: this.queueBytes, oldest_queue_age_ms: this.queue.length ? Math.max(0, this.now() - Math.min(...this.queue.map(v => v.createdAt))) : 0,
      window_seq: String(++this.windowSeq), window_start_ms: this.lastHealth, window_ms: Math.max(0, this.now() - this.lastHealth) };
    if (this.enqueue(this.createEntry(snapshot, S.Telemetry, values, 1, 1, Priorities.Summary))) {
      for (const key of Object.keys(this.stats)) this.stats[key] = 0;
      this.lastHealth = this.now();
    }
  }
  tick(): void {
    if (this.closed || !this.snapshotContext) return;
    if (this.now() - this.lastWindow >= L.WindowMs) this.flushWindows();
    if (this.now() - this.lastHealth >= L.HealthMs) this.emitHealth();
    void this.pump().catch(() => this.increment('upload_failed'));
  }
  async pump(): Promise<void> {
    if (this.sending || this.closed || !this.snapshotContext || this.restoring) return;
    const now = this.now();
    for (let index = this.queue.length - 1; index >= 0; index--) if (this.queue[index].expiresAt <= now) { this.remove(index); this.increment('expired'); }
    this.tokens = Math.min(4, this.tokens + Math.max(0, now - this.tokenAt) / 3000); this.tokenAt = now;
    if (this.tokens < 1 || now < this.circuitUntil) return;
    let entry: RecordEntry | undefined;
    for (let round = 0; round < Schedule.length; round++) {
      const priority = Schedule[this.scheduleIndex++ % Schedule.length];
      const lanes = ['control', 'live', 'history', 'files', 'transport', 'background', 'unknown'];
      const cursor = this.laneCursor.get(priority) ?? 0;
      for (let offset = 0; offset < lanes.length; offset++) {
        const index = (cursor + offset) % lanes.length;
        entry = this.queue.find(v => v.priority === priority && (v.fields.lane ?? 'unknown') === lanes[index] && v.nextAt <= now);
        if (entry) { this.laneCursor.set(priority, (index + 1) % lanes.length); break; }
      }
      if (entry) break;
    }
    if (!entry) return;
    if (!entry.context.installationId) {
      // Only the installation UUID may be supplied later; account fields remain frozen.
      if (this.snapshotContext.main.installationId) entry.context = { ...entry.context, installationId: this.snapshotContext.main.installationId };
      else return;
    }
    const url = this.encode(entry);
    if (!url) { this.remove(this.queue.indexOf(entry)); this.increment('oversized'); this.persist(); return; }
    this.tokens--; this.sending = true; this.activeId = entry.eventId; this.abort = new AbortController();
    const generation = this.generation;
    entry.attempts++; this.persist();
    try {
      const result = await sendFrozenMainLogEvent({ url }, { fetch: this.options.fetch, signal: this.abort.signal, now: this.now });
      if (generation !== this.generation || this.closed) return;
      if (result.outcome === FrozenLogOutcome.Sent) {
        this.increment('upload_ok'); this.failures = 0; this.circuitUntil = 0; this.remove(this.queue.indexOf(entry));
      } else if (result.outcome === FrozenLogOutcome.Cancelled) { /* A generation change handles removal. */ }
      else {
        this.increment('upload_failed'); this.failures++;
        if (result.outcome === FrozenLogOutcome.Rejected || entry.attempts >= 6) {
          this.remove(this.queue.indexOf(entry)); this.increment('dropped');
        } else {
          const jitter = 1 + Math.max(0, Math.min(1, this.options.random?.() ?? Math.random())) * 0.2;
          entry.nextAt = now + Math.max(RetryDelays[entry.attempts - 1] * jitter, result.retryAfterMs ?? 0);
        }
        if (this.failures >= 3) this.circuitUntil = Math.max(now + L.HealthMs, entry.nextAt, now + (result.retryAfterMs ?? 0));
        else if (result.status === 429) this.circuitUntil = Math.max(this.circuitUntil, now + (result.retryAfterMs ?? 0));
      }
    } finally { this.sending = false; this.activeId = null; this.abort = null; this.queueBytes = this.queue.reduce((sum, v) => sum + Buffer.byteLength(JSON.stringify(v)), 0); this.persist(); }
  }

  private async restore(generation: number): Promise<void> {
    const current = () => generation === this.generation && !this.closed && !!this.snapshotContext;
    const entries = await this.spool!.restore(value => this.validateRestored(value), current);
    this.restoring = false;
    if (current()) for (const value of entries) this.enqueue(value, true);
    if (!this.closed) this.persist();
  }
  private validateRestored(value: unknown): RecordEntry | null {
    if (!value || typeof value !== 'object') return null;
    const e = value as RecordEntry;
    if (!this.snapshotContext || e.epoch !== this.snapshotContext.epoch || !uuid(e.eventId) || !e.fields || !e.context
      || !Number.isFinite(e.createdAt) || e.createdAt > this.now() || !Number.isFinite(e.expiresAt) || e.expiresAt <= this.now()
      || e.expiresAt > e.createdAt + L.TtlMs || !Number.isInteger(e.attempts) || e.attempts < 0 || e.attempts >= 6
      || !Number.isFinite(e.nextAt) || ![1, 2].includes(e.priority) || Buffer.byteLength(JSON.stringify(e)) > L.EventBytes) return null;
    const name = e.fields.event_name ?? e.fields.summary_kind ?? (e.fields.action === A.Ui ? E.Ui : '');
    if (typeof name !== 'string' || (!telemetryEvents.has(name) && !telemetrySummaries.has(name))) return null;
    // Reject tampering/old schema, never silently rewrite a persisted event under the same ID.
    const safeFields = sanitizeRemoteTelemetryFields(e.fields);
    const context = e.context;
    if (context.userId !== this.snapshotContext.main.userId || context.installationId !== this.snapshotContext.main.installationId
      || context.timestamp !== e.createdAt || !text(context.appVersion) || !opaque(context.installationId)) return null;
    for (const key of ['arch', 'platform', 'firstKeyfrom', 'latestKeyfrom', 'language'] as const) {
      if (typeof context[key] !== 'string' || (context[key] !== '' && !text(context[key]))) return null;
    }
    const common = this.captureContext({ epoch: 'validation', enabled: true, installationId: context.installationId,
      appVersion: context.appVersion, environment: e.fields.environment as RemoteTelemetryContext['environment'],
      remoteEnvironment: String(e.fields.remote_environment), userId: context.userId,
      identityNamespace: e.fields.identity_namespace as RemoteTelemetryContext['identityNamespace'],
      remoteOwnerId: e.fields.remote_owner_id as string | undefined, ownerScopeId: e.fields.owner_scope_id as string | undefined,
      scopeKind: e.fields.scope_kind as string | undefined, deviceId: e.fields.device_id as string | undefined,
      dataSpaceId: e.fields.data_space_id as string | undefined, dataGeneration: e.fields.data_generation as string | undefined,
      syncProtocolVersion: e.fields.sync_protocol_version as string | undefined, buildId: e.fields.build_id as string | undefined });
    if (!common) return null;
    for (const key of ['remote_owner_id', 'owner_scope_id', 'scope_kind', 'data_space_id', 'data_generation']) {
      if (e.fields[key] !== undefined && e.fields[key] !== this.snapshotContext.common[key]) return null;
    }
    Object.assign(safeFields, common.common);
    safeFields.action = telemetrySummaries.has(name) ? A.Summary : name === E.Ui ? A.Ui : A.Runtime;
    if (telemetrySummaries.has(name)) safeFields.summary_kind = name; else if (name !== E.Ui) safeFields.event_name = name;
    safeFields.telemetry_schema_version = 1; safeFields.sampling_policy_version = 1; safeFields.eventId = e.eventId;
    for (const key of ['window_seq', 'event_seq']) if (typeof e.fields[key] === 'string' && /^\d{1,20}$/u.test(e.fields[key])) safeFields[key] = e.fields[key];
    for (const key of ['window_start_ms', 'window_ms', 'sample_probability', 'represented_count']) {
      if (typeof e.fields[key] === 'number' && Number.isFinite(e.fields[key]) && e.fields[key] >= 0) safeFields[key] = e.fields[key];
    }
    if (uuid(e.fields.process_instance_id)) safeFields.process_instance_id = e.fields.process_instance_id;
    if (['window', 'event', 'operation'].includes(String(e.fields.sampling_unit))) safeFields.sampling_unit = e.fields.sampling_unit;
    if (!safeFields.event_seq || !safeFields.process_instance_id || safeFields.sample_probability === undefined
      || safeFields.represented_count === undefined || !safeFields.sampling_unit) return null;
    for (const key of Object.keys(e.fields)) if (safeFields[key] !== e.fields[key]) return null;
    for (const key of Object.keys(safeFields)) if (e.fields[key] !== safeFields[key]) return null;
    if (!telemetrySummaries.has(name) && !remoteTelemetryHasRequired(name, safeFields)) return null;
    const safe = { ...e, fields: { ...e.fields }, context: { ...e.context } };
    return this.encode(safe) ? safe : null;
  }

  snapshot(): { queued: number; bytes: number; sending: boolean; stats: Record<string, number>; groups: number; windows: number } {
    return { queued: this.queue.length, bytes: this.queueBytes, sending: this.sending, stats: { ...this.stats }, groups: this.groups.size, windows: this.windows.size };
  }
  async shutdown(): Promise<void> {
    if (this.closed || this.stopping) return;
    this.flushWindows(); this.stopping = true; this.abort?.abort();
    if (this.timer) clearInterval(this.timer); this.timer = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async (): Promise<void> => {
      await this.restorePromise;
      this.closed = true; this.generation++; this.restoring = false; this.persist();
      await this.spool?.flush();
    };
    await Promise.race([flush(), new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
    this.closed = true;
    if (timer) clearTimeout(timer);
  }
}
let remoteTelemetry: RemoteTelemetry | null = null;
export function configureRemoteTelemetry(options: RemoteTelemetryOptions): RemoteTelemetry | null {
  try { if (!remoteTelemetry) remoteTelemetry = new RemoteTelemetry(options); else remoteTelemetry.updateContext(options.context); return remoteTelemetry; }
  catch { return null; }
}
export function updateRemoteTelemetryContext(context: RemoteTelemetryContext): void { try { remoteTelemetry?.updateContext(context); } catch { /* Best effort. */ } }
export function captureRemoteTelemetry(base?: Record<string, unknown>): RemoteTelemetryCapture { try { return remoteTelemetry?.capture(base) ?? noopCapture; } catch { return noopCapture; } }
export function remoteTelemetryEvent(event: string, fields: Record<string, unknown> = {}): void { captureRemoteTelemetry().emit(event, fields); }
export async function shutdownRemoteTelemetry(): Promise<void> { try { await remoteTelemetry?.shutdown(); } catch { /* Bounded shutdown. */ } finally { remoteTelemetry = null; } }
