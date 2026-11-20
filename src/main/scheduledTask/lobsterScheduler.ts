// Engine-independent SQLite-backed task scheduler for LobsterAI.
//
// Replaces OpenClaw's internal cron engine so scheduled tasks survive engine
// upgrades cleanly, persist directly in `lobsterai.sqlite`, support IANA
// timezones and `skipMissedJobs` on wake, and execute turns via DSH + deliver
// results to `[定时]` sessions or `@lobsterai/dsh-channels`.

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import {
  DeliveryMode,
  RunDeliveryStatus,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from '../../scheduledTask/constants';
import type {
  RunFilter,
  Schedule,
  ScheduleCron,
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskPayload,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
  TaskState,
} from '../../scheduledTask/types';

export interface LobsterSchedulerRunResult {
  sessionId?: string | null;
  sessionKey?: string | null;
  summary?: string | null;
  deliveryStatus?: RunDeliveryStatus | null;
  deliveryError?: string | null;
}

export type LobsterSchedulerExecutor = (
  task: ScheduledTask,
  signal: AbortSignal,
) => Promise<LobsterSchedulerRunResult>;

export interface LobsterSchedulerOptions {
  db: Database.Database;
  executor?: LobsterSchedulerExecutor;
  /** Poll tick interval in ms (default 15_000). */
  tickIntervalMs?: number;
  /** Clock provider override for deterministic unit tests. */
  now?: () => number;
  /** Skip tasks whose scheduled time was missed while the app was asleep/closed (default true). */
  skipMissedJobs?: boolean;
}

export interface LegacyTaskImportRecord {
  id?: string;
  input: ScheduledTaskInput;
  state?: Partial<TaskState> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LegacyRunImportRecord {
  id: string;
  taskId: string;
  sessionId?: string | null;
  sessionKey?: string | null;
  status: TaskStatus;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  summary?: string | null;
  deliveryError?: string | null;
  deliveryStatus?: RunDeliveryStatus | null;
  deliveryChannel?: string | null;
}

interface ParsedCronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

interface TaskRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  schedule_json: string;
  session_target: string;
  wake_mode: string;
  payload_json: string;
  delivery_json: string;
  agent_id: string | null;
  session_key: string | null;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  task_name?: string;
  session_id: string | null;
  session_key: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  summary: string | null;
  delivery_error: string | null;
  delivery_status: string | null;
  delivery_channel: string | null;
}

const DEFAULT_TICK_INTERVAL_MS = 15_000;
const MAX_CRON_SEARCH_MINUTES = 366 * 24 * 60; // 1 leap year scan bound

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseCronField(
  token: string,
  min: number,
  max: number,
  normalizeSevenToZero = false,
): { values: Set<number>; isWildcard: boolean } {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Empty cron field');
  const isWildcard = trimmed === '*';
  const values = new Set<number>();

  for (const part of trimmed.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step "${part}"`);
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [s, e] = rangePart.split('-').map(Number);
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < min || e > max || s > e) {
        throw new Error(`Invalid cron range "${part}"`);
      }
      start = s;
      end = e;
    } else {
      const single = Number(rangePart);
      if (!Number.isInteger(single) || single < min || single > max) {
        throw new Error(`Invalid cron value "${part}"`);
      }
      start = single;
      end = single;
    }

    for (let v = start; v <= end; v += step) {
      values.add(normalizeSevenToZero && v === 7 ? 0 : v);
    }
  }

  return { values, isWildcard };
}

export function parseCronExpression(expr: string): ParsedCronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields (min hour dom month dow): "${expr}"`);
  }
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dow = parseCronField(parts[4], 0, 7, true);

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domWildcard: dom.isWildcard,
    dowWildcard: dow.isWildcard,
  };
}

function getZonedDateParts(
  timestampMs: number,
  timeZone?: string,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
  if (!timeZone) {
    const d = new Date(timestampMs);
    return {
      minute: d.getMinutes(),
      hour: d.getHours(),
      day: d.getDate(),
      month: d.getMonth() + 1,
      weekday: d.getDay(),
    };
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(timestampMs));
  let minute = 0;
  let hour = 0;
  let day = 1;
  let month = 1;
  let weekday = 0;
  for (const part of parts) {
    if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'weekday') weekday = WEEKDAY_MAP[part.value] ?? 0;
  }
  return { minute, hour, day, month, weekday };
}

