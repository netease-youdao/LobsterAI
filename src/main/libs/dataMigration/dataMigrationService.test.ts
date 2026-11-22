import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, expect, test, vi } from 'vitest';

import { DataMigrationRestoreStatus } from '../../../shared/dataMigration/constants';
import { MIGRATION_V2_COMPLETED_KV_KEY } from '../../../shared/migration/constants';
import { DB_FILENAME } from '../../appConstants';
import { LobsterMemoryService, MEMORY_FTS_DB_NAME } from '../../memory/lobsterMemoryService';
import { DshHostManager, resolveBundledDshPaths } from '../dsh/dshHostManager';
import {
  assertDataMigrationSqliteSnapshotMatchesLiveSync,
  createMigrationArchiveSync,
  type DshStateMigrationSummary,
  inspectMigrationArchiveSync,
  performDataMigrationRestoreSync,
  performPendingDataMigrationRestoreSync,
  writePendingRestoreRequestSync,
} from './dataMigrationService';

const tempRoots: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-test-'));
  tempRoots.push(dir);
  return dir;
};

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const writeOpenClawStateFixture = (userDataPath: string, label: string): void => {
  writeFile(
    path.join(userDataPath, 'openclaw', 'state', 'openclaw.json'),
    JSON.stringify({ label, agents: { defaults: { model: `${label}-model` } } }),
  );
  writeFile(
    path.join(userDataPath, 'openclaw', 'state', 'cron', 'jobs.json'),
    JSON.stringify({ jobs: [{ id: `${label}-cron`, name: `${label} cron` }] }),
  );
  writeFile(
    path.join(userDataPath, 'openclaw', 'state', 'cron', 'runs', `${label}-cron.jsonl`),
    `${JSON.stringify({ jobId: `${label}-cron`, status: 'ok' })}\n`,
  );
  writeFile(
    path.join(userDataPath, 'openclaw', 'state', 'agents', 'writer', 'sessions', `${label}-session.jsonl`),
    `${JSON.stringify({ type: 'message', message: { role: 'user', content: `${label} transcript` } })}\n`,
  );
};

const writeSqliteFixture = (dbPath: string, label: string): void => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(dbPath, { force: true });

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE cowork_messages (id TEXT PRIMARY KEY);
      CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY);
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        install_dir TEXT,
        command TEXT,
        args_json TEXT
      );
      CREATE TABLE user_plugins (plugin_id TEXT PRIMARY KEY);
      CREATE TABLE user_memories (id TEXT PRIMARY KEY);
      CREATE TABLE user_memory_sources (id TEXT PRIMARY KEY);
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY);
      CREATE TABLE subagent_messages (id TEXT PRIMARY KEY);
      CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE im_session_mappings (im_conversation_id TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (im_conversation_id, platform));
      CREATE TABLE scheduled_task_meta (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, binding TEXT NOT NULL);
      CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE scheduled_task_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    `);

    const now = Date.now();
    const insertKv = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    insertKv.run('auth_tokens', JSON.stringify({ accessToken: `${label}-access`, refreshToken: `${label}-refresh` }), now);
    insertKv.run('auth_user', JSON.stringify({ id: `${label}-user` }), now);
    insertKv.run('app_config', JSON.stringify({ providers: { custom: { models: [`${label}-model`] } } }), now);
    insertKv.run('skills_state', JSON.stringify({ [`${label}-skill`]: { enabled: true } }), now);
    insertKv.run('openclaw_session_policy', JSON.stringify({ mode: label }), now);
    insertKv.run('installation_uuid', JSON.stringify(`${label}-install`), now);

    db.prepare('INSERT INTO cowork_sessions (id) VALUES (?)').run(`${label}-session`);
    db.prepare('INSERT INTO cowork_messages (id) VALUES (?)').run(`${label}-message`);
    db.prepare('INSERT INTO cowork_config (key, value, updated_at) VALUES (?, ?, ?)').run('workingDirectory', label, now);
    db.prepare('INSERT INTO agents (id) VALUES (?)').run(`${label}-agent`);
    db.prepare('INSERT INTO mcp_servers (id) VALUES (?)').run(`${label}-mcp`);
    db.prepare('INSERT INTO mcp_launch_resolutions (server_id, install_dir, command, args_json) VALUES (?, ?, ?, ?)').run(
      `${label}-mcp`,
      path.join('/source-machine', 'openclaw', 'mcp-packages', label),
      'node',
      JSON.stringify([path.join('/source-machine', 'openclaw', 'mcp-packages', label, 'bin.js')]),
    );
    db.prepare('INSERT INTO user_plugins (plugin_id) VALUES (?)').run(`${label}-plugin`);
    db.prepare('INSERT INTO user_memories (id) VALUES (?)').run(`${label}-memory`);
    db.prepare('INSERT INTO user_memory_sources (id) VALUES (?)').run(`${label}-memory-source`);
    db.prepare('INSERT INTO subagent_runs (id) VALUES (?)').run(`${label}-subagent`);
    db.prepare('INSERT INTO subagent_messages (id) VALUES (?)').run(`${label}-subagent-message`);
    db.prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)').run(
      `${label}-im`,
      JSON.stringify({ enabled: true, token: `${label}-im-token` }),
      now,
    );
    db.prepare('INSERT INTO im_session_mappings (im_conversation_id, platform) VALUES (?, ?)').run(`${label}-conversation`, 'telegram');
    db.prepare('INSERT INTO scheduled_task_meta (task_id, origin, binding) VALUES (?, ?, ?)').run(
      `${label}-task`,
      JSON.stringify({ kind: 'manual' }),
      JSON.stringify({ kind: 'new_session' }),
    );
    db.prepare('INSERT INTO scheduled_tasks (id, name) VALUES (?, ?)').run(`${label}-legacy-task`, `${label} task`);
    db.prepare('INSERT INTO scheduled_task_runs (id, task_id) VALUES (?, ?)').run(`${label}-legacy-run`, `${label}-legacy-task`);
  } finally {
    db.close();
  }
};

const writeMultiAgentSqliteFixture = (dbPath: string, label: string): void => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(dbPath, { force: true });

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY);
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        install_dir TEXT,
        command TEXT,
        args_json TEXT
      );
      CREATE TABLE user_plugins (plugin_id TEXT PRIMARY KEY);
      CREATE TABLE user_memories (id TEXT PRIMARY KEY);
      CREATE TABLE user_memory_sources (id TEXT PRIMARY KEY);
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY);
      CREATE TABLE subagent_messages (id TEXT PRIMARY KEY);
      CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE im_session_mappings (im_conversation_id TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (im_conversation_id, platform));
      CREATE TABLE scheduled_task_meta (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, binding TEXT NOT NULL);
    `);

    const now = Date.now();
    const appConfig = {
      providers: {
        custom_0: {
          enabled: true,
          apiKey: `sk-${label}-custom`,
          baseUrl: 'https://api.example.com/v1',
          models: [{ id: `${label}-model`, name: `${label} Model` }],
        },
      },
      api: {
        key: `sk-${label}-custom`,
        baseUrl: 'https://api.example.com/v1',
      },
    };
    const insertKv = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    insertKv.run('app_config', JSON.stringify(appConfig), now);

    const insertAgent = db.prepare('INSERT INTO agents (id) VALUES (?)');
    const insertSession = db.prepare(
      'INSERT INTO cowork_sessions (id, title, status, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const agentId of ['main', 'writer', 'reviewer']) {
      insertAgent.run(agentId);
      insertSession.run(`${label}-${agentId}-session`, `${agentId} session`, 'completed', agentId, now, now);
    }
  } finally {
    db.close();
  }
};

const openSqliteFixtureWithWalChange = (dbPath: string, label: string): Database.Database => {
  writeSqliteFixture(dbPath, label);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.prepare('INSERT INTO cowork_sessions (id) VALUES (?)').run(`${label}-wal-session`);
  return db;
};

const readSqliteValue = (dbPath: string, sql: string, params: unknown[] = []): unknown => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).pluck().get(...params);
  } finally {
    db.close();
  }
};

const readSqliteString = (dbPath: string, sql: string, params: unknown[] = []): string => (
  String(readSqliteValue(dbPath, sql, params) ?? '')
);

const readSqliteCount = (dbPath: string, tableName: string): number => (
  Number(readSqliteValue(dbPath, `SELECT COUNT(*) FROM "${tableName}"`) ?? 0)
);

const listArchiveEntries = (archivePath: string): string[] => {
  const entries: string[] = [];
  tar.list({
    sync: true,
    file: archivePath,
    onentry: entry => entries.push(entry.path),
  });
  return entries.sort();
};

