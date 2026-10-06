import React, { useEffect, useRef } from 'react';

interface AppUpdateInteractionOverlayProps {
  children: React.ReactNode;
}

const AppUpdateInteractionOverlay: React.FC<AppUpdateInteractionOverlayProps> = ({ children }) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const keepFocusInsideOverlay = (event: FocusEvent) => {
      if (event.target instanceof Node && !overlay.contains(event.target)) {
        overlay.focus({ preventScroll: true });
      }
    };

    overlay.focus({ preventScroll: true });
    document.addEventListener('focusin', keepFocusInsideOverlay, true);

    return () => {
      document.removeEventListener('focusin', keepFocusInsideOverlay, true);
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex cursor-wait items-center justify-center bg-surface p-4 outline-none"
      style={{
        backgroundImage: 'linear-gradient(360deg, rgba(255, 0, 77, 0) 5.5%, rgba(255, 0, 77, 0.05) 100%)',
      }}
      tabIndex={-1}
    >
      <div className="non-draggable flex h-full min-h-0 w-full max-w-lg cursor-default items-center py-2">
        {children}
      </div>
    </div>
  );
};

export default AppUpdateInteractionOverlay;
