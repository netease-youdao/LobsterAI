import { expect, test } from 'vitest';

import { UsageFailureCode, UsageStage } from '../analytics/usage';
import { MediaConfirmationReason } from './confirmation';
import { mediaFailureFields, MediaGenerationGateReason, mediaServerFailureFields } from './usage';

test('reports exact numeric server rejection codes without response text', () => {
  expect(mediaServerFailureFields(40204, false)).toEqual({
    failureStage: UsageStage.Submit,
    failureCode: UsageFailureCode.Quota,
    blockedReason: 'server_40204',
  });
  expect(mediaServerFailureFields(99887, false)).toMatchObject({
    failureCode: UsageFailureCode.Unknown,
    blockedReason: 'server_99887',
  });
  expect(mediaServerFailureFields(40321, true).failureCode).toBe(UsageFailureCode.Quota);
  expect(mediaServerFailureFields('private response', false)).not.toHaveProperty('blockedReason');
});

test('closed confirmation and local model reasons survive; arbitrary metadata cannot enter analytics', () => {
  expect(
    mediaFailureFields({
      failureCode: MediaConfirmationReason.Timeout,
      failureStage: UsageStage.Confirmation,
    }),
  ).toEqual({
    failureCode: MediaConfirmationReason.Timeout,
    failureStage: UsageStage.Confirmation,
  });
  expect(mediaFailureFields({ warnings: [MediaGenerationGateReason.MediaNotEnabled] })).toMatchObject({
    failureCode: UsageFailureCode.Model,
    failureStage: UsageStage.Prepare,
    blockedReason: MediaGenerationGateReason.MediaNotEnabled,
  });
  expect(
    mediaFailureFields({
      failureCode: 'private path',
      failureStage: 'private prompt',
      blockedReason: 'server_private',
      warnings: ['private'],
    }),
  ).toEqual({});
});
