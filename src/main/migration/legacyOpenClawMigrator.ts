// Pure Offline 6-Step Atomic OpenClaw -> DeepSeek Harness (DSH) Migrator.
//
// Runs BEFORE DSH boots on first launch after upgrading to LobsterAI v2.
// Zero OpenClaw runtime dependency — reads legacy OpenClaw files and SQLite
// tables purely offline, snapshots SQLite before any mutation, archives every
// incompatible/retired module into `legacy-openclaw-backup/<ts>/`, verifies
// integrity, rolls back automatically on failure, and cleans up disposable
// OpenClaw caches only after atomic commit succeeds.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DeliveryMode,
  InternalTaskMarker,
  OpenClawSystemPayloadKind,
  PayloadKind,
  RunDeliveryStatus,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from '../../scheduledTask/constants';
import type {
  Schedule,
  ScheduledTaskDelivery,
  ScheduledTaskPayload,
  TaskState,
} from '../../scheduledTask/types';
import { AgentId } from '../../shared/agent/constants';
import {
  LEGACY_OPENCLAW_BACKUP_DIR_NAME,
  RETAINED_IM_PLATFORM_LIST,
  RetiredImPlatform,
  WORKSPACES_DIR_NAME,
} from '../../shared/dshEngine/hostConstants';
import {
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_CRON_BACKFILL_KV_KEY,
  MIGRATION_V2_REPORT_KV_KEY,
  type MigrationV2ArchivedItem,
  type MigrationV2ReauthItem,
  type MigrationV2Report,
  MigrationV2Status,
} from '../../shared/migration/constants';
import { type Platform, PlatformRegistry } from '../../shared/platform';
import { seedAgentPersonaFiles } from '../libs/agentPersonaFiles';
import {
  APP_CONFIG_KEY,
  migrateBrowserDisplayModeConfig,
} from '../libs/browserDisplayModeMigration';
import {
  LobsterMemoryService,
  sanitizeAgentId,
  stripManagedAgentsSection,
  WorkspaceFileName,
} from '../memory/lobsterMemoryService';
import {
  type LegacyRunImportRecord,
  type LegacyTaskImportRecord,
  LobsterScheduler,
} from '../scheduledTask/lobsterScheduler';
import { migrateLegacyConversationImages } from './legacyConversationImages';
import { migrateLegacySubagentHistory } from './legacySubagentHistory';
import {
  collectDirectoryTarEntries,
  extractMatchingEntriesFromTarGz,
  type TarEntryInput,
  writeTarGzArchive,
} from './tarGzUtil';

export interface RunLegacyOpenClawMigrationOptions {
  /** Electron userData root directory. */
  userDataDir: string;
  /** Absolute path to `lobsterai.sqlite`. */
  sqlitePath: string;
  /** Optional clock override for deterministic backup folder timestamps. */
  now?: () => Date;
}

export interface LegacyOpenClawMigrationResult {
  status: MigrationV2Status;
  report?: MigrationV2Report;
  rolledBack?: boolean;
  error?: string;
}

const RETIRED_IM_PLATFORMS: readonly string[] = [
  RetiredImPlatform.Popo,
  RetiredImPlatform.Nim,
  RetiredImPlatform.NeteaseBee,
  RetiredImPlatform.Email,
];

const WORKSPACE_FILES_TO_MIGRATE = [
  WorkspaceFileName.Soul,
  WorkspaceFileName.Identity,
  WorkspaceFileName.User,
  WorkspaceFileName.Memory,
  WorkspaceFileName.Agents,
] as const;

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function getTableColumns(db: Database.Database, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => String(r.name ?? '')).filter(Boolean));
}

function getKv(db: Database.Database, key: string): string | null {
  if (!tableExists(db, 'kv')) return null;
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function setKv(db: Database.Database, key: string, value: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
  db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    Date.now(),
  );
}

function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function measureDirSize(targetPath: string): number {
  if (!fs.existsSync(targetPath)) return 0;
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(targetPath)) {
      total += measureDirSize(path.join(targetPath, entry));
    }
    return total;
  } catch {
    return 0;
  }
}

function safeReadJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const RETAINED_IM_PLATFORM_SET = new Set<string>(RETAINED_IM_PLATFORM_LIST);
const INTERNAL_DECLARATION_PREFIXES = ['heartbeat:', 'skill-collection-review:'] as const;
const RUN_DEDUPE_WINDOW_MS = 5_000;
const SESSION_MATCH_WINDOW_MS = 120_000;
const CONTAINER_SESSION_SPAN_MS = 24 * 60 * 60 * 1_000;

interface OpenedLegacyDb {
  db: Database.Database;
  close: () => void;
}

function openLegacyOpenClawDbReadOnly(openclawDbPath: string): OpenedLegacyDb | null {
  if (!fs.existsSync(openclawDbPath)) return null;
  try {
    const db = new Database(openclawDbPath, { readonly: true });
    return { db, close: () => db.close() };
  } catch {
    // WAL files without a matching `-shm` cannot be opened readonly; recover
    // safely on a temporary copy so the legacy source is never mutated.
  }

  let tmpDir: string | null = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-legacy-db-'));
    const copiedDbPath = path.join(tmpDir, 'openclaw.sqlite');
    fs.copyFileSync(openclawDbPath, copiedDbPath);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${openclawDbPath}${suffix}`;
      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${copiedDbPath}${suffix}`);
      }
    }
    const db = new Database(copiedDbPath);
    const dirToClean = tmpDir;
    return {
      db,
      close: () => {
        try {
          db.close();
        } finally {
          fs.rmSync(dirToClean, { recursive: true, force: true });
        }
      },
    };
  } catch {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return null;
  }
}

function safeParseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function toIsoTimestampOrNull(value: unknown): string | null {
  const num = toFiniteNumberOrNull(value);
  if (num !== null && num > 0) {
    const d = new Date(num);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function resolveRetainedDeliveryChannel(rawChannel: unknown): string | null {
  if (typeof rawChannel !== 'string') return null;
  const trimmed = rawChannel.trim().toLowerCase();
  if (!trimmed) return null;

  const platformCandidate =
    trimmed === 'lark'
      ? 'feishu'
      : trimmed === 'wecom-bot'
        ? 'wecom'
        : (PlatformRegistry.platformOfChannel(trimmed) ?? trimmed);

  if (!RETAINED_IM_PLATFORM_SET.has(platformCandidate)) {
    return null;
  }
  return PlatformRegistry.channelOf(platformCandidate as Platform);
}

function isInternalLegacyCronJob(
  raw: Record<string, unknown>,
  meta?: { declarationKey?: string | null; payloadKind?: string | null },
): boolean {
  const decl = (meta?.declarationKey ?? (typeof raw.declarationKey === 'string' ? raw.declarationKey : '')).trim();
  if (decl && INTERNAL_DECLARATION_PREFIXES.some((prefix) => decl.startsWith(prefix))) {
    return true;
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.startsWith(InternalTaskMarker.MemoryCoreManagedDescriptionPrefix)) {
    return true;
  }

  const rawPayload = safeParseJsonObject(raw.payload);
  const payloadKind = (
    (typeof rawPayload?.kind === 'string' ? rawPayload.kind : null)
    ?? meta?.payloadKind
    ?? ''
  ).trim();
  if (
    payloadKind === OpenClawSystemPayloadKind.Heartbeat
    || payloadKind === OpenClawSystemPayloadKind.SkillCollectionReview
  ) {
    return true;
  }

  const payloadText =
    typeof rawPayload?.message === 'string'
      ? rawPayload.message
      : typeof rawPayload?.text === 'string'
        ? rawPayload.text
        : '';
  return payloadText.trim().startsWith(InternalTaskMarker.MemoryCorePayloadPrefix);
}

function mapLegacyStatus(rawStatus: unknown): TaskStatus | null {
  if (typeof rawStatus !== 'string') return null;
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === 'ok' || normalized === 'success' || normalized === 'succeeded' || normalized === 'completed') {
    return TaskStatus.Success;
  }
  if (normalized === 'skipped' || normalized === 'superseded') {
    return TaskStatus.Skipped;
  }
  if (
    normalized === 'error'
    || normalized === 'failed'
    || normalized === 'timed_out'
    || normalized === 'timeout'
    || normalized === 'cancelled'
    || normalized === 'canceled'
    || normalized === 'interrupted'
  ) {
    return TaskStatus.Error;
  }
  if (normalized === 'running') {
    return TaskStatus.Running;
  }
  return null;
}

function mapLegacyDeliveryStatus(rawStatus: unknown): RunDeliveryStatus | null {
  if (typeof rawStatus !== 'string') return null;
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === RunDeliveryStatus.Delivered) return RunDeliveryStatus.Delivered;
  if (normalized === RunDeliveryStatus.NotDelivered || normalized === 'not_delivered' || normalized === 'failed') {
    return RunDeliveryStatus.NotDelivered;
  }
  if (
    normalized === RunDeliveryStatus.NotRequested
    || normalized === 'not_requested'
    || normalized === 'not_applicable'
  ) {
    return RunDeliveryStatus.NotRequested;
  }
  if (normalized === RunDeliveryStatus.Unknown) return RunDeliveryStatus.Unknown;
  return null;
}

