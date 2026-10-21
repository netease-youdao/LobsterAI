import { describe, expect, test } from 'vitest';

import { imageEditingHeader } from './imageEditingHeader';

describe('image editor admission before decoding', () => {
  test('reads JPEG frame dimensions after metadata and rejects truncated segments', () => {
    const bytes = Buffer.from([255, 216, 255, 224, 0, 4, 1, 2, 255, 194, 0, 8, 8, 1, 224, 2, 128, 0]);
    expect(imageEditingHeader(bytes)).toMatchObject({ width: 640, height: 480, mime: 'image/jpeg' });
    expect(() => imageEditingHeader(bytes.subarray(0, 16))).toThrow();
  });
  test('rejects animated PNG by chunk type without matching compressed pixel content', () => {
    const png = Buffer.alloc(49); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
    png.writeUInt32BE(4, 33); png.write('IDAT', 37); png.write('acTL', 41);
    expect(imageEditingHeader(png)).toMatchObject({ width: 640, height: 480 });
    png.write('acTL', 37); expect(() => imageEditingHeader(png)).toThrow();
  });
  test('reads WebP extended dimensions and rejects its animation flag', () => {
    const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8);
    webp.write('VP8X', 12); webp.writeUInt32LE(10, 16); webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(479, 27, 3);
    expect(imageEditingHeader(webp)).toMatchObject({ width: 640, height: 480, mime: 'image/webp' });
    webp[20] = 2; expect(() => imageEditingHeader(webp)).toThrow();
  });
});
