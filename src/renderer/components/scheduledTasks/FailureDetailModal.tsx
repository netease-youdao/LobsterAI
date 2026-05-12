import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef } from 'react';

import { i18nService } from '../../services/i18n';

interface FailureDetailModalProps {
  inputCommand: string;
  error: string;
  taskName?: string;
  runTime?: string;
  onClose: () => void;
}

const FailureDetailModal: React.FC<FailureDetailModalProps> = ({
  inputCommand,
  error,
  taskName,
  runTime,
  onClose,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleOverlayClick}
    >
      <div className="bg-surface rounded-xl shadow-popover border border-border w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {i18nService.t('scheduledTasksFailureDetailTitle')}
            </h3>
            {taskName && (
              <p className="text-xs text-secondary mt-0.5">{taskName}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-4 overflow-y-auto">
          {/* Run time */}
          {runTime && (
            <div>
              <div className="text-xs font-medium text-secondary mb-1">
                {i18nService.t('scheduledTasksHistoryColTime')}
              </div>
              <div className="text-sm text-foreground">{runTime}</div>
            </div>
          )}

          {/* Input command */}
          <div>
            <div className="text-xs font-medium text-secondary mb-1">
              {i18nService.t('scheduledTasksInputCommand')}
            </div>
            <div className="text-sm text-foreground bg-surface-raised rounded-lg p-3 whitespace-pre-wrap break-words border border-border/50">
              {inputCommand || '-'}
            </div>
          </div>

          {/* Failure reason */}
          <div>
            <div className="text-xs font-medium text-red-500 mb-1">
              {i18nService.t('scheduledTasksFailureReason')}
            </div>
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 rounded-lg p-3 whitespace-pre-wrap break-words border border-red-200 dark:border-red-800">
              {error || '-'}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-foreground bg-surface-raised hover:bg-surface-overlay rounded-md border border-border transition-colors"
          >
            {i18nService.t('close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FailureDetailModal;
