import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getLibraryHtmlThumbnailStampColor, HtmlThumbnailLayout, HtmlThumbnailLimits } from '../../shared/library/htmlThumbnail';
import type {
  LibraryThumbnailRenderRequest,
  LibraryThumbnailRenderResult,
} from '../../shared/library/thumbnail';
import {
  getLibraryThumbnailPresentationStampColor,
  LibraryThumbnailFailureCode,
  LibraryThumbnailPresentationStamp,
} from '../../shared/library/thumbnail';

type RenderResponseFactory = (
  request: LibraryThumbnailRenderRequest,
) => LibraryThumbnailRenderResult;

const electronMocks = vi.hoisted(() => {
  const renderResponses: RenderResponseFactory[] = [];
  const presentationFrames: Array<{
    crop: ReturnType<typeof vi.fn>;
    getSize: () => { width: number; height: number };
    isEmpty: () => boolean;
    toBitmap: () => Buffer;
    toPNG: () => Buffer;
  }> = [];
  const captureFrames: typeof presentationFrames = [];
  const windows: Array<{
    destroy: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
    webContents: {
      capturePage: ReturnType<typeof vi.fn>;
      beginFrameSubscription: ReturnType<typeof vi.fn>;
      endFrameSubscription: ReturnType<typeof vi.fn>;
      executeJavaScript: ReturnType<typeof vi.fn>;
      invalidate: ReturnType<typeof vi.fn>;
      isDestroyed: () => boolean;
      on: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
    };
  }> = [];

  const BrowserWindow = vi.fn(function FakeBrowserWindow() {
    let destroyed = false;
    let frameCallback: ((image: typeof presentationFrames[number]) => void) | undefined;
    const webContents = {
      beginFrameSubscription: vi.fn((
        _onlyDirty: boolean,
        callback: (image: typeof presentationFrames[number]) => void,
      ) => {
        frameCallback = callback;
      }),
      capturePage: vi.fn(() => Promise.resolve(captureFrames.shift())),
      endFrameSubscription: vi.fn(),
      executeJavaScript: vi.fn((script: string) => {
        if (script.includes('typeof window.renderLibraryThumbnail')) return Promise.resolve(true);
        const prefix = 'window.renderLibraryThumbnail(';
        const request = JSON.parse(script.slice(prefix.length, -1)) as LibraryThumbnailRenderRequest;
        const response = renderResponses.shift();
        if (!response) throw new Error('Missing mocked thumbnail response');
        return Promise.resolve(response(request));
      }),
      invalidate: vi.fn(() => {
        const image = presentationFrames.shift();
        if (image) queueMicrotask(() => frameCallback?.(image));
      }),
      isDestroyed: () => destroyed,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    const instance = {
      destroy: vi.fn(() => { destroyed = true; }),
      getContentSize: () => [480, 270],
      isDestroyed: () => destroyed,
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      setContentSize: vi.fn(),
      setMenu: vi.fn(),
      webContents,
    };
    windows.push(instance);
    return instance;
  });

  return { BrowserWindow, presentationFrames, captureFrames, renderResponses, windows };
});

vi.mock('electron', () => ({ BrowserWindow: electronMocks.BrowserWindow }));

import { LibraryThumbnailRenderer } from './libraryThumbnailRenderer';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);

let testDirectory: string;
let renderer: LibraryThumbnailRenderer | undefined;

beforeEach(async () => {
  electronMocks.renderResponses.length = 0;
  electronMocks.presentationFrames.length = 0;
  electronMocks.captureFrames.length = 0;
  electronMocks.windows.length = 0;
  electronMocks.BrowserWindow.mockClear();
  testDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'library-thumbnail-renderer-'));
});

