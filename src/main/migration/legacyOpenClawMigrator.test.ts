import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { WORKSPACES_DIR_NAME } from '../../shared/dshEngine/hostConstants';
import { MigrationV2Status } from '../../shared/migration/constants';
import { LobsterScheduler } from '../scheduledTask/lobsterScheduler';
import {
  dismissMigrationV2Report,
  getPendingMigrationV2Report,
  runLegacyOpenClawMigration,
} from './legacyOpenClawMigrator';

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
});
