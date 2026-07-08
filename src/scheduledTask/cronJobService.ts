import { BrowserWindow } from 'electron';

import { parseChannelSessionKey } from '../main/libs/openclawChannelSessionSync';
import { PlatformRegistry } from '../shared/platform';
import type {
  DeliveryMode as DeliveryModeType,
  GatewayStatus as GatewayStatusType,
  SessionTarget as SessionTargetType,
  WakeMode as WakeModeType,
} from './constants';
import {
  DeliveryMode,
  GatewayStatus,
  InternalTaskMarker,
  IpcChannel,
  PayloadKind,
  ScheduleKind,
  TaskStatus,
} from './constants';
import type {
  RunFilter,
  Schedule,
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskPayload,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
  TaskState,
} from './types';

type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

interface GatewayScheduleAt {
  kind: 'at';
  at: string;
}

interface GatewayScheduleEvery {
  kind: 'every';
  everyMs: number;
  anchorMs?: number;
}

interface GatewayScheduleCron {
  kind: 'cron';
  expr: string;
  tz?: string;
  staggerMs?: number;
}

type GatewaySchedule = GatewayScheduleAt | GatewayScheduleEvery | GatewayScheduleCron;

type GatewayPayload =
  | {
      kind: 'agentTurn';
      message: string;
      timeoutSeconds?: number;
      model?: string;
      thinking?: string;
    }
  | {
      kind: 'systemEvent';
      text: string;
    };

interface GatewayDelivery {
  mode: DeliveryModeType;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
}

interface GatewayJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: GatewayStatusType;
  lastStatus?: GatewayStatusType;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  /** Delivery status from the last run. */
  lastDeliveryStatus?: string;
  /** Delivery error message from the last run. */
  lastDeliveryError?: string;
}

interface GatewayJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: GatewaySchedule;
  sessionTarget: SessionTargetType;
  wakeMode: WakeModeType;
  payload: GatewayPayload;
  delivery?: GatewayDelivery;
  agentId?: string | null;
  sessionKey?: string | null;
  state: GatewayJobState;
  createdAtMs: number;
  updatedAtMs: number;
}

interface GatewayRunLogEntry {
  ts: number;
  jobId: string;
  action?: string;
  status?: GatewayStatusType;
  error?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  jobName?: string;
  summary?: string;
  deliveryStatus?: string;
  deliveryError?: string;
}

interface CronJobServiceDeps {
  getGatewayClient: () => GatewayClientLike | null;
  ensureGatewayReady: () => Promise<void>;
}

/** Delivery routing summary cached per job for synchronous lookups. */
export interface ScheduledTaskJobDelivery {
  mode: DeliveryModeType;
  channel?: string;
}

type InternalScheduledTaskCandidate = {
  description?: string | null;
  payload?: {
    kind?: string;
    message?: string;
    text?: string;
  } | null;
};

export function isInternalScheduledTaskJob(job: InternalScheduledTaskCandidate): boolean {
  const description = job.description?.trim() ?? '';
  if (description.startsWith(InternalTaskMarker.MemoryCoreManagedDescriptionPrefix)) {
    return true;
  }

  const payload = job.payload;
  let payloadText: string | undefined;
  if (payload?.kind === PayloadKind.SystemEvent) {
    payloadText = payload.text;
  } else if (payload?.kind === PayloadKind.AgentTurn) {
    payloadText = payload.message;
  }

  return (
    typeof payloadText === 'string' &&
    payloadText.trim().startsWith(InternalTaskMarker.MemoryCorePayloadPrefix)
  );
}

/**
 * Coerce a value to a finite number, returning `fallback` when the value is
 * undefined, null, NaN, Infinity, or not a number at all.
 * Used to guard against malformed Gateway responses that could surface NaN in the UI.
 */
function safeFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/**
 * Same as {@link safeFiniteNumber} but returns `null` when the value is absent
 * instead of a numeric fallback.  Suitable for optional timestamp fields.
 */
function safeFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function mapGatewayResultStatus(
  status?: GatewayStatusType,
): 'success' | 'error' | 'skipped' | null {
  if (status === GatewayStatus.Ok) return TaskStatus.Success;
  if (status === GatewayStatus.Error) return TaskStatus.Error;
  if (status === GatewayStatus.Skipped) return TaskStatus.Skipped;
  return null;
}

function matchesRunFilter(run: ScheduledTaskRun, filter?: RunFilter): boolean {
  if (filter?.status && run.status !== filter.status) return false;
  return true;
}

/**
 * Returns true when a gateway error is exclusively a delivery failure —
 * the agent turn itself completed successfully but the gateway reports an
 * error because delivery was attempted and failed (or was not requested).
 *
 * The gateway currently conflates delivery failure with job failure for
 * `delivery.mode: "none"` jobs, setting `status: "error"` even though the
 * agent turn produced a valid summary.  This helper lets callers downgrade
 * such errors to success.
 */
function isDeliveryOnlyError(opts: {
  status?: GatewayStatusType;
  error?: string;
  deliveryError?: string;
  deliveryStatus?: string;
}): boolean {
  if (opts.status !== GatewayStatus.Error) return false;
  if (!opts.error) return false;
  // The error is delivery-only when its text matches the deliveryError exactly.
  return !!opts.deliveryError && opts.error === opts.deliveryError;
}

export function mapGatewaySchedule(schedule: GatewaySchedule): Schedule {
  switch (schedule.kind) {
    case ScheduleKind.At:
      return { kind: ScheduleKind.At, at: schedule.at };
    case ScheduleKind.Every: {
      const everyMs = safeFiniteNumber(schedule.everyMs, 60_000);
      const anchorMs = safeFiniteNumberOrNull(schedule.anchorMs);
      return {
        kind: ScheduleKind.Every,
        everyMs,
        ...(anchorMs !== null ? { anchorMs } : {}),
      };
    }
    case ScheduleKind.Cron: {
      const staggerMs = safeFiniteNumberOrNull(schedule.staggerMs);
      return {
        kind: ScheduleKind.Cron,
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
        ...(staggerMs !== null ? { staggerMs } : {}),
      };
    }
  }
}

function toGatewaySchedule(schedule: Schedule): GatewaySchedule {
  switch (schedule.kind) {
    case ScheduleKind.At:
      return { kind: ScheduleKind.At, at: schedule.at };
    case ScheduleKind.Every:
      return {
        kind: ScheduleKind.Every,
        everyMs: schedule.everyMs,
        ...(typeof schedule.anchorMs === 'number' ? { anchorMs: schedule.anchorMs } : {}),
      };
    case ScheduleKind.Cron:
      return {
        kind: ScheduleKind.Cron,
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
        ...(typeof schedule.staggerMs === 'number' ? { staggerMs: schedule.staggerMs } : {}),
      };
  }
}

function toGatewayPayload(payload: ScheduledTaskPayload): GatewayPayload {
  if (payload.kind === PayloadKind.SystemEvent) {
    return {
      kind: PayloadKind.SystemEvent,
      text: payload.text,
    };
  }

  return {
    kind: PayloadKind.AgentTurn,
    message: payload.message,
    ...(typeof payload.timeoutSeconds === 'number'
      ? { timeoutSeconds: payload.timeoutSeconds }
      : {}),
    ...(payload.model ? { model: payload.model } : {}),
  };
}

