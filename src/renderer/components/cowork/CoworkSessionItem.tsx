import { ChatBubbleLeftRightIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkSessionStatus, CoworkSessionSummary } from '../../types/cowork';
import { formatRelativeTimeString } from '../../utils/formatTime';
import Modal from '../common/Modal';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import ListChecksIcon from '../icons/ListChecksIcon';
import PencilSquareIcon from '../icons/PencilSquareIcon';
import TrashIcon from '../icons/TrashIcon';

interface CoworkSessionItemProps {
  session: CoworkSessionSummary;
  hasUnread: boolean;
  isActive: boolean;
  isBatchMode: boolean;
  isSelected: boolean;
  showBatchOption?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onTogglePin: (pinned: boolean) => void;
  onRename: (title: string) => void;
  onToggleSelection: () => void;
  onEnterBatchMode: () => void;
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
    strokeWidth={2}
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


const CoworkSessionItem: React.FC<CoworkSessionItemProps> = ({
  session,
  hasUnread,
  isActive,
  isBatchMode,
  isSelected,
  showBatchOption = true,
  onSelect,
  onDelete,
  onTogglePin,
  onRename,
  onToggleSelection,
  onEnterBatchMode,
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
    const menuHeight = showBatchOption ? 156 : 120;
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

  const handleBatchClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    onEnterBatchMode();
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
    const menuHeight = showConfirmDelete ? 112 : (showBatchOption ? 156 : 120);
    const position = calculateMenuPosition(menuHeight);
    if (position && (position.x !== menuPosition.x || position.y !== menuPosition.y)) {
      setMenuPosition(position);
    }
  }, [menuPosition, showConfirmDelete, showBatchOption]);

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
  const relativeTime = formatRelativeTimeString(session.updatedAt);
  const showRunningIndicator = session.status === 'running';
  const showUnreadIndicator = !showRunningIndicator && hasUnread;
  const batchLabel = i18nService.t('batchOperations');
  const menuItems = useMemo(() => {
    const items = [
      { key: 'rename', label: renameLabel, onClick: handleRenameClick, tone: 'neutral' as const },
      { key: 'pin', label: pinButtonLabel, onClick: handleTogglePin, tone: 'neutral' as const },
      { key: 'delete', label: deleteLabel, onClick: handleDeleteClick, tone: 'danger' as const },
    ];
    if (showBatchOption) {
      items.unshift({ key: 'batch', label: batchLabel, onClick: handleBatchClick, tone: 'neutral' as const });
    }
    return items;
  }, [
    batchLabel,
    deleteLabel,
    handleBatchClick,
    handleDeleteClick,
    handleRenameClick,
    handleTogglePin,
    pinButtonLabel,
    renameLabel,
    showBatchOption,
  ]);

  return (
    <div
      onClick={() => {
        if (isRenaming) return;
        closeMenu();
        if (isBatchMode) {
          onToggleSelection();
          return;
        }
        onSelect();
      }}
      className={`group relative py-2 px-3 rounded-lg cursor-pointer transition-all duration-150 ${
        isActive
          ? 'bg-black/[0.06] dark:bg-white/[0.08]'
          : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
      }`}
    >
      {/* Content area */}
      <div className="flex items-center gap-2.5">
        {isBatchMode && (
          <div className="flex items-center flex-shrink-0">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={(e) => {
                e.stopPropagation();
                onToggleSelection();
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-primary cursor-pointer"
            />
          </div>
        )}
        {/* Chat icon with optional red dot badge for unread */}
        {!isBatchMode && (
          <span className="relative flex-shrink-0" style={{ width: '18px', height: '18px' }}>
            <ChatBubbleLeftRightIcon
              className={`${
                showRunningIndicator
                  ? 'text-primary animate-pulse'
                  : 'text-secondary/40'
              }`}
              style={{ width: '18px', height: '18px' }}
            />
            {showUnreadIndicator && (
              <span className="absolute -top-0.5 -right-0.5 block w-2 h-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900" />
            )}
          </span>
        )}
        <div className="flex-1 min-w-0 group-hover:pr-8">
          {isRenaming ? (
            <div className="flex items-center gap-1.5">
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
                className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2 py-1 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <h3 className="text-[13px] font-normal text-foreground truncate">
                  {session.title}
                </h3>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-secondary mt-0.5">
                <span className="whitespace-nowrap">
                  {relativeTime}
                </span>
                <span className="whitespace-nowrap">
                  {i18nService.t(statusLabels[session.status])}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Actions - absolutely positioned overlay */}
      {!isBatchMode && (
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
          className="p-1.5 rounded-lg bg-surface-raised text-secondary hover:bg-surface hover:bg-surface transition-colors"
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
      )}

      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-xl border border-border bg-surface shadow-lg overflow-hidden"
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
                  : 'text-foreground hover:bg-surface-raised'
              }`}
            >
              {item.key === 'batch' && <ListChecksIcon className="h-4 w-4" />}
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
        <Modal onClose={handleCancelDelete} className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                {i18nService.t('deleteTaskConfirmTitle')}
              </h2>
            </div>

            {/* Content */}
            <div className="px-5 pb-4">
              <p className="text-sm text-secondary">
                {i18nService.t('deleteTaskConfirmMessage')}
              </p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
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
        </Modal>
      )}
    </div>
  );
};

export default CoworkSessionItem;
