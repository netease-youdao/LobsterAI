import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ClockIcon, EllipsisVerticalIcon, PlayIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { selectTask, setViewMode, updateTaskState } from '../../store/slices/scheduledTaskSlice';
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
  const [isRunning, setIsRunning] = React.useState(false);
  const [menuPosition, setMenuPosition] = React.useState<{ top: number; left: number; showAbove?: boolean } | null>(null);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
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
      className="grid grid-cols-[1.2fr_1fr_110px_40px] items-center gap-3 px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer transition-colors"
      onClick={() => dispatch(selectTask(task.id))}
    >
      <div className="min-w-0">
        <div className={`text-sm truncate ${task.enabled ? 'dark:text-claude-darkText text-claude-text' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'}`}>
          {task.name}
        </div>
        {task.description && (
          <div className="text-xs truncate dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {task.description}
          </div>
        )}
      </div>

      <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
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
            task.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkSurfaceHover bg-claude-border'
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
            ref={menuButtonRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (!showMenu && menuButtonRef.current) {
                const rect = menuButtonRef.current.getBoundingClientRect();
                const viewportHeight = window.innerHeight;
                const menuEstimatedHeight = 140; // 3 items * ~46px each
                
                // Check if menu would overflow bottom
                const spaceBelow = viewportHeight - rect.bottom;
                const shouldShowAbove = spaceBelow < menuEstimatedHeight + 8;
                
                setMenuPosition({
                  top: shouldShowAbove ? rect.top - 4 : rect.bottom + 4,
                  left: rect.right,
                  showAbove: shouldShowAbove,
                });
              }
              setShowMenu((value) => !value);
            }}
            className="p-1.5 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <EllipsisVerticalIcon className="w-5 h-5" />
          </button>
          {showMenu && menuPosition && (
            <div 
              className="fixed z-50 w-max rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
              style={{ 
                top: `${menuPosition.top}px`, 
                left: `${menuPosition.left}px`,
                transform: menuPosition.showAbove ? 'translate(-100%, -100%)' : 'translateX(-100%)'
              }}
            >
              <button
                type="button"
                onClick={async (event) => {
                  event.stopPropagation();
                  setShowMenu(false);
                  setIsRunning(true);
                  
                  // Optimistic update: immediately mark as running in UI
                  dispatch(updateTaskState({
                    taskId: task.id,
                    taskState: {
                      ...task.state,
                      runningAtMs: Date.now(),
                      lastStatus: 'running',
                    },
                  }));
                  
                  try {
                    await scheduledTaskService.runManually(task.id);
                    setIsRunning(false);
                    window.dispatchEvent(
                      new CustomEvent('app:showToast', {
                        detail: { message: i18nService.t('scheduledTasksTriggered'), variant: 'success' },
                      })
                    );
                    // Real state will be synced by pollOnce() after 800ms
                  } catch (error) {
                    // Rollback optimistic update on failure
                    dispatch(updateTaskState({
                      taskId: task.id,
                      taskState: {
                        ...task.state,
                        runningAtMs: null,
                      },
                    }));
                    setIsRunning(false);
                    window.dispatchEvent(
                      new CustomEvent('app:showToast', {
                        detail: { message: i18nService.t('scheduledTasksRunFailed'), variant: 'info' },
                      })
                    );
                  }
                }}
                disabled={Boolean(task.state.runningAtMs) || isRunning}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50 transition-colors"
              >
                <PlayIcon className="h-4 w-4 shrink-0" />
                <span>{isRunning ? (i18nService.t('scheduledTasksRunning') || '执行中...') : i18nService.t('scheduledTasksRun')}</span>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMenu(false);
                  dispatch(selectTask(task.id));
                  dispatch(setViewMode('edit'));
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <PencilSquareIcon className="h-4 w-4 shrink-0" />
                <span>{i18nService.t('scheduledTasksEdit')}</span>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMenu(false);
                  onRequestDelete(task.id, task.name);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <TrashIcon className="h-4 w-4 shrink-0" />
                <span>{i18nService.t('scheduledTasksDelete')}</span>
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
        <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('loading')}
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6">
        <ClockIcon className="h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4" />
        <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('scheduledTasksEmptyState')}
        </p>
        <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
          {i18nService.t('scheduledTasksEmptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-[1.2fr_1fr_110px_40px] items-center gap-3 px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksListColTitle')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksListColSchedule')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksListColStatus')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary text-center">
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
