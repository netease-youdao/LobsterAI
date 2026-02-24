import React, { useState, useRef, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTask, Schedule, ScheduledTaskInput, NotifyPlatform } from '../../types/scheduledTask';

interface TaskFormProps {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  onCancel: () => void;
  onSaved: () => void;
}

type ScheduleMode = 'once' | 'daily' | 'weekly' | 'monthly';

const NOTIFY_PLATFORMS: NotifyPlatform[] = ['dingtalk', 'feishu', 'telegram', 'discord', 'nim'];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const; // 0=Sunday

// Parse existing schedule into UI state
function parseScheduleToUI(schedule: Schedule): {
  mode: ScheduleMode;
  date: string;
  time: string;
  weekday: number;
  monthDay: number;
} {
  const defaults = { mode: 'once' as ScheduleMode, date: '', time: '09:00', weekday: 1, monthDay: 1 };

  if (schedule.type === 'at') {
    const dt = schedule.datetime ?? '';
    // datetime-local format: "YYYY-MM-DDTHH:MM"
    if (dt.includes('T')) {
      return { ...defaults, mode: 'once', date: dt.slice(0, 10), time: dt.slice(11, 16) };
    }
    return { ...defaults, mode: 'once', date: dt.slice(0, 10) };
  }

  if (schedule.type === 'cron' && schedule.expression) {
    const parts = schedule.expression.trim().split(/\s+/);
    if (parts.length >= 5) {
      const [min, hour, dom, , dow] = parts;
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

      if (dow !== '*' && dom === '*') {
        // Weekly: M H * * DOW
        return { ...defaults, mode: 'weekly', time: timeStr, weekday: parseInt(dow) || 0 };
      }
      if (dom !== '*' && dow === '*') {
        // Monthly: M H DOM * *
        return { ...defaults, mode: 'monthly', time: timeStr, monthDay: parseInt(dom) || 1 };
      }
      // Daily: M H * * *
      return { ...defaults, mode: 'daily', time: timeStr };
    }
  }

  // Fallback for interval type - treat as daily
  if (schedule.type === 'interval') {
    return { ...defaults, mode: 'daily' };
  }

  return defaults;
}

