import { expect, test } from 'vitest';

import { ArtifactPreviewHost, ArtifactPreviewProtocol } from '../../../../shared/artifactPreview/constants';
import { LocalFileThumbnailFit } from '../../../../shared/artifactPreview/localFileThumbnail';
import { buildLocalFileSrc } from './VideoRenderer';

test('video preview uses an explicit host and preserves Windows and POSIX file paths', () => {
  for (const [input, expectedPath] of [
    ['file:///D:/media/a%20b.mp4', '/D:/media/a b.mp4'],
    ['D:\\media\\a b.mp4', '/D:/media/a b.mp4'],
    ['/Users/me/media/a b.mp4', '/Users/me/media/a b.mp4'],
  ]) {
    const url = new URL(buildLocalFileSrc(input, 123));
    expect(url.protocol).toBe(`${ArtifactPreviewProtocol.LocalFile}:`);
    expect(url.host).toBe(ArtifactPreviewHost.LocalFile);
    expect(decodeURIComponent(url.pathname)).toBe(expectedPath);
    expect(url.searchParams.get('v')).toBe('123');
  }
});

test('video preview carries account-bound access alongside the standard scheme host', () => {
  const access = { itemId: 'library-item', accountEpoch: 'epoch-a' };
  const url = new URL(buildLocalFileSrc('D:\\media\\a b.mp4', 123, access));
  expect(url.host).toBe(ArtifactPreviewHost.LocalFile);
  expect(decodeURIComponent(url.pathname)).toBe('/D:/media/a b.mp4');
  expect(JSON.parse(url.searchParams.get('access')!)).toEqual(access);
  expect(url.searchParams.get('v')).toBe('123');
});

test('thumbnail requests preserve the access grant and encoded filename', () => {
  const access = { itemId: 'library-item', accountEpoch: 'epoch-a' };
  const url = new URL(buildLocalFileSrc('/media/image?#.png', 123, access, {
    edge: 512, fit: LocalFileThumbnailFit.Cover,
  }));
  expect(decodeURIComponent(url.pathname)).toBe('/media/image?#.png');
  expect(JSON.parse(url.searchParams.get('access')!)).toEqual(access);
  expect(url.searchParams.get('thumb')).toBe('512');
  expect(url.searchParams.get('thumbFit')).toBe(LocalFileThumbnailFit.Cover);
});
