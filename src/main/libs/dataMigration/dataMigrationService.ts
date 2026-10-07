import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import {
  type DataMigrationLastRestoreResult,
  DataMigrationRestoreStatus,
} from '../../../shared/dataMigration/constants';
import { APP_NAME, DB_FILENAME } from '../../appConstants';
import { SQLITE_BACKUP_DIR_NAME } from '../sqliteBackup/constants';

const CURRENT_ARCHIVE_ROOT = APP_NAME;
const MANIFEST_FILE_NAME = '.lobsterai-migration.json';
const PENDING_RESTORE_FILE_NAME = '.lobsterai-data-migration-restore-pending.json';
const LAST_RESTORE_RESULT_FILE_NAME = '.lobsterai-data-migration-restore-result.json';
const ARCHIVE_FORMAT = 'lobsterai-data-migration';
const ARCHIVE_FORMAT_VERSION = 1;
const SQLITE_BACKUP_TOP_LEVEL_DIR_NAME = SQLITE_BACKUP_DIR_NAME.split('/')[0] || 'backups';
const SQLITE_RESTORE_FILE_NAMES = [
  DB_FILENAME,
  `${DB_FILENAME}-wal`,
  `${DB_FILENAME}-shm`,
] as const;
const SQLITE_REPLACE_RETRY_DELAYS_MS = [
  50,
  100,
  250,
  500,
  1_000,
] as const;

const SQLITE_MIGRATION_TABLES = [
  'kv',
  'cowork_sessions',
  'cowork_messages',
  'cowork_config',
  'agents',
  'mcp_servers',
  'mcp_launch_resolutions',
  'user_plugins',
  'user_memories',
  'user_memory_sources',
  'subagent_runs',
  'subagent_messages',
  'im_config',
  'im_session_mappings',
  'scheduled_task_meta',
  'scheduled_tasks',
  'scheduled_task_runs',
] as const;

const SQLITE_MIGRATION_KV_KEYS = [
  'auth_tokens',
  'auth_user',
  'app_config',
  'skills_state',
  'openclaw_session_policy',
  'installation_uuid',
] as const;

const SQLITE_CRITICAL_CONTENT_TABLES = [
  ...SQLITE_MIGRATION_TABLES,
] as const;

const OPENCLAW_STATE_RELATIVE_PATH = 'openclaw/state';

const OPENCLAW_STATE_SUMMARY_EXCLUDED_SEGMENTS = new Set([
  '.compile-cache',
  'bin',
]);

const OPENCLAW_STATE_SUMMARY_EXCLUDED_RELATIVE_PATHS = [
  'logs',
];

const OPENCLAW_STATE_SUMMARY_EXCLUDED_FILE_NAMES = new Set([
  'gateway-port.json',
  'gateway-token',
]);

const SOURCE_EXCLUDED_TOP_LEVEL_NAMES = new Set([
  'Cache',
  'Code Cache',
  'cowork',
  'Dictionaries',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Local State',
  'Local Storage',
  'Network',
  // Chromium storage for persistent `persist:` partitions (in-app/agent browser cookies,
  // LevelDB, caches). The running main process keeps these files locked, so deleting them
  // during restore fails with EBUSY; cookies are also encrypted per machine on Windows.
  // Treat it like Local Storage/Network above: exclude from backups, preserve on restore.
  'Partitions',
  'Preferences',
  'Service Worker',
  'Session Storage',
  'Shared Dictionary',
  'SharedStorage',
  'SharedStorage-shm',
  'SharedStorage-wal',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'blob_storage',
  'Crashpad',
  'install-timing.log',
  SQLITE_BACKUP_TOP_LEVEL_DIR_NAME,
  'logs',
  'lockfile',
  'runtimes',
  'skill-migrate.log',
  'sqlite-backups',
  PENDING_RESTORE_FILE_NAME,
  LAST_RESTORE_RESULT_FILE_NAME,
]);

const RESTORE_PRESERVED_TOP_LEVEL_NAMES = new Set([
  'Cache',
  'Code Cache',
  'cowork',
  'Dictionaries',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Local State',
  'Local Storage',
  'Network',
  'Partitions',
  'Preferences',
  'Service Worker',
  'Session Storage',
  'Shared Dictionary',
  'SharedStorage',
  'SharedStorage-shm',
  'SharedStorage-wal',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'blob_storage',
  'Crashpad',
  'install-timing.log',
  SQLITE_BACKUP_TOP_LEVEL_DIR_NAME,
  'logs',
  'lockfile',
  'runtimes',
  'skill-migrate.log',
  'sqlite-backups',
  PENDING_RESTORE_FILE_NAME,
  LAST_RESTORE_RESULT_FILE_NAME,
]);

const SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES = [
  'Cookies',
  'DIPS',
  '.com.github.Electron.',
];

const RESTORE_PRESERVED_TOP_LEVEL_PREFIXES = SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES;

const EXCLUDED_RELATIVE_PATHS = [
  'openclaw/logs',
  'openclaw/mcp-packages',
  'openclaw/state/logs',
];

const RESTORE_PRESERVED_RELATIVE_PATHS = [
  'openclaw/logs',
  'openclaw/mcp-packages',
  'openclaw/state/logs',
];

const ALLOWED_ENTRY_TYPES = new Set([
  'File',
  'OldFile',
  'Directory',
]);

export type DataMigrationArchiveKind = 'backup' | 'rollback';

export interface CreateMigrationArchiveInput {
  userDataPath: string;
  outputPath: string;
  sqliteSnapshotPath?: string;
  now?: Date;
  archiveKind?: DataMigrationArchiveKind;
}

export interface CreateMigrationArchiveResult {
  outputPath: string;
  sizeBytes: number;
}

export interface MigrationArchiveInfo {
  archivePath: string;
  root: string;
  entryCount: number;
  hasSqliteDatabase: boolean;
  hasManifest: boolean;
}

interface InspectMigrationArchiveOptions {
  requireSqliteDatabase?: boolean;
  validateSqliteDatabase?: boolean;
  requireManifest?: boolean;
  validateManifest?: boolean;
}

interface MigrationManifest {
  format?: string;
  version?: number;
  archiveRoot?: string;
  archiveKind?: DataMigrationArchiveKind;
  sqlite?: SqliteMigrationSummary;
  openclawState?: OpenClawStateMigrationSummary;
}

export interface PendingDataMigrationRestoreRequest {
  archivePath: string;
  requestedAt: string;
}

export interface PerformPendingDataMigrationRestoreInput {
  userDataPath: string;
  rollbackRootPath: string;
  now?: Date;
}

export interface PerformDataMigrationRestoreInput extends PerformPendingDataMigrationRestoreInput {
  archivePath: string;
}

interface SqliteMigrationSummary {
  exists: boolean;
  sizeBytes?: number;
  checksumSha256?: string;
  quickCheck?: string;
  tableNames?: string[];
  rowCounts?: Record<string, number>;
  tableContentChecksums?: Record<string, string>;
  kvKeys?: string[];
  kvValueChecksums?: Record<string, string>;
  appConfigChecksumSha256?: string;
  primaryApiKeyPresent?: boolean;
  agentIds?: string[];
  sessionCountsByAgentId?: Record<string, number>;
  providerKeys?: string[];
  enabledProviderKeys?: string[];
  providerKeysWithApiKey?: string[];
  customProviderKeys?: string[];
  imConfigKeys?: string[];
  imConfigValueChecksums?: Record<string, string>;
  scheduledTaskMetaIds?: string[];
  error?: string;
}

