import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CoworkSessionSummary, CoworkSessionStatus } from '../../types/cowork';
import { EllipsisHorizontalIcon, ExclamationTriangleIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface CoworkSessionItemProps {
  session: CoworkSessionSummary;
  hasUnread: boolean;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onTogglePin: (pinned: boolean) => void;
  onRename: (title: string) => void;
}

const statusLabels: Record<CoworkSessionStatus, string> = {
  idle: 'coworkStatusIdle',
  running: 'coworkStatusRunning',
  completed: 'coworkStatusCompleted',
  error: 'coworkStatusError',
};

const PushPinIcon: React.FC<React.SVGProps<SVGSVGElement> & { slashed?: boolean }> = ({
  slashed,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="rotate(45 12 12)">
      <path d="M9 3h6l-1 5 2 2v2H8v-2l2-2-1-5z" />
      <path d="M12 12v9" />
    </g>
    {slashed && <path d="M5 5L19 19" />}
  </svg>
);

const formatRelativeTime = (timestamp: number): { compact: string; full: string } => {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) {
    return {
      compact: 'now',
      full: i18nService.t('justNow'),
    };
  } else if (minutes < 60) {
    return {
      compact: `${minutes}m`,
      full: `${minutes} ${i18nService.t('minutesAgo')}`,
    };
  } else if (hours < 24) {
    return {
      compact: `${hours}h`,
      full: `${hours} ${i18nService.t('hoursAgo')}`,
    };
  } else if (days === 1) {
    return {
      compact: '1d',
      full: i18nService.t('yesterday'),
    };
  } else {
    return {
      compact: `${days}d`,
      full: `${days} ${i18nService.t('daysAgo')}`,
    };
  }
};

const CoworkSessionItem: React.FC<CoworkSessionItemProps> = ({
  session,
  hasUnread,
  isActive,
  onSelect,
  onDelete,
  onTogglePin,
  onRename,
}) => {
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(session.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, session.title]);

  const calculateMenuPosition = (height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const menuWidth = 180;
    const padding = 8;
    const x = Math.min(
      Math.max(padding, rect.right - menuWidth),
      window.innerWidth - menuWidth - padding
    );
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - padding);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) {
      closeMenu();
      return;
    }
    const menuHeight = 120;
    const position = calculateMenuPosition(menuHeight);
    if (position) {
      setMenuPosition(position);
    }
    setShowConfirmDelete(false);
  };

  const closeMenu = () => {
    setMenuPosition(null);
    setShowConfirmDelete(false);
  };

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    onTogglePin(!session.pinned);
    closeMenu();
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setShowConfirmDelete(false);
    setRenameValue(session.title);
    setMenuPosition(null);
  };

  const handleRenameSave = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle && nextTitle !== session.title) {
      onRename(nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    setRenameValue(session.title);
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(true);
    setMenuPosition(null);
  };

  const handleConfirmDelete = () => {
    onDelete();
    setShowConfirmDelete(false);
  };

  const handleCancelDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowConfirmDelete(false);
  };

  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !actionButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [menuPosition]);

  useEffect(() => {
    if (!menuPosition) return;
    const menuHeight = showConfirmDelete ? 112 : 120;
    const position = calculateMenuPosition(menuHeight);
    if (position && (position.x !== menuPosition.x || position.y !== menuPosition.y)) {
      setMenuPosition(position);
    }
  }, [menuPosition, showConfirmDelete]);

  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  const pinButtonLabel = session.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession');
  const actionLabel = i18nService.t('coworkSessionActions');
  const renameLabel = i18nService.t('renameConversation');
  const deleteLabel = i18nService.t('deleteSession');
  const relativeTime = formatRelativeTime(session.updatedAt);
  const showRunningIndicator = session.status === 'running';
  const showUnreadIndicator = !showRunningIndicator && hasUnread;
  const showStatusIndicator = showRunningIndicator || showUnreadIndicator;
  const menuItems = useMemo(() => {
    return [
      { key: 'rename', label: renameLabel, onClick: handleRenameClick, tone: 'neutral' as const },
      { key: 'pin', label: pinButtonLabel, onClick: handleTogglePin, tone: 'neutral' as const },
      { key: 'delete', label: deleteLabel, onClick: handleDeleteClick, tone: 'danger' as const },
    ];
  }, [
    deleteLabel,
    handleDeleteClick,
    handleRenameClick,
    handleTogglePin,
    pinButtonLabel,
    renameLabel,
  ]);

  return (
    <div
      onClick={() => {
        if (isRenaming) return;
        closeMenu();
        onSelect();
      }}
      className={`group relative p-3 rounded-lg cursor-pointer transition-all duration-150 ${
        isActive
          ? 'bg-black/[0.06] dark:bg-white/[0.08]'
          : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
      }`}
    >
      {/* Content area */}
      <div className="flex items-start">
        <div className="flex-1 min-w-0">
          <div className={`flex items-center mb-1 ${showStatusIndicator ? 'gap-2' : 'gap-0'}`}>
            {/* Status indicator */}
            {showStatusIndicator && (
              <span
                className={`block w-2 h-2 rounded-full bg-claude-accent flex-shrink-0 ${
                  showRunningIndicator ? 'shadow-[0_0_6px_rgba(59,130,246,0.5)] animate-pulse' : ''
                }`}
                title={showRunningIndicator ? i18nService.t(statusLabels[session.status]) : undefined}
              />
            )}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleRenameSave(event);
                  }
                  if (event.key === 'Escape') {
                    handleRenameCancel(event);
                  }
                }}
                onBlur={handleRenameBlur}
                className="flex-1 min-w-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
            ) : (
              <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                {session.title}
              </h3>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="whitespace-nowrap" title={relativeTime.full}>
              {relativeTime.compact}
            </span>
            <span className="text-[10px] uppercase tracking-wider whitespace-nowrap">
              {i18nService.t(statusLabels[session.status])}
            </span>
          </div>
        </div>
      </div>

      {/* Actions - absolutely positioned overlay */}
      <div
        className={`absolute right-1.5 top-1.5 transition-opacity ${
          isRenaming
            ? 'opacity-0 pointer-events-none'
            : session.pinned
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          ref={actionButtonRef}
          onClick={openMenu}
          className="p-1.5 rounded-lg bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurface hover:bg-claude-surface transition-colors"
          aria-label={actionLabel}
        >
          {session.pinned ? (
            <span className="relative block h-4 w-4">
              <PushPinIcon className="h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
              <EllipsisHorizontalIcon className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </span>
          ) : (
            <EllipsisHorizontalIcon className="h-4 w-4" />
          )}
        </button>
      </div>

      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          role="menu"
        >
          {menuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                item.tone === 'danger'
                  ? 'text-red-500 hover:bg-red-500/10'
                  : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              {item.key === 'rename' && <PencilSquareIcon className="h-4 w-4" />}
              {item.key === 'pin' && (
                <PushPinIcon
                  slashed={session.pinned}
                  className={`h-4 w-4 ${session.pinned ? 'opacity-60' : ''}`}
                />
              )}
              {item.key === 'delete' && <TrashIcon className="h-4 w-4" />}
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showConfirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={handleCancelDelete}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('deleteTaskConfirmTitle')}
              </h2>
            </div>

            {/* Content */}
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('deleteTaskConfirmMessage')}
              </p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('deleteSession')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const areSessionItemPropsEqual = (prev: CoworkSessionItemProps, next: CoworkSessionItemProps): boolean => (
  prev.hasUnread === next.hasUnread
  && prev.isActive === next.isActive
  && prev.session.id === next.session.id
  && prev.session.title === next.session.title
  && prev.session.status === next.session.status
  && prev.session.pinned === next.session.pinned
  && prev.session.updatedAt === next.session.updatedAt
  && prev.session.createdAt === next.session.createdAt
);

export default React.memo(CoworkSessionItem, areSessionItemPropsEqual);
