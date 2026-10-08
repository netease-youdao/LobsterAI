import { describe, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectOpenClawSourceContains,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenClaw aborted tool run exit patch', () => {
  test('drops the old backport because v2026.8.1 includes stopIfAborted upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-stop-loop-after-aborted-tool-run.patch');
  });

  test.skipIf(!isOpenClawSourceAvailable())('keeps the upstream abort guards in the pinned source', () => {
    expectOpenClawSourceContains([
      {
        file: 'packages/agent-core/src/agent-loop.ts',
        snippets: ['const stopIfAborted = async (): Promise<boolean> => {', 'if (await stopIfAborted())'],
      },
      {
        file: 'packages/agent-core/src/agent-loop.test.ts',
        snippets: ['does not request another model turn after a tool aborts the run'],
      },
    ]);
  });
});
