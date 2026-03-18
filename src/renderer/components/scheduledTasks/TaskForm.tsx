import React, { useEffect, useState } from 'react';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
} from '../../types/scheduledTask';

interface TaskFormProps {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  onCancel: () => void;
  onSaved: () => void;
}

type EveryUnit = 'minutes' | 'hours' | 'days';
type ScheduleKind = 'every' | 'at' | 'cron';
type DeliveryMode = 'none' | 'announce' | 'webhook';

interface FormState {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  scheduleAt: string;
  everyAmount: string;
  everyUnit: EveryUnit;
  cronExpr: string;
  cronTz: string;
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'now' | 'next-heartbeat';
  payloadKind: 'systemEvent' | 'agentTurn';
  payloadText: string;
  timeoutSeconds: string;
  deliveryMode: DeliveryMode;
  deliveryChannel: string;
  deliveryTo: string;
}

const DEFAULT_FORM_STATE: FormState = {
  name: '',
  description: '',
  agentId: '',
  enabled: true,
  scheduleKind: 'every',
  scheduleAt: '',
  everyAmount: '30',
  everyUnit: 'minutes',
  cronExpr: '0 7 * * *',
  cronTz: '',
  sessionTarget: 'isolated',
  wakeMode: 'now',
  payloadKind: 'agentTurn',
  payloadText: '',
  timeoutSeconds: '',
  deliveryMode: 'announce',
  deliveryChannel: 'last',
  deliveryTo: '',
};

function toDatetimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseEverySchedule(everyMs: number): { everyAmount: string; everyUnit: EveryUnit } {
  if (everyMs % 86_400_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 86_400_000)), everyUnit: 'days' };
  }
  if (everyMs % 3_600_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 3_600_000)), everyUnit: 'hours' };
  }
  return { everyAmount: String(Math.max(1, Math.round(everyMs / 60_000))), everyUnit: 'minutes' };
}

function createFormState(task?: ScheduledTask): FormState {
  if (!task) {
    return { ...DEFAULT_FORM_STATE };
  }

  const nextState: FormState = {
    ...DEFAULT_FORM_STATE,
    name: task.name,
    description: task.description,
    agentId: task.agentId || '',
    enabled: task.enabled,
    sessionTarget: task.sessionTarget,
    wakeMode: task.wakeMode,
    payloadKind: task.payload.kind,
    payloadText: task.payload.kind === 'systemEvent' ? task.payload.text : task.payload.message,
    timeoutSeconds: task.payload.kind === 'agentTurn' && typeof task.payload.timeoutSeconds === 'number'
      ? String(task.payload.timeoutSeconds)
      : '',
    deliveryMode: task.delivery.mode,
    deliveryChannel: task.delivery.channel || 'last',
    deliveryTo: task.delivery.to || '',
  };

  if (task.schedule.kind === 'at') {
    nextState.scheduleKind = 'at';
    nextState.scheduleAt = toDatetimeLocalValue(task.schedule.at);
  } else if (task.schedule.kind === 'every') {
    nextState.scheduleKind = 'every';
    const parsedEvery = parseEverySchedule(task.schedule.everyMs);
    nextState.everyAmount = parsedEvery.everyAmount;
    nextState.everyUnit = parsedEvery.everyUnit;
  } else {
    nextState.scheduleKind = 'cron';
    nextState.cronExpr = task.schedule.expr;
    nextState.cronTz = task.schedule.tz || '';
  }

  return nextState;
}

function supportsAnnounceDelivery(form: FormState): boolean {
  return form.sessionTarget === 'isolated' && form.payloadKind === 'agentTurn';
}

function normalizeDeliveryMode(form: FormState): DeliveryMode {
  if (form.deliveryMode !== 'announce') {
    return form.deliveryMode;
  }
  return supportsAnnounceDelivery(form) ? 'announce' : 'none';
}

