/**
 * One-time migration: move scheduled tasks from legacy SQLite tables
 * (used in the non-openclaw release) into the OpenClaw gateway via CronJobService.
 *
 * Safe to call multiple times — a kv flag prevents re-running.
 */

import fs from 'fs';
import path from 'path';
import type { Database } from 'sql.js';
import type { CronJobService } from './cronJobService';
import { MigrationKey, ScheduleKind, PayloadKind, DeliveryMode, SessionTarget, WakeMode, GatewayStatus, DefaultAgentId } from './constants';
import type { Schedule, ScheduledTaskDelivery, ScheduledTaskInput } from './types';

// ---------------------------------------------------------------------------
// Legacy types (main branch schema — never changed, only removed)
// ---------------------------------------------------------------------------

interface LegacySchedule {
  type: 'at' | 'interval' | 'cron';
  datetime?: string;
  intervalMs?: number;
  expression?: string;
}

interface LegacyTaskRow {
  id: string;
  name: string;
  description: string;
  enabled: number; // 0 | 1
  schedule_json: string;
  prompt: string;
  notify_platforms_json: string; // JSON string of string[]
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function formatLocalTimezoneOffset(): string {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absMinutes / 60).toString().padStart(2, '0');
  const minutes = (absMinutes % 60).toString().padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/**
 * Ensure a datetime string has an explicit timezone offset.
 * Legacy `at` datetimes were stored as local time without offset (e.g. "2026-03-17T21:30:00").
 * The OpenClaw gateway interprets offset-less strings as UTC, causing an 8-hour drift
 * for users in UTC+8.  Append the local timezone offset when missing.
 */
function ensureTimezoneOffset(datetime: string): string {
  // Already has an offset (+HH:MM, -HH:MM) or trailing 'Z'
  if (/(?:Z|[+-]\d{2}:\d{2})\s*$/.test(datetime)) return datetime;
  return `${datetime}${formatLocalTimezoneOffset()}`;
}

function convertSchedule(legacy: LegacySchedule): Schedule | null {
  if (legacy.type === 'at') {
    if (!legacy.datetime) return null;
    const withTz = ensureTimezoneOffset(legacy.datetime);
    // Skip one-time tasks whose scheduled time is already in the past —
    // the gateway rejects them and they would never fire anyway.
    if (new Date(withTz).getTime() <= Date.now()) return null;
    return { kind: ScheduleKind.At, at: withTz };
  }
  if (legacy.type === 'interval') {
    const ms = legacy.intervalMs;
    if (!ms || ms <= 0) return null;
    return { kind: ScheduleKind.Every, everyMs: ms };
  }
  if (legacy.type === 'cron') {
    if (!legacy.expression) return null;
    return { kind: ScheduleKind.Cron, expr: legacy.expression };
  }
  return null;
}

function convertDelivery(platformsJson: string): ScheduledTaskDelivery {
  let platforms: string[] = [];
  try {
    platforms = JSON.parse(platformsJson);
  } catch {
    // ignore
  }
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return { mode: DeliveryMode.None };
  }
  // New format supports one delivery target — use the first platform as channel.
  return { mode: DeliveryMode.Announce, channel: platforms[0] };
}

