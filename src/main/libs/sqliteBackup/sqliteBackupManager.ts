import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DB_FILENAME } from '../../appConstants';
import {
  SQLITE_BACKUP_ALWAYS_ON_STARTUP_ENV,
  SQLITE_BACKUP_DIR_NAME,
  SQLITE_BACKUP_FILE_NAME,
  SQLITE_BACKUP_HEALTH_OK,
  SQLITE_BACKUP_INTERVAL_MS,
  SQLITE_BACKUP_MANIFEST_FILE_NAME,
  SQLITE_BACKUP_MANIFEST_VERSION,
  SQLITE_BACKUP_QUARANTINE_DIR_NAME,
  SQLITE_BACKUP_RETENTION_COUNT,
  SQLITE_BACKUP_SNAPSHOTS_DIR_NAME,
  type SqliteBackupManifest,
  type SqliteBackupRecord,
  SqliteBackupTrigger,
  type SqliteBackupTrigger as SqliteBackupTriggerType,
} from './constants';

export type SqliteBackupPaths = {
  backupDir: string;
  snapshotsDir: string;
  quarantineDir: string;
  manifestPath: string;
};

export type SqliteHealthCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

export type SqliteRestoreResult = {
  restored: boolean;
  snapshotFileName?: string;
};

type SqliteBackupProgress = {
  totalPages: number;
  remainingPages: number;
};

const SQLITE_BACKUP_PROGRESS_PAGE_RATE = 100;

const SINGLE_BACKUP_FILE_NAME = SQLITE_BACKUP_FILE_NAME;

const applyRecommendedPragmas = (db: Database.Database): void => {
  // WAL mode: persists across connections, never reverts. NORMAL sync is safe under WAL
  // (no data loss on OS crash; power-loss risk is the same as DELETE mode).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -8000'); // 8 MB; negative value = kibibytes
  db.pragma('wal_autocheckpoint = 1000'); // checkpoint every ~4 MB of WAL writes
};

const isRecoverableSqliteStartupError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === 'SQLITE_CORRUPT' || candidate.code === 'SQLITE_NOTADB') {
    return true;
  }
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return (
    message.includes('database disk image is malformed') ||
    message.includes('file is not a database') ||
    message.includes('malformed')
  );
};

const readPragmaNumber = (db: Database.Database, pragma: string): number | undefined => {
  const value = db.pragma(pragma, { simple: true });
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const fileExists = (filePath: string): boolean => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
};

