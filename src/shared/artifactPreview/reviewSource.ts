export const ReviewSourceStatus = { Ready: 'ready', Unavailable: 'unavailable' } as const;
export const ReviewSourceReason = {
  Binary: 'binary', TooLarge: 'too-large', NotFound: 'not-found',
  RevisionMismatch: 'revision-mismatch', Unsupported: 'unsupported',
} as const;
export interface ReviewSourceRequest {
  sessionId: string;
  artifactId: string;
  revision: string;
  /** Stable file ID from the parsed, host-verified patch. Never an arbitrary path. */
  fileId: string;
}
export type ReviewSourceResponse = ReviewSourceRequest & (
  | { status: typeof ReviewSourceStatus.Ready; path: string; oldPath: string; newPath: string; oldSource: string; newSource: string }
  | { status: typeof ReviewSourceStatus.Unavailable; reason: typeof ReviewSourceReason[keyof typeof ReviewSourceReason] }
);

export const MAX_REVIEW_SOURCE_BYTES = 2_000_000;
