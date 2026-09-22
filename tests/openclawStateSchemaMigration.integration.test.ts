import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from '../src/main/libs/openclawCompatibilityRepair';
import { migrateLegacySessionStorageWithDoctor } from '../src/main/libs/openclawSessionLegacyMigration';
import { OPENCLAW_REPAIR_SNAPSHOT_MANIFEST, OpenClawRepairPhase } from '../src/shared/openclawEngine/repair';
import {
  OPENCLAW_STARTUP_COMPATIBILITY_ENTRY,
  OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX,
  OpenClawBundledDiscoveryMode,
  OpenClawStartupCompatibilityMode,
} from '../src/shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../src/shared/openclawEngine/startupMigration';
import { readRepairedGatewayHistory } from './helpers/openclawGatewayRepairSmoke';

const runtimeRoot = process.env.OPENCLAW_STARTUP_COMPAT_RUNTIME;
const execFileAsync = promisify(execFile);
let directory: string;
let stateDir: string;
let configPath: string;
let databasePath: string;
const handles: DatabaseSync[] = [];

describe.skipIf(!runtimeRoot)('packaged shared-state preparation', () => {
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-state-upgrade-'));
    stateDir = path.join(directory, '旧版本 state');
    configPath = path.join(stateDir, 'openclaw.json');
    databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local' },
      agents: { ownership: 'explicit', entries: { main: {} }, defaults: {
        workspace: path.join(stateDir, 'workspace-main'), systemAgent: { agentId: 'main' }, authInheritance: { agentId: 'main' },
      } },
      plugins: { enabled: false, bundledDiscovery: OpenClawBundledDiscoveryMode.Compat },
      logging: { file: path.join(directory, 'openclaw.log') },
    }));
  });

  afterEach(() => {
    for (const db of handles.splice(0)) if (db.isOpen) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function connect(file = databasePath) {
    const db = new DatabaseSync(file);
    handles.push(db);
    return db;
  }

  function seedLegacyState(wal = false) {
    const db = connect();
    if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
        agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, NULL, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE, source_sequence INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT,
        actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        session_key TEXT, session_id TEXT, run_id TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT
      );
      INSERT INTO audit_events VALUES (42, 'retained-event', 'source:42', 42, 100,
        'agent_run', 'agent.run.started', 'started', NULL, 'agent', 'main', 'main',
        NULL, NULL, 'retained-run', NULL, NULL);
    `);
    return db;
  }

  function seedPreAuditState(wal = false) {
    const db = seedLegacyState(wal);
    db.exec(`
      DROP TABLE audit_events;
      CREATE TABLE config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO config_machine_state VALUES ('fixture.retained', '{"value":"旧版配置"}', 10);
    `);
    return db;
  }

  function retainedMachineState(db: DatabaseSync) {
    return db.prepare("SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key = 'fixture.retained'").get();
  }

  function environment(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      OPENCLAW_HOME: directory, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SERVICE_REPAIR_POLICY: 'external', ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_NO_AUTO_UPDATE: '1',
      XDG_CACHE_HOME: path.join(directory, 'cache'), TMPDIR: directory, TEMP: directory, TMP: directory,
    };
  }

  async function prepare() {
    let output: { stdout: string; stderr: string };
    try {
      output = await execFileAsync(process.execPath, [path.join(runtimeRoot!, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY),
        OpenClawStartupCompatibilityMode.PrepareStartup], { env: environment(), cwd: runtimeRoot, timeout: 30_000 });
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      if (failure.code !== 1) throw error;
      output = failure;
    }
    const line = output.stdout.split(/\r?\n/).findLast(value => value.startsWith(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX));
    expect(line, output.stderr).toBeDefined();
    return JSON.parse(line!.slice(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX.length)) as {
      status: OpenClawStartupMigrationStatus; backups: string[]; changes: string[]; error?: string;
    };
  }

  function events(db: DatabaseSync) {
    return db.prepare('SELECT sequence,event_id,run_id FROM audit_events').all();
  }

  test.each(Object.values(OpenClawBundledDiscoveryMode))('migrates v1 plus %s discovery with a WAL-complete backup', async mode => {
    const originalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    originalConfig.plugins.bundledDiscovery = mode;
    fs.writeFileSync(configPath, JSON.stringify(originalConfig));
    const before = fs.readFileSync(configPath, 'utf8');
    const db = seedLegacyState(true);
    const records = events(db);
    expect(fs.statSync(databasePath + '-wal').size).toBeGreaterThan(0);
    const result = await prepare();
    expect(result, result.error).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    const saved = connect(result.backups.find(file => file.endsWith('.sqlite'))!);
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(events(saved)).toEqual(records);
    expect(fs.readFileSync(result.backups.find(file => file.endsWith('openclaw.json'))!, 'utf8')).toBe(before);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(events(db)).toEqual(records);
    expect(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.bundledDiscovery'").get()?.value_json)
      .toBe(JSON.stringify(mode));
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.bundledDiscovery).toBeUndefined();
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, backups: [], changes: [] });
  });

  test('migrates old SQLite even when no legacy config field remains', async () => {
    seedLegacyState().close();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.plugins.bundledDiscovery;
    const before = JSON.stringify(config);
    fs.writeFileSync(configPath, before);
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    expect(connect().prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  test.each([true, false])('initializes pre-audit v1 with WAL data and legacy discovery=%s', async legacyDiscovery => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!legacyDiscovery) delete config.plugins.bundledDiscovery;
    const configBefore = JSON.stringify(config);
    fs.writeFileSync(configPath, configBefore);
    const db = seedPreAuditState(true);
    const retained = retainedMachineState(db);
    expect(fs.statSync(databasePath + '-wal').size).toBeGreaterThan(0);

    const result = await prepare();
    expect(result, result.error).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    const saved = connect(result.backups.find(file => file.endsWith('.sqlite'))!);
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(saved.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'audit_events'").get()).toBeUndefined();
    expect(retainedMachineState(saved)).toEqual(retained);
    expect(fs.readFileSync(result.backups.find(file => file.endsWith('openclaw.json'))!, 'utf8')).toBe(configBefore);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()?.schema_version).toBe(15);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(events(db)).toEqual([]);
    expect(retainedMachineState(db)).toEqual(retained);
    if (legacyDiscovery) {
      expect(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.bundledDiscovery'").get()?.value_json)
        .toBe(JSON.stringify(OpenClawBundledDiscoveryMode.Compat));
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.bundledDiscovery).toBeUndefined();
    } else {
      expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    }
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, backups: [], changes: [] });
  });

  test.each([2, 15])('refuses to recreate a missing audit ledger in schema %s', async version => {
    const db = seedPreAuditState();
    db.exec(`PRAGMA user_version = ${version}`);
    db.prepare('UPDATE schema_meta SET schema_version = ?').run(version);
    const retained = retainedMachineState(db);
    db.close();
    const configBefore = fs.readFileSync(configPath);
    const result = await prepare();
    expect(result.status).toBe(OpenClawStartupMigrationStatus.Failed);
    const unchanged = connect();
    expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(version);
    expect(unchanged.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'audit_events'").get()).toBeUndefined();
    expect(retainedMachineState(unchanged)).toEqual(retained);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
  });

  test.each(['missing', 'malformed'])('preserves %s config for Doctor after database migration', async kind => {
    seedLegacyState().close();
    if (kind === 'missing') fs.unlinkSync(configPath);
    else fs.writeFileSync(configPath, '{invalid');
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    if (kind === 'missing') expect(fs.existsSync(configPath)).toBe(false);
    else expect(fs.readFileSync(configPath, 'utf8')).toBe('{invalid');
  });

  test('does not change the database or config when backup creation fails', async () => {
    seedLegacyState().close();
    const before = fs.readFileSync(databasePath);
    const configBefore = fs.readFileSync(configPath);
    fs.writeFileSync(path.join(stateDir, 'startup-recovery-backups'), 'blocked');
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Failed, backups: [] });
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
  });

  test.each(['newer', 'metadata', 'corrupt'])('refuses %s SQLite without modifying the source', async kind => {
    const db = seedLegacyState();
    if (kind === 'newer') db.exec('PRAGMA user_version = 16');
    if (kind === 'metadata') db.exec('UPDATE schema_meta SET schema_version = 2');
    db.close();
    if (kind === 'corrupt') fs.writeFileSync(databasePath, 'invalid database fixture');
    const before = fs.readFileSync(databasePath);
    const configBefore = fs.readFileSync(configPath);
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Failed, backups: [] });
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
  });

  test('refuses an unknown audit layout and retains its records and config', async () => {
    const db = seedLegacyState();
    db.exec('ALTER TABLE audit_events ADD COLUMN unexpected TEXT');
    const before = events(db);
    db.close();
    const configBefore = fs.readFileSync(configPath);
    const result = await prepare();
    expect(result.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(result.backups.some(file => file.endsWith('.sqlite'))).toBe(true);
    const unchanged = connect();
    expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(events(unchanged)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
  });

  test('one-click repair reaches Doctor with v1 and legacy discovery together', async () => {
    seedLegacyState().close();
    const backupDir = path.join(directory, 'manual-backup');
    fs.mkdirSync(backupDir);
    const params = { runtimeRoot: runtimeRoot!, stateDir, configPath, backupDir,
      electronNodeRuntimePath: process.execPath, env: environment() };
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot });
    await runOpenClawDoctorRepair(params);
    expect(fs.existsSync(path.join(backupDir, 'doctor-result.json'))).toBe(true);
    expect(connect().prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(events(connect())).toEqual([{ sequence: 42, event_id: 'retained-event', run_id: 'retained-run' }]);
    expect(connect(path.join(backupDir, 'original', 'state', 'openclaw.sqlite'))
      .prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  }, 180_000);

  test('one-click repair initializes pre-audit v1 before Doctor and remains restartable', async () => {
    const db = seedPreAuditState();
    const retained = retainedMachineState(db);
    db.close();
    const backupDir = path.join(directory, 'manual-backup');
    fs.mkdirSync(backupDir);
    const params = { runtimeRoot: runtimeRoot!, stateDir, configPath, backupDir,
      electronNodeRuntimePath: process.execPath, env: environment() };
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot });
    const doctor = await runOpenClawDoctorRepair(params);
    expect(doctor.code).toBe(0);
    expect(fs.existsSync(path.join(backupDir, 'doctor-result.json'))).toBe(true);
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery });
    expect(connect().prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(retainedMachineState(connect())).toEqual(retained);
    const saved = connect(path.join(backupDir, 'original', 'state', 'openclaw.sqlite'));
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(retainedMachineState(saved)).toEqual(retained);
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, backups: [], changes: [] });
    const gateway = { runtimeRoot: runtimeRoot!, env: environment(), sessionKey: 'agent:main:main' };
    await readRepairedGatewayHistory(gateway);
    await readRepairedGatewayHistory(gateway);
  }, 180_000);

  test.each([1, 15])('repairs agent v1 and dangling skill links with shared schema %s, retaining media and WAL data', async sharedVersion => {
    seedLegacyState().close();
    if (sharedVersion === 15) await prepare();
    const agentPath = path.join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    const agent = connect(agentPath);
    // The owned, path/source-keyed v1 memory layout supported by the pinned
    // owner. Keep committed records in WAL while taking the repair snapshot.
    agent.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
        agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'main', NULL, 1, 1);
      CREATE TABLE memory_index_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
      INSERT INTO memory_index_state VALUES (1, 7);
      CREATE TABLE memory_index_sources (
        path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory', hash TEXT NOT NULL,
        mtime INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (path, source)
      );
      INSERT INTO memory_index_sources VALUES ('MEMORY.md', 'memory', 'source-hash', 10, 20);
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
        model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO memory_index_chunks VALUES ('sentinel', 'MEMORY.md', 'memory', 1, 1, 'chunk-hash', 'model', 'retained memory', '[]', 1);
    `);
    const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const mediaPath = path.join(stateDir, 'attachment.png');
    fs.writeFileSync(mediaPath, 'attachment bytes');
    const sessionFile = path.join(sessionsDir, 'legacy-session.jsonl');
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({
      'agent:main:main': { sessionId: 'legacy-session', updatedAt: 1000, sessionFile },
    }));
    fs.writeFileSync(sessionFile, [
      { type: 'session', version: 3, id: 'legacy-session', timestamp: '2026-09-01T00:00:00.000Z', cwd: directory },
      { type: 'message', id: 'legacy-media', parentId: null, timestamp: '2026-09-01T00:00:01.000Z',
        message: { role: 'user', content: 'retained message', MediaPath: mediaPath, MediaType: 'image/png' } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    const skillsDir = path.join(stateDir, 'plugin-skills');
    fs.mkdirSync(skillsDir);
    const skillLink = path.join(skillsDir, 'browser-automation');
    fs.symlinkSync(path.join(directory, 'removed-installation', 'browser-automation'), skillLink, 'junction');
    fs.writeFileSync(path.join(skillsDir, 'notes.txt'), 'retained user file');
    const backupDir = path.join(directory, 'manual-backup');
    fs.mkdirSync(backupDir);
    const params = { runtimeRoot: runtimeRoot!, stateDir, configPath, backupDir,
      electronNodeRuntimePath: process.execPath, env: environment() };
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot });
    const savedAgent = connect(path.join(backupDir, 'original', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'));
    expect(savedAgent.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(savedAgent.prepare('SELECT text FROM memory_index_chunks').get()?.text).toBe('retained memory');
    expect(JSON.parse(fs.readFileSync(path.join(backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST), 'utf8'))
      .generatedPluginSkillLinks).toEqual([{ path: path.join('plugin-skills', 'browser-automation'), target: fs.readlinkSync(skillLink) }]);
    expect(fs.readFileSync(path.join(backupDir, 'original', 'plugin-skills', 'notes.txt'), 'utf8')).toBe('retained user file');
    agent.close();
    savedAgent.close();
    await runOpenClawDoctorRepair(params);
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery });
    const imported = await migrateLegacySessionStorageWithDoctor(params);
    expect(imported.status, JSON.stringify(imported)).not.toBe(OpenClawStartupMigrationStatus.Failed);
    const migratedAgent = connect(agentPath);
    expect(migratedAgent.prepare('PRAGMA user_version').get()?.user_version).toBe(19);
    expect(migratedAgent.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(migratedAgent.prepare('SELECT text FROM memory_index_chunks').get()?.text).toBe('retained memory');
    const messages = migratedAgent.prepare('SELECT event_json FROM transcript_events').all()
      .map(row => JSON.parse(String(row.event_json))).filter(event => event.type === 'message');
    expect(messages).toEqual([expect.objectContaining({ message: expect.objectContaining({ content: 'retained message' }) })]);
    expect(JSON.stringify(messages)).toContain(mediaPath.replaceAll('\\', '\\\\'));
    expect(fs.readFileSync(mediaPath, 'utf8')).toBe('attachment bytes');
    expect(connect().prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(events(connect())).toEqual([{ sequence: 42, event_id: 'retained-event', run_id: 'retained-run' }]);
    migratedAgent.close();
    await runOpenClawDoctorRepair(params);
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery });
    expect(connect(agentPath).prepare('SELECT COUNT(*) AS count FROM transcript_events').get()?.count).toBe(2);
    if (sharedVersion === 1) {
      // A successful Doctor exit alone does not prove the gateway can start,
      // accept authenticated RPCs, and still read the old session after restart.
      const gateway = { runtimeRoot: runtimeRoot!, env: environment(), sessionKey: 'agent:main:main' };
      expect(await readRepairedGatewayHistory(gateway)).toContain('retained message');
      expect(await readRepairedGatewayHistory(gateway)).toContain('retained message');
    }
  }, 180_000);
});
