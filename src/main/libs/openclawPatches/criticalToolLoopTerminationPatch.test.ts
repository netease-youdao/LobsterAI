import { describe, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectOpenClawSourceContains,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenClaw critical tool-loop termination patch decisions', () => {
  test('drops the v2026.6.1 termination and soft-veto backports', () => {
    expectCurrentOpenClawPatchMissing('openclaw-terminate-run-on-critical-tool-loop.patch');
    expectCurrentOpenClawPatchMissing('zz-openclaw-tool-loop-soft-vetoes.patch');
  });

  test.skipIf(!isOpenClawSourceAvailable())('uses the richer v2026.8.1 native recovery contract', () => {
    expectOpenClawSourceContains([
      {
        file: 'packages/agent-core/src/agent-loop.ts',
        snippets: [
          'Critical tool-loop recovery failed because another critical loop was detected',
          'terminateRun: params.terminal',
        ],
      },
      {
        file: 'src/agents/embedded-agent-runner/run/tool-loop-recovery.ts',
        snippets: ['kind: "critical-tool-loop"', 'tool-loop batch admission failed'],
      },
    ]);
  });
});
