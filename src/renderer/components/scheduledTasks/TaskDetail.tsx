import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { setViewMode } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTask, Schedule } from '../../types/scheduledTask';
import TaskRunHistory from './TaskRunHistory';
import { PlayIcon } from '@heroicons/react/24/outline';
import PencilIcon from '../icons/PencilIcon';
import TrashIcon from '../icons/TrashIcon';

function formatScheduleLabel(schedule: Schedule): string {
  switch (schedule.type) {
    case 'at':
      return `${i18nService.t('scheduledTasksScheduleAtLabel')}: ${schedule.datetime ? new Date(schedule.datetime).toLocaleString() : '-'}`;
    case 'interval': {
      const unitKey = schedule.unit === 'minutes' ? 'scheduledTasksFormIntervalMinutes' :
        schedule.unit === 'hours' ? 'scheduledTasksFormIntervalHours' : 'scheduledTasksFormIntervalDays';
      return `${i18nService.t('scheduledTasksScheduleEvery')} ${schedule.value ?? 0} ${i18nService.t(unitKey)}`;
    }
    case 'cron':
      return `${i18nService.t('scheduledTasksScheduleCronLabel')}: ${schedule.expression ?? ''}`;
    default:
      return '';
  }
}

interface TaskDetailProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string) => void;
}

const TaskDetail: React.FC<TaskDetailProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const runs = useSelector((state: RootState) => state.scheduledTask.runs[task.id] ?? []);

  useEffect(() => {
    scheduledTaskService.loadRuns(task.id);
  }, [task.id]);

  const handleEdit = () => {
    dispatch(setViewMode('edit'));
  };

  const handleRunNow = async () => {
    await scheduledTaskService.runManually(task.id);
  };

  const handleDelete = () => {
    onRequestDelete(task.id, task.name);
  };

  const statusLabel = task.state.lastStatus
    ? i18nService.t(`scheduledTasksStatus${task.state.lastStatus.charAt(0).toUpperCase() + task.state.lastStatus.slice(1)}`)
    : '-';

  const statusColor = {
    success: 'text-green-500',
    error: 'text-red-500',
    running: 'text-blue-500',
  };

  const sectionClass = 'rounded-lg border dark:border-claude-darkBorder border-claude-border p-4';
  const sectionTitleClass = 'text-sm font-semibold dark:text-claude-darkText text-claude-text mb-3';
  const labelClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const valueClass = 'text-sm dark:text-claude-darkText text-claude-text';

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {task.name}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleEdit}
            className="p-2 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title={i18nService.t('scheduledTasksEdit')}
          >
            <PencilIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleRunNow}
            disabled={!!task.state.runningAtMs}
            className="p-2 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
            title={i18nService.t('scheduledTasksRun')}
          >
            <PlayIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            title={i18nService.t('scheduledTasksDelete')}
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Prompt */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksPrompt')}</h3>
        <div className="text-sm dark:text-claude-darkText text-claude-text whitespace-pre-wrap bg-claude-surfaceHover/30 dark:bg-claude-darkSurfaceHover/30 rounded-md p-3">
          {task.prompt}
        </div>
      </div>

      {/* Configuration */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksConfiguration')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksSchedule')}</div>
            <div className={valueClass}>{formatScheduleLabel(task.schedule)}</div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksFormEnabled')}</div>
            <div className={valueClass}>
              <span className={`inline-flex items-center gap-1 ${task.enabled ? 'text-green-500' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'}`}>
                {task.enabled ? '✓ ' + i18nService.t('enabled') : i18nService.t('disabled')}
              </span>
            </div>
          </div>
          {task.workingDirectory && (
            <div className="col-span-2">
              <div className={labelClass}>{i18nService.t('scheduledTasksWorkingDirectory')}</div>
              <div className={valueClass + ' font-mono text-xs'}>{task.workingDirectory}</div>
            </div>
          )}
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksExecutionMode')}</div>
            <div className={valueClass}>{task.executionMode}</div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksDetailExpiresAt')}</div>
            <div className={valueClass}>
              {task.expiresAt
                ? new Date(task.expiresAt + 'T00:00:00').toLocaleDateString()
                : i18nService.t('scheduledTasksFormExpiresAtNone')}
            </div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksDetailNotify')}</div>
            <div className={valueClass}>
              {task.notifyPlatforms && task.notifyPlatforms.length > 0
                ? task.notifyPlatforms.map((p) =>
                    i18nService.t(`scheduledTasksFormNotify${p.charAt(0).toUpperCase() + p.slice(1)}`)
                  ).join(', ')
                : i18nService.t('scheduledTasksFormNotifyNone')}
            </div>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksStatus')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksLastRun')}</div>
            <div className={valueClass}>
              {task.state.lastStatus && (
                <span className={statusColor[task.state.lastStatus] || ''}>
                  {statusLabel}
                </span>
              )}
              {!task.state.lastStatus && '-'}
              {task.state.lastRunAtMs && (
                <span className="ml-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  ({new Date(task.state.lastRunAtMs).toLocaleString()})
                </span>
              )}
            </div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksNextRun')}</div>
            <div className={valueClass}>
              {task.state.nextRunAtMs
                ? new Date(task.state.nextRunAtMs).toLocaleString()
                : '-'}
            </div>
          </div>
          {task.state.lastDurationMs !== null && (
            <div>
              <div className={labelClass}>{i18nService.t('scheduledTasksLastDuration')}</div>
              <div className={valueClass}>
                {task.state.lastDurationMs < 1000
                  ? `${task.state.lastDurationMs}ms`
                  : `${(task.state.lastDurationMs / 1000).toFixed(1)}s`}
              </div>
            </div>
          )}
          {(task.state.consecutiveErrors ?? 0) > 0 && (
            <div>
              <div className={labelClass}>{i18nService.t('scheduledTasksConsecutiveErrors')}</div>
              <div className="text-sm text-red-500">{task.state.consecutiveErrors}</div>
            </div>
          )}
        </div>
        {task.state.lastError && (
          <div className="mt-3 px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded">
            {task.state.lastError}
          </div>
        )}
      </div>

      {/* Run History */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksRunHistory')}</h3>
        <TaskRunHistory taskId={task.id} runs={runs} />
      </div>
    </div>
  );
};

export default TaskDetail;
