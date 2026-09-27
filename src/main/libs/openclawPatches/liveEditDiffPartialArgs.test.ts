import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

const patchFile = 'openclaw-live-edit-diff-partial-args.patch';

describe(patchFile, () => {
  test('streams live file-edit progress for OpenAI-compatible completions providers', () => {
    expectPatchContains(patchFile, [
      'diff --git a/src/agents/embedded-agent-live-edit-diff.ts',
      '+    typeof block?.partialJson === "string"',
      '+      : typeof block?.partialArgs === "string"',
      '+        ? block.partialArgs',
      'counts OpenAI-compatible completions arguments buffered in partialArgs',
    ]);
  });
});
