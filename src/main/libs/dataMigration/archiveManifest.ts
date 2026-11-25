import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as tar from 'tar';

import {
  type DataMigrationArchiveStats,
  DataMigrationErrorCode,
} from '../../../shared/dataMigration/constants';
import {
  DSH_PROFILE_DIR_NAME,
  DSH_PROFILE_NAME,
  WORKSPACES_DIR_NAME,
} from '../../../shared/dshEngine/hostConstants';
import { APP_NAME, DB_FILENAME } from '../../appConstants';
import { readInstalledProfilePlugins } from '../../ipcHandlers/dshHost/pluginOperations';
import {
  type CollectedMigrationFile,
  collectWhitelistedFilesSync,
  WHITELIST_MANIFEST_PATHS,
} from './archiveWhitelist';
import { DataMigrationError } from './dataMigrationError';
import {
  assertManifestSqliteSummaryMatches,
  assertMigrationSqliteReadySync,
  readSqliteMigrationSummarySync,
  type SqliteMigrationSummary,
} from './sqliteMigrationSnapshot';

export const CURRENT_ARCHIVE_ROOT = APP_NAME;
export const MANIFEST_FILE_NAME = '.lobsterai-migration.json';
export const ARCHIVE_FORMAT = 'lobsterai-data-migration';
export const ARCHIVE_ENGINE = 'dsh';
export const ARCHIVE_FORMAT_VERSION = 3;
export const SUPPORTED_DSH_MANIFEST_VERSIONS = new Set([2, 3]);

export const ALLOWED_ARCHIVE_ENTRY_TYPES = new Set([
  'File',
  'OldFile',
  'Directory',
]);

export type DataMigrationArchiveKind = 'backup' | 'rollback';

export interface DshStateMigrationSummary {
  exists: boolean;
  fileCount?: number;
  totalSizeBytes?: number;
  checksumSha256?: string;
  sessionCount?: number;
  sessionFileCount?: number;
  profileConfigExists?: boolean;
  thirdPartyPluginNames?: string[];
  workspacesExist: boolean;
  workspaceFileCount?: number;
  workspaceTotalSizeBytes?: number;
  workspaceChecksumSha256?: string;
  workspaceAgentIds?: string[];
  whitelistedFileCount?: number;
  whitelistedTotalSizeBytes?: number;
  whitelistedChecksumSha256?: string;
  sampledRelativePaths?: string[];
  error?: string;
}

export interface MigrationManifest {
  format?: string;
  version?: number;
  engine?: string;
  appName?: string;
  appVersion?: string;
  archiveKind?: DataMigrationArchiveKind;
  archiveRoot?: string;
  sourceUserDataPath?: string;
  createdAt?: string;
  platform?: string;
  arch?: string;
  includesWorkingDirectories?: boolean;
  whitelistPaths?: string[];
  stats?: DataMigrationArchiveStats;
  sqlite?: SqliteMigrationSummary;
  dshState?: DshStateMigrationSummary;
}

const computeFileStreamSha256Async = (filePath: string): Promise<Buffer> => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest()));
});

const updateHashWithFileSync = (hash: crypto.Hash, filePath: string): void => {
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
};

const computeCollectedFilesChecksumSync = (
  files: readonly CollectedMigrationFile[],
  relativePrefixToStrip?: string,
): string | undefined => {
  if (files.length === 0) return undefined;
  const hash = crypto.createHash('sha256');
  const stripPrefix = relativePrefixToStrip ? `${relativePrefixToStrip}/` : '';
  for (const file of files) {
    const relKey = stripPrefix && file.relativePath.startsWith(stripPrefix)
      ? file.relativePath.slice(stripPrefix.length)
      : file.relativePath;
    hash.update(relKey);
    hash.update('\0');
    hash.update(String(file.sizeBytes));
    hash.update('\0');
    updateHashWithFileSync(hash, file.absolutePath);
    hash.update('\0');
  }
  return hash.digest('hex');
};

