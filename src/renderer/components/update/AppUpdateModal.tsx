import React from 'react';

import { type AppUpdateRuntimeState, AppUpdateStatus, isManualDownloadUrl } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import { formatAppUpdateError } from './appUpdateErrorText';
import { formatTransferProgress } from './appUpdateProgressText';

interface AppUpdateModalProps {
  updateState: AppUpdateRuntimeState;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

/**
 * Release-notes dialog. Confirming from "available" starts a silent background
 * download; confirming from "ready" installs and restarts. A download that is
 * already running is informational only and can be dismissed at any time.
 */
const AppUpdateModal: React.FC<AppUpdateModalProps> = ({
  updateState,
  onConfirm,
  onCancel,
  onRetry,
}) => {
  const updateInfo = updateState.info;
  if (!updateInfo) return null;

  const { latestVersion, date, changeLog, url } = updateInfo;
  const lang = i18nService.getLanguage();
  const currentLog = changeLog?.[lang] ?? { title: '', content: [] };
  const isManualUrl = isManualDownloadUrl(url);
  const isInstalling = updateState.status === AppUpdateStatus.Installing;
  const canDismiss = !isInstalling;
  const canInstall = updateState.status === AppUpdateStatus.Ready && updateState.readyFilePath != null;
  const isError = updateState.status === AppUpdateStatus.Error;
  // A failed install keeps the verified file and returns to Ready with an
  // error message, so retrying installs the existing file without re-downloading.
  const isInstallError = canInstall && updateState.errorMessage != null;
  const isDownloading = updateState.status === AppUpdateStatus.Downloading || updateState.status === AppUpdateStatus.Checking;
  const showInfoFooter = updateState.status === AppUpdateStatus.Available;
  const rawPercent = updateState.progress?.percent;
  const percent = typeof rawPercent === 'number' && Number.isFinite(rawPercent)
    ? Math.min(100, Math.max(0, Math.round(rawPercent * 100)))
    : null;

  const title = isError
    ? i18nService.t('updateDownloadFailed')
    : isInstallError
      ? i18nService.t('updateInstallFailed')
      : canInstall
        ? i18nService.t('updateReadyTitle')
        : isDownloading
          ? i18nService.t('updateDownloadingBackground')
          : i18nService.t('updateAvailableTitle');

  const confirmLabel = canInstall
    ? i18nService.t(isInstallError ? 'updateRetry' : 'updateReadyConfirm')
    : isManualUrl
      ? i18nService.t('updateAvailableConfirm')
      : isError
        ? i18nService.t('updateRetry')
        : i18nService.t('updateAvailableConfirm');

  return (
    <Modal
      onClose={canDismiss ? onCancel : () => {}}
      onEscape={canDismiss ? onCancel : undefined}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
      className="modal-content w-full max-w-md mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden"
    >
      <div className="px-5 pt-5 pb-4">
        <h3 className={`text-base font-semibold ${isError || isInstallError ? 'text-red-500 dark:text-red-400' : 'text-foreground'}`}>
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
              {percent != null ? (
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              ) : (
                <div className="h-full bg-primary/60 rounded-full animate-pulse" style={{ width: '100%' }} />
              )}
            </div>

            <div className="mt-2 flex items-center justify-between gap-3 text-xs text-secondary tabular-nums">
              <span className="min-w-0 truncate">
                {formatTransferProgress(updateState.progress) ?? i18nService.t('updateDownloadingPill')}
              </span>
              {percent != null && <span className="shrink-0">{percent}%</span>}
            </div>
          </div>
        )}

        {updateState.installIncomplete && canInstall && (
          <p className="mt-4 text-sm text-amber-600 dark:text-amber-400">
            {i18nService.t('updateInstallIncomplete')}
          </p>
        )}

        {updateState.errorMessage && (
          <p className="mt-4 text-sm text-secondary break-words">
            {formatAppUpdateError(updateState.errorMessage)}
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
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('updateDownloadingDismiss')}
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
        <div className="px-5 pb-5 flex flex-col items-center gap-3">
          <svg
            className="animate-spin h-8 w-8 text-primary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <p className="text-sm text-secondary text-center">
            {i18nService.t('updateInstallingHint')}
          </p>
        </div>
      )}

      {isError && (
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
