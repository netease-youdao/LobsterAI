import { describe, expect, test } from 'vitest';

import { calculateRasterThumbnailDrawRect } from './rasterThumbnailLayout';

describe('raster thumbnail layout', () => {
  test('centers a wide image without cropping it', () => {
    expect(calculateRasterThumbnailDrawRect(800, 200, 480, 270)).toEqual({
      x: 0,
      y: 75,
      width: 480,
      height: 120,
    });
  });

  test('centers a tall image without stretching it', () => {
    expect(calculateRasterThumbnailDrawRect(200, 800, 480, 270)).toEqual({
      x: 206.25,
      y: 0,
      width: 67.5,
      height: 270,
    });
  });

  test('rejects an image without decoded dimensions', () => {
    expect(() => calculateRasterThumbnailDrawRect(0, 100, 480, 270)).toThrow(
      'Raster thumbnail dimensions must be positive',
    );
  });
});
