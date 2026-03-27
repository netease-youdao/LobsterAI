import { BrowserWindow } from 'electron';
import type {
  Schedule,
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskPayload,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
  TaskState,
} from './types';
import { parseChannelSessionKey, CHANNEL_PLATFORM_MAP, PLATFORM_TO_CHANNEL_MAP } from '../main/libs/openclawChannelSessionSync';
import {
  ScheduleKind,
  PayloadKind,
  DeliveryMode,
  SessionTarget,
  WakeMode,
  TaskStatus,
  GatewayStatus,
  IpcChannel,
} from './constants';
import type {
  SessionTarget as SessionTargetType,
  WakeMode as WakeModeType,
  DeliveryMode as DeliveryModeType,
  GatewayStatus as GatewayStatusType,
} from './constants';

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
}

interface CronJobServiceDeps {
  getGatewayClient: () => GatewayClientLike | null;
  ensureGatewayReady: () => Promise<void>;
}

function mapGatewayResultStatus(
  status?: GatewayStatusType,
): 'success' | 'error' | 'skipped' | null {
  if (status === GatewayStatus.Ok) return TaskStatus.Success;
  if (status === GatewayStatus.Error) return TaskStatus.Error;
  if (status === GatewayStatus.Skipped) return TaskStatus.Skipped;
  return null;
}

export function mapGatewaySchedule(schedule: GatewaySchedule): Schedule {
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
  };
}

function toGatewayDelivery(delivery?: ScheduledTaskDelivery): GatewayDelivery | undefined {
  console.log('[CronJobService][toGatewayDelivery] input delivery:', JSON.stringify(delivery, null, 2));
  if (!delivery) {
    console.log('[CronJobService][toGatewayDelivery] no delivery, returning undefined');
    return undefined;
  }
  if (delivery.mode === DeliveryMode.None) {
    // Preserve channel/to even with mode='none' so IM notification target round-trips
    // through the gateway for the edit form to display.
    const result: GatewayDelivery = {
      mode: DeliveryMode.None,
      ...(delivery.channel ? { channel: delivery.channel } : {}),
      ...(delivery.to ? { to: delivery.to } : {}),
    } as GatewayDelivery;
    console.log('[CronJobService][toGatewayDelivery] mode=none with preserved channel/to:', JSON.stringify(result));
    return result;
  }

  // Translate logical UI channel names to OpenClaw channel names.
  // e.g. 'popo' (UI/config key) → 'moltbot-popo' (OpenClaw plugin name).
  const openclawChannel = delivery.channel
    ? (() => {
        const platform = CHANNEL_PLATFORM_MAP[delivery.channel];
        return platform ? (PLATFORM_TO_CHANNEL_MAP[platform] ?? delivery.channel) : delivery.channel;
      })()
    : undefined;

  const result: GatewayDelivery = {
    mode: delivery.mode,
    ...(openclawChannel ? { channel: openclawChannel } : {}),
    ...(delivery.to ? { to: delivery.to } : {}),
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
    ...(typeof delivery.bestEffort === 'boolean'
      ? { bestEffort: delivery.bestEffort }
      : {}),
  };
  console.log('[CronJobService][toGatewayDelivery] output gatewayDelivery:', JSON.stringify(result, null, 2));
  return result;
}

export function mapGatewayTaskState(state: GatewayJobState): TaskState {
  const lastStatus = state.runningAtMs
    ? TaskStatus.Running
    : mapGatewayResultStatus(state.lastRunStatus ?? state.lastStatus);

  return {
    nextRunAtMs: state.nextRunAtMs ?? null,
    lastRunAtMs: state.lastRunAtMs ?? null,
    lastStatus,
    lastError: state.lastError ?? null,
    lastDurationMs: state.lastDurationMs ?? null,
    runningAtMs: state.runningAtMs ?? null,
    consecutiveErrors: state.consecutiveErrors ?? 0,
  };
}

