import { randomUUID } from 'crypto';

import { LogReporterAction } from '../../shared/analytics/constants';
import {
  catalogAnalyticsId,
  UsageAnalytics,
  type UsageContext,
  usageFailureCode,
  UsageOutcome,
  UsageStage,
} from '../../shared/analytics/usage';
import type { MediaConfirmationEvent } from '../../shared/media/confirmation';
import { MediaProtocol, MediaTaskStatus, TERMINAL_MEDIA_TASK_STATUSES } from '../../shared/media/constants';
import { mediaFailureFields } from '../../shared/media/usage';
import type { MainLogEventParams } from './mainLogReporter';
import type { MediaUsageRecord, MediaUsageStore } from './mediaUsageStore';

const MediaAction = { Generate: 'generate', Cancel: 'cancel' } as const;

interface MediaJob extends MediaUsageRecord {
  owner: string;
  epoch: number;
  confirmationStartedAt?: number;
  confirmationResolved?: boolean;
  confirmationEvents?: Set<string>;
}

interface MediaResult {
  isError?: boolean;
  details?: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
}

export class MediaUsageAnalytics {
  private readonly jobs = new Map<string, MediaJob>();
  private epoch = 0;

  constructor(
    private readonly deps: {
      getOwner: () => string | null;
      getScope?: () => string;
      store?: MediaUsageStore;
      context: (sessionId: string) => UsageContext | undefined;
      report: (event: MainLogEventParams) => void;
      now?: () => number;
    },
  ) {}

  async run<T extends MediaResult>(
    info: {
      sessionId: string | null;
      mediaType: string;
      action: string;
      selectionSource?: string;
      policyVersion?: string;
      taskId?: unknown;
      callId: string;
    },
    invoke: () => Promise<T>,
  ): Promise<T> {
    let job: MediaJob | undefined;
    this.safe(() => {
      const owner = this.deps.getOwner();
      if (owner === null) return;
      if (info.action === MediaAction.Generate) {
        job = this.find(info.callId);
        if (job) return;
        job = {
          id: randomUUID(),
          owner,
          epoch: this.epoch,
          scope: this.deps.getScope?.() ?? owner,
          aliases: [info.callId],
          attemptCount: 0,
          context: info.sessionId ? this.deps.context(info.sessionId) : undefined,
          mediaType: info.mediaType,
          selectionSource: info.selectionSource,
          policyVersion: info.policyVersion,
          startedAt: this.now(),
          terminal: false,
          saved: false,
          accepted: false,
        };
        this.jobs.set(info.callId, job);
        this.trim();
        this.emit(job, UsageStage.Start, UsageOutcome.Started);
      } else if (typeof info.taskId === 'string') job = this.find(info.taskId);
    });
    try {
      const result = await invoke();
      this.safe(() => {
        if (!job || !this.current(job)) return;
        // A successful cancel API call acknowledges intent, not a terminal generation state.
        if (info.action === MediaAction.Cancel) return;
        const details = result.details ?? {};
        const status = typeof details.status === 'string' ? details.status : '';
        if (info.action === MediaAction.Generate) {
          if (details.submissionUnknown === true) {
            this.unconfirmed(job);
            return;
          }
          if (result.isError) {
            const reason = [
              details.reason,
              ...(Array.isArray(details.warnings) ? details.warnings : []),
              ...result.content.map(item => item.text),
            ]
              .filter(item => typeof item === 'string')
              .join(' ');
            this.failure(job, reason, status, mediaFailureFields(details));
            return;
          }
          this.accept(info.callId, details);
          if (!job.accepted) { this.unconfirmed(job); return; }
        }
        const assets = Array.isArray(details.assets) ? details.assets : [];
        this.terminal(job, status, assets.length);
        if (status === MediaTaskStatus.Succeeded && job.attemptCount === 0) {
          const saved = assets.filter(
            asset => asset && typeof asset === 'object' && 'filePath' in asset,
          ).length;
          this.persisted(job, saved, job.outputCount ?? assets.length);
        }
      });
      return result;
    } catch (error) {
      this.safe(() => {
        if (job && info.action === MediaAction.Generate) this.failure(job, error);
      });
      throw error;
    }
  }

  observe(taskId: string, status: string, count: number): void {
    this.safe(() => {
      const job = this.find(taskId);
      if (job) this.terminal(job, status, count);
    });
  }

