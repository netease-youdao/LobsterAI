import { expect,test } from 'vitest';

import {
  isReminderSystemTurn,
  looksLikeIMScheduledTaskCandidate,
  normalizeDetectedScheduledTaskRequest,
} from './imScheduledTaskHandler';

test('normalizes model-detected IM reminder requests into direct cron.add inputs', () => {
  const scheduleAtInput = '2026-03-15T16:30:00+08:00';
  const runAt = new Date(scheduleAtInput);
  const expectedClock = '16:30';
  const parsed = normalizeDetectedScheduledTaskRequest(
    {
      shouldCreateTask: true,
      scheduleAt: scheduleAtInput,
      reminderBody: '喝饮料',
      taskName: '喝饮料提醒',
    },
    '2分钟后提醒我喝饮料',
    new Date('2026-03-15T16:28:00+08:00'),
  );

  expect(parsed).toBeTruthy();
  expect(parsed!.kind).toBe('create');
  expect(parsed!.reminderBody).toBe('喝饮料');
  expect(parsed!.taskName).toBe('喝饮料提醒');
  expect(parsed!.payloadText).toBe('⏰ 提醒：喝饮料');
  expect(parsed!.delayLabel).toBe('2分钟后');
  expect(parsed!.runAt.toISOString()).toBe(runAt.toISOString());
  expect(new Date(parsed!.scheduleAt).toISOString()).toBe(runAt.toISOString());
  expect(parsed!.confirmationText).toMatch(new RegExp(`2分钟后（${expectedClock}）会提醒你喝饮料`, 'u'));
});

test('only uses heuristic as a cheap reminder candidate prefilter', () => {
  expect(looksLikeIMScheduledTaskCandidate('帮我总结一下今天的会议纪要')).toBe(false);
  expect(looksLikeIMScheduledTaskCandidate('2分钟后提醒我喝饮料')).toBe(true);
});

test('rejects detector payloads without a future timezone-aware timestamp', () => {
  expect(normalizeDetectedScheduledTaskRequest({
    shouldCreateTask: true,
    scheduleAt: '2026-03-15T16:30:00',
    reminderBody: '喝水',
  }, '提醒我喝水', new Date('2026-03-15T16:28:00+08:00'))).toBe(null);
});

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
