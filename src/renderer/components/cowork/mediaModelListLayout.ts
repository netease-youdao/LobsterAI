/** One model row: py-2 around a 20px line. */
export const MEDIA_MODEL_ROW_HEIGHT = 36;
/** The list's py-1. */
const MEDIA_MODEL_LIST_PADDING_Y = 8;
/** The list's max-h-80; longer lists scroll. */
export const MEDIA_MODEL_LIST_MAX_HEIGHT = 320;
/** Rows held open while the first model list loads. */
export const MEDIA_MODEL_LOADING_ROWS = 4;
/** Rows the list keeps when a short space squeezes the panel. */
export const MEDIA_MODEL_MIN_VISIBLE_ROWS = 3;
/** Gap kept between the panel's top and the edge that clips it. */
export const MEDIA_PANEL_EDGE_MARGIN = 8;

/**
 * The image and video tabs share one list height, sized for the longer list,
 * so switching tabs never resizes a panel that grows upward from the toolbar
 * and never moves the tab bar out from under the pointer.
 */
export function resolveMediaModelListMinHeight(
  counts: { image: number; video: number },
  isLoading: boolean,
): number {
  const rows = Math.max(counts.image, counts.video, isLoading ? MEDIA_MODEL_LOADING_ROWS : 1);
  return Math.min(MEDIA_MODEL_LIST_MAX_HEIGHT, rows * MEDIA_MODEL_ROW_HEIGHT + MEDIA_MODEL_LIST_PADDING_Y);
}

/** How far a squeezed list may shrink: a few rows, or the whole list when it is shorter. */
export function resolveMediaModelListFloorHeight(listHeight: number): number {
  return Math.min(listHeight, MEDIA_MODEL_MIN_VISIBLE_ROWS * MEDIA_MODEL_ROW_HEIGHT + MEDIA_MODEL_LIST_PADDING_Y);
}

/**
 * The panel grows upward from a fixed bottom edge, so a long model list can
 * push its tab bar past the top of the nearest clipping ancestor (the home
 * page scroller under the header). Cap the panel to the room above; the
 * model list shrinks and scrolls instead.
 */
export function resolveMediaPanelMaxHeight(panelBottom: number, clipTop: number): number {
  return Math.max(0, Math.floor(panelBottom - clipTop - MEDIA_PANEL_EDGE_MARGIN));
}
