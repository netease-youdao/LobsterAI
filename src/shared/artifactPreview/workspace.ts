import type { ReviewScopeDescriptor } from './reviewScopes';

export interface WorkspaceChangesSummary {
  review?: ReviewScopeDescriptor;
  cwd: string;
  branch: string | null;
  /** Fixed Git baseline; null denotes an unborn repository. */
  baseRevision?: string | null;
  added: number;
  removed: number;
  totalChangedFiles: number;
  statsIncomplete: boolean;
  truncated: boolean;
  files: Array<{ path: string; status: string; added: number | null; removed: number | null }>;
}

/** Lightweight persisted output identity. Bodies are resolved on demand. */
export interface ArtifactOutputReference {
  id: string;
  sessionId: string;
  messageId: string;
  type: 'html' | 'svg' | 'image' | 'video' | 'mermaid' | 'code' | 'markdown' | 'text' | 'document' | 'local-service';
  title: string;
  createdAt: number;
  filePath?: string;
  fileName?: string;
  url?: string;
  language?: string;
  contentVersion?: number;
  workspaceChanges?: WorkspaceChangesSummary;
}

export interface ResolvedArtifactOutput extends ArtifactOutputReference {
  content: string;
  source?: 'inline' | 'tool' | 'file';
  remoteUrl?: string;
}

export function artifactContentRevision(artifact: { contentVersion?: number; content?: string }): string {
  if (typeof artifact.contentVersion === 'number') return `v${artifact.contentVersion}`;
  if (!artifact.content) return 'unversioned';
  let hash = 2166136261;
  for (let index = 0; index < artifact.content.length; index += 1) hash = Math.imul(hash ^ artifact.content.charCodeAt(index), 16777619);
  return `content-${(hash >>> 0).toString(16)}`;
}