function buildScheduleInput(form: FormState): ScheduledTaskInput['schedule'] {
  if (form.scheduleKind === 'at') {
    return {
      kind: 'at',
      at: new Date(form.scheduleAt).toISOString(),
    };
  }

  if (form.scheduleKind === 'every') {
    const amount = Number.parseInt(form.everyAmount, 10);
    const multiplier = form.everyUnit === 'minutes'
      ? 60_000
      : form.everyUnit === 'hours'
        ? 3_600_000
        : 86_400_000;
    return {
      kind: 'every',
      everyMs: amount * multiplier,
    };
  }

  return {
    kind: 'cron',
    expr: form.cronExpr.trim(),
    ...(form.cronTz.trim() ? { tz: form.cronTz.trim() } : {}),
  };
}

function buildDeliveryInput(form: FormState): ScheduledTaskDelivery {
  const deliveryMode = normalizeDeliveryMode(form);
  if (deliveryMode === 'none') {
    return { mode: 'none' };
  }

  if (deliveryMode === 'webhook') {
    return {
      mode: 'webhook',
      ...(form.deliveryTo.trim() ? { to: form.deliveryTo.trim() } : {}),
    };
  }

  return {
    mode: 'announce',
    channel: form.deliveryChannel.trim() || 'last',
    ...(form.deliveryTo.trim() ? { to: form.deliveryTo.trim() } : {}),
  };
}

