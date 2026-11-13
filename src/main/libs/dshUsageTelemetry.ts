import { randomUUID } from 'crypto';

import { LogReporterAction } from '../../shared/analytics/constants';
import {
  DSH_ANALYTICS_SCHEMA_VERSION,
  DSH_OBSERVER_READY_PREFIX,
  DSH_RUNTIME_SOURCE,
  DshObserverStatus,
  DshRequestApi,
  DshRuntimeEndReason,
  DshTelemetryStage,
} from '../../shared/dshEngine/analytics';
import { writeDshObservationPatch } from './dshObservationPlugin';
import type { MainLogEventParams, MainLogReporter, MainLogReportSnapshot, MainLogUrlContext } from './mainLogReporter';
import type { ProxyRequestObservation, ProxyRequestResult } from './openclawTokenProxy';

interface DshUsageTelemetryOptions {
  getReporter: () => MainLogReporter;
  getProxyBaseUrl: () => string | null;
  writePatch?: typeof writeDshObservationPatch;
}

export interface DshRuntimeObservation {
  instanceId: string;
  patchPath: string | null;
  observeOutput: (line: string) => void;
  ready: () => void;
  finish: (reason: DshRuntimeEndReason, errorCode?: string | null) => void;
}

interface RuntimeRecord {
  instanceId: string;
  version: string | null;
  sessionStoreShared: boolean;
  observerStatus: DshObserverStatus;
}

interface QueuedEvent {
  params: MainLogEventParams;
  snapshot: MainLogReportSnapshot;
  attempts: number;
}

const MAX_QUEUED_EVENTS = 128;
const MAX_EVENT_ATTEMPTS = 3;
const MAX_EVENT_AGE_MS = 60_000;
const RETRY_DELAY_MS = 1_000;

/** Best effort observation. All entry points isolate failures from business code. */
export class DshUsageTelemetry {
  private activeRuntime: RuntimeRecord | null = null;
  private readonly queue: QueuedEvent[] = [];
  private draining = false;

  constructor(private readonly options: DshUsageTelemetryOptions) {}

  startRuntime(input: { directory: string; version: string | null; sessionStoreShared: boolean }): DshRuntimeObservation | null {
    try {
      const record: RuntimeRecord = {
        instanceId: randomUUID(),
        version: input.version,
        sessionStoreShared: input.sessionStoreShared,
        observerStatus: DshObserverStatus.Unavailable,
      };
      let patchPath: string | null = null;
      try {
        const baseUrl = this.options.getProxyBaseUrl();
        if (baseUrl) {
          patchPath = (this.options.writePatch ?? writeDshObservationPatch)(input.directory, record.instanceId, baseUrl);
          record.observerStatus = DshObserverStatus.Prepared;
        }
      } catch {
        console.warn('[DshTelemetry] Observer unavailable; continuing with the original launch');
      }
      this.activeRuntime = record;
      const startedAt = Date.now();
      const context = this.captureContext();
      let ended = false;
      let ready = false;
      const emit = (stage: DshTelemetryStage, reason?: DshRuntimeEndReason, errorCode?: string | null) => {
        this.enqueue({
          action: LogReporterAction.DshRuntimeLifecycle,
          ...this.runtimeFields(record),
          stage,
          durationMs: Math.max(0, Date.now() - startedAt),
          reason,
          failureCode: errorCode ?? undefined,
        }, context);
      };
      emit(DshTelemetryStage.Start);
      return {
        instanceId: record.instanceId,
        patchPath,
        observeOutput: line => {
          if (!ended && line.trim() === DSH_OBSERVER_READY_PREFIX + record.instanceId) {
            record.observerStatus = DshObserverStatus.Active;
          }
        },
        ready: () => {
          if (ended || ready) return;
          ready = true;
          emit(DshTelemetryStage.Ready);
        },
        finish: (reason, errorCode) => {
          if (ended) return;
          ended = true;
          if (this.activeRuntime === record) this.activeRuntime = null;
          emit(DshTelemetryStage.End, reason, errorCode);
        },
      };
    } catch {
      console.warn('[DshTelemetry] Runtime observation unavailable');
      return null;
    }
  }

