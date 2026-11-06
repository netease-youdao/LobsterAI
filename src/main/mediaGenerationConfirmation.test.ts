import {
  describe,
  expect,
  test,
} from 'vitest';

import { UsageOutcome, UsageStage } from '../shared/analytics/usage';
import { MediaConfirmationReason } from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import { imageConfirmationFailure, imageConfirmationQuestions, isMediaGenerationConfirmed } from './mediaGenerationConfirmation';

describe('paid media confirmation', () => {
  test.each([
    [MediaConfirmationReason.Timeout, MediaTaskStatus.Timeout],
    [MediaConfirmationReason.NotDisplayed, MediaTaskStatus.Timeout],
    [MediaConfirmationReason.UserCancelled, MediaTaskStatus.Cancelled],
    [MediaConfirmationReason.Interrupted, UsageOutcome.Interrupted],
    [MediaConfirmationReason.AccountChanged, UsageOutcome.Interrupted],
    [MediaConfirmationReason.NoRoute, MediaTaskStatus.Failed],
  ] as const)('preserves the image confirmation failure cause %s', (reason, status) => {
    expect(imageConfirmationFailure({ behavior: 'deny', reason }, key => key).details).toEqual({
      reason, status, failureCode: reason, failureStage: UsageStage.Confirmation,
    });
  });

  test('shows a per-image rate without inventing an estimate for tiered pricing', () => {
    const t = (key: string, params?: Record<string, string | number>) => params ? `${key}:${params.credits}` : key;
    expect(imageConfirmationQuestions({ pricing: { billingUnit: 'per_image', costYuan: 0.22 } }, t)[0].subtitle)
      .toBe('mediaImageConfirmUnitPrice:22');
    expect(imageConfirmationQuestions({ pricing: { billingUnit: 'per_image', costYuan: 0.22, tiers: [{}] } }, t)[0].subtitle)
      .toBe('mediaImageConfirmCostUnknown');
  });
  test.each([
    null, undefined, {}, { behavior: 'allow' }, { behavior: 'deny', answers: { question: 'Generate' } },
    { behavior: 'allow', answers: { question: 'Cancel' } },
    { behavior: 'allow', answers: { anotherQuestion: 'Generate' } },
    { behavior: 'allow', answers: { question: 'free text' } },
  ])('does not submit without an explicit matching approval: %j', response => {
    expect(isMediaGenerationConfirmed(response, 'question', 'Generate')).toBe(false);
  });

  test('accepts only the actual question and affirmative option', () => {
    expect(isMediaGenerationConfirmed({ behavior: 'allow', answers: { question: 'Generate' } }, 'question', 'Generate'))
      .toBe(true);
  });
});
