import React, { useCallback, useState } from 'react';

import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);

/** One zoom range for every preview and editor, so the panel's buttons match what each allows. */
export const OfficeZoom = {
  Default: 1,
  Min: 0.25,
  Max: 4,
  Step: 0.1,
} as const;

export function clampOfficeZoom(value: number): number {
  return Math.max(OfficeZoom.Min, Math.min(OfficeZoom.Max, Number(value.toFixed(2))));
}

export function useOfficePreviewZoom() {
  const [zoomFactor, setZoomFactor] = useState<number>(OfficeZoom.Default);

  const setClampedZoomFactor = useCallback((next: number | ((current: number) => number)) => {
    setZoomFactor(current => clampOfficeZoom(typeof next === 'function' ? next(current) : next));
  }, []);

  const zoomOut = useCallback(() => {
    setClampedZoomFactor(current => current - OfficeZoom.Step);
  }, [setClampedZoomFactor]);

  const zoomIn = useCallback(() => {
    setClampedZoomFactor(current => current + OfficeZoom.Step);
  }, [setClampedZoomFactor]);

  const resetZoom = useCallback(() => {
    setClampedZoomFactor(OfficeZoom.Default);
  }, [setClampedZoomFactor]);

  const zoomByWheelDelta = useCallback((deltaY: number) => {
    setClampedZoomFactor(current => current + (deltaY > 0 ? -OfficeZoom.Step : OfficeZoom.Step));
  }, [setClampedZoomFactor]);

  const handleWheelZoom = useCallback((event: React.WheelEvent<HTMLElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomByWheelDelta(event.deltaY);
  }, [zoomByWheelDelta]);

  const handleNativeWheelZoom = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomByWheelDelta(event.deltaY);
  }, [zoomByWheelDelta]);

  return {
    zoomFactor,
    zoomIn,
    zoomOut,
    resetZoom,
    handleWheelZoom,
    handleNativeWheelZoom,
  };
}

interface OfficeZoomControlsProps {
  zoomFactor: number;
  displayZoomFactor?: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
}

export const OfficeZoomControls: React.FC<OfficeZoomControlsProps> = ({
  zoomFactor,
  displayZoomFactor,
  onZoomOut,
  onZoomIn,
  onResetZoom,
}) => (
  <div className="flex shrink-0 items-center gap-1" aria-label={t('artifactBrowserZoom')}>
    <button
      type="button"
      onClick={onZoomOut}
      disabled={zoomFactor <= OfficeZoom.Min}
      className="flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-xs text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
      title={t('artifactBrowserZoomOut')}
      aria-label={t('artifactBrowserZoomOut')}
    >
      -
    </button>
    <button
      type="button"
      onClick={onResetZoom}
      className="h-6 min-w-[44px] rounded border border-border bg-surface px-1.5 text-xs tabular-nums text-secondary hover:bg-surface-hover"
      title={t('artifactBrowserResetZoom')}
      aria-label={t('artifactBrowserResetZoom')}
    >
      {Math.round((displayZoomFactor ?? zoomFactor) * 100)}%
    </button>
    <button
      type="button"
      onClick={onZoomIn}
      disabled={zoomFactor >= OfficeZoom.Max}
      className="flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-xs text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
      title={t('artifactBrowserZoomIn')}
      aria-label={t('artifactBrowserZoomIn')}
    >
      +
    </button>
  </div>
);