function mapLegacyTaskState(
  rawState: Record<string, unknown> | null,
  deliveryMode: DeliveryMode,
): Partial<TaskState> | null {
  if (!rawState) return null;
  let lastStatus = mapLegacyStatus(rawState.lastRunStatus ?? rawState.lastStatus);
  const lastError = typeof rawState.lastError === 'string' && rawState.lastError.trim()
    ? rawState.lastError
    : null;
  const lastDeliveryError = typeof rawState.lastDeliveryError === 'string'
    ? rawState.lastDeliveryError
    : null;

  // Match legacy CronJobService: downgrade delivery-only errors on mode='none' tasks.
  if (
    lastStatus === TaskStatus.Error
    && deliveryMode === DeliveryMode.None
    && lastError
    && lastDeliveryError
    && lastError === lastDeliveryError
  ) {
    lastStatus = TaskStatus.Success;
  }
  if (lastStatus === TaskStatus.Running) {
    lastStatus = lastError ? TaskStatus.Error : null;
  }

  return {
    lastRunAtMs: toFiniteNumberOrNull(rawState.lastRunAtMs),
    lastStatus,
    lastError: lastStatus === TaskStatus.Success ? null : lastError,
    lastDurationMs: toFiniteNumberOrNull(rawState.lastDurationMs),
    runningAtMs: null,
    consecutiveErrors: Math.max(0, Math.floor(toFiniteNumberOrNull(rawState.consecutiveErrors) ?? 0)),
  };
}

function extractLegacyCronJobs(
  openclawStateDir: string,
  legacyDb: Database.Database | null,
): LegacyTaskImportRecord[] {
  const results: LegacyTaskImportRecord[] = [];
  const seenIds = new Set<string>();

  const pushRawJob = (
    raw: Record<string, unknown>,
    meta?: {
      declarationKey?: string | null;
      payloadKind?: string | null;
      stateOverride?: Record<string, unknown> | null;
      updatedAtOverride?: unknown;
    },
  ) => {
    if (isInternalLegacyCronJob(raw, meta)) return;

    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
    if (id && seenIds.has(id)) return;

    const rawSched = safeParseJsonObject(raw.schedule) ?? {};
    let schedule: Schedule;
    if (rawSched.kind === 'at' && typeof rawSched.at === 'string' && rawSched.at.trim()) {
      schedule = { kind: 'at', at: rawSched.at.trim() };
    } else if (rawSched.kind === 'every') {
      const everyMs = toFiniteNumberOrNull(rawSched.everyMs);
      if (everyMs === null || everyMs <= 0) return;
      const anchorMs = toFiniteNumberOrNull(rawSched.anchorMs);
      schedule = {
        kind: 'every',
        everyMs,
        ...(anchorMs !== null ? { anchorMs } : {}),
      };
    } else if (typeof rawSched.expr === 'string' && rawSched.expr.trim()) {
      const staggerMs = toFiniteNumberOrNull(rawSched.staggerMs);
      schedule = {
        kind: 'cron',
        expr: rawSched.expr.trim(),
        ...(typeof rawSched.tz === 'string' && rawSched.tz.trim() ? { tz: rawSched.tz.trim() } : {}),
        ...(staggerMs !== null ? { staggerMs } : {}),
      };
    } else {
      return;
    }

    const rawPayload = safeParseJsonObject(raw.payload) ?? {};
    let payload: ScheduledTaskPayload;
    if (rawPayload.kind === PayloadKind.SystemEvent) {
      const text = typeof rawPayload.text === 'string' ? rawPayload.text : '';
      if (!text.trim()) return;
      payload = { kind: PayloadKind.SystemEvent, text };
    } else {
      const message = typeof rawPayload.message === 'string'
        ? rawPayload.message
        : typeof rawPayload.text === 'string'
          ? rawPayload.text
          : '';
      if (!message.trim()) return;
      const timeoutSeconds = toFiniteNumberOrNull(rawPayload.timeoutSeconds);
      payload = {
        kind: PayloadKind.AgentTurn,
        message,
        ...(timeoutSeconds !== null && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
        ...(typeof rawPayload.model === 'string' && rawPayload.model.trim() ? { model: rawPayload.model.trim() } : {}),
      };
    }

    const rawDelivery = safeParseJsonObject(raw.delivery) ?? {};
    const rawDeliveryMode = typeof rawDelivery.mode === 'string' ? rawDelivery.mode.trim().toLowerCase() : '';
    const retainedChannel = resolveRetainedDeliveryChannel(rawDelivery.channel);
    let delivery: ScheduledTaskDelivery;
    if (rawDeliveryMode === DeliveryMode.Announce && retainedChannel) {
      delivery = {
        mode: DeliveryMode.Announce,
        channel: retainedChannel,
        ...(typeof rawDelivery.to === 'string' && rawDelivery.to.trim() ? { to: rawDelivery.to.trim() } : {}),
        ...(typeof rawDelivery.accountId === 'string' && rawDelivery.accountId.trim()
          ? { accountId: rawDelivery.accountId.trim() }
          : {}),
        ...(typeof rawDelivery.bestEffort === 'boolean' ? { bestEffort: rawDelivery.bestEffort } : {}),
      };
    } else if (
      rawDeliveryMode === DeliveryMode.Webhook
      && typeof rawDelivery.to === 'string'
      && rawDelivery.to.trim()
    ) {
      delivery = {
        mode: DeliveryMode.Webhook,
        to: rawDelivery.to.trim(),
        ...(typeof rawDelivery.bestEffort === 'boolean' ? { bestEffort: rawDelivery.bestEffort } : {}),
      };
    } else {
      delivery = { mode: DeliveryMode.None };
    }

    if (id) seenIds.add(id);

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : (id || 'Migrated Task');
    const description = typeof raw.description === 'string' ? raw.description : '';
    const enabled = raw.enabled !== false && raw.enabled !== 0;
    const rawState = meta?.stateOverride ?? safeParseJsonObject(raw.state);
    const createdAt = toIsoTimestampOrNull(raw.createdAtMs ?? raw.createdAt);
    const updatedAt = toIsoTimestampOrNull(
      meta?.updatedAtOverride ?? raw.updatedAtMs ?? raw.updatedAt,
    ) ?? createdAt;

    results.push({
      id,
      input: {
        name,
        description,
        enabled,
        schedule,
        sessionTarget: raw.sessionTarget === SessionTarget.Main ? SessionTarget.Main : SessionTarget.Isolated,
        wakeMode: raw.wakeMode === WakeMode.NextHeartbeat ? WakeMode.NextHeartbeat : WakeMode.Now,
        payload,
        delivery,
        agentId: typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : 'main',
        sessionKey: typeof raw.sessionKey === 'string' && raw.sessionKey.trim() ? raw.sessionKey.trim() : null,
      },
      state: mapLegacyTaskState(rawState, delivery.mode),
      createdAt,
      updatedAt,
    });
  };

  // Source A (authoritative in OpenClaw >= 2026.8): `openclaw.sqlite` -> `cron_jobs` (fallback: `cron`)
  let hasSqliteCronJobsTable = false;
  if (legacyDb) {
    try {
      const targetTable = tableExists(legacyDb, 'cron_jobs')
        ? 'cron_jobs'
        : tableExists(legacyDb, 'cron')
          ? 'cron'
          : null;
      if (targetTable) {
        hasSqliteCronJobsTable = targetTable === 'cron_jobs';
        const rows = legacyDb.prepare(`SELECT * FROM ${targetTable}`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const parsedJob = safeParseJsonObject(row.job_json) ?? { ...row };
          if (typeof parsedJob.id !== 'string' && typeof row.job_id === 'string') {
            parsedJob.id = row.job_id;
          }
          if (typeof parsedJob.name !== 'string' && typeof row.name === 'string') {
            parsedJob.name = row.name;
          }
          if (typeof parsedJob.description !== 'string' && typeof row.description === 'string') {
            parsedJob.description = row.description;
          }
          if (parsedJob.enabled === undefined && row.enabled !== undefined) {
            parsedJob.enabled = Boolean(row.enabled);
          }
          if (typeof parsedJob.agentId !== 'string' && typeof row.agent_id === 'string') {
            parsedJob.agentId = row.agent_id;
          }
          const stateOverride = safeParseJsonObject(row.state_json);
          pushRawJob(parsedJob, {
            declarationKey: typeof row.declaration_key === 'string' ? row.declaration_key : null,
            payloadKind: typeof row.payload_kind === 'string' ? row.payload_kind : null,
            stateOverride,
            updatedAtOverride: row.runtime_updated_at_ms ?? row.updated_at,
          });
        }
      }
    } catch {
      // ignore unreadable legacy cron table
    }
  }

  // Source B: `<openclawStateDir>/cron/jobs.json` (or `.migrated` strictly when SQLite had no `cron_jobs` table)
  const jsonCandidates = hasSqliteCronJobsTable
    ? [path.join(openclawStateDir, 'cron', 'jobs.json')]
    : [
        path.join(openclawStateDir, 'cron', 'jobs.json'),
        path.join(openclawStateDir, 'cron', 'jobs.json.migrated'),
      ];
  for (const jobsJsonPath of jsonCandidates) {
    if (!fs.existsSync(jobsJsonPath)) continue;
    const parsed = safeReadJson(jobsJsonPath);
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { jobs?: unknown }).jobs))
        ? (parsed as { jobs: unknown[] }).jobs
        : [];
    for (const item of list) {
      if (item && typeof item === 'object') pushRawJob(item as Record<string, unknown>);
    }
  }

  return results;
}

