import {
  ChatBubbleBottomCenterTextIcon,
  ChatBubbleLeftIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { AgentId } from '@shared/agent';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import { RootState } from '../../store';
import {
  type CoworkSessionContentSearchItem,
  CoworkSessionStatusValue,
  type CoworkSessionSummary,
} from '../../types/cowork';
import { getAgentDisplayNameById } from '../../utils/agentDisplay';
import { formatAgentTaskRelativeTime } from '../agentSidebar/time';
import Modal from '../common/Modal';
import SkinPresentationScope from '../skin/SkinPresentationScope';
import { requestConversationSearch } from './pendingConversationSearch';

const SEARCH_SESSION_LIMIT = 100;
const SEARCH_CONTENT_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 180;
const TASK_SEARCH_ANALYTICS_SOURCE = 'home_task_search';
// Hits are a fixed blue (not the theme primary, which some themes make orange or pink) on a
// faint tint, so they stand out from the gray excerpt without shifting its line rhythm.
const SEARCH_HIT_CLASS_NAME = 'rounded-[3px] bg-[#2563EB]/[0.08] font-medium text-[#2563EB] '
  + 'box-decoration-clone dark:bg-[#60A5FA]/[0.16] dark:text-[#7CB4FF]';
const SECTION_LABEL_CLASS_NAME = 'px-2.5 pb-1 pt-1.5 text-[11px] font-medium tracking-wide text-secondary/60';

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
      <span className={SEARCH_HIT_CLASS_NAME}>
        {title.slice(matchIndex, matchIndex + trimmedQuery.length)}
      </span>
      {title.slice(matchIndex + trimmedQuery.length)}
    </>
  );
};

const renderHighlightedSnippet = (
  snippet: string,
  highlightStart: number,
  highlightLength: number,
): React.ReactNode => {
  if (highlightStart < 0 || highlightLength <= 0) return snippet;
  const highlightEnd = highlightStart + highlightLength;
  return (
    <>
      {snippet.slice(0, highlightStart)}
      <span className={SEARCH_HIT_CLASS_NAME}>
        {snippet.slice(highlightStart, highlightEnd)}
      </span>
      {snippet.slice(highlightEnd)}
    </>
  );
};

