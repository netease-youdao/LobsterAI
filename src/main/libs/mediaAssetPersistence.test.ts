import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import {
  type FetchResponseLike,
  inferImageExtensionFromBytes,
  inferImageExtensionFromUrl,
  inferImageMimeTypeFromDataUrl,
  persistGeneratedImageAssets,
  persistGeneratedVideoAssets,
  sanitizeGeneratedImageFileName,
} from './mediaAssetPersistence';

const pngBuffer = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D,
]);
const mp4Buffer = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6F, 0x6D,
  0x00, 0x00, 0x02, 0x00,
]);

function makeResponse(buffer: Buffer, contentType: string, ok = true): FetchResponseLike {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Server Error',
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null,
    },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

describe('mediaAssetPersistence', () => {
  test('sanitizes generated image filenames', () => {
    expect(sanitizeGeneratedImageFileName('bad:name?.png', 'generated-image', '.png')).toBe('bad-name-.png');
    expect(sanitizeGeneratedImageFileName('no-extension', 'generated-image', '.webp')).toBe('no-extension.webp');
    expect(sanitizeGeneratedImageFileName('cat.jpeg', 'generated-image', '.png')).toBe('cat.png');
    expect(sanitizeGeneratedImageFileName('...', 'generated-image', '.png')).toBe('generated-image.png');
  });

  test('infers image extensions from urls and bytes', () => {
    expect(inferImageExtensionFromUrl('https://example.com/path/image.png?signature=temporary')).toBe('.png');
    expect(inferImageExtensionFromBytes(pngBuffer)).toBe('.png');
    expect(inferImageMimeTypeFromDataUrl(`data:image/webp;base64,${Buffer.from('raw').toString('base64')}`)).toBe('image/webp');
  });

  test('persists downloaded images into cwd and avoids overwriting existing files', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-media-assets-'));
    await fs.promises.writeFile(path.join(cwd, 'generated-image.png'), 'existing');

    const result = await persistGeneratedImageAssets({
      cwd,
      now: new Date(2026, 4, 14, 11, 50, 32),
      assets: [
        {
          type: 'image',
          url: 'https://example.com/generated.png?signature=temporary',
          mimeType: 'image/png',
          filename: 'generated-image.png',
        },
      ],
      fetchAsset: async () => makeResponse(pngBuffer, 'image/png'),
    });

    expect(result.failed).toHaveLength(0);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].filename).toBe('generated-image-2.png');
    expect(result.saved[0].filePath).toBe(path.join(cwd, 'generated-image-2.png'));
    expect(await fs.promises.readFile(result.saved[0].filePath)).toEqual(pngBuffer);
  });

  test('persists downloaded images using byte-detected extension over declared filename', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-media-assets-'));

    const result = await persistGeneratedImageAssets({
      cwd,
      now: new Date(2026, 5, 12, 17, 31, 0),
      assets: [
        {
          type: 'image',
          url: 'https://example.com/british-shorthair-golden-shaded.webp',
          mimeType: 'image/webp',
          filename: 'british-shorthair-golden-shaded.webp',
        },
      ],
      fetchAsset: async () => makeResponse(pngBuffer, 'image/webp'),
    });

    expect(result.failed).toHaveLength(0);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].filename).toBe('british-shorthair-golden-shaded.png');
    expect(result.saved[0].mimeType).toBe('image/png');
    expect(result.saved[0].filePath).toBe(path.join(cwd, 'british-shorthair-golden-shaded.png'));
    expect(await fs.promises.readFile(result.saved[0].filePath)).toEqual(pngBuffer);
  });

  test('persists image data urls without fetching and prefers byte-detected extension', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-media-assets-'));
    const dataUrl = `data:image/jpeg;base64,${pngBuffer.toString('base64')}`;

    const result = await persistGeneratedImageAssets({
      cwd,
      now: new Date(2026, 4, 14, 11, 50, 32),
      assets: [
        {
          type: 'image',
          url: dataUrl,
          mimeType: 'image/jpeg',
        },
      ],
      fetchAsset: async () => {
        throw new Error('data URL should not be fetched');
      },
    });

    expect(result.failed).toHaveLength(0);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].filename).toBe('generated-image-20260514-115032-1.png');
    expect(result.saved[0].mimeType).toBe('image/png');
    expect(await fs.promises.readFile(result.saved[0].filePath)).toEqual(pngBuffer);
  });

  test('persists image data urls using byte-detected extension over declared filename', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-media-assets-'));
    const dataUrl = `data:image/jpeg;base64,${pngBuffer.toString('base64')}`;

    const result = await persistGeneratedImageAssets({
      cwd,
      now: new Date(2026, 5, 12, 17, 31, 0),
      assets: [
        {
          type: 'image',
          url: dataUrl,
          mimeType: 'image/jpeg',
          filename: 'british-shorthair-golden-shaded.jpeg',
        },
      ],
      fetchAsset: async () => {
        throw new Error('data URL should not be fetched');
      },
    });

    expect(result.failed).toHaveLength(0);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].filename).toBe('british-shorthair-golden-shaded.png');
    expect(result.saved[0].mimeType).toBe('image/png');
    expect(result.saved[0].filePath).toBe(path.join(cwd, 'british-shorthair-golden-shaded.png'));
    expect(await fs.promises.readFile(result.saved[0].filePath)).toEqual(pngBuffer);
  });

  test('persists image data urls using declared mime when bytes are unknown', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-media-assets-'));
    const rawBuffer = Buffer.from('image-bytes-without-known-signature');

    const result = await persistGeneratedImageAssets({
      cwd,
      now: new Date(2026, 4, 14, 11, 50, 32),
      assets: [
        {
          type: 'image',
          url: `data:image/webp;base64,${rawBuffer.toString('base64')}`,
        },
      ],
      fetchAsset: async () => {
        throw new Error('data URL should not be fetched');
      },
    });

    expect(result.failed).toHaveLength(0);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].filename).toBe('generated-image-20260514-115032-1.webp');
    expect(result.saved[0].mimeType).toBe('image/webp');
    expect(await fs.promises.readFile(result.saved[0].filePath)).toEqual(rawBuffer);
  });

  test('reports failed downloads without writing files', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-media-assets-'));

    const result = await persistGeneratedImageAssets({
      cwd,
      assets: [
        {
          type: 'image',
          url: 'https://example.com/generated.txt',
        },
      ],
      fetchAsset: async () => makeResponse(Buffer.from('not an image'), 'text/plain'),
    });

    expect(result.saved).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(await fs.promises.readdir(cwd)).toEqual([]);
  });

  test('persists downloaded videos into cwd', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-media-assets-'));

    const result = await persistGeneratedVideoAssets({
      cwd,
      now: new Date(2026, 4, 14, 11, 50, 32),
      assets: [
        {
          type: 'video',
          url: 'https://example.com/generated.mp4?signature=temporary',
          outputIndex: 3,
          mimeType: 'video/mp4',
        },
      ],
      fetchAsset: async () => makeResponse(mp4Buffer, 'video/mp4'),
    });

    expect(result.failed).toHaveLength(0);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].filename).toBe('generated-video-20260514-115032-1.mp4');
    expect(result.saved[0].outputIndex).toBe(3);
    expect(result.saved[0].filePath).toBe(path.join(cwd, 'generated-video-20260514-115032-1.mp4'));
    expect(await fs.promises.readFile(result.saved[0].filePath)).toEqual(mp4Buffer);
  });
});
