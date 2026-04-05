import {
  ClockIcon,
  EllipsisVerticalIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { ScheduledTask } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { selectTask, setViewMode, updateTaskState } from '../../store/slices/scheduledTaskSlice';
import {
  formatRelativeTime,
  formatScheduleLabel,
  getAgentInfo,
  getStatusLabelKey,
  getStatusTone,
} from './utils';

/* ------------------------------------------------------------------ */
/*  TaskCard                                                          */
/* ------------------------------------------------------------------ */

interface TaskCardProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string) => void;
}

const TaskCard: React.FC<TaskCardProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const agents = useSelector((state: RootState) => state.agent.agents);
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

  const statusLabel = i18nService.t(getStatusLabelKey(
    task.enabled ? task.state.lastStatus : null,
  ));
  const statusTone = task.enabled
    ? getStatusTone(task.state.lastStatus)
    : 'text-secondary';
  const displayStatus = task.enabled ? statusLabel : i18nService.t('scheduledTasksStatusDisabled');

  const agentMessage =
    task.payload.kind === 'agentTurn'
      ? task.payload.message
      : task.payload.kind === 'systemEvent'
        ? task.payload.text
        : '';

  const agentInfo = getAgentInfo(task.agentId, agents);

  return (
    <div
      className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary cursor-pointer flex flex-col gap-2"
      onClick={() => dispatch(selectTask(task.id))}
    >
      {/* Header: clock icon + name + toggle */}
      <div className="flex items-center gap-2 min-w-0">
        <ClockIcon className="w-4 h-4 text-secondary shrink-0" />
        <span className={`text-sm font-medium truncate flex-1 min-w-0 ${task.enabled ? 'text-foreground' : 'text-secondary'}`}>
          {task.name}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void scheduledTaskService.toggleTask(task.id, !task.enabled);
          }}
          className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
            task.enabled ? 'bg-primary' : 'bg-border'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-surface transition-transform shadow-sm ${
              task.enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Agent message */}
      {agentMessage && (
        <p
          className="text-xs text-secondary line-clamp-2 leading-relaxed"
          title={agentMessage}
        >
          {agentMessage}
        </p>
      )}

      {/* Schedule label */}
      <div className="text-xs text-secondary flex items-center gap-1">
        <span>🕐</span>
        <span className="truncate">{formatScheduleLabel(task.schedule)}</span>
      </div>

      {/* Bottom row: agent info + last run + status + menu */}
      <div className="flex items-center gap-2">
        {/* Agent info */}
        <div className="flex items-center gap-1 min-w-0 shrink-0">
          <span className="text-xs">{agentInfo.icon}</span>
          <span className="text-xs text-secondary truncate max-w-[72px]">{agentInfo.name}</span>
        </div>

        {/* Last run time */}
        {task.state.lastRunAtMs && (
          <div className="flex items-center gap-1 text-xs text-secondary min-w-0">
            <span>{i18nService.t('scheduledTasksLastRun')}</span>
            <span className="truncate">{formatRelativeTime(task.state.lastRunAtMs)}</span>
          </div>
        )}

        <div className="flex-1" />

        {/* Status badge */}
        <span className={`text-xs font-medium shrink-0 ${statusTone}`}>
          {displayStatus}
        </span>

        {/* More menu */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (!showMenu && menuButtonRef.current) {
                const rect = menuButtonRef.current.getBoundingClientRect();
                const spaceBelow = window.innerHeight - rect.bottom;
                const shouldShowAbove = spaceBelow < 148;
                setMenuPosition({
                  top: shouldShowAbove ? rect.top - 4 : rect.bottom + 4,
                  left: rect.right,
                  showAbove: shouldShowAbove,
                });
              }
              setShowMenu((v) => !v);
            }}
            className="p-1 rounded-lg text-secondary hover:text-primary transition-colors"
          >
            <EllipsisVerticalIcon className="w-4 h-4" />
          </button>
          {showMenu && menuPosition && (
            <div
              className="fixed z-50 w-max rounded-xl border border-border bg-surface shadow-popover overflow-hidden"
              style={{
                top: `${menuPosition.top}px`,
                left: `${menuPosition.left}px`,
                transform: menuPosition.showAbove ? 'translate(-100%, -100%)' : 'translateX(-100%)',
              }}
            >
              <button
                type="button"
                onClick={async (event) => {
                  event.stopPropagation();
                  setShowMenu(false);
                  setIsRunning(true);
                  dispatch(updateTaskState({
                    taskId: task.id,
                    taskState: { ...task.state, runningAtMs: Date.now(), lastStatus: 'running' },
                  }));
                  try {
                    await scheduledTaskService.runManually(task.id);
                    setIsRunning(false);
                    window.dispatchEvent(
                      new CustomEvent('app:showToast', {
                        detail: { message: i18nService.t('scheduledTasksTriggered'), variant: 'success' },
                      }),
                    );
                  } catch {
                    dispatch(updateTaskState({
                      taskId: task.id,
                      taskState: { ...task.state, runningAtMs: null },
                    }));
                    setIsRunning(false);
                    window.dispatchEvent(
                      new CustomEvent('app:showToast', {
                        detail: { message: i18nService.t('scheduledTasksRunFailed'), variant: 'info' },
                      }),
                    );
                  }
                }}
                disabled={Boolean(task.state.runningAtMs) || isRunning}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-raised disabled:opacity-50 transition-colors"
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
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-raised transition-colors"
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
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10 transition-colors"
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

/* ------------------------------------------------------------------ */
/*  TaskList                                                          */
/* ------------------------------------------------------------------ */

interface TaskListProps {
  onRequestDelete: (taskId: string, taskName: string) => void;
  onNewTask: () => void;
}

const TaskList: React.FC<TaskListProps> = ({ onRequestDelete, onNewTask }) => {
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const loading = useSelector((state: RootState) => state.scheduledTask.loading);
  const [searchQuery, setSearchQuery] = React.useState('');

  // Sort: enabled first (nextRunAtMs asc), then disabled (createdAt desc)
  const sortedTasks = React.useMemo(() => {
    return [...tasks].sort((a, b) => {
      // Enabled before disabled
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;

      if (a.enabled) {
        // Within enabled: nextRunAtMs ascending (soonest first), null at end
        const aNext = a.state.nextRunAtMs;
        const bNext = b.state.nextRunAtMs;
        if (aNext !== null && bNext !== null) {
          if (aNext !== bNext) return aNext - bNext;
        } else if (aNext !== null) return -1;
        else if (bNext !== null) return 1;
        // Tie-break by createdAt descending
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      // Within disabled: createdAt descending
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [tasks]);

  const filteredTasks = React.useMemo(() => {
    if (!searchQuery.trim()) return sortedTasks;
    const query = searchQuery.trim().toLowerCase();
    return sortedTasks.filter((t) => t.name.toLowerCase().includes(query));
  }, [sortedTasks, searchQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-secondary">{i18nService.t('loading')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Search bar + New Task button */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-secondary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={i18nService.t('scheduledTasksSearchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface border border-border text-foreground placeholder:text-secondary focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <button
          type="button"
          onClick={onNewTask}
          className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl bg-primary text-white hover:bg-primary-hover transition-colors shrink-0"
        >
          <PlusIcon className="w-4 h-4" />
          {i18nService.t('scheduledTasksNewTask')}
        </button>
      </div>

      {/* Empty state */}
      {tasks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 px-6">
          <ClockIcon className="h-12 w-12 text-secondary/40 mb-4" />
          <p className="text-sm font-medium text-secondary mb-1">
            {i18nService.t('scheduledTasksEmptyState')}
          </p>
          <p className="text-xs text-secondary/70 text-center">
            {i18nService.t('scheduledTasksEmptyHint')}
          </p>
        </div>
      )}

      {/* No search results */}
      {tasks.length > 0 && filteredTasks.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-secondary">
            {i18nService.t('scheduledTasksNoSearchResults')}
          </p>
        </div>
      )}

      {/* Card grid */}
      {filteredTasks.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {filteredTasks.map((task) => (
            <TaskCard key={task.id} task={task} onRequestDelete={onRequestDelete} />
          ))}
        </div>
      )}
    </div>
  );
};

export default TaskList;