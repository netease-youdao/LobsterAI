import { describe, expect, test } from 'vitest';

import { CompanionAppCategory } from './appCategories';
import {
  canShowCompanionHint,
  COMPANION_WELCOME_TOPIC,
  type CompanionHintCandidate,
  companionHintCopyKeys,
  companionHintDay,
  CompanionHintOutcome,
  CompanionHintRule,
  companionHintVariant,
  markCompanionHintOutcome,
  markCompanionHintShown,
  normalizeCompanionHintLedger,
} from './hintPolicy';

const HOUR = 60 * 60_000;
const launchedAt = new Date(2026, 9, 6, 9, 0).getTime();
const now = launchedAt + HOUR;
const day = companionHintDay(now);

function candidate(patch: Partial<CompanionHintCandidate> = {}): CompanionHintCandidate {
  return {
    category: CompanionAppCategory.Mail,
    dwellMs: CompanionHintRule.DwellMs,
    now,
    day,
    launchedAt,
    quiet: false,
    ledger: normalizeCompanionHintLedger(null, day),
    ...patch,
  };
}

describe('when a hint may appear', () => {
  test('needs a category with a hint, a settled app, and a calm moment', () => {
    expect(canShowCompanionHint(candidate())).toBe(true);
    expect(canShowCompanionHint(candidate({ category: CompanionAppCategory.Code }))).toBe(false);
    expect(canShowCompanionHint(candidate({ dwellMs: CompanionHintRule.DwellMs - 1 }))).toBe(false);
    expect(canShowCompanionHint(candidate({ quiet: true }))).toBe(false);
    expect(canShowCompanionHint(candidate({ now: launchedAt + 1_000 }))).toBe(false);
  });

  test('keeps a global gap and a daily limit', () => {
    let ledger = markCompanionHintShown(normalizeCompanionHintLedger(null, day), CompanionAppCategory.Mail, now, day);
    expect(canShowCompanionHint(candidate({ category: CompanionAppCategory.Browser, ledger, now: now + 60_000 }))).toBe(false);
    expect(canShowCompanionHint(candidate({ category: CompanionAppCategory.Browser, ledger, now: now + CompanionHintRule.GlobalGapMs }))).toBe(true);
    ledger = markCompanionHintShown(ledger, CompanionAppCategory.Browser, now + HOUR, day);
    ledger = markCompanionHintShown(ledger, CompanionAppCategory.Document, now + 2 * HOUR, day);
    expect(canShowCompanionHint(candidate({ category: CompanionAppCategory.Pdf, ledger, now: now + 3 * HOUR }))).toBe(false);
  });

  test('a new day resets the daily count but not the per-category gap', () => {
    const shown = markCompanionHintShown(normalizeCompanionHintLedger(null, day), CompanionAppCategory.Mail, now, day);
    const tomorrow = now + 20 * HOUR;
    const nextDay = companionHintDay(tomorrow);
    const ledger = normalizeCompanionHintLedger(shown, nextDay);
    expect(ledger.shownToday).toBe(0);
    expect(canShowCompanionHint(candidate({ ledger, now: tomorrow, day: nextDay }))).toBe(false);
    expect(canShowCompanionHint(candidate({ ledger, now: now + 25 * HOUR, day: companionHintDay(now + 25 * HOUR) }))).toBe(true);
  });

  test('stops a category the user keeps ignoring or muted', () => {
    let ledger = normalizeCompanionHintLedger(null, day);
    for (let index = 0; index < CompanionHintRule.IgnoreLimit; index += 1) {
      ledger = markCompanionHintOutcome(ledger, CompanionAppCategory.Mail, CompanionHintOutcome.Ignored, now);
    }
    expect(canShowCompanionHint(candidate({ ledger, now: now + 30 * 24 * HOUR }))).toBe(false);
    const muted = markCompanionHintOutcome(normalizeCompanionHintLedger(null, day), CompanionAppCategory.Browser, CompanionHintOutcome.Muted, now);
    expect(canShowCompanionHint(candidate({ category: CompanionAppCategory.Browser, ledger: muted }))).toBe(false);
  });

  test('stays quiet for a week once the habit landed', () => {
    const accepted = markCompanionHintOutcome(normalizeCompanionHintLedger(null, day), CompanionAppCategory.Mail, CompanionHintOutcome.Accepted, now);
    expect(canShowCompanionHint(candidate({ ledger: accepted, now: now + 2 * 24 * HOUR }))).toBe(false);
    expect(canShowCompanionHint(candidate({ ledger: accepted, now: now + 8 * 24 * HOUR }))).toBe(true);
  });
});

describe('hint ledger and copy', () => {
  test('drops corrupted records instead of trusting them', () => {
    const ledger = normalizeCompanionHintLedger({ day, shownToday: 'many', categories: { mail: { shown: -3, muted: 'yes' }, bogus: {} } }, day);
    expect(ledger.shownToday).toBe(0);
    expect(ledger.categories.mail).toEqual({ shown: 0, ignored: 0, lastShownAt: 0, acceptedAt: 0, muted: false });
    expect(Object.keys(ledger.categories)).toEqual(['mail']);
  });

  test('rotates copy variants as a category is shown again', () => {
    let ledger = normalizeCompanionHintLedger(null, day);
    expect(companionHintVariant(ledger, CompanionAppCategory.Mail)).toBe(0);
    ledger = markCompanionHintShown(ledger, CompanionAppCategory.Mail, now, day);
    expect(companionHintVariant(ledger, CompanionAppCategory.Mail)).toBe(1);
    ledger = markCompanionHintShown(ledger, CompanionAppCategory.Mail, now + 25 * HOUR, day);
    expect(companionHintVariant(ledger, CompanionAppCategory.Mail)).toBe(0);
  });

  test('maps topics to message, action, and prompt keys', () => {
    expect(companionHintCopyKeys(CompanionAppCategory.Mail, 1)).toEqual({
      message: 'desktopCompanionHintMail1',
      action: 'desktopCompanionHintActionMail',
      prompt: 'desktopCompanionPromptMail',
    });
    expect(companionHintCopyKeys(COMPANION_WELCOME_TOPIC, 0).prompt).toBe('');
  });
});
