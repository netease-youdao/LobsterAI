import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  disabled = false,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const selectedIndex = options.findIndex((o) => o.value === value);

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
    if (isOpen) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
      requestAnimationFrame(() => {
        const list = listRef.current;
        if (!list) return;
        const selected = list.querySelector('[aria-selected="true"]');
        if (selected) {
          (selected as HTMLElement).scrollIntoView({ block: 'nearest' });
        }
      });
    }
  }, [isOpen, selectedIndex]);

  const scrollHighlightedIntoView = useCallback((index: number) => {
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      const items = list.querySelectorAll('[role="option"]');
      if (items[index]) {
        (items[index] as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    });
  }, []);

  const findNextEnabledIndex = (from: number, direction: 1 | -1): number => {
    let idx = from;
    while (idx >= 0 && idx < options.length) {
      if (!options[idx].disabled) return idx;
      idx += direction;
    }
    return -1;
  };

  const handleSelect = (opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setIsOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;

    if (!isOpen) {
      if (event.key === 'ArrowDown' || event.key === ' ') {
        event.preventDefault();
        setIsOpen(true);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        setIsOpen(true);
        return;
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setIsOpen(false);
        break;
      case 'ArrowDown': {
        event.preventDefault();
        const next = findNextEnabledIndex(highlightedIndex + 1, 1);
        if (next !== -1) {
          setHighlightedIndex(next);
          scrollHighlightedIntoView(next);
        }
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = findNextEnabledIndex(highlightedIndex - 1, -1);
        if (prev !== -1) {
          setHighlightedIndex(prev);
          scrollHighlightedIntoView(prev);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const opt = options[highlightedIndex];
        if (opt && !opt.disabled) {
          handleSelect(opt);
        }
        break;
      }
    }
  };

  const itemClass = (index: number, opt: SelectOption) => {
    const base = 'px-3 py-2 cursor-pointer select-none truncate';

    if (opt.disabled) {
      return `${base} text-secondary opacity-50 cursor-not-allowed`;
    }

    if (opt.value === value) {
      return `${base} bg-primary/10 text-primary font-medium`;
    }

    if (index === highlightedIndex) {
      return `${base} bg-surface-raised text-foreground`;
    }

    return `${base} text-foreground hover:bg-surface-raised`;
  };

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className={`flex items-center justify-between w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        }`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="truncate">{selectedOption?.label || value}</span>
        <ChevronDownIcon
          className={`h-4 w-4 ml-2 text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 rounded-lg border border-border bg-surface shadow-popover popover-enter">
          <ul
            ref={listRef}
            className="py-1 max-h-60 overflow-y-auto text-sm"
            role="listbox"
          >
            {options.map((opt, index) => (
              <li
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                className={itemClass(index, opt)}
                onMouseEnter={() => {
                  if (!opt.disabled) setHighlightedIndex(index);
                }}
                onClick={() => handleSelect(opt)}
              >
                {opt.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default CustomSelect;
