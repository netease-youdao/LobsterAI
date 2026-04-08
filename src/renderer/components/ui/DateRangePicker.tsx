import {
  CalendarIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Zero-pad to 2 digits */
const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** Format Date → 'YYYY-MM-DD' */
const toDateStr = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Check if two dates are the same calendar day */
const isSameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Get all days to display for a month (includes leading/trailing days from adjacent months) */
function getCalendarDays(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0=Sun
  const days: Date[] = [];

  // Leading days from previous month
  for (let i = startOffset - 1; i >= 0; i--) {
    days.push(new Date(year, month, -i));
  }

  // Current month days
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(new Date(year, month, d));
  }

  // Trailing days to fill 6 rows (42 cells) — only if needed
  while (days.length < 42) {
    const last = days[days.length - 1];
    days.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }

  return days;
}

/* ------------------------------------------------------------------ */
/*  i18n labels                                                       */
/* ------------------------------------------------------------------ */

const WEEKDAY_LABELS_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_LABELS_EN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const MONTH_LABELS_ZH = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
];
const MONTH_LABELS_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function getWeekdayLabels(): string[] {
  return i18nService.getLanguage() === 'zh' ? WEEKDAY_LABELS_ZH : WEEKDAY_LABELS_EN;
}

function getMonthLabel(month: number): string {
  return i18nService.getLanguage() === 'zh'
    ? MONTH_LABELS_ZH[month]
    : MONTH_LABELS_EN[month];
}

function formatMonthTitle(year: number, month: number): string {
  return i18nService.getLanguage() === 'zh'
    ? `${year}年${month + 1}月`
    : `${getMonthLabel(month)} ${year}`;
}

/* ------------------------------------------------------------------ */
/*  MonthGrid                                                         */
/* ------------------------------------------------------------------ */

interface MonthGridProps {
  year: number;
  month: number;
  selectedStart: string;
  selectedEnd: string;
  hoverDate: Date | null;
  onDateClick: (date: Date) => void;
  onDateHover: (date: Date | null) => void;
}

