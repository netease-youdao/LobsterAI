import { afterEach, describe, expect, test, vi } from 'vitest';

import { TaskStatus } from './constants';
import { createRunFilter } from './runFilter';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createRunFilter', () => {
  test('preserves unfiltered and status-only behavior', () => {
    const run = { startedAt: '', status: TaskStatus.Error };
    expect(createRunFilter()(run)).toBe(true);
    expect(createRunFilter({ status: TaskStatus.Error })(run)).toBe(true);
    expect(createRunFilter({ status: TaskStatus.Success })(run)).toBe(false);
  });

  test('compares UTC run timestamps against local days, including the last millisecond', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const matches = createRunFilter({ startDate: '2026-09-10', endDate: '2026-09-10' });
    const run = (startedAt: string) => ({ startedAt, status: TaskStatus.Success });

    expect(matches(run('2026-09-09T15:59:59.999Z'))).toBe(false);
    expect(matches(run('2026-09-09T16:00:00.000Z'))).toBe(true);
    expect(matches(run('2026-09-10T15:59:59.999Z'))).toBe(true);
    expect(matches(run('2026-09-10T16:00:00.000Z'))).toBe(false);
  });

  test.each([
    { date: '2026-03-08', start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' },
    { date: '2026-11-01', start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' },
  ])('uses local calendar boundaries across daylight saving on $date', ({ date, start, end }) => {
    vi.stubEnv('TZ', 'America/New_York');
    const matches = createRunFilter({ startDate: date, endDate: date });
    const run = (startedAt: string) => ({ startedAt, status: TaskStatus.Success });

    expect(matches(run(new Date(Date.parse(start) - 1).toISOString()))).toBe(false);
    expect(matches(run(start))).toBe(true);
    expect(matches(run(new Date(Date.parse(end) - 1).toISOString()))).toBe(true);
    expect(matches(run(end))).toBe(false);
  });

  test('supports open date bounds while applying status filtering', () => {
    const run = {
      startedAt: new Date('2026-09-10T12:00:00').toISOString(),
      status: TaskStatus.Success,
    };
    expect(createRunFilter({ startDate: '2026-09-10' })(run)).toBe(true);
    expect(createRunFilter({ endDate: '2026-09-10' })(run)).toBe(true);
    expect(createRunFilter({ startDate: '2026-09-11' })(run)).toBe(false);
    expect(createRunFilter({ endDate: '2026-09-09' })(run)).toBe(false);
    expect(createRunFilter({ endDate: '2026-09-10', status: TaskStatus.Error })(run)).toBe(false);
  });

  test('does not match an invalid run timestamp when filtering dates', () => {
    expect(createRunFilter({ startDate: '2026-09-10' })({
      startedAt: 'invalid',
      status: TaskStatus.Success,
    })).toBe(false);
  });
});
