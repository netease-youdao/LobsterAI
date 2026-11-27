import { describe, expect, test } from 'vitest';

import {
  buildVisualRailTicks,
  computeCappedPlaceholderRailCount,
  computeVisualRailMaxTicks,
  getRailTooltipGeometry,
  getVisualRailLineWidth,
  RAIL_LINE_ACTIVE_WIDTH,
  RAIL_LINE_DEFAULT_WIDTH,
  RAIL_LINE_HOVER_STEPS,
  RAIL_MAX_PLACEHOLDER_ITEMS,
  RAIL_MAX_VISUAL_TICKS,
  RAIL_MIN_VISUAL_TICKS,
  RAIL_TOOLTIP_MAX_WIDTH_PX,
  RAIL_TOOLTIP_VERTICAL_PADDING_PX,
  RAIL_TOOLTIP_VIEWPORT_PADDING_PX,
} from './conversationRailDisplay';

describe('computeCappedPlaceholderRailCount', () => {
  test('keeps local count when all messages fit in loaded turns', () => {
    expect(computeCappedPlaceholderRailCount(6, 6)).toBe(6);
    expect(computeCappedPlaceholderRailCount(4, 5)).toBe(5);
  });

  test('caps placeholder count for tool-heavy sessions before the rail index arrives', () => {
    expect(computeCappedPlaceholderRailCount(400, 4)).toBe(RAIL_MAX_PLACEHOLDER_ITEMS);
    expect(computeCappedPlaceholderRailCount(400, 28)).toBe(28);
    expect(computeCappedPlaceholderRailCount(16, 4)).toBe(8);
  });
});

describe('computeVisualRailMaxTicks', () => {
  test('returns RAIL_MAX_VISUAL_TICKS for normal desktop container heights and missing heights', () => {
    expect(computeVisualRailMaxTicks(700)).toBe(RAIL_MAX_VISUAL_TICKS);
    expect(computeVisualRailMaxTicks(400)).toBe(RAIL_MAX_VISUAL_TICKS);
    expect(computeVisualRailMaxTicks(null)).toBe(RAIL_MAX_VISUAL_TICKS);
    expect(computeVisualRailMaxTicks(0)).toBe(RAIL_MAX_VISUAL_TICKS);
  });

  test('shrinks tick cap gracefully for compact container heights without falling below RAIL_MIN_VISUAL_TICKS', () => {
    const compact = computeVisualRailMaxTicks(260);
    expect(compact).toBeGreaterThanOrEqual(RAIL_MIN_VISUAL_TICKS);
    expect(compact).toBeLessThan(RAIL_MAX_VISUAL_TICKS);
    expect(computeVisualRailMaxTicks(120)).toBe(RAIL_MIN_VISUAL_TICKS);
  });
});

describe('buildVisualRailTicks', () => {
  test('returns 1-to-1 ticks when turn count does not exceed the visual cap', () => {
    const ticks = buildVisualRailTicks(6, 2);
    expect(ticks).toHaveLength(6);
    expect(ticks.map(t => t.targetRailIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ticks.filter(t => t.isActive).map(t => t.slotIndex)).toEqual([2]);
  });

  test('compresses long conversations into contiguous buckets capped at RAIL_MAX_VISUAL_TICKS', () => {
    const total = 150;
    const activeIndex = 73;
    const ticks = buildVisualRailTicks(total, activeIndex);

    expect(ticks).toHaveLength(RAIL_MAX_VISUAL_TICKS);
    expect(ticks[0].startRailIndex).toBe(0);
    expect(ticks[0].targetRailIndex).toBe(0);
    expect(ticks[ticks.length - 1].endRailIndex).toBe(total - 1);
    expect(ticks[ticks.length - 1].targetRailIndex).toBe(total - 1);

    // Every turn in [0, total - 1] belongs to exactly one contiguous bucket.
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i].startRailIndex).toBe(ticks[i - 1].endRailIndex + 1);
      expect(ticks[i].endRailIndex).toBeGreaterThanOrEqual(ticks[i].startRailIndex);
    }

    const activeTicks = ticks.filter(t => t.isActive);
    expect(activeTicks).toHaveLength(1);
    expect(activeTicks[0].targetRailIndex).toBe(activeIndex);
    expect(activeIndex).toBeGreaterThanOrEqual(activeTicks[0].startRailIndex);
    expect(activeIndex).toBeLessThanOrEqual(activeTicks[0].endRailIndex);
  });

  test('anchors top and bottom endpoints cleanly when active is first or last turn', () => {
    const firstActive = buildVisualRailTicks(80, 0);
    expect(firstActive[0].isActive).toBe(true);
    expect(firstActive[0].targetRailIndex).toBe(0);

    const lastActive = buildVisualRailTicks(80, 79);
    expect(lastActive[lastActive.length - 1].isActive).toBe(true);
    expect(lastActive[lastActive.length - 1].targetRailIndex).toBe(79);
  });

  test('handles empty input gracefully', () => {
    expect(buildVisualRailTicks(0, 0)).toEqual([]);
  });
});

describe('getVisualRailLineWidth', () => {
  test('highlights active slot when idle and uses hover wave when hovered', () => {
    expect(getVisualRailLineWidth(3, 3, null)).toBe(RAIL_LINE_ACTIVE_WIDTH);
    expect(getVisualRailLineWidth(2, 3, null)).toBe(RAIL_LINE_DEFAULT_WIDTH);
    expect(getVisualRailLineWidth(5, 0, 5)).toBe(RAIL_LINE_HOVER_STEPS[0]);
    expect(getVisualRailLineWidth(4, 0, 5)).toBe(RAIL_LINE_HOVER_STEPS[1]);
    expect(getVisualRailLineWidth(0, 0, 5)).toBe(RAIL_LINE_DEFAULT_WIDTH);
  });
});

describe('getRailTooltipGeometry', () => {
  test('aligns the tooltip to the left of the hovered tick on spacious viewports', () => {
    const geometry = getRailTooltipGeometry(
      { top: 300, height: 13, left: 1180 },
      { width: 1220, height: 800 },
    );

    expect(geometry.width).toBe(RAIL_TOOLTIP_MAX_WIDTH_PX);
    expect(geometry.right).toBeGreaterThan(RAIL_TOOLTIP_VIEWPORT_PADDING_PX);
    expect(geometry.top).toBeCloseTo(306.5);
  });

  test('clamps top, bottom, and width inside small viewports', () => {
    const nearTop = getRailTooltipGeometry(
      { top: 10, height: 13, left: 320 },
      { width: 360, height: 500 },
    );
    expect(nearTop.top).toBe(RAIL_TOOLTIP_VERTICAL_PADDING_PX);
    expect(nearTop.width).toBeLessThanOrEqual(360 - nearTop.right - RAIL_TOOLTIP_VIEWPORT_PADDING_PX);

    const nearBottom = getRailTooltipGeometry(
      { top: 485, height: 13, left: 320 },
      { width: 360, height: 500 },
    );
    expect(nearBottom.top).toBe(500 - RAIL_TOOLTIP_VERTICAL_PADDING_PX);
  });
});
