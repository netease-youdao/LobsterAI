import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

describe('openclaw-im-bound-agent-run-cwd.patch', () => {
  test('keeps agent cwd schema and runtime resolution in the current OpenClaw patch set', () => {
    expectPatchContains('openclaw-im-bound-agent-run-cwd.patch', [
      'resolveAgentRunCwd',
      'cfg.agents?.defaults?.cwd',
      'cwd: z.string().optional()',
      'cwd: runCwd',
      'cwd?: string;',
      'cwd: normalizeOptionalString(sessionEntry?.spawnedCwd) ?? cwd',
    ]);
  });

  test('keeps bootstrap workspace separate from the task cwd', () => {
    const patchContent = readCurrentOpenClawPatch('openclaw-im-bound-agent-run-cwd.patch');

    expect(patchContent).not.toContain('workspaceDir: runCwd');
    expect(patchContent).toContain('workspaceDir,');
    expect(patchContent).toContain('cwd: cwd ?? workspaceDir');
  });
});