function extractReceiptIdFromTaskRunId(runId: unknown): string | null {
  if (typeof runId !== 'string') return null;
  if (!runId.startsWith('cron:')) return null;
  const parts = runId.split(':');
  return parts.length >= 4 && parts[3].trim() ? parts[3].trim() : null;
}

function extractLegacyCronRuns(params: {
  openclawStateDir: string;
  legacyDb: Database.Database | null;
  targetDb: Database.Database;
  migratedJobs: LegacyTaskImportRecord[];
}): LegacyRunImportRecord[] {
  const { openclawStateDir, legacyDb, targetDb, migratedJobs } = params;
  const taskDeliveryChannelById = new Map<string, string | null>();
  for (const job of migratedJobs) {
    if (!job.id) continue;
    const delivery = job.input.delivery;
    const channel = delivery?.mode === DeliveryMode.Announce ? (delivery.channel ?? null) : null;
    taskDeliveryChannelById.set(job.id, channel);
  }
  if (taskDeliveryChannelById.size === 0) return [];

  const runs: Array<LegacyRunImportRecord & { _startedMs: number }> = [];
  const seenReceiptIds = new Set<string>();
  const seenTimesByTask = new Map<string, number[]>();

  const hasRunNear = (taskId: string, startedMs: number, toleranceMs: number): boolean => {
    const times = seenTimesByTask.get(taskId);
    if (!times) return false;
    return times.some((t) => Math.abs(t - startedMs) <= toleranceMs);
  };

  const recordRunTime = (taskId: string, startedMs: number): void => {
    const times = seenTimesByTask.get(taskId);
    if (times) {
      times.push(startedMs);
    } else {
      seenTimesByTask.set(taskId, [startedMs]);
    }
  };

  // Source 1: `openclaw.sqlite` -> `task_runs WHERE runtime = 'cron'` (richest metadata & summaries)
  if (legacyDb && tableExists(legacyDb, 'task_runs')) {
    try {
      const rows = legacyDb
        .prepare("SELECT * FROM task_runs WHERE runtime = 'cron' ORDER BY COALESCE(started_at, created_at) DESC")
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const taskId = typeof row.source_id === 'string' ? row.source_id.trim() : '';
        if (!taskId || !taskDeliveryChannelById.has(taskId)) continue;

        const startedMs = toFiniteNumberOrNull(row.started_at) ?? toFiniteNumberOrNull(row.created_at);
        if (startedMs === null || startedMs <= 0) continue;

        const receiptId = extractReceiptIdFromTaskRunId(row.run_id);
        if (receiptId && seenReceiptIds.has(receiptId)) continue;
        if (hasRunNear(taskId, startedMs, RUN_DEDUPE_WINDOW_MS)) continue;

        const rawStatus = mapLegacyStatus(row.status);
        const status = rawStatus === TaskStatus.Running || rawStatus === null ? TaskStatus.Error : rawStatus;
        const endedMs = toFiniteNumberOrNull(row.ended_at);
        const durationMs = endedMs !== null && endedMs >= startedMs ? endedMs - startedMs : null;
        const rawError = typeof row.error === 'string' && row.error.trim() ? row.error.trim() : null;
        const error =
          status === TaskStatus.Success
            ? null
            : (rawError ?? (rawStatus === TaskStatus.Running || row.status === 'interrupted'
              ? 'Interrupted before completion'
              : null));
        const summary = typeof row.terminal_summary === 'string' && row.terminal_summary.trim()
          ? row.terminal_summary.trim()
          : null;
        const rawTaskRowId = typeof row.task_id === 'string' && row.task_id.trim()
          ? row.task_id.trim()
          : `${taskId}-${startedMs}`;

        if (receiptId) seenReceiptIds.add(receiptId);
        recordRunTime(taskId, startedMs);
        runs.push({
          id: `legacy-taskrun-${rawTaskRowId}`,
          taskId,
          sessionId: null,
          sessionKey: typeof row.child_session_key === 'string' && row.child_session_key.trim()
            ? row.child_session_key.trim()
            : null,
          status,
          startedAt: new Date(startedMs).toISOString(),
          finishedAt: endedMs !== null ? new Date(endedMs).toISOString() : null,
          durationMs,
          error,
          summary,
          deliveryError: null,
          deliveryStatus: mapLegacyDeliveryStatus(row.delivery_status),
          deliveryChannel: taskDeliveryChannelById.get(taskId) ?? null,
          _startedMs: startedMs,
        });
      }
    } catch {
      // ignore malformed task_runs table
    }
  }

  // Source 2: `openclaw.sqlite` -> `cron_run_receipts` (covers historical runs beyond `task_runs` retention)
  if (legacyDb && tableExists(legacyDb, 'cron_run_receipts')) {
    try {
      const rows = legacyDb
        .prepare('SELECT * FROM cron_run_receipts ORDER BY started_at_ms DESC')
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const taskId = typeof row.job_id === 'string' ? row.job_id.trim() : '';
        if (!taskId || !taskDeliveryChannelById.has(taskId)) continue;

        const startedMs = toFiniteNumberOrNull(row.started_at_ms);
        if (startedMs === null || startedMs <= 0) continue;

        const receiptId = typeof row.receipt_id === 'string' && row.receipt_id.trim()
          ? row.receipt_id.trim()
          : `${taskId}-${startedMs}`;
        if (seenReceiptIds.has(receiptId) || hasRunNear(taskId, startedMs, RUN_DEDUPE_WINDOW_MS)) {
          continue;
        }

        const rawStatus = mapLegacyStatus(row.status);
        const status = rawStatus === TaskStatus.Running || rawStatus === null ? TaskStatus.Error : rawStatus;
        const finishedMs = toFiniteNumberOrNull(row.finished_at_ms);
        const durationMs = finishedMs !== null && finishedMs >= startedMs ? finishedMs - startedMs : null;
        const rawError = typeof row.error_text === 'string' && row.error_text.trim()
          ? row.error_text.trim()
          : null;
        const error =
          status === TaskStatus.Success
            ? null
            : (rawError ?? (rawStatus === TaskStatus.Running || row.status === 'interrupted'
              ? 'Interrupted before completion'
              : null));

        seenReceiptIds.add(receiptId);
        recordRunTime(taskId, startedMs);
        runs.push({
          id: `legacy-receipt-${receiptId}`,
          taskId,
          sessionId: null,
          sessionKey: null,
          status,
          startedAt: new Date(startedMs).toISOString(),
          finishedAt: finishedMs !== null ? new Date(finishedMs).toISOString() : null,
          durationMs,
          error,
          summary: null,
          deliveryError: null,
          deliveryStatus: null,
          deliveryChannel: taskDeliveryChannelById.get(taskId) ?? null,
          _startedMs: startedMs,
        });
      }
    } catch {
      // ignore malformed cron_run_receipts table
    }
  }

  // Source 3: `<openclawStateDir>/cron/runs/*.jsonl` (and `.jsonl.migrated` matching migrated task IDs)
  const runsDir = path.join(openclawStateDir, 'cron', 'runs');
  if (fs.existsSync(runsDir)) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(runsDir);
    } catch {
      files = [];
    }
    for (const fileName of files) {
      const match = fileName.match(/^(.+?)\.jsonl(?:\.migrated)?$/);
      if (!match) continue;
      const fallbackJobId = match[1];
      let content: string;
      try {
        content = fs.readFileSync(path.join(runsDir, fileName), 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = safeParseJsonObject(trimmed);
        if (!entry) continue;
        const taskId = typeof entry.jobId === 'string' && entry.jobId.trim()
          ? entry.jobId.trim()
          : fallbackJobId;
        if (!taskDeliveryChannelById.has(taskId)) continue;
        if (typeof entry.action === 'string' && entry.action !== 'finished' && !entry.status) continue;

        const tsMs = toFiniteNumberOrNull(entry.ts);
        const startedMs = toFiniteNumberOrNull(entry.runAtMs) ?? tsMs;
        if (startedMs === null || startedMs <= 0) continue;
        if (hasRunNear(taskId, startedMs, RUN_DEDUPE_WINDOW_MS)) continue;

        const rawStatus = mapLegacyStatus(entry.status);
        let status = rawStatus === TaskStatus.Running || rawStatus === null ? TaskStatus.Error : rawStatus;
        const rawError = typeof entry.error === 'string' && entry.error.trim() ? entry.error.trim() : null;
        const deliveryError = typeof entry.deliveryError === 'string' && entry.deliveryError.trim()
          ? entry.deliveryError.trim()
          : null;
        if (status === TaskStatus.Error && rawError && deliveryError && rawError === deliveryError) {
          status = TaskStatus.Success;
        }
        const durationMs = toFiniteNumberOrNull(entry.durationMs);
        const finishedMs = tsMs !== null && tsMs >= startedMs
          ? tsMs
          : (durationMs !== null ? startedMs + durationMs : null);

        recordRunTime(taskId, startedMs);
        runs.push({
          id: `legacy-jsonl-${taskId}-${tsMs ?? startedMs}`,
          taskId,
          sessionId: null,
          sessionKey: typeof entry.sessionKey === 'string' && entry.sessionKey.trim()
            ? entry.sessionKey.trim()
            : null,
          status,
          startedAt: new Date(startedMs).toISOString(),
          finishedAt: finishedMs !== null ? new Date(finishedMs).toISOString() : null,
          durationMs,
          error: status === TaskStatus.Success ? null : rawError,
          summary: typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : null,
          deliveryError,
          deliveryStatus: mapLegacyDeliveryStatus(entry.deliveryStatus),
          deliveryChannel: taskDeliveryChannelById.get(taskId) ?? null,
          _startedMs: startedMs,
        });
      }
    }
  }

  // Source 4 + Session linking: link runs to existing `cowork_sessions` via `scheduled_task_id`
  // and recover historical single-run sessions predating `task_runs`/`cron_run_receipts`.
  if (tableExists(targetDb, 'cowork_sessions') && getTableColumns(targetDb, 'cowork_sessions').has('scheduled_task_id')) {
    try {
      const sessionRows = targetDb
        .prepare(
          'SELECT id, scheduled_task_id, created_at, updated_at FROM cowork_sessions WHERE scheduled_task_id IS NOT NULL ORDER BY created_at DESC',
        )
        .all() as Array<{
          id: string;
          scheduled_task_id: string;
          created_at: number;
          updated_at: number;
        }>;
      const sessionsByTask = new Map<string, typeof sessionRows>();
      for (const s of sessionRows) {
        if (!taskDeliveryChannelById.has(s.scheduled_task_id)) continue;
        const list = sessionsByTask.get(s.scheduled_task_id);
        if (list) list.push(s);
        else sessionsByTask.set(s.scheduled_task_id, [s]);
      }

      for (const run of runs) {
        const candidates = sessionsByTask.get(run.taskId);
        if (!candidates || candidates.length === 0) continue;

        let bestExact: { id: string; delta: number } | null = null;
        let coveringSessionId: string | null = null;
        for (const s of candidates) {
          const delta = Math.abs(s.created_at - run._startedMs);
          if (delta <= SESSION_MATCH_WINDOW_MS && (!bestExact || delta < bestExact.delta)) {
            bestExact = { id: s.id, delta };
          }
          if (
            !coveringSessionId
            && s.created_at - SESSION_MATCH_WINDOW_MS <= run._startedMs
            && run._startedMs <= s.updated_at + SESSION_MATCH_WINDOW_MS
          ) {
            coveringSessionId = s.id;
          }
        }
        if (bestExact) {
          run.sessionId = bestExact.id;
        } else if (!run.summary && !run.error && coveringSessionId) {
          run.sessionId = coveringSessionId;
        }
      }

      for (const [taskId, taskSessions] of sessionsByTask.entries()) {
        for (const s of taskSessions) {
          if (!Number.isFinite(s.created_at) || s.created_at <= 0) continue;
          if (hasRunNear(taskId, s.created_at, SESSION_MATCH_WINDOW_MS)) continue;

          // Skip long-lived multi-run container sessions when runs already fall inside their span.
          const spanMs = Math.max(0, (s.updated_at || s.created_at) - s.created_at);
          if (spanMs > CONTAINER_SESSION_SPAN_MS) {
            const times = seenTimesByTask.get(taskId) ?? [];
            const covered = times.some(
              (t) => s.created_at - SESSION_MATCH_WINDOW_MS <= t && t <= s.updated_at + SESSION_MATCH_WINDOW_MS,
            );
            if (covered) continue;
          }

          const finishedMs = Number.isFinite(s.updated_at) && s.updated_at >= s.created_at
            ? s.updated_at
            : null;
          const durationMs = finishedMs !== null ? Math.min(finishedMs - s.created_at, 3_600_000) : null;
          recordRunTime(taskId, s.created_at);
          runs.push({
            id: `legacy-session-${s.id}`,
            taskId,
            sessionId: s.id,
            sessionKey: null,
            status: TaskStatus.Success,
            startedAt: new Date(s.created_at).toISOString(),
            finishedAt: finishedMs !== null ? new Date(finishedMs).toISOString() : null,
            durationMs,
            error: null,
            summary: null,
            deliveryError: null,
            deliveryStatus: null,
            deliveryChannel: taskDeliveryChannelById.get(taskId) ?? null,
            _startedMs: s.created_at,
          });
        }
      }
    } catch {
      // ignore cowork_sessions lookup failure
    }
  }

  // Avoid leaving unresolvable OpenClaw session keys on runs without local
  // session/summary/error (which would trigger a retry spinner in RunSessionModal).
  return runs.map(({ _startedMs: _ignored, ...run }) => {
    if (!run.sessionId && !run.summary && !run.error) {
      return { ...run, sessionKey: null };
    }
    return run;
  });
}

