import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import {
  DataMigrationErrorCode,
  type DataMigrationLastRestoreResult,
  type DataMigrationPostRestoreNotices,
  type DataMigrationPreviewResult,
  type DataMigrationProgressEvent,
  DataMigrationProgressOperation,
  DataMigrationProgressPhase,
  DataMigrationRestoreStatus,
} from '../../../shared/dataMigration/constants';
import { APP_NAME, DB_FILENAME } from '../../appConstants';
import {
  ALLOWED_ARCHIVE_ENTRY_TYPES,
  assertDshStateSummaryMatches,
  assertDshStateSummaryValuesMatch,
  assertSafeArchiveEntryPath,
  buildArchiveStatsFromSummaries,
  buildManifestAsync,
  buildManifestSync,
  CURRENT_ARCHIVE_ROOT,
  type DataMigrationArchiveKind,
  type DshStateMigrationSummary,
  inspectTarGzStreamAsync,
  isArchiveRootParentDirectory,
  MANIFEST_FILE_NAME,
  type MigrationManifest,
  readDshStateMigrationSummarySync,
  readMigrationManifestSync,
  resolveArchiveRoot,
  validateExtractedArchiveContentSync,
} from './archiveManifest';
import {
  clearWhitelistedUserDataSync,
  collectWhitelistedFilesSync,
  copyWhitelistedFilesSync,
  DEFAULT_MAX_ROLLBACK_ARCHIVES,
  isWhitelistedAncestorDirectory,
  isWhitelistedMigrationPath,
  pruneOldRollbackArchivesSync,
} from './archiveWhitelist';
import {
  DataMigrationError,
  isDataMigrationError,
} from './dataMigrationError';
import {
  detectMissingThirdPartyDshPluginsSync,
  type PostRestoreSafeStoragePort,
  sanitizeRestoredStateSync,
} from './postRestoreSanitizer';
import { rewriteRestoredUserDataPathsInSqliteSync } from './rewriteRestoredUserDataPaths';
import {
  assertDataMigrationSqliteSnapshotMatchesLiveSync,
  assertMigrationSqliteReadySync,
  assertSqliteCriticalSummaryMatches,
  checkpointSqliteDatabaseSync,
  createDataMigrationSqliteSnapshot,
  SQLITE_CORE_DSH_TABLES,
  SQLITE_RESTORE_FILE_NAMES,
} from './sqliteMigrationSnapshot';

export {
  assertDataMigrationSqliteSnapshotMatchesLiveSync,
  createDataMigrationSqliteSnapshot,
  type DataMigrationArchiveKind,
  DataMigrationError,
  type DshStateMigrationSummary,
  isDataMigrationError,
  type PostRestoreSafeStoragePort,
  readDshStateMigrationSummarySync,
};

const PENDING_RESTORE_FILE_NAME = '.lobsterai-data-migration-restore-pending.json';
const LAST_RESTORE_RESULT_FILE_NAME = '.lobsterai-data-migration-restore-result.json';

const SQLITE_REPLACE_RETRY_DELAYS_MS = [
  50,
  100,
  250,
  500,
  1_000,
] as const;

const BACKUP_SPACE_SAFETY_FACTOR = 1.5;
const RESTORE_SPACE_SAFETY_FACTOR = 2.2;

export type DataMigrationProgressCallback = (event: DataMigrationProgressEvent) => void;

export interface CreateMigrationArchiveInput {
  userDataPath: string;
  outputPath: string;
  sqliteSnapshotPath?: string;
  now?: Date;
  archiveKind?: DataMigrationArchiveKind;
  appVersion?: string;
  onProgress?: DataMigrationProgressCallback;
  skipDiskSpaceCheck?: boolean;
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
  manifest?: MigrationManifest | null;
}

interface InspectMigrationArchiveOptions {
  requireSqliteDatabase?: boolean;
  validateSqliteDatabase?: boolean;
  requireManifest?: boolean;
  validateManifest?: boolean;
}

export interface PendingDataMigrationRestoreRequest {
  archivePath: string;
  requestedAt: string;
}

export interface PerformPendingDataMigrationRestoreInput {
  userDataPath: string;
  rollbackRootPath: string;
  defaultWorkingDirectory?: string;
  safeStorage?: PostRestoreSafeStoragePort | null;
  maxRollbackArchives?: number;
  now?: Date;
}

