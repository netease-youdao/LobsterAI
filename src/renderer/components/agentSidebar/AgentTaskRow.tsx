import { ShareIcon } from '@heroicons/react/20/solid';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { OwnershipTargetKind } from '@shared/ownership/constants';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import {
  getIMSessionDisplayTitle,
  getIMSessionPlatformIconClassName,
  getIMSessionPlatformLabel,
  getIMSessionPlatformLogo,
} from '../cowork/imSessionDisplay';
import ClockIcon from '../icons/ClockIcon';
import EditIcon from '../icons/EditIcon';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import ListChecksIcon from '../icons/ListChecksIcon';
import LoadingIcon from '../icons/LoadingIcon';
import PushPinIcon from '../icons/PushPinIcon';
import TrashIcon from '../icons/TrashIcon';
import { useOwnershipHover } from '../ownership/OwnershipHoverCard';
import OwnershipMenuItems from '../ownership/OwnershipMenuItems';
import { AgentSidebarIndicator } from './constants';
import {
  getScheduledTaskDisplayTitle,
  hasLegacyScheduledTaskTitle,
} from './scheduledTaskSession';
import { formatAgentTaskRelativeTime } from './time';
import type { AgentSidebarTaskNode } from './types';

interface AgentTaskRowProps {
  task: AgentSidebarTaskNode;
  isBatchMode: boolean;
  isSelected: boolean;
  contextLabel?: string;
  contextIcon?: React.ReactNode;
  isSelectionDisabled?: boolean;
  showBatchOption?: boolean;
  hasActiveSubagent?: boolean;
  onSelect: () => void;
  onDelete: () => Promise<void>;
  onShare: () => Promise<void>;
  onTogglePin: (pinned: boolean) => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onToggleSelection: () => void;
  onEnterBatchMode: () => void;
  onSidebarAction?: (actionType: string, params?: {
    agentType?: 'main' | 'custom';
    hasActiveSubagent?: boolean;
    isCurrentSession?: boolean;
    isPinned?: boolean;
    result?: 'success' | 'failed';
    targetPinned?: boolean;
    taskStatus?: string;
  }) => void;
  analyticsParams?: {
    agentType: 'main' | 'custom';
    hasActiveSubagent?: boolean;
    isCurrentSession: boolean;
    isPinned: boolean;
    taskStatus: string;
  };
}

const ACTION_MENU_VIEWPORT_PADDING = 8;
const ACTION_MENU_VERTICAL_GAP = 4;
const ACTION_MENU_HEIGHT = 205;
const ACTION_MENU_WITH_BATCH_HEIGHT = 237;

