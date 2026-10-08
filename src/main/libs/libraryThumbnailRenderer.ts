import { BrowserWindow, type NativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  HtmlThumbnailLayout,
  isLibraryHtmlThumbnailExtension,
} from '../../shared/library/htmlThumbnail';
import {
  createLibraryThumbnailRenderRequest,
  getLibraryThumbnailFailureDetails,
  isLibraryDirectPngThumbnailExtension,
  isLibraryThumbnailFailureRetryable,
  LibraryThumbnailError,
  LibraryThumbnailFailureCode,
  type LibraryThumbnailFailureCodeType,
  LibraryThumbnailLimits,
  LibraryThumbnailPresentationStamp,
  type LibraryThumbnailRenderMetrics,
  type LibraryThumbnailRenderResult,
  withLibraryThumbnailErrorMetrics,
} from '../../shared/library/thumbnail';
import {
  hasLibraryThumbnailPresentationStamp,
  type LibraryThumbnailPresentationExpectation,
} from './libraryThumbnailPresentation';
import { isLikelyBlankThumbnailBitmap } from './libraryThumbnailValidation';

interface ThumbnailSize {
  width: number;
  height: number;
}

interface LibraryThumbnailRendererOptions {
  developmentServerUrl?: string;
  productionHtmlPath: string;
  maxSourceBytes?: number;
  renderTimeoutMs?: number;
  captureTimeoutMs?: number;
  presentationTimeoutMs?: number;
}

const LIBRARY_THUMBNAIL_PARTITION = 'library-thumbnail-renderer';
const SLOW_RENDER_THRESHOLD_MS = 4_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isRenderResult = (value: unknown): value is LibraryThumbnailRenderResult => (
  typeof value === 'object'
  && value !== null
  && typeof (value as LibraryThumbnailRenderResult).success === 'boolean'
);

/**
 * Captured pages are 1x bitmaps in physical pixels, so on HiDPI displays the
 * thumbnail rectangle must be scaled before cropping and the result brought
 * back to the requested size.
 */
const cropPresentedThumbnail = (image: NativeImage, size: ThumbnailSize): NativeImage => {
  const captured = image.getSize();
  const scale = captured.width > 0 ? captured.width / size.width : 1;
  const cropped = image.crop({
    x: 0,
    y: 0,
    width: Math.min(captured.width, Math.round(size.width * scale)),
    height: Math.min(captured.height, Math.round(size.height * scale)),
  });
  if (scale <= 1) return cropped;
  return cropped.resize({ width: size.width, height: size.height, quality: 'best' });
};

export class LibraryThumbnailRenderer {
  private readonly developmentServerUrl?: string;
  private readonly productionHtmlPath: string;
  private readonly maxSourceBytes: number;
  private readonly renderTimeoutMs: number;
  private readonly captureTimeoutMs: number;
  private readonly presentationTimeoutMs: number;
  private window?: BrowserWindow;
  private renderGeneration = 0;

  constructor(options: LibraryThumbnailRendererOptions) {
    this.developmentServerUrl = options.developmentServerUrl;
    this.productionHtmlPath = options.productionHtmlPath;
    this.maxSourceBytes = options.maxSourceBytes ?? LibraryThumbnailLimits.MaxSourceBytes;
    this.renderTimeoutMs = options.renderTimeoutMs ?? LibraryThumbnailLimits.RenderTimeoutMs;
    this.captureTimeoutMs = options.captureTimeoutMs ?? LibraryThumbnailLimits.CaptureTimeoutMs;
    this.presentationTimeoutMs = options.presentationTimeoutMs
      ?? LibraryThumbnailLimits.PresentationTimeoutMs;
  }

  render(filePath: string, size: ThumbnailSize): Promise<Buffer> {
    return this.renderWithRecovery(filePath, size);
  }

  dispose(): void {
    this.destroyCurrentWindow();
  }

