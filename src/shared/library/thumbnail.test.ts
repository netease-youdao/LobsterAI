import { describe, expect, test } from 'vitest';

import { LibraryArtifactType } from './constants';
import {
  createLibraryThumbnailRenderRequest,
  getLibraryThumbnailFailureDetails,
  isLibraryDirectPngThumbnailExtension,
  isLibraryRasterThumbnailExtension,
  isLibraryThumbnailFailureRetryable,
  LibraryThumbnailDimensions,
  LibraryThumbnailError,
  LibraryThumbnailFailureCode,
  LibraryThumbnailFailureStage,
} from './thumbnail';

describe('library thumbnail render request', () => {
  test.each([
    ['report.docx', '.docx', LibraryArtifactType.Document],
    ['report.PDF', '.pdf', LibraryArtifactType.Document],
    ['sheet.xlsx', '.xlsx', LibraryArtifactType.Document],
    ['deck.pptx', '.pptx', LibraryArtifactType.Document],
    ['page.html', '.html', LibraryArtifactType.Html],
    ['photo.png', '.png', LibraryArtifactType.Image],
    ['clip.mp4', '.mp4', LibraryArtifactType.Video],
  ])('builds a renderer request for %s', (fileName, extension, artifactType) => {
    expect(createLibraryThumbnailRenderRequest(fileName, 'YWJj')).toEqual({
      fileName,
      extension,
      artifactType,
      contentBase64: 'YWJj',
      width: LibraryThumbnailDimensions.Width,
      height: LibraryThumbnailDimensions.Height,
      renderGeneration: 0,
    });
  });

  test('rejects files outside the previewable library policy', () => {
    expect(createLibraryThumbnailRenderRequest('archive.zip', 'YWJj')).toBeNull();
    expect(createLibraryThumbnailRenderRequest('README', 'YWJj')).toBeNull();
  });

  test('preserves an explicitly requested capture size', () => {
    const request = createLibraryThumbnailRenderRequest('photo.jpg', 'YWJj', 320, 180, 42);

    expect(request).toMatchObject({ width: 320, height: 180, renderGeneration: 42 });
  });

  test.each(['.png', '.JPG', '.jpeg', '.gif', '.webp', '.bmp', '.avif'])(
    'routes %s through direct raster thumbnail rendering',
    extension => {
      expect(isLibraryRasterThumbnailExtension(extension)).toBe(true);
    },
  );

  test('keeps SVG out of the raster-only source policy', () => {
    expect(isLibraryRasterThumbnailExtension('.svg')).toBe(false);
  });

  test.each(['.svg', '.pdf', '.md', '.txt', '.css', '.mp4', '.xlsx', '.mmd'])(
    'routes %s through direct PNG output',
    extension => {
      expect(isLibraryDirectPngThumbnailExtension(extension)).toBe(true);
    },
  );

  test.each(['.html', '.docx', '.pptx'])(
    'keeps %s on the committed presentation path',
    extension => {
      expect(isLibraryDirectPngThumbnailExtension(extension)).toBe(false);
    },
  );

  test('maps stable thumbnail failure codes to diagnostic stages', () => {
    const failure = getLibraryThumbnailFailureDetails(new LibraryThumbnailError(
      LibraryThumbnailFailureCode.PptxMediaTimeout,
      'media timed out',
      { slideCount: 10, sourceHasVisualContent: true },
    ));

    expect(failure).toEqual({
      code: LibraryThumbnailFailureCode.PptxMediaTimeout,
      stage: LibraryThumbnailFailureStage.PptxMedia,
      message: 'media timed out',
      metrics: { slideCount: 10, sourceHasVisualContent: true },
    });
  });

  test('retries transient renderer failures but not permanent source failures', () => {
    expect(isLibraryThumbnailFailureRetryable(
      LibraryThumbnailFailureCode.PresentationTimeout,
    )).toBe(true);
    expect(isLibraryThumbnailFailureRetryable(
      LibraryThumbnailFailureCode.UnsupportedFormat,
    )).toBe(false);
    expect(isLibraryThumbnailFailureRetryable(
      LibraryThumbnailFailureCode.SourceTooLarge,
    )).toBe(false);
  });
});
