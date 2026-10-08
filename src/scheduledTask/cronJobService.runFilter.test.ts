import { describe, expect, test, vi } from 'vitest';

import { GatewayStatus, TaskStatus } from './constants';
import { CronJobService } from './cronJobService';
import type { RunFilter } from './types';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

const GatewayMethod = {
  List: 'cron.list',
  Runs: 'cron.runs',
} as const;

interface RunEntry {
  ts: number;
  jobId: string;
  runAtMs?: number;
  status: GatewayStatus;
  error?: string;
  deliveryError?: string;
}

function makeEntry(startedAt: string, overrides: Partial<RunEntry> = {}): RunEntry {
  const timestamp = new Date(startedAt).getTime();
  return {
    ts: timestamp + 1_000,
    jobId: 'user-job',
    runAtMs: timestamp,
    status: GatewayStatus.Ok,
    ...overrides,
  };
}

function createService(entries: RunEntry[]) {
  const runRequests: Array<{ limit: number; offset: number }> = [];
  const service = new CronJobService({
    ensureGatewayReady: async () => {},
    getGatewayClient: () => ({
      request: async <T>(method: string, params?: unknown) => {
        if (method === GatewayMethod.List) return { jobs: [] } as T;
        expect(method).toBe(GatewayMethod.Runs);
        // The gateway rejects these unsupported date parameters before reading history.
        expect(params).not.toHaveProperty('startMs');
        expect(params).not.toHaveProperty('endMs');
        const page = params as { limit: number; offset: number };
        runRequests.push(page);
        return { entries: entries.slice(page.offset, page.offset + page.limit) } as T;
      },
    }),
  });
  return { service, runRequests };
}

const readers = [
  {
    name: 'global',
    read: (service: CronJobService, limit: number, offset: number, filter: RunFilter) =>
      service.listAllRuns(limit, offset, filter),
  },
  {
    name: 'single-task',
    read: (service: CronJobService, limit: number, offset: number, filter: RunFilter) =>
      service.listRuns('user-job', limit, offset, filter),
  },
];

describe.each(readers)('$name history date filtering', ({ read }) => {
  test.each([
    { filter: { startDate: '2026-09-10' }, expectedIndexes: [0, 1, 2] },
    { filter: { endDate: '2026-09-10' }, expectedIndexes: [1, 2, 3] },
    {
      filter: { startDate: '2026-09-10', endDate: '2026-09-10' },
      expectedIndexes: [1, 2],
    },
  ])('filters local calendar days for $filter', async ({ filter, expectedIndexes }) => {
    const entries = [
      makeEntry('2026-09-11T00:00:00.000'),
      makeEntry('2026-09-10T23:59:59.999'),
      makeEntry('2026-09-10T00:00:00.000'),
      makeEntry('2026-09-09T23:59:59.999'),
    ];
    const { service } = createService(entries);

    const runs = await read(service, 20, 0, filter);

    expect(runs.map(run => run.id)).toEqual(
      expectedIndexes.map(index => `user-job-${entries[index].ts}`),
    );
  });

  test('finds old runs across pages and applies offsets after date and status filtering', async () => {
    const recentRuns = Array.from({ length: 100 }, (_, index) =>
      makeEntry('2026-09-11T12:00:00', { ts: new Date('2026-09-11T12:01:00').getTime() - index }),
    );
    const firstMatch = makeEntry('2026-09-10T13:00:00');
    const secondMatch = makeEntry('2026-09-10T12:00:00', {
      status: GatewayStatus.Error,
      error: 'delivery failed',
      deliveryError: 'delivery failed',
    });
    const thirdMatch = makeEntry('2026-09-10T11:00:00');
    const entries = [
      ...recentRuns,
      firstMatch,
      makeEntry('2026-09-10T12:30:00', { status: GatewayStatus.Skipped }),
      secondMatch,
      makeEntry('2026-09-10T11:30:00', { status: GatewayStatus.Error, error: 'agent failed' }),
      thirdMatch,
      makeEntry('2026-09-09T23:00:00'),
    ];
    const { service, runRequests } = createService(entries);

    const runs = await read(service, 2, 1, {
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      status: TaskStatus.Success,
    });

    expect(runs.map(run => run.id)).toEqual([
      `user-job-${secondMatch.ts}`,
      `user-job-${thirdMatch.ts}`,
    ]);
    expect(runRequests.map(page => page.offset)).toEqual([0, 50, 100]);
  });

  test('keeps scanning when completion order differs from start order', async () => {
    const olderStarts = Array.from({ length: 50 }, (_, index) =>
      makeEntry('2026-09-09T23:00:00', { ts: new Date('2026-09-11T00:00:00').getTime() - index }),
    );
    const target = makeEntry('2026-09-10T01:00:00');
    const { service, runRequests } = createService([...olderStarts, target]);

    const runs = await read(service, 1, 0, {
      startDate: '2026-09-10',
      endDate: '2026-09-10',
    });

    expect(runs.map(run => run.id)).toEqual([`user-job-${target.ts}`]);
    expect(runRequests.map(page => page.offset)).toEqual([0, 50]);
  });

  test('exhausts history when the requested date range has no matches', async () => {
    const entries = Array.from({ length: 100 }, (_, index) =>
      makeEntry('2026-09-11T12:00:00', { ts: index + 1 }),
    );
    const { service, runRequests } = createService(entries);

    expect(await read(service, 20, 0, { endDate: '2026-01-01' })).toEqual([]);
    expect(runRequests.map(page => page.offset)).toEqual([0, 50, 100]);
  });

  test('uses the history timestamp when an entry has no start timestamp', async () => {
    const entry = makeEntry('2026-09-10T12:00:00', { runAtMs: undefined });
    const { service } = createService([entry]);

    const runs = await read(service, 20, 0, { startDate: '2026-09-10', endDate: '2026-09-10' });

    expect(runs).toHaveLength(1);
    expect(runs[0].startedAt).toBe(new Date(entry.ts).toISOString());
  });
});