const AgentTaskRow: React.FC<AgentTaskRowProps> = ({
  task,
  isBatchMode,
  isSelected,
  contextLabel,
  contextIcon,
  isSelectionDisabled = false,
  showBatchOption = false,
  hasActiveSubagent = false,
  onSelect,
  onDelete,
  onShare,
  onTogglePin,
  onRename,
  onToggleSelection,
  onEnterBatchMode,
  onSidebarAction,
  analyticsParams,
}) => {
  const baseDisplayTitle = task.isScheduledTask
    ? getScheduledTaskDisplayTitle(task.title)
    : task.title;
  const imDisplayTitle = getIMSessionDisplayTitle(baseDisplayTitle, task.imPlatform).title;
  const displayTitle = task.isScheduledTask ? baseDisplayTitle : imDisplayTitle;
  const imPlatformLogo = task.isScheduledTask ? null : getIMSessionPlatformLogo(task.imPlatform);
  const imPlatformLabel = task.isScheduledTask ? null : getIMSessionPlatformLabel(task.imPlatform);
  const imPlatformIconClassName = task.isScheduledTask ? null : getIMSessionPlatformIconClassName(task.imPlatform);
  // Keep a legacy prefix visible while editing so users can deliberately retain
  // or remove the heuristic marker. Persisted markers do not depend on the title.
  const editableTitle = task.isScheduledTask && hasLegacyScheduledTaskTitle(task.title)
    ? task.title
    : displayTitle;
  const [menuPosition, setMenuPosition] = useState<{ right: number; top: number } | null>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [suppressPinHover, setSuppressPinHover] = useState(false);
  const [renameValue, setRenameValue] = useState(editableTitle);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isMenuOpen = menuPosition !== null;
  const ownershipHover = useOwnershipHover({ kind: OwnershipTargetKind.Task, id: task.id }, isBatchMode || isRenaming || isSelectionDisabled || isMenuOpen);

  const calculateMenuPosition = useCallback(() => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const menuHeight = showBatchOption ? ACTION_MENU_WITH_BATCH_HEIGHT : ACTION_MENU_HEIGHT;
    const right = Math.max(ACTION_MENU_VIEWPORT_PADDING, window.innerWidth - rect.right);
    const top = Math.max(
      ACTION_MENU_VIEWPORT_PADDING,
      Math.min(
        rect.bottom + ACTION_MENU_VERTICAL_GAP,
        window.innerHeight - menuHeight - ACTION_MENU_VIEWPORT_PADDING,
      ),
    );

    return { right, top };
  }, [showBatchOption]);

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
  }, []);

  const toggleMenu = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isMenuOpen) {
      closeMenu();
      return;
    }

    const position = calculateMenuPosition();
    if (position) {
      onSidebarAction?.('task_menu_open', analyticsParams);
      setMenuPosition(position);
    }
  };

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(editableTitle);
    }
  }, [editableTitle, isRenaming]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const focusTimer = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !actionButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
        actionButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeMenu, isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const updateMenuPosition = () => {
      const position = calculateMenuPosition();
      if (position) {
        setMenuPosition(position);
      } else {
        closeMenu();
      }
    };
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [calculateMenuPosition, closeMenu, isMenuOpen]);

  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  const handleRowClick = () => {
    if (isRenaming || isSelectionDisabled) return;
    if (isBatchMode) {
      onToggleSelection();
      return;
    }
    onSelect();
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleRowClick();
    }
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (menuItems.length === 0) return;
    event.preventDefault();
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? menuItems.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + menuItems.length) % menuItems.length
          : (currentIndex - 1 + menuItems.length) % menuItems.length;
    menuItems[nextIndex]?.focus();
  };

  const handleRenameSave = async () => {
    const nextTitle = renameValue.trim();
    setIsRenaming(false);
    if (nextTitle && nextTitle !== editableTitle) {
      await onRename(nextTitle);
    }
  };

  const handleRenameCancel = () => {
    onSidebarAction?.('task_rename_cancel', analyticsParams);
    setRenameValue(editableTitle);
    setIsRenaming(false);
  };

  const indicatorLabel = task.indicator === AgentSidebarIndicator.PendingPermission
    ? i18nService.t('myAgentSidebarPendingPermission')
    : task.indicator === AgentSidebarIndicator.Running
      ? i18nService.t('myAgentSidebarRunning')
      : i18nService.t('myAgentSidebarUnreadResult');
  const menuItemClassName =
    'flex w-full items-center gap-2 whitespace-nowrap px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
  const menuIconClassName = 'h-3.5 w-3.5';
  const relativeTime = formatAgentTaskRelativeTime(task.updatedAt || task.createdAt);
  const showRelativeTime = !contextLabel && task.indicator === AgentSidebarIndicator.None;
  const pinLabel = task.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession');
  const isActivityRow = !!contextLabel;
  const scheduledTaskLabel = i18nService.t('myAgentSidebarScheduledTask');

  return (
    <div
      {...ownershipHover.handlers}
      className={`group relative -ml-[6px] flex w-[calc(100%+12px)] items-center gap-2 rounded-md ${
        isActivityRow ? 'min-h-[48px] py-1.5' : 'h-[30px]'
      } ${
        isBatchMode ? 'pl-4' : isActivityRow ? 'pl-3.5' : 'pl-[38px]'
      } pr-2.5 text-sm font-normal transition-colors ${
        isSelectionDisabled
          ? 'cursor-default text-foreground/30'
          : task.isSelected && !hasActiveSubagent
          ? 'cursor-pointer bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.07]'
          : 'cursor-pointer text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
      }`}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      onMouseMove={() => setSuppressPinHover(false)}
      onMouseLeave={() => { setSuppressPinHover(false); ownershipHover.handlers.onMouseLeave(); }}
      role="treeitem"
      tabIndex={isSelectionDisabled ? -1 : 0}
      aria-level={isActivityRow ? 1 : 2}
      aria-selected={task.isSelected}
      aria-disabled={isSelectionDisabled || undefined}
    >
      {!isActivityRow && !isBatchMode && !isRenaming && !isSelectionDisabled && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            const nextPinned = !task.pinned;
            setSuppressPinHover(true);
            event.currentTarget.blur();
            void onTogglePin(nextPinned);
          }}
          className={`absolute left-[13px] top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-foreground transition-opacity hover:opacity-[0.46] focus:outline-none ${
            suppressPinHover
              ? 'pointer-events-none opacity-0'
              : task.pinned
                ? 'opacity-[0.46]'
                : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-[0.3] focus-visible:pointer-events-auto focus-visible:opacity-[0.46]'
          }`}
          aria-label={pinLabel}
          title={pinLabel}
        >
          <PushPinIcon className="h-3.5 w-3.5" />
        </button>
      )}

      {isBatchMode && (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(event) => {
            event.stopPropagation();
            onToggleSelection();
          }}
          onClick={(event) => event.stopPropagation()}
          className="h-3.5 w-3.5 shrink-0 rounded border-gray-300 accent-primary"
        />
      )}

      {isRenaming ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onBlur={() => void handleRenameSave()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void handleRenameSave();
            }
            if (event.key === 'Escape') {
              handleRenameCancel();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-sm font-normal text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <>
          {task.isScheduledTask && (
            <span
              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${
                isSelectionDisabled ? 'text-foreground/30' : 'text-secondary'
              }`}
              role="img"
              title={scheduledTaskLabel}
              aria-label={scheduledTaskLabel}
            >
              <ClockIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          {imPlatformLogo && imPlatformLabel && (
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
              role="img"
              title={imPlatformLabel}
              aria-label={imPlatformLabel}
            >
              <img
                src={imPlatformLogo}
                alt=""
                className={imPlatformIconClassName ?? undefined}
                draggable={false}
              />
            </span>
          )}
          <span className={`min-w-0 flex-1 ${isActivityRow ? 'flex flex-col gap-0.5' : 'truncate'}`}>
            <span className="truncate">{displayTitle}</span>
            {contextLabel && (
              <span className="flex min-w-0 items-center gap-1 text-[11px] font-normal leading-4 text-secondary">
                {contextIcon && (
                  <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                    {contextIcon}
                  </span>
                )}
                <span className="truncate">{contextLabel}</span>
              </span>
            )}
          </span>
          {task.indicator === AgentSidebarIndicator.PendingPermission && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-3 text-primary transition-opacity group-hover:opacity-0"
              title={indicatorLabel}
              aria-label={indicatorLabel}
            >
              <span className="h-1 w-1 shrink-0 rounded-full bg-primary animate-pulse" aria-hidden="true" />
              {indicatorLabel}
            </span>
          )}
          {task.indicator === AgentSidebarIndicator.Running && (
            <span
              className="inline-flex h-3 w-3 shrink-0 items-center justify-center transition-opacity group-hover:opacity-0"
              title={indicatorLabel}
              aria-label={indicatorLabel}
            >
              <LoadingIcon className="h-3 w-3 animate-spin text-secondary" aria-hidden="true" />
            </span>
          )}
          {task.indicator === AgentSidebarIndicator.CompletedUnread && (
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-full bg-blue-500 transition-opacity group-hover:opacity-0"
              title={indicatorLabel}
              aria-label={indicatorLabel}
            />
          )}
          {showRelativeTime && (
            <span
              className="shrink-0 whitespace-nowrap text-[12px] font-normal text-foreground/45 transition-opacity group-hover:opacity-0"
              title={relativeTime.full}
            >
              {relativeTime.compact}
            </span>
          )}
        </>
      )}

      {!isBatchMode && !isRenaming && !isSelectionDisabled && (
        <button
          ref={actionButtonRef}
          type="button"
          onClick={toggleMenu}
          className={`absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-foreground transition-opacity hover:opacity-[0.46] ${
            isMenuOpen ? 'opacity-[0.46]' : 'opacity-0 group-hover:opacity-[0.3] focus-visible:opacity-[0.46]'
          }`}
          aria-label={i18nService.t('coworkSessionActions')}
        >
          <EllipsisHorizontalIcon className="h-4 w-4" />
        </button>
      )}

      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-[60] w-max min-w-[112px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
          style={{ top: menuPosition.top, right: menuPosition.right }}
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          <OwnershipMenuItems target={{ kind: OwnershipTargetKind.Task, id: task.id }} onAction={closeMenu} className={menuItemClassName} />
          {showBatchOption && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                closeMenu();
                onEnterBatchMode();
              }}
              className={menuItemClassName}
              role="menuitem"
            >
              <ListChecksIcon className={menuIconClassName} />
              {i18nService.t('batchOperations')}
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              closeMenu();
              onSidebarAction?.('task_rename_start', analyticsParams);
              setIsRenaming(true);
            }}
            className={menuItemClassName}
            role="menuitem"
          >
            <EditIcon className={menuIconClassName} />
            {i18nService.t('renameConversation')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              closeMenu();
              void onTogglePin(!task.pinned);
            }}
            className={menuItemClassName}
            role="menuitem"
          >
            <PushPinIcon slashed={task.pinned} className={menuIconClassName} />
            {task.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              closeMenu();
              void onShare();
            }}
            className={menuItemClassName}
            role="menuitem"
          >
            <ShareIcon className={menuIconClassName} />
            {i18nService.t('coworkShareSession')}
          </button>
          <div role="separator" className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              closeMenu();
              onSidebarAction?.('task_delete_confirm_open', analyticsParams);
              setShowConfirmDelete(true);
            }}
            className={menuItemClassName}
            role="menuitem"
          >
            <TrashIcon className={menuIconClassName} />
            {i18nService.t('deleteSession')}
          </button>
        </div>
      )}

      {ownershipHover.card}
      {showConfirmDelete && (
        <Modal
          onClose={() => setShowConfirmDelete(false)}
          className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
              <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {i18nService.t('deleteTaskConfirmTitle')}
            </h2>
          </div>
          <div className="px-5 pb-4">
            <p className="text-sm text-secondary">
              {i18nService.t('deleteTaskConfirmMessage')}
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
            <button
              type="button"
              onClick={() => {
                onSidebarAction?.('task_delete_cancel', analyticsParams);
                setShowConfirmDelete(false);
              }}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                onSidebarAction?.('task_delete_submit', analyticsParams);
                setShowConfirmDelete(false);
                void onDelete();
              }}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 text-white transition-colors hover:bg-red-600"
            >
              {i18nService.t('deleteSession')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default AgentTaskRow;
