import { i18nService } from '../../services/i18n';
import { formatMessageDateTime } from '../../utils/tokenFormat';

export interface AgentTaskRelativeTime {
  compact: string;
  full: string;
}

const Milliseconds = {
  Minute: 60000,
  Hour: 3600000,
  Day: 86400000,
} as const;

const CalendarUnit = {
  HoursPerDay: 24,
  DaysPerWeek: 7,
  DaysPerMonth: 30,
  MonthsPerYear: 12,
} as const;

const formatDuration = (
  value: number,
  unitKey: string,
  timestamp: number,
): AgentTaskRelativeTime => {
  const unit = i18nService.t(unitKey);
  const compact = i18nService.getLanguage() === 'zh' ? `${value} ${unit}` : `${value}${unit}`;
  return {
    compact,
    full: formatMessageDateTime(timestamp) || compact,
  };
};

export const formatAgentTaskRelativeTime = (timestamp: number): AgentTaskRelativeTime => {
  const safeTimestamp = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  const diff = Math.max(0, Date.now() - safeTimestamp);
  const minutes = Math.max(1, Math.floor(diff / Milliseconds.Minute));
  if (minutes <= 60) {
    return formatDuration(minutes, 'myAgentSidebarMinuteShort', safeTimestamp);
  }

  const hours = Math.floor(diff / Milliseconds.Hour);

  if (hours < CalendarUnit.HoursPerDay) {
    return formatDuration(hours, 'myAgentSidebarHourShort', safeTimestamp);
  }

  const days = Math.floor(diff / Milliseconds.Day);
  if (days < CalendarUnit.DaysPerWeek) {
    return formatDuration(days, 'myAgentSidebarDayShort', safeTimestamp);
  }

  if (days < CalendarUnit.DaysPerMonth) {
    return formatDuration(
      Math.floor(days / CalendarUnit.DaysPerWeek),
      'myAgentSidebarWeekShort',
      safeTimestamp,
    );
  }

  const months = Math.floor(days / CalendarUnit.DaysPerMonth);
  if (months < CalendarUnit.MonthsPerYear) {
    return formatDuration(months, 'myAgentSidebarMonthShort', safeTimestamp);
  }

  return formatDuration(
    Math.floor(months / CalendarUnit.MonthsPerYear),
    'myAgentSidebarYearShort',
    safeTimestamp,
  );
};
