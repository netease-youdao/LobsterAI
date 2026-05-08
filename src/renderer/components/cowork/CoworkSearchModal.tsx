import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import type { CoworkSessionStatus, CoworkSessionSummary } from '../../types/cowork';
import { formatRelativeTimeString } from '../../utils/formatTime';
import SearchIcon from '../icons/SearchIcon';

interface CoworkSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}

interface AgentInfo {
  id: string;
  icon: string;
  name: string;
}

interface TimeGroup {
  label: string;
  sessions: CoworkSessionSummary[];
}

const statusLabels: Record<CoworkSessionStatus, string> = {
  idle: 'coworkStatusIdle',
  running: 'coworkStatusRunning',
  completed: 'coworkStatusCompleted',
  error: 'coworkStatusError',
};

/**
 * Classify a timestamp into a time group label following the ChatGPT progressive pattern:
 * Today → Yesterday → Previous 7 Days → Previous 30 Days → Month YYYY
 */
function getTimeGroupLabel(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const yesterdayStart = todayStart - 86400000;
  const sevenDaysAgo = todayStart - 7 * 86400000;
  const thirtyDaysAgo = todayStart - 30 * 86400000;

  if (timestamp >= todayStart) {
    return i18nService.t('today');
  } else if (timestamp >= yesterdayStart) {
    return i18nService.t('yesterday');
  } else if (timestamp >= sevenDaysAgo) {
    return i18nService.t('previous7Days');
  } else if (timestamp >= thirtyDaysAgo) {
    return i18nService.t('previous30Days');
  } else {
    // Group by month: "2025年3月" / "March 2025"
    const lang = i18nService.getLanguage();
    const year = date.getFullYear();
    const month = date.getMonth(); // 0-based
    if (lang === 'zh') {
      return `${year}年${month + 1}月`;
    } else {
      const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      return `${monthNames[month]} ${year}`;
    }
  }
}


/**
 * Group sessions by time period, maintaining order within each group.
 */
function groupSessionsByTime(sessions: CoworkSessionSummary[], now: number): TimeGroup[] {
  const groupMap = new Map<string, CoworkSessionSummary[]>();
  const groupOrder: string[] = [];

  // Sessions should already be sorted by updatedAt desc
  for (const session of sessions) {
    const label = getTimeGroupLabel(session.updatedAt, now);
    if (!groupMap.has(label)) {
      groupMap.set(label, []);
      groupOrder.push(label);
    }
    groupMap.get(label)!.push(session);
  }

  return groupOrder.map((label) => ({
    label,
    sessions: groupMap.get(label)!,
  }));
}

