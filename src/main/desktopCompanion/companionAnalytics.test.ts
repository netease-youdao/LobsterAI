import { randomUUID } from 'crypto';
import { describe, expect, test, vi } from 'vitest';

import { LogReporterAction, LogReporterStoreKey } from '../../shared/analytics/constants';
import { UsageEntry } from '../../shared/analytics/usage';
import {
  CompanionAnalyticsAction as Action, CompanionAnalyticsOutcome as Outcome, CompanionAnalyticsSetting as Setting,
  CompanionAnalyticsSource as Source, CompanionAnalyticsStage as Stage, CompanionAnalyticsTool as Tool,
  normalizeCompanionAnalyticsEvent,
} from '../../shared/desktopCompanion/analytics';
import { DEFAULT_DESKTOP_COMPANION_PREFERENCES } from '../../shared/desktopCompanion/constants';
import { CompanionFileKind } from '../../shared/desktopCompanion/fileKinds';
import { MainLogReporter } from '../libs/mainLogReporter';
import { CompanionAnalytics } from './companionAnalytics';

describe('companion analytics privacy and reporting', () => {
  test('drops business data, unknown enum values, invalid numbers and non-companion events', () => {
    expect(normalizeCompanionAnalyticsEvent({ action: Action.FileDrop, source: Source.FileDrop,
      prompt: 'private selection', text: 'private answer', path: '/Users/private/document.pdf',
      sessionId: 'local-session', requestId: 'upstream-id', appId: 'private.application',
      skin: '/private/skin.png', reason: 'HTTP error containing secrets', durationMs: Infinity,
      attachmentCount: -1, fileKinds: [CompanionFileKind.Pdf, '/private/document.pdf', CompanionFileKind.Pdf].join(','),
    })).toEqual({ action: Action.FileDrop, source: Source.FileDrop, fileKinds: CompanionFileKind.Pdf });
    expect(normalizeCompanionAnalyticsEvent({ action: LogReporterAction.AppStarted, source: Source.Panel })).toBeNull();
    expect(normalizeCompanionAnalyticsEvent({ action: Action.Task, source: '/private/path' })).toBeNull();
  });

  test('reports only actual preference changes without shortcut or excluded application identifiers', () => {
    const report = vi.fn();
    const analytics = new CompanionAnalytics(report);
    const previous = { ...DEFAULT_DESKTOP_COMPANION_PREFERENCES, enabled: false };
    analytics.preferences(previous, { ...previous }, Source.Settings);
    expect(report).not.toHaveBeenCalled();
    analytics.preferences(previous, { ...previous, enabled: true, shortcut: '', selectionExcludedApps: ['Secret App'] }, Source.Settings);
    expect(report.mock.calls.map(([event]) => event)).toEqual([
      { action: Action.SettingChanged, source: Source.Settings, setting: Setting.Enabled, enabled: true },
      { action: Action.SettingChanged, source: Source.Settings, setting: Setting.Shortcut, hasShortcut: false },
      { action: Action.SettingChanged, source: Source.Settings, setting: Setting.ExcludedApps, excludedAppCount: 1 },
    ]);
  });

  test('finishes a tool once even if cancellation and a late completion race', () => {
    const report = vi.fn();
    const finish = new CompanionAnalytics(report).tool({ source: Source.Selection, tool: Tool.Explain });
    finish(Outcome.Cancelled);
    finish(Outcome.Success);
    expect(report.mock.calls.map(([event]) => event.stage)).toEqual([Stage.Submit, Stage.Result]);
    expect(report.mock.lastCall?.[0]).toMatchObject({ outcome: Outcome.Cancelled, durationMs: expect.any(Number) });
  });

  test('uses the current main-process opt-out and login state for every auxiliary-window event', async () => {
    let enabled = false;
    let yid = 'first-account';
    const fetch = vi.fn<(url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number }>>(async () => ({ ok: true, status: 200 }));
    const reporter = new MainLogReporter({ appVersion: 'test', fetch, store: {
      get: <T>(key: string): T | undefined => ({
        [LogReporterStoreKey.AppConfig]: { usageAnalyticsEnabled: enabled },
        [LogReporterStoreKey.AuthUser]: { yid },
        [LogReporterStoreKey.InstallationUuid]: 'installation',
      }[key] as T | undefined),
      set: vi.fn(),
    } });
    const analytics = new CompanionAnalytics(event => reporter.report(event));
    const event = { action: Action.Task, source: Source.Panel, stage: Stage.Submit };
    analytics.report(event);
    expect(fetch).not.toHaveBeenCalled();
    enabled = true;
    analytics.report(event);
    yid = 'second-account';
    analytics.report(event);
    enabled = false;
    analytics.report(event);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('log_Usid'))).toEqual(['first-account', 'second-account']);
  });

  test('isolates both synchronous and asynchronous reporter failures', async () => {
    for (const report of [() => { throw new Error('offline'); }, () => Promise.reject(new Error('offline'))]) {
      const analytics = new CompanionAnalytics(report);
      expect(() => analytics.report({ action: Action.Task, source: Source.Panel })).not.toThrow();
    }
    await Promise.resolve();
  });
});

