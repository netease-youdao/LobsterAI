import type { NativeImage, Rectangle } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import {
  getLibraryHtmlThumbnailStampColor,
  HtmlThumbnailLayout,
} from '../../shared/library/htmlThumbnail';
import {
  getLibraryThumbnailPresentationStampColor,
  LibraryThumbnailFailureCode,
  LibraryThumbnailPresentationStamp,
} from '../../shared/library/thumbnail';
import {
  hasLibraryThumbnailPresentationStamp,
  waitForCommittedThumbnailPresentation,
} from './libraryThumbnailPresentation';

const createWebContents = (frames: NativeImage[]) => {
  let callback: ((image: NativeImage, dirtyRect: Rectangle) => void) | undefined;
  const endFrameSubscription = vi.fn();
  const invalidate = vi.fn(() => {
    const image = frames.shift();
    if (image) {
      queueMicrotask(() => callback?.(image, {
        x: 0,
        y: 0,
        width: 480,
        height: 270,
      }));
    }
  });
  return {
    beginFrameSubscription: vi.fn((
      _onlyDirty: boolean,
      nextCallback: (image: NativeImage, dirtyRect: Rectangle) => void,
    ) => {
      callback = nextCallback;
    }),
    endFrameSubscription,
    invalidate,
    isDestroyed: () => false,
  };
};

const createStampedImage = (
  renderGeneration: number,
  scale = 1,
  reportPhysicalSize = false,
): NativeImage => {
  const width = 480;
  const height = 270 + LibraryThumbnailPresentationStamp.Height;
  const bitmapWidth = Math.round(width * scale);
  const bitmapHeight = Math.round(height * scale);
  const stampStartY = Math.round(270 * scale);
  const bitmap = Buffer.alloc(bitmapWidth * bitmapHeight * 4);
  const color = getLibraryThumbnailPresentationStampColor(renderGeneration);
  for (let y = stampStartY; y < bitmapHeight; y += 1) {
    for (let x = 0; x < bitmapWidth; x += 1) {
      bitmap.set(
        [color.blue, color.green, color.red, 255],
        ((y * bitmapWidth) + x) * 4,
      );
    }
  }
  return {
    getSize: () => reportPhysicalSize
      ? { width: bitmapWidth, height: bitmapHeight }
      : { width, height },
    toBitmap: () => bitmap,
  } as unknown as NativeImage;
};

const createHtmlStampedImage = ({
  parentGeneration,
  childGeneration,
  scale = 1,
  reportPhysicalSize = false,
}: {
  parentGeneration?: number;
  childGeneration?: number;
  scale?: number;
  reportPhysicalSize?: boolean;
}): NativeImage => {
  const width = 480;
  const contentHeight = 270;
  const height = contentHeight + HtmlThumbnailLayout.ChildStampHeight
    + LibraryThumbnailPresentationStamp.Height;
  const bitmapWidth = Math.round(width * scale);
  const bitmapHeight = Math.round(height * scale);
  const bitmap = Buffer.alloc(bitmapWidth * bitmapHeight * 4, 255);
  const drawStamp = (
    top: number,
    stampHeight: number,
    color: { red: number; green: number; blue: number },
  ): void => {
    for (let y = Math.round(top * scale); y < Math.round((top + stampHeight) * scale); y += 1) {
      for (let x = 0; x < bitmapWidth; x += 1) {
        bitmap.set(
          [color.blue, color.green, color.red, 255],
          ((y * bitmapWidth) + x) * 4,
        );
      }
    }
  };
  if (childGeneration !== undefined) {
    drawStamp(
      contentHeight,
      HtmlThumbnailLayout.ChildStampHeight,
      getLibraryHtmlThumbnailStampColor(childGeneration),
    );
  }
  if (parentGeneration !== undefined) {
    drawStamp(
      contentHeight + HtmlThumbnailLayout.ChildStampHeight,
      LibraryThumbnailPresentationStamp.Height,
      getLibraryThumbnailPresentationStampColor(parentGeneration),
    );
  }
  return {
    getSize: () => reportPhysicalSize
      ? { width: bitmapWidth, height: bitmapHeight }
      : { width, height },
    toBitmap: () => bitmap,
  } as unknown as NativeImage;
};

