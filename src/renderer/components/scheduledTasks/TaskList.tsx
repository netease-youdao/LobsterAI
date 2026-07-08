import {
  ClockIcon,
  EllipsisVerticalIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import React from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { ScheduledTaskDataStatus } from '../../../scheduledTask/constants';
import type { ScheduledTask } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { selectTask, setViewMode } from '../../store/slices/scheduledTaskSlice';
import EditIcon from '../icons/EditIcon';
import TrashIcon from '../icons/TrashIcon';
import { getTaskAnalyticsParams, reportScheduledTaskAction } from './analytics';
import ScheduledTaskDataState from './ScheduledTaskDataState';
import TaskStatusChip from './TaskStatusChip';
import {
  SCHEDULED_TASK_TEMPLATES,
  type ScheduledTaskTemplate,
  templateIconComponents,
} from './taskTemplates';
import TaskToggle from './TaskToggle';
import {
  formatNextRunRelative,
  formatScheduleLabel,
  getTaskDisplayStatus,
  getTaskPromptText,
} from './utils';

const listPageClass = 'px-6 py-5 sm:px-8 lg:px-10';
const listContentClass = 'mx-auto w-full max-w-[880px]';
/** Show the search field only once the list is big enough for it to help. */
const SEARCH_VISIBLE_MIN_TASKS = 6;
const menuWidthPx = 144;
const menuHeightEstimatePx = 156;
const menuEdgeGapPx = 8;
const menuTriggerGapPx = 4;
const menuItemClassName =
  'flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]';
const destructiveMenuItemClassName =
  'flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-[13px] text-red-500 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]';
const menuIconClassName = 'h-3.5 w-3.5';

interface MenuPosition {
  top: number;
  left: number;
}

interface TaskCardProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string, source?: string) => void;
}

