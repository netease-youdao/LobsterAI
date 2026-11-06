import { expect, test } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '../../../types/artifact';
import { getImageArtifactSrc } from './imageArtifactSource';

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
