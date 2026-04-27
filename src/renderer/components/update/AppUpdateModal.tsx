import React from 'react';

import { type AppUpdateRuntimeState,AppUpdateStatus } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

interface AppUpdateModalProps {
  updateState: AppUpdateRuntimeState;
  onConfirm: () => void;
  onCancel: () => void;
  onCancelDownload: () => void;
  onRetry: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

const AppUpdateModal: React.FC<AppUpdateModalProps> = ({
  updateState,
  onConfirm,
  onCancel,
  onCancelDownload,
  onRetry,
}) => {
  const updateInfo = updateState.info;
  if (!updateInfo) return null;

  const { latestVersion, date, changeLog, url } = updateInfo;
  const lang = i18nService.getLanguage();
  const currentLog = changeLog?.[lang] ?? { title: '', content: [] };
  const isManualUrl = url.includes('#') || url.endsWith('/download-list');
  const isInstalling = updateState.status === AppUpdateStatus.Installing;
  const canDismiss = updateState.status !== AppUpdateStatus.Downloading && !isInstalling;
  const canInstall = updateState.status === AppUpdateStatus.Ready && updateState.readyFilePath != null;
  const isError = updateState.status === AppUpdateStatus.Error;
  const isDownloading = updateState.status === AppUpdateStatus.Downloading || updateState.status === AppUpdateStatus.Checking;
  const showInfoFooter = updateState.status === AppUpdateStatus.Available;
  const isRetryState = updateState.status === AppUpdateStatus.Error;

  const title = isError
    ? (canInstall ? i18nService.t('updateInstallFailed') : i18nService.t('updateDownloadFailed'))
    : canInstall
      ? i18nService.t('updateReadyTitle')
      : isDownloading
        ? i18nService.t('updateDownloadingBackground')
        : i18nService.t('updateAvailableTitle');

  const confirmLabel = canInstall
    ? i18nService.t('updateReadyConfirm')
    : isManualUrl
      ? i18nService.t('updateAvailableConfirm')
      : isRetryState
        ? i18nService.t('updateRetry')
        : i18nService.t('updateAvailableConfirm');

  return (
    <Modal onClose={canDismiss ? onCancel : () => {}} overlayClassName="fixed inset-0 z-50 flex items-center justify-center modal-backdrop" className="modal-content w-full max-w-md mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden">
      <div className="px-5 pt-5 pb-4">
        <h3 className={`text-base font-semibold ${isError ? 'text-red-500 dark:text-red-400' : 'text-foreground'}`}>
          {title}
        </h3>
        <p className="mt-1.5 text-xs text-secondary">
          v{latestVersion}{date ? ` · ${date}` : ''}
        </p>

        {currentLog.title && (
          <p className="mt-3 text-sm font-medium text-foreground">
            {currentLog.title}
          </p>
        )}

        {currentLog.content.length > 0 && (
          <ul className="mt-2 space-y-1.5 max-h-40 overflow-y-auto pl-2">
            {currentLog.content.map((item, index) => (
              <li key={index} className="flex items-start gap-2 text-sm text-secondary">
                <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-gray-400 dark:bg-gray-500" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}

        {isDownloading && (
          <div className="mt-4">
            <div className="h-2 rounded-full bg-primary/20 overflow-hidden">
              {updateState.progress?.percent != null ? (
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(updateState.progress.percent * 100)}%` }}
                />
              ) : (
                <div className="h-full bg-primary/60 rounded-full animate-pulse" style={{ width: '100%' }} />
              )}
            </div>

            <div className="mt-2 flex items-center justify-between text-xs text-secondary">
              <span>
                {updateState.progress
                  ? updateState.progress.total != null
                    ? `${formatBytes(updateState.progress.received)} / ${formatBytes(updateState.progress.total)}`
                    : formatBytes(updateState.progress.received)
                  : '0 B'}
              </span>
              <span className="flex items-center gap-3">
                {updateState.progress?.speed != null && (
                  <span>{formatSpeed(updateState.progress.speed)}</span>
                )}
                {updateState.progress?.percent != null && (
                  <span>{Math.round(updateState.progress.percent * 100)}%</span>
                )}
              </span>
            </div>
          </div>
        )}

        {isInstalling && (
          <p className="mt-4 text-sm text-secondary">
            {i18nService.t('updateInstallingHint')}
          </p>
        )}

        {updateState.errorMessage && (
          <p className="mt-4 text-sm text-secondary break-words">
            {updateState.errorMessage}
          </p>
        )}
      </div>

      {showInfoFooter && (
        <div className="px-5 pb-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('updateAvailableCancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      )}

      {isDownloading && (
        <div className="px-5 pb-5 flex items-center justify-end">
          <button
            type="button"
            onClick={onCancelDownload}
            className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('updateDownloadCancel')}
          </button>
        </div>
      )}

      {canInstall && (
        <div className="px-5 pb-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('updateReadyLater')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      )}

      {isInstalling && (
        <div className="px-5 pb-5 flex justify-center">
          <svg
            className="animate-spin h-8 w-8 text-primary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      )}

      {isError && !canInstall && (
        <div className="px-5 pb-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('updateAvailableCancel')}
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      )}
    </Modal>
  );
};

export default AppUpdateModal;
