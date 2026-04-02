import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import { i18nService } from '../../services/i18n';

interface CoworkSessionListProps {
  sessions: CoworkSessionSummary[];
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
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);

  const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return b.createdAt - a.createdAt;
  };

  const { pinnedSessions, groupedSessions } = useMemo(() => {
    const pinned = sessions
      .filter((s) => s.pinned)
      .sort(sortByRecentActivity);

    const unpinned = sessions
      .filter((s) => !s.pinned)
      .sort(sortByRecentActivity);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const groups: { key: string; label: string; sessions: CoworkSessionSummary[] }[] = [
      { key: 'today',     label: i18nService.t('today'),         sessions: [] },
      { key: 'yesterday', label: i18nService.t('yesterday'),      sessions: [] },
      { key: 'thisWeek',  label: i18nService.t('groupThisWeek'), sessions: [] },
      { key: 'earlier',   label: i18nService.t('groupEarlier'),  sessions: [] },
    ];

    for (const s of unpinned) {
      if (s.updatedAt >= todayStart.getTime()) {
        groups[0].sessions.push(s);
      } else if (s.updatedAt >= yesterdayStart.getTime()) {
        groups[1].sessions.push(s);
      } else if (s.updatedAt >= weekStart.getTime()) {
        groups[2].sessions.push(s);
      } else {
        groups[3].sessions.push(s);
      }
    }

    return {
      pinnedSessions: pinned,
      groupedSessions: groups.filter((g) => g.sessions.length > 0),
    };
  }, [sessions]);

  const renderSessionItem = (session: CoworkSessionSummary) => (
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

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-secondary">
          {i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Pinned group */}
      {pinnedSessions.length > 0 && (
        <div>
          <div className="px-3 py-1 text-[11px] font-semibold text-secondary uppercase tracking-wider">
            {i18nService.t('groupPinned')}
          </div>
          <div className="space-y-0.5">
            {pinnedSessions.map(renderSessionItem)}
          </div>
        </div>
      )}
      {/* Time-based groups */}
      {groupedSessions.map((group) => (
        <div key={group.key}>
          <div className="px-3 py-1 text-[11px] font-semibold text-secondary uppercase tracking-wider">
            {group.label}
          </div>
          <div className="space-y-0.5">
            {group.sessions.map(renderSessionItem)}
          </div>
        </div>
      ))}
    </div>
  );
};

export default CoworkSessionList;