  attribution(taskId: unknown): { context: UsageContext; mediaJobId: string } | undefined {
    try {
      const job = typeof taskId === 'string' ? this.find(taskId) : undefined;
      if (job?.context && job.owner === this.deps.getOwner()) return { context: job.context, mediaJobId: job.id };
    } catch { /* A missing attribution must not block delivery. */ }
    return undefined;
  }

  accept(callId: string, task: Record<string, unknown>): void {
    this.safe(() => {
      const job = this.find(callId);
      if (!job || (job.terminal && !job.accepted)
        || !((typeof task.taskId === 'string' && task.taskId.length > 0) || typeof task.taskId === 'number')) return;
      const modelId = catalogAnalyticsId(task.upstreamModel ?? task.model) ?? job.modelId;
      const protocol = typeof task.protocolVersion === 'number' ? task.protocolVersion : job.protocolVersion;
      let changed = modelId !== job.modelId || protocol !== job.protocolVersion;
      job.modelId = modelId;
      job.protocolVersion = protocol;
      for (const alias of [task.taskId, task.upstreamTaskId]) {
        if (typeof alias === 'string' || typeof alias === 'number') {
          const key = String(alias);
          this.jobs.set(key, job);
          if (!job.aliases.includes(key)) { job.aliases.push(key); changed = true; }
        }
      }
      if (!job.accepted) {
        job.accepted = true;
        this.emit(job, UsageStage.Accepted, UsageOutcome.Succeeded);
      } else if (changed) this.persist(job);
      this.trim();
      this.terminal(
        job,
        String(task.status),
        Array.isArray(task.resultUrls) ? task.resultUrls.length : Array.isArray(task.assets) ? task.assets.length : 0,
      );
    });
  }

  confirmation(
    callId: string,
    outcome: typeof UsageOutcome.Requested | typeof UsageOutcome.Allowed | typeof UsageOutcome.Denied,
    modelId?: string,
  ): void {
    this.safe(() => {
      const job = this.find(callId);
      if (!job || job.owner !== this.deps.getOwner() || job.accepted || job.terminal) return;
      if (outcome === UsageOutcome.Requested) {
        if (job.confirmationStartedAt !== undefined) return;
        job.confirmationStartedAt = this.now();
        job.modelId = catalogAnalyticsId(modelId);
      } else {
        if (job.confirmationStartedAt === undefined || job.confirmationResolved) return;
        job.confirmationResolved = true;
      }
      this.emit(job, UsageStage.Confirmation, outcome, {
        durationMs: Math.max(0, this.now() - job.confirmationStartedAt),
      });
    });
  }

  confirmationEvent(callId: string, event: MediaConfirmationEvent, modelId: string): void {
    this.safe(() => {
      const job = this.find(callId);
      if (!job || !this.current(job) || job.accepted || job.terminal) return;
      const key = event.outcome + ':' + event.count;
      job.confirmationEvents ??= new Set();
      if (job.confirmationEvents.has(key)) return;
      job.confirmationEvents.add(key);
      job.modelId = catalogAnalyticsId(modelId);
      this.emit(job, UsageStage.Confirmation, event.outcome, {
        durationMs: event.durationMs, count: event.count, failureCode: event.failureCode,
        ...(event.failureCode ? { failureStage: UsageStage.Confirmation } : {}),
      });
    });
  }

  save(taskId: string, savedCount: number, outputCount: number): void {
    this.safe(() => {
      const job = this.find(taskId);
      if (job) this.persisted(job, savedCount, outputCount);
    });
  }

  submitting(callId: string, protocolVersion: number, modelId: string): void {
    this.safe(() => {
      const job = this.find(callId);
      if (!job || job.accepted || job.terminal) return;
      job.protocolVersion = protocolVersion;
      job.modelId = catalogAnalyticsId(modelId);
      this.emit(job, UsageStage.Submit, UsageOutcome.Started);
    });
  }

  reject(callId: string, error: unknown, fields: Record<string, string> = {}): void {
    this.safe(() => { const job = this.find(callId); if (job) this.failure(job, error, undefined, mediaFailureFields(fields)); });
  }

  clear(): void {
    this.epoch += 1;
    this.jobs.clear();
    this.safe(() => this.deps.store?.clear());
  }

  private unconfirmed(job: MediaJob): void {
    if (job.submissionUnknown) return;
    job.submissionUnknown = true;
    this.emit(job, UsageStage.Submit, UsageOutcome.Unknown);
  }

