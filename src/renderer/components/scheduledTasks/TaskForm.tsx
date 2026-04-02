import React, { useEffect, useState } from 'react';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskConversationOption,
  ScheduledTaskInput,
} from '../../../scheduledTask/types';
import { formatScheduleLabel, type PlanType, scheduleToPlanInfo } from './utils';
import { PlatformRegistry } from '@shared/platform';

interface TaskFormProps {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  onCancel: () => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  description: string;
  planType: PlanType;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  monthDay: number;
  payloadText: string;
  notifyChannel: string;
  notifyTo: string;
}

function nowDefaults() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: 9,
    minute: 0,
    second: 0,
  };
}

const DEFAULT_FORM_STATE: FormState = {
  name: '',
  description: '',
  planType: 'daily',
  ...nowDefaults(),
  weekday: 1,
  monthDay: 1,
  payloadText: '',
  notifyChannel: 'none',
  notifyTo: '',
};

function isIMChannel(channel: string): boolean {
  return PlatformRegistry.isIMChannel(channel);
}

function createFormState(task?: ScheduledTask): FormState {
  if (!task) return { ...DEFAULT_FORM_STATE, ...nowDefaults() };

  const planInfo = scheduleToPlanInfo(task.schedule);
  return {
    name: task.name,
    description: task.description,
    planType: planInfo.planType,
    year: planInfo.year,
    month: planInfo.month,
    day: planInfo.day,
    hour: planInfo.hour,
    minute: planInfo.minute,
    second: planInfo.second,
    weekday: planInfo.weekday,
    monthDay: planInfo.monthDay,
    payloadText: task.payload.kind === 'systemEvent' ? task.payload.text : task.payload.message,
    notifyChannel: task.delivery.channel || 'none',
    notifyTo: task.delivery.to || '',
  };
}

function buildScheduleInput(form: FormState): ScheduledTaskInput['schedule'] {
  if (form.planType === 'once') {
    const date = new Date(form.year, form.month - 1, form.day, form.hour, form.minute, form.second);
    return { kind: 'at', at: date.toISOString() };
  }

  const min = String(form.minute);
  const hr = String(form.hour);

  if (form.planType === 'daily') {
    return { kind: 'cron', expr: `${min} ${hr} * * *` };
  }

  if (form.planType === 'weekly') {
    return { kind: 'cron', expr: `${min} ${hr} * * ${form.weekday}` };
  }

  return { kind: 'cron', expr: `${min} ${hr} ${form.monthDay} * *` };
}

const WEEKDAY_KEYS = [
  'scheduledTasksFormWeekSun',
  'scheduledTasksFormWeekMon',
  'scheduledTasksFormWeekTue',
  'scheduledTasksFormWeekWed',
  'scheduledTasksFormWeekThu',
  'scheduledTasksFormWeekFri',
  'scheduledTasksFormWeekSat',
] as const;

