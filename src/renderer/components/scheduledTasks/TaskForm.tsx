import {
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  BellSlashIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import { PlatformRegistry } from '@shared/platform';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { DeliveryMode, PayloadKind, ScheduleKind, SessionTarget, WakeMode } from '../../../scheduledTask/constants';
import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskConversationOption,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
} from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import { resolveOpenClawModelRef, toOpenClawModelRef } from '../../utils/openclawModelRef';
import Modal from '../common/Modal';
import ModelSelector from '../ModelSelector';
import {
  getDeliveryAnalyticsParams,
  getFormScheduleAnalyticsParams,
  getModelAnalyticsParams,
  getPayloadAnalyticsParams,
  reportScheduledTaskAction,
  serializeAnalyticsList,
} from './analytics';
import ScheduledTaskTemplatePickerModal from './ScheduledTaskTemplatePickerModal';
import { SCHEDULED_TASK_TEMPLATES, type ScheduledTaskTemplate } from './taskTemplates';
import {
  channelOptionMatchesSelection,
  conversationOptionMatchesValue,
  formatChannelOptionLabel,
  formatConversationOptionLabel,
  formatDeliveryTarget,
  formatScheduleLabel,
  pickDefaultConversation,
  type PlanType,
  scheduleToPlanInfo,
} from './utils';

interface TaskFormProps {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  initialTemplate?: ScheduledTaskTemplate | null;
  onCancel: () => void;
  onSaved: (newTaskId?: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

interface CronBuilder {
  minute: string; // e.g. '0', '*/5', '*/15', '*/30', '*'
  hour: string; // e.g. '9', '*/2', '*'
  dom: string; // e.g. '*', '1', '15'
  month: string; // e.g. '*'
  dow: string; // e.g. '*', '1-5', '1', '0'
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
  weekdays: number[];
  monthDay: number;
  payloadText: string;
  notifyChannel: string;
  notifyTo: string;
  cronExpr: string;
  cronTz: string;
  cronMode: 'builder' | 'raw';
  cronBuilder: CronBuilder;
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
  cronExpr: '',
  cronTz: '',
  cronMode: 'builder',
  cronBuilder: { ...DEFAULT_CRON_BUILDER },
  notifyAccountId: undefined,
  modelId: '',
};

// Cron quick-pick examples: [label key, expr]
const CRON_QUICK_PICKS: Array<{ labelKey: string; expr: string }> = [
  { labelKey: 'scheduledTasksFormCronQuickEveryDay', expr: '0 9 * * *' },
  { labelKey: 'scheduledTasksFormCronQuickWeekday', expr: '0 9 * * 1-5' },
  { labelKey: 'scheduledTasksFormCronQuickEveryHour', expr: '0 * * * *' },
  { labelKey: 'scheduledTasksFormCronQuickEvery15min', expr: '*/15 * * * *' },
];

function isIMChannel(channel: string): boolean {
  return PlatformRegistry.isIMChannel(channel);
}

function applyScheduledTaskTemplate(form: FormState, template: ScheduledTaskTemplate): FormState {
  const dateDefaults = nowDefaults();
  return {
    ...form,
    ...dateDefaults,
    name: i18nService.t(template.titleKey),
    planType: template.schedule.planType,
    hour: template.schedule.hour,
    minute: template.schedule.minute,
    second: 0,
    weekdays: template.schedule.weekdays ? [...template.schedule.weekdays] : form.weekdays,
    monthDay: template.schedule.monthDay ?? form.monthDay,
    payloadText: i18nService.t(template.promptKey),
    cronExpr: '',
    cronTz: '',
    cronMode: 'builder',
    cronBuilder: { ...DEFAULT_CRON_BUILDER },
  };
}

export function createScheduledTaskFormState(
  task: ScheduledTask | undefined,
  fallbackModelRef: string,
  template?: ScheduledTaskTemplate | null,
): FormState {
  if (!task) {
    const form = { ...DEFAULT_FORM_STATE, ...nowDefaults(), modelId: fallbackModelRef };
    return template ? applyScheduledTaskTemplate(form, template) : form;
  }

  const planInfo = scheduleToPlanInfo(task.schedule);
  const rawCronExpr =
    planInfo.cronExpr ?? (task.schedule.kind === ScheduleKind.Cron ? task.schedule.expr : '');
  const parsedBuilder = rawCronExpr
    ? (exprToCronBuilder(rawCronExpr) ?? { ...DEFAULT_CRON_BUILDER })
    : { ...DEFAULT_CRON_BUILDER };
  const taskModelRef = task.payload.kind === PayloadKind.AgentTurn
    ? (task.payload.model?.trim() || fallbackModelRef)
    : '';

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
    payloadText: task.payload.kind === PayloadKind.SystemEvent ? task.payload.text : task.payload.message,
    notifyChannel: task.delivery.channel || 'none',
    notifyTo: task.delivery.to || '',
    cronExpr: rawCronExpr,
    cronTz: planInfo.cronTz ?? (task.schedule.kind === ScheduleKind.Cron ? (task.schedule.tz ?? '') : ''),
    cronMode: 'builder',
    cronBuilder: parsedBuilder,
    notifyAccountId: task.delivery.accountId,
    modelId: taskModelRef,
  };
}

function buildScheduleInput(form: FormState): ScheduledTaskInput['schedule'] {
  if (form.planType === 'once') {
    const date = new Date(form.year, form.month - 1, form.day, form.hour, form.minute, form.second);
    return { kind: ScheduleKind.At, at: date.toISOString() };
  }

  if (form.planType === 'cron') {
    const expr =
      form.cronMode === 'builder' ? cronBuilderToExpr(form.cronBuilder) : form.cronExpr.trim();
    const schedule: ScheduledTaskInput['schedule'] & { kind: typeof ScheduleKind.Cron } = {
      kind: ScheduleKind.Cron,
      expr,
    };
    if (form.cronTz.trim()) {
      schedule.tz = form.cronTz.trim();
    }
    return schedule;
  }

  const min = String(form.minute);
  const hr = String(form.hour);

  if (form.planType === 'hourly') {
    return { kind: ScheduleKind.Cron, expr: `${min} * * * *` };
  }

  if (form.planType === 'daily') {
    return { kind: ScheduleKind.Cron, expr: `${min} ${hr} * * *` };
  }

  if (form.planType === 'weekly') {
    const dowField = [...form.weekdays].sort((a, b) => a - b).join(',');
    return { kind: ScheduleKind.Cron, expr: `${min} ${hr} * * ${dowField}` };
  }

  return { kind: ScheduleKind.Cron, expr: `${min} ${hr} ${form.monthDay} * *` };
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

const formPageClass = 'px-6 py-4 sm:px-8 lg:px-10';
const formContentClass = 'mx-auto w-full max-w-[760px]';

// Returns the human-readable cron description, or null if the expression is
// syntactically invalid (wrong number of fields, parse error).
// Distinguishes from an empty/blank expression which returns null without error.
function previewCron(expr: string): { ok: true; label: string } | { ok: false } | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { ok: false };
  try {
    const label = formatScheduleLabel({ kind: ScheduleKind.Cron, expr: trimmed });
    return { ok: true, label };
  } catch {
    return { ok: false };
  }
}

function getErrorCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.name && error.name !== 'Error' ? error.name : fallback;
}

