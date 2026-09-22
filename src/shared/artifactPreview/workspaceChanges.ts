import { artifactContentRevision, type ResolvedArtifactOutput, type WorkspaceChangesSummary } from './workspace';

export function isWorkspaceDiffArtifact(artifact: { id: string; type: string; language?: string }): boolean {
  return artifact.type === 'code' && (artifact.language?.toLowerCase() === 'diff' || artifact.id.startsWith('environment-changes:'));
}

export function buildWorkspaceChangesArtifact(sessionId: string, title: string, snapshot: {
  cwd: string; branch: string | null; added: number; removed: number; diff: string;
  baseRevision?: string | null;
  changedFiles: WorkspaceChangesSummary['files']; totalChangedFiles?: number; statsIncomplete?: boolean; truncated?: boolean;
}): ResolvedArtifactOutput {
  const id = `environment-changes:${sessionId}`;
  const workspaceChanges: WorkspaceChangesSummary = {
    cwd: snapshot.cwd, branch: snapshot.branch, added: snapshot.added, removed: snapshot.removed,
    ...(snapshot.baseRevision !== undefined ? { baseRevision: snapshot.baseRevision } : {}),
    totalChangedFiles: snapshot.totalChangedFiles ?? snapshot.changedFiles.length,
    statsIncomplete: snapshot.statsIncomplete === true, truncated: snapshot.truncated === true,
    files: snapshot.changedFiles,
  };
  // Reopening the same review must keep a stable identity. Bind the revision to the
  // reviewed content and file metadata instead of an unrelated wall-clock time.
  const revision = artifactContentRevision({ content: JSON.stringify(workspaceChanges) + '\n' + snapshot.diff });
  return { id, sessionId, messageId: id, type: 'code', language: 'diff', title,
    content: snapshot.diff, workspaceChanges, createdAt: Date.now(),
    contentVersion: Number.parseInt(revision.slice('content-'.length), 16) };
}
