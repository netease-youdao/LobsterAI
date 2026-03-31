import React from 'react';
import { XMarkIcon, InformationCircleIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

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
      <div className="w-full max-w-md mx-4 rounded-2xl border border-claude-border/60 dark:border-claude-darkBorder/60 bg-white/95 dark:bg-claude-darkSurface/95 text-claude-text dark:text-claude-darkText px-6 py-4 shadow-xl backdrop-blur-md animate-scale-in">
        <div className="flex items-start gap-4">
          <div className="shrink-0 rounded-full bg-claude-accent/10 p-2.5">
            <InformationCircleIcon className="h-5 w-5 text-claude-accent" />
          </div>
          <div className="flex-1 text-base font-medium leading-snug">
            {message}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText rounded-full p-1 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
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
