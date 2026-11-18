// Where a chip's detail card opens. The card is fixed to the viewport (it is
// portaled out of the message, which may clip), so it is placed against the
// window: below the chip when it fits, otherwise on the roomier side, and
// shifted horizontally to stay on screen.

export interface ContextChipDetailAnchor {
  top: number;
  bottom: number;
  left: number;
}

export interface ContextChipDetailSize {
  width: number;
  height: number;
}

export const ContextChipDetailSide = {
  Below: 'below',
  Above: 'above',
} as const;
export type ContextChipDetailSide = typeof ContextChipDetailSide[keyof typeof ContextChipDetailSide];

export interface ContextChipDetailPlacement {
  top: number;
  left: number;
  side: ContextChipDetailSide;
}

const ANCHOR_GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;

export function placeContextChipDetail(
  anchor: ContextChipDetailAnchor,
  size: ContextChipDetailSize,
  viewport: ContextChipDetailSize,
): ContextChipDetailPlacement {
  const spaceBelow = viewport.height - anchor.bottom - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
  const spaceAbove = anchor.top - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
  const side = size.height <= spaceBelow || spaceBelow >= spaceAbove
    ? ContextChipDetailSide.Below
    : ContextChipDetailSide.Above;
  const top = side === ContextChipDetailSide.Below
    ? anchor.bottom + ANCHOR_GAP_PX
    : anchor.top - ANCHOR_GAP_PX - size.height;
  const maxLeft = viewport.width - VIEWPORT_MARGIN_PX - size.width;
  return {
    top: Math.max(VIEWPORT_MARGIN_PX, Math.round(top)),
    left: Math.round(Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor.left, maxLeft))),
    side,
  };
}