  private terminal(job: MediaJob, status: string, outputCount: number): void {
    if (!this.current(job) || job.terminal || !TERMINAL_MEDIA_TASK_STATUSES.has(status)) return;
    job.terminal = true;
    job.outputCount = outputCount;
    job.generatedSuccessfully = status === MediaTaskStatus.Succeeded;
    this.emit(
      job,
      UsageStage.Generated,
      status === MediaTaskStatus.Succeeded
        ? UsageOutcome.Succeeded
        : status === MediaTaskStatus.Cancelled
          ? UsageOutcome.Cancelled
          : status === MediaTaskStatus.Timeout
            ? UsageOutcome.Timeout
            : UsageOutcome.Failed,
      { outputCount },
    );
  }

  private persisted(job: MediaJob, savedCount: number, outputCount: number): void {
    if (!this.current(job) || job.saved) return;
    const succeeded = savedCount > 0 && savedCount === outputCount;
    job.attemptCount += 1;
    job.saved = succeeded || job.protocolVersion !== MediaProtocol.Durable;
    this.emit(
      job,
      job.saved ? UsageStage.Saved : UsageStage.DeliveryAttempt,
      succeeded ? UsageOutcome.Succeeded : UsageOutcome.Failed,
      {
        savedCount,
        outputCount,
        partial: savedCount > 0 && savedCount < outputCount,
        attemptCount: job.attemptCount,
        failureCode:
          savedCount === outputCount && outputCount > 0 ? undefined : 'delivery_incomplete',
      },
    );
  }

  private emit(
    job: MediaJob,
    stage: UsageStage,
    outcome: UsageOutcome | MediaConfirmationEvent['outcome'],
    fields: Record<string, string | number | boolean | undefined> = {},
  ): void {
    if (!this.current(job)) return;
    this.persist(job);
    this.deps.report({
      action: LogReporterAction.MediaLifecycle,
      schemaVersion: UsageAnalytics.MediaSchemaVersion,
      ...job.context,
      mediaJobId: job.id,
      mediaType: job.mediaType,
      modelId: job.modelId,
      selectionSource: job.selectionSource,
      policyVersion: job.policyVersion,
      protocolVersion: job.protocolVersion,
      stage,
      outcome,
      durationMs: Math.max(0, this.now() - job.startedAt),
      ...fields,
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private failure(job: MediaJob, error: unknown, status?: string, fields: Record<string, string> = {}): void {
    if (!this.current(job)) return;
    const stage = !job.accepted
      ? UsageStage.Accepted
      : job.generatedSuccessfully
        ? UsageStage.Saved
        : UsageStage.End;
    if (stage === UsageStage.Saved && job.saved) return;
    if (stage === UsageStage.Saved && job.protocolVersion === MediaProtocol.Durable) {
      this.persisted(job, 0, job.outputCount ?? 0);
      return;
    }
    if (stage === UsageStage.Accepted) {
      if (job.terminal) return;
      job.terminal = true;
    }
    if (stage === UsageStage.Saved) job.saved = true;
    this.emit(
      job,
      stage,
      status === UsageOutcome.Cancelled ? UsageOutcome.Cancelled
        : status === UsageOutcome.Timeout ? UsageOutcome.Timeout
          : status === UsageOutcome.Interrupted ? UsageOutcome.Interrupted : UsageOutcome.Failed,
      { failureCode: usageFailureCode(error), ...fields },
    );
  }

  private trim(): void {
    while (this.jobs.size > UsageAnalytics.MaxTrackedItems)
      this.jobs.delete(this.jobs.keys().next().value!);
  }

  private current(job: MediaJob): boolean {
    return job.epoch === this.epoch && job.owner === this.deps.getOwner()
      && job.scope === (this.deps.getScope?.() ?? job.owner);
  }

  private find(alias: string): MediaJob | undefined {
    const owner = this.deps.getOwner();
    if (owner === null) { this.clear(); return undefined; }
    const scope = this.deps.getScope?.() ?? owner;
    const live = this.jobs.get(alias);
    if (live && this.current(live)) return live;
    let stored: MediaUsageRecord | undefined;
    try { stored = this.deps.store?.find(scope, alias); } catch { /* Continue without persisted attribution. */ }
    if (!stored) return undefined;
    const job: MediaJob = { ...stored, owner, epoch: this.epoch };
    for (const key of job.aliases) this.jobs.set(key, job);
    this.trim();
    return job;
  }

  private persist(job: MediaJob): void {
    if (job.protocolVersion !== MediaProtocol.Durable) return;
    try { this.deps.store?.save(job); } catch { /* Storage cannot suppress live telemetry. */ }
  }
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* Telemetry is best effort. */
    }
  }
}
