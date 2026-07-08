import { ArrowLeftIcon } from '@heroicons/react/20/solid';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { CoworkMessage, SubagentSessionSummary } from '@/types/cowork';

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

const getSubagentDisplayName = (subagent: SubagentSessionSummary): string => (
  subagent.label?.trim()
    || subagent.agentId?.trim()
    || i18nService.t('subagentUnnamed')
);

const getSubagentInitial = (subagent: SubagentSessionSummary): string => {
  const displayName = getSubagentDisplayName(subagent).trim();
  return displayName.slice(0, 1).toUpperCase() || 'S';
};

const getSubagentStatusLabel = (status: SubagentSessionSummary['status']): string => {
  if (status === 'done') return i18nService.t('subagentCompleted');
  if (status === 'error') return i18nService.t('subagentError');
  return i18nService.t('subagentWorking');
};

const SubagentStatusDot: React.FC<{ status: SubagentSessionSummary['status'] }> = ({ status }) => (
  <span
    className={`h-2 w-2 shrink-0 rounded-full ${
      status === 'running'
        ? 'animate-pulse bg-blue-500'
        : status === 'error'
          ? 'bg-red-500'
          : 'bg-green-500'
    }`}
  />
);

const SubagentPanelRow: React.FC<{
  subagent: SubagentSessionSummary;
  onSelectSubagent: (subagent: SubagentSessionSummary) => void;
}> = ({ subagent, onSelectSubagent }) => {
  const displayName = getSubagentDisplayName(subagent);
  const duration = formatDuration(
    subagent.createdAt,
    subagent.status === 'running' ? null : subagent.endedAt,
  );

  return (
    <button
      type="button"
      onClick={() => onSelectSubagent(subagent)}
      className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {getSubagentInitial(subagent)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
          <SubagentStatusDot status={subagent.status} />
        </span>
        {subagent.task?.trim() && (
          <span className="mt-0.5 block truncate text-xs text-secondary">
            {subagent.task}
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted">
        {subagent.status === 'running' ? i18nService.t('subagentWorking') : duration}
      </span>
    </button>
  );
};

const SubagentDetailContent: React.FC<{
  subagent: SubagentSessionSummary;
  onBack: () => void;
}> = ({ subagent, onBack }) => {
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
    if (status !== 'running') return undefined;
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

  const displayName = getSubagentDisplayName(subagent);

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
          {getSubagentInitial(subagent)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
          {subagent.task?.trim() && (
            <div className="truncate text-xs text-secondary">{subagent.task}</div>
          )}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface px-2 py-1 text-xs text-secondary">
          <SubagentStatusDot status={status} />
          <span>{getSubagentStatusLabel(status)}</span>
        </span>
      </div>
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-secondary">
            {i18nService.t('loading')}
          </div>
        ) : (
          <ConversationTurnsView
            messages={effectiveMessages}
            isStreaming={status === 'running'}
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
  onSelectSubagent: (subagent: SubagentSessionSummary) => void;
}> = ({ title, subagents, onSelectSubagent }) => {
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
  const grouped = useMemo(() => ({
    running: subagents.filter(subagent => subagent.status === 'running'),
    done: subagents.filter(subagent => subagent.status === 'done'),
    error: subagents.filter(subagent => subagent.status === 'error'),
  }), [subagents]);

  if (selectedSubagent) {
    return (
      <SubagentDetailContent
        subagent={selectedSubagent}
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
          onSelectSubagent={onSelectSubagent}
        />
        <SubagentSection
          title={i18nService.t('subagentPanelCompleted')}
          subagents={grouped.done}
          onSelectSubagent={onSelectSubagent}
        />
        <SubagentSection
          title={i18nService.t('subagentPanelFailed')}
          subagents={grouped.error}
          onSelectSubagent={onSelectSubagent}
        />
      </div>
    </div>
  );
};

export default SubagentPanelContent;
