/**
 * Pure validation helpers for the scheduled task form.
 * Kept separate from utils.ts so they can be imported in unit tests
 * without pulling in cronstrue (which is not available in the Node test env).
 */

/**
 * Validate the "once" (no-repeat) schedule fields from the task form.
 * Returns an i18n error key if invalid, or null if the values are acceptable.
 *
 * @param year   Year from form state. 0 means the user cleared the date input.
 * @param month  Month (1-based)
 * @param day    Day of month
 * @param hour   Hour (0-23)
 * @param minute Minute (0-59)
 * @param second Second (0-59)
 * @param now    Current timestamp in ms (injectable for testing; defaults to Date.now())
 */
export function validateOnceSchedule(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  now = Date.now(),
): 'scheduledTasksFormValidationDateRequired' | 'scheduledTasksFormValidationDatetimeFuture' | null {
  if (!year) {
    return 'scheduledTasksFormValidationDateRequired';
  }
  const runAt = new Date(year, month - 1, day, hour, minute, second);
  if (runAt.getTime() <= now) {
    return 'scheduledTasksFormValidationDatetimeFuture';
  }
  return null;
}
