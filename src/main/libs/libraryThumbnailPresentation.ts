import type { NativeImage, Rectangle } from 'electron';

import { getLibraryHtmlThumbnailStampColor, HtmlThumbnailLayout } from '../../shared/library/htmlThumbnail';
import {
  getLibraryThumbnailPresentationStampColor,
  LibraryThumbnailError,
  LibraryThumbnailFailureCode,
  LibraryThumbnailPresentationStamp,
} from '../../shared/library/thumbnail';

interface ThumbnailPresentationWebContents {
  beginFrameSubscription: (
    onlyDirty: boolean,
    callback: (image: NativeImage, dirtyRect: Rectangle) => void,
  ) => void;
  endFrameSubscription: () => void;
  invalidate: () => void;
  isDestroyed: () => boolean;
}

export interface LibraryThumbnailPresentationExpectation {
  width: number;
  height: number;
  renderGeneration: number;
  html?: boolean;
}

const isWithinTolerance = (actual: number, expected: number): boolean => (
  Math.abs(actual - expected) <= LibraryThumbnailPresentationStamp.ColorTolerance
);

export const hasLibraryThumbnailPresentationStamp = (
  image: NativeImage,
  expectation: LibraryThumbnailPresentationExpectation,
): boolean => {
  const size = image.getSize();
  const childStampHeight = expectation.html ? HtmlThumbnailLayout.ChildStampHeight : 0;
  const expectedHeight = expectation.height + childStampHeight + LibraryThumbnailPresentationStamp.Height;
  if (size.width < expectation.width || size.height < expectedHeight) return false;
  const bitmap = image.toBitmap();
  if (bitmap.length % 4 !== 0) return false;
  const pixelCount = bitmap.length / 4;
  const expectedAspectRatio = expectation.width / expectedHeight;
  const bitmapWidth = Math.round(Math.sqrt(pixelCount * expectedAspectRatio));
  const bitmapHeight = Math.round(pixelCount / bitmapWidth);
  if (bitmapWidth * bitmapHeight !== pixelCount) return false;
  const horizontalScale = bitmapWidth / expectation.width;
  const verticalScale = bitmapHeight / expectedHeight;
  if (
    horizontalScale < 1
    || verticalScale < 1
    || Math.abs(horizontalScale - verticalScale) > 0.05
  ) return false;
  const matchesStamp = (top: number, height: number, color: { red: number; green: number; blue: number }): boolean => {
    const stampStartY = Math.round(top * verticalScale);
    const stampPixelHeight = Math.max(
      1,
      Math.round(height * verticalScale),
    );
    const sampleY = Math.min(bitmapHeight - 1, stampStartY + Math.floor(stampPixelHeight / 2));
    const sampleXs = [0.2, 0.5, 0.8].map(ratio => (
      Math.min(bitmapWidth - 1, Math.floor(expectation.width * horizontalScale * ratio))
    ));
    return sampleXs.every(sampleX => {
      const offset = ((sampleY * bitmapWidth) + sampleX) * 4;
      return isWithinTolerance(bitmap[offset] ?? -1, color.blue)
        && isWithinTolerance(bitmap[offset + 1] ?? -1, color.green)
        && isWithinTolerance(bitmap[offset + 2] ?? -1, color.red);
    });
  };
  return matchesStamp(
    expectation.height + childStampHeight,
    LibraryThumbnailPresentationStamp.Height,
    getLibraryThumbnailPresentationStampColor(expectation.renderGeneration),
  ) && (!expectation.html || matchesStamp(
    expectation.height,
    childStampHeight,
    getLibraryHtmlThumbnailStampColor(expectation.renderGeneration),
  ));
};

export const waitForCommittedThumbnailPresentation = (
  webContents: ThumbnailPresentationWebContents,
  timeoutMs: number,
  expectation?: LibraryThumbnailPresentationExpectation,
): Promise<NativeImage> => new Promise((resolve, reject) => {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let presentedFrameCount = 0;

  const finish = (error?: Error, image?: NativeImage): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (!webContents.isDestroyed()) {
      try {
        webContents.endFrameSubscription();
      } catch {
        // The renderer can disappear while a frame is being delivered.
      }
    }
    if (error) reject(error);
    else if (image) resolve(image);
    else reject(new LibraryThumbnailError(
      LibraryThumbnailFailureCode.PresentationFailed,
      'Thumbnail presentation did not provide a frame',
    ));
  };

  timer = setTimeout(() => {
    finish(new LibraryThumbnailError(
      LibraryThumbnailFailureCode.PresentationTimeout,
      'Thumbnail presentation timed out',
    ));
  }, timeoutMs);

  try {
    webContents.beginFrameSubscription(false, image => {
      if (settled) return;
      if (expectation) {
        if (hasLibraryThumbnailPresentationStamp(image, expectation)) {
          finish(undefined, image);
          return;
        }
        try {
          webContents.invalidate();
        } catch (error) {
          finish(new LibraryThumbnailError(
            LibraryThumbnailFailureCode.PresentationFailed,
            error instanceof Error ? error.message : 'Thumbnail repaint failed',
          ));
        }
        return;
      }
      presentedFrameCount += 1;
      if (presentedFrameCount === 1) {
        try {
          webContents.invalidate();
        } catch (error) {
          finish(new LibraryThumbnailError(
            LibraryThumbnailFailureCode.PresentationFailed,
            error instanceof Error ? error.message : 'Thumbnail repaint failed',
          ));
        }
        return;
      }
      finish(undefined, image);
    });
    webContents.invalidate();
  } catch (error) {
    finish(new LibraryThumbnailError(
      LibraryThumbnailFailureCode.PresentationFailed,
      error instanceof Error ? error.message : 'Thumbnail presentation failed',
    ));
  }
});