const TaskCard: React.FC<TaskCardProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const [showMenu, setShowMenu] = React.useState(false);
  const [menuPosition, setMenuPosition] = React.useState<MenuPosition | null>(null);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const updateMenuPosition = React.useCallback(() => {
    if (!menuButtonRef.current) return;

    const rect = menuButtonRef.current.getBoundingClientRect();
    const maxLeft = window.innerWidth - menuWidthPx - menuEdgeGapPx;
    const left = Math.max(
      menuEdgeGapPx,
      Math.min(rect.right - menuWidthPx, maxLeft),
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const hasMoreSpaceAbove = rect.top > spaceBelow;
    const openAbove = spaceBelow < menuHeightEstimatePx + menuTriggerGapPx && hasMoreSpaceAbove;
    const preferredTop = openAbove
      ? rect.top - menuHeightEstimatePx - menuTriggerGapPx
      : rect.bottom + menuTriggerGapPx;
    const maxTop = window.innerHeight - menuHeightEstimatePx - menuEdgeGapPx;

    setMenuPosition({
      top: Math.max(menuEdgeGapPx, Math.min(preferredTop, maxTop)),
      left,
    });
  }, []);

  React.useLayoutEffect(() => {
    if (showMenu) {
      updateMenuPosition();
    } else {
      setMenuPosition(null);
    }
  }, [showMenu, updateMenuPosition]);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuButtonRef.current &&
        !menuButtonRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  React.useEffect(() => {
    if (!showMenu) return;

    const handleViewportChange = () => setShowMenu(false);
    window.addEventListener('resize', handleViewportChange);
    document.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      document.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [showMenu]);

  const displayStatus = getTaskDisplayStatus(task);
  const isRunning = displayStatus === 'running';
  const promptText = getTaskPromptText(task);
  const nextRunLabel = task.enabled ? formatNextRunRelative(task.state.nextRunAtMs) : null;
  const analyticsParams = React.useMemo(
    () => getTaskAnalyticsParams(task, availableModels),
    [availableModels, task],
  );

  const handleSelectTask = React.useCallback(() => {
    reportScheduledTaskAction('select_task', {
      source: 'scheduled_tasks_list',
      ...analyticsParams,
    });
    dispatch(selectTask(task.id));
  }, [analyticsParams, dispatch, task.id]);

  const handleToggleTask = React.useCallback(async () => {
    const targetEnabled = !task.enabled;
    reportScheduledTaskAction('toggle_enabled', {
      source: 'scheduled_tasks_list',
      targetEnabled,
      ...analyticsParams,
    });
    try {
      await scheduledTaskService.toggleTask(task.id, targetEnabled);
      reportScheduledTaskAction('toggle_enabled_success', {
        source: 'scheduled_tasks_list',
        targetEnabled,
        result: 'success',
        ...analyticsParams,
      });
    } catch {
      // The service already rolled back the optimistic flip and toasted.
      reportScheduledTaskAction('toggle_enabled_failed', {
        source: 'scheduled_tasks_list',
        targetEnabled,
        result: 'failed',
        errorCode: 'toggle_failed',
        ...analyticsParams,
      });
    }
  }, [analyticsParams, task.enabled, task.id]);

  const handleRunManually = React.useCallback(async () => {
    reportScheduledTaskAction('run_manually', {
      source: 'scheduled_tasks_list',
      ...analyticsParams,
    });
    try {
      await scheduledTaskService.runManually(task.id);
      reportScheduledTaskAction('run_manually_success', {
        source: 'scheduled_tasks_list',
        result: 'success',
        ...analyticsParams,
      });
    } catch {
      reportScheduledTaskAction('run_manually_failed', {
        source: 'scheduled_tasks_list',
        result: 'failed',
        errorCode: 'run_manually_failed',
        ...analyticsParams,
      });
    }
  }, [analyticsParams, task.id]);

  const handleCardKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Nested controls (toggle, menu) handle their own keys.
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleSelectTask();
      }
    },
    [handleSelectTask],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      className="group flex cursor-pointer flex-col rounded-xl border border-border bg-surface p-4 transition hover:border-primary/35 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      onClick={handleSelectTask}
      onKeyDown={handleCardKeyDown}
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          className={`min-w-0 flex-1 truncate text-sm font-semibold ${
            task.enabled ? 'text-foreground' : 'text-secondary'
          }`}
        >
          {task.name}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          <TaskToggle enabled={task.enabled} onToggle={() => void handleToggleTask()} />
          <div className="relative">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={event => {
                event.stopPropagation();
                setShowMenu(value => {
                  const nextShowMenu = !value;
                  if (nextShowMenu) {
                    reportScheduledTaskAction('task_menu_open', {
                      source: 'scheduled_tasks_list',
                      ...analyticsParams,
                    });
                  }
                  return nextShowMenu;
                });
              }}
              className="rounded-md p-1 text-secondary/70 transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <EllipsisVerticalIcon className="h-4 w-4" />
            </button>
            {showMenu && menuPosition && (
              createPortal(
                <div
                  ref={menuRef}
                  onClick={event => event.stopPropagation()}
                  className="fixed z-[9999] w-36 rounded-lg border border-border bg-surface py-1 shadow-lg"
                  style={{ top: menuPosition.top, left: menuPosition.left }}
                >
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      setShowMenu(false);
                      void handleRunManually();
                    }}
                    disabled={isRunning}
                    className={`${menuItemClassName} disabled:opacity-50`}
                  >
                    <PlayIcon className={menuIconClassName} />
                    {i18nService.t('scheduledTasksRun')}
                  </button>
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      setShowMenu(false);
                      reportScheduledTaskAction('edit_task', {
                        source: 'scheduled_tasks_list',
                        ...analyticsParams,
                      });
                      dispatch(selectTask(task.id));
                      dispatch(setViewMode('edit'));
                    }}
                    className={menuItemClassName}
                  >
                    <EditIcon className={menuIconClassName} />
                    {i18nService.t('scheduledTasksEdit')}
                  </button>
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      setShowMenu(false);
                      onRequestDelete(task.id, task.name, 'scheduled_tasks_list');
                    }}
                    className={destructiveMenuItemClassName}
                  >
                    <TrashIcon className={menuIconClassName} />
                    {i18nService.t('scheduledTasksDelete')}
                  </button>
                </div>,
                document.body,
              )
            )}
          </div>
        </div>
      </div>

      <p className="mt-1.5 min-h-[40px] text-[13px] leading-5 text-secondary line-clamp-2">
        {task.description || promptText}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-secondary">
          <ClockIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {formatScheduleLabel(task.schedule)}
            {nextRunLabel && <span className="text-secondary/60"> · {nextRunLabel}</span>}
          </span>
        </div>
        <TaskStatusChip status={displayStatus} />
      </div>
    </div>
  );
};

interface TemplateGalleryProps {
  onCreateFromTemplate: (template: ScheduledTaskTemplate) => void;
}

