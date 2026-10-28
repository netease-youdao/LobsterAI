import { afterEach, expect, test, vi } from 'vitest';

import { isUsageId } from '../../../shared/analytics/usage';
import { type CompanionAnalyticsEvent, CompanionAnalyticsOutcome, CompanionAnalyticsSource, CompanionAnalyticsStage,
  CompanionTaskBlockedReason, CompanionTaskFailureCode, CompanionTaskFailureStage } from '../../../shared/desktopCompanion/analytics';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import { CoworkStartBlock } from '../cowork/coworkStartRequest';
import { beginCompanionTask, companionPreflightFailure } from './analytics';

afterEach(() => vi.unstubAllGlobals());

test.each([
  [CoworkStartBlock.EngineNotReady, CompanionTaskFailureCode.EngineNotReady, CompanionTaskBlockedReason.Starting],
  [CoworkStartBlock.EnterpriseQuota, CompanionTaskFailureCode.Quota, CompanionTaskBlockedReason.EnterpriseQuota],
  [CoworkStartBlock.ModelBillingSide, CompanionTaskFailureCode.ModelBillingSide, CompanionTaskBlockedReason.ModelBillingSide],
])('classifies the %s preflight rejection separately', (block, failureCode, blockedReason) => {
  expect(companionPreflightFailure(block, OpenClawEnginePhase.Starting)).toEqual({
    failureCode, failureStage: CompanionTaskFailureStage.Preflight, blockedReason,
  });
});

test('records the actual task submission result once, including follow-ups', () => {
  const reportAnalytics = vi.fn<(event: CompanionAnalyticsEvent) => Promise<void>>(async () => {});
  vi.stubGlobal('window', { electron: { desktopCompanion: { reportAnalytics } } });
  const finish = beginCompanionTask(CompanionAnalyticsSource.Result, true);
  finish(true);
  finish(false);
  expect(reportAnalytics.mock.calls.map(([event]) => event.stage)).toEqual([CompanionAnalyticsStage.Submit, CompanionAnalyticsStage.Result]);
  expect(reportAnalytics.mock.lastCall?.[0]).toMatchObject({ source: CompanionAnalyticsSource.Result,
    isFollowUp: true, outcome: CompanionAnalyticsOutcome.Success });
  const events = reportAnalytics.mock.calls.map(([event]) => event);
  expect(isUsageId(events[0].callId)).toBe(true);
  expect(events[1].callId).toBe(events[0].callId);
});

test('reporter IPC failure does not reject a task submission', async () => {
  vi.stubGlobal('window', { electron: { desktopCompanion: { reportAnalytics: () => Promise.reject(new Error('IPC closed')) } } });
  expect(() => beginCompanionTask(CompanionAnalyticsSource.Panel)(false)).not.toThrow();
  await Promise.resolve();
});

test('retains the first classified failure and reuses the submission call ID', () => {
  const reportAnalytics = vi.fn(async (_event: CompanionAnalyticsEvent) => {});
  vi.stubGlobal('window', { electron: { desktopCompanion: { reportAnalytics } } });
  const finish = beginCompanionTask(CompanionAnalyticsSource.Panel);
  const failure = { failureCode: CompanionTaskFailureCode.EngineNotReady,
    failureStage: CompanionTaskFailureStage.Preflight, blockedReason: CompanionTaskBlockedReason.Starting };
  finish(false, failure);
  finish(false);
  finish(true);
  expect(reportAnalytics).toHaveBeenCalledTimes(2);
  const [submit, result] = reportAnalytics.mock.calls.map(([event]) => event);
  expect(result).toMatchObject({ ...failure, callId: submit.callId, outcome: CompanionAnalyticsOutcome.Failed });
});

test('success omits stale failure fields and failures always carry a classification', () => {
  const reportAnalytics = vi.fn(async (_event: CompanionAnalyticsEvent) => {});
  vi.stubGlobal('window', { electron: { desktopCompanion: { reportAnalytics } } });
  beginCompanionTask(CompanionAnalyticsSource.Panel)(true, { failureCode: CompanionTaskFailureCode.Unknown, failureStage: CompanionTaskFailureStage.Preflight });
  expect(reportAnalytics.mock.lastCall?.[0].failureCode).toBeUndefined();
  beginCompanionTask(CompanionAnalyticsSource.Result, true)(false);
  expect(reportAnalytics.mock.lastCall?.[0]).toMatchObject({ failureCode: CompanionTaskFailureCode.Unknown, failureStage: CompanionTaskFailureStage.SessionContinue });
});