const extractArchive = (archivePath: string): string => {
  const extractRoot = makeTempDir();
  tar.extract({
    sync: true,
    file: archivePath,
    cwd: extractRoot,
  });
  return extractRoot;
};

const writeManifestFixture = (userDataPath: string): void => {
  writeFile(
    path.join(userDataPath, '.lobsterai-migration.json'),
    JSON.stringify({
      format: 'lobsterai-data-migration',
      version: 1,
      archiveRoot: 'LobsterAI',
      sqlite: { exists: true },
      openclawState: { exists: false },
    }),
  );
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createMigrationArchive excludes cache and log data and writes a manifest', () => {
  const root = makeTempDir();
  const userData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'backup.tar.gz');

  writeFile(path.join(userData, 'Cache', 'cache.bin'), 'cache');
  writeFile(path.join(userData, 'Code Cache', 'code.bin'), 'code-cache');
  writeFile(path.join(userData, 'Dictionaries', 'en-US-10-1.bdic'), 'dictionary');
  writeFile(path.join(userData, 'GPUCache', 'gpu.bin'), 'gpu-cache');
  writeFile(path.join(userData, 'Local State'), 'local-state');
  writeFile(path.join(userData, 'Local Storage', 'leveldb', 'LOCK'), 'local-storage-lock');
  writeFile(path.join(userData, 'Network', 'Cookies'), 'network-cookies');
  writeFile(path.join(userData, 'Preferences'), 'preferences');
  writeFile(path.join(userData, 'Session Storage', 'leveldb', 'LOCK'), 'session-storage-lock');
  writeFile(path.join(userData, 'Shared Dictionary', 'dict.bin'), 'dictionary');
  writeFile(path.join(userData, 'SharedStorage'), 'shared-storage');
  writeFile(path.join(userData, 'SharedStorage-wal'), 'shared-storage-wal');
  writeFile(path.join(userData, 'logs', 'main.log'), 'log');
  writeFile(path.join(userData, 'updates', 'installer.dmg'), 'downloaded update');
  writeFile(path.join(userData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'old-snapshot');
  writeFile(path.join(userData, 'sqlite-backups', 'lobsterai-latest.sqlite'), 'legacy-snapshot');
  writeFile(path.join(userData, 'Cookies'), 'cookies');
  writeFile(path.join(userData, 'DIPS-journal'), 'dips');
  writeFile(path.join(userData, '.com.github.Electron.test'), 'electron-marker');
  writeFile(path.join(userData, 'install-timing.log'), 'install log');
  writeFile(path.join(userData, 'skill-migrate.log'), 'skill migrate log');
  writeSqliteFixture(path.join(userData, DB_FILENAME), 'source');
  writeFile(path.join(userData, 'cowork', 'workspaces', 'session.txt'), 'workspace');
  writeFile(path.join(userData, 'openclaw', 'logs', 'gateway-2026-06-10.log'), 'gateway log');
  writeFile(path.join(userData, 'openclaw', 'state', 'logs', 'commands.log'), 'commands log');
  writeFile(path.join(userData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'native');
  writeFile(path.join(userData, 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'top-level-native');
  writeOpenClawStateFixture(userData, 'source');
  writeFile(path.join(userData, 'runtimes', 'node', 'node.exe'), 'runtime');
  writeFile(path.join(userData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');

  createMigrationArchiveSync({ userDataPath: userData, outputPath: archivePath });

  const entries = listArchiveEntries(archivePath);
  expect(entries).toContain('LobsterAI/.lobsterai-migration.json');
  expect(entries).toContain(`LobsterAI/${DB_FILENAME}`);
  expect(entries).toContain('LobsterAI/openclaw/state/openclaw.json');
  expect(entries).toContain('LobsterAI/SKILLs/demo/SKILL.md');
  expect(entries.some(entry => entry.includes('/Cache/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Code Cache/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/cowork/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Dictionaries/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/GPUCache/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Local Storage/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Network/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Session Storage/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Shared Dictionary/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/openclaw/mcp-packages/'))).toBe(false);
  expect(entries.some(entry => entry.startsWith('LobsterAI/mcp-packages/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/openclaw/logs/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/openclaw/state/logs/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/backups/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/logs/'))).toBe(false);
  expect(entries.some(entry => entry.startsWith('LobsterAI/updates/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/runtimes/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/sqlite-backups/'))).toBe(false);
  expect(entries.some(entry => entry.endsWith('/install-timing.log'))).toBe(false);
  expect(entries.some(entry => entry.endsWith('/skill-migrate.log'))).toBe(false);
  expect(entries.some(entry => entry.endsWith('/Local State'))).toBe(false);
  expect(entries.some(entry => entry.endsWith('/Preferences'))).toBe(false);
  expect(entries.some(entry => entry.includes('/SharedStorage'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Cookies'))).toBe(false);
  expect(entries.some(entry => entry.includes('/DIPS'))).toBe(false);
  expect(entries.some(entry => entry.includes('/.com.github.Electron.'))).toBe(false);

  const extractRoot = extractArchive(archivePath);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extractRoot, 'LobsterAI', '.lobsterai-migration.json'), 'utf8'),
  ) as {
    format?: string;
    archiveRoot?: string;
    sqlite?: { rowCounts?: Record<string, number>; tableContentChecksums?: Record<string, string> };
    openclawState?: { cronFileCount?: number; agentSessionFileCount?: number; openclawConfigExists?: boolean };
  };
  expect(manifest.format).toBe('lobsterai-data-migration');
  expect(manifest.archiveRoot).toBe('LobsterAI');
  expect(manifest.sqlite?.rowCounts?.scheduled_task_meta).toBe(1);
  expect(manifest.sqlite?.tableContentChecksums?.im_config).toBeTruthy();
  expect(manifest.openclawState?.openclawConfigExists).toBe(true);
  expect(manifest.openclawState?.cronFileCount).toBeGreaterThan(0);
  expect(manifest.openclawState?.agentSessionFileCount).toBeGreaterThan(0);
});

test('createMigrationArchive replaces the live sqlite database with the snapshot', () => {
  const root = makeTempDir();
  const userData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'backup.tar.gz');
  const sqliteSnapshotPath = path.join(root, 'snapshot.sqlite');

  writeSqliteFixture(path.join(userData, DB_FILENAME), 'live');
  writeFile(path.join(userData, `${DB_FILENAME}-wal`), 'live-wal');
  writeSqliteFixture(sqliteSnapshotPath, 'snapshot');

  createMigrationArchiveSync({
    userDataPath: userData,
    outputPath: archivePath,
    sqliteSnapshotPath,
  });

  const extractRoot = extractArchive(archivePath);
  expect(readSqliteString(path.join(extractRoot, 'LobsterAI', DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('snapshot-refresh');
  expect(fs.existsSync(path.join(extractRoot, 'LobsterAI', `${DB_FILENAME}-wal`))).toBe(false);
});

test('assertDataMigrationSqliteSnapshotMatchesLiveSync rejects stale snapshots that lost agents and provider keys', () => {
  const root = makeTempDir();
  const liveDbPath = path.join(root, 'live.sqlite');
  const staleSnapshotPath = path.join(root, 'snapshot.sqlite');

  writeMultiAgentSqliteFixture(liveDbPath, 'live');
  writeSqliteFixture(staleSnapshotPath, 'stale');

  expect(() => assertDataMigrationSqliteSnapshotMatchesLiveSync(liveDbPath, staleSnapshotPath))
    .toThrow(/Backup snapshot .*mismatch/);
});

test('createMigrationArchive rejects a source without a sqlite database', () => {
  const root = makeTempDir();
  const userData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'backup.tar.gz');

  writeFile(path.join(userData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');

  expect(() => createMigrationArchiveSync({ userDataPath: userData, outputPath: archivePath }))
    .toThrow(`missing ${DB_FILENAME}`);
  expect(fs.existsSync(archivePath)).toBe(false);
});

test('inspectMigrationArchive rejects legacy Windows PowerShell archive root', () => {
  const root = makeTempDir();
  const legacyRoot = path.join(root, 'AppData', 'Roaming', 'LobsterAI');
  const archivePath = path.join(root, 'legacy.tar.gz');
  writeSqliteFixture(path.join(legacyRoot, DB_FILENAME), 'legacy');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: root,
  }, ['AppData']);

  expect(() => inspectMigrationArchiveSync(archivePath)).toThrow(/does not contain LobsterAI user data/);
});

test('inspectMigrationArchive rejects archives without a migration manifest', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'missing-manifest.tar.gz');
  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: root,
  }, ['LobsterAI']);

  expect(() => inspectMigrationArchiveSync(archivePath)).toThrow(/missing \.lobsterai-migration\.json/);
});

