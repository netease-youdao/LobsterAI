import { beforeEach, describe, expect, test, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('../services/store', () => ({
  localStore: storeMock,
}));

import {
  getActivityBusinessDate,
  getDailyCheckInDismissKey,
  isDailyCheckInDismissedForDate,
  readDailyCheckInDismissState,
  saveDailyCheckInDismissState,
} from './dailyCheckInDismissState';

describe('daily check-in dismiss state', () => {
  beforeEach(() => {
    storeMock.getItem.mockReset();
    storeMock.setItem.mockReset();
  });

  test('uses server time in the activity timezone as the business date', () => {
    expect(getActivityBusinessDate(
      '2026-07-30T16:30:00.000Z',
      'Asia/Shanghai',
    )).toBe('2026-07-31');
  });

  test('falls back to the UTC date for an invalid timezone', () => {
    expect(getActivityBusinessDate(
      '2026-07-30T16:30:00.000Z',
      'Invalid/Timezone',
    )).toBe('2026-07-30');
  });

  test('only suppresses the activity on the date it was dismissed', () => {
    const state = {
      businessDate: '2026-07-30',
      dismissedAt: 1_788_000_000_000,
    };

    expect(isDailyCheckInDismissedForDate(state, '2026-07-30')).toBe(true);
    expect(isDailyCheckInDismissedForDate(state, '2026-07-31')).toBe(false);
    expect(isDailyCheckInDismissedForDate(null, '2026-07-30')).toBe(false);
  });

  test('persists and reads the latest dismissed business date', async () => {
    const key = getDailyCheckInDismissKey('daily-check-in', 3);
    await expect(saveDailyCheckInDismissState(
      key,
      '2026-07-30',
      1_788_000_000_000,
    )).resolves.toEqual({
      businessDate: '2026-07-30',
      dismissedAt: 1_788_000_000_000,
    });
    expect(storeMock.setItem).toHaveBeenCalledWith(key, {
      businessDate: '2026-07-30',
      dismissedAt: 1_788_000_000_000,
    });

    storeMock.getItem.mockResolvedValue({
      businessDate: '2026-07-30',
      dismissedAt: 1_788_000_000_000,
    });
    await expect(readDailyCheckInDismissState(key)).resolves.toEqual({
      businessDate: '2026-07-30',
      dismissedAt: 1_788_000_000_000,
    });
  });
});
