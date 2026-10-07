import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, expect, test } from 'vitest';

import { DataMigrationRestoreStatus } from '../../../shared/dataMigration/constants';
import { DB_FILENAME } from '../../appConstants';
import {
  assertDataMigrationSqliteSnapshotMatchesLiveSync,
  createMigrationArchiveSync,
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
  writeFile(path.join(userData, 'Partitions', 'lobster-artifact-browser', 'Local Storage', 'leveldb', 'LOCK'), 'partition-lock');
  writeFile(path.join(userData, 'Preferences'), 'preferences');
  writeFile(path.join(userData, 'Session Storage', 'leveldb', 'LOCK'), 'session-storage-lock');
  writeFile(path.join(userData, 'Shared Dictionary', 'dict.bin'), 'dictionary');
  writeFile(path.join(userData, 'SharedStorage'), 'shared-storage');
  writeFile(path.join(userData, 'SharedStorage-wal'), 'shared-storage-wal');
  writeFile(path.join(userData, 'logs', 'main.log'), 'log');
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
  expect(entries.some(entry => entry.includes('/Partitions/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Session Storage/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Shared Dictionary/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/openclaw/mcp-packages/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/openclaw/logs/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/openclaw/state/logs/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/backups/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/logs/'))).toBe(false);
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
  writeFile(path.join(sourceUserData, 'Partitions', 'lobster-artifact-browser', 'Local Storage', 'leveldb', 'source.log'), 'source-partition-storage');
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
  writeFile(path.join(targetUserData, 'Partitions', 'lobster-artifact-browser', 'Local Storage', 'leveldb', 'LOCK'), 'target-partition-lock');
  writeFile(path.join(targetUserData, 'Preferences'), 'target-preferences');
  writeFile(path.join(targetUserData, 'Session Storage', 'leveldb', 'LOCK'), 'target-session-storage-lock');
  writeFile(path.join(targetUserData, 'Shared Dictionary', 'target.dict'), 'target-dictionary');
  writeFile(path.join(targetUserData, 'SharedStorage'), 'target-shared-storage');
  writeFile(path.join(targetUserData, 'SharedStorage-wal'), 'target-shared-storage-wal');
  writeFile(path.join(targetUserData, 'openclaw', 'logs', 'gateway-2026-06-10.log'), 'target-gateway-log');
  writeFile(path.join(targetUserData, 'openclaw', 'state', 'logs', 'commands.log'), 'target-commands-log');
  writeFile(path.join(targetUserData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'target-native.node'), 'target-native');
  writeFile(path.join(targetUserData, 'runtimes', 'python', 'python.exe'), 'target-runtime');
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
  writeFile(path.join(extractRoot, 'LobsterAI', 'Partitions', 'lobster-artifact-browser', 'Local Storage', 'leveldb', 'source.log'), 'legacy-source-partition-storage');
  writeFile(path.join(extractRoot, 'LobsterAI', 'Preferences'), 'legacy-source-preferences');
  writeFile(path.join(extractRoot, 'LobsterAI', 'Session Storage', 'leveldb', 'source.log'), 'legacy-source-session-storage');
  writeFile(path.join(extractRoot, 'LobsterAI', 'openclaw', 'logs', 'gateway-2026-06-10.log'), 'legacy-source-gateway-log');
  writeFile(path.join(extractRoot, 'LobsterAI', 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'legacy-source-native');
  writeFile(path.join(extractRoot, 'LobsterAI', 'openclaw', 'state', 'logs', 'commands.log'), 'legacy-source-commands-log');
  writeFile(path.join(extractRoot, 'LobsterAI', 'runtimes', 'python', 'python.exe'), 'legacy-source-runtime');
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
  expect(rollbackEntries.some(entry => entry.includes('/Partitions/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/openclaw/mcp-packages/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/openclaw/logs/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/openclaw/state/logs/'))).toBe(false);
  expect(rollbackEntries.some(entry => entry.includes('/runtimes/'))).toBe(false);
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
  expect(fs.readFileSync(path.join(targetUserData, 'Partitions', 'lobster-artifact-browser', 'Local Storage', 'leveldb', 'LOCK'), 'utf8'))
    .toBe('target-partition-lock');
  expect(fs.existsSync(path.join(targetUserData, 'Partitions', 'lobster-artifact-browser', 'Local Storage', 'leveldb', 'source.log')))
    .toBe(false);
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
  expect(fs.readFileSync(path.join(targetUserData, 'openclaw', 'state', 'logs', 'commands.log'), 'utf8'))
    .toBe('target-commands-log');
  expect(fs.readFileSync(path.join(targetUserData, 'runtimes', 'python', 'python.exe'), 'utf8')).toBe('target-runtime');
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
