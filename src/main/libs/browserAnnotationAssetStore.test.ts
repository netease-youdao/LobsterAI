import { describe, expect, test } from 'vitest';

import { calculateBrowserAnnotationCrop } from './browserAnnotationAssetStore';

describe('calculateBrowserAnnotationCrop', () => {
  test('uses captured bitmap scale rather than devicePixelRatio', () => {
    expect(calculateBrowserAnnotationCrop(
      { width: 2400, height: 1600 },
      { width: 1200, height: 800 },
      { x: 100, y: 50, width: 200, height: 100 },
    )).toEqual({ x: 136, y: 36, width: 528, height: 328, padding: 32 });
  });

  test('clamps crop to image bounds', () => {
    expect(calculateBrowserAnnotationCrop(
      { width: 1000, height: 500 },
      { width: 1000, height: 500 },
      { x: -10, y: -20, width: 50, height: 40 },
      true,
    )).toEqual({ x: 0, y: 0, width: 56, height: 36, padding: 16 });
  });
});
