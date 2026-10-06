import type { NativeImage } from 'electron';

import { getLibraryHtmlThumbnailStampColor, HtmlThumbnailLayout } from '../../shared/library/htmlThumbnail';
import {
  getLibraryThumbnailPresentationStampColor,
  LibraryThumbnailPresentationStamp,
} from '../../shared/library/thumbnail';

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
