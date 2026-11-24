import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useState } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

interface ModelSwitchConfirmDialogProps {
  isOpen: boolean;
  previousModelName: string;
  nextModelName: string;
  confirming?: boolean;
  onCancel: () => void;
  onConfirm: (dontAskAgain: boolean) => void;
}

const ModelSwitchConfirmDialog: React.FC<ModelSwitchConfirmDialogProps> = ({
  isOpen,
  previousModelName,
  nextModelName,
  confirming = false,
  onCancel,
  onConfirm,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const checkboxId = useId();
  const [dontAskAgain, setDontAskAgain] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setDontAskAgain(false);
    }
  }, [isOpen, previousModelName, nextModelName]);

  const handleCancel = () => {
    if (!confirming) onCancel();
  };

  const handleConfirm = () => {
    if (confirming) return;
    onConfirm(dontAskAgain);
  };

  const message = i18nService.t('coworkModelSwitchConfirmMessage')
    .replace('{previous}', () => previousModelName)
    .replace('{next}', () => nextModelName);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCancel}
      onEscape={handleCancel}
      overlayClassName="fixed inset-0 z-[10050] flex items-center justify-center modal-backdrop px-4"
      className="modal-content w-full max-w-[440px] overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="p-6"
      >
        <h2 id={titleId} className="text-base font-semibold leading-6 text-foreground">
          {i18nService.t('coworkModelSwitchConfirmTitle')}
        </h2>

        <p id={descriptionId} className="mt-2.5 text-sm leading-relaxed text-secondary">
          {message}
        </p>

        <div className="mt-5">
          <label
            htmlFor={checkboxId}
            className={`inline-flex select-none items-center gap-2.5 text-sm text-foreground ${
              confirming ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
            }`}
          >
            <input
              id={checkboxId}
              type="checkbox"
              checked={dontAskAgain}
              disabled={confirming}
              onChange={(event) => setDontAskAgain(event.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary/60 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-surface ${
                dontAskAgain
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-foreground/25 bg-surface hover:border-foreground/45'
              }`}
            >
              {dontAskAgain && <CheckIcon className="h-3 w-3 stroke-[2.5]" />}
            </span>
            <span>{i18nService.t('coworkModelSwitchConfirmDontAskAgain')}</span>
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            autoFocus
            onClick={handleCancel}
            disabled={confirming}
            className="rounded-xl border border-foreground/15 bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirming}
            className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {i18nService.t('coworkModelSwitchConfirmAction')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ModelSwitchConfirmDialog;
