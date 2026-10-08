import { describe, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectOpenClawSourceContains,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenClaw user-turn prompt cache stability patch decisions', () => {
  test('drops the v2026.6.1 backport because v2026.8.1 owns byte-stable replay upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-user-turn-cache-stability.patch');
  });

  test.skipIf(!isOpenClawSourceAvailable())('keeps the upstream cache-stability implementation and tests', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/embedded-agent-runner/run/attempt-llm-boundary.ts',
        snippets: [
          'canonicalizeTextOnlyUserContent',
          'stampUserTextWithMessageTimestamp',
          'currentUserTimestampOverride',
          'byte-stable across current↔historical',
        ],
      },
      {
        file: 'src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts',
        snippets: ['prompt-cache byte-identity', 'repeated calls are byte-stable'],
      },
    ]);
  });
});
