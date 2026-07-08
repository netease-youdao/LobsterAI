import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { getAgentDisplayName, isDefaultAgentId, shouldUseDefaultAgentIcon } from '../../utils/agentDisplay';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import AgentConfirmDialog from '../agent/AgentConfirmDialog';
import { AgentConfirmDialogVariant } from '../agent/constants';
import ComposeIcon from '../icons/ComposeIcon';
import DefaultAgentIcon from '../icons/DefaultAgentIcon';
import EditIcon from '../icons/EditIcon';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import PushPinIcon from '../icons/PushPinIcon';
import TrashIcon from '../icons/TrashIcon';
import AgentTaskRow from './AgentTaskRow';
import { createSessionBatchKey } from './batchSelection';
import ExpandAgentTasksRow from './ExpandAgentTasksRow';
import type { AgentSidebarAgentNode, AgentSidebarTaskNode } from './types';

interface AgentTreeNodeProps {
  agent: AgentSidebarAgentNode;
  isBatchMode: boolean;
  batchAgentId: string | null;
  selectedKeys: Set<string>;
  showBatchOption?: boolean;
  onToggleExpanded: (agentId: string) => void;
  onEditAgent: (agent: AgentSidebarAgentNode) => void;
  onCreateTask: (agent: AgentSidebarAgentNode) => void;
  onDeleteAgent: (agent: AgentSidebarAgentNode) => Promise<void>;
  onToggleAgentPin: (agent: AgentSidebarAgentNode, pinned: boolean) => Promise<void>;
  onRetryLoadTasks: (agentId: string) => void;
  onLoadMoreTasks: (agentId: string) => void;
  onCollapseTasks: (agentId: string) => void;
  onSelectTask: (task: AgentSidebarTaskNode) => void;
  onDeleteTask: (task: AgentSidebarTaskNode) => Promise<void>;
  onShareTask: (task: AgentSidebarTaskNode) => Promise<void>;
  onToggleTaskPin: (task: AgentSidebarTaskNode, pinned: boolean) => Promise<void>;
  onRenameTask: (task: AgentSidebarTaskNode, title: string) => Promise<void>;
  onToggleSelection: (selectionKey: string, agentId: string) => void;
  onEnterBatchMode: (task: AgentSidebarTaskNode) => void;
  onSidebarAction?: (actionType: string, params?: {
    agentType?: 'main' | 'custom';
    hasActiveSubagent?: boolean;
    isCurrentSession?: boolean;
    isCurrentSubagent?: boolean;
    isExpanded?: boolean;
    isPinned?: boolean;
    subagentStatus?: string;
    targetPinned?: boolean;
    taskStatus?: string;
    visibleTaskCount?: number;
  }) => void;
  getTaskActionParams?: (task: AgentSidebarTaskNode, hasActiveSubagent?: boolean) => {
    agentType: 'main' | 'custom';
    hasActiveSubagent?: boolean;
    isCurrentSession: boolean;
    isPinned: boolean;
    taskStatus: string;
  };
}

const ACTION_MENU_VIEWPORT_PADDING = 8;
const ACTION_MENU_VERTICAL_GAP = 4;
const ACTION_MENU_HEIGHT = 104;
const AGENT_TASKS_TRANSITION_MS = 200;

const AgentAvatar: React.FC<{ agent: AgentSidebarAgentNode }> = ({ agent }) => {
  if (shouldUseDefaultAgentIcon(agent)) {
    return <DefaultAgentIcon className="h-4 w-4" />;
  }

  return (
    <AgentAvatarIcon
      value={agent.icon}
      className="h-4 w-4"
      iconClassName="h-4 w-4"
      legacyClassName="text-[14px]"
      fallbackText={getAgentDisplayName(agent).trim().slice(0, 1).toUpperCase() || 'A'}
    />
  );
};

