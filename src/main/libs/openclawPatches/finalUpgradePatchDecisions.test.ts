import { describe, test } from 'vitest';

import { expectCurrentOpenClawPatchMissing, expectPatchContains } from './patchTestUtils';

describe('final OpenClaw 6.1 patch decisions', () => {
  test('carries aborted tool loop breaker because upstream generic loop detection is not enough', () => {
    expectPatchContains('openclaw-aborted-tool-loop-breaker.patch', [
      'ABORTED_TOOL_LOOP_CRITICAL_THRESHOLD',
      'detector: "aborted_tool_loop"',
      'sanitizeAbortedToolLoopHistory',
      'MAX_PRESERVED_ABORTED_TOOL_HISTORY_PAIRS',
    ]);
  });

  test('carries prompt segment fallback skip because derivePromptSegments is diagnostic-only', () => {
    expectPatchContains('openclaw-skip-derive-prompt-segments-deadloop.patch', [
      'skip derivePromptSegments fallback',
      'const promptSegments = runResult.meta?.promptSegments',
    ]);
  });

  test('carries subagent cleanup finalize best-effort handling for bundle runtime', () => {
    expectPatchContains('openclaw-subagent-cleanup-finalize-best-effort.patch', [
      'emitCompletionEndedHookBestEffort',
      'failed to emit subagent ended hook during cleanup',
      'GATEWAY_BUNDLE_BASENAME',
      './dist/${joined.slice(2)}',
    ]);
  });

  test('does not carry widened incomplete-turn retry guard because OpenClaw 6.1 has guarded upstream coverage', () => {
    expectCurrentOpenClawPatchMissing('openclaw-widen-incomplete-turn-retry-guard.patch');
  });
});
