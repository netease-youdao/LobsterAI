import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionList from './CoworkSessionList';

const emptySet = new Set<string>();

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

// Cache for message content to avoid repeated loads
const messageContentCache = new Map<string, string>();

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
  const [isSearchingMessages, setIsSearchingMessages] = useState(false);
  // Map from sessionId -> matched snippet for message-level matches
  const [messageMatchMap, setMessageMatchMap] = useState<Map<string, string>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  const titleFilteredSessions = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(trimmedQuery));
  }, [sessions, searchQuery]);

  // Full-text search in message content for sessions NOT matched by title
  const performMessageSearch = useCallback(async (query: string, signal: AbortSignal) => {
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery) {
      setMessageMatchMap(new Map());
      setIsSearchingMessages(false);
      return;
    }

    const titleMatchedIds = new Set(
      sessions
        .filter((s) => s.title.toLowerCase().includes(trimmedQuery))
        .map((s) => s.id)
    );

    const toSearch = sessions.filter((s) => !titleMatchedIds.has(s.id));
    if (toSearch.length === 0) {
      setMessageMatchMap(new Map());
      setIsSearchingMessages(false);
      return;
    }

    setIsSearchingMessages(true);
    const newMap = new Map<string, string>();

    for (const session of toSearch) {
      if (signal.aborted) break;

      let content = messageContentCache.get(session.id);
      if (content === undefined) {
        try {
          const loaded = await coworkService.loadSession(session.id);
          if (signal.aborted) break;
          if (loaded) {
            content = loaded.messages
              .filter((m) => m.type === 'user' || m.type === 'assistant')
              .map((m) => m.content)
              .join(' ');
            messageContentCache.set(session.id, content);
          } else {
            content = '';
            messageContentCache.set(session.id, content);
          }
        } catch {
          content = '';
          messageContentCache.set(session.id, content);
        }
      }

      if (content && content.toLowerCase().includes(trimmedQuery)) {
        // Extract a brief snippet around the match
        const idx = content.toLowerCase().indexOf(trimmedQuery);
        const start = Math.max(0, idx - 30);
        const end = Math.min(content.length, idx + trimmedQuery.length + 60);
        const snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
        newMap.set(session.id, snippet);
      }
    }

    if (!signal.aborted) {
      setMessageMatchMap(newMap);
      setIsSearchingMessages(false);
    }
  }, [sessions]);

  // Debounced message search trigger
  useEffect(() => {
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const abort = new AbortController();
    searchAbortRef.current = abort;

    const timer = setTimeout(() => {
      void performMessageSearch(searchQuery, abort.signal);
    }, 300);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [searchQuery, performMessageSearch]);

  // Combined filtered sessions: title matches + message content matches
  const filteredSessions = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return sessions;

    const titleMatched = sessions.filter((s) => s.title.toLowerCase().includes(trimmedQuery));
    const titleMatchedIds = new Set(titleMatched.map((s) => s.id));

    const messageMatched = sessions.filter(
      (s) => !titleMatchedIds.has(s.id) && messageMatchMap.has(s.id)
    );

    return [...titleMatched, ...messageMatched];
  }, [sessions, searchQuery, messageMatchMap]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
    setMessageMatchMap(new Map());
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

  const trimmedQuery = searchQuery.trim();

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
            {isSearchingMessages && trimmedQuery && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-secondary animate-pulse">
                {i18nService.t('searchSearching')}
              </span>
            )}
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
          {filteredSessions.length === 0 && !isSearchingMessages ? (
            <div className="py-10 text-center text-sm text-secondary">
              {i18nService.t('searchNoResults')}
            </div>
          ) : (
            <>
              {messageMatchMap.size > 0 && trimmedQuery && (
                <div className="mb-2 px-2">
                  {Array.from(messageMatchMap.entries()).map(([sessionId, snippet]) => {
                    const session = sessions.find((s) => s.id === sessionId);
                    if (!session) return null;
                    return (
                      <div key={sessionId} className="mb-1 px-2 py-1 rounded text-xs text-secondary bg-surface-raised border-l-2 border-primary/40">
                        <span className="font-medium text-foreground">{session.title}</span>
                        <span className="mx-1 text-secondary">·</span>
                        <span>{i18nService.t('searchMatchedInMessage')}</span>
                        <div className="mt-0.5 text-secondary/80 truncate">{snippet}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              <CoworkSessionList
                sessions={filteredSessions}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CoworkSearchModal;
