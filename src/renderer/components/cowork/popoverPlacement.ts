export interface PopoverPlacementOptions {
  preferredAlign: 'left' | 'right';
  /** Estimated popover height in px, used to decide up vs down. */
  estimatedHeight: number;
  /** Estimated popover width in px, used to decide the anchored side. */
  desiredWidth: number;
}

export interface PopoverPlacement {
  direction: 'up' | 'down';
  alignSide: 'left' | 'right';
  /** Width cap in px when even the chosen side cannot fully fit the popover. */
  maxWidth: number | null;
}

export interface PopoverEdgeRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PopoverBoundaryBounds extends PopoverEdgeRect {
  element: HTMLElement | null;
}

export interface FixedPopoverPlacementOptions {
  anchor: PopoverEdgeRect;
  viewportWidth: number;
  viewportHeight: number;
  desiredWidth: number;
  estimatedHeight: number;
  gap?: number;
  margin?: number;
  boundary?: Partial<PopoverEdgeRect>;
  preferredAlign?: 'left' | 'right';
}

export interface FixedPopoverPlacement {
  left: number;
  width: number;
  direction: 'up' | 'down';
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export const POPOVER_BOUNDARY_SELECTOR = '[data-popover-boundary="true"]';

const CLIPPING_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'hidden', 'clip']);
const POPOVER_EDGE_MARGIN = 8;

/**
 * Pure placement math for portal/fixed popovers anchored to an element inside
 * a split pane. Never crosses `boundary.right` (which separates HTML panes
 * from native Electron `WebContentsView` sidebars such as Agent Browser /
 * Word), while allowing leftward overflow over HTML chrome if needed before
 * shrinking the width.
 */
export function resolveFixedPopoverPlacement(
  options: FixedPopoverPlacementOptions,
): FixedPopoverPlacement {
  const {
    anchor,
    viewportWidth,
    viewportHeight,
    desiredWidth,
    estimatedHeight,
    gap = POPOVER_EDGE_MARGIN,
    margin = gap,
    boundary,
    preferredAlign = 'left',
  } = options;

  const boundaryLeft = Math.max(0, boundary?.left ?? 0);
  const effectiveRight = Math.min(viewportWidth, boundary?.right ?? viewportWidth);
  const maxAvailableWidth = Math.max(0, effectiveRight - margin * 2);
  const width = maxAvailableWidth > 0 ? Math.min(desiredWidth, maxAvailableWidth) : desiredWidth;
  const maxLeft = Math.max(margin, effectiveRight - width - margin);
  const preferredMinLeft = boundaryLeft + margin;
  const minLeft = preferredMinLeft <= maxLeft ? preferredMinLeft : margin;

  const desiredLeft = preferredAlign === 'right' ? anchor.right - width : anchor.left;
  const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

  const boundaryTop = Math.max(0, boundary?.top ?? 0);
  const boundaryBottom = Math.min(viewportHeight, boundary?.bottom ?? viewportHeight);
  const above = Math.max(0, anchor.top - boundaryTop - gap - margin);
  const below = Math.max(0, boundaryBottom - anchor.bottom - gap - margin);
  const direction: FixedPopoverPlacement['direction'] = above >= estimatedHeight || above > below
    ? 'up'
    : 'down';

  return {
    left,
    width,
    direction,
    ...(direction === 'up'
      ? { bottom: viewportHeight - anchor.top + gap }
      : { top: anchor.bottom + gap }),
    maxHeight: direction === 'up' ? above : below,
  };
}

/**
 * Resolves the nearest `[data-popover-boundary="true"]` ancestor bounds
 * clamped to the viewport, falling back to the full viewport when absent.
 */
export function resolvePopoverBoundaryBounds(root: HTMLElement): PopoverBoundaryBounds {
  const boundaryEl = root.closest<HTMLElement>(POPOVER_BOUNDARY_SELECTOR);
  if (!boundaryEl) {
    return {
      top: 0,
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
      element: null,
    };
  }
  const rect = boundaryEl.getBoundingClientRect();
  return {
    top: Math.max(0, rect.top),
    bottom: Math.min(window.innerHeight, rect.bottom),
    left: Math.max(0, rect.left),
    right: Math.min(window.innerWidth, rect.right),
    element: boundaryEl,
  };
}

/** Pure placement decision, split out from the DOM walk for tests. */
export function choosePopoverPlacement(
  anchor: PopoverEdgeRect,
  vertical: { top: number; bottom: number },
  horizontal: { left: number; right: number },
  options: PopoverPlacementOptions,
): PopoverPlacement {
  const spaceAbove = anchor.top - vertical.top;
  const direction: PopoverPlacement['direction'] = spaceAbove >= options.estimatedHeight
    ? 'up'
    : (vertical.bottom - anchor.bottom > spaceAbove ? 'down' : 'up');
  // Width available when the popover is right-aligned to the anchor (grows
  // leftward) vs left-aligned (grows rightward).
  const spaceLeftward = anchor.right - horizontal.left;
  const spaceRightward = horizontal.right - anchor.left;
  let alignSide: PopoverPlacement['alignSide'] = options.preferredAlign;
  if (alignSide === 'right') {
    if (spaceLeftward < options.desiredWidth && spaceRightward > spaceLeftward) alignSide = 'left';
  } else if (spaceRightward < options.desiredWidth && spaceLeftward > spaceRightward) {
    alignSide = 'right';
  }
  const availableWidth = (alignSide === 'right' ? spaceLeftward : spaceRightward) - POPOVER_EDGE_MARGIN;
  return {
    direction,
    alignSide,
    maxWidth: availableWidth < options.desiredWidth ? Math.max(0, availableWidth) : null,
  };
}

/**
 * The edges of the nearest ancestors that clip `root` vertically and
 * horizontally, falling back to the viewport.
 */
export function resolvePopoverClipBounds(root: HTMLElement): {
  vertical: { top: number; bottom: number };
  horizontal: { left: number; right: number };
} {
  let vertical = { top: 0, bottom: window.innerHeight };
  let horizontal = { left: 0, right: window.innerWidth };
  let verticalFound = false;
  let horizontalFound = false;
  for (let node = root.parentElement; node && (!verticalFound || !horizontalFound); node = node.parentElement) {
    const { overflowX, overflowY } = window.getComputedStyle(node);
    const clipsY = CLIPPING_OVERFLOW_VALUES.has(overflowY);
    const clipsX = CLIPPING_OVERFLOW_VALUES.has(overflowX);
    if (!clipsY && !clipsX) continue;
    const rect = node.getBoundingClientRect();
    if (clipsY && !verticalFound) {
      verticalFound = true;
      vertical = { top: rect.top, bottom: rect.bottom };
    }
    if (clipsX && !horizontalFound) {
      horizontalFound = true;
      horizontal = { left: rect.left, right: rect.right };
    }
  }
  return { vertical, horizontal };
}

/**
 * Anchored popovers are clipped by the nearest overflow ancestor (message
 * list, panel body): flip below the anchor when the space above cannot fit
 * the popover, flip the anchored side when the preferred side would be cut
 * off horizontally, and cap the width when neither side can fully fit it.
 */
export function resolvePopoverPlacement(
  root: HTMLElement,
  options: PopoverPlacementOptions,
): PopoverPlacement {
  const { vertical, horizontal } = resolvePopoverClipBounds(root);
  return choosePopoverPlacement(root.getBoundingClientRect(), vertical, horizontal, options);
}
