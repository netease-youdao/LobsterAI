import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import TrashIcon from '../icons/TrashIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { CoworkFavoriteItem } from '../../types/cowork';

interface FavoritesViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  onShowCowork?: () => void;
}

const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return i18nService.t('justNow');
  if (minutes < 60) return `${minutes} ${i18nService.t('minutesAgo')}`;
  if (hours < 24) return `${hours} ${i18nService.t('hoursAgo')}`;
  return `${days} ${i18nService.t('daysAgo')}`;
};

const truncateContent = (content: string, maxLen = 100): string => {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + '...';
};

const FavoritesView: React.FC<FavoritesViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onShowCowork,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const favorites = useSelector((state: RootState) => state.favorites.items);
  const [deleteTarget, setDeleteTarget] = useState<CoworkFavoriteItem | null>(null);

  useEffect(() => {
    coworkService.loadFavorites();
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await coworkService.removeFavoriteById(deleteTarget.id);
    setDeleteTarget(null);
  };

  const handleJumpToSession = (item: CoworkFavoriteItem) => {
    onShowCowork?.();
    coworkService.loadSession(item.sessionId);
  };

  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
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
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('favorites')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
        <div className="max-w-3xl mx-auto px-4 py-6">
          {favorites.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <svg
                className="h-12 w-12 dark:text-claude-darkTextSecondary text-claude-textSecondary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0z" />
              </svg>
              <h3 className="mt-4 text-lg font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('favoritesEmpty')}
              </h3>
              <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-xs">
                {i18nService.t('favoritesEmptyHint')}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {favorites.map((item) => (
                <div
                  key={item.id}
                  className="group relative flex items-start gap-3 px-4 py-3 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer transition-colors"
                  onClick={() => handleJumpToSession(item)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${
                        item.messageType === 'user'
                          ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary'
                          : 'bg-claude-accent/10 text-claude-accent'
                      }`}>
                        {item.messageType === 'user' ? 'You' : 'AI'}
                      </span>
                    </div>
                    <p className="dark:text-claude-darkText text-claude-text text-sm leading-relaxed">
                      {truncateContent(item.messageContent)}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                        {item.sessionTitle}
                      </span>
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(item);
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('favoritesDeleteConfirmTitle')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('favoritesDeleteConfirmMessage')}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FavoritesView;
