import { PlatformRegistry } from '@shared/platform';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskConversationOption,
  ScheduledTaskInput,
} from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import ModelSelector from '../ModelSelector';
import { formatScheduleLabel, type PlanType, scheduleToPlanInfo } from './utils';

interface TaskFormProps {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
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
  weekdays: number[];
  monthDay: number;
  payloadText: string;
  notifyChannel: string;
  notifyTo: string;
  notifyAccountId: string | undefined;
  modelId: string;
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
  weekdays: [1, 2, 3, 4, 5],
  monthDay: 1,
  payloadText: '',
  notifyChannel: 'none',
  notifyTo: '',
  notifyAccountId: undefined,
  modelId: '',
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
    weekdays: planInfo.weekdays,
    monthDay: planInfo.monthDay,
    payloadText: task.payload.kind === 'systemEvent' ? task.payload.text : task.payload.message,
    notifyChannel: task.delivery.channel || 'none',
    notifyTo: task.delivery.to || '',
    notifyAccountId: task.delivery.accountId,
    modelId: task.payload.kind === 'agentTurn' ? (task.payload.model ?? '') : '',
  };
}

function buildScheduleInput(form: FormState): ScheduledTaskInput['schedule'] {
  if (form.planType === 'once') {
    const date = new Date(form.year, form.month - 1, form.day, form.hour, form.minute, form.second);
    return { kind: 'at', at: date.toISOString() };
  }

  const min = String(form.minute);
  const hr = String(form.hour);

  if (form.planType === 'hourly') {
    return { kind: 'cron', expr: `${min} * * * *` };
  }

  if (form.planType === 'daily') {
    return { kind: 'cron', expr: `${min} ${hr} * * *` };
  }

  if (form.planType === 'weekly') {
    const dowField = [...form.weekdays].sort((a, b) => a - b).join(',');
    return { kind: 'cron', expr: `${min} ${hr} * * ${dowField}` };
  }

  return { kind: 'cron', expr: `${min} ${hr} ${form.monthDay} * *` };
}

