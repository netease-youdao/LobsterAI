import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

interface TimePickerProps {
  hour: number;
  minute: number;
  second?: number;
  showSeconds?: boolean;
  onChange: (values: { hour: number; minute: number; second?: number }) => void;
  className?: string;
}

interface SegmentProps {
  value: number;
  max: number;
  onChange: (value: number) => void;
}

const TimeSegment: React.FC<SegmentProps> = ({ value, max, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(String(value).padStart(2, '0'));
  const [isFocused, setIsFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isFocused) {
      setInputValue(String(value).padStart(2, '0'));
    }
  }, [value, isFocused]);

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
      const clamped = Math.max(0, Math.min(max, parsed));
      onChange(clamped);
      setInputValue(String(clamped).padStart(2, '0'));
    } else {
      setInputValue(String(value).padStart(2, '0'));
    }
  }, [max, onChange, value]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, '');
    if (raw.length <= 2) {
      setInputValue(raw);
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= max) {
        onChange(parsed);
      }
    }
  }, [max, onChange]);

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
      const next = value >= max ? 0 : value + 1;
      onChange(next);
      setInputValue(String(next).padStart(2, '0'));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = value <= 0 ? max : value - 1;
      onChange(next);
      setInputValue(String(next).padStart(2, '0'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitValue(inputValue);
      setIsOpen((prev) => !prev);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setInputValue(String(value).padStart(2, '0'));
    }
  }, [value, max, onChange, inputValue, commitValue]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (isOpen) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      const next = value >= max ? 0 : value + 1;
      onChange(next);
      setInputValue(String(next).padStart(2, '0'));
    } else {
      const next = value <= 0 ? max : value - 1;
      onChange(next);
      setInputValue(String(next).padStart(2, '0'));
    }
  }, [isOpen, value, max, onChange]);

  const handleToggleDropdown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOpen((prev) => !prev);
    inputRef.current?.focus();
  }, []);

  const handleSelectValue = useCallback((v: number) => {
    onChange(v);
    setInputValue(String(v).padStart(2, '0'));
    setIsOpen(false);
    inputRef.current?.focus();
  }, [onChange]);

  const handleListWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center rounded-lg border border-border bg-surface hover:border-primary/50 focus-within:ring-2 focus-within:ring-primary/50 focus-within:border-transparent transition-colors">
        <input
          ref={inputRef}
          type="text"
          maxLength={2}
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onWheel={handleWheel}
          onClick={() => setIsOpen(true)}
          className="w-9 bg-transparent px-1 py-2 text-sm text-foreground text-center focus:outline-none cursor-pointer"
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
          onWheel={handleListWheel}
          className="absolute z-50 mt-1 w-full max-h-[200px] overflow-y-auto rounded-lg border border-border bg-surface shadow-popover popover-enter"
        >
          {Array.from({ length: max + 1 }, (_, i) => (
            <div
              key={i}
              data-selected={i === value ? 'true' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelectValue(i);
              }}
              className={`px-2 py-1.5 text-sm text-center cursor-pointer select-none ${
                i === value
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-foreground hover:bg-surface-raised'
              }`}
            >
              {String(i).padStart(2, '0')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const TimePicker: React.FC<TimePickerProps> = ({
  hour,
  minute,
  second = 0,
  showSeconds = false,
  onChange,
  className,
}) => {
  const handleHourChange = useCallback((newHour: number) => {
    onChange({ hour: newHour, minute, ...(showSeconds ? { second } : {}) });
  }, [minute, second, showSeconds, onChange]);

  const handleMinuteChange = useCallback((newMinute: number) => {
    onChange({ hour, minute: newMinute, ...(showSeconds ? { second } : {}) });
  }, [hour, second, showSeconds, onChange]);

  const handleSecondChange = useCallback((newSecond: number) => {
    onChange({ hour, minute, second: newSecond });
  }, [hour, minute, onChange]);

  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      <TimeSegment value={hour} max={23} onChange={handleHourChange} />
      <span className="text-sm text-secondary font-medium">:</span>
      <TimeSegment value={minute} max={59} onChange={handleMinuteChange} />
      {showSeconds && (
        <>
          <span className="text-sm text-secondary font-medium">:</span>
          <TimeSegment value={second} max={59} onChange={handleSecondChange} />
        </>
      )}
    </div>
  );
};

export default TimePicker;