test('inspectMigrationArchive rejects unsupported archive extensions', () => {
  const root = makeTempDir();
  const archivePath = path.join(root, 'backup.tar');
  writeFile(archivePath, 'not a gzip archive');

  expect(() => inspectMigrationArchiveSync(archivePath)).toThrow(/\.tar\.gz or \.tgz/);
});

test('inspectMigrationArchive rejects archives whose manifest does not match sqlite content', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const archivePath = path.join(root, 'source-backup.tar.gz');
  const tamperedArchivePath = path.join(root, 'tampered-backup.tar.gz');
  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });
  const extractRoot = extractArchive(archivePath);
  const manifestPath = path.join(extractRoot, 'LobsterAI', '.lobsterai-migration.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    sqlite?: { checksumSha256?: string };
  };
  manifest.sqlite = { ...(manifest.sqlite || {}), checksumSha256: 'wrong-checksum' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  tar.create({
    sync: true,
    gzip: true,
    file: tamperedArchivePath,
    cwd: extractRoot,
  }, ['LobsterAI']);

  expect(() => inspectMigrationArchiveSync(tamperedArchivePath)).toThrow(/sqlite checksum mismatch/);
});

test('inspectMigrationArchive rejects unreadable sqlite database', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'invalid.tar.gz');
  writeFile(path.join(sourceUserData, DB_FILENAME), 'not a sqlite database');
  writeManifestFixture(sourceUserData);

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: root,
  }, ['LobsterAI']);

  expect(() => inspectMigrationArchiveSync(archivePath)).toThrow(`unreadable ${DB_FILENAME}`);
});

test('inspectMigrationArchive rejects parent-directory archive paths', () => {
  const root = makeTempDir();
  const source = path.join(root, 'source');
  const archivePath = path.join(root, 'evil.tar.gz');
  writeFile(path.join(source, 'payload.txt'), 'evil');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: source,
    prefix: '../evil',
  }, ['payload.txt']);

  expect(() => inspectMigrationArchiveSync(archivePath)).toThrow(/parent-directory path/);
});

test('performPendingDataMigrationRestoreSync creates rollback and restores backup data', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeFile(path.join(sourceUserData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');
  writeOpenClawStateFixture(sourceUserData, 'source');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writeOpenClawStateFixture(targetUserData, 'target');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });
  writePendingRestoreRequestSync(targetUserData, archivePath);

  const result = performPendingDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(result?.rollbackPath).toBeTruthy();
  expect(fs.existsSync(result?.rollbackPath || '')).toBe(true);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('source-refresh');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT id FROM cowork_sessions')).toBe('source-session');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT id FROM agents')).toBe('source-agent');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT id FROM mcp_servers')).toBe('source-mcp');
  expect(readSqliteCount(path.join(targetUserData, DB_FILENAME), 'mcp_launch_resolutions')).toBe(0);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT plugin_id FROM user_plugins')).toBe('source-plugin');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT key FROM im_config')).toBe('source-im');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT task_id FROM scheduled_task_meta')).toBe('source-task');
  expect(fs.readFileSync(path.join(targetUserData, 'SKILLs', 'demo', 'SKILL.md'), 'utf8')).toBe('# Demo');
  expect(fs.readFileSync(path.join(targetUserData, 'openclaw', 'state', 'cron', 'jobs.json'), 'utf8'))
    .toContain('source-cron');
  expect(fs.readFileSync(
    path.join(targetUserData, 'openclaw', 'state', 'agents', 'writer', 'sessions', 'source-session.jsonl'),
    'utf8',
  )).toContain('source transcript');
});

test('performDataMigrationRestoreSync restores backup data without a pending marker', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['app_config']))
    .toContain('source-model');
  expect(readSqliteCount(path.join(targetUserData, DB_FILENAME), 'subagent_runs')).toBe(1);
  expect(readSqliteCount(path.join(targetUserData, DB_FILENAME), 'user_memory_sources')).toBe(1);
});

test('performDataMigrationRestoreSync preserves multiple agents, their sessions, and custom provider api keys', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeMultiAgentSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  const targetDbPath = path.join(targetUserData, DB_FILENAME);
  const appConfig = JSON.parse(readSqliteString(targetDbPath, 'SELECT value FROM kv WHERE key = ?', ['app_config'])) as {
    providers?: Record<string, { apiKey?: string }>;
  };

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(readSqliteCount(targetDbPath, 'agents')).toBe(3);
  expect(readSqliteCount(targetDbPath, 'cowork_sessions')).toBe(3);
  expect(readSqliteValue(
    targetDbPath,
    "SELECT COUNT(*) FROM cowork_sessions WHERE agent_id IN ('main', 'writer', 'reviewer')",
  )).toBe(3);
  expect(appConfig.providers?.custom_0?.apiKey).toBe('sk-source-custom');
});

test('performDataMigrationRestoreSync checkpoints archived WAL data into the restored sqlite database', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  const sourceDb = openSqliteFixtureWithWalChange(path.join(sourceUserData, DB_FILENAME), 'source');
  try {
    writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
    createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });
  } finally {
    sourceDb.close();
  }

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(fs.existsSync(path.join(targetUserData, `${DB_FILENAME}-wal`))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, `${DB_FILENAME}-shm`))).toBe(false);
  expect(readSqliteString(
    path.join(targetUserData, DB_FILENAME),
    'SELECT id FROM cowork_sessions WHERE id = ?',
    ['source-wal-session'],
  )).toBe('source-wal-session');
});

test('performDataMigrationRestoreSync restores valid backup when current sqlite is unreadable', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeFile(path.join(targetUserData, DB_FILENAME), 'not a sqlite database');
  writeFile(path.join(targetUserData, 'old-only.txt'), 'old');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(result?.rollbackPath).toBeTruthy();
  expect(fs.existsSync(result?.rollbackPath || '')).toBe(true);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('source-refresh');
  expect(fs.existsSync(path.join(targetUserData, 'old-only.txt'))).toBe(false);
});

