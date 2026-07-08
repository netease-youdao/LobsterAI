import { PlayIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { DeliveryMode, TaskStatus } from '../../../scheduledTask/constants';
import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskConversationOption,
} from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { setViewMode } from '../../store/slices/scheduledTaskSlice';
import EditIcon from '../icons/EditIcon';
import TrashIcon from '../icons/TrashIcon';
import { getTaskAnalyticsParams, reportScheduledTaskAction } from './analytics';
import TaskRunHistory from './TaskRunHistory';
import TaskStatusChip from './TaskStatusChip';
import TaskToggle from './TaskToggle';
import {
  channelOptionMatchesSelection,
  formatDateTimeMinute,
  formatDeliveryLabel,
  formatDuration,
  formatElapsedDuration,
  formatNextRunRelative,
  formatScheduleLabel,
  getTaskDisplayStatus,
} from './utils';

const lastRunStatusLabelKeys: Record<TaskStatus, string> = {
  [TaskStatus.Success]: 'scheduledTasksStatusSuccess',
  [TaskStatus.Error]: 'scheduledTasksStatusError',
  [TaskStatus.Skipped]: 'scheduledTasksStatusSkipped',
  [TaskStatus.Running]: 'scheduledTasksStatusRunning',
};

const lastRunStatusTones: Record<TaskStatus, string> = {
  [TaskStatus.Success]: 'text-green-600 dark:text-green-400',
  [TaskStatus.Error]: 'text-red-600 dark:text-red-400',
  [TaskStatus.Skipped]: 'text-yellow-600 dark:text-yellow-400',
  [TaskStatus.Running]: 'text-blue-600 dark:text-blue-400',
};

interface TaskDetailProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string, source?: string) => void;
}

