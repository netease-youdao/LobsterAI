import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseScheduledReminderPrompt,
  parseLegacyScheduledReminderSystemMessage,
  isSimpleScheduledReminderText,
  parseSimpleScheduledReminderText,
  getScheduledReminderDisplayText,
} = require('../dist-electron/common/scheduledReminderText.js');

// ==================== parseScheduledReminderPrompt ====================

test('parseScheduledReminderPrompt: parses basic reminder text', () => {
  const text = 'A scheduled reminder has been triggered. The reminder content is:喝水时间到了，记得喝水！';
  const result = parseScheduledReminderPrompt(text);
  assert.deepEqual(result, { reminderText: '喝水时间到了，记得喝水！' });
});

test('parseScheduledReminderPrompt: parses with current time', () => {
  const text = 'A scheduled reminder has been triggered. The reminder content is:喝水时间到了，记得喝水！Current time:2026-03-15T10:00:00+08:00';
  const result = parseScheduledReminderPrompt(text);
  assert.deepEqual(result, { reminderText: '喝水时间到了，记得喝水！', currentTime: '2026-03-15T10:00:00+08:00' });
});

test('parseScheduledReminderPrompt: parses with internal instruction', () => {
  const text = 'A scheduled reminder has been triggered. The reminder content is:喝水时间到了，记得喝水！Handle this reminder internally. Do not relay it to the user unless explicitly requested.';
  const result = parseScheduledReminderPrompt(text);
  assert.equal(result.reminderText, '喝水时间到了，记得喝水！');
});

test('parseScheduledReminderPrompt: parses with relay instruction', () => {
  const text = 'A scheduled reminder has been triggered. The reminder content is:喝水时间到了，记得喝水！Please relay this reminder to the user in a helpful and friendly way.';
  const result = parseScheduledReminderPrompt(text);
  assert.equal(result.reminderText, '喝水时间到了，记得喝水！');
});

test('parseScheduledReminderPrompt: returns null for non-reminder text', () => {
  assert.equal(parseScheduledReminderPrompt('Hello world'), null);
  assert.equal(parseScheduledReminderPrompt(''), null);
  assert.equal(parseScheduledReminderPrompt('A scheduled reminder has been triggered.'), null);
});

test('parseScheduledReminderPrompt: handles only currentTime after prefix', () => {
  const text = 'A scheduled reminder has been triggered. The reminder content is:Current time:2026-03-15T10:00:00+08:00';
  const result = parseScheduledReminderPrompt(text);
  assert.equal(result, null);
});

test('parseScheduledReminderPrompt: handles whitespace variations', () => {
  const text = '  A scheduled reminder has been triggered. The reminder content is:  喝水时间到了  ';
  const result = parseScheduledReminderPrompt(text);
  assert.equal(result.reminderText, '喝水时间到了');
});

// ==================== parseLegacyScheduledReminderSystemMessage ====================

test('parseLegacyScheduledReminderSystemMessage: parses legacy format with timestamp', () => {
  const text = 'System: [2026-03-15T10:00:00+08:00] ⏰喝水时间到了，记得喝水！\n\nSome additional content';
  const result = parseLegacyScheduledReminderSystemMessage(text);
  // Legacy parser keeps the ⏰ emoji in reminderText
  assert.equal(result.reminderText, '⏰喝水时间到了，记得喝水！');
  assert.equal(result.currentTime, '2026-03-15T10:00:00+08:00');
});

test('parseLegacyScheduledReminderSystemMessage: parses legacy format without timestamp', () => {
  const text = 'System: ⏰喝水时间到了，记得喝水！';
  const result = parseLegacyScheduledReminderSystemMessage(text);
  // Legacy parser keeps the ⏰ emoji in reminderText
  assert.equal(result.reminderText, '⏰喝水时间到了，记得喝水！');
});

test('parseLegacyScheduledReminderSystemMessage: returns null for non-legacy format', () => {
  assert.equal(parseLegacyScheduledReminderSystemMessage('Hello world'), null);
  assert.equal(parseLegacyScheduledReminderSystemMessage('A scheduled reminder has been triggered. The reminder content is:喝水'), null);
  assert.equal(parseLegacyScheduledReminderSystemMessage(''), null);
});

test('parseLegacyScheduledReminderSystemMessage: falls back to content after system line', () => {
  const text = 'System: [10:00] ⏰Reminder text\nA scheduled reminder has been triggered. The reminder content is:喝水';
  const result = parseLegacyScheduledReminderSystemMessage(text);
  assert.equal(result.reminderText, '喝水');
});

// ==================== isSimpleScheduledReminderText ====================

test('isSimpleScheduledReminderText: detects simple reminder format', () => {
  assert.equal(isSimpleScheduledReminderText('⏰ 喝水时间到了'), true);
  assert.equal(isSimpleScheduledReminderText('⏰'), true);
  assert.equal(isSimpleScheduledReminderText('⏰  '), true);
  assert.equal(isSimpleScheduledReminderText('  ⏰  '), true);
});

test('isSimpleScheduledReminderText: returns false for non-simple format', () => {
  assert.equal(isSimpleScheduledReminderText('Hello world'), false);
  assert.equal(isSimpleScheduledReminderText('Reminder: 喝水时间到了'), false);
  assert.equal(isSimpleScheduledReminderText(''), false);
  // ⏰ without following space does not match
  assert.equal(isSimpleScheduledReminderText('⏰喝水时间到了'), false);
});

// ==================== parseSimpleScheduledReminderText ====================

test('parseSimpleScheduledReminderText: parses simple reminder', () => {
  const result = parseSimpleScheduledReminderText('⏰ 喝水时间到了');
  assert.deepEqual(result, { reminderText: '⏰ 喝水时间到了' });
});

test('parseSimpleScheduledReminderText: returns null for non-simple format', () => {
  assert.equal(parseSimpleScheduledReminderText('Hello world'), null);
  assert.equal(parseSimpleScheduledReminderText(''), null);
});

// ==================== getScheduledReminderDisplayText ====================

test('getScheduledReminderDisplayText: delegates to parseScheduledReminderPrompt', () => {
  const text = 'A scheduled reminder has been triggered. The reminder content is:喝水时间到了';
  assert.equal(getScheduledReminderDisplayText(text), '喝水时间到了');
});

test('getScheduledReminderDisplayText: falls back to legacy parser', () => {
  const text = 'System: [2026-03-15T10:00:00+08:00] ⏰喝水时间到了，记得喝水！';
  // Legacy parser keeps the ⏰ emoji in reminderText
  assert.equal(getScheduledReminderDisplayText(text), '⏰喝水时间到了，记得喝水！');
});

test('getScheduledReminderDisplayText: falls back to simple parser', () => {
  const text = '⏰ 喝水时间到了';
  assert.equal(getScheduledReminderDisplayText(text), '⏰ 喝水时间到了');
});

test('getScheduledReminderDisplayText: returns null for unrecognized format', () => {
  assert.equal(getScheduledReminderDisplayText('Hello world'), null);
  assert.equal(getScheduledReminderDisplayText(''), null);
});
