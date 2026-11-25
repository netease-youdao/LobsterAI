import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

interface AppUpdateInstallConfirmDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Asked before installing while an agent turn or scheduled task is still
 * running: installing quits the app, which cuts that work short.
 */
const AppUpdateInstallConfirmDialog: React.FC<AppUpdateInstallConfirmDialogProps> = ({
  onCancel,
  onConfirm,
}) => (
  <Modal
    onClose={onCancel}
    onEscape={onCancel}
    overlayClassName="fixed inset-0 z-[9999] flex items-center justify-center modal-backdrop px-4"
    className="modal-content w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
  >
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="app-update-install-confirm-title"
      aria-describedby="app-update-install-confirm-message"
      className="p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <ExclamationTriangleIcon
            className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <h2 id="app-update-install-confirm-title" className="text-base font-semibold leading-6 text-foreground">
            {i18nService.t('updateInstallConfirmTitle')}
          </h2>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label={i18nService.t('close')}
          title={i18nService.t('close')}
          className="-mr-1 -mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <p id="app-update-install-confirm-message" className="mt-2.5 text-sm leading-relaxed text-secondary">
        {i18nService.t('updateInstallConfirmMessage')}
      </p>

      <div className="mt-6 flex items-center justify-end gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-foreground/15 bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        >
          {i18nService.t('updateInstallConfirmContinue')}
        </button>
      </div>
    </div>
  </Modal>
);

export default AppUpdateInstallConfirmDialog;
