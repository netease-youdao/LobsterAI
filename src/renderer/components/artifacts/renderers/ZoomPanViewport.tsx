import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  clampZoomScale,
  createZoomAnchor,
  getAnchoredScrollDelta,
  getWheelZoomScale,
  resolveSvgIntrinsicSize,
  type SvgIntrinsicSize,
  type ZoomAnchor,
  type ZoomPoint,
} from './zoomPan';

// Space around the content. It is part of the fit-width math, so it is applied as an
// inline style rather than a class.
const ZOOM_STAGE_PADDING_PX = 16;

interface ZoomState {
  scale: number;
  anchor: ZoomAnchor | null;
}

interface PanState {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface ZoomPan {
  scale: number;
  /** Width the content may take at 100%: the viewport minus the stage padding. */
  availableWidth: number;
  contentElement: HTMLElement | null;
  isPannable: boolean;
  isPanning: boolean;
  setViewportElement: (element: HTMLDivElement | null) => void;
  setContentElement: (element: HTMLElement | null) => void;
  /** Zooms around `point`, or around the viewport centre when it is omitted. */
  zoomTo: (getScale: (scale: number) => number, point?: ZoomPoint) => void;
  resetZoom: () => void;
  panHandlers: Pick<
    React.DOMAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'
  >;
}

export function useZoomPan(): ZoomPan {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, anchor: null });
  const [availableWidth, setAvailableWidth] = useState(0);
  const [isPannable, setIsPannable] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const appliedZoomRef = useRef(zoom);
  const panRef = useRef<PanState | null>(null);

  const zoomTo = useCallback((getScale: (scale: number) => number, point?: ZoomPoint) => {
    let anchor: ZoomAnchor | null = null;
    if (viewport && content) {
      const viewportRect = viewport.getBoundingClientRect();
      anchor = createZoomAnchor(
        point ?? {
          clientX: viewportRect.left + viewport.clientWidth / 2,
          clientY: viewportRect.top + viewport.clientHeight / 2,
        },
        content.getBoundingClientRect(),
      );
    }
    setZoom(prev => {
      const scale = clampZoomScale(getScale(prev.scale));
      return scale === prev.scale ? prev : { scale, anchor };
    });
  }, [viewport, content]);

  const resetZoom = useCallback(() => zoomTo(() => 1), [zoomTo]);

  // Runs after the zoomed size is in the DOM: scroll so the anchored point stays put.
  useLayoutEffect(() => {
    if (appliedZoomRef.current === zoom) return;
    appliedZoomRef.current = zoom;
    if (!viewport || !content || !zoom.anchor) return;
    const delta = getAnchoredScrollDelta(zoom.anchor, content.getBoundingClientRect());
    viewport.scrollLeft += delta.x;
    viewport.scrollTop += delta.y;
  }, [zoom, viewport, content]);

  useEffect(() => {
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomTo(scale => getWheelZoomScale(scale, event.deltaY), event);
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [viewport, zoomTo]);

  useLayoutEffect(() => {
    if (!viewport) return;
    const measure = () => {
      setAvailableWidth(Math.max(0, viewport.clientWidth - ZOOM_STAGE_PADDING_PX * 2));
      setIsPannable(
        viewport.scrollWidth > viewport.clientWidth + 1 || viewport.scrollHeight > viewport.clientHeight + 1,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [viewport, content]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // A press on a scrollbar targets the viewport itself; leave it to the browser.
    if (!isPannable || event.button !== 0 || event.pointerType !== 'mouse' || event.target === event.currentTarget) {
      return;
    }
    const target = event.currentTarget;
    panRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: target.scrollLeft,
      scrollTop: target.scrollTop,
    };
    target.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }, [isPannable]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
  }, []);

  const handlePanEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
  }, []);

  return {
    scale: zoom.scale,
    availableWidth,
    contentElement: content,
    isPannable,
    isPanning,
    setViewportElement: setViewport,
    setContentElement: setContent,
    zoomTo,
    resetZoom,
    panHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePanEnd,
      onPointerCancel: handlePanEnd,
      onLostPointerCapture: handlePanEnd,
    },
  };
}

/**
 * Reads the size hints of the SVG injected into `container`. SVGs without a viewBox get
 * one, otherwise resizing the element would not scale the drawing.
 */
export function useInjectedSvgSize(container: HTMLElement | null, markup: string): SvgIntrinsicSize | null {
  const [measured, setMeasured] = useState<{ markup: string; size: SvgIntrinsicSize } | null>(null);

  useLayoutEffect(() => {
    const svg = container?.querySelector<SVGSVGElement>(':scope > svg');
    if (!svg) {
      setMeasured(null);
      return;
    }
    const size = resolveSvgIntrinsicSize({
      width: svg.getAttribute('width'),
      height: svg.getAttribute('height'),
      viewBox: svg.getAttribute('viewBox'),
      maxWidth: svg.style.maxWidth || null,
    });
    if (size.fallbackViewBox) svg.setAttribute('viewBox', size.fallbackViewBox);
    setMeasured({ markup, size });
  }, [container, markup]);

  return measured?.markup === markup ? measured.size : null;
}

interface ZoomPanViewportProps {
  zoomPan: ZoomPan;
  /** Whether the content has an explicit zoomed size yet; until then it is laid out to fit. */
  isContentSized: boolean;
  /** Controls pinned over the viewport, outside the scrolling area. */
  overlay?: React.ReactNode;
  children: React.ReactNode;
}

export const ZoomPanViewport: React.FC<ZoomPanViewportProps> = ({ zoomPan, isContentSized, overlay, children }) => {
  const cursorClass = zoomPan.isPanning
    ? 'cursor-grabbing select-none'
    : zoomPan.isPannable ? 'cursor-grab select-none' : '';
  return (
    <div className="relative h-full w-full">
      <div
        ref={zoomPan.setViewportElement}
        className={`h-full w-full overflow-auto [scrollbar-gutter:stable] ${cursorClass}`}
        {...zoomPan.panHandlers}
      >
        {/* Grows with the content and centres it with auto margins, so an oversized
            child overflows only to the right and bottom, where it can be scrolled to. */}
        <div
          className={`flex min-h-full min-w-full ${isContentSized ? 'w-max' : ''}`}
          style={{ padding: ZOOM_STAGE_PADDING_PX }}
        >
          {children}
        </div>
      </div>
      {overlay}
    </div>
  );
};

export const ZoomResetBadge: React.FC<{ zoomPan: ZoomPan }> = ({ zoomPan }) => {
  if (zoomPan.scale === 1) return null;
  return (
    <button
      type="button"
      onClick={zoomPan.resetZoom}
      className="absolute bottom-3 right-3 px-2 py-1 text-xs rounded bg-surface text-secondary hover:bg-surface-hover"
    >
      {Math.round(zoomPan.scale * 100)}%
    </button>
  );
};
