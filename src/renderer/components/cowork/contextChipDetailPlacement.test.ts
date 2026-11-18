import { describe, expect, test } from 'vitest';

import { ContextChipDetailSide, placeContextChipDetail } from './contextChipDetailPlacement';

const viewport = { width: 1200, height: 800 };
const card = { width: 320, height: 200 };

describe('placeContextChipDetail', () => {
  test('opens below the chip, aligned to its left edge', () => {
    expect(placeContextChipDetail({ top: 100, bottom: 124, left: 400 }, card, viewport)).toEqual({
      top: 130,
      left: 400,
      side: ContextChipDetailSide.Below,
    });
  });

  test('opens above the chip when it does not fit below', () => {
    expect(placeContextChipDetail({ top: 700, bottom: 724, left: 400 }, card, viewport)).toEqual({
      top: 494,
      left: 400,
      side: ContextChipDetailSide.Above,
    });
  });

  test('stays below when neither side fits but below has more room', () => {
    const placement = placeContextChipDetail(
      { top: 120, bottom: 144, left: 400 },
      { width: 320, height: 700 },
      viewport,
    );
    expect(placement.side).toBe(ContextChipDetailSide.Below);
    expect(placement.top).toBe(150);
  });

  test('shifts left to keep a chip near the right edge on screen', () => {
    expect(placeContextChipDetail({ top: 100, bottom: 124, left: 1100 }, card, viewport).left).toBe(872);
  });

  test('never starts past the viewport margin', () => {
    expect(placeContextChipDetail({ top: 100, bottom: 124, left: 2 }, card, viewport).left).toBe(8);
    expect(placeContextChipDetail(
      { top: 100, bottom: 124, left: 400 },
      { width: 320, height: 200 },
      { width: 1200, height: 140 },
    ).top).toBe(8);
  });
});
