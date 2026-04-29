import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';

interface DateInputProps {
  value: string; // YYYY-MM-DD or ''
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
}

const WEEKDAY_KEYS = [
  'scheduledTasksFormWeekShortSun',
  'scheduledTasksFormWeekShortMon',
  'scheduledTasksFormWeekShortTue',
  'scheduledTasksFormWeekShortWed',
  'scheduledTasksFormWeekShortThu',
  'scheduledTasksFormWeekShortFri',
  'scheduledTasksFormWeekShortSat',
] as const;

const PANEL_HEIGHT_ESTIMATE = 280;
const PANEL_WIDTH = 240;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toYMD(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseYMD(s: string): { y: number; m: number; d: number } | null {
  const [y, m, d] = s.split('-').map(Number);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
  return { y, m, d };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function firstDayOfWeek(year: number, month: number): number {
  return new Date(year, month - 1, 1).getDay();
}

interface PanelPos {
  top: number;
  left: number;
}

const DateInput: React.FC<DateInputProps> = ({ value, onChange, min, max, placeholder }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PanelPos>({ top: 0, left: 0 });

  // Calendar view state: the month currently displayed
  const today = new Date();
  const parsed = value ? parseYMD(value) : null;
  const [viewYear, setViewYear] = useState(parsed?.y ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.m ?? today.getMonth() + 1);

  // Sync view to value when it changes externally
  useEffect(() => {
    if (value) {
      const p = parseYMD(value);
      if (p) {
        setViewYear(p.y);
        setViewMonth(p.m);
      }
    }
  }, [value]);

  // Calculate panel position from trigger bounding rect
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < PANEL_HEIGHT_ESTIMATE && rect.top > spaceBelow;

    // Horizontal: prefer left-aligned, but shift left if it overflows the viewport
    let left = rect.left;
    if (left + PANEL_WIDTH > window.innerWidth - 8) {
      left = rect.right - PANEL_WIDTH;
    }
    // Ensure it doesn't go off the left edge either
    if (left < 8) left = 8;

    setPos({
      top: openAbove ? rect.top - PANEL_HEIGHT_ESTIMATE : rect.bottom + 4,
      left,
    });
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const goPrev = useCallback(() => {
    setViewMonth(m => {
      if (m === 1) {
        setViewYear(y => y - 1);
        return 12;
      }
      return m - 1;
    });
  }, []);

  const goNext = useCallback(() => {
    setViewMonth(m => {
      if (m === 12) {
        setViewYear(y => y + 1);
        return 1;
      }
      return m + 1;
    });
  }, []);

  const handleSelect = (day: number) => {
    onChange(toYMD(viewYear, viewMonth, day));
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
  };

  const isDisabled = (day: number): boolean => {
    const dateStr = toYMD(viewYear, viewMonth, day);
    if (min && dateStr < min) return true;
    if (max && dateStr > max) return true;
    return false;
  };

  // Build the calendar grid
  const totalDays = daysInMonth(viewYear, viewMonth);
  const startDay = firstDayOfWeek(viewYear, viewMonth);
  const todayStr = toYMD(today.getFullYear(), today.getMonth() + 1, today.getDate());

  // Display text
  const displayText = parsed ? `${parsed.y}/${pad(parsed.m)}/${pad(parsed.d)}` : '';

  return (
    <>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 text-xs rounded-md border border-border-subtle px-2 py-1 transition-colors ${
          open
            ? 'border-primary bg-surface text-foreground'
            : value
              ? 'bg-surface text-foreground hover:border-primary/50'
              : 'bg-surface text-secondary hover:border-primary/50'
        }`}
      >
        <CalendarIcon className="h-3 w-3 shrink-0 opacity-60" />
        <span className={value ? '' : 'opacity-50'}>
          {displayText || placeholder || '----/--/--'}
        </span>
        {value && (
          <span
            onClick={handleClear}
            className="ml-0.5 opacity-40 hover:opacity-100 transition-opacity"
          >
            ×
          </span>
        )}
      </button>

      {/* Calendar dropdown — rendered via portal to avoid overflow clipping */}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[9999] rounded-lg shadow-lg bg-surface border border-border p-3 select-none"
            style={{ top: pos.top, left: pos.left, minWidth: 240 }}
          >
            {/* Month/Year nav */}
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={goPrev}
                className="p-1 rounded text-secondary hover:bg-surface-raised transition-colors"
              >
                <ChevronLeftIcon className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs font-medium text-foreground">
                {viewYear} / {pad(viewMonth)}
              </span>
              <button
                type="button"
                onClick={goNext}
                className="p-1 rounded text-secondary hover:bg-surface-raised transition-colors"
              >
                <ChevronRightIcon className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {WEEKDAY_KEYS.map(key => (
                <div key={key} className="text-center text-[10px] text-secondary py-0.5">
                  {i18nService.t(key)}
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-0.5">
              {/* Empty cells before the first day */}
              {Array.from({ length: startDay }, (_, i) => (
                <div key={`e-${i}`} />
              ))}
              {/* Day cells */}
              {Array.from({ length: totalDays }, (_, i) => {
                const day = i + 1;
                const dateStr = toYMD(viewYear, viewMonth, day);
                const isSelected = dateStr === value;
                const isToday = dateStr === todayStr;
                const disabled = isDisabled(day);
                return (
                  <button
                    key={day}
                    type="button"
                    disabled={disabled}
                    onClick={() => handleSelect(day)}
                    className={`w-7 h-7 rounded text-xs transition-colors ${
                      isSelected
                        ? 'bg-primary text-white font-medium'
                        : disabled
                          ? 'text-secondary/30 cursor-not-allowed'
                          : isToday
                            ? 'text-primary font-medium hover:bg-surface-raised'
                            : 'text-foreground hover:bg-surface-raised'
                    }`}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

export default DateInput;
