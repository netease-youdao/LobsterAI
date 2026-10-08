import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { isLibraryHtmlThumbnailExtension } from '../../shared/library/htmlThumbnail';
import {
  isLibraryDirectPngThumbnailExtension,
  isLibraryRasterThumbnailExtension,
  LibraryThumbnailError,
  LibraryThumbnailFailureCode,
  LibraryThumbnailRequestPriority,
  type LibraryThumbnailRequestPriorityType,
} from '../../shared/library/thumbnail';

interface ThumbnailFileStat {
  isFile: () => boolean;
  mtimeMs: number;
  size: number;
}

interface ThumbnailSize {
  width: number;
  height: number;
}

interface LibraryThumbnailServiceOptions {
  createThumbnail: (filePath: string, size: ThumbnailSize) => Promise<Buffer>;
  getCacheDirectory?: () => string;
  statFile?: (filePath: string) => Promise<ThumbnailFileStat>;
  maxConcurrency?: number;
  maxMemoryEntries?: number;
  maxDiskEntries?: number;
  size?: ThumbnailSize;
}

interface LibraryThumbnailGenerateOptions {
  requestId?: string;
  priority?: LibraryThumbnailRequestPriorityType;
}

interface QueuedThumbnailRequest {
  cacheKey: string;
  requestIds: Set<string>;
  hasAnonymousConsumer: boolean;
  priority: LibraryThumbnailRequestPriorityType;
  sequence: number;
  started: boolean;
  run: () => Promise<string>;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  promise: Promise<string>;
}

export const LibraryThumbnailCacheVersion = {
  RasterCanvas: 'raster-canvas-v1',
  DirectCanvas: 'direct-canvas-v1',
  PresentedFrame: 'presentation-stamp-v3',
  HtmlPresentedFrame: 'html-child-presentation-stamp-v1',
  PptxFirstSlidePresentedFrame: 'pptx-source-aware-presentation-stamp-v5',
} as const;
const DEFAULT_THUMBNAIL_SIZE = { width: 480, height: 270 };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LIBRARY_THUMBNAIL_PRIORITY_SET = new Set<number>(
  Object.values(LibraryThumbnailRequestPriority),
);

const isValidPngBuffer = (buffer: Buffer): boolean => (
  buffer.length > PNG_SIGNATURE.length
  && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
);

export const getLibraryThumbnailCacheVersion = (filePath: string): string => {
  const extension = path.extname(filePath).toLowerCase();
  if (isLibraryHtmlThumbnailExtension(extension)) {
    return LibraryThumbnailCacheVersion.HtmlPresentedFrame;
  }
  if (extension === '.pptx') {
    return LibraryThumbnailCacheVersion.PptxFirstSlidePresentedFrame;
  }
  if (isLibraryRasterThumbnailExtension(extension)) {
    return LibraryThumbnailCacheVersion.RasterCanvas;
  }
  if (isLibraryDirectPngThumbnailExtension(extension)) {
    return LibraryThumbnailCacheVersion.DirectCanvas;
  }
  return LibraryThumbnailCacheVersion.PresentedFrame;
};

export class LibraryThumbnailService {
  private readonly createThumbnail: LibraryThumbnailServiceOptions['createThumbnail'];
  private readonly getCacheDirectory?: () => string;
  private readonly statFile: NonNullable<LibraryThumbnailServiceOptions['statFile']>;
  private readonly maxConcurrency: number;
  private readonly maxMemoryEntries: number;
  private readonly maxDiskEntries: number;
  private readonly size: ThumbnailSize;
  private readonly memoryCache = new Map<string, string>();
  private readonly inFlight = new Map<string, QueuedThumbnailRequest>();
  private readonly requestsById = new Map<string, QueuedThumbnailRequest>();
  private readonly preparingRequestIds = new Set<string>();
  private readonly canceledPreparingRequestIds = new Set<string>();
  private readonly pendingRequests: QueuedThumbnailRequest[] = [];
  private activeCount = 0;
  private nextSequence = 0;
  private nextTemporaryFileId = 0;
  private diskPrunePromise?: Promise<void>;

