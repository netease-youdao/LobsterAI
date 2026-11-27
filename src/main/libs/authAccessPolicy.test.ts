import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { AgentId } from '../../shared/agent';
import {
  AuthAccessPolicy,
  AuthAccessPolicyStoreKey,
  AuthGateErrorCode,
  AuthGateReason,
  AuthSessionChangeReason,
} from '../../shared/auth/constants';
import {
  type AuthAccessPolicyKvPort,
  createAuthRequiredIpcError,
  detectLegacyInstallationInSqlite,
  evaluateAuthAccessState,
  resolveAndPersistAuthAccessPolicy,
} from './authAccessPolicy';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-auth-policy-'));
  tempDirs.push(dir);
  return dir;
}

function createSchemaDb(): { db: Database.Database; kv: AuthAccessPolicyKvPort } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE agents (id TEXT PRIMARY KEY);
    CREATE TABLE mcp_servers (id TEXT PRIMARY KEY);
    CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE lobster_scheduled_tasks (id TEXT PRIMARY KEY);
    CREATE TABLE user_memories (id TEXT PRIMARY KEY);
  `);
  // Fresh installations seed the default main agent and internal migration keys.
  db.prepare('INSERT INTO agents (id) VALUES (?)').run(AgentId.Main);
  db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
    'coworkSessions.scheduledTaskIdBackfill.v1.completed',
    JSON.stringify('1'),
    Date.now(),
  );
  db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
    'userMemories.migration.v1.completed',
    JSON.stringify('1'),
    Date.now(),
  );

  const kv: AuthAccessPolicyKvPort = {
    get<T = unknown>(key: string): T | undefined {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!row) return undefined;
      return JSON.parse(row.value) as T;
    },
    set<T = unknown>(key: string, value: T): void {
      db.prepare(`
        INSERT INTO kv (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), Date.now());
    },
  };

  return { db, kv };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('authAccessPolicy', () => {
  test('classifies a fresh installation as login_required and persists the decision', () => {
    const { db, kv } = createSchemaDb();
    const userDataDir = createTempDir();

    const first = resolveAndPersistAuthAccessPolicy(db, kv, { userDataDir });
    expect(first).toEqual({
      policy: AuthAccessPolicy.LoginRequired,
      alreadyPersisted: false,
      detectedLegacy: false,
    });
    expect(kv.get(AuthAccessPolicyStoreKey.Policy)).toBe(AuthAccessPolicy.LoginRequired);

    // Subsequent usage (privacy agreed, sessions created, auth tokens saved) must NOT flip a new user to legacy.
    kv.set('privacy_agreed', true);
    kv.set('auth_tokens', { accessToken: 'a', refreshToken: 'r' });
    db.prepare('INSERT INTO cowork_sessions (id) VALUES (?)').run('session-1');

    const second = resolveAndPersistAuthAccessPolicy(db, kv, { userDataDir });
    expect(second).toEqual({
      policy: AuthAccessPolicy.LoginRequired,
      alreadyPersisted: true,
      detectedLegacy: false,
    });

    db.close();
  });

  test.each([
    ['privacy_agreed', (kv: AuthAccessPolicyKvPort) => kv.set('privacy_agreed', true)],
    ['auth_tokens', (kv: AuthAccessPolicyKvPort) => kv.set('auth_tokens', { accessToken: 'a', refreshToken: 'r' })],
    ['auth_user', (kv: AuthAccessPolicyKvPort) => kv.set('auth_user', { yid: 'u1' })],
    ['app_config', (kv: AuthAccessPolicyKvPort) => kv.set('app_config', { language: 'zh' })],
    ['installation_uuid', (kv: AuthAccessPolicyKvPort) => kv.set('installation_uuid', 'uuid-1')],
    ['keyfrom_attribution', (kv: AuthAccessPolicyKvPort) => kv.set('keyfrom_attribution', { firstKeyfrom: 'official' })],
    ['auto_launch_initialized', (kv: AuthAccessPolicyKvPort) => kv.set('auto_launch_initialized', true)],
  ])('detects legacy installation from existing kv key %s', (_label, seed) => {
    const { db, kv } = createSchemaDb();
    seed(kv);

    const result = resolveAndPersistAuthAccessPolicy(db, kv);
    expect(result).toEqual({
      policy: AuthAccessPolicy.LegacyOptional,
      alreadyPersisted: false,
      detectedLegacy: true,
    });
    expect(kv.get(AuthAccessPolicyStoreKey.Policy)).toBe(AuthAccessPolicy.LegacyOptional);

    db.close();
  });

  test.each([
    ['cowork_sessions', (db: Database.Database) => db.prepare('INSERT INTO cowork_sessions (id) VALUES (?)').run('s1')],
    ['custom agent', (db: Database.Database) => db.prepare('INSERT INTO agents (id) VALUES (?)').run('custom-1')],
    ['mcp_servers', (db: Database.Database) => db.prepare('INSERT INTO mcp_servers (id) VALUES (?)').run('m1')],
    ['im_config', (db: Database.Database) => db.prepare('INSERT INTO im_config (key, value) VALUES (?, ?)').run('feishu', '{}')],
    ['lobster_scheduled_tasks', (db: Database.Database) => db.prepare('INSERT INTO lobster_scheduled_tasks (id) VALUES (?)').run('t1')],
    ['user_memories', (db: Database.Database) => db.prepare('INSERT INTO user_memories (id) VALUES (?)').run('mem1')],
  ])('detects legacy installation from existing business table data (%s)', (_label, seed) => {
    const { db, kv } = createSchemaDb();
    seed(db);

    expect(detectLegacyInstallationInSqlite({ db })).toBe(true);
    const result = resolveAndPersistAuthAccessPolicy(db, kv);
    expect(result.policy).toBe(AuthAccessPolicy.LegacyOptional);

    db.close();
  });

  test('detects legacy installation from legacy-openclaw-backup directory', () => {
    const { db, kv } = createSchemaDb();
    const userDataDir = createTempDir();
    fs.mkdirSync(path.join(userDataDir, 'legacy-openclaw-backup'), { recursive: true });

    const result = resolveAndPersistAuthAccessPolicy(db, kv, { userDataDir });
    expect(result.policy).toBe(AuthAccessPolicy.LegacyOptional);
    expect(result.detectedLegacy).toBe(true);

    db.close();
  });

  test('keeps legacy_optional persisted even if user clears all sessions later', () => {
    const { db, kv } = createSchemaDb();
    db.prepare('INSERT INTO cowork_sessions (id) VALUES (?)').run('s1');
    const first = resolveAndPersistAuthAccessPolicy(db, kv);
    expect(first.policy).toBe(AuthAccessPolicy.LegacyOptional);

    db.prepare('DELETE FROM cowork_sessions').run();
    const second = resolveAndPersistAuthAccessPolicy(db, kv);
    expect(second.policy).toBe(AuthAccessPolicy.LegacyOptional);
    expect(second.alreadyPersisted).toBe(true);

    db.close();
  });

  test('evaluates live auth access state for new, legacy, enterprise, logged-out, and expired scenarios', () => {
    expect(evaluateAuthAccessState({
      policy: AuthAccessPolicy.LoginRequired,
      enterpriseLoginHidden: false,
      hasCredentials: false,
      lastSessionChangeReason: null,
      privacyAgreed: false,
    })).toEqual({
      policy: AuthAccessPolicy.LoginRequired,
      loginRequired: true,
      blocked: true,
      reason: AuthGateReason.FirstRun,
    });

    expect(evaluateAuthAccessState({
      policy: AuthAccessPolicy.LoginRequired,
      enterpriseLoginHidden: false,
      hasCredentials: true,
      lastSessionChangeReason: null,
      privacyAgreed: true,
    })).toEqual({
      policy: AuthAccessPolicy.LoginRequired,
      loginRequired: true,
      blocked: false,
      reason: null,
    });

    expect(evaluateAuthAccessState({
      policy: AuthAccessPolicy.LoginRequired,
      enterpriseLoginHidden: false,
      hasCredentials: false,
      lastSessionChangeReason: AuthSessionChangeReason.UserLogout,
      privacyAgreed: true,
    })).toEqual({
      policy: AuthAccessPolicy.LoginRequired,
      loginRequired: true,
      blocked: true,
      reason: AuthGateReason.LoggedOut,
    });

    expect(evaluateAuthAccessState({
      policy: AuthAccessPolicy.LoginRequired,
      enterpriseLoginHidden: false,
      hasCredentials: false,
      lastSessionChangeReason: AuthSessionChangeReason.RefreshRejected,
      privacyAgreed: true,
    })).toEqual({
      policy: AuthAccessPolicy.LoginRequired,
      loginRequired: true,
      blocked: true,
      reason: AuthGateReason.SessionExpired,
    });

    expect(evaluateAuthAccessState({
      policy: AuthAccessPolicy.LoginRequired,
      enterpriseLoginHidden: true,
      hasCredentials: false,
      lastSessionChangeReason: null,
      privacyAgreed: false,
    })).toEqual({
      policy: AuthAccessPolicy.LoginRequired,
      loginRequired: false,
      blocked: false,
      reason: null,
    });

    expect(evaluateAuthAccessState({
      policy: AuthAccessPolicy.LegacyOptional,
      enterpriseLoginHidden: false,
      hasCredentials: false,
      lastSessionChangeReason: AuthSessionChangeReason.UserLogout,
      privacyAgreed: true,
    })).toEqual({
      policy: AuthAccessPolicy.LegacyOptional,
      loginRequired: false,
      blocked: false,
      reason: null,
    });
  });

  test('builds structured AUTH_REQUIRED ipc error payloads', () => {
    expect(createAuthRequiredIpcError()).toEqual({
      success: false,
      error: 'Authentication is required to perform this action.',
      errorCode: AuthGateErrorCode.AuthRequired,
    });
  });
});
