import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CompanionAppCategory } from '../../shared/desktopCompanion/appCategories';
import { DesktopCompanionStoreKey } from '../../shared/desktopCompanion/constants';
import { COMPANION_WELCOME_TOPIC, CompanionHintOutcome, CompanionHintRule } from '../../shared/desktopCompanion/hintPolicy';
import { CompanionHintsController } from './companionHints';

const START = new Date(2026, 9, 6, 9, 0).getTime();

let values: Map<string, unknown>;
let shown: Array<[string, number]>;
let enabled: boolean;
let quiet: boolean;

function create() {
  return new CompanionHintsController({
    store: { get: <T>(key: string) => values.get(key) as T | undefined, set: (key, value) => { values.set(key, value); } },
    isEnabled: () => enabled,
    isQuiet: () => quiet,
    showHint: (topic, variant) => { shown.push([topic, variant]); return true; },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  values = new Map();
  shown = [];
  enabled = true;
  quiet = false;
});
afterEach(() => vi.useRealTimers());

describe('context hints', () => {
  test('wait for the app to settle and the launch to calm down', () => {
    const hints = create();
    hints.onForegroundChange('com.microsoft.Outlook');
    vi.advanceTimersByTime(CompanionHintRule.DwellMs + 500);
    expect(shown).toEqual([]);
    vi.setSystemTime(START + CompanionHintRule.LaunchQuietMs);
    hints.onForegroundChange('com.apple.mail');
    vi.advanceTimersByTime(CompanionHintRule.DwellMs + 500);
    expect(shown).toEqual([[CompanionAppCategory.Mail, 0]]);
    expect(values.get(DesktopCompanionStoreKey.HintLedger)).toMatchObject({ shownToday: 1 });
  });

  test('switching away before the dwell time cancels the hint', () => {
    vi.setSystemTime(START + CompanionHintRule.LaunchQuietMs);
    const hints = create();
    hints.onForegroundChange('com.apple.mail');
    vi.advanceTimersByTime(3_000);
    hints.onForegroundChange('com.lobsterai.app');
    vi.advanceTimersByTime(CompanionHintRule.DwellMs + 500);
    expect(shown).toEqual([]);
    expect(hints.foregroundCategory).toBeNull();
  });

  test('stay silent when tips are off or the user is busy', () => {
    vi.setSystemTime(START + CompanionHintRule.LaunchQuietMs);
    const hints = create();
    enabled = false;
    hints.onForegroundChange('com.apple.mail');
    vi.advanceTimersByTime(CompanionHintRule.DwellMs + 500);
    enabled = true;
    quiet = true;
    hints.onForegroundChange('com.google.Chrome');
    vi.advanceTimersByTime(CompanionHintRule.DwellMs + 500);
    expect(shown).toEqual([]);
  });

  test('remember outcomes across launches', () => {
    vi.setSystemTime(START + CompanionHintRule.LaunchQuietMs);
    create().recordOutcome(CompanionAppCategory.Mail, CompanionHintOutcome.Muted);
    const hints = create();
    vi.setSystemTime(START + 2 * CompanionHintRule.LaunchQuietMs + 1);
    hints.onForegroundChange('com.apple.mail');
    vi.advanceTimersByTime(CompanionHintRule.DwellMs + 500);
    expect(shown).toEqual([]);
  });

  test('greet only once, even before tips settle', () => {
    const hints = create();
    hints.scheduleWelcome();
    vi.advanceTimersByTime(2_000);
    expect(shown).toEqual([[COMPANION_WELCOME_TOPIC, 0]]);
    expect(values.get(DesktopCompanionStoreKey.Greeted)).toBe(true);
    create().scheduleWelcome();
    vi.advanceTimersByTime(2_000);
    expect(shown).toHaveLength(1);
  });
});
