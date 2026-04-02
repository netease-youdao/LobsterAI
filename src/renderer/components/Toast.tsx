import React from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { InformationCircleIcon } from '@heroicons/react/20/solid';

interface ToastProps {
  message: string;
  onClose?: () => void;
}

const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="w-full max-w-md mx-4 rounded-2xl border border-border-subtle bg-surface text-foreground px-5 py-3.5 shadow-xl backdrop-blur-md animate-scale-in">
        <div className="flex items-center gap-3">
          <div className="shrink-0 rounded-full bg-primary-muted p-2">
            <InformationCircleIcon className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 text-sm font-medium leading-snug">
            {message}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 text-secondary hover:text-foreground rounded-full p-1 hover:bg-surface-raised transition-colors"
              aria-label="Close"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Toast;