function cronMatches(parsed: ParsedCronFields, tsMs: number, tz?: string): boolean {
  const parts = getZonedDateParts(tsMs, tz);
  if (!parsed.months.has(parts.month)) return false;
  if (!parsed.hours.has(parts.hour)) return false;
  if (!parsed.minutes.has(parts.minute)) return false;

  const domMatch = parsed.daysOfMonth.has(parts.day);
  const dowMatch = parsed.daysOfWeek.has(parts.weekday);
  if (parsed.domWildcard && parsed.dowWildcard) return true;
  if (parsed.domWildcard) return dowMatch;
  if (parsed.dowWildcard) return domMatch;
  return domMatch || dowMatch;
}

function computeNextCronRunMs(schedule: ScheduleCron, afterMs: number): number | null {
  const parsed = parseCronExpression(schedule.expr);
  // Start on the next whole minute strictly after `afterMs`.
  const startMinute = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < MAX_CRON_SEARCH_MINUTES; i += 1) {
    const candidate = startMinute + i * 60_000;
    if (cronMatches(parsed, candidate, schedule.tz)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Compute the next execution epoch millisecond strictly after `nowMs`,
 * or `null` when a one-shot schedule has already passed.
 */
export function computeNextRunAtMs(schedule: Schedule, nowMs: number): number | null {
  if (schedule.kind === 'at') {
    const targetMs = Date.parse(schedule.at);
    if (!Number.isFinite(targetMs)) return null;
    return targetMs > nowMs ? targetMs : null;
  }
  if (schedule.kind === 'every') {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) return null;
    const anchor = typeof schedule.anchorMs === 'number' && Number.isFinite(schedule.anchorMs)
      ? schedule.anchorMs
      : nowMs;
    if (anchor > nowMs) return anchor;
    const elapsed = nowMs - anchor;
    const intervals = Math.floor(elapsed / schedule.everyMs) + 1;
    return anchor + intervals * schedule.everyMs;
  }
  return computeNextCronRunMs(schedule, nowMs);
}

function defaultState(nextRunAtMs: number | null): TaskState {
  return {
    nextRunAtMs,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    runningAtMs: null,
    consecutiveErrors: 0,
  };
}

export class LobsterScheduler extends EventEmitter {
  private readonly db: Database.Database;
  private executor: LobsterSchedulerExecutor | null;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;
  private readonly skipMissedJobs: boolean;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly runningControllers = new Map<string, AbortController>();

  constructor(options: LobsterSchedulerOptions) {
    super();
    this.db = options.db;
    this.executor = options.executor ?? null;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.skipMissedJobs = options.skipMissedJobs ?? true;
    this.ensureSchema();
  }

  setExecutor(executor: LobsterSchedulerExecutor | null): void {
    this.executor = executor;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lobster_scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_json TEXT NOT NULL,
        session_target TEXT NOT NULL DEFAULT 'isolated',
        wake_mode TEXT NOT NULL DEFAULT 'now',
        payload_json TEXT NOT NULL,
        delivery_json TEXT NOT NULL,
        agent_id TEXT,
        session_key TEXT,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lobster_scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        session_key TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        summary TEXT,
        delivery_error TEXT,
        delivery_status TEXT,
        delivery_channel TEXT,
        FOREIGN KEY (task_id) REFERENCES lobster_scheduled_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lobster_scheduled_runs_task_started
        ON lobster_scheduled_task_runs(task_id, started_at DESC);
    `);
  }

  start(): void {
    if (this.timer) return;
    if (this.skipMissedJobs) {
      this.reconcileMissedJobs();
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.runningControllers.values()) {
      controller.abort(new Error('LobsterScheduler stopped'));
    }
    this.runningControllers.clear();
  }

  /**
   * Advance overdue tasks past `now()` without firing stale runs after sleep
   * or prolonged app shutdown (`skipMissedJobs` policy).
   */
  reconcileMissedJobs(): number {
    const nowMs = this.now();
    let skipped = 0;
    for (const task of this.listTasks()) {
      if (!task.enabled) continue;
      if (task.state.runningAtMs !== null) {
        // Clear any stale running flag left by a hard crash.
        task.state.runningAtMs = null;
      }
      if (task.state.nextRunAtMs !== null && task.state.nextRunAtMs < nowMs - this.tickIntervalMs) {
        task.state.nextRunAtMs = computeNextRunAtMs(task.schedule, nowMs);
        this.saveTaskState(task.id, task.state);
        skipped += 1;
      }
    }
    return skipped;
  }

  listTasks(): ScheduledTask[] {
    const rows = this.db
      .prepare('SELECT * FROM lobster_scheduled_tasks ORDER BY created_at DESC')
      .all() as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  getTask(taskId: string): ScheduledTask | null {
    const row = this.db
      .prepare('SELECT * FROM lobster_scheduled_tasks WHERE id = ?')
      .get(taskId) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

  createTask(input: ScheduledTaskInput, explicitId?: string): ScheduledTask {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const id = explicitId || randomUUID();
    const delivery: ScheduledTaskDelivery = input.delivery ?? { mode: DeliveryMode.None };
    const nextRunAtMs = input.enabled ? computeNextRunAtMs(input.schedule, nowMs) : null;
    const state = defaultState(nextRunAtMs);

    this.db
      .prepare(`
        INSERT INTO lobster_scheduled_tasks (
          id, name, description, enabled, schedule_json, session_target, wake_mode,
          payload_json, delivery_json, agent_id, session_key, state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.name,
        input.description ?? '',
        input.enabled ? 1 : 0,
        JSON.stringify(input.schedule),
        input.sessionTarget ?? SessionTarget.Isolated,
        input.wakeMode ?? WakeMode.Now,
        JSON.stringify(input.payload),
        JSON.stringify(delivery),
        input.agentId ?? null,
        input.sessionKey ?? null,
        JSON.stringify(state),
        nowIso,
        nowIso,
      );

    return this.getTask(id)!;
  }

  updateTask(taskId: string, patch: Partial<ScheduledTaskInput>): ScheduledTask | null {
    const existing = this.getTask(taskId);
    if (!existing) return null;

    const nextEnabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    const nextSchedule = patch.schedule !== undefined ? patch.schedule : existing.schedule;
    const nextState: TaskState = {
      ...existing.state,
      nextRunAtMs: nextEnabled ? computeNextRunAtMs(nextSchedule, this.now()) : null,
    };

    const nowIso = new Date(this.now()).toISOString();
    this.db
      .prepare(`
        UPDATE lobster_scheduled_tasks
        SET name = ?, description = ?, enabled = ?, schedule_json = ?, session_target = ?,
            wake_mode = ?, payload_json = ?, delivery_json = ?, agent_id = ?, session_key = ?,
            state_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        patch.name ?? existing.name,
        patch.description ?? existing.description,
        nextEnabled ? 1 : 0,
        JSON.stringify(nextSchedule),
        patch.sessionTarget ?? existing.sessionTarget,
        patch.wakeMode ?? existing.wakeMode,
        JSON.stringify(patch.payload ?? existing.payload),
        JSON.stringify(patch.delivery ?? existing.delivery),
        patch.agentId !== undefined ? patch.agentId : existing.agentId,
        patch.sessionKey !== undefined ? patch.sessionKey : existing.sessionKey,
        JSON.stringify(nextState),
        nowIso,
        taskId,
      );

    const updated = this.getTask(taskId)!;
    this.emit('statusUpdate', { taskId, state: updated.state });
    return updated;
  }

  toggleTask(taskId: string, enabled: boolean): ScheduledTask | null {
    return this.updateTask(taskId, { enabled });
  }

  deleteTask(taskId: string): boolean {
    const controller = this.runningControllers.get(taskId);
    if (controller) {
      controller.abort(new Error('Scheduled task deleted'));
      this.runningControllers.delete(taskId);
    }
    const res = this.db.prepare('DELETE FROM lobster_scheduled_tasks WHERE id = ?').run(taskId);
    return res.changes > 0;
  }

  stopTask(taskId: string): boolean {
    const controller = this.runningControllers.get(taskId);
    if (!controller) return false;
    controller.abort(new Error('Scheduled task stopped by user'));
    this.runningControllers.delete(taskId);
    return true;
  }

  countRuns(taskId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM lobster_scheduled_task_runs WHERE task_id = ?')
      .get(taskId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listRuns(taskId: string, limit = 50, offset = 0, filter?: RunFilter): ScheduledTaskRun[] {
    const clauses = ['task_id = ?'];
    const params: unknown[] = [taskId];
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.startDate) {
      clauses.push('started_at >= ?');
      params.push(filter.startDate);
    }
    if (filter?.endDate) {
      clauses.push('started_at <= ?');
      params.push(filter.endDate);
    }
    params.push(limit, offset);
    const rows = this.db
      .prepare(`
        SELECT * FROM lobster_scheduled_task_runs
        WHERE ${clauses.join(' AND ')}
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params) as RunRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  listAllRuns(limit = 50, offset = 0, filter?: RunFilter): ScheduledTaskRunWithName[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      clauses.push('r.status = ?');
      params.push(filter.status);
    }
    if (filter?.startDate) {
      clauses.push('r.started_at >= ?');
      params.push(filter.startDate);
    }
    if (filter?.endDate) {
      clauses.push('r.started_at <= ?');
      params.push(filter.endDate);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit, offset);
    const rows = this.db
      .prepare(`
        SELECT r.*, t.name AS task_name
        FROM lobster_scheduled_task_runs r
        LEFT JOIN lobster_scheduled_tasks t ON t.id = r.task_id
        ${whereSql}
        ORDER BY r.started_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params) as RunRow[];
    return rows.map((row) => ({
      ...this.rowToRun(row),
      taskName: row.task_name ?? row.task_id,
    }));
  }

  /**
   * Import legacy OpenClaw cron job records idempotently (used by
   * `LegacyOpenClawMigrator` during v1 -> v2 upgrade and backup backfill).
   * Preserves original job IDs, timestamps, and historical last-run state.
   */
  importLegacyJobs(jobs: LegacyTaskImportRecord[]): number {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO lobster_scheduled_tasks (
        id, name, description, enabled, schedule_json, session_target, wake_mode,
        payload_json, delivery_json, agent_id, session_key, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    const importTx = this.db.transaction(() => {
      for (const item of jobs) {
        if (item.id && this.getTask(item.id)) continue;
        const id = item.id || randomUUID();
        const delivery: ScheduledTaskDelivery = item.input.delivery ?? { mode: DeliveryMode.None };
        let nextRunAtMs: number | null = null;
        if (item.input.enabled) {
          try {
            nextRunAtMs = computeNextRunAtMs(item.input.schedule, nowMs);
          } catch {
            nextRunAtMs = null;
          }
        }
        const rawLastStatus = item.state?.lastStatus ?? null;
        const safeLastStatus =
          rawLastStatus === TaskStatus.Running
            ? (item.state?.lastError ? TaskStatus.Error : null)
            : rawLastStatus;
        const state: TaskState = {
          nextRunAtMs,
          lastRunAtMs:
            typeof item.state?.lastRunAtMs === 'number' && Number.isFinite(item.state.lastRunAtMs)
              ? item.state.lastRunAtMs
              : null,
          lastStatus: safeLastStatus,
          lastError: typeof item.state?.lastError === 'string' ? item.state.lastError : null,
          lastDurationMs:
            typeof item.state?.lastDurationMs === 'number' && Number.isFinite(item.state.lastDurationMs)
              ? item.state.lastDurationMs
              : null,
          runningAtMs: null,
          consecutiveErrors:
            typeof item.state?.consecutiveErrors === 'number' && Number.isFinite(item.state.consecutiveErrors)
              ? Math.max(0, Math.floor(item.state.consecutiveErrors))
              : 0,
        };
        const createdAt = item.createdAt && Number.isFinite(Date.parse(item.createdAt))
          ? item.createdAt
          : nowIso;
        const updatedAt = item.updatedAt && Number.isFinite(Date.parse(item.updatedAt))
          ? item.updatedAt
          : createdAt;

        const res = insertStmt.run(
          id,
          item.input.name,
          item.input.description ?? '',
          item.input.enabled ? 1 : 0,
          JSON.stringify(item.input.schedule),
          item.input.sessionTarget ?? SessionTarget.Isolated,
          item.input.wakeMode ?? WakeMode.Now,
          JSON.stringify(item.input.payload),
          JSON.stringify(delivery),
          item.input.agentId ?? null,
          item.input.sessionKey ?? null,
          JSON.stringify(state),
          createdAt,
          updatedAt,
        );
        if (res.changes > 0) imported += 1;
      }
    });
    importTx();
    return imported;
  }

  /**
   * Import historical OpenClaw cron run logs idempotently.
   * Skips orphan runs whose `taskId` is not present in `lobster_scheduled_tasks`
   * and avoids duplicating existing `(task_id, started_at)` records.
   */
  importLegacyRuns(runs: LegacyRunImportRecord[]): number {
    if (runs.length === 0) return 0;

    const existingTasks = new Map<string, ScheduledTask>();
    for (const task of this.listTasks()) {
      existingTasks.set(task.id, task);
    }
    if (existingTasks.size === 0) return 0;

    const existingRunKeys = new Set<string>();
    const existingRows = this.db
      .prepare('SELECT task_id, started_at FROM lobster_scheduled_task_runs')
      .all() as Array<{ task_id: string; started_at: string }>;
    for (const row of existingRows) {
      existingRunKeys.add(`${row.task_id}|${row.started_at}`);
    }

    const insertRunStmt = this.db.prepare(`
      INSERT OR IGNORE INTO lobster_scheduled_task_runs (
        id, task_id, session_id, session_key, status, started_at, finished_at,
        duration_ms, error, summary, delivery_error, delivery_status, delivery_channel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    const latestRunByTask = new Map<string, { startedMs: number; run: LegacyRunImportRecord }>();

    const importTx = this.db.transaction(() => {
      for (const run of runs) {
        const task = existingTasks.get(run.taskId);
        if (!task) continue;
        const startedMs = Date.parse(run.startedAt);
        if (!Number.isFinite(startedMs)) continue;

        const dedupeKey = `${run.taskId}|${run.startedAt}`;
        if (existingRunKeys.has(dedupeKey)) continue;

        const safeStatus =
          run.status === TaskStatus.Running ? TaskStatus.Error : run.status;
        const safeError =
          safeStatus === TaskStatus.Success
            ? null
            : (run.error ?? (run.status === TaskStatus.Running ? 'Interrupted before completion' : null));
        const durationMs =
          typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)
            ? Math.max(0, Math.round(run.durationMs))
            : null;
        const deliveryChannel =
          run.deliveryChannel !== undefined
            ? run.deliveryChannel
            : (task.delivery.mode === DeliveryMode.Announce ? (task.delivery.channel ?? null) : null);

        const res = insertRunStmt.run(
          run.id,
          run.taskId,
          run.sessionId ?? null,
          run.sessionKey ?? null,
          safeStatus,
          run.startedAt,
          run.finishedAt ?? null,
          durationMs,
          safeError,
          run.summary ?? null,
          run.deliveryError ?? null,
          run.deliveryStatus ?? null,
          deliveryChannel,
        );
        if (res.changes > 0) {
          imported += 1;
          existingRunKeys.add(dedupeKey);
          const prev = latestRunByTask.get(run.taskId);
          if (!prev || startedMs > prev.startedMs) {
            latestRunByTask.set(run.taskId, {
              startedMs,
              run: { ...run, status: safeStatus, error: safeError, durationMs },
            });
          }
        }
      }

      // Backfill task summary state when imported runs exist but `lastRunAtMs` was empty.
      for (const [taskId, latest] of latestRunByTask.entries()) {
        const task = existingTasks.get(taskId);
        if (!task || task.state.lastRunAtMs !== null) continue;
        const patchedState: TaskState = {
          ...task.state,
          lastRunAtMs: latest.startedMs,
          lastStatus: latest.run.status,
          lastError: latest.run.error ?? null,
          lastDurationMs: latest.run.durationMs ?? null,
          runningAtMs: null,
        };
        this.saveTaskState(taskId, patchedState);
      }
    });
    importTx();
    return imported;
  }

  /**
   * Evaluate all enabled tasks due at `now()` and execute them.
   */
  async tick(): Promise<string[]> {
    const nowMs = this.now();
    const firedIds: string[] = [];
    for (const task of this.listTasks()) {
      if (!task.enabled) continue;
      if (this.runningControllers.has(task.id)) continue;
      if (task.state.nextRunAtMs === null || task.state.nextRunAtMs > nowMs) continue;
      firedIds.push(task.id);
      await this.executeTaskNow(task);
    }
    return firedIds;
  }

  async runNow(taskId: string): Promise<ScheduledTaskRun> {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Scheduled task "${taskId}" not found`);
    }
    return this.executeTaskNow(task);
  }

  private async executeTaskNow(task: ScheduledTask): Promise<ScheduledTaskRun> {
    const startedMs = this.now();
    const startedIso = new Date(startedMs).toISOString();
    const runId = randomUUID();
    const controller = new AbortController();
    this.runningControllers.set(task.id, controller);

    const nextState: TaskState = {
      ...task.state,
      runningAtMs: startedMs,
      lastStatus: TaskStatus.Running,
    };
    this.saveTaskState(task.id, nextState);
    this.emit('statusUpdate', { taskId: task.id, state: nextState });

    this.db
      .prepare(`
        INSERT INTO lobster_scheduled_task_runs (
          id, task_id, session_id, session_key, status, started_at, delivery_channel
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        task.id,
        null,
        task.sessionKey,
        TaskStatus.Running,
        startedIso,
        task.delivery.channel ?? null,
      );

    let status: TaskStatus = TaskStatus.Success;
    let errorMsg: string | null = null;
    let runResult: LobsterSchedulerRunResult = {};

    try {
      if (!this.executor) {
        throw new Error('No scheduler executor configured');
      }
      runResult = await this.executor(task, controller.signal);
    } catch (error) {
      status = TaskStatus.Error;
      errorMsg = error instanceof Error ? error.message : String(error);
    } finally {
      this.runningControllers.delete(task.id);
    }

    const finishedMs = this.now();
    const finishedIso = new Date(finishedMs).toISOString();
    const durationMs = Math.max(0, finishedMs - startedMs);

    this.db
      .prepare(`
        UPDATE lobster_scheduled_task_runs
        SET session_id = ?, session_key = ?, status = ?, finished_at = ?, duration_ms = ?,
            error = ?, summary = ?, delivery_error = ?, delivery_status = ?
        WHERE id = ?
      `)
      .run(
        runResult.sessionId ?? null,
        runResult.sessionKey ?? task.sessionKey ?? null,
        status,
        finishedIso,
        durationMs,
        errorMsg,
        runResult.summary ?? null,
        runResult.deliveryError ?? null,
        runResult.deliveryStatus ?? (task.delivery.mode === DeliveryMode.None ? RunDeliveryStatus.NotRequested : RunDeliveryStatus.Delivered),
        runId,
      );

    // One-shot `at` tasks disable automatically after firing; recurring tasks
    // compute the next slot after completion.
    const latestTask = this.getTask(task.id);
    if (latestTask) {
      const keepEnabled = latestTask.enabled && latestTask.schedule.kind !== 'at';
      const updatedState: TaskState = {
        nextRunAtMs: keepEnabled ? computeNextRunAtMs(latestTask.schedule, finishedMs) : null,
        lastRunAtMs: startedMs,
        lastStatus: status,
        lastError: errorMsg,
        lastDurationMs: durationMs,
        runningAtMs: null,
        consecutiveErrors: status === TaskStatus.Error ? latestTask.state.consecutiveErrors + 1 : 0,
      };
      this.db
        .prepare('UPDATE lobster_scheduled_tasks SET enabled = ?, state_json = ?, updated_at = ? WHERE id = ?')
        .run(keepEnabled ? 1 : 0, JSON.stringify(updatedState), finishedIso, task.id);
      this.emit('statusUpdate', { taskId: task.id, state: updatedState });
    }

    const finalRunRow = this.db
      .prepare('SELECT * FROM lobster_scheduled_task_runs WHERE id = ?')
      .get(runId) as RunRow;
    const runRecord = this.rowToRun(finalRunRow);
    this.emit('runUpdate', { run: { ...runRecord, taskName: task.name } });
    return runRecord;
  }

  private saveTaskState(taskId: string, state: TaskState): void {
    this.db
      .prepare('UPDATE lobster_scheduled_tasks SET state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), new Date(this.now()).toISOString(), taskId);
  }

  private rowToTask(row: TaskRow): ScheduledTask {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      schedule: JSON.parse(row.schedule_json) as Schedule,
      sessionTarget: row.session_target as SessionTarget,
      wakeMode: row.wake_mode as WakeMode,
      payload: JSON.parse(row.payload_json) as ScheduledTaskPayload,
      delivery: JSON.parse(row.delivery_json) as ScheduledTaskDelivery,
      agentId: row.agent_id,
      sessionKey: row.session_key,
      state: JSON.parse(row.state_json) as TaskState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToRun(row: RunRow): ScheduledTaskRun {
    return {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      sessionKey: row.session_key,
      status: row.status as TaskStatus,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      error: row.error,
      summary: row.summary,
      deliveryError: row.delivery_error,
      deliveryStatus: row.delivery_status as RunDeliveryStatus | null,
      deliveryChannel: row.delivery_channel,
    };
  }
}