function rowToInput(row: LegacyTaskRow): ScheduledTaskInput | null {
  let legacySchedule: LegacySchedule;
  try {
    legacySchedule = JSON.parse(row.schedule_json);
  } catch {
    console.warn(`[MigrateScheduledTasks] Skipping task "${row.name}" — invalid schedule_json`);
    return null;
  }

  const schedule = convertSchedule(legacySchedule);
  if (!schedule) {
    console.warn(`[MigrateScheduledTasks] Skipping task "${row.name}" — cannot convert schedule`, legacySchedule);
    return null;
  }

  return {
    name: row.name,
    description: row.description ?? '',
    enabled: row.enabled === 1,
    schedule,
    // 旧任务都带有 prompt，使用 isolated session + agentTurn。
    // main session 仅支持 systemEvent payload，不适用于迁移场景。
    sessionTarget: SessionTarget.Isolated,
    wakeMode: WakeMode.NextHeartbeat,
    payload: { kind: PayloadKind.AgentTurn, message: row.prompt },
    delivery: convertDelivery(row.notify_platforms_json ?? '[]'),
    agentId: DefaultAgentId,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface MigrationDeps {
  /** Raw sql.js Database instance for reading legacy tables. */
  db: Database;
  /** Reads a value from the app kv store. */
  getKv: (key: string) => unknown;
  /** Writes a value to the app kv store. */
  setKv: (key: string, value: string) => void;
  /** CronJobService (already constructed, gateway not necessarily ready yet). */
  cronJobService: CronJobService;
}

export async function migrateScheduledTasksToOpenclaw(deps: MigrationDeps): Promise<void> {
  const { db, getKv, setKv, cronJobService } = deps;

  // 1. Idempotency guard
  if (getKv(MigrationKey.TasksToOpenclaw) === 'true') return;

  // 2. Check if the legacy table exists (new installs won't have it)
  try {
    const tableCheck = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'",
    );
    if (!tableCheck[0]?.values?.length) {
      // Fresh install — nothing to migrate
      setKv(MigrationKey.TasksToOpenclaw, 'true');
      return;
    }
  } catch (err) {
    console.warn('[MigrateScheduledTasks] Could not check legacy table existence, skipping:', err);
    return;
  }

  // 3. Read all legacy rows
  let rows: LegacyTaskRow[] = [];
  try {
    const result = db.exec(
      'SELECT id, name, description, enabled, schedule_json, prompt, notify_platforms_json FROM scheduled_tasks',
    );
    if (!result[0]?.values?.length) {
      setKv(MigrationKey.TasksToOpenclaw, 'true');
      return;
    }
    const cols = result[0].columns;
    rows = result[0].values.map((vals) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => { obj[col] = vals[i]; });
      return obj as unknown as LegacyTaskRow;
    });
  } catch (err) {
    console.warn('[MigrateScheduledTasks] Failed to read legacy tasks, skipping migration:', err);
    return;
  }

  console.log(`[MigrateScheduledTasks] Migrating ${rows.length} task(s) to OpenClaw gateway...`);

  // 4. Push each task to the OpenClaw gateway
  let succeeded = 0;
  let skipped = 0;
  let gatewayErrors = 0;
  for (const row of rows) {
    const input = rowToInput(row);
    if (!input) { skipped++; continue; }

    try {
      await cronJobService.addJob(input);
      console.log(`[MigrateScheduledTasks] Migrated task: "${row.name}"`);
      succeeded++;
    } catch (err) {
      console.error(`[MigrateScheduledTasks] Failed to migrate task "${row.name}":`, err);
      gatewayErrors++;
    }
  }

  console.log(`[MigrateScheduledTasks] Done. succeeded=${succeeded}, skipped=${skipped}, gatewayErrors=${gatewayErrors}`);

  // 5. Mark as done only when there are no gateway errors.
  // Skipped tasks (invalid schedule etc.) are unrecoverable and don't block completion.
  // Gateway errors may be transient, so we leave the flag unset to allow a retry on next launch.
  if (gatewayErrors === 0) {
    setKv(MigrationKey.TasksToOpenclaw, 'true');
  }
}

// ---------------------------------------------------------------------------
// Run history migration: SQLite scheduled_task_runs → OpenClaw JSONL files
// ---------------------------------------------------------------------------

const RUN_HISTORY_MIGRATION_KEY = MigrationKey.RunsToOpenclaw;

interface LegacyRunRow {
  id: string;
  task_id: string;
  session_id: string | null;
  status: string; // 'success' | 'error' | 'running'
  started_at: string; // ISO string
  finished_at: string | null; // ISO string
  duration_ms: number | null;
  error: string | null;
}

function toGatewayStatus(status: string): GatewayStatus {
  if (status === 'success') return GatewayStatus.Ok;
  if (status === 'error') return GatewayStatus.Error;
  return GatewayStatus.Skipped;
}

interface RunHistoryMigrationDeps {
  db: Database;
  getKv: (key: string) => unknown;
  setKv: (key: string, value: string) => void;
  /** Path to {userData}/openclaw/state — used to locate cron/runs/. */
  openclawStateDir: string;
}

