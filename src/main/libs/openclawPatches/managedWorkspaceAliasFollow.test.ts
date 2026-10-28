import { describe, test } from 'vitest';

import { OPENCLAW_MANAGED_WORKSPACE_ROOT_ENV } from '../../../shared/openclawEngine/constants';
import { expectPatchContains } from './patchTestUtils';

const PATCH_FILE = 'openclaw-managed-workspace-alias-follow.patch';

describe(PATCH_FILE, () => {
  test('reads the managed root from the variable LobsterAI sets', () => {
    expectPatchContains(PATCH_FILE, [
      'diff --git a/src/agents/workspace-state-store.ts',
      `+const MANAGED_WORKSPACE_ROOT_ENV = "${OPENCLAW_MANAGED_WORKSPACE_ROOT_ENV}";`,
    ]);
  });

  test('follows only existing paths and repoints stale aliases', () => {
    expectPatchContains(PATCH_FILE, [
      '+  const followExistingTarget = followCurrentTarget && workspacePathEntryExists(params.workspaceDir);',
      '+      if (!params.followCurrentTarget || existing.alias_path !== alias.workspacePath) {',
      '+          .updateTable("workspace_path_aliases")',
    ]);
  });

  test('covers the synced-folder relink end to end', () => {
    expectPatchContains(PATCH_FILE, [
      'diff --git a/src/agents/workspace.managed-relink.test.ts',
      'serves the synced workspace without reseeding bootstrap',
      'keeps failing closed when LobsterAI has not claimed the workspace root',
    ]);
  });
});
