export const DataMigrationIpc = {
  Backup: 'openclaw:dataMigration:backup',
  PickRestoreArchive: 'openclaw:dataMigration:pickRestoreArchive',
  Preview: 'openclaw:dataMigration:preview',
  Restore: 'openclaw:dataMigration:restore',
  GetLastRestoreResult: 'openclaw:dataMigration:getLastRestoreResult',
  Progress: 'openclaw:dataMigration:progress',
  ReinstallPlugins: 'openclaw:dataMigration:reinstallPlugins',
} as const;

export type DataMigrationIpc =
  typeof DataMigrationIpc[keyof typeof DataMigrationIpc];

export const DataMigrationRestoreStatus = {
  Success: 'success',
  Failed: 'failed',
} as const;

export type DataMigrationRestoreStatus =
  typeof DataMigrationRestoreStatus[keyof typeof DataMigrationRestoreStatus];

export const DataMigrationErrorCode = {
  ActiveWorkloads: 'active_workloads',
  LegacyOpenClawUnsupported: 'legacy_openclaw_unsupported',
  InsufficientDiskSpace: 'insufficient_disk_space',
  CorruptedArchive: 'corrupted_archive',
  UnsupportedFormat: 'unsupported_format',
  RestoreFailed: 'restore_failed',
} as const;

export type DataMigrationErrorCode =
  typeof DataMigrationErrorCode[keyof typeof DataMigrationErrorCode];

export const DataMigrationProgressOperation = {
  Backup: 'backup',
  Restore: 'restore',
} as const;

export type DataMigrationProgressOperation =
  typeof DataMigrationProgressOperation[keyof typeof DataMigrationProgressOperation];

export const DataMigrationProgressPhase = {
  CheckingSpace: 'checking_space',
  SnapshottingDatabase: 'snapshotting_database',
  CollectingFiles: 'collecting_files',
  CreatingArchive: 'creating_archive',
  VerifyingArchive: 'verifying_archive',
  CreatingRollback: 'creating_rollback',
  ExtractingArchive: 'extracting_archive',
  SanitizingData: 'sanitizing_data',
  ApplyingData: 'applying_data',
  Completed: 'completed',
} as const;

export type DataMigrationProgressPhase =
  typeof DataMigrationProgressPhase[keyof typeof DataMigrationProgressPhase];

export interface DataMigrationProgressEvent {
  operation: DataMigrationProgressOperation;
  phase: DataMigrationProgressPhase;
  percent?: number;
  detail?: string;
}

export interface DataMigrationArchiveStats {
  sessionCount: number;
  agentCount: number;
  scheduledTaskCount: number;
  mcpServerCount: number;
  skillCount: number;
  thirdPartyPluginCount: number;
  thirdPartyPluginNames: string[];
  dshSessionCount: number;
  workspaceAgentCount: number;
  estimatedUncompressedBytes: number;
}

export interface DataMigrationMissingPluginInfo {
  name: string;
  specifier: string;
  enabled: boolean;
  isLocalPath?: boolean;
}

export interface DataMigrationPostRestoreNotices {
  isCrossMachine: boolean;
  sourcePlatform?: string;
  resetDefaultWorkingDirectory?: {
    previous: string;
    current: string;
  };
  missingAgentWorkingDirectories?: Array<{
    agentId: string;
    agentName: string;
    path: string;
  }>;
  missingScheduledTaskWorkingDirectories?: Array<{
    taskId: string;
    taskName: string;
    path: string;
  }>;
  reauthRequiredMcpServers?: Array<{
    serverId: string;
    serverName: string;
  }>;
  clearedBrowserCredentialCount?: number;
  missingDshPlugins?: DataMigrationMissingPluginInfo[];
  rewrittenPathCount?: number;
}

export interface DataMigrationBackupResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  sizeBytes?: number;
  errorCode?: DataMigrationErrorCode;
  error?: string;
}

export interface DataMigrationPickArchiveResult {
  success: boolean;
  canceled?: boolean;
  archivePath?: string;
  error?: string;
}

export interface DataMigrationPreviewRequest {
  archivePath: string;
}

export interface DataMigrationPreviewResult {
  success: boolean;
  archivePath?: string;
  archiveSizeBytes?: number;
  manifestVersion?: number;
  createdAt?: string;
  appVersion?: string;
  sourcePlatform?: string;
  sourceArch?: string;
  stats?: DataMigrationArchiveStats;
  errorCode?: DataMigrationErrorCode;
  error?: string;
}

export interface DataMigrationRestoreRequest {
  archivePath?: string;
}

export interface DataMigrationRestoreScheduleResult {
  success: boolean;
  canceled?: boolean;
  scheduledRestart?: boolean;
  rollbackPath?: string;
  errorCode?: DataMigrationErrorCode;
  error?: string;
}

export interface DataMigrationLastRestoreResult {
  status: DataMigrationRestoreStatus;
  archivePath: string;
  rollbackPath?: string;
  restoredAt: string;
  errorCode?: DataMigrationErrorCode;
  error?: string;
  notices?: DataMigrationPostRestoreNotices;
}

export interface DataMigrationLastRestoreResponse {
  success: boolean;
  result?: DataMigrationLastRestoreResult | null;
  error?: string;
}

export interface DataMigrationReinstallPluginsRequest {
  plugins: DataMigrationMissingPluginInfo[];
}

export interface DataMigrationPluginInstallOutcome {
  name: string;
  specifier: string;
  ok: boolean;
  skippedLocalPath?: boolean;
  error?: string;
}

export interface DataMigrationReinstallPluginsResult {
  success: boolean;
  results: DataMigrationPluginInstallOutcome[];
  error?: string;
}
