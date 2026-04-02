import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTaskRun } from '../../../scheduledTask/types';
import RunSessionModal from './RunSessionModal';
import { formatDateTime, formatDuration } from './utils';

interface TaskRunHistoryProps {
  taskId: string;
  runs: ScheduledTaskRun[];
}

const statusIcons: Record<string, { icon: string; color: string }> = {
  success: { icon: '✓', color: 'text-green-500' },
  error: { icon: '✗', color: 'text-red-500' },
  skipped: { icon: '↷', color: 'text-yellow-500' },
  running: { icon: '●', color: 'text-blue-500' },
};

const TaskRunHistory: React.FC<TaskRunHistoryProps> = ({ taskId, runs }) => {
  const hasMore = useSelector((state: RootState) => state.scheduledTask.runsHasMore[taskId] ?? false);
  const [viewingRun, setViewingRun] = useState<ScheduledTaskRun | null>(null);

  const handleLoadMore = async () => {
    await scheduledTaskService.loadRuns(taskId, 50, runs.length);
  };

  if (runs.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-secondary">
        {i18nService.t('scheduledTasksNoRuns')}
      </div>
    );
  }

  return (
    <div>
      <div className="divide-y divide-border/50">
        {runs.map((run) => {
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
                  <span className="text-xs text-secondary">
                    {formatDuration(run.durationMs)}
                  </span>
                )}
                {run.status === 'error' && run.error && (
                  <span
                    className="text-xs text-red-500 max-w-[150px] truncate"
                    title={run.error}
                  >
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
