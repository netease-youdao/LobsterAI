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
import * as path from 'path';

import {
  DeliveryMode,
  SessionTarget,
  WakeMode,
} from '../../scheduledTask/constants';
import type { Schedule, ScheduledTaskInput } from '../../scheduledTask/types';
import {
  LEGACY_OPENCLAW_BACKUP_DIR_NAME,
  RETAINED_IM_PLATFORM_LIST,
  RetiredImPlatform,
  WORKSPACES_DIR_NAME,
} from '../../shared/dshEngine/hostConstants';
import {
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_REPORT_KV_KEY,
  type MigrationV2ArchivedItem,
  type MigrationV2ReauthItem,
  type MigrationV2Report,
  MigrationV2Status,
} from '../../shared/migration/constants';
import {
  LobsterMemoryService,
  stripManagedAgentsSection,
  WorkspaceFileName,
} from '../memory/lobsterMemoryService';
import { LobsterScheduler } from '../scheduledTask/lobsterScheduler';
import { migrateLegacySubagentHistory } from './legacySubagentHistory';
import {
  collectDirectoryTarEntries,
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

function extractLegacyCronJobs(openclawStateDir: string): Array<{ id?: string; input: ScheduledTaskInput }> {
  const results: Array<{ id?: string; input: ScheduledTaskInput }> = [];
  const seenIds = new Set<string>();

  const pushRawJob = (raw: Record<string, unknown>) => {
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
    if (id && seenIds.has(id)) return;
    if (id) seenIds.add(id);

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : (id || 'Migrated Task');
    const description = typeof raw.description === 'string' ? raw.description : '';
    const enabled = raw.enabled !== false;

    const rawSched = (raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {}) as Record<string, unknown>;
    let schedule: Schedule;
    if (rawSched.kind === 'at' && typeof rawSched.at === 'string') {
      schedule = { kind: 'at', at: rawSched.at };
    } else if (rawSched.kind === 'every' && typeof rawSched.everyMs === 'number' && rawSched.everyMs > 0) {
      schedule = { kind: 'every', everyMs: rawSched.everyMs };
    } else if (typeof rawSched.expr === 'string' && rawSched.expr.trim()) {
      schedule = {
        kind: 'cron',
        expr: rawSched.expr.trim(),
        ...(typeof rawSched.tz === 'string' && rawSched.tz.trim() ? { tz: rawSched.tz.trim() } : {}),
      };
    } else {
      return;
    }

    const rawPayload = (raw.payload && typeof raw.payload === 'object' ? raw.payload : {}) as Record<string, unknown>;
    const message = typeof rawPayload.message === 'string'
      ? rawPayload.message
      : typeof rawPayload.text === 'string'
        ? rawPayload.text
        : '';
    if (!message.trim()) return;

    const rawDelivery = (raw.delivery && typeof raw.delivery === 'object' ? raw.delivery : {}) as Record<string, unknown>;
    const channel = typeof rawDelivery.channel === 'string' ? rawDelivery.channel.toLowerCase() : undefined;
    const isRetainedChannel = channel && (RETAINED_IM_PLATFORM_LIST as readonly string[]).includes(channel);

    results.push({
      id,
      input: {
        name,
        description,
        enabled,
        schedule,
        sessionTarget: raw.sessionTarget === SessionTarget.Main ? SessionTarget.Main : SessionTarget.Isolated,
        wakeMode: raw.wakeMode === WakeMode.NextHeartbeat ? WakeMode.NextHeartbeat : WakeMode.Now,
        payload: {
          kind: 'agentTurn',
          message,
          ...(typeof rawPayload.model === 'string' ? { model: rawPayload.model } : {}),
        },
        delivery: isRetainedChannel
          ? {
              mode: DeliveryMode.Announce,
              channel,
              ...(typeof rawDelivery.to === 'string' ? { to: rawDelivery.to } : {}),
              ...(typeof rawDelivery.accountId === 'string' ? { accountId: rawDelivery.accountId } : {}),
            }
          : { mode: DeliveryMode.None },
        agentId: typeof raw.agentId === 'string' ? raw.agentId : 'main',
      },
    });
  };

  // Source A: `<openclawStateDir>/cron/jobs.json`
  const jobsJsonPath = path.join(openclawStateDir, 'cron', 'jobs.json');
  if (fs.existsSync(jobsJsonPath)) {
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

  // Source B: `<openclawStateDir>/state/openclaw.sqlite` (`cron` table if present)
  const openclawDbPath = path.join(openclawStateDir, 'state', 'openclaw.sqlite');
  if (fs.existsSync(openclawDbPath)) {
    let legacyDb: Database.Database | null = null;
    try {
      legacyDb = new Database(openclawDbPath, { readonly: true });
      if (tableExists(legacyDb, 'cron')) {
        const rows = legacyDb.prepare('SELECT * FROM cron').all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          if (typeof row.job_json === 'string') {
            try {
              const parsed = JSON.parse(row.job_json) as Record<string, unknown>;
              pushRawJob(parsed);
            } catch {
              // ignore malformed row
            }
          } else {
            pushRawJob(row);
          }
        }
      }
    } catch {
      // ignore unreadable legacy db
    } finally {
      legacyDb?.close();
    }
  }

  return results;
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
        if (content.trim().length > 0) {
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
      return { status: MigrationV2Status.Skipped };
    }

    // Fresh install guard: no legacy OpenClaw state dir and no legacy rows -> skip.
    const hasOpenClawState = fs.existsSync(openclawStateDir);
    const hasLegacyEngineKv = getKv(db, 'cowork.agent_engine') === 'openclaw';
    if (!hasOpenClawState && !hasLegacyEngineKv) {
      setKv(db, MIGRATION_V2_COMPLETED_KV_KEY, JSON.stringify({ migratedAt: now().toISOString(), freshInstall: true }));
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
      const workspacesMigrated = migrateLegacyWorkspaces(
        openclawStateDir,
        workspacesDir,
        incompatibleEntries,
        archivedModules,
      );

      // Scheduled tasks: import OpenClaw cron jobs into LobsterScheduler tables.
      const scheduler = new LobsterScheduler({ db });
      const legacyJobs = extractLegacyCronJobs(openclawStateDir);
      const scheduledTasksMigrated = scheduler.importLegacyJobs(legacyJobs);

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
          imAllowListsMigrated,
          sessionsPreservedForLazyBridge,
          mcpLaunchCachesCleared,
          disposableBytesFreed,
        },
        archivedModules,
        reauthRequired,
      };

      const commitTx = db.transaction(() => {
        setKv(db, 'cowork.agent_engine', 'dsh');
        setKv(db, MIGRATION_V2_REPORT_KV_KEY, JSON.stringify(report));
        setKv(db, MIGRATION_V2_COMPLETED_KV_KEY, JSON.stringify({ migratedAt: report.migratedAt, backupDir }));
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
