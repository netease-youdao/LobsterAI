import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  AuthAccessPolicy,
  AuthAccessPolicyStoreKey,
} from '../../../shared/auth/constants';
import type {
  DataMigrationMissingPluginInfo,
  DataMigrationPostRestoreNotices,
} from '../../../shared/dataMigration/constants';
import {
  DSH_PROFILE_DIR_NAME,
  DSH_PROFILE_NAME,
} from '../../../shared/dshEngine/hostConstants';
import {
  ExperimentalDshCleanupSkipReason,
  LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY,
  MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
} from '../../../shared/migration/constants';
import { readInstalledProfilePlugins } from '../../ipcHandlers/dshHost/pluginOperations';
import {
  detectLegacyInstallationInSqlite,
  parseAuthAccessPolicy,
} from '../authAccessPolicy';
import { getSqliteTableColumns, sqliteTableExists } from './sqliteMigrationSnapshot';

const DSH_CACHED_SHELL_PATH_KV_KEY = 'dsh_cached_shell_path_v1';
const MCP_OAUTH_TOKEN_KV_PREFIX = 'mcp_oauth_token:';
const BROWSER_CREDENTIAL_AVAILABILITY_KV_KEY = 'browserCredentials.availability';
const LOCAL_SPECIFIER_RE = /^(?:file:|link:|\/|\.\.?[/\\]|~\/|[a-zA-Z]:[/\\]|\\\\)/i;

export interface PostRestoreSafeStoragePort {
  isEncryptionAvailable(): boolean;
  decryptString(encrypted: Buffer): string;
}

export interface SanitizeRestoredStateOptions {
  dbPath: string;
  userDataPath: string;
  sourceUserDataPath?: string;
  sourcePlatform?: string;
  currentPlatform?: NodeJS.Platform;
  defaultWorkingDirectory?: string;
  safeStorage?: PostRestoreSafeStoragePort | null;
  rewrittenPathCount?: number;
  /** Skip checking `node_modules` when running on a pre-apply staging DB. */
  skipPluginCheck?: boolean;
}

const normalizeRootForCompare = (raw: string): string => {
  let normalized = raw.trim().replace(/\\/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(normalized)) break;
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
};

export const detectCrossMachineRestore = (options: {
  sourceUserDataPath?: string;
  targetUserDataPath: string;
  sourcePlatform?: string;
  currentPlatform?: NodeJS.Platform;
}): boolean => {
  const currentPlatform = options.currentPlatform ?? process.platform;
  if (options.sourcePlatform && options.sourcePlatform !== currentPlatform) {
    return true;
  }
  if (options.sourceUserDataPath && options.sourceUserDataPath.trim()) {
    return (
      normalizeRootForCompare(options.sourceUserDataPath)
      !== normalizeRootForCompare(options.targetUserDataPath)
    );
  }
  return false;
};

const clearTransientStateInSqlite = (db: Database.Database, isCrossMachine: boolean): void => {
  if (sqliteTableExists(db, 'kv')) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(DSH_CACHED_SHELL_PATH_KV_KEY);
    db.prepare('DELETE FROM kv WHERE key = ?').run(LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY);
    // Never let a backup restored from another machine mutate this machine's `~/.dsh`.
    if (isCrossMachine) {
      db.prepare(`
        INSERT OR IGNORE INTO kv (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(
        MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
        JSON.stringify({
          completedAt: new Date().toISOString(),
          skipped: ExperimentalDshCleanupSkipReason.BackupRestore,
        }),
        Date.now(),
      );
    }
  }
  if (sqliteTableExists(db, 'mcp_launch_resolutions')) {
    db.prepare('DELETE FROM mcp_launch_resolutions').run();
  }
};

const backfillLegacyAuthAccessPolicyInSqlite = (
  db: Database.Database,
  userDataPath: string,
): void => {
  if (!sqliteTableExists(db, 'kv')) return;
  const existingRow = db
    .prepare('SELECT value FROM kv WHERE key = ?')
    .get(AuthAccessPolicyStoreKey.Policy) as { value: string } | undefined;
  if (existingRow) {
    try {
      if (parseAuthAccessPolicy(JSON.parse(existingRow.value)) !== null) {
        return;
      }
    } catch {
      // Malformed value; fall through to legacy detection.
    }
  }
  if (detectLegacyInstallationInSqlite({ db, userDataDir: userDataPath })) {
    db.prepare(`
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(
      AuthAccessPolicyStoreKey.Policy,
      JSON.stringify(AuthAccessPolicy.LegacyOptional),
      Date.now(),
    );
  }
};

const sanitizeBrowserCredentials = (
  db: Database.Database,
  safeStorage: PostRestoreSafeStoragePort | null | undefined,
  isCrossMachine: boolean,
): number => {
  if (!sqliteTableExists(db, 'browser_credentials')) return 0;

  const rows = db
    .prepare('SELECT id, encrypted_password FROM browser_credentials')
    .all() as Array<{ id: string; encrypted_password: Buffer }>;
  if (rows.length === 0) return 0;

  const canProbeDecrypt = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  const undecryptableIds: string[] = [];

  if (canProbeDecrypt && safeStorage) {
    for (const row of rows) {
      try {
        safeStorage.decryptString(row.encrypted_password);
      } catch {
        undecryptableIds.push(row.id);
      }
    }
  } else if (isCrossMachine) {
    // OS-encrypted blobs from a different machine cannot be decrypted locally.
    for (const row of rows) {
      undecryptableIds.push(row.id);
    }
  }

  if (undecryptableIds.length > 0) {
    const deleteStmt = db.prepare('DELETE FROM browser_credentials WHERE id = ?');
    db.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteStmt.run(id);
      }
    })(undecryptableIds);

    // Reset persisted device availability flag so the target machine re-evaluates
    // its own OS keychain cleanly instead of inheriting stale source-machine status.
    if (sqliteTableExists(db, 'kv')) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(BROWSER_CREDENTIAL_AVAILABILITY_KV_KEY);
    }
  }

  return undecryptableIds.length;
};

