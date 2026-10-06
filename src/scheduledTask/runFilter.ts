import type { RunFilter, ScheduledTaskRun } from './types';

/** Shared by history pagination and the renderer's live run filtering. */
export function createRunFilter(
  filter: RunFilter = {},
): (run: Pick<ScheduledTaskRun, 'startedAt' | 'status'>) => boolean {
  const { startDate, endDate, status } = filter;
  const startMs = startDate
    ? new Date(`${startDate}T00:00:00`).getTime()
    : Number.NEGATIVE_INFINITY;
  const end = endDate ? new Date(`${endDate}T00:00:00`) : null;
  // Use the next local midnight to include the entire end date, including
  // milliseconds, and account for days shortened or extended by daylight saving.
  if (end) end.setDate(end.getDate() + 1);
  const endMs = end?.getTime() ?? Number.POSITIVE_INFINITY;

  return run => {
    if (status && run.status !== status) return false;
    if (!startDate && !endDate) return true;
    const startedAtMs = new Date(run.startedAt).getTime();
    return startedAtMs >= startMs && startedAtMs < endMs;
  };
}
