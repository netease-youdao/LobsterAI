import React from 'react';
import { XMarkIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import { InformationCircleIcon } from '@heroicons/react/20/solid';

interface ToastProps {
  message: string;
  variant?: 'info' | 'success';
  onClose?: () => void;
}

const Toast: React.FC<ToastProps> = ({ message, variant = 'info', onClose }) => {
  if (variant === 'success') {
    return (
      <div className="fixed top-5 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-claude-accent text-white text-sm font-medium shadow-lg animate-scale-in">
          <CheckCircleIcon className="h-4 w-4 shrink-0" />
          <span>{message}</span>
        </div>
      </div>
    );
  }

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