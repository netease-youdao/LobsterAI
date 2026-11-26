// Pure Offline 6-Step Atomic OpenClaw -> DeepSeek Harness (DSH) Migrator.
//
// Runs BEFORE DSH boots on first launch after upgrading to LobsterAI v2.
// Zero OpenClaw runtime dependency — reads legacy OpenClaw files and SQLite
// tables purely offline, snapshots SQLite before any mutation, archives every
// incompatible/retired module into `legacy-openclaw-backup/<ts>/`, verifies
// integrity, rolls back automatically on failure, and cleans up disposable
// OpenClaw caches only after atomic commit succeeds.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
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
  LEGACY_DREAM_DIARY_FILENAME,
  LEGACY_DREAM_DIARY_LOWERCASE_FILENAME,
} from '../../shared/cowork/dreamDiary';
import { CoworkMessageEditPhase } from '../../shared/cowork/messageEdit';
import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_PERMISSION_PRESET_KV_KEY,
  LEGACY_OPENCLAW_BACKUP_DIR_NAME,
  mapLegacyExecutionModeToPermissionPreset,
  parseDshPermissionPreset,
  RETAINED_IM_PLATFORM_LIST,
  RetiredImPlatform,
  WORKSPACES_DIR_NAME,
} from '../../shared/dshEngine/hostConstants';
import { McpAuthMode } from '../../shared/mcp/auth';
import { normalizeMcpServerUrlInput } from '../../shared/mcp/url';
import {
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_CRON_BACKFILL_KV_KEY,
  MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
  MIGRATION_V2_MCP_OAUTH_BACKFILL_KV_KEY,
  MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY,
  MIGRATION_V2_REPORT_KV_KEY,
  MIGRATION_V2_TAVILY_BACKFILL_KV_KEY,
  MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY,
  MIGRATION_V2_WEIXIN_CREDENTIALS_KEY,
  type MigrationV2ArchivedItem,
  type MigrationV2ReauthItem,
  type MigrationV2Report,
  MigrationV2Status,
} from '../../shared/migration/constants';
import { NeteaseMail } from '../../shared/neteaseMail/constants';
import {
  XAI_AUTH_CREDENTIAL_TYPE,
  XAI_AUTH_PROVIDER,
  type XaiOAuthCredential,
} from '../../shared/openclawEngine/xaiAuthStore';
import { type Platform, PlatformRegistry } from '../../shared/platform';
import { cpRecursiveSync } from '../fsCompat';
import { seedAgentPersonaFiles } from '../libs/agentPersonaFiles';
import {
  APP_CONFIG_KEY,
  migrateBrowserDisplayModeConfig,
} from '../libs/browserDisplayModeMigration';
import {
  encodeMigratedMcpOAuthToken,
  MCP_OAUTH_TOKEN_KV_PREFIX,
  type McpOAuthTokenRecord,
} from '../mcp/mcpOAuthManager';
import { findLegacyDreamDiaryFile } from '../memory/legacyDreamDiaryReader';
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
import { legacyImBotIdentities, preserveLegacyImBotIdentities } from './legacyImBotIdentities';
import { readLegacyNeteaseMailToken } from './legacyNeteaseMail';
import { seedLegacySessionsToDsh } from './legacySessionSeeder';
import { migrateLegacySubagentHistory } from './legacySubagentHistory';
import {
  type ExtractedLegacyTavilyConfig,
  extractLegacyTavilyConfig,
  LegacyTavilySource,
  type LegacyUserPluginRow,
  migrateLegacyTavilyPluginToMcp,
} from './legacyTavilyMigration';
import { migrateLegacyWeixinCredentials, WEIXIN_REAUTH_ITEM } from './legacyWeixinCredentials';
import {
  collectDirectoryTarEntries,
  extractMatchingEntriesFromTarGz,
  type TarEntryInput,
  writeTarGzArchive,
} from './tarGzUtil';

export {
  type ExtractedLegacyTavilyConfig,
  extractLegacyTavilyConfig,
  LegacyTavilySource,
  migrateLegacyTavilyPluginToMcp,
};

export interface RunLegacyOpenClawMigrationOptions {
  /** Electron userData root directory. */
  userDataDir: string;
  /** Absolute path to `lobsterai.sqlite`. */
  sqlitePath: string;
  isPackaged?: boolean;
  /** Optional clock override for deterministic backup folder timestamps. */
  now?: () => Date;
  /**
   * When true (default for app startup), skip synchronous deletion of
   * disposable cache directories so window creation is never blocked by
   * removing tens of thousands of NTFS files; callers run
   * `cleanupLegacyOpenClawDisposableCaches(userDataDir)` asynchronously after
   * the main window is shown.
   */
  deferDisposableCacheCleanup?: boolean;
}

export interface LegacyOpenClawMigrationResult {
  status: MigrationV2Status;
  report?: MigrationV2Report;
  rolledBack?: boolean;
  error?: string;
}

const RETIRED_IM_PLATFORMS: readonly string[] = [
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

function copyLegacyMemoryMarkdownRecursive(
  srcDir: string,
  dstDir: string,
  agentId: string,
  incompatibleEntries: TarEntryInput[],
  relPrefix = '',
): { copiedAny: boolean; dreamsFilesArchived: number } {
  let copiedAny = false;
  let dreamsFilesArchived = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return { copiedAny, dreamsFilesArchived };
  }

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.dreams') {
        const archivePrefix = relPrefix
          ? `dreams/${agentId}/memory/${relPrefix}/.dreams`
          : `dreams/${agentId}/memory/.dreams`;
        const dreamEntries = collectDirectoryTarEntries(srcPath, archivePrefix);
        incompatibleEntries.push(...dreamEntries);
        dreamsFilesArchived += dreamEntries.length;
        continue;
      }
      const nextRelPrefix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const nested = copyLegacyMemoryMarkdownRecursive(
        srcPath,
        path.join(dstDir, entry.name),
        agentId,
        incompatibleEntries,
        nextRelPrefix,
      );
      if (nested.copiedAny) copiedAny = true;
      dreamsFilesArchived += nested.dreamsFilesArchived;
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const dstPath = path.join(dstDir, entry.name);
    if (!fs.existsSync(dstPath)) {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
      copiedAny = true;
    }
  }

  return { copiedAny, dreamsFilesArchived };
}

export interface LegacyDreamDiaryBackfillResult {
  status: 'skipped' | 'completed' | 'failed';
  diariesRestored: number;
  error?: string;
}

function copyLegacyDreamDiaryFile(srcFile: string, dstDir: string): boolean {
  if (!fs.existsSync(srcFile)) return false;
  const content = fs.readFileSync(srcFile, 'utf8');
  if (!content.trim()) return false;
  if (findLegacyDreamDiaryFile(dstDir)) return false;

  fs.mkdirSync(dstDir, { recursive: true });
  const dstFile = path.join(dstDir, LEGACY_DREAM_DIARY_FILENAME);
  fs.writeFileSync(dstFile, content, 'utf8');
  try {
    const stat = fs.statSync(srcFile);
    fs.utimesSync(dstFile, stat.atime, stat.mtime);
  } catch {
    // Best-effort mtime preservation.
  }
  return true;
}

interface ParsedDreamDiaryArchiveEntry {
  agentId: string;
  isCanonicalWorkspace: boolean;
  isUpperCase: boolean;
}

function parseDreamDiaryArchiveEntry(archivePath: string): ParsedDreamDiaryArchiveEntry | null {
  const normalized = archivePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
  const stripped = normalized.startsWith('openclaw-state/')
    ? normalized.slice('openclaw-state/'.length)
    : normalized;
  const segments = stripped.split('/').filter(Boolean);
  if (segments.length !== 2) return null;

  const [dirName, fileName] = segments;
  if (fileName.toLowerCase() !== LEGACY_DREAM_DIARY_LOWERCASE_FILENAME) return null;
  if (dirName !== 'workspace' && !dirName.startsWith('workspace-')) return null;

  const rawAgentId = dirName === 'workspace'
    ? AgentId.Main
    : dirName.slice('workspace-'.length).trim() || AgentId.Main;
  try {
    return {
      agentId: sanitizeAgentId(rawAgentId),
      isCanonicalWorkspace: dirName !== 'workspace',
      isUpperCase: fileName === LEGACY_DREAM_DIARY_FILENAME,
    };
  } catch {
    return null;
  }
}

function isDreamDiaryArchiveEntry(archivePath: string): boolean {
  return parseDreamDiaryArchiveEntry(archivePath) !== null;
}

