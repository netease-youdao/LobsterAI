import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { localStore } from '../../services/store';
import { RootState } from '../../store';
import {
  selectCompletedUnreadSessionIds,
  selectCoworkSessions,
  selectCurrentSessionId,
  selectPendingPermissionSessionIds,
} from '../../store/selectors/coworkSelectors';
import type { CoworkSessionSummary } from '../../types/cowork';
import { CoworkSessionStatusValue } from '../../types/cowork';
import {
  AgentSidebarIndicator,
  AgentSidebarPageSize,
  AgentSidebarPreferenceKey,
} from './constants';
import {
  hasLegacyScheduledTaskTitle,
  isScheduledTaskSession,
} from './scheduledTaskSession';
import type {
  AgentSidebarAgentNode,
  AgentSidebarAgentSummary,
  AgentSidebarPreferenceState,
  AgentSidebarTaskNode,
} from './types';

const normalizeAgentId = (agentId?: string) => agentId?.trim() || 'main';

const logAgentSidebarLoadIssue = (
  level: 'warn' | 'error',
  message: string,
  error?: unknown,
): void => {
  if (level === 'error') {
    console.error(`[AgentSidebar] ${message}`, error);
  } else {
    console.warn(`[AgentSidebar] ${message}`);
  }
  const persistedMessage = error === undefined
    ? message
    : `${message} error=${error instanceof Error ? error.message : String(error)}`;
  try {
    window.electron?.log?.fromRenderer?.(level, 'AgentSidebar', persistedMessage);
  } catch {
    // Best-effort renderer diagnostics only.
  }
};

