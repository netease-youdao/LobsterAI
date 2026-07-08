import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { AgentId } from '@shared/agent';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import { RootState } from '../../store';
import { CoworkSessionStatusValue, type CoworkSessionSummary } from '../../types/cowork';
import { getAgentDisplayNameById } from '../../utils/agentDisplay';
import { formatAgentTaskRelativeTime } from '../agentSidebar/time';
import Modal from '../common/Modal';

const SEARCH_SESSION_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 180;
const TASK_SEARCH_ANALYTICS_SOURCE = 'home_task_search';

const getSessionAgentId = (session: CoworkSessionSummary) => {
  return session.agentId?.trim() || AgentId.Main;
};

const getSessionAgentType = (session: CoworkSessionSummary): 'main' | 'custom' => (
  getSessionAgentId(session) === AgentId.Main ? 'main' : 'custom'
);

const reportTaskSearchAction = (
  actionType: string,
  options: {
    agentType?: 'main' | 'custom';
    hasQuery?: boolean;
    isCurrentSession?: boolean;
    resultCount?: number;
    sessionStatus?: string;
  } = {},
): void => {
  console.debug('[CoworkSearch] reporting task search analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.TaskSearchAction,
    source: TASK_SEARCH_ANALYTICS_SOURCE,
    actionType,
    hasQuery: options.hasQuery,
    resultCount: options.resultCount,
    isCurrentSession: options.isCurrentSession,
    sessionStatus: options.sessionStatus,
    agentType: options.agentType,
  });
};

const mergeUniqueSessions = (
  primary: CoworkSessionSummary[],
  secondary: CoworkSessionSummary[],
): CoworkSessionSummary[] => {
  const seen = new Set<string>();
  const result: CoworkSessionSummary[] = [];
  [...primary, ...secondary].forEach((session) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    result.push(session);
  });
  return result;
};

const renderHighlightedTitle = (title: string, query: string): React.ReactNode => {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) return title;
  const matchIndex = title.toLowerCase().indexOf(trimmedQuery);
  if (matchIndex === -1) return title;
  return (
    <>
      {title.slice(0, matchIndex)}
      <span className="rounded-[3px] bg-primary/15 text-foreground">
        {title.slice(matchIndex, matchIndex + trimmedQuery.length)}
      </span>
      {title.slice(matchIndex + trimmedQuery.length)}
    </>
  );
};

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-background px-1 font-sans text-[10px] font-medium text-secondary">
    {children}
  </kbd>
);

interface CoworkSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (session: CoworkSessionSummary) => void | Promise<void>;
}

