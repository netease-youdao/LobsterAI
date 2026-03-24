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
} from '../../renderer/types/scheduledTask';

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
  mode: 'none' | 'announce' | 'webhook';
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
}

interface GatewayJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: 'ok' | 'error' | 'skipped';
  lastStatus?: 'ok' | 'error' | 'skipped';
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
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'now' | 'next-heartbeat';
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
  status?: 'ok' | 'error' | 'skipped';
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
  status?: 'ok' | 'error' | 'skipped',
): 'success' | 'error' | 'skipped' | null {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'error';
  if (status === 'skipped') return 'skipped';
  return null;
}

export function mapGatewaySchedule(schedule: GatewaySchedule): Schedule {
  switch (schedule.kind) {
    case 'at':
      return { kind: 'at', at: schedule.at };
    case 'every':
      return {
        kind: 'every',
        everyMs: schedule.everyMs,
        ...(typeof schedule.anchorMs === 'number' ? { anchorMs: schedule.anchorMs } : {}),
      };
    case 'cron':
      return {
        kind: 'cron',
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
        ...(typeof schedule.staggerMs === 'number' ? { staggerMs: schedule.staggerMs } : {}),
      };
  }
}

function toGatewaySchedule(schedule: Schedule): GatewaySchedule {
  switch (schedule.kind) {
    case 'at':
      return { kind: 'at', at: schedule.at };
    case 'every':
      return {
        kind: 'every',
        everyMs: schedule.everyMs,
        ...(typeof schedule.anchorMs === 'number' ? { anchorMs: schedule.anchorMs } : {}),
      };
    case 'cron':
      return {
        kind: 'cron',
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
        ...(typeof schedule.staggerMs === 'number' ? { staggerMs: schedule.staggerMs } : {}),
      };
  }
}

function toGatewayPayload(payload: ScheduledTaskPayload): GatewayPayload {
  if (payload.kind === 'systemEvent') {
    return {
      kind: 'systemEvent',
      text: payload.text,
    };
  }

  return {
    kind: 'agentTurn',
    message: payload.message,
    ...(typeof payload.timeoutSeconds === 'number'
      ? { timeoutSeconds: payload.timeoutSeconds }
      : {}),
  };
}

function toGatewayDelivery(delivery?: ScheduledTaskDelivery): GatewayDelivery | undefined {
  if (!delivery || delivery.mode === 'none') {
    return delivery?.mode === 'none' ? { mode: 'none' } : undefined;
  }

  return {
    mode: delivery.mode,
    ...(delivery.channel ? { channel: delivery.channel } : {}),
    ...(delivery.to ? { to: delivery.to } : {}),
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
    ...(typeof delivery.bestEffort === 'boolean'
      ? { bestEffort: delivery.bestEffort }
      : {}),
  };
}

export function mapGatewayTaskState(state: GatewayJobState): TaskState {
  const lastStatus = state.runningAtMs
    ? 'running'
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
  const delivery = job.delivery ?? { mode: 'none' as const };

  return {
    id: job.id,
    name: job.name,
    description: job.description ?? '',
    enabled: job.enabled,
    schedule: mapGatewaySchedule(job.schedule),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload.kind === 'systemEvent'
      ? { kind: 'systemEvent', text: job.payload.text }
      : {
          kind: 'agentTurn',
          message: job.payload.message,
          ...(typeof job.payload.timeoutSeconds === 'number'
            ? { timeoutSeconds: job.payload.timeoutSeconds }
            : {}),
        },
    delivery: {
      mode: delivery.mode,
      ...(delivery.channel ? { channel: delivery.channel } : {}),
      ...(delivery.to ? { to: delivery.to } : {}),
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
    ? 'running'
    : (mapGatewayResultStatus(entry.status) ?? 'error');

  return {
    id: `${entry.jobId}-${entry.ts}`,
    taskId: entry.jobId,
    sessionId: entry.sessionId ?? null,
    sessionKey: entry.sessionKey ?? null,
    status,
    startedAt: new Date(entry.runAtMs ?? entry.ts).toISOString(),
    finishedAt: status === 'running' ? null : new Date(entry.ts).toISOString(),
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
    const client = await this.client();
    const job = await client.request<GatewayJob>('cron.add', {
      name: input.name,
      description: input.description || undefined,
      enabled: input.enabled,
      schedule: toGatewaySchedule(input.schedule),
      sessionTarget: input.sessionTarget,
      wakeMode: input.wakeMode,
      payload: toGatewayPayload(input.payload),
      ...(toGatewayDelivery(input.delivery) ? { delivery: toGatewayDelivery(input.delivery) } : {}),
      ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
      ...(input.sessionKey?.trim() ? { sessionKey: input.sessionKey.trim() } : {}),
    });
    const mapped = mapGatewayJob(job);
    this.jobNameCache.set(mapped.id, mapped.name);
    return mapped;
  }

  async updateJob(id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
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
    if (input.delivery !== undefined) patch.delivery = toGatewayDelivery(input.delivery) ?? { mode: 'none' };
    if (input.agentId !== undefined) patch.agentId = input.agentId?.trim() || null;
    if (input.sessionKey !== undefined) patch.sessionKey = input.sessionKey?.trim() || null;

    const job = await client.request<GatewayJob>('cron.update', { id, patch });
    return mapGatewayJob(job);
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
        window.webContents.send('scheduledTask:statusUpdate', { taskId, state });
      }
    });
  }

  private emitRunUpdate(run: ScheduledTaskRunWithName): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send('scheduledTask:runUpdate', { run });
      }
    });
  }

  private emitFullRefresh(): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send('scheduledTask:refresh');
      }
    });
  }
}