const TaskForm: React.FC<TaskFormProps> = ({ mode, task, onCancel, onSaved }) => {
  const coworkConfig = useSelector((state: RootState) => state.cowork.config);
  const defaultWorkingDirectory = coworkConfig?.workingDirectory ?? '';

  // Parse existing schedule for edit mode
  const parsed = task ? parseScheduleToUI(task.schedule) : null;

  // Form state
  const [name, setName] = useState(task?.name ?? '');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(parsed?.mode ?? 'once');
  const [scheduleDate, setScheduleDate] = useState(parsed?.date ?? '');
  const [scheduleTime, setScheduleTime] = useState(parsed?.time ?? '09:00');
  const [weekday, setWeekday] = useState(parsed?.weekday ?? 1);
  const [monthDay, setMonthDay] = useState(parsed?.monthDay ?? 1);
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [workingDirectory, setWorkingDirectory] = useState(task?.workingDirectory ?? '');
  const [expiresAt, setExpiresAt] = useState(task?.expiresAt ?? '');
  const [notifyPlatforms, setNotifyPlatforms] = useState<NotifyPlatform[]>(task?.notifyPlatforms ?? []);
  const [notifyDropdownOpen, setNotifyDropdownOpen] = useState(false);
  const notifyDropdownRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifyDropdownRef.current && !notifyDropdownRef.current.contains(e.target as Node)) {
        setNotifyDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const buildSchedule = (): Schedule => {
    const [hour, min] = scheduleTime.split(':').map(Number);
    switch (scheduleMode) {
      case 'once':
        return { type: 'at', datetime: `${scheduleDate}T${scheduleTime}` };
      case 'daily':
        return { type: 'cron', expression: `${min} ${hour} * * *` };
      case 'weekly':
        return { type: 'cron', expression: `${min} ${hour} * * ${weekday}` };
      case 'monthly':
        return { type: 'cron', expression: `${min} ${hour} ${monthDay} * *` };
    }
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = i18nService.t('scheduledTasksFormValidationNameRequired');
    if (!prompt.trim()) newErrors.prompt = i18nService.t('scheduledTasksFormValidationPromptRequired');
    if (!(workingDirectory.trim() || defaultWorkingDirectory.trim())) {
      newErrors.workingDirectory = i18nService.t('scheduledTasksFormValidationWorkingDirectoryRequired');
    }
    if (scheduleMode === 'once') {
      if (!scheduleDate || !scheduleTime) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
      } else if (new Date(`${scheduleDate}T${scheduleTime}`).getTime() <= Date.now()) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
      }
    }
    if (!scheduleTime) {
      newErrors.schedule = i18nService.t('scheduledTasksFormValidationTimeRequired');
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const input: ScheduledTaskInput = {
        name: name.trim(),
        description: '',
        schedule: buildSchedule(),
        prompt: prompt.trim(),
        workingDirectory: workingDirectory.trim() || defaultWorkingDirectory,
        systemPrompt: '',
        executionMode: task?.executionMode ?? 'auto',
        expiresAt: expiresAt || null,
        notifyPlatforms,
        enabled: task?.enabled ?? true,
      };
      if (mode === 'create') {
        await scheduledTaskService.createTask(input);
      } else if (task) {
        await scheduledTaskService.updateTaskById(task.id, input);
      }
      onSaved();
    } catch {
      // Error handled by service
    } finally {
      setSubmitting(false);
    }
  };

  const handleBrowseDirectory = async () => {
    try {
      const result = await window.electron?.dialog?.selectDirectory();
      if (result?.success && result.path) {
        setWorkingDirectory(result.path);
      }
    } catch {
      // ignore
    }
  };

  const weekdayKeys: Record<number, string> = {
    0: 'scheduledTasksFormWeekSun',
    1: 'scheduledTasksFormWeekMon',
    2: 'scheduledTasksFormWeekTue',
    3: 'scheduledTasksFormWeekWed',
    4: 'scheduledTasksFormWeekThu',
    5: 'scheduledTasksFormWeekFri',
    6: 'scheduledTasksFormWeekSat',
  };

  const inputClass = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50';
  const labelClass = 'block text-sm font-medium dark:text-claude-darkText text-claude-text mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';

  const scheduleModes: ScheduleMode[] = ['once', 'daily', 'weekly', 'monthly'];

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
        {mode === 'create' ? i18nService.t('scheduledTasksFormCreate') : i18nService.t('scheduledTasksFormUpdate')}
      </h2>

      {/* Name */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormName')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          placeholder={i18nService.t('scheduledTasksFormNamePlaceholder')}
        />
        {errors.name && <p className={errorClass}>{errors.name}</p>}
      </div>

      {/* Prompt */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksPrompt')}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className={inputClass + ' h-28 resize-none'}
          placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
        />
        {errors.prompt && <p className={errorClass}>{errors.prompt}</p>}
      </div>

      {/* Schedule */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
        <div className="grid grid-cols-3 gap-2">
          {/* Schedule Mode Dropdown */}
          <select
            value={scheduleMode}
            onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
            className={inputClass}
          >
            {scheduleModes.map((m) => (
              <option key={m} value={m}>
                {i18nService.t(`scheduledTasksFormScheduleMode${m.charAt(0).toUpperCase() + m.slice(1)}`)}
              </option>
            ))}
          </select>

          {/* Second column: date/weekday/monthday or time (for daily) */}
          {scheduleMode === 'once' ? (
            <input
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className={inputClass}
              min={new Date().toISOString().slice(0, 10)}
            />
          ) : scheduleMode === 'weekly' ? (
            <select
              value={weekday}
              onChange={(e) => setWeekday(parseInt(e.target.value))}
              className={inputClass}
            >
              {WEEKDAYS.map((d) => (
                <option key={d} value={d}>
                  {i18nService.t(weekdayKeys[d])}
                </option>
              ))}
            </select>
          ) : scheduleMode === 'monthly' ? (
            <select
              value={monthDay}
              onChange={(e) => setMonthDay(parseInt(e.target.value))}
              className={inputClass}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}{i18nService.t('scheduledTasksFormMonthDaySuffix')}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className={inputClass}
            />
          )}

          {/* Third column: time picker (or empty for daily) */}
          {scheduleMode === 'daily' ? (
            <div />
          ) : (
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className={inputClass}
            />
          )}
        </div>
        {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}
      </div>

      {/* Working Directory */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormWorkingDirectory')}</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={workingDirectory}
            onChange={(e) => setWorkingDirectory(e.target.value)}
            className={inputClass + ' flex-1'}
            placeholder={defaultWorkingDirectory || i18nService.t('scheduledTasksFormWorkingDirectoryPlaceholder')}
          />
          <button
            type="button"
            onClick={handleBrowseDirectory}
            className="px-3 py-2 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {i18nService.t('browse')}
          </button>
        </div>
      </div>
      {errors.workingDirectory && <p className={errorClass}>{errors.workingDirectory}</p>}

      {/* Expires At */}
      <div>
        <label className={labelClass}>
          {i18nService.t('scheduledTasksFormExpiresAt')}
          <span className="text-xs font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary ml-1">
            {i18nService.t('scheduledTasksFormOptional')}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className={inputClass + ' flex-1'}
            min={new Date().toISOString().slice(0, 10)}
          />
          {expiresAt && (
            <button
              type="button"
              onClick={() => setExpiresAt('')}
              className="px-3 py-2 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              {i18nService.t('scheduledTasksFormExpiresAtClear')}
            </button>
          )}
        </div>
      </div>

      {/* Notification */}
      <div>
        <label className={labelClass}>
          {i18nService.t('scheduledTasksFormNotify')}
          <span className="text-xs font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary ml-1">
            {i18nService.t('scheduledTasksFormOptional')}
          </span>
        </label>
        <div className="relative" ref={notifyDropdownRef}>
          <button
            type="button"
            onClick={() => setNotifyDropdownOpen(!notifyDropdownOpen)}
            className={inputClass + ' flex items-center justify-between cursor-pointer text-left'}
          >
            <span className={notifyPlatforms.length === 0 ? 'dark:text-claude-darkTextSecondary text-claude-textSecondary' : ''}>
              {notifyPlatforms.length === 0
                ? i18nService.t('scheduledTasksFormNotifyNone')
                : notifyPlatforms.map((p) =>
                    i18nService.t(`scheduledTasksFormNotify${p.charAt(0).toUpperCase() + p.slice(1)}`)
                  ).join(', ')}
            </span>
            <svg className={`w-4 h-4 ml-2 transition-transform ${notifyDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {notifyDropdownOpen && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white shadow-lg py-1">
              {NOTIFY_PLATFORMS.map((platform) => {
                const checked = notifyPlatforms.includes(platform);
                return (
                  <label
                    key={platform}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setNotifyPlatforms(
                          checked
                            ? notifyPlatforms.filter((p) => p !== platform)
                            : [...notifyPlatforms, platform]
                        );
                      }}
                      className="text-claude-accent focus:ring-claude-accent rounded"
                    />
                    <span className="text-sm dark:text-claude-darkText text-claude-text">
                      {i18nService.t(`scheduledTasksFormNotify${platform.charAt(0).toUpperCase() + platform.slice(1)}`)}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
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
          onClick={handleSubmit}
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
