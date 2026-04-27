export const SqliteBackupTrigger = {
  Periodic: 'periodic',
  Manual: 'manual',
} as const;

export type SqliteBackupTrigger =
  typeof SqliteBackupTrigger[keyof typeof SqliteBackupTrigger];

export const SQLITE_BACKUP_DIR_NAME = 'backups/sqlite';
export const SQLITE_BACKUP_SNAPSHOTS_DIR_NAME = 'snapshots';
export const SQLITE_BACKUP_QUARANTINE_DIR_NAME = 'quarantine';
export const SQLITE_BACKUP_MANIFEST_FILE_NAME = 'manifest.json';
export const SQLITE_BACKUP_FILE_NAME = 'lobsterai-latest.sqlite';
export const SQLITE_BACKUP_RETENTION_COUNT = 1;
export const SQLITE_BACKUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
export const SQLITE_BACKUP_ALWAYS_ON_STARTUP_ENV = 'LOBSTERAI_SQLITE_BACKUP_ALWAYS_ON_STARTUP';
export const SQLITE_BACKUP_MANIFEST_VERSION = 1 as const;
export const SQLITE_BACKUP_HEALTH_OK = 'ok' as const;

export type SqliteBackupRecord = {
  id: string;
  fileName: string;
  createdAt: number;
  trigger: SqliteBackupTrigger;
  sizeBytes: number;
  checksumSha256: string;
  quickCheck: 'ok' | 'failed';
  sourceUserVersion?: number;
  sourceSchemaVersion?: number;
  restoreTested: boolean;
};

export type SqliteBackupManifest = {
  version: 1;
  snapshots: SqliteBackupRecord[];
  updatedAt: number;
};
