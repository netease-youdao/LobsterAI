import { expect, test } from 'vitest';

import { LocalFileThumbnailFit } from '../../../../shared/artifactPreview/localFileThumbnail';
import { type Artifact, ArtifactTypeValue } from '../../../types/artifact';
import { getImageArtifactDisplaySrc, getImageArtifactSrc } from './imageArtifactSource';

const image = (overrides: Partial<Artifact>): Artifact => ({
  id: 'image-1',
  messageId: 'm1',
  sessionId: 'sess1',
  type: ArtifactTypeValue.Image,
  title: 'cat.png',
  content: '',
  createdAt: 100,
  ...overrides,
});

const version = (src: string): string | null => new URL(src).searchParams.get('v');

test('images on disk load from the file, versioned by contentVersion', () => {
  const src = getImageArtifactSrc(image({ filePath: '/Users/me/out/cat.png', contentVersion: 200 }));

  expect(decodeURIComponent(new URL(src).pathname)).toBe('/Users/me/out/cat.png');
  expect(version(src)).toBe('200');
});

test('images on disk without a contentVersion fall back to createdAt', () => {
  expect(version(getImageArtifactSrc(image({ filePath: '/Users/me/out/cat.png' })))).toBe('100');
});

test('the file wins over inline data, and inline images use their content', () => {
  const dataUrl = 'data:image/png;base64,AAAA';

  expect(getImageArtifactSrc(image({ filePath: '/Users/me/out/cat.png', content: dataUrl }))).not.toBe(dataUrl);
  expect(getImageArtifactSrc(image({ content: dataUrl }))).toBe(dataUrl);
});

test('display sources ask for a copy sized to the screen and keep the original version', () => {
  const artifact = image({ filePath: '/Users/me/out/cat.png', contentVersion: 200 });
  const thumb = (src: string): string | null => new URL(src).searchParams.get('thumb');

  const fit = (src: string): string | null => new URL(src).searchParams.get('thumbFit');

  expect(thumb(getImageArtifactDisplaySrc(artifact, 768, LocalFileThumbnailFit.Contain, 2))).toBe('1536');
  expect(fit(getImageArtifactDisplaySrc(artifact, 768, LocalFileThumbnailFit.Contain, 2))).toBeNull();
  expect(thumb(getImageArtifactDisplaySrc(artifact, 768, LocalFileThumbnailFit.Contain, 1))).toBe('1024');
  const tile = getImageArtifactDisplaySrc(artifact, 240, LocalFileThumbnailFit.Cover, 2);
  expect([thumb(tile), fit(tile), version(tile)]).toEqual(['512', 'cover', '200']);
  // Beyond the largest thumbnail only the original is big enough.
  expect(thumb(getImageArtifactDisplaySrc(artifact, 1200, LocalFileThumbnailFit.Contain, 2))).toBeNull();
  expect(getImageArtifactDisplaySrc(image({ content: 'data:image/png;base64,AAAA' }), 240, LocalFileThumbnailFit.Cover, 2))
    .toBe('data:image/png;base64,AAAA');
});

test('original images and thumbnails retain the account-bound access grant', () => {
  const fileAccess = { itemId: 'image-item', accountEpoch: 'account-a:1' };
  const artifact = image({ filePath: '/Users/me/out/private?#.png', contentVersion: 200, fileAccess });
  const sources = [
    getImageArtifactSrc(artifact),
    getImageArtifactDisplaySrc(artifact, 240, LocalFileThumbnailFit.Cover, 2),
    getImageArtifactDisplaySrc(artifact, 1200, LocalFileThumbnailFit.Contain, 2),
  ];
  for (const source of sources) {
    const url = new URL(source);
    expect(decodeURIComponent(url.pathname)).toBe(artifact.filePath);
    expect(JSON.parse(url.searchParams.get('access')!)).toEqual(fileAccess);
    expect(version(source)).toBe('200');
  }
  const changedAccount = { ...artifact, fileAccess: { ...fileAccess, accountEpoch: 'account-b:2' } };
  expect(getImageArtifactSrc(changedAccount)).not.toBe(sources[0]);
  expect(getImageArtifactDisplaySrc(changedAccount, 240, LocalFileThumbnailFit.Cover, 2)).not.toBe(sources[1]);
});