function taskSetup() {
  const report = vi.fn();
  const context = { taskId: randomUUID(), turnId: randomUUID(), entry: UsageEntry.Runtime };
  const state = { owner: 'private-account:1' as string | null };
  const analytics = new CompanionAnalytics(report, () => state.owner);
  const submit = { action: Action.Task, source: Source.Panel, stage: Stage.Submit, callId: randomUUID() };
  const result = { ...submit, stage: Stage.Result, outcome: Outcome.Success };
  return { analytics, report, state, context, submit, result, events: () => report.mock.calls.map(([event]) => event) };
}

test('links a panel opening and one submission to runtime IDs without reporting the local session', () => {
  const s = taskSetup();
  const journeyId = randomUUID();
  s.analytics.task(s.submit, 10, Source.Panel, journeyId);
  s.analytics.task(s.submit, 10, Source.Panel, randomUUID());
  s.analytics.captureTask(10)(s.context);
  s.analytics.captureTask(10)({ ...s.context, turnId: randomUUID() });
  s.analytics.task({ ...s.result, taskId: randomUUID(), turnId: randomUUID() }, 10, Source.Panel);
  s.analytics.task(s.result, 10, Source.Panel);
  expect(s.events()).toEqual([
    { ...s.submit, journeyId, isFollowUp: false },
    { ...s.submit, stage: Stage.Result, outcome: Outcome.Success, journeyId, isFollowUp: false,
      taskId: s.context.taskId, turnId: s.context.turnId },
  ]);
  expect(JSON.stringify(s.events())).not.toContain('private');
});

test('failed and undispatched submissions do not borrow another task context', () => {
  for (const outcome of [Outcome.Failed, Outcome.Success]) {
    const s = taskSetup();
    s.analytics.task(s.submit, 10, Source.Panel);
    if (outcome === Outcome.Failed) s.analytics.captureTask(10)(s.context);
    s.analytics.task({ ...s.result, outcome }, 10, Source.Panel);
    expect(s.events()).toHaveLength(2);
    expect(s.events()[1].taskId).toBeUndefined();
    expect(s.events()[1].turnId).toBeUndefined();
  }
});

test('late follow-up completion retains the dispatched turn even when a later turn has started', () => {
  const s = taskSetup();
  s.analytics.task({ ...s.submit, isFollowUp: true }, 10, Source.Result);
  const dispatchedTurnId = s.context.turnId;
  s.analytics.captureTask(10)(s.context);
  s.context.turnId = randomUUID();
  s.analytics.task(s.result, 10, Source.Result);
  expect(s.events()[1].turnId).toBe(dispatchedTurnId);
  expect(s.events()[1].isFollowUp).toBe(true);
});

test('another window, account or an opt-out cannot complete a captured submission', () => {
  const s = taskSetup();
  s.analytics.task(s.submit, 10, Source.Panel);
  const capture = s.analytics.captureTask(10);
  s.analytics.task(s.result, 11, Source.Panel);
  s.state.owner = 'private-account:2';
  capture(s.context);
  s.analytics.task(s.result, 10, Source.Panel);
  s.state.owner = null;
  s.analytics.clearTasks();
  s.state.owner = 'private-account:1';
  s.analytics.task(s.result, 10, Source.Panel);
  expect(s.events()).toHaveLength(1);
});

test('only UUID correlation fields survive the reporting allowlist', () => {
  const callId = randomUUID();
  const journeyId = randomUUID();
  expect(normalizeCompanionAnalyticsEvent({ action: Action.Task, source: Source.Panel, callId, journeyId,
    sessionId: randomUUID(), taskId: 'private-business-id', turnId: 'private-text' })).toEqual({
    action: Action.Task, source: Source.Panel, callId, journeyId,
  });
});

test('each window captures only its own dispatch, including simultaneous submissions', () => {
  const s = taskSetup();
  const second = { ...s.submit, callId: randomUUID() };
  const otherContext = { ...s.context, taskId: randomUUID(), turnId: randomUUID() };
  s.analytics.task(s.submit, 10, Source.Panel);
  s.analytics.task(second, 11, Source.FileDrop);
  const firstDispatch = s.analytics.captureTask(10);
  const secondDispatch = s.analytics.captureTask(11);
  secondDispatch(otherContext);
  firstDispatch(s.context);
  s.analytics.task({ ...second, stage: Stage.Result, outcome: Outcome.Success }, 11, Source.FileDrop);
  s.analytics.task(s.result, 10, Source.Panel);
  expect(s.events().slice(-2).map(event => [event.callId, event.turnId])).toEqual([
    [second.callId, otherContext.turnId], [s.submit.callId, s.context.turnId],
  ]);
});
