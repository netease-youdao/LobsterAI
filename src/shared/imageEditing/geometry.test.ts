import { describe, expect, test } from 'vitest';

import { imageGenerationSize, imagePoint, imageRectangle, validImageSize } from './geometry';

describe('image editing geometry', () => {
  test('the same image location survives zoom, scrolling, and reversed region drags', () => {
    const small = imagePoint(150, 220, { left: 50, top: 20, width: 400, height: 400 });
    const zoomed = imagePoint(50, 300, { left: -150, top: -100, width: 800, height: 800 });
    expect(zoomed).toEqual(small);
    expect(imageRectangle({ x: 0.8, y: 0.9 }, small)).toEqual({ x: 0.25, y: 0.5, width: 0.55, height: 0.4 });
    expect(imagePoint(-5, 999, { left: 0, top: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 1 });
  });
  test('exact resize rejects fractional, unsafe and empty dimensions', () => {
    expect(validImageSize(1024, 768)).toBe(true);
    for (const size of [[0, 512], [1, 100], [5000, 5000], [NaN, 200], [20.5, 20], [Infinity, 2], [16385, 2]]) {
      expect(validImageSize(size[0], size[1])).toBe(false);
    }
  });
  test.each(['1:1', '3:4', '4:3', '9:16', '16:9'])('AI preset %s has the requested ratio and fits provider pixel limits', ratio => {
    const [width, height] = imageGenerationSize(640, 480, ratio).split('x').map(Number);
    const [a, b] = ratio.split(':').map(Number);
    expect(width / height).toBeCloseTo(a / b, 8);
    expect(width * height).toBeGreaterThanOrEqual(3_686_400);
    expect(width * height).toBeLessThanOrEqual(4_194_304);
  });
});
