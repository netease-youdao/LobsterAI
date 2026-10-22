import { expect, test } from 'vitest';

import { OpenClawEnginePhase } from '../openclawEngine/constants';
import { CompanionAnalyticsAction, CompanionAnalyticsSource, CompanionTaskBlockedReason, companionTaskFailure,
  CompanionTaskFailureCode, CompanionTaskFailureStage, normalizeCompanionAnalyticsEvent } from './analytics';

test('structured readiness failures preserve phase without reporting the raw error', () => {
  const failure = companionTaskFailure({ code: 'ENGINE_NOT_READY', error: 'private response',
    engineStatus: { phase: OpenClawEnginePhase.Starting, message: 'private path' } }, CompanionTaskFailureStage.SessionStart);
  expect(failure).toEqual({ failureCode: CompanionTaskFailureCode.EngineNotReady,
    failureStage: CompanionTaskFailureStage.SessionStart, blockedReason: CompanionTaskBlockedReason.Starting });
  expect(normalizeCompanionAnalyticsEvent({ action: CompanionAnalyticsAction.Task, source: CompanionAnalyticsSource.Panel, ...failure }))
    .toMatchObject(failure);
  expect(JSON.stringify(failure)).not.toContain('private');
});

test.each([
  [new Error('ECONNRESET private-host'), CompanionTaskFailureCode.Network],
  [{ code: CompanionTaskFailureCode.ApiUnavailable }, CompanionTaskFailureCode.ApiUnavailable],
  [{ error: '40204: private response' }, CompanionTaskFailureCode.Quota],
  [{ error: 'model unavailable' }, CompanionTaskFailureCode.Model],
  [new Error('timed out'), CompanionTaskFailureCode.Timeout],
  [undefined, CompanionTaskFailureCode.Unknown],
])('classifies exceptions and IPC failures with bounded values', (error, expected) => {
  expect(companionTaskFailure(error, CompanionTaskFailureStage.SessionContinue)).toEqual({
    failureCode: expected, failureStage: CompanionTaskFailureStage.SessionContinue,
  });
});

test('untrusted gateway phases are never added to analytics', () => {
  expect(companionTaskFailure({ code: 'ENGINE_NOT_READY', engineStatus: { phase: 'private account' } }, CompanionTaskFailureStage.SessionStart))
    .toMatchObject({ blockedReason: CompanionTaskBlockedReason.Unknown });
});
