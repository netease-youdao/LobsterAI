import { expect, test } from 'vitest';

import {
  buildCoworkImageAttachmentPreview,
  COWORK_IMAGE_ATTACHMENT_MAX_BYTES,
  COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES,
  estimateBase64DecodedBytes,
  formatCoworkImageAttachmentLimit,
  readImageDimensions,
  SniffableImageMimeType,
  sniffImageMimeType,
  validateCoworkImageAttachmentSize,
} from './imageAttachments';

test('estimateBase64DecodedBytes handles padding and data URL prefixes', () => {
  expect(estimateBase64DecodedBytes('TWFu')).toBe(3);
  expect(estimateBase64DecodedBytes('TWE=')).toBe(2);
  expect(estimateBase64DecodedBytes('TQ==')).toBe(1);
  expect(estimateBase64DecodedBytes('data:image/png;base64,TWFu')).toBe(3);
});

test('formatCoworkImageAttachmentLimit uses a locale-neutral MB label', () => {
  expect(formatCoworkImageAttachmentLimit()).toBe('30MB');
});

test('validateCoworkImageAttachmentSize accepts exactly the 30MB limit', () => {
  const validation = validateCoworkImageAttachmentSize({
    base64Data: '',
    sizeBytes: COWORK_IMAGE_ATTACHMENT_MAX_BYTES,
  });

  expect(validation.ok).toBe(true);
  expect(validation.sizeBytes).toBe(COWORK_IMAGE_ATTACHMENT_MAX_BYTES);
});

test('validateCoworkImageAttachmentSize rejects payloads over the 30MB limit', () => {
  const validation = validateCoworkImageAttachmentSize({
    base64Data: '',
    sizeBytes: COWORK_IMAGE_ATTACHMENT_MAX_BYTES + 1,
  });

  expect(validation.ok).toBe(false);
  expect(validation.maxBytes).toBe(COWORK_IMAGE_ATTACHMENT_MAX_BYTES);
});

test('validateCoworkImageAttachmentSize does not trust a smaller declared size', () => {
  const validation = validateCoworkImageAttachmentSize({
    base64Data: 'A'.repeat(Math.ceil((COWORK_IMAGE_ATTACHMENT_MAX_BYTES + 1) / 3) * 4),
    sizeBytes: 1,
  });

  expect(validation.ok).toBe(false);
  expect(validation.sizeBytes).toBeGreaterThan(COWORK_IMAGE_ATTACHMENT_MAX_BYTES);
});

test('buildCoworkImageAttachmentPreview stores preview data instead of large original data', () => {
  const preview = buildCoworkImageAttachmentPreview({
    name: 'large.png',
    mimeType: 'image/png',
    base64Data: 'A'.repeat(COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES * 2),
    sizeBytes: COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES + 1,
    localPath: '/tmp/large.png',
    previewMimeType: 'image/jpeg',
    previewBase64Data: 'cHJldmlldw==',
  });

  expect(preview).toEqual({
    name: 'large.png',
    mimeType: 'image/jpeg',
    base64Data: 'cHJldmlldw==',
    originalMimeType: 'image/png',
    originalSizeBytes: 786432,
    localPath: '/tmp/large.png',
    isPreview: true,
  });
});

test('buildCoworkImageAttachmentPreview refuses large originals without preview data', () => {
  expect(buildCoworkImageAttachmentPreview({
    name: 'large.png',
    mimeType: 'image/png',
    base64Data: 'A'.repeat(COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES * 2),
    sizeBytes: COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES + 1,
  })).toBeUndefined();
});

test('reads dimensions from PNG, JPEG, GIF, BMP, and WebP (VP8, VP8L, VP8X) headers', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  expect(sniffImageMimeType(png)).toBe(SniffableImageMimeType.Png);
  expect(readImageDimensions(png)).toEqual({ width: 640, height: 480 });

  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  expect(sniffImageMimeType(jpeg)).toBe(SniffableImageMimeType.Jpeg);
  expect(readImageDimensions(jpeg)).toEqual({ width: 400, height: 300 });

  const gif = Buffer.alloc(10);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(240, 8);
  expect(sniffImageMimeType(gif)).toBe(SniffableImageMimeType.Gif);
  expect(readImageDimensions(gif)).toEqual({ width: 320, height: 240 });

  const bmp = Buffer.alloc(26);
  bmp.write('BM', 0, 'ascii');
  bmp.writeInt32LE(512, 18);
  bmp.writeInt32LE(-256, 22);
  expect(sniffImageMimeType(bmp)).toBe(SniffableImageMimeType.Bmp);
  expect(readImageDimensions(bmp)).toEqual({ width: 512, height: 256 });

  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0, 'ascii');
  vp8x.write('WEBP', 8, 'ascii');
  vp8x.write('VP8X', 12, 'ascii');
  vp8x.writeUIntLE(1280 - 1, 24, 3);
  vp8x.writeUIntLE(720 - 1, 27, 3);
  expect(sniffImageMimeType(vp8x)).toBe(SniffableImageMimeType.Webp);
  expect(readImageDimensions(vp8x)).toEqual({ width: 1280, height: 720 });

  const vp8l = Buffer.alloc(30);
  vp8l.write('RIFF', 0, 'ascii');
  vp8l.write('WEBP', 8, 'ascii');
  vp8l.write('VP8L', 12, 'ascii');
  vp8l[20] = 0x2f;
  const packed = ((800 - 1) & 0x3fff) | (((600 - 1) & 0x3fff) << 14);
  vp8l.writeUInt32LE(packed >>> 0, 21);
  expect(readImageDimensions(vp8l)).toEqual({ width: 800, height: 600 });

  const vp8 = Buffer.alloc(30);
  vp8.write('RIFF', 0, 'ascii');
  vp8.write('WEBP', 8, 'ascii');
  vp8.write('VP8 ', 12, 'ascii');
  vp8[23] = 0x9d;
  vp8[24] = 0x01;
  vp8[25] = 0x2a;
  vp8.writeUInt16LE(1024, 26);
  vp8.writeUInt16LE(768, 28);
  expect(readImageDimensions(vp8)).toEqual({ width: 1024, height: 768 });

  expect(readImageDimensions(Buffer.from('not an image'))).toBeUndefined();
});
