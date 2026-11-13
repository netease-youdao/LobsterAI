import { describe, expect, test, vi } from 'vitest';

import {
  CompanionAnalyticsAction, CompanionAnalyticsInteraction as Interaction, CompanionAnalyticsSource, CompanionAnalyticsTool,
} from '../../shared/desktopCompanion/analytics';
import { COMPANION_LOGIN_ATTRIBUTION_MS, CompanionLoginTracker, isCompanionLoginSource, normalizeCompanionLoginStart } from './companionLogin';

const JOURNEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('normalizeCompanionLoginStart', () => {
  test('keeps a known tool, a usage ID and a trimmed resume request', () => {
    expect(normalizeCompanionLoginStart({
      tool: CompanionAnalyticsTool.Ask, journeyId: JOURNEY_ID, resume: { question: '  Why this tense?  ', extra: 'x' }, other: 1,
    })).toEqual({ tool: CompanionAnalyticsTool.Ask, journeyId: JOURNEY_ID, resume: { question: 'Why this tense?' } });
  });

  test('drops unknown tools, foreign IDs and empty resume requests', () => {
    expect(normalizeCompanionLoginStart({ tool: 'shell' })).toBeNull();
    expect(normalizeCompanionLoginStart(null)).toBeNull();
    expect(normalizeCompanionLoginStart({ tool: CompanionAnalyticsTool.Tts, journeyId: 'not-an-id', resume: { question: '   ' } }))
      .toEqual({ tool: CompanionAnalyticsTool.Tts });
  });

  test('bounds the carried question by characters, not UTF-16 units', () => {
    const question = '译'.repeat(5_000);
    expect(normalizeCompanionLoginStart({ tool: CompanionAnalyticsTool.Ask, resume: { question } })?.resume?.question)
      .toHaveLength(4_000);
  });

  test('only the selection and language tools cards may start a sign-in', () => {
    expect(isCompanionLoginSource(CompanionAnalyticsSource.Selection)).toBe(true);
    expect(isCompanionLoginSource(CompanionAnalyticsSource.LanguageTools)).toBe(true);
    expect(isCompanionLoginSource(CompanionAnalyticsSource.Panel)).toBe(false);
  });
});

describe('CompanionLoginTracker', () => {
  test('connects the click and the sign-in with one journey and the time between them', () => {
    let now = 1_000;
    const report = vi.fn();
    const tracker = new CompanionLoginTracker({ report }, () => now);
    tracker.begin(CompanionAnalyticsSource.LanguageTools, { tool: CompanionAnalyticsTool.Tts, journeyId: JOURNEY_ID });
    now += 42_000;
    expect(tracker.succeed()).toBe(true);
    expect(report.mock.calls.map(([event]) => event)).toEqual([
      { action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.LanguageTools,
        interactionType: Interaction.LoginClick, tool: CompanionAnalyticsTool.Tts, journeyId: JOURNEY_ID },
      { action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.LanguageTools,
        interactionType: Interaction.LoginSuccess, tool: CompanionAnalyticsTool.Tts, journeyId: JOURNEY_ID, durationMs: 42_000 },
    ]);
    // One sign-in is credited once.
    expect(tracker.succeed()).toBe(false);
    expect(report).toHaveBeenCalledTimes(2);
  });

  test('makes up a journey when the prompt sent none, and the newest prompt wins', () => {
    const report = vi.fn();
    const tracker = new CompanionLoginTracker({ report }, () => 0);
    tracker.begin(CompanionAnalyticsSource.Selection, { tool: CompanionAnalyticsTool.Explain });
    tracker.begin(CompanionAnalyticsSource.LanguageTools, { tool: CompanionAnalyticsTool.Ask });
    tracker.succeed();
    const [first, second, success] = report.mock.calls.map(([event]) => event);
    expect(first.journeyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(success).toMatchObject({ source: CompanionAnalyticsSource.LanguageTools, tool: CompanionAnalyticsTool.Ask, journeyId: second.journeyId });
  });

  test('does not credit a sign-in that came long after the prompt, or one no prompt started', () => {
    let now = 0;
    const report = vi.fn();
    const tracker = new CompanionLoginTracker({ report }, () => now);
    expect(tracker.succeed()).toBe(false);
    tracker.begin(CompanionAnalyticsSource.Selection, { tool: CompanionAnalyticsTool.Summarize });
    now = COMPANION_LOGIN_ATTRIBUTION_MS + 1;
    expect(tracker.succeed()).toBe(false);
    expect(report.mock.calls.map(([event]) => event.interactionType)).toEqual([Interaction.LoginClick]);
  });
});
