import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import { MANAGEMENT_BODY_TEXT } from '../common/managementTypography';

export interface LibraryFilterDropdownOption<T extends string> {
  value: T;
  label: string;
  leading?: React.ReactNode;
  labelClassName?: string;
}

interface LibraryFilterDropdownProps<T extends string> {
  value: T;
  options: readonly LibraryFilterDropdownOption<T>[];
  ariaLabel: string;
  onChange: (value: T) => void;
  triggerLabel?: string;
  triggerLeading?: React.ReactNode;
  showSelectedLeading?: boolean;
  active?: boolean;
  triggerClassName?: string;
  menuClassName?: string;
}

const LibraryFilterDropdown = <T extends string,>({
  value,
  options,
  ariaLabel,
  onChange,
  triggerLabel,
  triggerLeading,
  showSelectedLeading = true,
  active = false,
  triggerClassName = 'min-w-[104px]',
  menuClassName = 'w-44',
}: LibraryFilterDropdownProps<T>): React.ReactElement => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const selectedOption = options.find(option => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;
  const selectedLeading = triggerLeading !== undefined
    ? triggerLeading
    : showSelectedLeading
      ? selectedOption?.leading
      : undefined;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`${ariaLabel}: ${selectedLabel}`}
        onClick={() => setIsOpen(open => !open)}
        className={`inline-flex h-9 items-center gap-2 rounded-xl border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
          isOpen
            ? 'border-primary/40 bg-surface-raised'
            : active
              ? 'border-primary/30 bg-primary/5 text-primary'
              : 'border-border'
        } ${triggerClassName}`}
      >
        {selectedLeading}
        {triggerLabel && (
          <span className={`shrink-0 font-normal ${active ? 'text-primary/80' : 'text-tertiary'}`}>
            {triggerLabel}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 text-secondary transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`popover-enter absolute left-0 top-full z-30 mt-1 max-h-[360px] overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-popover ${menuClassName}`}
        >
          {options.map(option => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`flex h-9 w-full items-center gap-3 px-3 text-left ${MANAGEMENT_BODY_TEXT} transition-colors ${
                  selected
                    ? 'bg-surface-raised font-medium text-foreground'
                    : 'text-foreground hover:bg-surface-raised'
                }`}
              >
                {option.leading}
                <span className={`min-w-0 flex-1 truncate ${option.labelClassName ?? ''}`}>
                  {option.label}
                </span>
                {selected && <CheckIcon className="h-4 w-4 shrink-0" strokeWidth={2.25} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default LibraryFilterDropdown;
