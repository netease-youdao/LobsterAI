import React, { useRef } from 'react';

interface ModalProps {
  isOpen?: boolean;
  onClose: () => void;
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
  className,
  overlayClassName,
  onClick,
  children,
}) => {
  const mouseDownOnBackdropRef = useRef(false);

  if (isOpen === false) return null;

  return (
    <div
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
};

export default Modal;
