type SessionLike = {
  id: string;
};

type CoworkDeleteStateShape = {
  sessions: SessionLike[];
  unreadSessionIds: string[];
  currentSessionId: string | null;
  currentSession: SessionLike | null;
  isStreaming: boolean;
  completedUnreadSessionIds?: string[];
  draftSelectedTextSnippets?: Record<string, unknown>;
  draftBrowserAnnotationBatches?: Record<string, unknown>;
};

export const removeSessionFromState = (
  state: CoworkDeleteStateShape,
  sessionId: string,
): void => {
  state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);
  if (state.completedUnreadSessionIds) {
    state.completedUnreadSessionIds = state.completedUnreadSessionIds.filter(
      (id) => id !== sessionId,
    );
  }
  if (state.draftSelectedTextSnippets) {
    delete state.draftSelectedTextSnippets[sessionId];
  }
  if (state.draftBrowserAnnotationBatches) {
    delete state.draftBrowserAnnotationBatches[sessionId];
  }

  if (state.currentSessionId === sessionId) {
    state.currentSessionId = null;
    state.currentSession = null;
    state.isStreaming = false;
  }
};

export const removeSessionsFromState = (
  state: CoworkDeleteStateShape,
  sessionIds: string[],
): void => {
  const sessionIdSet = new Set(sessionIds);
  state.sessions = state.sessions.filter((session) => !sessionIdSet.has(session.id));
  state.unreadSessionIds = state.unreadSessionIds.filter((id) => !sessionIdSet.has(id));
  if (state.completedUnreadSessionIds) {
    state.completedUnreadSessionIds = state.completedUnreadSessionIds.filter(
      (id) => !sessionIdSet.has(id),
    );
  }
  if (state.draftSelectedTextSnippets) {
    for (const sessionId of sessionIds) {
      delete state.draftSelectedTextSnippets[sessionId];
    }
  }
  if (state.draftBrowserAnnotationBatches) {
    for (const sessionId of sessionIds) {
      delete state.draftBrowserAnnotationBatches[sessionId];
    }
  }

  if (state.currentSessionId && sessionIdSet.has(state.currentSessionId)) {
    state.currentSessionId = null;
    state.currentSession = null;
    state.isStreaming = false;
  }
};
