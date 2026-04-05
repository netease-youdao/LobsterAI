import { CalendarIcon, ClockIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import type { ScheduledTaskRunWithName } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import RunSessionModal from './RunSessionModal';
import {
  formatDateGroup,
  formatDuration,
  getAgentInfo,
  getStatusLabelKey,
} from './utils';

const PAGE_SIZE = 50;

/* ------------------------------------------------------------------ */
/*  DateRangePicker                                                   */
/* ------------------------------------------------------------------ */

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onStartDateChange: (v: string) => void;
  onEndDateChange: (v: string) => void;
  onClear: () => void;
}

const DateRangePicker: React.FC<DateRangePickerProps> = ({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onClear,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const hasRange = startDate || endDate;
  const displayLabel = hasRange
    ? `${startDate || '...'} - ${endDate || '...'}`
    : i18nService.t('scheduledTasksHistoryTimeRange');

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl border transition-colors shrink-0 ${
          hasRange
            ? 'border-primary text-primary bg-primary-muted'
            : 'border-border text-secondary bg-surface hover:border-primary'
        }`}
      >
        <CalendarIcon className="w-4 h-4" />
        <span className="truncate max-w-[200px]">{displayLabel}</span>
        {hasRange && (
          <XMarkIcon
            className="w-3.5 h-3.5 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 rounded-xl shadow-popover bg-surface border border-border p-3 flex items-center gap-2">
          <input
            type="date"
            value={startDate}
            onChange={(e) => onStartDateChange(e.target.value)}
            className="px-2 py-1.5 text-sm rounded-lg border border-border bg-background text-foreground focus:outline-none focus:border-primary"
          />
          <span className="text-secondary text-sm">-</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => onEndDateChange(e.target.value)}
            className="px-2 py-1.5 text-sm rounded-lg border border-border bg-background text-foreground focus:outline-none focus:border-primary"
          />
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  HistoryRunRow                                                     */
/* ------------------------------------------------------------------ */

interface HistoryRunRowProps {
  run: ScheduledTaskRunWithName;
  onViewSession: (run: ScheduledTaskRunWithName) => void;
}

const HistoryRunRow: React.FC<HistoryRunRowProps> = ({ run, onViewSession }) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const isError = run.status === 'error';
  const hasSession = run.sessionId || run.sessionKey;
  const statusLabel = i18nService.t(getStatusLabelKey(run.status));
  const agentInfo = getAgentInfo(run.agentId, agents);

  const startedDate = new Date(run.startedAt);
  const timeStr = `${startedDate.getHours().toString().padStart(2, '0')}:${startedDate.getMinutes().toString().padStart(2, '0')}:${startedDate.getSeconds().toString().padStart(2, '0')}`;

  return (
    <div
      className={`rounded-xl border border-border bg-surface p-3 transition-colors ${
        hasSession ? 'hover:border-primary cursor-pointer' : ''
      }`}
      onClick={() => onViewSession(run)}
    >
      {/* Row 1: clock + task name | time + status */}
      <div className="flex items-start gap-3">
        <ClockIcon className="w-5 h-5 text-secondary shrink-0 mt-2" />
        <span className="text-sm font-medium text-foreground truncate flex-1 min-w-0">
          {run.taskName}
        </span>
        <div className="shrink-0 flex items-center gap-2 text-xs text-secondary whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span>{i18nService.t('scheduledTasksLastRunTime')} {timeStr}</span>
          <span className={`font-medium ${
            isError
              ? 'text-destructive'
              : run.status === 'success'
                ? 'text-success'
                : run.status === 'running'
                  ? 'text-primary'
                  : 'text-warning'
          }`}>
            {statusLabel}
            {run.status === 'running' && (
              <svg className="w-3 h-3 animate-spin text-primary inline-block ml-0.5" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
              </svg>
            )}
          </span>
        </div>
      </div>

      {/* Row 2: agent message (left) | agent + duration (right) */}
      <div className="flex items-center gap-3 mt-1 pl-8">
        <p className="text-xs text-secondary truncate flex-1 min-w-0" title={run.agentMessage || ''}>
          {run.agentMessage || '\u00A0'}
        </p>
        <div className="shrink-0 flex items-center gap-1 text-xs text-secondary whitespace-nowrap">
          <span className="shrink-0">{agentInfo.icon}</span>
          <span>{agentInfo.name}</span>
          {run.durationMs !== null && (
            <>
              <span className="mx-0.5">·</span>
              <span>{formatDuration(run.durationMs)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  AllRunsHistory                                                    */
/* ------------------------------------------------------------------ */

const AllRunsHistory: React.FC = () => {
  const allRuns = useSelector((state: RootState) => state.scheduledTask.allRuns);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const [viewingRun, setViewingRun] = useState<ScheduledTaskRunWithName | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Avoid lint warning for unused 'agents' — it's used in HistoryRunRow via selector
  void agents;

  // Initial load
  useEffect(() => {
    scheduledTaskService.loadAllRuns(PAGE_SIZE);
  }, []);

  // Track whether there's more data
  useEffect(() => {
    setHasMore(allRuns.length > 0 && allRuns.length % PAGE_SIZE === 0);
  }, [allRuns.length]);

  // Load more callback
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await scheduledTaskService.loadAllRuns(PAGE_SIZE, allRuns.length);
    setLoadingMore(false);
  }, [loadingMore, hasMore, allRuns.length]);

  // Infinite scroll with IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore();
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  // Filter runs
  const filteredRuns = useMemo(() => {
    let runs = allRuns;

    // Name filter
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      runs = runs.filter((r) => r.taskName.toLowerCase().includes(q));
    }

    // Date range filter
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      runs = runs.filter((r) => new Date(r.startedAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      runs = runs.filter((r) => new Date(r.startedAt) <= end);
    }

    return runs;
  }, [allRuns, searchQuery, startDate, endDate]);

  // Group by date
  const groupedRuns = useMemo(() => {
    const groups = new Map<string, ScheduledTaskRunWithName[]>();
    for (const run of filteredRuns) {
      const date = new Date(run.startedAt);
      const key = formatDateGroup(date);
      const group = groups.get(key);
      if (group) {
        group.push(run);
      } else {
        groups.set(key, [run]);
      }
    }
    return groups;
  }, [filteredRuns]);

  const handleViewSession = (run: ScheduledTaskRunWithName) => {
    if (run.sessionId || run.sessionKey) {
      setViewingRun(run);
    }
  };

  const handleClearDateRange = () => {
    setStartDate('');
    setEndDate('');
  };

  return (
    <div className="flex flex-col gap-3" ref={scrollContainerRef}>
      {/* Search bar + Date range picker */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-secondary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={i18nService.t('scheduledTasksHistorySearchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface border border-border text-foreground placeholder:text-secondary focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onClear={handleClearDateRange}
        />
      </div>

      {/* Empty state */}
      {allRuns.length === 0 && !loadingMore && (
        <div className="flex flex-col items-center justify-center py-16 px-6">
          <ClockIcon className="h-12 w-12 text-secondary/40 mb-4" />
          <p className="text-sm font-medium text-secondary">
            {i18nService.t('scheduledTasksHistoryEmpty')}
          </p>
        </div>
      )}

      {/* No filter results */}
      {allRuns.length > 0 && filteredRuns.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-secondary">
            {i18nService.t('scheduledTasksHistoryNoResults')}
          </p>
        </div>
      )}

      {/* Grouped run records */}
      {Array.from(groupedRuns.entries()).map(([dateLabel, runs]) => (
        <div key={dateLabel}>
          <h3 className="text-sm font-semibold text-foreground mb-2">{dateLabel}</h3>
          <div className="flex flex-col gap-2">
            {runs.map((run) => (
              <HistoryRunRow key={run.id} run={run} onViewSession={handleViewSession} />
            ))}
          </div>
        </div>
      ))}

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} className="h-1" />

      {/* Loading spinner */}
      {loadingMore && (
        <div className="flex items-center justify-center py-4">
          <svg className="animate-spin h-5 w-5 text-primary" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
            <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
          </svg>
          <span className="ml-2 text-sm text-secondary">{i18nService.t('scheduledTasksLoadingMore')}</span>
        </div>
      )}

      {/* No more data indicator */}
      {!hasMore && allRuns.length > 0 && filteredRuns.length > 0 && (
        <div className="text-center py-3 text-xs text-secondary">
          {i18nService.t('scheduledTasksNoMoreData')}
        </div>
      )}

      {/* Session modal */}
      {viewingRun && (
        <RunSessionModal
          sessionId={viewingRun.sessionId}
          sessionKey={viewingRun.sessionKey}
          onClose={() => setViewingRun(null)}
        />
      )}
    </div>
  );
};

export default AllRunsHistory;