function toGatewayDelivery(delivery?: ScheduledTaskDelivery): GatewayDelivery | undefined {
  console.log(
    '[CronJobService][toGatewayDelivery] input delivery:',
    JSON.stringify(delivery, null, 2),
  );
  if (!delivery) {
    console.log('[CronJobService][toGatewayDelivery] no delivery, returning undefined');
    return undefined;
  }
  if (delivery.mode === DeliveryMode.None) {
    // mode='none' means no notification; send a clean { mode: 'none' } patch.
    // The gateway patch-merges delivery and cannot clear a previously-set
    // channel/to, but mapGatewayJob strips any residual target on the way back
    // so the UI never surfaces a notification target for none-mode tasks.
    const result: GatewayDelivery = { mode: DeliveryMode.None };
    console.log(
      '[CronJobService][toGatewayDelivery] mode=none, cleared channel/to:',
      JSON.stringify(result),
    );
    return result;
  }

  // Translate logical UI channel names to OpenClaw channel names.
  // e.g. 'popo' (UI/config key) → 'moltbot-popo' (OpenClaw plugin name).
  const openclawChannel = delivery.channel
    ? (() => {
        const platform = PlatformRegistry.platformOfChannel(delivery.channel);
        return platform ? PlatformRegistry.channelOf(platform) : delivery.channel;
      })()
    : undefined;

  const result: GatewayDelivery = {
    mode: delivery.mode,
    ...(openclawChannel ? { channel: openclawChannel } : {}),
    ...(delivery.to ? { to: delivery.to } : {}),
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
    ...(typeof delivery.bestEffort === 'boolean' ? { bestEffort: delivery.bestEffort } : {}),
  };
  console.log(
    '[CronJobService][toGatewayDelivery] output gatewayDelivery:',
    JSON.stringify(result, null, 2),
  );
  return result;
}

export function mapGatewayTaskState(
  state: GatewayJobState,
  deliveryMode?: DeliveryModeType,
): TaskState {
  let lastStatus = state.runningAtMs
    ? TaskStatus.Running
    : mapGatewayResultStatus(state.lastRunStatus ?? state.lastStatus);

  // When delivery.mode is "none" and the gateway reports an error that is
  // purely a delivery failure, downgrade to success.
  if (
    lastStatus === TaskStatus.Error &&
    deliveryMode === DeliveryMode.None &&
    isDeliveryOnlyError({
      status: state.lastRunStatus ?? state.lastStatus,
      error: state.lastError,
      deliveryError: state.lastDeliveryError,
      deliveryStatus: state.lastDeliveryStatus,
    })
  ) {
    lastStatus = TaskStatus.Success;
  }

  return {
    nextRunAtMs: safeFiniteNumberOrNull(state.nextRunAtMs),
    lastRunAtMs: safeFiniteNumberOrNull(state.lastRunAtMs),
    lastStatus,
    lastError: lastStatus === TaskStatus.Success ? null : (state.lastError ?? null),
    lastDurationMs: safeFiniteNumberOrNull(state.lastDurationMs),
    runningAtMs: safeFiniteNumberOrNull(state.runningAtMs),
    consecutiveErrors: safeFiniteNumber(state.consecutiveErrors ?? 0, 0),
  };
}

/**
 * Maps a non-`none` gateway delivery onto the UI model, inferring channel/to
 * from `sessionKey` when the gateway job has no explicit delivery target
 * (common for agent-initiated cron.add tasks). Callers must handle
 * `mode === 'none'` separately so stale gateway-retained targets are stripped.
 */
function mapGatewayDeliveryTarget(
  delivery: GatewayDelivery,
  sessionKey: string | null | undefined,
): ScheduledTaskDelivery {
  let inferredChannel: string | undefined;
  let inferredTo: string | undefined;
  if (!delivery.channel && sessionKey) {
    const parsed = parseChannelSessionKey(sessionKey);
    if (parsed) {
      const channelName = PlatformRegistry.channelOf(parsed.platform);
      if (channelName) {
        inferredChannel = channelName;
        inferredTo = parsed.conversationId;
      }
    }
  }

  return {
    mode: delivery.mode,
    ...(delivery.channel || inferredChannel
      ? { channel: delivery.channel ?? inferredChannel }
      : {}),
    ...(delivery.to || inferredTo ? { to: delivery.to ?? inferredTo } : {}),
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
    ...(typeof delivery.bestEffort === 'boolean' ? { bestEffort: delivery.bestEffort } : {}),
  };
}