  private async renderWithRecovery(filePath: string, size: ThumbnailSize): Promise<Buffer> {
    let lastError: unknown;
    const extension = path.extname(filePath).toLowerCase();
    for (let attempt = 1; attempt <= LibraryThumbnailLimits.MaxRenderAttempts; attempt += 1) {
      try {
        return await this.renderNow(filePath, size);
      } catch (error) {
        lastError = error;
        this.destroyCurrentWindow();
        const failure = getLibraryThumbnailFailureDetails(
          error,
          LibraryThumbnailFailureCode.RendererFailed,
        );
        if (
          attempt < LibraryThumbnailLimits.MaxRenderAttempts
          && isLibraryThumbnailFailureRetryable(failure.code)
        ) {
          console.warn('[LibraryThumbnail] Retrying render in a fresh window', {
            extension,
            attempt,
            strategy: isLibraryDirectPngThumbnailExtension(extension)
              ? 'direct-canvas'
              : 'isolated-presentation',
            failureCode: failure.code,
            failureStage: failure.stage,
            sourceSizeBytes: failure.metrics?.sourceSizeBytes,
            slideCount: failure.metrics?.slideCount,
            imageCount: failure.metrics?.imageCount,
          });
          continue;
        }
        break;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new LibraryThumbnailError(
      LibraryThumbnailFailureCode.RendererFailed,
      'Thumbnail rendering failed',
    );
  }

  private async renderNow(filePath: string, size: ThumbnailSize): Promise<Buffer> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.SourceReadFailed,
        error instanceof Error ? error.message : 'Thumbnail source could not be read',
      );
    }
    if (stat.size > this.maxSourceBytes) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.SourceTooLarge,
        'File is too large for thumbnail rendering',
        { sourceSizeBytes: stat.size },
      );
    }

    let content: Buffer;
    try {
      content = await fs.promises.readFile(filePath);
    } catch (error) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.SourceReadFailed,
        error instanceof Error ? error.message : 'Thumbnail source could not be read',
        { sourceSizeBytes: stat.size },
      );
    }
    this.renderGeneration += 1;
    const request = createLibraryThumbnailRenderRequest(
      path.basename(filePath),
      content.toString('base64'),
      size.width,
      size.height,
      this.renderGeneration,
    );
    if (!request) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.UnsupportedFormat,
        'Unsupported thumbnail format',
        { sourceSizeBytes: stat.size },
      );
    }

    let rendererWindow: BrowserWindow;
    try {
      rendererWindow = await this.ensureWindow(size);
    } catch (error) {
      throw withLibraryThumbnailErrorMetrics(
        error,
        LibraryThumbnailFailureCode.RendererFailed,
        { sourceSizeBytes: stat.size },
      );
    }
    const windowHeight = size.height + LibraryThumbnailPresentationStamp.Height
      + (isLibraryHtmlThumbnailExtension(request.extension) ? HtmlThumbnailLayout.ChildStampHeight : 0);
    const [currentWidth, currentHeight] = rendererWindow.getContentSize();
    if (currentWidth !== size.width || currentHeight !== windowHeight) {
      rendererWindow.setContentSize(size.width, windowHeight, false);
    }

    const script = `window.renderLibraryThumbnail(${JSON.stringify(request)})`;
    let result: unknown;
    try {
      result = await this.withTimeout(
        rendererWindow.webContents.executeJavaScript(script, true),
        this.renderTimeoutMs,
        LibraryThumbnailFailureCode.RendererTimeout,
        'Thumbnail rendering timed out',
      );
    } catch (error) {
      throw withLibraryThumbnailErrorMetrics(
        error,
        LibraryThumbnailFailureCode.RendererFailed,
        { sourceSizeBytes: stat.size },
      );
    }
    if (!isRenderResult(result)) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.RendererResponseInvalid,
        'Invalid thumbnail renderer response',
        { sourceSizeBytes: stat.size },
      );
    }
    if (result.renderGeneration !== request.renderGeneration) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.RenderGenerationMismatch,
        'Thumbnail renderer generation mismatch',
        { sourceSizeBytes: stat.size, ...result.metrics },
      );
    }
    if (!result.success) {
      throw new LibraryThumbnailError(
        result.failureCode ?? LibraryThumbnailFailureCode.RendererFailed,
        result.error || 'Thumbnail rendering failed',
        { sourceSizeBytes: stat.size, ...result.metrics },
      );
    }
    const metrics: LibraryThumbnailRenderMetrics = {
      renderDurationMs: result.metrics?.renderDurationMs ?? 0,
      sourceSizeBytes: stat.size,
      ...result.metrics,
    };
    if (metrics.renderDurationMs >= SLOW_RENDER_THRESHOLD_MS) {
      console.warn('[LibraryThumbnail] Slow renderer completion', {
        extension: request.extension,
        renderGeneration: request.renderGeneration,
        strategy: result.pngBase64 ? 'direct-canvas' : 'isolated-presentation',
        renderDurationMs: metrics.renderDurationMs,
        sourceSizeBytes: metrics.sourceSizeBytes,
        slideCount: metrics.slideCount,
        imageCount: metrics.imageCount,
      });
    }

    if (result.pngBase64 !== undefined) {
      if (!isLibraryDirectPngThumbnailExtension(request.extension)) {
        throw new LibraryThumbnailError(
          LibraryThumbnailFailureCode.RendererResponseInvalid,
          'Unexpected direct thumbnail output',
          metrics,
        );
      }
      return this.decodeDirectPng(result.pngBase64, metrics);
    }

    return this.captureRenderedPage(
      rendererWindow,
      size,
      request.extension,
      request.renderGeneration,
      metrics,
    );
  }

  private async captureRenderedPage(
    rendererWindow: BrowserWindow,
    size: ThumbnailSize,
    extension: string,
    renderGeneration: number,
    metrics?: LibraryThumbnailRenderMetrics,
  ): Promise<Buffer> {
    const expectation: LibraryThumbnailPresentationExpectation = {
      width: size.width,
      height: size.height,
      renderGeneration,
      html: isLibraryHtmlThumbnailExtension(extension),
    };
    let image: NativeImage;
    try {
      // Validate and crop the very same image; a second capture would reintroduce the race.
      const presentedImage = await this.capturePresentedPage(rendererWindow, expectation);
      image = cropPresentedThumbnail(presentedImage, size);
    } catch (error) {
      throw withLibraryThumbnailErrorMetrics(
        error,
        LibraryThumbnailFailureCode.PresentationFailed,
        metrics ?? {},
      );
    }
    const capturedSize = image.getSize();
    if (image.isEmpty() || capturedSize.width <= 0 || capturedSize.height <= 0) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.CaptureEmpty,
        'Thumbnail capture is empty',
        metrics,
      );
    }
    const hasExpectedVisualContent = metrics?.sourceHasVisualContent === true
      || metrics?.domHasVisualContent === true
      || (
        metrics?.sourceHasVisualContent === undefined
        && metrics?.domHasVisualContent === undefined
        && metrics?.hasVisualContent === true
      );
    if (
      extension === '.pptx'
      && hasExpectedVisualContent
      && isLikelyBlankThumbnailBitmap(image.toBitmap())
    ) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.CaptureBlank,
        'Thumbnail capture is visually blank',
        metrics,
      );
    }
    const png = image.toPNG();
    if (png.length === 0) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.CaptureEmpty,
        'Thumbnail PNG is empty',
        metrics,
      );
    }
    return png;
  }

  /**
   * Poll capturePage until the frame carries the current generation stamps.
   * A hidden window does not repaint on demand: a frame subscription only
   * delivers the snapshot taken when it starts and invalidate() never yields
   * another frame, whereas every capturePage call copies the current surface.
   */
  private async capturePresentedPage(
    rendererWindow: BrowserWindow,
    expectation: LibraryThumbnailPresentationExpectation,
  ): Promise<NativeImage> {
    const captureHeight = expectation.height
      + (expectation.html ? HtmlThumbnailLayout.ChildStampHeight : 0)
      + LibraryThumbnailPresentationStamp.Height;
    const deadline = Date.now() + this.presentationTimeoutMs;
    while (Date.now() < deadline) {
      rendererWindow.webContents.invalidate();
      const image = await this.withTimeout(
        rendererWindow.webContents.capturePage({
          x: 0,
          y: 0,
          width: expectation.width,
          height: captureHeight,
        }, { stayHidden: true, stayAwake: true }),
        Math.max(1, Math.min(this.captureTimeoutMs, deadline - Date.now())),
        LibraryThumbnailFailureCode.PresentationTimeout,
        'Thumbnail presentation timed out',
      );
      if (hasLibraryThumbnailPresentationStamp(image, expectation)) return image;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(
          resolve,
          Math.min(LibraryThumbnailLimits.PresentationPollIntervalMs, remaining),
        ));
      }
    }
    throw new LibraryThumbnailError(
      LibraryThumbnailFailureCode.PresentationTimeout,
      'Thumbnail presentation timed out',
    );
  }

  private decodeDirectPng(
    pngBase64: string,
    metrics: LibraryThumbnailRenderMetrics,
  ): Buffer {
    if (!pngBase64.trim()) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.DirectPngInvalid,
        'Direct thumbnail output is empty',
        metrics,
      );
    }
    const png = Buffer.from(pngBase64, 'base64');
    if (png.length <= PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new LibraryThumbnailError(
        LibraryThumbnailFailureCode.DirectPngInvalid,
        'Direct thumbnail output is not a PNG',
        metrics,
      );
    }
    return png;
  }

  private async ensureWindow(size: ThumbnailSize): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const rendererWindow = new BrowserWindow({
      width: size.width,
      height: size.height + LibraryThumbnailPresentationStamp.Height,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#F5F6F8',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: LIBRARY_THUMBNAIL_PARTITION,
        backgroundThrottling: false,
        devTools: false,
        spellcheck: false,
        enableWebSQL: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    rendererWindow.setMenu(null);
    rendererWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    rendererWindow.webContents.on('will-navigate', event => {
      event.preventDefault();
    });
    rendererWindow.webContents.on('render-process-gone', () => {
      this.resetWindow(rendererWindow);
    });
    rendererWindow.on('closed', () => {
      if (this.window === rendererWindow) this.window = undefined;
    });

    try {
      if (this.developmentServerUrl) {
        const rendererUrl = new URL('/library-thumbnail.html', this.developmentServerUrl);
        await rendererWindow.loadURL(rendererUrl.href);
      } else {
        await rendererWindow.loadFile(this.productionHtmlPath);
      }
      const isReady = await rendererWindow.webContents.executeJavaScript(
        'typeof window.renderLibraryThumbnail === "function"',
        true,
      );
      if (isReady !== true) {
        throw new LibraryThumbnailError(
          LibraryThumbnailFailureCode.RendererFailed,
          'Thumbnail renderer did not initialize',
        );
      }
      this.window = rendererWindow;
      return rendererWindow;
    } catch (error) {
      rendererWindow.destroy();
      throw error;
    }
  }

  private resetWindow(rendererWindow: BrowserWindow): void {
    if (!rendererWindow.isDestroyed()) rendererWindow.destroy();
    if (this.window === rendererWindow) this.window = undefined;
  }

  private destroyCurrentWindow(): void {
    const rendererWindow = this.window;
    this.window = undefined;
    if (rendererWindow && !rendererWindow.isDestroyed()) rendererWindow.destroy();
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    failureCode: LibraryThumbnailFailureCodeType,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(
            new LibraryThumbnailError(failureCode, message),
          ), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
