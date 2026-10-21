import { describe, expect, test } from 'vitest';

import { COMPANION_RECENT_TASK_LIMIT, CompanionResultMessageType as Kind, getCompanionTaskPreview, normalizeCompanionTaskRecords } from './results';

describe('persisted companion task history', () => {
  test('ignores corrupt records and duplicates without losing valid entries', () => {
    expect(normalizeCompanionTaskRecords([null, {}, { sessionId: '' }, { sessionId: 12 },
      { sessionId: 'one', viewedAt: 20 }, { sessionId: 'one', viewedAt: 50 },
      { sessionId: 'two', viewedAt: Infinity }, { sessionId: 'three', viewedAt: -1 },
    ])).toEqual([{ sessionId: 'one', viewedAt: 20 }, { sessionId: 'two', viewedAt: 0 }, { sessionId: 'three', viewedAt: 0 }]);
    expect(normalizeCompanionTaskRecords('bad')).toEqual([]);
  });
  test('bounds the recent list and preserves its newest-first order', () => {
    const value = Array.from({ length: 50 }, (_, i) => ({ sessionId: `task-${i}`, viewedAt: 0 }));
    expect(normalizeCompanionTaskRecords(value)).toEqual(value.slice(0, COMPANION_RECENT_TASK_LIMIT));
  });
});

describe('companion task summary', () => {
  test('shows a bounded plain-text answer without Markdown decoration', () => {
    expect(getCompanionTaskPreview({ type: Kind.Assistant, content: '**已优化**，查看[结果](https://example.com)\n整体更轻。' }))
      .toBe('已优化，查看结果 整体更轻。');
    expect(getCompanionTaskPreview({ type: Kind.Assistant, content: '长'.repeat(500) })).toHaveLength(180);
  });
  test('does not expose thinking, errors, tool output or the previous answer after a new request', () => {
    for (const type of [Kind.User, Kind.ToolUse, Kind.ToolResult, Kind.System]) {
      expect(getCompanionTaskPreview({ type, content: 'Internal content' })).toBe('');
    }
    for (const metadata of [{ isThinking: true }, { isError: true }, { isFinal: false }]) {
      expect(getCompanionTaskPreview({ type: Kind.Assistant, content: 'Internal content', metadata })).toBe('');
    }
    expect(getCompanionTaskPreview()).toBe('');
  });
});
