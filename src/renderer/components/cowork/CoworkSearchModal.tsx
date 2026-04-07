import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredSessions = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(trimmedQuery));
  }, [sessions, searchQuery]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
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
          {filteredSessions.length === 0 ? (
            <div className="py-10 text-center text-sm text-secondary">
              {i18nService.t('searchNoResults')}
            </div>
          ) : (
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
          )}
        </div>
      </div>
    </Modal>
  );
};

export default CoworkSearchModal;
