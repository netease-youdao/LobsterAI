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

const CLIPPING_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'hidden', 'clip']);
const POPOVER_EDGE_MARGIN = 8;

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
 * Anchored popovers are clipped by the nearest overflow ancestor (message
 * list, panel body): flip below the anchor when the space above cannot fit
 * the popover, flip the anchored side when the preferred side would be cut
 * off horizontally, and cap the width when neither side can fully fit it.
 */
export function resolvePopoverPlacement(
  root: HTMLElement,
  options: PopoverPlacementOptions,
): PopoverPlacement {
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
  return choosePopoverPlacement(root.getBoundingClientRect(), vertical, horizontal, options);
}
