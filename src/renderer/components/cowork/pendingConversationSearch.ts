import { CoworkUiEvent } from './constants';

/** A request from the task search to open a session with its conversation search pre-filled. */
interface PendingConversationSearch {
  sessionId: string;
  query: string;
  requestedAt: number;
}

/** Long enough for a cold session load, short enough that a stale request never surprises the user. */
export const PENDING_CONVERSATION_SEARCH_TTL_MS = 15_000;

let pending: PendingConversationSearch | null = null;

export const setPendingConversationSearch = (
  sessionId: string,
  query: string,
  now: number = Date.now(),
): void => {
  const trimmedQuery = query.trim();
  pending = sessionId && trimmedQuery ? { sessionId, query: trimmedQuery, requestedAt: now } : null;
};

/**
 * Return and clear the pending query when it targets `sessionId` and has not
 * expired. A request for another session is kept for that session to claim.
 */
export const takePendingConversationSearch = (
  sessionId: string,
  now: number = Date.now(),
): string | null => {
  if (!pending) return null;
  if (now - pending.requestedAt > PENDING_CONVERSATION_SEARCH_TTL_MS) {
    pending = null;
    return null;
  }
  if (pending.sessionId !== sessionId) return null;
  const { query } = pending;
  pending = null;
  return query;
};

/** Ask the session view to open its conversation search for `query` once `sessionId` is shown. */
export const requestConversationSearch = (sessionId: string, query: string): void => {
  setPendingConversationSearch(sessionId, query);
  window.dispatchEvent(new CustomEvent(CoworkUiEvent.PendingConversationSearch));
};
