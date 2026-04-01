import React, { useCallback, useEffect, useRef } from 'react';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

interface UnsavedChangesModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

const UnsavedChangesModal: React.FC<UnsavedChangesModalProps> = ({
  onConfirm,
  onCancel,
}) => {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      aria-describedby="unsaved-changes-desc"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      <div
        className="relative w-80 rounded-xl shadow-2xl bg-surface border border-border p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center">
          <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
            <ExclamationTriangleIcon className="w-5 h-5 text-amber-500" />
          </div>
          <h3 id="unsaved-changes-title" className="text-sm font-semibold text-foreground mb-2">
            {i18nService.t('scheduledTasksUnsavedChangesTitle')}
          </h3>
          <p id="unsaved-changes-desc" className="text-sm text-secondary mb-5">
            {i18nService.t('scheduledTasksUnsavedChangesMessage')}
          </p>
          <div className="flex items-center gap-3 w-full">
            <button
              ref={cancelButtonRef}
              type="button"
              onClick={onCancel}
              className="flex-1 px-4 py-2 text-sm rounded-lg text-foreground border border-border hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('scheduledTasksUnsavedChangesContinueEditing')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="flex-1 px-4 py-2 text-sm rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
            >
              {i18nService.t('scheduledTasksUnsavedChangesDiscard')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UnsavedChangesModal;
