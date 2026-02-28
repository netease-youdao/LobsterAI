import React from 'react';
import { i18nService } from '../../services/i18n';
import type { AppUpdateInfo, AppUpdateDownloadProgress } from '../../services/appUpdate';

export type UpdateModalState = 'info' | 'downloading' | 'installing' | 'error';

interface AppUpdateModalProps {
  updateInfo: AppUpdateInfo;
  onConfirm: () => void;
  onCancel: () => void;
  modalState: UpdateModalState;
  downloadProgress: AppUpdateDownloadProgress | null;
  errorMessage: string | null;
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
  updateInfo,
  onConfirm,
  onCancel,
  modalState,
  downloadProgress,
  errorMessage,
  onCancelDownload,
  onRetry,
}) => {
  const { latestVersion, date, changeLog } = updateInfo;
  const lang = i18nService.getLanguage();
  const currentLog = changeLog?.[lang] ?? { title: '', content: [] };
  const isDismissible = modalState === 'info' || modalState === 'error';

  const handleBackdropClick = () => {
    if (isDismissible) {
      onCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
      onClick={handleBackdropClick}
    >
      <div
        className="modal-content w-full max-w-md mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Info state - shows changelog and Update/Cancel buttons */}
        {modalState === 'info' && (
          <>
            <div className="px-5 pt-5 pb-4">
              <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('updateAvailableTitle')}
              </h3>
              <p className="mt-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                v{latestVersion}{date ? ` · ${date}` : ''}
              </p>

              {currentLog.title && (
                <p className="mt-3 text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {currentLog.title}
                </p>
              )}

              {currentLog.content.length > 0 && (
                <ul className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                  {currentLog.content.map((item, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-claude-accent/60" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="px-5 pb-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('updateAvailableCancel')}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
              >
                {i18nService.t('updateAvailableConfirm')}
              </button>
            </div>
          </>
        )}

        {/* Downloading state - progress bar with cancel */}
        {modalState === 'downloading' && (
          <div className="px-5 py-5">
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('updateDownloading')}
            </h3>
            <p className="mt-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              v{latestVersion}
            </p>

            <div className="mt-4">
              {/* Progress bar */}
              <div className="h-2 rounded-full bg-claude-accent/20 overflow-hidden">
                {downloadProgress?.percent != null ? (
                  <div
                    className="h-full bg-claude-accent rounded-full transition-all duration-300"
                    style={{ width: `${Math.round(downloadProgress.percent * 100)}%` }}
                  />
                ) : (
                  <div className="h-full bg-claude-accent/60 rounded-full animate-pulse" style={{ width: '100%' }} />
                )}
              </div>

              {/* Progress info */}
              <div className="mt-2 flex items-center justify-between text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <span>
                  {downloadProgress
                    ? downloadProgress.total != null
                      ? `${formatBytes(downloadProgress.received)} / ${formatBytes(downloadProgress.total)}`
                      : formatBytes(downloadProgress.received)
                    : '0 B'}
                </span>
                <span className="flex items-center gap-3">
                  {downloadProgress?.speed != null && (
                    <span>{formatSpeed(downloadProgress.speed)}</span>
                  )}
                  {downloadProgress?.percent != null && (
                    <span>{Math.round(downloadProgress.percent * 100)}%</span>
                  )}
                </span>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end">
              <button
                type="button"
                onClick={onCancelDownload}
                className="px-3 py-1.5 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('updateDownloadCancel')}
              </button>
            </div>
          </div>
        )}

        {/* Installing state - spinner, no buttons */}
        {modalState === 'installing' && (
          <div className="px-5 py-5">
            <div className="flex flex-col items-center py-4">
              <svg
                className="animate-spin h-8 w-8 text-claude-accent"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <h3 className="mt-4 text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('updateInstalling')}
              </h3>
              <p className="mt-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary text-center">
                {i18nService.t('updateInstallingHint')}
              </p>
            </div>
          </div>
        )}

        {/* Error state - error message with retry/cancel */}
        {modalState === 'error' && (
          <div className="px-5 py-5">
            <h3 className="text-base font-semibold text-red-500 dark:text-red-400">
              {errorMessage?.includes('Install') || errorMessage?.includes('安装')
                ? i18nService.t('updateInstallFailed')
                : i18nService.t('updateDownloadFailed')}
            </h3>
            {errorMessage && (
              <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">
                {errorMessage}
              </p>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('updateAvailableCancel')}
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
              >
                {i18nService.t('updateRetry')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AppUpdateModal;
