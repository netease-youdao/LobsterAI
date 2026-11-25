import { ShareIcon } from '@heroicons/react/20/solid';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
import AgentTaskHoverCard, {
  type AgentTaskHoverCardMeta,
  getTaskHoverCardDelayMs,
  notifyTaskHoverCardClosed,
  notifyTaskHoverCardOpened,
  subscribeOtherTaskHoverCardOpen,
} from './AgentTaskHoverCard';
import { AgentSidebarIndicator, AgentTaskRowVariant } from './constants';
import {
  getScheduledTaskDisplayTitle,
  hasLegacyScheduledTaskTitle,
} from './scheduledTaskSession';
import type { TaskHoverCardAnchor } from './taskHoverCard';
import { formatAgentTaskRelativeTime } from './time';
import type { AgentSidebarTaskNode } from './types';

interface AgentTaskRowProps {
  task: AgentSidebarTaskNode;
  isBatchMode: boolean;
  isSelected: boolean;
  variant?: AgentTaskRowVariant;
  contextLabel?: string;
  contextIcon?: React.ReactNode;
  hoverMeta?: AgentTaskHoverCardMeta;
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
  variant,
  contextLabel,
  contextIcon,
  hoverMeta,
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
  const [hoverAnchor, setHoverAnchor] = useState<TaskHoverCardAnchor | null>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(editableTitle);
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const isHoveringActionsRef = useRef(false);
  const hoverCardId = useId();
  const isMenuOpen = menuPosition !== null;
  const resolvedVariant: AgentTaskRowVariant = variant
    ?? (contextLabel ? AgentTaskRowVariant.Activity : AgentTaskRowVariant.Nested);
  const isActivityRow = resolvedVariant === AgentTaskRowVariant.Activity;
  const isPinnedRow = resolvedVariant === AgentTaskRowVariant.Pinned;
  const canShowHoverCard = Boolean(hoverMeta)
    && !isBatchMode
    && !isRenaming
    && !isSelectionDisabled
    && !isMenuOpen
    && !showConfirmDelete;

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const hideHoverCard = useCallback(() => {
    clearHoverTimer();
    setHoverAnchor((previous) => {
      if (previous !== null) {
        notifyTaskHoverCardClosed(hoverCardId);
      }
      return null;
    });
  }, [clearHoverTimer, hoverCardId]);

  const readHoverAnchor = useCallback((): TaskHoverCardAnchor | null => {
    const rowElement = rowRef.current;
    if (!rowElement) return null;
    const rowRect = rowElement.getBoundingClientRect();
    const sidebarRect = rowElement.closest('aside')?.getBoundingClientRect();
    return {
      rowTop: rowRect.top,
      rowHeight: rowRect.height,
      sidebarRight: sidebarRect ? sidebarRect.right : rowRect.right,
    };
  }, []);

