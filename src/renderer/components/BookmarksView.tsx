import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useSelector } from 'react-redux';

import { bookmarkService } from '../services/bookmark';
import { i18nService } from '../services/i18n';
import type { RootState } from '../store';
import type { Bookmark } from '../types/cowork';
import MarkdownContent from './MarkdownContent';

const COLLAPSED_MAX_HEIGHT = 160;

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const BookmarkItem: React.FC<{
  bookmark: Bookmark;
  sessionExists: boolean;
  onJump: (bookmark: Bookmark) => void;
  onRemove: (bookmarkId: string) => void;
}> = React.memo(({ bookmark, sessionExists, onJump, onRemove }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const isUser = bookmark.messageType === 'user';
  const badgeColor = isUser ? 'text-blue-500 bg-blue-500/10' : 'text-purple-500 bg-purple-500/10';

  useEffect(() => {
    const el = contentRef.current;
    if (el) {
      setCanExpand(el.scrollHeight > COLLAPSED_MAX_HEIGHT);
    }
  }, [bookmark.content]);

  return (
    <div
      className={`group bg-surface rounded-lg px-3 py-2 hover:bg-surface-raised transition-colors ${canExpand ? 'cursor-pointer' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => canExpand && setIsExpanded(!isExpanded)}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${badgeColor}`}>
            {isUser ? i18nService.t('userMessage') : i18nService.t('aiReply')}
          </span>
          <span className="text-xs text-muted truncate max-w-[200px]" title={bookmark.sessionTitle}>
            {bookmark.sessionTitle}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {canExpand && (
            <span className="text-xs text-primary">
              {isExpanded ? i18nService.t('collapse') : i18nService.t('expand')}
            </span>
          )}
          <span className="text-xs text-muted">{formatRelativeTime(bookmark.createdAt)}</span>
        </div>
      </div>
      <div className="relative">
        <div
          ref={contentRef}
          className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
          style={!isExpanded && canExpand ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined}
        >
          <MarkdownContent
            content={bookmark.content}
            className="prose dark:prose-invert max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
        {canExpand && !isExpanded && (
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-surface group-hover:from-surface-raised pointer-events-none transition-colors" />
        )}
      </div>
      <div className="flex items-center justify-end gap-2 mt-1.5 pt-1.5 border-t border-border/50">
        <button
          onClick={e => {
            e.stopPropagation();
            onRemove(bookmark.id);
          }}
          className={`text-xs text-muted hover:text-red-500 transition-colors ${
            isHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {i18nService.t('removeBookmark')}
        </button>
        <button
          onClick={e => {
            e.stopPropagation();
            if (sessionExists) {
              onJump(bookmark);
            }
          }}
          disabled={!sessionExists}
          className={`text-xs font-medium transition-colors ${
            sessionExists
              ? 'text-primary hover:text-primary/80 cursor-pointer'
              : 'text-muted cursor-not-allowed'
          }`}
          title={sessionExists ? i18nService.t('jumpToMessage') : i18nService.t('sessionDeleted')}
        >
          {sessionExists ? `→ ${i18nService.t('jumpToMessage')}` : i18nService.t('sessionDeleted')}
        </button>
      </div>
    </div>
  );
});

interface BookmarksViewProps {
  onJumpToMessage: (sessionId: string, messageId: string) => void;
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

const BookmarksView: React.FC<BookmarksViewProps> = ({
  onJumpToMessage,
  isSidebarCollapsed,
  onToggleSidebar,
}) => {
  const bookmarks = useSelector((state: RootState) => state.bookmark.bookmarks);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const sessionIds = React.useMemo(() => new Set(sessions.map(s => s.id)), [sessions]);

  const handleJump = useCallback(
    (bookmark: Bookmark) => {
      onJumpToMessage(bookmark.sessionId, bookmark.messageId);
    },
    [onJumpToMessage],
  );

  const handleRemove = useCallback(async (bookmarkId: string) => {
    await bookmarkService.remove(bookmarkId);
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        {isSidebarCollapsed && (
          <button
            onClick={onToggleSidebar}
            className="p-1.5 rounded-md hover:bg-surface-raised transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-secondary"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <line x1="9" x2="9" y1="3" y2="21" />
            </svg>
          </button>
        )}
        <h1 className="text-lg font-semibold text-foreground">{i18nService.t('bookmarks')}</h1>
        <span className="text-sm text-muted">{bookmarks.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {bookmarks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-muted mb-4"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <p className="text-sm text-muted max-w-xs">{i18nService.t('noBookmarks')}</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-3">
            {bookmarks.map(bookmark => (
              <BookmarkItem
                key={bookmark.id}
                bookmark={bookmark}
                sessionExists={sessionIds.has(bookmark.sessionId)}
                onJump={handleJump}
                onRemove={handleRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default BookmarksView;
