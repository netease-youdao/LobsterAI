import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
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
import type { RootState } from '../../store';

interface TaskFormProps {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  onCancel: () => void;
  onSaved: (newTaskId?: string) => void;
}

interface CronBuilder {
  minute: string;   // e.g. '0', '*/5', '*/15', '*/30', '*'
  hour: string;     // e.g. '9', '*/2', '*'
  dom: string;      // e.g. '*', '1', '15'
  month: string;    // e.g. '*'
  dow: string;      // e.g. '*', '1-5', '1', '0'
}

const DEFAULT_CRON_BUILDER: CronBuilder = {
  minute: '0',
  hour: '9',
  dom: '*',
  month: '*',
  dow: '*',
};

function cronBuilderToExpr(b: CronBuilder): string {
  return `${b.minute} ${b.hour} ${b.dom} ${b.month} ${b.dow}`;
}

/** Best-effort parse of a 5-field cron expr into builder fields. */
function exprToCronBuilder(expr: string): CronBuilder | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  return { minute, hour, dom, month, dow };
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
  cronExpr: string;
  cronTz: string;
  cronMode: 'builder' | 'raw';
  cronBuilder: CronBuilder;
  agentId: string;
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
  cronExpr: '',
  cronTz: '',
  cronMode: 'builder',
  cronBuilder: { ...DEFAULT_CRON_BUILDER },
  agentId: '',
};

// Cron quick-pick examples: [label key, expr]
const CRON_QUICK_PICKS: Array<{ labelKey: string; expr: string }> = [
  { labelKey: 'scheduledTasksFormCronQuickEveryDay', expr: '0 9 * * *' },
  { labelKey: 'scheduledTasksFormCronQuickWeekday', expr: '0 9 * * 1-5' },
  { labelKey: 'scheduledTasksFormCronQuickEveryHour', expr: '0 * * * *' },
  { labelKey: 'scheduledTasksFormCronQuickEvery15min', expr: '*/15 * * * *' },
];

// Prompt template quick-picks: [label key, text key]
const PROMPT_TEMPLATES: Array<{ labelKey: string; textKey: string }> = [
  {
    labelKey: 'scheduledTasksFormPromptTemplateDailySummary',
    textKey: 'scheduledTasksFormPromptTemplateDailySummaryText',
  },
  {
    labelKey: 'scheduledTasksFormPromptTemplateDataCheck',
    textKey: 'scheduledTasksFormPromptTemplateDataCheckText',
  },
  {
    labelKey: 'scheduledTasksFormPromptTemplateCodeReview',
    textKey: 'scheduledTasksFormPromptTemplateCodeReviewText',
  },
];

function isIMChannel(channel: string): boolean {
  return PlatformRegistry.isIMChannel(channel);
}

function createFormState(task?: ScheduledTask): FormState {
  if (!task) return { ...DEFAULT_FORM_STATE, ...nowDefaults() };

  const planInfo = scheduleToPlanInfo(task.schedule);
  const rawCronExpr = planInfo.cronExpr ?? (task.schedule.kind === 'cron' ? task.schedule.expr : '');
  const parsedBuilder = rawCronExpr ? (exprToCronBuilder(rawCronExpr) ?? { ...DEFAULT_CRON_BUILDER }) : { ...DEFAULT_CRON_BUILDER };

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
    cronExpr: rawCronExpr,
    cronTz: planInfo.cronTz ?? (task.schedule.kind === 'cron' ? (task.schedule.tz ?? '') : ''),
    cronMode: 'builder',
    cronBuilder: parsedBuilder,
    agentId: task.agentId ?? '',
  };
}

