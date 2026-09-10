import { ClockIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { ScheduledTaskDataStatus, TaskStatus } from '../../../scheduledTask/constants';
import { createRunFilter } from '../../../scheduledTask/runFilter';
import type { RunFilter, ScheduledTaskRunWithName } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { getFilterAnalyticsParams, getRunAnalyticsParams, reportScheduledTaskAction } from './analytics';
import DateInput from './DateInput';
import RunSessionModal from './RunSessionModal';
import ScheduledTaskDataState from './ScheduledTaskDataState';
import { formatDateTime, formatDuration } from './utils';

const STATUS_OPTIONS = [
  TaskStatus.Success,
  TaskStatus.Error,
  TaskStatus.Skipped,
  TaskStatus.Running,
] as const;

const historyGridClass = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_88px] items-center gap-3';

const statusConfig: Record<TaskStatus, { label: string; color: string; activeColor: string }> = {
  [TaskStatus.Success]: {
    label: 'scheduledTasksStatusSuccess',
    color: 'text-green-600 dark:text-green-400',
    activeColor: 'bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400',
  },
  [TaskStatus.Error]: {
    label: 'scheduledTasksStatusError',
    color: 'text-red-500',
    activeColor: 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400',
  },
  [TaskStatus.Skipped]: {
    label: 'scheduledTasksStatusSkipped',
    color: 'text-yellow-500',
    activeColor: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-400',
  },
  [TaskStatus.Running]: {
    label: 'scheduledTasksStatusRunning',
    color: 'text-blue-500',
    activeColor: 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400',
  },
};

const EMPTY_FILTER: RunFilter = {};

interface AllRunsHistoryProps {
  /** Search text owned by the page toolbar, shared with the tasks tab. */
  searchText?: string;
}

