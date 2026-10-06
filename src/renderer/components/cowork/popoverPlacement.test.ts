import { describe, expect, test } from 'vitest';

import { choosePopoverPlacement, type PopoverEdgeRect } from './popoverPlacement';

const VERTICAL = { top: 0, bottom: 800 };
const HORIZONTAL = { left: 250, right: 1300 };

const makeAnchor = (overrides: Partial<PopoverEdgeRect> = {}): PopoverEdgeRect => ({
  top: 600,
  bottom: 630,
  left: 430,
  right: 520,
  ...overrides,
});

describe('choosePopoverPlacement', () => {
  test('keeps the preferred side when the popover fits', () => {
    const placement = choosePopoverPlacement(
      makeAnchor({ left: 710, right: 800 }),
      VERTICAL,
      HORIZONTAL,
      { preferredAlign: 'right', estimatedHeight: 300, desiredWidth: 360 },
    );
    expect(placement).toEqual({ direction: 'up', alignSide: 'right', maxWidth: null });
  });

  test('flips a right-aligned popover to the left side when the pill sits near the container left edge', () => {
    // The reported bug: pill at the left of a wide message bubble, popover
    // grows leftward past the message list boundary and gets clipped.
    const placement = choosePopoverPlacement(
      makeAnchor({ left: 430, right: 520 }),
      VERTICAL,
      HORIZONTAL,
      { preferredAlign: 'right', estimatedHeight: 300, desiredWidth: 360 },
    );
    expect(placement.alignSide).toBe('left');
    expect(placement.maxWidth).toBeNull();
  });

  test('flips a left-aligned popover to the right side near the container right edge', () => {
    const placement = choosePopoverPlacement(
      makeAnchor({ left: 1200, right: 1290 }),
      VERTICAL,
      HORIZONTAL,
      { preferredAlign: 'left', estimatedHeight: 300, desiredWidth: 360 },
    );
    expect(placement.alignSide).toBe('right');
    expect(placement.maxWidth).toBeNull();
  });

  test('stays on the preferred side but caps the width when no side fully fits', () => {
    const placement = choosePopoverPlacement(
      makeAnchor({ left: 360, right: 450 }),
      VERTICAL,
      { left: 250, right: 510 },
      { preferredAlign: 'right', estimatedHeight: 300, desiredWidth: 360 },
    );
    // Leftward space (200) beats rightward space (150), so no flip; the width
    // is capped to the available space minus the edge margin.
    expect(placement.alignSide).toBe('right');
    expect(placement.maxWidth).toBe(192);
  });

  test('never returns a negative width cap', () => {
    const placement = choosePopoverPlacement(
      makeAnchor({ left: 250, right: 254 }),
      VERTICAL,
      { left: 250, right: 254 },
      { preferredAlign: 'right', estimatedHeight: 300, desiredWidth: 360 },
    );
    expect(placement.maxWidth).toBe(0);
  });

  test('drops below the anchor when the space above cannot fit the popover', () => {
    const placement = choosePopoverPlacement(
      makeAnchor({ top: 100, bottom: 130 }),
      VERTICAL,
      HORIZONTAL,
      { preferredAlign: 'left', estimatedHeight: 300, desiredWidth: 200 },
    );
    expect(placement.direction).toBe('down');
  });

  test('keeps dropping up when the space below is even smaller', () => {
    const placement = choosePopoverPlacement(
      makeAnchor({ top: 200, bottom: 700 }),
      VERTICAL,
      HORIZONTAL,
      { preferredAlign: 'left', estimatedHeight: 300, desiredWidth: 200 },
    );
    expect(placement.direction).toBe('up');
  });
});
