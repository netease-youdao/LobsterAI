/**
 * Pure responsive layout, zoom, and presentation scaling helpers for the PowerPoint editor.
 * Kept DOM-free so the geometry rules can be tested directly in Vitest.
 */

export const SlidesThumbLayout = {
  Bottom: 'bottom',
  Left: 'left',
} as const;
export type SlidesThumbLayout = typeof SlidesThumbLayout[keyof typeof SlidesThumbLayout];

export const SlidesToolbarDensity = {
  Full: 'full',
  Compact: 'compact',
  Minimal: 'minimal',
} as const;
export type SlidesToolbarDensity = typeof SlidesToolbarDensity[keyof typeof SlidesToolbarDensity];

/** Below this editor width, 16:9 slides are width-bound so thumbnails move to a bottom strip. */
export const SLIDES_WIDE_BREAKPOINT_PX = 760;
/** Compact stage padding below this stage width so split-pane slides reclaim horizontal width. */
export const SLIDES_COMPACT_STAGE_BREAKPOINT_PX = 640;
/** Toolbar breakpoints to keep the top header strictly single-row without wrapping. */
export const SLIDES_TOOLBAR_COMPACT_WIDTH_PX = 470;
export const SLIDES_TOOLBAR_MINIMAL_WIDTH_PX = 380;

export const SLIDES_ZOOM_LIMITS = { min: 0.25, max: 4 } as const;
/** Fitting goes below the smallest fixed zoom step so narrow panels still fit the whole slide. */
export const SLIDES_MIN_FIT_ZOOM = 0.1;
export const SLIDES_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const HORIZONTAL_THUMB_HEIGHT_PX = 54;
const HORIZONTAL_THUMB_WIDTH_BOUNDS = { min: 64, max: 112 } as const;

/** Wide/expanded panels dock thumbnails on the left; narrow split panels place them along the bottom. */
export function resolveSlidesThumbLayout(editorWidth: number): SlidesThumbLayout {
  return editorWidth >= SLIDES_WIDE_BREAKPOINT_PX
    ? SlidesThumbLayout.Left
    : SlidesThumbLayout.Bottom;
}

/** Responsive stage padding around the active slide canvas. */
export function resolveStagePadding(stageWidth: number): { x: number; y: number } {
  if (stageWidth > 0 && stageWidth < SLIDES_COMPACT_STAGE_BREAKPOINT_PX) {
    return { x: 12, y: 16 };
  }
  return { x: 24, y: 24 };
}

/**
 * Compute the largest scale that fits `slide` inside `stage` after subtracting symmetric padding.
 * Rounded down to 0.01 so the fitted slide never overflows by a fractional pixel.
 */
export function resolveFitZoom(
  slide: { width: number; height: number },
  stage: { width: number; height: number },
  padding: { x: number; y: number },
): number | undefined {
  const width = stage.width - padding.x * 2;
  const height = stage.height - padding.y * 2;
  if (slide.width <= 0 || slide.height <= 0 || width <= 0 || height <= 0) return undefined;
  const raw = Math.min(width / slide.width, height / slide.height);
  return Math.max(
    SLIDES_MIN_FIT_ZOOM,
    Math.min(SLIDES_ZOOM_LIMITS.max, Math.floor(raw * 100) / 100),
  );
}

/** Horizontal filmstrip thumbnail dimensions preserving the slide aspect ratio within sensible bounds. */
export function resolveHorizontalThumbSize(
  slideSize: { width: number; height: number },
): { width: number; height: number } {
  const ratio = slideSize.width > 0 && slideSize.height > 0
    ? slideSize.width / slideSize.height
    : 16 / 9;
  const width = Math.round(
    Math.max(
      HORIZONTAL_THUMB_WIDTH_BOUNDS.min,
      Math.min(HORIZONTAL_THUMB_WIDTH_BOUNDS.max, HORIZONTAL_THUMB_HEIGHT_PX * ratio),
    ),
  );
  const height = Math.max(36, Math.round(width / ratio));
  return { width, height };
}

/** Scale a slide to fill the presentation viewport while keeping its aspect ratio intact. */
export function resolvePresentationScale(
  slide: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (slide.width <= 0 || slide.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return 1;
  }
  return Math.min(viewport.width / slide.width, viewport.height / slide.height);
}

/** Clamp slide stepping within `[0, count - 1]`. */
export function stepSlideIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, current + delta));
}

/** Single-row toolbar density tier based on the available editor width. */
export function resolveSlidesToolbarDensity(width: number): SlidesToolbarDensity {
  if (width > 0 && width < SLIDES_TOOLBAR_MINIMAL_WIDTH_PX) {
    return SlidesToolbarDensity.Minimal;
  }
  if (width > 0 && width < SLIDES_TOOLBAR_COMPACT_WIDTH_PX) {
    return SlidesToolbarDensity.Compact;
  }
  return SlidesToolbarDensity.Full;
}
