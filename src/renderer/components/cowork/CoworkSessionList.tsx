import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectUnreadSessionIds } from '../../store/selectors/coworkSelectors';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import { i18nService } from '../../services/i18n';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';

// ─── Types ───────────────────────────────────────────────────────────────────

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

type GroupKey = 'pinned' | 'today' | 'yesterday' | 'last7Days' | 'last30Days' | 'earlier';

interface SessionGroup {
  key: GroupKey | string; // 'earlier' 下可能细分为 'YYYY-MM'
  label: string;
  sessions: CoworkSessionSummary[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getGroupKey(updatedAt: number, now: Date): GroupKey | string {
  const d = new Date(updatedAt);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const day7Start = todayStart - 6 * 86_400_000;
  const day30Start = todayStart - 29 * 86_400_000;

  if (updatedAt >= todayStart) return 'today';
  if (updatedAt >= yesterdayStart) return 'yesterday';
  if (updatedAt >= day7Start) return 'last7Days';
  if (updatedAt >= day30Start) return 'last30Days';
  // 更早：按 "YYYY年MM月" / "MMMM YYYY" 细分
  return `earlier_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getEarlierLabel(key: string): string {
  // key 格式：earlier_YYYY_MM
  const parts = key.split('_');
  const year = parseInt(parts[1], 10);
  const month = parseInt(parts[2], 10);
  const lang = i18nService.getLanguage();
  if (lang === 'zh') {
    return `${year}年${month}月`;
  }
  const date = new Date(year, month - 1, 1);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

function getGroupLabel(key: GroupKey | string): string {
  if (key === 'pinned') return i18nService.t('pinned');
  if (key === 'today') return i18nService.t('today');
  if (key === 'yesterday') return i18nService.t('yesterday');
  if (key === 'last7Days') return i18nService.t('last7Days');
  if (key === 'last30Days') return i18nService.t('last30Days');
  if (key.startsWith('earlier_')) return getEarlierLabel(key);
  return i18nService.t('earlier');
}

// 按 key 定义排列顺序（earlier_YYYY_MM 根据时间倒序排在最后）
const GROUP_ORDER: (GroupKey | 'earlier')[] = [
  'pinned', 'today', 'yesterday', 'last7Days', 'last30Days', 'earlier',
];

function sortGroupKey(a: string, b: string): number {
  const aIsEarlier = a.startsWith('earlier_');
  const bIsEarlier = b.startsWith('earlier_');

  if (!aIsEarlier && !bIsEarlier) {
    return GROUP_ORDER.indexOf(a as GroupKey) - GROUP_ORDER.indexOf(b as GroupKey);
  }
  // 两者都是 earlier_YYYY_MM，按时间倒序（新的月份在前）
  if (aIsEarlier && bIsEarlier) {
    return b.localeCompare(a);
  }
  // earlier 类型排在固定分组后面
  return aIsEarlier ? 1 : -1;
}

function buildGroups(sessions: CoworkSessionSummary[]): SessionGroup[] {
  const now = new Date();
  const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return b.createdAt - a.createdAt;
  };

  const groupMap = new Map<string, CoworkSessionSummary[]>();

  for (const session of sessions) {
    const key = session.pinned ? 'pinned' : getGroupKey(session.updatedAt, now);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(session);
  }

  return Array.from(groupMap.entries())
    .sort(([a], [b]) => sortGroupKey(a, b))
    .map(([key, list]) => ({
      key,
      label: getGroupLabel(key),
      sessions: list.sort(sortByRecentActivity),
    }));
}

// ─── Component ───────────────────────────────────────────────────────────────

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

  const groups = useMemo(() => buildGroups(sessions), [sessions]);

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

  return (
    <div className="space-y-1">
      {groups.map((group) => (
        <div key={group.key}>
          {/* 分组标题 */}
          <div className="px-2 pt-3 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-secondary/60 select-none">
              {group.label}
            </span>
          </div>
          {/* 分组内会话列表 */}
          <div className="space-y-0.5">
            {group.sessions.map((session) => (
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
        </div>
      ))}
    </div>
  );
};

export default CoworkSessionList;
