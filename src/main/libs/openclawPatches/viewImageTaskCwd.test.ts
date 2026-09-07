import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const patchFile = 'openclaw-view-image-task-cwd.patch';

describe(patchFile, () => {
  test('resolves and authorizes view_image paths from the task working directory', () => {
    expectPatchContains(patchFile, [
      'diff --git a/src/agents/openclaw-tools.ts',
      'cwd: options?.cwd',
      'const runtimeCwd = options?.cwd?.trim() || options?.workspaceDir',
      'return resolve(runtimeCwd, normalizedRef)',
      'containmentRoot: sandboxConfig ? undefined : (options?.fsPolicy?.root ?? runtimeCwd)',
      'return containmentRoot ? [containmentRoot] : workspaceDir ? [workspaceDir] : []',
      'resolves and authorizes local image paths against the runtime cwd',
      'fsPolicy: { workspaceOnly: true }',
    ]);
  });

  test('does not replace local path validation with unrestricted access', () => {
    expect(readCurrentOpenClawPatch(patchFile)).not.toContain('localRoots: "any"');
  });
});
