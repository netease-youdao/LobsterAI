export const TooltipPosition = {
  Top: 'top',
  Bottom: 'bottom',
} as const;
export type TooltipPosition = typeof TooltipPosition[keyof typeof TooltipPosition];

export const TooltipAlign = {
  Start: 'start',
  Center: 'center',
  End: 'end',
} as const;
export type TooltipAlign = typeof TooltipAlign[keyof typeof TooltipAlign];

export interface TooltipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface PortalTooltipPosition {
  left: number;
  top: number;
  placement: TooltipPosition;
}

export const PORTAL_TOOLTIP_GAP_PX = 8;
export const PORTAL_TOOLTIP_VIEWPORT_PADDING_PX = 8;

export function computePortalTooltipPosition({
  anchorRect,
  bubbleSize,
  viewport,
  position = TooltipPosition.Bottom,
  align = TooltipAlign.Center,
  gap = PORTAL_TOOLTIP_GAP_PX,
  viewportPadding = PORTAL_TOOLTIP_VIEWPORT_PADDING_PX,
}: {
  anchorRect: TooltipRect;
  bubbleSize: TooltipSize;
  viewport: TooltipSize;
  position?: TooltipPosition;
  align?: TooltipAlign;
  gap?: number;
  viewportPadding?: number;
}): PortalTooltipPosition {
  const bottomTop = anchorRect.bottom + gap;
  const topTop = anchorRect.top - gap - bubbleSize.height;

  const fitsBottom = bottomTop + bubbleSize.height <= viewport.height - viewportPadding;
  const fitsTop = topTop >= viewportPadding;

  let placement: TooltipPosition = position;
  let rawTop = position === TooltipPosition.Top ? topTop : bottomTop;

  if (position === TooltipPosition.Bottom && !fitsBottom && fitsTop) {
    placement = TooltipPosition.Top;
    rawTop = topTop;
  } else if (position === TooltipPosition.Top && !fitsTop && fitsBottom) {
    placement = TooltipPosition.Bottom;
    rawTop = bottomTop;
  }

  const maxTop = Math.max(viewportPadding, viewport.height - bubbleSize.height - viewportPadding);
  const top = Math.max(viewportPadding, Math.min(maxTop, rawTop));

  const rawLeft = align === TooltipAlign.Start
    ? anchorRect.left
    : align === TooltipAlign.End
      ? anchorRect.right - bubbleSize.width
      : anchorRect.left + (anchorRect.width - bubbleSize.width) / 2;

  const maxLeft = Math.max(viewportPadding, viewport.width - bubbleSize.width - viewportPadding);
  const left = Math.max(viewportPadding, Math.min(maxLeft, rawLeft));

  return { left, top, placement };
}
