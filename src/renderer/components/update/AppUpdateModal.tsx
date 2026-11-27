import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useId } from 'react';

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

const SECONDARY_BUTTON_CLASS_NAME =
  'rounded-xl border border-foreground/15 bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface';
const PRIMARY_BUTTON_CLASS_NAME =
  'rounded-xl bg-action px-4 py-2 text-sm font-medium text-action-foreground transition-colors hover:bg-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface';

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
  const titleId = useId();
  const updateInfo = updateState.info;
  if (!updateInfo) return null;

  const { latestVersion, date, changeLog, url } = updateInfo;
  const lang = i18nService.getLanguage();
  const currentLog = changeLog?.[lang] ?? { title: '', content: [] };
  const releaseNotes = currentLog.content.filter((item) => item.trim().length > 0);
  const hasReleaseNotesSection = Boolean(currentLog.title.trim()) || releaseNotes.length > 0;
  const isManualUrl = isManualDownloadUrl(url);
  const isInstalling = updateState.status === AppUpdateStatus.Installing;
  const canDismiss = !isInstalling;
  const canInstall = updateState.status === AppUpdateStatus.Ready && updateState.readyFilePath != null;
  const isError = updateState.status === AppUpdateStatus.Error;
  // A failed install keeps the verified file and returns to Ready with an
  // error message, so retrying installs the existing file without re-downloading.
  const isInstallError = canInstall && updateState.errorMessage != null;
  const hasFailure = isError || isInstallError;
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

  const statusDotTone = hasFailure
    ? 'bg-destructive ring-destructive/15'
    : canInstall || isInstalling
      ? 'bg-emerald-500 ring-emerald-500/15'
      : 'bg-primary ring-primary/15';

  return (
    <Modal
      onClose={canDismiss ? onCancel : () => {}}
      onEscape={canDismiss ? onCancel : undefined}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4"
      className="modal-content w-full max-w-[440px] overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="px-6 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {hasFailure ? (
                  <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                ) : (
                  <span
                    className={`inline-flex h-2 w-2 shrink-0 rounded-full ring-[3px] ${statusDotTone}`}
                    aria-hidden="true"
                  />
                )}
                <h3 id={titleId} className="text-base font-semibold leading-6 text-foreground">
                  {title}
                </h3>
              </div>
              <p className="mt-1 text-xs tabular-nums text-secondary">
                v{latestVersion}{date ? ` · ${date}` : ''}
              </p>
            </div>
            {canDismiss && (
              <button
                type="button"
                onClick={onCancel}
                aria-label={i18nService.t('close')}
                title={i18nService.t('close')}
                className="-mr-1 -mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <XMarkIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>

          {hasReleaseNotesSection && (
            <div className="mt-4 rounded-xl border border-border/70 bg-surface-raised/60 px-4 py-3">
              {currentLog.title.trim() && (
                <p className="text-xs font-medium text-foreground">
                  {currentLog.title}
                </p>
              )}
              {releaseNotes.length > 0 && (
                <ul className={`${currentLog.title.trim() ? 'mt-2' : ''} max-h-44 space-y-1.5 overflow-y-auto pr-1`}>
                  {releaseNotes.map((item, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm leading-relaxed text-secondary">
                      <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-muted" aria-hidden="true" />
                      <span className="min-w-0 break-words">{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {isDownloading && (
            <div className="mt-4">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
                {percent != null ? (
                  <div
                    className="h-full rounded-full bg-foreground transition-all duration-300"
                    style={{ width: `${percent}%` }}
                  />
                ) : (
                  <div
                    className="h-full rounded-full bg-foreground/60 animate-pulse motion-reduce:animate-none"
                    style={{ width: '100%' }}
                  />
                )}
              </div>

              <div className="mt-2 flex items-center justify-between gap-3 text-xs tabular-nums text-secondary">
                <span className="min-w-0 truncate">
                  {formatTransferProgress(updateState.progress) ?? i18nService.t('updateDownloadingPill')}
                </span>
                {percent != null && <span className="shrink-0">{percent}%</span>}
              </div>
            </div>
          )}

          {updateState.installIncomplete && canInstall && (
            <p className="mt-3.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] px-3.5 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {i18nService.t('updateInstallIncomplete')}
            </p>
          )}

          {updateState.errorMessage && (
            <p className="mt-3.5 break-words rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-foreground">
              {formatAppUpdateError(updateState.errorMessage)}
            </p>
          )}
        </div>

        {showInfoFooter && (
          <div className="flex items-center justify-end gap-2.5 px-6 pb-5 pt-0.5">
            <button
              type="button"
              onClick={onCancel}
              className={SECONDARY_BUTTON_CLASS_NAME}
            >
              {i18nService.t('updateAvailableCancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={PRIMARY_BUTTON_CLASS_NAME}
            >
              {confirmLabel}
            </button>
          </div>
        )}

        {isDownloading && (
          <div className="flex items-center justify-end px-6 pb-5 pt-0.5">
            <button
              type="button"
              onClick={onCancel}
              className={SECONDARY_BUTTON_CLASS_NAME}
            >
              {i18nService.t('updateDownloadingDismiss')}
            </button>
          </div>
        )}

        {canInstall && (
          <div className="flex items-center justify-end gap-2.5 px-6 pb-5 pt-0.5">
            <button
              type="button"
              onClick={onCancel}
              className={SECONDARY_BUTTON_CLASS_NAME}
            >
              {i18nService.t('updateReadyLater')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={PRIMARY_BUTTON_CLASS_NAME}
            >
              {confirmLabel}
            </button>
          </div>
        )}

        {isInstalling && (
          <div className="flex flex-col items-center gap-3 px-6 pb-5 pt-1">
            <svg
              className="h-7 w-7 animate-spin text-foreground motion-reduce:animate-none"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3.5" />
              <path className="opacity-85" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-center text-sm text-secondary">
              {i18nService.t('updateInstallingHint')}
            </p>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-end gap-2.5 px-6 pb-5 pt-0.5">
            <button
              type="button"
              onClick={onCancel}
              className={SECONDARY_BUTTON_CLASS_NAME}
            >
              {i18nService.t('updateAvailableCancel')}
            </button>
            <button
              type="button"
              onClick={onRetry}
              className={PRIMARY_BUTTON_CLASS_NAME}
            >
              {confirmLabel}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default AppUpdateModal;
