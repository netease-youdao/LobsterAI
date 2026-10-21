import { InformationCircleIcon } from '@heroicons/react/20/solid';
import { XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';

/**
 * Payload accepted by the global `app:showToast` event. Plain strings remain
 * supported; pass an object to attach an action button (e.g. "Show in Folder"
 * after an export completes).
 */
export interface ToastEventDetail {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const ToastPlacement = {
  Center: 'center',
  Top: 'top',
} as const;
export type ToastPlacement = typeof ToastPlacement[keyof typeof ToastPlacement];

interface ToastProps {
  placement?: ToastPlacement;
  message: string;
  closeLabel: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  /** Centers the toast on its nearest positioned ancestor instead of the window. */
  contained?: boolean;
}

const Toast: React.FC<ToastProps> = ({ message, closeLabel, actionLabel, onAction, onClose, placement = ToastPlacement.Center, contained = false }) => {
  return (
    <div className={`pointer-events-none ${contained ? 'absolute' : 'fixed'} left-1/2 z-[10000] w-max max-w-full -translate-x-1/2 px-4 ${
      placement === ToastPlacement.Top ? 'top-8' : 'top-1/2 -translate-y-1/2'
    }`}>
      <div
        className={`pointer-events-auto w-fit rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5 text-foreground shadow-elevated animate-scale-in ${
          placement === ToastPlacement.Top ? 'max-w-[min(42rem,calc(100vw-2rem))]' : 'max-w-[min(28rem,calc(100vw-2rem))]'
        }`}
        role="status"
        aria-live="polite"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="shrink-0 rounded-full bg-primary-muted p-1.5">
            <InformationCircleIcon className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1 text-sm font-medium leading-snug [overflow-wrap:anywhere]">
            {message}
          </div>
          {actionLabel && onAction && (
            <button
              onClick={() => {
                onAction();
                onClose?.();
              }}
              className="shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-sm font-medium text-primary transition-colors hover:bg-primary-muted"
            >
              {actionLabel}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 text-secondary hover:text-foreground rounded-full p-1 hover:bg-surface-raised transition-colors"
              aria-label={closeLabel}
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
