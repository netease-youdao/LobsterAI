import { describe, expect, test } from 'vitest';

import {
  emptyLaunchAdState,
  isLaunchAdEligible,
  markLaunchAdDismissed,
  markLaunchAdShown,
  normalizeLaunchAdState,
  pickLaunchAd,
} from './launchAdFrequency';
import type { ClientBanner } from './sidebarAdBannerState';

const banner = (id: number, displayFrequency?: string, weight = 1): ClientBanner => ({
  id,
  activityDescription: `Launch ${id}`,
  linkUrl: `https://lobsterai.youdao.com/launch/${id}`,
  imageUrl: `https://nos.example.com/launch-${id}.png`,
  updatedAt: '2026-11-11T01:00:00',
  displayFrequency,
  weight,
});

const MORNING = new Date(2026, 10, 11, 9, 0, 0).getTime();
const EVENING = new Date(2026, 10, 11, 21, 0, 0).getTime();
const NEXT_DAY = new Date(2026, 10, 12, 9, 0, 0).getTime();

describe('launch ad frequency', () => {
  test('daily banners pop up once per local day and default to daily', () => {
    const daily = banner(1);
    const shown = markLaunchAdShown(emptyLaunchAdState(), daily, MORNING);

    expect(isLaunchAdEligible(daily, emptyLaunchAdState(), MORNING)).toBe(true);
    expect(isLaunchAdEligible(daily, shown, EVENING)).toBe(false);
    expect(isLaunchAdEligible(daily, shown, NEXT_DAY)).toBe(true);
  });

  test('once banners stop after the user dismisses that banner version', () => {
    const once = banner(2, 'once');
    const shown = markLaunchAdShown(emptyLaunchAdState(), once, MORNING);
    expect(isLaunchAdEligible(once, shown, NEXT_DAY)).toBe(true);

    const dismissed = markLaunchAdDismissed(shown, once, MORNING);
    expect(isLaunchAdEligible(once, dismissed, NEXT_DAY)).toBe(false);
    expect(isLaunchAdEligible({ ...once, updatedAt: '2026-11-12T00:00:00' }, dismissed, NEXT_DAY)).toBe(true);
  });

  test('every-launch banners are always eligible', () => {
    const every = banner(3, 'every_launch');
    const state = markLaunchAdDismissed(markLaunchAdShown(emptyLaunchAdState(), every, MORNING), every, MORNING);
    expect(isLaunchAdEligible(every, state, EVENING)).toBe(true);
  });

  test('picks among eligible banners by weight', () => {
    const shownToday = banner(4, 'daily', 100);
    const light = banner(5, 'daily', 1);
    const heavy = banner(6, 'daily', 3);
    const state = markLaunchAdShown(emptyLaunchAdState(), shownToday, MORNING);

    expect(pickLaunchAd([shownToday, light, heavy], state, EVENING, () => 0)).toBe(light);
    expect(pickLaunchAd([shownToday, light, heavy], state, EVENING, () => 0.5)).toBe(heavy);
    expect(pickLaunchAd([shownToday], state, EVENING)).toBeNull();
  });

  test('ignores malformed persisted state', () => {
    expect(normalizeLaunchAdState(null)).toEqual({ versions: {} });
    expect(normalizeLaunchAdState({ versions: { '1:v': { lastShownAt: 'x', dismissedAt: 5 } } }))
      .toEqual({ versions: { '1:v': { dismissedAt: 5 } } });
  });
});
