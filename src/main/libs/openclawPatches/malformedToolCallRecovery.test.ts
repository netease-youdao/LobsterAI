import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const repairPatch = 'openclaw-openai-completions-tool-call-repair.patch';
const continuationPatch = 'openclaw-malformed-tool-call-continuation.patch';
const MALFORMED_TOOL_CALL_DIAGNOSTIC_TYPE = '"malformed_tool_call_arguments"';

describe(repairPatch, () => {
  test('repairs complete OpenAI-compatible tool-call arguments before rejecting them', () => {
    expectPatchContains(repairPatch, [
      '+    finalizeTerminalToolCallArguments(toolCalls, (call) => call.partialArgs, undefined, {',
      '+      repairStringLiterals: true,',
      '+  const repaired = repairJson(value, { preserveValidControlEscapes: true });',
      'repairs a complete modern tool terminal with $reason',
    ]);
  });

  test('keeps truncated arguments rejected and records a content-free diagnostic', () => {
    expectPatchContains(repairPatch, [
      'Truncated free-text arguments must never be "repaired"',
      '+        type: MALFORMED_TOOL_CALL_DIAGNOSTIC_TYPE,',
      '+class MalformedToolCallArgumentsError extends Error {',
      "Diagnostics describe the buffer's shape only and never retain argument text.",
    ]);
  });
});

describe(continuationPatch, () => {
  test('continues a side-effecting turn after a rejected tool call', () => {
    expectPatchContains(continuationPatch, [
      '+  if (!settledTurnFinalizationAttempted && continueAfterMalformedToolCall(input)) {',
      '+export const MALFORMED_TOOL_CALL_RETRY_LIMIT = 2;',
      '"Provider returned an incomplete or malformed tool call"',
      "continues a side-effecting turn after the provider's tool call is rejected",
      'does not request isolated finalization for a rejected tool call',
    ]);
  });

  test('consumes the diagnostic type the repair patch records', () => {
    expect(readCurrentOpenClawPatch(repairPatch)).toContain(MALFORMED_TOOL_CALL_DIAGNOSTIC_TYPE);
    expect(readCurrentOpenClawPatch(continuationPatch)).toContain(
      MALFORMED_TOOL_CALL_DIAGNOSTIC_TYPE,
    );
  });
});
