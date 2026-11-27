import type { Artifact } from '../../../types/artifact';

export interface ImageStudioViewportSnapshot {
  /** Zoom multiplier relative to the fitted image size (`1` = fit to window). */
  zoom: number;
  /** Normalized horizontal center of the visible area on the image (`0..1`). */
  centerX: number;
  /** Normalized vertical center of the visible area on the image (`0..1`). */
  centerY: number;
}

export interface StudioStageMetrics {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  insetTop: number;
  insetBottom: number;
  horizontalGutter: number;
  zoom: number;
}

export interface StudioGalleryState {
  items: readonly Artifact[];
  activeIndex: number;
}

const MIN_STUDIO_ZOOM = 0.25;
const MAX_STUDIO_ZOOM = 8;

const clamp = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, value))
);

export const clampStudioZoom = (value: number): number => (
  Number.isFinite(value) ? clamp(value, MIN_STUDIO_ZOOM, MAX_STUDIO_ZOOM) : 1
);

/**
 * Normalizes a studio gallery list so the active artifact always has a valid index
 * and duplicate artifact IDs never produce redundant thumbnails.
 */
export function normalizeStudioGallery(
  artifact: Artifact,
  artifacts?: readonly Artifact[],
): StudioGalleryState {
  if (!artifacts?.length) {
    return { items: [artifact], activeIndex: 0 };
  }

  const items: Artifact[] = [];
  const seenIds = new Set<string>();
  for (const candidate of artifacts) {
    if (!candidate?.id || seenIds.has(candidate.id)) continue;
    seenIds.add(candidate.id);
    items.push(candidate);
  }

  let activeIndex = items.findIndex((item) => item.id === artifact.id);
  if (activeIndex < 0 && artifact.filePath) {
    activeIndex = items.findIndex((item) => item.filePath === artifact.filePath);
  }
  if (activeIndex < 0) {
    items.unshift(artifact);
    activeIndex = 0;
  }

  return { items, activeIndex };
}

/**
 * Computes the fitted stage geometry and offsets inside the scrollable viewport.
 * Mirrors the flex-centered padded layout in `ImageEditor`.
 */
export function computeStudioStageGeometry(metrics: StudioStageMetrics): {
  fit: number;
  displayWidth: number;
  displayHeight: number;
  innerWidth: number;
  innerHeight: number;
  stageLeft: number;
  stageTop: number;
  visibleCenterOffsetY: number;
} {
  const safeImageWidth = Math.max(1, metrics.imageWidth);
  const safeImageHeight = Math.max(1, metrics.imageHeight);
  const availableWidth = Math.max(1, metrics.viewportWidth - metrics.horizontalGutter * 2);
  const availableHeight = Math.max(1, metrics.viewportHeight - metrics.insetTop - metrics.insetBottom);
  const fit = Math.min(availableWidth / safeImageWidth, availableHeight / safeImageHeight, 1);
  const safeFit = Math.max(0.01, fit);
  const safeZoom = clampStudioZoom(metrics.zoom);
  const displayWidth = Math.max(1, safeImageWidth * safeFit * safeZoom);
  const displayHeight = Math.max(1, safeImageHeight * safeFit * safeZoom);
  const innerWidth = Math.max(metrics.viewportWidth, displayWidth + metrics.horizontalGutter * 2);
  const innerHeight = Math.max(metrics.viewportHeight, displayHeight + metrics.insetTop + metrics.insetBottom);
  const contentAreaWidth = Math.max(0, innerWidth - metrics.horizontalGutter * 2);
  const contentAreaHeight = Math.max(0, innerHeight - metrics.insetTop - metrics.insetBottom);
  const stageLeft = metrics.horizontalGutter + Math.max(0, (contentAreaWidth - displayWidth) / 2);
  const stageTop = metrics.insetTop + Math.max(0, (contentAreaHeight - displayHeight) / 2);
  const visibleCenterOffsetY = metrics.insetTop + Math.max(0, metrics.viewportHeight - metrics.insetTop - metrics.insetBottom) / 2;

  return {
    fit,
    displayWidth,
    displayHeight,
    innerWidth,
    innerHeight,
    stageLeft,
    stageTop,
    visibleCenterOffsetY,
  };
}

/**
 * Captures the user's current zoom and normalized focal center on the image
 * so switching to another gallery image can restore the same framing.
 */
export function captureStudioViewportSnapshot(
  metrics: StudioStageMetrics & { scrollLeft: number; scrollTop: number },
): ImageStudioViewportSnapshot {
  const geometry = computeStudioStageGeometry(metrics);
  const visibleCenterX = metrics.scrollLeft + metrics.viewportWidth / 2;
  const visibleCenterY = metrics.scrollTop + geometry.visibleCenterOffsetY;
  return {
    zoom: clampStudioZoom(metrics.zoom),
    centerX: clamp((visibleCenterX - geometry.stageLeft) / geometry.displayWidth, 0, 1),
    centerY: clamp((visibleCenterY - geometry.stageTop) / geometry.displayHeight, 0, 1),
  };
}

/**
 * Converts a saved viewport snapshot into clamped scroll offsets for the newly loaded image.
 */
export function resolveStudioViewportScroll(
  metrics: Omit<StudioStageMetrics, 'zoom'>,
  snapshot: ImageStudioViewportSnapshot,
): { scrollLeft: number; scrollTop: number } {
  const geometry = computeStudioStageGeometry({ ...metrics, zoom: snapshot.zoom });
  const targetX = geometry.stageLeft + clamp(snapshot.centerX, 0, 1) * geometry.displayWidth;
  const targetY = geometry.stageTop + clamp(snapshot.centerY, 0, 1) * geometry.displayHeight;
  const maxScrollLeft = Math.max(0, geometry.innerWidth - metrics.viewportWidth);
  const maxScrollTop = Math.max(0, geometry.innerHeight - metrics.viewportHeight);
  return {
    scrollLeft: clamp(targetX - metrics.viewportWidth / 2, 0, maxScrollLeft),
    scrollTop: clamp(targetY - geometry.visibleCenterOffsetY, 0, maxScrollTop),
  };
}

/**
 * Returns whether keyboard gallery navigation (`ArrowLeft`, `ArrowRight`, `Home`, `End`)
 * should be handled by the studio instead of an active form control or editing tool.
 */
export function canNavigateStudioGalleryByKey(params: {
  canNavigate: boolean;
  isTyping: boolean;
  isViewMode: boolean;
  hasVersionMenuOpen: boolean;
  isBusy: boolean;
  hasActiveDraft: boolean;
}): boolean {
  return (
    params.canNavigate
    && !params.isTyping
    && params.isViewMode
    && !params.hasVersionMenuOpen
    && !params.isBusy
    && !params.hasActiveDraft
  );
}

/**
 * Returns the unique cache key for a preloaded studio image artifact.
 */
export function getStudioArtifactCacheKey(
  artifact: Pick<Artifact, 'id' | 'contentVersion' | 'createdAt' | 'filePath'>,
): string {
  return `${artifact.id}:${artifact.contentVersion ?? artifact.createdAt}:${artifact.filePath ?? ''}`;
}