interface OpenClawStateMigrationSummary {
  exists: boolean;
  fileCount?: number;
  totalSizeBytes?: number;
  checksumSha256?: string;
  cronFileCount?: number;
  cronRunFileCount?: number;
  agentSessionFileCount?: number;
  openclawConfigExists?: boolean;
  sampledRelativePaths?: string[];
  error?: string;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

export const formatDataMigrationTimestamp = (date = new Date()): string => (
  `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
);

export const buildDataMigrationBackupFileName = (date = new Date()): string =>
  `lobsterai-backup-${formatDataMigrationTimestamp(date)}.tar.gz`;

export const buildDataMigrationRollbackFileName = (date = new Date()): string =>
  `lobsterai-rollback-${formatDataMigrationTimestamp(date)}.tar.gz`;

export const ensureTarGzFileName = (filePath: string): string => {
  const trimmed = filePath.trim();
  return /\.tar\.gz$/i.test(trimmed) ? trimmed : `${trimmed}.tar.gz`;
};

const isSupportedMigrationArchivePath = (filePath: string): boolean =>
  /\.tar\.gz$/i.test(filePath) || /\.tgz$/i.test(filePath);

export const getPendingRestoreRequestPath = (userDataPath: string): string =>
  path.join(userDataPath, PENDING_RESTORE_FILE_NAME);

export const getLastRestoreResultPath = (userDataPath: string): string =>
  path.join(userDataPath, LAST_RESTORE_RESULT_FILE_NAME);

const resolvePath = (value: string): string => path.resolve(value);

const isPathInside = (candidatePath: string, parentPath: string): boolean => {
  const relative = path.relative(resolvePath(parentPath), resolvePath(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isTopLevelEntryMatch = (
  relativePosixPath: string,
  names: Set<string>,
  prefixes: readonly string[],
): boolean => {
  const firstSegment = relativePosixPath.split('/')[0] || '';
  return names.has(firstSegment)
    || prefixes.some(prefix => firstSegment.startsWith(prefix));
};

const isExcludedSourceTopLevelEntry = (relativePosixPath: string): boolean =>
  isTopLevelEntryMatch(
    relativePosixPath,
    SOURCE_EXCLUDED_TOP_LEVEL_NAMES,
    SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES,
  );

const isPreservedRestoreTopLevelEntry = (relativePosixPath: string): boolean =>
  isTopLevelEntryMatch(
    relativePosixPath,
    RESTORE_PRESERVED_TOP_LEVEL_NAMES,
    RESTORE_PRESERVED_TOP_LEVEL_PREFIXES,
  );

const isExcludedMigrationEntry = (relativePosixPath: string): boolean => {
  if (!relativePosixPath) return false;
  if (isExcludedSourceTopLevelEntry(relativePosixPath)) return true;
  return EXCLUDED_RELATIVE_PATHS.some(excludedPath => (
    relativePosixPath === excludedPath
    || relativePosixPath.startsWith(`${excludedPath}/`)
  ));
};

const isPreservedRestoreRelativeEntry = (relativePosixPath: string): boolean => (
  RESTORE_PRESERVED_RELATIVE_PATHS.some(preservedPath => (
    relativePosixPath === preservedPath
    || relativePosixPath.startsWith(`${preservedPath}/`)
  ))
);

const hasPreservedRestoreRelativeDescendant = (relativePosixPath: string): boolean => (
  RESTORE_PRESERVED_RELATIVE_PATHS.some(preservedPath => preservedPath.startsWith(`${relativePosixPath}/`))
);

const isTopLevelSqliteRestoreEntry = (relativePosixPath: string): boolean => {
  const firstSegment = relativePosixPath.split('/')[0] || '';
  return SQLITE_RESTORE_FILE_NAMES.includes(firstSegment as typeof SQLITE_RESTORE_FILE_NAMES[number]);
};

const getExclusionManifestFields = (archiveKind: DataMigrationArchiveKind): Record<string, unknown> => {
  if (archiveKind === 'rollback') {
    return {
      excludedTopLevelNames: [...RESTORE_PRESERVED_TOP_LEVEL_NAMES].sort(),
      excludedTopLevelPrefixes: [...RESTORE_PRESERVED_TOP_LEVEL_PREFIXES].sort(),
      excludedRelativePaths: [...RESTORE_PRESERVED_RELATIVE_PATHS].sort(),
    };
  }

  return {
    excludedTopLevelNames: [...SOURCE_EXCLUDED_TOP_LEVEL_NAMES].sort(),
    excludedTopLevelPrefixes: [...SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES].sort(),
    excludedRelativePaths: [...EXCLUDED_RELATIVE_PATHS].sort(),
  };
};

const shouldExcludeSourcePath = (
  relativePosixPath: string,
  absolutePath: string,
  input: CreateMigrationArchiveInput,
): boolean => {
  if (!relativePosixPath) return false;
  const archiveKind = input.archiveKind ?? 'backup';
  if (archiveKind === 'rollback') {
    if (isPreservedRestoreTopLevelEntry(relativePosixPath)) return true;
    if (isPreservedRestoreRelativeEntry(relativePosixPath)) return true;
  } else if (isExcludedMigrationEntry(relativePosixPath)) {
    return true;
  }

  const firstSegment = relativePosixPath.split('/')[0] || '';
  if (input.sqliteSnapshotPath) {
    if (
      firstSegment === DB_FILENAME
      || firstSegment === `${DB_FILENAME}-wal`
      || firstSegment === `${DB_FILENAME}-shm`
    ) {
      return true;
    }
  }

  return isPathInside(absolutePath, input.outputPath);
};

const ensureDirSync = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const removeDirIfExistsSync = (dirPath: string): void => {
  fs.rmSync(dirPath, { recursive: true, force: true });
};

const waitSync = (delayMs: number): void => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, delayMs);
};

const isRetryableFileSystemError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
};

const retryFileSystemOperationSync = (operationName: string, operation: () => void): void => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SQLITE_REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      operation();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFileSystemError(error) || attempt >= SQLITE_REPLACE_RETRY_DELAYS_MS.length) {
        break;
      }
      waitSync(SQLITE_REPLACE_RETRY_DELAYS_MS[attempt]);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${operationName} failed: ${message}`);
};

const removePathWithRetrySync = (targetPath: string): void => {
  retryFileSystemOperationSync(`Remove ${path.basename(targetPath)}`, () => {
    fs.rmSync(targetPath, { recursive: true, force: true });
  });
};