test('performPendingDataMigrationRestoreSync replaces data in place and preserves runtime locks', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeFile(path.join(sourceUserData, 'openclaw', 'state', 'openclaw.json'), '{"source":true}');
  writeFile(path.join(sourceUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'source-backup');
  writeFile(path.join(sourceUserData, 'sqlite-backups', 'lobsterai-latest.sqlite'), 'source-legacy-backup');
  writeFile(path.join(sourceUserData, 'cowork', 'bin', 'node.cmd'), 'source-shim');
  writeFile(path.join(sourceUserData, 'install-timing.log'), 'source-install-log');
  writeFile(path.join(sourceUserData, 'skill-migrate.log'), 'source-skill-migrate-log');
  writeFile(path.join(sourceUserData, 'Dictionaries', 'source.bdic'), 'source-dictionary');
  writeFile(path.join(sourceUserData, 'Local State'), 'source-local-state');
  writeFile(path.join(sourceUserData, 'Local Storage', 'leveldb', 'source.log'), 'source-local-storage');
  writeFile(path.join(sourceUserData, 'Network', 'Cookies'), 'source-network-cookies');
  writeFile(path.join(sourceUserData, 'Preferences'), 'source-preferences');
  writeFile(path.join(sourceUserData, 'Session Storage', 'leveldb', 'source.log'), 'source-session-storage');
  writeFile(path.join(sourceUserData, 'Shared Dictionary', 'source.dict'), 'source-dictionary');
  writeFile(path.join(sourceUserData, 'SharedStorage'), 'source-shared-storage');
  writeFile(path.join(sourceUserData, 'SharedStorage-wal'), 'source-shared-storage-wal');
  writeFile(path.join(sourceUserData, 'openclaw', 'logs', 'gateway-2026-06-10.log'), 'source-gateway-log');
  writeFile(path.join(sourceUserData, 'openclaw', 'state', 'logs', 'commands.log'), 'source-commands-log');
  writeFile(path.join(sourceUserData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'native');
  writeFile(path.join(sourceUserData, 'runtimes', 'python', 'python.exe'), 'source-runtime');
  writeFile(path.join(sourceUserData, `${DB_FILENAME}-wal`), 'source-wal');
  writeFile(path.join(sourceUserData, `${DB_FILENAME}-shm`), 'source-shm');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writeFile(path.join(targetUserData, `${DB_FILENAME}-wal`), 'target-wal');
  writeFile(path.join(targetUserData, `${DB_FILENAME}-shm`), 'target-shm');
  writeFile(path.join(targetUserData, 'old-only.txt'), 'old');
  writeFile(path.join(targetUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'target-backup');
  writeFile(path.join(targetUserData, 'sqlite-backups', 'lobsterai-latest.sqlite'), 'target-legacy-backup');
  writeFile(path.join(targetUserData, 'cowork', 'bin', 'node.cmd'), 'target-shim');
  writeFile(path.join(targetUserData, 'install-timing.log'), 'target-install-log');
  writeFile(path.join(targetUserData, 'skill-migrate.log'), 'target-skill-migrate-log');
  writeFile(path.join(targetUserData, 'Dictionaries', 'target.bdic'), 'target-dictionary');
  writeFile(path.join(targetUserData, 'Local State'), 'target-local-state');
  writeFile(path.join(targetUserData, 'Local Storage', 'leveldb', 'LOCK'), 'target-local-storage-lock');
  writeFile(path.join(targetUserData, 'Network', 'Cookies'), 'runtime-cookies');
  writeFile(path.join(targetUserData, 'Preferences'), 'target-preferences');
  writeFile(path.join(targetUserData, 'Session Storage', 'leveldb', 'LOCK'), 'target-session-storage-lock');
  writeFile(path.join(targetUserData, 'Shared Dictionary', 'target.dict'), 'target-dictionary');
  writeFile(path.join(targetUserData, 'SharedStorage'), 'target-shared-storage');
  writeFile(path.join(targetUserData, 'SharedStorage-wal'), 'target-shared-storage-wal');
  writeFile(path.join(targetUserData, 'openclaw', 'logs', 'gateway-2026-06-10.log'), 'target-gateway-log');
  writeFile(path.join(targetUserData, 'openclaw', 'state', 'logs', 'commands.log'), 'target-commands-log');
  writeFile(path.join(targetUserData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'target-native.node'), 'target-native');
  writeFile(path.join(targetUserData, 'mcp-packages', 'demo', 'node_modules', 'target-native.node'), 'target-top-level-native');
  writeFile(path.join(targetUserData, 'runtimes', 'python', 'python.exe'), 'target-runtime');
  writeFile(path.join(targetUserData, 'updates', 'local-installer.dmg'), 'target-update');
  writeFile(path.join(targetUserData, 'SingletonLock'), 'runtime-lock');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });
  const extractRoot = extractArchive(archivePath);
  writeFile(path.join(extractRoot, 'LobsterAI', 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'legacy-source-backup');
  writeFile(path.join(extractRoot, 'LobsterAI', 'sqlite-backups', 'lobsterai-latest.sqlite'), 'legacy-source-legacy-backup');
  writeFile(path.join(extractRoot, 'LobsterAI', 'cowork', 'bin', 'node.cmd'), 'legacy-source-shim');
  writeFile(path.join(extractRoot, 'LobsterAI', 'install-timing.log'), 'legacy-source-install-log');
  writeFile(path.join(extractRoot, 'LobsterAI', 'skill-migrate.log'), 'legacy-source-skill-migrate-log');
  writeFile(path.join(extractRoot, 'LobsterAI', 'Dictionaries', 'source.bdic'), 'legacy-source-dictionary');
  writeFile(path.join(extractRoot, 'LobsterAI', 'Local Storage', 'leveldb', 'source.log'), 'legacy-source-local-storage');
  writeFile(path.join(extractRoot, 'LobsterAI', 'Preferences'), 'legacy-source-preferences');
  writeFile(path.join(extractRoot, 'LobsterAI', 'Session Storage', 'leveldb', 'source.log'), 'legacy-source-session-storage');
  writeFile(path.join(extractRoot, 'LobsterAI', 'openclaw', 'logs', 'gateway-2026-06-10.log'), 'legacy-source-gateway-log');
  writeFile(path.join(extractRoot, 'LobsterAI', 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'legacy-source-native');
  writeFile(path.join(extractRoot, 'LobsterAI', 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'source-top-level-native');
  writeFile(path.join(extractRoot, 'LobsterAI', 'openclaw', 'state', 'logs', 'commands.log'), 'legacy-source-commands-log');
  writeFile(path.join(extractRoot, 'LobsterAI', 'runtimes', 'python', 'python.exe'), 'legacy-source-runtime');
  writeFile(path.join(extractRoot, 'LobsterAI', 'updates', 'old-installer.dmg'), 'source-update');
  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: extractRoot,
  }, ['LobsterAI']);
  writePendingRestoreRequestSync(targetUserData, archivePath);

  const result = performPendingDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  const rollbackEntries = listArchiveEntries(result?.rollbackPath || '');
  expect(rollbackEntries.some(entry => entry.includes('/backups/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/cowork/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/Dictionaries/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/Local Storage/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/Network/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/openclaw/mcp-packages/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.startsWith('LobsterAI/mcp-packages/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/openclaw/logs/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/openclaw/state/logs/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/runtimes/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.startsWith('LobsterAI/updates/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/sqlite-backups/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.endsWith('/install-timing.log'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.endsWith('/skill-migrate.log'))).toBe(false);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('source-refresh');
  expect(fs.readFileSync(path.join(targetUserData, 'openclaw', 'state', 'openclaw.json'), 'utf8')).toBe('{"source":true}');
  expect(fs.existsSync(path.join(targetUserData, `${DB_FILENAME}-wal`))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, `${DB_FILENAME}-shm`))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, 'old-only.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(targetUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'utf8'))
    .toBe('target-backup');
  expect(fs.readFileSync(path.join(targetUserData, 'sqlite-backups', 'lobsterai-latest.sqlite'), 'utf8'))
    .toBe('target-legacy-backup');
  expect(fs.readFileSync(path.join(targetUserData, 'cowork', 'bin', 'node.cmd'), 'utf8')).toBe('target-shim');
  expect(fs.readFileSync(path.join(targetUserData, 'install-timing.log'), 'utf8')).toBe('target-install-log');
  expect(fs.readFileSync(path.join(targetUserData, 'skill-migrate.log'), 'utf8')).toBe('target-skill-migrate-log');
  expect(fs.readFileSync(path.join(targetUserData, 'Dictionaries', 'target.bdic'), 'utf8'))
    .toBe('target-dictionary');
  expect(fs.readFileSync(path.join(targetUserData, 'Local State'), 'utf8')).toBe('target-local-state');
  expect(fs.readFileSync(path.join(targetUserData, 'Local Storage', 'leveldb', 'LOCK'), 'utf8'))
    .toBe('target-local-storage-lock');
  expect(fs.readFileSync(path.join(targetUserData, 'Network', 'Cookies'), 'utf8')).toBe('runtime-cookies');
  expect(fs.readFileSync(path.join(targetUserData, 'Preferences'), 'utf8')).toBe('target-preferences');
  expect(fs.readFileSync(path.join(targetUserData, 'Session Storage', 'leveldb', 'LOCK'), 'utf8'))
    .toBe('target-session-storage-lock');
  expect(fs.readFileSync(path.join(targetUserData, 'Shared Dictionary', 'target.dict'), 'utf8'))
    .toBe('target-dictionary');
  expect(fs.readFileSync(path.join(targetUserData, 'SharedStorage'), 'utf8')).toBe('target-shared-storage');
  expect(fs.readFileSync(path.join(targetUserData, 'SharedStorage-wal'), 'utf8')).toBe('target-shared-storage-wal');
  expect(fs.readFileSync(path.join(targetUserData, 'openclaw', 'logs', 'gateway-2026-06-10.log'), 'utf8'))
    .toBe('target-gateway-log');
  expect(fs.readFileSync(path.join(targetUserData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'target-native.node'), 'utf8'))
    .toBe('target-native');
  expect(fs.readFileSync(path.join(targetUserData, 'mcp-packages', 'demo', 'node_modules', 'target-native.node'), 'utf8'))
    .toBe('target-top-level-native');
  expect(fs.existsSync(path.join(targetUserData, 'mcp-packages', 'demo', 'node_modules', 'native.node'))).toBe(false);
  expect(fs.readFileSync(path.join(targetUserData, 'openclaw', 'state', 'logs', 'commands.log'), 'utf8'))
    .toBe('target-commands-log');
  expect(fs.readFileSync(path.join(targetUserData, 'runtimes', 'python', 'python.exe'), 'utf8')).toBe('target-runtime');
  expect(fs.readFileSync(path.join(targetUserData, 'updates', 'local-installer.dmg'), 'utf8')).toBe('target-update');
  expect(fs.existsSync(path.join(targetUserData, 'updates', 'old-installer.dmg'))).toBe(false);
  expect(fs.readFileSync(path.join(targetUserData, 'SingletonLock'), 'utf8')).toBe('runtime-lock');
});

test('performPendingDataMigrationRestoreSync keeps existing data when restore fails', () => {
  const root = makeTempDir();
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'missing-backup.tar.gz');

  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writePendingRestoreRequestSync(targetUserData, archivePath);

  const result = performPendingDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Failed);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('target-refresh');
});

test('performDataMigrationRestoreSync rolls back when the backup is missing sqlite data', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  const sourceParent = path.dirname(sourceUserData);
  writeFile(path.join(sourceUserData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');
  writeManifestFixture(sourceUserData);
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: sourceParent,
  }, ['LobsterAI']);

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Failed);
  expect(result?.error).toContain(`missing ${DB_FILENAME}`);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('target-refresh');
  expect(fs.existsSync(path.join(targetUserData, 'SKILLs', 'demo', 'SKILL.md'))).toBe(false);
});