  constructor(options: LibraryThumbnailServiceOptions) {
    this.createThumbnail = options.createThumbnail;
    this.getCacheDirectory = options.getCacheDirectory;
    this.statFile = options.statFile ?? (filePath => fs.promises.stat(filePath));
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 3));
    this.maxMemoryEntries = Math.max(1, Math.floor(options.maxMemoryEntries ?? 128));
    this.maxDiskEntries = Math.max(1, Math.floor(options.maxDiskEntries ?? 256));
    this.size = options.size ?? DEFAULT_THUMBNAIL_SIZE;
  }

  async generate(
    filePath: string,
    options: LibraryThumbnailGenerateOptions = {},
  ): Promise<string> {
    if (!filePath.trim()) throw new Error('Missing file path');

    const resolvedPath = path.resolve(filePath.trim());
    if (options.requestId) this.preparingRequestIds.add(options.requestId);
    let stat: ThumbnailFileStat;
    try {
      try {
        stat = await this.statFile(resolvedPath);
      } catch (error) {
        throw new LibraryThumbnailError(
          LibraryThumbnailFailureCode.SourceReadFailed,
          error instanceof Error ? error.message : 'Thumbnail source could not be read',
        );
      }
      if (options.requestId && this.canceledPreparingRequestIds.delete(options.requestId)) {
        throw new LibraryThumbnailError(
          LibraryThumbnailFailureCode.RequestCanceled,
          'Thumbnail request was canceled',
        );
      }
    } finally {
      if (options.requestId) {
        this.preparingRequestIds.delete(options.requestId);
        this.canceledPreparingRequestIds.delete(options.requestId);
      }
    }
    if (!stat.isFile()) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.SourceReadFailed,
        'Thumbnail source is not a file',
      );
    }

    const cacheKey = [
      getLibraryThumbnailCacheVersion(resolvedPath),
      resolvedPath,
      stat.mtimeMs,
      stat.size,
    ].join('\0');
    const memoryValue = this.getMemoryValue(cacheKey);
    if (memoryValue) return memoryValue;

    const priority = options.priority !== undefined
      && LIBRARY_THUMBNAIL_PRIORITY_SET.has(options.priority)
      ? options.priority
      : LibraryThumbnailRequestPriority.Background;
    const existingRequest = this.inFlight.get(cacheKey);
    if (existingRequest) {
      if (options.requestId) {
        existingRequest.requestIds.add(options.requestId);
        this.requestsById.set(options.requestId, existingRequest);
      } else {
        existingRequest.hasAnonymousConsumer = true;
      }
      if (!existingRequest.started && priority < existingRequest.priority) {
        existingRequest.priority = priority;
        this.pumpQueue();
      }
      return existingRequest.promise;
    }

    let resolveRequest: (value: string) => void = () => undefined;
    let rejectRequest: (error: unknown) => void = () => undefined;
    const promise = new Promise<string>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const request: QueuedThumbnailRequest = {
      cacheKey,
      requestIds: new Set(options.requestId ? [options.requestId] : []),
      hasAnonymousConsumer: !options.requestId,
      priority,
      sequence: this.nextSequence++,
      started: false,
      run: async () => {
        const diskValue = await this.readDiskValue(cacheKey);
        if (diskValue) return diskValue;

        const buffer = await this.createThumbnail(resolvedPath, this.size);
        if (!isValidPngBuffer(buffer)) {
          throw new LibraryThumbnailError(
            LibraryThumbnailFailureCode.DirectPngInvalid,
            'Thumbnail output is not a valid PNG',
          );
        }
        await this.writeDiskValue(cacheKey, buffer);
        return `data:image/png;base64,${buffer.toString('base64')}`;
      },
      resolve: resolveRequest,
      reject: rejectRequest,
      promise,
    };
    this.inFlight.set(cacheKey, request);
    if (options.requestId) this.requestsById.set(options.requestId, request);
    this.pendingRequests.push(request);
    this.pumpQueue();
    return promise;
  }

  cancel(requestId: string): boolean {
    const request = this.requestsById.get(requestId);
    if (!request) {
      if (!this.preparingRequestIds.has(requestId)) return false;
      this.canceledPreparingRequestIds.add(requestId);
      return true;
    }
    this.requestsById.delete(requestId);
    request.requestIds.delete(requestId);
    if (request.started || request.hasAnonymousConsumer || request.requestIds.size > 0) {
      return false;
    }

    const pendingIndex = this.pendingRequests.indexOf(request);
    if (pendingIndex >= 0) this.pendingRequests.splice(pendingIndex, 1);
    this.inFlight.delete(request.cacheKey);
    request.reject(new LibraryThumbnailError(
      LibraryThumbnailFailureCode.RequestCanceled,
      'Thumbnail request was canceled',
    ));
    return true;
  }

  private getMemoryValue(cacheKey: string): string | undefined {
    const value = this.memoryCache.get(cacheKey);
    if (!value) return undefined;
    this.memoryCache.delete(cacheKey);
    this.memoryCache.set(cacheKey, value);
    return value;
  }

  private setMemoryValue(cacheKey: string, value: string): void {
    this.memoryCache.delete(cacheKey);
    this.memoryCache.set(cacheKey, value);
    while (this.memoryCache.size > this.maxMemoryEntries) {
      const oldestKey = this.memoryCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.memoryCache.delete(oldestKey);
    }
  }

  private getDiskPath(cacheKey: string): string | undefined {
    if (!this.getCacheDirectory) return undefined;
    const digest = crypto.createHash('sha256').update(cacheKey).digest('hex');
    return path.join(this.getCacheDirectory(), `${digest}.png`);
  }

  private async readDiskValue(cacheKey: string): Promise<string | undefined> {
    const cachePath = this.getDiskPath(cacheKey);
    if (!cachePath) return undefined;
    try {
      const buffer = await fs.promises.readFile(cachePath);
      if (!isValidPngBuffer(buffer)) {
        await fs.promises.unlink(cachePath).catch((): void => {
          // A concurrently removed invalid entry needs no further handling.
        });
        return undefined;
      }
      void fs.promises.utimes(cachePath, new Date(), new Date()).catch((): void => {
        // Cache recency is best-effort.
      });
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
      return undefined;
    }
  }

  private async writeDiskValue(cacheKey: string, buffer: Buffer): Promise<void> {
    const cachePath = this.getDiskPath(cacheKey);
    if (!cachePath) return;
    const temporaryPath = `${cachePath}.${process.pid}.${this.nextTemporaryFileId++}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(temporaryPath, buffer, { flag: 'wx' });
      await fs.promises.rename(temporaryPath, cachePath);
      this.scheduleDiskPrune();
    } catch {
      void fs.promises.unlink(temporaryPath).catch((): void => {
        // Temporary files are best-effort cache state.
      });
      // A cache write failure must not prevent the thumbnail from being displayed.
    }
  }

  private scheduleDiskPrune(): void {
    if (this.diskPrunePromise || !this.getCacheDirectory) return;
    this.diskPrunePromise = this.pruneDiskCache()
      .catch((): void => {
        // Cache cleanup is best-effort.
      })
      .finally((): void => {
        this.diskPrunePromise = undefined;
      });
  }

  private async pruneDiskCache(): Promise<void> {
    const cacheDirectory = this.getCacheDirectory?.();
    if (!cacheDirectory) return;
    const entries = await fs.promises.readdir(cacheDirectory, { withFileTypes: true });
    const cacheFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.png'));
    if (cacheFiles.length <= this.maxDiskEntries) return;

    const filesWithStats = await Promise.all(cacheFiles.map(async entry => {
      const filePath = path.join(cacheDirectory, entry.name);
      const stat = await fs.promises.stat(filePath);
      return { filePath, lastUsedAt: stat.mtimeMs };
    }));
    filesWithStats.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const deleteCount = filesWithStats.length - this.maxDiskEntries;
    await Promise.all(filesWithStats.slice(0, deleteCount).map(({ filePath }) => (
      fs.promises.unlink(filePath).catch((): void => {
        // A concurrently removed cache entry needs no further handling.
      })
    )));
  }

  private pumpQueue(): void {
    while (this.activeCount < this.maxConcurrency && this.pendingRequests.length > 0) {
      this.pendingRequests.sort((left, right) => (
        left.priority - right.priority || left.sequence - right.sequence
      ));
      const request = this.pendingRequests.shift();
      if (!request) return;
      request.started = true;
      this.activeCount += 1;
      void request.run().then(dataUrl => {
        this.setMemoryValue(request.cacheKey, dataUrl);
        request.resolve(dataUrl);
      }).catch(error => {
        request.reject(error);
      }).finally(() => {
        this.activeCount -= 1;
        this.inFlight.delete(request.cacheKey);
        for (const requestId of request.requestIds) this.requestsById.delete(requestId);
        this.pumpQueue();
      });
    }
  }
}
