import { describe, expect, test, vi } from 'vitest';

import {
  isLikelyBlankThumbnailBitmap,
  shouldRejectNativeLibraryThumbnail,
} from './libraryThumbnailValidation';

const createBitmap = (
  pixelCount: number,
  colorAt: (index: number) => [number, number, number, number],
): Uint8Array => {
  const bitmap = new Uint8Array(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    const [blue, green, red, alpha] = colorAt(index);
    bitmap.set([blue, green, red, alpha], index * 4);
  }
  return bitmap;
};

describe('library thumbnail visual validation', () => {
  test('identifies an all-white bitmap as blank', () => {
    const bitmap = createBitmap(1_000, () => [255, 255, 255, 255]);

    expect(isLikelyBlankThumbnailBitmap(bitmap)).toBe(true);
  });

  test('identifies a white slide with a light gray border as blank', () => {
    const bitmap = createBitmap(1_000, index => (
      index < 100 ? [245, 245, 245, 255] : [255, 255, 255, 255]
    ));

    expect(isLikelyBlankThumbnailBitmap(bitmap)).toBe(true);
  });

  test('keeps a light slide containing visible dark content', () => {
    const bitmap = createBitmap(1_000, index => (
      index < 20 ? [40, 40, 40, 255] : [255, 255, 255, 255]
    ));

    expect(isLikelyBlankThumbnailBitmap(bitmap)).toBe(false);
  });

  test('identifies a transparent bitmap as blank', () => {
    const bitmap = createBitmap(100, () => [0, 0, 0, 0]);

    expect(isLikelyBlankThumbnailBitmap(bitmap)).toBe(true);
  });
});

describe('native library thumbnail validation', () => {
  test.each(['darwin', 'win32', 'linux'] as const)('rejects uniform native HTML output on %s', platform => {
    for (const extension of ['.html', '.htm', '.HTML', '.HTM']) {
      for (const color of [[255, 255, 255, 255], [10, 9, 6, 255], [0, 0, 0, 0]] as const) {
        expect(shouldRejectNativeLibraryThumbnail({
          extension,
          platform,
          rendererConfirmedIntentionalBlank: false,
          getBitmap: () => createBitmap(100, () => [...color]),
        })).toBe(true);
      }
    }
  });

  test('does not treat PPTX blank-source metadata as proof for a native HTML fallback', () => {
    expect(shouldRejectNativeLibraryThumbnail({
      extension: '.html',
      platform: 'darwin',
      rendererConfirmedIntentionalBlank: true,
      getBitmap: () => createBitmap(100, () => [255, 255, 255, 255]),
    })).toBe(true);
  });

  test('accepts native HTML thumbnails containing visible content', () => {
    expect(shouldRejectNativeLibraryThumbnail({
      extension: '.htm',
      platform: 'darwin',
      rendererConfirmedIntentionalBlank: false,
      getBitmap: () => createBitmap(1_000, index => (
        index < 30 ? [40, 40, 40, 255] : [255, 255, 255, 255]
      )),
    })).toBe(false);
  });

  test('preserves the existing Windows PPTX blank fallback guard', () => {
    const getBitmap = vi.fn(() => createBitmap(100, () => [255, 255, 255, 255]));
    expect(shouldRejectNativeLibraryThumbnail({
      extension: '.pptx',
      platform: 'win32',
      rendererConfirmedIntentionalBlank: false,
      getBitmap,
    })).toBe(true);
    expect(getBitmap).toHaveBeenCalledTimes(1);
  });

  test.each([
    { extension: '.pptx', platform: 'win32', rendererConfirmedIntentionalBlank: true },
    { extension: '.pptx', platform: 'darwin', rendererConfirmedIntentionalBlank: false },
    { extension: '.pptx', platform: 'linux', rendererConfirmedIntentionalBlank: false },
    { extension: '.docx', platform: 'win32', rendererConfirmedIntentionalBlank: false },
    { extension: '.png', platform: 'darwin', rendererConfirmedIntentionalBlank: false },
    { extension: '.pdf', platform: 'linux', rendererConfirmedIntentionalBlank: false },
  ] as const)('does not decode or reject other existing fallback cases: $extension on $platform', options => {
    const getBitmap = vi.fn(() => createBitmap(100, () => [255, 255, 255, 255]));
    expect(shouldRejectNativeLibraryThumbnail({ ...options, getBitmap })).toBe(false);
    expect(getBitmap).not.toHaveBeenCalled();
  });
});
