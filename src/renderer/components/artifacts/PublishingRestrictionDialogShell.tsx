import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { type RefObject, useEffect, useRef } from 'react';

import Modal from '@/components/common/Modal';
import { i18nService } from '@/services/i18n';

interface PublishingRestrictionDialogShellProps {
  titleId: string;
  descriptionId?: string;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement>;
  maxWidthClassName?: string;
  overlayClassName?: string;
  children: React.ReactNode;
}

const FOCUSABLE_ELEMENT_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Visual and interaction shell shared only by publishing entitlement/quota
 * restrictions. Keeping it feature-scoped prevents unrelated app dialogs from
 * inheriting publishing-specific sizing or dismissal behavior.
 */
const PublishingRestrictionDialogShell: React.FC<PublishingRestrictionDialogShellProps> = ({
  titleId,
  descriptionId,
  onClose,
  initialFocusRef,
  maxWidthClassName = 'max-w-[448px]',
  overlayClassName =
    'fixed inset-0 z-[10040] flex items-center justify-center bg-black/35 p-4',
  children,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frameId = window.requestAnimationFrame(() => {
      (initialFocusRef?.current ?? closeButtonRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialogElement = dialogRef.current;
      if (!dialogElement) return;
      const focusableElements = Array.from(
        dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENT_SELECTOR),
      );
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (!dialogElement.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [initialFocusRef]);

  return (
    <Modal
      onClose={onClose}
      onEscape={onClose}
      overlayClassName={overlayClassName}
      className={`w-full ${maxWidthClassName}`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative max-h-[calc(100vh-2rem)] w-full overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          aria-label={i18nService.t('close')}
          title={i18nService.t('close')}
        >
          <XMarkIcon className="h-5 w-5" aria-hidden="true" />
        </button>
        {children}
      </div>
    </Modal>
  );
};

export default PublishingRestrictionDialogShell;
