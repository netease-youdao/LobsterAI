import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DeliveryMode, TaskStatus } from '../../scheduledTask/constants';
import { CoworkMessageEditPhase } from '../../shared/cowork/messageEdit';
import {
  DSH_PERMISSION_PRESET_KV_KEY,
  DshPermissionPreset,
  LEGACY_OPENCLAW_BACKUP_DIR_NAME,
  WORKSPACES_DIR_NAME,
} from '../../shared/dshEngine/hostConstants';
import {
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY,
  MIGRATION_V2_REPORT_KV_KEY,
  MigrationV2Status,
} from '../../shared/migration/constants';
import { CoworkMessageEditStore } from '../libs/coworkMessageEditStore';
import { CoworkMessageVersionStore } from '../libs/coworkMessageVersionStore';
import { LobsterScheduler } from '../scheduledTask/lobsterScheduler';
import {
  backfillLegacyScheduledTasksFromBackup,
  dismissMigrationV2Report,
  getPendingMigrationV2Report,
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
    db.prepare('INSERT INTO im_config VALUES (?, ?, ?)').run('popo', '{"appKey":"x"}', 1);
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

    // Verify Step 1 snapshot + Step 3 archives exist & are non-empty.
    expect(fs.existsSync(report.sqliteSnapshotPath)).toBe(true);
    expect(fs.existsSync(report.incompatibleArchivePath)).toBe(true);
    expect(fs.statSync(report.incompatibleArchivePath).size).toBeGreaterThan(0);
    expect(report.legacyStateArchivePath && fs.existsSync(report.legacyStateArchivePath)).toBe(true);
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

    // Verify Step 5 cleaned up old OpenClaw & experimental dsh-runtime caches.
    expect(fs.existsSync(path.join(userDataDir, 'openclaw'))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'dsh-runtime'))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'third-party-extensions'))).toBe(false);

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
        delivery: { mode: 'announce', channel: 'moltbot-popo', to: 'retired-user' },
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

    // Retired POPO delivery downgraded cleanly to mode='none'.
    const wrapupTask = scheduler.getTask('job-wrapup')!;
    expect(wrapupTask.enabled).toBe(false);
    expect(wrapupTask.delivery).toEqual({ mode: DeliveryMode.None });

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
});
