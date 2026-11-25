import { expect, test } from 'vitest';

import { UsageOutcome } from '../shared/analytics/usage';
import {
  MediaConfirmationReason as Reason,
  readVideoConfirmationDetails,
} from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import { mediaTranslations } from '../shared/media/copy';
import {
  buildLocalFileImagePreviewUrl,
  createVideoReferenceImagePreview,
  type DecodedPreviewImage,
  videoConfirmationFailure,
  videoConfirmationQuestions,
  videoConfirmationReferences,
} from './videoGenerationConfirmation';

const t = (key: string, params: Record<string, string | number> = {}) => Object.entries(params)
  .reduce((text, [name, value]) => text.replaceAll('{' + name + '}', String(value)),
    (mediaTranslations.zh as Record<string, string>)[key] ?? key);

test.each([
  [Reason.UserCancelled, MediaTaskStatus.Cancelled],
  [Reason.NoRoute, MediaTaskStatus.Failed],
  [Reason.Timeout, MediaTaskStatus.Timeout],
  [Reason.NotDisplayed, MediaTaskStatus.Timeout],
  [Reason.Interrupted, UsageOutcome.Interrupted],
  [Reason.AccountChanged, UsageOutcome.Interrupted],
])('keeps %s distinct in the final media outcome', (reason, status) => {
  expect(videoConfirmationFailure({ behavior: 'deny', reason }, t).details).toMatchObject({ status, failureCode: reason });
});

test('refreshing catalogue pricing keeps the original confirmation question and request parameters', () => {
  const input = { model: 'video-model', params: { durationSeconds: 5, resolution: '720p' }, prompt: 'Original scene', portalUrl: 'https://example.invalid' };
  const first = videoConfirmationQuestions(input, { pricing: { billingUnit: 'per_second', creditsPerSecond: 40 } }, t);
  const refreshed = videoConfirmationQuestions(input, { pricing: { billingUnit: 'per_second', creditsPerSecond: 70 } }, t);
  expect(refreshed[0].question).toBe(first[0].question);
  expect(first[0].subtitle).toContain('200');
  expect(refreshed[0].subtitle).toContain('350');
  expect(input.params).toEqual({ durationSeconds: 5, resolution: '720p' });
});

test('carries structured request details for the desktop card next to the prose question', () => {
  const input = {
    model: 'video-model', prompt: 'Two puppies race', portalUrl: 'https://example.invalid/tasks',
    params: { durationSeconds: 5, resolution: '720p', aspectRatio: '16:9' },
    references: [{ kind: 'image' as const, thumbnail: 'data:image/jpeg;base64,AA' }],
  };
  const [question] = videoConfirmationQuestions(input, { pricing: { billingUnit: 'per_second', creditsPerSecond: 40 } }, t);
  expect(question.video).toEqual({
    model: 'video-model', prompt: 'Two puppies race', portalUrl: 'https://example.invalid/tasks',
    resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', estimatedCredits: 200,
    references: [{ kind: 'image', thumbnail: 'data:image/jpeg;base64,AA' }],
  });
  const [unpriced] = videoConfirmationQuestions(input, { pricingDescription: ' 0.4 credits / second ' }, t);
  expect(unpriced.video).toMatchObject({ pricingNote: '0.4 credits / second' });
  expect(unpriced.video?.estimatedCredits).toBeUndefined();
});

test('collects each reference once and previews only images', () => {
  const image = 'data:image/png;base64,AAAA';
  const references = videoConfirmationReferences({
    firstFrame: image,
    images: [image, 'https://example.invalid/b.png'],
    videos: ['https://example.invalid/clip.mp4'],
    media: [{ type: 'image_url', image_url: { url: 'https://example.invalid/c.png' } }],
  }, source => source.startsWith('data:') ? 'thumb' : undefined);
  expect(references).toEqual([
    { kind: 'image', thumbnail: 'thumb' },
    { kind: 'image' },
    { kind: 'video' },
    { kind: 'image' },
  ]);
  expect(videoConfirmationReferences({ images: [image] }, () => { throw new Error('decode failed'); })).toEqual([{ kind: 'image' }]);
});

const isWindows = process.platform === 'win32';
const localImageDirectory = isWindows ? 'C:/Users/me' : '/Users/me';
const localImagePreviewDirectory = isWindows ? 'localfile://local/C%3A/Users/me' : 'localfile://local/Users/me';