export function migrateLegacyScheduledTasksAndRuns(params: {
  openclawStateDir: string;
  db: Database.Database;
  nowMs?: number;
}): { tasksImported: number; runsImported: number } {
  const { openclawStateDir, db, nowMs } = params;
  const openclawDbPath = path.join(openclawStateDir, 'state', 'openclaw.sqlite');
  const openedLegacy = openLegacyOpenClawDbReadOnly(openclawDbPath);

  try {
    const legacyDb = openedLegacy?.db ?? null;
    const scheduler = new LobsterScheduler({
      db,
      ...(typeof nowMs === 'number' ? { now: () => nowMs } : {}),
    });
    const legacyJobs = extractLegacyCronJobs(openclawStateDir, legacyDb);
    const tasksImported = scheduler.importLegacyJobs(legacyJobs);
    const legacyRuns = extractLegacyCronRuns({
      openclawStateDir,
      legacyDb,
      targetDb: db,
      migratedJobs: legacyJobs,
    });
    const runsImported = scheduler.importLegacyRuns(legacyRuns);
    return { tasksImported, runsImported };
  } finally {
    openedLegacy?.close();
  }
}

function isCronMigrationArchiveEntry(archivePath: string): boolean {
  const normalized = archivePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return (
    normalized === 'openclaw-state/state/openclaw.sqlite'
    || normalized === 'openclaw-state/state/openclaw.sqlite-wal'
    || normalized === 'openclaw-state/state/openclaw.sqlite-shm'
    || normalized.startsWith('openclaw-state/cron/')
  );
}

