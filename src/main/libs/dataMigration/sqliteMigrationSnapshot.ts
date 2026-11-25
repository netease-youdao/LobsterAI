import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DSH_PERMISSION_PRESET_KV_KEY } from '../../../shared/dshEngine/hostConstants';
import { DB_FILENAME } from '../../appConstants';

const SQLITE_SNAPSHOT_QUICK_CHECK_OK = 'ok';

export const SQLITE_RESTORE_FILE_NAMES = [
  DB_FILENAME,
  `${DB_FILENAME}-wal`,
  `${DB_FILENAME}-shm`,
] as const;

/**
 * Transient tables that are cleared or regenerated on restore and therefore
 * excluded from content-checksum comparison across restore sanitization.
 */
export const SQLITE_TRANSIENT_TABLES = new Set<string>([
  'mcp_launch_resolutions',
]);

/**
 * Core DSH application tables tracked explicitly for row-count checks and
 * backward-compatible manifest inspection. In v3 manifests, EVERY non-transient
 * application table in `sqlite_master` is hashed into `tableContentChecksums`.
 */
export const SQLITE_CORE_DSH_TABLES = [
  'kv',
  'cowork_sessions',
  'cowork_messages',
  'cowork_session_capsules',
  'cowork_message_edits',
  'cowork_message_versions',
  'cowork_message_version_switches',
  'cowork_config',
  'agents',
  'mcp_servers',
  'user_memories',
  'user_memory_sources',
  'subagent_runs',
  'subagent_messages',
  'dsh_subagent_agent_bindings',
  'dsh_deleted_subagents',
  'im_config',
  'im_session_mappings',
  'scheduled_task_meta',
  'lobster_scheduled_tasks',
  'lobster_scheduled_task_runs',
  'browser_credentials',
  'library_local_artifacts',
  'library_artifact_sessions',
  'library_favorites',
  'library_manual_sources',
] as const;

export const SQLITE_DSH_KV_KEYS = [
  'auth_tokens',
  'auth_user',
  'app_config',
  'skills_state',
  DSH_PERMISSION_PRESET_KV_KEY,
  'installation_uuid',
] as const;

export interface SqliteMigrationSummary {
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
  totalSessionCount?: number;
  providerKeys?: string[];
  enabledProviderKeys?: string[];
  providerKeysWithApiKey?: string[];
  customProviderKeys?: string[];
  imConfigKeys?: string[];
  imConfigValueChecksums?: Record<string, string>;
  scheduledTaskMetaIds?: string[];
  scheduledTaskCount?: number;
  scheduledTaskRunCount?: number;
  mcpServerCount?: number;
  error?: string;
}

const quoteSqliteIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

export const sqliteTableExists = (db: Database.Database, tableName: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
};

export const getSqliteTableColumns = (db: Database.Database, tableName: string): string[] => (
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

const computeFileSha256Sync = (filePath: string): string => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
};

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
  if (!sqliteTableExists(db, tableName)) return undefined;
  const columns = getSqliteTableColumns(db, tableName);
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

const readTableContentChecksums = (
  db: Database.Database,
  tableNames: readonly string[],
): Record<string, string> => {
  const checksums: Record<string, string> = {};
  for (const tableName of tableNames) {
    if (SQLITE_TRANSIENT_TABLES.has(tableName)) continue;
    const checksum = computeTableContentChecksum(db, tableName);
    if (checksum) {
      checksums[tableName] = checksum;
    }
  }
  return checksums;
};

const readKvValueChecksums = (db: Database.Database): Record<string, string> => {
  if (!sqliteTableExists(db, 'kv')) return {};
  const rows = db
    .prepare(`SELECT key, value FROM kv WHERE key IN (${SQLITE_DSH_KV_KEYS.map(() => '?').join(', ')})`)
    .all(...SQLITE_DSH_KV_KEYS) as Array<{ key: string; value: string }>;
  return Object.fromEntries(
    rows
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(row => [row.key, crypto.createHash('sha256').update(row.value).digest('hex')]),
  );
};

const readAgentIds = (db: Database.Database): string[] => {
  if (!sqliteTableExists(db, 'agents')) return [];
  return (db.prepare('SELECT id FROM agents ORDER BY id').all() as Array<{ id: string }>)
    .map(row => row.id)
    .filter(id => id.trim().length > 0);
};

