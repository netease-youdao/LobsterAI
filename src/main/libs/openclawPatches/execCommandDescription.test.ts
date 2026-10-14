import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const patchFile = 'openclaw-exec-command-description.patch';

describe(patchFile, () => {
  test('lets the model attach a plain-language summary to every exec surface', () => {
    expectPatchContains(patchFile, [
      'diff --git a/src/agents/bash-tools.schemas.ts',
      '+  description: Type.Optional(',
      "in the user's language; shown to the user instead of the command.",
      '+  description: execSchema.properties.description,',
      'asks for an optional user-facing summary on the %s surface',
      '["command", "description", "workdir", "env", "timeoutSeconds", "host", "node"]',
    ]);
  });

  test('keeps the summary optional so existing exec callers stay valid', () => {
    const patch = readCurrentOpenClawPatch(patchFile);
    expect(patch).toContain('expect(schema.required ?? []).not.toContain("description")');
    expect(patch).not.toMatch(/^\+\s*description: Type\.String\(/m);
  });
});
