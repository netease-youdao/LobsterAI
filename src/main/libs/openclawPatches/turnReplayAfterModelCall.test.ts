import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const patchFile = 'openclaw-skip-turn-replay-after-model-call.patch';

describe(patchFile, () => {
  test('stops both whole-turn replays once the turn started a model call', () => {
    expectPatchContains(patchFile, [
      'diff --git a/src/auto-reply/reply/agent-runner-error-handler.ts',
      '+  modelCallStarted: boolean;',
      '+    if (info.phase === "model_call_started") {',
      '+      overloadRetryState.modelCallStarted = true;',
      '+    modelCallStarted: false,',
    ]);
    const patch = readCurrentOpenClawPatch(patchFile);
    // The overload replay and the transient HTTP replay both check the flag.
    expect(patch.match(/^\+\s+!params\.overloadRetryState\.modelCallStarted &&$/gm)).toHaveLength(2);
  });

  test('keeps pre-call replays and covers the regression upstream', () => {
    const patch = readCurrentOpenClawPatch(patchFile);
    expect(patch).not.toMatch(/^-.*Retrying once in/m);
    expect(patch).not.toMatch(/^-.*Overloaded provider before reply/m);
    expect(patch).toContain('does not replay a stream interrupted after the model call started');
    expect(patch).toContain('surfaces a provider HTTP 503 without replaying once the model call started');
    expect(patch).toContain('["tool_execution_started", "assistant_output_started", "model_call_started"]');
  });
});