const computeFileSha256Sync = (filePath: string): string => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const copyFileSync = (sourcePath: string, targetPath: string): void => {
  ensureDirSync(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
};

const copyFileReplacingWithRetrySync = (sourcePath: string, targetPath: string): void => {
  ensureDirSync(path.dirname(targetPath));
  const tempTargetPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.restore-${crypto.randomUUID()}.tmp`,
  );
  try {
    copyFileSync(sourcePath, tempTargetPath);
    retryFileSystemOperationSync(`Replace ${path.basename(targetPath)}`, () => {
      fs.renameSync(tempTargetPath, targetPath);
    });
  } finally {
    try {
      fs.rmSync(tempTargetPath, { force: true });
    } catch {
      // Ignore temporary cleanup failures; the final target has already been verified later.
    }
  }
};

const copyDirectorySync = (
  sourceRoot: string,
  targetRoot: string,
  shouldExclude?: (relativePosixPath: string, absolutePath: string) => boolean,
): void => {
  const copyEntry = (sourcePath: string, targetPath: string, relativePosixPath: string): void => {
    if (shouldExclude?.(relativePosixPath, sourcePath)) return;

    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) return;

    if (stat.isDirectory()) {
      ensureDirSync(targetPath);
      for (const entry of fs.readdirSync(sourcePath)) {
        const childRelative = relativePosixPath
          ? `${relativePosixPath}/${entry}`
          : entry;
        copyEntry(path.join(sourcePath, entry), path.join(targetPath, entry), childRelative);
      }
      return;
    }

    if (stat.isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  };

  copyEntry(sourceRoot, targetRoot, '');
};

const writeJsonSync = (filePath: string, value: unknown): void => {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const readJsonFileSync = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
};

const tableExists = (db: Database.Database, tableName: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
};

const quoteSqliteIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

const getTableColumns = (db: Database.Database, tableName: string): string[] => (
  (db.pragma(`table_info(${quoteSqliteIdentifier(tableName)})`) as Array<{ name: string }>)
    .map(column => column.name)
);

const readApplicationTableNames = (db: Database.Database): string[] => (
  (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>)
    .map(row => row.name)
    .filter(name => name.trim().length > 0)
);

const normalizeSqliteValueForHash = (value: unknown): unknown => {
  if (Buffer.isBuffer(value)) {
    return {
      type: 'buffer',
      sha256: crypto.createHash('sha256').update(value).digest('hex'),
      sizeBytes: value.length,
    };
  }
  return value;
};

const computeTableContentChecksum = (db: Database.Database, tableName: string): string | undefined => {
  if (!tableExists(db, tableName)) return undefined;
  const columns = getTableColumns(db, tableName);
  if (columns.length === 0) return undefined;

  const rows = db
    .prepare(`SELECT ${columns.map(quoteSqliteIdentifier).join(', ')} FROM ${quoteSqliteIdentifier(tableName)}`)
    .all() as Array<Record<string, unknown>>;
  const serializedRows = rows
    .map(row => JSON.stringify(columns.map(column => normalizeSqliteValueForHash(row[column]))))
    .sort();

  const hash = crypto.createHash('sha256');
  hash.update(tableName);
  hash.update('\0');
  hash.update(columns.join('\0'));
  hash.update('\0');
  for (const row of serializedRows) {
    hash.update(row);
    hash.update('\n');
  }
  return hash.digest('hex');
};

const readTableRowCounts = (
  db: Database.Database,
  tableNames: readonly string[],
): Record<string, number> => {
  const rowCounts: Record<string, number> = {};
  for (const tableName of tableNames) {
    const count = db
      .prepare(`SELECT COUNT(*) FROM ${quoteSqliteIdentifier(tableName)}`)
      .pluck()
      .get() as number;
    rowCounts[tableName] = Number(count) || 0;
  }
  return rowCounts;
};

const readTableContentChecksums = (db: Database.Database): Record<string, string> => {
  const checksums: Record<string, string> = {};
  for (const tableName of SQLITE_CRITICAL_CONTENT_TABLES) {
    const checksum = computeTableContentChecksum(db, tableName);
    if (checksum) {
      checksums[tableName] = checksum;
    }
  }
  return checksums;
};

const readKvValueChecksums = (db: Database.Database): Record<string, string> => {
  if (!tableExists(db, 'kv')) return {};
  const rows = db
    .prepare(`SELECT key, value FROM kv WHERE key IN (${SQLITE_MIGRATION_KV_KEYS.map(() => '?').join(', ')})`)
    .all(...SQLITE_MIGRATION_KV_KEYS) as Array<{ key: string; value: string }>;
  return Object.fromEntries(
    rows
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(row => [row.key, crypto.createHash('sha256').update(row.value).digest('hex')]),
  );
};

const readAgentIds = (db: Database.Database): string[] => {
  if (!tableExists(db, 'agents')) return [];
  return (db.prepare('SELECT id FROM agents ORDER BY id').all() as Array<{ id: string }>)
    .map(row => row.id)
    .filter(id => id.trim().length > 0);
};

const readSessionCountsByAgentId = (db: Database.Database): Record<string, number> => {
  if (!tableExists(db, 'cowork_sessions')) return {};
  const columns = new Set(getTableColumns(db, 'cowork_sessions'));
  const sql = columns.has('agent_id')
    ? `
      SELECT COALESCE(NULLIF(TRIM(agent_id), ''), 'main') as agent_id, COUNT(*) as count
      FROM cowork_sessions
      GROUP BY COALESCE(NULLIF(TRIM(agent_id), ''), 'main')
      ORDER BY agent_id
    `
    : `
      SELECT 'main' as agent_id, COUNT(*) as count
      FROM cowork_sessions
    `;
  const rows = db.prepare(sql).all() as Array<{ agent_id: string; count: number }>;
  return Object.fromEntries(rows.map(row => [row.agent_id, Number(row.count) || 0]));
};

const readAppConfigProviderSummary = (
  db: Database.Database,
): Pick<
  SqliteMigrationSummary,
  | 'appConfigChecksumSha256'
  | 'primaryApiKeyPresent'
  | 'providerKeys'
  | 'enabledProviderKeys'
  | 'providerKeysWithApiKey'
  | 'customProviderKeys'
> => {
  if (!tableExists(db, 'kv')) {
    return {
      primaryApiKeyPresent: false,
      providerKeys: [],
      enabledProviderKeys: [],
      providerKeysWithApiKey: [],
      customProviderKeys: [],
    };
  }

  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('app_config') as
    | { value: string }
    | undefined;
  if (!row?.value) {
    return {
      primaryApiKeyPresent: false,
      providerKeys: [],
      enabledProviderKeys: [],
      providerKeysWithApiKey: [],
      customProviderKeys: [],
    };
  }

  try {
    const config = JSON.parse(row.value) as {
      api?: { key?: string };
      providers?: Record<string, { enabled?: boolean; apiKey?: string }>;
    };
    const providers = config.providers && typeof config.providers === 'object'
      ? config.providers
      : {};
    const providerKeys = Object.keys(providers).sort();
    return {
      appConfigChecksumSha256: crypto.createHash('sha256').update(row.value).digest('hex'),
      primaryApiKeyPresent: typeof config.api?.key === 'string' && config.api.key.trim().length > 0,
      providerKeys,
      enabledProviderKeys: providerKeys
        .filter(key => providers[key]?.enabled === true)
        .sort(),
      providerKeysWithApiKey: providerKeys
        .filter(key => typeof providers[key]?.apiKey === 'string' && providers[key]!.apiKey!.trim().length > 0)
        .sort(),
      customProviderKeys: providerKeys
        .filter(key => key.startsWith('custom_') || key === 'custom')
        .sort(),
    };
  } catch {
    return {
      appConfigChecksumSha256: crypto.createHash('sha256').update(row.value).digest('hex'),
      primaryApiKeyPresent: false,
      providerKeys: [],
      enabledProviderKeys: [],
      providerKeysWithApiKey: [],
      customProviderKeys: [],
    };
  }
};

const readImConfigSummary = (
  db: Database.Database,
): Pick<SqliteMigrationSummary, 'imConfigKeys' | 'imConfigValueChecksums'> => {
  if (!tableExists(db, 'im_config')) {
    return { imConfigKeys: [], imConfigValueChecksums: {} };
  }
  const rows = db
    .prepare('SELECT key, value FROM im_config ORDER BY key')
    .all() as Array<{ key: string; value?: string | null }>;
  return {
    imConfigKeys: rows.map(row => row.key),
    imConfigValueChecksums: Object.fromEntries(
      rows.map(row => [
        row.key,
        crypto.createHash('sha256').update(row.value ?? '').digest('hex'),
      ]),
    ),
  };
};

const readScheduledTaskMetaIds = (db: Database.Database): string[] => {
  if (!tableExists(db, 'scheduled_task_meta')) return [];
  return (db.prepare('SELECT task_id FROM scheduled_task_meta ORDER BY task_id').all() as Array<{ task_id: string }>)
    .map(row => row.task_id)
    .filter(id => id.trim().length > 0);
};

const readSqliteMigrationSummarySync = (dbPath: string): SqliteMigrationSummary => {
  if (!fs.existsSync(dbPath)) return { exists: false };
  const stat = fs.statSync(dbPath);
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const quickCheck = String(db.prepare('PRAGMA quick_check').pluck().get() ?? '');
    const tableNames = readApplicationTableNames(db);
    const rowCounts = readTableRowCounts(db, tableNames);

    const kvKeys = tableExists(db, 'kv')
      ? SQLITE_MIGRATION_KV_KEYS.filter((key) => {
        const row = db?.prepare('SELECT key FROM kv WHERE key = ?').get(key);
        return Boolean(row);
      })
      : [];
    const providerSummary = readAppConfigProviderSummary(db);
    const imConfigSummary = readImConfigSummary(db);

    return {
      exists: true,
      sizeBytes: stat.size,
      checksumSha256: computeFileSha256Sync(dbPath),
      quickCheck,
      tableNames,
      rowCounts,
      tableContentChecksums: readTableContentChecksums(db),
      kvKeys,
      kvValueChecksums: readKvValueChecksums(db),
      agentIds: readAgentIds(db),
      sessionCountsByAgentId: readSessionCountsByAgentId(db),
      scheduledTaskMetaIds: readScheduledTaskMetaIds(db),
      ...providerSummary,
      ...imConfigSummary,
    };
  } catch (error) {
    return {
      exists: true,
      sizeBytes: stat.size,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
};

const assertMigrationSqliteReadySync = (dbPath: string, label: string): SqliteMigrationSummary => {
  const summary = readSqliteMigrationSummarySync(dbPath);
  if (!summary.exists) {
    throw new Error(`${label} is missing ${DB_FILENAME}.`);
  }
  if (summary.error) {
    throw new Error(`${label} contains an unreadable ${DB_FILENAME}: ${summary.error}`);
  }
  if (summary.quickCheck !== 'ok') {
    throw new Error(`${label} ${DB_FILENAME} failed quick_check: ${summary.quickCheck || 'empty result'}`);
  }
  return summary;
};

const arraysEqual = (left: readonly string[] = [], right: readonly string[] = []): boolean => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

const recordsEqual = (
  left: Record<string, number> = {},
  right: Record<string, number> = {},
): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return arraysEqual(leftKeys, rightKeys)
    && leftKeys.every(key => left[key] === right[key]);
};

const stringRecordsEqual = (
  left: Record<string, string> = {},
  right: Record<string, string> = {},
): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return arraysEqual(leftKeys, rightKeys)
    && leftKeys.every(key => left[key] === right[key]);
};

const assertStringArraySummaryFieldMatches = (
  sourceSummary: SqliteMigrationSummary,
  targetSummary: SqliteMigrationSummary,
  fieldName: keyof Pick<
    SqliteMigrationSummary,
    | 'tableNames'
    | 'kvKeys'
    | 'agentIds'
    | 'providerKeys'
    | 'enabledProviderKeys'
    | 'providerKeysWithApiKey'
    | 'customProviderKeys'
    | 'imConfigKeys'
    | 'scheduledTaskMetaIds'
  >,
  label: string,
): void => {
  const sourceValues = sourceSummary[fieldName] ?? [];
  const targetValues = targetSummary[fieldName] ?? [];
  if (!arraysEqual(sourceValues, targetValues)) {
    throw new Error(
      `${label} ${fieldName} mismatch: expected [${sourceValues.join(', ')}], got [${targetValues.join(', ')}].`,
    );
  }
};

const assertSqliteCriticalSummaryMatches = (
  sourceSummary: SqliteMigrationSummary,
  targetSummary: SqliteMigrationSummary,
  label: string,
): void => {
  for (const fieldName of [
    'tableNames',
    'kvKeys',
    'agentIds',
    'providerKeys',
    'enabledProviderKeys',
    'providerKeysWithApiKey',
    'customProviderKeys',
    'imConfigKeys',
    'scheduledTaskMetaIds',
  ] as const) {
    assertStringArraySummaryFieldMatches(sourceSummary, targetSummary, fieldName, label);
  }

  if (!recordsEqual(sourceSummary.rowCounts, targetSummary.rowCounts)) {
    throw new Error(
      `${label} rowCounts mismatch: expected ${JSON.stringify(sourceSummary.rowCounts ?? {})}, got ${JSON.stringify(targetSummary.rowCounts ?? {})}.`,
    );
  }

  if (!stringRecordsEqual(sourceSummary.tableContentChecksums, targetSummary.tableContentChecksums)) {
    throw new Error(`${label} tableContentChecksums mismatch.`);
  }

  if (!stringRecordsEqual(sourceSummary.kvValueChecksums, targetSummary.kvValueChecksums)) {
    throw new Error(`${label} kvValueChecksums mismatch.`);
  }

  if (!stringRecordsEqual(sourceSummary.imConfigValueChecksums, targetSummary.imConfigValueChecksums)) {
    throw new Error(`${label} imConfigValueChecksums mismatch.`);
  }

  if (sourceSummary.appConfigChecksumSha256 !== targetSummary.appConfigChecksumSha256) {
    throw new Error(`${label} appConfigChecksumSha256 mismatch.`);
  }

  if (sourceSummary.primaryApiKeyPresent !== targetSummary.primaryApiKeyPresent) {
    throw new Error(`${label} primaryApiKeyPresent mismatch.`);
  }

  if (!recordsEqual(sourceSummary.sessionCountsByAgentId, targetSummary.sessionCountsByAgentId)) {
    throw new Error(
      `${label} sessionCountsByAgentId mismatch: expected ${JSON.stringify(sourceSummary.sessionCountsByAgentId ?? {})}, got ${JSON.stringify(targetSummary.sessionCountsByAgentId ?? {})}.`,
    );
  }
};

export const assertDataMigrationSqliteSnapshotMatchesLiveSync = (
  liveDbPath: string,
  snapshotDbPath: string,
): void => {
  const liveSummary = assertMigrationSqliteReadySync(liveDbPath, 'Live data');
  const snapshotSummary = assertMigrationSqliteReadySync(snapshotDbPath, 'Backup snapshot');

  assertSqliteCriticalSummaryMatches(liveSummary, snapshotSummary, 'Backup snapshot');
};

const checkpointSqliteDatabaseSync = (dbPath: string, label: string): void => {
  for (const fileName of SQLITE_RESTORE_FILE_NAMES) {
    const sqlitePath = path.join(path.dirname(dbPath), fileName);
    if (!fs.existsSync(sqlitePath)) continue;
    try {
      fs.chmodSync(sqlitePath, 0o600);
    } catch {
      // Best effort; extracted archives may already have writable files.
    }
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed to checkpoint ${DB_FILENAME}: ${message}`);
  } finally {
    db?.close();
  }
};