describe('library thumbnail presentation barrier', () => {
  test('ignores the first frame and returns the frame committed after a second repaint', async () => {
    const firstFrame = { frame: 'previous' } as unknown as NativeImage;
    const committedFrame = { frame: 'current' } as unknown as NativeImage;
    const webContents = createWebContents([firstFrame, committedFrame]);

    await expect(waitForCommittedThumbnailPresentation(webContents, 50)).resolves.toBe(
      committedFrame,
    );

    expect(webContents.beginFrameSubscription).toHaveBeenCalledWith(false, expect.any(Function));
    expect(webContents.invalidate).toHaveBeenCalledTimes(2);
    expect(webContents.endFrameSubscription).toHaveBeenCalledTimes(1);
  });

  test('ends the frame subscription when presentation times out', async () => {
    const webContents = createWebContents([]);

    const presentation = waitForCommittedThumbnailPresentation(webContents, 5);
    await expect(presentation).rejects.toThrow('Thumbnail presentation timed out');
    await expect(presentation).rejects.toMatchObject({
      code: LibraryThumbnailFailureCode.PresentationTimeout,
    });

    expect(webContents.endFrameSubscription).toHaveBeenCalledTimes(1);
  });

  test('waits until the frame carries the current render generation stamp', async () => {
    const previousFrame = createStampedImage(41);
    const committedFrame = createStampedImage(42);
    const expectation = { width: 480, height: 270, renderGeneration: 42 };
    const webContents = createWebContents([previousFrame, committedFrame]);

    expect(hasLibraryThumbnailPresentationStamp(previousFrame, expectation)).toBe(false);
    expect(hasLibraryThumbnailPresentationStamp(committedFrame, expectation)).toBe(true);
    await expect(
      waitForCommittedThumbnailPresentation(webContents, 50, expectation),
    ).resolves.toBe(committedFrame);
    expect(webContents.invalidate).toHaveBeenCalledTimes(2);
  });

  test.each([1, 1.25, 1.5])(
    'recognizes the current frame stamp at %sx display scale',
    scale => {
      const expectation = { width: 480, height: 270, renderGeneration: 9 };
      expect(hasLibraryThumbnailPresentationStamp(
        createStampedImage(9, scale),
        expectation,
      )).toBe(true);
      expect(hasLibraryThumbnailPresentationStamp(
        createStampedImage(8, scale),
        expectation,
      )).toBe(false);
    },
  );

  test('recognizes a scaled frame when NativeImage reports physical dimensions', () => {
    const expectation = { width: 480, height: 270, renderGeneration: 9 };
    expect(hasLibraryThumbnailPresentationStamp(
      createStampedImage(9, 1.25, true),
      expectation,
    )).toBe(true);
  });

  test('does not accept an HTML parent frame before its child frame has presented', () => {
    const expectation = { width: 480, height: 270, renderGeneration: 42, html: true };
    const parentOnly = createHtmlStampedImage({ parentGeneration: 42 });

    expect(hasLibraryThumbnailPresentationStamp(parentOnly, expectation)).toBe(false);
  });

  test.each([
    { parentGeneration: 42, childGeneration: 41 },
    { parentGeneration: 41, childGeneration: 42 },
    { parentGeneration: undefined, childGeneration: 42 },
  ])('requires both HTML stamps to belong to the current generation: %j', generations => {
    const expectation = { width: 480, height: 270, renderGeneration: 42, html: true };

    expect(hasLibraryThumbnailPresentationStamp(
      createHtmlStampedImage(generations),
      expectation,
    )).toBe(false);
  });

  test('accepts a legitimate white HTML page when both generation stamps have presented', () => {
    const expectation = { width: 480, height: 270, renderGeneration: 42, html: true };
    const image = createHtmlStampedImage({ parentGeneration: 42, childGeneration: 42 });

    expect(image.toBitmap().subarray(0, 480 * 270 * 4).every(value => value === 255)).toBe(true);
    expect(hasLibraryThumbnailPresentationStamp(image, expectation)).toBe(true);
  });

  test('returns the exact frame carrying both HTML stamps, not separate parent and child frames', async () => {
    const expectation = { width: 480, height: 270, renderGeneration: 42, html: true };
    const parentOnly = createHtmlStampedImage({ parentGeneration: 42 });
    const childOnly = createHtmlStampedImage({ childGeneration: 42 });
    const staleChild = createHtmlStampedImage({ parentGeneration: 42, childGeneration: 41 });
    const committedFrame = createHtmlStampedImage({ parentGeneration: 42, childGeneration: 42 });
    const webContents = createWebContents([parentOnly, childOnly, staleChild, committedFrame]);

    await expect(
      waitForCommittedThumbnailPresentation(webContents, 50, expectation),
    ).resolves.toBe(committedFrame);

    expect(webContents.invalidate).toHaveBeenCalledTimes(4);
    expect(webContents.endFrameSubscription).toHaveBeenCalledTimes(1);
  });

  test.each([1, 1.25, 1.5, 1.75, 2])(
    'recognizes both HTML stamps at %sx display scale with logical or physical reported dimensions',
    scale => {
      const expectation = { width: 480, height: 270, renderGeneration: 9, html: true };
      for (const reportPhysicalSize of [false, true]) {
        expect(hasLibraryThumbnailPresentationStamp(createHtmlStampedImage({
          parentGeneration: 9,
          childGeneration: 9,
          scale,
          reportPhysicalSize,
        }), expectation)).toBe(true);
        expect(hasLibraryThumbnailPresentationStamp(createHtmlStampedImage({
          parentGeneration: 9,
          childGeneration: 8,
          scale,
          reportPhysicalSize,
        }), expectation)).toBe(false);
      }
    },
  );

  test('rejects a legacy single-stamp frame for HTML while preserving non-HTML behavior', () => {
    const expectation = { width: 480, height: 270, renderGeneration: 42 };
    const legacyFrame = createStampedImage(42);

    expect(hasLibraryThumbnailPresentationStamp(legacyFrame, { ...expectation, html: true })).toBe(false);
    expect(hasLibraryThumbnailPresentationStamp(legacyFrame, expectation)).toBe(true);
    expect(hasLibraryThumbnailPresentationStamp(legacyFrame, { ...expectation, html: false })).toBe(true);
  });

  test('requires the child marker to cover every sampled horizontal position', () => {
    const expectation = { width: 480, height: 270, renderGeneration: 42, html: true };
    const image = createHtmlStampedImage({ parentGeneration: 42, childGeneration: 42 });
    const sampleOffset = ((271 * 480) + 240) * 4;
    image.toBitmap().fill(255, sampleOffset, sampleOffset + 4);

    expect(hasLibraryThumbnailPresentationStamp(image, expectation)).toBe(false);
  });

  test('times out and unsubscribes if the HTML child marker never presents', async () => {
    const expectation = { width: 480, height: 270, renderGeneration: 42, html: true };
    const webContents = createWebContents([
      createHtmlStampedImage({ parentGeneration: 42 }),
      createHtmlStampedImage({ parentGeneration: 42, childGeneration: 41 }),
    ]);

    await expect(waitForCommittedThumbnailPresentation(webContents, 5, expectation)).rejects.toMatchObject({
      code: LibraryThumbnailFailureCode.PresentationTimeout,
    });
    expect(webContents.endFrameSubscription).toHaveBeenCalledTimes(1);
  });
});
