import { AgentSource } from '@shared/agent/constants';
import { expertReminderRevision } from '@shared/agent/presets';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { localStore } from '../../services/store';
import { RootState } from '../../store';
import {
  selectCompletedUnreadSessionIds,
  selectCoworkSessions,
  selectCurrentSessionId,
  selectPendingPermissionSessionIds,
} from '../../store/selectors/coworkSelectors';
import { setSidebarRevealAgentId } from '../../store/slices/agentSlice';
import type { CoworkSessionSummary } from '../../types/cowork';
import { CoworkSessionSource, CoworkSessionStatusValue } from '../../types/cowork';
import {
  AgentSidebarIndicator,
  AgentSidebarPageSize,
  AgentSidebarPreferenceKey,
  PinnedTaskSortMode,
} from './constants';
import {
  hasLegacyScheduledTaskTitle,
  isScheduledTaskSession,
} from './scheduledTaskSession';
import {
  type AgentSidebarActivityItem,
  computeSidebarTaskStatusCounts,
  type SidebarTaskStatusCounts,
} from './taskFilter';
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

const PINNED_REFRESH_DEBOUNCE_MS = 250;

const hasSessionChanged = (
  previous: CoworkSessionSummary,
  next: CoworkSessionSummary,
): boolean => {
  return previous.title !== next.title
    || previous.scheduledTaskId !== next.scheduledTaskId
    || previous.status !== next.status
    || previous.pinned !== next.pinned
    || previous.pinOrder !== next.pinOrder
    || (previous.cwd ?? '') !== (next.cwd ?? '')
    || (previous.forkGitBranch ?? null) !== (next.forkGitBranch ?? null)
    || previous.imPlatform !== next.imPlatform
    || (previous.source ?? null) !== (next.source ?? null)
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
    const aUpdatedAt = a.updatedAt || a.createdAt;
    const bUpdatedAt = b.updatedAt || b.createdAt;
    if (bUpdatedAt !== aUpdatedAt) return bUpdatedAt - aUpdatedAt;
    return b.createdAt - a.createdAt;
  });
};

