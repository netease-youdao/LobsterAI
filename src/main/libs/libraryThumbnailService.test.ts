import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import { LibraryThumbnailRequestPriority } from '../../shared/library/thumbnail';
import {
  getLibraryThumbnailCacheVersion,
  LibraryThumbnailCacheVersion,
  LibraryThumbnailService,
} from './libraryThumbnailService';

const createStat = (mtimeMs: number, size = 10) => ({
  isFile: () => true,
  mtimeMs,
  size,
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

const flushTasks = (): Promise<void> => new Promise(resolve => {
  setImmediate(resolve);
});

describe('LibraryThumbnailService', () => {
  test('versions the cache independently for raster, PPTX and other renderer strategies', () => {
    expect(getLibraryThumbnailCacheVersion('/tmp/slides.pptx')).toBe(
      LibraryThumbnailCacheVersion.PptxFirstSlidePresentedFrame,
    );
    expect(getLibraryThumbnailCacheVersion('/tmp/slides.PPTX')).toBe(
      LibraryThumbnailCacheVersion.PptxFirstSlidePresentedFrame,
    );
    expect(getLibraryThumbnailCacheVersion('/tmp/photo.JPG')).toBe(
      LibraryThumbnailCacheVersion.RasterCanvas,
    );
    expect(getLibraryThumbnailCacheVersion('/tmp/report.pdf')).toBe(
      LibraryThumbnailCacheVersion.DirectCanvas,
    );
    expect(getLibraryThumbnailCacheVersion('/tmp/vector.svg')).toBe(
      LibraryThumbnailCacheVersion.DirectCanvas,
    );
  });

  test('uses a fixed cross-platform 16:9 thumbnail size', async () => {
    let receivedSize: { width: number; height: number } | undefined;
    const service = new LibraryThumbnailService({
      statFile: async () => createStat(100),
      createThumbnail: async (_filePath, size) => {
        receivedSize = size;
        return PNG_BYTES;
      },
    });

    await service.generate('/tmp/library-fixed-size.png');

    expect(receivedSize).toEqual({ width: 480, height: 270 });
  });

  test('caches by resolved path, mtime and size', async () => {
    let mtimeMs = 100;
    let createCount = 0;
    const service = new LibraryThumbnailService({
      statFile: async () => createStat(mtimeMs),
      createThumbnail: async () => {
        createCount += 1;
        return Buffer.concat([PNG_BYTES, Buffer.from([createCount])]);
      },
    });

    const first = await service.generate('/tmp/library-cache.docx');
    const second = await service.generate('/tmp/library-cache.docx');
    expect(second).toBe(first);
    expect(createCount).toBe(1);

    mtimeMs = 200;
    const changed = await service.generate('/tmp/library-cache.docx');
    expect(changed).not.toBe(first);
    expect(createCount).toBe(2);
  });

  test('deduplicates simultaneous requests for the same file version', async () => {
    let createCount = 0;
    let releaseThumbnail: ((value: Buffer) => void) | undefined;
    const service = new LibraryThumbnailService({
      statFile: async () => createStat(100),
      createThumbnail: async () => {
        createCount += 1;
        return new Promise<Buffer>(resolve => {
          releaseThumbnail = resolve;
        });
      },
    });

    const first = service.generate('/tmp/library-deduplicate.pdf');
    const second = service.generate('/tmp/library-deduplicate.pdf');
    await flushTasks();
    expect(createCount).toBe(1);

    releaseThumbnail?.(PNG_BYTES);
    await expect(Promise.all([first, second])).resolves.toEqual([
      PNG_DATA_URL,
      PNG_DATA_URL,
    ]);
  });

  test('limits concurrent thumbnail generation', async () => {
    let activeCount = 0;
    let peakActiveCount = 0;
    const releases: Array<() => void> = [];
    const service = new LibraryThumbnailService({
      maxConcurrency: 2,
      statFile: async () => createStat(100),
      createThumbnail: async filePath => {
        activeCount += 1;
        peakActiveCount = Math.max(peakActiveCount, activeCount);
        await new Promise<void>(resolve => {
          releases.push(resolve);
        });
        activeCount -= 1;
        return Buffer.concat([PNG_BYTES, Buffer.from(filePath)]);
      },
    });

    const requests = [
      service.generate('/tmp/library-one.pdf'),
      service.generate('/tmp/library-two.pdf'),
      service.generate('/tmp/library-three.pdf'),
    ];
    await flushTasks();
    expect(releases).toHaveLength(2);
    expect(peakActiveCount).toBe(2);

    releases.shift()?.();
    await flushTasks();
    expect(releases).toHaveLength(2);
    releases.splice(0).forEach(release => release());
    await Promise.all(requests);
    expect(peakActiveCount).toBe(2);
  });

  test('promotes a visible request ahead of queued near-viewport work', async () => {
    const runningPath = path.resolve(os.tmpdir(), 'running.pdf');
    const nearPath = path.resolve(os.tmpdir(), 'near.pdf');
    const visiblePath = path.resolve(os.tmpdir(), 'visible.pdf');
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const service = new LibraryThumbnailService({
      maxConcurrency: 1,
      statFile: async () => createStat(100),
      createThumbnail: async filePath => {
        started.push(filePath);
        await new Promise<void>(resolve => releases.push(resolve));
        return PNG_BYTES;
      },
    });

    const running = service.generate(runningPath, {
      requestId: 'running',
      priority: LibraryThumbnailRequestPriority.NearViewport,
    });
    const near = service.generate(nearPath, {
      requestId: 'near',
      priority: LibraryThumbnailRequestPriority.NearViewport,
    });
    const visible = service.generate(visiblePath, {
      requestId: 'visible',
      priority: LibraryThumbnailRequestPriority.Visible,
    });
    await flushTasks();
    expect(started).toEqual([runningPath]);

    releases.shift()?.();
    await flushTasks();
    expect(started).toEqual([runningPath, visiblePath]);
    releases.shift()?.();
    await flushTasks();
    releases.shift()?.();
    await Promise.all([running, near, visible]);
    expect(started).toEqual([runningPath, visiblePath, nearPath]);
  });

  test('cancels a queued request before renderer work starts', async () => {
    const releases: Array<() => void> = [];
    const service = new LibraryThumbnailService({
      maxConcurrency: 1,
      statFile: async () => createStat(100),
      createThumbnail: async () => {
        await new Promise<void>(resolve => releases.push(resolve));
        return PNG_BYTES;
      },
    });

    const running = service.generate('/tmp/running.pdf', { requestId: 'running' });
    const canceled = service.generate('/tmp/canceled.pdf', { requestId: 'canceled' });
    await flushTasks();
    expect(service.cancel('canceled')).toBe(true);
    await expect(canceled).rejects.toMatchObject({ code: 'request_canceled' });
    releases.shift()?.();
    await running;
  });

  test('cancels a request while its file metadata is still being read', async () => {
    let releaseStat: (() => void) | undefined;
    const createThumbnail = async () => PNG_BYTES;
    const service = new LibraryThumbnailService({
      statFile: async () => {
        await new Promise<void>(resolve => { releaseStat = resolve; });
        return createStat(100);
      },
      createThumbnail,
    });

    const canceled = service.generate('/tmp/preparing.pdf', { requestId: 'preparing' });
    expect(service.cancel('preparing')).toBe(true);
    releaseStat?.();
    await expect(canceled).rejects.toMatchObject({ code: 'request_canceled' });
  });

  test('rejects a corrupt disk entry and replaces it through an atomic cache write', async () => {
    const cacheDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'library-cache-'));
    try {
      const firstService = new LibraryThumbnailService({
        getCacheDirectory: () => cacheDirectory,
        statFile: async () => createStat(100),
        createThumbnail: async () => PNG_BYTES,
      });
      await firstService.generate('/tmp/cached.pdf');
      const [cacheFile] = await fs.promises.readdir(cacheDirectory);
      expect(cacheFile).toMatch(/\.png$/);
      await fs.promises.writeFile(path.join(cacheDirectory, cacheFile!), 'corrupt');

      let regenerated = 0;
      const secondService = new LibraryThumbnailService({
        getCacheDirectory: () => cacheDirectory,
        statFile: async () => createStat(100),
        createThumbnail: async () => {
          regenerated += 1;
          return PNG_BYTES;
        },
      });
      await expect(secondService.generate('/tmp/cached.pdf')).resolves.toBe(PNG_DATA_URL);
      expect(regenerated).toBe(1);
      expect(await fs.promises.readdir(cacheDirectory)).toEqual([cacheFile]);
    } finally {
      await fs.promises.rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});