const TemplateGallery: React.FC<TemplateGalleryProps> = ({ onCreateFromTemplate }) => (
  <div>
    <div className="mb-3 flex items-center gap-3">
      <span className="text-xs font-medium text-secondary">
        {i18nService.t('scheduledTasksTemplatesSection')}
      </span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {SCHEDULED_TASK_TEMPLATES.map(template => {
        const Icon = templateIconComponents[template.icon];
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onCreateFromTemplate(template)}
            className="group flex items-start gap-3 rounded-xl border border-transparent p-3 text-left transition hover:border-border hover:bg-surface"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-secondary transition-colors group-hover:bg-primary/10 group-hover:text-primary">
              <Icon className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                {i18nService.t(template.titleKey)}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-secondary line-clamp-2">
                {i18nService.t(template.descriptionKey)}
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-xs text-secondary/70">
                <ClockIcon className="h-3 w-3" />
                {i18nService.t(template.scheduleLabelKey)}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  </div>
);

interface TaskListProps {
  onRequestDelete: (taskId: string, taskName: string, source?: string) => void;
  onCreateNew: () => void;
  onCreateFromTemplate: (template: ScheduledTaskTemplate) => void;
}

const TaskList: React.FC<TaskListProps> = ({
  onRequestDelete,
  onCreateNew,
  onCreateFromTemplate,
}) => {
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const status = useSelector((state: RootState) => state.scheduledTask.taskListStatus);
  const error = useSelector((state: RootState) => state.scheduledTask.taskListError);
  const [searchText, setSearchText] = React.useState('');

  // Re-render every 30s so the relative "next run" labels on the cards stay
  // honest while the list is left open.
  const [, setRelativeTimeTick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setRelativeTimeTick(tick => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sortedTasks = React.useMemo(() => {
    const rank = (task: ScheduledTask): number => {
      if (task.state.runningAtMs) return 0;
      if (task.enabled && task.state.nextRunAtMs !== null) return 1;
      if (task.enabled) return 2;
      return 3;
    };
    return [...tasks].sort((a, b) => {
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      const nextA = a.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
      const nextB = b.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
      if (nextA !== nextB) return nextA - nextB;
      return a.name.localeCompare(b.name);
    });
  }, [tasks]);

  const normalizedSearch = searchText.trim().toLowerCase();
  const visibleTasks = React.useMemo(() => {
    if (!normalizedSearch) return sortedTasks;
    return sortedTasks.filter(task =>
      [task.name, task.description, getTaskPromptText(task)]
        .join('\n')
        .toLowerCase()
        .includes(normalizedSearch),
    );
  }, [normalizedSearch, sortedTasks]);

  if (status !== ScheduledTaskDataStatus.Ready) {
    return (
      <div className={listPageClass}>
        <div className={listContentClass}>
          <ScheduledTaskDataState
            status={status}
            error={error}
            onRetry={() => {
              reportScheduledTaskAction('retry_load_tasks', {
                source: 'scheduled_tasks_list',
                result: 'retry',
              });
              void scheduledTaskService.loadTasks();
            }}
          />
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className={listPageClass}>
        <div className={`${listContentClass} space-y-8`}>
          <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <ClockIcon className="h-7 w-7 text-primary" />
            </div>
            <p className="text-sm font-semibold text-foreground">
              {i18nService.t('scheduledTasksEmptyState')}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {i18nService.t('scheduledTasksEmptyHint')}
            </p>
            <button
              type="button"
              onClick={onCreateNew}
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
            >
              <PlusIcon className="h-4 w-4" />
              {i18nService.t('scheduledTasksNewTask')}
            </button>
          </div>
          <TemplateGallery onCreateFromTemplate={onCreateFromTemplate} />
        </div>
      </div>
    );
  }

  return (
    <div className={listPageClass}>
      <div className={`${listContentClass} space-y-8`}>
        <div className="space-y-3">
          {tasks.length >= SEARCH_VISIBLE_MIN_TASKS && (
            <div className="relative">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary/60" />
              <input
                type="text"
                value={searchText}
                onChange={event => setSearchText(event.target.value)}
                placeholder={i18nService.t('scheduledTasksSearchPlaceholder')}
                className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-foreground placeholder:text-secondary/60 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          )}

          {visibleTasks.length === 0 ? (
            <div className="rounded-xl border border-border px-6 py-10 text-center text-sm text-secondary">
              {i18nService.t('scheduledTasksSearchNoResults')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {visibleTasks.map(task => (
                <TaskCard key={task.id} task={task} onRequestDelete={onRequestDelete} />
              ))}
            </div>
          )}
        </div>

        <TemplateGallery onCreateFromTemplate={onCreateFromTemplate} />
      </div>
    </div>
  );
};

export default TaskList;
