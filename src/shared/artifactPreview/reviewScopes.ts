export const ReviewScope = { Repository: 'repository', Unstaged: 'unstaged', Staged: 'staged', Branch: 'branch', Commit: 'commit' } as const;
export type ReviewScope = typeof ReviewScope[keyof typeof ReviewScope];
export const ReviewIpc = {
  /** Build a review artifact for a scope (working tree, staged, branch or commit). */
  Read: 'cowork:review:read',
  /** Read the complete old/new source of one reviewed file for syntax highlighting and context expansion. */
  Source: 'cowork:review:source',
} as const;
export const SCOPED_REVIEW_PREFIX = 'scoped-review:';
export interface ReviewScopeRequest { sessionId: string; scope: ReviewScope; reference?: string }
export interface ReviewScopeDescriptor { refreshedOnRestore?: boolean; scope: ReviewScope; reference?: string; baseRevision?: string | null; targetRevision?: string | null }