const toPosixPath = (value: string): string => value.replace(/\\/g, '/');

const shouldExcludeOpenClawStateSummaryPath = (relativePosixPath: string): boolean => {
  const segments = relativePosixPath.split('/').filter(Boolean);
  if (segments.some(segment => OPENCLAW_STATE_SUMMARY_EXCLUDED_SEGMENTS.has(segment))) {
    return true;
  }
  if (OPENCLAW_STATE_SUMMARY_EXCLUDED_RELATIVE_PATHS.some(excludedPath => (
    relativePosixPath === excludedPath
    || relativePosixPath.startsWith(`${excludedPath}/`)
  ))) {
    return true;
  }
  const fileName = segments[segments.length - 1] ?? '';
  return OPENCLAW_STATE_SUMMARY_EXCLUDED_FILE_NAMES.has(fileName);
};

const readOpenClawStateMigrationSummarySync = (userDataPath: string): OpenClawStateMigrationSummary => {
  const stateRoot = path.join(userDataPath, ...OPENCLAW_STATE_RELATIVE_PATH.split('/'));
  if (!fs.existsSync(stateRoot)) return { exists: false };
  if (!fs.statSync(stateRoot).isDirectory()) {
    return { exists: false, error: `${OPENCLAW_STATE_RELATIVE_PATH} is not a directory` };
  }

  try {
    const files: Array<{ relativePath: string; absolutePath: string; sizeBytes: number }> = [];
    const visit = (dirPath: string): void => {
      for (const entryName of fs.readdirSync(dirPath)) {
        const absolutePath = path.join(dirPath, entryName);
        const relativePath = toPosixPath(path.relative(stateRoot, absolutePath));
        if (!relativePath || shouldExcludeOpenClawStateSummaryPath(relativePath)) continue;

        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          visit(absolutePath);
          continue;
        }
        if (!stat.isFile()) continue;
        files.push({ relativePath, absolutePath, sizeBytes: stat.size });
      }
    };
    visit(stateRoot);
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    const hash = crypto.createHash('sha256');
    let totalSizeBytes = 0;
    for (const file of files) {
      totalSizeBytes += file.sizeBytes;
      hash.update(file.relativePath);
      hash.update('\0');
      hash.update(String(file.sizeBytes));
      hash.update('\0');
      hash.update(fs.readFileSync(file.absolutePath));
      hash.update('\0');
    }

    return {
      exists: true,
      fileCount: files.length,
      totalSizeBytes,
      checksumSha256: hash.digest('hex'),
      cronFileCount: files.filter(file => file.relativePath === 'cron' || file.relativePath.startsWith('cron/')).length,
      cronRunFileCount: files.filter(file => file.relativePath.startsWith('cron/runs/')).length,
      agentSessionFileCount: files.filter(file => file.relativePath.includes('/sessions/')).length,
      openclawConfigExists: files.some(file => file.relativePath === 'openclaw.json'),
      sampledRelativePaths: files.slice(0, 50).map(file => file.relativePath),
    };
  } catch (error) {
    return {
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const assertOpenClawStateSummaryMatches = (
  sourceUserDataPath: string,
  targetUserDataPath: string,
  label: string,
): void => {
  const sourceSummary = readOpenClawStateMigrationSummarySync(sourceUserDataPath);
  const targetSummary = readOpenClawStateMigrationSummarySync(targetUserDataPath);

  assertOpenClawStateSummaryValuesMatch(sourceSummary, targetSummary, label);
};

const assertOpenClawStateSummaryValuesMatch = (
  sourceSummary: OpenClawStateMigrationSummary,
  targetSummary: OpenClawStateMigrationSummary,
  label: string,
): void => {
  if (sourceSummary.error || targetSummary.error) {
    throw new Error(
      `${label} OpenClaw state summary failed: ${sourceSummary.error || targetSummary.error}`,
    );
  }
  for (const fieldName of [
    'exists',
    'fileCount',
    'totalSizeBytes',
    'checksumSha256',
    'cronFileCount',
    'cronRunFileCount',
    'agentSessionFileCount',
    'openclawConfigExists',
  ] as const) {
    if (sourceSummary[fieldName] !== targetSummary[fieldName]) {
      throw new Error(
        `${label} OpenClaw state ${fieldName} mismatch: expected ${String(sourceSummary[fieldName])}, got ${String(targetSummary[fieldName])}.`,
      );
    }
  }
};

const readMigrationManifestSync = (sourceRoot: string): MigrationManifest => {
  const manifestPath = path.join(sourceRoot, MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup archive is missing ${MANIFEST_FILE_NAME}.`);
  }
  let manifest: MigrationManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as MigrationManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Backup archive contains an unreadable ${MANIFEST_FILE_NAME}: ${message}`);
  }

  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new Error(`Backup archive manifest format is unsupported: ${manifest.format || 'missing'}.`);
  }
  if (manifest.version !== ARCHIVE_FORMAT_VERSION) {
    throw new Error(`Backup archive manifest version is unsupported: ${String(manifest.version ?? 'missing')}.`);
  }
  if (manifest.archiveRoot !== CURRENT_ARCHIVE_ROOT) {
    throw new Error(`Backup archive manifest root is unsupported: ${manifest.archiveRoot || 'missing'}.`);
  }
  return manifest;
};

