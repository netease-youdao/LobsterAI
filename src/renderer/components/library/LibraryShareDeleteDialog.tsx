import { ArrowPathIcon, TrashIcon } from '@heroicons/react/24/outline';
import React, { useId, useState } from 'react';

import { i18nService } from '../../services/i18n';
import {
  MANAGEMENT_BODY_TEXT,
  MANAGEMENT_META_TEXT,
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';
import Modal from '../common/Modal';

interface LibraryShareDeleteDialogProps {
  fileName: string;
  busy: boolean;
  showFreeQuotaNotice: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

const LibraryShareDeleteDialog: React.FC<LibraryShareDeleteDialogProps> = ({
  fileName,
  busy,
  showFreeQuotaNotice,
  error,
  onCancel,
  onConfirm,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const [confirmation, setConfirmation] = useState('');
  const confirmed = confirmation.trim() === fileName;
  const cancel = (): void => {
    if (!busy) onCancel();
  };

  return (
    <Modal
      onClose={cancel}
      onEscape={cancel}
      overlayClassName="fixed inset-0 z-[9999] flex items-center justify-center modal-backdrop px-4"
      className="modal-content w-full max-w-[460px] rounded-2xl border border-border bg-surface p-6 shadow-modal"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-red-600">
          <TrashIcon className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2 id={titleId} className={`${MANAGEMENT_TITLE_TEXT} mt-4 font-semibold text-foreground`}>
          {i18nService.t('libraryShareDeleteConfirmTitle').replace('{name}', fileName)}
        </h2>
        <p id={descriptionId} className={`${MANAGEMENT_BODY_TEXT} mt-2 leading-[var(--lobster-leading-sm)] text-secondary`}>
          {i18nService.t('libraryShareDeleteConfirmDescription')}
        </p>
        {showFreeQuotaNotice && (
          <p className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-700 dark:text-red-300">
            {i18nService.t('libraryShareDeleteQuotaNotice')}
          </p>
        )}
        <label
          className={`${MANAGEMENT_META_TEXT} mt-4 block font-medium leading-[var(--lobster-leading-xs)] text-secondary`}
          htmlFor={inputId}
        >
          {i18nService.t('libraryShareDeleteConfirmInputLabel').replace('{name}', fileName)}
        </label>
        <input
          id={inputId}
          value={confirmation}
          disabled={busy}
          autoComplete="off"
          autoFocus
          onChange={event => setConfirmation(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && confirmed && !busy) onConfirm();
          }}
          className={`${MANAGEMENT_BODY_TEXT} mt-2 h-10 w-full rounded-lg border border-border bg-surface px-3 text-foreground outline-none transition-colors focus:border-red-500`}
        />
        {error && (
          <p className={`${MANAGEMENT_BODY_TEXT} mt-3 text-red-600 dark:text-red-400`}>
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={cancel}
            className={`rounded-lg border border-border px-4 py-2 ${MANAGEMENT_BODY_TEXT} text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !confirmed}
            aria-busy={busy}
            onClick={onConfirm}
            className={`inline-flex min-w-[112px] items-center justify-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 ${MANAGEMENT_BODY_TEXT} font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {busy ? (
              <>
                <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
                {i18nService.t('libraryShareDeleting')}
              </>
            ) : (
              i18nService.t('libraryShareDeletePermanently')
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default LibraryShareDeleteDialog;
