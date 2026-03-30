import React, { useCallback, useMemo, useState } from 'react';
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
  onMoveToFolder?: (sessionId: string, folder: string) => void;
}

const sortByActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return b.createdAt - a.createdAt;
};

// Folder group header with collapse toggle
const FolderGroupHeader: React.FC<{
  folderName: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
}> = ({ folderName, count, isCollapsed, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    className="w-full flex items-center gap-1.5 px-3 py-1 mt-2 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText transition-colors group"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150 ${isCollapsed ? '-rotate-90' : ''}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
    <svg
      viewBox="0 0 24 24"
      fill={isCollapsed ? 'none' : 'currentColor'}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 flex-shrink-0 opacity-70"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
    <span className="truncate flex-1 text-left">{folderName}</span>
    <span className="opacity-50">{count}</span>
  </button>
);

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
  onMoveToFolder,
}) => {
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const toggleFolder = (folder: string) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  };

  // Lifted outside component to avoid re-creation on every render
  const pinnedSessions = useMemo(
    () => sessions.filter(s => s.pinned).sort(sortByActivity),
    [sessions]
  );

  // Non-pinned sessions grouped by folder
  const folderGroups = useMemo(() => {
    const unpinned = sessions.filter(s => !s.pinned);
    const map = new Map<string, CoworkSessionSummary[]>();
    for (const s of unpinned) {
      const key = s.folder || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    map.forEach((items, key) => map.set(key, items.sort(sortByActivity)));
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b);
    });
    return keys.map(k => ({ folder: k, items: map.get(k)! }));
  }, [sessions]);

  // Folder names list cached separately to avoid re-computing inside renderItem
  const folderNames = useMemo(
    () => folderGroups.filter(g => g.folder !== '').map(g => g.folder),
    [folderGroups]
  );

  const renderItem = useCallback((session: CoworkSessionSummary) => (
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
      onMoveToFolder={onMoveToFolder ? (folder) => onMoveToFolder(session.id, folder) : undefined}
      existingFolders={folderNames}
    />
  ), [
    unreadSessionIdSet, currentSessionId, isBatchMode, selectedIds, showBatchOption,
    onSelectSession, onDeleteSession, onTogglePin, onRenameSession,
    onToggleSelection, onEnterBatchMode, onMoveToFolder, folderNames,
  ]);

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {/* Pinned sessions */}
      {pinnedSessions.map(renderItem)}

      {/* Folder groups */}
      {folderGroups.map(({ folder, items }) => {
        if (!folder) {
          // No folder — render items directly without header
          return <React.Fragment key="__no_folder__">{items.map(renderItem)}</React.Fragment>;
        }
        const isCollapsed = collapsedFolders.has(folder);
        return (
          <div key={folder}>
            <FolderGroupHeader
              folderName={folder}
              count={items.length}
              isCollapsed={isCollapsed}
              onToggle={() => toggleFolder(folder)}
            />
            {!isCollapsed && (
              <div className="pl-3">
                {items.map(renderItem)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CoworkSessionList;