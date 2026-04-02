import React, { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { XMarkIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import { i18nService } from '../../services/i18n';

export interface InPageSearchState {
  query: string;
  /** Index of the currently focused match (0-based) */
  activeIndex: number;
  /** Total number of matches across all turns */
  totalCount: number;
}

/** Methods exposed to the parent via ref */
export interface CoworkInPageSearchHandle {
  focus(): void;
}

interface CoworkInPageSearchProps {
  state: InPageSearchState;
  onChange: (query: string) => void;
  onNavigate: (direction: 'prev' | 'next') => void;
  onClose: () => void;
}

const CoworkInPageSearch = forwardRef<CoworkInPageSearchHandle, CoworkInPageSearchProps>(
  function CoworkInPageSearch({ state, onChange, onNavigate, onClose }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Expose focus() to parent
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // Auto-focus when mounted
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Keyboard navigation inside the bar
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onNavigate(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const { query, activeIndex, totalCount } = state;
  const hasQuery = query.trim().length > 0;
  const counterText = hasQuery
    ? totalCount === 0
      ? i18nService.t('inPageSearchNoResults')
      : `${activeIndex + 1} / ${totalCount}`
    : '';

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
      // Prevent clicks inside the bar from bubbling to the detail pane
      onClick={(e) => e.stopPropagation()}
    >
      <SearchIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />

      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={i18nService.t('inPageSearchPlaceholder')}
        className="flex-1 min-w-0 bg-transparent text-sm dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary outline-none"
        aria-label={i18nService.t('inPageSearchPlaceholder')}
      />

      {/* Match counter */}
      {hasQuery && (
        <span
          className={`shrink-0 text-xs tabular-nums ${
            totalCount === 0
              ? 'dark:text-red-400 text-red-500'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
          }`}
        >
          {counterText}
        </span>
      )}

      {/* Prev / Next buttons */}
      <button
        type="button"
        disabled={totalCount === 0}
        onClick={() => onNavigate('prev')}
        className="p-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 transition-colors"
        aria-label={i18nService.t('inPageSearchPrev')}
      >
        <ChevronUpIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        disabled={totalCount === 0}
        onClick={() => onNavigate('next')}
        className="p-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 transition-colors"
        aria-label={i18nService.t('inPageSearchNext')}
      >
        <ChevronDownIcon className="h-4 w-4" />
      </button>

      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        aria-label={i18nService.t('close')}
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
});

export default CoworkInPageSearch;