const TaskForm: React.FC<TaskFormProps> = ({ mode, task, onCancel, onSaved, onDirtyChange }) => {
  const [form, setForm] = useState<FormState>(() => createFormState(task));
  const initialFormRef = useRef<string>(JSON.stringify(createFormState(task)));
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const [channelOptions, setChannelOptions] = useState<ScheduledTaskChannelOption[]>(() => {
    const base: ScheduledTaskChannelOption[] = [];
    const savedChannel = task?.delivery.channel;
    if (savedChannel && isIMChannel(savedChannel) && !base.some((o) => o.value === savedChannel)) {
      const platform = PlatformRegistry.platformOfChannel(savedChannel);
      const label = platform ? PlatformRegistry.get(platform).label : savedChannel;
      base.push({ value: savedChannel, label });
    }
    return base;
  });
  const [conversations, setConversations] = useState<ScheduledTaskConversationOption[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isDirty = JSON.stringify(form) !== initialFormRef.current;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

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
        // Use the server-returned order (DEFINITIONS order) as the base,
        // then append any saved channel that is not in the list (e.g. disabled platform).
        const next = [...channels];
        for (const saved of current) {
          if (!next.some((item) => item.value === saved.value)) {
            next.push(saved);
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
    void scheduledTaskService.listChannelConversations(form.notifyChannel, form.notifyAccountId).then((result) => {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.notifyChannel, form.notifyAccountId]);

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

    if (form.planType === 'weekly' && form.weekdays.length === 0) {
      nextErrors.schedule = i18nService.t('scheduledTasksFormValidationWeekdayRequired');
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setSubmitting(true);
    setSubmitError(null);
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
          ...(form.modelId ? { model: form.modelId } : {}),
        },
        delivery: form.notifyChannel === 'none'
          ? { mode: 'none' }
          : {
              mode: 'announce',
              channel: form.notifyChannel,
              ...(form.notifyTo ? { to: form.notifyTo } : {}),
              ...(form.notifyAccountId ? { accountId: form.notifyAccountId } : {}),
            },
      };

      if (mode === 'create') {
        await scheduledTaskService.createTask(input);
      } else if (task) {
        await scheduledTaskService.updateTaskById(task.id, input);
      }
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50';
  const textareaInputClass = 'w-full rounded-t-lg px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none resize-none bg-transparent';
  const labelClass = 'block text-sm font-medium dark:text-claude-darkText text-claude-text mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';

  const selectedModelValue: Model | null = form.modelId
    ? availableModels.find((m) => toOpenClawModelRef(m) === form.modelId) ?? null
    : null;

  const handleModelChange = (model: Model | null) => {
    updateForm({ modelId: model ? toOpenClawModelRef(model) : '' });
  };

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
        <option value="hourly">{i18nService.t('scheduledTasksFormScheduleModeHourly')}</option>
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

    if (form.planType === 'hourly') {
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="flex items-center gap-3">
            {planSelect}
            <select
              value={form.minute}
              onChange={(e) => updateForm({ minute: Number(e.target.value) })}
              className="w-20 shrink-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text text-center focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
            >
              {Array.from({ length: 60 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
              ))}
            </select>
            <span className="shrink-0 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('scheduledTasksFormHourlyMinuteSuffix')}</span>
          </div>
        </div>
      );
    }

    if (form.planType === 'weekly') {
      // Locale-aware weekday order:
      // zh: Mon(1)→Sun(0) �?Chinese convention starts with Monday
      // en: Sun(0)→Sat(6) �?English convention starts with Sunday
      const WEEKDAY_SHORT_LABELS: [string, number][] =
        i18nService.getLanguage() === 'zh'
          ? [
              ['scheduledTasksFormWeekShortMon', 1],
              ['scheduledTasksFormWeekShortTue', 2],
              ['scheduledTasksFormWeekShortWed', 3],
              ['scheduledTasksFormWeekShortThu', 4],
              ['scheduledTasksFormWeekShortFri', 5],
              ['scheduledTasksFormWeekShortSat', 6],
              ['scheduledTasksFormWeekShortSun', 0],
            ]
          : [
              ['scheduledTasksFormWeekShortSun', 0],
              ['scheduledTasksFormWeekShortMon', 1],
              ['scheduledTasksFormWeekShortTue', 2],
              ['scheduledTasksFormWeekShortWed', 3],
              ['scheduledTasksFormWeekShortThu', 4],
              ['scheduledTasksFormWeekShortFri', 5],
              ['scheduledTasksFormWeekShortSat', 6],
            ];

      const toggleWeekday = (day: number) => {
        const current = form.weekdays;
        const next = current.includes(day)
          ? current.filter((d) => d !== day)
          : [...current, day];
        updateForm({ weekdays: next });
      };

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
          <div className="flex items-center gap-2 mt-2">
            {WEEKDAY_SHORT_LABELS.map(([key, dayValue]) => {
              const selected = form.weekdays.includes(dayValue);
              return (
                <button
                  key={dayValue}
                  type="button"
                  onClick={() => toggleWeekday(dayValue)}
                  className={`w-9 h-9 rounded-full text-sm font-medium transition-colors ${
                    selected
                      ? 'bg-claude-text dark:bg-claude-darkText text-white dark:text-claude-darkBg'
                      : 'border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                  }`}
                >
                  {i18nService.t(key)}
                </button>
              );
            })}
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

  const [channelDropdownOpen, setChannelDropdownOpen] = useState(false);
  const channelDropdownRef = React.useRef<HTMLDivElement>(null);
  const [convDropdownOpen, setConvDropdownOpen] = useState(false);
  const convDropdownRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (channelDropdownRef.current && !channelDropdownRef.current.contains(event.target as Node)) {
        setChannelDropdownOpen(false);
      }
      if (convDropdownRef.current && !convDropdownRef.current.contains(event.target as Node)) {
        setConvDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getChannelLogo = (channelValue: string): string | null => {
    const platform = PlatformRegistry.platformOfChannel(channelValue);
    if (platform) {
      return PlatformRegistry.logo(platform);
    }
    return null;
  };

  const isChannelUnsupported = (channelValue: string): boolean => {
    return channelValue === 'openclaw-weixin';
  };

  const getChannelDisplayLabel = (channelValue: string): string => {
    if (channelValue === 'none') return i18nService.t('scheduledTasksFormNotifyChannelNone');
    // Use i18n translation for platform name (e.g. weixin �?'微信', feishu �?'飞书')
    const platform = PlatformRegistry.platformOfChannel(channelValue);
    if (platform) {
      const label = i18nService.t(platform) || PlatformRegistry.get(platform).label;
      return isChannelUnsupported(channelValue) ? `${label} (${i18nService.t('scheduledTasksChannelUnsupported')})` : label;
    }
    const option = channelOptions.find(c => c.value === channelValue);
    return option ? option.label : channelValue;
  };

  const renderNotifyRow = () => {
    const selectedLogo = getChannelLogo(form.notifyChannel);
    return (
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormNotifyChannel')}</label>
        <div className="flex items-center gap-3">
          <div className={`relative ${showConversationSelector ? 'flex-1 min-w-0' : 'w-full'}`} ref={channelDropdownRef}>
            <button
              type="button"
              onClick={() => setChannelDropdownOpen(!channelDropdownOpen)}
              className={`${inputClass} w-full flex items-center justify-between cursor-pointer`}
            >
              <span className="flex items-center gap-2 truncate">
                {selectedLogo && (
                  <img src={selectedLogo} alt="" className="w-5 h-5 object-contain rounded" />
                )}
                <span className="truncate">{(() => {
                  const base = getChannelDisplayLabel(form.notifyChannel);
                  if (!form.notifyAccountId) return base;
                  const selected = channelOptions.find(
                    (o) => o.value === form.notifyChannel && o.accountId === form.notifyAccountId,
                  );
                  return selected ? `${base} · ${selected.label}` : base;
                })()}</span>
              </span>
              <svg className={`w-4 h-4 ml-2 flex-shrink-0 transition-transform ${channelDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {channelDropdownOpen && (
              <div className="absolute z-50 w-full mt-1 rounded-xl border border-border bg-surface shadow-lg overflow-hidden">
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-raised transition-colors"
                  onClick={() => { updateForm({ notifyChannel: 'none', notifyTo: '', notifyAccountId: undefined }); setChannelDropdownOpen(false); }}
                >
                  <span className="w-5 h-5" />
                  <span className="text-sm text-foreground">{i18nService.t('scheduledTasksFormNotifyChannelNone')}</span>
                </div>
                {channelOptions.map((channel) => {
                  const unsupported = isChannelUnsupported(channel.value);
                  const logo = getChannelLogo(channel.value);
                  const platform = PlatformRegistry.platformOfChannel(channel.value);
                  const platformLabel = platform ? (i18nService.t(platform) || channel.label) : channel.label;
                  // For multi-instance options, show "平台 · 实例名"; for single-instance use platform label only.
                  const displayName = channel.accountId ? `${platformLabel} · ${channel.label}` : platformLabel;
                  const isActive = form.notifyChannel === channel.value &&
                    (channel.accountId ? form.notifyAccountId === channel.accountId : !form.notifyAccountId);
                  return (
                    <div
                      key={`${channel.value}:${channel.accountId ?? ''}`}
                      className={`flex items-center gap-2 px-3 py-2 transition-colors ${
                        unsupported
                          ? 'opacity-50 cursor-not-allowed'
                          : 'cursor-pointer hover:bg-surface-raised'
                      } ${isActive ? 'bg-surface-raised' : ''}`}
                      onClick={() => {
                        if (!unsupported) {
                          updateForm({ notifyChannel: channel.value, notifyTo: '', notifyAccountId: channel.accountId });
                          setChannelDropdownOpen(false);
                        }
                      }}
                    >
                      {logo ? (
                        <img src={logo} alt={displayName} className="w-5 h-5 object-contain rounded" />
                      ) : (
                        <span className="w-5 h-5" />
                      )}
                      <span className={`text-sm ${unsupported ? 'text-foreground-secondary' : 'text-foreground'}`}>
                        {unsupported
                          ? `${displayName} (${i18nService.t('scheduledTasksChannelUnsupported')})`
                          : displayName}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {showConversationSelector && (
            <div className="relative flex-1 min-w-0" ref={convDropdownRef}>
              <button
                type="button"
                onClick={() => { if (!conversationsLoading) setConvDropdownOpen(!convDropdownOpen); }}
                disabled={conversationsLoading}
                className={`${inputClass} w-full flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className="truncate text-sm">
                  {conversationsLoading
                    ? i18nService.t('scheduledTasksFormNotifyConversationLoading')
                    : form.notifyTo || i18nService.t('scheduledTasksFormNotifyConversationNone')}
                </span>
                <svg className={`w-4 h-4 ml-2 flex-shrink-0 transition-transform ${convDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {convDropdownOpen && !conversationsLoading && (
                <div className="absolute z-50 w-full mt-1 rounded-xl border border-border bg-surface shadow-lg overflow-hidden">
                  {conversations.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-foreground-secondary">
                      {i18nService.t('scheduledTasksFormNotifyConversationNone')}
                    </div>
                  ) : (
                    conversations.map((conv) => (
                      <div
                        key={conv.conversationId}
                        className={`px-3 py-2 text-sm cursor-pointer hover:bg-surface-raised transition-colors truncate ${form.notifyTo === conv.conversationId ? 'bg-surface-raised text-foreground' : 'text-foreground'}`}
                        onClick={() => { updateForm({ notifyTo: conv.conversationId }); setConvDropdownOpen(false); }}
                      >
                        {conv.conversationId}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
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
        <label className={labelClass}>{i18nService.t('scheduledTasksFormName')}<span className="text-red-400 text-xs ml-0.5">*</span></label>
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
          {i18nService.t('scheduledTasksFormPayloadTextAgent')}<span className="text-red-400 text-xs ml-0.5">*</span>
        </label>
        <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white focus-within:ring-1 focus-within:ring-claude-accent/40 focus-within:border-claude-accent">
          <textarea
            value={form.payloadText}
            onChange={(event) => updateForm({ payloadText: event.target.value })}
            className={textareaInputClass}
            placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
            rows={4}
          />
          <div className="flex items-center px-2 py-1">
            <ModelSelector
              dropdownDirection="up"
              value={selectedModelValue}
              onChange={handleModelChange}
              defaultLabel={i18nService.t('scheduledTasksFormModelDefault')}
            />
          </div>
        </div>
        {errors.payloadText && <p className={errorClass}>{errors.payloadText}</p>}
      </div>

      {renderScheduleRow()}
      {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}

      {renderNotifyRow()}

      {submitError && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40">
          <span className="text-sm text-red-600 dark:text-red-400 break-words min-w-0">
            {i18nService.t('scheduledTasksFormSubmitError')}{submitError}
          </span>
          <button
            type="button"
            onClick={() => setSubmitError(null)}
            className="shrink-0 ml-auto p-0.5 text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors"
            aria-label="dismiss"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

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