export interface PerformDataMigrationRestoreInput extends PerformPendingDataMigrationRestoreInput {
  archivePath: string;
  onProgress?: DataMigrationProgressCallback;
  skipDiskSpaceCheck?: boolean;
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
      // Ignore temporary cleanup failures.
    }
  }
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

const findExistingAncestorDir = (targetPath: string): string => {
  let current = resolvePath(targetPath);
  while (true) {
    if (fs.existsSync(current)) {
      try {
        return fs.statSync(current).isDirectory() ? current : path.dirname(current);
      } catch {
        return path.dirname(current);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
};

const formatBytesShort = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

export const assertSufficientDiskSpaceAsync = async (
  targetPath: string,
  requiredBytes: number,
  label: string,
): Promise<void> => {
  if (requiredBytes <= 0 || typeof fs.promises.statfs !== 'function') return;
  const checkDir = findExistingAncestorDir(targetPath);
  let stats: fs.StatsFs;
  try {
    stats = await fs.promises.statfs(checkDir);
  } catch {
    return;
  }
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return;
  if (availableBytes < requiredBytes) {
    throw new DataMigrationError(
      DataMigrationErrorCode.InsufficientDiskSpace,
      `Insufficient disk space for ${label}: need about ${formatBytesShort(requiredBytes)}, available ${formatBytesShort(availableBytes)}.`,
    );
  }
};

const copyWhitelistedFilesAsync = async (
  sourceRoot: string,
  targetRoot: string,
  skipAbsolutePath?: string,
  onProgress?: (copiedCount: number, totalCount: number) => void,
): Promise<void> => {
  const files = collectWhitelistedFilesSync(sourceRoot);
  const resolvedSkip = skipAbsolutePath ? resolvePath(skipAbsolutePath) : null;
  const total = files.length;
  let copied = 0;

  for (const file of files) {
    if (resolvedSkip && resolvePath(file.absolutePath) === resolvedSkip) continue;
    const targetPath = path.join(targetRoot, ...file.relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(file.absolutePath, targetPath);
    copied += 1;
    if (onProgress && (copied === total || copied % 20 === 0)) {
      onProgress(copied, total);
    }
  }
};

const copyLiveSqliteForArchiveSync = (
  userDataPath: string,
  stageUserDataRoot: string,
  sqliteSnapshotPath?: string,
): void => {
  if (sqliteSnapshotPath) {
    copyFileSync(resolvePath(sqliteSnapshotPath), path.join(stageUserDataRoot, DB_FILENAME));
    return;
  }

  // When archiving directly from a live userData directory without a pre-checkpointed
  // snapshot, include `-wal` and `-shm` so uncommitted WAL frames are preserved and
  // checkpointed cleanly on restore.
  for (const fileName of SQLITE_RESTORE_FILE_NAMES) {
    const src = path.join(userDataPath, fileName);
    if (!fs.existsSync(src)) continue;
    try {
      if (!fs.statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    copyFileSync(src, path.join(stageUserDataRoot, fileName));
  }
};

const isSqliteEntryRelativePath = (relPath: string): boolean =>
  SQLITE_RESTORE_FILE_NAMES.includes(relPath as typeof SQLITE_RESTORE_FILE_NAMES[number]);

const shouldExtractArchiveRelativePath = (
  relPath: string,
  isDirectoryEntry: boolean,
  options: { includeRollbackEntries?: boolean } = {},
): boolean => {
  if (!relPath) return true;
  if (relPath === MANIFEST_FILE_NAME) return true;
  if (isSqliteEntryRelativePath(relPath)) return true;
  if (options.includeRollbackEntries) {
    return isWhitelistedMigrationPath(relPath) || (isDirectoryEntry && isWhitelistedAncestorDirectory(relPath));
  }
  return isWhitelistedMigrationPath(relPath) || (isDirectoryEntry && isWhitelistedAncestorDirectory(relPath));
};

/**
 * Synchronous backup/rollback archive creator (used by synchronous rollback
 * creation and synchronous unit-test flows). Always produces a plaintext
 * `.tar.gz` containing strictly whitelisted DSH data and `lobsterai.sqlite`.
 */
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
    copyWhitelistedFilesSync(userDataPath, stageUserDataRoot, { skipAbsolutePath: outputPath });
    copyLiveSqliteForArchiveSync(
      userDataPath,
      stageUserDataRoot,
      input.sqliteSnapshotPath,
    );

    const stagedDbPath = path.join(stageUserDataRoot, DB_FILENAME);
    if (archiveKind !== 'rollback') {
      assertMigrationSqliteReadySync(stagedDbPath, 'Backup staging');
    }

    const manifest = buildManifestSync({
      sourceUserDataPath: userDataPath,
      stageUserDataRoot,
      sqlitePath: stagedDbPath,
      archiveKind,
      appVersion: input.appVersion,
      now: input.now,
    });
    writeJsonSync(path.join(stageUserDataRoot, MANIFEST_FILE_NAME), manifest);

    ensureDirSync(path.dirname(outputPath));
    const tempArchivePath = path.join(
      path.dirname(outputPath),
      `.${path.basename(outputPath)}.write-${crypto.randomUUID()}.tmp`,
    );
    try {
      tar.create({
        sync: true,
        gzip: true,
        file: tempArchivePath,
        cwd: stageParent,
        portable: true,
      }, [CURRENT_ARCHIVE_ROOT]);
      fs.renameSync(tempArchivePath, outputPath);
    } catch (error) {
      fs.rmSync(tempArchivePath, { force: true });
      throw error;
    }

    if (archiveKind !== 'rollback') {
      inspectMigrationArchiveSync(outputPath, {
        validateSqliteDatabase: false,
        validateManifest: false,
      });
    }

    return {
      outputPath,
      sizeBytes: fs.statSync(outputPath).size,
    };
  } finally {
    removeDirIfExistsSync(tempRoot);
  }
};

/**
 * Asynchronous streaming backup archive creator:
 * - checks available disk space before staging
 * - copies strictly whitelisted DSH data asynchronously
 * - builds Manifest v3 using streaming SHA-256 hashes
 * - streams tar.gz creation without blocking the main event loop
 * - verifies archive readability in a single streaming pass (zero disk extraction)
 */
export const createMigrationArchive = async (
  input: CreateMigrationArchiveInput,
): Promise<CreateMigrationArchiveResult> => {
  const userDataPath = resolvePath(input.userDataPath);
  const outputPath = resolvePath(input.outputPath);
  const archiveKind = input.archiveKind ?? 'backup';
  const emitProgress = (phase: DataMigrationProgressPhase, percent?: number, detail?: string): void => {
    input.onProgress?.({
      operation: DataMigrationProgressOperation.Backup,
      phase,
      percent,
      detail,
    });
  };

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobsterai-data-migration-'));
  const stageParent = path.join(tempRoot, 'stage');
  const stageUserDataRoot = path.join(stageParent, CURRENT_ARCHIVE_ROOT);

  try {
    if (!input.skipDiskSpaceCheck && archiveKind !== 'rollback') {
      emitProgress(DataMigrationProgressPhase.CheckingSpace, 5);
      const files = collectWhitelistedFilesSync(userDataPath);
      const filesBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      const sqliteSource = input.sqliteSnapshotPath
        ? resolvePath(input.sqliteSnapshotPath)
        : path.join(userDataPath, DB_FILENAME);
      const sqliteBytes = fs.existsSync(sqliteSource) ? fs.statSync(sqliteSource).size : 0;
      const estimatedBytes = Math.ceil((filesBytes + sqliteBytes) * BACKUP_SPACE_SAFETY_FACTOR);
      await assertSufficientDiskSpaceAsync(os.tmpdir(), estimatedBytes, 'backup staging');
      await assertSufficientDiskSpaceAsync(path.dirname(outputPath), estimatedBytes, 'backup output');
    }

    emitProgress(DataMigrationProgressPhase.CollectingFiles, 15);
    await fs.promises.mkdir(stageUserDataRoot, { recursive: true });
    await copyWhitelistedFilesAsync(
      userDataPath,
      stageUserDataRoot,
      outputPath,
      (copied, total) => {
        const pct = total > 0 ? 15 + Math.round((copied / total) * 25) : 40;
        emitProgress(DataMigrationProgressPhase.CollectingFiles, pct, `${copied}/${total}`);
      },
    );

    const stagedDbPath = path.join(stageUserDataRoot, DB_FILENAME);
    if (input.sqliteSnapshotPath) {
      await fs.promises.copyFile(resolvePath(input.sqliteSnapshotPath), stagedDbPath);
    } else {
      copyLiveSqliteForArchiveSync(userDataPath, stageUserDataRoot);
    }

    if (archiveKind !== 'rollback') {
      assertMigrationSqliteReadySync(stagedDbPath, 'Backup staging');
    }

    const manifest = await buildManifestAsync({
      sourceUserDataPath: userDataPath,
      stageUserDataRoot,
      sqlitePath: stagedDbPath,
      archiveKind,
      appVersion: input.appVersion,
      now: input.now,
    });
    writeJsonSync(path.join(stageUserDataRoot, MANIFEST_FILE_NAME), manifest);

    emitProgress(DataMigrationProgressPhase.CreatingArchive, 50);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const tempArchivePath = path.join(
      path.dirname(outputPath),
      `.${path.basename(outputPath)}.write-${crypto.randomUUID()}.tmp`,
    );

    try {
      await tar.create({
        gzip: true,
        file: tempArchivePath,
        cwd: stageParent,
        portable: true,
      }, [CURRENT_ARCHIVE_ROOT]);

      if (archiveKind !== 'rollback') {
        emitProgress(DataMigrationProgressPhase.VerifyingArchive, 85);
        await inspectTarGzStreamAsync(tempArchivePath, {
          requireSqliteDatabase: true,
          requireManifest: true,
          validateManifest: true,
        });
      }

      await fs.promises.rename(tempArchivePath, outputPath);
    } catch (error) {
      try {
        fs.rmSync(tempArchivePath, { force: true });
      } catch {
        // Best-effort cleanup.
      }
      throw error;
    }

    emitProgress(DataMigrationProgressPhase.Completed, 100);
    return {
      outputPath,
      sizeBytes: fs.statSync(outputPath).size,
    };
  } finally {
    removeDirIfExistsSync(tempRoot);
  }
};

const inspectArchiveEntrySync = (
  archivePath: string,
  entry: { path: string; type?: string },
  state: {
    root: string | null;
    entryCount: number;
    hasSqliteDatabase: boolean;
    hasManifest: boolean;
  },
): void => {
  const normalizedPath = assertSafeArchiveEntryPath(entry.path);
  if (entry.type && !ALLOWED_ARCHIVE_ENTRY_TYPES.has(entry.type)) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive contains an unsupported entry type: ${entry.type}`,
    );
  }

  const root = resolveArchiveRoot(normalizedPath);
  if (!root) {
    if (entry.type === 'Directory' && isArchiveRootParentDirectory(normalizedPath)) {
      return;
    }
    throw new DataMigrationError(
      DataMigrationErrorCode.UnsupportedFormat,
      `Backup archive does not contain ${APP_NAME} user data: ${entry.path}`,
    );
  }
  if (state.root && state.root !== root) {
    throw new DataMigrationError(
      DataMigrationErrorCode.UnsupportedFormat,
      `Backup archive contains multiple root directories: ${archivePath}`,
    );
  }
  state.root = root;
  state.entryCount += 1;
  if (normalizedPath === `${root}/${DB_FILENAME}`) {
    if (entry.type && entry.type !== 'File' && entry.type !== 'OldFile') {
      throw new DataMigrationError(
        DataMigrationErrorCode.CorruptedArchive,
        `Backup archive ${DB_FILENAME} entry is not a file.`,
      );
    }
    state.hasSqliteDatabase = true;
  }
  if (normalizedPath === `${root}/${MANIFEST_FILE_NAME}`) {
    if (entry.type && entry.type !== 'File' && entry.type !== 'OldFile') {
      throw new DataMigrationError(
        DataMigrationErrorCode.CorruptedArchive,
        `Backup archive ${MANIFEST_FILE_NAME} entry is not a file.`,
      );
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
        if ('type' in entry && entry.type && !ALLOWED_ARCHIVE_ENTRY_TYPES.has(entry.type)) {
          throw new DataMigrationError(
            DataMigrationErrorCode.CorruptedArchive,
            `Backup archive contains an unsupported entry type: ${entry.type}`,
          );
        }
        const archiveRoot = resolveArchiveRoot(normalizedPath);
        const isDirectoryEntry = 'type' in entry
          ? entry.type === 'Directory'
          : entry.isDirectory();
        if (!archiveRoot) {
          return isDirectoryEntry && isArchiveRootParentDirectory(normalizedPath);
        }
        if (archiveRoot !== root) return false;
        const relInsideRoot = normalizedPath === root ? '' : normalizedPath.slice(root.length + 1);
        return shouldExtractArchiveRelativePath(relInsideRoot, isDirectoryEntry);
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
    throw new DataMigrationError(
      DataMigrationErrorCode.UnsupportedFormat,
      'Backup archive must be a .tar.gz or .tgz file.',
    );
  }
  const requireSqliteDatabase = options.requireSqliteDatabase ?? true;
  const validateSqliteDatabase = options.validateSqliteDatabase ?? true;
  const requireManifest = options.requireManifest ?? true;
  const validateManifest = options.validateManifest ?? true;
  const state: {
    root: string | null;
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
    onReadEntry: entry => inspectArchiveEntrySync(resolvedArchivePath, entry, state),
  });

  if (!state.root || state.entryCount <= 0) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      'Backup archive is empty or missing LobsterAI user data.',
    );
  }
  if (requireSqliteDatabase && !state.hasSqliteDatabase) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive is missing ${DB_FILENAME}.`,
    );
  }
  if (requireManifest && !state.hasManifest) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive is missing ${MANIFEST_FILE_NAME}.`,
    );
  }
  if (
    (requireSqliteDatabase && validateSqliteDatabase)
    || (requireManifest && validateManifest)
  ) {
    validateArchiveContentSync(resolvedArchivePath, state.root);
  }

  return {
    archivePath: resolvedArchivePath,
    root: state.root,
    entryCount: state.entryCount,
    hasSqliteDatabase: state.hasSqliteDatabase,
    hasManifest: state.hasManifest,
  };
};

/**
 * Lightweight streaming preview for an archive:
 * reads `.lobsterai-migration.json` without extracting any files to disk,
 * rejects legacy v1 OpenClaw archives with `LegacyOpenClawUnsupported`, and
 * returns structured summary stats for the confirmation dialog.
 */
export const previewMigrationArchive = async (
  archivePath: string,
): Promise<DataMigrationPreviewResult> => {
  const resolvedArchivePath = resolvePath(archivePath);
  if (!fs.existsSync(resolvedArchivePath)) {
    return {
      success: false,
      archivePath: resolvedArchivePath,
      errorCode: DataMigrationErrorCode.CorruptedArchive,
      error: 'Selected backup archive does not exist.',
    };
  }

  const archiveSizeBytes = fs.statSync(resolvedArchivePath).size;

  if (!isSupportedMigrationArchivePath(resolvedArchivePath)) {
    return {
      success: false,
      archivePath: resolvedArchivePath,
      archiveSizeBytes,
      errorCode: DataMigrationErrorCode.UnsupportedFormat,
      error: 'Backup archive must be a .tar.gz or .tgz file.',
    };
  }

  try {
    const inspected = await inspectTarGzStreamAsync(resolvedArchivePath, {
      requireSqliteDatabase: true,
      requireManifest: true,
      validateManifest: true,
    });

    const manifest = inspected.manifest;
    const stats = manifest?.stats ?? buildArchiveStatsFromSummaries(manifest?.sqlite, manifest?.dshState);

    return {
      success: true,
      archivePath: resolvedArchivePath,
      archiveSizeBytes,
      manifestVersion: manifest?.version,
      createdAt: manifest?.createdAt,
      appVersion: manifest?.appVersion,
      sourcePlatform: manifest?.platform,
      sourceArch: manifest?.arch,
      stats,
    };
  } catch (error) {
    const errorCode = isDataMigrationError(error)
      ? error.code
      : DataMigrationErrorCode.CorruptedArchive;
    return {
      success: false,
      archivePath: resolvedArchivePath,
      archiveSizeBytes,
      errorCode,
      error: error instanceof Error ? error.message : 'Failed to inspect backup archive.',
    };
  }
};

export const inspectMigrationArchive = async (
  archivePath: string,
): Promise<MigrationArchiveInfo> => {
  const resolvedArchivePath = resolvePath(archivePath);
  if (!isSupportedMigrationArchivePath(resolvedArchivePath)) {
    throw new DataMigrationError(
      DataMigrationErrorCode.UnsupportedFormat,
      'Backup archive must be a .tar.gz or .tgz file.',
    );
  }
  const inspected = await inspectTarGzStreamAsync(resolvedArchivePath, {
    requireSqliteDatabase: true,
    requireManifest: true,
    validateManifest: true,
  });
  return {
    archivePath: resolvedArchivePath,
    root: inspected.root,
    entryCount: inspected.entryCount,
    hasSqliteDatabase: inspected.hasSqliteDatabase,
    hasManifest: inspected.hasManifest,
    manifest: inspected.manifest,
  };
};

const extractTarGzToTempSync = (
  tarGzPath: string,
  options: {
    requireSqliteDatabase?: boolean;
    requireManifest?: boolean;
    validateArchiveContent?: boolean;
    includeRollbackEntries?: boolean;
  } = {},
): { tempRoot: string; sourceRoot: string; info: MigrationArchiveInfo } => {
  const info = inspectMigrationArchiveSync(tarGzPath, {
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
        if ('type' in entry && entry.type && !ALLOWED_ARCHIVE_ENTRY_TYPES.has(entry.type)) {
          throw new DataMigrationError(
            DataMigrationErrorCode.CorruptedArchive,
            `Backup archive contains an unsupported entry type: ${entry.type}`,
          );
        }
        const root = resolveArchiveRoot(normalizedPath);
        const isDirectoryEntry = 'type' in entry
          ? entry.type === 'Directory'
          : entry.isDirectory();
        if (!root) {
          return isDirectoryEntry && isArchiveRootParentDirectory(normalizedPath);
        }
        if (root !== info.root) return false;
        const relInsideRoot = normalizedPath === root ? '' : normalizedPath.slice(root.length + 1);
        return shouldExtractArchiveRelativePath(relInsideRoot, isDirectoryEntry, {
          includeRollbackEntries: options.includeRollbackEntries,
        });
      },
    });

    const sourceRoot = path.join(tempRoot, ...info.root.split('/'));
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      throw new DataMigrationError(
        DataMigrationErrorCode.CorruptedArchive,
        'Backup archive did not extract a valid LobsterAI user data directory.',
      );
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

const extractTarGzToTempAsync = async (
  tarGzPath: string,
  options: {
    requireSqliteDatabase?: boolean;
    requireManifest?: boolean;
    validateArchiveContent?: boolean;
  } = {},
): Promise<{ tempRoot: string; sourceRoot: string; root: string }> => {
  const inspected = await inspectTarGzStreamAsync(tarGzPath, {
    requireSqliteDatabase: options.requireSqliteDatabase ?? true,
    requireManifest: options.requireManifest ?? true,
    validateManifest: options.validateArchiveContent ?? true,
  });

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobsterai-data-migration-restore-'));
  try {
    await tar.extract({
      file: tarGzPath,
      cwd: tempRoot,
      preservePaths: false,
      unlink: true,
      filter: (entryPath, entry) => {
        const normalizedPath = assertSafeArchiveEntryPath(entryPath);
        if ('type' in entry && entry.type && !ALLOWED_ARCHIVE_ENTRY_TYPES.has(entry.type)) {
          throw new DataMigrationError(
            DataMigrationErrorCode.CorruptedArchive,
            `Backup archive contains an unsupported entry type: ${entry.type}`,
          );
        }
        const root = resolveArchiveRoot(normalizedPath);
        const isDirectoryEntry = 'type' in entry
          ? entry.type === 'Directory'
          : entry.isDirectory();
        if (!root) {
          return isDirectoryEntry && isArchiveRootParentDirectory(normalizedPath);
        }
        if (root !== inspected.root) return false;
        const relInsideRoot = normalizedPath === root ? '' : normalizedPath.slice(root.length + 1);
        return shouldExtractArchiveRelativePath(relInsideRoot, isDirectoryEntry);
      },
    });

    const sourceRoot = path.join(tempRoot, ...inspected.root.split('/'));
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      throw new DataMigrationError(
        DataMigrationErrorCode.CorruptedArchive,
        'Backup archive did not extract a valid LobsterAI user data directory.',
      );
    }
    if (options.validateArchiveContent ?? true) {
      validateExtractedArchiveContentSync(sourceRoot);
    }
    return { tempRoot, sourceRoot, root: inspected.root };
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
  errorCode: isDataMigrationError(error) ? error.code : DataMigrationErrorCode.RestoreFailed,
  error: error instanceof Error ? error.message : String(error),
});

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

  if (!fs.existsSync(sourceDbPath)) return;
  if (!fs.statSync(sourceDbPath).isFile()) {
    throw new DataMigrationError(
      DataMigrationErrorCode.CorruptedArchive,
      `Backup archive ${DB_FILENAME} entry is not a file.`,
    );
  }

  copyFileReplacingWithRetrySync(sourceDbPath, targetDbPath);

  if (!options.includeSidecars) return;

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

const replaceWhitelistedUserDataSync = (
  sourceRoot: string,
  userDataPath: string,
  options: { includeSqliteSidecars?: boolean } = {},
): void => {
  clearWhitelistedUserDataSync(userDataPath, removePathWithRetrySync);
  copyWhitelistedFilesSync(sourceRoot, userDataPath);
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

  for (const tableName of SQLITE_CORE_DSH_TABLES) {
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
  const rollback = extractTarGzToTempSync(rollbackPath, {
    requireSqliteDatabase: false,
    requireManifest: false,
    validateArchiveContent: false,
    includeRollbackEntries: true,
  });
  try {
    replaceWhitelistedUserDataSync(rollback.sourceRoot, userDataPath, {
      includeSqliteSidecars: true,
    });
  } finally {
    removeDirIfExistsSync(rollback.tempRoot);
  }
};

const applyExtractedRestoreSync = (options: {
  sourceRoot: string;
  userDataPath: string;
  manifest: MigrationManifest;
  defaultWorkingDirectory?: string;
  safeStorage?: PostRestoreSafeStoragePort | null;
  onTargetTouched: () => void;
  onPhase?: (phase: DataMigrationProgressPhase, percent?: number) => void;
}): DataMigrationPostRestoreNotices => {
  const { sourceRoot, userDataPath, manifest } = options;
  const extractedDbPath = path.join(sourceRoot, DB_FILENAME);

  options.onPhase?.(DataMigrationProgressPhase.SanitizingData, 65);
  assertMigrationSqliteReadySync(extractedDbPath, 'Backup archive');
  checkpointSqliteDatabaseSync(extractedDbPath, 'Backup archive');

  const rewriteResult = rewriteRestoredUserDataPathsInSqliteSync(extractedDbPath, {
    sourceUserDataPath: manifest.sourceUserDataPath,
    targetUserDataPath: resolvePath(userDataPath),
    existsInTarget: (relPosix) => fs.existsSync(path.join(sourceRoot, ...relPosix.split('/'))),
  });

  const notices = sanitizeRestoredStateSync({
    dbPath: extractedDbPath,
    userDataPath: resolvePath(userDataPath),
    sourceUserDataPath: manifest.sourceUserDataPath,
    sourcePlatform: manifest.platform,
    defaultWorkingDirectory: options.defaultWorkingDirectory,
    safeStorage: options.safeStorage,
    rewrittenPathCount: rewriteResult.updatedRows,
    skipPluginCheck: true,
  });

  checkpointSqliteDatabaseSync(extractedDbPath, 'Backup archive');
  const postSanitizeSummary = assertMigrationSqliteReadySync(extractedDbPath, 'Backup archive');

  options.onPhase?.(DataMigrationProgressPhase.ApplyingData, 80);
  options.onTargetTouched();
  replaceWhitelistedUserDataSync(sourceRoot, userDataPath);
  assertSqliteRestoredSync(sourceRoot, userDataPath, postSanitizeSummary);

  if (manifest.dshState && manifest.version === 3) {
    assertDshStateSummaryValuesMatch(
      manifest.dshState,
      readDshStateMigrationSummarySync(userDataPath),
      'Restored data',
      { manifestVersion: manifest.version },
    );
  }
  assertDshStateSummaryMatches(sourceRoot, userDataPath, 'Restored data');
  removeSqliteSidecarsWithRetrySync(userDataPath);

  const missingDshPlugins = detectMissingThirdPartyDshPluginsSync(userDataPath);
  if (missingDshPlugins.length > 0) {
    notices.missingDshPlugins = missingDshPlugins;
  }

  return notices;
};

/**
 * Synchronous restore (used before app ready by `performPendingDataMigrationRestoreSync`
 * and synchronous unit tests; supports plaintext `.tar.gz` / `.tgz` archives).
 */
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
      pruneOldRollbackArchivesSync(
        input.rollbackRootPath,
        input.maxRollbackArchives ?? DEFAULT_MAX_ROLLBACK_ARCHIVES,
      );
    }

    const extracted = extractTarGzToTempSync(archivePath);
    extractedTempRoot = extracted.tempRoot;
    const extractedManifest = readMigrationManifestSync(extracted.sourceRoot);

    const notices = applyExtractedRestoreSync({
      sourceRoot: extracted.sourceRoot,
      userDataPath: input.userDataPath,
      manifest: extractedManifest,
      defaultWorkingDirectory: input.defaultWorkingDirectory,
      safeStorage: input.safeStorage,
      onTargetTouched: () => {
        targetWasTouched = true;
      },
    });

    const result: DataMigrationLastRestoreResult = {
      status: DataMigrationRestoreStatus.Success,
      archivePath,
      rollbackPath,
      restoredAt: now.toISOString(),
      notices,
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
      // If marker writing fails, still return the failure result.
    }
    return result;
  } finally {
    if (extractedTempRoot) {
      removeDirIfExistsSync(extractedTempRoot);
    }
  }
};

/**
 * Asynchronous streaming restore supporting `.tar.gz` / `.tgz` backups,
 * disk-space precheck, live progress events, rollback rotation, full path
 * rewriting, and cross-machine sanitization.
 */
export const performDataMigrationRestore = async (
  input: PerformDataMigrationRestoreInput,
): Promise<DataMigrationLastRestoreResult> => {
  const now = input.now ?? new Date();
  const archivePath = resolvePath(input.archivePath);
  let rollbackPath: string | undefined;
  let rollbackReady = false;
  let extractedTempRoot: string | null = null;
  let targetWasTouched = false;

  const emitProgress = (phase: DataMigrationProgressPhase, percent?: number, detail?: string): void => {
    input.onProgress?.({
      operation: DataMigrationProgressOperation.Restore,
      phase,
      percent,
      detail,
    });
  };

  try {
    if (!input.skipDiskSpaceCheck) {
      emitProgress(DataMigrationProgressPhase.CheckingSpace, 15);
      const archiveBytes = fs.statSync(archivePath).size;
      const estimatedRequired = Math.ceil(archiveBytes * RESTORE_SPACE_SAFETY_FACTOR);
      await assertSufficientDiskSpaceAsync(input.rollbackRootPath, estimatedRequired, 'restore rollback');
      await assertSufficientDiskSpaceAsync(input.userDataPath, estimatedRequired, 'restore target');
    }

    ensureDirSync(input.rollbackRootPath);
    if (fs.existsSync(input.userDataPath)) {
      emitProgress(DataMigrationProgressPhase.CreatingRollback, 28);
      rollbackPath = path.join(input.rollbackRootPath, buildDataMigrationRollbackFileName(now));
      await createMigrationArchive({
        userDataPath: input.userDataPath,
        outputPath: rollbackPath,
        now,
        archiveKind: 'rollback',
        skipDiskSpaceCheck: true,
      });
      rollbackReady = true;
      pruneOldRollbackArchivesSync(
        input.rollbackRootPath,
        input.maxRollbackArchives ?? DEFAULT_MAX_ROLLBACK_ARCHIVES,
      );
    }

    emitProgress(DataMigrationProgressPhase.ExtractingArchive, 48);
    const extracted = await extractTarGzToTempAsync(archivePath);
    extractedTempRoot = extracted.tempRoot;
    const extractedManifest = readMigrationManifestSync(extracted.sourceRoot);

    const notices = applyExtractedRestoreSync({
      sourceRoot: extracted.sourceRoot,
      userDataPath: input.userDataPath,
      manifest: extractedManifest,
      defaultWorkingDirectory: input.defaultWorkingDirectory,
      safeStorage: input.safeStorage,
      onTargetTouched: () => {
        targetWasTouched = true;
      },
      onPhase: (phase, percent) => emitProgress(phase, percent),
    });

    const result: DataMigrationLastRestoreResult = {
      status: DataMigrationRestoreStatus.Success,
      archivePath,
      rollbackPath,
      restoredAt: now.toISOString(),
      notices,
    };
    writeRestoreResultSync(input.userDataPath, result);
    emitProgress(DataMigrationProgressPhase.Completed, 100);
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
      // If marker writing fails, still return the failure result.
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