function findLegacyStateArchivePath(userDataDir: string, db: Database.Database): string | null {
  const rawReport = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
  if (rawReport) {
    try {
      const report = JSON.parse(rawReport) as MigrationV2Report;
      if (report?.legacyStateArchivePath && fs.existsSync(report.legacyStateArchivePath)) {
        return report.legacyStateArchivePath;
      }
    } catch {
      // fall through to directory scan
    }
  }

  const backupsRoot = path.join(userDataDir, LEGACY_OPENCLAW_BACKUP_DIR_NAME);
  if (!fs.existsSync(backupsRoot)) return null;
  try {
    const dirs = fs
      .readdirSync(backupsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const dirName of dirs) {
      const candidate = path.join(backupsRoot, dirName, 'legacy-openclaw-state.tar.gz');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

export interface LegacyScheduledTaskBackfillResult {
  status: 'skipped' | 'completed' | 'failed';
  tasksImported: number;
  runsImported: number;
  error?: string;
}

/**
 * One-shot idempotent backfill for users who completed OpenClaw -> DSH v2
 * migration before `cron_jobs` / run-history extraction was fixed.
 *
 * Streams only `openclaw-state/state/openclaw.sqlite*` and `openclaw-state/cron/*`
 * from `legacy-openclaw-backup/<ts>/legacy-openclaw-state.tar.gz` into a temp
 * directory, imports missing tasks & runs idempotently, and cleans up.
 */
export async function backfillLegacyScheduledTasksFromBackup(options: {
  userDataDir: string;
  db: Database.Database;
  now?: () => Date;
}): Promise<LegacyScheduledTaskBackfillResult> {
  const { userDataDir, db } = options;
  const now = options.now ?? (() => new Date());

  if (getKv(db, MIGRATION_V2_CRON_BACKFILL_KV_KEY)) {
    return { status: 'skipped', tasksImported: 0, runsImported: 0 };
  }

  const completedRaw = getKv(db, MIGRATION_V2_COMPLETED_KV_KEY);
  if (!completedRaw) {
    return { status: 'skipped', tasksImported: 0, runsImported: 0 };
  }

  try {
    const completedMeta = JSON.parse(completedRaw) as { freshInstall?: boolean };
    if (completedMeta?.freshInstall) {
      setKv(
        db,
        MIGRATION_V2_CRON_BACKFILL_KV_KEY,
        JSON.stringify({ completedAt: now().toISOString(), skipped: 'freshInstall' }),
      );
      return { status: 'skipped', tasksImported: 0, runsImported: 0 };
    }
  } catch {
    // Non-JSON completion marker still proceeds to archive lookup.
  }

  const archivePath = findLegacyStateArchivePath(userDataDir, db);
  if (!archivePath) {
    setKv(
      db,
      MIGRATION_V2_CRON_BACKFILL_KV_KEY,
      JSON.stringify({ completedAt: now().toISOString(), skipped: 'noBackupArchive' }),
    );
    return { status: 'skipped', tasksImported: 0, runsImported: 0 };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-cron-backfill-'));
  try {
    await extractMatchingEntriesFromTarGz(archivePath, tmpDir, isCronMigrationArchiveEntry);
    const extractedStateDir = path.join(tmpDir, 'openclaw-state');
    const { tasksImported, runsImported } = migrateLegacyScheduledTasksAndRuns({
      openclawStateDir: extractedStateDir,
      db,
      nowMs: now().getTime(),
    });

    const rawReport = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
    if (rawReport && (tasksImported > 0 || runsImported > 0)) {
      try {
        const report = JSON.parse(rawReport) as MigrationV2Report;
        if (report && report.version === 2 && report.summary) {
          report.summary.scheduledTasksMigrated =
            (report.summary.scheduledTasksMigrated ?? 0) + tasksImported;
          report.summary.scheduledTaskRunsMigrated =
            (report.summary.scheduledTaskRunsMigrated ?? 0) + runsImported;
          setKv(db, MIGRATION_V2_REPORT_KV_KEY, JSON.stringify(report));
          if (report.backupDir && fs.existsSync(report.backupDir)) {
            fs.writeFileSync(
              path.join(report.backupDir, 'migration-report.json'),
              `${JSON.stringify(report, null, 2)}\n`,
              'utf8',
            );
          }
        }
      } catch {
        // Best-effort report metadata update.
      }
    }

    setKv(
      db,
      MIGRATION_V2_CRON_BACKFILL_KV_KEY,
      JSON.stringify({ completedAt: now().toISOString(), tasksImported, runsImported }),
    );
    return { status: 'completed', tasksImported, runsImported };
  } catch (error) {
    return {
      status: 'failed',
      tasksImported: 0,
      runsImported: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Copy legacy `workspace-*` persona & memory files out of OpenClaw's state dir
 * into engine-independent `<userData>/workspaces/<agentId>/`, stripping the
 * old OpenClaw-managed `AGENTS.md` section and skipping `.dreams/`.
 */
function migrateLegacyWorkspaces(
  openclawStateDir: string,
  workspacesDir: string,
  incompatibleEntries: TarEntryInput[],
  archivedModules: MigrationV2ArchivedItem[],
): number {
  if (!fs.existsSync(openclawStateDir)) return 0;
  let migratedCount = 0;
  let dreamsFilesArchived = 0;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(openclawStateDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const memoryService = new LobsterMemoryService(workspacesDir);
  try {
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !dirent.name.startsWith('workspace-')) continue;
      const agentId = dirent.name.slice('workspace-'.length).trim() || 'main';
      const srcDir = path.join(openclawStateDir, dirent.name);
      const dstDir = memoryService.ensureAgentWorkspace(agentId);

      let copiedAny = false;
      for (const fileName of WORKSPACE_FILES_TO_MIGRATE) {
        const srcFile = path.join(srcDir, fileName);
        if (!fs.existsSync(srcFile)) continue;
        let content = fs.readFileSync(srcFile, 'utf8');
        if (fileName === WorkspaceFileName.Agents) {
          content = stripManagedAgentsSection(content);
        }
        if (fileName === WorkspaceFileName.Soul || fileName === WorkspaceFileName.Identity || content.trim()) {
          const dstFile = path.join(dstDir, fileName);
          if (!fs.existsSync(dstFile)) {
            fs.writeFileSync(dstFile, content, 'utf8');
          }
          copiedAny = true;
        }
      }

      // Copy daily memory notes (`memory/YYYY-MM-DD.md`).
      const srcDailyDir = path.join(srcDir, 'memory');
      if (fs.existsSync(srcDailyDir)) {
        const dstDailyDir = path.join(dstDir, 'memory');
        fs.mkdirSync(dstDailyDir, { recursive: true });
        for (const f of fs.readdirSync(srcDailyDir)) {
          if (!f.endsWith('.md')) continue;
          const srcMd = path.join(srcDailyDir, f);
          const dstMd = path.join(dstDailyDir, f);
          if (fs.statSync(srcMd).isFile() && !fs.existsSync(dstMd)) {
            fs.copyFileSync(srcMd, dstMd);
            copiedAny = true;
          }
        }
      }

      // Archive `.dreams/` into incompatible modules backup instead of migrating.
      const dreamsDir = path.join(srcDir, '.dreams');
      if (fs.existsSync(dreamsDir)) {
        const dreamEntries = collectDirectoryTarEntries(dreamsDir, `dreams/${agentId}`);
        incompatibleEntries.push(...dreamEntries);
        dreamsFilesArchived += dreamEntries.length;
      }

      if (copiedAny) {
        memoryService.reindexAgent(agentId);
        migratedCount += 1;
      }
    }
  } finally {
    memoryService.close();
  }

  if (dreamsFilesArchived > 0) {
    archivedModules.push({
      category: 'dreaming_embedding',
      label: 'Memory Dreaming archives (.dreams)',
      count: dreamsFilesArchived,
    });
  }
  return migratedCount;
}

/** Legacy workspaces can have just one persona file. SQLite supplies only missing files. */
function backfillAgentPersonaFiles(db: Database.Database, workspacesDir: string): void {
  const marker = 'engine.migration.v2.expertPersonas';
  if (getKv(db, marker)) return;
  const columns = getTableColumns(db, 'agents');
  if (columns.has('id') && columns.has('system_prompt') && columns.has('identity')) {
    const experts = db.prepare(`
      SELECT id, system_prompt AS systemPrompt, identity FROM agents
      WHERE id != ? AND (system_prompt != '' OR identity != '')
    `).all(AgentId.Main) as Array<{ id: string; systemPrompt: string; identity: string }>;
    for (const expert of experts) {
      seedAgentPersonaFiles(path.join(workspacesDir, sanitizeAgentId(expert.id)), expert);
    }
  }
  setKv(db, marker, '1');
}

/**
 * Resets any persisted `app_config.browserWebAccess` external browser mode to
 * `in-app`, strips dead external-only fields, and preserves all reusable
 * browser settings (`networkMode`, `credentialUseMode`, `credentialSaveMode`,
 * `blockedHostnames`, etc.).
 *
 * When `incompatibleEntries` / `archivedModules` are supplied during the full
 * v2 migration and an external browser configuration was active, archives the
 * removed external browser fields and records an `external_chrome` notice.
 */
function migrateLegacyBrowserDisplayModeConfig(
  db: Database.Database,
  incompatibleEntries?: TarEntryInput[],
  archivedModules?: MigrationV2ArchivedItem[],
): number {
  const rawAppConfig = getKv(db, APP_CONFIG_KEY);
  if (!rawAppConfig) return 0;

  const parsedAppConfig = safeParseJsonObject(rawAppConfig);
  if (!parsedAppConfig) return 0;

  const result = migrateBrowserDisplayModeConfig(parsedAppConfig);
  if (!result.changed) return 0;

  setKv(db, APP_CONFIG_KEY, JSON.stringify(result.nextConfig));

  if (!result.migratedExternalConfig) return 0;

  if (incompatibleEntries) {
    incompatibleEntries.push({
      archivePath: 'sqlite/external_browser_config.json',
      content: Buffer.from(JSON.stringify(result.archivedExternalConfig ?? {}, null, 2), 'utf8'),
    });
  }
  if (archivedModules) {
    archivedModules.push({
      category: 'external_chrome',
      label: 'External browser configuration (migrated to in-app browser)',
      count: 1,
    });
  }
  return 1;
}

/**
 * Read pending v2 migration report for `MigrationReportModal.tsx`.
 */
export function getPendingMigrationV2Report(db: Database.Database): MigrationV2Report | null {
  const raw = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MigrationV2Report;
    if (parsed && parsed.version === 2 && !parsed.dismissed) {
      return parsed;
    }
  } catch {
    // ignore malformed report
  }
  return null;
}

export function dismissMigrationV2Report(db: Database.Database): void {
  const raw = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as MigrationV2Report;
    if (parsed && parsed.version === 2) {
      parsed.dismissed = true;
      setKv(db, MIGRATION_V2_REPORT_KV_KEY, JSON.stringify(parsed));
    }
  } catch {
    // ignore
  }
}

/**
 * Run the 6-step pure offline atomic OpenClaw -> DSH migration.
 */
export function runLegacyOpenClawMigration(
  options: RunLegacyOpenClawMigrationOptions,
): LegacyOpenClawMigrationResult {
  const { userDataDir, sqlitePath } = options;
  const now = options.now ?? (() => new Date());

  if (!fs.existsSync(sqlitePath)) {
    return { status: MigrationV2Status.Skipped };
  }

  const openclawRootDir = path.join(userDataDir, 'openclaw');
  const openclawStateDir = path.join(openclawRootDir, 'state');
  const workspacesDir = path.join(userDataDir, WORKSPACES_DIR_NAME);

  let db = new Database(sqlitePath);
  try {
    // Idempotency guard: already migrated -> instant return.
    if (getKv(db, MIGRATION_V2_COMPLETED_KV_KEY)) {
      migrateLegacySubagentHistory(db, openclawStateDir);
      migrateLegacyConversationImages(db, userDataDir);
      backfillAgentPersonaFiles(db, workspacesDir);
      migrateLegacyBrowserDisplayModeConfig(db);
      return { status: MigrationV2Status.Skipped };
    }

    // Fresh install guard: no legacy OpenClaw state dir and no legacy rows -> skip.
    const hasOpenClawState = fs.existsSync(openclawStateDir);
    const hasLegacyEngineKv = getKv(db, 'cowork.agent_engine') === 'openclaw';
    if (!hasOpenClawState && !hasLegacyEngineKv) {
      backfillAgentPersonaFiles(db, workspacesDir);
      migrateLegacyConversationImages(db, userDataDir);
      migrateLegacyBrowserDisplayModeConfig(db);
      const migratedAt = now().toISOString();
      setKv(db, MIGRATION_V2_COMPLETED_KV_KEY, JSON.stringify({ migratedAt, freshInstall: true }));
      setKv(db, MIGRATION_V2_CRON_BACKFILL_KV_KEY, JSON.stringify({ completedAt: migratedAt, skipped: 'freshInstall' }));
      return { status: MigrationV2Status.Skipped };
    }

    // ── Step 1: Atomic Pre-Migration SQLite Snapshot ─────────────────────────
    const backupDir = path.join(
      userDataDir,
      LEGACY_OPENCLAW_BACKUP_DIR_NAME,
      formatBackupTimestamp(now()),
    );
    fs.mkdirSync(backupDir, { recursive: true });
    const sqliteSnapshotPath = path.join(backupDir, 'lobsterai.pre-v2.sqlite');

    // Flush WAL frames cleanly and create an exact point-in-time snapshot.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Non-WAL journal mode is also fine.
    }
    db.close();
    fs.copyFileSync(sqlitePath, sqliteSnapshotPath);
    db = new Database(sqlitePath);

    try {
      const incompatibleEntries: TarEntryInput[] = [];
      const archivedModules: MigrationV2ArchivedItem[] = [];
      const reauthRequired: MigrationV2ReauthItem[] = [];

      // ── Step 2: Offline Extract & Transform ──────────────────────────────
      migrateLegacySubagentHistory(db, openclawStateDir);
      migrateLegacyConversationImages(db, userDataDir);
      const externalBrowserConfigsMigrated = migrateLegacyBrowserDisplayModeConfig(
        db,
        incompatibleEntries,
        archivedModules,
      );
      const workspacesMigrated = migrateLegacyWorkspaces(
        openclawStateDir,
        workspacesDir,
        incompatibleEntries,
        archivedModules,
      );
      backfillAgentPersonaFiles(db, workspacesDir);

      // Scheduled tasks & run history: import OpenClaw cron jobs & runs into LobsterScheduler tables.
      const {
        tasksImported: scheduledTasksMigrated,
        runsImported: scheduledTaskRunsMigrated,
      } = migrateLegacyScheduledTasksAndRuns({
        openclawStateDir,
        db,
        nowMs: now().getTime(),
      });

      // IM allowFrom whitelists for the 7 retained platforms.
      let imAllowListsMigrated = 0;
      const credsDir = path.join(openclawStateDir, 'credentials');
      const allowListsByPlatform: Record<string, string[]> = {};
      if (fs.existsSync(credsDir)) {
        for (const f of fs.readdirSync(credsDir)) {
          const match = f.match(/^([a-z0-9_-]+)-allowFrom\.json$/i);
          if (!match) continue;
          const platform = match[1].toLowerCase();
          if (!(RETAINED_IM_PLATFORM_LIST as readonly string[]).includes(platform)) continue;
          const parsed = safeReadJson(path.join(credsDir, f));
          const list = Array.isArray(parsed)
            ? parsed.map(String)
            : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { allowFrom?: unknown }).allowFrom))
              ? (parsed as { allowFrom: unknown[] }).allowFrom.map(String)
              : [];
          if (list.length > 0) {
            allowListsByPlatform[platform] = list;
            imAllowListsMigrated += 1;
          }
        }
      }
      if (imAllowListsMigrated > 0) {
        setKv(db, 'im.migrated_allow_from.v2', JSON.stringify(allowListsByPlatform));
      }

      // Detect Weixin state requiring re-login on new DSH channel driver.
      if (fs.existsSync(path.join(openclawStateDir, 'openclaw-weixin'))) {
        reauthRequired.push({
          kind: 'im_weixin',
          id: 'weixin',
          label: 'Weixin Bot (QR re-login required)',
        });
      }

      // Clear stale `mcp_launch_resolutions` pointing to `openclaw/mcp-packages`.
      let mcpLaunchCachesCleared = 0;
      if (tableExists(db, 'mcp_launch_resolutions')) {
        const cols = getTableColumns(db, 'mcp_launch_resolutions');
        const pathCols = ['install_dir', 'command', 'args_json', 'resolved_path'].filter((c) => cols.has(c));
        if (pathCols.length > 0) {
          const whereClause = pathCols
            .map((c) => `LOWER(COALESCE(${c}, '')) LIKE '%openclaw%' OR LOWER(COALESCE(${c}, '')) LIKE '%mcp-packages%'`)
            .join(' OR ');
          const res = db.prepare(`DELETE FROM mcp_launch_resolutions WHERE ${whereClause}`).run();
          mcpLaunchCachesCleared = res.changes;
        }
      }

      // Inspect Remote MCP OAuth servers needing reauth after migration.
      if (tableExists(db, 'mcp_servers')) {
        const cols = getTableColumns(db, 'mcp_servers');
        if (cols.has('id') && cols.has('config_json')) {
          const selectCols = cols.has('name') ? 'id, name, config_json' : 'id, config_json';
          const mcpRows = db.prepare(`SELECT ${selectCols} FROM mcp_servers`).all() as Array<{
            id: string;
            name?: string;
            config_json?: string;
          }>;
          for (const row of mcpRows) {
            if (typeof row.config_json === 'string' && row.config_json.includes('"oauth"')) {
              reauthRequired.push({
                kind: 'mcp_oauth',
                id: row.id,
                label: row.name || row.id,
              });
            }
          }
        }
      }

      // Count historical sessions preserved for Lazy Context Bridge.
      let sessionsPreservedForLazyBridge = 0;
      if (tableExists(db, 'cowork_sessions')) {
        const cols = getTableColumns(db, 'cowork_sessions');
        const row = cols.has('claude_session_id')
          ? (db
              .prepare("SELECT COUNT(*) AS cnt FROM cowork_sessions WHERE claude_session_id IS NULL OR claude_session_id NOT LIKE 'dsh:%'")
              .get() as { cnt: number })
          : (db.prepare('SELECT COUNT(*) AS cnt FROM cowork_sessions').get() as { cnt: number });
        sessionsPreservedForLazyBridge = row.cnt;
      }

      // ── Step 3: Archive Incompatible & Retired Modules ───────────────────
      // 3a. Legacy OpenClaw `user_plugins` table
      if (tableExists(db, 'user_plugins')) {
        const plugins = db.prepare('SELECT * FROM user_plugins').all();
        if (plugins.length > 0) {
          incompatibleEntries.push({
            archivePath: 'sqlite/user_plugins.json',
            content: Buffer.from(JSON.stringify(plugins, null, 2), 'utf8'),
          });
          archivedModules.push({
            category: 'user_plugins',
            label: 'Legacy OpenClaw user plugins',
            count: plugins.length,
          });
        }
      }

      // 3b. `third-party-extensions/` & `openclaw/state/extensions/`
      const thirdPartyExtDir = path.join(userDataDir, 'third-party-extensions');
      const thirdPartyEntries = collectDirectoryTarEntries(thirdPartyExtDir, 'third-party-extensions');
      const openclawExtEntries = collectDirectoryTarEntries(
        path.join(openclawStateDir, 'extensions'),
        'openclaw-extensions',
      );
      if (thirdPartyEntries.length > 0 || openclawExtEntries.length > 0) {
        incompatibleEntries.push(...thirdPartyEntries, ...openclawExtEntries);
        archivedModules.push({
          category: 'third_party_extensions',
          label: 'Legacy OpenClaw extensions',
          count: thirdPartyEntries.length + openclawExtEntries.length,
        });
      }

      // 3c. `openclaw.user.json` & `openclaw.json`
      for (const cfgFile of ['openclaw.user.json', 'openclaw.json']) {
        const full = path.join(openclawStateDir, cfgFile);
        if (fs.existsSync(full)) {
          incompatibleEntries.push({
            archivePath: `openclaw-config/${cfgFile}`,
            content: fs.readFileSync(full),
          });
          if (cfgFile === 'openclaw.user.json') {
            archivedModules.push({
              category: 'openclaw_config',
              label: 'openclaw.user.json custom overrides',
              count: 1,
            });
          }
        }
      }

      // 3d. Retired IM platform configs (POPO, NIM, NetEase Bee, Email)
      if (tableExists(db, 'im_config')) {
        const imCols = getTableColumns(db, 'im_config');
        const keyCol = imCols.has('platform') ? 'platform' : imCols.has('key') ? 'key' : null;
        if (keyCol) {
          const placeholders = RETIRED_IM_PLATFORMS.map(() => '?').join(', ');
          const retiredRows = db
            .prepare(`SELECT * FROM im_config WHERE LOWER(${keyCol}) IN (${placeholders})`)
            .all(...RETIRED_IM_PLATFORMS) as Array<Record<string, unknown>>;
          if (retiredRows.length > 0) {
            incompatibleEntries.push({
              archivePath: 'sqlite/retired_im_config.json',
              content: Buffer.from(JSON.stringify(retiredRows, null, 2), 'utf8'),
            });
            archivedModules.push({
              category: 'retired_im',
              label: 'Retired IM configs (POPO / NIM / NetEase Bee / Email)',
              count: retiredRows.length,
            });
          }
        }
      }

      // 3e. Legacy `cowork_message_versions` archive (Option B drops in-place version tree)
      if (tableExists(db, 'cowork_message_versions')) {
        const versions = db.prepare('SELECT * FROM cowork_message_versions').all();
        if (versions.length > 0) {
          incompatibleEntries.push({
            archivePath: 'sqlite/cowork_message_versions.json',
            content: Buffer.from(JSON.stringify(versions, null, 2), 'utf8'),
          });
          archivedModules.push({
            category: 'message_versions',
            label: 'Historical in-place message edit versions',
            count: versions.length,
          });
        }
      }

      // Write incompatible modules archive (even if empty, guarantees manifest exists).
      const incompatibleArchivePath = path.join(backupDir, 'incompatible-modules-backup.tar.gz');
      writeTarGzArchive(incompatibleArchivePath, incompatibleEntries);

      // ── Step 4: Verify Integrity & Atomic Commit ─────────────────────────
      const quickCheck = db.pragma('quick_check') as Array<{ quick_check: string }>;
      if (!quickCheck.every((r) => r.quick_check === 'ok')) {
        throw new Error(`SQLite quick_check failed after migration: ${JSON.stringify(quickCheck)}`);
      }
      if (!fs.existsSync(incompatibleArchivePath) || fs.statSync(incompatibleArchivePath).size === 0) {
        throw new Error('Incompatible modules archive failed verification');
      }

      // ── Step 5: Free Disposable Caches & Archive Remaining `openclaw/state` ─
      let disposableBytesFreed = 0;
      const disposableDirs = [
        path.join(openclawRootDir, 'logs'),
        path.join(openclawRootDir, 'mcp-packages'),
        path.join(openclawRootDir, '.compile-cache'),
        path.join(openclawRootDir, 'repair-backups'),
        path.join(openclawStateDir, '.compile-cache'),
        path.join(openclawStateDir, 'memory'),
        path.join(userDataDir, 'dsh-runtime'), // Old experimental 160MB runtime cache
      ];
      for (const dir of disposableDirs) {
        if (!fs.existsSync(dir)) continue;
        disposableBytesFreed += measureDirSize(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      }

      let legacyStateArchivePath: string | null = null;
      if (fs.existsSync(openclawStateDir)) {
        const remainingEntries = collectDirectoryTarEntries(openclawStateDir, 'openclaw-state');
        if (remainingEntries.length > 0) {
          legacyStateArchivePath = path.join(backupDir, 'legacy-openclaw-state.tar.gz');
          writeTarGzArchive(legacyStateArchivePath, remainingEntries);
        }
      }

      // Build final report and commit atomically into SQLite `kv`.
      const report: MigrationV2Report = {
        version: 2,
        migratedAt: now().toISOString(),
        backupDir,
        incompatibleArchivePath,
        legacyStateArchivePath,
        sqliteSnapshotPath,
        dismissed: archivedModules.length === 0 && reauthRequired.length === 0,
        summary: {
          workspacesMigrated,
          scheduledTasksMigrated,
          scheduledTaskRunsMigrated,
          imAllowListsMigrated,
          sessionsPreservedForLazyBridge,
          mcpLaunchCachesCleared,
          disposableBytesFreed,
          externalBrowserConfigsMigrated,
        },
        archivedModules,
        reauthRequired,
      };

      const commitTx = db.transaction(() => {
        setKv(db, 'cowork.agent_engine', 'dsh');
        setKv(db, MIGRATION_V2_REPORT_KV_KEY, JSON.stringify(report));
        setKv(db, MIGRATION_V2_COMPLETED_KV_KEY, JSON.stringify({ migratedAt: report.migratedAt, backupDir }));
        setKv(
          db,
          MIGRATION_V2_CRON_BACKFILL_KV_KEY,
          JSON.stringify({
            completedAt: report.migratedAt,
            tasksImported: scheduledTasksMigrated,
            runsImported: scheduledTaskRunsMigrated,
          }),
        );
      });
      commitTx();

      fs.writeFileSync(
        path.join(backupDir, 'migration-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );

      // Remove old OpenClaw directory & third-party-extensions only AFTER
      // SQLite commit and backup archives are verified on disk.
      if (fs.existsSync(openclawRootDir)) {
        fs.rmSync(openclawRootDir, { recursive: true, force: true });
      }
      if (fs.existsSync(thirdPartyExtDir)) {
        fs.rmSync(thirdPartyExtDir, { recursive: true, force: true });
      }

      return { status: MigrationV2Status.Completed, report };
    } catch (error) {
      // Automatic rollback of SQLite from pre-v2 snapshot; leaves openclaw/state untouched.
      try {
        db.close();
      } catch {
        // ignore close error
      }
      try {
        if (fs.existsSync(sqliteSnapshotPath)) {
          fs.copyFileSync(sqliteSnapshotPath, sqlitePath);
        }
      } catch {
        // best-effort rollback
      }
      return {
        status: MigrationV2Status.Failed,
        rolledBack: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    try {
      if (db.open) db.close();
    } catch {
      // already closed
    }
  }
}
