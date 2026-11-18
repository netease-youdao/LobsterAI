import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const patchFile = 'openclaw-tolerate-replaced-thinking-catalog-owner.patch';

describe(patchFile, () => {
  test('falls back to the scoped catalog instead of failing every turn on a replaced owner', () => {
    expectPatchContains(patchFile, [
      'Backport: https://github.com/openclaw/openclaw/commit/bf599a721784849e350c18ff703c9e75de939e0d',
      'diff --git a/src/agents/prepared-model-catalog.ts b/src/agents/prepared-model-catalog.ts',
      '-        throw new PreparedModelCatalogConfigReplacedError(candidate.agentDir);',
      '+        continue;',
    ]);
  });

  test('carries the upstream regression case and leaves out the wizard half', () => {
    const patch = readCurrentOpenClawPatch(patchFile);
    expect(patch).toContain(
      '+  it("falls back to the scoped catalog while a published owner has the replaced config", async () => {',
    );
    expect(patch.match(/^diff --git /gm)).toHaveLength(2);
    expect(patch).not.toContain('src/wizard/');
  });
});