const readSessionCountsByAgentId = (db: Database.Database): Record<string, number> => {
  if (!sqliteTableExists(db, 'cowork_sessions')) return {};
  const columns = new Set(getSqliteTableColumns(db, 'cowork_sessions'));
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
  if (!sqliteTableExists(db, 'kv')) {
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
      enabledProviderKeys: providerKeys.filter(key => providers[key]?.enabled === true).sort(),
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
  if (!sqliteTableExists(db, 'im_config')) {
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
  if (!sqliteTableExists(db, 'scheduled_task_meta')) return [];
  return (db.prepare('SELECT task_id FROM scheduled_task_meta ORDER BY task_id').all() as Array<{ task_id: string }>)
    .map(row => row.task_id)
    .filter(id => id.trim().length > 0);
};

export const readSqliteMigrationSummarySync = (dbPath: string): SqliteMigrationSummary => {
  if (!fs.existsSync(dbPath)) return { exists: false };
  const stat = fs.statSync(dbPath);
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const quickCheck = String(db.prepare('PRAGMA quick_check').pluck().get() ?? '');
    const tableNames = readApplicationTableNames(db);
    const rowCounts = readTableRowCounts(db, tableNames);

    const kvKeys = sqliteTableExists(db, 'kv')
      ? SQLITE_DSH_KV_KEYS.filter(key => Boolean(db?.prepare('SELECT key FROM kv WHERE key = ?').get(key)))
      : [];
    const providerSummary = readAppConfigProviderSummary(db);
    const imConfigSummary = readImConfigSummary(db);
    const sessionCountsByAgentId = readSessionCountsByAgentId(db);

    return {
      exists: true,
      sizeBytes: stat.size,
      checksumSha256: computeFileSha256Sync(dbPath),
      quickCheck,
      tableNames,
      rowCounts,
      tableContentChecksums: readTableContentChecksums(db, tableNames),
      kvKeys,
      kvValueChecksums: readKvValueChecksums(db),
      agentIds: readAgentIds(db),
      sessionCountsByAgentId,
      totalSessionCount: rowCounts.cowork_sessions ?? 0,
      scheduledTaskMetaIds: readScheduledTaskMetaIds(db),
      scheduledTaskCount: rowCounts.lobster_scheduled_tasks ?? 0,
      scheduledTaskRunCount: rowCounts.lobster_scheduled_task_runs ?? 0,
      mcpServerCount: rowCounts.mcp_servers ?? 0,
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

export const assertMigrationSqliteReadySync = (dbPath: string, label: string): SqliteMigrationSummary => {
  const summary = readSqliteMigrationSummarySync(dbPath);
  if (!summary.exists) {
    throw new Error(`${label} is missing ${DB_FILENAME}.`);
  }
  if (summary.error) {
    throw new Error(`${label} contains an unreadable ${DB_FILENAME}: ${summary.error}`);
  }
  if (summary.quickCheck !== SQLITE_SNAPSHOT_QUICK_CHECK_OK) {
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
  return arraysEqual(leftKeys, rightKeys) && leftKeys.every(key => left[key] === right[key]);
};

const stringRecordsEqual = (
  left: Record<string, string> = {},
  right: Record<string, string> = {},
): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return arraysEqual(leftKeys, rightKeys) && leftKeys.every(key => left[key] === right[key]);
};

export const assertSqliteCriticalSummaryMatches = (
  expectedSummary: SqliteMigrationSummary,
  actualSummary: SqliteMigrationSummary,
  label: string,
  options: { manifestVersion?: number } = {},
): void => {
  const isV2Manifest = options.manifestVersion === 2;

  for (const fieldName of [
    'tableNames',
    'agentIds',
    'providerKeys',
    'enabledProviderKeys',
    'providerKeysWithApiKey',
    'customProviderKeys',
    'imConfigKeys',
    'scheduledTaskMetaIds',
  ] as const) {
    const expectedValues = expectedSummary[fieldName] ?? [];
    const actualValues = actualSummary[fieldName] ?? [];
    if (!arraysEqual(expectedValues, actualValues)) {
      throw new Error(
        `${label} ${fieldName} mismatch: expected [${expectedValues.join(', ')}], got [${actualValues.join(', ')}].`,
      );
    }
  }

  if (!recordsEqual(expectedSummary.rowCounts, actualSummary.rowCounts)) {
    throw new Error(
      `${label} rowCounts mismatch: expected ${JSON.stringify(expectedSummary.rowCounts ?? {})}, got ${JSON.stringify(actualSummary.rowCounts ?? {})}.`,
    );
  }

  // Manifest v2 recorded a narrower static subset of table checksums and KV keys.
  // For v2 archives, verify every checksum/KV that the manifest actually recorded;
  // for v3 archives, enforce exact equality across all non-transient tables and DSH KV keys.
  const expectedTableChecksums = expectedSummary.tableContentChecksums ?? {};
  const actualTableChecksums = actualSummary.tableContentChecksums ?? {};
  if (isV2Manifest) {
    for (const [tableName, expectedHash] of Object.entries(expectedTableChecksums)) {
      if (SQLITE_TRANSIENT_TABLES.has(tableName)) continue;
      if (actualTableChecksums[tableName] !== expectedHash) {
        throw new Error(`${label} tableContentChecksums mismatch for ${tableName}.`);
      }
    }
  } else if (!stringRecordsEqual(expectedTableChecksums, actualTableChecksums)) {
    throw new Error(`${label} tableContentChecksums mismatch.`);
  }

  const expectedKvChecksums = expectedSummary.kvValueChecksums ?? {};
  const actualKvChecksums = actualSummary.kvValueChecksums ?? {};
  if (isV2Manifest) {
    for (const [key, expectedHash] of Object.entries(expectedKvChecksums)) {
      if (key in actualKvChecksums && actualKvChecksums[key] !== expectedHash) {
        throw new Error(`${label} kvValueChecksums mismatch for ${key}.`);
      }
    }
  } else {
    const expectedKvKeys = expectedSummary.kvKeys ?? [];
    const actualKvKeys = actualSummary.kvKeys ?? [];
    if (!arraysEqual(expectedKvKeys, actualKvKeys)) {
      throw new Error(
        `${label} kvKeys mismatch: expected [${expectedKvKeys.join(', ')}], got [${actualKvKeys.join(', ')}].`,
      );
    }
    if (!stringRecordsEqual(expectedKvChecksums, actualKvChecksums)) {
      throw new Error(`${label} kvValueChecksums mismatch.`);
    }
  }

  if (!stringRecordsEqual(expectedSummary.imConfigValueChecksums, actualSummary.imConfigValueChecksums)) {
    throw new Error(`${label} imConfigValueChecksums mismatch.`);
  }

  if (expectedSummary.appConfigChecksumSha256 !== actualSummary.appConfigChecksumSha256) {
    throw new Error(`${label} appConfigChecksumSha256 mismatch.`);
  }

  if (expectedSummary.primaryApiKeyPresent !== actualSummary.primaryApiKeyPresent) {
    throw new Error(`${label} primaryApiKeyPresent mismatch.`);
  }

  if (!recordsEqual(expectedSummary.sessionCountsByAgentId, actualSummary.sessionCountsByAgentId)) {
    throw new Error(
      `${label} sessionCountsByAgentId mismatch: expected ${JSON.stringify(expectedSummary.sessionCountsByAgentId ?? {})}, got ${JSON.stringify(actualSummary.sessionCountsByAgentId ?? {})}.`,
    );
  }
};

export const assertManifestSqliteSummaryMatches = (
  manifestSummary: SqliteMigrationSummary | undefined,
  actualSummary: SqliteMigrationSummary,
  label: string,
  manifestVersion?: number,
): void => {
  if (!manifestSummary) {
    throw new Error(`${label} is missing sqlite summary.`);
  }
  if (manifestSummary.exists !== actualSummary.exists) {
    throw new Error(`${label} sqlite existence mismatch.`);
  }
  if (!manifestSummary.exists) return;
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
  assertSqliteCriticalSummaryMatches(manifestSummary, actualSummary, label, { manifestVersion });
};

export const createDataMigrationSqliteSnapshot = async (
  db: Database.Database,
  destinationPath: string,
): Promise<void> => {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  await db.backup(destinationPath);
  let verifyDb: Database.Database | null = null;
  try {
    verifyDb = new Database(destinationPath, { readonly: true, fileMustExist: true });
    const quickCheck = verifyDb.prepare('PRAGMA quick_check').pluck().get();
    if (quickCheck !== SQLITE_SNAPSHOT_QUICK_CHECK_OK) {
      throw new Error(
        `SQLite snapshot quick_check failed: ${typeof quickCheck === 'string' && quickCheck ? quickCheck : 'empty result'}`,
      );
    }
  } catch (error) {
    fs.rmSync(destinationPath, { force: true });
    throw error;
  } finally {
    verifyDb?.close();
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

export const checkpointSqliteDatabaseSync = (dbPath: string, label: string): void => {
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
