import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DeliveryMode, TaskStatus } from '../../scheduledTask/constants';
import {
  LEGACY_OPENCLAW_BACKUP_DIR_NAME,
  WORKSPACES_DIR_NAME,
} from '../../shared/dshEngine/hostConstants';
import {
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY,
  MIGRATION_V2_REPORT_KV_KEY,
  MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY,
  MigrationV2Status,
} from '../../shared/migration/constants';
import { LobsterMemoryService, memoryFingerprint } from '../memory/lobsterMemoryService';
import { LobsterScheduler } from '../scheduledTask/lobsterScheduler';
import {
  backfillLegacyDreamDiariesFromBackup,
  backfillLegacyScheduledTasksFromBackup,
  backfillLegacyUserMemories,
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
});