const sanitizeMcpOAuthTokens = (
  db: Database.Database,
  safeStorage: PostRestoreSafeStoragePort | null | undefined,
  isCrossMachine: boolean,
): Array<{ serverId: string; serverName: string }> => {
  if (!sqliteTableExists(db, 'kv')) return [];

  const tokenRows = db
    .prepare("SELECT key, value FROM kv WHERE key LIKE 'mcp_oauth_token:%'")
    .all() as Array<{ key: string; value: string }>;
  if (tokenRows.length === 0) return [];

  const serverNamesById = new Map<string, string>();
  if (sqliteTableExists(db, 'mcp_servers')) {
    const mcpRows = db
      .prepare('SELECT id, name FROM mcp_servers')
      .all() as Array<{ id: string; name: string }>;
    for (const row of mcpRows) {
      serverNamesById.set(row.id, row.name);
    }
  }

  const canProbeDecrypt = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  const invalidKeys: Array<{ key: string; serverId: string }> = [];

  for (const row of tokenRows) {
    if (!row.value.startsWith('safe:')) continue;
    const serverId = row.key.slice(MCP_OAUTH_TOKEN_KV_PREFIX.length);
    if (canProbeDecrypt && safeStorage) {
      try {
        safeStorage.decryptString(Buffer.from(row.value.slice(5), 'base64'));
      } catch {
        invalidKeys.push({ key: row.key, serverId });
      }
    } else if (isCrossMachine) {
      invalidKeys.push({ key: row.key, serverId });
    }
  }

  if (invalidKeys.length === 0) return [];

  const deleteStmt = db.prepare('DELETE FROM kv WHERE key = ?');
  db.transaction((items: Array<{ key: string; serverId: string }>) => {
    for (const item of items) {
      deleteStmt.run(item.key);
    }
  })(invalidKeys);

  return invalidKeys.map(({ serverId }) => ({
    serverId,
    serverName: serverNamesById.get(serverId) ?? serverId,
  }));
};

const isExistingDirectorySync = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const sanitizeWorkingDirectories = (
  db: Database.Database,
  defaultWorkingDirectory?: string,
): Pick<
  DataMigrationPostRestoreNotices,
  | 'resetDefaultWorkingDirectory'
  | 'missingAgentWorkingDirectories'
  | 'missingScheduledTaskWorkingDirectories'
> => {
  const result: Pick<
    DataMigrationPostRestoreNotices,
    | 'resetDefaultWorkingDirectory'
    | 'missingAgentWorkingDirectories'
    | 'missingScheduledTaskWorkingDirectories'
  > = {};

  if (sqliteTableExists(db, 'cowork_config')) {
    const row = db
      .prepare("SELECT value FROM cowork_config WHERE key = 'workingDirectory'")
      .get() as { value?: string } | undefined;
    const previous = row?.value?.trim() ?? '';
    if (previous && !isExistingDirectorySync(previous) && defaultWorkingDirectory?.trim()) {
      const nextDefault = defaultWorkingDirectory.trim();
      db.prepare(
        "UPDATE cowork_config SET value = ?, updated_at = ? WHERE key = 'workingDirectory'",
      ).run(nextDefault, Date.now());
      result.resetDefaultWorkingDirectory = {
        previous,
        current: nextDefault,
      };
    }
  }

  if (sqliteTableExists(db, 'agents')) {
    const cols = new Set(getSqliteTableColumns(db, 'agents'));
    if (cols.has('id') && cols.has('name') && cols.has('working_directory')) {
      const rows = db
        .prepare("SELECT id, name, working_directory FROM agents WHERE working_directory IS NOT NULL AND TRIM(working_directory) != ''")
        .all() as Array<{ id: string; name: string; working_directory: string }>;
      const missing = rows
        .filter(row => !isExistingDirectorySync(row.working_directory.trim()))
        .map(row => ({
          agentId: row.id,
          agentName: row.name,
          path: row.working_directory.trim(),
        }));
      if (missing.length > 0) {
        result.missingAgentWorkingDirectories = missing;
      }
    }
  }

  if (sqliteTableExists(db, 'lobster_scheduled_tasks')) {
    const cols = new Set(getSqliteTableColumns(db, 'lobster_scheduled_tasks'));
    if (cols.has('id') && cols.has('name') && cols.has('payload_json')) {
      const rows = db
        .prepare('SELECT id, name, payload_json FROM lobster_scheduled_tasks')
        .all() as Array<{ id: string; name: string; payload_json: string }>;
      const missing: Array<{ taskId: string; taskName: string; path: string }> = [];
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload_json) as { workingDirectory?: unknown };
          const dir = typeof payload.workingDirectory === 'string'
            ? payload.workingDirectory.trim()
            : '';
          if (dir && !isExistingDirectorySync(dir)) {
            missing.push({ taskId: row.id, taskName: row.name, path: dir });
          }
        } catch {
          // Ignore malformed payload JSON.
        }
      }
      if (missing.length > 0) {
        result.missingScheduledTaskWorkingDirectories = missing;
      }
    }
  }

  return result;
};

