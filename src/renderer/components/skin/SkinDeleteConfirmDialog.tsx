import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useId } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

interface SkinDeleteConfirmDialogProps {
  skinName: string;
  isActive: boolean;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const SkinDeleteConfirmDialog: React.FC<SkinDeleteConfirmDialogProps> = ({
  skinName,
  isActive,
  isDeleting,
  onCancel,
  onConfirm,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const handleCancel = () => {
    if (!isDeleting) onCancel();
  };

  return (
    <Modal
      onClose={handleCancel}
      overlayClassName="fixed inset-0 z-[9999] flex items-center justify-center modal-backdrop px-4"
      className="modal-content w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-raised text-destructive">
            <ExclamationTriangleIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              {i18nService.t('aiSkinDeleteConfirmTitle')}
            </h2>
            <div id={descriptionId} className="mt-1.5 space-y-2 text-sm leading-5 text-secondary">
              <p>{i18nService.t('aiSkinDeleteConfirmMessage').replace('{name}', skinName)}</p>
              {isActive && (
                <p className="font-medium text-foreground">
                  {i18nService.t('aiSkinDeleteActiveWarning')}
                </p>
              )}
              <p className="text-xs">{i18nService.t('aiSkinDeleteManagedCopyNote')}</p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isDeleting}
            className="rounded-lg px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDeleting ? i18nService.t('aiSkinDeleting') : i18nService.t('aiSkinDelete')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default SkinDeleteConfirmDialog;
