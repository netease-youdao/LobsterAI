import zlib from 'node:zlib';

import { describe, expect, test, vi } from 'vitest';

import { WORD_PACKAGE_LIMITS } from '../../../../shared/office/word/wordFile';
import { hasImageFile, imageFileOf, prepareWordImage, WordImageError } from './wordImages';

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGB PNG; `dpi` adds a pHYs chunk, `pixels: false` leaves the image data out. */
function png(width: number, height: number, { dpi, pixels = true }: { dpi?: number; pixels?: boolean } = {}): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header)];
  if (dpi) {
    const density = Buffer.alloc(9);
    const perMeter = Math.round(dpi / 0.0254);
    density.writeUInt32BE(perMeter, 0);
    density.writeUInt32BE(perMeter, 4);
    density[8] = 1;
    chunks.push(pngChunk('pHYs', density));
  }
  if (pixels) chunks.push(pngChunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * height))));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

/** A 24-bit BMP with no pixel data beyond its header. */
function bmp(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(54 + width * height * 4);
  bytes.write('BM', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  return new Uint8Array(bytes);
}

const WEBP_1X1 = new Uint8Array(Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'));
const neverEncode = async (): Promise<Uint8Array> => { throw new Error('should not re-encode'); };

describe('prepareWordImage', () => {
  test('keeps a PNG and sizes it at 96 dpi when it states no resolution', async () => {
    const bytes = png(200, 100);
    const result = await prepareWordImage(bytes, neverEncode);
    expect(result).toEqual({ ok: true, image: { bytes, mime: 'image/png', widthPoints: 150, heightPoints: 75 } });
  });

  test('sizes a picture by its stated resolution, as Word does with Retina screenshots', async () => {
    const result = await prepareWordImage(png(200, 100, { dpi: 144 }), neverEncode);
    expect(result.ok && [result.image.widthPoints, result.image.heightPoints]).toEqual([100.01, 50]);
  });

  test('stores WebP and BMP as PNG, keeping the natural size of the original', async () => {
    const encoded = png(2, 3);
    const toPng = vi.fn(async () => encoded);
    const result = await prepareWordImage(bmp(2, 3), toPng);
    expect(toPng).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/bmp');
    expect(result).toEqual({ ok: true, image: { bytes: encoded, mime: 'image/png', widthPoints: 1.5, heightPoints: 2.25 } });
    const webp = await prepareWordImage(WEBP_1X1, toPng);
    expect(webp.ok && webp.image.mime).toBe('image/png');
    expect(toPng).toHaveBeenLastCalledWith(WEBP_1X1, 'image/webp');
  });

  test('reads the type from the bytes and refuses formats Word pictures cannot hold', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    expect(await prepareWordImage(svg, neverEncode)).toEqual({ ok: false, error: WordImageError.Unsupported });
    expect(await prepareWordImage(new TextEncoder().encode('not a picture at all'), neverEncode))
      .toEqual({ ok: false, error: WordImageError.Unsupported });
    // A PNG signature over a broken header is not a PNG.
    expect(await prepareWordImage(png(200, 100).slice(0, 20), neverEncode)).toEqual({ ok: false, error: WordImageError.Unsupported });
  });

  test('refuses a picture whose conversion fails', async () => {
    const result = await prepareWordImage(WEBP_1X1, async () => { throw new Error('decode failed'); });
    expect(result).toEqual({ ok: false, error: WordImageError.Unsupported });
  });

  test('refuses empty files and pictures beyond the size limits before decoding them', async () => {
    expect(await prepareWordImage(new Uint8Array(), neverEncode)).toEqual({ ok: false, error: WordImageError.Empty });
    expect(await prepareWordImage(png(40000, 10, { pixels: false }), neverEncode)).toEqual({ ok: false, error: WordImageError.TooLarge });
    expect(await prepareWordImage(png(20000, 20000, { pixels: false }), neverEncode)).toEqual({ ok: false, error: WordImageError.TooLarge });
    const oversized = new Uint8Array(WORD_PACKAGE_LIMITS.maxPartBytes + 1);
    oversized.set(png(1, 1));
    expect(await prepareWordImage(oversized, neverEncode)).toEqual({ ok: false, error: WordImageError.TooLarge });
  });
});

describe('picture transfers', () => {
  const transfer = (files: File[], items: { kind: string; type: string; file?: File }[]) => ({
    files,
    items: items.map(item => ({ kind: item.kind, type: item.type, getAsFile: () => item.file ?? null })),
  }) as unknown as DataTransfer;

  test('finds the first picture file of a paste or drop', () => {
    const picture = new File([png(1, 1) as BlobPart], 'shot.png', { type: 'image/png' });
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    expect(imageFileOf(transfer([text, picture], []))).toBe(picture);
    // Screenshots on the clipboard come as items without a file list.
    expect(imageFileOf(transfer([], [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png', file: picture }]))).toBe(picture);
    expect(imageFileOf(transfer([text], [{ kind: 'file', type: 'text/plain', file: text }]))).toBeNull();
    expect(imageFileOf(null)).toBeNull();
  });

  test('tells picture payloads from text ones', () => {
    expect(hasImageFile(transfer([], [{ kind: 'file', type: 'image/jpeg' }]))).toBe(true);
    expect(hasImageFile(transfer([], [{ kind: 'string', type: 'text/html' }, { kind: 'file', type: 'application/pdf' }]))).toBe(false);
    expect(hasImageFile(null)).toBe(false);
  });
});