afterEach(async () => {
  renderer?.dispose();
  renderer = undefined;
  await fs.promises.rm(testDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const writeRasterFile = async (fileName = 'photo.png'): Promise<string> => {
  const filePath = path.join(testDirectory, fileName);
  await fs.promises.writeFile(filePath, Buffer.from('source-image'));
  return filePath;
};

const writeMarkdownFile = async (): Promise<string> => {
  const filePath = path.join(testDirectory, 'README.md');
  await fs.promises.writeFile(filePath, '# Current document');
  return filePath;
};

const writePptxFile = async (): Promise<string> => {
  const filePath = path.join(testDirectory, 'slides.pptx');
  await fs.promises.writeFile(filePath, Buffer.from('presentation'));
  return filePath;
};

const createFrame = (
  png: Buffer,
  contentBitmap = Buffer.alloc(480 * 270 * 4),
  renderGeneration = 1,
  html = false,
  childGeneration: number | null = renderGeneration,
) => {
  const childHeight = html ? HtmlThumbnailLayout.ChildStampHeight : 0;
  const frameHeight = 270 + childHeight + LibraryThumbnailPresentationStamp.Height;
  const frameBitmap = Buffer.alloc(480 * frameHeight * 4);
  contentBitmap.copy(frameBitmap, 0, 0, 480 * 270 * 4);
  const color = getLibraryThumbnailPresentationStampColor(renderGeneration);
  for (let y = 270 + childHeight; y < frameHeight; y += 1) {
    for (let x = 0; x < 480; x += 1) {
      frameBitmap.set([color.blue, color.green, color.red, 255], ((y * 480) + x) * 4);
    }
  }
  if (html && childGeneration !== null) {
    const childColor = getLibraryHtmlThumbnailStampColor(childGeneration);
    for (let y = 270; y < 270 + childHeight; y += 1) {
      for (let x = 0; x < 480; x += 1) {
        frameBitmap.set([childColor.blue, childColor.green, childColor.red, 255], ((y * 480) + x) * 4);
      }
    }
  }
  const croppedImage = {
    getSize: () => ({ width: 480, height: 270 }),
    isEmpty: () => false,
    toBitmap: () => contentBitmap,
    toPNG: () => png,
  };
  return {
    crop: vi.fn(() => croppedImage),
    getSize: () => ({ width: 480, height: frameHeight }),
    isEmpty: () => false,
    toBitmap: () => frameBitmap,
    toPNG: () => png,
  };
};

const createVisibleBitmap = (): Buffer => {
  const bitmap = Buffer.alloc(480 * 270 * 4);
  const pixelCount = bitmap.length / 4;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const value = pixel < pixelCount / 10 ? 30 : 255;
    bitmap.set([value, value, value, 255], pixel * 4);
  }
  return bitmap;
};

const successfulDirectResponse = (
  request: LibraryThumbnailRenderRequest,
): LibraryThumbnailRenderResult => ({
  success: true,
  renderGeneration: request.renderGeneration,
  pngBase64: PNG_BYTES.toString('base64'),
  metrics: { renderDurationMs: 1 },
});

describe('LibraryThumbnailRenderer', () => {
  test.each(['darwin', 'linux'] as const)('waits for the HTML child on %s and crops the validated image', async platform => {
    const unpainted = createFrame(Buffer.from('blank'), undefined, 1, true, null);
    const current = createFrame(PNG_BYTES, Buffer.alloc(480 * 270 * 4, 255), 1, true);
    electronMocks.captureFrames.push(unpainted, current);
    electronMocks.renderResponses.push(request => ({ success: true, renderGeneration: request.renderGeneration }));
    renderer = new LibraryThumbnailRenderer({ platform, productionHtmlPath: '/tmp/thumbnail.html' });

    await expect(renderer.render(await writeRasterFile('page.html'), { width: 480, height: 270 })).resolves.toEqual(PNG_BYTES);
    const contents = electronMocks.windows[0]!.webContents;
    expect(contents.capturePage).toHaveBeenCalledTimes(2);
    expect(contents.capturePage).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 480, height: 274 },
      { stayHidden: true, stayAwake: true },
    );
    expect(unpainted.crop).not.toHaveBeenCalled();
    expect(current.crop).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0, width: 480, height: 270 });
    expect(contents.beginFrameSubscription).not.toHaveBeenCalled();
  });

  test('waits for both HTML stamps on Windows and accepts intentional white content', async () => {
    const oldChild = createFrame(Buffer.from('old'), undefined, 1, true, 0);
    const current = createFrame(PNG_BYTES, Buffer.alloc(480 * 270 * 4, 255), 1, true);
    electronMocks.presentationFrames.push(oldChild, current);
    electronMocks.renderResponses.push(request => ({ success: true, renderGeneration: request.renderGeneration }));
    renderer = new LibraryThumbnailRenderer({ platform: 'win32', productionHtmlPath: '/tmp/thumbnail.html' });
    await expect(renderer.render(await writeRasterFile('page.htm'), { width: 480, height: 270 })).resolves.toEqual(PNG_BYTES);
    expect(oldChild.crop).not.toHaveBeenCalled();
    expect(current.crop).toHaveBeenCalledTimes(1);
    expect(electronMocks.windows[0]!.webContents.capturePage).not.toHaveBeenCalled();
    expect(electronMocks.windows[0]!.webContents.endFrameSubscription).toHaveBeenCalledTimes(1);
  });

  test.each([10, HtmlThumbnailLimits.CaptureIntervalMs * 2])('bounds HTML capture waiting at %i ms and retries in a fresh window without returning unpainted output', async presentationTimeoutMs => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const success = (request: LibraryThumbnailRenderRequest) => {
      // Every poll must see an unpainted child, even if an attempt captures more than once.
      electronMocks.windows.at(-1)!.webContents.capturePage.mockResolvedValue(
        createFrame(PNG_BYTES, undefined, request.renderGeneration, true, null),
      );
      return { success: true, renderGeneration: request.renderGeneration };
    };
    electronMocks.renderResponses.push(success, success);
    renderer = new LibraryThumbnailRenderer({ platform: 'darwin', presentationTimeoutMs, productionHtmlPath: '/tmp/thumbnail.html' });
    await expect(renderer.render(await writeRasterFile('page.html'), { width: 480, height: 270 })).rejects.toMatchObject({
      code: LibraryThumbnailFailureCode.PresentationTimeout,
    });
    expect(electronMocks.windows).toHaveLength(2);
    expect(electronMocks.windows.every(window => window.isDestroyed())).toBe(true);
  });

  test('returns direct raster PNG output without capturing the shared window', async () => {
    electronMocks.renderResponses.push(successfulDirectResponse);
    renderer = new LibraryThumbnailRenderer({ productionHtmlPath: '/tmp/thumbnail.html' });

    const thumbnail = await renderer.render(await writeRasterFile(), { width: 480, height: 270 });

    expect(thumbnail).toEqual(PNG_BYTES);
    expect(electronMocks.windows).toHaveLength(1);
    expect(electronMocks.windows[0]?.webContents.capturePage).not.toHaveBeenCalled();
  });

  test('destroys the shared window and fully rerenders after a generation mismatch', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    electronMocks.renderResponses.push(
      request => ({
        success: true,
        renderGeneration: request.renderGeneration - 1,
        pngBase64: PNG_BYTES.toString('base64'),
        metrics: { renderDurationMs: 1 },
      }),
      successfulDirectResponse,
    );
    renderer = new LibraryThumbnailRenderer({ productionHtmlPath: '/tmp/thumbnail.html' });

    await expect(
      renderer.render(await writeRasterFile(), { width: 480, height: 270 }),
    ).resolves.toEqual(PNG_BYTES);

    expect(electronMocks.windows).toHaveLength(2);
    expect(electronMocks.windows[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      '[LibraryThumbnail] Retrying render in a fresh window',
      expect.objectContaining({ extension: '.png', attempt: 1 }),
    );
  });

  test('uses the second presentation frame directly on Windows without capturePage', async () => {
    const previousFramePng = Buffer.from('previous-frame');
    electronMocks.presentationFrames.push(
      createFrame(previousFramePng, undefined, 0),
      createFrame(PNG_BYTES, undefined, 1),
    );
    electronMocks.renderResponses.push(request => ({
      success: true,
      renderGeneration: request.renderGeneration,
      metrics: { renderDurationMs: 1 },
    }));
    renderer = new LibraryThumbnailRenderer({
      platform: 'win32',
      presentationTimeoutMs: 50,
      productionHtmlPath: '/tmp/thumbnail.html',
    });

    await expect(
      renderer.render(await writeMarkdownFile(), { width: 480, height: 270 }),
    ).resolves.toEqual(PNG_BYTES);

    expect(electronMocks.windows[0]?.webContents.invalidate).toHaveBeenCalledTimes(2);
    expect(electronMocks.windows[0]?.webContents.capturePage).not.toHaveBeenCalled();
  });

  test('rejects a blank Windows PPTX frame when the source first slide has content', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    electronMocks.presentationFrames.push(
      createFrame(Buffer.from('previous-frame'), undefined, 0),
      createFrame(Buffer.from('blank-frame'), undefined, 1),
      createFrame(Buffer.from('previous-frame'), undefined, 1),
      createFrame(PNG_BYTES, createVisibleBitmap(), 2),
    );
    electronMocks.renderResponses.push(
      request => ({
        success: true,
        renderGeneration: request.renderGeneration,
        metrics: {
          renderDurationMs: 1,
          slideCount: 8,
          sourceHasVisualContent: true,
          domHasVisualContent: true,
        },
      }),
      request => ({
        success: true,
        renderGeneration: request.renderGeneration,
        metrics: {
          renderDurationMs: 1,
          slideCount: 8,
          sourceHasVisualContent: true,
          domHasVisualContent: true,
        },
      }),
    );
    renderer = new LibraryThumbnailRenderer({
      platform: 'win32',
      presentationTimeoutMs: 50,
      productionHtmlPath: '/tmp/thumbnail.html',
    });

    await expect(
      renderer.render(await writePptxFile(), { width: 480, height: 270 }),
    ).resolves.toEqual(PNG_BYTES);

    expect(electronMocks.windows).toHaveLength(2);
    expect(warning).toHaveBeenCalledWith(
      '[LibraryThumbnail] Retrying render in a fresh window',
      expect.objectContaining({
        failureCode: LibraryThumbnailFailureCode.CaptureBlank,
        failureStage: 'validation',
        slideCount: 8,
      }),
    );
  });

  test('preserves an intentionally blank PPTX first slide', async () => {
    const blankPng = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from([0x04])]);
    electronMocks.presentationFrames.push(
      createFrame(Buffer.from('previous-frame'), undefined, 0),
      createFrame(blankPng, undefined, 1),
    );
    electronMocks.renderResponses.push(request => ({
      success: true,
      renderGeneration: request.renderGeneration,
      metrics: {
        renderDurationMs: 1,
        slideCount: 3,
        sourceHasVisualContent: false,
        domHasVisualContent: false,
      },
    }));
    renderer = new LibraryThumbnailRenderer({
      platform: 'win32',
      presentationTimeoutMs: 50,
      productionHtmlPath: '/tmp/thumbnail.html',
    });

    await expect(
      renderer.render(await writePptxFile(), { width: 480, height: 270 }),
    ).resolves.toEqual(blankPng);
  });

  test('rejects a blank Windows PPTX frame when only the rendered DOM confirms content', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    electronMocks.presentationFrames.push(
      createFrame(Buffer.from('previous-frame'), undefined, 0),
      createFrame(Buffer.from('blank-frame'), undefined, 1),
      createFrame(Buffer.from('previous-frame'), undefined, 1),
      createFrame(PNG_BYTES, createVisibleBitmap(), 2),
    );
    electronMocks.renderResponses.push(
      request => ({
        success: true,
        renderGeneration: request.renderGeneration,
        metrics: {
          renderDurationMs: 1,
          slideCount: 4,
          sourceHasVisualContent: false,
          domHasVisualContent: true,
        },
      }),
      request => ({
        success: true,
        renderGeneration: request.renderGeneration,
        metrics: {
          renderDurationMs: 1,
          slideCount: 4,
          sourceHasVisualContent: false,
          domHasVisualContent: true,
        },
      }),
    );
    renderer = new LibraryThumbnailRenderer({
      platform: 'win32',
      presentationTimeoutMs: 50,
      productionHtmlPath: '/tmp/thumbnail.html',
    });

    await expect(
      renderer.render(await writePptxFile(), { width: 480, height: 270 }),
    ).resolves.toEqual(PNG_BYTES);

    expect(electronMocks.windows).toHaveLength(2);
    expect(warning).toHaveBeenCalledWith(
      '[LibraryThumbnail] Retrying render in a fresh window',
      expect.objectContaining({
        failureCode: LibraryThumbnailFailureCode.CaptureBlank,
        failureStage: 'validation',
      }),
    );
  });

  test('keeps alternating raster and document thumbnails bound to their own request', async () => {
    const documentPng = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from([0x02])]);
    const finalImagePng = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from([0x03])]);
    electronMocks.presentationFrames.push(
      createFrame(PNG_BYTES, undefined, 1),
      createFrame(documentPng, undefined, 2),
    );
    electronMocks.renderResponses.push(
      successfulDirectResponse,
      request => ({
        success: true,
        renderGeneration: request.renderGeneration,
        metrics: { renderDurationMs: 1 },
      }),
      request => ({
        success: true,
        renderGeneration: request.renderGeneration,
        pngBase64: finalImagePng.toString('base64'),
        metrics: { renderDurationMs: 1 },
      }),
    );
    renderer = new LibraryThumbnailRenderer({
      platform: 'win32',
      presentationTimeoutMs: 50,
      productionHtmlPath: '/tmp/thumbnail.html',
    });

    const firstImage = await renderer.render(
      await writeRasterFile('first.png'),
      { width: 480, height: 270 },
    );
    const document = await renderer.render(
      await writeMarkdownFile(),
      { width: 480, height: 270 },
    );
    const finalImage = await renderer.render(
      await writeRasterFile('final.png'),
      { width: 480, height: 270 },
    );

    expect([firstImage, document, finalImage]).toEqual([
      PNG_BYTES,
      documentPng,
      finalImagePng,
    ]);
    expect(electronMocks.windows).toHaveLength(1);
    expect(electronMocks.windows[0]?.webContents.capturePage).not.toHaveBeenCalled();
  });
});
