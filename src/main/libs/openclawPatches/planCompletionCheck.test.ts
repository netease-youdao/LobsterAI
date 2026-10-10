import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const patchFile = 'zz-openclaw-plan-completion-check.patch';

describe(patchFile, () => {
  test('backports the upstream unfinished-plan completion check', () => {
    expectPatchContains(patchFile, [
      'Backport: https://github.com/openclaw/openclaw/commit/3ba0a0b23761ef8209827f7f3dd0f82713c33bbe',
      'diff --git a/src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts',
      '+const PLAN_COMPLETION_CHECK_CUSTOM_TYPE = "openclaw.plan-completion-check";',
      '+            completionCheck.checked = true;',
      '+              { deliverAs: "followUp" },',
      '+            return { continueCurrentTurn: true };',
      '+      options.onPlanSaved?.(',
      '+    completionCheck: { unfinishedPlan: false, checked: false },',
    ]);
  });

  test('keeps the checkpoint run alive and live streaming intact', () => {
    expectPatchContains(patchFile, [
      'diff --git a/src/agents/embedded-agent-subscribe.handlers.lifecycle.ts',
      '+  const continueCurrentTurn = () => {',
      '+        if (decision?.continueCurrentTurn === true) {',
      '+    deferTerminalDelivery: shouldRunBeforeAgentFinalize === true,',
      '+      params.deferTerminalDelivery !== false,',
      '+        hasAcceptedSessionSpawn(ctx.state.acceptedSessionSpawns) ||',
    ]);
  });

  test('marks the continued answer with a checkpoint event for the desktop client', () => {
    expectPatchContains(patchFile, [
      '+function emitAssistantCheckpoint(ctx: EmbeddedAgentSubscribeContext) {',
      '+    stream: "checkpoint",',
      '+    emitAssistantCheckpoint(ctx);',
    ]);
    const patch = readCurrentOpenClawPatch(patchFile);
    // Emitted only after the finished answer's deferred events are flushed.
    expect(patch).toMatch(
      /\+ {4}ctx\.flushDeferredAssistantEvents\(\);\n\+ {4}ctx\.flushDeferredBlockReplies\(\);\n\+ {4}finalizeAgentEnd\(\);\n\+ {4}emitAssistantCheckpoint\(ctx\);/,
    );
  });

  test('leaves out the NO_REPLY clause that needs upstream kept-answer delivery', () => {
    const patch = readCurrentOpenClawPatch(patchFile);
    const instruction = patch.match(/^\+ {2}"This run’s latest successfully saved plan[^\n]*$/m)?.[0];
    expect(instruction).toBeDefined();
    expect(instruction).toContain('report that concrete limitation. Do not invent completion or new authority.');
    expect(instruction).not.toContain('SILENT_REPLY_TOKEN');
    expect(instruction).not.toContain('NO_REPLY');
  });

  test('carries the regression coverage for the check and its live streaming', () => {
    const patch = readCurrentOpenClawPatch(patchFile);
    expect(patch).toContain(
      'diff --git a/src/agents/embedded-agent-runner/run/attempt-plan-completion.test.ts',
    );
    expect(patch).toContain('continues a committed unfinished plan without repeating completed effects');
    expect(patch).toContain('streams assistant text live when only the completion check is armed');
    expect(patch).toContain('keeps checkpoint delivery nonterminal (buffered=%s)');
  });
});