export const detectMissingThirdPartyDshPluginsSync = (
  userDataPath: string,
): DataMigrationMissingPluginInfo[] => {
  const profileDir = path.join(userDataPath, DSH_PROFILE_DIR_NAME, 'profiles', DSH_PROFILE_NAME);
  const installedPlugins = readInstalledProfilePlugins(profileDir);
  const missing: DataMigrationMissingPluginInfo[] = [];

  for (const plugin of installedPlugins) {
    if (plugin.managed) continue;
    const moduleDir = path.join(profileDir, 'node_modules', ...plugin.name.split('/'));
    if (fs.existsSync(moduleDir)) continue;
    missing.push({
      name: plugin.name,
      specifier: plugin.specifier,
      enabled: plugin.enabled,
      isLocalPath: LOCAL_SPECIFIER_RE.test(plugin.specifier.trim()),
    });
  }

  return missing;
};

/**
 * Sanitizes restored SQLite and inspects DSH profile state after copying
 * restored files into `userDataPath`:
 * - clears machine-local `dsh_cached_shell_path_v1` & `mcp_launch_resolutions`
 * - probes `safeStorage` to keep decryptable records on same-machine restore
 *   while cleanly removing undecryptable cross-machine `browser_credentials`
 *   and `mcp_oauth_token:*` entries
 * - resets non-existent default `workingDirectory` and records missing custom
 *   agent / scheduled task directories
 * - detects third-party DSH plugins whose `node_modules` need reinstallation
 */
export const sanitizeRestoredStateSync = (
  options: SanitizeRestoredStateOptions,
): DataMigrationPostRestoreNotices => {
  const isCrossMachine = detectCrossMachineRestore({
    sourceUserDataPath: options.sourceUserDataPath,
    targetUserDataPath: options.userDataPath,
    sourcePlatform: options.sourcePlatform,
    currentPlatform: options.currentPlatform,
  });

  const notices: DataMigrationPostRestoreNotices = {
    isCrossMachine,
    ...(options.sourcePlatform ? { sourcePlatform: options.sourcePlatform } : {}),
    ...(options.rewrittenPathCount && options.rewrittenPathCount > 0
      ? { rewrittenPathCount: options.rewrittenPathCount }
      : {}),
  };

  if (fs.existsSync(options.dbPath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(options.dbPath);
      clearTransientStateInSqlite(db, isCrossMachine);
      backfillLegacyAuthAccessPolicyInSqlite(db, options.userDataPath);

      const clearedBrowserCredentialCount = sanitizeBrowserCredentials(
        db,
        options.safeStorage,
        isCrossMachine,
      );
      if (clearedBrowserCredentialCount > 0) {
        notices.clearedBrowserCredentialCount = clearedBrowserCredentialCount;
      }

      const reauthRequiredMcpServers = sanitizeMcpOAuthTokens(
        db,
        options.safeStorage,
        isCrossMachine,
      );
      if (reauthRequiredMcpServers.length > 0) {
        notices.reauthRequiredMcpServers = reauthRequiredMcpServers;
      }

      const dirNotices = sanitizeWorkingDirectories(db, options.defaultWorkingDirectory);
      Object.assign(notices, dirNotices);
    } finally {
      db?.close();
    }
  }

  if (!options.skipPluginCheck) {
    const missingDshPlugins = detectMissingThirdPartyDshPluginsSync(options.userDataPath);
    if (missingDshPlugins.length > 0) {
      notices.missingDshPlugins = missingDshPlugins;
    }
  }

  return notices;
};