  const scheduleHoverCard = useCallback(() => {
    if (!canShowHoverCard || isHoveringActionsRef.current) return;
    clearHoverTimer();
    const delayMs = getTaskHoverCardDelayMs();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      if (isHoveringActionsRef.current) return;
      const anchor = readHoverAnchor();
      if (!anchor) return;
      notifyTaskHoverCardOpened(hoverCardId);
      setHoverAnchor(anchor);
    }, delayMs);
  }, [canShowHoverCard, clearHoverTimer, hoverCardId, readHoverAnchor]);

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
    hideHoverCard();
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
    if (!canShowHoverCard) {
      hideHoverCard();
    }
  }, [canShowHoverCard, hideHoverCard]);

  useEffect(() => {
    const unsubscribe = subscribeOtherTaskHoverCardOpen(hoverCardId, () => {
      clearHoverTimer();
      setHoverAnchor(null);
    });
    return () => {
      unsubscribe();
      clearHoverTimer();
      notifyTaskHoverCardClosed(hoverCardId);
    };
  }, [clearHoverTimer, hoverCardId]);

  useEffect(() => {
    if (!hoverAnchor) return;
    const handleDismiss = () => hideHoverCard();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hideHoverCard();
      }
    };
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [hideHoverCard, hoverAnchor]);

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
    hideHoverCard();
    if (isBatchMode) {
      onToggleSelection();
      return;
    }
    onSelect();
  };

  const handleRowMouseClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // The first click already opened the task; later clicks of a double click
    // belong to the rename gesture. Batch mode keeps every click as a toggle.
    if (event.detail > 1 && !isBatchMode) return;
    handleRowClick();
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

  const startRename = (actionType: 'task_rename_start' | 'task_rename_double_click') => {
    hideHoverCard();
    onSidebarAction?.(actionType, analyticsParams);
    setIsRenaming(true);
  };

  const handleTitleDoubleClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    // Batch mode uses clicks to toggle selection, so a double click there must
    // not open the editor on top of two selection toggles.
    if (isBatchMode || isSelectionDisabled) return;
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    startRename('task_rename_double_click');
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
    'flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-surface-raised';
  const dangerMenuItemClassName =
    'flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] text-red-500 transition-colors hover:bg-red-500/10';
  const menuIconClassName = 'h-3.5 w-3.5';
  const taskTimestamp = task.updatedAt || task.createdAt;
  const relativeTime = formatAgentTaskRelativeTime(taskTimestamp);
  const showRelativeTime = !isActivityRow && task.indicator === AgentSidebarIndicator.None;
  const showStatusOrTime = task.indicator !== AgentSidebarIndicator.None || showRelativeTime;
  const showRowActions = !isBatchMode && !isRenaming && !isSelectionDisabled;
  const pinLabel = task.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession');
  const scheduledTaskLabel = i18nService.t('myAgentSidebarScheduledTask');
  // Nested and pinned tasks keep full 14px legibility; hierarchy comes from indentation,
  // icon-less alignment on the agent text rail, and a slightly softer ink step.
  const textSizeClassName = isActivityRow
    ? 'text-[length:var(--lobster-text-sidebarCompact)]'
    : 'text-[length:var(--lobster-text-sidebarTask)]';
  const leftPaddingClassName = isBatchMode
    ? 'pl-2'
    : isActivityRow || isPinnedRow
      ? 'pl-2.5'
      : 'pl-[38px]';

  const contextMenu = menuPosition ? (
    <div
      ref={menuRef}
      className="fixed z-[60] w-max min-w-[136px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-popover"
      style={{ top: menuPosition.top, right: menuPosition.right }}
      role="menu"
      onKeyDown={handleMenuKeyDown}
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
          startRename('task_rename_start');
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
        {pinLabel}
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
        className={dangerMenuItemClassName}
        role="menuitem"
      >
        <TrashIcon className={menuIconClassName} />
        {i18nService.t('deleteSession')}
      </button>
    </div>
  ) : null;

  return (
    <div
      ref={rowRef}
      className={`group relative flex w-full items-center gap-2 rounded-[9px] ${
        isActivityRow ? 'min-h-[48px] py-1.5' : 'h-[32px]'
      } ${leftPaddingClassName} pr-2 ${textSizeClassName} transition-all duration-150 ${
        isSelectionDisabled
          ? 'cursor-default font-normal text-foreground/30'
          : task.isSelected && !hasActiveSubagent
            ? 'cursor-pointer bg-[var(--lobster-sidebar-item-hover)] font-medium text-foreground'
            : `cursor-pointer font-normal hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground ${
              isActivityRow ? 'text-foreground' : 'text-foreground/85'
            }`
      }`}
      onClick={handleRowMouseClick}
      onKeyDown={handleRowKeyDown}
      onMouseEnter={scheduleHoverCard}
      onMouseLeave={() => {
        isHoveringActionsRef.current = false;
        hideHoverCard();
      }}
      onPointerDown={hideHoverCard}
      role="treeitem"
      tabIndex={isSelectionDisabled ? -1 : 0}
      aria-level={isActivityRow || isPinnedRow ? 1 : 2}
      aria-selected={task.isSelected}
      aria-disabled={isSelectionDisabled || undefined}
    >
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
          className={`min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-0.5 ${textSizeClassName} font-normal text-foreground focus:outline-none focus:ring-1 focus:ring-primary`}
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
          <span
            className={`min-w-0 flex-1 ${isActivityRow ? 'flex flex-col gap-0.5' : 'truncate'}`}
            onDoubleClick={handleTitleDoubleClick}
          >
            <span className="truncate">{displayTitle}</span>
            {contextLabel && (
              <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--lobster-text-sidebarMeta)] font-normal leading-4 text-secondary">
                {contextIcon && (
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                    {contextIcon}
                  </span>
                )}
                <span className="truncate">{contextLabel}</span>
              </span>
            )}
          </span>

          {(showStatusOrTime || showRowActions) && (
            <div className="flex shrink-0 items-center">
              {showStatusOrTime && (
                <div
                  className={`flex items-center ${
                    showRowActions
                      ? isMenuOpen
                        ? 'w-0 overflow-hidden opacity-0'
                        : 'group-hover:w-0 group-hover:overflow-hidden group-hover:opacity-0 group-focus-within:w-0 group-focus-within:overflow-hidden group-focus-within:opacity-0'
                      : ''
                  }`}
                >
                  {task.indicator === AgentSidebarIndicator.PendingPermission && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-3 text-primary"
                      title={indicatorLabel}
                      aria-label={indicatorLabel}
                    >
                      <span className="h-1 w-1 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
                      {indicatorLabel}
                    </span>
                  )}
                  {task.indicator === AgentSidebarIndicator.Running && (
                    <span
                      className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
                      title={indicatorLabel}
                      aria-label={indicatorLabel}
                    >
                      <LoadingIcon className="h-3 w-3 animate-spin text-secondary" aria-hidden="true" />
                    </span>
                  )}
                  {task.indicator === AgentSidebarIndicator.CompletedUnread && (
                    <span
                      className="h-[7px] w-[7px] shrink-0 rounded-full bg-primary"
                      title={indicatorLabel}
                      aria-label={indicatorLabel}
                    />
                  )}
                  {showRelativeTime && (
                    <span
                      className="shrink-0 whitespace-nowrap pr-0.5 text-[length:var(--lobster-text-sidebarMeta)] font-normal tabular-nums text-secondary/90"
                      title={relativeTime.full}
                    >
                      {relativeTime.compact}
                    </span>
                  )}
                </div>
              )}

              {showRowActions && (
                <div
                  className={`flex items-center gap-0.5 ${
                    isMenuOpen
                      ? 'pointer-events-auto w-auto overflow-visible opacity-100'
                      : 'pointer-events-none w-0 overflow-hidden opacity-0 group-hover:pointer-events-auto group-hover:w-auto group-hover:overflow-visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:w-auto group-focus-within:overflow-visible group-focus-within:opacity-100'
                  }`}
                  onMouseEnter={() => {
                    isHoveringActionsRef.current = true;
                    hideHoverCard();
                  }}
                  onMouseLeave={() => {
                    isHoveringActionsRef.current = false;
                    scheduleHoverCard();
                  }}
                >
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      hideHoverCard();
                      event.currentTarget.blur();
                      void onTogglePin(!task.pinned);
                    }}
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] focus:outline-none focus-visible:opacity-100 ${
                      task.pinned
                        ? 'text-foreground/85 hover:text-foreground'
                        : 'text-secondary hover:text-foreground'
                    }`}
                    aria-label={pinLabel}
                    aria-pressed={task.pinned}
                    title={pinLabel}
                  >
                    <PushPinIcon filled={task.pinned} className="h-3.5 w-3.5" />
                  </button>
                  <button
                    ref={actionButtonRef}
                    type="button"
                    onClick={toggleMenu}
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-secondary transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground focus-visible:opacity-100 ${
                      isMenuOpen
                        ? 'bg-[var(--lobster-sidebar-item-hover)] text-foreground opacity-100'
                        : ''
                    }`}
                    aria-label={i18nService.t('coworkSessionActions')}
                  >
                    <EllipsisHorizontalIcon className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {contextMenu && (typeof document !== 'undefined' ? createPortal(contextMenu, document.body) : contextMenu)}

      {hoverAnchor && hoverMeta && (
        <AgentTaskHoverCard
          anchor={hoverAnchor}
          title={displayTitle}
          timestamp={taskTimestamp}
          cwd={task.cwd}
          forkGitBranch={task.forkGitBranch}
          indicator={task.indicator}
          isScheduledTask={task.isScheduledTask}
          imPlatformLabel={imPlatformLabel}
          meta={hoverMeta}
        />
      )}

      {showConfirmDelete && (
        <Modal
          onClose={() => setShowConfirmDelete(false)}
          className="mx-4 w-full max-w-sm overflow-hidden rounded-2xl bg-surface shadow-xl"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
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
          <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
            <button
              type="button"
              onClick={() => {
                onSidebarAction?.('task_delete_cancel', analyticsParams);
                setShowConfirmDelete(false);
              }}
              className="rounded-lg px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised"
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
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
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
