import { type RefObject, useLayoutEffect } from 'react';

import { DesktopCompanionSize } from '../../../shared/desktopCompanion/constants';

/**
 * Content-sized companion windows (hint bubble, drop zone, selection toolbar
 * and answer card) report their card size so the main process can hug it.
 * The transparent margin leaves room for the card's own shadow.
 */
export function useMeasuredSurface(ref: RefObject<HTMLElement | null>, active: boolean, contentKey = ''): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    const pad = DesktopCompanionSize.SurfacePad;
    let frame = 0;
    let last = '';
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const size = { width: Math.ceil(rect.width + pad * 2), height: Math.ceil(rect.height + pad * 2) };
        const key = `${size.width}x${size.height}`;
        if (key === last) return;
        last = key;
        window.electron.desktopCompanion.resizeSurface(size);
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ref, active, contentKey]);
}
