import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { AgentId } from '../../shared/agent';
import {
  AuthAccessPolicy,
  AuthAccessPolicyStoreKey,
  type AuthAccessState,
  AuthGateErrorCode,
  AuthGateReason,
  AuthSessionChangeReason,
} from '../../shared/auth/constants';

export interface AuthAccessPolicyKvPort {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

export interface LegacyInstallationDetectionInput {
  db: Database.Database;
  userDataDir?: string;
}

export interface ResolveAuthAccessPolicyResult {
  policy: AuthAccessPolicy;
  alreadyPersisted: boolean;
  detectedLegacy: boolean;
}

export interface EvaluateAuthAccessStateInput {
  policy: AuthAccessPolicy;
  enterpriseLoginHidden: boolean;
  hasCredentials: boolean;
  lastSessionChangeReason: AuthSessionChangeReason | null;
  privacyAgreed: boolean;
}

export interface AuthRequiredIpcErrorResponse {
  success: false;
  error: string;
  errorCode: typeof AuthGateErrorCode.AuthRequired;
}

const LEGACY_KV_TRUTHY_KEYS = [
  'auth_tokens',
  'auth_user',
  'app_config',
  'installation_uuid',
  'keyfrom_attribution',
  'auto_launch_initialized',
  'skills_state',
  'desktop_companion_preferences',
] as const;

const LEGACY_NON_EMPTY_TABLES = [
  'cowork_sessions',
  'mcp_servers',
  'im_config',
  'lobster_scheduled_tasks',
  'user_memories',
] as const;

const LEGACY_FS_MARKERS = [
  'legacy-openclaw-backup',
  'config.json',
] as const;

export function parseAuthAccessPolicy(value: unknown): AuthAccessPolicy | null {
  if (value === AuthAccessPolicy.LegacyOptional) return AuthAccessPolicy.LegacyOptional;
  if (value === AuthAccessPolicy.LoginRequired) return AuthAccessPolicy.LoginRequired;
  return null;
}

function sqliteTableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function readRawKvValue(db: Database.Database, key: string): unknown {
  if (!sqliteTableExists(db, 'kv')) return undefined;
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

function isNonEmptyLegacyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * Inspect SQLite and optional userData filesystem markers to determine whether
 * this installation already has usage history from an earlier release.
 *
 * Must run right after `SqliteStore.create()` and BEFORE startup writes
 * `keyfrom_attribution`, `installation_uuid`, `auto_launch_initialized`, or
 * `enterprise_config`, so a fresh installation is never misclassified as legacy.
 */
export function detectLegacyInstallationInSqlite({
  db,
  userDataDir,
}: LegacyInstallationDetectionInput): boolean {
  if (sqliteTableExists(db, 'kv')) {
    if (readRawKvValue(db, 'privacy_agreed') === true) {
      return true;
    }
    for (const key of LEGACY_KV_TRUTHY_KEYS) {
      if (isNonEmptyLegacyValue(readRawKvValue(db, key))) {
        return true;
      }
    }
  }

  for (const table of LEGACY_NON_EMPTY_TABLES) {
    if (!sqliteTableExists(db, table)) continue;
    const row = db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get() as
      | { present: number }
      | undefined;
    if (row) return true;
  }

  if (sqliteTableExists(db, 'agents')) {
    const customAgent = db
      .prepare('SELECT 1 AS present FROM agents WHERE id != ? LIMIT 1')
      .get(AgentId.Main) as { present: number } | undefined;
    if (customAgent) return true;
  }

  if (userDataDir) {
    for (const marker of LEGACY_FS_MARKERS) {
      try {
        if (fs.existsSync(path.join(userDataDir, marker))) {
          return true;
        }
      } catch {
        // Ignore filesystem stat errors and rely on SQLite signals.
      }
    }
  }

  return false;
}

/**
 * Resolve the durable per-installation auth access policy once and persist it.
 * Once persisted, the policy is immutable across future launches so a new user
 * cannot become legacy after logging in and a legacy user cannot lose access
 * after clearing sessions.
 */
export function resolveAndPersistAuthAccessPolicy(
  db: Database.Database,
  kv: AuthAccessPolicyKvPort,
  options: { userDataDir?: string } = {},
): ResolveAuthAccessPolicyResult {
  const existing = parseAuthAccessPolicy(kv.get(AuthAccessPolicyStoreKey.Policy));
  if (existing) {
    return {
      policy: existing,
      alreadyPersisted: true,
      detectedLegacy: existing === AuthAccessPolicy.LegacyOptional,
    };
  }

  const detectedLegacy = detectLegacyInstallationInSqlite({
    db,
    userDataDir: options.userDataDir,
  });
  const policy = detectedLegacy
    ? AuthAccessPolicy.LegacyOptional
    : AuthAccessPolicy.LoginRequired;

  kv.set(AuthAccessPolicyStoreKey.Policy, policy);
  console.log(
    `[AuthAccessPolicy] initialized policy=${policy} (detectedLegacy=${detectedLegacy})`,
  );

  return {
    policy,
    alreadyPersisted: false,
    detectedLegacy,
  };
}

/**
 * Evaluate the live access state combining the durable installation policy,
 * enterprise deployment override (`ui.login === 'hide'`), and current auth
 * credentials.
 */
export function evaluateAuthAccessState(
  input: EvaluateAuthAccessStateInput,
): AuthAccessState {
  const loginRequired = (
    input.policy === AuthAccessPolicy.LoginRequired
    && !input.enterpriseLoginHidden
  );
  const blocked = loginRequired && !input.hasCredentials;
  if (!blocked) {
    return {
      policy: input.policy,
      loginRequired,
      blocked: false,
      reason: null,
    };
  }

  let reason: AuthGateReason;
  if (
    input.lastSessionChangeReason === AuthSessionChangeReason.RefreshRejected
    || input.lastSessionChangeReason === AuthSessionChangeReason.EnterpriseMembershipRevoked
  ) {
    reason = AuthGateReason.SessionExpired;
  } else if (
    input.lastSessionChangeReason === AuthSessionChangeReason.UserLogout
    || input.privacyAgreed
  ) {
    reason = AuthGateReason.LoggedOut;
  } else {
    reason = AuthGateReason.FirstRun;
  }

  return {
    policy: input.policy,
    loginRequired,
    blocked: true,
    reason,
  };
}

export function createAuthRequiredIpcError(
  message = 'Authentication is required to perform this action.',
): AuthRequiredIpcErrorResponse {
  return {
    success: false,
    error: message,
    errorCode: AuthGateErrorCode.AuthRequired,
  };
}
