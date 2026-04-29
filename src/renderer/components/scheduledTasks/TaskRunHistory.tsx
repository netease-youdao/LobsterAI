import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import type { RunFilter, ScheduledTaskRun } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import DateInput from './DateInput';
import RunSessionModal from './RunSessionModal';
import { formatDateTime, formatDuration } from './utils';

interface TaskRunHistoryProps {
  taskId: string;
  runs: ScheduledTaskRun[];
}

const STATUS_OPTIONS = ['success', 'error', 'skipped', 'running'] as const;

const statusLabelKeys: Record<string, string> = {
  success: 'scheduledTasksStatusSuccess',
  error: 'scheduledTasksStatusError',
  skipped: 'scheduledTasksStatusSkipped',
  running: 'scheduledTasksStatusRunning',
};

const statusPillColors: Record<string, string> = {
  success: 'bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400',
  error: 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400',
  skipped: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-400',
  running: 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400',
};

const statusIcons: Record<string, { icon: string; color: string }> = {
  success: { icon: '✓', color: 'text-green-500' },
  error: { icon: '✗', color: 'text-red-500' },
  skipped: { icon: '↷', color: 'text-yellow-500' },
  running: { icon: '●', color: 'text-blue-500' },
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

const TaskRunHistory: React.FC<TaskRunHistoryProps> = ({ taskId, runs }) => {
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
    handleFilterChange(EMPTY_FILTER);
  };

  const handleStatusToggle = (status: string) => {
    handleFilterChange({
      ...filter,
      status: filter.status === status ? undefined : status,
    });
  };

  const handleLoadMore = async () => {
    await scheduledTaskService.loadRuns(taskId, 50, runs.length, filter);
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
            onChange={v => handleFilterChange({ ...filter, startDate: v || undefined })}
            placeholder={i18nService.t('scheduledTasksFilterStartDate')}
          />
          <span className="text-xs text-secondary/50">–</span>
          <DateInput
            value={filter.endDate ?? ''}
            min={filter.startDate}
            onChange={v => handleFilterChange({ ...filter, endDate: v || undefined })}
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
            const statusInfo = statusIcons[run.status] || { icon: '?', color: '' };
            return (
              <div key={run.id} className="flex items-center justify-between py-2.5 px-1">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`text-sm font-bold ${statusInfo.color}`}>{statusInfo.icon}</span>
                  <div className="min-w-0">
                    <span className="text-sm text-foreground">
                      {formatDateTime(new Date(run.startedAt))}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-2">
                  {run.durationMs !== null && (
                    <span className="text-xs text-secondary">{formatDuration(run.durationMs)}</span>
                  )}
                  {run.status === 'error' && run.error && (
                    <span className="text-xs text-red-500 max-w-[150px] truncate" title={run.error}>
                      {run.error}
                    </span>
                  )}
                  {(run.sessionId || run.sessionKey) && (
                    <button
                      type="button"
                      onClick={() => setViewingRun(run)}
                      className="text-xs text-primary hover:text-primary-hover transition-colors"
                    >
                      {i18nService.t('scheduledTasksViewSession')}
                    </button>
                  )}
                </div>
              </div>
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
          sessionId={viewingRun.sessionId}
          sessionKey={viewingRun.sessionKey}
          onClose={() => setViewingRun(null)}
        />
      )}
    </div>
  );
};

export default TaskRunHistory;
