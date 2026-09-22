import { ArrowLeftIcon } from '@heroicons/react/20/solid';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';
import { type CoworkMessage, SubagentSessionStatus, type SubagentSessionSummary } from '@/types/cowork';
import { getSubagentDisplayInitial, getSubagentDisplayName } from '@/utils/subagentDisplay';

import ConversationTurnsView from '../cowork/ConversationTurnsView';

interface SubagentPanelContentProps {
  subagents: SubagentSessionSummary[];
  loading?: boolean;
  selectedSubagent?: SubagentSessionSummary | null;
  onBackToList?: () => void;
  onSelectSubagent: (subagent: SubagentSessionSummary) => void;
}

const SUBAGENT_DETAIL_POLL_INTERVAL_MS = 5_000;

const formatDuration = (createdAt: number, endedAt: number | null): string => {
  const elapsed = Math.max(0, (endedAt ?? Date.now()) - createdAt);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const getSubagentStatusLabel = (status: SubagentSessionSummary['status']): string => {
  if (status === SubagentSessionStatus.Done) return i18nService.t('subagentCompleted');
  if (status === SubagentSessionStatus.Error) return i18nService.t('subagentError');
  return i18nService.t('subagentPanelRunning');
};

const SubagentStatusBadge: React.FC<{ status: SubagentSessionStatus }> = ({ status }) => (
  <span
    className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs ${
      status === SubagentSessionStatus.Running
        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : status === SubagentSessionStatus.Error
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-green-500/10 text-green-700 dark:text-green-400'
    }`}
  >
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${status === SubagentSessionStatus.Running ? 'animate-pulse' : ''}`}
      aria-hidden="true"
    />
    {getSubagentStatusLabel(status)}
  </span>
);

