import { useCallback, useEffect, useState } from 'react';

import {
  type DataMigrationLastRestoreResult,
  type DataMigrationPluginInstallOutcome,
  type DataMigrationPreviewResult,
  type DataMigrationProgressEvent,
  DataMigrationRestoreStatus,
} from '../../../shared/dataMigration/constants';
import {
  dataMigrationService,
  mapDataMigrationErrorMessage,
} from '../../services/dataMigration';
import { i18nService } from '../../services/i18n';

const waitForNextPaint = (): Promise<void> => new Promise(resolve => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => resolve());
  });
});

export interface DataBackupSavedSummary {
  path: string;
  sizeBytes?: number;
}

export interface UseDataMigrationOptions {
  persistModelSettingsBeforeBackup?: () => Promise<void>;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onReportAction?: (
    action: 'backup_data' | 'restore_data',
    status: 'success' | 'failed',
    extra?: { sizeBytes?: number; errorCode?: string },
  ) => void;
}

export function useDataMigration({
  persistModelSettingsBeforeBackup,
  onError,
  onNotice,
  onReportAction,
}: UseDataMigrationOptions) {
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isReinstallingPlugins, setIsReinstallingPlugins] = useState(false);
  const [backupResult, setBackupResult] = useState<DataBackupSavedSummary | null>(null);
  const [progress, setProgress] = useState<DataMigrationProgressEvent | null>(null);
  const [restorePreview, setRestorePreview] = useState<DataMigrationPreviewResult | null>(null);
  const [lastRestoreResult, setLastRestoreResult] = useState<DataMigrationLastRestoreResult | null>(null);
  const [pluginInstallOutcomes, setPluginInstallOutcomes] = useState<DataMigrationPluginInstallOutcome[] | null>(null);

  useEffect(() => {
    const unsubscribe = dataMigrationService.onProgress((event) => {
      setProgress(event);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let active = true;
    void dataMigrationService.getLastRestoreResult().then((response) => {
      if (!active || !response.success || !response.result) return;
      setLastRestoreResult(response.result);
      if (response.result.status === DataMigrationRestoreStatus.Success) {
        onNotice(i18nService.t('openClawDataMigrationSuccess'));
        return;
      }
      const message = mapDataMigrationErrorMessage(
        response.result.errorCode,
        response.result.error,
        key => i18nService.t(key),
      );
      onError(message);
    }).catch((loadError) => {
      if (!active) return;
      onError(loadError instanceof Error ? loadError.message : i18nService.t('openClawDataMigrationFailed'));
    });
    return () => {
      active = false;
    };
  }, [onError, onNotice]);

  const revealPath = useCallback(async (targetPath: string | undefined) => {
    if (!targetPath) return;
    try {
      const result = await dataMigrationService.revealInFolder(targetPath);
      if (!result?.success) {
        onError(result?.error || i18nService.t('showInFolderFailed'));
      }
    } catch (revealError) {
      onError(revealError instanceof Error ? revealError.message : i18nService.t('showInFolderFailed'));
    }
  }, [onError]);

  const runBackup = useCallback(async () => {
    if (isBackingUp || isRestoring || isPreviewing) return;
    onError(null);
    onNotice(null);
    setBackupResult(null);
    setProgress(null);
    setIsBackingUp(true);
    try {
      await waitForNextPaint();
      if (persistModelSettingsBeforeBackup) {
        await persistModelSettingsBeforeBackup();
      }
      const result = await dataMigrationService.backup();
      if (!result.success) {
        const message = mapDataMigrationErrorMessage(
          result.errorCode,
          result.error || i18nService.t('openClawDataBackupFailed'),
          key => i18nService.t(key),
        );
        onError(message);
        onReportAction?.('backup_data', 'failed', {
          errorCode: result.errorCode ?? 'unknown',
        });
        return;
      }
      if (result.canceled) {
        return;
      }
      if (result.path) {
        setBackupResult({
          path: result.path,
          sizeBytes: result.sizeBytes,
        });
      }
      onNotice(i18nService.t('openClawDataBackupSuccess'));
      onReportAction?.('backup_data', 'success', {
        sizeBytes: result.sizeBytes,
      });
    } catch (backupError) {
      onError(backupError instanceof Error ? backupError.message : i18nService.t('openClawDataBackupFailed'));
      onReportAction?.('backup_data', 'failed', { errorCode: 'unknown' });
    } finally {
      setIsBackingUp(false);
      setProgress(null);
    }
  }, [isBackingUp, isPreviewing, isRestoring, onError, onNotice, onReportAction, persistModelSettingsBeforeBackup]);

  const startRestoreFlow = useCallback(async () => {
    if (isBackingUp || isRestoring || isPreviewing) return;
    onError(null);
    onNotice(null);
    try {
      const picked = await dataMigrationService.pickRestoreArchive();
      if (!picked.success) {
        onError(picked.error || i18nService.t('openClawDataMigrationFailed'));
        return;
      }
      if (picked.canceled || !picked.archivePath) {
        return;
      }
      setIsPreviewing(true);
      try {
        const preview = await dataMigrationService.preview({ archivePath: picked.archivePath });
        if (!preview.success) {
          onError(mapDataMigrationErrorMessage(preview.errorCode, preview.error, key => i18nService.t(key)));
          return;
        }
        setRestorePreview(preview);
      } finally {
        setIsPreviewing(false);
      }
    } catch (pickError) {
      onError(pickError instanceof Error ? pickError.message : i18nService.t('openClawDataMigrationFailed'));
    }
  }, [isBackingUp, isPreviewing, isRestoring, onError, onNotice]);

  const cancelRestorePreview = useCallback(() => {
    if (isRestoring) return;
    setRestorePreview(null);
  }, [isRestoring]);

  const confirmRestore = useCallback(async () => {
    if (isRestoring || !restorePreview?.archivePath) return;
    const targetArchivePath = restorePreview.archivePath;
    setRestorePreview(null);
    onError(null);
    onNotice(null);
    setProgress(null);
    setIsRestoring(true);
    let keepLoadingUntilRestart = false;
    try {
      await waitForNextPaint();
      const result = await dataMigrationService.restore({
        archivePath: targetArchivePath,
      });
      if (!result.success) {
        onError(
          mapDataMigrationErrorMessage(
            result.errorCode,
            result.error || i18nService.t('openClawDataMigrationFailed'),
            key => i18nService.t(key),
          ),
        );
        onReportAction?.('restore_data', 'failed', {
          errorCode: result.errorCode ?? 'unknown',
        });
        return;
      }
      if (result.canceled) {
        return;
      }
      if (result.scheduledRestart) {
        keepLoadingUntilRestart = true;
        onNotice(i18nService.t('openClawDataMigrationRestarting'));
      }
      onReportAction?.('restore_data', 'success');
    } catch (restoreError) {
      onError(restoreError instanceof Error ? restoreError.message : i18nService.t('openClawDataMigrationFailed'));
      onReportAction?.('restore_data', 'failed', { errorCode: 'unknown' });
    } finally {
      if (!keepLoadingUntilRestart) {
        setIsRestoring(false);
        setProgress(null);
      }
    }
  }, [isRestoring, onError, onNotice, onReportAction, restorePreview]);

  const reinstallMissingPlugins = useCallback(async () => {
    const missing = lastRestoreResult?.notices?.missingDshPlugins;
    if (!missing || missing.length === 0 || isReinstallingPlugins) return;
    setIsReinstallingPlugins(true);
    setPluginInstallOutcomes(null);
    onError(null);
    try {
      const response = await dataMigrationService.reinstallPlugins({ plugins: missing });
      setPluginInstallOutcomes(response.results);
      if (response.success) {
        onNotice(i18nService.t('dataMigrationPluginsReinstallSuccess'));
        setLastRestoreResult(prev => (
          prev && prev.notices
            ? { ...prev, notices: { ...prev.notices, missingDshPlugins: [] } }
            : prev
        ));
      } else {
        const failedNames = response.results.filter(item => !item.ok).map(item => item.name);
        onError(
          response.error
          || i18nService.t('dataMigrationPluginsReinstallPartialFailed').replace('{plugins}', failedNames.join(', ')),
        );
      }
    } catch (reinstallError) {
      onError(
        reinstallError instanceof Error
          ? reinstallError.message
          : i18nService.t('dataMigrationPluginsReinstallFailed'),
      );
    } finally {
      setIsReinstallingPlugins(false);
    }
  }, [isReinstallingPlugins, lastRestoreResult, onError, onNotice]);

  const dismissLastRestoreResult = useCallback(() => {
    setLastRestoreResult(null);
    setPluginInstallOutcomes(null);
  }, []);

  return {
    isBackingUp,
    isRestoring,
    isPreviewing,
    isReinstallingPlugins,
    isBusy: isBackingUp || isRestoring,
    backupResult,
    progress,
    restorePreview,
    lastRestoreResult,
    pluginInstallOutcomes,
    hasOpenModal: restorePreview !== null,
    dismissTopModal: () => {
      if (restorePreview !== null) {
        cancelRestorePreview();
      }
    },
    runBackup,
    startRestoreFlow,
    cancelRestorePreview,
    confirmRestore,
    revealBackupResult: () => revealPath(backupResult?.path),
    revealRollbackPath: () => revealPath(lastRestoreResult?.rollbackPath),
    reinstallMissingPlugins,
    dismissLastRestoreResult,
  };
}
