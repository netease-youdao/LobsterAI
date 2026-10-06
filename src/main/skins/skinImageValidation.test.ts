import {
  SkinAssetFormat,
  SkinAssetMimeType,
} from '@shared/skin/constants';
import { describe, expect, test } from 'vitest';

import { inspectSkinImage } from './skinImageValidation';

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return result;
}

function createPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.from([1])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createJpeg(width: number, height: number): Buffer {
  const startOfFrame = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
  ]);
  const startOfScan = Buffer.from([
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00,
    0x02, 0x00,
    0x03, 0x00,
    0x00, 0x3f, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    startOfFrame,
    startOfScan,
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

function createWebp(width: number, height: number): Buffer {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  const payload = Buffer.from([
    0x2f,
    widthMinusOne & 0xff,
    ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
    (heightMinusOne >> 2) & 0xff,
    (heightMinusOne >> 10) & 0x0f,
  ]);
  const result = Buffer.alloc(26);
  result.write('RIFF', 0, 'ascii');
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WEBP', 8, 'ascii');
  result.write('VP8L', 12, 'ascii');
  result.writeUInt32LE(payload.length, 16);
  payload.copy(result, 20);
  return result;
}

describe('inspectSkinImage', () => {
  test('identifies PNG, JPEG, and WebP from bytes rather than file extensions', () => {
    expect(inspectSkinImage(createPng(1600, 900))).toMatchObject({
      format: SkinAssetFormat.Png,
      mimeType: SkinAssetMimeType.Png,
      width: 1600,
      height: 900,
    });
    expect(inspectSkinImage(createJpeg(1440, 900))).toMatchObject({
      format: SkinAssetFormat.Jpeg,
      mimeType: SkinAssetMimeType.Jpeg,
      width: 1440,
      height: 900,
    });
    expect(inspectSkinImage(createWebp(512, 512))).toMatchObject({
      format: SkinAssetFormat.Webp,
      mimeType: SkinAssetMimeType.Webp,
      width: 512,
      height: 512,
    });
  });

  test('rejects malformed signatures, truncated containers, and invalid PNG CRCs', () => {
    expect(inspectSkinImage(Buffer.from('image/png'))).toBeNull();
    expect(inspectSkinImage(createWebp(512, 512).subarray(0, 24))).toBeNull();
    const corruptPng = createPng(1600, 900);
    corruptPng[29] ^= 0xff;
    expect(inspectSkinImage(corruptPng)).toBeNull();
  });
});
