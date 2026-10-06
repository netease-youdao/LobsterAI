import { describe, expect, test } from 'vitest';

import {
  formatLibraryDateGroupTitle,
  getLibraryDateGroupKey,
  groupLibraryItemsByDateAndSession,
} from './libraryDateGrouping';

const titleOptions = {
  locale: 'zh-CN',
  todayLabel: '今天',
  yesterdayLabel: '昨天',
};

describe('library date grouping', () => {
  test('uses the local calendar date as the group key', () => {
    expect(getLibraryDateGroupKey(new Date(2026, 6, 23, 0, 1).getTime())).toBe('2026-07-23');
    expect(getLibraryDateGroupKey(new Date(2026, 6, 23, 23, 59).getTime())).toBe('2026-07-23');
    expect(getLibraryDateGroupKey(new Date(2026, 6, 22, 23, 59).getTime())).toBe('2026-07-22');
  });

  test('keeps friendly titles for today and yesterday', () => {
    const now = new Date(2026, 7, 18, 9, 30).getTime();
    expect(formatLibraryDateGroupTitle(
      new Date(2026, 7, 18, 1).getTime(),
      { ...titleOptions, now },
    )).toBe('今天');
    expect(formatLibraryDateGroupTitle(
      new Date(2026, 7, 17, 23).getTime(),
      { ...titleOptions, now },
    )).toBe('昨天');
  });

  test('shows a concrete date for older groups and includes the year when needed', () => {
    const now = new Date(2026, 7, 18, 9, 30).getTime();
    expect(formatLibraryDateGroupTitle(
      new Date(2026, 6, 23, 14, 34).getTime(),
      { ...titleOptions, now },
    )).toBe('7月23日');
    expect(formatLibraryDateGroupTitle(
      new Date(2025, 11, 31, 14, 34).getTime(),
      { ...titleOptions, now },
    )).toBe('2025年12月31日');
  });

  test('orders date and session buckets by their newest item', () => {
    const items = [
      { id: 'older-b', time: new Date(2026, 7, 17, 9).getTime(), session: 'b' },
      { id: 'newer-b', time: new Date(2026, 7, 18, 10).getTime(), session: 'b' },
      { id: 'newest-a', time: new Date(2026, 7, 18, 11).getTime(), session: 'a' },
    ];

    const groups = groupLibraryItemsByDateAndSession(
      items,
      item => item.time,
      item => item.session,
    );

    expect(groups.map(group => group.dateKey)).toEqual(['2026-08-18', '2026-08-17']);
    expect(groups[0].sessionBuckets.map(group => group.sessionKey)).toEqual(['a', 'b']);
    expect(groups[0].sessionBuckets.map(group => group.representativeTime)).toEqual([
      items[2].time,
      items[1].time,
    ]);
    expect(groups[0].sessionBuckets.flatMap(group => group.items.map(item => item.id)))
      .toEqual(['newest-a', 'newer-b']);
  });

  test('merges one session within a date but keeps it separate across dates', () => {
    const items = [
      { id: 'today-1', time: new Date(2026, 7, 18, 11).getTime(), session: 'a' },
      { id: 'today-2', time: new Date(2026, 7, 18, 10).getTime(), session: 'a' },
      { id: 'yesterday', time: new Date(2026, 7, 17, 10).getTime(), session: 'a' },
    ];

    const groups = groupLibraryItemsByDateAndSession(
      items,
      item => item.time,
      item => item.session,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0].sessionBuckets).toHaveLength(1);
    expect(groups[0].sessionBuckets[0].items.map(item => item.id)).toEqual(['today-1', 'today-2']);
    expect(groups[1].sessionBuckets[0].items.map(item => item.id)).toEqual(['yesterday']);
  });
});
