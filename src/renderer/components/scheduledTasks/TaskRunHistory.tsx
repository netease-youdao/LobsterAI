import {
  CheckCircleIcon,
  ChevronRightIcon,
  MinusCircleIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { TaskStatus } from '../../../scheduledTask/constants';
import type { RunFilter, ScheduledTask, ScheduledTaskRun } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { getFilterAnalyticsParams, getRunAnalyticsParams, getTaskAnalyticsParams, reportScheduledTaskAction } from './analytics';
import DateInput from './DateInput';
import RunSessionModal from './RunSessionModal';
import { formatDateTime, formatDuration } from './utils';

interface TaskRunHistoryProps {
  task: ScheduledTask;
  runs: ScheduledTaskRun[];
}

const STATUS_OPTIONS = [
  TaskStatus.Success,
  TaskStatus.Error,
  TaskStatus.Skipped,
  TaskStatus.Running,
] as const;

const statusLabelKeys: Record<TaskStatus, string> = {
  [TaskStatus.Success]: 'scheduledTasksStatusSuccess',
  [TaskStatus.Error]: 'scheduledTasksStatusError',
  [TaskStatus.Skipped]: 'scheduledTasksStatusSkipped',
  [TaskStatus.Running]: 'scheduledTasksStatusRunning',
};

const statusPillColors: Record<TaskStatus, string> = {
  [TaskStatus.Success]: 'bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400',
  [TaskStatus.Error]: 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400',
  [TaskStatus.Skipped]: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-400',
  [TaskStatus.Running]: 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400',
};

const RunStatusIcon: React.FC<{ status: TaskStatus }> = ({ status }) => {
  if (status === TaskStatus.Running) {
    return (
      <svg className="h-4 w-4 shrink-0 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
      </svg>
    );
  }
  if (status === TaskStatus.Success) {
    return <CheckCircleIcon className="h-4 w-4 shrink-0 text-green-500" />;
  }
  if (status === TaskStatus.Error) {
    return <XCircleIcon className="h-4 w-4 shrink-0 text-red-500" />;
  }
  return <MinusCircleIcon className="h-4 w-4 shrink-0 text-yellow-500" />;
};

function applyClientFilter(runs: ScheduledTaskRun[], filter: RunFilter): ScheduledTaskRun[] {
  return runs.filter(run => {
    if (filter.status && run.status !== filter.status) return false;
    if (filter.startDate && run.startedAt < filter.startDate + 'T00:00:00') return false;
    if (filter.endDate && run.startedAt > filter.endDate + 'T23:59:59') return false;
    return true;
  });
}

const EMPTY_FILTER: RunFilter = {};

const TaskRunHistory: React.FC<TaskRunHistoryProps> = ({ task, runs }) => {
  const taskId = task.id;
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const hasMore = useSelector(
    (state: RootState) => state.scheduledTask.runsHasMore[taskId] ?? false,
  );
  const [viewingRun, setViewingRun] = useState<ScheduledTaskRun | null>(null);
  const [filter, setFilter] = useState<RunFilter>(EMPTY_FILTER);

  const hasActiveFilter = Boolean(filter.startDate || filter.endDate || filter.status);

  const displayedRuns = useMemo(
    () => (hasActiveFilter ? applyClientFilter(runs, filter) : runs),
    [runs, filter, hasActiveFilter],
  );
  const taskAnalyticsParams = useMemo(
    () => getTaskAnalyticsParams(task, availableModels),
    [availableModels, task],
  );

  const loadInitial = useCallback(
    (f: RunFilter) => {
      scheduledTaskService.loadRuns(taskId, 20, 0, f);
    },
    [taskId],
  );

  useEffect(() => {
    loadInitial(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilterChange = (newFilter: RunFilter) => {
    setFilter(newFilter);
    loadInitial(newFilter);
  };

  const handleClearFilter = () => {
    reportScheduledTaskAction('task_history_filter_clear', {
      source: 'scheduled_task_history',
      resultCount: displayedRuns.length,
      ...taskAnalyticsParams,
      ...getFilterAnalyticsParams(filter),
    });
    handleFilterChange(EMPTY_FILTER);
  };

  const handleStatusToggle = (status: TaskStatus) => {
    const nextFilter = {
      ...filter,
      status: filter.status === status ? undefined : status,
    };
    reportScheduledTaskAction('task_history_filter_status', {
      source: 'scheduled_task_history',
      targetStatus: status,
      selected: nextFilter.status === status,
      resultCount: displayedRuns.length,
      ...taskAnalyticsParams,
      ...getFilterAnalyticsParams(nextFilter),
    });
    handleFilterChange(nextFilter);
  };

  const handleLoadMore = async () => {
    reportScheduledTaskAction('task_history_load_more', {
      source: 'scheduled_task_history',
      loadedCount: runs.length,
      ...taskAnalyticsParams,
      ...getFilterAnalyticsParams(filter),
    });
    await scheduledTaskService.loadRuns(taskId, 50, runs.length, filter);
  };

  const handleDateFilterChange = (newFilter: RunFilter) => {
    reportScheduledTaskAction('task_history_filter_date', {
      source: 'scheduled_task_history',
      resultCount: displayedRuns.length,
      ...taskAnalyticsParams,
      ...getFilterAnalyticsParams(newFilter),
    });
    handleFilterChange(newFilter);
  };

  return (
    <div>
      {/* Filter: status pills + date range, compact inline */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-3">
        {/* Status pills */}
        <div className="flex items-center gap-1">
          {STATUS_OPTIONS.map(s => {
            const isActive = filter.status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => handleStatusToggle(s)}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  isActive
                    ? statusPillColors[s]
                    : 'border-transparent text-secondary hover:bg-surface-raised'
                }`}
              >
                {i18nService.t(statusLabelKeys[s])}
              </button>
            );
          })}
        </div>

        {/* Date range + clear */}
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
              className="ml-0.5 p-0.5 rounded text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
              title={i18nService.t('scheduledTasksFilterClear')}
            >
              <XMarkIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {displayedRuns.length === 0 ? (
        <div className="text-center py-6 text-sm text-secondary">
          {hasActiveFilter
            ? i18nService.t('scheduledTasksFilterNoResults')
            : i18nService.t('scheduledTasksNoRuns')}
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {displayedRuns.map(run => {
            const canView = Boolean(run.sessionId || run.sessionKey || run.summary || run.error);
            return (
              <button
                key={run.id}
                type="button"
                disabled={!canView}
                onClick={() => {
                  reportScheduledTaskAction('task_history_view_session', {
                    source: 'scheduled_task_history',
                    ...taskAnalyticsParams,
                    ...getRunAnalyticsParams(run),
                  });
                  setViewingRun(run);
                }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-surface-raised/60 disabled:cursor-default"
              >
                <RunStatusIcon status={run.status} />
                <span className="shrink-0 text-sm text-foreground">
                  {formatDateTime(new Date(run.startedAt))}
                </span>
                {run.status === 'error' && run.error && (
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-red-500"
                    title={run.error}
                  >
                    {run.error}
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-2.5">
                  {run.durationMs !== null && (
                    <span className="text-xs tabular-nums text-secondary">
                      {formatDuration(run.durationMs)}
                    </span>
                  )}
                  {canView && <ChevronRightIcon className="h-3.5 w-3.5 text-secondary/50" />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {hasMore && (
        <button
          type="button"
          onClick={handleLoadMore}
          className="w-full py-2 mt-2 text-sm text-primary hover:text-primary-hover transition-colors"
        >
          {i18nService.t('scheduledTasksLoadMore')}
        </button>
      )}

      {viewingRun && (
        <RunSessionModal
          taskName={task.name}
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

export default TaskRunHistory;
