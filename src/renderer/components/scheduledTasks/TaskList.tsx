import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ClockIcon, EllipsisVerticalIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { selectTask, setViewMode } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTask } from '../../../scheduledTask/types';
import { formatScheduleLabel, getStatusLabelKey, getStatusTone } from './utils';

interface TaskListItemProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string) => void;
}

const TaskListItem: React.FC<TaskListItemProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const statusLabel = i18nService.t(getStatusLabelKey(task.state.lastStatus));
  const statusTone = getStatusTone(task.state.lastStatus);

  return (
    <div
      className="grid grid-cols-[1.2fr_1fr_110px_40px] items-center gap-3 px-4 py-3 border-b border-border-subtle hover:bg-surface-raised/50 cursor-pointer transition-colors"
      onClick={() => dispatch(selectTask(task.id))}
    >
      <div className="min-w-0">
        <div className={`text-sm truncate ${task.enabled ? 'text-foreground' : 'text-secondary'}`}>
          {task.name}
        </div>
        {task.description && (
          <div className="text-xs truncate text-secondary">
            {task.description}
          </div>
        )}
      </div>

      <div className="text-sm text-secondary truncate">
        {formatScheduleLabel(task.schedule)}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-medium ${statusTone}`}>{statusLabel}</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void scheduledTaskService.toggleTask(task.id, !task.enabled);
          }}
          className={`relative shrink-0 w-7 h-4 rounded-full transition-colors ${
            task.enabled ? 'bg-primary' : 'bg-border'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform shadow-sm ${
              task.enabled ? 'translate-x-3' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <div className="flex justify-center">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setShowMenu((value) => !value);
            }}
            className="p-1.5 rounded-md text-secondary hover:bg-surface-raised transition-colors"
          >
            <EllipsisVerticalIcon className="w-5 h-5" />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-full mt-1 w-32 rounded-lg shadow-lg bg-surface border border-border z-50 py-1">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMenu(false);
                  void scheduledTaskService.runManually(task.id);
                }}
                disabled={Boolean(task.state.runningAtMs)}
                className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-surface-raised disabled:opacity-50"
              >
                {i18nService.t('scheduledTasksRun')}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMenu(false);
                  dispatch(selectTask(task.id));
                  dispatch(setViewMode('edit'));
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-surface-raised"
              >
                {i18nService.t('scheduledTasksEdit')}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMenu(false);
                  onRequestDelete(task.id, task.name);
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-surface-raised"
              >
                {i18nService.t('scheduledTasksDelete')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface TaskListProps {
  onRequestDelete: (taskId: string, taskName: string) => void;
}

const TaskList: React.FC<TaskListProps> = ({ onRequestDelete }) => {
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const loading = useSelector((state: RootState) => state.scheduledTask.loading);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-secondary">
          {i18nService.t('loading')}
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6">
        <ClockIcon className="h-12 w-12 text-secondary/40 mb-4" />
        <p className="text-sm font-medium text-secondary mb-1">
          {i18nService.t('scheduledTasksEmptyState')}
        </p>
        <p className="text-xs text-secondary/70 text-center">
          {i18nService.t('scheduledTasksEmptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-[1.2fr_1fr_110px_40px] items-center gap-3 px-4 py-2 border-b border-border-subtle">
        <div className="text-xs font-medium text-secondary">
          {i18nService.t('scheduledTasksListColTitle')}
        </div>
        <div className="text-xs font-medium text-secondary">
          {i18nService.t('scheduledTasksListColSchedule')}
        </div>
        <div className="text-xs font-medium text-secondary">
          {i18nService.t('scheduledTasksListColStatus')}
        </div>
        <div className="text-xs font-medium text-secondary text-center">
          {i18nService.t('scheduledTasksListColMore')}
        </div>
      </div>
      {tasks.map((task) => (
        <TaskListItem key={task.id} task={task} onRequestDelete={onRequestDelete} />
      ))}
    </div>
  );
};

export default TaskList;
