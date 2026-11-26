import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  detectMissingThirdPartyDshPluginsSync,
  type PostRestoreSafeStoragePort,
  sanitizeRestoredStateSync,
} from './postRestoreSanitizer';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-post-restore-sanitizer-test-'));
  tempDirs.push(dir);
  return dir;
};

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const createTestDb = (dbPath: string): Database.Database => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, working_directory TEXT NOT NULL DEFAULT '');
    CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE mcp_launch_resolutions (server_id TEXT PRIMARY KEY, command TEXT);
    CREATE TABLE browser_credentials (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_password BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE lobster_scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  return db;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('postRestoreSanitizer', () => {
  test('clears transient keys, undecryptable cross-machine safeStorage secrets, resets missing default cwd, and detects missing 3rd-party plugins', () => {
    const dir = makeTempDir();
    const targetUserData = path.join(dir, 'target', 'LobsterAI');
    const defaultCwd = path.join(dir, 'default-project');
    fs.mkdirSync(defaultCwd, { recursive: true });
    const dbPath = path.join(targetUserData, 'lobsterai.sqlite');

    const db = createTestDb(dbPath);
    try {
      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        'dsh_cached_shell_path_v1',
        '/Users/alice/.nvm/bin:/usr/bin',
        1,
      );
      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        'browserCredentials.availability',
        JSON.stringify({ available: true }),
        1,
      );
      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        'mcp_oauth_token:srv-remote',
        `safe:${Buffer.from('foreign-device-ciphertext').toString('base64')}`,
        1,
      );
      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        'mcp_oauth_token:srv-b64',
        `b64:${Buffer.from('{"accessToken":"ok"}').toString('base64')}`,
        1,
      );
      db.prepare('INSERT INTO mcp_servers (id, name) VALUES (?, ?)').run('srv-remote', 'Figma Remote');
      db.prepare('INSERT INTO mcp_launch_resolutions (server_id, command) VALUES (?, ?)').run(
        'srv-local',
        '/Users/alice/.local/bin/server',
      );
      db.prepare('INSERT INTO browser_credentials (id, origin, username, encrypted_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('cred-1', 'https://example.com', 'alice', Buffer.from('foreign-blob'), 1, 1);
      db.prepare('INSERT INTO cowork_config (key, value, updated_at) VALUES (?, ?, ?)').run(
        'workingDirectory',
        '/nonexistent/source/project',
        1,
      );
      db.prepare('INSERT INTO agents (id, name, working_directory) VALUES (?, ?, ?)').run(
        'writer',
        'Writer Agent',
        '/nonexistent/writer/dir',
      );
      db.prepare('INSERT INTO lobster_scheduled_tasks (id, name, payload_json) VALUES (?, ?, ?)').run(
        'task-1',
        'Daily Digest',
        JSON.stringify({ kind: 'agentTurn', workingDirectory: '/nonexistent/task/dir' }),
      );
    } finally {
      db.close();
    }

    // Seed DSH profile package.json with managed + 2 third-party plugins (one npm, one local path)
    const profileDir = path.join(targetUserData, 'dsh-profile', 'profiles', 'lobsterai');
    writeFile(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'lobsterai-dsh-profile',
        private: true,
        dependencies: {
          '@lobsterai/dsh-bundle': 'file:/app/dsh-bundles/lobsterai-host',
          'dsh-plugin-weather': '^1.2.0',
          'dsh-plugin-local': 'file:/Users/alice/dev/local-plugin',
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@lobsterai/dsh-bundle', 'dsh-plugin-weather'],
          },
        },
      }),
    );

    const targetSafeStorage: PostRestoreSafeStoragePort = {
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw new Error('Cannot decrypt foreign ciphertext');
      },
    };

    const notices = sanitizeRestoredStateSync({
      dbPath,
      userDataPath: targetUserData,
      sourceUserDataPath: '/Users/alice/Library/Application Support/LobsterAI',
      sourcePlatform: 'darwin',
      defaultWorkingDirectory: defaultCwd,
      safeStorage: targetSafeStorage,
      rewrittenPathCount: 3,
    });

    expect(notices.isCrossMachine).toBe(true);
    expect(notices.rewrittenPathCount).toBe(3);
    expect(notices.clearedBrowserCredentialCount).toBe(1);
    expect(notices.reauthRequiredMcpServers).toEqual([
      { serverId: 'srv-remote', serverName: 'Figma Remote' },
    ]);
    expect(notices.resetDefaultWorkingDirectory).toEqual({
      previous: '/nonexistent/source/project',
      current: defaultCwd,
    });
    expect(notices.missingAgentWorkingDirectories).toEqual([
      { agentId: 'writer', agentName: 'Writer Agent', path: '/nonexistent/writer/dir' },
    ]);
    expect(notices.missingScheduledTaskWorkingDirectories).toEqual([
      { taskId: 'task-1', taskName: 'Daily Digest', path: '/nonexistent/task/dir' },
    ]);
    expect(notices.missingDshPlugins).toEqual([
      { name: 'dsh-plugin-weather', specifier: '^1.2.0', enabled: true, isLocalPath: false },
      { name: 'dsh-plugin-local', specifier: 'file:/Users/alice/dev/local-plugin', enabled: false, isLocalPath: true },
    ]);

    const checkDb = new Database(dbPath, { readonly: true });
    try {
      expect(checkDb.prepare("SELECT value FROM kv WHERE key = 'dsh_cached_shell_path_v1'").get()).toBeUndefined();
      expect(checkDb.prepare("SELECT value FROM kv WHERE key = 'mcp_oauth_token:srv-remote'").get()).toBeUndefined();
      expect(checkDb.prepare("SELECT value FROM kv WHERE key = 'mcp_oauth_token:srv-b64'").get()).toBeDefined();
      expect(checkDb.prepare('SELECT COUNT(*) FROM mcp_launch_resolutions').pluck().get()).toBe(0);
      expect(checkDb.prepare('SELECT COUNT(*) FROM browser_credentials').pluck().get()).toBe(0);
      expect(
        checkDb.prepare("SELECT value FROM cowork_config WHERE key = 'workingDirectory'").pluck().get(),
      ).toBe(defaultCwd);
    } finally {
      checkDb.close();
    }
  });

  test('preserves decryptable safeStorage secrets and installed plugins on same-machine restore', () => {
    const dir = makeTempDir();
    const userData = path.join(dir, 'LobsterAI');
    const dbPath = path.join(userData, 'lobsterai.sqlite');
    const db = createTestDb(dbPath);
    try {
      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        'mcp_oauth_token:srv-1',
        `safe:${Buffer.from('local-cipher').toString('base64')}`,
        1,
      );
      db.prepare('INSERT INTO browser_credentials (id, origin, username, encrypted_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('cred-1', 'https://example.com', 'alice', Buffer.from('local-cipher'), 1, 1);
    } finally {
      db.close();
    }

    const profileDir = path.join(userData, 'dsh-profile', 'profiles', 'lobsterai');
    writeFile(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'lobsterai-dsh-profile',
        private: true,
        dependencies: { 'dsh-plugin-weather': '^1.0.0' },
        dsh: { profile: { bundles: ['dsh-plugin-weather'] } },
      }),
    );
    writeFile(path.join(profileDir, 'node_modules', 'dsh-plugin-weather', 'package.json'), '{}');

    const localSafeStorage: PostRestoreSafeStoragePort = {
      isEncryptionAvailable: () => true,
      decryptString: (buf) => buf.toString('utf8'),
    };

    const notices = sanitizeRestoredStateSync({
      dbPath,
      userDataPath: userData,
      sourceUserDataPath: userData,
      sourcePlatform: process.platform,
      safeStorage: localSafeStorage,
    });

    expect(notices.isCrossMachine).toBe(false);
    expect(notices.clearedBrowserCredentialCount).toBeUndefined();
    expect(notices.reauthRequiredMcpServers).toBeUndefined();
    expect(notices.missingDshPlugins).toBeUndefined();
    expect(detectMissingThirdPartyDshPluginsSync(userData)).toEqual([]);

    const checkDb = new Database(dbPath, { readonly: true });
    try {
      expect(checkDb.prepare('SELECT COUNT(*) FROM browser_credentials').pluck().get()).toBe(1);
      expect(checkDb.prepare("SELECT value FROM kv WHERE key = 'mcp_oauth_token:srv-1'").get()).toBeDefined();
    } finally {
      checkDb.close();
    }
  });
});
