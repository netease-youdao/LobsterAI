import {
  ArrowDownIcon,
  ArrowUpIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef } from 'react';

import { i18nService } from '../../services/i18n';
import SidebarSearchIcon from '../icons/SidebarSearchIcon';
import {
  ConversationSearchDirection,
  ConversationSearchErrorReason,
  type ConversationSearchErrorReason as ConversationSearchErrorReasonValue,
  ConversationSearchStatus,
  type ConversationSearchStatus as ConversationSearchStatusValue,
} from './conversationSearch';

interface CoworkConversationSearchProps {
  query: string;
  status: ConversationSearchStatusValue;
  errorReason?: ConversationSearchErrorReasonValue | null;
  activeMatchIndex: number;
  resultCount: number;
  isResultLimitReached: boolean;
  focusRequestKey: number;
  onQueryChange: (query: string) => void;
  onNavigate: (direction: typeof ConversationSearchDirection[keyof typeof ConversationSearchDirection]) => void;
  onClose: () => void;
}

const CoworkConversationSearch: React.FC<CoworkConversationSearchProps> = ({
  query,
  status,
  errorReason = null,
  activeMatchIndex,
  resultCount,
  isResultLimitReached,
  focusRequestKey,
  onQueryChange,
  onNavigate,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasQuery = query.trim().length > 0;
  const hasResults = resultCount > 0;
  const shouldShowNavigation = hasQuery && status === ConversationSearchStatus.Ready;
  const shouldShowResultRow = hasQuery
    || status === ConversationSearchStatus.Loading
    || status === ConversationSearchStatus.Error;

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [focusRequestKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const resultText = status === ConversationSearchStatus.Loading
    ? i18nService.t('coworkConversationSearchLoading')
    : status === ConversationSearchStatus.Error
      ? i18nService.t(errorReason === ConversationSearchErrorReason.HistoryTooLarge
        ? 'coworkConversationSearchTooLarge'
        : 'coworkConversationSearchFailed')
      : hasQuery
        ? i18nService.t('coworkConversationSearchResults')
          .replace('{current}', String(hasResults ? activeMatchIndex + 1 : 0))
          .replace('{total}', `${resultCount}${isResultLimitReached ? '+' : ''}`)
        : '';

  return (
    <div
      className="non-draggable relative -mr-1 top-1 z-40 w-[340px] min-w-[min(240px,calc(100vw_-_24px))] max-w-[calc(100vw_-_24px)] self-start overflow-hidden rounded-3xl border border-border/80 bg-surface-overlay text-foreground shadow-[0_10px_30px_rgba(15,23,42,0.12)] backdrop-blur-xl dark:shadow-[0_12px_34px_rgba(0,0,0,0.42)]"
      role="search"
      data-cowork-conversation-search="true"
    >
      <div className="flex h-12 items-center px-4">
        <SidebarSearchIcon className="h-[18px] w-[18px] shrink-0 text-foreground/80" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              onNavigate(event.shiftKey
                ? ConversationSearchDirection.Previous
                : ConversationSearchDirection.Next);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
          className="min-w-0 flex-1 border-0 bg-transparent px-3 text-[15px] leading-5 text-foreground outline-none placeholder:text-muted/90 focus:outline-none focus:ring-0"
          placeholder={i18nService.t('coworkConversationSearchPlaceholder')}
          aria-label={i18nService.t('coworkConversationSearchPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="mx-1.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-foreground/[0.10] hover:text-foreground"
          aria-label={i18nService.t('coworkConversationSearchClose')}
          title={i18nService.t('coworkConversationSearchClose')}
        >
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {shouldShowResultRow && (
        <div className="flex h-8 items-center justify-between border-t border-border/70 px-4 text-xs text-muted">
          {shouldShowNavigation && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onNavigate(ConversationSearchDirection.Previous)}
                disabled={!hasResults}
                className="inline-flex h-6 w-5 items-center justify-center rounded text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                aria-label={i18nService.t('coworkConversationSearchPrevious')}
                title={i18nService.t('coworkConversationSearchPrevious')}
              >
                <ArrowUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate(ConversationSearchDirection.Next)}
                disabled={!hasResults}
                className="inline-flex h-6 w-5 items-center justify-center rounded text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                aria-label={i18nService.t('coworkConversationSearchNext')}
                title={i18nService.t('coworkConversationSearchNext')}
              >
                <ArrowDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
          <div
            className="ml-auto min-w-0 truncate pl-3 text-right"
            role="status"
            aria-live="polite"
            title={resultText || undefined}
          >
            {resultText}
          </div>
        </div>
      )}
    </div>
  );
};

export default CoworkConversationSearch;