export const SubagentPanelRow: React.FC<{
  subagent: SubagentSessionSummary;
  agents: RootState['agent']['agents'];
  onSelectSubagent: (subagent: SubagentSessionSummary) => void;
}> = ({ subagent, agents, onSelectSubagent }) => {
  const displayName = getSubagentDisplayName(subagent, agents);
  const duration = formatDuration(
    subagent.createdAt,
    subagent.status === SubagentSessionStatus.Running ? null : subagent.endedAt,
  );

  return (
    <button
      type="button"
      onClick={() => onSelectSubagent(subagent)}
      className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {getSubagentDisplayInitial(subagent, agents)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{displayName}</span>
        {subagent.task?.trim() && (
          <span className="mt-0.5 block truncate text-xs text-secondary">
            {subagent.task}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <SubagentStatusBadge status={subagent.status} />
        {subagent.status !== SubagentSessionStatus.Running && (
          <span className="text-xs text-muted">{duration}</span>
        )}
      </span>
    </button>
  );
};

const SubagentDetailContent: React.FC<{
  subagent: SubagentSessionSummary;
  agents: RootState['agent']['agents'];
  onBack: () => void;
}> = ({ subagent, agents, onBack }) => {
  const [messages, setMessages] = useState<CoworkMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SubagentSessionSummary['status']>(subagent.status);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousMessageCountRef = useRef(0);

  const fetchHistory = useCallback(async (showLoading = false) => {
    if (!subagent.parentSessionId) return;
    if (showLoading) {
      setLoading(true);
    }
    try {
      const result = await window.electron?.cowork?.getSubTaskHistory({
        parentSessionId: subagent.parentSessionId,
        agentId: subagent.id,
        sessionKey: subagent.sessionKey ?? undefined,
      });
      if (result?.success && result.messages) {
        setMessages(result.messages as CoworkMessage[]);
      }
    } finally {
      setLoading(false);
    }
  }, [subagent.id, subagent.parentSessionId, subagent.sessionKey]);

  const fetchStatus = useCallback(async () => {
    if (!subagent.parentSessionId) return;
    try {
      const result = await window.electron?.cowork?.listSubagentSessions(subagent.parentSessionId);
      const run = result?.success ? result.runs?.find(item => item.id === subagent.id) : undefined;
      if (run?.status) {
        setStatus(run.status);
      }
    } catch {
      // Keep the last known status; detail history may still be readable.
    }
  }, [subagent.id, subagent.parentSessionId]);

  useEffect(() => {
    setMessages([]);
    setStatus(subagent.status);
    void fetchHistory(true);
    void fetchStatus();
  }, [fetchHistory, fetchStatus, subagent.id, subagent.status]);

  useEffect(() => {
    if (status !== SubagentSessionStatus.Running) return undefined;
    const timer = window.setInterval(() => {
      void fetchHistory();
      void fetchStatus();
    }, SUBAGENT_DETAIL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [fetchHistory, fetchStatus, status]);

  useEffect(() => {
    if (messages.length <= previousMessageCountRef.current || !contentRef.current) {
      previousMessageCountRef.current = messages.length;
      return;
    }
    contentRef.current.scrollTop = contentRef.current.scrollHeight;
    previousMessageCountRef.current = messages.length;
  }, [messages]);

  const effectiveMessages = useMemo(() => {
    if (messages.length > 0 || !subagent.task?.trim()) return messages;
    return [{
      id: 'synthetic-task',
      type: 'user' as const,
      content: subagent.task,
      timestamp: subagent.createdAt,
    }] as CoworkMessage[];
  }, [messages, subagent.createdAt, subagent.task]);

  const displayName = getSubagentDisplayName(subagent, agents);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface hover:text-foreground"
          aria-label={i18nService.t('back')}
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {getSubagentDisplayInitial(subagent, agents)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
          {subagent.task?.trim() && (
            <div className="truncate text-xs text-secondary">{subagent.task}</div>
          )}
        </div>
        <SubagentStatusBadge status={status} />
      </div>
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-secondary">
            {i18nService.t('loading')}
          </div>
        ) : (
          <ConversationTurnsView
            messages={effectiveMessages}
            isStreaming={status === SubagentSessionStatus.Running}
            readOnly
            className="py-2"
          />
        )}
      </div>
    </div>
  );
};

const SubagentSection: React.FC<{
  title: string;
  subagents: SubagentSessionSummary[];
  agents: RootState['agent']['agents'];
  onSelectSubagent: (subagent: SubagentSessionSummary) => void;
}> = ({ title, subagents, agents, onSelectSubagent }) => {
  if (subagents.length === 0) return null;

  return (
    <section>
      <div className="sticky top-0 z-10 flex h-9 items-center border-b border-border bg-background px-4">
        <h3 className="text-xs font-medium text-secondary">
          {title}
        </h3>
      </div>
      <div className="divide-y divide-border">
        {subagents.map(subagent => (
          <SubagentPanelRow
            key={subagent.id}
            subagent={subagent}
            agents={agents}
            onSelectSubagent={onSelectSubagent}
          />
        ))}
      </div>
    </section>
  );
};

const SubagentPanelContent: React.FC<SubagentPanelContentProps> = ({
  subagents,
  loading = false,
  selectedSubagent,
  onBackToList,
  onSelectSubagent,
}) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const grouped = useMemo(() => ({
    running: subagents.filter(subagent => subagent.status === SubagentSessionStatus.Running),
    done: subagents.filter(subagent => subagent.status === SubagentSessionStatus.Done),
    error: subagents.filter(subagent => subagent.status === SubagentSessionStatus.Error),
  }), [subagents]);

  if (selectedSubagent) {
    return (
      <SubagentDetailContent
        subagent={selectedSubagent}
        agents={agents}
        onBack={onBackToList ?? (() => undefined)}
      />
    );
  }

  if (loading && subagents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-secondary">
        {i18nService.t('loading')}
      </div>
    );
  }

  if (subagents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-secondary">
        {i18nService.t('subagentPanelEmpty')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4">
        <h2 className="text-sm font-medium text-foreground">
          {i18nService.t('subagentPanelTitle')}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SubagentSection
          title={i18nService.t('subagentPanelRunning')}
          subagents={grouped.running}
          agents={agents}
          onSelectSubagent={onSelectSubagent}
        />
        <SubagentSection
          title={i18nService.t('subagentPanelCompleted')}
          subagents={grouped.done}
          agents={agents}
          onSelectSubagent={onSelectSubagent}
        />
        <SubagentSection
          title={i18nService.t('subagentPanelFailed')}
          subagents={grouped.error}
          agents={agents}
          onSelectSubagent={onSelectSubagent}
        />
      </div>
    </div>
  );
};

export default SubagentPanelContent;
