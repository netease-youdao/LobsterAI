import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { bookmarkService, type BookmarkEntry } from '../../services/bookmark';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';

// ─── BookmarkIcon (outline / filled) ─────────────────────────────────────────

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

// ─── BookmarkButton (inline, beside CopyButton) ────────────────────────────

export const BookmarkButton: React.FC<{
  sessionId: string;
  messageId: string;
  visible: boolean;
}> = ({ sessionId, messageId, visible }) => {
  // Subscribe to bookmark changes reactively
  const bookmarks = useSyncExternalStore(
    (cb) => bookmarkService.subscribe(cb),
    () => bookmarkService.isBookmarked(sessionId, messageId),
  );
  const isBookmarked = bookmarks;
  const [animating, setAnimating] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const added = await bookmarkService.toggle(sessionId, messageId);
    setAnimating(true);
    setTimeout(() => setAnimating(false), 300);

    window.dispatchEvent(new CustomEvent('app:showToast', {
      detail: added ? i18nService.t('bookmarkAdded') : i18nService.t('bookmarkRemoved'),
    }));
  };

  return (
    <button
      onClick={handleClick}
      className={`p-1.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-all duration-200 ${
        visible || isBookmarked ? 'opacity-100' : 'opacity-0 pointer-events-none'
      } ${animating ? 'scale-125' : ''}`}
      title={isBookmarked ? i18nService.t('bookmarkRemove') : i18nService.t('bookmarkAdd')}
    >
      {isBookmarked ? (
        <BookmarkSolidIcon className="w-4 h-4 text-claude-accent" />
      ) : (
        <BookmarkOutlineIcon className="w-4 h-4 text-[var(--icon-secondary)]" />
      )}
    </button>
  );
};

// ─── BookmarksPanel (slide-over / dropdown) ─────────────────────────────────

export const BookmarksPanel: React.FC<{
  sessionId: string;
  messages: CoworkMessage[];
  isOpen: boolean;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}> = ({ sessionId, messages, isOpen, onClose, onJumpToMessage }) => {
  const [entries, setEntries] = useState<BookmarkEntry[]>([]);

  // Load bookmarks when panel opens
  useEffect(() => {
    if (!isOpen) return;
    bookmarkService.load(sessionId).then(setEntries);
    const unsub = bookmarkService.subscribe(() => {
      bookmarkService.load(sessionId).then(setEntries);
    });
    return unsub;
  }, [isOpen, sessionId]);

  // Build a lookup from message ID → message
  const messageMap = React.useMemo(() => {
    const map = new Map<string, CoworkMessage>();
    for (const msg of messages) {
      map.set(msg.id, msg);
    }
    return map;
  }, [messages]);

  // Filter entries to those whose message still exists
  const validEntries = entries.filter((e) => messageMap.has(e.messageId));

  const handleRemove = async (messageId: string) => {
    await bookmarkService.toggle(sessionId, messageId);
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Panel */}
      <div className="fixed right-4 top-14 z-50 w-80 max-h-[70vh] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover flex flex-col overflow-hidden popover-enter">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2">
            <BookmarkSolidIcon className="w-4 h-4 text-claude-accent" />
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('bookmarks')}
            </span>
            {validEntries.length > 0 && (
              <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                ({validEntries.length})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {validEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <BookmarkOutlineIcon className="w-10 h-10 dark:text-claude-darkTextSecondary/30 text-claude-textSecondary/30 mb-3" />
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('bookmarksEmpty')}
              </p>
              <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-1">
                {i18nService.t('bookmarksEmptyHint')}
              </p>
            </div>
          ) : (
            <div className="divide-y dark:divide-claude-darkBorder/50 divide-claude-border/50">
              {validEntries.map((entry) => {
                const msg = messageMap.get(entry.messageId);
                if (!msg) return null;
                const preview = msg.content.slice(0, 120).replace(/\n+/g, ' ');
                const isUser = msg.type === 'user';
                return (
                  <div
                    key={entry.messageId}
                    className="group flex items-start gap-2 px-4 py-3 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors cursor-pointer"
                    onClick={() => {
                      onJumpToMessage(entry.messageId);
                      onClose();
                    }}
                    title={i18nService.t('bookmarkJumpTo')}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          isUser
                            ? 'bg-claude-accent/10 text-claude-accent'
                            : 'dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary'
                        }`}>
                          {isUser ? 'User' : 'Assistant'}
                        </span>
                        <span className="text-[10px] dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50">
                          {new Date(entry.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-xs dark:text-claude-darkText text-claude-text line-clamp-2 leading-relaxed">
                        {preview || '...'}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemove(entry.messageId);
                      }}
                      className="p-1 rounded-md opacity-0 group-hover:opacity-100 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-all"
                      title={i18nService.t('bookmarkRemove')}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
};