export function mapGatewayJob(job: GatewayJob): ScheduledTask {
  const delivery = job.delivery ?? { mode: DeliveryMode.None };

  // mode='none' means no notification. The gateway patch-merges delivery on
  // cron.update and cannot clear a previously-set channel/to, so a job that was
  // switched to "不通知" still carries the stale target on subsequent reads.
  // Strip any residual channel/to/accountId here so update/list/get/refresh
  // all surface a clean { mode: 'none' } to the UI. This is the single
  // chokepoint for gateway→UI job mapping, so it covers every read path.
  const mappedDelivery: ScheduledTaskDelivery =
    delivery.mode === DeliveryMode.None
      ? { mode: DeliveryMode.None }
      : mapGatewayDeliveryTarget(delivery, job.sessionKey);

  return {
    id: job.id,
    name: job.name,
    description: job.description ?? '',
    enabled: job.enabled,
    schedule: mapGatewaySchedule(job.schedule),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload:
      job.payload.kind === PayloadKind.SystemEvent
        ? { kind: PayloadKind.SystemEvent, text: job.payload.text }
        : {
            kind: PayloadKind.AgentTurn,
            message: job.payload.message,
            ...(typeof job.payload.timeoutSeconds === 'number'
              ? { timeoutSeconds: job.payload.timeoutSeconds }
              : {}),
            ...(job.payload.model ? { model: job.payload.model } : {}),
          },
    delivery: mappedDelivery,
    agentId: job.agentId ?? null,
    sessionKey: job.sessionKey ?? null,
    state: mapGatewayTaskState(job.state, delivery.mode),
    createdAt: new Date(safeFiniteNumber(job.createdAtMs, Date.now())).toISOString(),
    updatedAt: new Date(safeFiniteNumber(job.updatedAtMs, Date.now())).toISOString(),
  };
}

export function mapGatewayRun(entry: GatewayRunLogEntry): ScheduledTaskRun {
  let status =
    entry.action && entry.action !== 'finished'
      ? TaskStatus.Running
      : (mapGatewayResultStatus(entry.status) ?? TaskStatus.Error);

  // Suppress delivery-only errors: the agent turn succeeded but the
  // gateway conflated a delivery failure with the job status.
  if (
    status === TaskStatus.Error &&
    isDeliveryOnlyError({
      status: entry.status,
      error: entry.error,
      deliveryError: entry.deliveryError,
      deliveryStatus: entry.deliveryStatus,
    })
  ) {
    status = TaskStatus.Success;
  }

  const tsMs = safeFiniteNumber(entry.runAtMs ?? entry.ts, Date.now());

  return {
    id: `${entry.jobId}-${entry.ts}`,
    taskId: entry.jobId,
    sessionId: entry.sessionId ?? null,
    sessionKey: entry.sessionKey ?? null,
    status,
    startedAt: new Date(tsMs).toISOString(),
    finishedAt:
      status === TaskStatus.Running
        ? null
        : new Date(safeFiniteNumber(entry.ts, tsMs)).toISOString(),
    durationMs: safeFiniteNumberOrNull(entry.durationMs),
    error: status === TaskStatus.Success ? null : (entry.error ?? null),
    summary: entry.summary ?? null,
    deliveryError: entry.deliveryError ?? null,
  };
}

/** Extract a short title from a run's summary (first line, trimmed to 30 chars). */
function extractRunTitle(summary?: string): string | undefined {
  if (!summary) return undefined;
  const firstLine = summary.split('\n')[0].trim();
  if (!firstLine) return undefined;
  return firstLine.length > 30 ? firstLine.slice(0, 30) + '…' : firstLine;
}

