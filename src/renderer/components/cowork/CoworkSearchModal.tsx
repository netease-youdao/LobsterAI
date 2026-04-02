import React, { useEffect, useMemo, useRef, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionList from './CoworkSessionList';
import { HighlightText } from './CoworkSessionItem';

const emptySet = new Set<string>();

interface ContentSearchResult {
  sessionId: string;
  title: string;
  updatedAt: number;
  human: string;
  assistant: string;
  /** Normalised terms from the backend — used for multi-term highlighting. */
  terms: string[];
}

interface CoworkSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
}

/**
 * Extract a short snippet around the first occurrence of any term in `text`.
 * Window: up to 30 chars before + term itself + 60 chars after.
 */
export const getSnippet = (text: string, terms: string[], maxLen = 120): string => {
  if (!text || terms.length === 0) return text.slice(0, maxLen);
  const lower = text.toLowerCase();
  let bestIdx = -1;
  let bestTerm = '';
  for (const term of terms) {
    if (!term.trim()) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestTerm = term;
    }
  }
  if (bestIdx === -1) return text.slice(0, maxLen);
  const start = Math.max(0, bestIdx - 30);
  const end = Math.min(text.length, bestIdx + bestTerm.length + 60);
  const snippet = text.slice(start, end);
  return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`;
};

const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmedQuery = searchQuery.trim();

  // Title-only filter for instant feedback
  const titleMatchedSessions = useMemo(() => {
    const lower = trimmedQuery.toLowerCase();
    if (!lower) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(lower));
  }, [sessions, trimmedQuery]);

  // Merge title matches + content matches, deduplicating by sessionId
  const titleMatchedIds = useMemo(
    () => new Set(titleMatchedSessions.map((s) => s.id)),
    [titleMatchedSessions],
  );
  const contentOnlyResults = useMemo(
    () => contentResults.filter((r) => !titleMatchedIds.has(r.sessionId)),
    [contentResults, titleMatchedIds],
  );

  const hasQuery = trimmedQuery.length > 0;
  const isEmpty = hasQuery && !isSearching && titleMatchedSessions.length === 0 && contentOnlyResults.length === 0;

  // Debounced content search via IPC
  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setContentResults([]);
      setIsSearching(false);
      return;
    }

    // Set isSearching only inside the timeout so it doesn't flash on every keystroke
    // during the debounce window — it becomes true only when a request actually fires.
    debounceTimerRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const result = await window.electron.cowork.searchSessions(trimmedQuery);
        if (result.success) {
          setContentResults(result.results ?? []);
        }
      } catch {
        setContentResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [trimmedQuery]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
    setContentResults([]);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleSelectSession = async (sessionId: string) => {
    await onSelectSession(sessionId);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="modal-content w-full max-w-2xl mt-10 rounded-2xl border border-border bg-surface shadow-modal overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('searchChats')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={i18nService.t('coworkSearchPlaceholder')}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="px-3 py-3 max-h-[60vh] overflow-y-auto">
          {/* Loading indicator */}
          {isSearching && (
            <div className="py-4 text-center text-xs text-secondary animate-pulse">
              {i18nService.t('searching')}
            </div>
          )}

          {!isSearching && isEmpty && (
            <div className="py-10 text-center text-sm text-secondary">
              {i18nService.t('coworkSearchNoResults')}
            </div>
          )}

          {!isSearching && !isEmpty && (
            <>
              {/* Title-matched sessions — pass keyword so titles are highlighted */}
              {titleMatchedSessions.length > 0 && (
                <CoworkSessionList
                  sessions={titleMatchedSessions}
                  currentSessionId={currentSessionId}
                  isBatchMode={false}
                  selectedIds={emptySet}
                  showBatchOption={false}
                  highlightKeyword={hasQuery ? trimmedQuery : ''}
                  onSelectSession={handleSelectSession}
                  onDeleteSession={onDeleteSession}
                  onTogglePin={onTogglePin}
                  onRenameSession={onRenameSession}
                  onToggleSelection={() => {}}
                  onEnterBatchMode={() => {}}
                />
              )}

              {/* Content-matched sessions (not already shown by title) */}
              {contentOnlyResults.length > 0 && (
                <div className={titleMatchedSessions.length > 0 ? 'mt-2 border-t border-border pt-2' : ''}>
                  {hasQuery && (
                    <p className="px-2 pb-1 text-xs text-secondary">
                      {i18nService.t('coworkSearchMatchedContent')}
                    </p>
                  )}
                  <div className="space-y-1">
                    {contentOnlyResults.map((result) => {
                      // Use backend terms for matching — they include split sub-terms
                      // (e.g. "auth flow" → ["auth flow", "auth", "flow"]) so we can
                      // find the best snippet even when only a sub-term matches.
                      const terms = result.terms.length > 0 ? result.terms : [trimmedQuery];
                      const lowerTerms = terms.map((t) => t.toLowerCase());
                      const sourceText =
                        lowerTerms.some((t) => result.human.toLowerCase().includes(t))
                          ? result.human
                          : lowerTerms.some((t) => result.assistant.toLowerCase().includes(t))
                            ? result.assistant
                            : result.human || result.assistant;
                      const snippetText = getSnippet(sourceText, terms);
                      return (
                        <button
                          key={result.sessionId}
                          type="button"
                          className="w-full text-left px-3 py-2 rounded-xl hover:bg-surface-raised transition-colors"
                          onClick={() => void handleSelectSession(result.sessionId)}
                        >
                          <p className="text-sm font-medium text-foreground truncate">
                            <HighlightText
                              text={result.title || i18nService.t('coworkNewSession')}
                              keywords={terms}
                            />
                          </p>
                          {snippetText && (
                            <p className="mt-0.5 text-xs text-secondary line-clamp-2">
                              <HighlightText text={snippetText} keywords={terms} />
                            </p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CoworkSearchModal;