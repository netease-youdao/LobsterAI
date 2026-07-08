import { describe, test } from 'vitest';

import {
  expectBundledOpenClawRuntimeContains,
  expectOpenClawSourceContains,
  expectPatchContains,
  isBundledOpenClawRuntimeAvailable,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenClaw user-turn prompt cache stability patch', () => {
  test('carries the v6.1 backport for byte-stable current and historical user turns', () => {
    expectPatchContains('openclaw-user-turn-cache-stability.patch', [
      'canonicalizeTextOnlyUserContent',
      'stampUserTextWithMessageTimestamp',
      'currentUserTimestampOverride',
      'BodyForAgent: messageForAgent',
      'prompt-cache byte-identity',
      'turn1AsCurrent',
      'turn1AsHistorical',
    ]);
  });

  test.skipIf(!isOpenClawSourceAvailable())('is applied to the local OpenClaw source tree', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/embedded-agent-runner/run/attempt.llm-boundary.ts',
        snippets: [
          'canonicalizeTextOnlyUserContent',
          'stampUserTextWithMessageTimestamp',
          'currentUserTimestampOverride',
        ],
      },
      {
        file: 'src/gateway/server-methods/agent-timestamp.ts',
        snippets: ['export function buildTimestampPrefix'],
      },
      {
        file: 'src/gateway/server-methods/chat.ts',
        snippets: ['BodyForAgent: messageForAgent'],
      },
      {
        file: 'src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts',
        snippets: ['prompt-cache byte-identity', 'turn1AsCurrent', 'turn1AsHistorical'],
      },
    ]);
  });

  test.skipIf(!isBundledOpenClawRuntimeAvailable())('is included in the bundled OpenClaw runtime', () => {
    expectBundledOpenClawRuntimeContains([
      'currentUserTimestampOverride',
      'runtimeTimestamp',
      'alternateText',
    ]);
  });
});
