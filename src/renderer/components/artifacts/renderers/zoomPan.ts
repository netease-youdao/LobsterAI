// Pure helpers behind the zoomable previews (image, SVG, Mermaid).
//
// Zoom changes the content's layout size instead of applying a CSS transform: a
// transform does not grow the scrollable area, so the part pushed past the left and
// top edges could never be scrolled back into view.

export const MIN_ZOOM_SCALE = 0.1;
export const MAX_ZOOM_SCALE = 5;
export const ZOOM_BUTTON_STEP = 0.1;

// Ctrl/Cmd + wheel, and trackpad pinch, which Chromium reports the same way. Capping
// each event keeps one mouse-wheel notch at about 10% while small pinch deltas still
// track the fingers.
const WHEEL_ZOOM_SENSITIVITY = 0.01;
const WHEEL_ZOOM_MAX_DELTA = 10;

// Browsers give an SVG without size hints the default 300x150 object size.
const DEFAULT_SVG_WIDTH = 300;
const DEFAULT_SVG_HEIGHT = 150;

const SVG_LENGTH_UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

export interface ZoomPoint {
  clientX: number;
  clientY: number;
}

export interface ZoomRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ZoomSize {
  width: number;
  height: number;
}

/** A pointer position plus the point of the content under it, as a fraction of the content box. */
export interface ZoomAnchor extends ZoomPoint {
  ratioX: number;
  ratioY: number;
}

export const clampZoomScale = (scale: number): number =>
  Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale));

/** Wheel zoom is multiplicative so a notch feels the same at every zoom level. */
export const getWheelZoomScale = (scale: number, deltaY: number): number => {
  const delta = Math.max(-WHEEL_ZOOM_MAX_DELTA, Math.min(WHEEL_ZOOM_MAX_DELTA, deltaY));
  return clampZoomScale(scale * Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY));
};

/** Button zoom moves in fixed steps, rounded so repeated steps do not drift. */
export const stepZoomScale = (scale: number, direction: 1 | -1): number =>
  clampZoomScale(Math.round((scale + direction * ZOOM_BUTTON_STEP) * 100) / 100);

export const createZoomAnchor = (point: ZoomPoint, contentRect: ZoomRect): ZoomAnchor | null => {
  if (contentRect.width <= 0 || contentRect.height <= 0) return null;
  return {
    clientX: point.clientX,
    clientY: point.clientY,
    ratioX: (point.clientX - contentRect.left) / contentRect.width,
    ratioY: (point.clientY - contentRect.top) / contentRect.height,
  };
};

/** Scroll change that brings the anchored content point back under the pointer after a zoom. */
export const getAnchoredScrollDelta = (anchor: ZoomAnchor, contentRect: ZoomRect): { x: number; y: number } => ({
  x: contentRect.left + anchor.ratioX * contentRect.width - anchor.clientX,
  y: contentRect.top + anchor.ratioY * contentRect.height - anchor.clientY,
});

/**
 * At 100% content is as wide as the panel allows but never wider than its intrinsic
 * width; tall content keeps that width and scrolls. A null intrinsic width fills the panel.
 */
export const getZoomedSize = ({
  intrinsicWidth,
  aspectRatio,
  availableWidth,
  scale,
}: {
  intrinsicWidth: number | null;
  aspectRatio: number;
  availableWidth: number;
  scale: number;
}): ZoomSize | null => {
  if (!(aspectRatio > 0) || !(availableWidth > 0)) return null;
  const fitWidth = intrinsicWidth !== null && intrinsicWidth > 0
    ? Math.min(intrinsicWidth, availableWidth)
    : availableWidth;
  const width = fitWidth * scale;
  return { width, height: width / aspectRatio };
};

export interface SvgSizeAttributes {
  width: string | null;
  height: string | null;
  viewBox: string | null;
  /** Inline `max-width`, which Mermaid uses to declare the diagram's natural width. */
  maxWidth?: string | null;
}

export interface SvgIntrinsicSize {
  /** Natural width in px; null when the SVG is meant to fill the available width. */
  width: number | null;
  aspectRatio: number;
  /** viewBox to add so the drawing scales with the element; null when it already has one. */
  fallbackViewBox: string | null;
}

const parseSvgLength = (value: string | null | undefined): number | null => {
  const match = value?.trim().toLowerCase().match(/^(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm|q)?$/);
  if (!match) return null;
  const length = Number(match[1]) * SVG_LENGTH_UNIT_PX[match[2] ?? ''];
  return Number.isFinite(length) && length > 0 ? length : null;
};

const parseViewBoxSize = (value: string | null): ZoomSize | null => {
  const parts = value?.trim().split(/[\s,]+/).map(Number) ?? [];
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return null;
  const [, , width, height] = parts;
  return width > 0 && height > 0 ? { width, height } : null;
};

export const resolveSvgIntrinsicSize = ({ width, height, viewBox, maxWidth }: SvgSizeAttributes): SvgIntrinsicSize => {
  const declaredWidth = parseSvgLength(width);
  const declaredHeight = parseSvgLength(height);
  const viewBoxSize = parseViewBoxSize(viewBox);

  if (!viewBoxSize) {
    const fallbackWidth = declaredWidth ?? DEFAULT_SVG_WIDTH;
    const fallbackHeight = declaredHeight ?? DEFAULT_SVG_HEIGHT;
    return {
      width: fallbackWidth,
      aspectRatio: fallbackWidth / fallbackHeight,
      fallbackViewBox: `0 0 ${fallbackWidth} ${fallbackHeight}`,
    };
  }

  const aspectRatio = declaredWidth && declaredHeight
    ? declaredWidth / declaredHeight
    : viewBoxSize.width / viewBoxSize.height;
  return {
    width: declaredWidth ?? (declaredHeight ? declaredHeight * aspectRatio : parseSvgLength(maxWidth)),
    aspectRatio,
    fallbackViewBox: null,
  };
};
