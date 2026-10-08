import { afterEach, describe, expect, test } from 'vitest';

import {
  cacheLibraryThumbnail,
  clearLibraryThumbnailCache,
  createLibraryThumbnailCacheKey,
  getCachedLibraryThumbnail,
  LibraryHtmlThumbnailClientCacheVersion,
  LibraryThumbnailClientCacheVersion,
  shouldApplyLibraryThumbnailResult,
} from './libraryThumbnailCache';

afterEach(() => {
  clearLibraryThumbnailCache();
});

describe('library thumbnail cache', () => {
  test('changes the cache key when the file mtime changes', () => {
    expect(createLibraryThumbnailCacheKey('/tmp/report.pdf', 100)).not.toBe(
      createLibraryThumbnailCacheKey('/tmp/report.pdf', 200),
    );
  });

  test('changes the cache key when the file size changes', () => {
    expect(createLibraryThumbnailCacheKey('/tmp/report.pdf', 100, 10)).not.toBe(
      createLibraryThumbnailCacheKey('/tmp/report.pdf', 100, 20),
    );
  });

  test('includes the renderer identity version in the cache key', () => {
    expect(createLibraryThumbnailCacheKey('/tmp/report.pdf', 100)).toContain(
      `${LibraryThumbnailClientCacheVersion}\0`,
    );
  });

  test.each([
    '/tmp/index.html',
    '/tmp/页面.HTM',
    'C:\\project\\index.HTML',
    '\\\\server\\share\\index.HtMl',
    'index.htm',
  ])('uses the HTML-specific version for %s without rewriting the path', filePath => {
    expect(createLibraryThumbnailCacheKey(filePath, 100, 20)).toBe([
      LibraryHtmlThumbnailClientCacheVersion,
      filePath,
      100,
      20,
    ].join('\0'));
  });

  test.each([
    '/tmp/.html',
    'C:\\project\\.htm',
    '/tmp/page.html/document.docx',
    'C:\\page.htm\\image.png',
    '/tmp/page.html.txt',
    '/tmp/report.pdf',
    '/tmp/slides.pptx',
  ])('preserves the existing version for other paths: %s', filePath => {
    expect(createLibraryThumbnailCacheKey(filePath, 100, 20)).toBe([
      LibraryThumbnailClientCacheVersion,
      filePath,
      100,
      20,
    ].join('\0'));
  });

  test('cannot reuse an HTML thumbnail stored under the previous client version', () => {
    const filePath = '/tmp/index.html';
    const oldKey = [LibraryThumbnailClientCacheVersion, filePath, 100, 20].join('\0');
    cacheLibraryThumbnail(oldKey, 'data:image/png;base64,b2xk');

    expect(getCachedLibraryThumbnail(createLibraryThumbnailCacheKey(filePath, 100, 20))).toBeUndefined();
    expect(getCachedLibraryThumbnail(oldKey)).toBe('data:image/png;base64,b2xk');
  });

  test('rejects a completed request after the card identity changes', () => {
    const imageKey = createLibraryThumbnailCacheKey('/tmp/image.png', 100);
    const markdownKey = createLibraryThumbnailCacheKey('/tmp/README.md', 100);

    expect(shouldApplyLibraryThumbnailResult(imageKey, markdownKey, true)).toBe(false);
    expect(shouldApplyLibraryThumbnailResult(imageKey, imageKey, false)).toBe(false);
    expect(shouldApplyLibraryThumbnailResult(imageKey, imageKey, true)).toBe(true);
  });

  test('keeps the loaded thumbnail', () => {
    const cacheKey = createLibraryThumbnailCacheKey('/tmp/report.pdf', 100);
    const dataUrl = 'data:image/png;base64,dGVzdA==';

    cacheLibraryThumbnail(cacheKey, dataUrl);

    expect(getCachedLibraryThumbnail(cacheKey)).toBe(dataUrl);
  });
});
