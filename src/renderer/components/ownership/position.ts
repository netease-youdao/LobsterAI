const MARGIN = 8;
const GAP = 10;
export const OWNERSHIP_HOVER_DELAY = 200;
export const OWNERSHIP_CLOSE_DELAY = 120;

export function ownershipCardPosition(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  viewport: { width: number; height: number },
  card = { width: 300, height: 260 },
): { left: number; top: number; width: number } {
  const width = Math.min(card.width, Math.max(0, viewport.width - 2 * MARGIN));
  const maxLeft = viewport.width - width - MARGIN;
  const maxTop = Math.max(MARGIN, viewport.height - card.height - MARGIN);
  let left = anchor.right + GAP;
  let top = anchor.top;
  if (left > maxLeft) {
    left = anchor.left - GAP - width;
    if (left < MARGIN) {
      left = anchor.left;
      top = anchor.bottom + GAP;
      if (top > maxTop) top = anchor.top - GAP - card.height;
    }
  }
  return {
    left: Math.max(MARGIN, Math.min(left, maxLeft)),
    top: Math.max(MARGIN, Math.min(top, maxTop)),
    width,
  };
}
