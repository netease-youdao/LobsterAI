import { expect, test } from 'vitest';

import { LocalFileThumbnailFit, parseLocalFileThumbnailFit, snapLocalFileThumbnailEdge } from './localFileThumbnail';

test('snaps requests up to a built thumbnail edge, or to none beyond the largest', () => {
  expect(snapLocalFileThumbnailEdge(100)).toBe(256);
  expect(snapLocalFileThumbnailEdge(512)).toBe(512);
  expect(snapLocalFileThumbnailEdge(960)).toBe(1024);
  expect(snapLocalFileThumbnailEdge(1440)).toBe(1536);
  expect(snapLocalFileThumbnailEdge(2400)).toBeNull();
  expect(snapLocalFileThumbnailEdge(0)).toBeNull();
  expect(snapLocalFileThumbnailEdge(Number.NaN)).toBeNull();
});

test('reads the fit mode, defaulting to contain', () => {
  expect(parseLocalFileThumbnailFit('cover')).toBe(LocalFileThumbnailFit.Cover);
  expect(parseLocalFileThumbnailFit('contain')).toBe(LocalFileThumbnailFit.Contain);
  expect(parseLocalFileThumbnailFit(null)).toBe(LocalFileThumbnailFit.Contain);
  expect(parseLocalFileThumbnailFit('stretch')).toBe(LocalFileThumbnailFit.Contain);
});