export function mapGatewayJob(job: GatewayJob): ScheduledTask {
  const delivery = job.delivery ?? { mode: DeliveryMode.None };

  // Infer delivery channel/to from sessionKey when the gateway job has no
  // explicit delivery target (common for agent-initiated cron.add tasks).
  let inferredChannel: string | undefined;
  let inferredTo: string | undefined;
  if (!delivery.channel && job.sessionKey) {
    const parsed = parseChannelSessionKey(job.sessionKey);
    if (parsed) {
      const channelName = PLATFORM_TO_CHANNEL_MAP[parsed.platform];
      if (channelName) {
        inferredChannel = channelName;
        inferredTo = parsed.conversationId;
      }
    }
  }

  return {
    id: job.id,
    name: job.name,
    description: job.description ?? '',
    enabled: job.enabled,
    schedule: mapGatewaySchedule(job.schedule),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload.kind === PayloadKind.SystemEvent
      ? { kind: PayloadKind.SystemEvent, text: job.payload.text }
      : {
          kind: PayloadKind.AgentTurn,
          message: job.payload.message,
          ...(typeof job.payload.timeoutSeconds === 'number'
            ? { timeoutSeconds: job.payload.timeoutSeconds }
            : {}),
        },
    delivery: {
      mode: delivery.mode,
      ...(delivery.channel || inferredChannel
        ? { channel: delivery.channel ?? inferredChannel }
        : {}),
      ...(delivery.to || inferredTo
        ? { to: delivery.to ?? inferredTo }
        : {}),
      ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
      ...(typeof delivery.bestEffort === 'boolean'
        ? { bestEffort: delivery.bestEffort }
        : {}),
    },
    agentId: job.agentId ?? null,
    sessionKey: job.sessionKey ?? null,
    state: mapGatewayTaskState(job.state),
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
  };
}