const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  currentSessionId,
  onSelectSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [allSessions, setAllSessions] = useState<CoworkSessionSummary[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Get agents from Redux to filter orphan sessions and display icons
  const agents = useSelector((state: RootState) => state.agent.agents);
  const hasMultipleAgents = useMemo(() => agents.filter((a) => a.enabled).length > 1, [agents]);

  // Build agent lookup map
  const agentMap = useMemo(() => {
    const map = new Map<string, AgentInfo>();
    for (const agent of agents) {
      map.set(agent.id, {
        id: agent.id,
        icon: agent.icon || (agent.id === 'main' ? '🦞' : '🤖'),
        name: agent.name,
      });
    }
    return map;
  }, [agents]);

  // Valid agent IDs set (for filtering orphan sessions)
  const validAgentIds = useMemo(() => new Set(agents.filter((a) => a.enabled).map((a) => a.id)), [agents]);

  // Load all sessions when modal opens (global, no agent filter)
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const result = await window.electron?.cowork?.listSessions();
      if (!cancelled && result?.success && result.sessions) {
        setAllSessions(result.sessions);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  // Filter: remove orphan sessions (agent deleted) + text search
  const filteredSessions = useMemo(() => {
    // Step 1: Filter out sessions whose agent has been deleted
    const validSessions = allSessions.filter((s) => {
      const agentId = s.agentId || 'main';
      return validAgentIds.has(agentId);
    });

    // Step 2: Sort by updatedAt desc
    const sorted = [...validSessions].sort((a, b) => b.updatedAt - a.updatedAt);

    // Step 3: Text search
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return sorted;
    return sorted.filter((session) => session.title.toLowerCase().includes(trimmedQuery));
  }, [allSessions, validAgentIds, searchQuery]);

  // Group by time — `now` is fixed when modal opens, sufficient for grouping and relative times
  const now = useMemo(() => Date.now(), []);
  const timeGroups = useMemo(() => groupSessionsByTime(filteredSessions, now), [filteredSessions, now]);

  // Auto-focus on open
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
    setAllSessions([]);
  }, [isOpen]);

  // ESC to close
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

  // Click outside panel to close (light overlay)
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  }, [onClose]);

  const handleSelectSession = async (sessionId: string) => {
    try {
      // Find the session to potentially switch agent
      const session = allSessions.find((s) => s.id === sessionId);
      if (session) {
        const agentId = session.agentId || 'main';
        // Import dynamically to avoid circular deps; agent switch is needed for cross-agent selection
        const { agentService } = await import('../../services/agent');
        const { coworkService } = await import('../../services/cowork');
        const { store } = await import('../../store');
        const currentAgent = store.getState().agent.currentAgentId;
        if (agentId !== currentAgent) {
          agentService.switchAgent(agentId);
          await coworkService.loadSessions(agentId);
        }
      }
      await onSelectSession(sessionId);
    } catch (error) {
      console.error('[CoworkSearchModal] session selection failed:', error);
    } finally {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/10 dark:bg-black/20 animate-[overlayFadeIn_200ms_ease-out_forwards]"
      onClick={handleOverlayClick}
    >
      <style>{`
        @keyframes overlayFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes searchPanelExpand {
          from {
            opacity: 0;
            transform: translateY(-50%) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(-50%) scale(1);
          }
        }
      `}</style>
      {/* Left-anchored floating panel with expand animation */}
      <div
        ref={panelRef}
        className="absolute left-60 w-[600px] h-[545px] max-w-[calc(100vw-260px)] flex flex-col rounded-2xl border border-border bg-surface shadow-xl overflow-hidden"
        style={{
          top: '50%',
          transform: 'translateY(-50%)',
          animation: 'searchPanelExpand 250ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        }}
      >
        {/* Search header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={i18nService.t('searchConversations')}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
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

        {/* Results with time groups */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {filteredSessions.length === 0 ? (
            <div className="py-12 text-center text-sm text-secondary">
              {i18nService.t('searchNoResults')}
            </div>
          ) : (
            <div>
              {timeGroups.map((group, groupIdx) => (
                <div key={group.label} className={groupIdx > 0 ? 'mt-1' : ''}>
                  {/* Time group header */}
                  <div className="px-3 py-2 text-[11px] font-semibold text-secondary tracking-wide">
                    {group.label}
                  </div>
                  {/* Sessions in this group */}
                  <div className="px-1">
                    {group.sessions.map((session) => {
                      const agentId = session.agentId || 'main';
                      const agentInfo = agentMap.get(agentId);
                      const isActive = session.id === currentSessionId;
                      const timeDisplay = formatRelativeTimeString(session.updatedAt, now);
                      const isRunning = session.status === 'running';
                      const isError = session.status === 'error';

                      return (
                        <div
                          key={session.id}
                          onClick={() => handleSelectSession(session.id)}
                          className={`group flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-colors ${
                            isActive
                              ? 'bg-primary/8 ring-1 ring-primary/20'
                              : 'hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
                          }`}
                        >
                          {/* Agent icon (only when multiple agents) — circular background */}
                          {hasMultipleAgents && (
                            <span
                              className="flex items-center justify-center w-7 h-7 rounded-full bg-black/[0.06] dark:bg-white/[0.1] text-sm shrink-0"
                              title={agentInfo?.name}
                            >
                              {agentInfo?.icon || '🤖'}
                            </span>
                          )}
                          {/* Content: single row — title left, time · status right */}
                          <div className="flex-1 min-w-0 flex items-center gap-2">
                            {isRunning && (
                              <span className="block w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_4px_rgba(59,130,246,0.5)] animate-pulse shrink-0" />
                            )}
                            <span className={`text-[13px] font-normal truncate ${isActive ? 'text-primary' : 'text-foreground'}`}>
                              {session.title}
                            </span>
                            {/* Time + Status badge — right aligned */}
                            <div className="flex items-center gap-2 ml-auto shrink-0">
                              <span className="text-xs text-secondary/70 whitespace-nowrap">{timeDisplay}</span>
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-none whitespace-nowrap ${
                                isRunning
                                  ? 'bg-primary/15 text-primary'
                                  : isError
                                    ? 'bg-red-500/15 text-red-500'
                                    : session.status === 'completed'
                                      ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                                      : 'bg-secondary/10 text-secondary'
                              }`}>
                                {i18nService.t(statusLabels[session.status])}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CoworkSearchModal;