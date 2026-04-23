import { useState, useEffect, useRef, useCallback } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionList from './CoworkSessionList';
import Modal from '../common/Modal';

const emptySet = new Set<string>();

interface CoworkSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Recent sessions shown when query is empty */
  recentSessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
}

const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  recentSessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CoworkSessionSummary[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const trimmed = query.trim();
      // Always query the backend so results are always cross-agent
      const result = await window.electron?.cowork?.searchSessions(trimmed);
      if (result?.success) {
        setSearchResults(result.sessions ?? []);
      }
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    // Skip debounce trigger on initial mount (isOpen=false) and let the
    // open-modal effect handle the first fetch immediately.
    if (!isOpen) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => runSearch(searchQuery), 250);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchQuery, runSearch, isOpen]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      // Immediately load all sessions cross-agent when modal opens
      void runSearch('');
      return;
    }
    setSearchQuery('');
    setSearchResults(null);
  }, [isOpen, runSearch]);

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

  // Always use backend search results (cross-agent); fall back to recentSessions only before first fetch
  const displaySessions = searchResults !== null ? searchResults : recentSessions;
  const isEmpty = !isSearching && displaySessions.length === 0;

  if (!isOpen) return null;

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-start justify-center modal-backdrop p-6"
      className="modal-content w-full max-w-2xl mt-10 rounded-2xl border border-border bg-surface shadow-modal overflow-hidden"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('search')}
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
          {isSearching ? (
            <div className="py-10 text-center text-sm text-secondary">
              {i18nService.t('searching')}
            </div>
          ) : isEmpty ? (
            <div className="py-10 text-center text-sm text-secondary">
              {searchQuery.trim() ? i18nService.t('searchNoResults') : i18nService.t('searchNoConversations')}
            </div>
          ) : (
            <CoworkSessionList
              sessions={displaySessions}
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
        </div>
      </div>
    </Modal>
  );
};

export default CoworkSearchModal;