const assertManifestSqliteSummaryMatches = (
  manifestSummary: SqliteMigrationSummary | undefined,
  actualSummary: SqliteMigrationSummary,
  label: string,
): void => {
  if (!manifestSummary) {
    throw new Error(`${label} is missing sqlite summary.`);
  }
  if (manifestSummary.exists !== actualSummary.exists) {
    throw new Error(`${label} sqlite existence mismatch.`);
  }
  if (!manifestSummary.exists) {
    return;
  }
  if (manifestSummary.error || actualSummary.error) {
    throw new Error(`${label} sqlite summary failed: ${manifestSummary.error || actualSummary.error}`);
  }
  if (manifestSummary.quickCheck !== actualSummary.quickCheck) {
    throw new Error(`${label} sqlite quick_check mismatch.`);
  }
  if (manifestSummary.sizeBytes !== actualSummary.sizeBytes) {
    throw new Error(`${label} sqlite sizeBytes mismatch.`);
  }
  if (manifestSummary.checksumSha256 !== actualSummary.checksumSha256) {
    throw new Error(`${label} sqlite checksum mismatch.`);
  }
  assertSqliteCriticalSummaryMatches(manifestSummary, actualSummary, label);
};

const validateExtractedArchiveContentSync = (sourceRoot: string): MigrationManifest => {
  const manifest = readMigrationManifestSync(sourceRoot);
  const sqliteSummary = assertMigrationSqliteReadySync(path.join(sourceRoot, DB_FILENAME), 'Backup archive');
  assertManifestSqliteSummaryMatches(manifest.sqlite, sqliteSummary, 'Backup archive manifest');

  if (!manifest.openclawState) {
    throw new Error('Backup archive manifest is missing OpenClaw state summary.');
  }
  assertOpenClawStateSummaryValuesMatch(
    manifest.openclawState,
    readOpenClawStateMigrationSummarySync(sourceRoot),
    'Backup archive manifest',
  );
  return manifest;
};