test('performDataMigrationRestoreSync rejects unreadable backup sqlite before touching target data', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  const sourceParent = path.dirname(sourceUserData);
  writeFile(path.join(sourceUserData, DB_FILENAME), 'not a sqlite database');
  writeFile(path.join(sourceUserData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');
  writeManifestFixture(sourceUserData);
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writeFile(path.join(targetUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'target-backup');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: sourceParent,
  }, ['LobsterAI']);

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Failed);
  expect(result?.error).toContain(`unreadable ${DB_FILENAME}`);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('target-refresh');
  expect(fs.readFileSync(path.join(targetUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'utf8'))
    .toBe('target-backup');
  expect(fs.existsSync(path.join(targetUserData, 'SKILLs', 'demo', 'SKILL.md'))).toBe(false);
});

const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const writeRichDshSqliteFixture = (
  dbPath: string,
  userDataPath: string,
  options: {
    dshSessionId?: string;
    includeBindingsTable?: boolean;
    includeLegacyOpenClawEngine?: boolean;
  } = {},
): void => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(dbPath, { force: true });

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        agent_id TEXT DEFAULT 'main',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, system_prompt TEXT DEFAULT '', identity TEXT DEFAULT '');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, config_json TEXT);
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        install_dir TEXT,
        command TEXT,
        args_json TEXT
      );
      CREATE TABLE user_plugins (plugin_id TEXT PRIMARY KEY);
      CREATE TABLE user_memories (id TEXT PRIMARY KEY);
      CREATE TABLE user_memory_sources (id TEXT PRIMARY KEY);
      CREATE TABLE subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        session_key TEXT,
        child_cowork_session_id TEXT,
        agent_id TEXT,
        label TEXT,
        task TEXT,
        status TEXT,
        created_at INTEGER,
        completed_at INTEGER
      );
      CREATE TABLE subagent_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        type TEXT,
        content TEXT,
        metadata TEXT,
        created_at INTEGER
      );
      CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE im_session_mappings (im_conversation_id TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (im_conversation_id, platform));
      CREATE TABLE scheduled_task_meta (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, binding TEXT NOT NULL);
    `);

    if (options.includeBindingsTable !== false) {
      db.exec(`
        CREATE TABLE dsh_subagent_agent_bindings (
          child_session_id TEXT PRIMARY KEY,
          parent_dsh_session_id TEXT NOT NULL,
          root_cowork_session_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    }

    const now = Date.now();
    const insertKv = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    insertKv.run('auth_tokens', JSON.stringify({ accessToken: 'tok-access', refreshToken: 'tok-refresh' }), now);
    insertKv.run('app_config', JSON.stringify({ providers: { custom: { enabled: true, apiKey: 'sk-test' } } }), now);
    if (options.includeLegacyOpenClawEngine) {
      insertKv.run('cowork.agent_engine', 'openclaw', now);
    } else {
      insertKv.run('cowork.agent_engine', 'dsh', now);
      insertKv.run(MIGRATION_V2_COMPLETED_KV_KEY, JSON.stringify({ migratedAt: new Date(now).toISOString(), freshInstall: true }), now);
    }

    const dshSessionId = options.dshSessionId ?? 'dsh-sess-1';
    const storedSessionId = options.includeLegacyOpenClawEngine ? 'legacy-oc-sess' : `dsh:${dshSessionId}`;
    db.prepare(
      'INSERT INTO cowork_sessions (id, title, claude_session_id, status, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('cowork-sess-1', 'Backup Test Session', storedSessionId, 'completed', 'main', now, now);

    const originalImgPath = path.join(userDataPath, 'cowork-image-originals', 'cowork-sess-1', 'photo.png');
    const generatedImgPath = path.join(userDataPath, 'generated-images', 'cowork-sess-1', 'render.png');
    const generatedVidPath = path.join(userDataPath, 'generated-videos', 'cowork-sess-1', 'clip.mp4');
    const workspaceMemoryPath = path.join(userDataPath, 'workspaces', 'main', 'MEMORY.md');
    const skillPath = path.join(userDataPath, 'SKILLs', 'demo', 'SKILL.md');
    const userProjectFile = '/Users/alice/projects/my-app/README.md';

    db.prepare(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'msg-user-1',
      'cowork-sess-1',
      'user',
      'Check my image and files',
      JSON.stringify({
        imageAttachmentPreviews: [
          {
            name: 'photo.png',
            retainedOriginalPath: originalImgPath,
            localPath: userProjectFile,
            isPreview: true,
          },
        ],
        ...(options.includeLegacyOpenClawEngine
          ? {}
          : {
            historyImageReferences: [
              { name: 'photo.png', path: originalImgPath, previewOnly: false },
            ],
          }),
        localMediaAttachments: [
          { localPath: originalImgPath, mimeType: 'image/png', name: 'photo.png' },
        ],
        attachments: [
          { path: workspaceMemoryPath, name: 'MEMORY.md' },
          { path: skillPath, name: 'SKILL.md' },
          { path: userProjectFile, name: 'README.md' },
        ],
      }),
      now,
    );

    db.prepare(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'msg-tool-1',
      'cowork-sess-1',
      'tool_result',
      'Generated media',
      JSON.stringify({
        toolResultDetails: {
          mediaType: 'image',
          resultUrls: [`file://${generatedImgPath.replace(/\\/g, '/')}`],
          assets: [
            {
              filePath: generatedImgPath,
              localPath: generatedImgPath,
              url: `file://${generatedImgPath.replace(/\\/g, '/')}`,
            },
          ],
        },
        mediaStatusDetails: {
          mediaType: 'video',
          assets: [{ filePath: generatedVidPath }],
        },
      }),
      now + 1,
    );

    db.prepare('INSERT INTO agents (id) VALUES (?)').run('main');
    if (options.includeBindingsTable !== false) {
      db.prepare(
        'INSERT INTO dsh_subagent_agent_bindings (child_session_id, parent_dsh_session_id, root_cowork_session_id, target_agent_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('child-dsh-1', dshSessionId, 'cowork-sess-1', 'writer', now);
    }
  } finally {
    db.close();
  }
};

