import { expect, test } from 'vitest';

import { UsageOutcome } from '../shared/analytics/usage';
import { MediaConfirmationReason as Reason } from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import { mediaTranslations } from '../shared/media/copy';
import { videoConfirmationFailure, videoConfirmationQuestions, videoConfirmationReferences } from './videoGenerationConfirmation';

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
