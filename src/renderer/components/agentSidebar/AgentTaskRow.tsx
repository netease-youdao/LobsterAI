import { ShareIcon } from '@heroicons/react/20/solid';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import EditIcon from '../icons/EditIcon';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import ListChecksIcon from '../icons/ListChecksIcon';
import LoadingIcon from '../icons/LoadingIcon';
import PushPinIcon from '../icons/PushPinIcon';
import TrashIcon from '../icons/TrashIcon';
import { AgentSidebarIndicator } from './constants';
import { formatAgentTaskRelativeTime } from './time';
import type { AgentSidebarTaskNode } from './types';

interface AgentTaskRowProps {
  task: AgentSidebarTaskNode;
  isBatchMode: boolean;
  isSelected: boolean;
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
const ACTION_MENU_HEIGHT = 164;
const ACTION_MENU_WITH_BATCH_HEIGHT = 196;

const AgentTaskRow: React.FC<AgentTaskRowProps> = ({
  task,
  isBatchMode,
  isSelected,
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
  const [menuPosition, setMenuPosition] = useState<{ right: number; top: number } | null>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [suppressPinHover, setSuppressPinHover] = useState(false);
  const [renameValue, setRenameValue] = useState(task.title);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isMenuOpen = menuPosition !== null;

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
      setRenameValue(task.title);
    }
  }, [isRenaming, task.title]);

  useEffect(() => {
    if (!isMenuOpen) return;
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
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
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

  const handleRenameSave = async () => {
    const nextTitle = renameValue.trim();
    setIsRenaming(false);
    if (nextTitle && nextTitle !== task.title) {
      await onRename(nextTitle);
    }
  };

  const handleRenameCancel = () => {
    onSidebarAction?.('task_rename_cancel', analyticsParams);
    setRenameValue(task.title);
    setIsRenaming(false);
  };

  const indicatorLabel = task.indicator === AgentSidebarIndicator.Running
    ? i18nService.t('myAgentSidebarRunning')
    : i18nService.t('myAgentSidebarUnreadResult');
  const menuItemClassName =
    'flex w-full items-center gap-2 whitespace-nowrap px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
  const menuIconClassName = 'h-3.5 w-3.5';
  const relativeTime = formatAgentTaskRelativeTime(task.updatedAt || task.createdAt);
  const showRelativeTime = task.indicator === AgentSidebarIndicator.None;
  const pinLabel = task.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession');

  return (
    <div
      className={`group relative -ml-[6px] flex h-[30px] w-[calc(100%+12px)] items-center gap-2 rounded-md ${
        isBatchMode ? 'pl-4' : 'pl-[38px]'
      } pr-2.5 text-sm font-normal transition-colors ${
        isSelectionDisabled
          ? 'cursor-default text-foreground/30'
          : task.isSelected && !hasActiveSubagent
          ? 'cursor-pointer bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.07]'
          : 'cursor-pointer text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
      }`}
      onClick={handleRowClick}
      onMouseMove={() => setSuppressPinHover(false)}
      onMouseLeave={() => setSuppressPinHover(false)}
      role="treeitem"
      aria-level={2}
      aria-selected={task.isSelected}
      aria-disabled={isSelectionDisabled || undefined}
    >
      {!isBatchMode && !isRenaming && !isSelectionDisabled && (
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
                : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-[0.3]'
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
          <span className="min-w-0 flex-1 truncate">
            {task.title}
          </span>
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
            isMenuOpen ? 'opacity-[0.46]' : 'opacity-0 group-hover:opacity-[0.3]'
          }`}
          aria-label={i18nService.t('coworkSessionActions')}
        >
          <EllipsisHorizontalIcon className="h-4 w-4" />
        </button>
      )}

      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-[60] w-max min-w-[124px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
          style={{ top: menuPosition.top, right: menuPosition.right }}
          role="menu"
        >
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
