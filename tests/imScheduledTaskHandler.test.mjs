import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  looksLikeIMScheduledTaskCandidate,
  normalizeDetectedScheduledTaskRequest,
  isReminderSystemTurn,
} = require('../dist-electron/main/im/imScheduledTaskHandler.js');

test('normalizes model-detected IM reminder requests into direct cron.add inputs', () => {
  const parsed = normalizeDetectedScheduledTaskRequest(
    {
      shouldCreateTask: true,
      scheduleAt: '2026-03-15T16:30:00+08:00',
      reminderBody: '喝饮料',
      taskName: '喝饮料提醒',
    },
    '2分钟后提醒我喝饮料',
    new Date('2026-03-15T16:28:00+08:00'),
  );

  assert.ok(parsed);
  assert.equal(parsed.kind, 'create');
  assert.equal(parsed.reminderBody, '喝饮料');
  assert.equal(parsed.taskName, '喝饮料提醒');
  assert.equal(parsed.payloadText, '⏰ 提醒：喝饮料');
  assert.equal(parsed.delayLabel, '2分钟后');
  // scheduleAt may be in any timezone representation; compare as absolute timestamps
  assert.equal(new Date(parsed.scheduleAt).getTime(), new Date('2026-03-15T16:30:00+08:00').getTime());
  assert.match(parsed.confirmationText, /2分钟后.*会提醒你喝饮料/u);
});

test('only uses heuristic as a cheap reminder candidate prefilter', () => {
  assert.equal(looksLikeIMScheduledTaskCandidate('帮我总结一下今天的会议纪要'), false);
  assert.equal(looksLikeIMScheduledTaskCandidate('2分钟后提醒我喝饮料'), true);
});

test('rejects detector payloads without a future timezone-aware timestamp', () => {
  assert.equal(normalizeDetectedScheduledTaskRequest({
    shouldCreateTask: true,
    scheduleAt: '2026-03-15T16:30:00',
    reminderBody: '喝水',
  }, '提醒我喝水', new Date('2026-03-15T16:28:00+08:00')), null);
});

test('identifies reminder system turns for async IM delivery', () => {
  assert.equal(isReminderSystemTurn([
    { type: 'assistant', content: '普通回复' },
  ]), false);

  assert.equal(isReminderSystemTurn([
    { type: 'system', content: '⏰ 提醒：喝饮料' },
    { type: 'assistant', content: '该喝饮料啦！' },
  ]), true);
});

test('keeps recognizing legacy reminder system messages during transition', () => {
  assert.equal(isReminderSystemTurn([
    { type: 'system', content: 'System: [Sunday, March 15th, 2026 — 4:30 PM] ⏰ 提醒：喝饮料' },
    { type: 'assistant', content: '该喝饮料啦！' },
  ]), true);
});

test('recognizes plain reminder text turns during runtime hotfix rollout', () => {
  assert.equal(isReminderSystemTurn([
    { type: 'user', content: '⏰ 提醒：该去钉钉打卡啦！别忘了打卡哦～' },
    { type: 'assistant', content: '⏰ 时间到啦，该去打卡了。' },
  ]), true);
});