const TaskForm: React.FC<TaskFormProps> = ({ mode, task, onCancel, onSaved }) => {
  const [form, setForm] = useState<FormState>(() => createFormState(task));
  const [channelOptions, setChannelOptions] = useState<ScheduledTaskChannelOption[]>([
    { value: 'last', label: 'Last conversation' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
    const currentChannel = form.deliveryChannel.trim();
    if (!currentChannel) return;
    setChannelOptions((current) => (
      current.some((item) => item.value === currentChannel)
        ? current
        : [...current, { value: currentChannel, label: currentChannel }]
    ));
  }, [form.deliveryChannel]);

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
    if (form.scheduleKind === 'at') {
      const runAtMs = Date.parse(form.scheduleAt);
      if (!Number.isFinite(runAtMs) || runAtMs <= Date.now()) {
        nextErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
      }
    }
    if (form.scheduleKind === 'every') {
      const amount = Number.parseInt(form.everyAmount, 10);
      if (!Number.isFinite(amount) || amount <= 0) {
        nextErrors.schedule = i18nService.t('scheduledTasksFormValidationIntervalPositive');
      }
    }
    if (form.scheduleKind === 'cron' && !form.cronExpr.trim()) {
      nextErrors.schedule = i18nService.t('scheduledTasksFormValidationCronRequired');
    }
    if (form.sessionTarget === 'main' && form.payloadKind !== 'systemEvent') {
      nextErrors.payloadKind = i18nService.t('scheduledTasksFormValidationPayloadMismatch');
    }
    if (form.sessionTarget === 'isolated' && form.payloadKind !== 'agentTurn') {
      nextErrors.payloadKind = i18nService.t('scheduledTasksFormValidationPayloadMismatch');
    }
    if (form.deliveryMode === 'webhook' && !form.deliveryTo.trim()) {
      nextErrors.deliveryTo = i18nService.t('scheduledTasksFormValidationWebhookRequired');
    }
    if (form.payloadKind === 'agentTurn' && form.timeoutSeconds.trim()) {
      const timeout = Number.parseInt(form.timeoutSeconds, 10);
      if (!Number.isFinite(timeout) || timeout < 0) {
        nextErrors.timeoutSeconds = i18nService.t('scheduledTasksFormValidationTimeout');
      }
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setSubmitting(true);
    try {
      const timeoutSeconds = Number.parseInt(form.timeoutSeconds, 10);
      const input: ScheduledTaskInput = {
        name: form.name.trim(),
        description: form.description.trim(),
        agentId: form.agentId.trim() || null,
        enabled: form.enabled,
        schedule: buildScheduleInput(form),
        sessionTarget: form.sessionTarget,
        wakeMode: form.wakeMode,
        payload: form.payloadKind === 'systemEvent'
          ? { kind: 'systemEvent', text: form.payloadText.trim() }
          : {
              kind: 'agentTurn',
              message: form.payloadText.trim(),
              ...(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
            },
        delivery: buildDeliveryInput(form),
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
  const normalizedDeliveryMode = normalizeDeliveryMode(form);

  return (
    <div className="p-4 space-y-4 max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
        {mode === 'create' ? i18nService.t('scheduledTasksFormCreate') : i18nService.t('scheduledTasksFormUpdate')}
      </h2>

      <div className="grid grid-cols-2 gap-4">
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
          <label className={labelClass}>{i18nService.t('scheduledTasksFormAgentId')}</label>
          <input
            type="text"
            value={form.agentId}
            onChange={(event) => updateForm({ agentId: event.target.value })}
            className={inputClass}
            placeholder={i18nService.t('scheduledTasksFormAgentIdPlaceholder')}
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormDescription')}</label>
        <textarea
          value={form.description}
          onChange={(event) => updateForm({ description: event.target.value })}
          className={`${inputClass} h-20 resize-none`}
          placeholder={i18nService.t('scheduledTasksFormDescriptionPlaceholder')}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
          <select
            value={form.scheduleKind}
            onChange={(event) => updateForm({ scheduleKind: event.target.value as ScheduleKind })}
            className={inputClass}
          >
            <option value="every">{i18nService.t('scheduledTasksFormScheduleModeEvery')}</option>
            <option value="at">{i18nService.t('scheduledTasksFormScheduleModeAt')}</option>
            <option value="cron">{i18nService.t('scheduledTasksFormScheduleModeCron')}</option>
          </select>
        </div>
        <div className="flex items-end">
          <label className="inline-flex items-center gap-2 text-sm dark:text-claude-darkText text-claude-text">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => updateForm({ enabled: event.target.checked })}
              className="rounded border-claude-border dark:border-claude-darkBorder"
            />
            {i18nService.t('scheduledTasksFormEnabled')}
          </label>
        </div>
      </div>

      {form.scheduleKind === 'at' && (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormRunAt')}</label>
          <input
            type="datetime-local"
            value={form.scheduleAt}
            onChange={(event) => updateForm({ scheduleAt: event.target.value })}
            className={inputClass}
          />
        </div>
      )}

      {form.scheduleKind === 'every' && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{i18nService.t('scheduledTasksFormEveryAmount')}</label>
            <input
              type="number"
              min="1"
              value={form.everyAmount}
              onChange={(event) => updateForm({ everyAmount: event.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>{i18nService.t('scheduledTasksFormEveryUnit')}</label>
            <select
              value={form.everyUnit}
              onChange={(event) => updateForm({ everyUnit: event.target.value as EveryUnit })}
              className={inputClass}
            >
              <option value="minutes">{i18nService.t('scheduledTasksFormIntervalMinutes')}</option>
              <option value="hours">{i18nService.t('scheduledTasksFormIntervalHours')}</option>
              <option value="days">{i18nService.t('scheduledTasksFormIntervalDays')}</option>
            </select>
          </div>
        </div>
      )}

      {form.scheduleKind === 'cron' && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{i18nService.t('scheduledTasksFormCronExpression')}</label>
            <input
              type="text"
              value={form.cronExpr}
              onChange={(event) => updateForm({ cronExpr: event.target.value })}
              className={inputClass}
              placeholder={i18nService.t('scheduledTasksFormCronPlaceholder')}
            />
          </div>
          <div>
            <label className={labelClass}>{i18nService.t('scheduledTasksFormCronTimezone')}</label>
            <input
              type="text"
              value={form.cronTz}
              onChange={(event) => updateForm({ cronTz: event.target.value })}
              className={inputClass}
              placeholder={i18nService.t('scheduledTasksFormCronTimezonePlaceholder')}
            />
          </div>
        </div>
      )}
      {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormSessionTarget')}</label>
          <select
            value={form.sessionTarget}
            onChange={(event) => updateForm({ sessionTarget: event.target.value as FormState['sessionTarget'] })}
            className={inputClass}
          >
            <option value="main">{i18nService.t('scheduledTasksFormSessionTargetMain')}</option>
            <option value="isolated">{i18nService.t('scheduledTasksFormSessionTargetIsolated')}</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormWakeMode')}</label>
          <select
            value={form.wakeMode}
            onChange={(event) => updateForm({ wakeMode: event.target.value as FormState['wakeMode'] })}
            className={inputClass}
          >
            <option value="now">{i18nService.t('scheduledTasksFormWakeModeNow')}</option>
            <option value="next-heartbeat">{i18nService.t('scheduledTasksFormWakeModeNextHeartbeat')}</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormPayloadKind')}</label>
          <select
            value={form.payloadKind}
            onChange={(event) => updateForm({ payloadKind: event.target.value as FormState['payloadKind'] })}
            className={inputClass}
          >
            <option value="systemEvent">{i18nService.t('scheduledTasksFormPayloadKindSystemEvent')}</option>
            <option value="agentTurn">{i18nService.t('scheduledTasksFormPayloadKindAgentTurn')}</option>
          </select>
          {errors.payloadKind && <p className={errorClass}>{errors.payloadKind}</p>}
        </div>
      </div>

      <div>
        <label className={labelClass}>
          {form.payloadKind === 'systemEvent'
            ? i18nService.t('scheduledTasksFormPayloadTextSystem')
            : i18nService.t('scheduledTasksFormPayloadTextAgent')}
        </label>
        <textarea
          value={form.payloadText}
          onChange={(event) => updateForm({ payloadText: event.target.value })}
          className={`${inputClass} h-28 resize-none`}
          placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
        />
        {errors.payloadText && <p className={errorClass}>{errors.payloadText}</p>}
      </div>

      {form.payloadKind === 'agentTurn' && (
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormTimeoutSeconds')}</label>
          <input
            type="number"
            min="0"
            value={form.timeoutSeconds}
            onChange={(event) => updateForm({ timeoutSeconds: event.target.value })}
            className={inputClass}
            placeholder={i18nService.t('scheduledTasksFormTimeoutSecondsPlaceholder')}
          />
          {errors.timeoutSeconds && <p className={errorClass}>{errors.timeoutSeconds}</p>}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{i18nService.t('scheduledTasksFormDeliveryMode')}</label>
          <select
            value={normalizedDeliveryMode}
            onChange={(event) => updateForm({ deliveryMode: event.target.value as DeliveryMode })}
            className={inputClass}
          >
            {supportsAnnounceDelivery(form) && (
              <option value="announce">{i18nService.t('scheduledTasksFormDeliveryModeAnnounce')}</option>
            )}
            <option value="webhook">{i18nService.t('scheduledTasksFormDeliveryModeWebhook')}</option>
            <option value="none">{i18nService.t('scheduledTasksFormDeliveryModeNone')}</option>
          </select>
        </div>

        {normalizedDeliveryMode === 'announce' && (
          <div>
            <label className={labelClass}>{i18nService.t('scheduledTasksFormDeliveryChannel')}</label>
            <select
              value={form.deliveryChannel || 'last'}
              onChange={(event) => updateForm({ deliveryChannel: event.target.value })}
              className={inputClass}
            >
              {channelOptions.map((channel) => (
                <option key={channel.value} value={channel.value}>
                  {channel.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {normalizedDeliveryMode !== 'none' && (
          <div className={normalizedDeliveryMode === 'webhook' ? 'col-span-2' : ''}>
            <label className={labelClass}>
              {normalizedDeliveryMode === 'webhook'
                ? i18nService.t('scheduledTasksFormWebhookUrl')
                : i18nService.t('scheduledTasksFormDeliveryTo')}
            </label>
            <input
              type="text"
              value={form.deliveryTo}
              onChange={(event) => updateForm({ deliveryTo: event.target.value })}
              className={inputClass}
              placeholder={i18nService.t('scheduledTasksFormDeliveryToPlaceholder')}
            />
            {errors.deliveryTo && <p className={errorClass}>{errors.deliveryTo}</p>}
          </div>
        )}
      </div>

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
