import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionList from './CoworkSessionList';

const emptySet = new Set<string>();
const DEBOUNCE_MS = 300;

interface ContentMatchResult {
  sessionId: string;
  title: string;
  updatedAt: number;
  human: string;
  assistant: string;
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
  const [contentResults, setContentResults] = useState<ContentMatchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const titleFilteredSessions = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(trimmedQuery));
  }, [sessions, searchQuery]);

  const titleMatchedIds = useMemo(
    () => new Set(titleFilteredSessions.map((s) => s.id)),
    [titleFilteredSessions],
  );

  const contentOnlyResults = useMemo(
    () => contentResults.filter((r) => !titleMatchedIds.has(r.sessionId)),
    [contentResults, titleMatchedIds],
  );

  const searchContent = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setContentResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    try {
      const response = await window.electron.cowork.searchSessions({
        query: trimmed,
        maxResults: 10,
      });
      if (response.success && response.results) {
        setContentResults(response.results);
      } else {
        setContentResults([]);
      }
    } catch {
      setContentResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setContentResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    debounceTimerRef.current = setTimeout(() => {
      searchContent(trimmed);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [searchQuery, searchContent]);

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
    setIsSearching(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleSelectSession = async (sessionId: string) => {
    await onSelectSession(sessionId);
    onClose();
  };

  if (!isOpen) return null;

  const hasQuery = searchQuery.trim().length > 0;
  const hasAnyResult = titleFilteredSessions.length > 0 || contentOnlyResults.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="modal-content w-full max-w-2xl mt-10 rounded-2xl border border-border bg-surface shadow-modal overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('search')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={i18nService.t('searchConversations')}
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
          {!hasAnyResult && !isSearching ? (
            <div className="py-10 text-center text-sm text-secondary">
              {hasQuery ? i18nService.t('searchNoResults') : i18nService.t('searchNoResults')}
            </div>
          ) : (
            <>
              {titleFilteredSessions.length > 0 && (
                <CoworkSessionList
                  sessions={titleFilteredSessions}
                  currentSessionId={currentSessionId}
                  isBatchMode={false}
                  selectedIds={emptySet}
                  showBatchOption={false}
                  onSelectSession={handleSelectSession}
                  onDeleteSession={onDeleteSession}
                  onTogglePin={onTogglePin}
                  onRenameSession={onRenameSession}
                  onToggleSelection={() => {}}
                  onEnterBatchMode={() => {}}
                />
              )}
              {hasQuery && contentOnlyResults.length > 0 && (
                <div className={titleFilteredSessions.length > 0 ? 'mt-3 pt-3 border-t border-border' : ''}>
                  <div className="px-1 pb-2 text-xs font-medium text-secondary uppercase tracking-wider">
                    {i18nService.t('searchContentMatch')}
                  </div>
                  <div className="space-y-1">
                    {contentOnlyResults.map((result) => (
                      <button
                        key={result.sessionId}
                        type="button"
                        onClick={() => handleSelectSession(result.sessionId)}
                        className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-surface-raised transition-colors group"
                      >
                        <div className="text-sm font-medium text-foreground truncate">
                          {result.title}
                        </div>
                        {result.human && (
                          <div className="mt-1 text-xs text-secondary line-clamp-2">
                            {result.human}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {isSearching && hasQuery && (
                <div className="py-4 text-center">
                  <div className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-r-transparent" />
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