const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  sessions,
  currentSessionId,
  onSelectSession,
}) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [searchResultQuery, setSearchResultQuery] = useState('');
  const [searchSessions, setSearchSessions] = useState<CoworkSessionSummary[]>(sessions);
  const [recentSessions, setRecentSessions] = useState<CoworkSessionSummary[]>(sessions);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const reportedOpenRef = useRef(false);
  const reportedEmptyResultKeyRef = useRef<string | null>(null);
  const navigationSourceRef = useRef<'keyboard' | 'pointer'>('keyboard');

  const displayedSessions = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return recentSessions;
    const resultQuery = searchResultQuery.trim().toLowerCase();
    const titleMatches = resultQuery === trimmedQuery ? searchSessions : [];

    const recentMatches = recentSessions.filter((session) => {
      const agentId = getSessionAgentId(session);
      const agentName = getAgentDisplayNameById(agentId, agents) ?? agentId;
      return session.title.toLowerCase().includes(trimmedQuery)
        || agentName.toLowerCase().includes(trimmedQuery);
    });

    return mergeUniqueSessions(titleMatches, recentMatches);
  }, [agents, recentSessions, searchQuery, searchResultQuery, searchSessions]);

  const agentNameBySessionId = useMemo(() => {
    const names = new Map<string, string>();
    displayedSessions.forEach((session) => {
      const agentId = getSessionAgentId(session);
      names.set(session.id, getAgentDisplayNameById(agentId, agents) ?? agentId);
    });
    return names;
  }, [agents, displayedSessions]);

  const hasQuery = searchQuery.trim().length > 0;

  useEffect(() => {
    if (isOpen) {
      if (!reportedOpenRef.current) {
        reportedOpenRef.current = true;
        reportTaskSearchAction('open', {
          hasQuery: false,
          resultCount: sessions.length,
        });
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
    setDebouncedSearchQuery('');
    setSearchResultQuery('');
    reportedOpenRef.current = false;
    reportedEmptyResultKeyRef.current = null;
  }, [isOpen, sessions.length]);

  useEffect(() => {
    if (!isOpen) {
      setSearchSessions(sessions);
      setRecentSessions(sessions);
      setSearchResultQuery('');
    }
  }, [isOpen, sessions]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, searchQuery]);

  useEffect(() => {
    if (!isOpen) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const query = debouncedSearchQuery.trim();
    setIsLoading(true);
    void coworkService.listSessionsForSearch(SEARCH_SESSION_LIMIT, 0, query)
      .then((result) => {
        if (requestId !== requestIdRef.current) return;
        if (!result.success || !result.sessions) {
          console.warn('[CoworkSearch] failed to load task search results:', result.error);
          setSearchSessions([]);
          setSearchResultQuery(query);
          return;
        }
        setSearchSessions(result.sessions);
        setSearchResultQuery(query);
        if (!query) {
          setRecentSessions(result.sessions);
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      });
  }, [debouncedSearchQuery, isOpen]);

  useEffect(() => {
    navigationSourceRef.current = 'keyboard';
    setActiveIndex(0);
  }, [displayedSessions]);

  const handleSelectSession = useCallback(async (session: CoworkSessionSummary) => {
    reportTaskSearchAction('select_result', {
      agentType: getSessionAgentType(session),
      hasQuery: searchQuery.trim().length > 0,
      isCurrentSession: session.id === currentSessionId,
      resultCount: displayedSessions.length,
      sessionStatus: session.status,
    });
    await onSelectSession(session);
    onClose();
  }, [currentSessionId, displayedSessions.length, onClose, onSelectSession, searchQuery]);

  const handleClose = useCallback(() => {
    reportTaskSearchAction('close', {
      hasQuery: searchQuery.trim().length > 0,
      resultCount: displayedSessions.length,
    });
    onClose();
  }, [displayedSessions.length, onClose, searchQuery]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Let the IME consume keys (including Escape) while composing
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        handleClose();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (displayedSessions.length === 0) return;
        navigationSourceRef.current = 'keyboard';
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((prev) => {
          const count = displayedSessions.length;
          return (prev + delta + count) % count;
        });
        return;
      }
      if (event.key === 'Enter') {
        const session = displayedSessions[activeIndex];
        if (!session) return;
        event.preventDefault();
        void handleSelectSession(session);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, displayedSessions, handleClose, handleSelectSession, isOpen]);

  useEffect(() => {
    if (!isOpen || isLoading || displayedSessions.length > 0) return;
    const emptyResultKey = `${searchQuery.trim().length > 0 ? 'query' : 'recent'}:${searchResultQuery}`;
    if (reportedEmptyResultKeyRef.current === emptyResultKey) return;
    reportedEmptyResultKeyRef.current = emptyResultKey;
    reportTaskSearchAction('empty_result', {
      hasQuery: searchQuery.trim().length > 0,
      resultCount: 0,
    });
  }, [displayedSessions.length, isLoading, isOpen, searchQuery, searchResultQuery]);

  if (!isOpen) return null;

  return (
    <Modal
      onClose={handleClose}
      overlayClassName="fixed inset-0 z-50 flex items-start justify-center bg-black/10 px-6 pt-[14vh] backdrop-blur-[1px] dark:bg-black/30"
      className="modal-content w-full max-w-[640px] overflow-hidden rounded-[18px] border border-border bg-white shadow-modal dark:bg-surface"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('search')}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <MagnifyingGlassIcon className="h-5 w-5 shrink-0 text-secondary/70" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={i18nService.t('searchConversations')}
            aria-label={i18nService.t('search')}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-foreground placeholder-secondary/70 outline-none"
          />
          {isLoading && (
            <svg className="h-4 w-4 shrink-0 animate-spin text-secondary/50" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
          <button
            type="button"
            onClick={handleClose}
            aria-label={i18nService.t('close')}
            title={i18nService.t('close')}
            className="flex h-6 shrink-0 items-center rounded-md border border-border bg-background px-1.5 text-[11px] font-medium text-secondary transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
          >
            Esc
          </button>
        </div>
        <div className="px-2 pb-1.5 pt-2">
          <div className="px-2.5 pb-1.5 text-[12px] font-medium text-secondary/80">
            {hasQuery ? i18nService.t('searchResults') : i18nService.t('searchRecentTasks')}
          </div>
          <div className="max-h-[min(420px,48vh)] overflow-y-auto">
            {displayedSessions.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-sm text-secondary">
                {!isLoading && <MagnifyingGlassIcon className="h-6 w-6 text-secondary/40" />}
                <span>{isLoading ? i18nService.t('loading') : i18nService.t('searchNoResults')}</span>
              </div>
            ) : (
              displayedSessions.map((session, index) => {
                const agentName = agentNameBySessionId.get(session.id) ?? getSessionAgentId(session);
                const isCurrent = session.id === currentSessionId;
                const isActive = index === activeIndex;
                const isRunning = session.status === CoworkSessionStatusValue.Running;
                const relativeTime = formatAgentTaskRelativeTime(session.updatedAt || session.createdAt);
                return (
                  <button
                    key={session.id}
                    type="button"
                    ref={(node) => {
                      if (node && isActive && navigationSourceRef.current === 'keyboard') {
                        node.scrollIntoView({ block: 'nearest' });
                      }
                    }}
                    onClick={() => void handleSelectSession(session)}
                    onMouseMove={() => {
                      navigationSourceRef.current = 'pointer';
                      if (activeIndex !== index) setActiveIndex(index);
                    }}
                    className={`flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13px] transition-colors ${
                      isActive
                        ? 'bg-black/[0.05] text-foreground dark:bg-white/[0.08]'
                        : 'text-secondary'
                      }`}
                  >
                    {isRunning && (
                      <span
                        className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
                        title={i18nService.t('myAgentSidebarRunning')}
                        aria-label={i18nService.t('myAgentSidebarRunning')}
                      >
                        <svg className="h-3 w-3 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                          />
                        </svg>
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {renderHighlightedTitle(session.title, searchQuery)}
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 rounded-[5px] bg-primary/10 px-1.5 py-px text-[11px] font-medium text-primary">
                        {i18nService.t('searchCurrentTask')}
                      </span>
                    )}
                    <span className="max-w-[136px] shrink-0 truncate text-[12px] text-secondary/75">
                      {agentName}
                    </span>
                    <span
                      className="w-[52px] shrink-0 text-right text-[12px] tabular-nums text-secondary/50"
                      title={relativeTime.full}
                    >
                      {relativeTime.compact}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-secondary/60">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span>{i18nService.t('searchHintSelect')}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            <span>{i18nService.t('searchHintOpen')}</span>
          </span>
        </div>
      </div>
    </Modal>
  );
};

export default CoworkSearchModal;
