import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { bookmarkService, type GlobalBookmarkEntry } from '../../services/bookmark';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface BookmarksViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  /** Navigate to a specific session + message */
  onNavigateToSession: (sessionId: string, messageId: string) => void;
}

const BookmarkOutlineIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" />
  </svg>
);

const BookmarkSolidIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path fillRule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clipRule="evenodd" />
  </svg>
);

/** Resolve a session title from the Redux sessions list or load via IPC */
const useSessionTitleResolver = () => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const titleMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      map.set(s.id, s.title);
    }
    return map;
  }, [sessions]);

  return (sessionId: string): string => {
    return titleMap.get(sessionId) || sessionId.slice(0, 8);
  };
};

const BookmarksView: React.FC<BookmarksViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onNavigateToSession,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [entries, setEntries] = useState<GlobalBookmarkEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const resolveTitle = useSessionTitleResolver();

  // Load all bookmarks across sessions and enrich with message preview
  const loadBookmarks = async () => {
    setIsLoading(true);
    try {
      const allEntries = await bookmarkService.loadAll();

      // Enrich entries with message content from loaded sessions
      const enriched: GlobalBookmarkEntry[] = [];
      const sessionCache = new Map<string, Awaited<ReturnType<typeof coworkService.loadSession>>>();

      for (const entry of allEntries) {
        let session = sessionCache.get(entry.sessionId);
        if (session === undefined) {
          session = await coworkService.loadSession(entry.sessionId);
          sessionCache.set(entry.sessionId, session);
        }
        const msg = session?.messages?.find((m) => m.id === entry.messageId);
        enriched.push({
          ...entry,
          sessionTitle: resolveTitle(entry.sessionId),
          preview: msg?.content?.slice(0, 150)?.replace(/\n+/g, ' ') || '',
          messageType: msg?.type || 'assistant',
        });
      }
      setEntries(enriched);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadBookmarks();
    const unsub = bookmarkService.subscribe(() => {
      loadBookmarks();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRemove = async (sessionId: string, messageId: string) => {
    await bookmarkService.toggle(sessionId, messageId);
  };

  const handleNavigate = (sessionId: string, messageId: string) => {
    onNavigateToSession(sessionId, messageId);
  };

  // Group entries by session
  const groupedBySession = React.useMemo(() => {
    const groups = new Map<string, GlobalBookmarkEntry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.sessionId) || [];
      list.push(entry);
      groups.set(entry.sessionId, list);
    }
    return groups;
  }, [entries]);

  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <div className="flex items-center gap-2">
            <BookmarkSolidIcon className="h-5 w-5 text-claude-accent" />
            <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('bookmarks')}
            </h1>
            {entries.length > 0 && (
              <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                ({entries.length})
              </span>
            )}
          </div>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
        <div className="max-w-3xl mx-auto px-4 py-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('loading')}...
              </div>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <BookmarkOutlineIcon className="w-16 h-16 dark:text-claude-darkTextSecondary/20 text-claude-textSecondary/20 mb-4" />
              <h2 className="text-lg font-medium dark:text-claude-darkText text-claude-text mb-2">
                {i18nService.t('bookmarksEmpty')}
              </h2>
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-sm">
                {i18nService.t('bookmarksGlobalEmptyHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {Array.from(groupedBySession.entries()).map(([sessionId, sessionEntries]) => (
                <div key={sessionId} className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
                  {/* Session header */}
                  <div className="flex items-center gap-2 px-4 py-2.5 dark:bg-claude-darkSurface/50 bg-claude-surface/50 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
                    </svg>
                    <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                      {sessionEntries[0]?.sessionTitle || sessionId.slice(0, 8)}
                    </span>
                    <span className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 ml-auto flex-shrink-0">
                      {sessionEntries.length} {sessionEntries.length === 1 ? 'bookmark' : 'bookmarks'}
                    </span>
                  </div>

                  {/* Bookmark entries */}
                  <div className="divide-y dark:divide-claude-darkBorder/30 divide-claude-border/30">
                    {sessionEntries.map((entry) => (
                      <div
                        key={`${entry.sessionId}-${entry.messageId}`}
                        className="group flex items-start gap-3 px-4 py-3 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 transition-colors cursor-pointer"
                        onClick={() => handleNavigate(entry.sessionId, entry.messageId)}
                      >
                        <BookmarkSolidIcon className="w-4 h-4 text-claude-accent/60 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                              entry.messageType === 'user'
                                ? 'bg-claude-accent/10 text-claude-accent'
                                : 'dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary'
                            }`}>
                              {entry.messageType === 'user' ? 'User' : 'Assistant'}
                            </span>
                            <span className="text-[10px] dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50">
                              {new Date(entry.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm dark:text-claude-darkText text-claude-text line-clamp-2 leading-relaxed">
                            {entry.preview || '...'}
                          </p>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemove(entry.sessionId, entry.messageId);
                          }}
                          className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-all flex-shrink-0"
                          title={i18nService.t('bookmarkRemove')}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
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

export default BookmarksView;