const computeCollectedFilesChecksumAsync = async (
  files: readonly CollectedMigrationFile[],
  relativePrefixToStrip?: string,
): Promise<string | undefined> => {
  if (files.length === 0) return undefined;
  const hash = crypto.createHash('sha256');
  const stripPrefix = relativePrefixToStrip ? `${relativePrefixToStrip}/` : '';
  for (const file of files) {
    const relKey = stripPrefix && file.relativePath.startsWith(stripPrefix)
      ? file.relativePath.slice(stripPrefix.length)
      : file.relativePath;
    hash.update(relKey);
    hash.update('\0');
    hash.update(String(file.sizeBytes));
    hash.update('\0');
    const fileDigest = await computeFileStreamSha256Async(file.absolutePath);
    hash.update(fileDigest);
    hash.update('\0');
  }
  return hash.digest('hex');
};

const countDshSessions = (dshFiles: readonly CollectedMigrationFile[]): number => {
  const prefix = `${DSH_PROFILE_DIR_NAME}/sessions/`;
  const sessionKeys = new Set<string>();
  for (const file of dshFiles) {
    if (!file.relativePath.startsWith(prefix)) continue;
    const inner = file.relativePath.slice(prefix.length);
    const segments = inner.split('/').filter(Boolean);
    if (segments.length >= 3) {
      sessionKeys.add(`${segments[0]}/${segments[1]}`);
    } else if (segments.length >= 1) {
      sessionKeys.add(segments[0]);
    }
  }
  return sessionKeys.size;
};

const countSkillsDirectories = (allFiles: readonly CollectedMigrationFile[]): number => {
  const skillNames = new Set<string>();
  for (const file of allFiles) {
    if (!file.relativePath.startsWith('SKILLs/')) continue;
    const rest = file.relativePath.slice('SKILLs/'.length);
    const first = rest.split('/')[0];
    if (first && !first.startsWith('.')) {
      skillNames.add(first);
    }
  }
  return skillNames.size;
};

const readThirdPartyPluginNames = (userDataPath: string): string[] => {
  const profileDir = path.join(userDataPath, DSH_PROFILE_DIR_NAME, 'profiles', DSH_PROFILE_NAME);
  return readInstalledProfilePlugins(profileDir)
    .filter(plugin => !plugin.managed)
    .map(plugin => plugin.name)
    .sort();
};

const buildDshSummaryFromFiles = (
  userDataPath: string,
  allFiles: readonly CollectedMigrationFile[],
  checksums: {
    dshChecksum?: string;
    workspaceChecksum?: string;
    whitelistedChecksum?: string;
  },
): DshStateMigrationSummary => {
  const dshPrefix = `${DSH_PROFILE_DIR_NAME}/`;
  const workspacePrefix = `${WORKSPACES_DIR_NAME}/`;
  const dshFiles = allFiles.filter(file => file.relativePath.startsWith(dshPrefix));
  const workspaceFiles = allFiles.filter(file => file.relativePath.startsWith(workspacePrefix));
  const sessionPrefix = `${DSH_PROFILE_DIR_NAME}/sessions/`;
  const sessionFiles = dshFiles.filter(file => file.relativePath.startsWith(sessionPrefix));
  const profileConfigPrefix = `${DSH_PROFILE_DIR_NAME}/profiles/${DSH_PROFILE_NAME}/`;
  const profileConfigExists = dshFiles.some(file => (
    file.relativePath === `${profileConfigPrefix}package.json`
    || file.relativePath === `${profileConfigPrefix}cordis.patch.yml`
  ));
  const workspaceAgentIds = [...new Set(
    workspaceFiles
      .map(file => file.relativePath.slice(workspacePrefix.length))
      .filter(rel => rel.includes('/'))
      .map(rel => rel.split('/')[0])
      .filter(Boolean),
  )].sort();

  const dshTotalSizeBytes = dshFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  const workspaceTotalSizeBytes = workspaceFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  const whitelistedTotalSizeBytes = allFiles.reduce((sum, file) => sum + file.sizeBytes, 0);

  return {
    exists: dshFiles.length > 0,
    fileCount: dshFiles.length,
    totalSizeBytes: dshTotalSizeBytes,
    checksumSha256: checksums.dshChecksum,
    sessionCount: countDshSessions(dshFiles),
    sessionFileCount: sessionFiles.length,
    profileConfigExists,
    thirdPartyPluginNames: readThirdPartyPluginNames(userDataPath),
    workspacesExist: workspaceFiles.length > 0,
    workspaceFileCount: workspaceFiles.length,
    workspaceTotalSizeBytes,
    workspaceChecksumSha256: checksums.workspaceChecksum,
    workspaceAgentIds,
    whitelistedFileCount: allFiles.length,
    whitelistedTotalSizeBytes,
    whitelistedChecksumSha256: checksums.whitelistedChecksum,
    sampledRelativePaths: allFiles.slice(0, 50).map(file => file.relativePath),
  };
};