export function mapGatewayRun(entry: GatewayRunLogEntry): ScheduledTaskRun {
  const status = entry.action && entry.action !== 'finished'
    ? TaskStatus.Running
    : (mapGatewayResultStatus(entry.status) ?? TaskStatus.Error);

  return {
    id: `${entry.jobId}-${entry.ts}`,
    taskId: entry.jobId,
    sessionId: entry.sessionId ?? null,
    sessionKey: entry.sessionKey ?? null,
    status,
    startedAt: new Date(entry.runAtMs ?? entry.ts).toISOString(),
    finishedAt: status === TaskStatus.Running ? null : new Date(entry.ts).toISOString(),
    durationMs: entry.durationMs ?? null,
    error: entry.error ?? null,
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
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownStates: Map<string, string> = new Map();
  private lastKnownRunAtMs: Map<string, number> = new Map();
  private polling = false;
  private firstPollDone = false;
  /** Synchronous jobId → name cache, populated during polling. */
  private jobNameCache: Map<string, string> = new Map();

  private static readonly POLL_INTERVAL_MS = 15_000;

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

  async addJob(input: ScheduledTaskInput): Promise<ScheduledTask> {
    console.log('[CronJobService][addJob] full input:', JSON.stringify(input, null, 2));
    console.log('[CronJobService][addJob] delivery details:', JSON.stringify({
      deliveryMode: input.delivery?.mode,
      deliveryChannel: input.delivery?.channel,
      deliveryTo: input.delivery?.to,
      deliveryAccountId: input.delivery?.accountId,
      sessionTarget: input.sessionTarget,
      sessionKey: input.sessionKey,
    }, null, 2));
    const client = await this.client();
    const gatewayDelivery = toGatewayDelivery(input.delivery);
    console.log('[CronJobService][addJob] resolved gatewayDelivery:', JSON.stringify(gatewayDelivery));
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
    console.log('[CronJobService][addJob] created job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async updateJob(id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
    console.log('[CronJobService][updateJob] id:', id, 'input:', JSON.stringify(input, null, 2));
    console.log('[CronJobService][updateJob] delivery details:', JSON.stringify({
      deliveryMode: input.delivery?.mode,
      deliveryChannel: input.delivery?.channel,
      deliveryTo: input.delivery?.to,
      deliveryAccountId: input.delivery?.accountId,
      sessionTarget: input.sessionTarget,
      sessionKey: input.sessionKey,
    }, null, 2));
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
    if (input.delivery !== undefined) patch.delivery = toGatewayDelivery(input.delivery) ?? { mode: DeliveryMode.None };
    if (input.agentId !== undefined) patch.agentId = input.agentId?.trim() || null;
    if (input.sessionKey !== undefined) patch.sessionKey = input.sessionKey?.trim() || null;

    console.log('[CronJobService][updateJob] final patch:', JSON.stringify(patch, null, 2));
    const job = await client.request<GatewayJob>('cron.update', { id, patch });
    const mapped = mapGatewayJob(job);
    console.log('[CronJobService][updateJob] updated job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async removeJob(id: string): Promise<void> {
    const client = await this.client();
    await client.request('cron.remove', { id });
    this.lastKnownStates.delete(id);
    this.lastKnownRunAtMs.delete(id);
  }

  async listJobs(): Promise<ScheduledTask[]> {
    const client = await this.client();
    const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
      includeDisabled: true,
      limit: 200,
    });
    return Array.isArray(result.jobs) ? result.jobs.map(mapGatewayJob) : [];
  }

  async getJob(id: string): Promise<ScheduledTask | null> {
    const raw = await this.getJobRaw(id);
    return raw ? mapGatewayJob(raw) : null;
  }

  private async getJobRaw(id: string): Promise<GatewayJob | null> {
    const client = await this.client();
    try {
      const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
        includeDisabled: true,
        query: id,
        limit: 20,
      });
      return result.jobs?.find((job) => job.id === id) ?? null;
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
  }

  async listRuns(jobId: string, limit = 20, offset = 0): Promise<ScheduledTaskRun[]> {
    const client = await this.client();
    const result = await client.request<{ entries?: GatewayRunLogEntry[] }>('cron.runs', {
      scope: 'job',
      id: jobId,
      limit,
      offset,
      sortDir: 'desc',
    });
    return Array.isArray(result.entries) ? result.entries.map(mapGatewayRun) : [];
  }

  async countRuns(jobId: string): Promise<number> {
    const client = await this.client();
    const result = await client.request<{ total?: number }>('cron.runs', {
      scope: 'job',
      id: jobId,
      limit: 0,
    });
    return typeof result.total === 'number' ? result.total : 0;
  }

  async listAllRuns(limit = 20, offset = 0): Promise<ScheduledTaskRunWithName[]> {
    const client = await this.client();
    const result = await client.request<{ entries?: GatewayRunLogEntry[] }>('cron.runs', {
      scope: 'all',
      limit,
      offset,
      sortDir: 'desc',
    });
    if (!Array.isArray(result.entries) || result.entries.length === 0) return [];

    // Build a jobId→name map for entries missing jobName
    const missingIds = new Set(
      result.entries.filter((e) => !e.jobName && !e.summary).map((e) => e.jobId),
    );
    const nameMap = new Map<string, string>();
    if (missingIds.size > 0) {
      try {
        const jobs = await this.listJobs();
        for (const job of jobs) {
          if (missingIds.has(job.id)) {
            nameMap.set(job.id, job.name);
          }
        }
      } catch {
        // fall through
      }
    }

    return result.entries.map((entry) => ({
      ...mapGatewayRun(entry),
      taskName: entry.jobName
        || nameMap.get(entry.jobId)
        || extractRunTitle(entry.summary)
        || entry.jobId,
    }));
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.pollOnce();
    this.pollingTimer = setInterval(() => {
      void this.pollOnce();
    }, CronJobService.POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.lastKnownStates.clear();
    this.lastKnownRunAtMs.clear();
    this.jobNameCache.clear();
    this.firstPollDone = false;
  }

  private async pollOnce(): Promise<void> {
    if (!this.polling) return;

    try {
      await this.ensureGatewayReady();
      const client = this.getGatewayClient();
      if (!client) return;

      const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
        includeDisabled: true,
        limit: 200,
      });
      const jobs = Array.isArray(result.jobs) ? result.jobs : [];

      // Refresh jobId → name cache for synchronous lookups (used by session naming).
      this.jobNameCache.clear();
      for (const job of jobs) {
        this.jobNameCache.set(job.id, job.name);
      }

      for (const job of jobs) {
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

      const currentIds = new Set(jobs.map((job) => job.id));
      for (const knownId of this.lastKnownStates.keys()) {
        if (!currentIds.has(knownId)) {
          this.lastKnownStates.delete(knownId);
          this.lastKnownRunAtMs.delete(knownId);
        }
      }

      if (!this.firstPollDone) {
        this.firstPollDone = true;
        this.emitFullRefresh();
      }
    } catch (error) {
      console.warn('[CronJobService] Polling error:', error);
    }
  }

  private emitStatusUpdate(taskId: string, state: TaskState): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.StatusUpdate, { taskId, state });
      }
    });
  }

  private emitRunUpdate(run: ScheduledTaskRunWithName): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.RunUpdate, { run });
      }
    });
  }

  private emitFullRefresh(): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.Refresh);
      }
    });
  }
}
