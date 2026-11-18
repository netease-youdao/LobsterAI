import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import {
  selectCompletedUnreadSessionIds,
  selectCoworkSessions,
  selectPendingPermissionSessionIds,
} from '../../store/selectors/coworkSelectors';
import type { CoworkSessionSummary } from '../../types/cowork';
import {
  buildSidebarTaskFilterQuery,
  isSidebarTaskFilterActive,
  reconcileSidebarTaskFilterResults,
  type SidebarTaskFilter,
  type SidebarTaskRuntimeState,
} from './taskFilter';

/** Coalesces bursts of session updates (a streaming turn) into one query. */
const REFRESH_DEBOUNCE_MS = 250;

export interface SidebarTaskFilterResults {
  sessions: CoworkSessionSummary[];
  isLoading: boolean;
  hasError: boolean;
}

const EMPTY_RESULTS: SidebarTaskFilterResults = { sessions: [], isLoading: false, hasError: false };

/**
 * Sessions matching the sidebar filter across all agents. Queries the main
 * process, then keeps the list in step with live session state.
 */
export const useSidebarTaskFilterResults = (filter: SidebarTaskFilter): SidebarTaskFilterResults => {
  const isActive = isSidebarTaskFilterActive(filter);
  const liveSessions = useSelector(selectCoworkSessions);
  const completedUnreadSessionIds = useSelector(selectCompletedUnreadSessionIds);
  const pendingPermissionSessionIds = useSelector(selectPendingPermissionSessionIds);
  const runtime = useMemo<SidebarTaskRuntimeState>(() => ({
    completedUnreadSessionIds: new Set(completedUnreadSessionIds),
    pendingPermissionSessionIds: new Set(pendingPermissionSessionIds),
  }), [completedUnreadSessionIds, pendingPermissionSessionIds]);
  // Refetch when any loaded session changes status or recency, not on every
  // unrelated Redux update.
  const liveSignature = useMemo(
    () => liveSessions.map(session => `${session.id}:${session.status}:${session.updatedAt}`).join('|'),
    [liveSessions],
  );
  const [queried, setQueried] = useState<CoworkSessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!isActive) return undefined;
    return window.electron?.cowork?.onSessionsChanged?.(() => setRefreshKey(key => key + 1));
  }, [isActive]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!isActive) {
      setQueried([]);
      setIsLoading(false);
      setHasError(false);
      return undefined;
    }
    const query = buildSidebarTaskFilterQuery(filter, runtime);
    if (!query) {
      setQueried([]);
      setIsLoading(false);
      setHasError(false);
      return undefined;
    }
    setIsLoading(true);
    const timer = window.setTimeout(() => {
      void coworkService.listFilteredSessions(query).then((result) => {
        if (requestId !== requestIdRef.current) return;
        if (!result.success) {
          console.warn('[CoworkSidebarFilter] failed to load filtered tasks:', result.error);
        }
        setQueried(result.success ? result.sessions ?? [] : []);
        setHasError(!result.success);
        setIsLoading(false);
      });
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filter, isActive, liveSignature, refreshKey, runtime]);

  return useMemo(() => {
    if (!isActive) return EMPTY_RESULTS;
    return {
      sessions: reconcileSidebarTaskFilterResults(queried, liveSessions, filter, runtime),
      isLoading,
      hasError,
    };
  }, [filter, hasError, isActive, isLoading, liveSessions, queried, runtime]);
};
