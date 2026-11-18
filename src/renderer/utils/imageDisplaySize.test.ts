import { afterEach, describe, expect, test } from 'vitest';

import {
  clearImageSizeCache,
  fitImageSize,
  getCachedImageSize,
  readBase64ImageSize,
  rememberImageSize,
} from './imageDisplaySize';

const toBase64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');
const ascii = (text: string): number[] => Array.from(text, char => char.charCodeAt(0));
const uint32BE = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const uint16BE = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const uint16LE = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const uint24LE = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

const pngHeader = (width: number, height: number): number[] => [
  0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a,
  ...uint32BE(13), ...ascii('IHDR'), ...uint32BE(width), ...uint32BE(height),
  8, 6, 0, 0, 0,
];

const jpegSegment = (marker: number, payload: number[]): number[] => [0xff, marker, ...uint16BE(payload.length + 2), ...payload];

const exifOrientationPayload = (orientation: number): number[] => [
  ...ascii('Exif'), 0, 0,
  ...ascii('MM'), ...uint16BE(42), ...uint32BE(8),
  ...uint16BE(1),
  ...uint16BE(0x0112), ...uint16BE(3), ...uint32BE(1), ...uint16BE(orientation), 0, 0,
  ...uint32BE(0),
];

const jpeg = (width: number, height: number, segmentsBeforeFrame: number[][] = []): number[] => [
  0xff, 0xd8,
  ...segmentsBeforeFrame.flat(),
  ...jpegSegment(0xc0, [8, ...uint16BE(height), ...uint16BE(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  0xff, 0xda,
];

afterEach(() => {
  clearImageSizeCache();
});

describe('readBase64ImageSize', () => {
  test('reads PNG dimensions from the IHDR chunk', () => {
    expect(readBase64ImageSize(toBase64(pngHeader(1024, 1536)))).toEqual({ width: 1024, height: 1536 });
  });

  test('accepts a full data URL', () => {
    expect(readBase64ImageSize(`data:image/png;base64,${toBase64(pngHeader(64, 32))}`)).toEqual({ width: 64, height: 32 });
  });

  test('reads GIF logical screen dimensions', () => {
    expect(readBase64ImageSize(toBase64([...ascii('GIF89a'), ...uint16LE(320), ...uint16LE(200), 0, 0, 0])))
      .toEqual({ width: 320, height: 200 });
  });

  test('reads JPEG frame dimensions after other segments', () => {
    const app0 = jpegSegment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    expect(readBase64ImageSize(toBase64(jpeg(800, 600, [app0])))).toEqual({ width: 800, height: 600 });
  });

  test('swaps JPEG dimensions for quarter-turn EXIF orientations', () => {
    const rotated = jpegSegment(0xe1, exifOrientationPayload(6));
    expect(readBase64ImageSize(toBase64(jpeg(4032, 3024, [rotated])))).toEqual({ width: 3024, height: 4032 });
    const upright = jpegSegment(0xe1, exifOrientationPayload(1));
    expect(readBase64ImageSize(toBase64(jpeg(4032, 3024, [upright])))).toEqual({ width: 4032, height: 3024 });
  });

  test('finds a JPEG frame that sits beyond the first header probe', () => {
    const largeExif = jpegSegment(0xe1, [...exifOrientationPayload(1), ...new Array(20000).fill(0)]);
    expect(readBase64ImageSize(toBase64(jpeg(1200, 900, [largeExif])))).toEqual({ width: 1200, height: 900 });
  });

  test('reads extended, lossless and lossy WebP headers', () => {
    const riff = (chunk: string, body: number[]): number[] => [
      ...ascii('RIFF'), ...uint32BE(0), ...ascii('WEBP'), ...ascii(chunk), ...uint32BE(0), ...body,
    ];
    expect(readBase64ImageSize(toBase64(riff('VP8X', [0, 0, 0, 0, ...uint24LE(1919), ...uint24LE(1079), 0, 0]))))
      .toEqual({ width: 1920, height: 1080 });

    // VP8L packs (width - 1) and (height - 1) as 14-bit fields after the 0x2f signature.
    const losslessWidth = 300 - 1;
    const losslessHeight = 150 - 1;
    const packed = losslessWidth | (losslessHeight << 14);
    expect(readBase64ImageSize(toBase64(riff('VP8L', [0x2f, packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >> 24) & 0xff, 0]))))
      .toEqual({ width: 300, height: 150 });

    expect(readBase64ImageSize(toBase64(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...uint16LE(640), ...uint16LE(480)]))))
      .toEqual({ width: 640, height: 480 });
  });

  test('returns null for unknown or truncated data', () => {
    expect(readBase64ImageSize(undefined)).toBeNull();
    expect(readBase64ImageSize('')).toBeNull();
    expect(readBase64ImageSize(toBase64(ascii('not an image at all')))).toBeNull();
    expect(readBase64ImageSize(toBase64(pngHeader(10, 10).slice(0, 18)))).toBeNull();
    expect(readBase64ImageSize(toBase64([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
  });
});

describe('fitImageSize', () => {
  test('shrinks to the tighter limit while keeping the aspect ratio', () => {
    expect(fitImageSize({ width: 1024, height: 1536 }, 256, 192)).toEqual({ width: 128, height: 192 });
    expect(fitImageSize({ width: 1920, height: 1080 }, 256, 192)).toEqual({ width: 256, height: 144 });
  });

  test('never enlarges small images', () => {
    expect(fitImageSize({ width: 40, height: 20 }, 256, 192)).toEqual({ width: 40, height: 20 });
  });
});

describe('image size cache', () => {
  test('remembers measured sizes by src', () => {
    rememberImageSize('localfile://local/a.png?v=1', 800, 600);
    expect(getCachedImageSize('localfile://local/a.png?v=1')).toEqual({ width: 800, height: 600 });
    expect(getCachedImageSize('localfile://local/a.png?v=2')).toBeNull();
  });

  test('ignores data URLs and invalid sizes', () => {
    rememberImageSize('data:image/png;base64,AAAA', 10, 10);
    expect(getCachedImageSize('data:image/png;base64,AAAA')).toBeNull();
    rememberImageSize('https://example.com/a.png', 0, 10);
    expect(getCachedImageSize('https://example.com/a.png')).toBeNull();
  });
});