const TaskForm: React.FC<TaskFormProps> = ({
  mode,
  task,
  initialTemplate = null,
  onCancel,
  onSaved,
  onDirtyChange,
}) => {
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const defaultSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const fallbackModelRef = defaultSelectedModel ? toOpenClawModelRef(defaultSelectedModel) : '';
  const [form, setForm] = useState<FormState>(() =>
    createScheduledTaskFormState(
      task,
      fallbackModelRef,
      mode === 'create' ? initialTemplate : null,
    )
  );
  const initialFormRef = useRef<string>(
    JSON.stringify(createScheduledTaskFormState(task, fallbackModelRef)),
  );
  const [channelOptions, setChannelOptions] = useState<ScheduledTaskChannelOption[]>(() => {
    const base: ScheduledTaskChannelOption[] = [];
    const savedChannel = task?.delivery.channel;
    if (savedChannel && isIMChannel(savedChannel) && !base.some(o => o.value === savedChannel)) {
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
  const [cronPreview, setCronPreview] = useState<
    { ok: true; label: string } | { ok: false } | null
  >(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [appliedTemplate, setAppliedTemplate] = useState<ScheduledTaskTemplate | null>(
    () => (mode === 'create' ? initialTemplate : null),
  );
  const [payloadEditorOpen, setPayloadEditorOpen] = useState(false);
  const payloadEditorTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!payloadEditorOpen) return;
    const textarea = payloadEditorTextareaRef.current;
    if (textarea) {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPayloadEditorOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [payloadEditorOpen]);

  const isDirty = JSON.stringify(form) !== initialFormRef.current;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const isAdvanced = form.planType === 'advanced';
  const isCron = form.planType === 'cron';
  const showConversationSelector = isIMChannel(form.notifyChannel);
  const isSystemEventTask = task?.payload.kind === PayloadKind.SystemEvent;

  useEffect(() => {
    const cleanForm = createScheduledTaskFormState(task, fallbackModelRef);
    const nextForm = createScheduledTaskFormState(
      task,
      fallbackModelRef,
      mode === 'create' ? initialTemplate : null,
    );
    initialFormRef.current = JSON.stringify(cleanForm);
    setForm(nextForm);
    setAppliedTemplate(mode === 'create' ? initialTemplate : null);
  }, [task, fallbackModelRef, initialTemplate, mode]);

  useEffect(() => {
    reportScheduledTaskAction('form_open', {
      source: 'scheduled_task_form',
      mode,
      hasInitialTemplate: Boolean(mode === 'create' && initialTemplate),
      templateId: mode === 'create' ? initialTemplate?.id : undefined,
      templateName: mode === 'create' && initialTemplate ? i18nService.t(initialTemplate.titleKey) : undefined,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void scheduledTaskService.listChannels().then(channels => {
      if (cancelled || channels.length === 0) return;
      setChannelOptions(current => {
        // Use the server-returned order (DEFINITIONS order) as the base,
        // then append any saved channel that is not in the list (e.g. disabled platform).
        const next = [...channels];
        for (const saved of current) {
          if (!next.some(item => item.value === saved.value)) {
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
    const selectedChannelOption = channelOptions.find(option =>
      channelOptionMatchesSelection(option, form.notifyChannel, form.notifyAccountId),
    );
    setConversationsLoading(true);
    void scheduledTaskService.listChannelConversations(
      form.notifyChannel,
      form.notifyAccountId,
      selectedChannelOption?.filterAccountId ?? form.notifyAccountId,
    ).then((result) => {
      if (cancelled) return;
      setConversations(result);
      setConversationsLoading(false);

        // Pre-select a sensible default (most recent DM with the selected bot)
        // when nothing is chosen yet; the user can still override the target via
        // the conversation dropdown below.
        const defaultConversation = pickDefaultConversation(result);
        if (defaultConversation && !form.notifyTo) {
          setForm(current => ({ ...current, notifyTo: defaultConversation.conversationId }));
          setErrors(current => {
            if (!current.notifyTo) return current;
            const { notifyTo: _ignored, ...rest } = current;
            return rest;
          });
        }
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.notifyChannel, form.notifyAccountId, channelOptions]);

  // Live cron preview
  useEffect(() => {
    if (!isCron) {
      setCronPreview(null);
      return;
    }
    const expr = form.cronMode === 'builder' ? cronBuilderToExpr(form.cronBuilder) : form.cronExpr;
    setCronPreview(previewCron(expr));
  }, [isCron, form.cronMode, form.cronExpr, form.cronBuilder]);

  const updateForm = (patch: Partial<FormState>) => {
    setForm(current => ({ ...current, ...patch }));
  };

  const buildFormAnalyticsParams = (
    currentForm: FormState,
    scheduleKind?: ScheduledTaskInput['schedule']['kind'],
  ) => {
    const delivery: ScheduledTaskDelivery =
      currentForm.notifyChannel === 'none'
        ? { mode: DeliveryMode.None }
        : {
            mode: DeliveryMode.Announce,
            channel: currentForm.notifyChannel,
            ...(currentForm.notifyTo ? { to: currentForm.notifyTo } : {}),
            ...(currentForm.notifyAccountId ? { accountId: currentForm.notifyAccountId } : {}),
          };
    const payload: ScheduledTaskInput['payload'] = isSystemEventTask
      ? {
          kind: PayloadKind.SystemEvent,
          text: currentForm.payloadText.trim(),
        }
      : {
          kind: PayloadKind.AgentTurn,
          message: currentForm.payloadText.trim(),
          model: currentForm.modelId,
        };

    return {
      mode,
      hasTemplate: Boolean(appliedTemplate),
      templateId: appliedTemplate?.id,
      templateName: appliedTemplate ? i18nService.t(appliedTemplate.titleKey) : undefined,
      ...getFormScheduleAnalyticsParams({
        cronExpr:
          currentForm.cronMode === 'builder'
            ? cronBuilderToExpr(currentForm.cronBuilder)
            : currentForm.cronExpr.trim(),
        cronMode: currentForm.cronMode,
        cronTz: currentForm.cronTz.trim(),
        hour: currentForm.hour,
        minute: currentForm.minute,
        monthDay: currentForm.monthDay,
        planType: currentForm.planType,
        scheduleKind,
        weekdays: currentForm.weekdays,
      }),
      ...getPayloadAnalyticsParams(payload),
      ...getDeliveryAnalyticsParams(delivery),
      ...getModelAnalyticsParams(
        payload.kind === PayloadKind.AgentTurn ? payload.model : undefined,
        availableModels,
      ),
    };
  };

  const handleApplyTemplate = (template: ScheduledTaskTemplate) => {
    setAppliedTemplate(template);
    reportScheduledTaskAction('template_selected', {
      source: 'scheduled_task_form',
      mode,
      templateId: template.id,
      templateName: i18nService.t(template.titleKey),
      planType: template.schedule.planType,
      hour: template.schedule.hour,
      minute: template.schedule.minute,
      weekdayCount: template.schedule.weekdays?.length ?? 0,
      weekdays: serializeAnalyticsList(template.schedule.weekdays ?? []),
      monthDay: template.schedule.monthDay,
    });
    setForm(current => applyScheduledTaskTemplate(current, template));
    setErrors({});
    setSubmitError(null);
    setShowTemplatePicker(false);
  };

  const resolvedSelectedModelValue: Model | null = form.modelId
    ? resolveOpenClawModelRef(form.modelId, availableModels)
    : null;
  const selectedModelIsInvalid = Boolean(form.modelId.trim() && !resolvedSelectedModelValue);
  const selectedModelValue: Model | null = resolvedSelectedModelValue
    ?? (form.modelId.trim()
      ? { id: '__invalid__', name: form.modelId.split('/').pop() || form.modelId } as Model
      : null);

  const validate = (): Record<string, string> => {
    const nextErrors: Record<string, string> = {};

    if (!form.name.trim()) {
      nextErrors.name = i18nService.t('scheduledTasksFormValidationNameRequired');
    }
    if (!form.payloadText.trim()) {
      nextErrors.payloadText = i18nService.t('scheduledTasksFormValidationPromptRequired');
    }
    if (!isSystemEventTask && !form.modelId.trim()) {
      nextErrors.modelId = i18nService.t('scheduledTasksFormValidationModelRequired');
    } else if (!isSystemEventTask && !resolvedSelectedModelValue) {
      nextErrors.modelId = i18nService.t('scheduledTasksFormValidationModelUnavailable');
    }

    if (form.planType === 'once') {
      const runAt = new Date(
        form.year,
        form.month - 1,
        form.day,
        form.hour,
        form.minute,
        form.second,
      );
      if (runAt.getTime() <= Date.now()) {
        nextErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
      }
    }

    if (form.planType === 'cron') {
      const expr =
        form.cronMode === 'builder' ? cronBuilderToExpr(form.cronBuilder) : form.cronExpr.trim();
      if (!expr) {
        nextErrors.schedule = i18nService.t('scheduledTasksFormValidationCronRequired');
      } else {
        const parts = expr.split(/\s+/);
        if (parts.length !== 5) {
          nextErrors.schedule = i18nService.t('scheduledTasksFormCronInputHint');
        }
      }
    }

    if (
      !isAdvanced &&
      !isCron &&
      (form.hour < 0 || form.hour > 23 || form.minute < 0 || form.minute > 59)
    ) {
      nextErrors.schedule = i18nService.t('scheduledTasksFormValidationTimeRequired');
    }

    if (form.planType === 'weekly' && form.weekdays.length === 0) {
      nextErrors.schedule = i18nService.t('scheduledTasksFormValidationWeekdayRequired');
    }

    // IM delivery needs a resolved target conversation; it stays empty only
    // when the selected bot has never had a conversation to deliver to.
    if (isIMChannel(form.notifyChannel) && !form.notifyTo.trim()) {
      nextErrors.notifyTo = i18nService.t('scheduledTasksFormValidationNotifyTargetMissing');
    }

    setErrors(nextErrors);
    return nextErrors;
  };

  const handleSubmit = async () => {
    const validationErrors = validate();
    const validationErrorKeys = Object.keys(validationErrors);
    if (validationErrorKeys.length > 0) {
      reportScheduledTaskAction('validation_failed', {
        source: 'scheduled_task_form',
        errorFields: validationErrorKeys.join(','),
        errorFieldCount: validationErrorKeys.length,
        ...buildFormAnalyticsParams(form),
      });
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const schedule = isAdvanced && task ? task.schedule : buildScheduleInput(form);
      const submitActionType = mode === 'create' ? 'create_submit' : 'edit_submit';
      reportScheduledTaskAction(submitActionType, {
        source: 'scheduled_task_form',
        ...buildFormAnalyticsParams(form, schedule.kind),
      });

      const payload: ScheduledTaskInput['payload'] = isSystemEventTask
        ? {
            kind: PayloadKind.SystemEvent,
            text: form.payloadText.trim(),
          }
        : {
            kind: PayloadKind.AgentTurn,
            message: form.payloadText.trim(),
            model: form.modelId,
          };

      const input: ScheduledTaskInput = {
        name: form.name.trim(),
        description: '',
        enabled: true,
        schedule,
        sessionTarget: SessionTarget.Isolated,
        wakeMode: WakeMode.Now,
        payload,
        delivery:
          form.notifyChannel === 'none'
            ? { mode: DeliveryMode.None }
            : {
                mode: DeliveryMode.Announce,
                channel: form.notifyChannel,
                ...(form.notifyTo ? { to: form.notifyTo } : {}),
                ...(form.notifyAccountId ? { accountId: form.notifyAccountId } : {}),
              },
      };

      if (mode === 'create') {
        const newId = await scheduledTaskService.createTask(input);
        reportScheduledTaskAction('create_success', {
          source: 'scheduled_task_form',
          result: 'success',
          ...buildFormAnalyticsParams(form, schedule.kind),
        });
        onSaved(newId ?? undefined);
      } else if (task) {
        await scheduledTaskService.updateTaskById(task.id, input);
        reportScheduledTaskAction('edit_success', {
          source: 'scheduled_task_form',
          result: 'success',
          ...buildFormAnalyticsParams(form, schedule.kind),
        });
        onSaved();
      }
      initialFormRef.current = JSON.stringify(form);
      onDirtyChange?.(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reportScheduledTaskAction(mode === 'create' ? 'create_failed' : 'edit_failed', {
        source: 'scheduled_task_form',
        result: 'failed',
        errorCode: getErrorCode(err, mode === 'create' ? 'create_failed' : 'edit_failed'),
        ...buildFormAnalyticsParams(form),
      });
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';
  const textareaInputClass =
    'w-full rounded-t-lg px-3 py-2 text-sm text-foreground focus:outline-none resize-none bg-transparent';
  const labelClass = 'block text-[13px] font-medium leading-5 text-foreground/85 mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';
  const hintClass = 'text-xs text-secondary mt-0.5';

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

  const renderPlanSelect = () => (
    <select
      value={form.planType}
      onChange={event => updateForm({ planType: event.target.value as PlanType })}
      className={`${inputClass} flex-1 min-w-0`}
    >
      <option value="once">{i18nService.t('scheduledTasksFormScheduleModeOnce')}</option>
      <option value="hourly">{i18nService.t('scheduledTasksFormScheduleModeHourly')}</option>
      <option value="daily">{i18nService.t('scheduledTasksFormScheduleModeDaily')}</option>
      <option value="weekly">{i18nService.t('scheduledTasksFormScheduleModeWeekly')}</option>
      <option value="monthly">{i18nService.t('scheduledTasksFormScheduleModeMonthly')}</option>
      <option value="cron">
        {i18nService.t(
          'scheduledTasksFormScheduleModeCronCustom' as Parameters<typeof i18nService.t>[0],
        )}
      </option>
    </select>
  );

  const renderCronSection = () => {
    // Derive current cron expression from builder or raw input
    const currentExpr =
      form.cronMode === 'builder' ? cronBuilderToExpr(form.cronBuilder) : form.cronExpr;

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

    const fieldSelectClass = `rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 flex-1 min-w-0`;

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">{renderPlanSelect()}</div>

        {/* Mode tabs */}
        <div className="flex items-center gap-0 border border-border rounded-lg overflow-hidden w-fit">
          <button
            type="button"
            onClick={handleSwitchToBuilder}
            className={`px-2.5 py-1 text-xs font-medium transition-colors ${
              form.cronMode === 'builder'
                ? 'bg-primary text-white'
                : 'bg-surface text-secondary hover:bg-surface-raised'
            }`}
          >
            {i18nService.t(
              'scheduledTasksFormCronModeBuilder' as Parameters<typeof i18nService.t>[0],
            )}
          </button>
          <button
            type="button"
            onClick={handleSwitchToRaw}
            className={`px-2.5 py-1 text-xs font-medium transition-colors ${
              form.cronMode === 'raw'
                ? 'bg-primary text-white'
                : 'bg-surface text-secondary hover:bg-surface-raised'
            }`}
          >
            {i18nService.t('scheduledTasksFormCronModeRaw' as Parameters<typeof i18nService.t>[0])}
          </button>
        </div>

        {form.cronMode === 'builder' ? (
          <div className="rounded-lg border border-border bg-surface-raised/20 p-2.5 space-y-2">
            {/* Field labels */}
            <div className="grid grid-cols-5 gap-1.5">
              {(['minute', 'hour', 'dom', 'month', 'dow'] as const).map(field => (
                <div key={field} className="text-center text-xs text-secondary font-medium">
                  {i18nService.t(
                    `scheduledTasksFormCronField_${field}` as Parameters<typeof i18nService.t>[0],
                  )}
                </div>
              ))}
            </div>
            {/* Field selects */}
            <div className="grid grid-cols-5 gap-1.5">
              {/* Minute */}
              <select
                value={form.cronBuilder.minute}
                onChange={e =>
                  updateForm({ cronBuilder: { ...form.cronBuilder, minute: e.target.value } })
                }
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 60 }, (_, i) => (
                  <option key={i} value={String(i)}>
                    {String(i).padStart(2, '0')}
                  </option>
                ))}
                <option value="*/5">*/5</option>
                <option value="*/10">*/10</option>
                <option value="*/15">*/15</option>
                <option value="*/30">*/30</option>
              </select>
              {/* Hour */}
              <select
                value={form.cronBuilder.hour}
                onChange={e =>
                  updateForm({ cronBuilder: { ...form.cronBuilder, hour: e.target.value } })
                }
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={String(i)}>
                    {String(i).padStart(2, '0')}
                  </option>
                ))}
                <option value="*/2">*/2</option>
                <option value="*/4">*/4</option>
                <option value="*/6">*/6</option>
                <option value="*/12">*/12</option>
              </select>
              {/* DOM (day of month) */}
              <select
                value={form.cronBuilder.dom}
                onChange={e =>
                  updateForm({ cronBuilder: { ...form.cronBuilder, dom: e.target.value } })
                }
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                  <option key={d} value={String(d)}>
                    {d}
                  </option>
                ))}
              </select>
              {/* Month */}
              <select
                value={form.cronBuilder.month}
                onChange={e =>
                  updateForm({ cronBuilder: { ...form.cronBuilder, month: e.target.value } })
                }
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                  <option key={m} value={String(m)}>
                    {m}
                  </option>
                ))}
              </select>
              {/* DOW (day of week) */}
              <select
                value={form.cronBuilder.dow}
                onChange={e =>
                  updateForm({ cronBuilder: { ...form.cronBuilder, dow: e.target.value } })
                }
                className={fieldSelectClass}
              >
                <option value="*">*</option>
                {WEEKDAY_KEYS.map((key, idx) => (
                  <option key={idx} value={String(idx)}>
                    {i18nService.t(key)}
                  </option>
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
                <span
                  className={`text-xs shrink-0 ${cronPreview.ok ? 'text-secondary' : 'text-red-500'}`}
                >
                  {cronPreview.ok
                    ? cronPreview.label
                    : i18nService.t(
                        'scheduledTasksFormCronPreviewInvalid' as Parameters<
                          typeof i18nService.t
                        >[0],
                      )}
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
              onChange={e => updateForm({ cronExpr: e.target.value })}
              placeholder={i18nService.t(
                'scheduledTasksFormCronInputPlaceholder' as Parameters<typeof i18nService.t>[0],
              )}
              className={inputClass}
              spellCheck={false}
            />
            <p className={hintClass}>
              {i18nService.t(
                'scheduledTasksFormCronInputHint' as Parameters<typeof i18nService.t>[0],
              )}
            </p>
            {/* Live preview */}
            {form.cronExpr.trim() && cronPreview !== null && (
              <div
                className={`mt-2 flex items-center gap-1.5 text-xs ${cronPreview.ok ? 'text-secondary' : 'text-red-500'}`}
              >
                {cronPreview.ok ? (
                  <>
                    <span className="opacity-60">
                      {i18nService.t(
                        'scheduledTasksFormCronPreview' as Parameters<typeof i18nService.t>[0],
                      )}
                    </span>
                    <span className="font-medium">{cronPreview.label}</span>
                  </>
                ) : (
                  <span className="font-medium">
                    {i18nService.t(
                      'scheduledTasksFormCronPreviewInvalid' as Parameters<typeof i18nService.t>[0],
                    )}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Quick pick chips */}
        <div>
          <p className="text-xs text-secondary mb-1">
            {i18nService.t(
              'scheduledTasksFormCronQuickTitle' as Parameters<typeof i18nService.t>[0],
            )}
          </p>
          <div className="flex flex-wrap gap-1">
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
                  className={`px-2 py-0.5 rounded-md text-xs border transition-colors ${
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
            {i18nService.t('scheduledTasksFormCronTimezone' as Parameters<typeof i18nService.t>[0])}
            <span className="ml-1 text-secondary font-normal">
              {i18nService.t('scheduledTasksFormOptional')}
            </span>
          </label>
          <input
            type="text"
            value={form.cronTz}
            onChange={e => updateForm({ cronTz: e.target.value })}
            placeholder={i18nService.t(
              'scheduledTasksFormCronTimezonePlaceholder' as Parameters<typeof i18nService.t>[0],
            )}
            className={inputClass}
            spellCheck={false}
          />
        </div>
      </div>
    );
  };

  const renderScheduleRow = () => {
    if (isAdvanced) {
      const existingExpr = task?.schedule.kind === ScheduleKind.Cron ? task.schedule.expr : '';
      const existingTz = task?.schedule.kind === ScheduleKind.Cron ? (task.schedule.tz ?? '') : '';
      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="rounded-lg bg-surface-raised/30 p-3 border border-border/50">
            <p className="text-sm text-secondary">{formatScheduleLabel(task!.schedule)}</p>
            {existingExpr && (
              <div className="flex items-center justify-end mt-2">
                <button
                  type="button"
                  onClick={() =>
                    updateForm({ planType: 'cron', cronExpr: existingExpr, cronTz: existingTz })
                  }
                  className="text-xs text-primary hover:text-primary/80 font-medium transition-colors shrink-0"
                >
                  {i18nService.t(
                    'scheduledTasksFormAdvancedEditAsCron' as Parameters<typeof i18nService.t>[0],
                  )}
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
              onChange={e => {
                const [y, mo, d] = e.target.value.split('-').map(Number);
                if (!Number.isNaN(y)) updateForm({ year: y, month: mo, day: d });
              }}
              className={`${inputClass} flex-1 min-w-0`}
            />
            <input
              type="time"
              step="1"
              value={fullTimeValue}
              onChange={e => {
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
              onChange={e => handleTimeChange(e.target.value)}
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
            {renderPlanSelect()}
            <select
              value={form.minute}
              onChange={e => updateForm({ minute: Number(e.target.value) })}
              className={`${inputClass} !w-20 shrink-0 text-center`}
            >
              {Array.from({ length: 60 }, (_, i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, '0')}
                </option>
              ))}
            </select>
            <span className="shrink-0 text-sm text-secondary">
              {i18nService.t('scheduledTasksFormHourlyMinuteSuffix')}
            </span>
          </div>
        </div>
      );
    }

    if (form.planType === 'weekly') {
      // Locale-aware weekday order:
      // zh: Mon(1)→Sun(0) — Chinese convention starts with Monday
      // en: Sun(0)→Sat(6) — English convention starts with Sunday
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
        const next = current.includes(day) ? current.filter(d => d !== day) : [...current, day];
        updateForm({ weekdays: next });
      };

      return (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <div className="flex items-center gap-3">
            {renderPlanSelect()}
            <input
              type="time"
              value={timeValue}
              onChange={e => handleTimeChange(e.target.value)}
              className={`${inputClass} flex-1 min-w-0`}
            />
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            {WEEKDAY_SHORT_LABELS.map(([key, dayValue]) => {
              const selected = form.weekdays.includes(dayValue);
              return (
                <button
                  key={dayValue}
                  type="button"
                  onClick={() => toggleWeekday(dayValue)}
                  className={`w-8 h-8 rounded-full text-xs font-medium transition-colors ${
                    selected
                      ? 'bg-primary text-white'
                      : 'border border-border text-secondary hover:bg-surface-raised'
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
          {renderPlanSelect()}
          <select
            value={form.monthDay}
            onChange={e => updateForm({ monthDay: Number(e.target.value) })}
            className={`${inputClass} flex-1 min-w-0`}
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
              <option key={d} value={d}>
                {d}
                {i18nService.t('scheduledTasksFormMonthDaySuffix')}
              </option>
            ))}
          </select>
          <input
            type="time"
            value={timeValue}
            onChange={e => handleTimeChange(e.target.value)}
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
      if (
        channelDropdownRef.current &&
        !channelDropdownRef.current.contains(event.target as Node)
      ) {
        setChannelDropdownOpen(false);
      }
      if (
        convDropdownRef.current &&
        !convDropdownRef.current.contains(event.target as Node)
      ) {
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

  const getChannelDisplayLabel = (channelValue: string): string => {
    if (channelValue === 'none') return i18nService.t('scheduledTasksFormNotifyChannelNone');
    // Use i18n translation for platform name (e.g. weixin → '微信', feishu → '飞书')
    const platform = PlatformRegistry.platformOfChannel(channelValue);
    if (platform) {
      return i18nService.t(platform) || PlatformRegistry.get(platform).label;
    }
    const option = channelOptions.find(c => c.value === channelValue);
    return option ? option.label : channelValue;
  };

  const renderNotifyRow = () => {
    const selectedLogo = getChannelLogo(form.notifyChannel);
    // The notify target is a user-selectable conversation (group or DM) for the
    // chosen bot instance. pickDefaultConversation pre-selects the most recent
    // DM, but the user can switch to any conversation via the dropdown below.
    const selectedConversation = conversations.find(
      (conv) => conversationOptionMatchesValue(form.notifyChannel, conv.conversationId, form.notifyTo),
    );
    const resolvedTargetLabel = selectedConversation
      ? formatConversationOptionLabel(selectedConversation)
      : form.notifyTo
        ? formatDeliveryTarget(form.notifyTo)
        : '';

    return (
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormNotifyChannel')}</label>
        <div className="relative w-full" ref={channelDropdownRef}>
            <button
              type="button"
              onClick={() => setChannelDropdownOpen(!channelDropdownOpen)}
              className={`${inputClass} w-full flex items-center justify-between cursor-pointer`}
            >
              <span className="flex items-center gap-2 truncate">
                {form.notifyChannel === DEFAULT_FORM_STATE.notifyChannel ? (
                  <BellSlashIcon className="w-5 h-5 shrink-0 text-secondary" />
                ) : selectedLogo ? (
                  <img src={selectedLogo} alt="" className="w-5 h-5 object-contain rounded" />
                ) : null}
                <span className="truncate">
                  {(() => {
                    const selected = channelOptions.find(o =>
                      channelOptionMatchesSelection(o, form.notifyChannel, form.notifyAccountId),
                    );
                    return selected
                      ? formatChannelOptionLabel(selected, channelOptions)
                      : getChannelDisplayLabel(form.notifyChannel);
                  })()}
                </span>
              </span>
              <svg
                className={`w-4 h-4 ml-2 flex-shrink-0 transition-transform ${channelDropdownOpen ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {channelDropdownOpen && (
              <div className="absolute bottom-full z-50 mb-1 w-full rounded-xl border border-border bg-surface shadow-popover popover-enter overflow-hidden">
                <div className="max-h-72 overflow-y-auto py-1">
                  <button
                    type="button"
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${
                      form.notifyChannel === DEFAULT_FORM_STATE.notifyChannel
                        ? 'bg-claude-surfaceHover/50 dark:bg-claude-darkSurfaceHover/50'
                        : ''
                    }`}
                    onClick={() => {
                      updateForm({
                        notifyChannel: DEFAULT_FORM_STATE.notifyChannel,
                        notifyTo: '',
                        notifyAccountId: undefined,
                      });
                      setChannelDropdownOpen(false);
                    }}
                  >
                    <BellSlashIcon className="w-5 h-5 shrink-0 text-secondary" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-normal leading-5">
                      {i18nService.t('scheduledTasksFormNotifyChannelNone')}
                    </span>
                    {form.notifyChannel === DEFAULT_FORM_STATE.notifyChannel && (
                      <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" />
                    )}
                  </button>
                  {channelOptions.map(channel => {
                    const logo = getChannelLogo(channel.value);
                    const displayName = formatChannelOptionLabel(channel, channelOptions);
                    const isActive = channelOptionMatchesSelection(
                      channel,
                      form.notifyChannel,
                      form.notifyAccountId,
                    );
                    return (
                      <button
                        type="button"
                        key={`${channel.value}:${channel.accountId ?? ''}`}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${
                          isActive ? 'bg-claude-surfaceHover/50 dark:bg-claude-darkSurfaceHover/50' : ''
                        }`}
                        onClick={() => {
                          updateForm({
                            notifyChannel: channel.value,
                            notifyTo: '',
                            notifyAccountId: channel.accountId,
                          });
                          setChannelDropdownOpen(false);
                        }}
                      >
                        {logo ? (
                          <img
                            src={logo}
                            alt={displayName}
                            className="w-5 h-5 shrink-0 object-contain rounded"
                          />
                        ) : (
                          <span className="w-5 h-5 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px] font-normal leading-5">
                          {displayName}
                        </span>
                        {isActive && (
                          <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
        </div>
        {showConversationSelector ? (
          <div className="mt-2">
            <div className="relative w-full" ref={convDropdownRef}>
              <button
                type="button"
                onClick={() => {
                  if (!conversationsLoading) setConvDropdownOpen(!convDropdownOpen);
                }}
                disabled={conversationsLoading}
                title={selectedConversation?.conversationId ?? form.notifyTo}
                className={`${inputClass} w-full flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className="truncate">
                  {conversationsLoading
                    ? i18nService.t('scheduledTasksFormNotifyConversationLoading')
                    : resolvedTargetLabel ||
                      i18nService.t('scheduledTasksFormNotifySelectConversation')}
                </span>
                <svg
                  className={`w-4 h-4 ml-2 flex-shrink-0 transition-transform ${
                    convDropdownOpen ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {convDropdownOpen && !conversationsLoading && (
                <div className="absolute bottom-full z-50 mb-1 w-full rounded-xl border border-border bg-surface shadow-popover popover-enter overflow-hidden">
                  <div className="max-h-72 overflow-y-auto py-1">
                    {conversations.length === 0 ? (
                      <div className="px-3 py-2 text-[13px] text-secondary">
                        {i18nService.t('scheduledTasksFormNotifyNoConversationHint')}
                      </div>
                    ) : (
                      conversations.map(conv => {
                        const isActive = conversationOptionMatchesValue(
                          form.notifyChannel,
                          conv.conversationId,
                          form.notifyTo,
                        );
                        return (
                          <button
                            type="button"
                            key={conv.conversationId}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${
                              isActive
                                ? 'bg-claude-surfaceHover/50 dark:bg-claude-darkSurfaceHover/50'
                                : ''
                            }`}
                            title={conv.conversationId}
                            onClick={() => {
                              updateForm({ notifyTo: conv.conversationId });
                              setConvDropdownOpen(false);
                              setErrors(current => {
                                if (!current.notifyTo) return current;
                                const { notifyTo: _ignored, ...rest } = current;
                                return rest;
                              });
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate text-[13px] font-normal leading-5">
                              {formatConversationOptionLabel(conv)}
                            </span>
                            {isActive && (
                              <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
            {errors.notifyTo ? (
              <p className={errorClass}>{errors.notifyTo}</p>
            ) : conversations.length === 0 && !conversationsLoading ? (
              <p className={hintClass}>
                {i18nService.t('scheduledTasksFormNotifyNoConversationHint')}
              </p>
            ) : (
              <p className={hintClass}>
                {i18nService.t('scheduledTasksFormNotifySelectConversationHint')}
              </p>
            )}
          </div>
        ) : (
          <p className={hintClass}>
            {i18nService.t('scheduledTasksFormNotifyChannelHint')}
          </p>
        )}
      </div>
    );
  };

  const payloadCharCount = form.payloadText.length;

  return (
    <>
    <div className="flex flex-col min-h-0 h-full">
      {/* Scrollable form body */}
      <div className={`flex-1 overflow-y-auto min-h-0 ${formPageClass}`}>
        <div className={`${formContentClass} space-y-5`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-foreground">
                {mode === 'create'
                  ? i18nService.t('scheduledTasksFormCreate')
                  : i18nService.t('scheduledTasksFormUpdate')}
              </h2>
              <p className="mt-1 text-sm text-secondary">
                {i18nService.t('scheduledTasksFormSubtitle')}
              </p>
            </div>
            {mode === 'create' && (
              <button
                type="button"
                onClick={() => {
                  reportScheduledTaskAction('template_picker_open', {
                    source: 'scheduled_task_form',
                    ...buildFormAnalyticsParams(form),
                  });
                  setShowTemplatePicker(true);
                }}
                className="h-8 shrink-0 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('scheduledTasksTemplateUse')}
              </button>
            )}
          </div>

          {/* Task name */}
          <div>
            <label className={labelClass}>{i18nService.t('scheduledTasksFormName')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span></label>
            <input
              type="text"
              value={form.name}
              onChange={event => updateForm({ name: event.target.value })}
              className={inputClass}
              placeholder={i18nService.t('scheduledTasksFormNamePlaceholder')}
            />
            {errors.name && <p className={errorClass}>{errors.name}</p>}
          </div>

          {/* Schedule */}
          <div>
            {renderScheduleRow()}
            {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}
          </div>

          {/* Prompt / payload */}
          <div>
            <div className={`flex items-end justify-between ${isSystemEventTask ? 'mb-1' : ''}`}>
              <label className={labelClass} style={{ marginBottom: 0 }}>
                {i18nService.t('scheduledTasksFormPayloadTextAgent')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
              </label>
              {payloadCharCount > 0 && (
                <span className="text-xs text-secondary tabular-nums">
                  {i18nService
                    .t('scheduledTasksFormCharCount' as Parameters<typeof i18nService.t>[0])
                    .replace('{count}', String(payloadCharCount))}
                </span>
              )}
            </div>
            {!isSystemEventTask && (
              <p className="mt-0.5 mb-1.5 text-xs text-secondary">
                {i18nService.t('scheduledTasksFormPayloadTextAgentHint')}
              </p>
            )}
            <div className="relative rounded-lg border border-border bg-surface focus-within:ring-2 focus-within:ring-primary/50">
              <textarea
                value={form.payloadText}
                onChange={event => updateForm({ payloadText: event.target.value })}
                className={`${textareaInputClass} resize-y`}
                style={{ minHeight: '80px', height: '120px', paddingRight: '2.5rem' }}
                placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  reportScheduledTaskAction('payload_editor_open', {
                    source: 'scheduled_task_form',
                    mode,
                    charCount: payloadCharCount,
                  });
                  setPayloadEditorOpen(true);
                }}
                title={i18nService.t('scheduledTasksFormPayloadExpand')}
                aria-label={i18nService.t('scheduledTasksFormPayloadExpand')}
                className="absolute right-2 top-2 rounded-md p-1.5 text-secondary/70 hover:bg-surface-raised hover:text-foreground transition-colors"
              >
                <ArrowsPointingOutIcon className="h-4 w-4" />
              </button>
              {!isSystemEventTask && (
                <div className="flex items-center gap-2 px-2 py-1 border-t border-border/40">
                  <ModelSelector
                    dropdownDirection="up"
                    value={selectedModelValue}
                    onChange={handleModelChange}
                  />
                </div>
              )}
            </div>
            {!isSystemEventTask && (errors.modelId || selectedModelIsInvalid) && (
              <p className={errorClass}>
                {errors.modelId || i18nService.t('scheduledTasksFormValidationModelUnavailable')}
              </p>
            )}
            {errors.payloadText && <p className={errorClass}>{errors.payloadText}</p>}
          </div>

          {/* Notification */}
          {renderNotifyRow()}
        </div>
      </div>

      {/* Submit error */}
      {submitError && (
        <div className="px-6 pb-2 sm:px-8 lg:px-10">
          <div className={`${formContentClass} flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40`}>
            <span className="text-xs text-red-600 dark:text-red-400 break-words min-w-0">
              {i18nService.t('scheduledTasksFormSubmitError')}
              {submitError}
            </span>
            <button
              type="button"
              onClick={() => setSubmitError(null)}
              className="shrink-0 ml-auto p-0.5 text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors"
              aria-label="dismiss"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="shrink-0 border-t border-border/60 px-6 py-3 sm:px-8 lg:px-10">
        <div className={`${formContentClass} flex items-center justify-end gap-2`}>
          <button
            type="button"
            onClick={() => {
              reportScheduledTaskAction('form_cancel', {
                source: 'scheduled_task_form',
                isDirty,
                ...buildFormAnalyticsParams(form),
              });
              onCancel();
            }}
            className="px-3 py-1.5 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="px-4 py-1.5 text-[14px] font-normal leading-5 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {submitting
              ? i18nService.t('saving')
              : mode === 'create'
                ? i18nService.t('scheduledTasksFormCreate')
                : i18nService.t('scheduledTasksFormUpdate')}
          </button>
        </div>
      </div>
    </div>
    {mode === 'create' && showTemplatePicker && (
      <ScheduledTaskTemplatePickerModal
        templates={SCHEDULED_TASK_TEMPLATES}
        onClose={() => {
          reportScheduledTaskAction('template_picker_close', {
            source: 'scheduled_task_form',
            mode,
            closeReason: 'close',
          });
          setShowTemplatePicker(false);
        }}
        onNew={() => {
          reportScheduledTaskAction('template_picker_close', {
            source: 'scheduled_task_form',
            mode,
            closeReason: 'new_blank',
          });
          setShowTemplatePicker(false);
        }}
        onSelect={handleApplyTemplate}
      />
    )}
    {payloadEditorOpen && (
      <Modal
        isOpen
        onClose={() => setPayloadEditorOpen(false)}
        overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/10 dark:bg-black/50 p-6"
        className="flex h-[min(720px,calc(100vh-48px))] w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden rounded-xl border border-surface bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.16)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">
              {i18nService.t('scheduledTasksFormPayloadTextAgent')}
            </h2>
            {!isSystemEventTask && (
              <p className="mt-0.5 text-sm text-secondary">
                {i18nService.t('scheduledTasksFormPayloadTextAgentHint')}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPayloadEditorOpen(false)}
            title={i18nService.t('scheduledTasksFormPayloadCollapse')}
            aria-label={i18nService.t('scheduledTasksFormPayloadCollapse')}
            className="p-2 rounded-lg hover:bg-surface-raised transition-colors"
          >
            <ArrowsPointingInIcon className="h-5 w-5 text-secondary" />
          </button>
        </div>
        <textarea
          ref={payloadEditorTextareaRef}
          value={form.payloadText}
          onChange={event => updateForm({ payloadText: event.target.value })}
          placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-5 pt-1 pb-4 text-sm leading-6 text-foreground focus:outline-none"
        />
        <div className="flex shrink-0 items-center justify-between border-t border-border/60 px-5 py-3">
          <span className="text-xs text-secondary tabular-nums">
            {i18nService
              .t('scheduledTasksFormCharCount' as Parameters<typeof i18nService.t>[0])
              .replace('{count}', String(payloadCharCount))}
          </span>
          <button
            type="button"
            onClick={() => setPayloadEditorOpen(false)}
            className="px-4 py-1.5 text-[14px] font-normal leading-5 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
          >
            {i18nService.t('scheduledTasksFormPayloadEditorDone')}
          </button>
        </div>
      </Modal>
    )}
    </>
  );
};

export default TaskForm;
