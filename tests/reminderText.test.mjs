/**
 * Unit tests for src/scheduled-task/reminderText.ts
 *
 * Covers all five exported functions:
 *   - parseScheduledReminderPrompt
 *   - parseLegacyScheduledReminderSystemMessage
 *   - isSimpleScheduledReminderText
 *   - parseSimpleScheduledReminderText
 *   - getScheduledReminderDisplayText
 *
 * Run: node --test tests/reminderText.test.mjs
 * Coverage: node --experimental-test-coverage --test tests/reminderText.test.mjs
 */
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
} = require('../dist-electron/scheduledTask/reminderText.js');

const PREFIX = 'A scheduled reminder has been triggered. The reminder content is:';
const INTERNAL = 'Handle this reminder internally. Do not relay it to the user unless explicitly requested.';
const RELAY = 'Please relay this reminder to the user in a helpful and friendly way.';
const TIME_PREFIX = 'Current time:';

// ---------------------------------------------------------------------------
// parseScheduledReminderPrompt
// ---------------------------------------------------------------------------

test('parseScheduledReminderPrompt: returns null when text does not start with prefix', () => {
  assert.equal(parseScheduledReminderPrompt('Hello world'), null);
});

test('parseScheduledReminderPrompt: returns null for empty string', () => {
  assert.equal(parseScheduledReminderPrompt(''), null);
});

test('parseScheduledReminderPrompt: returns null when prefix only, no reminder text', () => {
  assert.equal(parseScheduledReminderPrompt(PREFIX), null);
  assert.equal(parseScheduledReminderPrompt(`${PREFIX}   `), null);
});

test('parseScheduledReminderPrompt: parses plain reminder text', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Buy groceries`);
  assert.notEqual(result, null);
  assert.equal(result.reminderText, 'Buy groceries');
  assert.equal(result.currentTime, undefined);
});

test('parseScheduledReminderPrompt: trims input before matching prefix', () => {
  const result = parseScheduledReminderPrompt(`  ${PREFIX} Weekly report due  `);
  assert.notEqual(result, null);
  assert.equal(result.reminderText, 'Weekly report due');
});

test('parseScheduledReminderPrompt: strips trailing internal instruction', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Stand up meeting ${INTERNAL}`);
  assert.notEqual(result, null);
  assert.equal(result.reminderText, 'Stand up meeting');
});

test('parseScheduledReminderPrompt: strips trailing relay instruction', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Take a break ${RELAY}`);
  assert.notEqual(result, null);
  assert.equal(result.reminderText, 'Take a break');
});

test('parseScheduledReminderPrompt: extracts currentTime from trailing segment', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Call dentist ${TIME_PREFIX} 14:30`);
  assert.notEqual(result, null);
  assert.equal(result.reminderText, 'Call dentist');
  assert.equal(result.currentTime, '14:30');
});

test('parseScheduledReminderPrompt: handles multi-word reminder text', () => {
  const msg = 'Please check the server logs and alert if disk usage is above 90%';
  const result = parseScheduledReminderPrompt(`${PREFIX} ${msg}`);
  assert.notEqual(result, null);
  assert.equal(result.reminderText, msg);
});

// ---------------------------------------------------------------------------
// parseLegacyScheduledReminderSystemMessage
// ---------------------------------------------------------------------------

test('parseLegacyScheduledReminderSystemMessage: returns null for plain text', () => {
  assert.equal(parseLegacyScheduledReminderSystemMessage('Hello world'), null);
});

test('parseLegacyScheduledReminderSystemMessage: returns null for empty string', () => {
  assert.equal(parseLegacyScheduledReminderSystemMessage(''), null);
});

test('parseLegacyScheduledReminderSystemMessage: parses System line with brackets and emoji', () => {
  const result = parseLegacyScheduledReminderSystemMessage('System: [2026-03-27 14:00] ⏰ Daily standup');
  assert.notEqual(result, null);
  assert.equal(result.reminderText, '⏰ Daily standup');
  assert.equal(result.currentTime, '2026-03-27 14:00');
});

test('parseLegacyScheduledReminderSystemMessage: parses System line without brackets', () => {
  const result = parseLegacyScheduledReminderSystemMessage('System: ⏰ Weekly team sync');
  assert.notEqual(result, null);
  assert.equal(result.reminderText, '⏰ Weekly team sync');
  assert.equal(result.currentTime, undefined);
});