export const readDshStateMigrationSummarySync = (
  userDataPath: string,
  options: { hashMode?: 'v2-raw' | 'v3-digest' } = {},
): DshStateMigrationSummary => {
  try {
    const allFiles = collectWhitelistedFilesSync(userDataPath);
    const dshPrefix = `${DSH_PROFILE_DIR_NAME}/`;
    const workspacePrefix = `${WORKSPACES_DIR_NAME}/`;
    const dshFiles = allFiles.filter(file => file.relativePath.startsWith(dshPrefix));
    const workspaceFiles = allFiles.filter(file => file.relativePath.startsWith(workspacePrefix));

    if (options.hashMode === 'v2-raw') {
      return buildDshSummaryFromFiles(userDataPath, allFiles, {
        dshChecksum: computeCollectedFilesChecksumSync(dshFiles, DSH_PROFILE_DIR_NAME),
        workspaceChecksum: computeCollectedFilesChecksumSync(workspaceFiles, WORKSPACES_DIR_NAME),
        whitelistedChecksum: computeCollectedFilesChecksumSync(allFiles),
      });
    }

    // For v3, use identical per-file SHA-256 digest hashing between sync and async paths
    // so sync restore verification matches async backup manifests deterministically.
    const hashFilesViaFileDigestSync = (
      files: readonly CollectedMigrationFile[],
      strip?: string,
    ): string | undefined => {
      if (files.length === 0) return undefined;
      const hash = crypto.createHash('sha256');
      const stripPrefix = strip ? `${strip}/` : '';
      for (const file of files) {
        const relKey = stripPrefix && file.relativePath.startsWith(stripPrefix)
          ? file.relativePath.slice(stripPrefix.length)
          : file.relativePath;
        const fileHash = crypto.createHash('sha256');
        updateHashWithFileSync(fileHash, file.absolutePath);
        hash.update(relKey);
        hash.update('\0');
        hash.update(String(file.sizeBytes));
        hash.update('\0');
        hash.update(fileHash.digest());
        hash.update('\0');
      }
      return hash.digest('hex');
    };

    return buildDshSummaryFromFiles(userDataPath, allFiles, {
      dshChecksum: hashFilesViaFileDigestSync(dshFiles, DSH_PROFILE_DIR_NAME),
      workspaceChecksum: hashFilesViaFileDigestSync(workspaceFiles, WORKSPACES_DIR_NAME),
      whitelistedChecksum: hashFilesViaFileDigestSync(allFiles),
    });
  } catch (error) {
    return {
      exists: false,
      workspacesExist: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const readDshStateMigrationSummaryAsync = async (
  userDataPath: string,
): Promise<DshStateMigrationSummary> => {
  try {
    const allFiles = collectWhitelistedFilesSync(userDataPath);
    const dshPrefix = `${DSH_PROFILE_DIR_NAME}/`;
    const workspacePrefix = `${WORKSPACES_DIR_NAME}/`;
    const dshFiles = allFiles.filter(file => file.relativePath.startsWith(dshPrefix));
    const workspaceFiles = allFiles.filter(file => file.relativePath.startsWith(workspacePrefix));

    const [dshChecksum, workspaceChecksum, whitelistedChecksum] = await Promise.all([
      computeCollectedFilesChecksumAsync(dshFiles, DSH_PROFILE_DIR_NAME),
      computeCollectedFilesChecksumAsync(workspaceFiles, WORKSPACES_DIR_NAME),
      computeCollectedFilesChecksumAsync(allFiles),
    ]);

    return buildDshSummaryFromFiles(userDataPath, allFiles, {
      dshChecksum,
      workspaceChecksum,
      whitelistedChecksum,
    });
  } catch (error) {
    return {
      exists: false,
      workspacesExist: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const arraysEqual = (left: readonly string[] = [], right: readonly string[] = []): boolean => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

export const assertDshStateSummaryValuesMatch = (
  expectedSummary: DshStateMigrationSummary,
  actualSummary: DshStateMigrationSummary,
  label: string,
  options: { manifestVersion?: number } = {},
): void => {
  if (expectedSummary.error || actualSummary.error) {
    throw new Error(
      `${label} DSH state summary failed: ${expectedSummary.error || actualSummary.error}`,
    );
  }

  // Legacy v2 archives may have included non-whitelisted files under `dsh-profile/`
  // (e.g. `logs/` or `dsh-launcher/`) that v3 whitelist extraction intentionally omits.
  // For v2 archives, still strictly validate `workspaces/` and session presence;
  // for v3 archives, enforce full checksum equality across DSH, workspaces, and all whitelisted files.
  if (options.manifestVersion === 2) {
    if (expectedSummary.workspacesExist !== actualSummary.workspacesExist) {
      throw new Error(
        `${label} DSH state workspacesExist mismatch: expected ${String(expectedSummary.workspacesExist)}, got ${String(actualSummary.workspacesExist)}.`,
      );
    }
    if (
      expectedSummary.workspaceFileCount !== undefined
      && expectedSummary.workspaceFileCount !== actualSummary.workspaceFileCount
    ) {
      throw new Error(
        `${label} DSH state workspaceFileCount mismatch: expected ${String(expectedSummary.workspaceFileCount)}, got ${String(actualSummary.workspaceFileCount)}.`,
      );
    }
    if (
      expectedSummary.workspaceTotalSizeBytes !== undefined
      && expectedSummary.workspaceTotalSizeBytes !== actualSummary.workspaceTotalSizeBytes
    ) {
      throw new Error(
        `${label} DSH state workspaceTotalSizeBytes mismatch: expected ${String(expectedSummary.workspaceTotalSizeBytes)}, got ${String(actualSummary.workspaceTotalSizeBytes)}.`,
      );
    }
    if (
      expectedSummary.workspaceChecksumSha256 !== undefined
      && expectedSummary.workspaceChecksumSha256 !== actualSummary.workspaceChecksumSha256
    ) {
      throw new Error(`${label} DSH state workspaceChecksumSha256 mismatch.`);
    }
    if (
      expectedSummary.sessionFileCount !== undefined
      && expectedSummary.sessionFileCount !== actualSummary.sessionFileCount
    ) {
      throw new Error(
        `${label} DSH state sessionFileCount mismatch: expected ${String(expectedSummary.sessionFileCount)}, got ${String(actualSummary.sessionFileCount)}.`,
      );
    }
    return;
  }

  if (expectedSummary.exists !== actualSummary.exists) {
    throw new Error(
      `${label} DSH state exists mismatch: expected ${String(expectedSummary.exists)}, got ${String(actualSummary.exists)}.`,
    );
  }
  if (expectedSummary.workspacesExist !== actualSummary.workspacesExist) {
    throw new Error(
      `${label} DSH state workspacesExist mismatch: expected ${String(expectedSummary.workspacesExist)}, got ${String(actualSummary.workspacesExist)}.`,
    );
  }

  for (const fieldName of [
    'fileCount',
    'totalSizeBytes',
    'checksumSha256',
    'sessionCount',
    'sessionFileCount',
    'profileConfigExists',
    'workspaceFileCount',
    'workspaceTotalSizeBytes',
    'workspaceChecksumSha256',
    'whitelistedFileCount',
    'whitelistedTotalSizeBytes',
    'whitelistedChecksumSha256',
  ] as const) {
    if (expectedSummary[fieldName] !== undefined && expectedSummary[fieldName] !== actualSummary[fieldName]) {
      throw new Error(
        `${label} DSH state ${fieldName} mismatch: expected ${String(expectedSummary[fieldName])}, got ${String(actualSummary[fieldName])}.`,
      );
    }
  }

  if (
    expectedSummary.workspaceAgentIds !== undefined
    && !arraysEqual(expectedSummary.workspaceAgentIds, actualSummary.workspaceAgentIds ?? [])
  ) {
    throw new Error(
      `${label} DSH state workspaceAgentIds mismatch: expected [${expectedSummary.workspaceAgentIds.join(', ')}], got [${(actualSummary.workspaceAgentIds ?? []).join(', ')}].`,
    );
  }
};

export const assertDshStateSummaryMatches = (
  expectedUserDataPath: string,
  actualUserDataPath: string,
  label: string,
): void => {
  const expectedSummary = readDshStateMigrationSummarySync(expectedUserDataPath);
  const actualSummary = readDshStateMigrationSummarySync(actualUserDataPath);
  assertDshStateSummaryValuesMatch(expectedSummary, actualSummary, label);
};

export const buildArchiveStatsFromSummaries = (
  sqliteSummary: SqliteMigrationSummary | undefined,
  dshSummary: DshStateMigrationSummary | undefined,
  skillCount = 0,
): DataMigrationArchiveStats => {
  const thirdPartyPluginNames = dshSummary?.thirdPartyPluginNames ?? [];
  const whitelistedBytes = dshSummary?.whitelistedTotalSizeBytes
    ?? ((dshSummary?.totalSizeBytes ?? 0) + (dshSummary?.workspaceTotalSizeBytes ?? 0));

  return {
    sessionCount: sqliteSummary?.totalSessionCount ?? sqliteSummary?.rowCounts?.cowork_sessions ?? 0,
    agentCount: sqliteSummary?.agentIds?.length ?? sqliteSummary?.rowCounts?.agents ?? 0,
    scheduledTaskCount: sqliteSummary?.scheduledTaskCount
      ?? sqliteSummary?.rowCounts?.lobster_scheduled_tasks
      ?? 0,
    mcpServerCount: sqliteSummary?.mcpServerCount ?? sqliteSummary?.rowCounts?.mcp_servers ?? 0,
    skillCount,
    thirdPartyPluginCount: thirdPartyPluginNames.length,
    thirdPartyPluginNames,
    dshSessionCount: dshSummary?.sessionCount ?? 0,
    workspaceAgentCount: dshSummary?.workspaceAgentIds?.length ?? 0,
    estimatedUncompressedBytes: (sqliteSummary?.sizeBytes ?? 0) + whitelistedBytes,
  };
};

export const buildManifestSync = (options: {
  sourceUserDataPath: string;
  stageUserDataRoot: string;
  sqlitePath: string;
  archiveKind: DataMigrationArchiveKind;
  appVersion?: string;
  now?: Date;
}): MigrationManifest => {
  const now = options.now ?? new Date();
  const sqliteSummary = readSqliteMigrationSummarySync(options.sqlitePath);
  const dshSummary = readDshStateMigrationSummarySync(options.stageUserDataRoot);
  const allFiles = collectWhitelistedFilesSync(options.stageUserDataRoot);
  const stats = buildArchiveStatsFromSummaries(
    sqliteSummary,
    dshSummary,
    countSkillsDirectories(allFiles),
  );

  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_FORMAT_VERSION,
    engine: ARCHIVE_ENGINE,
    appName: APP_NAME,
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    archiveKind: options.archiveKind,
    archiveRoot: CURRENT_ARCHIVE_ROOT,
    sourceUserDataPath: path.resolve(options.sourceUserDataPath),
    createdAt: now.toISOString(),
    platform: process.platform,
    arch: process.arch,
    includesWorkingDirectories: false,
    whitelistPaths: [...WHITELIST_MANIFEST_PATHS],
    stats,
    sqlite: sqliteSummary,
    dshState: dshSummary,
  };
};

export const buildManifestAsync = async (options: {
  sourceUserDataPath: string;
  stageUserDataRoot: string;
  sqlitePath: string;
  archiveKind: DataMigrationArchiveKind;
  appVersion?: string;
  now?: Date;
}): Promise<MigrationManifest> => {
  const now = options.now ?? new Date();
  const sqliteSummary = readSqliteMigrationSummarySync(options.sqlitePath);
  const dshSummary = await readDshStateMigrationSummaryAsync(options.stageUserDataRoot);
  const allFiles = collectWhitelistedFilesSync(options.stageUserDataRoot);
  const stats = buildArchiveStatsFromSummaries(
    sqliteSummary,
    dshSummary,
    countSkillsDirectories(allFiles),
  );

  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_FORMAT_VERSION,
    engine: ARCHIVE_ENGINE,
    appName: APP_NAME,
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    archiveKind: options.archiveKind,
    archiveRoot: CURRENT_ARCHIVE_ROOT,
    sourceUserDataPath: path.resolve(options.sourceUserDataPath),
    createdAt: now.toISOString(),
    platform: process.platform,
    arch: process.arch,
    includesWorkingDirectories: false,
    whitelistPaths: [...WHITELIST_MANIFEST_PATHS],
    stats,
    sqlite: sqliteSummary,
    dshState: dshSummary,
  };
};

export const validateMigrationManifestObject = (manifest: MigrationManifest): MigrationManifest => {
  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new DataMigrationError(
      DataMigrationErrorCode.UnsupportedFormat,
      `Backup archive manifest format is unsupported: ${manifest.format || 'missing'}.`,
    );
  }
  if (manifest.version === 1) {
    throw new DataMigrationError(
      DataMigrationErrorCode.LegacyOpenClawUnsupported,
      'This backup was exported from the legacy OpenClaw engine and cannot be imported directly. Please upgrade LobsterAI on the original device first, then export a new backup.',
    );
  }
  if (manifest.version === undefined || !SUPPORTED_DSH_MANIFEST_VERSIONS.has(manifest.version)) {
    throw new DataMigrationError(
      DataMigrationErrorCode.UnsupportedFormat,
      `Backup archive manifest version is unsupported: ${String(manifest.version ?? 'missing')}.`,
    );
  }
  if (manifest.archiveRoot !== CURRENT_ARCHIVE_ROOT) {
    throw new DataMigrationError(
      DataMigrationErrorCode.UnsupportedFormat,
      `Backup archive manifest root is unsupported: ${manifest.archiveRoot || 'missing'}.`,
    );
  }
  if (!manifest.dshState) {
    throw new DataMigrationError(
      DataMigrationErrorCode.LegacyOpenClawUnsupported,
      'Backup archive does not contain DeepSeek Harness (DSH) state metadata.',
    );
  }
  return manifest;
};

export const readMigrationManifestSync = (sourceRoot: string): MigrationManifest => {
  const manifestPath = path.join(sourceRoot, MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive is missing ${MANIFEST_FILE_NAME}.`,
    );
  }
  let manifest: MigrationManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as MigrationManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive contains an unreadable ${MANIFEST_FILE_NAME}: ${message}`,
    );
  }
  return validateMigrationManifestObject(manifest);
};

export const validateExtractedArchiveContentSync = (sourceRoot: string): MigrationManifest => {
  const manifest = readMigrationManifestSync(sourceRoot);
  const sqliteSummary = assertMigrationSqliteReadySync(path.join(sourceRoot, DB_FILENAME), 'Backup archive');
  assertManifestSqliteSummaryMatches(manifest.sqlite, sqliteSummary, 'Backup archive manifest', manifest.version);

  const hashMode = manifest.version === 2 ? 'v2-raw' : 'v3-digest';
  const actualDshSummary = readDshStateMigrationSummarySync(sourceRoot, { hashMode });
  if (!manifest.dshState) {
    throw new DataMigrationError(
      DataMigrationErrorCode.LegacyOpenClawUnsupported,
      'Backup archive manifest is missing DSH state summary.',
    );
  }
  assertDshStateSummaryValuesMatch(
    manifest.dshState,
    actualDshSummary,
    'Backup archive manifest',
    { manifestVersion: manifest.version },
  );
  return manifest;
};

export const normalizeArchiveEntryPath = (entryPath: string): string => {
  let normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
};

export const assertSafeArchiveEntryPath = (entryPath: string): string => {
  const normalized = normalizeArchiveEntryPath(entryPath);
  if (!normalized || normalized.includes('\0')) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      'Backup archive contains an empty or invalid path.',
    );
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive contains an absolute path: ${entryPath}`,
    );
  }
  if (normalized.split('/').some(segment => segment === '..')) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive contains a parent-directory path: ${entryPath}`,
    );
  }
  return normalized;
};

