import React from 'react';
import { i18nService } from '../../services/i18n';
import type { AppUpdateInfo, AppUpdateDownloadProgress } from '../../services/appUpdate';
import Modal from '../common/Modal';

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

  return (
    <Modal onClose={isDismissible ? onCancel : () => {}} overlayClassName="fixed inset-0 z-50 flex items-center justify-center modal-backdrop" className="modal-content w-full max-w-md mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden">
        {/* Info state - shows changelog and Update/Cancel buttons */}
        {modalState === 'info' && (
          <>
            <div className="px-5 pt-5 pb-4">
              <h3 className="text-base font-semibold text-foreground">
                {i18nService.t('updateAvailableTitle')}
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
                <ul className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                  {currentLog.content.map((item, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm text-secondary">
                      <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary/60" />
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
                className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('updateAvailableCancel')}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
              >
                {i18nService.t('updateAvailableConfirm')}
              </button>
            </div>
          </>
        )}

        {/* Downloading state - progress bar with cancel */}
        {modalState === 'downloading' && (
          <div className="px-5 py-5">
            <h3 className="text-base font-semibold text-foreground">
              {i18nService.t('updateDownloading')}
            </h3>
            <p className="mt-1.5 text-xs text-secondary">
              v{latestVersion}
            </p>

            <div className="mt-4">
              {/* Progress bar */}
              <div className="h-2 rounded-full bg-primary/20 overflow-hidden">
                {downloadProgress?.percent != null ? (
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${Math.round(downloadProgress.percent * 100)}%` }}
                  />
                ) : (
                  <div className="h-full bg-primary/60 rounded-full animate-pulse" style={{ width: '100%' }} />
                )}
              </div>

              {/* Progress info */}
              <div className="mt-2 flex items-center justify-between text-xs text-secondary">
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
                className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
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
                className="animate-spin h-8 w-8 text-primary"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <h3 className="mt-4 text-base font-semibold text-foreground">
                {i18nService.t('updateInstalling')}
              </h3>
              <p className="mt-1.5 text-xs text-secondary text-center">
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
              <p className="mt-2 text-sm text-secondary break-words">
                {errorMessage}
              </p>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
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
                {i18nService.t('updateRetry')}
              </button>
            </div>
          </div>
        )}
    </Modal>
  );
};

export default AppUpdateModal;