test('parseLegacyScheduledReminderSystemMessage: returns null if ⏰ is missing', () => {
  assert.equal(parseLegacyScheduledReminderSystemMessage('System: [2026-03-27] Reminder without emoji'), null);
});

test('parseLegacyScheduledReminderSystemMessage: falls back to wrapped prompt in remainder', () => {
  const wrapped = `${PREFIX} Check deployments ${INTERNAL}`;
  const result = parseLegacyScheduledReminderSystemMessage(`System: [2026-03-27] ⏰ Override\n${wrapped}`);
  assert.notEqual(result, null);
  assert.equal(result.reminderText, 'Check deployments');
});

test('parseLegacyScheduledReminderSystemMessage: returns null for text without System: prefix', () => {
  assert.equal(parseLegacyScheduledReminderSystemMessage('⏰ Just a clock'), null);
});

// ---------------------------------------------------------------------------
// isSimpleScheduledReminderText
// ---------------------------------------------------------------------------

test('isSimpleScheduledReminderText: returns true for text starting with ⏰ followed by space', () => {
  assert.equal(isSimpleScheduledReminderText('⏰ Check email'), true);
});

test('isSimpleScheduledReminderText: returns true for bare ⏰ emoji', () => {
  assert.equal(isSimpleScheduledReminderText('⏰'), true);
});

test('isSimpleScheduledReminderText: trims leading whitespace before checking', () => {
  assert.equal(isSimpleScheduledReminderText('  ⏰ Alarm'), true);
});

test('isSimpleScheduledReminderText: returns false for text without ⏰ at start', () => {
  assert.equal(isSimpleScheduledReminderText('Reminder ⏰'), false);
});

test('isSimpleScheduledReminderText: returns false for empty string', () => {
  assert.equal(isSimpleScheduledReminderText(''), false);
});

test('isSimpleScheduledReminderText: returns false for plain text', () => {
  assert.equal(isSimpleScheduledReminderText('Daily standup at 9am'), false);
});

// ---------------------------------------------------------------------------
// parseSimpleScheduledReminderText
// ---------------------------------------------------------------------------

test('parseSimpleScheduledReminderText: returns prompt for simple ⏰ text', () => {
  const result = parseSimpleScheduledReminderText('⏰ Check mail');
  assert.notEqual(result, null);
  assert.equal(result.reminderText, '⏰ Check mail');
  assert.equal(result.currentTime, undefined);
});

test('parseSimpleScheduledReminderText: returns null for non-simple text', () => {
  assert.equal(parseSimpleScheduledReminderText('No emoji here'), null);
});

test('parseSimpleScheduledReminderText: preserves the full original trimmed text', () => {
  const result = parseSimpleScheduledReminderText('  ⏰ Buy milk and eggs  ');
  assert.notEqual(result, null);
  assert.equal(result.reminderText, '⏰ Buy milk and eggs');
});

test('parseSimpleScheduledReminderText: bare ⏰ returns prompt with just the emoji', () => {
  const result = parseSimpleScheduledReminderText('⏰');
  assert.notEqual(result, null);
  assert.equal(result.reminderText, '⏰');
});

// ---------------------------------------------------------------------------
// getScheduledReminderDisplayText
// ---------------------------------------------------------------------------

test('getScheduledReminderDisplayText: returns text for standard format', () => {
  assert.equal(
    getScheduledReminderDisplayText(`${PREFIX} Attend weekly planning`),
    'Attend weekly planning'
  );
});

test('getScheduledReminderDisplayText: returns text for legacy format', () => {
  assert.equal(
    getScheduledReminderDisplayText('System: [09:00] ⏰ Morning standup'),
    '⏰ Morning standup'
  );
});

test('getScheduledReminderDisplayText: returns text for simple ⏰ format', () => {
  assert.equal(getScheduledReminderDisplayText('⏰ Walk the dog'), '⏰ Walk the dog');
});

test('getScheduledReminderDisplayText: returns null for unrecognized text', () => {
  assert.equal(getScheduledReminderDisplayText('Just a normal message'), null);
});

test('getScheduledReminderDisplayText: returns null for empty string', () => {
  assert.equal(getScheduledReminderDisplayText(''), null);
});

test('getScheduledReminderDisplayText: standard format strips internal instruction suffix', () => {
  const result = getScheduledReminderDisplayText(`${PREFIX} Deploy to production ${INTERNAL}`);
  assert.equal(result, 'Deploy to production');
});
