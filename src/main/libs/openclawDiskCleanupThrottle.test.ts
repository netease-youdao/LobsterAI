import { expect, test } from 'vitest';

import {
  createDiskCleanupThrottle, DISK_CLEANUP_PASS_BUDGET_MS, DISK_CLEANUP_REST_MS, DISK_CLEANUP_WORK_SLICE_MS,
  DiskCleanupStopReason, isDiskCleanupStopped,
} from './openclawDiskCleanupThrottle';

function fakeClock() {
  const clock = { now: 0, rests: [] as number[] };
  return {
    clock,
    options: {
      clock: () => clock.now,
      sleep: async (ms: number) => {
        clock.rests.push(ms);
        clock.now += ms;
      },
    },
  };
}

test('defaults keep disk work to about a fifth of wall time within a five-minute pass', () => {
  expect(DISK_CLEANUP_WORK_SLICE_MS).toBe(20);
  expect(DISK_CLEANUP_REST_MS).toBe(80);
  expect(DISK_CLEANUP_PASS_BUDGET_MS).toBe(5 * 60 * 1000);
});

test('rests only once a work slice is used up, then starts a new slice', async () => {
  const { clock, options } = fakeClock();
  const throttle = createDiskCleanupThrottle({ ...options, workSliceMs: 20, restMs: 80 });

  clock.now = 19;
  await throttle.step();
  expect(clock.rests).toEqual([]);
  clock.now = 20;
  await throttle.step();
  expect(clock.rests).toEqual([80]);
  // The new slice starts after the rest (t=100).
  clock.now = 119;
  await throttle.step();
  expect(clock.rests).toEqual([80]);
  clock.now = 120;
  await throttle.step();
  expect(clock.rests).toEqual([80, 80]);
});

test('stops once the pass budget is spent', async () => {
  const { clock, options } = fakeClock();
  const throttle = createDiskCleanupThrottle({ ...options, budgetMs: 1000 });
  clock.now = 999;
  await throttle.step();
  clock.now = 1000;
  const error = await throttle.step().catch((caught: unknown) => caught);
  expect(isDiskCleanupStopped(error) && error.reason).toBe(DiskCleanupStopReason.Budget);
});

test('stops at the next rest after switching to battery power', async () => {
  const { clock, options } = fakeClock();
  let onBattery = false;
  const throttle = createDiskCleanupThrottle({ ...options, shouldStopForBattery: () => onBattery });
  clock.now = 25;
  await throttle.step();
  onBattery = true;
  // Mid-slice steps do not consult the power source.
  clock.now = 110;
  await throttle.step();
  clock.now = 130;
  const error = await throttle.step().catch((caught: unknown) => caught);
  expect(isDiskCleanupStopped(error) && error.reason).toBe(DiskCleanupStopReason.Battery);
});
