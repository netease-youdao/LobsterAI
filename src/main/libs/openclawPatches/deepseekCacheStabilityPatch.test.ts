import { describe, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectOpenClawSourceContains,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenClaw live tool-result cache stability patch decisions', () => {
  test('drops the v2026.6.1 backport in favor of native frozen-history projection', () => {
    expectCurrentOpenClawPatchMissing('openclaw-live-tool-result-cache-stability.patch');
  });

  test.skipIf(!isOpenClawSourceAvailable())('keeps native cache-stability regression coverage', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/embedded-agent-runner/tool-result-truncation.test.ts',
        snippets: [
          'keeps prompt projections stable while enforcing aggregate recovery as history grows',
          'allows aggregate overflow rather than rewriting frozen history',
        ],
      },
    ]);
  });
});