test('builds localfile preview URLs only for servable local image files', () => {
  expect(buildLocalFileImagePreviewUrl(`${localImageDirectory}/my photo #1.png`))
    .toBe(`${localImagePreviewDirectory}/my%20photo%20%231.png`);
  expect(buildLocalFileImagePreviewUrl(`${localImageDirectory}/参考图100%.webp`))
    .toBe(`${localImagePreviewDirectory}/%E5%8F%82%E8%80%83%E5%9B%BE100%25.webp`);
  expect(buildLocalFileImagePreviewUrl(`${localImageDirectory}/clip.mp4`)).toBeUndefined();
  expect(buildLocalFileImagePreviewUrl('relative/image.png')).toBeUndefined();
});

test('creates high-res preview metadata for local files, HTTP URLs, and inline data URLs', () => {
  const resizeCalls: Array<{ width?: number; height?: number }> = [];
  const makeImage = (width: number, height: number, empty = false): DecodedPreviewImage => ({
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: (options) => {
      resizeCalls.push(options);
      return makeImage(options.width ?? width, options.height ?? height, empty);
    },
    toJPEG: (quality) => Buffer.from(`jpg-${width}x${height}-q${quality}`),
  });

  expect(createVideoReferenceImagePreview('https://example.invalid/pic.png', {
    decodeDataUrl: () => makeImage(100, 100),
  })).toBe('https://example.invalid/pic.png');

  const localPreview = createVideoReferenceImagePreview('data:image/png;base64,AAAA', {
    localPath: `${localImageDirectory}/shot 1.png`,
    decodeDataUrl: () => makeImage(1920, 1080),
  });
  expect(localPreview).toEqual({
    thumbnail: `data:image/jpeg;base64,${Buffer.from('jpg-1920x96-q80').toString('base64')}`,
    previewUrl: `${localImagePreviewDirectory}/shot%201.png`,
    name: 'shot 1.png',
  });

  const undecodableLocal = createVideoReferenceImagePreview('data:image/webp;base64,AAAA', {
    localPath: `${localImageDirectory}/frame.webp`,
    decodeDataUrl: () => makeImage(0, 0, true),
  });
  expect(undecodableLocal).toEqual({
    thumbnail: `${localImagePreviewDirectory}/frame.webp`,
    previewUrl: `${localImagePreviewDirectory}/frame.webp`,
    name: 'frame.webp',
  });

  const smallInline = createVideoReferenceImagePreview('data:image/png;base64,SMALL', {
    decodeDataUrl: () => makeImage(800, 600),
  });
  expect(smallInline).toEqual({
    thumbnail: `data:image/jpeg;base64,${Buffer.from('jpg-800x96-q80').toString('base64')}`,
    previewUrl: 'data:image/png;base64,SMALL',
  });

  resizeCalls.length = 0;
  const largeInlineDataUrl = `data:image/png;base64,${'A'.repeat(300 * 1024)}`;
  const largeInline = createVideoReferenceImagePreview(largeInlineDataUrl, {
    decodeDataUrl: () => makeImage(2560, 1440),
  });
  expect(resizeCalls).toEqual([{ height: 96 }, { width: 1280 }]);
  expect(largeInline).toEqual({
    thumbnail: `data:image/jpeg;base64,${Buffer.from('jpg-2560x96-q80').toString('base64')}`,
    previewUrl: `data:image/jpeg;base64,${Buffer.from('jpg-1280x1440-q85').toString('base64')}`,
  });
});

test('propagates previewUrl and name through videoConfirmationReferences and readVideoConfirmationDetails', () => {
  const references = videoConfirmationReferences({
    images: ['data:image/png;base64,ONE'],
  }, () => ({
    thumbnail: 'data:image/jpeg;base64,THUMB',
    previewUrl: 'localfile://local/Users/me/one.png',
    name: 'one.png',
  }));
  expect(references).toEqual([
    {
      kind: 'image',
      thumbnail: 'data:image/jpeg;base64,THUMB',
      previewUrl: 'localfile://local/Users/me/one.png',
      name: 'one.png',
    },
  ]);

  const parsed = readVideoConfirmationDetails({
    model: 'seedance-fast',
    prompt: 'Ocean waves',
    portalUrl: 'https://example.invalid/tasks',
    references,
  });
  expect(parsed?.references).toEqual(references);
});