const removeFileIfExists = (filePath: string): void => {
  if (!fileExists(filePath)) return;
  fs.rmSync(filePath, { force: true });
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const copyFile = (sourcePath: string, destinationPath: string): void => {
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
};

const padTimestampSegment = (value: number, width = 2): string => {
  return value.toString().padStart(width, '0');
};

export const formatTimestampForLocalPath = (value: number): string => {
  const date = new Date(value);
  return [
    padTimestampSegment(date.getFullYear(), 4),
    padTimestampSegment(date.getMonth() + 1),
    padTimestampSegment(date.getDate()),
  ].join('-')
    + 'T'
    + [
      padTimestampSegment(date.getHours()),
      padTimestampSegment(date.getMinutes()),
      padTimestampSegment(date.getSeconds()),
    ].join('-')
    + '-'
    + padTimestampSegment(date.getMilliseconds(), 3);
};

const computeFileSha256 = (filePath: string): string => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const readQuickCheck = (db: Database.Database): string => {
  const row = db.prepare('PRAGMA quick_check').pluck().get() as string | undefined;
  return typeof row === 'string' ? row : '';
};

const readIntegrityCheck = (db: Database.Database): string => {
  const row = db.prepare('PRAGMA integrity_check').pluck().get() as string | undefined;
  return typeof row === 'string' ? row : '';
};

export const buildSqliteBackupPaths = (userDataPath: string): SqliteBackupPaths => {
  const backupDir = path.join(userDataPath, SQLITE_BACKUP_DIR_NAME);
  return {
    backupDir,
    snapshotsDir: path.join(backupDir, SQLITE_BACKUP_SNAPSHOTS_DIR_NAME),
    quarantineDir: path.join(backupDir, SQLITE_BACKUP_QUARANTINE_DIR_NAME),
    manifestPath: path.join(backupDir, SQLITE_BACKUP_MANIFEST_FILE_NAME),
  };
};

export const retainLatestSnapshots = (
  records: SqliteBackupRecord[],
): { retained: SqliteBackupRecord[]; removed: SqliteBackupRecord[] } => {
  const sorted = [...records].sort((left, right) => right.createdAt - left.createdAt);
  return {
    retained: sorted.slice(0, SQLITE_BACKUP_RETENTION_COUNT),
    removed: sorted.slice(SQLITE_BACKUP_RETENTION_COUNT),
  };
};

const emptyManifest = (): SqliteBackupManifest => ({
  version: SQLITE_BACKUP_MANIFEST_VERSION,
  snapshots: [],
  updatedAt: Date.now(),
});

const isTruthyEnvValue = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const buildSingleBackupRecord = (record: SqliteBackupRecord): SqliteBackupRecord => ({
  ...record,
  fileName: SINGLE_BACKUP_FILE_NAME,
});

const buildBackupSwapPath = (backupFilePath: string): string => `${backupFilePath}.previous`;

const resolveBackupRestorePath = (backupFilePath: string): string | null => {
  if (fileExists(backupFilePath)) {
    return backupFilePath;
  }
  const swapPath = buildBackupSwapPath(backupFilePath);
  if (fileExists(swapPath)) {
    return swapPath;
  }
  return null;
};

const publishBackupFile = (tempFilePath: string, finalFilePath: string): void => {
  const swapFilePath = buildBackupSwapPath(finalFilePath);

  if (!fileExists(finalFilePath)) {
    fs.renameSync(tempFilePath, finalFilePath);
    removeFileIfExists(swapFilePath);
    return;
  }

  removeFileIfExists(swapFilePath);
  fs.renameSync(finalFilePath, swapFilePath);

  try {
    fs.renameSync(tempFilePath, finalFilePath);
    removeFileIfExists(swapFilePath);
  } catch (error) {
    if (!fileExists(finalFilePath) && fileExists(swapFilePath)) {
      try {
        fs.renameSync(swapFilePath, finalFilePath);
      } catch (restoreError) {
        console.error('[SqliteBackup] Failed to restore previous backup after publish error:', restoreError);
      }
    }
    throw error;
  }
};

export class SqliteBackupManager {
  private userDataPath: string;
  private periodicTimer: NodeJS.Timeout | null = null;

  constructor(userDataPath: string) {
    this.userDataPath = userDataPath;
  }

  getPaths(): SqliteBackupPaths {
    return buildSqliteBackupPaths(this.userDataPath);
  }

  readManifest(): SqliteBackupManifest {
    const { manifestPath } = this.getPaths();
    if (!fileExists(manifestPath)) {
      return emptyManifest();
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<SqliteBackupManifest>;
      if (!Array.isArray(parsed.snapshots)) {
        return emptyManifest();
      }
      return {
        version: SQLITE_BACKUP_MANIFEST_VERSION,
        snapshots: parsed.snapshots
          .filter((item): item is SqliteBackupRecord => Boolean(item?.fileName))
          .sort((left, right) => right.createdAt - left.createdAt),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    } catch (error) {
      console.warn('[SqliteBackup] Failed to read backup manifest, using empty state:', error);
      return emptyManifest();
    }
  }

  verifyDatabaseHealth(db: Database.Database): SqliteHealthCheckResult {
    try {
      const quickCheck = readQuickCheck(db);
      if (quickCheck === SQLITE_BACKUP_HEALTH_OK) {
        return { ok: true };
      }
      return { ok: false, reason: quickCheck || 'quick_check returned an empty result' };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'quick_check failed',
      };
    }
  }

  async createBackup(input: {
    db: Database.Database;
    trigger: SqliteBackupTriggerType;
  }): Promise<SqliteBackupRecord> {
    const { snapshotsDir } = this.getPaths();
    ensureDir(snapshotsDir);

    const createdAt = Date.now();
    const id = crypto.randomUUID();
    const tempFileName = `.tmp-${id}.sqlite`;
    const tempFilePath = path.join(snapshotsDir, tempFileName);
    const finalFileName = SINGLE_BACKUP_FILE_NAME;
    const finalFilePath = path.join(snapshotsDir, finalFileName);

    console.log(`[SqliteBackup] Starting ${input.trigger} backup to ${finalFileName}`);

    try {
      await input.db.backup(tempFilePath, {
        progress: (progress: SqliteBackupProgress) => {
          const transferredPages = Math.max(0, progress.totalPages - progress.remainingPages);
          console.debug(
            `[SqliteBackup] Backup progress: transferred ${transferredPages}/${progress.totalPages} pages, ${progress.remainingPages} remaining`,
          );
          return SQLITE_BACKUP_PROGRESS_PAGE_RATE;
        },
      });

      const verifyDb = new Database(tempFilePath, { readonly: true });
      const quickCheck = readQuickCheck(verifyDb);
      const sourceUserVersion = readPragmaNumber(verifyDb, 'user_version');
      const sourceSchemaVersion = readPragmaNumber(verifyDb, 'schema_version');
      verifyDb.close();

      if (quickCheck !== SQLITE_BACKUP_HEALTH_OK) {
        throw new Error(`Backup quick_check failed: ${quickCheck}`);
      }

      publishBackupFile(tempFilePath, finalFilePath);

      const stat = fs.statSync(finalFilePath);
      const record = buildSingleBackupRecord({
        id,
        fileName: finalFileName,
        createdAt,
        trigger: input.trigger,
        sizeBytes: stat.size,
        checksumSha256: computeFileSha256(finalFilePath),
        quickCheck: 'ok',
        sourceUserVersion,
        sourceSchemaVersion,
        restoreTested: false,
      });

      const nextManifest = this.writeManifest({
        version: SQLITE_BACKUP_MANIFEST_VERSION,
        snapshots: [record],
        updatedAt: Date.now(),
      });

      console.log(
        `[SqliteBackup] Completed ${input.trigger} backup with ${nextManifest.snapshots.length} retained snapshot(s)`,
      );
      return record;
    } catch (error) {
      removeFileIfExists(tempFilePath);
      console.error('[SqliteBackup] Backup creation failed:', error);
      throw error;
    }
  }

  restoreLatestBackup(dbFilePath: string): SqliteRestoreResult {
    const manifest = this.readManifest();
    const { snapshotsDir, quarantineDir } = this.getPaths();
    const quarantineStamp = formatTimestampForLocalPath(Date.now());
    const quarantineTargetDir = path.join(quarantineDir, quarantineStamp);
    let hasQuarantinedCurrentFiles = false;

    for (const snapshot of manifest.snapshots.sort((left, right) => right.createdAt - left.createdAt)) {
      const snapshotPath = resolveBackupRestorePath(path.join(snapshotsDir, snapshot.fileName));
      if (!snapshotPath) continue;

      try {
        if (!hasQuarantinedCurrentFiles) {
          ensureDir(quarantineTargetDir);
          this.quarantineDatabaseFiles(dbFilePath, quarantineTargetDir);
          hasQuarantinedCurrentFiles = true;
        }
        copyFile(snapshotPath, dbFilePath);
        removeFileIfExists(`${dbFilePath}-wal`);
        removeFileIfExists(`${dbFilePath}-shm`);

        const restoredDb = new Database(dbFilePath);
        const integrityCheck = readIntegrityCheck(restoredDb);
        restoredDb.close();

        if (integrityCheck !== SQLITE_BACKUP_HEALTH_OK) {
          throw new Error(`integrity_check failed: ${integrityCheck}`);
        }

        this.markSnapshotAsRestoreTested(snapshot.fileName);
        fs.writeFileSync(
          path.join(quarantineTargetDir, 'restore-context.json'),
          JSON.stringify(
            {
              restoredSnapshot: snapshot.fileName,
              restoredAt: Date.now(),
            },
            null,
            2,
          ),
          'utf8',
        );
        console.log(`[SqliteBackup] Restored database from snapshot ${snapshot.fileName}`);
        return { restored: true, snapshotFileName: snapshot.fileName };
      } catch (error) {
        console.warn(`[SqliteBackup] Failed to restore snapshot ${snapshot.fileName}:`, error);
        removeFileIfExists(dbFilePath);
      }
    }

    if (!hasQuarantinedCurrentFiles) {
      ensureDir(quarantineTargetDir);
      this.quarantineDatabaseFiles(dbFilePath, quarantineTargetDir);
    }
    return { restored: false };
  }

  shouldCreatePeriodicBackup(now = Date.now()): boolean {
    if (isTruthyEnvValue(process.env[SQLITE_BACKUP_ALWAYS_ON_STARTUP_ENV])) {
      console.log(
        `[SqliteBackup] Forced startup backup is enabled via ${SQLITE_BACKUP_ALWAYS_ON_STARTUP_ENV}`,
      );
      return true;
    }
    const latest = this.readManifest().snapshots[0];
    if (!latest) return true;
    const backupPath = path.join(this.getPaths().snapshotsDir, latest.fileName);
    if (!resolveBackupRestorePath(backupPath)) {
      console.warn('[SqliteBackup] Backup file is missing; scheduling a replacement backup');
      return true;
    }
    return now - latest.createdAt >= SQLITE_BACKUP_INTERVAL_MS;
  }

  async startPeriodicBackupLoop(getDb: () => Database.Database): Promise<void> {
    if (this.shouldCreatePeriodicBackup()) {
      await this.createBackup({ db: getDb(), trigger: SqliteBackupTrigger.Periodic });
    }
    this.stopPeriodicBackupLoop();
    this.periodicTimer = setInterval(() => {
      if (!this.shouldCreatePeriodicBackup()) return;
      void this.createBackup({ db: getDb(), trigger: SqliteBackupTrigger.Periodic }).catch((error) => {
        console.error('[SqliteBackup] Periodic backup failed:', error);
      });
    }, SQLITE_BACKUP_INTERVAL_MS);
  }

  stopPeriodicBackupLoop(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private writeManifest(manifest: SqliteBackupManifest): SqliteBackupManifest {
    const { backupDir, manifestPath, snapshotsDir } = this.getPaths();
    ensureDir(backupDir);
    ensureDir(snapshotsDir);

    const { retained, removed } = retainLatestSnapshots(manifest.snapshots);
    const nextManifest: SqliteBackupManifest = {
      version: SQLITE_BACKUP_MANIFEST_VERSION,
      snapshots: retained,
      updatedAt: Date.now(),
    };
    const tempManifestPath = `${manifestPath}.tmp`;
    fs.writeFileSync(tempManifestPath, JSON.stringify(nextManifest, null, 2), 'utf8');
    fs.renameSync(tempManifestPath, manifestPath);
    for (const record of removed) {
      if (record.fileName !== SINGLE_BACKUP_FILE_NAME) {
        removeFileIfExists(path.join(snapshotsDir, record.fileName));
      }
    }
    return nextManifest;
  }

  private quarantineDatabaseFiles(dbFilePath: string, quarantineTargetDir: string): void {
    const candidates = [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`];
    for (const candidate of candidates) {
      if (!fileExists(candidate)) continue;
      fs.renameSync(candidate, path.join(quarantineTargetDir, path.basename(candidate)));
    }
  }

  private markSnapshotAsRestoreTested(fileName: string): void {
    const manifest = this.readManifest();
    const snapshots = manifest.snapshots.map((snapshot) =>
      snapshot.fileName === fileName ? { ...snapshot, restoreTested: true } : snapshot,
    );
    this.writeManifest({
      ...manifest,
      snapshots,
      updatedAt: Date.now(),
    });
  }
}

export const getSqliteMainDbPath = (userDataPath: string): string => {
  return path.join(userDataPath, DB_FILENAME);
};

export const openSqliteDatabaseWithRecovery = (
  userDataPath: string,
  dbFilePath = getSqliteMainDbPath(userDataPath),
): Database.Database => {
  let db: Database.Database | null = null;

  try {
    db = new Database(dbFilePath);
    applyRecommendedPragmas(db);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Ignore close failures during recovery.
    }

    if (!isRecoverableSqliteStartupError(error)) {
      throw error;
    }

    console.warn('[SqliteBackup] SQLite startup failed; attempting snapshot recovery:', error);
    const backupManager = new SqliteBackupManager(userDataPath);
    const restoreResult = backupManager.restoreLatestBackup(dbFilePath);
    if (!restoreResult.restored) {
      console.warn('[SqliteBackup] Snapshot recovery did not restore any database file');
      throw error;
    }

    const recoveredDb = new Database(dbFilePath);
    applyRecommendedPragmas(recoveredDb);
    return recoveredDb;
  }
};
