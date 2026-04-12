import { test, expect } from 'vitest';
import {
  parseScheduledReminderPrompt,
  parseLegacyScheduledReminderSystemMessage,
  isSimpleScheduledReminderText,
  parseSimpleScheduledReminderText,
  getScheduledReminderDisplayText,
} from './reminderText';

const PREFIX = 'A scheduled reminder has been triggered. The reminder content is:';
const INTERNAL = 'Handle this reminder internally. Do not relay it to the user unless explicitly requested.';
const RELAY = 'Please relay this reminder to the user in a helpful and friendly way.';
const TIME_PREFIX = 'Current time:';

// ---------------------------------------------------------------------------
// parseScheduledReminderPrompt
// ---------------------------------------------------------------------------

test('parseScheduledReminderPrompt: returns null when text does not start with prefix', () => {
  expect(parseScheduledReminderPrompt('Hello world')).toBe(null);
});

test('parseScheduledReminderPrompt: returns null for empty string', () => {
  expect(parseScheduledReminderPrompt('')).toBe(null);
});

test('parseScheduledReminderPrompt: returns null when prefix only, no reminder text', () => {
  expect(parseScheduledReminderPrompt(PREFIX)).toBe(null);
  expect(parseScheduledReminderPrompt(`${PREFIX}   `)).toBe(null);
});

test('parseScheduledReminderPrompt: parses plain reminder text', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Buy groceries`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Buy groceries');
  expect(result!.currentTime).toBe(undefined);
});

test('parseScheduledReminderPrompt: trims input before matching prefix', () => {
  const result = parseScheduledReminderPrompt(`  ${PREFIX} Weekly report due  `);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Weekly report due');
});

test('parseScheduledReminderPrompt: strips trailing internal instruction', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Stand up meeting ${INTERNAL}`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Stand up meeting');
});

test('parseScheduledReminderPrompt: strips trailing relay instruction', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Take a break ${RELAY}`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Take a break');
});

test('parseScheduledReminderPrompt: extracts currentTime from trailing segment', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Call dentist ${TIME_PREFIX} 14:30`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Call dentist');
  expect(result!.currentTime).toBe('14:30');
});

test('parseScheduledReminderPrompt: handles multi-word reminder text', () => {
  const msg = 'Please check the server logs and alert if disk usage is above 90%';
  const result = parseScheduledReminderPrompt(`${PREFIX} ${msg}`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe(msg);
});

// ---------------------------------------------------------------------------
// parseLegacyScheduledReminderSystemMessage
// ---------------------------------------------------------------------------

test('parseLegacyScheduledReminderSystemMessage: returns null for plain text', () => {
  expect(parseLegacyScheduledReminderSystemMessage('Hello world')).toBe(null);
});

test('parseLegacyScheduledReminderSystemMessage: returns null for empty string', () => {
  expect(parseLegacyScheduledReminderSystemMessage('')).toBe(null);
});

test('parseLegacyScheduledReminderSystemMessage: parses System line with brackets and emoji', () => {
  const result = parseLegacyScheduledReminderSystemMessage('System: [2026-03-27 14:00] ⏰ Daily standup');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰ Daily standup');
  expect(result!.currentTime).toBe('2026-03-27 14:00');
});

test('parseLegacyScheduledReminderSystemMessage: parses System line without brackets', () => {
  const result = parseLegacyScheduledReminderSystemMessage('System: ⏰ Weekly team sync');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰ Weekly team sync');
  expect(result!.currentTime).toBe(undefined);
});

test('parseLegacyScheduledReminderSystemMessage: returns null if emoji is missing', () => {
  expect(parseLegacyScheduledReminderSystemMessage('System: [2026-03-27] Reminder without emoji')).toBe(null);
});

test('parseLegacyScheduledReminderSystemMessage: falls back to wrapped prompt in remainder', () => {
  const wrapped = `${PREFIX} Check deployments ${INTERNAL}`;
  const result = parseLegacyScheduledReminderSystemMessage(`System: [2026-03-27] ⏰ Override\n${wrapped}`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Check deployments');
});

test('parseLegacyScheduledReminderSystemMessage: returns null for text without System: prefix', () => {
  expect(parseLegacyScheduledReminderSystemMessage('⏰ Just a clock')).toBe(null);
});

// ---------------------------------------------------------------------------
// isSimpleScheduledReminderText
// ---------------------------------------------------------------------------

test('isSimpleScheduledReminderText: returns true for text starting with emoji followed by space', () => {
  expect(isSimpleScheduledReminderText('⏰ Check email')).toBe(true);
});

test('isSimpleScheduledReminderText: returns true for bare emoji', () => {
  expect(isSimpleScheduledReminderText('⏰')).toBe(true);
});

test('isSimpleScheduledReminderText: trims leading whitespace before checking', () => {
  expect(isSimpleScheduledReminderText('  ⏰ Alarm')).toBe(true);
});

test('isSimpleScheduledReminderText: returns false for text without emoji at start', () => {
  expect(isSimpleScheduledReminderText('Reminder ⏰')).toBe(false);
});

test('isSimpleScheduledReminderText: returns false for empty string', () => {
  expect(isSimpleScheduledReminderText('')).toBe(false);
});

test('isSimpleScheduledReminderText: returns false for plain text', () => {
  expect(isSimpleScheduledReminderText('Daily standup at 9am')).toBe(false);
});

// ---------------------------------------------------------------------------
// parseSimpleScheduledReminderText
// ---------------------------------------------------------------------------

test('parseSimpleScheduledReminderText: returns prompt for simple emoji text', () => {
  const result = parseSimpleScheduledReminderText('⏰ Check mail');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰ Check mail');
  expect(result!.currentTime).toBe(undefined);
});

test('parseSimpleScheduledReminderText: returns null for non-simple text', () => {
  expect(parseSimpleScheduledReminderText('No emoji here')).toBe(null);
});

test('parseSimpleScheduledReminderText: preserves the full original trimmed text', () => {
  const result = parseSimpleScheduledReminderText('  ⏰ Buy milk and eggs  ');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰ Buy milk and eggs');
});

test('parseSimpleScheduledReminderText: bare emoji returns prompt with just the emoji', () => {
  const result = parseSimpleScheduledReminderText('⏰');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰');
});

// ---------------------------------------------------------------------------
// getScheduledReminderDisplayText
// ---------------------------------------------------------------------------

test('getScheduledReminderDisplayText: returns text for standard format', () => {
  expect(
    getScheduledReminderDisplayText(`${PREFIX} Attend weekly planning`),
  ).toBe('Attend weekly planning');
});

test('getScheduledReminderDisplayText: returns text for legacy format', () => {
  expect(
    getScheduledReminderDisplayText('System: [09:00] ⏰ Morning standup'),
  ).toBe('⏰ Morning standup');
});

test('getScheduledReminderDisplayText: returns text for simple emoji format', () => {
  expect(getScheduledReminderDisplayText('⏰ Walk the dog')).toBe('⏰ Walk the dog');
});

test('getScheduledReminderDisplayText: returns null for unrecognized text', () => {
  expect(getScheduledReminderDisplayText('Just a normal message')).toBe(null);
});

test('getScheduledReminderDisplayText: returns null for empty string', () => {
  expect(getScheduledReminderDisplayText('')).toBe(null);
});

test('getScheduledReminderDisplayText: standard format strips internal instruction suffix', () => {
  const result = getScheduledReminderDisplayText(`${PREFIX} Deploy to production ${INTERNAL}`);
  expect(result).toBe('Deploy to production');
});