const TaskForm: React.FC<TaskFormProps> = ({ mode, task, onCancel, onSaved }) => {
  const [form, setForm] = useState<FormState>(() => createFormState(task));
  const [channelOptions, setChannelOptions] = useState<ScheduledTaskChannelOption[]>(() => {
    const base: ScheduledTaskChannelOption[] = [];
    const savedChannel = task?.delivery.channel;
    if (savedChannel && isIMChannel(savedChannel) && !base.some((o) => o.value === savedChannel)) {
      base.push({ value: savedChannel, label: savedChannel });
    }
    return base;
  });
  const [conversations, setConversations] = useState<ScheduledTaskConversationOption[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isAdvanced = form.planType === 'advanced';
  const showConversationSelector = isIMChannel(form.notifyChannel);

  useEffect(() => {
    setForm(createFormState(task));
  }, [task]);

  useEffect(() => {
    let cancelled = false;
    void scheduledTaskService.listChannels().then((channels) => {
      if (cancelled || channels.length === 0) return;
      setChannelOptions((current) => {
        const next = [...current];
        for (const channel of channels) {
          if (!next.some((item) => item.value === channel.value)) {
            next.push(channel);
          }
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!showConversationSelector) {
      setConversations([]);
      return;
    }

    let cancelled = false;
    setConversationsLoading(true);
    void scheduledTaskService.listChannelConversations(form.notifyChannel).then((result) => {
      if (cancelled) return;
      setConversations(result);
      setConversationsLoading(false);

      if (result.length > 0 && !form.notifyTo) {
        setForm((current) => ({ ...current, notifyTo: result[0].conversationId }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [form.notifyChannel]);

  const updateForm = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const validate = (): boolean => {
    const nextErrors: Record<string, string> = {};

    if (!form.name.trim()) {
      nextErrors.name = i18nService.t('scheduledTasksFormValidationNameRequired');
    }
    if (!form.payloadText.trim()) {
      nextErrors.payloadText = i18nService.t('scheduledTasksFormValidationPromptRequired');
    }

    if (form.planType === 'once') {
      const runAt = new Date(form.year, form.month - 1, form.day, form.hour, form.minute, form.second);
      if (runAt.getTime() <= Date.now()) {
        nextErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
      }
    }

    if (!isAdvanced && (form.hour < 0 || form.hour > 23 || form.minute < 0 || form.minute > 59)) {
      nextErrors.schedule = i18nService.t('scheduledTasksFormValidationTimeRequired');
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setSubmitting(true);
    try {
      const schedule = isAdvanced && task
        ? task.schedule
        : buildScheduleInput(form);

      const input: ScheduledTaskInput = {
        name: form.name.trim(),
        description: '',
        enabled: true,
        schedule,
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: {
          kind: 'agentTurn',
          message: form.payloadText.trim(),
        },
        delivery: form.notifyChannel === 'none'
          ? { mode: 'none' }
          : {
              mode: 'announce',
              channel: form.notifyChannel,
              ...(form.notifyTo ? { to: form.notifyTo } : {}),
            },
      };

      if (mode === 'create') {
        await scheduledTaskService.createTask(input);
      } else if (task) {
        await scheduledTaskService.updateTaskById(task.id, input);
      }
      onSaved();
    } catch {
      // Service handles error state.
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';
  const labelClass = 'block text-sm font-medium text-foreground mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';

  const timeValue = `${String(form.hour).padStart(2, '0')}:${String(form.minute).padStart(2, '0')}`;
  const handleTimeChange = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      updateForm({ hour: h, minute: m });
    }
  };

  const renderScheduleRow = () => {
    if (isAdvanced) {
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="rounded-lg bg-surface-raised/30 p-3">
            <p className="text-sm text-secondary">
              {formatScheduleLabel(task!.schedule)}
            </p>
            <p className="text-xs text-secondary mt-1">
              {i18nService.t('scheduledTasksAdvancedSchedule')}
            </p>
          </div>
        </div>
      );
    }

    const planSelect = (
      <select
        value={form.planType}
        onChange={(event) => updateForm({ planType: event.target.value as PlanType })}
        className={`${inputClass} flex-1 min-w-0`}
      >
        <option value="once">{i18nService.t('scheduledTasksFormScheduleModeOnce')}</option>
        <option value="daily">{i18nService.t('scheduledTasksFormScheduleModeDaily')}</option>
        <option value="weekly">{i18nService.t('scheduledTasksFormScheduleModeWeekly')}</option>
        <option value="monthly">{i18nService.t('scheduledTasksFormScheduleModeMonthly')}</option>
      </select>
    );

    if (form.planType === 'once') {
      const dateValue = `${form.year}-${String(form.month).padStart(2, '0')}-${String(form.day).padStart(2, '0')}`;
      const fullTimeValue = `${timeValue}:${String(form.second).padStart(2, '0')}`;
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="flex items-center gap-3">
            {planSelect}
            <input
              type="date"
              value={dateValue}
              onChange={(e) => {
                const [y, mo, d] = e.target.value.split('-').map(Number);
                if (!Number.isNaN(y)) updateForm({ year: y, month: mo, day: d });
              }}
              className={`${inputClass} flex-1 min-w-0`}
            />
            <input
              type="time"
              step="1"
              value={fullTimeValue}
              onChange={(e) => {
                const parts = e.target.value.split(':').map(Number);
                const patch: Partial<FormState> = {};
                if (!Number.isNaN(parts[0])) patch.hour = parts[0];
                if (!Number.isNaN(parts[1])) patch.minute = parts[1];
                if (parts.length > 2 && !Number.isNaN(parts[2])) patch.second = parts[2];
                updateForm(patch);
              }}
              className={`${inputClass} flex-1 min-w-0`}
            />
          </div>
        </div>
      );
    }

    if (form.planType === 'daily') {
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="flex items-center gap-3">
            {planSelect}
            <input
              type="time"
              value={timeValue}
              onChange={(e) => handleTimeChange(e.target.value)}
              className={`${inputClass} flex-1 min-w-0`}
            />
          </div>
        </div>
      );
    }

    if (form.planType === 'weekly') {
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="flex items-center gap-3">
            {planSelect}
            <select
              value={form.weekday}
              onChange={(e) => updateForm({ weekday: Number(e.target.value) })}
              className={`${inputClass} flex-1 min-w-0`}
            >
              {WEEKDAY_KEYS.map((key, idx) => (
                <option key={idx} value={idx}>{i18nService.t(key)}</option>
              ))}
            </select>
            <input
              type="time"
              value={timeValue}
              onChange={(e) => handleTimeChange(e.target.value)}
              className={`${inputClass} flex-1 min-w-0`}
            />
          </div>
        </div>
      );
    }

    return (
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
        <div className="flex items-center gap-3">
          {planSelect}
          <select
            value={form.monthDay}
            onChange={(e) => updateForm({ monthDay: Number(e.target.value) })}
            className={`${inputClass} flex-1 min-w-0`}
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}{i18nService.t('scheduledTasksFormMonthDaySuffix')}
              </option>
            ))}
          </select>
          <input
            type="time"
            value={timeValue}
            onChange={(e) => handleTimeChange(e.target.value)}
            className={`${inputClass} flex-1 min-w-0`}
          />
        </div>
      </div>
    );
  };

  const renderNotifyRow = () => {
    return (
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormNotifyChannel')}</label>
        <div className="flex items-center gap-3">
          <select
            value={form.notifyChannel}
            onChange={(event) => updateForm({ notifyChannel: event.target.value, notifyTo: '' })}
            className={`${inputClass} ${showConversationSelector ? 'flex-1 min-w-0' : ''}`}
          >
            <option value="none">{i18nService.t('scheduledTasksFormNotifyChannelNone')}</option>
            {channelOptions.map((channel) => {
              const unsupported = channel.value === 'openclaw-weixin' || channel.value === 'qqbot' || channel.value === 'netease-bee';
              return (
                <option key={channel.value} value={channel.value} disabled={unsupported}>
                  {unsupported
                    ? `${channel.label} (${i18nService.t('scheduledTasksChannelUnsupported')})`
                    : channel.label}
                </option>
              );
            })}
          </select>
          {showConversationSelector && (
            <select
              value={form.notifyTo}
              onChange={(event) => updateForm({ notifyTo: event.target.value })}
              disabled={conversationsLoading}
              className={`${inputClass} flex-1 min-w-0`}
            >
              {conversationsLoading ? (
                <option value="">{i18nService.t('scheduledTasksFormNotifyConversationLoading')}</option>
              ) : conversations.length === 0 ? (
                <option value="">{i18nService.t('scheduledTasksFormNotifyConversationNone')}</option>
              ) : (
                conversations.map((conv) => (
                  <option key={conv.conversationId} value={conv.conversationId}>
                    {conv.conversationId}
                  </option>
                ))
              )}
            </select>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 space-y-4 max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold text-foreground">
        {mode === 'create' ? i18nService.t('scheduledTasksFormCreate') : i18nService.t('scheduledTasksFormUpdate')}
      </h2>

      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormName')}</label>
        <input
          type="text"
          value={form.name}
          onChange={(event) => updateForm({ name: event.target.value })}
          className={inputClass}
          placeholder={i18nService.t('scheduledTasksFormNamePlaceholder')}
        />
        {errors.name && <p className={errorClass}>{errors.name}</p>}
      </div>

      <div>
        <label className={labelClass}>
          {i18nService.t('scheduledTasksFormPayloadTextAgent')}
        </label>
        <textarea
          value={form.payloadText}
          onChange={(event) => updateForm({ payloadText: event.target.value })}
          className={`${inputClass} h-28 resize-none`}
          placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
        />
        {errors.payloadText && <p className={errorClass}>{errors.payloadText}</p>}
      </div>

      {renderScheduleRow()}
      {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}

      {renderNotifyRow()}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          {submitting
            ? i18nService.t('saving')
            : mode === 'create'
              ? i18nService.t('scheduledTasksFormCreate')
              : i18nService.t('scheduledTasksFormUpdate')}
        </button>
      </div>
    </div>
  );
};

export default TaskForm;
