import React, { useEffect, useMemo, useRef, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import { i18nService } from '../../services/i18n';

interface AgentItem {
  id: string;
  icon: string;
  name: string;
  description: string;
}

interface AgentSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: AgentItem[];
  onSelectAgent: (agentId: string) => void;
}

const AgentSearchModal: React.FC<AgentSearchModalProps> = ({
  isOpen,
  onClose,
  agents,
  onSelectAgent,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hasQuery = searchQuery.trim().length > 0;

  const filteredAgents = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return [];
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(trimmedQuery) ||
        a.description.toLowerCase().includes(trimmedQuery),
    );
  }, [agents, searchQuery]);

  const hasResults = hasQuery && filteredAgents.length > 0;

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

  const handleSelect = (agentId: string) => {
    onSelectAgent(agentId);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="modal-content w-full max-w-2xl mt-10 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-modal overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('searchExperts')}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Search input — integrated with close button */}
        <div className={`px-4 py-3${hasResults ? ' border-b dark:border-claude-darkBorder border-claude-border' : ''}`}>
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary pointer-events-none" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={i18nService.t('searchExperts')}
              className="w-full pl-9 pr-9 py-2.5 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary focus:outline-none"
            />
            <button
              type="button"
              onClick={onClose}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Results list — only when searching */}
        {hasQuery && (
          <div className="px-3 py-3 max-h-[60vh] overflow-y-auto">
            {filteredAgents.length === 0 ? (
              <div className="py-10 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('searchExpertsNoResults')}
              </div>
            ) : (
              <div className="space-y-0.5">
                {filteredAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => handleSelect(agent.id)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover flex items-center justify-center text-xl shrink-0">
                      {agent.icon || '🤖'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">
                        {agent.name}
                      </div>
                      {agent.description && (
                        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 line-clamp-1">
                          {agent.description}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentSearchModal;