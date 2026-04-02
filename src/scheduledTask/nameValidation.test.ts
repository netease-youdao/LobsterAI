import { describe, expect, test } from 'vitest';
import {
  hasDuplicateScheduledTaskName,
  normalizeScheduledTaskName,
} from './nameValidation';

describe('normalizeScheduledTaskName', () => {
  test('returns empty string for whitespace-only names', () => {
    expect(normalizeScheduledTaskName('   ')).toBe('');
  });

  test('trims leading and trailing whitespace', () => {
    expect(normalizeScheduledTaskName('  Daily Report  ')).toBe('Daily Report');
  });
});

describe('hasDuplicateScheduledTaskName', () => {
  const tasks = [
    { id: 'task-1', name: 'Daily Report' },
    { id: 'task-2', name: 'Weekly Digest' },
  ];

  test('returns true for an exact duplicate name', () => {
    expect(hasDuplicateScheduledTaskName(tasks, 'Daily Report')).toBe(true);
  });

  test('returns true for a trimmed duplicate name', () => {
    expect(hasDuplicateScheduledTaskName(tasks, '  Daily Report  ')).toBe(true);
  });

  test('excludes the current task id when editing', () => {
    expect(hasDuplicateScheduledTaskName(tasks, 'Daily Report', 'task-1')).toBe(false);
  });

  test('returns false for a different name', () => {
    expect(hasDuplicateScheduledTaskName(tasks, 'Monthly Review')).toBe(false);
  });
});
