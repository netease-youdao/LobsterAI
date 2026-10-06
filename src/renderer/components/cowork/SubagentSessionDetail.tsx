import { ArrowLeftIcon } from '@heroicons/react/20/solid';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import type { CoworkMessage, SubagentSessionSummary } from '../../types/cowork';
import { getSubagentDisplayName } from '../../utils/subagentDisplay';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ConversationTurnsView from './ConversationTurnsView';

interface SubagentSessionDetailProps {
  subagent: SubagentSessionSummary;
  onBack: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const SubagentSessionDetail: React.FC<SubagentSessionDetailProps> = ({ subagent, onBack, isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const [messages, setMessages] = useState<CoworkMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'running' | 'done' | 'error'>(subagent.status);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const agents = useSelector((state: RootState) => state.agent.agents);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  const fetchHistory = useCallback(async () => {
    if (!subagent.parentSessionId) return;
    try {
      const result = await window.electron?.cowork?.getSubTaskHistory({
        parentSessionId: subagent.parentSessionId,
        agentId: subagent.id,
        sessionKey: subagent.sessionKey ?? undefined,
      });
      if (result?.success && result.messages) {
        setMessages(result.messages as CoworkMessage[]);
      }
    } catch { /* ignore */ }
    finally {
      setLoading(false);
    }
  }, [subagent]);

  const fetchStatus = useCallback(async () => {
    if (!subagent.parentSessionId) return;
    try {
      const result = await window.electron?.cowork?.listSubagentSessions(subagent.parentSessionId);
      if (result?.success && result.runs) {
        const run = result.runs.find((r) => r.id === subagent.id);
        if (run?.status) setStatus(run.status);
      }
    } catch { /* ignore */ }
  }, [subagent]);

  useEffect(() => {
    void fetchHistory();
    void fetchStatus();

    // Only poll while subagent is still running
    if (status === 'running') {
      const timer = setInterval(() => {
        void fetchHistory();
        void fetchStatus();
      }, 5000);
      return () => clearInterval(timer);
    }
  }, [fetchHistory, fetchStatus, status]);

  // Use agent name as title to avoid duplicating the task content shown in conversation
  const displayTitle = useMemo(() => {
    return getSubagentDisplayName(subagent, agents);
  }, [agents, subagent]);

  // When messages are empty but task exists, synthesize a user message so
  // the view shows the initial prompt instead of "暂无对话记录"
  const effectiveMessages = useMemo(() => {
    if (messages.length > 0) return messages;
    if (!subagent.task) return messages;
    return [{
      id: 'synthetic-task',
      type: 'user' as const,
      content: subagent.task,
      timestamp: subagent.createdAt,
    }] as CoworkMessage[];
  }, [messages, subagent.task, subagent.createdAt]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="draggable flex h-12 items-center gap-3 border-b border-border px-4 bg-background shrink-0">
        <div className="non-draggable flex items-center gap-2">
          {isSidebarCollapsed && !isWindows && (
            <div className={`flex items-center gap-1 mr-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.05]"
            aria-label={i18nService.t('back') || 'Back'}
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              status === 'done' ? 'bg-green-500' : status === 'error' ? 'bg-red-500' : 'bg-blue-500 animate-pulse'
            }`}
          />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {displayTitle}
          </span>
        </div>

        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
          status === 'done'
            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            : status === 'error'
              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
              : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
        }`}>
          {status === 'done'
            ? (i18nService.t('subagentCompleted') || 'Completed')
            : status === 'error'
              ? (i18nService.t('subagentError') || 'Error')
              : (i18nService.t('subagentWorking') || 'Working...')}
        </span>
      </div>

      {/* Messages */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="ml-3 text-sm text-secondary">
              {i18nService.t('loading') || 'Loading...'}
            </span>
          </div>
        )}

        {!loading && (
          <ConversationTurnsView
            messages={effectiveMessages}
            isStreaming={status === 'running'}
            readOnly={true}
          />
        )}
      </div>

      {/* Footer status bar */}
      <div className="flex items-center justify-between border-t border-border px-4 py-2 bg-surface">
        <span className="text-xs text-secondary">
          {messages.length > 0
            ? `${messages.length} ${i18nService.t('subTaskMessages') || 'messages'}`
            : ''}
        </span>
        {subagent.label && (
          <span className="text-xs font-medium text-blue-500/70">
            {subagent.label}
          </span>
        )}
      </div>
    </div>
  );
};

export default SubagentSessionDetail;