export const logAgentSidebarDebug = (message: string): void => {
  console.debug(`[AgentSidebar] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('debug', 'AgentSidebar', message);
  } catch {
    // Best-effort renderer diagnostics only.
  }
};

const hasSessionChanged = (
  previous: CoworkSessionSummary,
  next: CoworkSessionSummary,
): boolean => {
  return previous.title !== next.title
    || previous.scheduledTaskId !== next.scheduledTaskId
    || previous.status !== next.status
    || previous.pinned !== next.pinned
    || previous.pinOrder !== next.pinOrder
    || previous.imPlatform !== next.imPlatform
    || previous.parentSessionId !== next.parentSessionId
    || previous.updatedAt !== next.updatedAt
    || previous.createdAt !== next.createdAt
    || normalizeAgentId(previous.agentId) !== normalizeAgentId(next.agentId);
};

const mergeSessions = (
  current: CoworkSessionSummary[],
  incoming: CoworkSessionSummary[],
): CoworkSessionSummary[] => {
  const byId = new Map<string, CoworkSessionSummary>();
  current.forEach((session) => byId.set(session.id, session));
  incoming.forEach((session) => byId.set(session.id, session));
  return Array.from(byId.values());
};

export const deriveAgentSidebarIndicator = (
  session: CoworkSessionSummary,
  completedUnreadSessionIds: Set<string>,
  pendingPermissionSessionIds: Set<string>,
) => {
  if (pendingPermissionSessionIds.has(session.id)) {
    return AgentSidebarIndicator.PendingPermission;
  }
  if (completedUnreadSessionIds.has(session.id)) {
    return AgentSidebarIndicator.CompletedUnread;
  }
  if (session.status === CoworkSessionStatusValue.Running) {
    return AgentSidebarIndicator.Running;
  }
  return AgentSidebarIndicator.None;
};

export const sortAgentSidebarTasks = (
  tasks: CoworkSessionSummary[],
): CoworkSessionSummary[] => {
  return [...tasks].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const aPinOrder = a.pinOrder ?? a.updatedAt ?? a.createdAt;
      const bPinOrder = b.pinOrder ?? b.updatedAt ?? b.createdAt;
      if (aPinOrder !== bPinOrder) return aPinOrder - bPinOrder;
    }
    const aUpdatedAt = a.updatedAt || a.createdAt;
    const bUpdatedAt = b.updatedAt || b.createdAt;
    if (bUpdatedAt !== aUpdatedAt) return bUpdatedAt - aUpdatedAt;
    return b.createdAt - a.createdAt;
  });
};

export const sortAgentSidebarAgents = (
  agents: AgentSidebarAgentSummary[],
): AgentSidebarAgentSummary[] => {
  return [...agents].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aSortOrder = a.sortOrder ?? (a.pinned ? a.pinOrder : null) ?? Number.MAX_SAFE_INTEGER;
    const bSortOrder = b.sortOrder ?? (b.pinned ? b.pinOrder : null) ?? Number.MAX_SAFE_INTEGER;
    if (aSortOrder !== bSortOrder) return aSortOrder - bSortOrder;
    return 0;
  });
};

export const toAgentSidebarTaskNode = (
  session: CoworkSessionSummary,
  currentSessionId: string | null,
  completedUnreadSessionIds: Set<string>,
  pendingPermissionSessionIds: Set<string>,
): AgentSidebarTaskNode => {
  return {
    id: session.id,
    agentId: normalizeAgentId(session.agentId),
    title: session.title,
    isScheduledTask: isScheduledTaskSession(
      session.scheduledTaskId,
      session.title,
      session.parentSessionId,
    ),
    status: session.status,
    pinned: session.pinned,
    pinOrder: session.pinOrder ?? null,
    imPlatform: session.imPlatform ?? null,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    indicator: deriveAgentSidebarIndicator(
      session,
      completedUnreadSessionIds,
      pendingPermissionSessionIds,
    ),
    isSelected: session.id === currentSessionId,
  };
};

export const collapseAgentSidebarTaskList = (
  expandedTaskListAgentIds: string[],
  agentId: string,
) => {
  return expandedTaskListAgentIds.includes(agentId)
    ? expandedTaskListAgentIds.filter((id) => id !== agentId)
    : expandedTaskListAgentIds;
};

export const removeAgentSidebarTaskPreviews = (
  previewsByAgentId: Record<string, CoworkSessionSummary[]>,
  sessionIds: Iterable<string>,
): Record<string, CoworkSessionSummary[]> => {
  const sessionIdSet = new Set(sessionIds);
  if (sessionIdSet.size === 0) return previewsByAgentId;

  let changed = false;
  const next = { ...previewsByAgentId };

  Object.entries(previewsByAgentId).forEach(([agentId, tasks]) => {
    if (!tasks.some((task) => sessionIdSet.has(task.id))) return;
    next[agentId] = tasks.filter((task) => !sessionIdSet.has(task.id));
    changed = true;
  });

  return changed ? next : previewsByAgentId;
};

export const removeAgentSidebarAgentTaskPreviews = (
  previewsByAgentId: Record<string, CoworkSessionSummary[]>,
  agentId: string,
): Record<string, CoworkSessionSummary[]> => {
  if (!Object.prototype.hasOwnProperty.call(previewsByAgentId, agentId)) {
    return previewsByAgentId;
  }

  const next = { ...previewsByAgentId };
  delete next[agentId];
  return next;
};

export const useAgentSidebarState = ({
  includeActivityTasks = false,
}: {
  includeActivityTasks?: boolean;
} = {}) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const sessions = useSelector(selectCoworkSessions);
  const completedUnreadSessionIds = useSelector(selectCompletedUnreadSessionIds);
  const pendingPermissionSessionIds = useSelector(selectPendingPermissionSessionIds);

  const [expandedAgentIds, setExpandedAgentIds] = useState<string[]>([]);
  const [expandedTaskListAgentIds, setExpandedTaskListAgentIds] = useState<string[]>([]);
  const [visibleTaskLimitByAgentId, setVisibleTaskLimitByAgentId] = useState<Record<string, number>>({});
  const [taskPreviewsByAgentId, setTaskPreviewsByAgentId] = useState<Record<string, CoworkSessionSummary[]>>({});
  const [hasMoreTasksByAgentId, setHasMoreTasksByAgentId] = useState<Record<string, boolean>>({});
  const [loadingAgentIds, setLoadingAgentIds] = useState<string[]>([]);
  const [failedAgentIds, setFailedAgentIds] = useState<string[]>([]);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);

  const loadedAgentIdsRef = useRef(new Set<string>());
  const loadingKeysRef = useRef(new Set<string>());
  const activeAgentIdsRef = useRef(new Set<string>());
  const loggedScheduledMarkerSignatureByAgentIdRef = useRef(new Map<string, string>());
  const initializedDefaultExpansionRef = useRef(false);

  useEffect(() => {
    return () => {
      activeAgentIdsRef.current.clear();
    };
  }, []);

  const enabledAgents = useMemo(() => {
    return agents
      .filter((agent) => agent.enabled)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        icon: agent.icon,
        enabled: agent.enabled,
        pinned: agent.pinned ?? false,
        pinOrder: agent.pinOrder ?? null,
        sortOrder: agent.sortOrder ?? null,
      }));
  }, [agents]);

  const sortedEnabledAgents = useMemo(() => {
    return sortAgentSidebarAgents(enabledAgents);
  }, [enabledAgents]);

  const completedUnreadSessionIdSet = useMemo(
    () => new Set(completedUnreadSessionIds),
    [completedUnreadSessionIds],
  );
  const pendingPermissionSessionIdSet = useMemo(
    () => new Set(pendingPermissionSessionIds),
    [pendingPermissionSessionIds],
  );
  const expandedAgentIdSet = useMemo(() => new Set(expandedAgentIds), [expandedAgentIds]);
  const expandedTaskListAgentIdSet = useMemo(
    () => new Set(expandedTaskListAgentIds),
    [expandedTaskListAgentIds],
  );
  const loadingAgentIdSet = useMemo(() => new Set(loadingAgentIds), [loadingAgentIds]);
  const failedAgentIdSet = useMemo(() => new Set(failedAgentIds), [failedAgentIds]);

  useEffect(() => {
    let cancelled = false;
    void localStore.getItem<AgentSidebarPreferenceState>(AgentSidebarPreferenceKey.State)
      .then((preference) => {
        if (cancelled) return;
        setExpandedAgentIds(preference?.expandedAgentIds ?? []);
        setExpandedTaskListAgentIds(preference?.expandedTaskListAgentIds ?? []);
      })
      .finally(() => {
        if (!cancelled) {
          setPreferenceLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!preferenceLoaded) return;
    const preference: AgentSidebarPreferenceState = {
      expandedAgentIds,
      expandedTaskListAgentIds,
      selectedAgentId: currentAgentId,
      selectedTaskId: currentSessionId ?? undefined,
    };
    void localStore.setItem(AgentSidebarPreferenceKey.State, preference);
  }, [
    currentAgentId,
    currentSessionId,
    expandedAgentIds,
    expandedTaskListAgentIds,
    preferenceLoaded,
  ]);

  useEffect(() => {
    if (!preferenceLoaded || initializedDefaultExpansionRef.current) return;
    if (sortedEnabledAgents.length === 0) return;
    initializedDefaultExpansionRef.current = true;
    setExpandedAgentIds((previous) => {
      if (previous.length > 0) return previous;
      const currentAgentExists = sortedEnabledAgents.some((agent) => agent.id === currentAgentId);
      return [currentAgentExists ? currentAgentId : sortedEnabledAgents[0].id];
    });
  }, [currentAgentId, preferenceLoaded, sortedEnabledAgents]);

  const setAgentLoading = useCallback((agentId: string, isLoading: boolean) => {
    setLoadingAgentIds((previous) => {
      const exists = previous.includes(agentId);
      if (isLoading && !exists) return [...previous, agentId];
      if (!isLoading && exists) return previous.filter((id) => id !== agentId);
      return previous;
    });
  }, []);

  const setAgentFailed = useCallback((agentId: string, failed: boolean) => {
    setFailedAgentIds((previous) => {
      const exists = previous.includes(agentId);
      if (failed && !exists) return [...previous, agentId];
      if (!failed && exists) return previous.filter((id) => id !== agentId);
      return previous;
    });
  }, []);

  const loadAgentTasks = useCallback(async (
    agentId: string,
    options: { offset?: number; limit?: number; replace?: boolean } = {},
  ) => {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? AgentSidebarPageSize.Preview;
    const replace = options.replace ?? offset === 0;
    const loadingKey = `${agentId}:${offset}:${limit}`;
    if (loadingKeysRef.current.has(loadingKey)) return;

    loadingKeysRef.current.add(loadingKey);
    setAgentLoading(agentId, true);
    setAgentFailed(agentId, false);

    try {
      const result = await coworkService.listSessionsForAgentPreview(agentId, limit, offset);
      if (!activeAgentIdsRef.current.has(agentId)) return;
      if (!result.success) {
        logAgentSidebarLoadIssue(
          'warn',
          `failed to load task preview for agent ${agentId}: ${result.error ?? 'unknown error'}.`,
        );
        setAgentFailed(agentId, true);
        return;
      }
      if (offset === 0) {
        const loadedSessions = result.sessions ?? [];
        const explicitMarkerCount = loadedSessions.filter(
          (session) => !session.parentSessionId && Boolean(session.scheduledTaskId?.trim()),
        ).length;
        const legacyMarkerCount = loadedSessions.filter(
          (session) => !session.parentSessionId
            && !session.scheduledTaskId?.trim()
            && hasLegacyScheduledTaskTitle(session.title),
        ).length;
        const markerSignature = `${explicitMarkerCount}:${legacyMarkerCount}`;
        if (
          loggedScheduledMarkerSignatureByAgentIdRef.current.get(agentId) !== markerSignature
        ) {
          const message = `scheduled-task markers resolved; agent=${agentId}; explicit=${explicitMarkerCount}; legacy=${legacyMarkerCount}; pageSize=${loadedSessions.length}.`;
          logAgentSidebarDebug(message);
          loggedScheduledMarkerSignatureByAgentIdRef.current.set(agentId, markerSignature);
        }
      }
      loadedAgentIdsRef.current.add(agentId);
      setTaskPreviewsByAgentId((previous) => {
        const current = replace ? [] : previous[agentId] ?? [];
        return {
          ...previous,
          [agentId]: mergeSessions(current, result.sessions ?? []),
        };
      });
      setHasMoreTasksByAgentId((previous) => ({
        ...previous,
        [agentId]: result.hasMore ?? false,
      }));
    } catch (error) {
      logAgentSidebarLoadIssue(
        'error',
        `task preview request rejected for agent ${agentId}.`,
        error,
      );
      if (activeAgentIdsRef.current.has(agentId)) {
        setAgentFailed(agentId, true);
      }
    } finally {
      loadingKeysRef.current.delete(loadingKey);
      if (activeAgentIdsRef.current.has(agentId)) {
        setAgentLoading(agentId, false);
      }
    }
  }, [setAgentFailed, setAgentLoading]);

  useEffect(() => {
    sortedEnabledAgents.forEach((agent) => {
      if (loadedAgentIdsRef.current.has(agent.id)) return;
      void loadAgentTasks(agent.id, { replace: true });
    });
  }, [loadAgentTasks, sortedEnabledAgents]);

  useEffect(() => {
    const activeAgentIds = new Set(enabledAgents.map((agent) => agent.id));
    activeAgentIdsRef.current = activeAgentIds;
    for (const agentId of Array.from(loadedAgentIdsRef.current)) {
      if (!activeAgentIds.has(agentId)) {
        loadedAgentIdsRef.current.delete(agentId);
        loggedScheduledMarkerSignatureByAgentIdRef.current.delete(agentId);
      }
    }
    for (const key of Array.from(loadingKeysRef.current)) {
      const separatorIndex = key.indexOf(':');
      const agentId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
      if (!activeAgentIds.has(agentId)) {
        loadingKeysRef.current.delete(key);
      }
    }

    setTaskPreviewsByAgentId((previous) => {
      let changed = false;
      const next: Record<string, CoworkSessionSummary[]> = {};
      Object.entries(previous).forEach(([agentId, tasks]) => {
        if (activeAgentIds.has(agentId)) {
          next[agentId] = tasks;
          return;
        }
        changed = true;
      });
      return changed ? next : previous;
    });
    setHasMoreTasksByAgentId((previous) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      Object.entries(previous).forEach(([agentId, hasMore]) => {
        if (activeAgentIds.has(agentId)) {
          next[agentId] = hasMore;
          return;
        }
        changed = true;
      });
      return changed ? next : previous;
    });
    setLoadingAgentIds((previous) => previous.filter((id) => activeAgentIds.has(id)));
    setFailedAgentIds((previous) => previous.filter((id) => activeAgentIds.has(id)));
    setExpandedAgentIds((previous) => previous.filter((id) => activeAgentIds.has(id)));
    setExpandedTaskListAgentIds((previous) => previous.filter((id) => activeAgentIds.has(id)));
    setVisibleTaskLimitByAgentId((previous) => {
      let changed = false;
      const next: Record<string, number> = {};
      Object.entries(previous).forEach(([agentId, limit]) => {
        if (activeAgentIds.has(agentId)) {
          next[agentId] = limit;
          return;
        }
        changed = true;
      });
      return changed ? next : previous;
    });
  }, [enabledAgents]);

  useEffect(() => {
    if (sessions.length === 0) return;
    setTaskPreviewsByAgentId((previous) => {
      let changed = false;
      const next = { ...previous };

      sessions.forEach((session) => {
        const agentId = normalizeAgentId(session.agentId);
        const existingTasks = next[agentId];
        if (!existingTasks) return;

        const index = existingTasks.findIndex((item) => item.id === session.id);
        if (index === -1) {
          if (loadedAgentIdsRef.current.has(agentId)) {
            next[agentId] = [session, ...existingTasks];
            changed = true;
          }
          return;
        }

        if (hasSessionChanged(existingTasks[index], session)) {
          const updatedTasks = [...existingTasks];
          updatedTasks[index] = session;
          next[agentId] = updatedTasks;
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [sessions]);

  const toggleAgentExpanded = useCallback((agentId: string) => {
    setExpandedAgentIds((previous) => {
      return previous.includes(agentId)
        ? previous.filter((id) => id !== agentId)
        : [...previous, agentId];
    });
  }, []);

  const loadMoreTasks = useCallback((agentId: string) => {
    const loadedTasks = taskPreviewsByAgentId[agentId] ?? [];
    const currentVisibleLimit =
      visibleTaskLimitByAgentId[agentId]
      ?? (expandedTaskListAgentIdSet.has(agentId)
        ? AgentSidebarPageSize.Preview + AgentSidebarPageSize.ExpandBatch
        : AgentSidebarPageSize.Preview);
    const nextVisibleLimit = currentVisibleLimit + AgentSidebarPageSize.ExpandBatch;
    setExpandedTaskListAgentIds((previous) => {
      return previous.includes(agentId) ? previous : [...previous, agentId];
    });
    setVisibleTaskLimitByAgentId((previous) => ({
      ...previous,
      [agentId]: nextVisibleLimit,
    }));

    if (loadedTasks.length >= nextVisibleLimit || !(hasMoreTasksByAgentId[agentId] ?? false)) {
      return Promise.resolve();
    }

    const offset = loadedTasks.length;
    const limit = Math.max(
      AgentSidebarPageSize.ExpandBatch,
      nextVisibleLimit - loadedTasks.length,
    );
    const loadingKey = `${agentId}:${offset}:${limit}`;
    if (loadingKeysRef.current.has(loadingKey)) return Promise.resolve();

    loadingKeysRef.current.add(loadingKey);
    setAgentLoading(agentId, true);
    setAgentFailed(agentId, false);

    const loadNextPage = async () => {
      try {
        const result = await coworkService.listSessionsForAgentPreview(agentId, limit, offset);
        if (!activeAgentIdsRef.current.has(agentId)) return;
        if (!result.success) {
          logAgentSidebarLoadIssue(
            'warn',
            `failed to load more tasks for agent ${agentId}: ${result.error ?? 'unknown error'}.`,
          );
          setAgentFailed(agentId, true);
          return;
        }
        loadedAgentIdsRef.current.add(agentId);
        setTaskPreviewsByAgentId((previous) => ({
          ...previous,
          [agentId]: mergeSessions(previous[agentId] ?? [], result.sessions ?? []),
        }));
        setHasMoreTasksByAgentId((previous) => ({
          ...previous,
          [agentId]: result.hasMore ?? false,
        }));
      } catch (error) {
        logAgentSidebarLoadIssue(
          'error',
          `load-more request rejected for agent ${agentId}.`,
          error,
        );
        if (activeAgentIdsRef.current.has(agentId)) {
          setAgentFailed(agentId, true);
        }
      }
    };

    return loadNextPage().finally(() => {
      loadingKeysRef.current.delete(loadingKey);
      if (activeAgentIdsRef.current.has(agentId)) {
        setAgentLoading(agentId, false);
      }
    });
  }, [
    expandedTaskListAgentIdSet,
    hasMoreTasksByAgentId,
    setAgentFailed,
    setAgentLoading,
    taskPreviewsByAgentId,
    visibleTaskLimitByAgentId,
  ]);

  const expandAgent = useCallback((agentId: string) => {
    setExpandedAgentIds((previous) => {
      return previous.includes(agentId) ? previous : [...previous, agentId];
    });
  }, []);

  const collapseAgent = useCallback((agentId: string) => {
    setExpandedAgentIds((previous) => {
      return previous.includes(agentId) ? previous.filter((id) => id !== agentId) : previous;
    });
  }, []);

  const expandTasks = useCallback((agentId: string) => {
    expandAgent(agentId);
    return loadMoreTasks(agentId);
  }, [expandAgent, loadMoreTasks]);

  const collapseTasks = useCallback((agentId: string) => {
    setExpandedTaskListAgentIds((previous) => {
      return collapseAgentSidebarTaskList(previous, agentId);
    });
    setVisibleTaskLimitByAgentId((previous) => {
      if (!Object.prototype.hasOwnProperty.call(previous, agentId)) return previous;
      const next = { ...previous };
      delete next[agentId];
      return next;
    });
  }, []);

  const retryLoadTasks = useCallback((agentId: string) => {
    loadedAgentIdsRef.current.delete(agentId);
    return loadAgentTasks(agentId, { replace: true });
  }, [loadAgentTasks]);

  const patchTaskPreview = useCallback((
    sessionId: string,
    updates: Partial<Pick<CoworkSessionSummary, 'title' | 'pinned' | 'pinOrder' | 'status'>>,
    options: { preserveUpdatedAt?: boolean } = {},
  ) => {
    setTaskPreviewsByAgentId((previous) => {
      let changed = false;
      const next = { ...previous };
      Object.entries(previous).forEach(([agentId, tasks]) => {
        const index = tasks.findIndex((task) => task.id === sessionId);
        if (index === -1) return;
        const updatedTasks = [...tasks];
        updatedTasks[index] = {
          ...updatedTasks[index],
          ...updates,
          updatedAt: options.preserveUpdatedAt ? updatedTasks[index].updatedAt : Date.now(),
        };
        next[agentId] = updatedTasks;
        changed = true;
      });
      return changed ? next : previous;
    });
  }, []);

  const removeTaskPreview = useCallback((sessionId: string) => {
    setTaskPreviewsByAgentId((previous) => {
      return removeAgentSidebarTaskPreviews(previous, [sessionId]);
    });
  }, []);

  const removeTaskPreviews = useCallback((sessionIds: string[]) => {
    setTaskPreviewsByAgentId((previous) => {
      return removeAgentSidebarTaskPreviews(previous, sessionIds);
    });
  }, []);

  const removeAgentTaskPreviews = useCallback((agentId: string) => {
    loadedAgentIdsRef.current.delete(agentId);
    for (const key of Array.from(loadingKeysRef.current)) {
      if (key.startsWith(`${agentId}:`)) {
        loadingKeysRef.current.delete(key);
      }
    }

    setTaskPreviewsByAgentId((previous) => {
      return removeAgentSidebarAgentTaskPreviews(previous, agentId);
    });
    setHasMoreTasksByAgentId((previous) => {
      if (!Object.prototype.hasOwnProperty.call(previous, agentId)) return previous;
      const next = { ...previous };
      delete next[agentId];
      return next;
    });
    setLoadingAgentIds((previous) => previous.filter((id) => id !== agentId));
    setFailedAgentIds((previous) => previous.filter((id) => id !== agentId));
    setExpandedAgentIds((previous) => previous.filter((id) => id !== agentId));
    setExpandedTaskListAgentIds((previous) => previous.filter((id) => id !== agentId));
    setVisibleTaskLimitByAgentId((previous) => {
      if (!Object.prototype.hasOwnProperty.call(previous, agentId)) return previous;
      const next = { ...previous };
      delete next[agentId];
      return next;
    });
  }, []);

  const {
    agentNodes,
    activityAgentNodes,
    hasUnreadCompletedTasks,
  } = useMemo<{
    agentNodes: AgentSidebarAgentNode[];
    activityAgentNodes: AgentSidebarAgentNode[];
    hasUnreadCompletedTasks: boolean;
  }>(() => {
    const visibleNodes: AgentSidebarAgentNode[] = [];
    const activityNodes: AgentSidebarAgentNode[] = [];
    let hasUnreadCompletedTasks = false;

    sortedEnabledAgents.forEach((agent) => {
      const taskPreviews = taskPreviewsByAgentId[agent.id] ?? [];
      const sortedTaskPreviews = sortAgentSidebarTasks(taskPreviews);
      const isTaskListExpanded = expandedTaskListAgentIdSet.has(agent.id);
      const visibleTaskLimit =
        visibleTaskLimitByAgentId[agent.id]
        ?? (isTaskListExpanded
          ? AgentSidebarPageSize.Preview + AgentSidebarPageSize.ExpandBatch
          : AgentSidebarPageSize.Preview);
      const hasMoreLoadedTasks = sortedTaskPreviews.length > visibleTaskLimit;
      const canExpandTasks =
        (hasMoreTasksByAgentId[agent.id] ?? false) || hasMoreLoadedTasks;
      const canCollapseTasks = isTaskListExpanded;
      if (
        !hasUnreadCompletedTasks
        && sortedTaskPreviews.some((session) => completedUnreadSessionIdSet.has(session.id))
      ) {
        hasUnreadCompletedTasks = true;
      }
      const visibleTaskPreviews = sortedTaskPreviews.slice(0, visibleTaskLimit);
      const taskPreviewsToMap = includeActivityTasks
        ? sortedTaskPreviews
        : visibleTaskPreviews;
      const tasks = taskPreviewsToMap.map((session) => {
        return toAgentSidebarTaskNode(
          session,
          currentSessionId,
          completedUnreadSessionIdSet,
          pendingPermissionSessionIdSet,
        );
      });
      const node = {
        ...agent,
        isExpanded: expandedAgentIdSet.has(agent.id),
        isTaskListExpanded,
        canExpandTasks,
        canCollapseTasks,
        isLoadingTasks: loadingAgentIdSet.has(agent.id),
        hasLoadError: failedAgentIdSet.has(agent.id),
        tasks,
      };
      if (includeActivityTasks) {
        activityNodes.push(node);
      }
      visibleNodes.push({
        ...node,
        tasks: includeActivityTasks ? tasks.slice(0, visibleTaskLimit) : tasks,
      });
    });

    return {
      agentNodes: visibleNodes,
      activityAgentNodes: activityNodes,
      hasUnreadCompletedTasks,
    };
  }, [
    completedUnreadSessionIdSet,
    currentSessionId,
    expandedAgentIdSet,
    expandedTaskListAgentIdSet,
    failedAgentIdSet,
    hasMoreTasksByAgentId,
    includeActivityTasks,
    loadingAgentIdSet,
    pendingPermissionSessionIdSet,
    sortedEnabledAgents,
    taskPreviewsByAgentId,
    visibleTaskLimitByAgentId,
  ]);

  return {
    agentNodes,
    activityAgentNodes,
    hasUnreadCompletedTasks,
    expandedTaskListAgentIdSet,
    patchTaskPreview,
    removeTaskPreview,
    removeTaskPreviews,
    removeAgentTaskPreviews,
    retryLoadTasks,
    loadMoreTasks,
    expandAgent,
    collapseAgent,
    expandTasks,
    collapseTasks,
    toggleAgentExpanded,
  };
};
