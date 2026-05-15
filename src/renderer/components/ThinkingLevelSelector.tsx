import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../services/i18n';

interface ThinkingLevelOption {
  value: string;
  labelKey: string;
  fallbackLabel: string;
}

const THINKING_LEVEL_OPTIONS: ThinkingLevelOption[] = [
  { value: '', labelKey: 'coworkThinkingDefault', fallbackLabel: 'Default' },
  { value: 'off', labelKey: '', fallbackLabel: 'Off' },
  { value: 'minimal', labelKey: '', fallbackLabel: 'Minimal' },
  { value: 'low', labelKey: '', fallbackLabel: 'Low' },
  { value: 'medium', labelKey: '', fallbackLabel: 'Medium' },
  { value: 'high', labelKey: '', fallbackLabel: 'High' },
  { value: 'adaptive', labelKey: '', fallbackLabel: 'Adaptive' },
];

interface ThinkingLevelSelectorProps {
  value: string;
  onChange: (level: string) => void;
  disabled?: boolean;
  compact?: boolean;
  dropdownDirection?: 'up' | 'down';
}

const ThinkingLevelSelector: React.FC<ThinkingLevelSelectorProps> = ({
  value,
  onChange,
  disabled = false,
  compact = false,
  dropdownDirection = 'up',
}) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const getOptionLabel = (opt: ThinkingLevelOption): string => {
    if (opt.labelKey) {
      return i18nService.t(opt.labelKey) || opt.fallbackLabel;
    }
    return opt.fallbackLabel;
  };

  const currentOption = THINKING_LEVEL_OPTIONS.find(o => o.value === value) ?? THINKING_LEVEL_OPTIONS[0];
  const displayLabel = getOptionLabel(currentOption);

  const triggerClassName = compact
    ? 'space-x-1.5 px-2 py-1 rounded-lg max-w-[160px]'
    : 'space-x-2 px-3 py-1.5 rounded-xl max-w-[200px]';
  const triggerTextClassName = compact ? 'text-xs' : 'text-sm';
  const triggerIconClassName = compact ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const dropdownPositionClass = dropdownDirection === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1';

  const handleSelect = (optValue: string) => {
    onChange(optValue);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${disabled ? 'cursor-wait' : 'cursor-pointer'}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={`flex items-center hover:bg-surface-raised text-foreground transition-colors disabled:opacity-70 disabled:cursor-wait ${triggerClassName} ${isOpen ? 'bg-surface-raised' : ''}`}
        aria-label={i18nService.t('coworkThinkingLevel') || 'Thinking Level'}
      >
        <span className={`${triggerTextClassName} truncate`}>{displayLabel}</span>
        <ChevronDownIcon className={`${triggerIconClassName} shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
      </button>

      {isOpen && (
        <div
          className={`absolute right-0 ${dropdownPositionClass} w-44 bg-surface rounded-xl shadow-popover z-50 border-border border overflow-hidden`}
        >
          <div className="py-1 max-h-72 overflow-y-auto">
            {THINKING_LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleSelect(opt.value)}
                className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 transition-colors hover:bg-surface-raised ${
                  value === opt.value ? 'text-foreground' : 'text-secondary'
                }`}
              >
                <span className="truncate text-[13px] font-normal leading-5">{getOptionLabel(opt)}</span>
                {value === opt.value && <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingLevelSelector;
