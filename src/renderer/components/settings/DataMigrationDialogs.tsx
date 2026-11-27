import {
  ArrowPathIcon,
  ArrowPathRoundedSquareIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import React from 'react';

import type {
  DataMigrationPreviewResult,
  DataMigrationProgressEvent,
} from '../../../shared/dataMigration/constants';
import { mapDataMigrationProgressPhaseLabel } from '../../services/dataMigration';
import { i18nService } from '../../services/i18n';

interface DataMigrationDialogsProps {
  restorePreview: DataMigrationPreviewResult | null;
  onCancelRestorePreview: () => void;
  onConfirmRestore: () => void;
  isBackingUp: boolean;
  isRestoring: boolean;
  progress: DataMigrationProgressEvent | null;
  formatSize: (sizeBytes?: number) => string;
}

const formatPlatformLabel = (platform?: string): string => {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform || '-';
  }
};

const formatDateTime = (iso?: string): string => {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
};

const DataMigrationDialogs: React.FC<DataMigrationDialogsProps> = ({
  restorePreview,
  onCancelRestorePreview,
  onConfirmRestore,
  isBackingUp,
  isRestoring,
  progress,
  formatSize,
}) => {
  const progressPhaseText = progress
    ? mapDataMigrationProgressPhaseLabel(progress.phase, key => i18nService.t(key))
    : i18nService.t(isBackingUp ? 'openClawDataBackupBlockingDesc' : 'openClawDataMigrationBlockingDesc');
  const progressPercent = typeof progress?.percent === 'number'
    ? Math.max(5, Math.min(100, Math.round(progress.percent)))
    : null;

  return (
    <>
      {restorePreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={onCancelRestorePreview}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border px-5 pt-5 pb-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-foreground">
                  <ArrowPathRoundedSquareIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-foreground">
                    {i18nService.t('openClawDataMigrationConfirmTitle')}
                  </h3>
                  <p className="mt-0.5 truncate font-mono text-xs text-secondary">
                    {restorePreview.archivePath}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4 px-5 py-4 text-sm text-secondary">
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface-raised/60 p-3 text-xs">
                <div>
                  <span className="text-secondary">{i18nService.t('dataMigrationPreviewCreatedAt')}: </span>
                  <span className="font-medium text-foreground">{formatDateTime(restorePreview.createdAt)}</span>
                </div>
                <div>
                  <span className="text-secondary">{i18nService.t('dataMigrationPreviewPlatform')}: </span>
                  <span className="font-medium text-foreground">
                    {formatPlatformLabel(restorePreview.sourcePlatform)}
                  </span>
                </div>
                <div>
                  <span className="text-secondary">{i18nService.t('openClawDataBackupSize')}: </span>
                  <span className="font-medium text-foreground">
                    {formatSize(restorePreview.archiveSizeBytes) || '-'}
                  </span>
                </div>
                {restorePreview.appVersion && (
                  <div>
                    <span className="text-secondary">{i18nService.t('dataMigrationPreviewAppVersion')}: </span>
                    <span className="font-medium text-foreground">v{restorePreview.appVersion}</span>
                  </div>
                )}
              </div>

              {restorePreview.stats && (
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: i18nService.t('dataMigrationStatSessions'), value: restorePreview.stats.sessionCount },
                    { label: i18nService.t('dataMigrationStatAgents'), value: restorePreview.stats.agentCount },
                    { label: i18nService.t('dataMigrationStatScheduledTasks'), value: restorePreview.stats.scheduledTaskCount },
                    { label: i18nService.t('dataMigrationStatMcpServers'), value: restorePreview.stats.mcpServerCount },
                    { label: i18nService.t('dataMigrationStatSkills'), value: restorePreview.stats.skillCount },
                    { label: i18nService.t('dataMigrationStatPlugins'), value: restorePreview.stats.thirdPartyPluginCount },
                  ].map(item => (
                    <div
                      key={item.label}
                      className="rounded-lg border border-border bg-surface px-2.5 py-2"
                    >
                      <div className="text-base font-semibold text-foreground">{item.value}</div>
                      <div className="text-[11px] text-secondary">{item.label}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1.5 text-xs leading-5">
                <p>{i18nService.t('openClawDataMigrationConfirmDesc')}</p>
                <p>{i18nService.t('openClawDataMigrationConfirmSafeDesc')}</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 px-5 pb-5">
              <button
                type="button"
                onClick={onCancelRestorePreview}
                disabled={isRestoring}
                className="rounded-xl border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-surface-raised disabled:opacity-60"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={onConfirmRestore}
                disabled={isRestoring}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-action px-3.5 py-1.5 text-sm font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
              >
                {isRestoring
                  ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
                  : <ArrowPathRoundedSquareIcon className="h-4 w-4" />}
                {isRestoring
                  ? i18nService.t('openClawDataMigrationRunning')
                  : i18nService.t('dataMigrationConfirmImportRestart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {(isBackingUp || isRestoring) && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface px-5 py-5 text-center shadow-xl">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-surface-raised text-foreground">
              <ArrowPathIcon className="h-5 w-5 animate-spin" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-foreground">
              {i18nService.t(isBackingUp
                ? 'openClawDataBackupBlockingTitle'
                : 'openClawDataMigrationBlockingTitle')}
            </h3>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {progressPhaseText}
            </p>
            {progressPercent !== null && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-secondary">{progressPercent}%</div>
              </div>
            )}
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {i18nService.t(isBackingUp
                  ? 'openClawDataBackupBlockingWarning'
                  : 'openClawDataMigrationBlockingWarning')}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default DataMigrationDialogs;
