import React, { useEffect, useState } from 'react';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import {
  parseSchedule,
  isParseError,
  getNextRunDates,
  formatNextRunDate,
} from '../../services/scheduleParser';
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
  naturalLanguage: string;
  scheduleKind: 'cron' | 'at' | '';
  cronExpr: string;
  atTime: string;
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

function isIMChannel(channel: string): boolean {
  return PlatformRegistry.isIMChannel(channel);
}

function createFormState(task?: ScheduledTask): FormState {
  const base: FormState = {
    name: '',
    naturalLanguage: '',
    scheduleKind: '',
    cronExpr: '',
    atTime: '',
    planType: 'daily',
    ...nowDefaults(),
    weekday: 1,
    monthDay: 1,
    payloadText: '',
    notifyChannel: 'none',
    notifyTo: '',
  };

  if (!task) return base;

  const planInfo = scheduleToPlanInfo(task.schedule);
  const schedule = task.schedule;

  return {
    ...base,
    name: task.name,
    naturalLanguage: task.description || '',
    scheduleKind: schedule.kind === 'cron' ? 'cron' : '',
    cronExpr: schedule.kind === 'cron' ? schedule.expr : '',
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

function isAdvancedSchedule(task?: ScheduledTask): boolean {
  if (!task) return false;
  return task.schedule.kind === 'at' || task.schedule.kind === 'every';
}

function buildFallbackSchedule(form: FormState): ScheduledTaskInput['schedule'] {
  if (form.planType === 'once') {
    const date = new Date(form.year, form.month - 1, form.day, form.hour, form.minute, form.second);
    return { kind: 'at', at: date.toISOString() };
  }
  const min = String(form.minute);
  const hr = String(form.hour);
  if (form.planType === 'daily') return { kind: 'cron', expr: `${min} ${hr} * * *` };
  if (form.planType === 'weekly') return { kind: 'cron', expr: `${min} ${hr} * * ${form.weekday}` };
  return { kind: 'cron', expr: `${min} ${hr} ${form.monthDay} * *` };
}

function buildLLMSchedule(form: FormState): ScheduledTaskInput['schedule'] {
  if (form.scheduleKind === 'at') return { kind: 'at', at: form.atTime };
  return { kind: 'cron', expr: form.cronExpr };
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
  const [useLLM, setUseLLM] = useState(() => {
    // Editing: restore mode from save time (description non-empty → LLM, empty → GUI)
    if (mode === 'edit' && task) return !!task.description;
    // Creating: default to LLM natural language input
    return true;
  });
  // In edit mode, lock the input mode — user cannot switch after saving
  const modeLocked = mode === 'edit';
  const [form, setForm] = useState<FormState>(() => createFormState(task));
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState('');
  const [nextRuns, setNextRuns] = useState<Date[]>([]);
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

  const advanced = isAdvancedSchedule(task);
  const showConversationSelector = isIMChannel(form.notifyChannel);

  useEffect(() => {
    setForm(createFormState(task));
    setConvertError('');
    setNextRuns([]);
  }, [task?.id]);

  useEffect(() => {
    if (useLLM && form.scheduleKind === 'cron' && form.cronExpr) {
      setNextRuns(getNextRunDates(form.cronExpr, 5));
    } else {
      setNextRuns([]);
    }
  }, [useLLM, form.scheduleKind, form.cronExpr]);

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

  const handleConvert = async () => {
    setConvertError('');
    setConverting(true);
    const outcome = await parseSchedule(form.naturalLanguage);
    setConverting(false);
    if (isParseError(outcome)) {
      setConvertError(outcome.error);
    } else if (outcome.kind === 'at') {
      updateForm({ scheduleKind: 'at', atTime: outcome.at, cronExpr: '' });
      setConvertError('');
    } else {
      updateForm({ scheduleKind: 'cron', cronExpr: outcome.cronExpr, atTime: '' });
      setConvertError('');
    }
  };

  const validate = (): boolean => {
    const nextErrors: Record<string, string> = {};

    if (!form.name.trim()) {
      nextErrors.name = i18nService.t('scheduledTasksFormValidationNameRequired');
    }
    if (!form.payloadText.trim()) {
      nextErrors.payloadText = i18nService.t('scheduledTasksFormValidationPromptRequired');
    }

    if (!advanced) {
      if (useLLM && form.scheduleKind === '') {
        nextErrors.schedule = i18nService.t('scheduleParserNotConverted');
      }
      if (!useLLM) {
        if (form.planType === 'once') {
          const runAt = new Date(form.year, form.month - 1, form.day, form.hour, form.minute, form.second);
          if (runAt.getTime() <= Date.now()) {
            nextErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
          }
        }
        if (form.hour < 0 || form.hour > 23 || form.minute < 0 || form.minute > 59) {
          nextErrors.schedule = i18nService.t('scheduledTasksFormValidationTimeRequired');
        }
      }
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setSubmitting(true);
    try {
      const schedule = advanced && task
        ? task.schedule
        : useLLM
          ? buildLLMSchedule(form)
          : buildFallbackSchedule(form);

      const input: ScheduledTaskInput = {
        name: form.name.trim(),
        description: useLLM ? form.naturalLanguage.trim() : '',
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

  const inputClass = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50';
  const labelClass = 'block text-sm font-medium dark:text-claude-darkText text-claude-text mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';

  const timeValue = `${String(form.hour).padStart(2, '0')}:${String(form.minute).padStart(2, '0')}`;
  const handleTimeChange = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      updateForm({ hour: h, minute: m });
    }
  };

  const renderFallbackSchedule = () => {
    const planSelect = (
      <select
        value={form.planType}
        onChange={(e) => updateForm({ planType: e.target.value as PlanType })}
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
      );
    }

    if (form.planType === 'daily') {
      return (
        <div className="flex items-center gap-3">
          {planSelect}
          <input
            type="time"
            value={timeValue}
            onChange={(e) => handleTimeChange(e.target.value)}
            className={`${inputClass} flex-1 min-w-0`}
          />
        </div>
      );
    }

    if (form.planType === 'weekly') {
      return (
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
      );
    }

    return (
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
    );
  };

  const renderScheduleSection = () => {
    if (advanced) {
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduleParserLabel')}</label>
          <div className="rounded-lg bg-claude-surfaceHover/30 dark:bg-claude-darkSurfaceHover/30 p-3">
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {formatScheduleLabel(task!.schedule)}
            </p>
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
              {i18nService.t('scheduledTasksAdvancedSchedule')}
            </p>
          </div>
        </div>
      );
    }

    const modeToggle = (
      <div className="flex items-center gap-1 mb-2">
        <button
          type="button"
          onClick={() => !modeLocked && setUseLLM(true)}
          disabled={modeLocked}
          className={`px-3 py-1 text-xs rounded-l-md border transition-colors ${
            useLLM
              ? 'bg-claude-accent text-white border-claude-accent'
              : 'dark:bg-claude-darkSurface bg-white dark:text-claude-darkTextSecondary text-claude-textSecondary border-claude-border dark:border-claude-darkBorder'
          } ${modeLocked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {i18nService.t('scheduledTasksScheduleModeNL')}
        </button>
        <button
          type="button"
          onClick={() => !modeLocked && setUseLLM(false)}
          disabled={modeLocked}
          className={`px-3 py-1 text-xs rounded-r-md border transition-colors ${
            !useLLM
              ? 'bg-claude-accent text-white border-claude-accent'
              : 'dark:bg-claude-darkSurface bg-white dark:text-claude-darkTextSecondary text-claude-textSecondary border-claude-border dark:border-claude-darkBorder'
          } ${modeLocked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {i18nService.t('scheduledTasksScheduleModeGUI')}
        </button>
      </div>
    );

    if (!useLLM) {
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          {modeToggle}
          {renderFallbackSchedule()}
          {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          {modeToggle}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={form.naturalLanguage}
              onChange={(e) => {
                updateForm({ naturalLanguage: e.target.value });
                if (convertError) setConvertError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !converting) {
                  e.preventDefault();
                  void handleConvert();
                }
              }}
              placeholder={i18nService.t('scheduleParserPlaceholder')}
              className={`${inputClass} flex-1`}
              disabled={converting}
            />
            <button
              type="button"
              onClick={() => void handleConvert()}
              disabled={converting || !form.naturalLanguage.trim()}
              className="shrink-0 px-3 py-2 text-sm font-medium bg-claude-accent text-white rounded-lg hover:bg-claude-accentHover transition-colors disabled:opacity-50"
            >
              {converting
                ? i18nService.t('scheduleParserConverting')
                : i18nService.t('scheduleParserConvertButton')}
            </button>
          </div>
          {convertError && <p className={errorClass}>{convertError}</p>}
          {errors.schedule && !convertError && <p className={errorClass}>{errors.schedule}</p>}
        </div>

        {form.scheduleKind === 'cron' && form.cronExpr && (
          <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surfaceHover/30 px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                {i18nService.t('scheduleParserCronLabel')}
              </span>
              <code className="text-sm font-mono dark:text-claude-darkText text-claude-text select-all">
                {form.cronExpr}
              </code>
            </div>

            {nextRuns.length > 0 && (
              <div>
                <p className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('scheduleParserNextRunsLabel')}
                </p>
                <ol className="space-y-0.5">
                  {nextRuns.map((date, idx) => (
                    <li
                      key={idx}
                      className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary flex items-center gap-2"
                    >
                      <span className="w-4 text-right shrink-0 opacity-50">{idx + 1}.</span>
                      {formatNextRunDate(date)}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {form.scheduleKind === 'at' && form.atTime && (
          <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surfaceHover/30 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                {i18nService.t('scheduleParserRunAt')}
              </span>
              <span className="text-sm dark:text-claude-darkText text-claude-text">
                {formatNextRunDate(new Date(form.atTime))}
              </span>
            </div>
          </div>
        )}
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
      <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
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

      {renderScheduleSection()}

      {renderNotifyRow()}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium bg-claude-accent text-white rounded-lg hover:bg-claude-accentHover transition-colors disabled:opacity-50"
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