export async function migrateScheduledTaskRunsToOpenclaw(
  deps: RunHistoryMigrationDeps,
): Promise<void> {
  const { db, getKv, setKv, openclawStateDir } = deps;

  // 1. Idempotency guard
  if (getKv(RUN_HISTORY_MIGRATION_KEY) === 'true') return;

  // 2. Check legacy table exists
  try {
    const tableCheck = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs'",
    );
    if (!tableCheck[0]?.values?.length) {
      setKv(RUN_HISTORY_MIGRATION_KEY, 'true');
      return;
    }
  } catch (err) {
    console.warn('[MigrateRunHistory] Could not check legacy tables, skipping:', err);
    return;
  }

  // 3. Read legacy run rows (use old task_id directly as the JSONL filename)
  let runs: LegacyRunRow[] = [];
  try {
    const result = db.exec(
      'SELECT id, task_id, session_id, status, started_at, finished_at, duration_ms, error FROM scheduled_task_runs ORDER BY started_at ASC',
    );
    if (!result[0]?.values?.length) {
      setKv(RUN_HISTORY_MIGRATION_KEY, 'true');
      return;
    }
    const cols = result[0].columns;
    runs = result[0].values.map((vals) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => { obj[col] = vals[i]; });
      return obj as unknown as LegacyRunRow;
    });
  } catch (err) {
    console.warn('[MigrateRunHistory] Failed to read legacy runs:', err);
    return;
  }

  // 3b. Build taskId → name map for display titles
  const taskIdToName = new Map<string, string>();
  try {
    const taskResult = db.exec('SELECT id, name FROM scheduled_tasks');
    if (taskResult[0]?.values) {
      const cols = taskResult[0].columns;
      for (const vals of taskResult[0].values) {
        const row: Record<string, unknown> = {};
        cols.forEach((col, i) => { row[col] = vals[i]; });
        if (row['id'] && row['name']) {
          taskIdToName.set(row['id'] as string, row['name'] as string);
        }
      }
    }
  } catch {
    // Non-fatal: names will be omitted if the table is unavailable
  }

  console.log(`[MigrateRunHistory] Migrating ${runs.length} run(s) to OpenClaw cron/runs/...`);

  // 4. Ensure runs directory exists
  const runsDir = path.join(openclawStateDir, 'cron', 'runs');
  try {
    fs.mkdirSync(runsDir, { recursive: true });
  } catch (err) {
    console.warn('[MigrateRunHistory] Failed to create runs directory:', err);
    return;
  }

  let succeeded = 0;
  let skipped = 0;

  // 5. Group runs by task_id (used as-is for the JSONL filename)
  const runsByTaskId = new Map<string, LegacyRunRow[]>();
  for (const run of runs) {
    let arr = runsByTaskId.get(run.task_id);
    if (!arr) { arr = []; runsByTaskId.set(run.task_id, arr); }
    arr.push(run);
  }

  for (const [taskId, taskRuns] of runsByTaskId.entries()) {
    const jsonlPath = path.join(runsDir, `${taskId}.jsonl`);

    // Collect existing timestamps to avoid duplicates on re-run
    const existingTs = new Set<number>();
    try {
      const existing = fs.readFileSync(jsonlPath, 'utf-8');
      for (const line of existing.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as { ts?: number };
          if (typeof entry.ts === 'number') existingTs.add(entry.ts);
        } catch { /* ignore malformed lines */ }
      }
    } catch { /* file doesn't exist yet — that's fine */ }

    const lines: string[] = [];
    for (const run of taskRuns) {
      const startedMs = new Date(run.started_at).getTime();
      const finishedMs = run.finished_at ? new Date(run.finished_at).getTime() : startedMs;

      if (existingTs.has(finishedMs)) { skipped++; continue; }

      const entry: Record<string, unknown> = {
        ts: finishedMs,
        jobId: taskId,
        action: 'finished',
        status: toGatewayStatus(run.status),
        runAtMs: startedMs,
      };
      if (typeof run.duration_ms === 'number') entry['durationMs'] = run.duration_ms;
      if (run.error) entry['error'] = run.error;
      if (run.session_id) entry['sessionId'] = run.session_id;
      const jobName = taskIdToName.get(taskId);
      if (jobName) entry['summary'] = jobName;

      lines.push(JSON.stringify(entry));
      succeeded++;
    }

    if (lines.length > 0) {
      try {
        fs.appendFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
      } catch (err) {
        console.error(`[MigrateRunHistory] Failed to write runs for task ${taskId}:`, err);
      }
    }
  }

  console.log(`[MigrateRunHistory] Done. succeeded=${succeeded}, skipped=${skipped}`);
  setKv(RUN_HISTORY_MIGRATION_KEY, 'true');
}