function findIncompatibleModulesArchivePath(userDataDir: string, db: Database.Database): string | null {
  const rawReport = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
  if (rawReport) {
    try {
      const report = JSON.parse(rawReport) as MigrationV2Report;
      if (report?.incompatibleArchivePath && fs.existsSync(report.incompatibleArchivePath)) {
        return report.incompatibleArchivePath;
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
      const candidate = path.join(backupsRoot, dirName, 'incompatible-modules-backup.tar.gz');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function isTavilyMigrationArchiveEntry(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return (
    normalized === 'sqlite/user_plugins.json'
    || normalized === 'openclaw-config/openclaw.user.json'
    || normalized === 'openclaw-config/openclaw.json'
  );
}

export interface LegacyTavilyBackfillResult {
  status: 'skipped' | 'completed' | 'failed';
  migrated: boolean;
  error?: string;
}

const LEGACY_MCP_TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_-]/g;
const LEGACY_MCP_TOOL_NAME_MAX_PREFIX = 30;
const LEGACY_MCP_OAUTH_REQUESTER_SUFFIX_RE = /-r-[0-9a-f]{16}$/i;

function hasNonAsciiChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

function legacySafeServerKey(name: string): string {
  if (!hasNonAsciiChar(name)) return name;
  const hash = createHash('md5').update(name).digest('hex').slice(0, 8);
  return `mcp-${hash}`;
}

function legacySanitizeServerName(raw: string): string {
  const cleaned = raw.trim().replace(LEGACY_MCP_TOOL_NAME_SAFE_RE, '-');
  const normalized = cleaned || 'mcp';
  const providerSafe = /^[A-Za-z]/.test(normalized) ? normalized : `mcp-${normalized}`;
  return providerSafe.length > LEGACY_MCP_TOOL_NAME_MAX_PREFIX
    ? providerSafe.slice(0, LEGACY_MCP_TOOL_NAME_MAX_PREFIX)
    : providerSafe;
}

/**
 * Compute OpenClaw's canonical operator `mcp_oauth_stores.store_key` for a
 * LobsterAI MCP server name & URL.
 */
export function computeLegacyMcpOAuthStoreKey(serverName: string, serverUrl: string): string {
  const serverKey = legacySafeServerKey(serverName);
  const safeName = legacySanitizeServerName(serverKey);
  const hash = createHash('sha256').update(serverKey).update('\0').update(serverUrl).digest('hex');
  return `${safeName}-${hash.slice(0, 16)}`;
}

interface LegacyMcpOAuthStoreEntry {
  storeKey: string;
  store: Record<string, unknown>;
  updatedAt: number | null;
}

function isLegacyOAuthMcpRow(
  config: Record<string, unknown>,
  transportType?: string | null,
): boolean {
  if (typeof transportType === 'string' && transportType.trim().toLowerCase() === 'stdio') {
    return false;
  }
  if (config.auth === McpAuthMode.OAuth) return true;
  if (config.oauth === true) return true;
  const legacyOAuthObj = safeParseJsonObject(config.oauth);
  if (legacyOAuthObj && legacyOAuthObj.enabled !== false) return true;
  return false;
}

function normalizeUrlForComparison(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const trimmedPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${trimmedPath}`.toLowerCase();
  } catch {
    return null;
  }
}

function extractOriginLower(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function collectCandidateUrls(rawUrl: string | undefined): string[] {
  if (!rawUrl || !rawUrl.trim()) return [];
  const candidates: string[] = [];
  const pushUnique = (val: string) => {
    if (val && !candidates.includes(val)) candidates.push(val);
  };
  const trimmed = rawUrl.trim();
  const normalized = normalizeMcpServerUrlInput(trimmed);
  if (normalized.ok) {
    pushUnique(normalized.url);
    pushUnique(normalized.url.replace(/\/+$/, ''));
  }
  pushUnique(trimmed);
  pushUnique(trimmed.replace(/\/+$/, ''));
  if (!trimmed.endsWith('/')) {
    pushUnique(`${trimmed}/`);
  }
  return candidates;
}

function loadLegacyMcpOAuthStores(openclawStateDir: string): LegacyMcpOAuthStoreEntry[] {
  const entriesByKey = new Map<string, LegacyMcpOAuthStoreEntry>();

  const openclawDbPath = path.join(openclawStateDir, 'state', 'openclaw.sqlite');
  const opened = openLegacyOpenClawDbReadOnly(openclawDbPath);
  if (opened) {
    try {
      if (tableExists(opened.db, 'mcp_oauth_stores')) {
        const rows = opened.db
          .prepare('SELECT store_key, format_version, store_json, updated_at FROM mcp_oauth_stores')
          .all() as Array<{
            store_key?: unknown;
            format_version?: unknown;
            store_json?: unknown;
            updated_at?: unknown;
          }>;
        for (const row of rows) {
          if (typeof row.store_key !== 'string' || !row.store_key.trim()) continue;
          const parsed = safeParseJsonObject(row.store_json);
          if (!parsed) continue;
          entriesByKey.set(row.store_key, {
            storeKey: row.store_key,
            store: parsed,
            updatedAt: toFiniteNumberOrNull(row.updated_at),
          });
        }
      }
    } catch {
      // Ignore unreadable legacy mcp_oauth_stores table.
    } finally {
      opened.close();
    }
  }

  // Fallback for retired pre-SQLite JSON files (`<openclawStateDir>/mcp-oauth/<storeKey>.json`).
  // Never override a canonical SQLite row (including explicit `credentialState: "cleared"`).
  const legacyJsonDir = path.join(openclawStateDir, 'mcp-oauth');
  if (fs.existsSync(legacyJsonDir)) {
    try {
      for (const fileName of fs.readdirSync(legacyJsonDir)) {
        if (!fileName.endsWith('.json')) continue;
        const storeKey = fileName.slice(0, -'.json'.length);
        if (!storeKey || entriesByKey.has(storeKey)) continue;
        const fullPath = path.join(legacyJsonDir, fileName);
        const parsed = safeParseJsonObject(safeReadJson(fullPath));
        if (!parsed) continue;
        let mtimeMs: number | null = null;
        try {
          mtimeMs = Math.floor(fs.statSync(fullPath).mtimeMs);
        } catch {
          mtimeMs = null;
        }
        entriesByKey.set(storeKey, {
          storeKey,
          store: parsed,
          updatedAt: mtimeMs,
        });
      }
    } catch {
      // Ignore unreadable legacy mcp-oauth directory.
    }
  }

  return Array.from(entriesByKey.values());
}

function extractUsableTokenRecordFromLegacyStore(params: {
  serverId: string;
  serverUrl?: string;
  entry: LegacyMcpOAuthStoreEntry;
  nowMs: number;
}): McpOAuthTokenRecord | null {
  const { serverId, serverUrl, entry, nowMs } = params;
  const { store } = entry;

  if (store.credentialState === 'cleared' || store.credentialState === 'uninitialized') {
    return null;
  }

  const tokens = safeParseJsonObject(store.tokens);
  const accessToken = typeof tokens?.access_token === 'string' && tokens.access_token.trim()
    ? tokens.access_token.trim()
    : null;
  if (!accessToken) return null;

  const refreshToken = typeof tokens?.refresh_token === 'string' && tokens.refresh_token.trim()
    ? tokens.refresh_token.trim()
    : undefined;
  const tokenType = typeof tokens?.token_type === 'string' && tokens.token_type.trim()
    ? tokens.token_type.trim()
    : 'Bearer';
  const scope = typeof tokens?.scope === 'string' && tokens.scope.trim()
    ? tokens.scope.trim()
    : undefined;
  const expiresAtMs = toFiniteNumberOrNull(store.tokenExpiresAt) ?? undefined;

  const clientInfo = safeParseJsonObject(store.clientInformation);
  const clientId = typeof clientInfo?.client_id === 'string' && clientInfo.client_id.trim()
    ? clientInfo.client_id.trim()
    : undefined;
  const clientSecret = typeof clientInfo?.client_secret === 'string' && clientInfo.client_secret.length > 0
    ? clientInfo.client_secret
    : undefined;
  const tokenEndpointAuthMethod =
    typeof clientInfo?.token_endpoint_auth_method === 'string'
    && clientInfo.token_endpoint_auth_method.trim()
      ? clientInfo.token_endpoint_auth_method.trim()
      : undefined;

  const discoveryState = safeParseJsonObject(store.discoveryState);
  const asMeta = safeParseJsonObject(discoveryState?.authorizationServerMetadata);
  const resourceMeta = safeParseJsonObject(discoveryState?.resourceMetadata);
  const tokenEndpoint = typeof asMeta?.token_endpoint === 'string' && asMeta.token_endpoint.trim()
    ? asMeta.token_endpoint.trim()
    : undefined;

  const normalizedUrlResult = serverUrl ? normalizeMcpServerUrlInput(serverUrl) : null;
  const fallbackResource = normalizedUrlResult?.ok ? normalizedUrlResult.url : undefined;
  const resource = (typeof resourceMeta?.resource === 'string' && resourceMeta.resource.trim()
    ? resourceMeta.resource.trim()
    : undefined) ?? fallbackResource;

  const isExpired = expiresAtMs !== undefined && expiresAtMs <= nowMs;
  const isRefreshable = Boolean(refreshToken && tokenEndpoint);
  if (isExpired && !isRefreshable) {
    return null;
  }

  return {
    serverId,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    ...(scope ? { scope } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
    ...(resource ? { resource } : {}),
    updatedAt: entry.updatedAt ?? nowMs,
  };
}

function matchLegacyMcpOAuthStore(params: {
  serverName: string;
  serverUrl?: string;
  entries: LegacyMcpOAuthStoreEntry[];
  usedStoreKeys: Set<string>;
}): LegacyMcpOAuthStoreEntry | null {
  const { serverName, serverUrl, entries, usedStoreKeys } = params;
  const operatorEntries = entries.filter(
    (e) => !usedStoreKeys.has(e.storeKey) && !LEGACY_MCP_OAUTH_REQUESTER_SUFFIX_RE.test(e.storeKey),
  );
  if (operatorEntries.length === 0) return null;

  const byKey = new Map(operatorEntries.map((e) => [e.storeKey, e]));

  // Pass 1: Exact OpenClaw store_key match across normalized/raw URL variants.
  const urlCandidates = collectCandidateUrls(serverUrl);
  const safeKey = legacySafeServerKey(serverName);
  const nameVariants = safeKey === serverName ? [serverName] : [safeKey, serverName];
  for (const candidateName of nameVariants) {
    const safeName = legacySanitizeServerName(candidateName);
    for (const candidateUrl of urlCandidates) {
      const hash = createHash('sha256')
        .update(candidateName)
        .update('\0')
        .update(candidateUrl)
        .digest('hex');
      const key = `${safeName}-${hash.slice(0, 16)}`;
      const exact = byKey.get(key);
      if (exact) return exact;
    }
  }

  // Pass 2: Fallback match by normalized resource URL inside `discoveryState`.
  const targetNormalizedUrl = normalizeUrlForComparison(serverUrl);
  if (targetNormalizedUrl) {
    const resourceMatches = operatorEntries.filter((entry) => {
      const discovery = safeParseJsonObject(entry.store.discoveryState);
      const resourceMeta = safeParseJsonObject(discovery?.resourceMetadata);
      const storeResource = typeof resourceMeta?.resource === 'string'
        ? normalizeUrlForComparison(resourceMeta.resource)
        : null;
      return storeResource === targetNormalizedUrl;
    });
    if (resourceMatches.length === 1) {
      return resourceMatches[0];
    }
  }

  // Pass 3: Fallback match by sanitized server-name prefix (requiring non-conflicting origin).
  const targetOrigin = extractOriginLower(serverUrl);
  const prefixes = Array.from(new Set(nameVariants.map((n) => `${legacySanitizeServerName(n)}-`)));
  for (const prefix of prefixes) {
    const prefixMatches = operatorEntries.filter((entry) => {
      if (!entry.storeKey.startsWith(prefix)) return false;
      const suffix = entry.storeKey.slice(prefix.length);
      if (!/^[0-9a-f]{16}$/i.test(suffix)) return false;
      if (!targetOrigin) return true;
      const discovery = safeParseJsonObject(entry.store.discoveryState);
      const resourceMeta = safeParseJsonObject(discovery?.resourceMetadata);
      const storeOrigin =
        extractOriginLower(typeof resourceMeta?.resource === 'string' ? resourceMeta.resource : undefined)
        ?? extractOriginLower(
          typeof discovery?.resourceMetadataUrl === 'string' ? discovery.resourceMetadataUrl : undefined,
        );
      return !storeOrigin || storeOrigin === targetOrigin;
    });
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }
  }

  return null;
}

export interface MigrateLegacyMcpOAuthTokensResult {
  tokensMigrated: number;
  migratedServerIds: string[];
  reauthRequired: MigrationV2ReauthItem[];
}

/**
 * Migrate valid or refreshable Remote MCP OAuth tokens from OpenClaw's
 * `openclaw.sqlite` (`mcp_oauth_stores`) into LobsterAI's SQLite `kv` table
 * under `mcp.oauth.token.<server.id>`. Only reports servers in `reauthRequired`
 * when no valid/refreshable token exists or could be migrated.
 */
export function migrateLegacyMcpOAuthTokens(params: {
  openclawStateDir: string;
  db: Database.Database;
  nowMs?: number;
  isPackaged?: boolean;
}): MigrateLegacyMcpOAuthTokensResult {
  const { openclawStateDir, db } = params;
  const nowMs = params.nowMs ?? Date.now();
  const reauthRequired: MigrationV2ReauthItem[] = [];
  const migratedServerIds: string[] = [];

  if (!tableExists(db, 'mcp_servers')) {
    return { tokensMigrated: 0, migratedServerIds, reauthRequired };
  }

  const cols = getTableColumns(db, 'mcp_servers');
  if (!cols.has('id') || !cols.has('config_json')) {
    return { tokensMigrated: 0, migratedServerIds, reauthRequired };
  }

  const selectCols = [
    'id',
    ...(cols.has('name') ? ['name'] : []),
    ...(cols.has('transport_type') ? ['transport_type'] : []),
    'config_json',
  ].join(', ');

  const mcpRows = db.prepare(`SELECT ${selectCols} FROM mcp_servers`).all() as Array<{
    id: string;
    name?: string;
    transport_type?: string;
    config_json?: string;
  }>;

  const remoteMcpServers: Array<{ id: string; name: string; url?: string; managedMail: boolean }> = [];
  for (const row of mcpRows) {
    const config = safeParseJsonObject(row.config_json);
    if (!config || !isLegacyOAuthMcpRow(config, row.transport_type)) continue;
    remoteMcpServers.push({
      managedMail: config.registryId === NeteaseMail.RegistryId,
      id: row.id,
      name: (typeof row.name === 'string' && row.name.trim()) ? row.name.trim() : row.id,
      url: typeof config.url === 'string' && config.url.trim() ? config.url.trim() : undefined,
    });
  }

  if (remoteMcpServers.length === 0) {
    return { tokensMigrated: 0, migratedServerIds, reauthRequired };
  }

  const legacyEntries = loadLegacyMcpOAuthStores(openclawStateDir);
  const usedStoreKeys = new Set<string>();

  for (const server of remoteMcpServers) {
    const existingKv = getKv(db, `${MCP_OAUTH_TOKEN_KV_PREFIX}${server.id}`);
    if (existingKv && existingKv.trim().length > 0) {
      // User already holds a v2 OAuth token for this server; preserve it.
      continue;
    }

    const matched = !server.managedMail && matchLegacyMcpOAuthStore({
      serverName: server.name, serverUrl: server.url, entries: legacyEntries, usedStoreKeys,
    });
    if (matched) usedStoreKeys.add(matched.storeKey);
    const tokenRecord = server.managedMail ? readLegacyNeteaseMailToken(openclawStateDir, server, openLegacyOpenClawDbReadOnly, params.isPackaged)
      : matched ? extractUsableTokenRecordFromLegacyStore({
        serverId: server.id, serverUrl: server.url, entry: matched, nowMs,
      }) : null;
    if (tokenRecord) {
      setKv(
        db,
        `${MCP_OAUTH_TOKEN_KV_PREFIX}${server.id}`,
        encodeMigratedMcpOAuthToken(tokenRecord),
      );
      migratedServerIds.push(server.id);
      continue;
    }

    reauthRequired.push({
      kind: 'mcp_oauth',
      id: server.id,
      label: server.name || server.id,
    });
  }

  return {
    tokensMigrated: migratedServerIds.length,
    migratedServerIds,
    reauthRequired,
  };
}

function isMcpOAuthMigrationArchiveEntry(archivePath: string): boolean {
  const normalized = archivePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return (
    normalized === 'openclaw-state/state/openclaw.sqlite'
    || normalized === 'openclaw-state/state/openclaw.sqlite-wal'
    || normalized === 'openclaw-state/state/openclaw.sqlite-shm'
    || normalized === 'openclaw-state/netease-mail-authorization.json'
    || /^openclaw-state\/agents\/main\/agent\/(?:openclaw-agent\.sqlite(?:-wal|-shm)?|auth-profiles\.json)$/.test(normalized)
    || normalized.startsWith('openclaw-state/mcp-oauth/')
  );
}

export interface LegacyMcpOAuthBackfillResult {
  status: 'skipped' | 'completed' | 'failed';
  tokensMigrated: number;
  migratedServerIds: string[];
  error?: string;
}

/**
 * One-shot idempotent backfill for users who completed OpenClaw -> DSH v2
 * migration before `mcp_oauth_stores` token migration landed.
 */
export async function backfillLegacyMcpOAuthTokensFromBackup(options: {
  userDataDir: string;
  db: Database.Database;
  now?: () => Date;
  isPackaged?: boolean;
}): Promise<LegacyMcpOAuthBackfillResult> {
  const { userDataDir, db } = options;
  const now = options.now ?? (() => new Date());

  if (getKv(db, MIGRATION_V2_MCP_OAUTH_BACKFILL_KV_KEY)) {
    return { status: 'skipped', tokensMigrated: 0, migratedServerIds: [] };
  }

  const completedRaw = getKv(db, MIGRATION_V2_COMPLETED_KV_KEY);
  if (!completedRaw) {
    return { status: 'skipped', tokensMigrated: 0, migratedServerIds: [] };
  }

  try {
    const completedMeta = JSON.parse(completedRaw) as { freshInstall?: boolean };
    if (completedMeta?.freshInstall) {
      setKv(
        db,
        MIGRATION_V2_MCP_OAUTH_BACKFILL_KV_KEY,
        JSON.stringify({ completedAt: now().toISOString(), skipped: 'freshInstall' }),
      );
      return { status: 'skipped', tokensMigrated: 0, migratedServerIds: [] };
    }
  } catch {
    // Non-JSON completion marker still proceeds to archive lookup.
  }

  const archivePath = findLegacyStateArchivePath(userDataDir, db);
  if (!archivePath) {
    setKv(
      db,
      MIGRATION_V2_MCP_OAUTH_BACKFILL_KV_KEY,
      JSON.stringify({ completedAt: now().toISOString(), skipped: 'noBackupArchive' }),
    );
    return { status: 'skipped', tokensMigrated: 0, migratedServerIds: [] };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-mcp-oauth-backfill-'));
  try {
    await extractMatchingEntriesFromTarGz(archivePath, tmpDir, isMcpOAuthMigrationArchiveEntry);
    const extractedStateDir = path.join(tmpDir, 'openclaw-state');
    const { tokensMigrated, migratedServerIds } = migrateLegacyMcpOAuthTokens({
      openclawStateDir: extractedStateDir,
      db,
      nowMs: now().getTime(),
      isPackaged: options.isPackaged,
    });

    const rawReport = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
    if (rawReport && tokensMigrated > 0) {
      try {
        const report = JSON.parse(rawReport) as MigrationV2Report;
        if (report && report.version === 2 && report.summary) {
          const migratedSet = new Set(migratedServerIds);
          report.summary.mcpOAuthTokensMigrated =
            (report.summary.mcpOAuthTokensMigrated ?? 0) + tokensMigrated;
          if (Array.isArray(report.reauthRequired)) {
            report.reauthRequired = report.reauthRequired.filter(
              (item) => !(item.kind === 'mcp_oauth' && migratedSet.has(item.id)),
            );
          }
          if (
            Array.isArray(report.archivedModules)
            && report.archivedModules.length === 0
            && Array.isArray(report.reauthRequired)
            && report.reauthRequired.length === 0
          ) {
            report.dismissed = true;
          }
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
      MIGRATION_V2_MCP_OAUTH_BACKFILL_KV_KEY,
      JSON.stringify({ completedAt: now().toISOString(), tokensMigrated }),
    );
    return { status: 'completed', tokensMigrated, migratedServerIds };
  } catch (error) {
    return {
      status: 'failed',
      tokensMigrated: 0,
      migratedServerIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * One-shot idempotent backfill for users who completed OpenClaw -> DSH v2
 * migration before legacy plugin-based Tavily config extraction landed.
 */
export async function backfillLegacyTavilyFromBackup(options: {
  userDataDir: string;
  db: Database.Database;
  now?: () => Date;
}): Promise<LegacyTavilyBackfillResult> {
  const { userDataDir, db } = options;
  const now = options.now ?? (() => new Date());

  if (getKv(db, MIGRATION_V2_TAVILY_BACKFILL_KV_KEY)) {
    return { status: 'skipped', migrated: false };
  }

  const completedRaw = getKv(db, MIGRATION_V2_COMPLETED_KV_KEY);
  if (!completedRaw) {
    return { status: 'skipped', migrated: false };
  }

  try {
    const completedMeta = JSON.parse(completedRaw) as { freshInstall?: boolean };
    if (completedMeta?.freshInstall) {
      setKv(
        db,
        MIGRATION_V2_TAVILY_BACKFILL_KV_KEY,
        JSON.stringify({ completedAt: now().toISOString(), skipped: 'freshInstall' }),
      );
      return { status: 'skipped', migrated: false };
    }
  } catch {
    // Non-JSON completion marker still proceeds.
  }

  const archivePath = findIncompatibleModulesArchivePath(userDataDir, db);
  const tmpDir = archivePath ? fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-tavily-backfill-')) : null;

  try {
    let archivedUserPlugins: LegacyUserPluginRow[] | undefined;
    let archivedOpenclawUserConfig: Record<string, unknown> | null = null;
    let archivedOpenclawConfig: Record<string, unknown> | null = null;

    if (archivePath && tmpDir) {
      await extractMatchingEntriesFromTarGz(archivePath, tmpDir, isTavilyMigrationArchiveEntry);
      const pluginsJson = safeReadJson(path.join(tmpDir, 'sqlite', 'user_plugins.json'));
      if (Array.isArray(pluginsJson)) {
        archivedUserPlugins = pluginsJson as LegacyUserPluginRow[];
      }
      const userCfg = safeReadJson(path.join(tmpDir, 'openclaw-config', 'openclaw.user.json'));
      if (userCfg && typeof userCfg === 'object' && !Array.isArray(userCfg)) {
        archivedOpenclawUserConfig = userCfg as Record<string, unknown>;
      }
      const mainCfg = safeReadJson(path.join(tmpDir, 'openclaw-config', 'openclaw.json'));
      if (mainCfg && typeof mainCfg === 'object' && !Array.isArray(mainCfg)) {
        archivedOpenclawConfig = mainCfg as Record<string, unknown>;
      }
    }

    const res = migrateLegacyTavilyPluginToMcp({
      db,
      userPluginsOverride: archivedUserPlugins,
      openclawUserConfigOverride: archivedOpenclawUserConfig,
      openclawConfigOverride: archivedOpenclawConfig,
      nowMs: now().getTime(),
    });

    setKv(
      db,
      MIGRATION_V2_TAVILY_BACKFILL_KV_KEY,
      JSON.stringify({
        completedAt: now().toISOString(),
        migrated: res.migrated,
        ...(res.source ? { source: res.source } : {}),
        ...(res.skippedReason ? { skippedReason: res.skippedReason } : {}),
      }),
    );

    return { status: 'completed', migrated: res.migrated };
  } catch (error) {
    return {
      status: 'failed',
      migrated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * One-shot idempotent backfill for users who completed OpenClaw -> DSH v2
 * migration before `DREAMS.md` preservation landed.
 *
 * Streams only `workspace-<agentId>/DREAMS.md`, `workspace-<agentId>/dreams.md`, and
 * `workspace/DREAMS.md` from `legacy-openclaw-backup/<ts>/legacy-openclaw-state.tar.gz`
 * into `<userData>/workspaces/<agentId>/DREAMS.md` without overwriting existing files.
 */
export async function backfillLegacyDreamDiariesFromBackup(options: {
  userDataDir: string;
  db: Database.Database;
  now?: () => Date;
}): Promise<LegacyDreamDiaryBackfillResult> {
  const { userDataDir, db } = options;
  const now = options.now ?? (() => new Date());

  if (getKv(db, MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY)) {
    return { status: 'skipped', diariesRestored: 0 };
  }

  const completedRaw = getKv(db, MIGRATION_V2_COMPLETED_KV_KEY);
  if (!completedRaw) {
    return { status: 'skipped', diariesRestored: 0 };
  }

  try {
    const completedMeta = JSON.parse(completedRaw) as { freshInstall?: boolean };
    if (completedMeta?.freshInstall) {
      setKv(
        db,
        MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
        JSON.stringify({ completedAt: now().toISOString(), skipped: 'freshInstall' }),
      );
      return { status: 'skipped', diariesRestored: 0 };
    }
  } catch {
    // Non-JSON completion marker still proceeds to archive lookup.
  }

  const archivePath = findLegacyStateArchivePath(userDataDir, db);
  if (!archivePath) {
    setKv(
      db,
      MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
      JSON.stringify({ completedAt: now().toISOString(), skipped: 'noBackupArchive' }),
    );
    return { status: 'skipped', diariesRestored: 0 };
  }

  const workspacesDir = path.join(userDataDir, WORKSPACES_DIR_NAME);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dream-diary-backfill-'));
  try {
    const extractedEntries = await extractMatchingEntriesFromTarGz(
      archivePath,
      tmpDir,
      isDreamDiaryArchiveEntry,
    );

    const prioritized = extractedEntries
      .map((entryPath) => ({
        entryPath,
        parsed: parseDreamDiaryArchiveEntry(entryPath),
      }))
      .filter(
        (item): item is { entryPath: string; parsed: ParsedDreamDiaryArchiveEntry } =>
          item.parsed !== null,
      )
      .sort((a, b) => {
        if (a.parsed.isCanonicalWorkspace !== b.parsed.isCanonicalWorkspace) {
          return a.parsed.isCanonicalWorkspace ? -1 : 1;
        }
        if (a.parsed.isUpperCase !== b.parsed.isUpperCase) {
          return a.parsed.isUpperCase ? -1 : 1;
        }
        return a.entryPath.localeCompare(b.entryPath);
      });

    let diariesRestored = 0;
    for (const { entryPath, parsed } of prioritized) {
      const extractedFile = path.resolve(tmpDir, ...entryPath.split('/').filter(Boolean));
      const dstDir = path.join(workspacesDir, parsed.agentId);
      if (copyLegacyDreamDiaryFile(extractedFile, dstDir)) {
        diariesRestored += 1;
      }
    }

    setKv(
      db,
      MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
      JSON.stringify({ completedAt: now().toISOString(), diariesRestored }),
    );
    return { status: 'completed', diariesRestored };
  } catch (error) {
    return {
      status: 'failed',
      diariesRestored: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Copy legacy `workspace-*` (and bare `workspace`) persona, memory, and
 * read-only historical `DREAMS.md` files out of OpenClaw's state dir into
 * engine-independent `<userData>/workspaces/<agentId>/`, stripping the old
 * OpenClaw-managed `AGENTS.md` section, recursively copying `memory/**\/*.md`,
 * and archiving `memory/.dreams/` (plus legacy `.dreams/`) into
 * `incompatible-modules-backup.tar.gz`.
 */
function migrateLegacyWorkspaces(
  openclawStateDir: string,
  workspacesDir: string,
  incompatibleEntries: TarEntryInput[],
  archivedModules: MigrationV2ArchivedItem[],
): { workspacesMigrated: number; dreamDiariesMigrated: number } {
  if (!fs.existsSync(openclawStateDir)) {
    return { workspacesMigrated: 0, dreamDiariesMigrated: 0 };
  }
  const migratedAgentIds = new Set<string>();
  let dreamDiariesMigrated = 0;
  let dreamsFilesArchived = 0;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(openclawStateDir, { withFileTypes: true });
  } catch {
    return { workspacesMigrated: 0, dreamDiariesMigrated: 0 };
  }

  const workspaceDirents = dirents
    .filter((d) => d.isDirectory() && (d.name === 'workspace' || d.name.startsWith('workspace-')))
    .sort((a, b) => {
      // Process `workspace-*` before bare `workspace` so `workspace-main` wins when both exist.
      if (a.name === 'workspace' && b.name !== 'workspace') return 1;
      if (b.name === 'workspace' && a.name !== 'workspace') return -1;
      return a.name.localeCompare(b.name);
    });

  const memoryService = new LobsterMemoryService(workspacesDir);
  try {
    for (const dirent of workspaceDirents) {
      const rawAgentId = dirent.name === 'workspace'
        ? AgentId.Main
        : dirent.name.slice('workspace-'.length).trim() || AgentId.Main;
      let agentId: string;
      try {
        agentId = sanitizeAgentId(rawAgentId);
      } catch {
        continue;
      }

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

      // Preserve historical `DREAMS.md` / `dreams.md` (case-insensitive) as read-only
      // `DREAMS.md` inside `<userData>/workspaces/<agentId>/`.
      const srcDreamDiary = findLegacyDreamDiaryFile(srcDir);
      if (srcDreamDiary && copyLegacyDreamDiaryFile(srcDreamDiary, dstDir)) {
        dreamDiariesMigrated += 1;
        copiedAny = true;
      }

      // Recursively copy daily and nested memory markdown notes (`memory/**/*.md`),
      // archiving `memory/.dreams/` (and any nested `.dreams/`) into incompatible backup.
      const srcDailyDir = path.join(srcDir, 'memory');
      if (fs.existsSync(srcDailyDir)) {
        const dstDailyDir = path.join(dstDir, 'memory');
        fs.mkdirSync(dstDailyDir, { recursive: true });
        const copiedMemory = copyLegacyMemoryMarkdownRecursive(
          srcDailyDir,
          dstDailyDir,
          agentId,
          incompatibleEntries,
        );
        if (copiedMemory.copiedAny) copiedAny = true;
        dreamsFilesArchived += copiedMemory.dreamsFilesArchived;
      }

      // Archive legacy top-level `.dreams/` into incompatible modules backup instead of migrating.
      // (`memory/.dreams/` is already archived during the recursive walk above.)
      const legacyTopDreamsDir = path.join(srcDir, '.dreams');
      if (fs.existsSync(legacyTopDreamsDir)) {
        const dreamEntries = collectDirectoryTarEntries(
          legacyTopDreamsDir,
          `dreams/${agentId}/.dreams`,
        );
        incompatibleEntries.push(...dreamEntries);
        dreamsFilesArchived += dreamEntries.length;
      }

      if (copiedAny) {
        memoryService.reindexAgent(agentId);
        migratedAgentIds.add(agentId);
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
  return {
    workspacesMigrated: migratedAgentIds.size,
    dreamDiariesMigrated,
  };
}

/**
 * Copy legacy custom skill directories out of `<openclawStateDir>/skills/`
 * and `<openclawStateDir>/workspace-<agentId>/skills/` into `<userData>/SKILLs/`
 * before deleting `openclaw/`. Never overwrites existing skills in `SKILLs/`.
 */
function migrateLegacyOpenClawSkills(
  openclawStateDir: string,
  userSkillsDir: string,
): number {
  if (!fs.existsSync(openclawStateDir)) return 0;

  const candidateSkillRoots: string[] = [];
  const sharedSkillsDir = path.join(openclawStateDir, 'skills');
  if (fs.existsSync(sharedSkillsDir)) {
    candidateSkillRoots.push(sharedSkillsDir);
  }

  let stateEntries: fs.Dirent[];
  try {
    stateEntries = fs.readdirSync(openclawStateDir, { withFileTypes: true });
  } catch {
    stateEntries = [];
  }

  const workspaceNames = stateEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('workspace-'))
    .map((entry) => entry.name)
    .sort((a, b) => {
      if (a === 'workspace-main') return -1;
      if (b === 'workspace-main') return 1;
      return a.localeCompare(b);
    });

  for (const workspaceName of workspaceNames) {
    const wsSkillsDir = path.join(openclawStateDir, workspaceName, 'skills');
    if (fs.existsSync(wsSkillsDir)) {
      candidateSkillRoots.push(wsSkillsDir);
    }
  }

  let migratedCount = 0;
  for (const sourceRoot of candidateSkillRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillId = entry.name.trim();
      if (!skillId || skillId.startsWith('.') || skillId.includes('/') || skillId.includes('\\')) {
        continue;
      }
      const srcSkillDir = path.join(sourceRoot, entry.name);
      try {
        if (!fs.statSync(srcSkillDir).isDirectory()) continue;
        const skillManifestPath = path.join(srcSkillDir, 'SKILL.md');
        if (!fs.existsSync(skillManifestPath) || !fs.statSync(skillManifestPath).isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      const targetSkillDir = path.join(userSkillsDir, skillId);
      if (fs.existsSync(targetSkillDir)) {
        continue;
      }

      fs.mkdirSync(userSkillsDir, { recursive: true });
      cpRecursiveSync(srcSkillDir, targetSkillDir, { dereference: true, force: false });
      migratedCount += 1;
    }
  }

  return migratedCount;
}

const XAI_AUTH_DIR_NAME = 'auth';
const XAI_AUTH_FILENAME = 'xai-oauth.json';

function isValidXaiOAuthCredential(value: unknown): value is XaiOAuthCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.provider === XAI_AUTH_PROVIDER
    && record.type === XAI_AUTH_CREDENTIAL_TYPE
    && typeof record.access === 'string'
    && record.access.trim().length > 0
  );
}

function extractXaiOAuthEntryFromStore(
  rawStore: unknown,
): { profileId: string; credential: XaiOAuthCredential } | null {
  if (!rawStore || typeof rawStore !== 'object' || Array.isArray(rawStore)) return null;
  const profiles = (rawStore as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return null;
  for (const [profileId, candidate] of Object.entries(profiles as Record<string, unknown>)) {
    if (isValidXaiOAuthCredential(candidate)) {
      return { profileId, credential: candidate };
    }
  }
  return null;
}

function isXaiOAuthEnabledInAppConfig(db: Database.Database): boolean {
  const raw = getKv(db, 'app_config');
  if (!raw) return false;
  const parsed = safeParseJsonObject(raw);
  const providers = parsed?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false;
  const xai = (providers as Record<string, unknown>).xai;
  if (!xai || typeof xai !== 'object' || Array.isArray(xai)) return false;
  const record = xai as Record<string, unknown>;
  return record.enabled === true && record.authType === XAI_AUTH_CREDENTIAL_TYPE;
}

function collectLegacyAgentNames(openclawStateDir: string): string[] {
  const agentsRoot = path.join(openclawStateDir, 'agents');
  if (!fs.existsSync(agentsRoot)) return [];
  const names: string[] = [];
  try {
    for (const dirent of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (dirent.isDirectory()) names.push(dirent.name);
    }
  } catch {
    return [];
  }
  names.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  return names;
}

export interface MigrateLegacyXaiOAuthResult {
  status: 'migrated' | 'already_present' | 'reauth_required' | 'not_found';
  profileId?: string;
}

/**
 * Migrate legacy OpenClaw xAI OAuth credentials out of `<userData>/openclaw/state/`
 * (checking both SQLite `auth_profile_store` tables and legacy `auth-profiles.json`
 * files) into `<userData>/auth/xai-oauth.json` before the legacy directory is deleted.
 */
export function migrateLegacyXaiOAuthCredential(params: {
  openclawStateDir: string;
  userDataDir: string;
  db: Database.Database;
  nowMs?: number;
}): MigrateLegacyXaiOAuthResult {
  const { openclawStateDir, userDataDir, db } = params;
  const targetDir = path.join(userDataDir, XAI_AUTH_DIR_NAME);
  const targetPath = path.join(targetDir, XAI_AUTH_FILENAME);

  if (fs.existsSync(targetPath)) {
    const existing = safeReadJson(targetPath) as { credential?: unknown } | null;
    if (existing && isValidXaiOAuthCredential(existing.credential)) {
      return { status: 'already_present' };
    }
  }

  let sawUnreadableStore = false;
  const agentNames = collectLegacyAgentNames(openclawStateDir);

  // 1. Canonical OpenClaw SQLite stores (`state/openclaw.sqlite` and `agents/*/agent/openclaw-agent.sqlite`)
  const sqliteCandidates = [
    path.join(openclawStateDir, 'state', 'openclaw.sqlite'),
    ...agentNames.map((agentName) => path.join(openclawStateDir, 'agents', agentName, 'agent', 'openclaw-agent.sqlite')),
  ];
  for (const sqliteFile of sqliteCandidates) {
    if (!fs.existsSync(sqliteFile)) continue;
    const opened = openLegacyOpenClawDbReadOnly(sqliteFile);
    if (!opened) {
      sawUnreadableStore = true;
      continue;
    }
    try {
      if (!tableExists(opened.db, 'auth_profile_store')) continue;
      const rows = opened.db
        .prepare("SELECT store_key, store_json FROM auth_profile_store ORDER BY CASE WHEN store_key = 'primary' THEN 0 ELSE 1 END")
        .all() as Array<{ store_key?: unknown; store_json?: unknown }>;
      for (const row of rows) {
        if (typeof row.store_json !== 'string' || !row.store_json.trim()) continue;
        const parsed = safeParseJsonObject(row.store_json);
        if (!parsed) {
          sawUnreadableStore = true;
          continue;
        }
        const entry = extractXaiOAuthEntryFromStore(parsed);
        if (entry) {
          fs.mkdirSync(targetDir, { recursive: true });
          const tmpPath = `${targetPath}.tmp`;
          const payload = {
            profileId: entry.profileId,
            credential: entry.credential,
            updatedAt: params.nowMs ?? Date.now(),
          };
          fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
          fs.renameSync(tmpPath, targetPath);
          return { status: 'migrated', profileId: entry.profileId };
        }
      }
    } catch {
      sawUnreadableStore = true;
    } finally {
      opened.close();
    }
  }

  // 2. Legacy JSON files (`agents/main/agent/auth-profiles.json`, other agents, or state root)
  const jsonCandidates = [
    ...agentNames.map((agentName) => path.join(openclawStateDir, 'agents', agentName, 'agent', 'auth-profiles.json')),
    path.join(openclawStateDir, 'auth-profiles.json'),
  ];
  for (const jsonFile of jsonCandidates) {
    if (!fs.existsSync(jsonFile)) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = fs.readFileSync(jsonFile, 'utf8');
      parsed = safeParseJsonObject(raw);
    } catch {
      sawUnreadableStore = true;
      continue;
    }
    if (!parsed) {
      sawUnreadableStore = true;
      continue;
    }
    const entry = extractXaiOAuthEntryFromStore(parsed);
    if (entry) {
      fs.mkdirSync(targetDir, { recursive: true });
      const tmpPath = `${targetPath}.tmp`;
      const payload = {
        profileId: entry.profileId,
        credential: entry.credential,
        updatedAt: params.nowMs ?? Date.now(),
      };
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmpPath, targetPath);
      return { status: 'migrated', profileId: entry.profileId };
    }
  }

  if (sawUnreadableStore || isXaiOAuthEnabledInAppConfig(db)) {
    return { status: 'reauth_required' };
  }
  return { status: 'not_found' };
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

const PENDING_MESSAGE_EDITS_CLEARED_KV_KEY = 'engine.migration.v2.pendingMessageEditsCleared';

/**
 * Archive (when `incompatibleEntries` is provided) and clear stale legacy
 * in-place message edit / version switch rows. LobsterAI v2 retires in-place
 * edit recovery in favor of session forking, so uncommitted rows left over
 * from OpenClaw must be cleared to avoid leaving sessions permanently stuck.
 */
function archiveAndClearLegacyPendingMessageEdits(
  db: Database.Database,
  incompatibleEntries?: TarEntryInput[],
): void {
  if (tableExists(db, 'cowork_message_edits')) {
    const editCols = getTableColumns(db, 'cowork_message_edits');
    const pendingEdits = editCols.has('phase')
      ? db
          .prepare('SELECT * FROM cowork_message_edits WHERE phase IS NULL OR phase NOT IN (?, ?)')
          .all(CoworkMessageEditPhase.Committed, CoworkMessageEditPhase.Restored)
      : db.prepare('SELECT * FROM cowork_message_edits').all();
    if (pendingEdits.length > 0) {
      incompatibleEntries?.push({
        archivePath: 'sqlite/cowork_message_edits.json',
        content: Buffer.from(JSON.stringify(pendingEdits, null, 2), 'utf8'),
      });
      if (editCols.has('phase')) {
        db.prepare('DELETE FROM cowork_message_edits WHERE phase IS NULL OR phase NOT IN (?, ?)')
          .run(CoworkMessageEditPhase.Committed, CoworkMessageEditPhase.Restored);
      } else {
        db.prepare('DELETE FROM cowork_message_edits').run();
      }
    }
  }

  if (tableExists(db, 'cowork_message_version_switches')) {
    const pendingSwitches = db.prepare('SELECT * FROM cowork_message_version_switches').all();
    if (pendingSwitches.length > 0) {
      incompatibleEntries?.push({
        archivePath: 'sqlite/cowork_message_version_switches.json',
        content: Buffer.from(JSON.stringify(pendingSwitches, null, 2), 'utf8'),
      });
      db.prepare('DELETE FROM cowork_message_version_switches').run();
    }
  }
}

/** One-shot cleanup for already-migrated v2 DBs that still have stale legacy edit rows. */
function clearLegacyPendingMessageEditsOnce(db: Database.Database): void {
  if (getKv(db, PENDING_MESSAGE_EDITS_CLEARED_KV_KEY)) return;
  archiveAndClearLegacyPendingMessageEdits(db);
  setKv(db, PENDING_MESSAGE_EDITS_CLEARED_KV_KEY, '1');
}

/**
 * Migrate legacy OpenClaw `cowork_config.executionMode` and per-session
 * `cowork_sessions.execution_mode` to DSH permission presets once.
 *
 * - `cowork_config.executionMode` -> `kv['dsh.permissionPreset.default']` when not already set
 *   (`'auto'` -> `'danger-full-access'`, `'local'`/`'sandbox'` -> `'workspace-write'`).
 * - Legacy `cowork_sessions.execution_mode` rows whose mapped preset differs from the
 *   legacy default receive an explicit `cowork_sessions.permission_preset` so per-session
 *   restrictions or auto approvals survive upgrade without relying on stale `execution_mode`.
 */
export function migrateLegacyPermissionPresets(db: Database.Database): void {
  if (getKv(db, MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY)) return;

  let legacyConfigExecutionMode: string | null = null;
  if (tableExists(db, 'cowork_config')) {
    try {
      const row = db
        .prepare("SELECT value FROM cowork_config WHERE key = 'executionMode'")
        .get() as { value?: unknown } | undefined;
      if (typeof row?.value === 'string') {
        legacyConfigExecutionMode = row.value;
      }
    } catch {
      // Ignore unreadable legacy cowork_config table.
    }
  }

  const mappedConfigPreset = mapLegacyExecutionModeToPermissionPreset(legacyConfigExecutionMode);
  const existingDefaultPreset = parseDshPermissionPreset(getKv(db, DSH_PERMISSION_PRESET_KV_KEY));
  if (!existingDefaultPreset && mappedConfigPreset) {
    setKv(db, DSH_PERMISSION_PRESET_KV_KEY, mappedConfigPreset);
  }

  if (tableExists(db, 'cowork_sessions')) {
    const cols = getTableColumns(db, 'cowork_sessions');
    if (cols.has('execution_mode')) {
      if (!cols.has('permission_preset')) {
        db.exec('ALTER TABLE cowork_sessions ADD COLUMN permission_preset TEXT;');
      }
      const baselinePreset = mappedConfigPreset ?? existingDefaultPreset ?? DEFAULT_DSH_PERMISSION_PRESET;
      const rows = db
        .prepare(
          'SELECT id, execution_mode FROM cowork_sessions WHERE permission_preset IS NULL AND execution_mode IS NOT NULL',
        )
        .all() as Array<{ id: string; execution_mode: string | null }>;
      const updateStmt = db.prepare('UPDATE cowork_sessions SET permission_preset = ? WHERE id = ?');
      for (const row of rows) {
        const sessionPreset = mapLegacyExecutionModeToPermissionPreset(row.execution_mode);
        if (sessionPreset && sessionPreset !== baselinePreset) {
          updateStmt.run(sessionPreset, row.id);
        }
      }
    }
  }

  setKv(db, MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY, '1');
}

export interface LegacyUserMemoriesBackfillResult {
  status: 'skipped' | 'completed' | 'failed';
  memoriesImported: number;
  error?: string;
}

/**
 * Migrate ALL active (`status = 'created'`) legacy SQLite `user_memories` rows
 * into `<workspacesDir>/main/MEMORY.md`, deduplicating by normalized fingerprint.
 *
 * Never resurrects `deleted` or `stale` rows and keeps `user_memories` and
 * `user_memory_sources` intact in SQLite for provenance & audit inspection.
 */
export function migrateLegacySqliteUserMemories(params: {
  db: Database.Database;
  workspacesDir: string;
  memoryService?: LobsterMemoryService;
}): number {
  const { db, workspacesDir } = params;
  if (!tableExists(db, 'user_memories')) return 0;

  const columns = getTableColumns(db, 'user_memories');
  if (!columns.has('text')) return 0;

  const whereClause = columns.has('status') ? "WHERE status = 'created'" : '';
  const orderClause = columns.has('created_at')
    ? 'ORDER BY created_at ASC, ROWID ASC'
    : 'ORDER BY ROWID ASC';

  const rows = db
    .prepare(`SELECT text FROM user_memories ${whereClause} ${orderClause}`)
    .all() as Array<{ text?: unknown }>;

  const texts = rows
    .map((row) => (typeof row.text === 'string' ? row.text.trim() : ''))
    .filter((text) => text.length > 0);
  if (texts.length === 0) return 0;

  const ownedService = !params.memoryService;
  const memoryService = params.memoryService ?? new LobsterMemoryService(workspacesDir);
  try {
    return memoryService.importMemories(AgentId.Main, texts);
  } finally {
    if (ownedService) {
      memoryService.close();
    }
  }
}

/**
 * One-shot idempotent backfill for already-migrated v2 DBs (or upgraded DBs
 * that previously only ran the capped 200-row lazy migration) so all active
 * SQLite-only `user_memories` rows are recovered into `workspaces/main/MEMORY.md`.
 */
export function backfillLegacyUserMemories(options: {
  userDataDir: string;
  db: Database.Database;
  memoryService?: LobsterMemoryService;
  now?: () => Date;
}): LegacyUserMemoriesBackfillResult {
  const { userDataDir, db, memoryService } = options;
  const now = options.now ?? (() => new Date());

  if (getKv(db, MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY)) {
    return { status: 'skipped', memoriesImported: 0 };
  }

  try {
    const workspacesDir = path.join(userDataDir, WORKSPACES_DIR_NAME);
    const memoriesImported = migrateLegacySqliteUserMemories({
      db,
      workspacesDir,
      memoryService,
    });

    const rawReport = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
    if (rawReport && memoriesImported > 0) {
      try {
        const report = JSON.parse(rawReport) as MigrationV2Report;
        if (report && report.version === 2 && report.summary) {
          report.summary.userMemoriesMigrated =
            (report.summary.userMemoriesMigrated ?? 0) + memoriesImported;
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
      MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY,
      JSON.stringify({ completedAt: now().toISOString(), memoriesImported }),
    );
    return { status: 'completed', memoriesImported };
  } catch (error) {
    return {
      status: 'failed',
      memoriesImported: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function migrateLegacyBrowserDisplayModeConfig(db: Database.Database): void {
  const rawAppConfig = getKv(db, APP_CONFIG_KEY);
  if (!rawAppConfig) return;

  const parsedAppConfig = safeParseJsonObject(rawAppConfig);
  if (!parsedAppConfig) return;

  const migrated = migrateBrowserDisplayModeConfig(parsedAppConfig);
  if (migrated !== parsedAppConfig) {
    setKv(db, APP_CONFIG_KEY, JSON.stringify(migrated));
  }
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

const LEGACY_MCP_PACKAGES_SEGMENT_RE = /([\\/])openclaw[\\/]mcp-packages(?=$|[\\/])/gi;
const OPENCLAW_PATH_SEGMENT_RE = /(?:^|[\\/])openclaw(?:$|[\\/])/i;

function rewriteLegacyMcpPackagePath(value: string): string {
  return value.replace(LEGACY_MCP_PACKAGES_SEGMENT_RE, '$1mcp-packages');
}

function relocateLegacyMcpPackagesDir(
  legacyDir: string,
  targetDir: string,
): { movedWholeDir: boolean } {
  if (!fs.existsSync(legacyDir)) {
    return { movedWholeDir: false };
  }
  if (!fs.existsSync(targetDir)) {
    try {
      fs.renameSync(legacyDir, targetDir);
      return { movedWholeDir: true };
    } catch {
      // Fall through to per-entry copy/move if atomic rename fails (e.g. EXDEV).
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
    const from = path.join(legacyDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
    } catch {
      fs.cpSync(from, to, { recursive: true, force: false });
      fs.rmSync(from, { recursive: true, force: true });
    }
  }
  return { movedWholeDir: false };
}

function migrateLegacyMcpLaunchResolutions(db: Database.Database): {
  rewritten: number;
  cleared: number;
} {
  if (!tableExists(db, 'mcp_launch_resolutions')) {
    return { rewritten: 0, cleared: 0 };
  }
  const cols = getTableColumns(db, 'mcp_launch_resolutions');
  const pathCols = ['install_dir', 'command', 'args_json', 'resolved_path'].filter((c) => cols.has(c));
  if (pathCols.length === 0) {
    return { rewritten: 0, cleared: 0 };
  }

  const keyCol = cols.has('server_id') ? 'server_id' : 'rowid';
  const selectCols = [keyCol, ...pathCols].join(', ');
  const whereClause = pathCols
    .map((c) => `LOWER(COALESCE(${c}, '')) LIKE '%openclaw%' OR LOWER(COALESCE(${c}, '')) LIKE '%mcp-packages%'`)
    .join(' OR ');

  const rows = db
    .prepare(`SELECT ${selectCols} FROM mcp_launch_resolutions WHERE ${whereClause}`)
    .all() as Array<Record<string, unknown>>;

  let rewritten = 0;
  let cleared = 0;

  const deleteStmt = db.prepare(`DELETE FROM mcp_launch_resolutions WHERE ${keyCol} = ?`);
  const setClause = pathCols.map((c) => `${c} = ?`).join(', ');
  const updateStmt = db.prepare(`UPDATE mcp_launch_resolutions SET ${setClause} WHERE ${keyCol} = ?`);

  for (const row of rows) {
    const keyVal = row[keyCol];
    const nextValues: Record<string, string | null> = {};
    let broken = false;
    let parsedArgs: string[] | null = null;

    for (const col of pathCols) {
      const raw = row[col];
      if (raw === null || raw === undefined) {
        nextValues[col] = null;
        continue;
      }
      const str = String(raw);
      if (col === 'args_json') {
        try {
          const parsed = JSON.parse(str) as unknown;
          if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            broken = true;
            break;
          }
          const nextArgs = (parsed as string[]).map((arg) => rewriteLegacyMcpPackagePath(arg));
          if (nextArgs.some((arg) => OPENCLAW_PATH_SEGMENT_RE.test(arg))) {
            broken = true;
            break;
          }
          parsedArgs = nextArgs;
          nextValues[col] = JSON.stringify(nextArgs);
        } catch {
          broken = true;
          break;
        }
      } else {
        const nextStr = rewriteLegacyMcpPackagePath(str);
        if (OPENCLAW_PATH_SEGMENT_RE.test(nextStr)) {
          broken = true;
          break;
        }
        nextValues[col] = nextStr;
      }
    }

    if (!broken) {
      const nextInstallDir = nextValues.install_dir;
      const nextCommand = nextValues.command;
      const nextResolvedPath = nextValues.resolved_path;
      const primaryBinArg = parsedArgs && parsedArgs.length > 0 ? parsedArgs[0] : null;

      let verifiedTargetBinary = false;
      if (nextInstallDir && !fs.existsSync(nextInstallDir)) {
        broken = true;
      }
      if (!broken && nextResolvedPath) {
        if (fs.existsSync(nextResolvedPath)) {
          verifiedTargetBinary = true;
        } else {
          broken = true;
        }
      }
      if (!broken && primaryBinArg) {
        if (fs.existsSync(primaryBinArg)) {
          verifiedTargetBinary = true;
        } else {
          broken = true;
        }
      }
      if (!broken && nextCommand && path.isAbsolute(nextCommand)) {
        if (fs.existsSync(nextCommand)) {
          if (!primaryBinArg) verifiedTargetBinary = true;
        } else {
          broken = true;
        }
      }
      if (!verifiedTargetBinary) {
        broken = true;
      }
    }

    if (broken) {
      const res = deleteStmt.run(keyVal);
      cleared += res.changes;
      continue;
    }

    const params = [...pathCols.map((c) => nextValues[c] ?? null), keyVal];
    updateStmt.run(...params);
    rewritten += 1;
  }

  return { rewritten, cleared };
}

/**
 * Pure disposable cache directories from legacy OpenClaw / experimental DSH
 * builds. Never includes `openclaw/state/media`, workspaces, agents, or user
 * extensions so historical conversation artifacts stay intact at their
 * original paths.
 */
export function getLegacyOpenClawDisposableCacheDirs(userDataDir: string): string[] {
  const openclawRootDir = path.join(userDataDir, 'openclaw');
  const openclawStateDir = path.join(openclawRootDir, 'state');
  return [
    path.join(openclawRootDir, 'logs'),
    path.join(openclawRootDir, '.compile-cache'),
    path.join(openclawRootDir, 'repair-backups'),
    path.join(openclawStateDir, '.compile-cache'),
    path.join(openclawStateDir, 'cache'),
    path.join(openclawStateDir, 'tmp'),
    path.join(openclawStateDir, 'worktrees'),
    path.join(userDataDir, 'dsh-runtime'), // Old experimental 160MB runtime cache
  ];
}

/**
 * Asynchronously remove legacy OpenClaw disposable caches without blocking the
 * Electron main thread. Safe to call on every startup after window creation.
 */
export async function cleanupLegacyOpenClawDisposableCaches(
  userDataDir: string,
): Promise<{ dirsRemoved: number }> {
  let dirsRemoved = 0;
  for (const dir of getLegacyOpenClawDisposableCacheDirs(userDataDir)) {
    try {
      await fs.promises.access(dir);
    } catch {
      continue;
    }
    try {
      await fs.promises.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 250,
      });
      dirsRemoved += 1;
    } catch (error) {
      console.warn(`[MigrationV2] failed to remove disposable cache dir ${dir}:`, error);
    }
  }
  return { dirsRemoved };
}

function listTopLevelEntryNames(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
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
    // Idempotency guard: already migrated -> instant return (after one-shot backfills).
    const completedRaw = getKv(db, MIGRATION_V2_COMPLETED_KV_KEY);
    if (completedRaw) {
      migrateLegacySubagentHistory(db, openclawStateDir);
      migrateLegacyConversationImages(db, userDataDir);
      backfillAgentPersonaFiles(db, workspacesDir);
      clearLegacyPendingMessageEditsOnce(db);
      backfillLegacyUserMemories({ userDataDir, db, now });
      let isFreshInstall = false;
      try {
        isFreshInstall = Boolean((JSON.parse(completedRaw) as { freshInstall?: boolean })?.freshInstall);
      } catch {
        // Non-JSON completion marker is treated as an upgraded database.
      }
      if (!isFreshInstall) {
        preserveLegacyImBotIdentities(db, userDataDir);
        if (!getKv(db, MIGRATION_V2_WEIXIN_CREDENTIALS_KEY)) {
          const raw = getKv(db, MIGRATION_V2_REPORT_KV_KEY);
          const report = safeParseJsonObject(raw) as Partial<MigrationV2Report> | null;
          const original = legacyImBotIdentities(db)?.find(bot => bot.key === WEIXIN_REAUTH_ITEM.id);
          db.transaction(() => {
            if (original && Array.isArray(report?.reauthRequired) && report.reauthRequired.some(item => item.kind === WEIXIN_REAUTH_ITEM.kind)
              && !migrateLegacyWeixinCredentials(db, openclawStateDir, original)) {
              report.reauthRequired = report.reauthRequired.filter(item => item.kind !== WEIXIN_REAUTH_ITEM.kind);
              if (!report.reauthRequired.length && !report.archivedModules?.length) report.dismissed = true;
              setKv(db, MIGRATION_V2_REPORT_KV_KEY, JSON.stringify(report));
            }
            setKv(db, MIGRATION_V2_WEIXIN_CREDENTIALS_KEY, '1');
          })();
        }
        migrateLegacyPermissionPresets(db);
      }
      migrateLegacyBrowserDisplayModeConfig(db);
      return { status: MigrationV2Status.Skipped };
    }

    // Fresh install guard: no legacy OpenClaw state dir and no legacy rows -> skip.
    const hasOpenClawState = fs.existsSync(openclawStateDir);
    const hasLegacyEngineKv = getKv(db, 'cowork.agent_engine') === 'openclaw';
    if (!hasOpenClawState && !hasLegacyEngineKv) {
      backfillAgentPersonaFiles(db, workspacesDir);
      migrateLegacyConversationImages(db, userDataDir);
      backfillLegacyUserMemories({ userDataDir, db, now });
      migrateLegacyBrowserDisplayModeConfig(db);
      const migratedAt = now().toISOString();
      setKv(db, MIGRATION_V2_COMPLETED_KV_KEY, JSON.stringify({ migratedAt, freshInstall: true }));
      setKv(db, MIGRATION_V2_CRON_BACKFILL_KV_KEY, JSON.stringify({ completedAt: migratedAt, skipped: 'freshInstall' }));
      setKv(db, PENDING_MESSAGE_EDITS_CLEARED_KV_KEY, '1');
      setKv(db, MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY, '1');
      setKv(
        db,
        MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
        JSON.stringify({ completedAt: migratedAt, skipped: 'freshInstall' }),
      );
      setKv(db, MIGRATION_V2_TAVILY_BACKFILL_KV_KEY, JSON.stringify({ completedAt: migratedAt, skipped: 'freshInstall' }));
      setKv(
        db,
        MIGRATION_V2_MCP_OAUTH_BACKFILL_KV_KEY,
        JSON.stringify({ completedAt: migratedAt, skipped: 'freshInstall' }),
      );
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

    const createdSeededSessionDirs: string[] = [];
    const legacyMcpPackagesDir = path.join(openclawRootDir, 'mcp-packages');
    const targetMcpPackagesDir = path.join(userDataDir, 'mcp-packages');
    let mcpPackagesMovedWholeDir = false;
    try {
      const incompatibleEntries: TarEntryInput[] = [];
      const archivedModules: MigrationV2ArchivedItem[] = [];
      const reauthRequired: MigrationV2ReauthItem[] = [];

      // ── Step 2: Offline Extract & Transform ──────────────────────────────
      migrateLegacySubagentHistory(db, openclawStateDir);
      migrateLegacyConversationImages(db, userDataDir);
      migrateLegacyBrowserDisplayModeConfig(db);
      const { workspacesMigrated, dreamDiariesMigrated } = migrateLegacyWorkspaces(
        openclawStateDir,
        workspacesDir,
        incompatibleEntries,
        archivedModules,
      );
      const userMemoriesMigrated = migrateLegacySqliteUserMemories({
        db,
        workspacesDir,
      });
      const skillsMigrated = migrateLegacyOpenClawSkills(
        openclawStateDir,
        path.join(userDataDir, 'SKILLs'),
      );
      backfillAgentPersonaFiles(db, workspacesDir);
      preserveLegacyImBotIdentities(db);
      migrateLegacyPermissionPresets(db);

      // Scheduled tasks & run history: import OpenClaw cron jobs & runs into LobsterScheduler tables.
      const {
        tasksImported: scheduledTasksMigrated,
        runsImported: scheduledTaskRunsMigrated,
      } = migrateLegacyScheduledTasksAndRuns({
        openclawStateDir,
        db,
        nowMs: now().getTime(),
      });

      // IM allowFrom whitelists for the retained platforms.
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

      // Migrate legacy xAI OAuth credential out of `openclaw/state` before cleanup.
      const xaiMigration = migrateLegacyXaiOAuthCredential({
        openclawStateDir,
        userDataDir,
        db,
        nowMs: now().getTime(),
      });
      if (xaiMigration.status === 'reauth_required') {
        reauthRequired.push({
          kind: 'xai_oauth',
          id: XAI_AUTH_PROVIDER,
          label: 'xAI (Grok) OAuth (re-login required)',
        });
      }

      const weixinReauth = migrateLegacyWeixinCredentials(db, openclawStateDir);
      if (weixinReauth) reauthRequired.push(weixinReauth);

      // Relocate cached MCP packages out of `openclaw/mcp-packages` to
      // `<userData>/mcp-packages` and rewrite valid `mcp_launch_resolutions`
      // paths in place so offline upgrades reuse installed binaries; delete
      // only broken rows whose target binary no longer exists.
      const relocateMcpResult = relocateLegacyMcpPackagesDir(
        legacyMcpPackagesDir,
        targetMcpPackagesDir,
      );
      mcpPackagesMovedWholeDir = relocateMcpResult.movedWholeDir;
      const { cleared: mcpLaunchCachesCleared } = migrateLegacyMcpLaunchResolutions(db);

      // Migrate legacy plugin/search-based Tavily config into SQLite `mcp_servers`
      // (`npx -y tavily-mcp@latest`, preserving API key & enabled state) if no
      // Tavily MCP server already exists.
      const tavilyMigration = migrateLegacyTavilyPluginToMcp({
        db,
        openclawStateDir,
        nowMs: now().getTime(),
      });
      const tavilyMcpMigrated = tavilyMigration.migrated ? 1 : 0;

      // Migrate Remote MCP OAuth tokens from OpenClaw `mcp_oauth_stores` before
      // removing `openclaw/state/`. Only servers without a valid or refreshable
      // legacy token are marked for re-authorization.
      const {
        tokensMigrated: mcpOAuthTokensMigrated,
        reauthRequired: mcpOAuthReauthRequired,
      } = migrateLegacyMcpOAuthTokens({
        openclawStateDir,
        db,
        nowMs: now().getTime(),
        isPackaged: options.isPackaged,
      });
      reauthRequired.push(...mcpOAuthReauthRequired);

      // Pre-seed historical OpenClaw sessions natively into DSH v4 JSONL-Zstd
      // storage BEFORE initStore() and createWindow(); empty or unconvertible
      // sessions remain safely preserved for Lazy Context Bridge fallback.
      const sessionSeedResult = seedLegacySessionsToDsh({
        db,
        userDataDir,
        nowMs: now().getTime(),
      });
      createdSeededSessionDirs.push(...sessionSeedResult.createdSessionDirs);
      const { sessionsPreSeeded, sessionsPreservedForLazyBridge } = sessionSeedResult;

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
      // Record a lightweight manifest only; keep directories intact on disk so
      // migration never blocks reading/compressing large extension trees.
      const thirdPartyExtDir = path.join(userDataDir, 'third-party-extensions');
      const openclawExtDir = path.join(openclawStateDir, 'extensions');
      const thirdPartyExtNames = listTopLevelEntryNames(thirdPartyExtDir);
      const openclawExtNames = listTopLevelEntryNames(openclawExtDir);
      if (thirdPartyExtNames.length > 0 || openclawExtNames.length > 0) {
        incompatibleEntries.push({
          archivePath: 'sqlite/legacy_extensions_manifest.json',
          content: Buffer.from(
            JSON.stringify(
              {
                thirdPartyExtensionsDir: thirdPartyExtDir,
                thirdPartyExtensions: thirdPartyExtNames,
                openclawExtensionsDir: openclawExtDir,
                openclawExtensions: openclawExtNames,
              },
              null,
              2,
            ),
            'utf8',
          ),
        });
        archivedModules.push({
          category: 'third_party_extensions',
          label: 'Legacy OpenClaw extensions',
          count: thirdPartyExtNames.length + openclawExtNames.length,
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

      // 3d. Retired IM platform configs (NIM, NetEase Bee, Email)
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
              label: 'Retired IM configs (NIM / NetEase Bee / Email)',
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

      // 3f. Archive and clear stale pending `cowork_message_edits` and
      // `cowork_message_version_switches` rows so upgraded sessions are never
      // blocked waiting for retired in-place edit recovery.
      archiveAndClearLegacyPendingMessageEdits(db, incompatibleEntries);

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

      // ── Step 5: Preserve Legacy Data In Place & Free Pure Caches ─────────
      // Keep `openclaw/state` (including `media/`, `agents/`, workspaces, and
      // configs) and `third-party-extensions/` in place on disk instead of
      // synchronously tar+gzipping and deleting them before the window opens:
      //  - Avoids multi-minute main-thread freezes on large OpenClaw profiles.
      //  - Preserves original paths for historical IM/conversation media files.
      // Only pure disposable caches are cleaned (asynchronously after window
      // creation when `deferDisposableCacheCleanup` is enabled).
      let disposableBytesFreed = 0;
      if (!options.deferDisposableCacheCleanup) {
        for (const dir of getLegacyOpenClawDisposableCacheDirs(userDataDir)) {
          if (!fs.existsSync(dir)) continue;
          disposableBytesFreed += measureDirSize(dir);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      const legacyStateArchivePath: string | null = null;

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
          userMemoriesMigrated,
          skillsMigrated,
          scheduledTasksMigrated,
          scheduledTaskRunsMigrated,
          imAllowListsMigrated,
          sessionsPreSeeded,
          sessionsPreservedForLazyBridge,
          mcpLaunchCachesCleared,
          tavilyMcpMigrated,
          mcpOAuthTokensMigrated,
          disposableBytesFreed,
        },
        archivedModules,
        reauthRequired,
      };

      const commitTx = db.transaction(() => {
        setKv(db, 'cowork.agent_engine', 'dsh');
        setKv(db, MIGRATION_V2_REPORT_KV_KEY, JSON.stringify(report));
        setKv(db, MIGRATION_V2_COMPLETED_KV_KEY, JSON.stringify({ migratedAt: report.migratedAt, backupDir }));
        setKv(db, MIGRATION_V2_WEIXIN_CREDENTIALS_KEY, '1');
        setKv(
          db,
          MIGRATION_V2_CRON_BACKFILL_KV_KEY,
          JSON.stringify({
            completedAt: report.migratedAt,
            tasksImported: scheduledTasksMigrated,
            runsImported: scheduledTaskRunsMigrated,
          }),
        );
        setKv(db, PENDING_MESSAGE_EDITS_CLEARED_KV_KEY, '1');
        setKv(
          db,
          MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY,
          JSON.stringify({
            completedAt: report.migratedAt,
            memoriesImported: userMemoriesMigrated,
          }),
        );
        setKv(
          db,
          MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
          JSON.stringify({
            completedAt: report.migratedAt,
            diariesRestored: dreamDiariesMigrated,
          }),
        );
        setKv(
          db,
          MIGRATION_V2_TAVILY_BACKFILL_KV_KEY,
          JSON.stringify({
            completedAt: report.migratedAt,
            migrated: tavilyMigration.migrated,
            ...(tavilyMigration.source ? { source: tavilyMigration.source } : {}),
            ...(tavilyMigration.skippedReason ? { skippedReason: tavilyMigration.skippedReason } : {}),
          }),
        );
        setKv(
          db,
          MIGRATION_V2_MCP_OAUTH_BACKFILL_KV_KEY,
          JSON.stringify({
            completedAt: report.migratedAt,
            tokensMigrated: mcpOAuthTokensMigrated,
          }),
        );
      });
      commitTx();

      fs.writeFileSync(
        path.join(backupDir, 'migration-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );

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
      for (const seededDir of createdSeededSessionDirs) {
        try {
          fs.rmSync(seededDir, { recursive: true, force: true });
        } catch {
          // best-effort rollback of pre-seeded DSH session artifacts
        }
      }
      if (
        mcpPackagesMovedWholeDir
        && !fs.existsSync(legacyMcpPackagesDir)
        && fs.existsSync(targetMcpPackagesDir)
      ) {
        try {
          fs.renameSync(targetMcpPackagesDir, legacyMcpPackagesDir);
        } catch {
          // best-effort rollback
        }
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
