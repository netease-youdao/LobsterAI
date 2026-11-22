// Cross-process constants and types for the OpenClaw -> DSH v2 one-shot
// offline migration & incompatible-modules backup report.

export const MIGRATION_V2_COMPLETED_KV_KEY = 'engine.migration.v2.completed';
export const MIGRATION_V2_REPORT_KV_KEY = 'engine.migration.v2.report';
export const MIGRATION_V2_CRON_BACKFILL_KV_KEY = 'engine.migration.v2.cronBackfillCompleted';
export const MIGRATION_V2_PERMISSION_PRESET_BACKFILL_KV_KEY = 'engine.migration.v2.permissionPresetBackfill';
export const MIGRATION_V2_USER_MEMORIES_BACKFILL_KV_KEY = 'engine.migration.v2.userMemoriesMigrated';
export const MIGRATION_V2_DREAM_DIARY_BACKFILL_KV_KEY = 'engine.migration.v2.dreamDiaryBackfilled';

export const MigrationV2Status = {
  Skipped: 'skipped',
  Completed: 'completed',
  Failed: 'failed',
} as const;
export type MigrationV2Status = typeof MigrationV2Status[keyof typeof MigrationV2Status];

export const MigrationV2Ipc = {
  GetReport: 'migration:v2:getReport',
  DismissReport: 'migration:v2:dismissReport',
  OpenBackupDir: 'migration:v2:openBackupDir',
} as const;
export type MigrationV2Ipc = typeof MigrationV2Ipc[keyof typeof MigrationV2Ipc];

export interface MigrationV2ArchivedItem {
  category:
    | 'user_plugins'
    | 'third_party_extensions'
    | 'openclaw_config'
    | 'retired_im'
    | 'dreaming_embedding'
    | 'message_versions'
    | 'external_chrome';
  label: string;
  count?: number;
  details?: string;
}

export interface MigrationV2ReauthItem {
  kind: 'mcp_oauth' | 'im_weixin' | 'im_feishu_uat';
  id: string;
  label: string;
}

export interface MigrationV2Report {
  version: 2;
  migratedAt: string;
  backupDir: string;
  incompatibleArchivePath: string;
  legacyStateArchivePath: string | null;
  sqliteSnapshotPath: string;
  dismissed: boolean;
  summary: {
    workspacesMigrated: number;
    userMemoriesMigrated?: number;
    scheduledTasksMigrated: number;
    scheduledTaskRunsMigrated?: number;
    imAllowListsMigrated: number;
    sessionsPreSeeded?: number;
    sessionsPreservedForLazyBridge: number;
    mcpLaunchCachesCleared: number;
    disposableBytesFreed: number;
  };
  archivedModules: MigrationV2ArchivedItem[];
  reauthRequired: MigrationV2ReauthItem[];
}
