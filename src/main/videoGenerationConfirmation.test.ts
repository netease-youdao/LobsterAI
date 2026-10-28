import { expect, test } from 'vitest';

import { UsageOutcome } from '../shared/analytics/usage';
import { MediaConfirmationReason as Reason } from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import { mediaTranslations } from '../shared/media/copy';
import { videoConfirmationFailure, videoConfirmationQuestions } from './videoGenerationConfirmation';

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
