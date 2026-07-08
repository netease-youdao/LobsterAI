import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('openclaw-cron-skip-missed-jobs.patch', () => {
  test('keeps skipMissedJobs schema and runtime support in the current OpenClaw patch set', () => {
    expectPatchContains('openclaw-cron-skip-missed-jobs.patch', [
      'skipMissedJobs',
      'z.boolean().optional()',
      'missed job',
    ]);
  });
});