const buildManifest = (
  input: CreateMigrationArchiveInput,
  manifestUserDataPath = resolvePath(input.userDataPath),
): Record<string, unknown> => {
  const now = input.now ?? new Date();
  const archiveKind = input.archiveKind ?? 'backup';
  const sqliteSourcePath = input.sqliteSnapshotPath
    ? resolvePath(input.sqliteSnapshotPath)
    : path.join(resolvePath(input.userDataPath), DB_FILENAME);
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_FORMAT_VERSION,
    appName: APP_NAME,
    archiveKind,
    archiveRoot: CURRENT_ARCHIVE_ROOT,
    createdAt: now.toISOString(),
    platform: process.platform,
    arch: process.arch,
    includesWorkingDirectories: false,
    ...getExclusionManifestFields(archiveKind),
    sqlite: readSqliteMigrationSummarySync(sqliteSourcePath),
    openclawState: readOpenClawStateMigrationSummarySync(manifestUserDataPath),
  };
};

export const createMigrationArchiveSync = (
  input: CreateMigrationArchiveInput,
): CreateMigrationArchiveResult => {
  const userDataPath = resolvePath(input.userDataPath);
  const outputPath = resolvePath(input.outputPath);
  const archiveKind = input.archiveKind ?? 'backup';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-'));
  const stageParent = path.join(tempRoot, 'stage');
  const stageUserDataRoot = path.join(stageParent, CURRENT_ARCHIVE_ROOT);

  try {
    ensureDirSync(stageUserDataRoot);
    copyDirectorySync(
      userDataPath,
      stageUserDataRoot,
      (relativePosixPath, absolutePath) => shouldExcludeSourcePath(relativePosixPath, absolutePath, {
        ...input,
        userDataPath,
        outputPath,
      }),
    );

    if (input.sqliteSnapshotPath) {
      copyFileSync(resolvePath(input.sqliteSnapshotPath), path.join(stageUserDataRoot, DB_FILENAME));
    }

    if (archiveKind !== 'rollback') {
      assertMigrationSqliteReadySync(path.join(stageUserDataRoot, DB_FILENAME), 'Backup staging');
      assertOpenClawStateSummaryMatches(userDataPath, stageUserDataRoot, 'Backup staging');
    }

    writeJsonSync(path.join(stageUserDataRoot, MANIFEST_FILE_NAME), buildManifest(input, stageUserDataRoot));

    ensureDirSync(path.dirname(outputPath));
    tar.create({
      sync: true,
      gzip: true,
      file: outputPath,
      cwd: stageParent,
      portable: true,
    }, [CURRENT_ARCHIVE_ROOT]);

    if (archiveKind !== 'rollback') {
      inspectMigrationArchiveSync(outputPath);
    }

    return {
      outputPath,
      sizeBytes: fs.statSync(outputPath).size,
    };
  } finally {
    removeDirIfExistsSync(tempRoot);
  }
};

export const createMigrationArchive = async (
  input: CreateMigrationArchiveInput,
): Promise<CreateMigrationArchiveResult> => createMigrationArchiveSync(input);

const normalizeArchiveEntryPath = (entryPath: string): string => {
  let normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
};

