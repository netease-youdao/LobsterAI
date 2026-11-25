import { describe, expect, test } from 'vitest';

import {
  buildRailTooltipContent,
  formatRailTooltipTimestamp,
  formatRailTurnPosition,
  resolveRailTurnTimestamp,
} from './conversationRailTooltip';

const ZH_LABELS = {
  unloadedTitle: '未加载消息',
  unloadedHint: '点击加载该位置附近的消息',
  turnPositionTemplate: '第 {current} / {total} 轮',
};

const EN_LABELS = {
  unloadedTitle: 'Unloaded message',
  unloadedHint: 'Click to load messages around this position',
  turnPositionTemplate: '{current} of {total}',
};

describe('resolveRailTurnTimestamp', () => {
  test('prefers the user message timestamp when valid', () => {
    expect(resolveRailTurnTimestamp(1700000000000, 1700000050000)).toBe(1700000000000);
  });

  test('falls back to the assistant message timestamp for orphan turns or invalid user timestamps', () => {
    expect(resolveRailTurnTimestamp(null, 1700000050000)).toBe(1700000050000);
    expect(resolveRailTurnTimestamp(0, 1700000050000)).toBe(1700000050000);
    expect(resolveRailTurnTimestamp(Number.NaN, 1700000050000)).toBe(1700000050000);
  });

  test('returns null when neither timestamp is valid', () => {
    expect(resolveRailTurnTimestamp(null, undefined)).toBeNull();
    expect(resolveRailTurnTimestamp(0, -100)).toBeNull();
  });
});

describe('formatRailTurnPosition', () => {
  test('formats 1-based current and total turn counts for zh and en templates', () => {
    expect(formatRailTurnPosition(1, 5, ZH_LABELS.turnPositionTemplate)).toBe('第 2 / 5 轮');
    expect(formatRailTurnPosition(1, 5, EN_LABELS.turnPositionTemplate)).toBe('2 of 5');
  });

  test('returns empty string for out-of-range or invalid counts', () => {
    expect(formatRailTurnPosition(-1, 5, EN_LABELS.turnPositionTemplate)).toBe('');
    expect(formatRailTurnPosition(5, 5, EN_LABELS.turnPositionTemplate)).toBe('');
    expect(formatRailTurnPosition(0, 0, EN_LABELS.turnPositionTemplate)).toBe('');
  });
});

describe('formatRailTooltipTimestamp', () => {
  test('always includes full date and time', () => {
    const timestamp = new Date(2026, 10, 24, 12, 28, 45).getTime();
    expect(formatRailTooltipTimestamp(timestamp)).toBe('2026/11/24 12:28');
  });

  test('returns empty string for missing or non-positive timestamps', () => {
    expect(formatRailTooltipTimestamp(null)).toBe('');
    expect(formatRailTooltipTimestamp(undefined)).toBe('');
    expect(formatRailTooltipTimestamp(0)).toBe('');
    expect(formatRailTooltipTimestamp(Number.NaN)).toBe('');
  });
});

describe('buildRailTooltipContent', () => {
  test('includes turn position and full date-time for normal turns', () => {
    const timestamp = new Date(2026, 10, 24, 9, 5).getTime();
    expect(buildRailTooltipContent({
      item: {
        label: '按你上面的结论来干吧',
        summary: '已按最优方案完成',
        timestamp,
      },
      railIndex: 1,
      totalCount: 5,
      hasPlaceholderItems: false,
      labels: ZH_LABELS,
    })).toEqual({
      title: '按你上面的结论来干吧',
      summary: '已按最优方案完成',
      turnPosition: '第 2 / 5 轮',
      timestampText: '2026/11/24 09:05',
    });
  });

  test('omits turn position and timestamp for placeholder items', () => {
    expect(buildRailTooltipContent({
      item: {
        label: 'Turn 3',
        summary: '',
        timestamp: null,
        isPlaceholder: true,
      },
      railIndex: 2,
      totalCount: 20,
      hasPlaceholderItems: true,
      labels: EN_LABELS,
    })).toEqual({
      title: 'Unloaded message',
      summary: 'Click to load messages around this position',
      turnPosition: '',
      timestampText: '',
    });
  });

  test('omits estimated turn position while keeping valid timestamp if placeholders exist', () => {
    const timestamp = new Date(2026, 10, 24, 14, 30).getTime();
    expect(buildRailTooltipContent({
      item: {
        label: 'Follow up question',
        summary: 'Reply summary',
        timestamp,
      },
      railIndex: 19,
      totalCount: 20,
      hasPlaceholderItems: true,
      labels: EN_LABELS,
    })).toEqual({
      title: 'Follow up question',
      summary: 'Reply summary',
      turnPosition: '',
      timestampText: '2026/11/24 14:30',
    });
  });
});