export class CronJobService {
  private readonly getGatewayClient: () => GatewayClientLike | null;
  private readonly ensureGatewayReady: () => Promise<void>;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKnownStates: Map<string, string> = new Map();
  private lastKnownRunAtMs: Map<string, number> = new Map();
  private polling = false;
  private firstPollDone = false;
  /** Synchronous jobId → name cache, populated during polling. */
  private jobNameCache: Map<string, string> = new Map();
  /** Synchronous jobId → delivery routing cache, populated during polling.
   *  Used by channel session sync to decide whether a cron run needs a local
   *  "[定时]" session or delivers into an IM conversation instead. */
  private jobDeliveryCache: Map<string, ScheduledTaskJobDelivery> = new Map();
  /** Job IDs currently running (non-null `runningAtMs`), updated during polling. */
  private runningJobIds: Set<string> = new Set();
  /** Keep the fast poll cadence until this timestamp (set by manual runs). */
  private fastPollUntilMs = 0;

  private static readonly POLL_INTERVAL_MS = 15_000;
  /** Faster cadence while a job is running so status changes land quickly. */
  private static readonly ACTIVE_POLL_INTERVAL_MS = 3_000;
  /** Fast-poll window after a manual trigger, covering the gap before the
   *  gateway reports the job as running. */
  private static readonly MANUAL_RUN_BOOST_MS = 30_000;

  constructor(deps: CronJobServiceDeps) {
    this.getGatewayClient = deps.getGatewayClient;
    this.ensureGatewayReady = deps.ensureGatewayReady;
  }

  /**
   * Look up a job name synchronously from the polling cache.
   * Returns the job name if known, or null if the cache hasn't been populated yet.
   */
  getJobNameSync(jobId: string): string | null {
    return this.jobNameCache.get(jobId) ?? null;
  }

  /**
   * Look up a job's delivery routing synchronously from the polling cache.
   * Returns null if the cache hasn't been populated yet.
   */
  getJobDeliverySync(jobId: string): ScheduledTaskJobDelivery | null {
    return this.jobDeliveryCache.get(jobId) ?? null;
  }

  private cacheJobDelivery(
    jobId: string,
    delivery?: { mode: DeliveryModeType; channel?: string } | null,
  ): void {
    this.jobDeliveryCache.set(jobId, {
      mode: delivery?.mode ?? DeliveryMode.None,
      ...(delivery?.channel ? { channel: delivery.channel } : {}),
    });
  }

  hasRunningJobs(): boolean {
    return this.runningJobIds.size > 0;
  }

  private async client(): Promise<GatewayClientLike> {
    let client = this.getGatewayClient();
    if (!client) {
      await this.ensureGatewayReady();
      client = this.getGatewayClient();
    }
    if (!client) {
      throw new Error('OpenClaw gateway client is unavailable for cron operations.');
    }
    return client;
  }

