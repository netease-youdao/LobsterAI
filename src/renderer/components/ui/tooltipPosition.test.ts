import { describe, expect, test } from 'vitest';

import {
  computePortalTooltipPosition,
  PORTAL_TOOLTIP_GAP_PX,
  PORTAL_TOOLTIP_VIEWPORT_PADDING_PX,
  TooltipAlign,
  TooltipPosition,
} from './tooltipPosition';

const VIEWPORT = { width: 1200, height: 800 };

describe('computePortalTooltipPosition', () => {
  test('centers bubble below anchor by default when room is available', () => {
    const result = computePortalTooltipPosition({
      anchorRect: { left: 400, top: 48, right: 428, bottom: 76, width: 28, height: 28 },
      bubbleSize: { width: 80, height: 24 },
      viewport: VIEWPORT,
    });

    expect(result).toEqual({
      left: 374,
      top: 76 + PORTAL_TOOLTIP_GAP_PX,
      placement: TooltipPosition.Bottom,
    });
  });

  test('supports Start and End horizontal alignment', () => {
    const anchorRect = { left: 500, top: 10, right: 528, bottom: 38, width: 28, height: 28 };
    const bubbleSize = { width: 96, height: 24 };

    expect(computePortalTooltipPosition({
      anchorRect,
      bubbleSize,
      viewport: VIEWPORT,
      align: TooltipAlign.Start,
    }).left).toBe(500);

    expect(computePortalTooltipPosition({
      anchorRect,
      bubbleSize,
      viewport: VIEWPORT,
      align: TooltipAlign.End,
    }).left).toBe(528 - 96);
  });

  test('clamps right-edge toolbar buttons inside the viewport', () => {
    const result = computePortalTooltipPosition({
      anchorRect: { left: 1164, top: 10, right: 1192, bottom: 38, width: 28, height: 28 },
      bubbleSize: { width: 120, height: 24 },
      viewport: VIEWPORT,
      align: TooltipAlign.Center,
    });

    expect(result.left).toBe(VIEWPORT.width - 120 - PORTAL_TOOLTIP_VIEWPORT_PADDING_PX);
    expect(result.top).toBe(38 + PORTAL_TOOLTIP_GAP_PX);
    expect(result.placement).toBe(TooltipPosition.Bottom);
  });

  test('clamps left-edge buttons inside the viewport', () => {
    const result = computePortalTooltipPosition({
      anchorRect: { left: 6, top: 50, right: 34, bottom: 78, width: 28, height: 28 },
      bubbleSize: { width: 100, height: 24 },
      viewport: VIEWPORT,
      align: TooltipAlign.Center,
    });

    expect(result.left).toBe(PORTAL_TOOLTIP_VIEWPORT_PADDING_PX);
  });

  test('flips from Bottom to Top when near the bottom viewport edge', () => {
    const result = computePortalTooltipPosition({
      anchorRect: { left: 500, top: 764, right: 528, bottom: 792, width: 28, height: 28 },
      bubbleSize: { width: 80, height: 24 },
      viewport: VIEWPORT,
      position: TooltipPosition.Bottom,
    });

    expect(result.placement).toBe(TooltipPosition.Top);
    expect(result.top).toBe(764 - PORTAL_TOOLTIP_GAP_PX - 24);
  });

  test('flips from Top to Bottom when near the top viewport edge', () => {
    const result = computePortalTooltipPosition({
      anchorRect: { left: 500, top: 10, right: 528, bottom: 38, width: 28, height: 28 },
      bubbleSize: { width: 80, height: 24 },
      viewport: VIEWPORT,
      position: TooltipPosition.Top,
    });

    expect(result.placement).toBe(TooltipPosition.Bottom);
    expect(result.top).toBe(38 + PORTAL_TOOLTIP_GAP_PX);
  });

  test('clamps safely when bubble is wider than the viewport', () => {
    const result = computePortalTooltipPosition({
      anchorRect: { left: 10, top: 50, right: 38, bottom: 78, width: 28, height: 28 },
      bubbleSize: { width: 400, height: 24 },
      viewport: { width: 200, height: 400 },
    });

    expect(result.left).toBe(PORTAL_TOOLTIP_VIEWPORT_PADDING_PX);
  });
});
