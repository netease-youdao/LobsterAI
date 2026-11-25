import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DeliveryMode, TaskStatus } from '../../scheduledTask/constants';
import {
  BrowserCredentialSaveMode,
  BrowserCredentialUseMode,
} from '../../shared/browserCredentials/constants';
import {
  BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  BrowserDisplayMode,
  BrowserNetworkMode,
} from '../../shared/browserWebAccess/constants';
import { CoworkMessageEditPhase } from '../../shared/cowork/messageEdit';
import {
  DSH_PERMISSION_PRESET_KV_KEY,
  DshPermissionPreset,
  LEGACY_OPENCLAW_BACKUP_DIR_NAME,
  WORKSPACES_DIR_NAME,
} from '../../shared/dshEngine/hostConstants';
import {
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
  MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY,
  MIGRATION_V2_REPORT_KV_KEY,
  MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY,
  MigrationV2Status,
} from '../../shared/migration/constants';
import { APP_CONFIG_KEY } from '../libs/browserDisplayModeMigration';
import { CoworkMessageEditStore } from '../libs/coworkMessageEditStore';
import { CoworkMessageVersionStore } from '../libs/coworkMessageVersionStore';
import { McpOAuthManager } from '../mcp/mcpOAuthManager';
import { LobsterMemoryService, memoryFingerprint } from '../memory/lobsterMemoryService';
import { LobsterScheduler } from '../scheduledTask/lobsterScheduler';
import {
  backfillLegacyDreamDiariesFromBackup,
  backfillLegacyMcpOAuthTokensFromBackup,
  backfillLegacyScheduledTasksFromBackup,
  backfillLegacyTavilyFromBackup,
  backfillLegacyUserMemories,
  cleanupLegacyOpenClawDisposableCaches,
  computeLegacyMcpOAuthStoreKey,
  dismissMigrationV2Report,
  extractLegacyTavilyConfig,
  getPendingMigrationV2Report,
  LegacyTavilySource,
  runLegacyOpenClawMigration,
} from './legacyOpenClawMigrator';
import {
  collectDirectoryTarEntries,
  extractMatchingEntriesFromTarGz,
  writeTarGzArchive,
} from './tarGzUtil';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-mig-v2-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('runLegacyOpenClawMigration', () => {
  test('hydrates missing expert persona files before first use and preserves edited or cleared files', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const db = new Database(sqlitePath);
    db.exec("CREATE TABLE agents (id TEXT, system_prompt TEXT, identity TEXT)");
    const add = db.prepare('INSERT INTO agents VALUES (?, ?, ?)');
    add.run('editor', 'old database prompt', 'proofreader');
    add.run('planner', 'meeting planner', 'stale identity');
    db.close();
    const state = path.join(userDataDir, 'openclaw', 'state');
    for (const expert of ['editor', 'planner']) {
      fs.mkdirSync(path.join(state, `workspace-${expert}`), { recursive: true });
    }
    fs.writeFileSync(path.join(state, 'workspace-editor', 'SOUL.md'), 'edited prompt');
    fs.writeFileSync(path.join(state, 'workspace-planner', 'IDENTITY.md'), '');
    expect(runLegacyOpenClawMigration({ userDataDir, sqlitePath }).status).toBe(MigrationV2Status.Completed);
    const root = path.join(userDataDir, WORKSPACES_DIR_NAME);
    expect(fs.readFileSync(path.join(root, 'editor', 'SOUL.md'), 'utf8')).toBe('edited prompt');
    expect(fs.readFileSync(path.join(root, 'editor', 'IDENTITY.md'), 'utf8')).toBe('proofreader\n');
    expect(fs.readFileSync(path.join(root, 'planner', 'SOUL.md'), 'utf8')).toBe('meeting planner\n');
    expect(fs.readFileSync(path.join(root, 'planner', 'IDENTITY.md'), 'utf8')).toBe('');
    fs.writeFileSync(path.join(root, 'planner', 'SOUL.md'), 'changed after upgrade');
    runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(fs.readFileSync(path.join(root, 'planner', 'SOUL.md'), 'utf8')).toBe('changed after upgrade');
  });

  test('executes full 6-step offline migration, archives incompatible modules, cleans caches, and is idempotent', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    // Seed legacy SQLite tables matching production schemas.
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, claude_session_id TEXT);
      CREATE TABLE user_plugins (plugin_id TEXT PRIMARY KEY, source TEXT, spec TEXT);
      CREATE TABLE mcp_launch_resolutions (server_id TEXT PRIMARY KEY, install_dir TEXT, command TEXT, args_json TEXT);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, config_json TEXT);
      CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_message_versions (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('cw-1', 'agent:main:legacy');
    db.prepare('INSERT INTO user_plugins VALUES (?, ?, ?)').run('plug-1', 'npm', 'legacy-weather');
    db.prepare('INSERT INTO mcp_launch_resolutions VALUES (?, ?, ?, ?)').run(
      'r1',
      '/tmp/openclaw/mcp-packages/foo',
      'node',
      '["/tmp/openclaw/mcp-packages/foo/bin.js"]',
    );
    db.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?)').run('m1', 'Linear', '{"oauth":{"enabled":true}}');
    db.prepare('INSERT INTO im_config VALUES (?, ?, ?)').run('nim', '{"appKey":"x"}', 1);
    db.prepare('INSERT INTO im_config VALUES (?, ?, ?)').run('feishu', '{"appId":"cli_1"}', 1);
    db.prepare('INSERT INTO cowork_message_versions VALUES (?, ?, ?)').run('v1', 'cw-1', 'old version');
    db.close();

    // Seed legacy OpenClaw filesystem layout.
    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    const wsMain = path.join(stateDir, 'workspace-main');
    fs.mkdirSync(path.join(wsMain, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(wsMain, '.dreams'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'cron'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'credentials'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'openclaw-weixin'), { recursive: true });
    fs.mkdirSync(path.join(userDataDir, 'openclaw', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(userDataDir, 'dsh-runtime'), { recursive: true });
    fs.mkdirSync(path.join(userDataDir, 'third-party-extensions', 'custom-ext'), { recursive: true });

    fs.writeFileSync(path.join(wsMain, 'SOUL.md'), 'Be concise and helpful.\n');
    fs.writeFileSync(path.join(wsMain, 'MEMORY.md'), '# Memory\n\n- Likes TypeScript.\n');
    fs.writeFileSync(
      path.join(wsMain, 'AGENTS.md'),
      '<!-- LOBSTERAI_MANAGED_START -->\nOld managed block\n<!-- LOBSTERAI_MANAGED_END -->\nUser custom rule.\n',
    );
    fs.writeFileSync(path.join(wsMain, 'memory', '2026-11-18.md'), '# 2026-11-18\n\nShipped feature.\n');
    fs.writeFileSync(path.join(wsMain, '.dreams', 'dream-1.md'), 'Old dream note\n');
    fs.writeFileSync(path.join(stateDir, 'openclaw.user.json'), '{"custom":true}\n');
    fs.writeFileSync(
      path.join(stateDir, 'cron', 'jobs.json'),
      JSON.stringify([
        {
          id: 'cron-daily-1',
          name: 'Daily Standup',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
          payload: { kind: 'agentTurn', message: 'Summarize PRs' },
          delivery: { mode: 'announce', channel: 'feishu', to: 'chat_1' },
        },
      ]),
    );
    fs.writeFileSync(
      path.join(stateDir, 'credentials', 'telegram-allowFrom.json'),
      JSON.stringify(['123456']),
    );
    fs.writeFileSync(path.join(userDataDir, 'openclaw', 'logs', 'gateway.log'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(userDataDir, 'dsh-runtime', 'old-cache.bin'), 'y'.repeat(1024));
    fs.writeFileSync(path.join(userDataDir, 'third-party-extensions', 'custom-ext', 'index.js'), 'export default {};');

    // Run migration!
    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-20T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report).toBeDefined();
    const report = result.report!;

    // Verify Step 1 snapshot + Step 3 incompatible manifest archive exist & are non-empty.
    // `openclaw/state` is preserved in place (no full tar.gz archive) to avoid blocking boot
    // and to keep historical `openclaw/state/media` artifact paths intact.
    expect(fs.existsSync(report.sqliteSnapshotPath)).toBe(true);
    expect(fs.existsSync(report.incompatibleArchivePath)).toBe(true);
    expect(fs.statSync(report.incompatibleArchivePath).size).toBeGreaterThan(0);
    expect(report.legacyStateArchivePath).toBeNull();
    expect(fs.existsSync(path.join(report.backupDir, 'migration-report.json'))).toBe(true);

    // Verify Step 2 workspaces migrated & managed AGENTS.md stripped & .dreams omitted.
    const migratedMain = path.join(userDataDir, WORKSPACES_DIR_NAME, 'main');
    expect(fs.readFileSync(path.join(migratedMain, 'SOUL.md'), 'utf8')).toContain('Be concise');
    expect(fs.readFileSync(path.join(migratedMain, 'AGENTS.md'), 'utf8')).toBe('User custom rule.');
    expect(fs.existsSync(path.join(migratedMain, 'memory', '2026-11-18.md'))).toBe(true);
    expect(fs.existsSync(path.join(migratedMain, '.dreams'))).toBe(false);
    expect(report.summary.workspacesMigrated).toBe(1);
    expect(report.summary.scheduledTasksMigrated).toBe(1);
    expect(report.summary.imAllowListsMigrated).toBe(1);
    expect(report.summary.sessionsPreservedForLazyBridge).toBe(1);
    expect(report.summary.mcpLaunchCachesCleared).toBe(1);
    expect(report.summary.disposableBytesFreed).toBeGreaterThanOrEqual(3072);

    // Verify retired/incompatible items & reauth prompts captured in report.
    expect(report.archivedModules.map((m) => m.category)).toEqual(
      expect.arrayContaining([
        'dreaming_embedding',
        'user_plugins',
        'third_party_extensions',
        'openclaw_config',
        'retired_im',
        'message_versions',
      ]),
    );
    expect(report.reauthRequired.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['im_weixin', 'mcp_oauth']),
    );

    // Verify Step 5 cleaned up pure disposable caches while preserving `openclaw/state`
    // and `third-party-extensions` in place on disk.
    expect(fs.existsSync(path.join(userDataDir, 'openclaw', 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'openclaw', 'state'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'dsh-runtime'))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'third-party-extensions'))).toBe(true);

    // Verify scheduled task landed in LobsterScheduler SQLite table & pending report readable.
    const verifyDb = new Database(sqlitePath);
    const scheduler = new LobsterScheduler({ db: verifyDb });
    expect(scheduler.listTasks().map((t) => t.name)).toEqual(['Daily Standup']);
    expect(getPendingMigrationV2Report(verifyDb)?.version).toBe(2);
    dismissMigrationV2Report(verifyDb);
    expect(getPendingMigrationV2Report(verifyDb)).toBeNull();
    verifyDb.close();

    // Re-running migration is a fast idempotent no-op.
    const second = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(second.status).toBe(MigrationV2Status.Skipped);
  });

  test('skips cleanly on fresh installs with no legacy OpenClaw state', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.close();

    const result = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(result.status).toBe(MigrationV2Status.Skipped);
  });

  test('migrates OpenClaw SQLite cron_jobs, task_runs, cron_run_receipts, and cowork_sessions while skipping internal jobs', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        claude_session_id TEXT,
        scheduled_task_id TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    // Dedicated single-run session for job-news matching receipt-old timestamp
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      'cw-news-1',
      '[定时] 科技早报',
      null,
      'job-news',
      1_794_357_002_000,
      1_794_357_150_000,
    );
    // Unmatched historical single-run session predating receipts/task_runs
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      'cw-wrapup-1',
      '[定时] 每日工作收尾',
      null,
      'job-wrapup',
      1_785_837_601_000,
      1_785_837_635_000,
    );
    db.close();

    // Seed OpenClaw 2026.8 state layout with SQLite WAL + migrated json files.
    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'cron'), { recursive: true });

    // Deleted old job in `jobs.json.migrated` must NOT be resurrected when `cron_jobs` exists.
    fs.writeFileSync(
      path.join(stateDir, 'cron', 'jobs.json.migrated'),
      JSON.stringify({
        jobs: [
          {
            id: 'deleted-old-job',
            name: 'Deleted Old Job',
            enabled: true,
            schedule: { kind: 'cron', expr: '0 8 * * *' },
            payload: { kind: 'agentTurn', message: 'Old deleted prompt' },
          },
        ],
      }),
    );

    const openclawDb = new Database(path.join(stateDir, 'state', 'openclaw.sqlite'));
    openclawDb.pragma('journal_mode = WAL');
    openclawDb.exec(`
      CREATE TABLE cron_jobs (
        store_key TEXT,
        job_id TEXT PRIMARY KEY,
        declaration_key TEXT,
        name TEXT,
        description TEXT,
        enabled INTEGER,
        agent_id TEXT,
        payload_kind TEXT,
        job_json TEXT,
        state_json TEXT,
        runtime_updated_at_ms INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT,
        source_id TEXT,
        child_session_key TEXT,
        run_id TEXT,
        label TEXT,
        status TEXT,
        delivery_status TEXT,
        created_at INTEGER,
        started_at INTEGER,
        ended_at INTEGER,
        error TEXT,
        terminal_summary TEXT
      );
      CREATE TABLE cron_run_receipts (
        receipt_id TEXT PRIMARY KEY,
        job_id TEXT,
        status TEXT,
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        error_text TEXT
      );
    `);

    const insertJob = openclawDb.prepare(
      'INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertJob.run(
      'jobs.json',
      'job-news',
      null,
      '科技早报',
      null,
      1,
      'main',
      'agentTurn',
      JSON.stringify({
        id: 'job-news',
        name: '科技早报',
        enabled: true,
        createdAtMs: 1_784_537_622_080,
        schedule: { kind: 'cron', expr: '30 8 * * 1,2,3,4,5', tz: 'Asia/Shanghai' },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: '整理今日科技早报' },
        delivery: { mode: 'none' },
      }),
      JSON.stringify({
        lastRunAtMs: 1_795_048_200_040,
        lastStatus: 'ok',
        lastDurationMs: 127_896,
      }),
      1_795_048_327_936,
      1_795_048_327_936,
    );
    insertJob.run(
      'jobs.json',
      'job-stars',
      null,
      'github star 数',
      null,
      1,
      'main',
      'agentTurn',
      JSON.stringify({
        id: 'job-stars',
        name: 'github star 数',
        enabled: true,
        createdAtMs: 1_784_727_023_918,
        schedule: { kind: 'cron', expr: '51 13 * * *' },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: '汇报 GitHub stars' },
        delivery: {
          mode: 'announce',
          channel: 'openclaw-weixin',
          to: 'user@im.wechat',
          accountId: 'bot-1',
        },
      }),
      JSON.stringify({ lastRunAtMs: 1_794_981_060_029, lastStatus: 'ok' }),
      1_794_981_060_029,
      1_794_981_060_029,
    );
    insertJob.run(
      'jobs.json',
      'job-wrapup',
      null,
      '每日工作收尾',
      null,
      0,
      'main',
      'agentTurn',
      JSON.stringify({
        id: 'job-wrapup',
        name: '每日工作收尾',
        enabled: false,
        createdAtMs: 1_784_290_347_114,
        schedule: { kind: 'cron', expr: '0 18 * * 1,2,3,4,5' },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: '工作收尾摘要' },
        delivery: { mode: 'announce', channel: 'moltbot-popo', to: 'user:legacy-user' },
      }),
      JSON.stringify({ lastRunAtMs: 1_785_837_600_026, lastStatus: 'ok' }),
      1_785_837_600_026,
      1_785_837_600_026,
    );
    // Internal OpenClaw jobs that MUST be excluded.
    insertJob.run(
      'jobs.json',
      'internal-hb',
      'heartbeat:main',
      'heartbeat-main',
      null,
      0,
      'main',
      'heartbeat',
      JSON.stringify({
        id: 'internal-hb',
        name: 'heartbeat-main',
        enabled: false,
        schedule: { kind: 'every', everyMs: 1_800_000 },
        payload: { kind: 'heartbeat' },
      }),
      '{}',
      1,
      1,
    );
    insertJob.run(
      'jobs.json',
      'internal-skill',
      'skill-collection-review:main',
      'skill-collection-review-main',
      null,
      0,
      'main',
      'skillCollectionReview',
      JSON.stringify({
        id: 'internal-skill',
        name: 'skill-collection-review-main',
        enabled: false,
        schedule: { kind: 'every', everyMs: 604_800_000 },
        payload: { kind: 'skillCollectionReview' },
      }),
      '{}',
      1,
      1,
    );

    // Seed task_runs (including 1 succeeded run overlapping with receipt + 1 stale running run)
    openclawDb
      .prepare('INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'tr-1',
        'cron',
        'job-news',
        'agent:main:cron:job-news:run:abc',
        'cron:job-news:1795048200040:rcpt-1',
        '科技早报',
        'succeeded',
        'not_applicable',
        1_795_048_200_040,
        1_795_048_200_040,
        1_795_048_327_936,
        null,
        '科技早报摘要内容',
      );
    openclawDb
      .prepare('INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'tr-running',
        'cron',
        'job-news',
        null,
        'cron:job-news:1795134600044:rcpt-running',
        '科技早报',
        'running',
        'not_applicable',
        1_795_134_600_044,
        1_795_134_600_044,
        null,
        null,
        null,
      );

    // Seed cron_run_receipts: rcpt-1 overlaps tr-1 (must dedupe!), rcpt-old is unique older run.
    openclawDb
      .prepare('INSERT INTO cron_run_receipts VALUES (?, ?, ?, ?, ?, ?)')
      .run('rcpt-1', 'job-news', 'ok', 1_795_048_200_040, 1_795_048_327_936, null);
    openclawDb
      .prepare('INSERT INTO cron_run_receipts VALUES (?, ?, ?, ?, ?, ?)')
      .run('rcpt-old', 'job-news', 'ok', 1_794_357_000_046, 1_794_357_152_059, null);
    openclawDb
      .prepare('INSERT INTO cron_run_receipts VALUES (?, ?, ?, ?, ?, ?)')
      .run('rcpt-orphan', 'deleted-old-job', 'ok', 1_790_000_000_000, 1_790_000_010_000, null);
    openclawDb.close();

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-20T03:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.summary.scheduledTasksMigrated).toBe(3);
    expect(result.report?.summary.scheduledTaskRunsMigrated).toBe(4);

    const verifyDb = new Database(sqlitePath);
    const scheduler = new LobsterScheduler({ db: verifyDb });
    const tasks = scheduler.listTasks();
    expect(tasks.map((t) => t.id).sort()).toEqual(['job-news', 'job-stars', 'job-wrapup']);

    const starsTask = scheduler.getTask('job-stars')!;
    expect(starsTask.enabled).toBe(true);
    expect(starsTask.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'openclaw-weixin',
      to: 'user@im.wechat',
      accountId: 'bot-1',
    });
    expect(starsTask.state.nextRunAtMs).toBeGreaterThan(Date.parse('2026-11-20T03:00:00.000Z'));

    // Preserve POPO delivery even when the migrated task itself is disabled.
    const wrapupTask = scheduler.getTask('job-wrapup')!;
    expect(wrapupTask.enabled).toBe(false);
    expect(wrapupTask.delivery).toMatchObject({ mode: DeliveryMode.Announce, channel: 'moltbot-popo', to: 'user:legacy-user' });

    // Verify runs: 3 for job-news (tr-1 deduped against rcpt-1, tr-running downgraded to error, rcpt-old linked to cw-news-1)
    // + 1 synthesized from cowork_sessions for job-wrapup.
    const newsRuns = scheduler.listRuns('job-news', 20, 0);
    expect(newsRuns).toHaveLength(3);
    expect(newsRuns.find((r) => r.id === 'legacy-taskrun-tr-1')?.summary).toBe('科技早报摘要内容');
    expect(newsRuns.find((r) => r.id === 'legacy-taskrun-tr-running')?.status).toBe(TaskStatus.Error);
    expect(newsRuns.find((r) => r.id === 'legacy-receipt-rcpt-old')?.sessionId).toBe('cw-news-1');

    const wrapupRuns = scheduler.listRuns('job-wrapup', 20, 0);
    expect(wrapupRuns).toHaveLength(1);
    expect(wrapupRuns[0].sessionId).toBe('cw-wrapup-1');
    verifyDb.close();
  });

  test('backfillLegacyScheduledTasksFromBackup restores missing tasks and runs idempotently for already-migrated users', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    // Build a legacy OpenClaw state archive mimicking an already-migrated backup.
    const stagingStateDir = path.join(createTempDir(), 'openclaw-state');
    fs.mkdirSync(path.join(stagingStateDir, 'state'), { recursive: true });
    const legacyDb = new Database(path.join(stagingStateDir, 'state', 'openclaw.sqlite'));
    legacyDb.exec(`
      CREATE TABLE cron_jobs (
        job_id TEXT PRIMARY KEY,
        declaration_key TEXT,
        name TEXT,
        enabled INTEGER,
        payload_kind TEXT,
        job_json TEXT,
        state_json TEXT
      );
      CREATE TABLE cron_run_receipts (
        receipt_id TEXT PRIMARY KEY,
        job_id TEXT,
        status TEXT,
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        error_text TEXT
      );
    `);
    legacyDb
      .prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        'backfill-job-1',
        null,
        '每日简报',
        1,
        'agentTurn',
        JSON.stringify({
          id: 'backfill-job-1',
          name: '每日简报',
          enabled: true,
          createdAtMs: 1_784_537_622_080,
          schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
          payload: { kind: 'agentTurn', message: '生成每日简报' },
          delivery: { mode: 'announce', channel: 'lark', to: 'oc_123' },
        }),
        JSON.stringify({ lastRunAtMs: 1_795_000_000_000, lastStatus: 'ok' }),
      );
    legacyDb
      .prepare('INSERT INTO cron_run_receipts VALUES (?, ?, ?, ?, ?, ?)')
      .run('r-backfill-1', 'backfill-job-1', 'ok', 1_795_000_000_000, 1_795_000_045_000, null);
    legacyDb.close();

    const backupDir = path.join(
      userDataDir,
      LEGACY_OPENCLAW_BACKUP_DIR_NAME,
      '2026-11-20T00-57-39-889Z',
    );
    fs.mkdirSync(backupDir, { recursive: true });
    const archivePath = path.join(backupDir, 'legacy-openclaw-state.tar.gz');
    writeTarGzArchive(
      archivePath,
      collectDirectoryTarEntries(stagingStateDir, 'openclaw-state'),
    );

    // Seed an already-migrated lobsterai.sqlite where scheduledTasksMigrated was 0.
    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    const initialReport = {
      version: 2,
      migratedAt: '2026-11-20T00:57:39.889Z',
      backupDir,
      incompatibleArchivePath: path.join(backupDir, 'incompatible-modules-backup.tar.gz'),
      legacyStateArchivePath: archivePath,
      sqliteSnapshotPath: path.join(backupDir, 'lobsterai.pre-v2.sqlite'),
      dismissed: true,
      summary: {
        workspacesMigrated: 1,
        scheduledTasksMigrated: 0,
        imAllowListsMigrated: 0,
        sessionsPreservedForLazyBridge: 10,
        mcpLaunchCachesCleared: 0,
        disposableBytesFreed: 0,
      },
      archivedModules: [],
      reauthRequired: [],
    };
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: initialReport.migratedAt, backupDir }),
      1,
    );
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_REPORT_KV_KEY,
      JSON.stringify(initialReport),
      1,
    );

    const first = await backfillLegacyScheduledTasksFromBackup({
      userDataDir,
      db,
      now: () => new Date('2026-11-20T04:00:00.000Z'),
    });
    expect(first).toEqual({
      status: 'completed',
      tasksImported: 1,
      runsImported: 1,
    });

    const scheduler = new LobsterScheduler({ db });
    const restored = scheduler.getTask('backfill-job-1')!;
    expect(restored.name).toBe('每日简报');
    expect(restored.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'feishu',
      to: 'oc_123',
    });
    expect(scheduler.countRuns('backfill-job-1')).toBe(1);

    const updatedReport = JSON.parse(
      fs.readFileSync(path.join(backupDir, 'migration-report.json'), 'utf8'),
    ) as { summary: { scheduledTasksMigrated: number; scheduledTaskRunsMigrated: number } };
    expect(updatedReport.summary.scheduledTasksMigrated).toBe(1);
    expect(updatedReport.summary.scheduledTaskRunsMigrated).toBe(1);

    // Second run must be an idempotent no-op.
    const second = await backfillLegacyScheduledTasksFromBackup({ userDataDir, db });
    expect(second).toEqual({
      status: 'skipped',
      tasksImported: 0,
      runsImported: 0,
    });
    db.close();
  });

  test('pre-seeds legacy cowork sessions into DSH v4 storage before window open and records report counts', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const projectDir = path.join(userDataDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        claude_session_id TEXT,
        cwd TEXT,
        created_at INTEGER
      );
      CREATE TABLE cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER,
        sequence INTEGER
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)').run(
      'cw-seeded',
      'Migrated Multi-Turn',
      'agent:main:legacy-rich',
      projectDir,
      1_700_000_000_000,
    );
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)').run(
      'cw-empty',
      'Empty Draft',
      null,
      projectDir,
      1_700_000_000_500,
    );
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'm1', 'cw-seeded', 'user', 'Remember project Apollo-42.', null, 1_700_000_001_000, 1,
    );
    db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'm2', 'cw-seeded', 'assistant', 'Noted Apollo-42.', null, 1_700_000_002_000, 2,
    );
    db.close();

    fs.mkdirSync(path.join(userDataDir, 'openclaw', 'state', 'workspace-main'), { recursive: true });

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.summary.sessionsPreSeeded).toBe(1);
    expect(result.report?.summary.sessionsPreservedForLazyBridge).toBe(1);

    const verifyDb = new Database(sqlitePath);
    const seededRow = verifyDb
      .prepare('SELECT claude_session_id FROM cowork_sessions WHERE id = ?')
      .get('cw-seeded') as { claude_session_id: string | null };
    const emptyRow = verifyDb
      .prepare('SELECT claude_session_id FROM cowork_sessions WHERE id = ?')
      .get('cw-empty') as { claude_session_id: string | null };
    verifyDb.close();

    expect(seededRow.claude_session_id).toMatch(/^dsh:[0-9a-f-]{36}$/);
    expect(emptyRow.claude_session_id).toBeNull();
  });

  test('never reads or mutates co-installed official ~/.dsh or ~/.agents across fresh boot and legacy OpenClaw upgrade', () => {
    const hashTree = (rootDir: string): Record<string, string> => {
      const digestMap: Record<string, string> = {};
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(rootDir, full).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            digestMap[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          }
        }
      };
      walk(rootDir);
      return digestMap;
    };

    const fakeHome = createTempDir();
    const officialDshDir = path.join(fakeHome, '.dsh');
    const officialAgentsDir = path.join(fakeHome, '.agents');

    fs.mkdirSync(path.join(officialDshDir, 'profiles', 'web'), { recursive: true });
    fs.mkdirSync(path.join(officialDshDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(officialAgentsDir, 'skills', 'official-only'), { recursive: true });

    fs.writeFileSync(
      path.join(officialDshDir, '.credentials.yaml'),
      'DEEPSEEK_API_KEY: sk-official-dsh-secret\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(officialDshDir, 'cordis.patch.yml'),
      '- id: llm-deepseek\n  config:\n    model: deepseek-chat\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(officialDshDir, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'official-web-profile', private: true }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(officialDshDir, 'sessions', 'official-session-1.jsonl'),
      '{"role":"user","content":"official dsh session"}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(officialAgentsDir, 'skills', 'official-only', 'SKILL.md'),
      '---\nname: official-only\ndescription: Official DSH skill\n---\n',
      'utf8',
    );

    const beforeDsh = hashTree(officialDshDir);
    const beforeAgents = hashTree(officialAgentsDir);

    const prevEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      DSH_HOME: process.env.DSH_HOME,
      DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME,
    };

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      process.env.DSH_HOME = officialDshDir;
      process.env.DSH_AGENTS_HOME = officialAgentsDir;

      // 1. Fresh install boot check
      const freshUserData = createTempDir();
      const freshSqlite = path.join(freshUserData, 'lobsterai.sqlite');
      const freshDb = new Database(freshSqlite);
      freshDb.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
      freshDb.close();
      expect(runLegacyOpenClawMigration({ userDataDir: freshUserData, sqlitePath: freshSqlite }).status).toBe(
        MigrationV2Status.Skipped,
      );
      expect(hashTree(officialDshDir)).toEqual(beforeDsh);
      expect(hashTree(officialAgentsDir)).toEqual(beforeAgents);

      // 2. Legacy OpenClaw -> DSH v2 upgrade migration (including old userData/dsh-runtime cleanup)
      const upgradeUserData = createTempDir();
      const upgradeSqlite = path.join(upgradeUserData, 'lobsterai.sqlite');
      const upgradeDb = new Database(upgradeSqlite);
      upgradeDb.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
      upgradeDb.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
      upgradeDb.close();

      const legacyWs = path.join(upgradeUserData, 'openclaw', 'state', 'workspace-main');
      fs.mkdirSync(legacyWs, { recursive: true });
      fs.writeFileSync(path.join(legacyWs, 'SOUL.md'), 'LobsterAI user persona\n', 'utf8');
      fs.mkdirSync(path.join(upgradeUserData, 'dsh-runtime'), { recursive: true });
      fs.writeFileSync(path.join(upgradeUserData, 'dsh-runtime', 'stale.bin'), 'stale-cache', 'utf8');

      const upgradeRes = runLegacyOpenClawMigration({
        userDataDir: upgradeUserData,
        sqlitePath: upgradeSqlite,
        now: () => new Date('2026-11-21T00:00:00.000Z'),
      });
      expect(upgradeRes.status).toBe(MigrationV2Status.Completed);
      expect(fs.existsSync(path.join(upgradeUserData, 'dsh-runtime'))).toBe(false);
      expect(hashTree(officialDshDir)).toEqual(beforeDsh);
      expect(hashTree(officialAgentsDir)).toEqual(beforeAgents);
    } finally {
      for (const [key, val] of Object.entries(prevEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  });

  test('archives and clears uncommitted cowork_message_edits and pending cowork_message_version_switches during migration', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, claude_session_id TEXT);
      CREATE TABLE cowork_message_edits (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE cowork_message_version_switches (
        session_id TEXT PRIMARY KEY,
        switch_json TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('cw-stuck-1', 'agent:main:legacy-1');
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('cw-stuck-2', 'agent:main:legacy-2');
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('cw-done', 'agent:main:legacy-3');

    const insertEdit = db.prepare('INSERT INTO cowork_message_edits VALUES (?, ?, ?, ?, ?)');
    insertEdit.run(
      'op-editing',
      'cw-stuck-1',
      'editing',
      JSON.stringify({ operationId: 'op-editing', sessionId: 'cw-stuck-1', messageId: 'm1', prompt: 'edited', phase: 'editing' }),
      JSON.stringify({ messages: [{ id: 'm1', content: 'orig' }] }),
    );
    insertEdit.run(
      'op-truncating',
      'cw-stuck-2',
      'truncating',
      JSON.stringify({ operationId: 'op-truncating', sessionId: 'cw-stuck-2', messageId: 'm2', prompt: 'edited-2', phase: 'truncating' }),
      JSON.stringify({ messages: [{ id: 'm2', content: 'orig-2' }] }),
    );
    insertEdit.run(
      'op-rewound',
      'cw-stuck-2',
      CoworkMessageEditPhase.Rewound,
      JSON.stringify({
        operationId: 'op-rewound',
        sessionId: 'cw-stuck-2',
        messageId: 'm3',
        prompt: 'edited-3',
        phase: CoworkMessageEditPhase.Rewound,
      }),
      JSON.stringify({ messages: [{ id: 'm3', content: 'orig-3' }] }),
    );
    insertEdit.run(
      'op-committed',
      'cw-done',
      CoworkMessageEditPhase.Committed,
      JSON.stringify({
        operationId: 'op-committed',
        sessionId: 'cw-done',
        messageId: 'm4',
        prompt: 'done',
        phase: CoworkMessageEditPhase.Committed,
      }),
      JSON.stringify({ messages: [{ id: 'm4', content: 'orig-4' }] }),
    );

    db.prepare('INSERT INTO cowork_message_version_switches VALUES (?, ?)').run(
      'cw-stuck-1',
      JSON.stringify({ sessionId: 'cw-stuck-1', fromVersionId: 'v1', toVersionId: 'v2', activeLeafEntryId: 'l1', targetLeafEntryId: 'l2' }),
    );
    db.close();

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report).toBeDefined();

    // Verify all non-terminal pending edits and pending version switches were archived before deletion.
    const extractDir = createTempDir();
    const extracted = await extractMatchingEntriesFromTarGz(
      result.report!.incompatibleArchivePath,
      extractDir,
      (archivePath) =>
        archivePath === 'sqlite/cowork_message_edits.json'
        || archivePath === 'sqlite/cowork_message_version_switches.json',
    );
    expect(extracted.sort()).toEqual([
      'sqlite/cowork_message_edits.json',
      'sqlite/cowork_message_version_switches.json',
    ]);

    const archivedEdits = JSON.parse(
      fs.readFileSync(path.join(extractDir, 'sqlite', 'cowork_message_edits.json'), 'utf8'),
    ) as Array<{ operation_id: string; phase: string }>;
    expect(archivedEdits.map((row) => row.operation_id).sort()).toEqual([
      'op-editing',
      'op-rewound',
      'op-truncating',
    ]);

    const archivedSwitches = JSON.parse(
      fs.readFileSync(path.join(extractDir, 'sqlite', 'cowork_message_version_switches.json'), 'utf8'),
    ) as Array<{ session_id: string }>;
    expect(archivedSwitches.map((row) => row.session_id)).toEqual(['cw-stuck-1']);

    // Verify CoworkMessageEditStore & CoworkMessageVersionStore report zero pending records,
    // while terminal committed rows are untouched.
    const verifyDb = new Database(sqlitePath);
    const editStore = new CoworkMessageEditStore(verifyDb, (_sessionId, op) => verifyDb.transaction(op)());
    const versionStore = new CoworkMessageVersionStore(verifyDb, (_sessionId, op) => verifyDb.transaction(op)());

    expect(editStore.pending('cw-stuck-1')).toBeNull();
    expect(editStore.pending('cw-stuck-2')).toBeNull();
    expect(editStore.pending('cw-done')).toBeNull();
    expect(versionStore.pendingSwitch('cw-stuck-1')).toBeNull();

    const remainingEdits = verifyDb
      .prepare('SELECT operation_id, phase FROM cowork_message_edits')
      .all() as Array<{ operation_id: string; phase: string }>;
    expect(remainingEdits).toEqual([
      { operation_id: 'op-committed', phase: CoworkMessageEditPhase.Committed },
    ]);
    verifyDb.close();
  });

  test('clears leftover pending cowork_message_edits and switches on already-migrated v2 databases', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, claude_session_id TEXT);
      CREATE TABLE cowork_message_edits (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE cowork_message_version_switches (
        session_id TEXT PRIMARY KEY,
        switch_json TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-20T00:00:00.000Z' }),
      1,
    );
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('cw-legacy', 'dsh:sess-1');
    db.prepare('INSERT INTO cowork_message_edits VALUES (?, ?, ?, ?, ?)').run(
      'op-stale',
      'cw-legacy',
      CoworkMessageEditPhase.Sending,
      JSON.stringify({
        operationId: 'op-stale',
        sessionId: 'cw-legacy',
        messageId: 'm1',
        prompt: 'stuck',
        phase: CoworkMessageEditPhase.Sending,
      }),
      JSON.stringify({ messages: [] }),
    );
    db.prepare('INSERT INTO cowork_message_version_switches VALUES (?, ?)').run(
      'cw-legacy',
      JSON.stringify({ sessionId: 'cw-legacy', fromVersionId: 'v1', toVersionId: 'v2' }),
    );
    db.close();

    const result = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(result.status).toBe(MigrationV2Status.Skipped);

    const verifyDb = new Database(sqlitePath);
    const editStore = new CoworkMessageEditStore(verifyDb, (_sessionId, op) => verifyDb.transaction(op)());
    const versionStore = new CoworkMessageVersionStore(verifyDb, (_sessionId, op) => verifyDb.transaction(op)());
    expect(editStore.pending('cw-legacy')).toBeNull();
    expect(versionStore.pendingSwitch('cw-legacy')).toBeNull();
    verifyDb.close();
  });

  test('migrates legacy cowork_config.executionMode and per-session execution_mode to DSH permission presets', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const openclawStateDir = path.join(userDataDir, 'openclaw', 'state');
    fs.mkdirSync(openclawStateDir, { recursive: true });

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        execution_mode TEXT
      );
    `);
    db.prepare("INSERT INTO cowork_config (key, value, updated_at) VALUES ('executionMode', 'auto', 1)").run();
    db.prepare("INSERT INTO cowork_sessions (id, title, claude_session_id, execution_mode) VALUES ('s-auto', 'Auto', 'oc-1', 'auto')").run();
    db.prepare("INSERT INTO cowork_sessions (id, title, claude_session_id, execution_mode) VALUES ('s-local', 'Local', 'oc-2', 'local')").run();
    db.close();

    const result = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(result.status).toBe(MigrationV2Status.Completed);

    const checkDb = new Database(sqlitePath, { readonly: true });
    const defaultKv = checkDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(DSH_PERMISSION_PRESET_KV_KEY) as { value?: string } | undefined;
    expect(defaultKv?.value).toBe(DshPermissionPreset.FullAccess);

    const sessions = checkDb
      .prepare('SELECT id, permission_preset FROM cowork_sessions ORDER BY id')
      .all() as Array<{ id: string; permission_preset: string | null }>;
    expect(sessions).toEqual([
      { id: 's-auto', permission_preset: null },
      { id: 's-local', permission_preset: DshPermissionPreset.WorkspaceWrite },
    ]);
    checkDb.close();
  });

  test('backfills legacy executionMode on already-migrated DB once without overwriting user-chosen preset', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        execution_mode TEXT
      );
    `);
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-01T00:00:00.000Z' }),
    );
    db.prepare("INSERT INTO cowork_config (key, value, updated_at) VALUES ('executionMode', 'local', 1)").run();
    db.prepare("INSERT INTO cowork_sessions (id, title, execution_mode) VALUES ('s-auto', 'Auto', 'auto')").run();
    db.prepare("INSERT INTO cowork_sessions (id, title, execution_mode) VALUES ('s-local', 'Local', 'local')").run();
    db.close();

    const first = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(first.status).toBe(MigrationV2Status.Skipped);

    const afterFirst = new Database(sqlitePath);
    const defaultKv = afterFirst
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(DSH_PERMISSION_PRESET_KV_KEY) as { value?: string } | undefined;
    expect(defaultKv?.value).toBe(DshPermissionPreset.WorkspaceWrite);
    const marker = afterFirst
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY) as { value?: string } | undefined;
    expect(marker?.value).toBe('1');
    const sessions = afterFirst
      .prepare('SELECT id, permission_preset FROM cowork_sessions ORDER BY id')
      .all() as Array<{ id: string; permission_preset: string | null }>;
    expect(sessions).toEqual([
      { id: 's-auto', permission_preset: DshPermissionPreset.FullAccess },
      { id: 's-local', permission_preset: null },
    ]);

    // User switches global default to read-only and resets s-auto to workspace-write:
    // re-running migration must NOT overwrite those changes.
    afterFirst.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, 2)').run(
      DSH_PERMISSION_PRESET_KV_KEY,
      DshPermissionPreset.ReadOnly,
    );
    afterFirst.prepare('UPDATE cowork_sessions SET permission_preset = ? WHERE id = ?').run(
      DshPermissionPreset.WorkspaceWrite,
      's-auto',
    );
    afterFirst.close();

    runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    const afterSecond = new Database(sqlitePath, { readonly: true });
    expect(
      (afterSecond.prepare('SELECT value FROM kv WHERE key = ?').get(DSH_PERMISSION_PRESET_KV_KEY) as { value?: string })?.value,
    ).toBe(DshPermissionPreset.ReadOnly);
    expect(
      (afterSecond.prepare("SELECT permission_preset FROM cowork_sessions WHERE id = 's-auto'").get() as { permission_preset?: string })?.permission_preset,
    ).toBe(DshPermissionPreset.WorkspaceWrite);
    afterSecond.close();
  });

  test('migrates bare legacy workspace/ when workspace-main is absent and recursively copies nested memory/**/*.md excluding .dreams/', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);');
    db.close();

    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    const bareWs = path.join(stateDir, 'workspace');
    fs.mkdirSync(path.join(bareWs, 'memory', 'topics', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(bareWs, 'memory', '.dreams'), { recursive: true });
    fs.writeFileSync(path.join(bareWs, 'USER.md'), '# User\n- Bare workspace user pref\n', 'utf8');
    fs.writeFileSync(
      path.join(bareWs, 'MEMORY.md'),
      '# Memories\n- Bare global pref\n- Alpha repo rule <!-- project: github.com/acme/alpha -->\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(bareWs, 'memory', 'topics', 'sub', 'architecture.md'),
      '# Architecture\n- Nested markdown memory note\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(bareWs, 'memory', '.dreams', 'ignored-dream.md'),
      'Dream note inside memory/.dreams\n',
      'utf8',
    );

    const result = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.summary.workspacesMigrated).toBe(1);

    const migratedMain = path.join(userDataDir, WORKSPACES_DIR_NAME, 'main');
    expect(fs.readFileSync(path.join(migratedMain, 'USER.md'), 'utf8')).toContain('Bare workspace user pref');
    expect(fs.readFileSync(path.join(migratedMain, 'MEMORY.md'), 'utf8')).toContain('<!-- project: github.com/acme/alpha -->');
    expect(
      fs.readFileSync(path.join(migratedMain, 'memory', 'topics', 'sub', 'architecture.md'), 'utf8'),
    ).toContain('Nested markdown memory note');
    expect(fs.existsSync(path.join(migratedMain, 'memory', '.dreams'))).toBe(false);
    expect(result.report?.archivedModules.some((m) => m.category === 'dreaming_embedding')).toBe(true);

    // Verify FTS5 index populated during migration finds nested markdown & USER.md while respecting project tags.
    const memSvc = new LobsterMemoryService(path.join(userDataDir, WORKSPACES_DIR_NAME));
    try {
      expect(memSvc.search('main', 'Nested markdown memory note')).toHaveLength(1);
      expect(memSvc.search('main', 'Bare workspace user pref')).toHaveLength(1);
      expect(memSvc.search('main', 'Alpha repo rule')).toHaveLength(0);
    } finally {
      memSvc.close();
    }
  });

  test('prefers workspace-main over bare workspace/ when both exist', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);');
    db.close();

    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    fs.mkdirSync(path.join(stateDir, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'workspace-main'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workspace', 'MEMORY.md'), '- Old bare workspace\n', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'workspace-main', 'MEMORY.md'), '- Canonical workspace-main\n', 'utf8');

    const result = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(result.status).toBe(MigrationV2Status.Completed);
    const migratedMem = fs.readFileSync(
      path.join(userDataDir, WORKSPACES_DIR_NAME, 'main', 'MEMORY.md'),
      'utf8',
    );
    expect(migratedMem).toContain('Canonical workspace-main');
    expect(migratedMem).not.toContain('Old bare workspace');
  });

  test('migrates ALL (>200) active SQLite user_memories without cap, excludes deleted/stale, and preserves user_memory_sources', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE user_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE user_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        role TEXT NOT NULL DEFAULT 'system',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);

    const insertMem = db.prepare(
      'INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    );
    const insertSrc = db.prepare(
      'INSERT INTO user_memory_sources VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    // 230 active SQLite memories (exceeding the legacy 200-row cap), where #1 duplicates MEMORY.md
    for (let i = 1; i <= 230; i += 1) {
      const text = i === 1 ? 'Already exists in MEMORY.md' : `Legacy active SQLite memory #${i}`;
      insertMem.run(`m-${i}`, text, memoryFingerprint(text), 0.9, i % 2, 'created', 1000 + i, 2000 + i);
      insertSrc.run(`s-${i}`, `m-${i}`, `sess-${i}`, `msg-${i}`, 'user', 1, 1000 + i);
    }

    // Deleted and stale rows that MUST NOT be resurrected into MEMORY.md
    insertMem.run(
      'm-del-1',
      'Deleted secret memory must stay deleted',
      memoryFingerprint('Deleted secret memory must stay deleted'),
      0.8,
      1,
      'deleted',
      500,
      600,
    );
    insertSrc.run('s-del-1', 'm-del-1', 'sess-del', 'msg-del', 'user', 0, 500);

    insertMem.run(
      'm-stale-1',
      'Stale implicit memory must not be resurrected',
      memoryFingerprint('Stale implicit memory must not be resurrected'),
      0.6,
      0,
      'stale',
      501,
      601,
    );
    insertSrc.run('s-stale-1', 'm-stale-1', 'sess-stale', 'msg-stale', 'assistant', 0, 501);
    db.close();

    // Seed legacy workspace-main/MEMORY.md with 1 overlapping entry + 1 file-only entry
    const wsMain = path.join(userDataDir, 'openclaw', 'state', 'workspace-main');
    fs.mkdirSync(wsMain, { recursive: true });
    fs.writeFileSync(
      path.join(wsMain, 'MEMORY.md'),
      '# User Memories\n\n- Already exists in MEMORY.md\n- File only memory entry\n',
      'utf8',
    );

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    // 230 active rows minus 1 duplicate already in MEMORY.md = 229 newly imported
    expect(result.report?.summary.userMemoriesMigrated).toBe(229);

    const memService = new LobsterMemoryService(path.join(userDataDir, WORKSPACES_DIR_NAME));
    try {
      const migratedEntries = memService.listMemories('main');
      // 2 original MEMORY.md entries + 229 SQLite-only active entries = 231 total
      expect(migratedEntries).toHaveLength(231);
      expect(migratedEntries.some((e) => e.text === 'Legacy active SQLite memory #230')).toBe(true);
      expect(migratedEntries.some((e) => e.text === 'Deleted secret memory must stay deleted')).toBe(false);
      expect(migratedEntries.some((e) => e.text === 'Stale implicit memory must not be resurrected')).toBe(false);
      // FTS5 index is immediately searchable for migrated SQLite memories
      expect(memService.search('main', 'Legacy active SQLite memory #230')).toHaveLength(1);
    } finally {
      memService.close();
    }

    // Verify user_memories and user_memory_sources rows remain intact in SQLite
    const verifyDb = new Database(sqlitePath);
    const memCount = verifyDb.prepare('SELECT COUNT(*) AS cnt FROM user_memories').get() as { cnt: number };
    const srcCount = verifyDb.prepare('SELECT COUNT(*) AS cnt FROM user_memory_sources').get() as { cnt: number };
    const kvRow = verifyDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY) as { value?: string } | undefined;
    expect(memCount.cnt).toBe(232);
    expect(srcCount.cnt).toBe(232);
    expect(kvRow?.value).toBeTruthy();
    verifyDb.close();
  });

  test('backfillLegacyUserMemories recovers SQLite-only memories idempotently for already-migrated v2 DBs', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const workspacesDir = path.join(userDataDir, WORKSPACES_DIR_NAME);
    const backupDir = path.join(userDataDir, LEGACY_OPENCLAW_BACKUP_DIR_NAME, '2026-11-20T01-00-00-000Z');
    fs.mkdirSync(backupDir, { recursive: true });

    // Pre-existing v2 workspaces/main/MEMORY.md has only first 5 entries
    const preMem = new LobsterMemoryService(workspacesDir);
    for (let i = 1; i <= 5; i += 1) {
      preMem.addMemory('main', `Recovered active memory #${i}`);
    }
    preMem.close();

    // Seed an already-migrated v2 DB where engine.migration.v2.completed is set,
    // but engine.migration.v2.userMemoriesMigrated is NOT set yet.
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE user_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE user_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
    const initialReport = {
      version: 2,
      migratedAt: '2026-11-20T01:00:00.000Z',
      backupDir,
      incompatibleArchivePath: path.join(backupDir, 'incompatible-modules-backup.tar.gz'),
      legacyStateArchivePath: null,
      sqliteSnapshotPath: path.join(backupDir, 'lobsterai.pre-v2.sqlite'),
      dismissed: true,
      summary: {
        workspacesMigrated: 1,
        scheduledTasksMigrated: 0,
        imAllowListsMigrated: 0,
        sessionsPreservedForLazyBridge: 0,
        mcpLaunchCachesCleared: 0,
        disposableBytesFreed: 0,
      },
      archivedModules: [],
      reauthRequired: [],
    };
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: initialReport.migratedAt, backupDir }),
      1,
    );
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_REPORT_KV_KEY,
      JSON.stringify(initialReport),
      1,
    );

    const insertMem = db.prepare(
      'INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    );
    const insertSrc = db.prepare(
      'INSERT INTO user_memory_sources VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 1; i <= 215; i += 1) {
      const text = `Recovered active memory #${i}`;
      insertMem.run(`um-${i}`, text, memoryFingerprint(text), 0.85, 1, 'created', 100 + i, 200 + i);
      insertSrc.run(`us-${i}`, `um-${i}`, `session-${i}`, `message-${i}`, 'user', 1, 100 + i);
    }
    insertMem.run(
      'um-del',
      'Historical deleted memory',
      memoryFingerprint('Historical deleted memory'),
      0.8,
      1,
      'deleted',
      50,
      60,
    );
    insertMem.run(
      'um-stale',
      'Historical stale memory',
      memoryFingerprint('Historical stale memory'),
      0.7,
      0,
      'stale',
      51,
      61,
    );

    // First backfill imports 210 missing active rows (215 - 5 existing)
    const first = backfillLegacyUserMemories({
      userDataDir,
      db,
      now: () => new Date('2026-11-21T02:00:00.000Z'),
    });
    expect(first).toEqual({
      status: 'completed',
      memoriesImported: 210,
    });

    const memService = new LobsterMemoryService(workspacesDir);
    try {
      const entries = memService.listMemories('main');
      expect(entries).toHaveLength(215);
      expect(entries.some((e) => e.text === 'Recovered active memory #215')).toBe(true);
      expect(entries.some((e) => e.text === 'Historical deleted memory')).toBe(false);
      expect(entries.some((e) => e.text === 'Historical stale memory')).toBe(false);
    } finally {
      memService.close();
    }

    // Updated report written to disk & kv
    const updatedReport = JSON.parse(
      fs.readFileSync(path.join(backupDir, 'migration-report.json'), 'utf8'),
    ) as { summary: { userMemoriesMigrated?: number } };
    expect(updatedReport.summary.userMemoriesMigrated).toBe(210);

    // Sources and rows stay intact in SQLite
    const srcCount = db.prepare('SELECT COUNT(*) AS cnt FROM user_memory_sources').get() as { cnt: number };
    expect(srcCount.cnt).toBe(215);

    // Second run is a fast idempotent no-op
    const second = backfillLegacyUserMemories({ userDataDir, db });
    expect(second).toEqual({
      status: 'skipped',
      memoriesImported: 0,
    });
    db.close();
  });

  test('runLegacyOpenClawMigration automatically backfills legacy user_memories on already-migrated v2 DBs', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE user_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-20T01:00:00.000Z' }),
      1,
    );
    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'um-auto-1',
      'Recovered automatically on startup',
      memoryFingerprint('Recovered automatically on startup'),
      0.9,
      1,
      'created',
      100,
      100,
    );
    db.prepare('INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'um-auto-del',
      'Deleted entry stays excluded',
      memoryFingerprint('Deleted entry stays excluded'),
      0.9,
      1,
      'deleted',
      101,
      101,
    );
    db.close();

    const result = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(result.status).toBe(MigrationV2Status.Skipped);

    const memService = new LobsterMemoryService(path.join(userDataDir, WORKSPACES_DIR_NAME));
    try {
      const entries = memService.listMemories('main');
      expect(entries.map((e) => e.text)).toEqual(['Recovered automatically on startup']);
      expect(memService.search('main', 'Recovered automatically')).toHaveLength(1);
    } finally {
      memService.close();
    }
  });

  test('migrates DREAMS.md and dreams.md normalized to DREAMS.md and archives memory/.dreams/', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.close();

    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    const wsMain = path.join(stateDir, 'workspace-main');
    const wsAgent1 = path.join(stateDir, 'workspace-agent1');
    fs.mkdirSync(path.join(wsMain, 'memory', '.dreams'), { recursive: true });
    fs.mkdirSync(wsAgent1, { recursive: true });

    const mainDiary = [
      '# Dream Diary',
      '',
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 14, 2026 at 3:00 AM GMT+8*',
      'Main agent historical dream entry.',
      '<!-- openclaw:dreaming:diary:end -->',
      '',
    ].join('\n');
    const agent1Diary = [
      '# Dream Diary',
      '',
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 12, 2026 at 3:00 AM GMT+8*',
      'Agent1 lowercase dreams.md entry.',
      '<!-- openclaw:dreaming:diary:end -->',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(wsMain, 'DREAMS.md'), mainDiary, 'utf8');
    fs.writeFileSync(path.join(wsMain, 'memory', '.dreams', 'short-term-recall.json'), '{"entries":[]}\n');
    fs.writeFileSync(path.join(wsMain, 'memory', '.dreams', 'phase-signals.json'), '{"signals":[]}\n');
    fs.writeFileSync(path.join(wsAgent1, 'dreams.md'), agent1Diary, 'utf8');

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    const report = result.report!;

    // Verify both DREAMS.md and lowercase dreams.md are copied and normalized to DREAMS.md.
    const migratedMainDreams = path.join(userDataDir, WORKSPACES_DIR_NAME, 'main', 'DREAMS.md');
    const migratedAgent1Dreams = path.join(userDataDir, WORKSPACES_DIR_NAME, 'agent1', 'DREAMS.md');
    expect(fs.readFileSync(migratedMainDreams, 'utf8')).toBe(mainDiary);
    expect(fs.readFileSync(migratedAgent1Dreams, 'utf8')).toBe(agent1Diary);
    expect(fs.readdirSync(path.join(userDataDir, WORKSPACES_DIR_NAME, 'agent1'))).toContain('DREAMS.md');

    // Verify memory/.dreams/ was archived into incompatible-modules-backup.tar.gz and NOT copied.
    expect(fs.existsSync(path.join(userDataDir, WORKSPACES_DIR_NAME, 'main', 'memory', '.dreams'))).toBe(false);
    const dreamingArchiveItem = report.archivedModules.find((m) => m.category === 'dreaming_embedding');
    expect(dreamingArchiveItem?.count).toBe(2);

    const inspectDir = createTempDir();
    const extractedDreamState = await extractMatchingEntriesFromTarGz(
      report.incompatibleArchivePath,
      inspectDir,
      (archivePath) => archivePath.startsWith('dreams/'),
    );
    expect(extractedDreamState.sort()).toEqual([
      'dreams/main/memory/.dreams/phase-signals.json',
      'dreams/main/memory/.dreams/short-term-recall.json',
    ]);

    // Verify dream diary backfill KV marker is stamped so already-migrated DB won't rescan archive.
    const verifyDb = new Database(sqlitePath);
    const kvRow = verifyDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY) as { value?: string } | undefined;
    expect(kvRow?.value).toBeTruthy();
    expect(JSON.parse(kvRow!.value!).diariesRestored).toBe(2);
    verifyDb.close();
  });

  test('backfillLegacyDreamDiariesFromBackup restores DREAMS.md from legacy-openclaw-state.tar.gz idempotently', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    // Build a legacy OpenClaw state archive mimicking an earlier v2 migration backup.
    const stagingStateDir = path.join(createTempDir(), 'openclaw-state');
    fs.mkdirSync(path.join(stagingStateDir, 'workspace-main'), { recursive: true });
    fs.mkdirSync(path.join(stagingStateDir, 'workspace-agent1'), { recursive: true });
    fs.mkdirSync(path.join(stagingStateDir, 'workspace-existing'), { recursive: true });
    fs.mkdirSync(path.join(stagingStateDir, 'workspace'), { recursive: true });

    const mainDiary = [
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 15, 2026 at 3:00 AM GMT+8*',
      'Restored from legacy state archive.',
      '<!-- openclaw:dreaming:diary:end -->',
    ].join('\n');
    const bareWorkspaceDiary = 'Bare workspace fallback (should lose to workspace-main).\n';
    const agent1Diary = [
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 11, 2026 at 3:00 AM GMT+8*',
      'Agent1 restored lowercase dreams.md.',
      '<!-- openclaw:dreaming:diary:end -->',
    ].join('\n');

    fs.writeFileSync(path.join(stagingStateDir, 'workspace-main', 'DREAMS.md'), mainDiary, 'utf8');
    fs.writeFileSync(path.join(stagingStateDir, 'workspace', 'DREAMS.md'), bareWorkspaceDiary, 'utf8');
    fs.writeFileSync(path.join(stagingStateDir, 'workspace-agent1', 'dreams.md'), agent1Diary, 'utf8');
    fs.writeFileSync(path.join(stagingStateDir, 'workspace-existing', 'DREAMS.md'), 'Old backup copy', 'utf8');

    // Pre-populate workspace-existing/DREAMS.md so we verify backfill does not overwrite it.
    const existingDir = path.join(userDataDir, WORKSPACES_DIR_NAME, 'existing');
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'DREAMS.md'), 'Already present diary', 'utf8');

    const backupDir = path.join(
      userDataDir,
      LEGACY_OPENCLAW_BACKUP_DIR_NAME,
      '2026-11-20T00-57-39-889Z',
    );
    fs.mkdirSync(backupDir, { recursive: true });
    const archivePath = path.join(backupDir, 'legacy-openclaw-state.tar.gz');
    writeTarGzArchive(
      archivePath,
      collectDirectoryTarEntries(stagingStateDir, 'openclaw-state'),
    );

    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-20T00:57:39.889Z', backupDir }),
      1,
    );
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_REPORT_KV_KEY,
      JSON.stringify({
        version: 2,
        migratedAt: '2026-11-20T00:57:39.889Z',
        backupDir,
        incompatibleArchivePath: path.join(backupDir, 'incompatible-modules-backup.tar.gz'),
        legacyStateArchivePath: archivePath,
        sqliteSnapshotPath: path.join(backupDir, 'lobsterai.pre-v2.sqlite'),
        dismissed: true,
        summary: {
          workspacesMigrated: 2,
          scheduledTasksMigrated: 0,
          imAllowListsMigrated: 0,
          sessionsPreservedForLazyBridge: 0,
          mcpLaunchCachesCleared: 0,
          disposableBytesFreed: 0,
        },
        archivedModules: [],
        reauthRequired: [],
      }),
      1,
    );

    const first = await backfillLegacyDreamDiariesFromBackup({
      userDataDir,
      db,
      now: () => new Date('2026-11-21T01:00:00.000Z'),
    });
    expect(first).toEqual({
      status: 'completed',
      diariesRestored: 2,
    });

    const workspacesDir = path.join(userDataDir, WORKSPACES_DIR_NAME);
    expect(fs.readFileSync(path.join(workspacesDir, 'main', 'DREAMS.md'), 'utf8')).toBe(mainDiary);
    expect(fs.readFileSync(path.join(workspacesDir, 'agent1', 'DREAMS.md'), 'utf8')).toBe(agent1Diary);
    expect(fs.readdirSync(path.join(workspacesDir, 'agent1'))).toContain('DREAMS.md');
    expect(fs.readFileSync(path.join(workspacesDir, 'existing', 'DREAMS.md'), 'utf8')).toBe(
      'Already present diary',
    );

    // Second run must be an idempotent no-op.
    const second = await backfillLegacyDreamDiariesFromBackup({ userDataDir, db });
    expect(second).toEqual({
      status: 'skipped',
      diariesRestored: 0,
    });
    db.close();
  });

  test('backfillLegacyDreamDiariesFromBackup falls back to bare workspace/DREAMS.md and skips fresh installs', async () => {
    // 1. Bare workspace/DREAMS.md without workspace-main
    const upgradedDir = createTempDir();
    const upgradedDb = new Database(path.join(upgradedDir, 'lobsterai.sqlite'));
    upgradedDb.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    const staging = path.join(createTempDir(), 'openclaw-state');
    fs.mkdirSync(path.join(staging, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'workspace', 'DREAMS.md'), 'Bare workspace diary\n', 'utf8');
    const backupDir = path.join(upgradedDir, LEGACY_OPENCLAW_BACKUP_DIR_NAME, '2026-11-20T01-00-00-000Z');
    fs.mkdirSync(backupDir, { recursive: true });
    writeTarGzArchive(
      path.join(backupDir, 'legacy-openclaw-state.tar.gz'),
      collectDirectoryTarEntries(staging, 'openclaw-state'),
    );
    upgradedDb.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-20T01:00:00.000Z', backupDir }),
      1,
    );

    const restored = await backfillLegacyDreamDiariesFromBackup({
      userDataDir: upgradedDir,
      db: upgradedDb,
    });
    expect(restored).toEqual({ status: 'completed', diariesRestored: 1 });
    expect(
      fs.readFileSync(path.join(upgradedDir, WORKSPACES_DIR_NAME, 'main', 'DREAMS.md'), 'utf8'),
    ).toBe('Bare workspace diary\n');
    upgradedDb.close();

    // 2. Fresh install must skip immediately without creating workspaces.
    const freshDir = createTempDir();
    const freshDb = new Database(path.join(freshDir, 'lobsterai.sqlite'));
    freshDb.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    freshDb.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-20T01:00:00.000Z', freshInstall: true }),
      1,
    );
    const freshResult = await backfillLegacyDreamDiariesFromBackup({
      userDataDir: freshDir,
      db: freshDb,
    });
    expect(freshResult).toEqual({ status: 'skipped', diariesRestored: 0 });
    expect(fs.existsSync(path.join(freshDir, WORKSPACES_DIR_NAME))).toBe(false);
    freshDb.close();
  });

  test('migrates custom skills from openclaw/state/skills and workspace-*/skills without overwriting existing SKILLs or wiping SQLite skill bindings', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE agents (id TEXT PRIMARY KEY, skill_ids TEXT);
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      'skills_state',
      JSON.stringify({ docx: false, 'custom-report': true }),
      1,
    );
    db.prepare('INSERT INTO agents VALUES (?, ?)').run('expert-a', JSON.stringify(['custom-report']));
    db.close();

    // Seed pre-existing skill in <userData>/SKILLs that must NOT be overwritten.
    const userSkillsDir = path.join(userDataDir, 'SKILLs');
    fs.mkdirSync(path.join(userSkillsDir, 'already-here'), { recursive: true });
    fs.writeFileSync(
      path.join(userSkillsDir, 'already-here', 'SKILL.md'),
      '---\nname: already-here\ndescription: New version in userData\n---\nKeep me.\n',
      'utf8',
    );

    // Seed legacy skills in openclaw/state/skills and workspace-*/skills.
    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    const legacyShared = path.join(stateDir, 'skills', 'legacy-shared');
    const legacyConflict = path.join(stateDir, 'skills', 'already-here');
    const legacyNotSkill = path.join(stateDir, 'skills', 'not-a-skill');
    const legacyMainSkill = path.join(stateDir, 'workspace-main', 'skills', 'legacy-main-skill');
    const legacyExpertSkill = path.join(stateDir, 'workspace-expert-a', 'skills', 'legacy-expert-skill');

    for (const dir of [legacyShared, legacyConflict, legacyNotSkill, legacyMainSkill, legacyExpertSkill]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.mkdirSync(path.join(legacyShared, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(legacyShared, 'SKILL.md'),
      '---\nname: 共享旧技能\ndescription: Legacy shared skill\n---\nBody\n',
      'utf8',
    );
    fs.writeFileSync(path.join(legacyShared, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', 'utf8');
    fs.writeFileSync(
      path.join(legacyConflict, 'SKILL.md'),
      '---\nname: already-here\ndescription: Stale openclaw copy\n---\nOverwrite attempt.\n',
      'utf8',
    );
    fs.writeFileSync(path.join(legacyNotSkill, 'README.md'), 'No SKILL.md here', 'utf8');
    fs.writeFileSync(
      path.join(legacyMainSkill, 'SKILL.md'),
      '---\nname: legacy-main-skill\ndescription: Main workspace skill\n---\nMain\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(legacyExpertSkill, 'SKILL.md'),
      '---\nname: legacy-expert-skill\ndescription: Expert workspace skill\n---\nExpert\n',
      'utf8',
    );

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.summary.skillsMigrated).toBe(3);

    // Legacy OpenClaw state is preserved in place after migration.
    expect(fs.existsSync(path.join(userDataDir, 'openclaw', 'state'))).toBe(true);

    // All three legacy skills + nested scripts landed in <userData>/SKILLs/.
    expect(fs.readFileSync(path.join(userSkillsDir, 'legacy-shared', 'SKILL.md'), 'utf8')).toContain('共享旧技能');
    expect(fs.readFileSync(path.join(userSkillsDir, 'legacy-shared', 'scripts', 'run.sh'), 'utf8')).toContain('echo ok');
    expect(fs.existsSync(path.join(userSkillsDir, 'legacy-main-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(userSkillsDir, 'legacy-expert-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(userSkillsDir, 'not-a-skill'))).toBe(false);

    // Existing skill in <userData>/SKILLs/ was NOT overwritten.
    expect(fs.readFileSync(path.join(userSkillsDir, 'already-here', 'SKILL.md'), 'utf8')).toContain('Keep me.');

    // SQLite skills_state and agents.skill_ids survived intact.
    const verifyDb = new Database(sqlitePath, { readonly: true });
    const skillsStateRow = verifyDb.prepare('SELECT value FROM kv WHERE key = ?').get('skills_state') as { value: string };
    expect(JSON.parse(skillsStateRow.value)).toEqual({ docx: false, 'custom-report': true });
    const agentRow = verifyDb.prepare('SELECT skill_ids FROM agents WHERE id = ?').get('expert-a') as { skill_ids: string };
    expect(JSON.parse(agentRow.skill_ids)).toEqual(['custom-report']);
    verifyDb.close();
  });

  test('retires im_config.email while preserving SKILLs/imap-smtp-email/accounts.json, .env, and skills_state', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    const originalSkillsState = JSON.stringify({
      'imap-smtp-email': { enabled: true },
      weather: { enabled: false },
    });
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('skills_state', originalSkillsState, 1);
    db.prepare('INSERT INTO im_config VALUES (?, ?, ?)').run(
      'email',
      JSON.stringify({ enabled: true, imapHost: 'imap.example.com' }),
      1,
    );
    db.prepare('INSERT INTO im_config VALUES (?, ?, ?)').run(
      'feishu',
      JSON.stringify({ enabled: true, appId: 'cli_keep' }),
      1,
    );
    db.close();

    // Seed legacy OpenClaw state so v2 migration runs.
    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    fs.mkdirSync(path.join(stateDir, 'workspace-main'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workspace-main', 'SOUL.md'), 'Legacy persona\n');

    // Seed user-configured Email Skill files under <userData>/SKILLs/imap-smtp-email/.
    const emailSkillDir = path.join(userDataDir, 'SKILLs', 'imap-smtp-email');
    fs.mkdirSync(emailSkillDir, { recursive: true });
    const accountsJsonContent = JSON.stringify({
      version: 1,
      defaultAccountId: 'migrated-work',
      accounts: [
        {
          id: 'migrated-work',
          name: 'Work Mailbox',
          enabled: true,
          email: 'alice@example.com',
          password: 'app-password-xyz',
          imapHost: 'imap.example.com',
          imapPort: 993,
          smtpHost: 'smtp.example.com',
          smtpPort: 465,
          smtpSecure: true,
        },
      ],
    }, null, 2) + '\n';
    const dotEnvContent = 'IMAP_USER=legacy@example.com\nIMAP_PASS=legacy-pw\n';
    fs.writeFileSync(path.join(emailSkillDir, 'accounts.json'), accountsJsonContent, 'utf8');
    fs.writeFileSync(path.join(emailSkillDir, '.env'), dotEnvContent, 'utf8');

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.archivedModules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'retired_im', count: 1 }),
      ]),
    );

    // Email Skill files must remain completely untouched on disk.
    expect(fs.readFileSync(path.join(emailSkillDir, 'accounts.json'), 'utf8')).toBe(accountsJsonContent);
    expect(fs.readFileSync(path.join(emailSkillDir, '.env'), 'utf8')).toBe(dotEnvContent);

    // kv['skills_state']['imap-smtp-email'] must remain completely intact.
    const verifyDb = new Database(sqlitePath);
    const kvRow = verifyDb.prepare('SELECT value FROM kv WHERE key = ?').get('skills_state') as
      | { value?: string }
      | undefined;
    verifyDb.close();
    expect(kvRow?.value).toBe(originalSkillsState);
    expect(JSON.parse(kvRow!.value!)['imap-smtp-email']).toEqual({ enabled: true });
  });

  test('migrates legacy enabled & disabled Tavily plugin config from user_plugins and openclaw.json without duplicating existing Tavily MCP', () => {
    // 1. Pure extractor handles user_plugins, openclaw.user.json, and openclaw.json tools.web.search.
    expect(extractLegacyTavilyConfig({
      userPlugins: [
        {
          plugin_id: 'tavily-search',
          spec: '@openclaw/tavily-search',
          enabled: 0,
          config: JSON.stringify({ apiKey: 'tvly-disabled-key' }),
        },
      ],
    })).toEqual({
      apiKey: 'tvly-disabled-key',
      enabled: false,
      source: LegacyTavilySource.UserPlugins,
    });

    expect(extractLegacyTavilyConfig({
      openclawConfig: {
        env: { TAVILY_API_KEY: 'tvly-env-resolved' },
        tools: {
          web: {
            search: {
              enabled: true,
              provider: 'tavily',
              apiKey: '${TAVILY_API_KEY}',
            },
          },
        },
      },
    })).toEqual({
      apiKey: 'tvly-env-resolved',
      enabled: true,
      source: LegacyTavilySource.OpenClawJson,
    });

    // 2. Full v2 migration from user_plugins (enabled = 1).
    const userData1 = createTempDir();
    const sqlite1 = path.join(userData1, 'lobsterai.sqlite');
    const db1 = new Database(sqlite1);
    db1.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE user_plugins (plugin_id TEXT PRIMARY KEY, source TEXT, spec TEXT, enabled INTEGER, config TEXT);
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db1.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db1.prepare('INSERT INTO user_plugins VALUES (?, ?, ?, ?, ?)').run(
      'tavily',
      'npm',
      '@openclaw/tavily',
      1,
      JSON.stringify({ apiKey: 'tvly-user-plugin-123' }),
    );
    db1.close();
    fs.mkdirSync(path.join(userData1, 'openclaw', 'state'), { recursive: true });

    const res1 = runLegacyOpenClawMigration({ userDataDir: userData1, sqlitePath: sqlite1 });
    expect(res1.status).toBe(MigrationV2Status.Completed);
    expect(res1.report?.summary.tavilyMcpMigrated).toBe(1);

    const verify1 = new Database(sqlite1, { readonly: true });
    const row1 = verify1.prepare('SELECT name, enabled, transport_type, config_json FROM mcp_servers').get() as {
      name: string;
      enabled: number;
      transport_type: string;
      config_json: string;
    };
    verify1.close();
    expect(row1.name).toBe('Tavily');
    expect(row1.enabled).toBe(1);
    expect(row1.transport_type).toBe('stdio');
    expect(JSON.parse(row1.config_json)).toEqual({
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env: { TAVILY_API_KEY: 'tvly-user-plugin-123' },
      registryId: 'tavily',
    });

    // 3. Full v2 migration from openclaw.json with disabled Tavily preserves enabled = 0.
    const userData2 = createTempDir();
    const sqlite2 = path.join(userData2, 'lobsterai.sqlite');
    const db2 = new Database(sqlite2);
    db2.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db2.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db2.close();
    const state2 = path.join(userData2, 'openclaw', 'state');
    fs.mkdirSync(state2, { recursive: true });
    fs.writeFileSync(
      path.join(state2, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          entries: {
            'tavily-search': {
              enabled: false,
              config: { apiKey: 'tvly-disabled-from-json' },
            },
          },
        },
      }),
      'utf8',
    );

    const res2 = runLegacyOpenClawMigration({ userDataDir: userData2, sqlitePath: sqlite2 });
    expect(res2.status).toBe(MigrationV2Status.Completed);
    const verify2 = new Database(sqlite2, { readonly: true });
    const row2 = verify2.prepare('SELECT name, enabled, config_json FROM mcp_servers').get() as {
      name: string;
      enabled: number;
      config_json: string;
    };
    verify2.close();
    expect(row2.name).toBe('Tavily');
    expect(row2.enabled).toBe(0);
    expect(JSON.parse(row2.config_json).env).toEqual({ TAVILY_API_KEY: 'tvly-disabled-from-json' });

    // 4. Existing Tavily MCP server in mcp_servers is preserved untouched (no duplicate).
    const userData3 = createTempDir();
    const sqlite3 = path.join(userData3, 'lobsterai.sqlite');
    const db3 = new Database(sqlite3);
    db3.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE user_plugins (plugin_id TEXT PRIMARY KEY, source TEXT, spec TEXT, enabled INTEGER, config TEXT);
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db3.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db3.prepare('INSERT INTO user_plugins VALUES (?, ?, ?, ?, ?)').run(
      'tavily',
      'npm',
      'tavily-plugin',
      1,
      JSON.stringify({ apiKey: 'tvly-plugin-old' }),
    );
    db3.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'existing-tavily-id',
      'My Custom Tavily',
      'Custom',
      0,
      'stdio',
      JSON.stringify({ command: 'npx', args: ['-y', 'tavily-mcp@latest'], env: { TAVILY_API_KEY: 'tvly-keep-me' } }),
      100,
      100,
    );
    db3.close();
    fs.mkdirSync(path.join(userData3, 'openclaw', 'state'), { recursive: true });

    const res3 = runLegacyOpenClawMigration({ userDataDir: userData3, sqlitePath: sqlite3 });
    expect(res3.status).toBe(MigrationV2Status.Completed);
    expect(res3.report?.summary.tavilyMcpMigrated).toBe(0);

    const verify3 = new Database(sqlite3, { readonly: true });
    const rows3 = verify3.prepare('SELECT id, name, enabled, config_json FROM mcp_servers').all() as Array<{
      id: string;
      name: string;
      enabled: number;
      config_json: string;
    }>;
    verify3.close();
    expect(rows3).toHaveLength(1);
    expect(rows3[0]).toMatchObject({ id: 'existing-tavily-id', name: 'My Custom Tavily', enabled: 0 });
    expect(JSON.parse(rows3[0].config_json).env).toEqual({ TAVILY_API_KEY: 'tvly-keep-me' });
  });

  test('backfillLegacyTavilyFromBackup restores Tavily MCP from archived incompatible-modules backup idempotently', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const backupDir = path.join(userDataDir, LEGACY_OPENCLAW_BACKUP_DIR_NAME, '2026-11-20T05-00-00Z');
    fs.mkdirSync(backupDir, { recursive: true });

    const archivePath = path.join(backupDir, 'incompatible-modules-backup.tar.gz');
    writeTarGzArchive(archivePath, [
      {
        archivePath: 'openclaw-config/openclaw.user.json',
        content: Buffer.from(
          JSON.stringify({
            tools: {
              web: {
                search: {
                  provider: 'tavily',
                  enabled: true,
                  apiKey: 'tvly-backfill-secret',
                },
              },
            },
          }),
          'utf8',
        ),
      },
    ]);

    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-20T05:00:00.000Z', backupDir }),
      1,
    );

    const first = await backfillLegacyTavilyFromBackup({ userDataDir, db });
    expect(first).toEqual({ status: 'completed', migrated: true });

    const row = db.prepare('SELECT name, enabled, config_json FROM mcp_servers').get() as {
      name: string;
      enabled: number;
      config_json: string;
    };
    expect(row.name).toBe('Tavily');
    expect(row.enabled).toBe(1);
    expect(JSON.parse(row.config_json).env).toEqual({ TAVILY_API_KEY: 'tvly-backfill-secret' });

    const second = await backfillLegacyTavilyFromBackup({ userDataDir, db });
    expect(second).toEqual({ status: 'skipped', migrated: false });
    db.close();
  });

  test('relocates cached openclaw/mcp-packages to <userData>/mcp-packages and rewrites valid mcp_launch_resolutions rows while clearing broken ones', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const legacyPkgDir = path.join(userDataDir, 'openclaw', 'mcp-packages', 'srv-valid-demo-mcp');
    const legacyBinPath = path.join(legacyPkgDir, 'node_modules', 'demo-mcp', 'bin.js');
    fs.mkdirSync(path.dirname(legacyBinPath), { recursive: true });
    fs.writeFileSync(legacyBinPath, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');
    fs.mkdirSync(path.join(userDataDir, 'openclaw', 'state'), { recursive: true });

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        status TEXT,
        install_dir TEXT,
        command TEXT,
        args_json TEXT
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.prepare('INSERT INTO mcp_launch_resolutions VALUES (?, ?, ?, ?, ?)').run(
      'srv-valid',
      'ready',
      legacyPkgDir,
      process.execPath,
      JSON.stringify([legacyBinPath, '--stdio']),
    );
    db.prepare('INSERT INTO mcp_launch_resolutions VALUES (?, ?, ?, ?, ?)').run(
      'srv-missing-bin',
      'ready',
      path.join(userDataDir, 'openclaw', 'mcp-packages', 'srv-missing'),
      process.execPath,
      JSON.stringify([path.join(userDataDir, 'openclaw', 'mcp-packages', 'srv-missing', 'bin.js')]),
    );
    db.prepare('INSERT INTO mcp_launch_resolutions VALUES (?, ?, ?, ?, ?)').run(
      'srv-legacy-state',
      'ready',
      path.join(userDataDir, 'openclaw', 'state', 'legacy-bin'),
      'node',
      JSON.stringify([path.join(userDataDir, 'openclaw', 'state', 'legacy-bin', 'index.js')]),
    );
    db.close();

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-22T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.summary.mcpLaunchCachesCleared).toBe(2);

    const expectedPkgDir = path.join(userDataDir, 'mcp-packages', 'srv-valid-demo-mcp');
    const expectedBinPath = path.join(expectedPkgDir, 'node_modules', 'demo-mcp', 'bin.js');
    expect(fs.existsSync(expectedBinPath)).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'openclaw', 'mcp-packages'))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'openclaw', 'state'))).toBe(true);

    const verifyDb = new Database(sqlitePath);
    const rows = verifyDb
      .prepare('SELECT server_id, status, install_dir, command, args_json FROM mcp_launch_resolutions')
      .all() as Array<{
      server_id: string;
      status: string;
      install_dir: string;
      command: string;
      args_json: string;
    }>;
    verifyDb.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      server_id: 'srv-valid',
      status: 'ready',
      install_dir: expectedPkgDir,
      command: process.execPath,
      args_json: JSON.stringify([expectedBinPath, '--stdio']),
    });
  });

  test('migrates valid and refreshable legacy OpenClaw mcp_oauth_stores tokens and only marks unmigratable servers for reauth', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const migrationNow = new Date('2026-11-21T00:00:00.000Z');
    const nowMs = migrationNow.getTime();

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT,
        transport_type TEXT,
        config_json TEXT
      );
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);

    const insertServer = db.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?, ?)');
    // 1. Valid active token matched by exact ASCII store_key
    insertServer.run(
      'srv-valid-uuid',
      'Remote Docs',
      'http',
      JSON.stringify({ url: 'https://mcp.docs.example/mcp', auth: 'oauth' }),
    );
    // 2. Expired token WITH refresh_token + token_endpoint (non-ASCII name -> safeServerKey md5!)
    insertServer.run(
      'srv-refreshable-uuid',
      '飞书知识库',
      'http',
      JSON.stringify({ url: 'https://mcp.feishu.example/v1', auth: 'oauth' }),
    );
    // 3. Fallback match by resource URL inside discoveryState when URL changed slightly
    insertServer.run(
      'srv-fallback-uuid',
      'Renamed Linear',
      'http',
      JSON.stringify({ url: 'https://mcp.linear.example/mcp/', auth: 'oauth' }),
    );
    // 4. Expired token WITHOUT refresh_token -> must require reauth
    insertServer.run(
      'srv-expired-uuid',
      'Expired Service',
      'http',
      JSON.stringify({ url: 'https://mcp.expired.example/mcp', auth: 'oauth' }),
    );
    // 5. Explicitly cleared store -> must require reauth
    insertServer.run(
      'srv-cleared-uuid',
      'Cleared Service',
      'http',
      JSON.stringify({ url: 'https://mcp.cleared.example/mcp', auth: 'oauth' }),
    );
    // 6. Non-OAuth server whose headers mention "oauth" -> must NOT be treated as OAuth!
    insertServer.run(
      'srv-static-uuid',
      'Static Header Server',
      'http',
      JSON.stringify({
        url: 'https://mcp.static.example/mcp',
        headers: { 'X-Note': 'not "oauth" mode' },
      }),
    );
    db.close();

    // Seed legacy OpenClaw SQLite `mcp_oauth_stores`.
    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const openclawDb = new Database(path.join(stateDir, 'state', 'openclaw.sqlite'));
    openclawDb.exec(`
      CREATE TABLE mcp_oauth_stores (
        store_key TEXT PRIMARY KEY,
        format_version INTEGER NOT NULL,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insertOAuth = openclawDb.prepare(
      'INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, ?)',
    );

    insertOAuth.run(
      computeLegacyMcpOAuthStoreKey('Remote Docs', 'https://mcp.docs.example/mcp'),
      JSON.stringify({
        tokens: {
          access_token: 'legacy-valid-access',
          refresh_token: 'legacy-valid-refresh',
          token_type: 'Bearer',
          scope: 'mcp:read',
        },
        tokenExpiresAt: nowMs + 3_600_000,
        clientInformation: {
          client_id: 'legacy-client-1',
          client_secret: 'legacy-secret-1',
        },
        discoveryState: {
          authorizationServerUrl: 'https://auth.docs.example',
          authorizationServerMetadata: {
            token_endpoint: 'https://auth.docs.example/token',
          },
          resourceMetadata: {
            resource: 'https://mcp.docs.example/mcp',
          },
        },
      }),
      nowMs - 5000,
    );

    insertOAuth.run(
      computeLegacyMcpOAuthStoreKey('飞书知识库', 'https://mcp.feishu.example/v1'),
      JSON.stringify({
        tokens: {
          access_token: 'expired-but-refreshable',
          refresh_token: 'feishu-refresh-tok',
          token_type: 'Bearer',
        },
        tokenExpiresAt: nowMs - 60_000, // already expired, but refreshable!
        clientInformation: { client_id: 'feishu-dcr-id', client_secret: 'feishu-dcr-sec' },
        discoveryState: {
          authorizationServerUrl: 'https://auth.feishu.example',
          authorizationServerMetadata: {
            token_endpoint: 'https://auth.feishu.example/token',
          },
        },
      }),
      nowMs - 10_000,
    );

    insertOAuth.run(
      computeLegacyMcpOAuthStoreKey('Old Linear Name', 'https://mcp.linear.example/mcp'),
      JSON.stringify({
        tokens: {
          access_token: 'fallback-linear-tok',
          token_type: 'Bearer',
        },
        tokenExpiresAt: nowMs + 7_200_000,
        discoveryState: {
          authorizationServerUrl: 'https://auth.linear.example',
          resourceMetadata: {
            resource: 'https://mcp.linear.example/mcp',
          },
        },
      }),
      nowMs - 2000,
    );

    insertOAuth.run(
      computeLegacyMcpOAuthStoreKey('Expired Service', 'https://mcp.expired.example/mcp'),
      JSON.stringify({
        tokens: {
          access_token: 'dead-token',
          token_type: 'Bearer',
        },
        tokenExpiresAt: nowMs - 10_000, // expired & no refresh_token
      }),
      nowMs - 20_000,
    );

    insertOAuth.run(
      computeLegacyMcpOAuthStoreKey('Cleared Service', 'https://mcp.cleared.example/mcp'),
      JSON.stringify({ credentialState: 'cleared' }),
      nowMs - 1000,
    );
    openclawDb.close();

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => migrationNow,
    });
    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.summary.mcpOAuthTokensMigrated).toBe(3);
    expect(result.report?.reauthRequired).toEqual([
      { kind: 'mcp_oauth', id: 'srv-expired-uuid', label: 'Expired Service' },
      { kind: 'mcp_oauth', id: 'srv-cleared-uuid', label: 'Cleared Service' },
    ]);

    // Verify migrated tokens load cleanly via McpOAuthManager.
    const verifyDb = new Database(sqlitePath);
    const kvPort = {
      get: (k: string) => {
        const row = verifyDb.prepare('SELECT value FROM kv WHERE key = ?').get(k) as
          | { value?: string }
          | undefined;
        return typeof row?.value === 'string' ? row.value : null;
      },
      set: (k: string, v: string) => {
        verifyDb.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(k, v, nowMs);
      },
      delete: (k: string) => {
        verifyDb.prepare('DELETE FROM kv WHERE key = ?').run(k);
      },
    };
    const oauthManager = new McpOAuthManager({ storage: kvPort, now: () => nowMs });

    expect(oauthManager.getToken('srv-valid-uuid')).toMatchObject({
      serverId: 'srv-valid-uuid',
      accessToken: 'legacy-valid-access',
      refreshToken: 'legacy-valid-refresh',
      clientId: 'legacy-client-1',
      clientSecret: 'legacy-secret-1',
      tokenEndpoint: 'https://auth.docs.example/token',
      resource: 'https://mcp.docs.example/mcp',
      scope: 'mcp:read',
    });
    expect(oauthManager.getToken('srv-refreshable-uuid')).toMatchObject({
      serverId: 'srv-refreshable-uuid',
      accessToken: 'expired-but-refreshable',
      refreshToken: 'feishu-refresh-tok',
      clientId: 'feishu-dcr-id',
      clientSecret: 'feishu-dcr-sec',
      tokenEndpoint: 'https://auth.feishu.example/token',
    });
    expect(oauthManager.getToken('srv-fallback-uuid')).toMatchObject({
      serverId: 'srv-fallback-uuid',
      accessToken: 'fallback-linear-tok',
    });
    expect(oauthManager.getToken('srv-expired-uuid')).toBeNull();
    expect(oauthManager.getToken('srv-cleared-uuid')).toBeNull();
    expect(oauthManager.getToken('srv-static-uuid')).toBeNull();
    verifyDb.close();
  });

  test('backfillLegacyMcpOAuthTokensFromBackup restores tokens from legacy-openclaw-state.tar.gz and preserves existing v2 tokens', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const now = new Date('2026-11-21T06:00:00.000Z');
    const nowMs = now.getTime();

    // Build a legacy backup archive containing `openclaw-state/state/openclaw.sqlite`.
    const stagingStateDir = path.join(createTempDir(), 'openclaw-state');
    fs.mkdirSync(path.join(stagingStateDir, 'state'), { recursive: true });
    const legacyDb = new Database(path.join(stagingStateDir, 'state', 'openclaw.sqlite'));
    legacyDb.exec(`
      CREATE TABLE mcp_oauth_stores (
        store_key TEXT PRIMARY KEY,
        format_version INTEGER NOT NULL,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacyDb.prepare(
      'INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, ?)',
    ).run(
      computeLegacyMcpOAuthStoreKey('Notion', 'https://mcp.notion.example/mcp'),
      JSON.stringify({
        tokens: { access_token: 'backfilled-notion-tok', refresh_token: 'backfilled-notion-ref', token_type: 'Bearer' },
        tokenExpiresAt: nowMs + 3_600_000,
        clientInformation: { client_id: 'notion-client' },
        discoveryState: {
          authorizationServerUrl: 'https://auth.notion.example',
          authorizationServerMetadata: { token_endpoint: 'https://auth.notion.example/token' },
        },
      }),
      nowMs - 5000,
    );
    legacyDb.prepare(
      'INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, ?)',
    ).run(
      computeLegacyMcpOAuthStoreKey('AlreadySignedIn', 'https://mcp.existing.example/mcp'),
      JSON.stringify({
        tokens: { access_token: 'stale-legacy-tok', token_type: 'Bearer' },
        tokenExpiresAt: nowMs + 3_600_000,
      }),
      nowMs - 5000,
    );
    legacyDb.close();

    const backupDir = path.join(userDataDir, LEGACY_OPENCLAW_BACKUP_DIR_NAME, '2026-11-20T01-00-00-000Z');
    fs.mkdirSync(backupDir, { recursive: true });
    const archivePath = path.join(backupDir, 'legacy-openclaw-state.tar.gz');
    writeTarGzArchive(archivePath, collectDirectoryTarEntries(stagingStateDir, 'openclaw-state'));

    // Seed an already-migrated v2 SQLite DB where Notion was previously marked for reauth.
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, transport_type TEXT, config_json TEXT);
    `);
    db.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?, ?)').run(
      'srv-notion-uuid',
      'Notion',
      'http',
      JSON.stringify({ url: 'https://mcp.notion.example/mcp', auth: 'oauth' }),
    );
    db.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?, ?)').run(
      'srv-existing-uuid',
      'AlreadySignedIn',
      'http',
      JSON.stringify({ url: 'https://mcp.existing.example/mcp', auth: 'oauth' }),
    );

    // Pre-existing v2 token must NOT be overwritten by backfill!
    const kvPort = {
      get: (k: string) => {
        const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value?: string } | undefined;
        return typeof row?.value === 'string' ? row.value : null;
      },
      set: (k: string, v: string) => {
        db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(k, v, nowMs);
      },
      delete: (k: string) => {
        db.prepare('DELETE FROM kv WHERE key = ?').run(k);
      },
    };
    const oauthManager = new McpOAuthManager({ storage: kvPort, now: () => nowMs });
    oauthManager.saveToken({
      serverId: 'srv-existing-uuid',
      accessToken: 'fresh-v2-token',
      tokenType: 'Bearer',
      updatedAt: nowMs,
    });

    const initialReport = {
      version: 2,
      migratedAt: '2026-11-20T01:00:00.000Z',
      backupDir,
      incompatibleArchivePath: path.join(backupDir, 'incompatible-modules-backup.tar.gz'),
      legacyStateArchivePath: archivePath,
      sqliteSnapshotPath: path.join(backupDir, 'lobsterai.pre-v2.sqlite'),
      dismissed: false,
      summary: {
        workspacesMigrated: 1,
        scheduledTasksMigrated: 0,
        imAllowListsMigrated: 0,
        sessionsPreservedForLazyBridge: 0,
        mcpLaunchCachesCleared: 0,
        disposableBytesFreed: 0,
      },
      archivedModules: [],
      reauthRequired: [{ kind: 'mcp_oauth', id: 'srv-notion-uuid', label: 'Notion' }],
    };
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: initialReport.migratedAt, backupDir }),
      1,
    );
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_REPORT_KV_KEY,
      JSON.stringify(initialReport),
      1,
    );

    const first = await backfillLegacyMcpOAuthTokensFromBackup({
      userDataDir,
      db,
      now: () => now,
    });
    expect(first).toEqual({
      status: 'completed',
      tokensMigrated: 1,
      migratedServerIds: ['srv-notion-uuid'],
    });

    expect(oauthManager.getToken('srv-notion-uuid')?.accessToken).toBe('backfilled-notion-tok');
    expect(oauthManager.getToken('srv-existing-uuid')?.accessToken).toBe('fresh-v2-token');

    const updatedReport = JSON.parse(
      fs.readFileSync(path.join(backupDir, 'migration-report.json'), 'utf8'),
    ) as { dismissed: boolean; reauthRequired: unknown[]; summary: { mcpOAuthTokensMigrated: number } };
    expect(updatedReport.summary.mcpOAuthTokensMigrated).toBe(1);
    expect(updatedReport.reauthRequired).toEqual([]);
    expect(updatedReport.dismissed).toBe(true);

    // Idempotent second run skips immediately.
    const second = await backfillLegacyMcpOAuthTokensFromBackup({ userDataDir, db, now: () => now });
    expect(second).toEqual({
      status: 'skipped',
      tokensMigrated: 0,
      migratedServerIds: [],
    });
    db.close();
  });

  test('preserves external browser mode and connection settings during offline v2 migration', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const browserWebAccess = {
      displayMode: BrowserDisplayMode.External,
      networkMode: BrowserNetworkMode.Strict,
      credentialUseMode: BrowserCredentialUseMode.OncePerTask,
      credentialSaveMode: BrowserCredentialSaveMode.Never,
      blockedHostnames: ['https://blocked.example.com', 'https://ads.example.com'],
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      cdpUrl: 'http://127.0.0.1:9222',
      headless: false,
      attachOnly: true,
      remoteCdpTimeoutMs: 15000,
      remoteCdpHandshakeTimeoutMs: 5000,
      extraArgs: ['--remote-debugging-port=9222'],
    };

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE browser_credentials (id TEXT PRIMARY KEY, origin TEXT NOT NULL, username TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      APP_CONFIG_KEY,
      JSON.stringify({
        theme: 'dark',
        browserDisplayModeMigrationVersion: 1,
        browserWebAccess,
      }),
      1,
    );
    db.prepare('INSERT INTO browser_credentials VALUES (?, ?, ?)').run(
      'cred-1',
      'https://example.com',
      'alice',
    );
    db.close();

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T12:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    const report = result.report!;
    expect(report.archivedModules.map((item) => item.category)).not.toContain('external_chrome');

    const verifyDb = new Database(sqlitePath);
    const rawAppConfig = verifyDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(APP_CONFIG_KEY) as { value: string };
    const migratedAppConfig = JSON.parse(rawAppConfig.value) as Record<string, unknown>;
    expect(migratedAppConfig).toEqual({
      theme: 'dark',
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
      browserWebAccess,
    });

    // Saved browser credentials table must remain untouched.
    const savedCred = verifyDb
      .prepare('SELECT id, origin, username FROM browser_credentials WHERE id = ?')
      .get('cred-1');
    expect(savedCred).toEqual({ id: 'cred-1', origin: 'https://example.com', username: 'alice' });
    verifyDb.close();

    const extractDir = createTempDir();
    const archivedEntries = await extractMatchingEntriesFromTarGz(
      report.incompatibleArchivePath,
      extractDir,
      (entryPath) => entryPath === 'sqlite/external_browser_config.json',
    );
    expect(archivedEntries).toEqual([]);
  });

  test('preserves in-app browser mode during offline v2 migration', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      APP_CONFIG_KEY,
      JSON.stringify({
        browserDisplayModeMigrationVersion: 1,
        browserWebAccess: {
          displayMode: BrowserDisplayMode.InApp,
          networkMode: BrowserNetworkMode.Strict,
          blockedHostnames: ['https://blocked.example.com'],
        },
      }),
      1,
    );
    db.close();

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      now: () => new Date('2026-11-21T12:05:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.archivedModules.map((item) => item.category)).not.toContain('external_chrome');

    const verifyDb = new Database(sqlitePath);
    const rawAppConfig = verifyDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(APP_CONFIG_KEY) as { value: string };
    expect(JSON.parse(rawAppConfig.value)).toEqual({
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.Strict,
        blockedHostnames: ['https://blocked.example.com'],
      },
    });
    verifyDb.close();
  });

  test('preserves external browser mode when backfilling a completed v2 migration', () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');

    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      MIGRATION_V2_COMPLETED_KV_KEY,
      JSON.stringify({ migratedAt: '2026-11-20T00:00:00.000Z' }),
      1,
    );
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(
      APP_CONFIG_KEY,
      JSON.stringify({
        browserDisplayModeMigrationVersion: 2,
        browserWebAccess: {
          displayMode: BrowserDisplayMode.External,
          credentialUseMode: BrowserCredentialUseMode.Disabled,
          credentialSaveMode: BrowserCredentialSaveMode.Never,
          blockedHostnames: ['https://blocked.example.com'],
          cdpUrl: 'http://127.0.0.1:9222',
        },
      }),
      1,
    );
    db.close();

    const result = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(result.status).toBe(MigrationV2Status.Skipped);

    const verifyDb = new Database(sqlitePath);
    const rawAppConfig = verifyDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(APP_CONFIG_KEY) as { value: string };
    expect(JSON.parse(rawAppConfig.value)).toEqual({
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
      browserWebAccess: {
        displayMode: BrowserDisplayMode.External,
        credentialUseMode: BrowserCredentialUseMode.Disabled,
        credentialSaveMode: BrowserCredentialSaveMode.Never,
        blockedHostnames: ['https://blocked.example.com'],
        cdpUrl: 'http://127.0.0.1:9222',
      },
    });
    verifyDb.close();
  });

  test('migrates legacy xAI OAuth credential from auth-profiles.json into auth/xai-oauth.json before deleting openclaw/', () => {
    const tmp = createTempDir();
    const sqlitePath = path.join(tmp, 'lobsterai.sqlite');
    const openclawState = path.join(tmp, 'openclaw', 'state');
    const mainAgentDir = path.join(openclawState, 'agents', 'main', 'agent');
    fs.mkdirSync(mainAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(mainAgentDir, 'auth-profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: {
          'xai:alice@example.com': {
            type: 'oauth',
            provider: 'xai',
            access: 'xai-legacy-access-token',
            refresh: 'xai-legacy-refresh-token',
            email: 'alice@example.com',
            expires: 1_900_000_000_000,
          },
        },
      }),
      'utf8',
    );

    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.close();

    const result = runLegacyOpenClawMigration({
      userDataDir: tmp,
      sqlitePath,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(fs.existsSync(path.join(tmp, 'openclaw', 'state'))).toBe(true);

    const migratedPath = path.join(tmp, 'auth', 'xai-oauth.json');
    expect(fs.existsSync(migratedPath)).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(migratedPath, 'utf8')) as {
      profileId: string;
      credential: { provider: string; type: string; access: string; email?: string };
    };
    expect(migrated.profileId).toBe('xai:alice@example.com');
    expect(migrated.credential).toMatchObject({
      provider: 'xai',
      type: 'oauth',
      access: 'xai-legacy-access-token',
      email: 'alice@example.com',
    });
    expect(result.report?.reauthRequired.some((r) => r.kind === 'xai_oauth')).toBe(false);
  });

  test('migrates legacy xAI OAuth credential from openclaw.sqlite auth_profile_store and flags reauth if unreadable', () => {
    // Part A: valid SQLite auth_profile_store
    const tmpOk = createTempDir();
    const sqliteOk = path.join(tmpOk, 'lobsterai.sqlite');
    const stateOk = path.join(tmpOk, 'openclaw', 'state', 'state');
    fs.mkdirSync(stateOk, { recursive: true });
    const legacyDb = new Database(path.join(stateOk, 'openclaw.sqlite'));
    legacyDb.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL)');
    legacyDb.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run(
      'primary',
      JSON.stringify({
        version: 1,
        profiles: {
          'xai:bob@example.com': {
            type: 'oauth',
            provider: 'xai',
            access: 'xai-sqlite-access-token',
            email: 'bob@example.com',
          },
        },
      }),
    );
    legacyDb.close();
    const dbOk = new Database(sqliteOk);
    dbOk.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    dbOk.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    dbOk.close();

    const resOk = runLegacyOpenClawMigration({ userDataDir: tmpOk, sqlitePath: sqliteOk });
    expect(resOk.status).toBe(MigrationV2Status.Completed);
    const migratedOk = JSON.parse(
      fs.readFileSync(path.join(tmpOk, 'auth', 'xai-oauth.json'), 'utf8'),
    ) as { profileId: string; credential: { access: string } };
    expect(migratedOk.profileId).toBe('xai:bob@example.com');
    expect(migratedOk.credential.access).toBe('xai-sqlite-access-token');

    // Part B: corrupted auth-profiles.json flags xai in reauthRequired
    const tmpBad = createTempDir();
    const sqliteBad = path.join(tmpBad, 'lobsterai.sqlite');
    const badAgentDir = path.join(tmpBad, 'openclaw', 'state', 'agents', 'main', 'agent');
    fs.mkdirSync(badAgentDir, { recursive: true });
    fs.writeFileSync(path.join(badAgentDir, 'auth-profiles.json'), '{not-valid-json', 'utf8');
    const dbBad = new Database(sqliteBad);
    dbBad.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    dbBad.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    dbBad.close();

    const resBad = runLegacyOpenClawMigration({ userDataDir: tmpBad, sqlitePath: sqliteBad });
    expect(resBad.status).toBe(MigrationV2Status.Completed);
    expect(resBad.report?.reauthRequired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'xai_oauth', id: 'xai' }),
      ]),
    );
  });

  test('deferDisposableCacheCleanup skips sync cache deletion, preserves openclaw/state/media, and cleans pure caches asynchronously', async () => {
    const userDataDir = createTempDir();
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const stateDir = path.join(userDataDir, 'openclaw', 'state');
    const mediaFile = path.join(stateDir, 'media', 'outbound', 'clip.mp4');
    const compileCacheFile = path.join(stateDir, '.compile-cache', 'chunk.bin');
    const stateCacheFile = path.join(stateDir, 'cache', 'index.bin');
    const tmpFile = path.join(stateDir, 'tmp', 'scratch.tmp');
    const logsFile = path.join(userDataDir, 'openclaw', 'logs', 'gateway.log');
    const oldDshRuntimeFile = path.join(userDataDir, 'dsh-runtime', 'stale.bin');
    const extFile = path.join(userDataDir, 'third-party-extensions', 'demo', 'index.js');

    for (const file of [mediaFile, compileCacheFile, stateCacheFile, tmpFile, logsFile, oldDshRuntimeFile, extFile]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'payload', 'utf8');
    }

    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
    db.close();

    const result = runLegacyOpenClawMigration({
      userDataDir,
      sqlitePath,
      deferDisposableCacheCleanup: true,
      now: () => new Date('2026-11-24T00:00:00.000Z'),
    });

    expect(result.status).toBe(MigrationV2Status.Completed);
    expect(result.report?.legacyStateArchivePath).toBeNull();
    // Deferred mode does not synchronously delete disposable caches during pre-boot.
    expect(fs.existsSync(compileCacheFile)).toBe(true);
    expect(fs.existsSync(stateCacheFile)).toBe(true);
    expect(fs.existsSync(mediaFile)).toBe(true);
    expect(fs.existsSync(extFile)).toBe(true);

    // Async post-window cleanup removes only pure caches, preserving media & extensions.
    const cleanup = await cleanupLegacyOpenClawDisposableCaches(userDataDir);
    expect(cleanup.dirsRemoved).toBeGreaterThanOrEqual(5);
    expect(fs.existsSync(compileCacheFile)).toBe(false);
    expect(fs.existsSync(stateCacheFile)).toBe(false);
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(fs.existsSync(logsFile)).toBe(false);
    expect(fs.existsSync(oldDshRuntimeFile)).toBe(false);
    expect(fs.existsSync(mediaFile)).toBe(true);
    expect(fs.existsSync(extFile)).toBe(true);
  });
});