test('v2 backup excludes dsh-profile/cache and memory-fts.sqlite*, validates dshState, and rewrites userData paths on independent restore', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source-profile', 'LobsterAI');
  const targetUserData = path.join(root, 'independent-target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'dsh-v2-backup.tar.gz');

  writeRichDshSqliteFixture(path.join(sourceUserData, DB_FILENAME), sourceUserData);

  // Populate DSH profile + sessions + excluded caches
  writeFile(path.join(sourceUserData, 'dsh-profile', 'profiles', 'lobsterai', 'package.json'), '{"name":"lobsterai-dsh-profile"}');
  writeFile(path.join(sourceUserData, 'dsh-profile', 'profiles', 'lobsterai', 'cordis.patch.yml'), '[]\n');
  writeFile(path.join(sourceUserData, 'dsh-profile', 'sessions', 'proj-1', 'sess-a', 'v4-0001.jsonl'), '{"type":"session/start"}\n');
  writeFile(path.join(sourceUserData, 'dsh-profile', 'sessions', 'proj-1', 'sess-b', 'v4-0001.jsonl'), '{"type":"session/start"}\n');
  writeFile(path.join(sourceUserData, 'dsh-profile', 'cache', 'pnpm-store', 'huge-cache.bin'), 'pnpm-bloat');
  writeFile(path.join(sourceUserData, 'dsh-profile', 'cache', 'npm-cache', 'index.json'), '{"cached":true}');
  writeFile(path.join(sourceUserData, 'dsh-profile', 'bin', 'dsh'), '#!/bin/sh\n');

  // Populate media & skills files referenced by cowork_messages.metadata
  fs.mkdirSync(path.join(sourceUserData, 'cowork-image-originals', 'cowork-sess-1'), { recursive: true });
  fs.writeFileSync(path.join(sourceUserData, 'cowork-image-originals', 'cowork-sess-1', 'photo.png'), TINY_PNG_BYTES);
  fs.mkdirSync(path.join(sourceUserData, 'generated-images', 'cowork-sess-1'), { recursive: true });
  fs.writeFileSync(path.join(sourceUserData, 'generated-images', 'cowork-sess-1', 'render.png'), TINY_PNG_BYTES);
  writeFile(path.join(sourceUserData, 'generated-videos', 'cowork-sess-1', 'clip.mp4'), 'mp4-bytes');
  writeFile(path.join(sourceUserData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo Skill');

  // Populate workspaces/main/MEMORY.md and open FTS5 index, then close cleanly
  const sourceMemory = new LobsterMemoryService(path.join(sourceUserData, 'workspaces'));
  sourceMemory.addMemory('main', 'Remember lobster backup code: CORAL-2026', 'Backup');
  sourceMemory.appendDailyNote('main', 'Daily backup note', new Date('2026-11-20T00:00:00Z'));
  expect(sourceMemory.search('main', 'CORAL-2026')).toHaveLength(1);
  // Simulate WAL sidecars existing beside memory-fts.sqlite
  writeFile(path.join(sourceUserData, 'workspaces', `${MEMORY_FTS_DB_NAME}-wal`), 'wal-stub');
  writeFile(path.join(sourceUserData, 'workspaces', `${MEMORY_FTS_DB_NAME}-shm`), 'shm-stub');
  sourceMemory.close();

  // Pre-seed targetUserData with stale memory + open-and-closed FTS index to ensure stale FTS is cleared on restore
  const targetOldMemory = new LobsterMemoryService(path.join(targetUserData, 'workspaces'));
  targetOldMemory.addMemory('main', 'Stale target memory that must disappear after restore');
  expect(targetOldMemory.search('main', 'Stale target')).toHaveLength(1);
  targetOldMemory.close();
  writeFile(path.join(targetUserData, 'dsh-profile', 'cache', 'pnpm-store', 'local-target-cache.bin'), 'keep-local-cache');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  // Verify archive exclusions & manifest v2 metadata
  const entries = listArchiveEntries(archivePath);
  expect(entries.some(e => e.includes('/dsh-profile/cache/'))).toBe(false);
  expect(entries.some(e => e.includes(`/workspaces/${MEMORY_FTS_DB_NAME}`))).toBe(false);
  expect(entries).toContain('LobsterAI/dsh-profile/sessions/proj-1/sess-a/v4-0001.jsonl');
  expect(entries).toContain('LobsterAI/dsh-profile/sessions/proj-1/sess-b/v4-0001.jsonl');
  expect(entries).toContain('LobsterAI/workspaces/main/MEMORY.md');

  const extractRoot = extractArchive(archivePath);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extractRoot, 'LobsterAI', '.lobsterai-migration.json'), 'utf8'),
  ) as {
    version?: number;
    sourceUserDataPath?: string;
    sqlite?: { tableContentChecksums?: Record<string, string> };
    dshState?: DshStateMigrationSummary;
  };
  expect(manifest.version).toBe(2);
  expect(manifest.sourceUserDataPath).toBe(path.resolve(sourceUserData));
  expect(manifest.sqlite?.tableContentChecksums?.dsh_subagent_agent_bindings).toBeTruthy();
  expect(manifest.dshState).toMatchObject({
    exists: true,
    sessionCount: 2,
    sessionFileCount: 2,
    profileConfigExists: true,
    workspacesExist: true,
    workspaceAgentIds: ['main'],
  });
  expect(manifest.dshState?.checksumSha256).toBeTruthy();
  expect(manifest.dshState?.workspaceChecksumSha256).toBeTruthy();

  // Restore into independent targetUserData
  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-11-21T10:00:00Z'),
  });
  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);

  // Verify preserved DSH sessions, workspace files, subagent bindings, and target local cache
  expect(fs.existsSync(path.join(targetUserData, 'dsh-profile', 'sessions', 'proj-1', 'sess-a', 'v4-0001.jsonl'))).toBe(true);
  expect(fs.readFileSync(path.join(targetUserData, 'workspaces', 'main', 'MEMORY.md'), 'utf8')).toContain('CORAL-2026');
  expect(fs.readFileSync(path.join(targetUserData, 'dsh-profile', 'cache', 'pnpm-store', 'local-target-cache.bin'), 'utf8'))
    .toBe('keep-local-cache');
  expect(readSqliteString(
    path.join(targetUserData, DB_FILENAME),
    'SELECT target_agent_id FROM dsh_subagent_agent_bindings WHERE child_session_id = ?',
    ['child-dsh-1'],
  )).toBe('writer');

  // Verify stale FTS DB was deleted on restore and rebuilds cleanly from restored MEMORY.md
  expect(fs.existsSync(path.join(targetUserData, 'workspaces', MEMORY_FTS_DB_NAME))).toBe(false);
  const restoredMemory = new LobsterMemoryService(path.join(targetUserData, 'workspaces'));
  try {
    expect(restoredMemory.search('main', 'Stale target')).toHaveLength(0);
    expect(restoredMemory.search('main', 'CORAL-2026')).toHaveLength(1);
  } finally {
    restoredMemory.close();
  }

  // Verify userData-rooted media/workspace/skill paths were rewritten to targetUserData, while user cwd path stayed intact
  const userMsgMeta = JSON.parse(
    readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT metadata FROM cowork_messages WHERE id = ?', ['msg-user-1']),
  ) as {
    imageAttachmentPreviews: Array<{ retainedOriginalPath: string; localPath: string }>;
    historyImageReferences: Array<{ path: string }>;
    localMediaAttachments: Array<{ localPath: string }>;
    attachments: Array<{ path: string }>;
  };
  const expectedTargetOriginal = path.join(targetUserData, 'cowork-image-originals', 'cowork-sess-1', 'photo.png');
  expect(userMsgMeta.imageAttachmentPreviews[0].retainedOriginalPath).toBe(expectedTargetOriginal);
  expect(userMsgMeta.imageAttachmentPreviews[0].localPath).toBe('/Users/alice/projects/my-app/README.md');
  expect(userMsgMeta.historyImageReferences[0].path).toBe(expectedTargetOriginal);
  expect(userMsgMeta.localMediaAttachments[0].localPath).toBe(expectedTargetOriginal);
  expect(fs.existsSync(userMsgMeta.historyImageReferences[0].path)).toBe(true);
  expect(userMsgMeta.attachments[0].path).toBe(path.join(targetUserData, 'workspaces', 'main', 'MEMORY.md'));
  expect(userMsgMeta.attachments[1].path).toBe(path.join(targetUserData, 'SKILLs', 'demo', 'SKILL.md'));
  expect(userMsgMeta.attachments[2].path).toBe('/Users/alice/projects/my-app/README.md');

  const toolMsgMeta = JSON.parse(
    readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT metadata FROM cowork_messages WHERE id = ?', ['msg-tool-1']),
  ) as {
    toolResultDetails: { assets: Array<{ filePath: string; url: string }>; resultUrls: string[] };
    mediaStatusDetails: { assets: Array<{ filePath: string }> };
  };
  const expectedTargetGenImg = path.join(targetUserData, 'generated-images', 'cowork-sess-1', 'render.png');
  expect(toolMsgMeta.toolResultDetails.assets[0].filePath).toBe(expectedTargetGenImg);
  expect(fs.existsSync(toolMsgMeta.toolResultDetails.assets[0].filePath)).toBe(true);
  expect(toolMsgMeta.toolResultDetails.assets[0].url).toContain(encodeURIComponent('independent-target'));
  expect(toolMsgMeta.mediaStatusDetails.assets[0].filePath)
    .toBe(path.join(targetUserData, 'generated-videos', 'cowork-sess-1', 'clip.mp4'));
});

