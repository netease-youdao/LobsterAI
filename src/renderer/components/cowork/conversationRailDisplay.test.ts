import { describe, expect, test } from 'vitest';

import {
  buildVisualRailTicks,
  computeCappedPlaceholderRailCount,
  type ConversationRailItem,
  filterRailOutlineItems,
  getRailOutlinePopoverGeometry,
  getVisualRailLineWidth,
  RAIL_LINE_ACTIVE_WIDTH,
  RAIL_LINE_DEFAULT_WIDTH,
  RAIL_LINE_HOVER_STEPS,
  RAIL_MAX_PLACEHOLDER_ITEMS,
  RAIL_MAX_VISUAL_TICKS,
  RAIL_OUTLINE_VIEWPORT_PADDING_PX,
} from './conversationRailDisplay';

const makeRailItem = (index: number, overrides: Partial<ConversationRailItem> = {}): ConversationRailItem => ({
  key: `turn-${index}`,
  messageId: `msg-${index}`,
  turnIndex: index,
  absoluteIndex: index * 2,
  label: `User prompt ${index + 1}`,
  summary: `Assistant reply summary ${index + 1}`,
  timestamp: 1_700_000_000_000 + index * 60_000,
  contentLen: 40,
  isUser: false,
  isLoaded: true,
  ...overrides,
});

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

describe('filterRailOutlineItems', () => {
  const items = [
    makeRailItem(0, { label: 'Setup Electron build', summary: 'Configured Vite and preload' }),
    makeRailItem(1, { label: 'Fix SQLite migration', summary: 'Added index on sequence' }),
    makeRailItem(11, { label: 'Polish right rail', summary: 'Added scrollable turn outline' }),
  ];

  test('returns all items when query is blank', () => {
    expect(filterRailOutlineItems(items, '   ').map(entry => entry.railIndex)).toEqual([0, 1, 2]);
  });

  test('matches title, summary, and 1-based turn number case-insensitively', () => {
    expect(filterRailOutlineItems(items, 'sqlite').map(entry => entry.railIndex)).toEqual([1]);
    expect(filterRailOutlineItems(items, 'OUTLINE').map(entry => entry.railIndex)).toEqual([2]);
    expect(filterRailOutlineItems(items, '#2').map(entry => entry.railIndex)).toEqual([1]);
    expect(filterRailOutlineItems(items, '3').map(entry => entry.railIndex)).toEqual([2]);
    expect(filterRailOutlineItems(items, 'nonexistent')).toEqual([]);
  });
});

describe('getRailOutlinePopoverGeometry', () => {
  test('positions the popover to the left of the rail and clamps within small viewports', () => {
    const geometry = getRailOutlinePopoverGeometry(
      { top: 40, bottom: 120, left: 980 },
      { width: 1024, height: 600 },
    );

    expect(geometry.right).toBeGreaterThan(RAIL_OUTLINE_VIEWPORT_PADDING_PX);
    expect(geometry.width).toBeLessThanOrEqual(1024 - geometry.right - RAIL_OUTLINE_VIEWPORT_PADDING_PX);
    expect(geometry.top - geometry.maxHeight / 2).toBeGreaterThanOrEqual(RAIL_OUTLINE_VIEWPORT_PADDING_PX);
    expect(geometry.top + geometry.maxHeight / 2).toBeLessThanOrEqual(600 - RAIL_OUTLINE_VIEWPORT_PADDING_PX);
  });
});
