import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

interface DatePickerProps {
  year: number;
  month: number;
  day: number;
  onChange: (values: { year: number; month: number; day: number }) => void;
  className?: string;
}

interface DateSegmentProps {
  value: number;
  min: number;
  max: number;
  width: string;
  padLength: number;
  options?: { value: number; label: string }[];
  onChange: (value: number) => void;
}

const DateSegment: React.FC<DateSegmentProps> = ({ value, min, max, width, padLength, options, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(String(value).padStart(padLength, '0'));
  const [isFocused, setIsFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isFocused) {
      setInputValue(String(value).padStart(padLength, '0'));
    }
  }, [value, isFocused, padLength]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const selectedItem = listRef.current.querySelector('[data-selected="true"]');
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'center' });
    }
  }, [isOpen, value]);

  const commitValue = useCallback((raw: string) => {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed));
      onChange(clamped);
      setInputValue(String(clamped).padStart(padLength, '0'));
    } else {
      setInputValue(String(value).padStart(padLength, '0'));
    }
  }, [min, max, onChange, value, padLength]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, '');
    if (raw.length <= padLength) {
      setInputValue(raw);
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) {
        onChange(parsed);
      }
    }
  }, [padLength, min, max, onChange]);

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    inputRef.current?.select();
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    commitValue(inputValue);
  }, [inputValue, commitValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = value >= max ? min : value + 1;
      onChange(next);
      setInputValue(String(next).padStart(padLength, '0'));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = value <= min ? max : value - 1;
      onChange(next);
      setInputValue(String(next).padStart(padLength, '0'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitValue(inputValue);
      setIsOpen((prev) => !prev);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setInputValue(String(value).padStart(padLength, '0'));
    }
  }, [value, min, max, onChange, padLength, inputValue, commitValue]);

  const handleToggleDropdown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOpen((prev) => !prev);
    inputRef.current?.focus();
  }, []);

  const handleSelectValue = useCallback((v: number) => {
    onChange(v);
    setInputValue(String(v).padStart(padLength, '0'));
    setIsOpen(false);
    inputRef.current?.focus();
  }, [onChange, padLength]);

  const items = options || Array.from({ length: max - min + 1 }, (_, i) => ({
    value: min + i,
    label: String(min + i).padStart(padLength, '0'),
  }));

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center rounded-lg border border-border bg-surface hover:border-primary/50 focus-within:ring-2 focus-within:ring-primary/50 focus-within:border-transparent transition-colors">
        <input
          ref={inputRef}
          type="text"
          maxLength={padLength}
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onClick={() => setIsOpen(true)}
          className={`${width} bg-transparent px-1 py-2 text-sm text-foreground text-center focus:outline-none cursor-pointer`}
        />
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={handleToggleDropdown}
          className="px-0.5 py-2 text-secondary hover:text-foreground transition-colors"
        >
          <ChevronDownIcon className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {isOpen && (
        <div
          ref={listRef}
          className="absolute z-50 mt-1 w-full max-h-[200px] overflow-y-auto rounded-lg border border-border bg-surface shadow-popover popover-enter"
        >
          {items.map((item) => (
            <div
              key={item.value}
              data-selected={item.value === value ? 'true' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelectValue(item.value);
              }}
              className={`px-2 py-1.5 text-sm text-center cursor-pointer select-none ${
                item.value === value
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-foreground hover:bg-surface-raised'
              }`}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: String(i + 1).padStart(2, '0'),
}));

const DatePicker: React.FC<DatePickerProps> = ({
  year,
  month,
  day,
  onChange,
  className,
}) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const maxDay = daysInMonth(year, month);

  const yearOptions = Array.from({ length: 10 }, (_, i) => ({
    value: currentYear + i,
    label: String(currentYear + i),
  }));

  const dayOptions = Array.from({ length: maxDay }, (_, i) => ({
    value: i + 1,
    label: String(i + 1).padStart(2, '0'),
  }));

  const handleYearChange = useCallback((newYear: number) => {
    const newMaxDay = daysInMonth(newYear, month);
    onChange({ year: newYear, month, day: Math.min(day, newMaxDay) });
  }, [month, day, onChange]);

  const handleMonthChange = useCallback((newMonth: number) => {
    const newMaxDay = daysInMonth(year, newMonth);
    onChange({ year, month: newMonth, day: Math.min(day, newMaxDay) });
  }, [year, day, onChange]);

  const handleDayChange = useCallback((newDay: number) => {
    onChange({ year, month, day: newDay });
  }, [year, month, onChange]);

  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      <DateSegment
        value={year}
        min={currentYear}
        max={currentYear + 9}
        width="w-12"
        padLength={4}
        options={yearOptions}
        onChange={handleYearChange}
      />
      <span className="text-sm text-secondary font-medium">/</span>
      <DateSegment
        value={month}
        min={1}
        max={12}
        width="w-9"
        padLength={2}
        options={MONTH_OPTIONS}
        onChange={handleMonthChange}
      />
      <span className="text-sm text-secondary font-medium">/</span>
      <DateSegment
        value={day}
        min={1}
        max={maxDay}
        width="w-9"
        padLength={2}
        options={dayOptions}
        onChange={handleDayChange}
      />
    </div>
  );
};

export default DatePicker;