test('inspectMigrationArchive rejects tampered v2 dsh-profile or workspaces content', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const archivePath = path.join(root, 'valid-v2.tar.gz');
  const tamperedDshArchive = path.join(root, 'tampered-dsh.tar.gz');
  const tamperedWorkspaceArchive = path.join(root, 'tampered-workspace.tar.gz');

  writeRichDshSqliteFixture(path.join(sourceUserData, DB_FILENAME), sourceUserData);
  writeFile(path.join(sourceUserData, 'dsh-profile', 'sessions', 'proj', 's1', 'v4.jsonl'), '{"ok":true}\n');
  writeFile(path.join(sourceUserData, 'workspaces', 'main', 'MEMORY.md'), '# User Memories\n\n- Original\n');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  // Tamper dsh-profile session file
  const extract1 = extractArchive(archivePath);
  writeFile(path.join(extract1, 'LobsterAI', 'dsh-profile', 'sessions', 'proj', 's1', 'v4.jsonl'), '{"ok":false}\n');
  tar.create({ sync: true, gzip: true, file: tamperedDshArchive, cwd: extract1 }, ['LobsterAI']);
  expect(() => inspectMigrationArchiveSync(tamperedDshArchive)).toThrow(/DSH state .*mismatch/);

  // Tamper workspaces/main/MEMORY.md
  const extract2 = extractArchive(archivePath);
  writeFile(path.join(extract2, 'LobsterAI', 'workspaces', 'main', 'MEMORY.md'), '# User Memories\n\n- Tampered\n');
  tar.create({ sync: true, gzip: true, file: tamperedWorkspaceArchive, cwd: extract2 }, ['LobsterAI']);
  expect(() => inspectMigrationArchiveSync(tamperedWorkspaceArchive)).toThrow(/DSH state .*mismatch/);

  // Missing dshState in v2 manifest is rejected
  const missingDshStateArchive = path.join(root, 'missing-dsh-state.tar.gz');
  const extract3 = extractArchive(archivePath);
  const manifestPath3 = path.join(extract3, 'LobsterAI', '.lobsterai-migration.json');
  const manifest3 = JSON.parse(fs.readFileSync(manifestPath3, 'utf8')) as Record<string, unknown>;
  delete manifest3.dshState;
  fs.writeFileSync(manifestPath3, `${JSON.stringify(manifest3, null, 2)}\n`, 'utf8');
  tar.create({ sync: true, gzip: true, file: missingDshStateArchive, cwd: extract3 }, ['LobsterAI']);
  expect(() => inspectMigrationArchiveSync(missingDshStateArchive)).toThrow(/missing DSH state summary/);

  // Backward compatibility: older manifests omitting dsh_subagent_agent_bindings checksum still validate
  const compatArchive = path.join(root, 'compat-no-bindings-checksum.tar.gz');
  const extract4 = extractArchive(archivePath);
  const manifestPath4 = path.join(extract4, 'LobsterAI', '.lobsterai-migration.json');
  const manifest4 = JSON.parse(fs.readFileSync(manifestPath4, 'utf8')) as {
    sqlite?: { tableContentChecksums?: Record<string, string> };
  };
  delete manifest4.sqlite?.tableContentChecksums?.dsh_subagent_agent_bindings;
  fs.writeFileSync(manifestPath4, `${JSON.stringify(manifest4, null, 2)}\n`, 'utf8');
  tar.create({ sync: true, gzip: true, file: compatArchive, cwd: extract4 }, ['LobsterAI']);
  expect(inspectMigrationArchiveSync(compatArchive).hasSqliteDatabase).toBe(true);
});

test('legacy v1 OpenClaw backup restores into v2 userData and runs runLegacyOpenClawMigration cleanly', () => {
  const root = makeTempDir();
  const legacySourceUserData = path.join(root, 'legacy-v1-machine', 'LobsterAI');
  const targetUserData = path.join(root, 'new-v2-machine', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const v2SeedArchive = path.join(root, 'seed.tar.gz');
  const v1ArchivePath = path.join(root, 'legacy-v1-backup.tar.gz');

  // Seed legacy OpenClaw v1 state without dsh_subagent_agent_bindings or dsh-profile
  writeRichDshSqliteFixture(path.join(legacySourceUserData, DB_FILENAME), legacySourceUserData, {
    includeBindingsTable: false,
    includeLegacyOpenClawEngine: true,
  });
  writeFile(path.join(legacySourceUserData, 'openclaw', 'state', 'openclaw.json'), JSON.stringify({ agents: {} }));
  writeFile(
    path.join(legacySourceUserData, 'openclaw', 'state', 'workspace-main', 'MEMORY.md'),
    '# User Memories\n\n- Legacy OpenClaw fact: NEPTUNE-V1-MIGRATED\n',
  );
  writeFile(
    path.join(legacySourceUserData, 'openclaw', 'state', 'cron', 'jobs.json'),
    JSON.stringify({
      jobs: [
        {
          id: 'legacy-daily-brief',
          name: 'Daily Brief',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          payload: { kind: 'agentTurn', message: 'Summarize today' },
          delivery: { mode: 'none' },
        },
      ],
    }),
  );
  fs.mkdirSync(path.join(legacySourceUserData, 'cowork-image-originals', 'cowork-sess-1'), { recursive: true });
  fs.writeFileSync(path.join(legacySourceUserData, 'cowork-image-originals', 'cowork-sess-1', 'photo.png'), TINY_PNG_BYTES);

  // Create archive then rewrite manifest to genuine v1 schema (version: 1, no dshState, no sourceUserDataPath, no dsh_subagent_agent_bindings checksum)
  createMigrationArchiveSync({ userDataPath: legacySourceUserData, outputPath: v2SeedArchive });
  const extractedSeed = extractArchive(v2SeedArchive);
  const manifestPath = path.join(extractedSeed, 'LobsterAI', '.lobsterai-migration.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.version = 1;
  delete manifest.dshState;
  delete manifest.sourceUserDataPath;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  tar.create({ sync: true, gzip: true, file: v1ArchivePath, cwd: extractedSeed }, ['LobsterAI']);

  // Inspect must accept v1 cleanly
  expect(inspectMigrationArchiveSync(v1ArchivePath).hasSqliteDatabase).toBe(true);

  // Restore into a fresh v2 userData directory
  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath: v1ArchivePath,
    now: new Date('2026-11-21T11:00:00Z'),
  });
  expect(result?.error).toBeUndefined();
  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);

  // Verify runLegacyOpenClawMigration produced a valid v2 state
  const targetDbPath = path.join(targetUserData, DB_FILENAME);
  expect(readSqliteString(targetDbPath, 'SELECT value FROM kv WHERE key = ?', ['cowork.agent_engine'])).toBe('dsh');
  expect(readSqliteString(targetDbPath, 'SELECT value FROM kv WHERE key = ?', [MIGRATION_V2_COMPLETED_KV_KEY])).toBeTruthy();

  // Workspaces migrated from openclaw/state/workspace-main -> workspaces/main
  expect(fs.readFileSync(path.join(targetUserData, 'workspaces', 'main', 'MEMORY.md'), 'utf8'))
    .toContain('NEPTUNE-V1-MIGRATED');
  expect(fs.existsSync(path.join(targetUserData, 'openclaw'))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, 'legacy-openclaw-backup'))).toBe(true);

  // Scheduled task migrated into lobster_scheduled_tasks
  expect(readSqliteString(targetDbPath, 'SELECT name FROM lobster_scheduled_tasks WHERE id = ?', ['legacy-daily-brief']))
    .toBe('Daily Brief');

  // Legacy conversation image migrated with rewritten targetUserData path
  const migratedUserMeta = JSON.parse(
    readSqliteString(targetDbPath, 'SELECT metadata FROM cowork_messages WHERE id = ?', ['msg-user-1']),
  ) as {
    historyImageReferences?: Array<{ name: string; path: string; previewOnly: boolean }>;
  };
  expect(migratedUserMeta.historyImageReferences).toHaveLength(1);
  expect(migratedUserMeta.historyImageReferences?.[0].previewOnly).toBe(false);
  expect(migratedUserMeta.historyImageReferences?.[0].path.startsWith(path.join(targetUserData, 'cowork-image-originals'))).toBe(true);
  expect(fs.readFileSync(migratedUserMeta.historyImageReferences![0].path)).toEqual(TINY_PNG_BYTES);
});

test('clearRestorableUserDataSync retries transient EBUSY errors during restore', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeFile(path.join(sourceUserData, 'workspaces', 'main', 'MEMORY.md'), '# Source Memory\n');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writeFile(path.join(targetUserData, 'workspaces', 'main', 'MEMORY.md'), '# Target Memory\n');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  const realRmSync = fs.rmSync.bind(fs);
  const targetWorkspacesPath = path.join(targetUserData, 'workspaces');
  let ebusyFailures = 0;
  const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((targetPath, options) => {
    if (String(targetPath) === targetWorkspacesPath && ebusyFailures < 2) {
      ebusyFailures += 1;
      const err = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      throw err;
    }
    return realRmSync(targetPath, options);
  });

  try {
    const result = performDataMigrationRestoreSync({
      userDataPath: targetUserData,
      rollbackRootPath: rollbackRoot,
      archivePath,
      now: new Date('2026-11-21T12:00:00Z'),
    });
    expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
    expect(ebusyFailures).toBe(2);
    expect(fs.readFileSync(path.join(targetUserData, 'workspaces', 'main', 'MEMORY.md'), 'utf8'))
      .toContain('Source Memory');
  } finally {
    rmSpy.mockRestore();
  }
});

interface MockOpenAiCapturedRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
}

const startMockOpenAiServer = async (): Promise<{
  baseUrl: string;
  requests: MockOpenAiCapturedRequest[];
  close: () => Promise<void>;
}> => {
  const requests: MockOpenAiCapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      let body: MockOpenAiCapturedRequest = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MockOpenAiCapturedRequest;
      } catch {
        // ignore malformed test payload
      }
      requests.push(body);

      const serializedMessages = JSON.stringify(body.messages ?? []);
      const replyText = serializedMessages.includes('AURORA-BACKUP-7492')
        ? 'Your secret verification code is AURORA-BACKUP-7492.'
        : 'I have noted that.';

      if (body.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const id = `chatcmpl-${requests.length}`;
        const created = Math.floor(Date.now() / 1000);
        const firstChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model ?? 'mock-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }],
        };
        const endChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model ?? 'mock-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
        };
        res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
        res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-${requests.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock OpenAI HTTP server');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
};

