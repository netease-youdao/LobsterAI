import { describe, expect, test } from 'vitest';

import { companionScreenshotCrop, companionScreenshotRect } from './screenshot';

describe('screenshot selection coordinates', () => {
  const display = { width: 1440, height: 900 };
  test('dragging up and left still produces a positive selection', () => {
    expect(companionScreenshotRect({ x: 400, y: 300 }, { x: 100, y: 50 }))
      .toEqual({ x: 100, y: 50, width: 300, height: 250 });
  });
  test.each([1, 1.25, 2])('crops at the actual resolution for scale %s', scale => {
    const image = { width: display.width * scale, height: display.height * scale };
    expect(companionScreenshotCrop({ x: 120, y: 40, width: 400, height: 200 }, display, image))
      .toEqual({ x: 120 * scale, y: 40 * scale, width: 400 * scale, height: 200 * scale });
  });
  test('clips to the display and rounds outward at fractional scales', () => {
    expect(companionScreenshotCrop({ x: -10, y: 11, width: 1500, height: 920 }, display, { width: 1800, height: 1125 }))
      .toEqual({ x: 0, y: 13, width: 1800, height: 1112 });
  });
  test.each([null, {}, { x: NaN, y: 0, width: 2, height: 3 }, { x: 0, y: 0, width: -2, height: 3 },
    { x: 0, y: 0, width: 1, height: 1 }, { x: 1500, y: 0, width: 20, height: 20 }])('rejects invalid or empty selections: %j', rect => {
    expect(companionScreenshotCrop(rect, display, display)).toBeNull();
  });
});
