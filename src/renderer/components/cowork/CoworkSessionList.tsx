import React, { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { selectUnreadSessionIds } from '../../store/selectors/coworkSelectors';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import { i18nService } from '../../services/i18n';
import { ChatBubbleLeftRightIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

/** Extract the cron job display name from a session title like "[定时] xxx" */
function extractCronGroupKey(title: string): string | null {
  // Match both "[定时] xxx" (zh) and "[Scheduled] xxx" (en) prefixes
  const match = title.match(/^\[.+?\]\s(.+)$/);
  if (!match) return null;
  // Only group sessions whose title starts with a known cron prefix pattern
  // We detect cron sessions by checking if the title was produced by resolveOrCreateCronSession:
  // format is "[<cronLabel>] <jobName>" or "[<cronLabel>] <jobId[:8]>"
  return match[1];
}

/** Whether a session title looks like a cron session */
function isCronSessionTitle(title: string): boolean {
  // Matches "[定时] ..." or "[Scheduled] ..." etc.
  return /^\[(定时|Scheduled)\]\s/.test(title);
}

interface CronGroup {
  /** Group key = job display name */
  key: string;
  /** All sessions in this group, sorted newest first */
  sessions: CoworkSessionSummary[];
  /** The latest session (shown as the group header) */
  latest: CoworkSessionSummary;
}

interface CoworkSessionListProps {
  sessions: CoworkSessionSummary[];
  isLoading?: boolean;
  currentSessionId: string | null;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  showBatchOption?: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
}

const CoworkSessionList: React.FC<CoworkSessionListProps> = ({
  sessions,
  isLoading = false,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption = true,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  onToggleSelection,
  onEnterBatchMode,
}) => {
  const unreadSessionIds = useSelector(selectUnreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);

  // Track which cron groups are expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  /** Grouped + sorted render list */
  const renderItems = useMemo(() => {
    const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return b.createdAt - a.createdAt;
    };

    const pinnedSessions = sessions.filter((s) => s.pinned).sort(sortByRecentActivity);
    const unpinnedSessions = sessions.filter((s) => !s.pinned).sort(sortByRecentActivity);
    const allSorted = [...pinnedSessions, ...unpinnedSessions];

    // Separate cron sessions from normal sessions, group by job name
    const cronGroupMap = new Map<string, CoworkSessionSummary[]>();
    const normalSessions: CoworkSessionSummary[] = [];

    for (const session of allSorted) {
      if (isCronSessionTitle(session.title)) {
        const groupKey = extractCronGroupKey(session.title) ?? session.title;
        if (!cronGroupMap.has(groupKey)) cronGroupMap.set(groupKey, []);
        cronGroupMap.get(groupKey)!.push(session);
      } else {
        normalSessions.push(session);
      }
    }

    // Build cron groups (already sorted newest-first since allSorted is sorted)
    const cronGroups: CronGroup[] = Array.from(cronGroupMap.entries()).map(([key, groupSessions]) => {
      // Sort group sessions by createdAt descending so the most recent execution is first
      const sortedByCreated = [...groupSessions].sort((a, b) => b.createdAt - a.createdAt);
      return { key, sessions: sortedByCreated, latest: sortedByCreated[0] };
    });

    // Build a unified render list mixing cron group headers and normal sessions,
    // sorted by their latest updatedAt so the overall order is consistent.
    type RenderItem =
      | { type: 'cronGroup'; group: CronGroup }
      | { type: 'session'; session: CoworkSessionSummary };

    const renderList: RenderItem[] = [
      ...cronGroups.map((group) => ({ type: 'cronGroup' as const, group, updatedAt: group.latest.updatedAt })),
      ...normalSessions.map((session) => ({ type: 'session' as const, session, updatedAt: session.updatedAt })),
    ].sort((a, b) => b.updatedAt - a.updatedAt);

    return { renderList };
  }, [sessions]);

  if (sessions.length === 0) {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-10">
          <svg className="animate-spin h-6 w-6 dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center py-10 px-4">
        <ChatBubbleLeftRightIcon className="h-10 w-10 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-3" />
        <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('coworkNoSessions')}
        </p>
        <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
          {i18nService.t('coworkNoSessionsHint')}
        </p>
      </div>
    );
  }

  const { renderList } = renderItems;

  return (
    <div className="space-y-2">
      {renderList.map((item) => {
        if (item.type === 'cronGroup') {
          const { group } = item;
          const isExpanded = expandedGroups.has(group.key);
          const hasMultiple = group.sessions.length > 1;

          return (
            <div key={`cron-group-${group.key}`}>
              {/* Group header: show latest session with expand toggle */}
              <div className="relative">
                <CoworkSessionItem
                  session={group.latest}
                  hasUnread={group.sessions.some((s) => unreadSessionIdSet.has(s.id))}
                  isActive={group.latest.id === currentSessionId}
                  isBatchMode={isBatchMode}
                  isSelected={selectedIds.has(group.latest.id)}
                  showBatchOption={showBatchOption}
                  onSelect={() => onSelectSession(group.latest.id)}
                  onDelete={() => onDeleteSession(group.latest.id)}
                  onTogglePin={(pinned) => onTogglePin(group.latest.id, pinned)}
                  onRename={(title) => onRenameSession(group.latest.id, title)}
                  onToggleSelection={() => onToggleSelection(group.latest.id)}
                  onEnterBatchMode={() => onEnterBatchMode(group.latest.id)}
                />
                {/* Expand/collapse button for groups with multiple sessions */}
                {hasMultiple && (
                  <button
                    className="absolute right-1 bottom-1 flex items-center gap-0.5 text-xs text-tertiary hover:text-secondary px-1 py-0.5 rounded"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleGroup(group.key);
                    }}
                    title={isExpanded ? i18nService.t('collapseHistory') : i18nService.t('expandHistory')}
                  >
                    {isExpanded
                      ? <ChevronDownIcon className="w-3 h-3" />
                      : <ChevronRightIcon className="w-3 h-3" />
                    }
                    <span>{group.sessions.length - 1}</span>
                  </button>
                )}
              </div>

              {/* Expanded history sessions (all except the latest) */}
              {isExpanded && hasMultiple && (
                <div className="ml-3 mt-1 space-y-1 border-l-2 border-border pl-2">
                  {group.sessions.slice(1).map((session) => (
                    <CoworkSessionItem
                      key={session.id}
                      session={session}
                      hasUnread={unreadSessionIdSet.has(session.id)}
                      isActive={session.id === currentSessionId}
                      isBatchMode={isBatchMode}
                      isSelected={selectedIds.has(session.id)}
                      showBatchOption={showBatchOption}
                      onSelect={() => onSelectSession(session.id)}
                      onDelete={() => onDeleteSession(session.id)}
                      onTogglePin={(pinned) => onTogglePin(session.id, pinned)}
                      onRename={(title) => onRenameSession(session.id, title)}
                      onToggleSelection={() => onToggleSelection(session.id)}
                      onEnterBatchMode={() => onEnterBatchMode(session.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        }

        // Normal session
        const { session } = item;
        return (
          <CoworkSessionItem
            key={session.id}
            session={session}
            hasUnread={unreadSessionIdSet.has(session.id)}
            isActive={session.id === currentSessionId}
            isBatchMode={isBatchMode}
            isSelected={selectedIds.has(session.id)}
            showBatchOption={showBatchOption}
            onSelect={() => onSelectSession(session.id)}
            onDelete={() => onDeleteSession(session.id)}
            onTogglePin={(pinned) => onTogglePin(session.id, pinned)}
            onRename={(title) => onRenameSession(session.id, title)}
            onToggleSelection={() => onToggleSelection(session.id)}
            onEnterBatchMode={() => onEnterBatchMode(session.id)}
          />
        );
      })}
    </div>
  );
};

export default CoworkSessionList;