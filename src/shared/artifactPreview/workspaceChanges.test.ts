import { expect, test } from 'vitest';

import { artifactContentRevision } from './workspace';
import { buildWorkspaceChangesArtifact, isWorkspaceDiffArtifact } from './workspaceChanges';

const snapshot = { cwd: '/tmp/repo', branch: 'main', added: 1, removed: 0,
  changedFiles: [{ path: 'new.md', status: '??', added: 1, removed: 0 }],
  diff: 'diff --git a/new.md b/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/new.md\n@@ -0,0 +1 @@\n+# Hello\n' };

test('review bodies contain only the patch, while unavailable files and limits remain structured', () => {
  const artifact = buildWorkspaceChangesArtifact('s', 'Changes', { ...snapshot, truncated: true, statsIncomplete: true, totalChangedFiles: 501 });
  expect(artifact.content).toBe(snapshot.diff);
  expect(artifact.workspaceChanges).toMatchObject({ totalChangedFiles: 501, truncated: true, statsIncomplete: true, files: snapshot.changedFiles });
  expect(isWorkspaceDiffArtifact(artifact)).toBe(true);
  expect(isWorkspaceDiffArtifact({ id: 'old-diff', type: 'code', language: 'diff' })).toBe(true);
  expect(isWorkspaceDiffArtifact({ id: 'unrelated', type: 'code', language: 'typescript' })).toBe(false);
});

test('same content keeps feedback identity when reopened, and changed patch or scope invalidates it', () => {
  const first = buildWorkspaceChangesArtifact('s', 'Changes', snapshot);
  const again = buildWorkspaceChangesArtifact('s', 'Localized title', structuredClone(snapshot));
  expect(artifactContentRevision(first)).toBe(artifactContentRevision(again));
  const edited = buildWorkspaceChangesArtifact('s', 'Changes', { ...snapshot, diff: snapshot.diff.replace('Hello', 'Goodbye') });
  expect(artifactContentRevision(edited)).not.toBe(artifactContentRevision(first));
  const otherScope = buildWorkspaceChangesArtifact('s', 'Changes', { ...snapshot, cwd: '/tmp/other' });
  expect(artifactContentRevision(otherScope)).not.toBe(artifactContentRevision(first));
  expect(buildWorkspaceChangesArtifact('other', 'Changes', snapshot).id).not.toBe(first.id);
});
