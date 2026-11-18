/** Query for the sidebar task filter; every given condition must hold. */
export interface CoworkSessionFilterQuery {
  /** Keep sessions whose stored status is one of these. */
  statuses?: string[];
  /** Keep only these sessions (renderer-only states such as unread or awaiting permission). */
  sessionIds?: string[];
  /** Keep sessions updated at or after this epoch-millisecond timestamp. */
  updatedSince?: number;
  limit?: number;
}

export const COWORK_SESSION_FILTER_DEFAULT_LIMIT = 200;
export const COWORK_SESSION_FILTER_MAX_LIMIT = 500;
/** Upper bound on `sessionIds`, far below SQLite's bound-parameter limit. */
export const COWORK_SESSION_FILTER_MAX_IDS = 1000;
