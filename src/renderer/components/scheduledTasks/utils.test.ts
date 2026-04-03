/**
 * Unit tests for validateOnceSchedule — the "no repeat" schedule validation
 * helper extracted from TaskForm.tsx.
 *
 * Bug covered (issue #1437):
 *   When the user selected "no repeat" (once) and cleared the date input,
 *   the form's onChange handler silently discarded the empty value (NaN guard)
 *   leaving stale year/month/day in state.  validate() then built a valid Date
 *   from that stale data, set no error, and handleSubmit() proceeded silently —
 *   giving the impression that the "Create Task" button did nothing.
 *
 * Fix:
 *   - onChange now stores year=0/month=0/day=0 when the input is cleared.
 *   - validateOnceSchedule returns 'scheduledTasksFormValidationDateRequired'
 *     when year === 0 (falsy), blocking submission and showing an error.
 */
import { test, expect } from 'vitest';
import { validateOnceSchedule } from './taskFormValidation';

// A fixed "now" used as reference so tests are not time-sensitive.
const NOW = new Date('2026-06-01T12:00:00Z').getTime();

// A datetime safely in the future relative to NOW.
const FUTURE_YEAR = 2026;
const FUTURE_MONTH = 12;
const FUTURE_DAY = 31;
const FUTURE_HOUR = 23;
const FUTURE_MIN = 59;
const FUTURE_SEC = 0;

// ---------------------------------------------------------------------------
// Core bug fix: year=0 (cleared date) must trigger the date-required error
// ---------------------------------------------------------------------------

test('returns date-required error when year is 0 (date field cleared)', () => {
  const result = validateOnceSchedule(0, 0, 0, 9, 0, 0, NOW);
  expect(result).toBe('scheduledTasksFormValidationDateRequired');
});

test('returns date-required error when year is 0 even with valid time', () => {
  const result = validateOnceSchedule(0, 6, 15, 14, 30, 0, NOW);
  expect(result).toBe('scheduledTasksFormValidationDateRequired');
});

// ---------------------------------------------------------------------------
// Future date validation
// ---------------------------------------------------------------------------

test('returns null for a datetime in the future', () => {
  const result = validateOnceSchedule(
    FUTURE_YEAR, FUTURE_MONTH, FUTURE_DAY,
    FUTURE_HOUR, FUTURE_MIN, FUTURE_SEC,
    NOW,
  );
  expect(result).toBeNull();
});

test('returns future-datetime error when date is in the past', () => {
  // 2025-01-01 09:00:00 is before NOW (2026-06-01)
  const result = validateOnceSchedule(2025, 1, 1, 9, 0, 0, NOW);
  expect(result).toBe('scheduledTasksFormValidationDatetimeFuture');
});

test('returns future-datetime error when date equals NOW exactly', () => {
  // Boundary: runAt.getTime() <= now → error (not strictly future)
  const nowDate = new Date(NOW);
  const result = validateOnceSchedule(
    nowDate.getFullYear(),
    nowDate.getMonth() + 1,
    nowDate.getDate(),
    nowDate.getHours(),
    nowDate.getMinutes(),
    nowDate.getSeconds(),
    NOW,
  );
  expect(result).toBe('scheduledTasksFormValidationDatetimeFuture');
});

test('returns null for a datetime one second in the future', () => {
  const oneSecLater = new Date(NOW + 1000);
  const result = validateOnceSchedule(
    oneSecLater.getFullYear(),
    oneSecLater.getMonth() + 1,
    oneSecLater.getDate(),
    oneSecLater.getHours(),
    oneSecLater.getMinutes(),
    oneSecLater.getSeconds(),
    NOW,
  );
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// date-required takes priority over future-datetime
// ---------------------------------------------------------------------------

test('date-required error takes priority: year=0 with past time still returns date-required', () => {
  // Even if the date would have been in the past, the "date not entered" error
  // should surface first so the user knows they need to fill the date field.
  const result = validateOnceSchedule(0, 1, 1, 0, 0, 0, NOW);
  expect(result).toBe('scheduledTasksFormValidationDateRequired');
});
