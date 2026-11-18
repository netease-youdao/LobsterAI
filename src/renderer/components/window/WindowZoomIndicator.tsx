import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { APP_ZOOM_CSS_VARIABLE } from './windowZoom';

const INDICATOR_VISIBLE_MS = 1500;

/**
 * Shows the main window zoom for a moment after Cmd/Ctrl + =, -, 0 or Cmd/Ctrl + wheel, and keeps the
 * zoom in a CSS variable for layouts that must stay the same on screen.
 */
const WindowZoomIndicator: React.FC = () => {
  const [zoomFactor, setZoomFactor] = useState<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = window.electron?.window?.onZoomChanged?.(({ zoomFactor: nextZoomFactor }) => {
      document.documentElement.style.setProperty(APP_ZOOM_CSS_VARIABLE, String(nextZoomFactor));
      setZoomFactor(nextZoomFactor);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        setZoomFactor(null);
        hideTimerRef.current = null;
      }, INDICATOR_VISIBLE_MS);
    });
    return () => {
      unsubscribe?.();
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  if (zoomFactor === null) return null;
  const resetShortcut = window.electron?.platform === 'darwin' ? '⌘0' : 'Ctrl+0';
  return (
    // Undoing the page zoom keeps the indicator the same size at every zoom level.
    <div
      className="pointer-events-none fixed left-1/2 top-14 z-[10001] -translate-x-1/2"
      style={{ zoom: 1 / zoomFactor }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface px-3.5 py-1.5 shadow-elevated">
        <span className="text-sm font-semibold tabular-nums text-foreground">{Math.round(zoomFactor * 100)}%</span>
        {zoomFactor !== 1 && (
          <span className="text-xs text-secondary">
            {i18nService.t('windowZoomResetHint').replace('{shortcut}', resetShortcut)}
          </span>
        )}
      </div>
    </div>
  );
};

export default WindowZoomIndicator;
