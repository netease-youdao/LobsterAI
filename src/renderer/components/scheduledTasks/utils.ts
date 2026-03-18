import { i18nService } from '../../services/i18n';
import type {
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskPayload,
  Schedule,
  TaskLastStatus,
} from '../../types/scheduledTask';

export function formatScheduleLabel(schedule: Schedule): string {
  if (schedule.kind === 'at') {
    const date = new Date(schedule.at);
    if (Number.isFinite(date.getTime())) {
      return `${i18nService.t('scheduledTasksFormScheduleModeAt')} · ${date.toLocaleString()}`;
    }
    return i18nService.t('scheduledTasksFormScheduleModeAt');
  }

  if (schedule.kind === 'every') {
    const everyMs = schedule.everyMs;
    if (everyMs % 86_400_000 === 0) {
      return `${i18nService.t('scheduledTasksScheduleEvery')} ${everyMs / 86_400_000} ${i18nService.t('scheduledTasksFormIntervalDays')}`;
    }
    if (everyMs % 3_600_000 === 0) {
      return `${i18nService.t('scheduledTasksScheduleEvery')} ${everyMs / 3_600_000} ${i18nService.t('scheduledTasksFormIntervalHours')}`;
    }
    return `${i18nService.t('scheduledTasksScheduleEvery')} ${Math.max(1, Math.round(everyMs / 60_000))} ${i18nService.t('scheduledTasksFormIntervalMinutes')}`;
  }

  const tzLabel = schedule.tz ? ` (${schedule.tz})` : '';
  return `Cron · ${schedule.expr}${tzLabel}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatPayloadLabel(payload: ScheduledTaskPayload): string {
  if (payload.kind === 'systemEvent') {
    return `${i18nService.t('scheduledTasksFormPayloadKindSystemEvent')} · ${payload.text}`;
  }
  const timeoutLabel = typeof payload.timeoutSeconds === 'number'
    ? ` · ${payload.timeoutSeconds}s`
    : '';
  return `${i18nService.t('scheduledTasksFormPayloadKindAgentTurn')} · ${payload.message}${timeoutLabel}`;
}

export function formatDeliveryLabel(delivery: ScheduledTaskDelivery): string {
  if (delivery.mode === 'none') {
    return i18nService.t('scheduledTasksFormDeliveryModeNone');
  }

  if (delivery.mode === 'webhook') {
    return delivery.to
      ? `${i18nService.t('scheduledTasksFormDeliveryModeWebhook')} · ${delivery.to}`
      : i18nService.t('scheduledTasksFormDeliveryModeWebhook');
  }

  const channel = delivery.channel || 'last';
  const toLabel = delivery.to ? ` -> ${delivery.to}` : '';
  return `${i18nService.t('scheduledTasksFormDeliveryModeAnnounce')} · ${channel}${toLabel}`;
}

export function getTaskPromptText(task: ScheduledTask): string {
  return task.payload.kind === 'systemEvent' ? task.payload.text : task.payload.message;
}

export function getStatusTone(status: TaskLastStatus): string {
  if (status === 'success') return 'text-green-500';
  if (status === 'error') return 'text-red-500';
  if (status === 'skipped') return 'text-yellow-500';
  if (status === 'running') return 'text-blue-500';
  return 'dark:text-claude-darkTextSecondary text-claude-textSecondary';
}

export function getStatusLabelKey(status: TaskLastStatus): string {
  if (status === 'success') return 'scheduledTasksStatusSuccess';
  if (status === 'error') return 'scheduledTasksStatusError';
  if (status === 'skipped') return 'scheduledTasksStatusSkipped';
  if (status === 'running') return 'scheduledTasksStatusRunning';
  return 'scheduledTasksStatusIdle';
}
