import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from '../src/main/libs/openclawCompatibilityRepair';
import { OpenClawRepairPhase } from '../src/shared/openclawEngine/repair';
import {
  OPENCLAW_RETIRED_GATEWAY_RELOAD_KEYS,
  OPENCLAW_STARTUP_COMPATIBILITY_ENTRY,
  OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX,
  OpenClawBundledDiscoveryMode,
  OpenClawGatewayReloadMode,
  OpenClawStartupCompatibilityMode,
} from '../src/shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../src/shared/openclawEngine/startupMigration';

const runtimeRoot = process.env.OPENCLAW_STARTUP_COMPAT_RUNTIME;
const sourceRoot = process.env.OPENCLAW_STARTUP_COMPAT_SOURCE;
const execFileAsync = promisify(execFile);
const TABLE = 'current_conversation_bindings';
let tempDir: string;
let stateDir: string;
let configPath: string;
let databasePath: string;
const handles: DatabaseSync[] = [];

describe.skipIf(!runtimeRoot || !sourceRoot)('bundled on-demand startup compatibility', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-startup-compat-integration-'));
    stateDir = path.join(tempDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      meta: { lastTouchedVersion: '2026.6.1' }, gateway: { mode: 'local' },
      agents: { ownership: 'explicit', entries: { main: {} },
        defaults: { systemAgent: { agentId: 'main' }, authInheritance: { agentId: 'main' } } },
      plugins: { enabled: false, bundledDiscovery: OpenClawBundledDiscoveryMode.Compat },
      logging: { file: path.join(tempDir, 'openclaw.log') },
    }, null, 2));
  });

  afterEach(() => {
    for (const db of handles.splice(0)) if (db.isOpen) db.close();
    if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function connect(file = databasePath) {
    const db = new DatabaseSync(file);
    handles.push(db);
    return db;
  }

  function seedDatabase() {
    const db = connect();
    db.exec(fs.readFileSync(path.join(sourceRoot!, 'src/state/openclaw-state-schema.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 15');
    db.prepare('INSERT INTO schema_meta (meta_key,role,schema_version,app_version,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('primary', 'global', 15, '2026.8.1', 1, 1);
    return db;
  }

  function driftBindings(db: DatabaseSync) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN target_agent_id TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE ${TABLE} ADD COLUMN target_session_id TEXT;
      DROP INDEX idx_current_conversation_bindings_target;
      CREATE INDEX idx_current_conversation_bindings_target ON ${TABLE}(target_agent_id,target_session_key,updated_at DESC,binding_key);`);
    const record = JSON.stringify({ bindingId: 'fixture', targetAgentId: 'main', targetSessionKey: 'agent:main:main', metadata: { unicode: '中文', nested: [1, null] } });
    db.prepare(`INSERT INTO ${TABLE} (binding_key,binding_id,target_session_key,channel,account_id,conversation_kind,
      conversation_id,target_kind,status,bound_at,record_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('fixture', 'fixture', 'agent:main:main', 'test', 'default', 'channel', 'conversation', 'session', 'active', 1, record, 9007199254740993n);
    return record;
  }

  async function run(mode: OpenClawStartupCompatibilityMode) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: tempDir, USERPROFILE: tempDir, APPDATA: path.join(tempDir, 'appdata'), XDG_CONFIG_HOME: path.join(tempDir, 'config'),
      TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir,
      OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, VITEST: 'true',
    };
    let output: { code: number; stdout: string; stderr: string };
    try {
      const result = await execFileAsync(process.execPath, [path.join(runtimeRoot!, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), mode],
        { cwd: runtimeRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
      output = { ...result, code: 0 };
    } catch (error) {
      const failed = error as Error & { code: number; stdout: string; stderr: string };
      if (failed.code !== 1) throw error;
      output = failed;
    }
    const line = output.stdout.split(/\r?\n/).findLast(value => value.startsWith(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX));
    expect(line, (output.stdout + output.stderr).slice(-3000)).toBeDefined();
    return { ...output, report: JSON.parse(line!.slice(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX.length)) as {
      status: OpenClawStartupMigrationStatus; changes: string[]; backups: string[]; error?: string;
    } };
  }

  test.each([OpenClawGatewayReloadMode.LegacyHot, OpenClawGatewayReloadMode.LegacyRestart])('migrates retired reload mode %s before the legacy session CLI validates config', async mode => {
    seedDatabase();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.plugins.bundledDiscovery;
    config.gateway.reload = { mode };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const original = fs.readFileSync(configPath, 'utf8');

    const result = await run(OpenClawStartupCompatibilityMode.PrepareStartup);
    expect(result.report, JSON.stringify(result.report)).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    expect(result.report.changes).toContain('Mapped retired gateway.reload.mode to hybrid.');
    expect(result.report.backups).toHaveLength(1);
    expect(fs.readFileSync(result.report.backups[0], 'utf8')).toBe(original);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.gateway).toEqual({ ...config.gateway, reload: { mode: OpenClawGatewayReloadMode.Hybrid } });
    expect(after.agents).toEqual(config.agents);
    expect(after.plugins).toEqual(config.plugins);
    expect((await run(OpenClawStartupCompatibilityMode.PrepareStartup)).report)
      .toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, changes: [], backups: [] });
  });

  test.each([OpenClawGatewayReloadMode.Off, OpenClawGatewayReloadMode.Hybrid, 'unknown-user-value'])('preserves reload mode %s without guessing or discarding config', async mode => {
    seedDatabase();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.plugins.bundledDiscovery;
    config.gateway.reload = { mode };
    const original = JSON.stringify(config, null, 2);
    fs.writeFileSync(configPath, original);
    expect((await run(OpenClawStartupCompatibilityMode.PrepareStartup)).report)
      .toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, changes: [], backups: [] });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  test.each(Object.values(OpenClawBundledDiscoveryMode))('imports %s once and retains the exact source backup', async mode => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.plugins.bundledDiscovery = mode;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const before = fs.readFileSync(configPath, 'utf8');
    const first = await run(OpenClawStartupCompatibilityMode.MigrateConfig);
    expect(first.report, first.stderr).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    expect(fs.readFileSync(first.report.backups[0], 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins).toEqual({ enabled: false });
    expect(connect().prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.bundledDiscovery'").get()?.value_json)
      .toBe(JSON.stringify(mode));
    const second = await run(OpenClawStartupCompatibilityMode.MigrateConfig);
    expect(second.report).toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, backups: [], changes: [] });
  });

  test('migrates discovery and retired reload together with one original backup', async () => {
    seedDatabase();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.gateway.reload = { mode: OpenClawGatewayReloadMode.LegacyRestart };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const original = fs.readFileSync(configPath, 'utf8');
    const { report } = await run(OpenClawStartupCompatibilityMode.PrepareStartup);
    expect(report, JSON.stringify(report)).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    expect(report.backups).toHaveLength(1);
    expect(report.changes).toHaveLength(2);
    expect(fs.readFileSync(report.backups[0], 'utf8')).toBe(original);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.gateway.reload.mode).toBe(OpenClawGatewayReloadMode.Hybrid);
    expect(after.plugins).toEqual({ enabled: false });
  });

  test.each([
    OpenClawGatewayReloadMode.LegacyHot,
    OpenClawGatewayReloadMode.LegacyRestart,
    OpenClawGatewayReloadMode.Hybrid,
    undefined,
  ])('retires only the two old reload timers alongside mode %s with exact backup', async mode => {
    seedDatabase();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.plugins.bundledDiscovery;
    config.gateway.reload = {
      ...(mode ? { mode } : {}),
      ...Object.fromEntries(OPENCLAW_RETIRED_GATEWAY_RELOAD_KEYS.map((key, index) => [key, 1000 + index])),
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const original = fs.readFileSync(configPath, 'utf8');
    const { report } = await run(OpenClawStartupCompatibilityMode.PrepareStartup);
    expect(report, JSON.stringify(report)).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    expect(report.backups).toHaveLength(1);
    expect(fs.readFileSync(report.backups[0], 'utf8')).toBe(original);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.gateway).toEqual({ ...config.gateway, reload: mode ? { mode: OpenClawGatewayReloadMode.Hybrid } : {} });
    expect(after.agents).toEqual(config.agents);
    expect(after.plugins).toEqual(config.plugins);
    for (const key of OPENCLAW_RETIRED_GATEWAY_RELOAD_KEYS) {
      expect(report.changes).toContain(`Removed retired gateway.reload.${key}.`);
    }
    expect((await run(OpenClawStartupCompatibilityMode.PrepareStartup)).report)
      .toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, changes: [], backups: [] });
  });

  test('preserves original config and backup when an unrelated field prevents canonical write', async () => {
    seedDatabase();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.plugins.bundledDiscovery;
    config.gateway.reload = {
      mode: OpenClawGatewayReloadMode.LegacyHot, userUnrecognizedField: true,
      ...Object.fromEntries(OPENCLAW_RETIRED_GATEWAY_RELOAD_KEYS.map(key => [key, 1000])),
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const original = fs.readFileSync(configPath, 'utf8');
    const { report } = await run(OpenClawStartupCompatibilityMode.PrepareStartup);
    expect(report).toMatchObject({ status: OpenClawStartupMigrationStatus.Failed });
    expect(report.backups).toHaveLength(1);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(fs.readFileSync(report.backups[0], 'utf8')).toBe(original);
  });

  test('preserves an unknown mode and its timers when canonical validation refuses migration', async () => {
    seedDatabase();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.plugins.bundledDiscovery;
    config.gateway.reload = { mode: 'unknown-user-mode', [OPENCLAW_RETIRED_GATEWAY_RELOAD_KEYS[0]]: 1000 };
    const original = JSON.stringify(config);
    fs.writeFileSync(configPath, original);
    const { report } = await run(OpenClawStartupCompatibilityMode.PrepareStartup);
    expect(report).toMatchObject({ status: OpenClawStartupMigrationStatus.Failed });
    expect(report.backups).toHaveLength(1);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(fs.readFileSync(report.backups[0], 'utf8')).toBe(original);
  });

  test('keeps an existing canonical discovery mode over the legacy value', async () => {
    const db = seedDatabase();
    db.prepare('INSERT INTO config_machine_state (state_key,value_json,updated_at_ms) VALUES (?,?,?)')
      .run('plugins.bundledDiscovery', JSON.stringify(OpenClawBundledDiscoveryMode.Allowlist), 1);
    expect((await run(OpenClawStartupCompatibilityMode.MigrateConfig)).report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
    expect(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.bundledDiscovery'").get()?.value_json)
      .toBe(JSON.stringify(OpenClawBundledDiscoveryMode.Allowlist));
  });

  test('repairs the reproduced layout with WAL data, retained values and an idempotent retry', async () => {
    const db = seedDatabase();
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    const record = driftBindings(db);
    expect(fs.statSync(databasePath + '-wal').size).toBeGreaterThan(0);
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const result = await run(OpenClawStartupCompatibilityMode.RepairBindings);
    expect(result.report, result.stderr).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    const retained = db.prepare(`SELECT record_json,updated_at FROM ${TABLE}`);
    retained.setReadBigInts(true);
    expect(retained.get()).toEqual({ record_json: record, updated_at: 9007199254740993n });
    expect(db.prepare(`PRAGMA table_xinfo(${TABLE})`).all().map(row => row.name)).not.toContain('target_agent_id');
    expect(connect(result.report.backups[0]).prepare(`SELECT record_json,target_agent_id FROM ${TABLE}`).get())
      .toEqual({ record_json: record, target_agent_id: 'main' });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect((await run(OpenClawStartupCompatibilityMode.RepairBindings)).report)
      .toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, backups: [], changes: [] });
    expect((await run(OpenClawStartupCompatibilityMode.MigrateConfig)).report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
  });

  test('failed config import keeps the legacy field for recovery followed by retry', async () => {
    driftBindings(seedDatabase());
    const before = fs.readFileSync(configPath, 'utf8');
    const failed = await run(OpenClawStartupCompatibilityMode.MigrateConfig);
    expect(failed.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(failed.report.error).toContain('column definitions differ for current_conversation_bindings');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect((await run(OpenClawStartupCompatibilityMode.RepairBindings)).report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
    expect((await run(OpenClawStartupCompatibilityMode.MigrateConfig)).report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
  });

  test.each([false, true])('manual repair combines binding recovery with legacy discovery=%s and preserves its snapshot', async (legacyDiscovery) => {
    const db = seedDatabase();
    const record = driftBindings(db);
    db.close();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!legacyDiscovery) delete config.plugins.bundledDiscovery;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const backupDir = path.join(tempDir, 'manual-repair-backup');
    fs.mkdirSync(backupDir);
    const params = {
      stateDir, configPath, runtimeRoot: runtimeRoot!, backupDir, electronNodeRuntimePath: process.execPath,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: tempDir, USERPROFILE: tempDir, APPDATA: path.join(tempDir, 'appdata'),
        XDG_CONFIG_HOME: path.join(tempDir, 'config'), XDG_CACHE_HOME: path.join(tempDir, 'cache'),
        TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir,
      },
    };
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot });
    await runOpenClawDoctorRepair(params);
    await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery }))
      .resolves.toMatchObject({ success: true });

    const repaired = connect();
    expect(repaired.prepare(`PRAGMA table_xinfo(${TABLE})`).all().map(row => row.name)).not.toContain('target_agent_id');
    const retained = repaired.prepare(`SELECT record_json,updated_at FROM ${TABLE}`);
    retained.setReadBigInts(true);
    expect(retained.get()).toEqual({ record_json: record, updated_at: 9007199254740993n });
    if (legacyDiscovery) {
      expect(repaired.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.bundledDiscovery'").get()?.value_json)
        .toBe(JSON.stringify(OpenClawBundledDiscoveryMode.Compat));
    }
    const saved = connect(path.join(backupDir, 'original', 'state', 'openclaw.sqlite'));
    expect(saved.prepare(`SELECT record_json,target_agent_id FROM ${TABLE}`).get()).toEqual({ record_json: record, target_agent_id: 'main' });
    expect(fs.readFileSync(path.join(backupDir, 'original', 'openclaw.json'), 'utf8')).toBe(configBefore);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.bundledDiscovery).toBeUndefined();
  }, 180_000);

  test.each([
    `ALTER TABLE ${TABLE} ADD COLUMN unexplained TEXT NOT NULL DEFAULT 'unknown'`,
    `CREATE TRIGGER custom_binding_trigger AFTER UPDATE ON ${TABLE} BEGIN SELECT 1; END`,
    `DROP INDEX idx_current_conversation_bindings_target;
      CREATE UNIQUE INDEX idx_current_conversation_bindings_target ON ${TABLE}(channel)`,
    `DROP INDEX idx_current_conversation_bindings_target;
      ALTER TABLE ${TABLE} DROP COLUMN target_agent_id;
      ALTER TABLE ${TABLE} ADD COLUMN target_agent_id TEXT NOT NULL DEFAULT 'main' CHECK(length(target_agent_id) > 0);
      CREATE INDEX idx_current_conversation_bindings_target ON ${TABLE}(target_session_key,updated_at DESC,binding_key)`,
    'PRAGMA user_version = 16',
  ])('refuses unknown structure/version without changing the database: %s', async sql => {
    const db = seedDatabase();
    driftBindings(db);
    db.exec(sql);
    db.close();
    const before = fs.readFileSync(databasePath);
    const failed = await run(OpenClawStartupCompatibilityMode.RepairBindings);
    expect(failed.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(failed.report.backups).toEqual([]);
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  test('rolls back the binding repair if another table fails canonical validation', async () => {
    const db = seedDatabase();
    const record = driftBindings(db);
    db.exec("ALTER TABLE config_machine_state ADD COLUMN unexplained TEXT NOT NULL DEFAULT 'unknown'");
    const failed = await run(OpenClawStartupCompatibilityMode.RepairBindings);
    expect(failed.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(db.prepare(`SELECT record_json,target_agent_id FROM ${TABLE}`).get()).toEqual({ record_json: record, target_agent_id: 'main' });
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });

  test('does not modify SQLite when the backup directory cannot be created', async () => {
    const db = seedDatabase();
    driftBindings(db);
    db.close();
    const before = fs.readFileSync(databasePath);
    fs.writeFileSync(path.join(stateDir, 'startup-recovery-backups'), 'blocked');
    const result = await run(OpenClawStartupCompatibilityMode.RepairBindings);
    expect(result.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(result.report.backups).toEqual([]);
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });
});