export const resolveArchiveRoot = (entryPath: string): string | null => {
  if (entryPath === CURRENT_ARCHIVE_ROOT || entryPath.startsWith(`${CURRENT_ARCHIVE_ROOT}/`)) {
    return CURRENT_ARCHIVE_ROOT;
  }
  return null;
};

export const isArchiveRootParentDirectory = (entryPath: string): boolean =>
  `${CURRENT_ARCHIVE_ROOT}/`.startsWith(`${entryPath}/`);

export interface StreamedTarInspectResult {
  root: string;
  entryCount: number;
  hasSqliteDatabase: boolean;
  hasManifest: boolean;
  manifest: MigrationManifest | null;
}

/**
 * Streams through a `.tar.gz` archive in a single pass without extracting files
 * to disk: verifies gzip/tar stream integrity, validates every entry path and
 * type, and parses `.lobsterai-migration.json` directly from the stream.
 */
export const inspectTarGzStreamAsync = async (
  tarGzPath: string,
  options: {
    requireSqliteDatabase?: boolean;
    requireManifest?: boolean;
    validateManifest?: boolean;
  } = {},
): Promise<StreamedTarInspectResult> => {
  const requireSqliteDatabase = options.requireSqliteDatabase ?? true;
  const requireManifest = options.requireManifest ?? true;
  const validateManifest = options.validateManifest ?? true;

  let root: string | null = null;
  let entryCount = 0;
  let hasSqliteDatabase = false;
  let hasManifest = false;
  const manifestChunks: Buffer[] = [];
  let streamValidationError: Error | null = null;

  const manifestEntryPath = `${CURRENT_ARCHIVE_ROOT}/${MANIFEST_FILE_NAME}`;
  const sqliteEntryPath = `${CURRENT_ARCHIVE_ROOT}/${DB_FILENAME}`;

  await tar.list({
    file: tarGzPath,
    strict: true,
    onReadEntry: (entry) => {
      if (streamValidationError) {
        entry.resume();
        return;
      }
      try {
        const normalizedPath = assertSafeArchiveEntryPath(entry.path);
        const entryType = entry.type as string | undefined;
        if (entryType && !ALLOWED_ARCHIVE_ENTRY_TYPES.has(entryType)) {
          throw new DataMigrationError(
            DataMigrationErrorCode.CorruptedArchive,
            `Backup archive contains an unsupported entry type: ${entryType}`,
          );
        }

        const resolvedRoot = resolveArchiveRoot(normalizedPath);
        if (!resolvedRoot) {
          if (entryType === 'Directory' && isArchiveRootParentDirectory(normalizedPath)) {
            return;
          }
          throw new DataMigrationError(
            DataMigrationErrorCode.UnsupportedFormat,
            `Backup archive does not contain ${APP_NAME} user data: ${entry.path}`,
          );
        }

        root = resolvedRoot;
        entryCount += 1;

        if (normalizedPath === sqliteEntryPath) {
          if (entryType && entryType !== 'File' && entryType !== 'OldFile') {
            throw new DataMigrationError(
              DataMigrationErrorCode.CorruptedArchive,
              `Backup archive ${DB_FILENAME} entry is not a file.`,
            );
          }
          hasSqliteDatabase = true;
        }

        if (normalizedPath === manifestEntryPath) {
          if (entryType && entryType !== 'File' && entryType !== 'OldFile') {
            throw new DataMigrationError(
              DataMigrationErrorCode.CorruptedArchive,
              `Backup archive ${MANIFEST_FILE_NAME} entry is not a file.`,
            );
          }
          hasManifest = true;
          entry.on('data', (chunk: Buffer) => {
            manifestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
        }
      } catch (error) {
        streamValidationError = error instanceof Error ? error : new Error(String(error));
      }
    },
  });

  if (streamValidationError) {
    throw streamValidationError;
  }
  if (!root || entryCount <= 0) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      'Backup archive is empty or missing LobsterAI user data.',
    );
  }
  if (requireSqliteDatabase && !hasSqliteDatabase) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive is missing ${DB_FILENAME}.`,
    );
  }
  if (requireManifest && !hasManifest) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive is missing ${MANIFEST_FILE_NAME}.`,
    );
  }

  let manifest: MigrationManifest | null = null;
  if (hasManifest && manifestChunks.length > 0) {
    const raw = Buffer.concat(manifestChunks).toString('utf8');
    try {
      manifest = JSON.parse(raw) as MigrationManifest;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DataMigrationError(
        DataMigrationErrorCode.CorruptedArchive,
        `Backup archive contains an unreadable ${MANIFEST_FILE_NAME}: ${message}`,
      );
    }
    if (validateManifest) {
      validateMigrationManifestObject(manifest);
    }
  } else if (requireManifest && validateManifest) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive contains an empty ${MANIFEST_FILE_NAME}.`,
    );
  }

  return {
    root,
    entryCount,
    hasSqliteDatabase,
    hasManifest,
    manifest,
  };
};