type SearchResultRow =
  | { kind: 'title'; session: CoworkSessionSummary }
  | { kind: 'content'; session: CoworkSessionSummary; match: CoworkSessionContentSearchItem['match'] };

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
  const [contentResults, setContentResults] = useState<CoworkSessionContentSearchItem[]>([]);
  const [contentResultQuery, setContentResultQuery] = useState('');
  const [isContentLoading, setIsContentLoading] = useState(false);
  const contentRequestIdRef = useRef(0);
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

  // Content hits for sessions already listed by title add nothing new; drop them.
  const displayedContentResults = useMemo(() => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery || contentResultQuery !== trimmedQuery) return [];
    const titleSessionIds = new Set(displayedSessions.map(session => session.id));
    return contentResults.filter(item => !titleSessionIds.has(item.session.id));
  }, [contentResultQuery, contentResults, displayedSessions, searchQuery]);

  const resultRows = useMemo<SearchResultRow[]>(() => [
    ...displayedSessions.map(session => ({ kind: 'title' as const, session })),
    ...displayedContentResults.map(item => ({
      kind: 'content' as const,
      session: item.session,
      match: item.match,
    })),
  ], [displayedContentResults, displayedSessions]);

  const agentNameBySessionId = useMemo(() => {
    const names = new Map<string, string>();
    resultRows.forEach(({ session }) => {
      const agentId = getSessionAgentId(session);
      names.set(session.id, getAgentDisplayNameById(agentId, agents) ?? agentId);
    });
    return names;
  }, [agents, resultRows]);

  const hasQuery = searchQuery.trim().length > 0;
  const isSearching = isLoading || isContentLoading;

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
      setContentResults([]);
      setContentResultQuery('');
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
    if (!isOpen) return;
    const requestId = contentRequestIdRef.current + 1;
    contentRequestIdRef.current = requestId;
    const query = debouncedSearchQuery.trim();
    if (!query) {
      setContentResults([]);
      setContentResultQuery('');
      setIsContentLoading(false);
      return;
    }
    setIsContentLoading(true);
    void coworkService.searchSessionContent(query, SEARCH_CONTENT_LIMIT)
      .then((result) => {
        if (requestId !== contentRequestIdRef.current) return;
        if (!result.success) {
          console.warn('[CoworkSearch] failed to load content search results:', result.error);
        }
        setContentResults(result.success ? result.results ?? [] : []);
        setContentResultQuery(query);
      })
      .finally(() => {
        if (requestId === contentRequestIdRef.current) {
          setIsContentLoading(false);
        }
      });
  }, [debouncedSearchQuery, isOpen]);

  useEffect(() => {
    navigationSourceRef.current = 'keyboard';
    setActiveIndex(0);
  }, [resultRows]);

  const handleSelectRow = useCallback(async (row: SearchResultRow) => {
    const { session } = row;
    reportTaskSearchAction(row.kind === 'content' ? 'select_content_result' : 'select_result', {
      agentType: getSessionAgentType(session),
      hasQuery: searchQuery.trim().length > 0,
      isCurrentSession: session.id === currentSessionId,
      resultCount: resultRows.length,
      sessionStatus: session.status,
    });
    if (row.kind === 'content') {
      // Queue before switching so the session view claims it as soon as it shows this session.
      requestConversationSearch(session.id, searchQuery);
    }
    await onSelectSession(session);
    onClose();
  }, [currentSessionId, onClose, onSelectSession, resultRows.length, searchQuery]);

  const handleClose = useCallback(() => {
    reportTaskSearchAction('close', {
      hasQuery: searchQuery.trim().length > 0,
      resultCount: resultRows.length,
    });
    onClose();
  }, [onClose, resultRows.length, searchQuery]);

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
        if (resultRows.length === 0) return;
        navigationSourceRef.current = 'keyboard';
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((prev) => {
          const count = resultRows.length;
          return (prev + delta + count) % count;
        });
        return;
      }
      if (event.key === 'Enter') {
        const row = resultRows[activeIndex];
        if (!row) return;
        event.preventDefault();
        void handleSelectRow(row);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, handleClose, handleSelectRow, isOpen, resultRows]);

  useEffect(() => {
    if (!isOpen || isSearching || resultRows.length > 0) return;
    const emptyResultKey = `${searchQuery.trim().length > 0 ? 'query' : 'recent'}:${searchResultQuery}`;
    if (reportedEmptyResultKeyRef.current === emptyResultKey) return;
    reportedEmptyResultKeyRef.current = emptyResultKey;
    reportTaskSearchAction('empty_result', {
      hasQuery: searchQuery.trim().length > 0,
      resultCount: 0,
    });
  }, [isOpen, isSearching, resultRows.length, searchQuery, searchResultQuery]);

  if (!isOpen) return null;

  return (
    <Modal
      onClose={handleClose}
      overlayClassName="fixed inset-0 z-50 flex items-start justify-center bg-black/10 px-6 pt-[14vh] backdrop-blur-[1px] dark:bg-black/30"
      className="w-full max-w-[640px]"
    >
      <SkinPresentationScope
        enabled
        data-skin-task-search="true"
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('search')}
        className="modal-content overflow-hidden rounded-[18px] border border-border bg-white shadow-modal dark:bg-surface"
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
          {isSearching && (
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
        <div className="px-2 pb-2 pt-1.5">
          {!hasQuery && (
            <div className={SECTION_LABEL_CLASS_NAME}>
              {i18nService.t('searchRecentTasks')}
            </div>
          )}
          <div className="max-h-[min(440px,50vh)] overflow-y-auto">
            {resultRows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-sm text-secondary">
                {!isSearching && <MagnifyingGlassIcon className="h-6 w-6 text-secondary/40" />}
                <span>{isSearching ? i18nService.t('loading') : i18nService.t('searchNoResults')}</span>
              </div>
            ) : (
              resultRows.map((row, index) => {
                const { session } = row;
                const agentName = agentNameBySessionId.get(session.id) ?? getSessionAgentId(session);
                const isCurrent = session.id === currentSessionId;
                const isActive = index === activeIndex;
                const isRunning = session.status === CoworkSessionStatusValue.Running;
                const relativeTime = formatAgentTaskRelativeTime(session.updatedAt || session.createdAt);
                const isContentRow = row.kind === 'content';
                const startsSection = hasQuery && resultRows[index - 1]?.kind !== row.kind;
                const RowIcon = isContentRow ? ChatBubbleBottomCenterTextIcon : ChatBubbleLeftIcon;
                return (
                  <React.Fragment key={`${row.kind}:${session.id}`}>
                    {startsSection && (
                      <div className={`${SECTION_LABEL_CLASS_NAME} ${index > 0 ? 'mt-2.5' : ''}`}>
                        {isContentRow
                          ? i18nService.t('searchContentResults')
                          : i18nService.t('searchTitleResults')}
                      </div>
                    )}
                    <button
                      type="button"
                      ref={(node) => {
                        if (node && isActive && navigationSourceRef.current === 'keyboard') {
                          node.scrollIntoView({ block: 'nearest' });
                        }
                      }}
                      onClick={() => void handleSelectRow(row)}
                      onMouseMove={() => {
                        navigationSourceRef.current = 'pointer';
                        if (activeIndex !== index) setActiveIndex(index);
                      }}
                      data-skin-search-result-active={isActive ? 'true' : undefined}
                      className={`flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors ${
                        isActive ? 'bg-black/[0.045] dark:bg-white/[0.07]' : ''
                      }`}
                    >
                      <span
                        className={`flex h-[18px] w-4 shrink-0 items-center justify-center transition-colors ${
                          isActive ? 'text-secondary' : 'text-secondary/50'
                        }`}
                        title={isRunning ? i18nService.t('myAgentSidebarRunning') : undefined}
                        aria-label={isRunning ? i18nService.t('myAgentSidebarRunning') : undefined}
                      >
                        {isRunning ? (
                          <svg className="h-3.5 w-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
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
                        ) : (
                          <RowIcon className="h-4 w-4" aria-hidden="true" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex w-full items-center gap-2.5 text-[13px] leading-[18px]">
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                            {isContentRow ? session.title : renderHighlightedTitle(session.title, searchQuery)}
                          </span>
                          {isCurrent && (
                            <span className="shrink-0 rounded-[5px] bg-primary/10 px-1.5 text-[11px] font-medium leading-[18px] text-primary">
                              {i18nService.t('searchCurrentTask')}
                            </span>
                          )}
                          {isContentRow && row.match.matchCount > 1 && (
                            <span className="shrink-0 text-[11px] tabular-nums text-secondary/55">
                              {i18nService
                                .t('searchContentMatchCount')
                                .replace('{count}', String(row.match.matchCount))}
                            </span>
                          )}
                          <span className="max-w-[136px] shrink-0 truncate text-[12px] text-secondary/70">
                            {agentName}
                          </span>
                          <span
                            className="min-w-[36px] shrink-0 text-right text-[12px] tabular-nums text-secondary/50"
                            title={relativeTime.full}
                          >
                            {relativeTime.compact}
                          </span>
                        </span>
                        {isContentRow && (
                          <span className="line-clamp-2 break-words text-[12px] leading-[18px] text-secondary/85">
                            <span className="text-secondary/50">
                              {row.match.messageType === 'user'
                                ? i18nService.t('searchContentFromUser')
                                : i18nService.t('searchContentFromAssistant')}
                            </span>
                            {renderHighlightedSnippet(
                              row.match.snippet,
                              row.match.highlightStart,
                              row.match.highlightLength,
                            )}
                          </span>
                        )}
                      </span>
                    </button>
                  </React.Fragment>
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
      </SkinPresentationScope>
    </Modal>
  );
};

export default CoworkSearchModal;