const AllRunsHistory: React.FC<AllRunsHistoryProps> = ({ searchText = '' }) => {
  const allRuns = useSelector((state: RootState) => state.scheduledTask.allRuns);
  const allRunsHasMore = useSelector((state: RootState) => state.scheduledTask.allRunsHasMore);
  const allRunsStatus = useSelector((state: RootState) => state.scheduledTask.allRunsStatus);
  const allRunsError = useSelector((state: RootState) => state.scheduledTask.allRunsError);
  const [viewingRun, setViewingRun] = useState<ScheduledTaskRunWithName | null>(null);
  const [filter, setFilter] = useState<RunFilter>(EMPTY_FILTER);

  const hasActiveFilter = Boolean(filter.startDate || filter.endDate || filter.status);
  const normalizedSearch = searchText.trim().toLowerCase();

  const displayedRuns = useMemo(() => {
    let runs = hasActiveFilter ? allRuns.filter(createRunFilter(filter)) : allRuns;
    if (normalizedSearch) {
      runs = runs.filter(run =>
        [run.taskName, run.summary ?? '', run.error ?? '']
          .join('\n')
          .toLowerCase()
          .includes(normalizedSearch),
      );
    }
    return runs;
  }, [allRuns, filter, hasActiveFilter, normalizedSearch]);

  const loadInitial = useCallback((f: RunFilter) => {
    scheduledTaskService.loadAllRuns(50, 0, f);
  }, []);

  useEffect(() => {
    loadInitial(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilterChange = (newFilter: RunFilter) => {
    setFilter(newFilter);
    loadInitial(newFilter);
  };

  const handleClearFilter = () => {
    reportScheduledTaskAction('history_filter_clear', {
      source: 'scheduled_tasks_history',
      resultCount: displayedRuns.length,
      ...getFilterAnalyticsParams(filter),
    });
    handleFilterChange(EMPTY_FILTER);
  };

  const handleStatusToggle = (status: TaskStatus) => {
    const nextFilter = {
      ...filter,
      status: filter.status === status ? undefined : status,
    };
    reportScheduledTaskAction('history_filter_status', {
      source: 'scheduled_tasks_history',
      targetStatus: status,
      selected: nextFilter.status === status,
      resultCount: displayedRuns.length,
      ...getFilterAnalyticsParams(nextFilter),
    });
    handleFilterChange(nextFilter);
  };

  const handleLoadMore = () => {
    reportScheduledTaskAction('history_load_more', {
      source: 'scheduled_tasks_history',
      loadedCount: allRuns.length,
      ...getFilterAnalyticsParams(filter),
    });
    scheduledTaskService.loadAllRuns(50, allRuns.length, filter);
  };

  const handleViewSession = (run: ScheduledTaskRunWithName) => {
    if (run.sessionId || run.sessionKey || run.summary || run.error) {
      reportScheduledTaskAction('history_view_session', {
        source: 'scheduled_tasks_history',
        ...getRunAnalyticsParams(run),
      });
      setViewingRun(run);
    }
  };

  const handleDateFilterChange = (newFilter: RunFilter) => {
    reportScheduledTaskAction('history_filter_date', {
      source: 'scheduled_tasks_history',
      resultCount: displayedRuns.length,
      ...getFilterAnalyticsParams(newFilter),
    });
    handleFilterChange(newFilter);
  };

  const isEmpty = displayedRuns.length === 0;

  if (allRunsStatus !== ScheduledTaskDataStatus.Ready) {
    return (
      <ScheduledTaskDataState
        status={allRunsStatus}
        error={allRunsError}
        onRetry={() => {
          reportScheduledTaskAction('retry_load_history', {
            source: 'scheduled_tasks_history',
            ...getFilterAnalyticsParams(filter),
          });
          loadInitial(filter);
        }}
      />
    );
  }

  return (
    <div>
      {/* Filter area */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Status pills */}
        <div className="flex items-center gap-1.5">
          {STATUS_OPTIONS.map(s => {
            const cfg = statusConfig[s];
            const isActive = filter.status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => handleStatusToggle(s)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  isActive
                    ? cfg.activeColor
                    : 'border-transparent text-secondary hover:bg-surface-raised'
                }`}
              >
                {i18nService.t(cfg.label)}
              </button>
            );
          })}
        </div>

        {/* Date range */}
        <div className="flex items-center gap-1.5 ml-auto">
          <DateInput
            value={filter.startDate ?? ''}
            max={filter.endDate}
            onChange={v => handleDateFilterChange({ ...filter, startDate: v || undefined })}
            placeholder={i18nService.t('scheduledTasksFilterStartDate')}
          />
          <span className="text-xs text-secondary/50">–</span>
          <DateInput
            value={filter.endDate ?? ''}
            min={filter.startDate}
            onChange={v => handleDateFilterChange({ ...filter, endDate: v || undefined })}
            placeholder={i18nService.t('scheduledTasksFilterEndDate')}
          />
          {hasActiveFilter && (
            <button
              type="button"
              onClick={handleClearFilter}
              className="ml-1 p-0.5 rounded text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
              title={i18nService.t('scheduledTasksFilterClear')}
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border-subtle bg-surface px-6 py-16">
          <ClockIcon className="h-12 w-12 text-secondary/40 mb-4" />
          <p className="text-sm font-medium text-secondary">
            {hasActiveFilter || normalizedSearch
              ? i18nService.t('scheduledTasksFilterNoResults')
              : i18nService.t('scheduledTasksHistoryEmpty')}
          </p>
        </div>
      )}

      {!isEmpty && (
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
          {/* Column headers */}
          <div className={`${historyGridClass} border-b border-border-subtle bg-surface-raised/40 px-5 py-2.5`}>
            <div className="text-xs font-medium text-secondary">
              {i18nService.t('scheduledTasksHistoryColTitle')}
            </div>
            <div className="text-xs font-medium text-secondary">
              {i18nService.t('scheduledTasksHistoryColTime')}
            </div>
            <div className="text-xs font-medium text-secondary">
              {i18nService.t('scheduledTasksHistoryColStatus')}
            </div>
          </div>

          {/* Run rows */}
          <div className="p-2">
            {displayedRuns.map(run => {
              const cfg = statusConfig[run.status];
              const canViewRun = run.sessionId || run.sessionKey || run.summary || run.error;
              return (
                <div
                  key={run.id}
                  className={`${historyGridClass} rounded-md px-3 py-3 transition-colors ${
                    canViewRun ? 'hover:bg-surface-raised/60 cursor-pointer' : ''
                  }`}
                  onClick={() => handleViewSession(run)}
                >
                  {/* Task title */}
                  <div className="text-sm text-foreground truncate">
                    {run.taskName}
                    {run.status === 'running' && (
                      <svg
                        className="inline-block w-3 h-3 ml-1.5 animate-spin text-blue-500"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                          className="opacity-25"
                        />
                        <path
                          d="M4 12a8 8 0 018-8"
                          stroke="currentColor"
                          strokeWidth="4"
                          strokeLinecap="round"
                          className="opacity-75"
                        />
                      </svg>
                    )}
                  </div>

                  {/* Run time + duration */}
                  <div className="text-sm text-secondary truncate">
                    {formatDateTime(new Date(run.startedAt))}
                    {run.durationMs !== null && (
                      <span className="ml-1.5 text-xs opacity-70">
                        ({formatDuration(run.durationMs)})
                      </span>
                    )}
                  </div>

                  {/* Status */}
                  <div className={`text-sm font-medium ${cfg.color}`}>
                    {i18nService.t(cfg.label)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Load more */}
          {allRunsHasMore && (
            <button
              type="button"
              onClick={handleLoadMore}
              className="w-full py-3 text-sm text-primary hover:text-primary-hover transition-colors"
            >
              {i18nService.t('scheduledTasksLoadMore')}
            </button>
          )}
        </div>
      )}

      {viewingRun && (
        <RunSessionModal
          taskName={viewingRun.taskName}
          runStartedAt={viewingRun.startedAt}
          sessionId={viewingRun.sessionId}
          sessionKey={viewingRun.sessionKey}
          runSummary={viewingRun.summary}
          runError={viewingRun.error}
          onClose={() => setViewingRun(null)}
        />
      )}
    </div>
  );
};

export default AllRunsHistory;