const AgentTreeNode: React.FC<AgentTreeNodeProps> = ({
  agent,
  isBatchMode,
  batchAgentId,
  selectedKeys,
  showBatchOption = false,
  onToggleExpanded,
  onEditAgent,
  onCreateTask,
  onDeleteAgent,
  onToggleAgentPin,
  onRetryLoadTasks,
  onLoadMoreTasks,
  onCollapseTasks,
  onSelectTask,
  onDeleteTask,
  onShareTask,
  onToggleTaskPin,
  onRenameTask,
  onToggleSelection,
  onEnterBatchMode,
  onSidebarAction,
  getTaskActionParams,
}) => {
  const [menuPosition, setMenuPosition] = useState<{ right: number; top: number } | null>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [shouldRenderTasks, setShouldRenderTasks] = useState(agent.isExpanded);
  const [isTaskGroupVisible, setIsTaskGroupVisible] = useState(agent.isExpanded);
  const [isTaskGroupTransitioning, setIsTaskGroupTransitioning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousExpandedRef = useRef(agent.isExpanded);
  const isMenuOpen = menuPosition !== null;
  const isMainAgent = isDefaultAgentId(agent.id);
  const isBatchAgent = isBatchMode && batchAgentId === agent.id;
  const isOutsideBatchAgent = isBatchMode && batchAgentId !== null && batchAgentId !== agent.id;
  const agentName = getAgentDisplayName(agent);
  const menuItemClassName =
    'flex w-full items-center gap-2 whitespace-nowrap px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
  const dangerMenuItemClassName =
    'flex w-full items-center gap-2 whitespace-nowrap px-2.5 py-1.5 text-left text-[13px] text-red-500 transition-colors hover:bg-red-500/10';
  const disabledMenuItemClassName =
    'flex w-full cursor-not-allowed items-center gap-2 whitespace-nowrap px-2.5 py-1.5 text-left text-[13px] text-secondary/40';
  const rowActionButtonClassName =
    'inline-flex h-5 w-5 items-center justify-center rounded text-foreground opacity-[0.3] transition-opacity hover:opacity-[0.46]';
  const rowEditActionButtonClassName =
    'inline-flex h-5 w-5 items-center justify-center rounded text-foreground opacity-[0.3] transition-opacity hover:opacity-[0.46]';
  const menuIconClassName = 'h-3.5 w-3.5';

  const calculateMenuPosition = useCallback(() => {
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const right = Math.max(ACTION_MENU_VIEWPORT_PADDING, window.innerWidth - rect.right);
    const top = Math.max(
      ACTION_MENU_VIEWPORT_PADDING,
      Math.min(
        rect.bottom + ACTION_MENU_VERTICAL_GAP,
        window.innerHeight - ACTION_MENU_HEIGHT - ACTION_MENU_VIEWPORT_PADDING,
      ),
    );

    return { right, top };
  }, []);

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
  }, []);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) {
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
    let animationFrame: number | undefined;
    let transitionTimeout: number | undefined;
    const wasExpanded = previousExpandedRef.current;

    previousExpandedRef.current = agent.isExpanded;

    if (wasExpanded === agent.isExpanded) {
      return undefined;
    }

    if (agent.isExpanded) {
      setShouldRenderTasks(true);
      setIsTaskGroupVisible(false);
      setIsTaskGroupTransitioning(true);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = window.requestAnimationFrame(() => {
          setIsTaskGroupVisible(true);
          transitionTimeout = window.setTimeout(() => {
            setIsTaskGroupTransitioning(false);
          }, AGENT_TASKS_TRANSITION_MS);
        });
      });
    } else {
      setIsTaskGroupTransitioning(true);
      setIsTaskGroupVisible(false);
      transitionTimeout = window.setTimeout(() => {
        setShouldRenderTasks(false);
        setIsTaskGroupTransitioning(false);
      }, AGENT_TASKS_TRANSITION_MS);
    }

    return () => {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (transitionTimeout !== undefined) {
        window.clearTimeout(transitionTimeout);
      }
    };
  }, [agent.isExpanded]);

  const handleEditAgent = (event: React.MouseEvent) => {
    event.stopPropagation();
    closeMenu();
    onEditAgent(agent);
  };

  const handleCreateTask = (event: React.MouseEvent) => {
    event.stopPropagation();
    closeMenu();
    onCreateTask(agent);
  };

  const handleAgentClick = (event: React.MouseEvent) => {
    onSidebarAction?.('agent_header_click', {
      agentType: isMainAgent ? 'main' : 'custom',
      isExpanded: agent.isExpanded,
      isPinned: agent.pinned,
    });
    onToggleExpanded(agent.id);
    handleCreateTask(event);
  };

  const handleDeleteMenuClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isMainAgent) return;
    closeMenu();
    onSidebarAction?.('agent_delete_confirm_open', {
      agentType: 'custom',
      isExpanded: agent.isExpanded,
      isPinned: agent.pinned,
    });
    setShowConfirmDelete(true);
  };

  const handleToggleAgentPin = (event: React.MouseEvent) => {
    event.stopPropagation();
    closeMenu();
    void onToggleAgentPin(agent, !agent.pinned);
  };

  return (
    <div className="space-y-0.5">
      <div className={`group sticky top-10 ${isMenuOpen ? 'z-50' : 'z-20'} -ml-[6px] h-7 w-[calc(100%+12px)] bg-surface-raised`}>
        <button
          type="button"
          onClick={handleAgentClick}
          className="flex h-full w-full items-center gap-2 rounded-md py-0 pl-3.5 pr-12 text-left text-sm font-normal text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          role="treeitem"
          aria-level={1}
          aria-expanded={agent.isExpanded}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center leading-none text-foreground">
            <AgentAvatar agent={agent} />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {agentName}
          </span>
        </button>

        <div
          className={`absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity ${
            isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          }`}
        >
          <button
            ref={menuButtonRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (isMenuOpen) {
                closeMenu();
                return;
              }
              const position = calculateMenuPosition();
              if (position) {
                onSidebarAction?.('agent_menu_open', {
                  agentType: isMainAgent ? 'main' : 'custom',
                  isExpanded: agent.isExpanded,
                  isPinned: agent.pinned,
                });
                setMenuPosition(position);
              }
            }}
            className={rowActionButtonClassName}
            aria-label={i18nService.t('coworkSessionActions')}
          >
            <EllipsisHorizontalIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCreateTask}
            className={rowEditActionButtonClassName}
            aria-label={i18nService.t('myAgentSidebarNewTask')}
          >
            <ComposeIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        {menuPosition && (
          <div
            ref={menuRef}
            className="fixed z-[60] w-max min-w-[104px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
            style={{ top: menuPosition.top, right: menuPosition.right }}
            role="menu"
          >
            <button
              type="button"
              onClick={handleEditAgent}
              className={menuItemClassName}
              role="menuitem"
            >
              <EditIcon className={menuIconClassName} />
              {i18nService.t('edit')}
            </button>
            <button
              type="button"
              onClick={handleToggleAgentPin}
              className={menuItemClassName}
              role="menuitem"
            >
              <PushPinIcon slashed={agent.pinned} className={menuIconClassName} />
              {agent.pinned ? i18nService.t('agentUnpin') : i18nService.t('agentPin')}
            </button>
            {isMainAgent ? (
              <button
                type="button"
                disabled
                className={disabledMenuItemClassName}
                role="menuitem"
                title={i18nService.t('agentDefaultCannotDelete')}
              >
                <TrashIcon className={menuIconClassName} />
                {i18nService.t('delete')}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDeleteMenuClick}
                className={dangerMenuItemClassName}
                role="menuitem"
              >
                <TrashIcon className={menuIconClassName} />
                {i18nService.t('delete')}
              </button>
            )}
          </div>
        )}

        {showConfirmDelete && (
          <AgentConfirmDialog
            variant={AgentConfirmDialogVariant.Delete}
            title={i18nService.t('agentDeleteConfirmTitle')}
            message={i18nService.t('agentDeleteConfirmMessage').replace('{name}', agentName)}
            cancelLabel={i18nService.t('cancel')}
            confirmLabel={i18nService.t('delete')}
            onCancel={() => {
              onSidebarAction?.('agent_delete_cancel', {
                agentType: 'custom',
                isExpanded: agent.isExpanded,
                isPinned: agent.pinned,
              });
              setShowConfirmDelete(false);
            }}
            onConfirm={() => {
              onSidebarAction?.('agent_delete_submit', {
                agentType: 'custom',
                isExpanded: agent.isExpanded,
                isPinned: agent.pinned,
              });
              setShowConfirmDelete(false);
              void onDeleteAgent(agent);
            }}
          />
        )}
      </div>

      {shouldRenderTasks && (
        <div
          className={`grid w-full min-w-0 max-w-full transition-all duration-200 ease-out motion-reduce:transition-none ${
            isTaskGroupVisible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div
            className={`min-h-0 min-w-0 max-w-full ${
              isTaskGroupVisible && !isTaskGroupTransitioning ? 'overflow-visible' : 'overflow-hidden'
            } ${isTaskGroupVisible ? '' : 'pointer-events-none'}`}
            role="group"
            aria-hidden={!agent.isExpanded}
          >
            <div className="min-w-0 max-w-full space-y-0.5">
              {agent.hasLoadError && agent.tasks.length === 0 && (
                <button
                  type="button"
                  onClick={() => onRetryLoadTasks(agent.id)}
                  className="-ml-[6px] flex h-7 w-[calc(100%+12px)] items-center rounded-md pl-[38px] pr-2.5 text-left text-[13px] text-red-500 transition-colors hover:bg-red-500/10"
                >
                  {i18nService.t('myAgentSidebarLoadFailed')}
                </button>
              )}

              {agent.isLoadingTasks && agent.tasks.length === 0 && (
                <div className="-ml-[6px] flex h-7 w-[calc(100%+12px)] items-center pl-[38px] pr-2.5 text-[13px] text-secondary">
                  {i18nService.t('loading')}
                </div>
              )}

              {!agent.isLoadingTasks && !agent.hasLoadError && agent.tasks.length === 0 && (
                <div className="-ml-[6px] flex h-7 w-[calc(100%+12px)] items-center pl-[38px] pr-2.5 text-[length:var(--lobster-text-sidebarCompact)] text-secondary">
                  {i18nService.t('myAgentSidebarNoTasks')}
                </div>
              )}

              {agent.tasks.map((task) => (
                <React.Fragment key={task.id}>
                  <AgentTaskRow
                    task={task}
                    isBatchMode={isBatchAgent}
                    isSelected={selectedKeys.has(createSessionBatchKey(task.id))}
                    isSelectionDisabled={isOutsideBatchAgent}
                    showBatchOption={showBatchOption && !isBatchMode}
                    onSelect={() => onSelectTask(task)}
                    onDelete={() => onDeleteTask(task)}
                    onShare={() => onShareTask(task)}
                    onTogglePin={(pinned) => onToggleTaskPin(task, pinned)}
                    onRename={(title) => onRenameTask(task, title)}
                    onToggleSelection={() => onToggleSelection(createSessionBatchKey(task.id), task.agentId)}
                    onEnterBatchMode={() => onEnterBatchMode(task)}
                    onSidebarAction={onSidebarAction}
                    analyticsParams={getTaskActionParams?.(task)}
                  />
                </React.Fragment>
              ))}

              {agent.hasLoadError && agent.tasks.length > 0 && (
                <button
                  type="button"
                  onClick={() => onRetryLoadTasks(agent.id)}
                  className="-ml-[6px] flex h-7 w-[calc(100%+12px)] items-center rounded-md pl-[38px] pr-2.5 text-left text-[13px] text-red-500 transition-colors hover:bg-red-500/10"
                >
                  {i18nService.t('myAgentSidebarLoadFailed')}
                </button>
              )}

              {agent.canExpandTasks && (
                <ExpandAgentTasksRow
                  isLoading={agent.isLoadingTasks}
                  label={i18nService.t('myAgentSidebarExpandMore')}
                  onClick={() => onLoadMoreTasks(agent.id)}
                />
              )}
              {agent.canCollapseTasks && (
                <ExpandAgentTasksRow
                  isLoading={false}
                  label={i18nService.t('myAgentSidebarCollapse')}
                  onClick={() => onCollapseTasks(agent.id)}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentTreeNode;
