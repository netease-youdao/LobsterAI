import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LocalFileThumbnailFit } from '../../shared/artifactPreview/localFileThumbnail';
import { LocalImageThumbnails, type ThumbnailImage } from './localImageThumbnails';

/** A PNG whose header is complete enough for imageEditingHeader; the pixels are never decoded here. */
const pngWithSize = (width: number, height: number): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
};

const fakeImage = (width: number, height: number, alpha = 255): ThumbnailImage => ({
  isEmpty: () => false,
  getSize: () => ({ width, height }),
  resize: size => fakeImage(size.width, size.height, alpha),
  toBitmap: () => Buffer.alloc(width * height * 4, alpha),
  toPNG: () => Buffer.from('png-thumbnail'),
  toJPEG: () => Buffer.from('jpeg-thumbnail'),
});

let tempDir: string;
let cacheDirectory: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-thumbnails-'));
  cacheDirectory = path.join(tempDir, 'cache');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const source = (name: string, bytes: Buffer) => {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, bytes);
  return { filePath, stat: fs.statSync(filePath) };
};

describe('LocalImageThumbnails', () => {
  test('builds an aspect-correct JPEG for an opaque image and reuses it from disk', async () => {
    const { filePath, stat } = source('wide.png', pngWithSize(1536, 1024));
    const createThumbnail = vi.fn(async (_file: string, size: { width: number; height: number }) => fakeImage(size.width, size.height));
    const thumbnails = new LocalImageThumbnails({ cacheDirectory, createThumbnail });

    const thumbnail = await thumbnails.resolve(filePath, stat, 900);

    expect(createThumbnail).toHaveBeenCalledWith(filePath, { width: 1024, height: 683 });
    expect(thumbnail?.endsWith('.jpg')).toBe(true);
    expect(fs.readFileSync(thumbnail!, 'utf8')).toBe('jpeg-thumbnail');
    expect(await thumbnails.resolve(filePath, stat, 1000)).toBe(thumbnail);

    const restarted = new LocalImageThumbnails({ cacheDirectory, createThumbnail });
    expect(await restarted.resolve(filePath, stat, 1024)).toBe(thumbnail);
    expect(createThumbnail).toHaveBeenCalledTimes(1);
  });

  test('cover thumbnails size the short side, and keep the original when it is already the short side', async () => {
    const wide = source('wide.png', pngWithSize(1536, 1024));
    const panorama = source('panorama.png', pngWithSize(1536, 472));
    const createThumbnail = vi.fn(async (_file: string, size: { width: number; height: number }) => fakeImage(size.width, size.height));
    const thumbnails = new LocalImageThumbnails({ cacheDirectory, createThumbnail });

    const contain = await thumbnails.resolve(wide.filePath, wide.stat, 512);
    const cover = await thumbnails.resolve(wide.filePath, wide.stat, 480, LocalFileThumbnailFit.Cover);

    expect(createThumbnail.mock.calls.map(call => call[1])).toEqual([{ width: 512, height: 341 }, { width: 768, height: 512 }]);
    expect(cover).not.toBe(contain);
    expect(await thumbnails.resolve(panorama.filePath, panorama.stat, 480, LocalFileThumbnailFit.Cover)).toBeNull();
  });

  test('keeps transparency as PNG', async () => {
    const { filePath, stat } = source('cutout.png', pngWithSize(1254, 1254));
    const thumbnails = new LocalImageThumbnails({
      cacheDirectory,
      createThumbnail: async (_file, size) => fakeImage(size.width, size.height, 0),
    });

    const thumbnail = await thumbnails.resolve(filePath, stat, 512);

    expect(thumbnail?.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(thumbnail!, 'utf8')).toBe('png-thumbnail');
  });

  test('serves the original when it is small enough, unsupported, or the thumbnailer misbehaves', async () => {
    const small = source('small.png', pngWithSize(800, 600));
    const gif = source('anim.gif', Buffer.from('GIF89a'));
    const large = source('large.png', pngWithSize(3000, 2000));
    const createThumbnail = vi.fn(async () => fakeImage(512, 512));
    const thumbnails = new LocalImageThumbnails({ cacheDirectory, createThumbnail });

    expect(await thumbnails.resolve(small.filePath, small.stat, 1024)).toBeNull();
    expect(await thumbnails.resolve(gif.filePath, gif.stat, 512)).toBeNull();
    expect(await thumbnails.resolve(large.filePath, large.stat, 4096)).toBeNull();
    // A square result for a 3:2 source means the thumbnailer padded or stretched it.
    expect(await thumbnails.resolve(large.filePath, large.stat, 512)).toBeNull();
    expect(createThumbnail).toHaveBeenCalledTimes(1);
    expect(await new LocalImageThumbnails({ cacheDirectory }).resolve(large.filePath, large.stat, 512)).toBeNull();
  });

  test('builds each thumbnail once for concurrent requests', async () => {
    const { filePath, stat } = source('wide.png', pngWithSize(1536, 1024));
    const createThumbnail = vi.fn(async (_file: string, size: { width: number; height: number }) => fakeImage(size.width, size.height));
    const thumbnails = new LocalImageThumbnails({ cacheDirectory, createThumbnail });

    const results = await Promise.all([thumbnails.resolve(filePath, stat, 512), thumbnails.resolve(filePath, stat, 400)]);

    expect(results[0]).toBe(results[1]);
    expect(createThumbnail).toHaveBeenCalledTimes(1);
  });

  test('prunes thumbnails older than a month', async () => {
    const { filePath, stat } = source('wide.png', pngWithSize(1536, 1024));
    const thumbnails = new LocalImageThumbnails({
      cacheDirectory,
      createThumbnail: async (_file, size) => fakeImage(size.width, size.height),
    });
    const thumbnail = await thumbnails.resolve(filePath, stat, 512);

    expect(await thumbnails.prune(Date.now())).toBe(0);
    expect(await thumbnails.prune(Date.now() + 31 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(fs.existsSync(thumbnail!)).toBe(false);
  });
});
