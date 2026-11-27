import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React from 'react';

import {
  type DataMigrationLastRestoreResult,
  type DataMigrationPluginInstallOutcome,
  DataMigrationRestoreStatus,
} from '../../../shared/dataMigration/constants';
import { i18nService } from '../../services/i18n';

interface DataMigrationRestoreReportCardProps {
  result: DataMigrationLastRestoreResult;
  isReinstallingPlugins: boolean;
  pluginInstallOutcomes: DataMigrationPluginInstallOutcome[] | null;
  onRevealRollback: () => void;
  onReinstallPlugins: () => void;
  onDismiss: () => void;
}

const DataMigrationRestoreReportCard: React.FC<DataMigrationRestoreReportCardProps> = ({
  result,
  isReinstallingPlugins,
  pluginInstallOutcomes,
  onRevealRollback,
  onReinstallPlugins,
  onDismiss,
}) => {
  const isSuccess = result.status === DataMigrationRestoreStatus.Success;
  const notices = result.notices;
  const missingPlugins = notices?.missingDshPlugins ?? [];
  const missingAgentDirs = notices?.missingAgentWorkingDirectories ?? [];
  const missingTaskDirs = notices?.missingScheduledTaskWorkingDirectories ?? [];
  const reauthMcp = notices?.reauthRequiredMcpServers ?? [];
  const clearedCredentials = notices?.clearedBrowserCredentialCount ?? 0;

  return (
    <div
      className={`rounded-xl border p-4 text-xs leading-5 ${
        isSuccess
          ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-100'
          : 'border-red-200 bg-red-50/70 text-red-900 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-100'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {isSuccess ? (
            <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          )}
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {isSuccess
                ? i18nService.t('dataMigrationReportSuccessTitle')
                : i18nService.t('dataMigrationReportFailedTitle')}
            </div>
            {!isSuccess && result.error && (
              <div className="opacity-90">{result.error}</div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={i18nService.t('close')}
          className="rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      {isSuccess && notices && (
        <ul className="mt-3 space-y-2 border-t border-current/15 pt-3">
          {notices.resetDefaultWorkingDirectory && (
            <li>
              <span className="font-medium">{i18nService.t('dataMigrationNoticeDefaultCwdReset')}: </span>
              <span className="font-mono break-all opacity-85">
                {notices.resetDefaultWorkingDirectory.previous} → {notices.resetDefaultWorkingDirectory.current}
              </span>
            </li>
          )}

          {missingAgentDirs.length > 0 && (
            <li>
              <span className="font-medium">{i18nService.t('dataMigrationNoticeMissingAgentDirs')}: </span>
              <span className="opacity-90">
                {missingAgentDirs.map(item => `${item.agentName} (${item.path})`).join('、')}
              </span>
            </li>
          )}

          {missingTaskDirs.length > 0 && (
            <li>
              <span className="font-medium">{i18nService.t('dataMigrationNoticeMissingTaskDirs')}: </span>
              <span className="opacity-90">
                {missingTaskDirs.map(item => `${item.taskName} (${item.path})`).join('、')}
              </span>
            </li>
          )}

          {reauthMcp.length > 0 && (
            <li>
              <span className="font-medium">{i18nService.t('dataMigrationNoticeMcpReauth')}: </span>
              <span className="opacity-90">
                {reauthMcp.map(item => item.serverName).join('、')}
              </span>
            </li>
          )}

          {clearedCredentials > 0 && (
            <li>
              {i18nService.t('dataMigrationNoticeBrowserCredentialsCleared')
                .replace('{count}', String(clearedCredentials))}
            </li>
          )}

          {missingPlugins.length > 0 && (
            <li className="rounded-lg border border-current/20 bg-surface/60 p-2.5 text-foreground">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium">
                    {i18nService.t('dataMigrationNoticeMissingPluginsTitle')}
                  </div>
                  <div className="mt-0.5 text-secondary">
                    {missingPlugins.map(item => `${item.name}${item.isLocalPath ? ` (${i18nService.t('dataMigrationLocalPluginTag')})` : ''}`).join('、')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onReinstallPlugins}
                  disabled={isReinstallingPlugins}
                  className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-action px-3 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isReinstallingPlugins && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />}
                  {isReinstallingPlugins
                    ? i18nService.t('dataMigrationPluginsReinstalling')
                    : i18nService.t('dataMigrationPluginsReinstallAction')}
                </button>
              </div>
            </li>
          )}
        </ul>
      )}

      {pluginInstallOutcomes && pluginInstallOutcomes.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
          {pluginInstallOutcomes.map(item => (
            <li key={item.name} className="flex items-center justify-between gap-2">
              <span className="font-mono">{item.name}</span>
              <span className={item.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>
                {item.ok
                  ? i18nService.t('dataMigrationPluginReinstallItemOk')
                  : item.skippedLocalPath
                    ? i18nService.t('dataMigrationPluginReinstallItemLocalSkipped')
                    : item.error || i18nService.t('dataMigrationPluginReinstallItemFailed')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {result.rollbackPath && (
        <div className="mt-3 flex flex-col gap-2 border-t border-current/15 pt-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 opacity-85">
            <span>{i18nService.t('dataMigrationRollbackPathLabel')}: </span>
            <span className="font-mono break-all">{result.rollbackPath}</span>
          </div>
          <button
            type="button"
            onClick={onRevealRollback}
            className="inline-flex h-7 shrink-0 items-center justify-center rounded-lg border border-current/25 px-2.5 text-xs font-medium transition-colors hover:bg-current/10"
          >
            {i18nService.t('showInFolder')}
          </button>
        </div>
      )}
    </div>
  );
};

export default DataMigrationRestoreReportCard;
