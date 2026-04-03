import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTaskRunWithName } from '../../../scheduledTask/types';
import { ClockIcon } from '@heroicons/react/24/outline';
import RunSessionModal from './RunSessionModal';
import { formatDateTime, formatDuration } from './utils';

const statusConfig: Record<string, { label: string; color: string }> = {
  success: { label: 'scheduledTasksStatusSuccess', color: 'text-green-500' },
  error: { label: 'scheduledTasksStatusError', color: 'text-red-500' },
  skipped: { label: 'scheduledTasksStatusSkipped', color: 'text-yellow-500' },
  running: { label: 'scheduledTasksStatusRunning', color: 'text-blue-500' },
};

const AllRunsHistory: React.FC = () => {
  const allRuns = useSelector((state: RootState) => state.scheduledTask.allRuns);
  const [viewingRun, setViewingRun] = useState<ScheduledTaskRunWithName | null>(null);

  useEffect(() => {
    scheduledTaskService.loadAllRuns(50);
  }, []);

  const handleLoadMore = () => {
    scheduledTaskService.loadAllRuns(50, allRuns.length);
  };

  const handleViewSession = (run: ScheduledTaskRunWithName) => {
    if (run.sessionId || run.sessionKey) {
      setViewingRun(run);
    }
  };

  if (allRuns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6">
        <ClockIcon className="h-12 w-12 text-secondary/40 mb-4" />
        <p className="text-sm font-medium text-secondary">
          {i18nService.t('scheduledTasksHistoryEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Column Headers */}
      <div className="grid grid-cols-[1fr_1fr_80px] items-center gap-3 px-4 py-2 border-b border-border-subtle">
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
      {allRuns.map((run) => {
        const cfg = statusConfig[run.status] || { label: '', color: '' };
        const hasSession = run.sessionId || run.sessionKey;
        return (
          <div
            key={run.id}
            className={`grid grid-cols-[1fr_1fr_80px] items-center gap-3 px-4 py-3 border-b border-border-subtle transition-colors ${
              hasSession
                ? 'hover:bg-surface-raised/50 cursor-pointer'
                : ''
            }`}
            onClick={() => handleViewSession(run)}
          >
            {/* Task title */}
            <div className="text-sm text-foreground truncate">
              {run.taskName}
              {run.status === 'running' && (
                <svg className="inline-block w-3 h-3 ml-1.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
                </svg>
              )}
            </div>

            {/* Run time + duration */}
            <div className="text-sm text-secondary truncate">
              {formatDateTime(new Date(run.startedAt))}
              {run.durationMs !== null && (
                <span className="ml-1.5 text-xs opacity-70">({formatDuration(run.durationMs)})</span>
              )}
            </div>

            {/* Status */}
            <div className={`text-sm font-medium ${cfg.color}`}>
              {i18nService.t(cfg.label)}
            </div>
          </div>
        );
      })}

      {/* Load more */}
      {allRuns.length >= 50 && allRuns.length % 50 === 0 && (
        <button
          type="button"
          onClick={handleLoadMore}
          className="w-full py-3 text-sm text-primary hover:text-primary-hover transition-colors"
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

export default AllRunsHistory;
