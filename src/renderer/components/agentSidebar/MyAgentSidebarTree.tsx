import { AgentId } from '@shared/agent';
import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { agentService } from '../../services/agent';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import { selectCurrentSessionId } from '../../store/selectors/coworkSelectors';
import { setDraftCollaborationMode } from '../../store/slices/coworkSlice';
import { CoworkCollaborationMode } from '../../types/cowork';
import { isDefaultAgentId } from '../../utils/agentDisplay';
import AgentCreateModal from '../agent/AgentCreateModal';
import AgentSettingsPanel from '../agent/AgentSettingsPanel';
import {
  type CoworkOpenAgentTaskSlotEventDetail,
  type CoworkOpenShareOptionsEventDetail,
  CoworkShortcutDirection,
  type CoworkSwitchAgentEventDetail,
  CoworkUiEvent,
} from '../cowork/constants';
import AgentTreeNode from './AgentTreeNode';
import {
  type AgentSidebarBatchItem,
  createSessionBatchItem,
} from './batchSelection';
import MyAgentSidebarHeader from './MyAgentSidebarHeader';
import type { AgentSidebarAgentNode, AgentSidebarTaskNode } from './types';
import { useAgentSidebarState } from './useAgentSidebarState';

interface MyAgentSidebarTreeProps {
  isBatchMode: boolean;
  batchAgentId: string | null;
  deletedSessionIds: string[];
  selectedKeys: Set<string>;
  onShowCowork: () => void;
  onTaskSelected?: (params: {
    agentType: 'main' | 'custom';
    isCurrentSession: boolean;
    taskStatus: string;
  }) => void;
  onSidebarAction?: (actionType: string, params?: {
    agentType?: 'main' | 'custom';
    hasActiveSubagent?: boolean;
    isCurrentSession?: boolean;
    isCurrentSubagent?: boolean;
    isExpanded?: boolean;
    isPinned?: boolean;
    result?: 'success' | 'failed';
    subagentStatus?: string;
    targetPinned?: boolean;
    taskStatus?: string;
    visibleTaskCount?: number;
  }) => void;
  onToggleSelection: (selectionKey: string, agentId: string) => void;
  onEnterBatchMode: (sessionId: string, agentId: string) => void;
  onBatchSelectableItemsChange: (items: AgentSidebarBatchItem[]) => void;
}

