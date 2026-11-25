import {
  type DataMigrationBackupResult,
  DataMigrationErrorCode,
  type DataMigrationLastRestoreResponse,
  type DataMigrationPickArchiveResult,
  type DataMigrationPostRestoreNotices,
  type DataMigrationPreviewRequest,
  type DataMigrationPreviewResult,
  type DataMigrationProgressEvent,
  DataMigrationProgressPhase,
  type DataMigrationReinstallPluginsRequest,
  type DataMigrationReinstallPluginsResult,
  type DataMigrationRestoreRequest,
  type DataMigrationRestoreScheduleResult,
} from '../../shared/dataMigration/constants';

export type DataMigrationTranslateFn = (key: string) => string;

export const mapDataMigrationErrorMessage = (
  errorCode: DataMigrationErrorCode | undefined,
  fallbackError: string | undefined,
  t: DataMigrationTranslateFn,
): string => {
  switch (errorCode) {
    case DataMigrationErrorCode.LegacyOpenClawUnsupported:
      return t('dataMigrationErrorLegacyOpenClaw');
    case DataMigrationErrorCode.InsufficientDiskSpace:
      return fallbackError || t('dataMigrationErrorInsufficientSpace');
    case DataMigrationErrorCode.ActiveWorkloads:
      return fallbackError || t('dataMigrationErrorActiveWorkloads');
    case DataMigrationErrorCode.UnsupportedFormat:
      return t('dataMigrationErrorUnsupportedFormat');
    case DataMigrationErrorCode.CorruptedArchive:
      return fallbackError || t('dataMigrationErrorCorruptedArchive');
    default:
      return fallbackError || t('openClawDataMigrationFailed');
  }
};

export const mapDataMigrationProgressPhaseLabel = (
  phase: DataMigrationProgressPhase,
  t: DataMigrationTranslateFn,
): string => {
  switch (phase) {
    case DataMigrationProgressPhase.CheckingSpace:
      return t('dataMigrationPhaseCheckingSpace');
    case DataMigrationProgressPhase.SnapshottingDatabase:
      return t('dataMigrationPhaseSnapshottingDb');
    case DataMigrationProgressPhase.CollectingFiles:
      return t('dataMigrationPhaseCollectingFiles');
    case DataMigrationProgressPhase.CreatingArchive:
      return t('dataMigrationPhaseCreatingArchive');
    case DataMigrationProgressPhase.VerifyingArchive:
      return t('dataMigrationPhaseVerifyingArchive');
    case DataMigrationProgressPhase.CreatingRollback:
      return t('dataMigrationPhaseCreatingRollback');
    case DataMigrationProgressPhase.ExtractingArchive:
      return t('dataMigrationPhaseExtractingArchive');
    case DataMigrationProgressPhase.SanitizingData:
      return t('dataMigrationPhaseSanitizingData');
    case DataMigrationProgressPhase.ApplyingData:
      return t('dataMigrationPhaseApplyingData');
    case DataMigrationProgressPhase.Completed:
      return t('dataMigrationPhaseCompleted');
    default:
      return t('openClawDataBackupBlockingDesc');
  }
};

export const hasPostRestoreActionableNotices = (
  notices?: DataMigrationPostRestoreNotices | null,
): boolean => {
  if (!notices) return false;
  return Boolean(
    notices.resetDefaultWorkingDirectory
    || (notices.missingAgentWorkingDirectories && notices.missingAgentWorkingDirectories.length > 0)
    || (notices.missingScheduledTaskWorkingDirectories && notices.missingScheduledTaskWorkingDirectories.length > 0)
    || (notices.reauthRequiredMcpServers && notices.reauthRequiredMcpServers.length > 0)
    || (notices.clearedBrowserCredentialCount && notices.clearedBrowserCredentialCount > 0)
    || (notices.missingDshPlugins && notices.missingDshPlugins.length > 0),
  );
};

export const dataMigrationService = {
  backup(): Promise<DataMigrationBackupResult> {
    return window.electron.openclaw.dataMigration.backup();
  },
  pickRestoreArchive(): Promise<DataMigrationPickArchiveResult> {
    return window.electron.openclaw.dataMigration.pickRestoreArchive();
  },
  preview(request: DataMigrationPreviewRequest): Promise<DataMigrationPreviewResult> {
    return window.electron.openclaw.dataMigration.preview(request);
  },
  restore(request?: DataMigrationRestoreRequest): Promise<DataMigrationRestoreScheduleResult> {
    return window.electron.openclaw.dataMigration.restore(request);
  },
  getLastRestoreResult(): Promise<DataMigrationLastRestoreResponse> {
    return window.electron.openclaw.dataMigration.getLastRestoreResult();
  },
  reinstallPlugins(
    request: DataMigrationReinstallPluginsRequest,
  ): Promise<DataMigrationReinstallPluginsResult> {
    return window.electron.openclaw.dataMigration.reinstallPlugins(request);
  },
  onProgress(callback: (event: DataMigrationProgressEvent) => void): () => void {
    return window.electron.openclaw.dataMigration.onProgress(callback);
  },
  revealInFolder(filePath: string): Promise<{ success?: boolean; error?: string }> {
    return window.electron.shell.showItemInFolder(filePath);
  },
};