  observeRequest(request: ProxyRequestObservation): ((result: ProxyRequestResult) => void) | undefined {
    try {
      const runtime = this.activeRuntime;
      const requestApi = request.path === '/v1/chat/completions' ? DshRequestApi.ChatCompletions
        : request.path === '/v1/messages' ? DshRequestApi.Messages : null;
      if (!runtime || runtime.observerStatus !== DshObserverStatus.Active
        || request.dshInstanceId !== runtime.instanceId || request.method !== 'POST' || !requestApi) return;
      const context = this.captureContext();
      if (!context) return;
      // Copy at admission: shutdown/account switch cannot change a request's owner.
      const fields = {
        ...this.runtimeFields(runtime),
        clientTraceId: request.traceId,
        clientSpanId: request.spanId,
        requestApi,
        modelId: typeof request.model === 'string' && /^[\w.:/-]{1,128}$/.test(request.model)
          ? request.model : undefined,
      };
      this.enqueue({ action: LogReporterAction.DshModelRequest, ...fields, stage: DshTelemetryStage.Start }, context);
      let finished = false;
      return result => {
        if (finished) return;
        finished = true;
        this.enqueue({
          action: LogReporterAction.DshModelRequest,
          ...fields,
          stage: DshTelemetryStage.End,
          outcome: result.outcome,
          httpStatus: result.status ?? undefined,
          serverTraceId: result.serverTraceId ?? undefined,
          durationMs: result.durationMs,
        }, context);
      };
    } catch {
      console.debug('[DshTelemetry] Request observation skipped');
      return undefined;
    }
  }

  private runtimeFields(record: RuntimeRecord) {
    return {
      schemaVersion: DSH_ANALYTICS_SCHEMA_VERSION,
      runtimeSource: DSH_RUNTIME_SOURCE,
      dshInstanceId: record.instanceId,
      dshVersion: record.version ?? undefined,
      sessionStoreShared: record.sessionStoreShared,
      dshObserverStatus: record.observerStatus,
    };
  }

  private captureContext(): MainLogUrlContext | null {
    try {
      return this.options.getReporter().captureContext();
    } catch {
      return null;
    }
  }

  private enqueue(params: MainLogEventParams, context: MainLogUrlContext | null): void {
    try {
      if (!context || !this.captureContext()) return;
      if (this.queue.length >= MAX_QUEUED_EVENTS) {
        console.debug('[DshTelemetry] Observation queue full; event dropped');
        return;
      }
      this.queue.push({
        params,
        snapshot: { context: { ...context, timestamp: Date.now() }, eventId: randomUUID() },
        attempts: 0,
      });
      void this.drain();
    } catch {
      console.debug('[DshTelemetry] Observation could not be queued');
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        if (!this.captureContext()) {
          this.queue.length = 0;
          return;
        }
        const event = this.queue.shift()!;
        if (Date.now() - event.snapshot.context.timestamp > MAX_EVENT_AGE_MS) continue;
        let delivered = false;
        try {
          delivered = await this.options.getReporter().report(event.params, event.snapshot);
        } catch { /* Bounded retries also cover reporter setup failures. */ }
        event.attempts += 1;
        if (!delivered && event.attempts < MAX_EVENT_ATTEMPTS && this.queue.length < MAX_QUEUED_EVENTS) {
          this.queue.push(event);
          await new Promise<void>(resolve => { setTimeout(resolve, RETRY_DELAY_MS).unref(); });
        }
      }
    } catch {
      this.queue.length = 0;
      console.debug('[DshTelemetry] Observation delivery unavailable');
    } finally {
      this.draining = false;
    }
  }
}