  private async listGatewayJobs(params: Record<string, unknown> = {}): Promise<GatewayJob[]> {
    const client = await this.client();
    const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
      includeDisabled: true,
      limit: 200,
      ...params,
    });
    return Array.isArray(result.jobs) ? result.jobs : [];
  }

  async addJob(input: ScheduledTaskInput): Promise<ScheduledTask> {
    console.log('[CronJobService][addJob] full input:', JSON.stringify(input, null, 2));
    console.log(
      '[CronJobService][addJob] delivery details:',
      JSON.stringify(
        {
          deliveryMode: input.delivery?.mode,
          deliveryChannel: input.delivery?.channel,
          deliveryTo: input.delivery?.to,
          deliveryAccountId: input.delivery?.accountId,
          sessionTarget: input.sessionTarget,
          sessionKey: input.sessionKey,
        },
        null,
        2,
      ),
    );
    const client = await this.client();
    const gatewayDelivery = toGatewayDelivery(input.delivery);
    console.log(
      '[CronJobService][addJob] resolved gatewayDelivery:',
      JSON.stringify(gatewayDelivery),
    );
    const job = await client.request<GatewayJob>('cron.add', {
      name: input.name,
      description: input.description || undefined,
      enabled: input.enabled,
      schedule: toGatewaySchedule(input.schedule),
      sessionTarget: input.sessionTarget,
      wakeMode: input.wakeMode,
      payload: toGatewayPayload(input.payload),
      ...(gatewayDelivery ? { delivery: gatewayDelivery } : {}),
      ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
      ...(input.sessionKey?.trim() ? { sessionKey: input.sessionKey.trim() } : {}),
    });
    const mapped = mapGatewayJob(job);
    this.jobNameCache.set(mapped.id, mapped.name);
    this.cacheJobDelivery(mapped.id, mapped.delivery);
    console.log('[CronJobService][addJob] created job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async updateJob(id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
    console.log('[CronJobService][updateJob] id:', id, 'input:', JSON.stringify(input, null, 2));
    console.log(
      '[CronJobService][updateJob] delivery details:',
      JSON.stringify(
        {
          deliveryMode: input.delivery?.mode,
          deliveryChannel: input.delivery?.channel,
          deliveryTo: input.delivery?.to,
          deliveryAccountId: input.delivery?.accountId,
          sessionTarget: input.sessionTarget,
          sessionKey: input.sessionKey,
        },
        null,
        2,
      ),
    );
    const client = await this.client();
    const patch: Record<string, unknown> = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) {
      patch.description = input.description || undefined;
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.schedule !== undefined) patch.schedule = toGatewaySchedule(input.schedule);
    if (input.sessionTarget !== undefined) patch.sessionTarget = input.sessionTarget;
    if (input.wakeMode !== undefined) patch.wakeMode = input.wakeMode;
    if (input.payload !== undefined) patch.payload = toGatewayPayload(input.payload);
    if (input.delivery !== undefined)
      patch.delivery = toGatewayDelivery(input.delivery) ?? { mode: DeliveryMode.None };
    if (input.agentId !== undefined) patch.agentId = input.agentId?.trim() || null;
    if (input.sessionKey !== undefined) patch.sessionKey = input.sessionKey?.trim() || null;

    console.log('[CronJobService][updateJob] final patch:', JSON.stringify(patch, null, 2));
    const job = await client.request<GatewayJob>('cron.update', { id, patch });
    const mapped = mapGatewayJob(job);
    this.jobNameCache.set(mapped.id, mapped.name);
    this.cacheJobDelivery(mapped.id, mapped.delivery);
    console.log('[CronJobService][updateJob] updated job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async removeJob(id: string): Promise<void> {
    const client = await this.client();
    await client.request('cron.remove', { id });
    this.lastKnownStates.delete(id);
    this.lastKnownRunAtMs.delete(id);
    this.jobNameCache.delete(id);
    this.jobDeliveryCache.delete(id);
  }

  async listJobs(): Promise<ScheduledTask[]> {
    const jobs = await this.listGatewayJobs();
    return jobs.filter(job => !isInternalScheduledTaskJob(job)).map(mapGatewayJob);
  }

  async getJob(id: string): Promise<ScheduledTask | null> {
    const raw = await this.getJobRaw(id);
    if (raw && isInternalScheduledTaskJob(raw)) return null;
    return raw ? mapGatewayJob(raw) : null;
  }

  private async getJobRaw(id: string): Promise<GatewayJob | null> {
    try {
      const jobs = await this.listGatewayJobs({
        query: id,
        limit: 20,
      });
      return jobs.find(job => job.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async toggleJob(id: string, enabled: boolean): Promise<ScheduledTask> {
    const client = await this.client();
    const job = await client.request<GatewayJob>('cron.update', { id, patch: { enabled } });
    return mapGatewayJob(job);
  }

  async runJob(id: string): Promise<void> {
    const client = await this.client();
    await client.request('cron.run', { id });
    // The gateway enqueues the run and returns immediately. Poll right away
    // and keep a fast cadence briefly so renderers see the running state and
    // the finished run without waiting for the regular poll interval.
    this.fastPollUntilMs = Date.now() + CronJobService.MANUAL_RUN_BOOST_MS;
    void this.pollOnce().finally(() => this.scheduleNextPoll());
  }

  async listRuns(
    jobId: string,
    limit = 20,
    offset = 0,
    filter?: RunFilter,
  ): Promise<ScheduledTaskRun[]> {
    const job = await this.getJobRaw(jobId);
    if (job && isInternalScheduledTaskJob(job)) return [];

    const client = await this.client();
    const visibleLimit = Math.max(0, limit);
    const visibleOffset = Math.max(0, offset);
    if (visibleLimit === 0) return [];

    const visibleRuns: ScheduledTaskRun[] = [];
    let skippedVisible = 0;
    let rawOffset = 0;
    const pageSize = Math.max(visibleLimit, 50);

    while (visibleRuns.length < visibleLimit) {
      const result = await client.request<{ entries?: GatewayRunLogEntry[] }>('cron.runs', {
        scope: 'job',
        id: jobId,
        limit: pageSize,
        offset: rawOffset,
        sortDir: 'desc',
        ...(filter?.startDate && { startMs: new Date(filter.startDate + 'T00:00:00').getTime() }),
        ...(filter?.endDate && { endMs: new Date(filter.endDate + 'T23:59:59').getTime() }),
      });
      const entries = Array.isArray(result.entries) ? result.entries : [];
      if (entries.length === 0) break;

      for (const entry of entries) {
        const run = mapGatewayRun(entry);
        if (!matchesRunFilter(run, filter)) continue;
        if (skippedVisible < visibleOffset) {
          skippedVisible += 1;
          continue;
        }
        visibleRuns.push(run);
        if (visibleRuns.length >= visibleLimit) break;
      }

      rawOffset += entries.length;
      if (entries.length < pageSize) break;
    }

    return visibleRuns;
  }

  async countRuns(jobId: string): Promise<number> {
    const job = await this.getJobRaw(jobId);
    if (job && isInternalScheduledTaskJob(job)) return 0;

    const client = await this.client();
    const result = await client.request<{ total?: number }>('cron.runs', {
      scope: 'job',
      id: jobId,
      limit: 0,
    });
    return typeof result.total === 'number' ? result.total : 0;
  }

  async listAllRuns(
    limit = 20,
    offset = 0,
    filter?: RunFilter,
  ): Promise<ScheduledTaskRunWithName[]> {
    const client = await this.client();
    const visibleLimit = Math.max(0, limit);
    const visibleOffset = Math.max(0, offset);
    if (visibleLimit === 0) return [];

    let jobs: GatewayJob[] = [];
    try {
      jobs = await this.listGatewayJobs();
    } catch {
      jobs = [];
    }

    const internalJobIds = new Set(
      jobs.filter(job => isInternalScheduledTaskJob(job)).map(job => job.id),
    );
    const nameMap = new Map(jobs.map(job => [job.id, job.name]));
    const visibleRuns: Array<{ entry: GatewayRunLogEntry; run: ScheduledTaskRun }> = [];
    let skippedVisible = 0;
    let rawOffset = 0;
    const pageSize = Math.max(visibleLimit, 50);

    while (visibleRuns.length < visibleLimit) {
      const result = await client.request<{ entries?: GatewayRunLogEntry[] }>('cron.runs', {
        scope: 'all',
        limit: pageSize,
        offset: rawOffset,
        sortDir: 'desc',
        ...(filter?.startDate && { startMs: new Date(filter.startDate + 'T00:00:00').getTime() }),
        ...(filter?.endDate && { endMs: new Date(filter.endDate + 'T23:59:59').getTime() }),
      });
      const entries = Array.isArray(result.entries) ? result.entries : [];
      if (entries.length === 0) break;

      for (const entry of entries) {
        if (internalJobIds.has(entry.jobId)) continue;
        const run = mapGatewayRun(entry);
        if (!matchesRunFilter(run, filter)) continue;
        if (skippedVisible < visibleOffset) {
          skippedVisible += 1;
          continue;
        }
        visibleRuns.push({ entry, run });
        if (visibleRuns.length >= visibleLimit) break;
      }

      rawOffset += entries.length;
      if (entries.length < pageSize) break;
    }

    return visibleRuns.map(({ entry, run }) => ({
      ...run,
      taskName:
        entry.jobName || nameMap.get(entry.jobId) || extractRunTitle(entry.summary) || entry.jobId,
    }));
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollOnce().finally(() => this.scheduleNextPoll());
  }

  notifyGatewayReady(): void {
    if (!this.polling) {
      this.startPolling();
      return;
    }
    void this.pollOnce(true).finally(() => this.scheduleNextPoll());
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.lastKnownStates.clear();
    this.lastKnownRunAtMs.clear();
    this.jobNameCache.clear();
    this.jobDeliveryCache.clear();
    this.runningJobIds.clear();
    this.fastPollUntilMs = 0;
    this.firstPollDone = false;
  }

  /**
   * (Re-)arm the poll timer with an adaptive delay: fast while a job is
   * running or a manual run was just triggered, relaxed otherwise.
   */
  private scheduleNextPoll(): void {
    if (!this.polling) return;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
    }
    const fast = this.runningJobIds.size > 0 || Date.now() < this.fastPollUntilMs;
    const delay = fast
      ? CronJobService.ACTIVE_POLL_INTERVAL_MS
      : CronJobService.POLL_INTERVAL_MS;
    this.pollingTimer = setTimeout(() => {
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }, delay);
  }

  private async pollOnce(forceFullRefresh = false): Promise<void> {
    if (!this.polling) return;

    try {
      // await this.ensureGatewayReady();
      const client = this.getGatewayClient();
      if (!client) return;

      const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
        includeDisabled: true,
        limit: 200,
      });
      const jobs = Array.isArray(result.jobs) ? result.jobs : [];
      const visibleJobs = jobs.filter(job => !isInternalScheduledTaskJob(job));

      // Refresh jobId → name/delivery caches for synchronous lookups
      // (used by session naming and cron session routing).
      this.jobNameCache.clear();
      this.jobDeliveryCache.clear();
      this.runningJobIds.clear();
      for (const job of jobs) {
        this.jobNameCache.set(job.id, job.name);
        this.cacheJobDelivery(job.id, job.delivery);
        if (job.state.runningAtMs) {
          this.runningJobIds.add(job.id);
        }
      }

      for (const job of visibleJobs) {
        const stateHash = JSON.stringify(job.state);
        const previousHash = this.lastKnownStates.get(job.id);
        if (previousHash !== stateHash) {
          this.lastKnownStates.set(job.id, stateHash);
          if (previousHash !== undefined) {
            const task = mapGatewayJob(job);
            this.emitStatusUpdate(task.id, task.state);
          }
        }

        const lastRunAtMs = job.state.lastRunAtMs ?? 0;
        const previousRunAtMs = this.lastKnownRunAtMs.get(job.id) ?? 0;
        if (lastRunAtMs > previousRunAtMs && previousRunAtMs > 0) {
          try {
            const runs = await this.listRuns(job.id, 1, 0);
            if (runs[0]) {
              const task = mapGatewayJob(job);
              this.emitRunUpdate({ ...runs[0], taskName: task.name });
            }
          } catch {
            // Ignore run fetch failures during polling.
          }
        }
        this.lastKnownRunAtMs.set(job.id, lastRunAtMs);
      }

      const currentIds = new Set(visibleJobs.map(job => job.id));
      for (const knownId of this.lastKnownStates.keys()) {
        if (!currentIds.has(knownId)) {
          this.lastKnownStates.delete(knownId);
          this.lastKnownRunAtMs.delete(knownId);
        }
      }

      if (forceFullRefresh || !this.firstPollDone) {
        this.firstPollDone = true;
        this.emitFullRefresh();
      }
    } catch (error) {
      console.warn('[CronJobService] Polling error:', error);
    }
  }

  private emitStatusUpdate(taskId: string, state: TaskState): void {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.StatusUpdate, { taskId, state });
      }
    });
  }

  private emitRunUpdate(run: ScheduledTaskRunWithName): void {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.RunUpdate, { run });
      }
    });
  }

  private emitFullRefresh(): void {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.Refresh);
      }
    });
  }
}