function buildScheduleInput(form: FormState): ScheduledTaskInput['schedule'] {
  if (form.planType === 'once') {
    const date = new Date(form.year, form.month - 1, form.day, form.hour, form.minute, form.second);
    return { kind: 'at', at: date.toISOString() };
  }

  if (form.planType === 'cron') {
    const expr = form.cronMode === 'builder'
      ? cronBuilderToExpr(form.cronBuilder)
      : form.cronExpr.trim();
    const schedule: ScheduledTaskInput['schedule'] & { kind: 'cron' } = {
      kind: 'cron',
      expr,
    };
    if (form.cronTz.trim()) {
      schedule.tz = form.cronTz.trim();
    }
    return schedule;
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

// Returns the human-readable cron description, or null if the expression is
// syntactically invalid (wrong number of fields, parse error).
// Distinguishes from an empty/blank expression which returns null without error.
function previewCron(expr: string): { ok: true; label: string } | { ok: false } | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { ok: false };
  try {
    const label = formatScheduleLabel({ kind: 'cron', expr: trimmed });
    return { ok: true, label };
  } catch {
    return { ok: false };
  }
}

const TaskForm: React.FC<TaskFormProps> = ({ mode, task, onCancel, onSaved }) => {
  const [form, setForm] = useState<FormState>(() => createFormState(task));
  const agents = useSelector((state: RootState) => state.agent.agents.filter((a) => a.enabled));
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
  const [cronPreview, setCronPreview] = useState<{ ok: true; label: string } | { ok: false } | null>(null);

  const isAdvanced = form.planType === 'advanced';
  const isCron = form.planType === 'cron';
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

  // Live cron preview
  useEffect(() => {
    if (!isCron) {
      setCronPreview(null);
      return;
    }
    const expr = form.cronMode === 'builder'
      ? cronBuilderToExpr(form.cronBuilder)
      : form.cronExpr;
    setCronPreview(previewCron(expr));
  }, [isCron, form.cronMode, form.cronExpr, form.cronBuilder]);

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

    if (form.planType === 'cron') {
      const expr = form.cronMode === 'builder'
        ? cronBuilderToExpr(form.cronBuilder)
        : form.cronExpr.trim();
      if (!expr) {
        nextErrors.schedule = i18nService.t('scheduledTasksFormValidationCronRequired');
      } else {
        const parts = expr.split(/\s+/);
        if (parts.length !== 5) {
          nextErrors.schedule = i18nService.t('scheduledTasksFormCronInputHint');
        }
      }
    }

    if (!isAdvanced && !isCron && (form.hour < 0 || form.hour > 23 || form.minute < 0 || form.minute > 59)) {
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
        agentId: form.agentId || null,
      };

      if (mode === 'create') {
        const newId = await scheduledTaskService.createTask(input);
        onSaved(newId ?? undefined);
      } else if (task) {
        await scheduledTaskService.updateTaskById(task.id, input);
        onSaved();
      }
    } catch {
      // Service handles error state.
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';
  const labelClass = 'block text-sm font-medium text-foreground mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';
  const hintClass = 'text-xs text-secondary mt-1';

  const timeValue = `${String(form.hour).padStart(2, '0')}:${String(form.minute).padStart(2, '0')}`;
  const handleTimeChange = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      updateForm({ hour: h, minute: m });
    }
  };

  const renderPlanSelect = () => (
    <select
      value={form.planType}
      onChange={(event) => updateForm({ planType: event.target.value as PlanType })}
      className={`${inputClass} flex-1 min-w-0`}
    >
      <option value="once">{i18nService.t('scheduledTasksFormScheduleModeOnce')}</option>
      <option value="daily">{i18nService.t('scheduledTasksFormScheduleModeDaily')}</option>
      <option value="weekly">{i18nService.t('scheduledTasksFormScheduleModeWeekly')}</option>
      <option value="monthly">{i18nService.t('scheduledTasksFormScheduleModeMonthly')}</option>
      <option value="cron">{i18nService.t('scheduledTasksFormScheduleModeCronCustom')}</option>
    </select>
  );

  const renderCronSection = () => {
    // Derive current cron expression from builder or raw input
    const currentExpr = form.cronMode === 'builder'
      ? cronBuilderToExpr(form.cronBuilder)
      : form.cronExpr;

    const handleSwitchToRaw = () => {
      updateForm({ cronMode: 'raw', cronExpr: cronBuilderToExpr(form.cronBuilder) });
    };

    const handleSwitchToBuilder = () => {
      const parsed = exprToCronBuilder(form.cronExpr);
      if (parsed) {
        updateForm({ cronMode: 'builder', cronBuilder: parsed });
      } else {
        updateForm({ cronMode: 'builder' });
      }
    };

    const fieldSelectClass = `rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 flex-1 min-w-0`;

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          {renderPlanSelect()}
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-0 border border-border rounded-lg overflow-hidden w-fit">
          <button
            type="button"
            onClick={handleSwitchToBuilder}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              form.cronMode === 'builder'
                ? 'bg-primary text-white'
                : 'bg-surface text-secondary hover:bg-surface-raised'
            }`}
          >
            {i18nService.t('scheduledTasksFormCronModeBuilder' as Parameters<typeof i18nService.t>[0])}
          </button>
          <button
            type="button"
            onClick={handleSwitchToRaw}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              form.cronMode === 'raw'
                ? 'bg-primary text-white'
                : 'bg-surface text-secondary hover:bg-surface-raised'
            }`}
          >
            {i18nService.t('scheduledTasksFormCronModeRaw' as Parameters<typeof i18nService.t>[0])}
          </button>
        </div>

        {form.cronMode === 'builder' ? (
          <div className="rounded-lg border border-border bg-surface-raised/20 p-3 space-y-3">
            {/* Field labels */}
            <div className="grid grid-cols-5 gap-2">
              {(['minute', 'hour', 'dom', 'month', 'dow'] as const).map((field) => (
                <div key={field} className="text-center text-xs text-secondary font-medium">
                  {i18nService.t(`scheduledTasksFormCronField_${field}` as Parameters<typeof i18nService.t>[0])}
                </div>
              ))}
            </div>
            {/* Field selects */}
            <div className="grid grid-cols-5 gap-2">
              {/* Minute */}
              <select
                value={form.cronBuilder.minute}
                onChange={(e) => updateForm({ cronBuilder: { ...form.cronBuilder, minute: e.target.value } })}
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 60 }, (_, i) => (
                  <option key={i} value={String(i)}>{String(i).padStart(2, '0')}</option>
                ))}
                <option value="*/5">*/5</option>
                <option value="*/10">*/10</option>
                <option value="*/15">*/15</option>
                <option value="*/30">*/30</option>
              </select>
              {/* Hour */}
              <select
                value={form.cronBuilder.hour}
                onChange={(e) => updateForm({ cronBuilder: { ...form.cronBuilder, hour: e.target.value } })}
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={String(i)}>{String(i).padStart(2, '0')}</option>
                ))}
                <option value="*/2">*/2</option>
                <option value="*/4">*/4</option>
                <option value="*/6">*/6</option>
                <option value="*/12">*/12</option>
              </select>
              {/* DOM (day of month) */}
              <select
                value={form.cronBuilder.dom}
                onChange={(e) => updateForm({ cronBuilder: { ...form.cronBuilder, dom: e.target.value } })}
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={String(d)}>{d}</option>
                ))}
              </select>
              {/* Month */}
              <select
                value={form.cronBuilder.month}
                onChange={(e) => updateForm({ cronBuilder: { ...form.cronBuilder, month: e.target.value } })}
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={String(m)}>{m}</option>
                ))}
              </select>
              {/* DOW (day of week) */}
              <select
                value={form.cronBuilder.dow}
                onChange={(e) => updateForm({ cronBuilder: { ...form.cronBuilder, dow: e.target.value } })}
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {WEEKDAY_KEYS.map((key, idx) => (
                  <option key={idx} value={String(idx)}>{i18nService.t(key)}</option>
                ))}
                <option value="1-5">{i18nService.t('scheduledTasksCronWeekdays')}</option>
                <option value="0,6">{i18nService.t('scheduledTasksCronWeekends')}</option>
              </select>
            </div>
            {/* Generated expression preview */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-secondary font-mono bg-surface px-2 py-1 rounded border border-border flex-1 truncate">
                {currentExpr}
              </span>
              {cronPreview !== null && (
                <span className={`text-xs shrink-0 ${cronPreview.ok ? 'text-secondary' : 'text-red-500'}`}>
                  {cronPreview.ok ? cronPreview.label : i18nService.t('scheduledTasksFormCronPreviewInvalid')}
                </span>
              )}
            </div>
          </div>
        ) : (
          /* Raw expression input */
          <div>
            <input
              type="text"
              value={form.cronExpr}
              onChange={(e) => updateForm({ cronExpr: e.target.value })}
              placeholder={i18nService.t('scheduledTasksFormCronInputPlaceholder')}
              className={inputClass}
              spellCheck={false}
            />
            <p className={hintClass}>{i18nService.t('scheduledTasksFormCronInputHint')}</p>
            {/* Live preview */}
            {form.cronExpr.trim() && cronPreview !== null && (
              <div className={`mt-2 flex items-center gap-1.5 text-xs ${cronPreview.ok ? 'text-secondary' : 'text-red-500'}`}>
                {cronPreview.ok ? (
                  <>
                    <span className="opacity-60">{i18nService.t('scheduledTasksFormCronPreview')}</span>
                    <span className="font-medium">{cronPreview.label}</span>
                  </>
                ) : (
                  <span className="font-medium">{i18nService.t('scheduledTasksFormCronPreviewInvalid')}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Quick pick chips */}
        <div>
          <p className="text-xs text-secondary mb-1.5">{i18nService.t('scheduledTasksFormCronQuickTitle')}</p>
          <div className="flex flex-wrap gap-1.5">
            {CRON_QUICK_PICKS.map(({ labelKey, expr }) => {
              const active = currentExpr === expr;
              return (
                <button
                  key={expr}
                  type="button"
                  onClick={() => {
                    const parsed = exprToCronBuilder(expr);
                    updateForm({
                      cronExpr: expr,
                      cronBuilder: parsed ?? form.cronBuilder,
                    });
                  }}
                  className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                    active
                      ? 'bg-primary/10 border-primary/40 text-primary font-medium'
                      : 'bg-surface border-border text-secondary hover:bg-surface-raised hover:text-foreground'
                  }`}
                >
                  {i18nService.t(labelKey as Parameters<typeof i18nService.t>[0])}
                  <span className="ml-1.5 opacity-50 font-mono">{expr}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Optional timezone */}
        <div>
          <label className="text-xs font-medium text-foreground block mb-1">
            {i18nService.t('scheduledTasksFormCronTimezone')}
            <span className="ml-1 text-secondary font-normal">{i18nService.t('scheduledTasksFormOptional')}</span>
          </label>
          <input
            type="text"
            value={form.cronTz}
            onChange={(e) => updateForm({ cronTz: e.target.value })}
            placeholder={i18nService.t('scheduledTasksFormCronTimezonePlaceholder')}
            className={inputClass}
            spellCheck={false}
          />
        </div>
      </div>
    );
  };

  const renderScheduleRow = () => {
    if (isAdvanced) {
      const existingExpr = task?.schedule.kind === 'cron' ? task.schedule.expr : '';
      const existingTz = task?.schedule.kind === 'cron' ? (task.schedule.tz ?? '') : '';
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="rounded-lg bg-surface-raised/30 p-3 border border-border/50">
            <p className="text-sm text-secondary">
              {formatScheduleLabel(task!.schedule)}
            </p>
            {existingExpr && (
              <div className="flex items-center justify-end mt-2">
                <button
                  type="button"
                  onClick={() => updateForm({ planType: 'cron', cronExpr: existingExpr, cronTz: existingTz })}
                  className="text-xs text-primary hover:text-primary/80 font-medium transition-colors shrink-0"
                >
                  {i18nService.t('scheduledTasksFormAdvancedEditAsCron' as Parameters<typeof i18nService.t>[0])}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (isCron) {
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          {renderCronSection()}
        </div>
      );
    }

    if (form.planType === 'once') {
      const dateValue = `${form.year}-${String(form.month).padStart(2, '0')}-${String(form.day).padStart(2, '0')}`;
      const fullTimeValue = `${timeValue}:${String(form.second).padStart(2, '0')}`;
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="flex items-center gap-3">
            {renderPlanSelect()}
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
            {renderPlanSelect()}
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
            {renderPlanSelect()}
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
          {renderPlanSelect()}
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
                conversations.map((conv) => {
                  const lastActive = conv.lastActiveAt
                    ? new Date(conv.lastActiveAt).toLocaleDateString()
                    : null;
                  const label = [conv.platform, conv.conversationId, lastActive]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <option key={conv.conversationId} value={conv.conversationId}>
                      {label}
                    </option>
                  );
                })
              )}
            </select>
          )}
        </div>
      </div>
    );
  };

  const renderAgentRow = () => {
    return (
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormAgent' as Parameters<typeof i18nService.t>[0])}</label>
        <select
          value={form.agentId}
          onChange={(event) => updateForm({ agentId: event.target.value })}
          className={inputClass}
        >
          <option value="">{i18nService.t('scheduledTasksFormAgentDefault' as Parameters<typeof i18nService.t>[0])}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
    );
  };

  const payloadCharCount = form.payloadText.length;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 min-h-0">
        <h2 className="text-base font-semibold text-foreground">
          {mode === 'create' ? i18nService.t('scheduledTasksFormCreate') : i18nService.t('scheduledTasksFormUpdate')}
        </h2>

        {/* Task name */}
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

        {/* Divider */}
        <div className="border-t border-border/40" />

        {/* Schedule */}
        <div>
          {renderScheduleRow()}
          {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}
        </div>

        {/* Divider */}
        <div className="border-t border-border/40" />

        {/* Prompt / payload */}
        <div>
          <div className="flex items-end justify-between mb-1">
            <label className={labelClass} style={{ marginBottom: 0 }}>
              {i18nService.t('scheduledTasksFormPayloadTextAgent')}
            </label>
            <span className="text-xs text-secondary tabular-nums">
              {i18nService.t('scheduledTasksFormCharCount' as Parameters<typeof i18nService.t>[0]).replace('{count}', String(payloadCharCount))}
            </span>
          </div>
          <textarea
            value={form.payloadText}
            onChange={(event) => updateForm({ payloadText: event.target.value })}
            className={`${inputClass} resize-y`}
            style={{ minHeight: '120px', height: '180px' }}
            placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
          />
          <p className={hintClass}>
            {i18nService.t('scheduledTasksFormPayloadTextAgentHint' as Parameters<typeof i18nService.t>[0])}
          </p>

          {/* Prompt templates — shown when textarea is empty */}
          {!form.payloadText.trim() && (
            <div className="mt-2">
              <p className="text-xs text-secondary mb-1.5">
                {i18nService.t('scheduledTasksFormPromptTemplateTitle' as Parameters<typeof i18nService.t>[0])}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PROMPT_TEMPLATES.map(({ labelKey, textKey }) => (
                  <button
                    key={labelKey}
                    type="button"
                    onClick={() => updateForm({ payloadText: i18nService.t(textKey as Parameters<typeof i18nService.t>[0]) })}
                    className="px-2.5 py-1 rounded-md text-xs border border-border bg-surface text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                  >
                    {i18nService.t(labelKey as Parameters<typeof i18nService.t>[0])}
                  </button>
                ))}
              </div>
            </div>
          )}

          {errors.payloadText && <p className={errorClass}>{errors.payloadText}</p>}
        </div>

        {/* Divider */}
        <div className="border-t border-border/40" />

        {/* Agent selector */}
        {renderAgentRow()}

        {/* Divider */}
        <div className="border-t border-border/40" />

        {/* Notification */}
        {renderNotifyRow()}
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center justify-end gap-3 px-5 py-3 border-t border-border bg-surface">
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
