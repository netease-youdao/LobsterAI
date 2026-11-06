import { describe, expect, test } from 'vitest';

import { blendErasePatch, eraseCropRect, type ImageEditRect, imageMaskBounds } from './imageEditingErase';

function bitmap(width: number, height: number, value: number, rect?: ImageEditRect, rectValue = 255): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const x = p % width;
    const y = Math.floor(p / width);
    const inside = rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    pixels.fill(inside ? rectValue : value, p * 4, p * 4 + 3);
    pixels[p * 4 + 3] = 255;
  }
  return pixels;
}

describe('erase mask bounds', () => {
  test('finds the marked rectangle and ignores faint antialiasing noise', () => {
    const mask = bitmap(40, 30, 0, { x: 12, y: 5, width: 7, height: 9 });
    mask.fill(20, 0, 3);
    expect(imageMaskBounds(mask, 40)).toEqual({ x: 12, y: 5, width: 7, height: 9 });
  });
  test('reports an unmarked mask and rejects mismatched dimensions', () => {
    expect(imageMaskBounds(bitmap(8, 8, 0), 8)).toBeUndefined();
    expect(() => imageMaskBounds(new Uint8Array(12), 2)).toThrow();
  });
});

describe('erase close-up', () => {
  const image = { width: 2496, height: 1664 };
  test('enlarges a small mark to a centered close-up', () => {
    const crop = eraseCropRect({ x: 1000, y: 800, width: 95, height: 75 }, image);
    expect(crop).toEqual({ x: 792, y: 582, width: 512, height: 512 });
  });
  test('keeps a mark near the corner inside the image', () => {
    const bounds = { x: 2252, y: 1403, width: 95, height: 75 };
    const crop = eraseCropRect(bounds, image);
    expect(crop).toEqual({ x: 1984, y: 1152, width: 512, height: 512 });
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(crop.x + crop.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(crop.y + crop.height);
  });
  test('limits the aspect ratio of long strokes and falls back to the full image for large marks', () => {
    const stroke = eraseCropRect({ x: 600, y: 700, width: 600, height: 20 }, image);
    expect(stroke.width / stroke.height).toBeLessThanOrEqual(2);
    expect(eraseCropRect({ x: 400, y: 300, width: 600, height: 500 }, image)).toEqual({ x: 0, y: 0, ...image });
    expect(eraseCropRect({ x: 10, y: 10, width: 20, height: 20 }, { width: 640, height: 480 })).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });
});

describe('erase blending', () => {
  const width = 120;
  const height = 80;
  const crop = { x: 20, y: 10, width: 80, height: 60 };
  const mark = { x: 50, y: 30, width: 20, height: 20 };
  const source = bitmap(width, height, 100);
  const mask = bitmap(width, height, 0, mark);
  // The model's fill covers the mark and its 6 px feather (in crop coordinates); elsewhere it matches the source.
  const filled = { x: mark.x - crop.x - 6, y: mark.y - crop.y - 6, width: mark.width + 12, height: mark.height + 12 };
  const patch = bitmap(crop.width, crop.height, 100, filled, 200);
  const at = (pixels: Uint8Array, x: number, y: number) => pixels[(y * width + x) * 4];

  test('replaces the marked area, feathers its edge and leaves everything else untouched', () => {
    const output = blendErasePatch(source, mask, patch, width, crop);
    expect(at(output, 50, 30)).toBe(200);
    expect(at(output, 60, 40)).toBe(200);
    // Just outside the mark the patch fades in; beyond the feather the source is unchanged.
    expect(at(output, 49, 40)).toBeGreaterThan(at(output, 46, 40));
    expect(at(output, 46, 40)).toBeGreaterThan(100);
    expect(at(output, 46, 40)).toBeLessThan(200);
    expect(at(output, 30, 40)).toBe(100);
    expect(at(output, 5, 5)).toBe(100);
    expect(output[(40 * width + 60) * 4 + 3]).toBe(255);
    expect(at(source, 60, 40)).toBe(100);
  });
  test('removes the color drift the model introduced in the area it should preserve', () => {
    const drifted = bitmap(crop.width, crop.height, 130, filled, 230);
    const output = blendErasePatch(source, mask, drifted, width, crop);
    expect(at(output, 60, 40)).toBe(200);
    expect(at(output, 30, 40)).toBe(100);
    expect(output[(40 * width + 60) * 4 + 3]).toBe(255);
  });
  test('rejects a patch or mask that does not match the crop', () => {
    expect(() => blendErasePatch(source, mask, bitmap(10, 10, 0), width, crop)).toThrow();
    expect(() => blendErasePatch(source, bitmap(10, 10, 0), patch, width, crop)).toThrow();
    expect(() => blendErasePatch(source, mask, patch, width, { ...crop, x: 60 })).toThrow();
  });
});
