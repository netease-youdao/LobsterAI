import {
  ChevronDownIcon,
  ChevronUpIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/office/word/wordEditorSession';
import { cycleFindMatchIndex } from '@/services/office/word/wordToolbarLayout';

const t = (key: string) => i18nService.t(key);
type WordTextMatch = ReturnType<NonNullable<WordEditorSession['editor']>['findMatches']>[number];

export interface WordFindBarProps {
  session: WordEditorSession;
  focusRequestId: number;
  onClose: () => void;
}

export function WordFindBar({
  session,
  focusRequestId,
  onClose,
}: WordFindBarProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<readonly WordTextMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequestId]);

  const runSearch = useCallback((nextQuery: string, autoSelect: boolean) => {
    const editor = session.editor;
    const trimmed = nextQuery.trim();
    if (!editor || !trimmed) {
      setMatches([]);
      setActiveIndex(-1);
      return;
    }
    const found = editor.findMatches(trimmed);
    setMatches(found);
    if (found.length === 0) {
      setActiveIndex(-1);
      return;
    }
    const targetIndex = 0;
    setActiveIndex(targetIndex);
    if (autoSelect) {
      editor.selectMatch(found[targetIndex]);
    }
  }, [session]);

  const stepMatch = useCallback((delta: 1 | -1) => {
    const editor = session.editor;
    const trimmed = query.trim();
    if (!editor || !trimmed) return;
    const latest = editor.findMatches(trimmed);
    setMatches(latest);
    if (latest.length === 0) {
      setActiveIndex(-1);
      return;
    }
    const nextIndex = cycleFindMatchIndex(activeIndex, latest.length, delta);
    setActiveIndex(nextIndex);
    if (nextIndex >= 0 && latest[nextIndex]) {
      editor.selectMatch(latest[nextIndex]);
    }
  }, [activeIndex, query, session]);

  const hasQuery = Boolean(query.trim());
  const counterLabel = hasQuery
    ? matches.length > 0
      ? `${activeIndex + 1} / ${matches.length}`
      : t('wordFindNoMatches')
    : '';

  return (
    <div
      className="lobster-word-find-bar"
      role="search"
      aria-label={t('wordFind')}
      onPointerUp={event => event.stopPropagation()}
    >
      <MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={event => {
          const next = event.target.value;
          setQuery(next);
          runSearch(next, true);
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            stepMatch(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder={t('wordFindPlaceholder')}
        aria-label={t('wordFindPlaceholder')}
        spellCheck={false}
        className="lobster-word-find-input"
      />
      {counterLabel && (
        <span className="lobster-word-find-count" aria-live="polite">
          {counterLabel}
        </span>
      )}
      <button
        type="button"
        className="lobster-word-find-btn"
        title={t('wordFindPrevious')}
        aria-label={t('wordFindPrevious')}
        disabled={matches.length === 0}
        onClick={() => stepMatch(-1)}
      >
        <ChevronUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="lobster-word-find-btn"
        title={t('wordFindNext')}
        aria-label={t('wordFindNext')}
        disabled={matches.length === 0}
        onClick={() => stepMatch(1)}
      >
        <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="lobster-word-find-btn"
        title={t('close')}
        aria-label={t('close')}
        onClick={onClose}
      >
        <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
