import { expect,test } from 'vitest';

import { isReminderSystemTurn } from './imScheduledTaskHandler';

test('identifies reminder system turns for async IM delivery', () => {
  expect(isReminderSystemTurn([
    { type: 'assistant', content: '普通回复' },
  ])).toBe(false);

  expect(isReminderSystemTurn([
    { type: 'system', content: '⏰ 提醒：喝饮料' },
    { type: 'assistant', content: '该喝饮料啦！' },
  ])).toBe(true);
});

test('keeps recognizing legacy reminder system messages during transition', () => {
  expect(isReminderSystemTurn([
    { type: 'system', content: 'System: [Sunday, March 15th, 2026 — 4:30 PM] ⏰ 提醒：喝饮料' },
    { type: 'assistant', content: '该喝饮料啦！' },
  ])).toBe(true);
});

test('recognizes plain reminder text turns during runtime hotfix rollout', () => {
  expect(isReminderSystemTurn([
    { type: 'user', content: '⏰ 提醒：该去钉钉打卡啦！别忘了打卡哦～' },
    { type: 'assistant', content: '⏰ 时间到啦，该去打卡了。' },
  ])).toBe(true);
});
