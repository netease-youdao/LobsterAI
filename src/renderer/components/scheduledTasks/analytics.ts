import { PlatformRegistry } from '@shared/platform';
import { ProviderName } from '@shared/providers/constants';

import { ScheduleKind } from '../../../scheduledTask/constants';
import type {
  RunFilter,
  Schedule,
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskPayload,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
} from '../../../scheduledTask/types';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import type { Model } from '../../store/slices/modelSlice';
import { resolveOpenClawModelRef } from '../../utils/openclawModelRef';
import type { PlanType } from './utils';
import { scheduleToPlanInfo } from './utils';

type AnalyticsValue = string | number | boolean | null | undefined;
type AnalyticsParams = Record<string, AnalyticsValue>;

export type ScheduledTaskAnalyticsSource =
  | 'scheduled_tasks_view'
  | 'scheduled_tasks_list'
  | 'scheduled_task_detail'
  | 'scheduled_task_form'
  | 'scheduled_tasks_history'
  | 'scheduled_task_history';

export function reportScheduledTaskAction(
  actionType: string,
  params: AnalyticsParams = {},
): void {
  console.debug('[ScheduledTasks] reporting analytics action', actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.ScheduledTaskAction,
    actionType,
    ...params,
  });
}

export function serializeAnalyticsList(values: Array<string | number | null | undefined>): string {
  return values
    .filter((value): value is string | number => value !== null && value !== undefined && value !== '')
    .map(String)
    .join(',');
}

export function getModelAnalyticsParams(
  modelRef: string | undefined,
  availableModels: Model[],
): AnalyticsParams {
  const trimmedRef = modelRef?.trim() ?? '';
  if (!trimmedRef) {
    return { hasModel: false };
  }

  const resolvedModel = resolveOpenClawModelRef(trimmedRef, availableModels);
  if (!resolvedModel) {
    const slashIndex = trimmedRef.indexOf('/');
    return {
      hasModel: true,
      modelResolved: false,
      modelId: slashIndex >= 0 ? trimmedRef.slice(slashIndex + 1) : trimmedRef,
      providerKey: slashIndex >= 0 ? trimmedRef.slice(0, slashIndex) : undefined,
    };
  }

  const modelSource =
    resolvedModel.isServerModel || resolvedModel.providerKey === ProviderName.LobsteraiServer
      ? 'package'
      : 'custom';

  return {
    hasModel: true,
    modelResolved: true,
    modelId: resolvedModel.id,
    modelName: resolvedModel.name,
    modelSource,
    providerKey: resolvedModel.providerKey,
    provider: resolvedModel.provider,
    selectorGroup: modelSource === 'package' ? 'server' : 'user',
  };
}

export function getDeliveryAnalyticsParams(
  delivery: ScheduledTaskDelivery,
): AnalyticsParams {
  const notifyPlatform = delivery.channel
    ? PlatformRegistry.platformOfChannel(delivery.channel)
    : undefined;

  return {
    deliveryMode: delivery.mode,
    notifyChannel: delivery.channel,
    notifyPlatform,
    hasNotifyTarget: Boolean(delivery.to),
    hasNotifyAccount: Boolean(delivery.accountId),
  };
}

export function getScheduleAnalyticsParams(schedule: Schedule): AnalyticsParams {
  const planInfo = scheduleToPlanInfo(schedule);
  const base: AnalyticsParams = {
    scheduleKind: schedule.kind,
    planType: planInfo.planType,
    hour: planInfo.hour,
    minute: planInfo.minute,
  };

  if (schedule.kind === ScheduleKind.Cron) {
    return {
      ...base,
      cronExpr: schedule.expr,
      cronTz: schedule.tz,
      weekdayCount: planInfo.planType === 'weekly' ? planInfo.weekdays.length : undefined,
      weekdays: planInfo.planType === 'weekly' ? serializeAnalyticsList(planInfo.weekdays) : undefined,
      monthDay: planInfo.planType === 'monthly' ? planInfo.monthDay : undefined,
    };
  }

  if (schedule.kind === ScheduleKind.At) {
    return {
      ...base,
      hasRunAt: Boolean(schedule.at),
    };
  }

  return {
    ...base,
    everyMs: schedule.everyMs,
  };
}

export function getPayloadAnalyticsParams(payload: ScheduledTaskPayload): AnalyticsParams {
  const text = payload.kind === 'systemEvent' ? payload.text : payload.message;
  return {
    payloadKind: payload.kind,
    payloadTextLength: text.length,
    hasPrompt: text.trim().length > 0,
  };
}

export function getTaskAnalyticsParams(
  task: ScheduledTask,
  availableModels: Model[] = [],
): AnalyticsParams {
  const taskModelRef = task.payload.kind === 'agentTurn' ? task.payload.model : undefined;
  return {
    enabled: task.enabled,
    taskStatus: task.state.runningAtMs ? 'running' : 'idle',
    lastStatus: task.state.lastStatus,
    hasNextRun: task.state.nextRunAtMs !== null,
    consecutiveErrors: task.state.consecutiveErrors,
    hasLastError: Boolean(task.state.lastError),
    sessionTarget: task.sessionTarget,
    wakeMode: task.wakeMode,
    hasSessionKey: Boolean(task.sessionKey),
    ...getScheduleAnalyticsParams(task.schedule),
    ...getPayloadAnalyticsParams(task.payload),
    ...getDeliveryAnalyticsParams(task.delivery),
    ...getModelAnalyticsParams(taskModelRef, availableModels),
  };
}

export function getFilterAnalyticsParams(filter: RunFilter): AnalyticsParams {
  return {
    hasActiveFilter: Boolean(filter.startDate || filter.endDate || filter.status),
    filterStatus: filter.status,
    hasStartDate: Boolean(filter.startDate),
    hasEndDate: Boolean(filter.endDate),
  };
}

export function getRunAnalyticsParams(run: ScheduledTaskRun | ScheduledTaskRunWithName): AnalyticsParams {
  return {
    runStatus: run.status,
    hasSession: Boolean(run.sessionId || run.sessionKey),
    hasDuration: run.durationMs !== null,
    durationMs: run.durationMs ?? undefined,
    hasError: Boolean(run.error),
  };
}

export function getFormScheduleAnalyticsParams(params: {
  cronExpr: string;
  cronMode: 'builder' | 'raw';
  cronTz: string;
  hour: number;
  minute: number;
  monthDay: number;
  planType: PlanType;
  scheduleKind?: Schedule['kind'];
  weekdays: number[];
}): AnalyticsParams {
  return {
    planType: params.planType,
    scheduleKind: params.scheduleKind,
    cronMode: params.planType === 'cron' ? params.cronMode : undefined,
    cronExpr: params.planType === 'cron' ? params.cronExpr : undefined,
    cronTz: params.planType === 'cron' ? params.cronTz : undefined,
    hour: params.hour,
    minute: params.minute,
    weekdayCount: params.planType === 'weekly' ? params.weekdays.length : undefined,
    weekdays: params.planType === 'weekly' ? serializeAnalyticsList(params.weekdays) : undefined,
    monthDay: params.planType === 'monthly' ? params.monthDay : undefined,
  };
}