export const sortPinnedSidebarTasks = (
  tasks: CoworkSessionSummary[],
  sortMode: PinnedTaskSortMode = PinnedTaskSortMode.Manual,
): CoworkSessionSummary[] => {
  return [...tasks]
    .filter((task) => task.pinned)
    .sort((a, b) => {
      if (sortMode === PinnedTaskSortMode.Manual) {
        const aHasOrder = a.pinOrder !== null && a.pinOrder !== undefined;
        const bHasOrder = b.pinOrder !== null && b.pinOrder !== undefined;
        if (aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
        if (aHasOrder && bHasOrder && b.pinOrder !== a.pinOrder) {
          return (b.pinOrder as number) - (a.pinOrder as number);
        }
      }
      const aUpdatedAt = a.updatedAt || a.createdAt;
      const bUpdatedAt = b.updatedAt || b.createdAt;
      if (bUpdatedAt !== aUpdatedAt) return bUpdatedAt - aUpdatedAt;
      return b.createdAt - a.createdAt;
    });
};

export const applyOptimisticPinnedTaskOrder = (
  current: CoworkSessionSummary[],
  orderedSessionIds: string[],
): CoworkSessionSummary[] => {
  if (orderedSessionIds.length === 0 || current.length === 0) return current;
  const orderIndexById = new Map<string, number>();
  orderedSessionIds.forEach((id, index) => {
    if (!orderIndexById.has(id)) {
      orderIndexById.set(id, index);
    }
  });
  const maxExistingOrder = current.reduce(
    (max, session) => Math.max(max, session.pinOrder ?? 0),
    0,
  );
  const baseOrder = Math.max(Date.now(), maxExistingOrder + current.length);
  const orderedExisting = [
    ...orderedSessionIds
      .map((id) => current.find((session) => session.id === id))
      .filter((session): session is CoworkSessionSummary => Boolean(session)),
    ...current.filter((session) => !orderIndexById.has(session.id)),
  ];
  return orderedExisting.map((session, index) => ({
    ...session,
    pinOrder: baseOrder - index,
  }));
};

export const reconcilePinnedSidebarSessions = (
  current: CoworkSessionSummary[],
  liveSessions: CoworkSessionSummary[],
): CoworkSessionSummary[] => {
  if (liveSessions.length === 0) return current;

  const byId = new Map<string, CoworkSessionSummary>();
  current.forEach((session) => byId.set(session.id, session));
  let changed = false;

  liveSessions.forEach((live) => {
    const existing = byId.get(live.id);
    if (!live.pinned) {
      if (existing) {
        byId.delete(live.id);
        changed = true;
      }
      return;
    }

    const merged: CoworkSessionSummary = {
      ...existing,
      ...live,
      cwd: live.cwd || existing?.cwd || '',
      forkGitBranch: live.forkGitBranch !== undefined ? live.forkGitBranch : (existing?.forkGitBranch ?? null),
      imPlatform: live.imPlatform !== undefined ? live.imPlatform : (existing?.imPlatform ?? null),
      source: live.source !== undefined ? live.source : (existing?.source ?? null),
    };
    if (!existing || hasSessionChanged(existing, merged)) {
      byId.set(live.id, merged);
      changed = true;
    }
  });

  return changed ? Array.from(byId.values()) : current;
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
    cwd: session.cwd?.trim() || '',
    forkGitBranch: session.forkGitBranch ?? null,
    imPlatform: session.imPlatform ?? null,
    isExternalDshSession: session.source === CoworkSessionSource.DshExternal,
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

export const useAgentSidebarState = () => {
  const dispatch = useDispatch();
  const agents = useSelector((state: RootState) => state.agent.agents);
  const revisions = useSelector((state: RootState) => state.agent.expertRevisions);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const sidebarRevealAgentId = useSelector((state: RootState) => state.agent.sidebarRevealAgentId);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const currentSessionAgentId = useSelector((state: RootState) => (
    state.cowork.currentSession ? normalizeAgentId(state.cowork.currentSession.agentId) : null
  ));
  const sessions = useSelector(selectCoworkSessions);
  const completedUnreadSessionIds = useSelector(selectCompletedUnreadSessionIds);
  const pendingPermissionSessionIds = useSelector(selectPendingPermissionSessionIds);

  const [expandedAgentIds, setExpandedAgentIds] = useState<string[]>([]);
  const [expandedTaskListAgentIds, setExpandedTaskListAgentIds] = useState<string[]>([]);
  const [isPinnedSectionCollapsed, setIsPinnedSectionCollapsed] = useState(false);
  const [pinnedTaskSortMode, setPinnedTaskSortMode] = useState<PinnedTaskSortMode>(
    PinnedTaskSortMode.Manual,
  );
  const [visibleTaskLimitByAgentId, setVisibleTaskLimitByAgentId] = useState<Record<string, number>>({});
  const [taskPreviewsByAgentId, setTaskPreviewsByAgentId] = useState<Record<string, CoworkSessionSummary[]>>({});
  const [pinnedSessions, setPinnedSessions] = useState<CoworkSessionSummary[]>([]);
  const [hasMoreTasksByAgentId, setHasMoreTasksByAgentId] = useState<Record<string, boolean>>({});
  const [loadingAgentIds, setLoadingAgentIds] = useState<string[]>([]);
  const [failedAgentIds, setFailedAgentIds] = useState<string[]>([]);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);

  const loadedAgentIdsRef = useRef(new Set<string>());
  const loadingKeysRef = useRef(new Set<string>());
  const activeAgentIdsRef = useRef(new Set<string>());
  const taskPreviewsByAgentIdRef = useRef(taskPreviewsByAgentId);
  taskPreviewsByAgentIdRef.current = taskPreviewsByAgentId;
  const pinnedRequestIdRef = useRef(0);
  const loggedScheduledMarkerSignatureByAgentIdRef = useRef(new Map<string, string>());
  const initializedDefaultExpansionRef = useRef(false);

  const loadPinnedSessions = useCallback(async () => {
    const requestId = ++pinnedRequestIdRef.current;
    try {
      const result = await coworkService.listPinnedSessions();
      if (requestId !== pinnedRequestIdRef.current) return;
      if (!result.success) {
        logAgentSidebarLoadIssue(
          'warn',
          `failed to load pinned tasks: ${result.error ?? 'unknown error'}.`,
        );
        return;
      }
      setPinnedSessions(result.sessions ?? []);
    } catch (error) {
      logAgentSidebarLoadIssue('error', 'pinned tasks request rejected.', error);
    }
  }, []);

  useEffect(() => {
    void loadPinnedSessions();
  }, [loadPinnedSessions]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const unsubscribe = window.electron?.cowork?.onSessionsChanged?.(() => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadPinnedSessions();
      }, PINNED_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      unsubscribe?.();
    };
  }, [loadPinnedSessions]);

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
        iconCustomized: agent.iconCustomized,
        workingDirectory: agent.workingDirectory,
        source: agent.source,
        presetId: agent.presetId,
        updateRevision: agent.source === AgentSource.Preset && agent.presetId
          ? expertReminderRevision(agent.presetRevision, revisions[agent.presetId], agent.dismissedPresetRevision)
          : undefined,
        enabled: agent.enabled,
        pinned: agent.pinned ?? false,
        pinOrder: agent.pinOrder ?? null,
        sortOrder: agent.sortOrder ?? null,
      }));
  }, [agents, revisions]);

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
        setIsPinnedSectionCollapsed(preference?.isPinnedSectionCollapsed ?? false);
        setPinnedTaskSortMode(
          preference?.pinnedTaskSortMode === PinnedTaskSortMode.UpdatedAt
            ? PinnedTaskSortMode.UpdatedAt
            : PinnedTaskSortMode.Manual,
        );
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
      isPinnedSectionCollapsed,
      pinnedTaskSortMode,
      selectedAgentId: currentAgentId,
      selectedTaskId: currentSessionId ?? undefined,
    };
    void localStore.setItem(AgentSidebarPreferenceKey.State, preference);
  }, [
    currentAgentId,
    currentSessionId,
    expandedAgentIds,
    expandedTaskListAgentIds,
    isPinnedSectionCollapsed,
    pinnedTaskSortMode,
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

        const existing = existingTasks[index];
        const mergedSession: CoworkSessionSummary = {
          ...existing,
          ...session,
          cwd: session.cwd || existing.cwd || '',
          forkGitBranch: session.forkGitBranch !== undefined
            ? session.forkGitBranch
            : (existing.forkGitBranch ?? null),
          imPlatform: session.imPlatform !== undefined
            ? session.imPlatform
            : (existing.imPlatform ?? null),
          source: session.source !== undefined
            ? session.source
            : (existing.source ?? null),
        };
        if (hasSessionChanged(existing, mergedSession)) {
          const updatedTasks = [...existingTasks];
          updatedTasks[index] = mergedSession;
          next[agentId] = updatedTasks;
          changed = true;
        }
      });

      return changed ? next : previous;
    });
    setPinnedSessions((previous) => reconcilePinnedSidebarSessions(previous, sessions));
  }, [sessions]);

  const togglePinnedSectionCollapsed = useCallback(() => {
    setIsPinnedSectionCollapsed((previous) => !previous);
  }, []);

  const expandPinnedSection = useCallback(() => {
    setIsPinnedSectionCollapsed(false);
  }, []);

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

  const canRevealAgent = enabledAgents.some((agent) => agent.id === sidebarRevealAgentId);
  const canRevealSession = enabledAgents.some((agent) => agent.id === currentSessionAgentId);

  useEffect(() => {
    if (!preferenceLoaded || !sidebarRevealAgentId || !canRevealAgent) return;
    // Consume the intent after preferences load, including repeated summons of the same expert.
    expandAgent(sidebarRevealAgentId);
    dispatch(setSidebarRevealAgentId(null));
  }, [canRevealAgent, dispatch, expandAgent, preferenceLoaded, sidebarRevealAgentId]);

  useEffect(() => {
    if (!preferenceLoaded || !currentSessionId || !currentSessionAgentId || !canRevealSession) return;
    // Only navigation reveals the group. Streaming updates must respect a manual collapse.
    expandAgent(currentSessionAgentId);
  }, [canRevealSession, currentSessionAgentId, currentSessionId, expandAgent, preferenceLoaded]);

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
    options: { preserveUpdatedAt?: boolean; fallbackTask?: AgentSidebarTaskNode } = {},
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

    setPinnedSessions((previous) => {
      const index = previous.findIndex((task) => task.id === sessionId);
      if (updates.pinned === false) {
        if (index === -1) return previous;
        return previous.filter((task) => task.id !== sessionId);
      }

      if (index !== -1) {
        const updated = [...previous];
        updated[index] = {
          ...updated[index],
          ...updates,
          updatedAt: options.preserveUpdatedAt ? updated[index].updatedAt : Date.now(),
        };
        return updated;
      }

      if (updates.pinned !== true) {
        return previous;
      }

      let source: CoworkSessionSummary | undefined;
      for (const tasks of Object.values(taskPreviewsByAgentIdRef.current)) {
        const match = tasks.find((task) => task.id === sessionId);
        if (match) {
          source = match;
          break;
        }
      }
      if (!source && options.fallbackTask) {
        const fallback = options.fallbackTask;
        source = {
          id: fallback.id,
          title: fallback.title,
          scheduledTaskId: fallback.isScheduledTask ? fallback.id : null,
          status: fallback.status,
          pinned: true,
          pinOrder: fallback.pinOrder ?? null,
          cwd: fallback.cwd ?? '',
          agentId: fallback.agentId,
          imPlatform: fallback.imPlatform ?? null,
          source: fallback.isExternalDshSession ? CoworkSessionSource.DshExternal : null,
          forkGitBranch: fallback.forkGitBranch ?? null,
          createdAt: fallback.createdAt,
          updatedAt: fallback.updatedAt,
        };
      }
      if (!source) {
        return previous;
      }

      return [
        {
          ...source,
          ...updates,
          pinned: true,
          updatedAt: options.preserveUpdatedAt ? source.updatedAt : Date.now(),
        },
        ...previous,
      ];
    });
  }, []);

  const removeTaskPreview = useCallback((sessionId: string) => {
    setTaskPreviewsByAgentId((previous) => {
      return removeAgentSidebarTaskPreviews(previous, [sessionId]);
    });
    setPinnedSessions((previous) => (
      previous.some((session) => session.id === sessionId)
        ? previous.filter((session) => session.id !== sessionId)
        : previous
    ));
  }, []);

  const removeTaskPreviews = useCallback((sessionIds: string[]) => {
    setTaskPreviewsByAgentId((previous) => {
      return removeAgentSidebarTaskPreviews(previous, sessionIds);
    });
    if (sessionIds.length > 0) {
      const idSet = new Set(sessionIds);
      setPinnedSessions((previous) => (
        previous.some((session) => idSet.has(session.id))
          ? previous.filter((session) => !idSet.has(session.id))
          : previous
      ));
    }
  }, []);

  const reorderPinnedTasks = useCallback(async (orderedSessionIds: string[]): Promise<boolean> => {
    if (orderedSessionIds.length === 0) return true;
    let previousSnapshot: CoworkSessionSummary[] = [];
    setPinnedSessions((previous) => {
      previousSnapshot = previous;
      return applyOptimisticPinnedTaskOrder(previous, orderedSessionIds);
    });

    const result = await coworkService.reorderPinnedSessions(orderedSessionIds);
    if (!result.success) {
      setPinnedSessions(previousSnapshot);
      return false;
    }
    if (result.sessions) {
      setPinnedSessions(result.sessions);
    }
    return true;
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
    setPinnedSessions((previous) => (
      previous.some((session) => normalizeAgentId(session.agentId) === agentId)
        ? previous.filter((session) => normalizeAgentId(session.agentId) !== agentId)
        : previous
    ));
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
    pinnedTaskItems,
    taskStatusCounts,
  } = useMemo<{
    agentNodes: AgentSidebarAgentNode[];
    pinnedTaskItems: AgentSidebarActivityItem[];
    taskStatusCounts: SidebarTaskStatusCounts;
  }>(() => {
    const visibleNodes: AgentSidebarAgentNode[] = [];
    const previewsByEnabledAgent: CoworkSessionSummary[][] = [];
    const agentNodeById = new Map<string, AgentSidebarAgentNode>();

    sortedEnabledAgents.forEach((agent) => {
      const taskPreviews = taskPreviewsByAgentId[agent.id] ?? [];
      const sortedTaskPreviews = sortAgentSidebarTasks(taskPreviews);
      previewsByEnabledAgent.push(sortedTaskPreviews);
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
      const visibleTaskPreviews = sortedTaskPreviews.slice(0, visibleTaskLimit);
      const tasks = visibleTaskPreviews.map((session) => {
        return toAgentSidebarTaskNode(
          session,
          currentSessionId,
          completedUnreadSessionIdSet,
          pendingPermissionSessionIdSet,
        );
      });
      const node: AgentSidebarAgentNode = {
        ...agent,
        isExpanded: expandedAgentIdSet.has(agent.id),
        isTaskListExpanded,
        canExpandTasks,
        canCollapseTasks,
        isLoadingTasks: loadingAgentIdSet.has(agent.id),
        hasLoadError: failedAgentIdSet.has(agent.id),
        tasks,
      };
      visibleNodes.push(node);
      agentNodeById.set(agent.id, node);
    });

    const sortedPinnedSessions = sortPinnedSidebarTasks(pinnedSessions, pinnedTaskSortMode);
    const pinnedItems: AgentSidebarActivityItem[] = [];
    const enabledPinnedSessions: CoworkSessionSummary[] = [];
    sortedPinnedSessions.forEach((session) => {
      const agent = agentNodeById.get(normalizeAgentId(session.agentId));
      if (!agent) return;
      enabledPinnedSessions.push(session);
      pinnedItems.push({
        agent,
        task: toAgentSidebarTaskNode(
          session,
          currentSessionId,
          completedUnreadSessionIdSet,
          pendingPermissionSessionIdSet,
        ),
      });
    });

    if (enabledPinnedSessions.length > 0) {
      previewsByEnabledAgent.push(enabledPinnedSessions);
    }

    const taskStatusCounts = computeSidebarTaskStatusCounts(previewsByEnabledAgent, {
      completedUnreadSessionIds: completedUnreadSessionIdSet,
      pendingPermissionSessionIds: pendingPermissionSessionIdSet,
    });

    return {
      agentNodes: visibleNodes,
      pinnedTaskItems: pinnedItems,
      taskStatusCounts,
    };
  }, [
    completedUnreadSessionIdSet,
    currentSessionId,
    expandedAgentIdSet,
    expandedTaskListAgentIdSet,
    failedAgentIdSet,
    hasMoreTasksByAgentId,
    loadingAgentIdSet,
    pendingPermissionSessionIdSet,
    pinnedSessions,
    pinnedTaskSortMode,
    sortedEnabledAgents,
    taskPreviewsByAgentId,
    visibleTaskLimitByAgentId,
  ]);

  return {
    agentNodes,
    pinnedTaskItems,
    isPinnedSectionCollapsed,
    pinnedTaskSortMode,
    taskStatusCounts,
    hasUnreadCompletedTasks: taskStatusCounts.completedUnread > 0,
    expandedTaskListAgentIdSet,
    patchTaskPreview,
    removeTaskPreview,
    removeTaskPreviews,
    reorderPinnedTasks,
    removeAgentTaskPreviews,
    retryLoadTasks,
    loadMoreTasks,
    expandAgent,
    collapseAgent,
    expandTasks,
    collapseTasks,
    toggleAgentExpanded,
    togglePinnedSectionCollapsed,
    expandPinnedSection,
    setPinnedTaskSortMode,
  };
};
