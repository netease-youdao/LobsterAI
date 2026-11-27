import { describe, expect, test } from 'vitest';

import {
  choosePopoverPlacement,
  type PopoverEdgeRect,
  resolveFixedPopoverPlacement,
} from './popoverPlacement';

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

describe('resolveFixedPopoverPlacement', () => {
  test('aligns to the anchor left edge when the popover fits inside the pane boundary', () => {
    const placement = resolveFixedPopoverPlacement({
      anchor: { top: 220, bottom: 248, left: 280, right: 360 },
      viewportWidth: 1200,
      viewportHeight: 800,
      desiredWidth: 260,
      estimatedHeight: 320,
      gap: 8,
      margin: 12,
      boundary: { top: 48, bottom: 800, left: 240, right: 720 },
    });

    expect(placement).toEqual({
      left: 280,
      width: 260,
      direction: 'down',
      top: 256,
      maxHeight: 532,
    });
  });

  test('clamps inside the chat pane right boundary so a right browser WebContentsView cannot clip it', () => {
    // Chat occupies 240..640; Agent Browser WebContentsView occupies 640..1200.
    // The usage chip sits near the right side of the chat pane (415..510).
    const placement = resolveFixedPopoverPlacement({
      anchor: { top: 200, bottom: 228, left: 415, right: 510 },
      viewportWidth: 1200,
      viewportHeight: 800,
      desiredWidth: 260,
      estimatedHeight: 320,
      gap: 8,
      margin: 12,
      boundary: { top: 48, bottom: 800, left: 240, right: 640 },
    });

    expect(placement.width).toBe(260);
    expect(placement.left).toBe(368);
    expect(placement.left + placement.width).toBeLessThanOrEqual(640 - 12);
    expect(placement.direction).toBe('down');
    expect(placement.top).toBe(236);
  });

  test('extends leftward over the HTML sidebar before shrinking when the chat pane is narrower than the popover', () => {
    const placement = resolveFixedPopoverPlacement({
      anchor: { top: 500, bottom: 528, left: 310, right: 390 },
      viewportWidth: 1200,
      viewportHeight: 800,
      desiredWidth: 260,
      estimatedHeight: 320,
      gap: 8,
      margin: 12,
      boundary: { top: 48, bottom: 800, left: 240, right: 460 },
    });

    expect(placement.width).toBe(260);
    expect(placement.left).toBe(188);
    expect(placement.left + placement.width).toBeLessThanOrEqual(460 - 12);
    expect(placement.direction).toBe('up');
    expect(placement.bottom).toBe(308);
    expect(placement.maxHeight).toBe(432);
  });

  test('shrinks width when total viewport space left of boundary.right is narrower than desiredWidth', () => {
    const placement = resolveFixedPopoverPlacement({
      anchor: { top: 500, bottom: 528, left: 120, right: 200 },
      viewportWidth: 900,
      viewportHeight: 800,
      desiredWidth: 260,
      estimatedHeight: 320,
      gap: 8,
      margin: 12,
      boundary: { top: 48, bottom: 800, left: 0, right: 240 },
    });

    expect(placement.width).toBe(216);
    expect(placement.left).toBe(12);
    expect(placement.left + placement.width).toBe(228);
  });
});
