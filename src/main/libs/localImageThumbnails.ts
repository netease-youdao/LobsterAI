import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { LocalFileThumbnailFit, snapLocalFileThumbnailEdge } from '../../shared/artifactPreview/localFileThumbnail';
import { imageEditingHeader } from './imageEditingHeader';

const THUMBNAIL_SOURCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
/** Reading a larger source to shrink it costs more than serving it. */
const MAX_THUMBNAIL_SOURCE_BYTES = 64 * 1024 * 1024;
/** Thumbnails are rebuilt after this long, so moved or edited sources do not leave files behind forever. */
const THUMBNAIL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLVED_CACHE_LIMIT = 2000;
const JPEG_QUALITY = 88;
/** Native thumbnailers may round the requested size by a pixel; anything further off is not a plain resize. */
const SIZE_TOLERANCE_PX = 2;

export interface ThumbnailImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality: 'good' }): ThumbnailImage;
  toBitmap(): Buffer;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

export interface LocalImageThumbnailDeps {
  cacheDirectory: string;
  /**
   * Builds a thumbnail of exactly the requested size, decoding outside the main thread
   * (QuickLook on macOS, the shell on Windows). Undefined where the platform has none.
   */
  createThumbnail?: (filePath: string, size: { width: number; height: number }) => Promise<ThumbnailImage>;
}

const hasTransparentPixels = (bitmap: Buffer): boolean => {
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] !== 255) return true;
  }
  return false;
};

const fileExists = (filePath: string) => fs.promises.access(filePath).then(() => true, () => false);

/**
 * Downscaled copies of local images for the conversation, which shows generated images far
 * smaller than they are made. Built one at a time and cached on disk by source path, size,
 * modification time and edge; anything unusual is served as the original instead.
 */
export class LocalImageThumbnails {
  private readonly resolved = new Map<string, string | null>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LocalImageThumbnailDeps) {}

  /**
   * Path of a copy whose long side (`contain`) is at most, or whose short side (`cover`) is at least,
   * `requestedEdge` pixels; null to serve the original.
   */
  async resolve(
    filePath: string,
    stat: { size: number; mtimeMs: number },
    requestedEdge: number,
    fit: LocalFileThumbnailFit = LocalFileThumbnailFit.Contain,
  ): Promise<string | null> {
    const edge = snapLocalFileThumbnailEdge(requestedEdge);
    if (!edge || !this.deps.createThumbnail || stat.size > MAX_THUMBNAIL_SOURCE_BYTES
      || !THUMBNAIL_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;

    const key = crypto.createHash('sha256')
      .update(`${path.resolve(filePath)}\0${stat.size}\0${stat.mtimeMs}\0${edge}\0${fit}`)
      .digest('hex');
    if (this.resolved.has(key)) {
      const known = this.resolved.get(key) ?? null;
      if (known === null || await fileExists(known)) return known;
      this.resolved.delete(key);
    }
    let task = this.pending.get(key);
    if (!task) {
      task = this.enqueue(() => this.build(filePath, key, edge, fit)).finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    return task;
  }

  /** Removes thumbnails older than a month; returns how many were deleted. */
  async prune(now = Date.now()): Promise<number> {
    let removed = 0;
    const buckets = await fs.promises.readdir(this.deps.cacheDirectory).catch(() => [] as string[]);
    for (const bucket of buckets) {
      const bucketPath = path.join(this.deps.cacheDirectory, bucket);
      const names = await fs.promises.readdir(bucketPath).catch(() => [] as string[]);
      for (const name of names) {
        const filePath = path.join(bucketPath, name);
        const stat = await fs.promises.stat(filePath).catch((): null => null);
        if (!stat?.isFile() || now - stat.mtimeMs < THUMBNAIL_MAX_AGE_MS) continue;
        await fs.promises.unlink(filePath).then(() => { removed += 1; }, (): void => {});
      }
    }
    if (removed > 0) this.resolved.clear();
    return removed;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch((): void => {});
    return run;
  }

  private cachePath(key: string, extension: string): string {
    return path.join(this.deps.cacheDirectory, key.slice(0, 2), `${key}${extension}`);
  }

  private remember(key: string, value: string | null): string | null {
    this.resolved.set(key, value);
    if (this.resolved.size > RESOLVED_CACHE_LIMIT) {
      const oldest = this.resolved.keys().next().value;
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
    return value;
  }

  private async build(filePath: string, key: string, edge: number, fit: LocalFileThumbnailFit): Promise<string | null> {
    for (const extension of ['.jpg', '.png']) {
      const cached = this.cachePath(key, extension);
      if (await fileExists(cached)) return this.remember(key, cached);
    }
    try {
      const bytes = await fs.promises.readFile(filePath);
      let header: ReturnType<typeof imageEditingHeader>;
      try {
        header = imageEditingHeader(bytes);
      } catch {
        // Animated or unrecognized images keep playing and rendering as they are.
        return this.remember(key, null);
      }
      const measured = fit === LocalFileThumbnailFit.Cover
        ? Math.min(header.width, header.height)
        : Math.max(header.width, header.height);
      if (measured <= edge) return this.remember(key, null);

      const scale = edge / measured;
      const size = {
        width: Math.max(1, Math.round(header.width * scale)),
        height: Math.max(1, Math.round(header.height * scale)),
      };
      // The requested box must keep the source's aspect ratio: given any other box,
      // native thumbnailers pad or stretch the image to fill it.
      const native = await this.deps.createThumbnail!(filePath, size);
      const actual = native.getSize();
      if (native.isEmpty() || Math.abs(actual.width - size.width) > SIZE_TOLERANCE_PX
        || Math.abs(actual.height - size.height) > SIZE_TOLERANCE_PX) {
        return this.remember(key, null);
      }
      // QuickLook renders for the screen's scale factor, and encoding picks the largest
      // representation (twice the size on Retina); the renderer already asked in device pixels.
      const image = native.resize({ ...size, quality: 'good' });

      const transparent = header.mime !== 'image/jpeg' && hasTransparentPixels(image.toBitmap());
      const target = this.cachePath(key, transparent ? '.png' : '.jpg');
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const tempPath = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(tempPath, transparent ? image.toPNG() : image.toJPEG(JPEG_QUALITY));
      await fs.promises.rename(tempPath, target);
      return this.remember(key, target);
    } catch (error) {
      console.warn('[LocalImageThumbnails] could not build a thumbnail; serving the original:', error);
      return this.remember(key, null);
    }
  }
}
