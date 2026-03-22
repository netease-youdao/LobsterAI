import React, { useMemo, useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import SubTaskDetailDrawer from './SubTaskDetailDrawer';
import { i18nService } from '../../services/i18n';

/** Extracted sub-task info from sessions_spawn tool calls in a session's messages */
interface SubTaskInfo {
  agentId: string;
  task: string;
  status: 'running' | 'done';
  /** The actual OpenClaw session key extracted from tool_result content */
  sessionKey?: string;
}

interface CoworkSessionListProps {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  showBatchOption?: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
}

const CoworkSessionList: React.FC<CoworkSessionListProps> = ({
  sessions,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption = true,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  onToggleSelection,
  onEnterBatchMode,
}) => {
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);

  // Extract sub-tasks from current session's messages (tool_use with sessions_spawn)
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const subTasks = useMemo<SubTaskInfo[]>(() => {
    if (!currentSession?.messages) return [];
    const tasks = new Map<string, SubTaskInfo>();
    // Track spawn tool_use IDs and the message index where each agent was spawned
    for (let i = 0; i < currentSession.messages.length; i++) {
      const msg = currentSession.messages[i];
      const meta = msg.metadata;
      if (!meta) continue;

      // Detect sessions_spawn tool use (start)
      if (msg.type === 'tool_use' && meta.toolName === 'sessions_spawn') {
        const input = meta.toolInput as Record<string, unknown> | undefined;
        const agentId = typeof input?.agentId === 'string' ? input.agentId : '';
        const task = typeof input?.task === 'string' ? input.task.slice(0, 60) : '';
        if (agentId) {
          tasks.set(agentId, { agentId, task, status: 'running' });
        }
      }

      // Skip tool_result for sessions_spawn — it only means "spawn succeeded",
      // NOT that the sub-agent has finished its work

      // Look for sessions_resume tool_use — this means the parent is retrieving
      // the sub-agent's completed result
      if (msg.type === 'tool_use' && (meta.toolName === 'sessions_resume' || meta.toolName === 'sessions_read')) {
        const input = meta.toolInput as Record<string, unknown> | undefined;
        const agentId = typeof input?.agentId === 'string' ? input.agentId : '';
        if (agentId && tasks.has(agentId)) {
          tasks.set(agentId, { ...tasks.get(agentId)!, status: 'done' });
        }
      }
    }

    // If the session status is 'completed', mark all sub-tasks as done
    if (currentSession.status === 'completed') {
      for (const [agentId, task] of tasks) {
        tasks.set(agentId, { ...task, status: 'done' });
      }
    }

    return Array.from(tasks.values());
  }, [currentSession?.messages, currentSession?.status]);

  const sortedSessions = useMemo(() => {
    const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
      if (b.updatedAt !== a.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return b.createdAt - a.createdAt;
    };

    const pinnedSessions = sessions
      .filter((session) => session.pinned)
      .sort(sortByRecentActivity);
    const unpinnedSessions = sessions
      .filter((session) => !session.pinned)
      .sort(sortByRecentActivity);
    return [...pinnedSessions, ...unpinnedSessions];
  }, [sessions]);

  // Poll backend for real subagent statuses (lifecycle-based, not message-based)
  const [backendStatuses, setBackendStatuses] = useState<Record<string, 'running' | 'done'>>({});
  const isSessionActive = currentSession?.status === 'running';
  const activeSessionId = currentSession?.id;
  // Track whether polling should continue via ref to avoid re-triggering the effect
  const hasRunningRef = React.useRef(false);

  // Reset backend statuses when switching sessions
  useEffect(() => {
    setBackendStatuses({});
    hasRunningRef.current = false;
  }, [activeSessionId]);

  // Update ref when statuses change
  useEffect(() => {
    hasRunningRef.current = Object.values(backendStatuses).some(s => s === 'running')
      || subTasks.some(t => t.status === 'running');
  }, [backendStatuses, subTasks]);

  useEffect(() => {
    if (!activeSessionId) return;
    // Only poll when there are sub-tasks OR the session is active
    if (subTasks.length === 0 && !isSessionActive) return;
    const poll = async () => {
      try {
        const result = await window.electron.cowork.getSubTaskStatus(activeSessionId);
        if (result.success && result.statuses) {
          setBackendStatuses(result.statuses);
        }
      } catch { /* ignore */ }
    };
    poll();
    // Always set up interval — it will self-terminate when no longer needed
    const timer = setInterval(() => {
      if (!hasRunningRef.current && !isSessionActive) {
        clearInterval(timer);
        return;
      }
      poll();
    }, 3000);
    return () => clearInterval(timer);
  }, [activeSessionId, subTasks.length, isSessionActive]);

  // Merge backend statuses into subTasks, and add backend-only subagents
  const enrichedSubTasks = useMemo(() => {
    // Start with message-extracted sub-tasks, enriched with backend status
    const merged = subTasks.map(t => {
      const backendStatus = backendStatuses[t.agentId];
      // Backend status overrides — only upgrade from running→done, never downgrade
      if (backendStatus === 'done' && t.status === 'running') {
        return { ...t, status: 'done' as const };
      }
      // If backend says running, keep running even if message-based says done
      if (backendStatus === 'running') {
        return { ...t, status: 'running' as const };
      }
      return t;
    });

    // Add subagents that backend discovered but messages didn't capture
    const knownAgentIds = new Set(subTasks.map(t => t.agentId));
    for (const [agentId, status] of Object.entries(backendStatuses)) {
      if (!knownAgentIds.has(agentId)) {
        merged.push({ agentId, task: '', status });
      }
    }

    return merged;
  }, [subTasks, backendStatuses]);

  // Sub-task detail drawer state
  const [activeSubTask, setActiveSubTask] = useState<{ agentId: string; parentSessionId: string } | null>(null);

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-secondary">
          {i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-2">
      {sortedSessions.map((session) => (
        <React.Fragment key={session.id}>
          <CoworkSessionItem
            session={session}
            hasUnread={unreadSessionIdSet.has(session.id)}
            isActive={session.id === currentSessionId}
            isBatchMode={isBatchMode}
            isSelected={selectedIds.has(session.id)}
            showBatchOption={showBatchOption}
            onSelect={() => onSelectSession(session.id)}
            onDelete={() => onDeleteSession(session.id)}
            onTogglePin={(pinned) => onTogglePin(session.id, pinned)}
            onRename={(title) => onRenameSession(session.id, title)}
            onToggleSelection={() => onToggleSelection(session.id)}
            onEnterBatchMode={() => onEnterBatchMode(session.id)}
          />
          {/* Sub-tasks: visible while session is running OR has running sub-tasks */}
          {session.id === currentSessionId && enrichedSubTasks.length > 0 &&
           (currentSession?.status !== 'completed' || enrichedSubTasks.some(s => s.status === 'running')) && (
            <div className="ml-4 pl-3 border-l-2 border-claude-accent/20 dark:border-claude-accent/15 space-y-0.5">
              {enrichedSubTasks.map((sub) => (
                <div
                  key={sub.agentId}
                  onClick={() => setActiveSubTask({ agentId: sub.agentId, parentSessionId: session.id })}
                  className="flex items-center gap-2 py-1 px-2 rounded-md text-xs transition-colors cursor-pointer hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      sub.status === 'done'
                        ? 'bg-green-500'
                        : 'bg-blue-500 animate-pulse'
                    }`}
                  />
                  <span className="font-medium dark:text-claude-darkText text-claude-text truncate">
                    {sub.agentId}
                  </span>
                  {sub.task && (
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate flex-1" title={sub.task}>
                      {sub.task}
                    </span>
                  )}
                  <span className={`text-[10px] flex-shrink-0 ${
                    sub.status === 'done'
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-blue-600 dark:text-blue-400'
                  }`}>
                    {sub.status === 'done'
                      ? (i18nService.t('orchLogDone') || '已完成')
                      : (i18nService.t('orchLogSpawning') || '执行中')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>

    {/* Sub-task detail drawer */}
    {activeSubTask && (
      <SubTaskDetailDrawer
        agentId={activeSubTask.agentId}
        parentSessionId={activeSubTask.parentSessionId}
        onClose={() => setActiveSubTask(null)}
      />
    )}
    </>
  );
};

export default CoworkSessionList;