const assertSafeArchiveEntryPath = (entryPath: string): string => {
  const normalized = normalizeArchiveEntryPath(entryPath);
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Backup archive contains an empty or invalid path.');
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Backup archive contains an absolute path: ${entryPath}`);
  }
  if (normalized.split('/').some(segment => segment === '..')) {
    throw new Error(`Backup archive contains a parent-directory path: ${entryPath}`);
  }
  return normalized;
};

const resolveArchiveRoot = (entryPath: string): Pick<MigrationArchiveInfo, 'root'> | null => {
  if (entryPath === CURRENT_ARCHIVE_ROOT || entryPath.startsWith(`${CURRENT_ARCHIVE_ROOT}/`)) {
    return { root: CURRENT_ARCHIVE_ROOT };
  }
  return null;
};

const isArchiveSqliteDatabaseEntry = (entryPath: string, root: string): boolean =>
  entryPath === `${root}/${DB_FILENAME}`;

const isArchiveRootParentDirectory = (entryPath: string): boolean => (
  `${CURRENT_ARCHIVE_ROOT}/`.startsWith(`${entryPath}/`)
);

const isArchiveManifestEntry = (entryPath: string, root: string): boolean =>
  entryPath === `${root}/${MANIFEST_FILE_NAME}`;

const inspectArchiveEntry = (
  archivePath: string,
  entry: { path: string; type?: string },
  state: {
    root: Pick<MigrationArchiveInfo, 'root'> | null;
    entryCount: number;
    hasSqliteDatabase: boolean;
    hasManifest: boolean;
  },
): void => {
  const normalizedPath = assertSafeArchiveEntryPath(entry.path);
  if (entry.type && !ALLOWED_ENTRY_TYPES.has(entry.type)) {
    throw new Error(`Backup archive contains an unsupported entry type: ${entry.type}`);
  }

  const root = resolveArchiveRoot(normalizedPath);
  if (!root) {
    if (entry.type === 'Directory' && isArchiveRootParentDirectory(normalizedPath)) {
      return;
    }
    throw new Error(`Backup archive does not contain ${APP_NAME} user data: ${entry.path}`);
  }
  if (state.root && state.root.root !== root.root) {
    throw new Error(`Backup archive contains multiple root directories: ${archivePath}`);
  }
  state.root = root;
  state.entryCount += 1;
  if (isArchiveSqliteDatabaseEntry(normalizedPath, root.root)) {
    if (entry.type && entry.type !== 'File' && entry.type !== 'OldFile') {
      throw new Error(`Backup archive ${DB_FILENAME} entry is not a file.`);
    }
    state.hasSqliteDatabase = true;
  }
  if (isArchiveManifestEntry(normalizedPath, root.root)) {
    if (entry.type && entry.type !== 'File' && entry.type !== 'OldFile') {
      throw new Error(`Backup archive ${MANIFEST_FILE_NAME} entry is not a file.`);
    }
    state.hasManifest = true;
  }
};

const validateArchiveContentSync = (archivePath: string, root: string): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-inspect-'));
  try {
    tar.extract({
      sync: true,
      file: archivePath,
      cwd: tempRoot,
      preservePaths: false,
      unlink: true,
      filter: (entryPath, entry) => {
        const normalizedPath = assertSafeArchiveEntryPath(entryPath);
        if ('type' in entry && entry.type && !ALLOWED_ENTRY_TYPES.has(entry.type)) {
          throw new Error(`Backup archive contains an unsupported entry type: ${entry.type}`);
        }
        const archiveRoot = resolveArchiveRoot(normalizedPath);
        const isDirectoryEntry = 'type' in entry
          ? entry.type === 'Directory'
          : entry.isDirectory();
        return Boolean(
          (archiveRoot && archiveRoot.root === root)
          || (isDirectoryEntry && isArchiveRootParentDirectory(normalizedPath)),
        );
      },
    });
    validateExtractedArchiveContentSync(path.join(tempRoot, ...root.split('/')));
  } finally {
    removeDirIfExistsSync(tempRoot);
  }
};

export const inspectMigrationArchiveSync = (
  archivePath: string,
  options: InspectMigrationArchiveOptions = {},
): MigrationArchiveInfo => {
  const resolvedArchivePath = resolvePath(archivePath);
  if (!isSupportedMigrationArchivePath(resolvedArchivePath)) {
    throw new Error('Backup archive must be a .tar.gz or .tgz file.');
  }
  const requireSqliteDatabase = options.requireSqliteDatabase ?? true;
  const validateSqliteDatabase = options.validateSqliteDatabase ?? true;
  const requireManifest = options.requireManifest ?? true;
  const validateManifest = options.validateManifest ?? true;
  const state: {
    root: Pick<MigrationArchiveInfo, 'root'> | null;
    entryCount: number;
    hasSqliteDatabase: boolean;
    hasManifest: boolean;
  } = {
    root: null,
    entryCount: 0,
    hasSqliteDatabase: false,
    hasManifest: false,
  };

  tar.list({
    sync: true,
    file: resolvedArchivePath,
    onentry: entry => inspectArchiveEntry(resolvedArchivePath, entry, state),
  });

  if (!state.root || state.entryCount <= 0) {
    throw new Error('Backup archive is empty or missing LobsterAI user data.');
  }
  if (requireSqliteDatabase && !state.hasSqliteDatabase) {
    throw new Error(`Backup archive is missing ${DB_FILENAME}.`);
  }
  if (requireManifest && !state.hasManifest) {
    throw new Error(`Backup archive is missing ${MANIFEST_FILE_NAME}.`);
  }
  if (
    (requireSqliteDatabase && validateSqliteDatabase)
    || (requireManifest && validateManifest)
  ) {
    validateArchiveContentSync(resolvedArchivePath, state.root.root);
  }

  return {
    archivePath: resolvedArchivePath,
    root: state.root.root,
    entryCount: state.entryCount,
    hasSqliteDatabase: state.hasSqliteDatabase,
    hasManifest: state.hasManifest,
  };
};

export const inspectMigrationArchive = async (archivePath: string): Promise<MigrationArchiveInfo> =>
  inspectMigrationArchiveSync(archivePath);

const extractMigrationArchiveToTempSync = (
  archivePath: string,
  options: {
    requireSqliteDatabase?: boolean;
    requireManifest?: boolean;
    validateArchiveContent?: boolean;
  } = {},
): { tempRoot: string; sourceRoot: string; info: MigrationArchiveInfo } => {
  const info = inspectMigrationArchiveSync(archivePath, {
    requireSqliteDatabase: options.requireSqliteDatabase,
    requireManifest: options.requireManifest,
    validateSqliteDatabase: false,
    validateManifest: false,
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-restore-'));

  try {
    tar.extract({
      sync: true,
      file: info.archivePath,
      cwd: tempRoot,
      preservePaths: false,
      unlink: true,
      filter: (entryPath, entry) => {
        const normalizedPath = assertSafeArchiveEntryPath(entryPath);
        if ('type' in entry && entry.type && !ALLOWED_ENTRY_TYPES.has(entry.type)) {
          throw new Error(`Backup archive contains an unsupported entry type: ${entry.type}`);
        }
        const root = resolveArchiveRoot(normalizedPath);
        const isDirectoryEntry = 'type' in entry
          ? entry.type === 'Directory'
          : entry.isDirectory();
        return Boolean(
          (root && root.root === info.root)
          || (isDirectoryEntry && isArchiveRootParentDirectory(normalizedPath)),
        );
      },
    });

    const sourceRoot = path.join(tempRoot, ...info.root.split('/'));
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      throw new Error('Backup archive did not extract a valid LobsterAI user data directory.');
    }
    if (options.validateArchiveContent ?? true) {
      validateExtractedArchiveContentSync(sourceRoot);
    }
    return { tempRoot, sourceRoot, info };
  } catch (error) {
    removeDirIfExistsSync(tempRoot);
    throw error;
  }
};

export const writePendingRestoreRequestSync = (
  userDataPath: string,
  archivePath: string,
  now = new Date(),
): PendingDataMigrationRestoreRequest => {
  const request = {
    archivePath: resolvePath(archivePath),
    requestedAt: now.toISOString(),
  };
  writeJsonSync(getPendingRestoreRequestPath(userDataPath), request);
  return request;
};

export const consumeLastRestoreResultSync = (
  userDataPath: string,
): DataMigrationLastRestoreResult | null => {
  const resultPath = getLastRestoreResultPath(userDataPath);
  const result = readJsonFileSync<DataMigrationLastRestoreResult>(resultPath);
  if (result) {
    try {
      fs.unlinkSync(resultPath);
    } catch {
      // Ignore marker cleanup failures.
    }
  }
  return result;
};

const writeRestoreResultSync = (userDataPath: string, result: DataMigrationLastRestoreResult): void => {
  writeJsonSync(getLastRestoreResultPath(userDataPath), result);
};

const buildFailedRestoreResult = (
  archivePath: string,
  rollbackPath: string | undefined,
  error: unknown,
  now: Date,
): DataMigrationLastRestoreResult => ({
  status: DataMigrationRestoreStatus.Failed,
  archivePath,
  rollbackPath,
  restoredAt: now.toISOString(),
  error: error instanceof Error ? error.message : String(error),
});

const clearRestorableUserDataSync = (userDataPath: string): void => {
  ensureDirSync(userDataPath);
  const clearEntry = (absolutePath: string, relativePosixPath: string): void => {
    if (isPreservedRestoreTopLevelEntry(relativePosixPath)) return;
    if (isPreservedRestoreRelativeEntry(relativePosixPath)) return;
    if (isTopLevelSqliteRestoreEntry(relativePosixPath)) return;

    if (hasPreservedRestoreRelativeDescendant(relativePosixPath)) {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        removeDirIfExistsSync(absolutePath);
        return;
      }

      for (const entry of fs.readdirSync(absolutePath)) {
        clearEntry(
          path.join(absolutePath, entry),
          `${relativePosixPath}/${entry}`,
        );
      }
      if (fs.readdirSync(absolutePath).length === 0) {
        removeDirIfExistsSync(absolutePath);
      }
      return;
    }

    removeDirIfExistsSync(absolutePath);
  };

  for (const entry of fs.readdirSync(userDataPath)) {
    clearEntry(path.join(userDataPath, entry), entry);
  }
};

const replaceSqliteDatabaseSync = (
  sourceRoot: string,
  userDataPath: string,
  options: { includeSidecars?: boolean } = {},
): void => {
  const sourceDbPath = path.join(sourceRoot, DB_FILENAME);
  const targetDbPath = path.join(userDataPath, DB_FILENAME);

  for (const fileName of SQLITE_RESTORE_FILE_NAMES) {
    removePathWithRetrySync(path.join(userDataPath, fileName));
  }

  if (!fs.existsSync(sourceDbPath)) {
    return;
  }
  if (!fs.statSync(sourceDbPath).isFile()) {
    throw new Error(`Backup archive ${DB_FILENAME} entry is not a file.`);
  }

  copyFileReplacingWithRetrySync(sourceDbPath, targetDbPath);

  if (!options.includeSidecars) {
    return;
  }

  for (const fileName of SQLITE_RESTORE_FILE_NAMES.slice(1)) {
    const sourcePath = path.join(sourceRoot, fileName);
    if (!fs.existsSync(sourcePath)) continue;
    if (!fs.statSync(sourcePath).isFile()) continue;
    copyFileReplacingWithRetrySync(sourcePath, path.join(userDataPath, fileName));
  }
};

const removeSqliteSidecarsWithRetrySync = (userDataPath: string): void => {
  for (const fileName of SQLITE_RESTORE_FILE_NAMES.slice(1)) {
    removePathWithRetrySync(path.join(userDataPath, fileName));
  }
};

const invalidateMcpLaunchResolutionsSync = (dbPath: string): void => {
  if (!fs.existsSync(dbPath)) return;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    if (!tableExists(db, 'mcp_launch_resolutions')) return;

    const columns = new Set(getTableColumns(db, 'mcp_launch_resolutions'));
    const clauses: string[] = [];
    const params: string[] = [];
    if (columns.has('install_dir')) {
      clauses.push('install_dir IS NOT NULL');
    }
    if (columns.has('command')) {
      clauses.push('command LIKE ?');
      params.push('%mcp-packages%');
    }
    if (columns.has('args_json')) {
      clauses.push('args_json LIKE ?');
      params.push('%mcp-packages%');
    }

    if (clauses.length === 0) {
      db.prepare('DELETE FROM mcp_launch_resolutions').run();
      return;
    }

    db.prepare(`DELETE FROM mcp_launch_resolutions WHERE ${clauses.join(' OR ')}`).run(...params);
  } finally {
    db?.close();
  }
};

const replaceRestorableUserDataSync = (
  sourceRoot: string,
  userDataPath: string,
  shouldExcludeCopiedEntry: (relativePosixPath: string, absolutePath: string) => boolean = (
    relativePosixPath,
  ) => isExcludedMigrationEntry(relativePosixPath),
  options: { includeSqliteSidecars?: boolean } = {},
): void => {
  clearRestorableUserDataSync(userDataPath);
  copyDirectorySync(
    sourceRoot,
    userDataPath,
    (relativePosixPath, absolutePath) => (
      isTopLevelSqliteRestoreEntry(relativePosixPath)
      || isPreservedRestoreRelativeEntry(relativePosixPath)
      || shouldExcludeCopiedEntry(relativePosixPath, absolutePath)
    ),
  );
  replaceSqliteDatabaseSync(sourceRoot, userDataPath, {
    includeSidecars: options.includeSqliteSidecars,
  });
};

const assertSqliteRestoredSync = (
  sourceRoot: string,
  userDataPath: string,
  sourceSummary = assertMigrationSqliteReadySync(path.join(sourceRoot, DB_FILENAME), 'Backup archive'),
): void => {
  const targetSummary = assertMigrationSqliteReadySync(path.join(userDataPath, DB_FILENAME), 'Restored data');
  if (sourceSummary.checksumSha256 !== targetSummary.checksumSha256) {
    throw new Error(`Restored ${DB_FILENAME} checksum does not match the backup archive.`);
  }

  for (const tableName of SQLITE_MIGRATION_TABLES) {
    const sourceCount = sourceSummary.rowCounts?.[tableName] ?? 0;
    const targetCount = targetSummary.rowCounts?.[tableName] ?? 0;
    if (sourceCount !== targetCount) {
      throw new Error(
        `Restored ${DB_FILENAME} row count mismatch for ${tableName}: expected ${sourceCount}, got ${targetCount}.`,
      );
    }
  }

  for (const key of sourceSummary.kvKeys ?? []) {
    if (!targetSummary.kvKeys?.includes(key)) {
      throw new Error(`Restored ${DB_FILENAME} is missing required kv key ${key}.`);
    }
  }

  assertSqliteCriticalSummaryMatches(sourceSummary, targetSummary, `Restored ${DB_FILENAME}`);
};

const restoreRollbackArchiveSync = (rollbackPath: string, userDataPath: string): void => {
  const rollback = extractMigrationArchiveToTempSync(rollbackPath, {
    requireSqliteDatabase: false,
    requireManifest: false,
    validateArchiveContent: false,
  });
  try {
    replaceRestorableUserDataSync(rollback.sourceRoot, userDataPath, isPreservedRestoreTopLevelEntry, {
      includeSqliteSidecars: true,
    });
  } finally {
    removeDirIfExistsSync(rollback.tempRoot);
  }
};

export const performDataMigrationRestoreSync = (
  input: PerformDataMigrationRestoreInput,
): DataMigrationLastRestoreResult | null => {
  const now = input.now ?? new Date();
  const archivePath = resolvePath(input.archivePath);
  let rollbackPath: string | undefined;
  let rollbackReady = false;
  let extractedTempRoot: string | null = null;
  let targetWasTouched = false;

  try {
    ensureDirSync(input.rollbackRootPath);
    if (fs.existsSync(input.userDataPath)) {
      rollbackPath = path.join(input.rollbackRootPath, buildDataMigrationRollbackFileName(now));
      createMigrationArchiveSync({
        userDataPath: input.userDataPath,
        outputPath: rollbackPath,
        now,
        archiveKind: 'rollback',
      });
      rollbackReady = true;
    }

    const extracted = extractMigrationArchiveToTempSync(archivePath);
    extractedTempRoot = extracted.tempRoot;
    assertMigrationSqliteReadySync(path.join(extracted.sourceRoot, DB_FILENAME), 'Backup archive');
    checkpointSqliteDatabaseSync(path.join(extracted.sourceRoot, DB_FILENAME), 'Backup archive');
    invalidateMcpLaunchResolutionsSync(path.join(extracted.sourceRoot, DB_FILENAME));
    checkpointSqliteDatabaseSync(path.join(extracted.sourceRoot, DB_FILENAME), 'Backup archive');
    const sourceSummary = assertMigrationSqliteReadySync(path.join(extracted.sourceRoot, DB_FILENAME), 'Backup archive');

    targetWasTouched = true;
    replaceRestorableUserDataSync(extracted.sourceRoot, input.userDataPath);
    assertSqliteRestoredSync(extracted.sourceRoot, input.userDataPath, sourceSummary);
    assertOpenClawStateSummaryMatches(extracted.sourceRoot, input.userDataPath, 'Restored data');
    removeSqliteSidecarsWithRetrySync(input.userDataPath);

    const result: DataMigrationLastRestoreResult = {
      status: DataMigrationRestoreStatus.Success,
      archivePath,
      rollbackPath,
      restoredAt: now.toISOString(),
    };
    writeRestoreResultSync(input.userDataPath, result);
    return result;
  } catch (error) {
    if (targetWasTouched && rollbackReady && rollbackPath) {
      try {
        restoreRollbackArchiveSync(rollbackPath, input.userDataPath);
      } catch {
        // Leave the original error as the reported failure.
      }
    }
    const result = buildFailedRestoreResult(archivePath, rollbackPath, error, now);
    try {
      writeRestoreResultSync(input.userDataPath, result);
    } catch {
      // If even marker writing fails, return the result to the caller.
    }
    return result;
  } finally {
    if (extractedTempRoot) {
      removeDirIfExistsSync(extractedTempRoot);
    }
  }
};

export const performPendingDataMigrationRestoreSync = (
  input: PerformPendingDataMigrationRestoreInput,
): DataMigrationLastRestoreResult | null => {
  const pendingPath = getPendingRestoreRequestPath(input.userDataPath);
  const request = readJsonFileSync<PendingDataMigrationRestoreRequest>(pendingPath);
  if (!request?.archivePath) return null;

  try {
    fs.unlinkSync(pendingPath);
  } catch {
    // The request has already been read; continue.
  }

  return performDataMigrationRestoreSync({
    ...input,
    archivePath: request.archivePath,
  });
};