const MonthGrid: React.FC<MonthGridProps> = ({
  year,
  month,
  selectedStart,
  selectedEnd,
  hoverDate,
  onDateClick,
  onDateHover,
}) => {
  const days = useMemo(() => getCalendarDays(year, month), [year, month]);
  const today = useMemo(() => new Date(), []);
  const weekdays = getWeekdayLabels();

  const startDate = useMemo(() => selectedStart ? new Date(selectedStart) : null, [selectedStart]);
  const endDate = useMemo(() => selectedEnd ? new Date(selectedEnd) : null, [selectedEnd]);

  const isInRange = useCallback(
    (date: Date): boolean => {
      if (!startDate) return false;
      const end = endDate || hoverDate;
      if (!end) return false;

      const ts = date.getTime();
      const s = startDate.getTime();
      const e = end.getTime();
      return ts >= Math.min(s, e) && ts <= Math.max(s, e);
    },
    [startDate, endDate, hoverDate],
  );

  const isRangeStart = useCallback(
    (date: Date): boolean => {
      if (!startDate) return false;
      return isSameDay(date, startDate);
    },
    [startDate],
  );

  const isRangeEnd = useCallback(
    (date: Date): boolean => {
      if (!endDate) return false;
      return isSameDay(date, endDate);
    },
    [endDate],
  );

  return (
    <div className="w-[224px]">
      {/* Month title */}
      <div className="text-center text-sm font-medium text-foreground mb-2">
        {formatMonthTitle(year, month)}
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-0 mb-1">
        {weekdays.map((label) => (
          <div
            key={label}
            className="text-center text-xs text-secondary font-medium py-0.5"
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-0">
        {days.map((date, idx) => {
          const isCurrentMonth = date.getMonth() === month;
          const isToday = isSameDay(date, today);
          const inRange = isInRange(date);
          const isStart = isRangeStart(date);
          const isEnd = isRangeEnd(date);
          const isSelected = isStart || isEnd;

          return (
            <button
              key={idx}
              type="button"
              onClick={() => onDateClick(date)}
              onMouseEnter={() => onDateHover(date)}
              onMouseLeave={() => onDateHover(null)}
              className={`
                h-8 w-8 text-xs flex items-center justify-center transition-colors relative
                ${!isCurrentMonth ? 'text-secondary/40' : 'text-foreground'}
                ${isToday && !isSelected ? 'border border-primary rounded' : ''}
                ${isSelected ? 'bg-primary text-white rounded-md z-10' : ''}
                ${inRange && !isSelected ? 'bg-primary/10' : ''}
                ${!isSelected && isCurrentMonth ? 'hover:bg-surface-raised rounded' : ''}
              `}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  DateRangePicker                                                   */
/* ------------------------------------------------------------------ */

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onStartDateChange: (v: string) => void;
  onEndDateChange: (v: string) => void;
  onClear: () => void;
}

const DateRangePicker: React.FC<DateRangePickerProps> = ({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onClear,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // "selecting" means user has clicked a start date and is hovering for end
  const [selecting, setSelecting] = useState(false);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);

  // Calendar view state — left panel month
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());

  // Right panel is always viewMonth + 1
  const rightYear = viewMonth === 11 ? viewYear + 1 : viewYear;
  const rightMonth = viewMonth === 11 ? 0 : viewMonth + 1;

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
        setSelecting(false);
        setHoverDate(null);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Navigate months
  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const prevYear = () => setViewYear((y) => y - 1);
  const nextYear = () => setViewYear((y) => y + 1);

  // Handle date selection
  const handleDateClick = (date: Date) => {
    const dateStr = toDateStr(date);

    if (!selecting) {
      // First click: set start
      onStartDateChange(dateStr);
      onEndDateChange('');
      setSelecting(true);
    } else {
      // Second click: set end (swap if needed)
      const start = new Date(startDate);
      if (date < start) {
        onStartDateChange(dateStr);
        onEndDateChange(startDate);
      } else {
        onEndDateChange(dateStr);
      }
      setSelecting(false);
      setHoverDate(null);
    }
  };

  const handleClear = () => {
    onClear();
    setSelecting(false);
    setHoverDate(null);
  };

  // Display label
  const hasRange = startDate || endDate;
  const displayLabel = hasRange
    ? `${startDate || '...'} → ${endDate || '...'}`
    : i18nService.t('scheduledTasksHistoryDateRange');

  const startPlaceholder = i18nService.getLanguage() === 'zh' ? '开始日期' : 'Start date';
  const endPlaceholder = i18nService.getLanguage() === 'zh' ? '结束日期' : 'End date';

  return (
    <div className="relative" ref={ref}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl border transition-colors shrink-0 ${
          hasRange
            ? 'border-primary text-primary bg-primary-muted'
            : 'border-border text-secondary bg-surface hover:border-primary'
        }`}
      >
        <CalendarIcon className="w-4 h-4" />
        <span className="truncate max-w-[200px]">{displayLabel}</span>
        {hasRange && (
          <XMarkIcon
            className="w-3.5 h-3.5 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              handleClear();
            }}
          />
        )}
      </button>

      {/* Dropdown calendar */}
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 rounded-xl shadow-popover bg-surface border border-border p-4">
          {/* Input row */}
          <div className="flex items-center gap-2 mb-3">
            <div className={`flex-1 px-2 py-1.5 text-sm rounded-lg border ${
              selecting ? 'border-primary' : 'border-border'
            } bg-background text-foreground`}>
              {startDate || <span className="text-secondary">{startPlaceholder}</span>}
            </div>
            <span className="text-secondary text-sm">→</span>
            <div className={`flex-1 px-2 py-1.5 text-sm rounded-lg border ${
              !selecting && endDate ? 'border-primary' : 'border-border'
            } bg-background text-foreground`}>
              {endDate || <span className="text-secondary">{endPlaceholder}</span>}
            </div>
            <CalendarIcon className="w-4 h-4 text-secondary shrink-0" />
          </div>

          {/* Navigation + two month grids */}
          <div className="flex items-start gap-4">
            {/* Left month */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={prevYear}
                    className="p-0.5 rounded hover:bg-surface-raised text-secondary hover:text-foreground transition-colors"
                  >
                    <ChevronDoubleLeftIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={prevMonth}
                    className="p-0.5 rounded hover:bg-surface-raised text-secondary hover:text-foreground transition-colors"
                  >
                    <ChevronLeftIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1" />
              </div>
              <MonthGrid
                year={viewYear}
                month={viewMonth}
                selectedStart={startDate}
                selectedEnd={endDate}
                hoverDate={selecting ? hoverDate : null}
                onDateClick={handleDateClick}
                onDateHover={setHoverDate}
              />
            </div>

            {/* Right month */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex-1" />
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={nextMonth}
                    className="p-0.5 rounded hover:bg-surface-raised text-secondary hover:text-foreground transition-colors"
                  >
                    <ChevronRightIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={nextYear}
                    className="p-0.5 rounded hover:bg-surface-raised text-secondary hover:text-foreground transition-colors"
                  >
                    <ChevronDoubleRightIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <MonthGrid
                year={rightYear}
                month={rightMonth}
                selectedStart={startDate}
                selectedEnd={endDate}
                hoverDate={selecting ? hoverDate : null}
                onDateClick={handleDateClick}
                onDateHover={setHoverDate}
              />
            </div>
          </div>

          {/* Clear button */}
          {hasRange && (
            <div className="flex justify-end mt-3 pt-2 border-t border-border">
              <button
                type="button"
                onClick={handleClear}
                className="text-xs text-secondary hover:text-destructive transition-colors"
              >
                {i18nService.getLanguage() === 'zh' ? '清除' : 'Clear'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DateRangePicker;
