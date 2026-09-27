import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  createModalEscapeLayerId,
  isDismissEscapeEvent,
  isTopModalEscapeLayer,
  registerModalEscapeLayer,
  unregisterModalEscapeLayer,
} from './modalEscape';

interface ModalProps {
  isOpen?: boolean;
  onClose: () => void;
  /**
   * Opt-in Escape handling. Runs only while this modal is the topmost one, so a
   * dialog opened inside another modal dismisses itself without closing the
   * modal behind it. Pass `onClose` when Escape should simply close the modal.
   */
  onEscape?: () => void;
  className?: string;
  overlayClassName?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}

/**
 * Modal — A base modal overlay component with correct close-on-backdrop behavior.
 *
 * Only closes when the user clicks the backdrop directly (mousedown + mouseup both on backdrop).
 * Dragging text from inside the modal to outside will NOT close the modal.
 */
const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  onEscape,
  className,
  overlayClassName,
  onClick,
  children,
}) => {
  const mouseDownOnBackdropRef = useRef(false);
  const layerIdRef = useRef<number | null>(null);
  if (layerIdRef.current === null) {
    layerIdRef.current = createModalEscapeLayerId();
  }
  const layerId = layerIdRef.current;
  const onEscapeRef = useRef(onEscape);
  const escapeEnabled = Boolean(onEscape);
  const isVisible = isOpen !== false;

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!isVisible) return undefined;
    registerModalEscapeLayer(layerId);
    return () => unregisterModalEscapeLayer(layerId);
  }, [isVisible, layerId]);

  useEffect(() => {
    if (!isVisible || !escapeEnabled) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isDismissEscapeEvent(event)) return;
      if (!isTopModalEscapeLayer(layerId)) return;
      // Mark the press as handled so outer listeners keep their overlays open.
      event.preventDefault();
      onEscapeRef.current?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, escapeEnabled, layerId]);

  if (!isVisible) return null;

  const modal = (
    <div
      data-app-modal
      className={overlayClassName ?? 'fixed inset-0 z-50 flex items-center justify-center bg-black/50'}
      onMouseDown={(e) => {
        // Record whether mousedown started on the backdrop (not on modal content)
        mouseDownOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Only close if both mousedown and click ended on the backdrop
        if (e.target === e.currentTarget && mouseDownOnBackdropRef.current) {
          mouseDownOnBackdropRef.current = false;
          onClose();
        }
      }}
    >
      <div
        className={className}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      >
        {children}
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modal;
  }

  return createPortal(modal, document.body);
};

export default Modal;