const MyAgentSidebarTree: React.FC<MyAgentSidebarTreeProps> = ({
  isBatchMode,
  batchAgentId,
  deletedSessionIds,
  selectedKeys,
  onShowCowork,
  onTaskSelected,
  onSidebarAction,
  onToggleSelection,
  onEnterBatchMode,
  onBatchSelectableItemsChange,
}) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const dispatch = useDispatch();
  const currentSessionId = useSelector(selectCurrentSessionId);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createAgentSource, setCreateAgentSource] = useState<'home_agent_sidebar' | 'home_agent_sidebar_empty'>(
    'home_agent_sidebar',
  );
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const {
    agentNodes,
    patchTaskPreview,
    removeTaskPreview,
    removeTaskPreviews,
    removeAgentTaskPreviews,
    retryLoadTasks,
    loadMoreTasks,
    expandAgent,
    expandTasks,
    collapseTasks,
    toggleAgentExpanded,
  } = useAgentSidebarState();

  const getAgentType = useCallback((agentId: string): 'main' | 'custom' => (
    isDefaultAgentId(agentId) ? 'main' : 'custom'
  ), []);

  const getTaskActionParams = useCallback((task: AgentSidebarTaskNode, hasActiveSubagent?: boolean) => ({
    agentType: getAgentType(task.agentId),
    hasActiveSubagent,
    isCurrentSession: task.id === currentSessionId,
    isPinned: task.pinned,
    taskStatus: task.status,
  }), [currentSessionId, getAgentType]);

  useEffect(() => {
    void agentService.loadAgents();
  }, []);

  const handleSelectTask = useCallback(async (task: AgentSidebarTaskNode) => {
    onTaskSelected?.({
      agentType: isDefaultAgentId(task.agentId) ? 'main' : 'custom',
      isCurrentSession: task.id === currentSessionId,
      taskStatus: task.status,
    });
    if (task.agentId !== currentAgentId) {
      agentService.switchAgent(task.agentId);
      await coworkService.loadSessions(task.agentId);
    }
    onShowCowork();
    // Clear subagent detail view so the main session detail is shown
    window.dispatchEvent(new CustomEvent(CoworkUiEvent.SelectSubagent, { detail: null }));
    return coworkService.loadSession(task.id);
  }, [currentAgentId, currentSessionId, onShowCowork, onTaskSelected]);

  useEffect(() => {
    const handleSwitchAgent = (event: Event) => {
      const detail = (event as CustomEvent<CoworkSwitchAgentEventDetail>).detail;
      const direction = detail?.direction;
      if (!direction || agentNodes.length === 0) return;

      const currentIndex = agentNodes.findIndex((agent) => agent.id === currentAgentId);
      const fallbackIndex = direction === CoworkShortcutDirection.Next ? 0 : agentNodes.length - 1;
      const nextIndex = currentIndex < 0
        ? fallbackIndex
        : direction === CoworkShortcutDirection.Next
          ? (currentIndex + 1) % agentNodes.length
          : (currentIndex - 1 + agentNodes.length) % agentNodes.length;
      const targetAgent = agentNodes[nextIndex];
      if (!targetAgent) return;

      void (async () => {
        if (targetAgent.id !== currentAgentId) {
          agentService.switchAgent(targetAgent.id);
          await coworkService.loadSessions(targetAgent.id);
        }
        expandAgent(targetAgent.id);
        onShowCowork();
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.SelectSubagent, { detail: null }));
      })();
    };

    const handleShowCurrentAgentTasks = () => {
      expandAgent(currentAgentId);
      void expandTasks(currentAgentId);
      onShowCowork();
    };

    const handleOpenAgentTaskSlot = (event: Event) => {
      const slot = (event as CustomEvent<CoworkOpenAgentTaskSlotEventDetail>).detail?.slot;
      if (!Number.isInteger(slot) || slot < 1) return;

      void (async () => {
        expandAgent(currentAgentId);
        void expandTasks(currentAgentId);
        const result = await coworkService.listSessionsForAgentPreview(currentAgentId, slot, 0);
        const session = result.sessions?.[slot - 1];
        if (!result.success || !session) {
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: i18nService.t('shortcutAgentTaskSlotUnavailable').replace('{slot}', String(slot)),
          }));
          return;
        }

        const agentId = session.agentId?.trim() || AgentId.Main;
        if (agentId !== currentAgentId) {
          agentService.switchAgent(agentId);
          await coworkService.loadSessions(agentId);
        }
        onShowCowork();
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.SelectSubagent, { detail: null }));
        await coworkService.loadSession(session.id);
      })();
    };

    window.addEventListener(CoworkUiEvent.ShortcutSwitchAgent, handleSwitchAgent);
    window.addEventListener(CoworkUiEvent.ShortcutShowCurrentAgentTasks, handleShowCurrentAgentTasks);
    window.addEventListener(CoworkUiEvent.ShortcutOpenAgentTaskSlot, handleOpenAgentTaskSlot);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutSwitchAgent, handleSwitchAgent);
      window.removeEventListener(CoworkUiEvent.ShortcutShowCurrentAgentTasks, handleShowCurrentAgentTasks);
      window.removeEventListener(CoworkUiEvent.ShortcutOpenAgentTaskSlot, handleOpenAgentTaskSlot);
    };
  }, [agentNodes, currentAgentId, expandAgent, expandTasks, onShowCowork]);

  const handleDeleteTask = async (task: AgentSidebarTaskNode) => {
    const deleted = await coworkService.deleteSession(task.id);
    onSidebarAction?.(deleted ? 'task_delete_success' : 'task_delete_failed', {
      ...getTaskActionParams(task),
      result: deleted ? 'success' : 'failed',
    });
    if (deleted) {
      removeTaskPreview(task.id);
    }
  };

  const handleToggleTaskPin = async (task: AgentSidebarTaskNode, pinned: boolean) => {
    const result = await coworkService.setSessionPinned(task.id, pinned);
    onSidebarAction?.('task_pin_toggle', {
      ...getTaskActionParams(task),
      result: result.success ? 'success' : 'failed',
      targetPinned: pinned,
    });
    if (result.success) {
      patchTaskPreview(task.id, { pinned, pinOrder: result.pinOrder }, { preserveUpdatedAt: true });
    }
  };

  const handleRenameTask = async (task: AgentSidebarTaskNode, title: string) => {
    const renamed = await coworkService.renameSession(task.id, title);
    onSidebarAction?.('task_rename_submit', {
      ...getTaskActionParams(task),
      result: renamed ? 'success' : 'failed',
    });
    if (renamed) {
      patchTaskPreview(task.id, { title }, { preserveUpdatedAt: true });
    }
  };

  const handleShareTask = async (task: AgentSidebarTaskNode) => {
    onSidebarAction?.('task_share_open', getTaskActionParams(task));
    const session = await handleSelectTask(task);
    if (!session) return;

    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent<CoworkOpenShareOptionsEventDetail>(
        CoworkUiEvent.OpenShareOptions,
        { detail: { sessionId: task.id } },
      ));
    }, 0);
  };

  const handleEnterBatchMode = (task: AgentSidebarTaskNode) => {
    if (task.agentId !== currentAgentId) {
      agentService.switchAgent(task.agentId);
      void coworkService.loadSessions(task.agentId);
    }
    onEnterBatchMode(task.id, task.agentId);
  };

  const handleCreateTask = async (agent: AgentSidebarAgentNode) => {
    onSidebarAction?.('agent_create_task', {
      agentType: getAgentType(agent.id),
      isExpanded: agent.isExpanded,
      isPinned: agent.pinned,
    });
    if (agent.id !== currentAgentId) {
      agentService.switchAgent(agent.id);
      await coworkService.loadSessions(agent.id);
    }
    coworkService.clearSession({ restoreAgentSkills: true });
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: CoworkCollaborationMode.Default,
    }));
    onShowCowork();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: false, resetCollaborationMode: true },
      }));
    }, 0);
  };

  const handleDeleteAgent = async (agent: AgentSidebarAgentNode) => {
    if (isDefaultAgentId(agent.id)) return;
    const deleted = await agentService.deleteAgent(agent.id);
    onSidebarAction?.(deleted ? 'agent_delete_success' : 'agent_delete_failed', {
      agentType: getAgentType(agent.id),
      isPinned: agent.pinned,
      result: deleted ? 'success' : 'failed',
    });
    if (deleted) {
      removeAgentTaskPreviews(agent.id);
    }
    if (deleted && settingsAgentId === agent.id) {
      setSettingsAgentId(null);
    }
    if (!deleted) {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentDeleteFailed') }));
    }
  };

  const handleToggleAgentPin = async (agent: AgentSidebarAgentNode, pinned: boolean) => {
    const updated = await agentService.updateAgent(agent.id, { pinned });
    onSidebarAction?.('agent_pin_toggle', {
      agentType: getAgentType(agent.id),
      isPinned: agent.pinned,
      result: updated ? 'success' : 'failed',
      targetPinned: pinned,
    });
    if (!updated) {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentPinFailed') }));
    }
  };

  const renderAgentNode = (agent: AgentSidebarAgentNode) => (
    <AgentTreeNode
      key={agent.id}
      agent={agent}
      isBatchMode={isBatchMode}
      batchAgentId={batchAgentId}
      selectedKeys={selectedKeys}
      showBatchOption
      onToggleExpanded={toggleAgentExpanded}
      onEditAgent={(agent) => {
        onSidebarAction?.('agent_edit', {
          agentType: getAgentType(agent.id),
          isExpanded: agent.isExpanded,
          isPinned: agent.pinned,
        });
        setSettingsAgentId(agent.id);
      }}
      onCreateTask={(agent) => void handleCreateTask(agent)}
      onDeleteAgent={handleDeleteAgent}
      onToggleAgentPin={handleToggleAgentPin}
      onRetryLoadTasks={(agentId) => {
        const targetAgent = agentNodes.find((item) => item.id === agentId);
        onSidebarAction?.('task_list_retry_load', {
          agentType: getAgentType(agentId),
          visibleTaskCount: targetAgent?.tasks.length,
        });
        void retryLoadTasks(agentId);
      }}
      onLoadMoreTasks={(agentId) => {
        const targetAgent = agentNodes.find((item) => item.id === agentId);
        onSidebarAction?.('task_list_expand_more', {
          agentType: getAgentType(agentId),
          visibleTaskCount: targetAgent?.tasks.length,
        });
        void loadMoreTasks(agentId);
      }}
      onCollapseTasks={(agentId) => {
        const targetAgent = agentNodes.find((item) => item.id === agentId);
        onSidebarAction?.('task_list_collapse', {
          agentType: getAgentType(agentId),
          visibleTaskCount: targetAgent?.tasks.length,
        });
        collapseTasks(agentId);
      }}
      onSelectTask={(task) => void handleSelectTask(task)}
      onDeleteTask={handleDeleteTask}
      onShareTask={handleShareTask}
      onToggleTaskPin={handleToggleTaskPin}
      onRenameTask={handleRenameTask}
      onToggleSelection={onToggleSelection}
      onEnterBatchMode={handleEnterBatchMode}
      onSidebarAction={onSidebarAction}
      getTaskActionParams={getTaskActionParams}
    />
  );

  const pinnedAgentNodes = agentNodes.filter((agent) => agent.pinned);
  const projectAgentNodes = agentNodes.filter((agent) => !agent.pinned);
  const hasPinnedAgents = pinnedAgentNodes.length > 0;

  useEffect(() => {
    if (deletedSessionIds.length === 0) return;
    removeTaskPreviews(deletedSessionIds);
  }, [deletedSessionIds, removeTaskPreviews]);

  useEffect(() => {
    if (!batchAgentId) {
      onBatchSelectableItemsChange([]);
      return;
    }

    const batchAgent = agentNodes.find((agent) => agent.id === batchAgentId);
    if (!batchAgent) {
      onBatchSelectableItemsChange([]);
      return;
    }

    const items = batchAgent.tasks.map((task): AgentSidebarBatchItem => createSessionBatchItem(task.id));
    onBatchSelectableItemsChange(items);
  }, [agentNodes, batchAgentId, onBatchSelectableItemsChange]);

  return (
    <div className="pb-3" role="tree" aria-label={i18nService.t('myAgents')}>
      {hasPinnedAgents && (
        <div className="space-y-0.5">
          <div className="sticky top-0 z-30 flex h-10 items-center bg-surface-raised px-1.5">
            <h2 className="min-w-0 truncate text-sm font-normal text-secondary">
              {i18nService.t('myAgentSidebarPinned')}
            </h2>
          </div>
          {pinnedAgentNodes.map(renderAgentNode)}
        </div>
      )}

      <MyAgentSidebarHeader
        onCreateAgent={() => {
          setCreateAgentSource('home_agent_sidebar');
          setIsCreateOpen(true);
        }}
      />

      {agentNodes.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="text-xs font-medium text-secondary">
            {i18nService.t('myAgentSidebarNoAgents')}
          </p>
          <button
            type="button"
            onClick={() => {
              setCreateAgentSource('home_agent_sidebar_empty');
              setIsCreateOpen(true);
            }}
            className="mt-3 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
          >
            {i18nService.t('createNewAgent')}
          </button>
        </div>
      ) : projectAgentNodes.length > 0 ? (
        <div className="space-y-0.5 px-0">
          {projectAgentNodes.map(renderAgentNode)}
        </div>
      ) : null}

      <AgentCreateModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        source={createAgentSource}
      />
      <AgentSettingsPanel
        agentId={settingsAgentId}
        onClose={() => setSettingsAgentId(null)}
      />
    </div>
  );
};

export default MyAgentSidebarTree;
