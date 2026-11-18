import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isReminderSystemTurn } = require('../dist-electron/main/im/imScheduledTaskHandler.js');

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