const runRealDshTurn = async (
  host: DshHostManager,
  sessionId: string,
  promptText: string,
): Promise<void> => {
  const client = host.getClient();
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error(`Timed out waiting for DSH turn/end for session ${sessionId}`));
  }, 25_000);

  try {
    const followStream = client.followSession<Record<string, unknown>>(
      {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        activate: true,
      },
      abortController.signal,
    );

    const waitForTurnEnd = (async () => {
      for await (const frame of followStream) {
        const ev = (frame.type === 'event' ? frame.event : frame) as Record<string, unknown> | undefined;
        if (ev && typeof ev === 'object' && ev.type === 'turn/end') {
          return;
        }
      }
    })();

    await client.promptSession({
      sessionId,
      requestId: crypto.randomUUID(),
      content: [{ type: 'text', text: promptText }],
      mode: 'queue',
    });

    await waitForTurnEnd;
  } finally {
    clearTimeout(timeout);
    abortController.abort();
  }
};

const bundledDshPaths = resolveBundledDshPaths({
  isPackaged: false,
  appRootDir: process.cwd(),
});
const hasBundledDshRuntime = fs.existsSync(path.join(bundledDshPaths.runtimeDir, 'lib', 'bin.js'));

test.skipIf(!hasBundledDshRuntime)(
  'real DSH runtime E2E: backup userDataA -> restore into clean userDataB -> resumed DSH session preserves turn-1 history',
  async () => {
    const root = makeTempDir();
    const userDataA = path.join(root, 'userDataA', 'LobsterAI');
    const userDataB = path.join(root, 'userDataB', 'LobsterAI');
    const rollbackRoot = path.join(root, 'rollbacks');
    const workDir = path.join(root, 'workspace-project');
    const archivePath = path.join(root, 'dsh-e2e-backup.tar.gz');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.join(userDataA, 'SKILLs'), { recursive: true });

    const mockOpenAi = await startMockOpenAiServer();
    let hostA: DshHostManager | null = null;
    let hostB: DshHostManager | null = null;

    try {
      // 1. Boot real DshHostManager on userDataA and run Turn 1 with a memorable fact
      hostA = new DshHostManager({
        userDataDir: userDataA,
        runtimeDir: bundledDshPaths.runtimeDir,
        hostBundleDir: bundledDshPaths.hostBundleDir,
        skillsDir: path.join(userDataA, 'SKILLs'),
        executablePath: process.execPath,
        skipElectronRunAsNode: true,
      });
      await hostA.start();
      await hostA.syncProviders({
        providers: [
          {
            id: 'mock-openai',
            displayName: 'Mock OpenAI',
            api: 'openai-completions',
            baseURL: mockOpenAi.baseUrl,
            apiKey: 'mock-key',
            models: [
              {
                id: 'mock-model',
                name: 'Mock Model',
                contextWindow: 128_000,
                maxTokens: 4_096,
                input: ['text'],
              },
            ],
          },
        ],
      });

      const created = await hostA.getClient().createSession({ cwd: workDir });
      const dshSessionId = created.sessionId;
      await hostA.getClient().selectModel({
        sessionId: dshSessionId,
        provider: 'mock-openai',
        model: 'mock-model',
      });

      await runRealDshTurn(
        hostA,
        dshSessionId,
        'Remember my secret verification code: AURORA-BACKUP-7492.',
      );

      // Seed SQLite + memory + rebuildable cache in userDataA before backup
      writeRichDshSqliteFixture(path.join(userDataA, DB_FILENAME), userDataA, { dshSessionId });
      fs.mkdirSync(path.join(userDataA, 'cowork-image-originals', 'cowork-sess-1'), { recursive: true });
      fs.writeFileSync(path.join(userDataA, 'cowork-image-originals', 'cowork-sess-1', 'photo.png'), TINY_PNG_BYTES);
      writeFile(path.join(userDataA, 'dsh-profile', 'cache', 'pnpm-store', 'bloat.bin'), 'skip-me');

      const memoryA = new LobsterMemoryService(path.join(userDataA, 'workspaces'));
      memoryA.addMemory('main', 'Fact stored in workspace memory: AURORA-BACKUP-7492');
      expect(memoryA.search('main', 'AURORA-BACKUP-7492')).toHaveLength(1);
      memoryA.close();

      // Stop hostA cleanly so DSH flushes JSONL session persistence files
      await hostA.stop();
      hostA = null;

      // 2. Create v2 backup archive from userDataA
      createMigrationArchiveSync({
        userDataPath: userDataA,
        outputPath: archivePath,
      });

      const entries = listArchiveEntries(archivePath);
      expect(entries.some(e => e.includes('/dsh-profile/cache/'))).toBe(false);
      expect(entries.some(e => e.includes(`/workspaces/${MEMORY_FTS_DB_NAME}`))).toBe(false);
      expect(entries.some(e => e.includes('/dsh-profile/sessions/'))).toBe(true);

      const extractedCheck = extractArchive(archivePath);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(extractedCheck, 'LobsterAI', '.lobsterai-migration.json'), 'utf8'),
      ) as { version?: number; dshState?: DshStateMigrationSummary };
      expect(manifest.version).toBe(2);
      expect(manifest.dshState?.exists).toBe(true);
      expect(manifest.dshState?.sessionCount).toBeGreaterThanOrEqual(1);
      expect(manifest.dshState?.workspacesExist).toBe(true);

      // 3. Restore archive into a brand new clean userDataB
      const restoreResult = performDataMigrationRestoreSync({
        userDataPath: userDataB,
        rollbackRootPath: rollbackRoot,
        archivePath,
        now: new Date('2026-11-21T13:00:00Z'),
      });
      expect(restoreResult?.status).toBe(DataMigrationRestoreStatus.Success);

      // Verify media path rewritten to userDataB and workspace FTS rebuilds cleanly
      const restoredMeta = JSON.parse(
        readSqliteString(path.join(userDataB, DB_FILENAME), 'SELECT metadata FROM cowork_messages WHERE id = ?', ['msg-user-1']),
      ) as { historyImageReferences: Array<{ path: string }> };
      expect(restoredMeta.historyImageReferences[0].path)
        .toBe(path.join(userDataB, 'cowork-image-originals', 'cowork-sess-1', 'photo.png'));
      expect(fs.existsSync(restoredMeta.historyImageReferences[0].path)).toBe(true);

      const memoryB = new LobsterMemoryService(path.join(userDataB, 'workspaces'));
      try {
        expect(memoryB.search('main', 'AURORA-BACKUP-7492')).toHaveLength(1);
      } finally {
        memoryB.close();
      }

      // 4. Boot real DshHostManager on userDataB and send Turn 2 on the restored session
      const requestsBeforeTurn2 = mockOpenAi.requests.length;
      hostB = new DshHostManager({
        userDataDir: userDataB,
        runtimeDir: bundledDshPaths.runtimeDir,
        hostBundleDir: bundledDshPaths.hostBundleDir,
        skillsDir: path.join(userDataB, 'SKILLs'),
        executablePath: process.execPath,
        skipElectronRunAsNode: true,
      });
      await hostB.start();
      await hostB.syncProviders({
        providers: [
          {
            id: 'mock-openai',
            displayName: 'Mock OpenAI',
            api: 'openai-completions',
            baseURL: mockOpenAi.baseUrl,
            apiKey: 'mock-key',
            models: [
              {
                id: 'mock-model',
                name: 'Mock Model',
                contextWindow: 128_000,
                maxTokens: 4_096,
                input: ['text'],
              },
            ],
          },
        ],
      });

      await runRealDshTurn(
        hostB,
        dshSessionId,
        'What was my secret verification code?',
      );

      // 5. Assert the Turn 2 LLM request includes the Turn 1 memorable fact from restored DSH session history!
      const turn2Requests = mockOpenAi.requests.slice(requestsBeforeTurn2);
      const turn2ChatRequest = turn2Requests.find(req =>
        JSON.stringify(req.messages ?? []).includes('What was my secret verification code?'),
      );
      expect(turn2ChatRequest).toBeDefined();
      expect(JSON.stringify(turn2ChatRequest?.messages ?? [])).toContain('AURORA-BACKUP-7492');
    } finally {
      await hostA?.stop().catch(() => undefined);
      await hostB?.stop().catch(() => undefined);
      await mockOpenAi.close();
    }
  },
  60_000,
);
