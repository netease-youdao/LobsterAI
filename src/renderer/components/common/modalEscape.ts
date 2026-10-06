/**
 * Escape-key bookkeeping shared by every `Modal` layer.
 *
 * Modals portal into `document.body`, so nesting is invisible in the DOM and a
 * plain `document` keydown listener would let an inner dialog and the panel
 * behind it both react to one Escape press. Each rendered modal registers a
 * layer id here; only the newest layer is allowed to act.
 *
 * Ids come from a monotonic counter taken during the first render, so a parent
 * modal always ranks below a modal opened inside it — mount effects fire
 * child-first and cannot be used for this ordering.
 */

let nextLayerId = 1;
const activeLayerIds = new Set<number>();

/** Allocate an id for a modal layer. Later calls always rank above earlier ones. */
export const createModalEscapeLayerId = (): number => {
  const id = nextLayerId;
  nextLayerId += 1;
  return id;
};

export const registerModalEscapeLayer = (layerId: number): void => {
  activeLayerIds.add(layerId);
};

export const unregisterModalEscapeLayer = (layerId: number): void => {
  activeLayerIds.delete(layerId);
};

/** True when `layerId` is registered and no newer modal layer is open above it. */
export const isTopModalEscapeLayer = (layerId: number): boolean => {
  if (!activeLayerIds.has(layerId)) return false;
  for (const activeId of activeLayerIds) {
    if (activeId > layerId) return false;
  }
  return true;
};

export interface EscapeKeyEventLike {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
}

/**
 * Escape presses an overlay may dismiss itself on: not an IME composition
 * cancel, and not already handled by an inner control.
 */
export const isDismissEscapeEvent = (event: EscapeKeyEventLike): boolean => {
  if (event.key !== 'Escape') return false;
  if (event.defaultPrevented) return false;
  // Let the IME consume Escape while composing; it cancels the composition.
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
};
