import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
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
    className="modal-content w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
  >
    <div role="alertdialog" aria-modal="true" aria-labelledby="app-update-install-confirm-title">
      <div className="flex items-start gap-3 px-5 py-4">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-raised text-warning">
          <ExclamationTriangleIcon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 id="app-update-install-confirm-title" className="text-base font-semibold text-foreground">
            {i18nService.t('updateInstallConfirmTitle')}
          </h2>
          <p className="mt-1.5 text-sm leading-5 text-secondary">
            {i18nService.t('updateInstallConfirmMessage')}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        >
          {i18nService.t('updateInstallConfirmContinue')}
        </button>
      </div>
    </div>
  </Modal>
);

export default AppUpdateInstallConfirmDialog;
