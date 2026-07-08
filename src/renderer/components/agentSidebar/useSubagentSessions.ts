import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type CoworkSessionStatus,
  CoworkSessionStatusValue,
  type SubagentSessionSummary,
} from '../../types/cowork';

const POLL_INTERVAL_MS = 5_000;
export const POST_PARENT_COMPLETION_POLL_MS = 5 * 60_000;
const POST_PARENT_REFRESH_DELAYS_MS = [1_000, 5_000, 15_000] as const;

export function shouldPollSubagentSessions(options: {
  parentSessionStatus?: CoworkSessionStatus;
  hasRunningSubagents: boolean;
  postParentPollingDeadlineMs: number | null;
  nowMs: number;
}): boolean {
  if (options.parentSessionStatus === CoworkSessionStatusValue.Running) {
    return true;
  }
  return options.hasRunningSubagents
    && options.postParentPollingDeadlineMs !== null
    && options.nowMs <= options.postParentPollingDeadlineMs;
}

/**
 * Fetches and polls subagent sessions for the currently selected session.
 * Returns a map of parentSessionId → subagent summaries.
 */
export const useSubagentSessions = (
  currentSessionId: string | null,
  currentSessionStatus?: CoworkSessionStatus,
) => {
  const [subagentsBySessionId, setSubagentsBySessionId] = useState<
    Record<string, SubagentSessionSummary[]>
  >({});
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const postParentPollingDeadlineRef = useRef<number | null>(null);
  const terminalRefreshTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const runningParentSessionIdRef = useRef<string | null>(null);

  const fetchSubagents = useCallback(async (sessionId: string) => {
    try {
      const result = await window.electron?.cowork?.listSubagentSessions(sessionId);
      if (!result?.success || !result.runs) return;

      const summaries: SubagentSessionSummary[] = result.runs.map((run) => ({
        id: run.id,
        agentId: run.agentId,
        task: run.task,
        label: run.label,
        sessionKey: run.sessionKey,
        parentSessionId: sessionId,
        status: run.status,
        createdAt: run.createdAt,
        endedAt: run.endedAt,
      }));

      setSubagentsBySessionId((prev) => {
        const existing = prev[sessionId];
        if (existing && JSON.stringify(existing) === JSON.stringify(summaries)) {
          return prev;
        }
        return { ...prev, [sessionId]: summaries };
      });
    } catch {
      // Silently ignore fetch errors
    }
  }, []);

  const removeSubagent = useCallback((parentSessionId: string, runId: string) => {
    setSubagentsBySessionId((prev) => {
      const existing = prev[parentSessionId];
      if (!existing) return prev;
      const next = existing.filter((subagent) => subagent.id !== runId);
      if (next.length === existing.length) return prev;
      return { ...prev, [parentSessionId]: next };
    });
  }, []);

  const clearTerminalRefreshTimeouts = useCallback(() => {
    for (const timeout of terminalRefreshTimeoutsRef.current) {
      clearTimeout(timeout);
    }
    terminalRefreshTimeoutsRef.current = [];
  }, []);

  useEffect(() => {
    postParentPollingDeadlineRef.current = null;
    runningParentSessionIdRef.current = null;
    clearTerminalRefreshTimeouts();
  }, [clearTerminalRefreshTimeouts, currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) return;

    if (currentSessionStatus === CoworkSessionStatusValue.Running) {
      runningParentSessionIdRef.current = currentSessionId;
      postParentPollingDeadlineRef.current = null;
      clearTerminalRefreshTimeouts();
      return;
    }

    if (runningParentSessionIdRef.current !== currentSessionId) return;
    runningParentSessionIdRef.current = null;
    postParentPollingDeadlineRef.current = Date.now() + POST_PARENT_COMPLETION_POLL_MS;
    clearTerminalRefreshTimeouts();

    terminalRefreshTimeoutsRef.current = POST_PARENT_REFRESH_DELAYS_MS.map((delayMs) => setTimeout(() => {
      void fetchSubagents(currentSessionId);
    }, delayMs));

    return clearTerminalRefreshTimeouts;
  }, [clearTerminalRefreshTimeouts, currentSessionId, currentSessionStatus, fetchSubagents]);

  useEffect(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    if (!currentSessionId) return;

    const currentSubagents = subagentsBySessionId[currentSessionId] ?? [];
    const hasRunningSubagents = currentSubagents.some((subagent) => subagent.status === 'running');
    if (currentSessionStatus !== CoworkSessionStatusValue.Running) {
      if (hasRunningSubagents && postParentPollingDeadlineRef.current === null) {
        postParentPollingDeadlineRef.current = Date.now() + POST_PARENT_COMPLETION_POLL_MS;
      } else if (!hasRunningSubagents) {
        postParentPollingDeadlineRef.current = null;
      }
    }

    // Initial fetch
    void fetchSubagents(currentSessionId);

    if (shouldPollSubagentSessions({
      parentSessionStatus: currentSessionStatus,
      hasRunningSubagents,
      postParentPollingDeadlineMs: postParentPollingDeadlineRef.current,
      nowMs: Date.now(),
    })) {
      pollingRef.current = setInterval(() => {
        if (!shouldPollSubagentSessions({
          parentSessionStatus: currentSessionStatus,
          hasRunningSubagents: true,
          postParentPollingDeadlineMs: postParentPollingDeadlineRef.current,
          nowMs: Date.now(),
        })) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          return;
        }
        void fetchSubagents(currentSessionId);
      }, POLL_INTERVAL_MS);
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [currentSessionId, currentSessionStatus, fetchSubagents, subagentsBySessionId]);

  return { subagentsBySessionId, refetchSubagents: fetchSubagents, removeSubagent };
};
