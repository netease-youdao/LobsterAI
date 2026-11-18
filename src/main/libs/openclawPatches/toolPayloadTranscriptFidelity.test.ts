import { describe, expect, test } from 'vitest';

import {
  expectOpenClawSourceContains,
  expectPatchContains,
  isOpenClawSourceAvailable,
  readCurrentOpenClawPatch,
} from './patchTestUtils';

const patchFile = 'openclaw-tool-payload-transcript-fidelity.patch';

describe(patchFile, () => {
  test('persists transcript text and live tool payloads as the model saw them', () => {
    expectPatchContains(patchFile, [
      'Backport of upstream #169063 (f956a18741)',
      'diff --git a/src/agents/transcript-redact.ts b/src/agents/transcript-redact.ts',
      '-    return redactTranscriptText(value, cfg, modelVisibleToolResult);',
      'diff --git a/src/agents/session-tool-result-guard.ts b/src/agents/session-tool-result-guard.ts',
      '-    return redactToolPayloadTextWithConfig(value, redactionConfig);',
      'diff --git a/src/agents/embedded-agent-tool-results.ts b/src/agents/embedded-agent-tool-results.ts',
      '-  return redactStringsDeep(args);',
      '+  return args;',
    ]);
  });

  test('keeps logging redaction and carries the replay regressions', () => {
    const patch = readCurrentOpenClawPatch(patchFile);
    expect(patch).not.toMatch(/^diff --git a\/src\/logging\//m);
    expect(patch).toContain('+  it("keeps 40-character relative paths in tool results unchanged", () => {');
    expect(patch).toContain('+        // LobsterAI: the next provider context replays exactly what the model saw,');
  });

  test.skipIf(!isOpenClawSourceAvailable())('is applied to the OpenClaw source', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/transcript-redact.ts',
        snippets: ['redactTranscriptText: (value: string) => value,'],
      },
      {
        file: 'src/agents/session-tool-result-guard.ts',
        snippets: ['persisted tool details keep their text'],
      },
      {
        file: 'src/agents/embedded-agent-tool-results.ts',
        snippets: ['tool arguments and results keep their text in live events'],
      },
    ]);
  });
});