const TaskDetail: React.FC<TaskDetailProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const runs = useSelector((state: RootState) => state.scheduledTask.runs[task.id] ?? []);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  const displayStatus = getTaskDisplayStatus(task);
  const isRunning = displayStatus === 'running';
  const runningAtMs = task.state.runningAtMs;

  // Tick every second while the task is running so the elapsed label stays live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!runningAtMs) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningAtMs]);

  useEffect(() => {
    void scheduledTaskService.loadRuns(task.id);
  }, [task.id]);

  // Resolve the delivery channel/target to the same friendly names the form
  // pickers show ("企业微信 · 2 号 · 私聊 · 张三") instead of raw ids.
  const { mode: deliveryMode, channel: deliveryChannel, accountId: deliveryAccountId, to: deliveryTo } = task.delivery;
  const [deliveryChannels, setDeliveryChannels] = useState<ScheduledTaskChannelOption[]>([]);
  const [deliveryConversations, setDeliveryConversations] = useState<
    ScheduledTaskConversationOption[]
  >([]);
  useEffect(() => {
    setDeliveryChannels([]);
    setDeliveryConversations([]);
    if (!deliveryChannel || deliveryMode === DeliveryMode.Webhook) return;
    let cancelled = false;
    void (async () => {
      const channels = await scheduledTaskService.listChannels();
      if (cancelled) return;
      setDeliveryChannels(channels);
      if (!deliveryTo) return;
      // Query conversations with the option's filterAccountId (like the form
      // does): some plugins persist mappings under a different account prefix
      // than the delivery-time accountId.
      const matched = channels.find(option =>
        channelOptionMatchesSelection(option, deliveryChannel, deliveryAccountId),
      );
      const conversations = await scheduledTaskService.listChannelConversations(
        deliveryChannel,
        deliveryAccountId,
        matched?.filterAccountId ?? deliveryAccountId,
      );
      if (!cancelled) setDeliveryConversations(conversations);
    })();
    return () => {
      cancelled = true;
    };
  }, [deliveryChannel, deliveryAccountId, deliveryTo, deliveryMode]);

  // Refresh the run list whenever the running flag flips (run started or
  // finished) so the history reflects the latest run without a manual reload.
  const wasRunningRef = useRef(Boolean(runningAtMs));
  useEffect(() => {
    const isRunningNow = Boolean(runningAtMs);
    if (wasRunningRef.current !== isRunningNow) {
      wasRunningRef.current = isRunningNow;
      void scheduledTaskService.loadRuns(task.id);
    }
  }, [runningAtMs, task.id]);

  const analyticsParams = React.useMemo(
    () => getTaskAnalyticsParams(task, availableModels),
    [availableModels, task],
  );

  const handleEdit = React.useCallback(() => {
    reportScheduledTaskAction('detail_edit', {
      source: 'scheduled_task_detail',
      ...analyticsParams,
    });
    dispatch(setViewMode('edit'));
  }, [analyticsParams, dispatch]);

  const handleRunManually = React.useCallback(async () => {
    reportScheduledTaskAction('detail_run_manually', {
      source: 'scheduled_task_detail',
      ...analyticsParams,
    });
    try {
      await scheduledTaskService.runManually(task.id);
      reportScheduledTaskAction('detail_run_manually_success', {
        source: 'scheduled_task_detail',
        result: 'success',
        ...analyticsParams,
      });
    } catch {
      reportScheduledTaskAction('detail_run_manually_failed', {
        source: 'scheduled_task_detail',
        result: 'failed',
        errorCode: 'run_manually_failed',
        ...analyticsParams,
      });
    }
  }, [analyticsParams, task.id]);

  const handleToggle = React.useCallback(async () => {
    const targetEnabled = !task.enabled;
    reportScheduledTaskAction('toggle_enabled', {
      source: 'scheduled_task_detail',
      targetEnabled,
      ...analyticsParams,
    });
    try {
      await scheduledTaskService.toggleTask(task.id, targetEnabled);
      reportScheduledTaskAction('toggle_enabled_success', {
        source: 'scheduled_task_detail',
        targetEnabled,
        result: 'success',
        ...analyticsParams,
      });
    } catch {
      // The service already rolled back the optimistic flip and toasted.
      reportScheduledTaskAction('toggle_enabled_failed', {
        source: 'scheduled_task_detail',
        targetEnabled,
        result: 'failed',
        errorCode: 'toggle_failed',
        ...analyticsParams,
      });
    }
  }, [analyticsParams, task.enabled, task.id]);

  const promptText = task.payload.kind === 'systemEvent' ? task.payload.text : task.payload.message;
  const deliveryLabel = formatDeliveryLabel(task.delivery, {
    conversations: deliveryConversations,
    channels: deliveryChannels,
  });
  const taskModelRef = task.payload.kind === 'agentTurn' ? task.payload.model : undefined;
  const taskModelLabel = taskModelRef
    ? (() => {
        const bareId = taskModelRef.includes('/') ? taskModelRef.slice(taskModelRef.indexOf('/') + 1) : taskModelRef;
        return availableModels.find((m) => m.id === bareId)?.name ?? bareId;
      })()
    : undefined;

  const lastStatus = task.state.lastStatus;
  const nextRunRelative = formatNextRunRelative(task.state.nextRunAtMs);
  const showErrorBanner = Boolean(task.state.lastError && lastStatus === TaskStatus.Error);
  const showConsecutiveWarning = task.state.consecutiveErrors >= 2;

  const sectionClass = 'rounded-xl border border-border bg-surface p-4';
  const sectionTitleClass = 'text-sm font-semibold text-foreground mb-3';
  const labelClass = 'text-xs text-secondary mb-0.5';
  const valueClass = 'text-sm text-foreground';

  return (
    <div className="mx-auto w-full max-w-[880px] space-y-4 px-6 py-5 sm:px-8 lg:px-10">
      {/* Header: name + status + actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="truncate text-xl font-semibold text-foreground">{task.name}</h2>
            <TaskStatusChip status={displayStatus} />
          </div>
          {task.description && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-secondary">{task.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRunManually()}
            disabled={isRunning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-primary"
          >
            {isRunning ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
              </svg>
            ) : (
              <PlayIcon className="h-4 w-4" />
            )}
            {isRunning
              ? i18nService.t('scheduledTasksStatusRunning')
              : i18nService.t('scheduledTasksRun')}
          </button>
          <TaskToggle
            enabled={task.enabled}
            onToggle={() => void handleToggle()}
            title={i18nService.t(task.enabled ? 'scheduledTasksEnabled' : 'scheduledTasksDisabled')}
          />
          <span className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={handleEdit}
            className="rounded-lg p-2 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            title={i18nService.t('scheduledTasksEdit')}
          >
            <EditIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onRequestDelete(task.id, task.name, 'scheduled_task_detail')}
            className="rounded-lg p-2 text-secondary transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
            title={i18nService.t('scheduledTasksDelete')}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Live running banner */}
      {isRunning && runningAtMs && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/[0.07] px-3 py-2 text-sm text-blue-600 dark:text-blue-400">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
            <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
          </svg>
          {i18nService
            .t('scheduledTasksRunningFor')
            .replace('{duration}', formatElapsedDuration(nowMs - runningAtMs))}
        </div>
      )}

      {/* Prompt */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksPrompt')}</h3>
        <div className="whitespace-pre-wrap rounded-lg bg-surface-raised/40 p-3 text-sm leading-6 text-foreground">
          {promptText}
        </div>
      </div>

      {/* Configuration */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksConfiguration')}</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksSchedule')}</div>
            <div className={valueClass}>{formatScheduleLabel(task.schedule)}</div>
          </div>
          {taskModelLabel && (
            <div>
              <div className={labelClass}>{i18nService.t('scheduledTasksDetailModel')}</div>
              <div className={valueClass}>{taskModelLabel}</div>
            </div>
          )}
          <div className="min-w-0">
            <div className={labelClass}>{i18nService.t('scheduledTasksDetailNotify')}</div>
            <div className={`${valueClass} truncate`} title={deliveryLabel}>
              {deliveryLabel}
            </div>
          </div>
          {task.sessionKey && (
            <div className="col-span-full">
              <div className={labelClass}>{i18nService.t('scheduledTasksSessionKey')}</div>
              <div
                className={`${valueClass} truncate font-mono text-xs text-secondary`}
                title={task.sessionKey}
              >
                {task.sessionKey}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Run status */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksStatus')}</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksLastRun')}</div>
            <div className={valueClass}>
              {lastStatus ? (
                <>
                  <span className={`font-medium ${lastRunStatusTones[lastStatus]}`}>
                    {i18nService.t(lastRunStatusLabelKeys[lastStatus])}
                  </span>
                  {task.state.lastRunAtMs && (
                    <span className="ml-1.5 text-xs text-secondary">
                      {formatDateTimeMinute(new Date(task.state.lastRunAtMs))}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-secondary">{i18nService.t('scheduledTasksStatusNever')}</span>
              )}
            </div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksNextRun')}</div>
            <div className={valueClass}>
              {task.state.nextRunAtMs ? (
                <>
                  {formatDateTimeMinute(new Date(task.state.nextRunAtMs))}
                  {nextRunRelative && (
                    <span className="ml-1.5 text-xs text-secondary">{nextRunRelative}</span>
                  )}
                </>
              ) : (
                '–'
              )}
            </div>
          </div>
          <div>
            <div className={labelClass}>{i18nService.t('scheduledTasksLastDuration')}</div>
            <div className={valueClass}>{formatDuration(task.state.lastDurationMs)}</div>
          </div>
        </div>
        {showErrorBanner && (
          <div className="mt-3 break-words rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-400">
            {task.state.lastError}
          </div>
        )}
        {showConsecutiveWarning && (
          <div className="mt-2 rounded-lg border border-yellow-500/20 bg-yellow-500/[0.06] px-3 py-2 text-xs leading-5 text-yellow-700 dark:text-yellow-400">
            {i18nService
              .t('scheduledTasksConsecutiveErrorsHint')
              .replace('{count}', String(task.state.consecutiveErrors))}
          </div>
        )}
      </div>

      {/* Run history */}
      <div className={sectionClass}>
        <h3 className={sectionTitleClass}>{i18nService.t('scheduledTasksRunHistory')}</h3>
        <TaskRunHistory task={task} runs={runs} />
      </div>
    </div>
  );
};

export default TaskDetail;
