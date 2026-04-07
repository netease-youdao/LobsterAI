import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { PlayIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { setViewMode } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTask } from '../../../scheduledTask/types';
import TaskRunHistory from './TaskRunHistory';
import {
  formatDateTime,
  formatDeliveryLabel,
  formatDuration,
  formatScheduleLabel,
  getStatusLabelKey,
  getStatusTone,
} from './utils';
import PencilIcon from '../icons/PencilIcon';
import TrashIcon from '../icons/TrashIcon';

interface TaskDetailProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string) => void;
}

const TaskDetail: React.FC<TaskDetailProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const runs = useSelector((state: RootState) => state.scheduledTask.runs[task.id] ?? []);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  useEffect(() => {
    void scheduledTaskService.loadRuns(task.id);
  }, [task.id]);

  const statusLabel = i18nService.t(getStatusLabelKey(task.state.lastStatus));
  const statusTone = getStatusTone(task.state.lastStatus);
  const promptText = task.payload.kind === 'systemEvent' ? task.payload.text : task.payload.message;
  const taskModelRef = task.payload.kind === 'agentTurn' ? task.payload.model : undefined;
  const taskModelLabel = taskModelRef
    ? (() => {
        const bareId = taskModelRef.includes('/') ? taskModelRef.slice(taskModelRef.indexOf('/') + 1) : taskModelRef;
        return availableModels.find((m) => m.id === bareId)?.name ?? bareId;
      })()
    : undefined;

  const sectionClass = 'rounded-lg border border-border p-4';
  const sectionTitleClass = 'text-sm font-semibold text-foreground mb-3';
  const labelClass = 'text-xs text-secondary';
  const valueClass = 'text-sm text-foreground';

  return (
    <div className="p-4 space-y-4 max-w-3xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">
            {task.name}
          </h2>
          {task.description && (
            <p className="mt-1 text-sm text-secondary whitespace-pre-wrap">
              {task.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => dispatch(setViewMode('edit'))}
            className="p-2 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            title={i18nService.t('scheduledTasksEdit')}
          >
            <PencilIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => void scheduledTaskService.runManually(task.id)}
            disabled={Boolean(task.state.runningAtMs)}
            className="p-2 rounded-lg text-secondary hover:bg-surface-raised transition-colors disabled:opacity-50"
            title={i18nService.t('scheduledTasksRun')}
          >
            <PlayIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onRequestDelete(task.id, task.name)}
            className="p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            title={i18nService.t('scheduledTasksDelete')}
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksPrompt')}</h3>
        <div className="text-sm text-foreground whitespace-pre-wrap bg-surface-raised/30 rounded-md p-3">
          {promptText}
        </div>
      </div>

      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksConfiguration')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksSchedule')}</div>
            <div className={valueClass}>{formatScheduleLabel(task.schedule)}</div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksDetailNotify')}</div>
            <div className={valueClass}>{formatDeliveryLabel(task.delivery)}</div>
          </div>
          {taskModelLabel && (
            <div>
              <div className={labelClass}>{i18nService.t('scheduledTasksDetailModel')}</div>
              <div className={valueClass}>{taskModelLabel}</div>
            </div>
          )}
          {task.sessionKey && (
            <div className="col-span-2">
              <div className={labelClass}>{i18nService.t('scheduledTasksSessionKey')}</div>
              <div className={`${valueClass} font-mono text-xs break-all`}>{task.sessionKey}</div>
            </div>
          )}
        </div>
      </div>

      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksStatus')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksLastRun')}</div>
            <div className={`${valueClass} ${statusTone}`}>
              {statusLabel}
              {task.state.lastRunAtMs && (
                <span className="ml-1 text-xs text-secondary">
                  ({formatDateTime(new Date(task.state.lastRunAtMs))})
                </span>
              )}
            </div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksNextRun')}</div>
            <div className={valueClass}>
              {task.state.nextRunAtMs
                ? formatDateTime(new Date(task.state.nextRunAtMs))
                : '-'}
            </div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksLastDuration')}</div>
            <div className={valueClass}>{formatDuration(task.state.lastDurationMs)}</div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksConsecutiveErrors')}</div>
            <div className={valueClass}>{task.state.consecutiveErrors}</div>
          </div>
        </div>
        {task.state.lastError && (
          <div className="mt-3 px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded">
            {task.state.lastError}
          </div>
        )}
      </div>

      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksRunHistory')}</h3>
        <TaskRunHistory taskId={task.id} runs={runs} />
      </div>
    </div>
  );
};

export default TaskDetail;
