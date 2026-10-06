import { describe, test } from 'vitest';

import {
  expectOpenClawSourceContains,
  expectPatchContains,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('openclaw-cron-skip-missed-jobs.patch', () => {
  test('keeps skipMissedJobs schema and runtime support in the current OpenClaw patch set', () => {
    expectPatchContains('openclaw-cron-skip-missed-jobs.patch', [
      'skipMissedJobs',
      'z.boolean().optional()',
      'cron: skipping missed jobs after restart',
    ]);
  });

  test('fast-forwards missed recurring jobs instead of only skipping the catch-up plan', () => {
    // Returning an empty catch-up plan is not enough: the first regular timer
    // tick still executes jobs whose nextRunAtMs is in the past. The patch
    // must advance those timestamps and exclude the jobs from the plan.
    expectPatchContains('openclaw-cron-skip-missed-jobs.patch', [
      'fastForwardMissedRecurringJobs',
      'recomputeJobNextRunAtMs',
      '.filter((job) => job.schedule.kind !== "at")',
      'skipJobIds = new Set([...(skipJobIds ?? []), ...fastForwardedJobIds])',
    ]);
  });

  test('ships behavior coverage for the skip semantics', () => {
    expectPatchContains('openclaw-cron-skip-missed-jobs.patch', [
      'timer.skip-missed-jobs.test.ts',
      'fast-forwards missed recurring jobs instead of replaying them',
      'keeps missed one-shot jobs on the default catch-up path',
      'catches up missed recurring jobs when skipMissedJobs is not enabled',
    ]);
  });

  test.skipIf(!isOpenClawSourceAvailable())('is applied to the local OpenClaw source tree', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/cron/service/timer-catchup.ts',
        snippets: [
          'fastForwardMissedRecurringJobs',
          'recomputeJobNextRunAtMs',
          'cron: skipping missed jobs after restart',
        ],
      },
      {
        file: 'src/cron/service/timer.skip-missed-jobs.test.ts',
        snippets: ['fast-forwards missed recurring jobs instead of replaying them'],
      },
    ]);
  });
});
