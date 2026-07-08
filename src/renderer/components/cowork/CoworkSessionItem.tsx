import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { stripGoalCommandPrefixForDisplay } from '../../../common/sessionTitle';
import { type CoworkGoal, CoworkGoalStatus } from '../../../shared/cowork/goal';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionStatus, CoworkSessionSummary } from '../../types/cowork';
import Modal from '../common/Modal';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import GoalIcon from '../icons/GoalIcon';
import ListChecksIcon from '../icons/ListChecksIcon';
import PencilSquareIcon from '../icons/PencilSquareIcon';
import PushPinIcon from '../icons/PushPinIcon';
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

const getGoalStatusLabel = (goal: CoworkGoal): string => {
  switch (goal.status) {
    case CoworkGoalStatus.Active:
      return i18nService.t('coworkGoalStatusActive');
    case CoworkGoalStatus.Paused:
      return i18nService.t('coworkGoalStatusPaused');
    case CoworkGoalStatus.Blocked:
      return i18nService.t('coworkGoalStatusBlocked');
    case CoworkGoalStatus.UsageLimited:
      return i18nService.t('coworkGoalStatusUsageLimited');
    case CoworkGoalStatus.BudgetLimited:
      return i18nService.t('coworkGoalStatusBudgetLimited');
    case CoworkGoalStatus.Complete:
      return i18nService.t('coworkGoalStatusComplete');
  }
};

const formatRelativeTime = (timestamp: number): { compact: string; full: string } => {
  const now = Date.now();
  const diff = Math.max(0, now - timestamp);

  const minutes = Math.max(1, Math.floor(diff / 60000));
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes <= 60) {
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
  const [menuPosition, setMenuPosition] = useState<{ right: number; y: number } | null>(null);
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

  const calculateMenuPosition = useCallback((height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const padding = 8;
    const right = Math.max(padding, window.innerWidth - rect.right);
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - padding);
    return { right, y };
  }, []);

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
    setShowConfirmDelete(false);
  }, []);

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

  const handleTogglePin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onTogglePin(!session.pinned);
    closeMenu();
  }, [closeMenu, onTogglePin, session.pinned]);

  const handleRenameClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setShowConfirmDelete(false);
    setRenameValue(session.title);
    setMenuPosition(null);
  }, [session.title]);

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

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(true);
    setMenuPosition(null);
  }, []);

  const handleConfirmDelete = () => {
    onDelete();
    setShowConfirmDelete(false);
  };

  const handleCancelDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowConfirmDelete(false);
  };

  const handleBatchClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    onEnterBatchMode();
  }, [closeMenu, onEnterBatchMode]);

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
  }, [closeMenu, menuPosition]);

  useEffect(() => {
    if (!menuPosition) return;
    const menuHeight = showConfirmDelete ? 112 : (showBatchOption ? 156 : 120);
    const position = calculateMenuPosition(menuHeight);
    if (position && (position.right !== menuPosition.right || position.y !== menuPosition.y)) {
      setMenuPosition(position);
    }
  }, [calculateMenuPosition, menuPosition, showBatchOption, showConfirmDelete]);

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
  const showRelativeTime = !showStatusIndicator;
  const displayTitle = stripGoalCommandPrefixForDisplay(session.title).trim() || session.title;
  const batchLabel = i18nService.t('batchOperations');
  const goalStatusLabel = session.goal ? getGoalStatusLabel(session.goal) : null;
  const goalTitle = session.goal ? `${goalStatusLabel}: ${session.goal.objective}` : undefined;
  const menuItems = useMemo(() => {
    const items = [
      { key: 'rename', label: renameLabel, onClick: handleRenameClick },
      { key: 'pin', label: pinButtonLabel, onClick: handleTogglePin },
      { key: 'delete', label: deleteLabel, onClick: handleDeleteClick },
    ];
    if (showBatchOption) {
      items.unshift({ key: 'batch', label: batchLabel, onClick: handleBatchClick });
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
      className={`group relative p-3 rounded-lg cursor-pointer transition-all duration-150 ${
        isActive
          ? 'bg-black/[0.06] dark:bg-white/[0.08]'
          : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
      }`}
    >
      {/* Content area */}
      <div className="flex items-start">
        {isBatchMode && (
          <div className="flex items-center mr-2 mt-0.5 flex-shrink-0">
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
        <div className="flex-1 min-w-0">
          <div className={`flex items-center mb-1 ${showStatusIndicator ? 'gap-2' : 'gap-0'}`}>
            {/* Status indicator */}
            {showStatusIndicator && (
              <span
                className={`block w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 ${
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
                className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2 py-1 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            ) : (
              <h3 className="text-sm font-medium text-foreground truncate">
                {displayTitle}
              </h3>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-secondary">
            {showRelativeTime && (
              <span className="whitespace-nowrap" title={relativeTime.full}>
                {relativeTime.compact}
              </span>
            )}
            <span className="text-[10px] uppercase tracking-wider whitespace-nowrap">
              {i18nService.t(statusLabels[session.status])}
            </span>
            {session.goal && goalStatusLabel && (
              <span
                className="inline-flex min-w-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                title={goalTitle}
              >
                <GoalIcon className="h-3 w-3 shrink-0" />
                <span className="shrink-0">{goalStatusLabel}</span>
                <span className="min-w-0 truncate text-primary/75">{session.goal.objective}</span>
              </span>
            )}
          </div>
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
          className="fixed z-50 w-max min-w-[124px] max-w-[calc(100vw-16px)] rounded-xl border border-border bg-surface shadow-lg overflow-hidden"
          style={{ top: menuPosition.y, right: menuPosition.right }}
          role="menu"
        >
          {menuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              className="w-full flex items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-raised"
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
