/** One model row: py-2 around a 20px line. */
export const MEDIA_MODEL_ROW_HEIGHT = 36;
/** The list's py-1. */
const MEDIA_MODEL_LIST_PADDING_Y = 8;
/** The list's max-h-80; longer lists scroll. */
export const MEDIA_MODEL_LIST_MAX_HEIGHT = 320;
/** Rows held open while the first model list loads. */
export const MEDIA_MODEL_LOADING_ROWS = 4;

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
