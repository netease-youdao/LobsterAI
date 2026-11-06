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
      'normalizeOptionalString(preparedSessionState.sessionEntry?.spawnedCwd) ??',
    ]);
  });

  test('resolves IM run cwd from the hot-reloaded runtime snapshot', () => {
    // Low-level channel dispatches pass the config captured at channel start.
    expectPatchContains('openclaw-im-bound-agent-run-cwd.patch', [
      'import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";',
      'getRuntimeConfigSnapshot() ?? cfg,',
      'resolves run cwd from the hot-reloaded runtime snapshot over a stale channel config',
    ]);
  });

  test('keeps bootstrap workspace separate from the task cwd', () => {
    const patchContent = readCurrentOpenClawPatch('openclaw-im-bound-agent-run-cwd.patch');

    expect(patchContent).not.toContain('workspaceDir: runCwd');
    expect(patchContent).toContain('workspaceDir: configuredWorkspaceDir');
    expect(patchContent).toContain('cwd: configuredCwd');
    expect(patchContent).toContain('cwd: runCwd');
    expect(patchContent).not.toContain('state.cwd');
    expect(patchContent).not.toContain('+      cwd: normalizeOptionalString(state.sessionEntry');
  });
});
