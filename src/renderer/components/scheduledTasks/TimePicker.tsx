import React, { useState, useRef, useEffect, useCallback } from 'react';

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
  const [isEditing, setIsEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setIsEditing(false);
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
  }, [isOpen]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const increment = useCallback(() => {
    onChange(value >= max ? 0 : value + 1);
  }, [value, max, onChange]);

  const decrement = useCallback(() => {
    onChange(value <= 0 ? max : value - 1);
  }, [value, max, onChange]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (isOpen) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      increment();
    } else {
      decrement();
    }
  }, [isOpen, increment, decrement]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      increment();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      decrement();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsOpen((prev) => !prev);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  }, [increment, decrement]);

  const handleClick = useCallback(() => {
    if (!isEditing) {
      setIsOpen((prev) => !prev);
    }
  }, [isEditing]);

  const handleDoubleClick = useCallback(() => {
    setIsOpen(false);
    setIsEditing(true);
  }, []);

  const commitEdit = useCallback((raw: string) => {
    setIsEditing(false);
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      onChange(Math.max(0, Math.min(max, parsed)));
    }
  }, [max, onChange]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      commitEdit(e.currentTarget.value);
    }
  }, [commitEdit]);

  const handleInputBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    commitEdit(e.currentTarget.value);
  }, [commitEdit]);

  const handleSelectValue = useCallback((v: number) => {
    onChange(v);
    setIsOpen(false);
  }, [onChange]);

  const handleListWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
  }, []);

  const display = String(value).padStart(2, '0');

  if (isEditing) {
    return (
      <div ref={containerRef} className="relative">
        <input
          ref={inputRef}
          type="text"
          maxLength={2}
          defaultValue={display}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          className="w-12 rounded-lg border border-primary bg-surface px-1 py-2 text-sm text-foreground text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        className="w-12 rounded-lg border border-border bg-surface px-1 py-2 text-sm text-foreground text-center cursor-pointer hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
      >
        {display}
      </button>
      {isOpen && (
        <div
          ref={listRef}
          onWheel={handleListWheel}
          className="absolute z-50 mt-1 w-16 max-h-[200px] overflow-y-auto rounded-lg border border-border bg-surface shadow-popover popover-enter"
        >
          {Array.from({ length: max + 1 }, (_, i) => (
            <div
              key={i}
              data-selected={i === value ? 'true' : undefined}
              onClick={() => handleSelectValue(i)}
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
