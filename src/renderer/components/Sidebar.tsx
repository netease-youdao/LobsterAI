import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { AgentId } from '@shared/agent';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../services/agent';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../services/logReporter';
import { RootState } from '../store';
import {
  selectCoworkSessions,
  selectCurrentSessionId,
} from '../store/selectors/coworkSelectors';
import type { CoworkSessionSummary } from '../types/cowork';
import { getAgentDisplayNameById } from '../utils/agentDisplay';
import {
  type AgentSidebarBatchItem,
  AgentSidebarBatchItemKind,
  type AgentSidebarSubagentBatchItem,
  createSessionBatchKey,
} from './agentSidebar/batchSelection';
import MyAgentSidebarTree from './agentSidebar/MyAgentSidebarTree';
import Modal from './common/Modal';
import { CoworkUiEvent } from './cowork/constants';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import Cog6ToothIcon from './icons/Cog6ToothIcon';
import ComposeIcon from './icons/ComposeIcon';
import SidebarAutomationIcon from './icons/SidebarAutomationIcon';
import SidebarKitsIcon from './icons/SidebarKitsIcon';
import SidebarMcpIcon from './icons/SidebarMcpIcon';
import SidebarSearchIcon from './icons/SidebarSearchIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import SkillIcon from './icons/SkillIcon';
import TrashIcon from './icons/TrashIcon';
import LoginButton from './LoginButton';
import SidebarAdBanner from './SidebarAdBanner';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'kits' | 'mcp';
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowKits: () => void;
  onShowMcp: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  updateBadge?: React.ReactNode;
  hideLogin?: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 244;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_COLLAPSE_TRANSITION_MS = 200;
const normalizeAgentId = (agentId?: string | null) => agentId?.trim() || AgentId.Main;
const SidebarNewFeatureBadge = {
  KitsDismissedVersionKey: 'sidebar.kitsNewFeatureBadge.dismissedVersion',
  // Bump this value in a release when the kits entry should show the badge again.
  KitsVersion: '2026-06-05',
} as const;
const sidebarNavItemClassName =
  'w-full inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-sm font-normal text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
const activeSidebarNavItemClassName =
  `${sidebarNavItemClassName} bg-black/[0.06] font-medium hover:bg-black/[0.06] dark:bg-white/[0.07] dark:hover:bg-white/[0.07]`;
const sidebarCreateIconClassName = 'h-4 w-4 shrink-0';

type SidebarAnalyticsSource = 'home_sidebar' | 'home_agent_sidebar';

interface SidebarAnalyticsOptions {
  activeView?: SidebarProps['activeView'];
  agentType?: 'main' | 'custom';
  hasActiveSubagent?: boolean;
  isCollapsed?: boolean;
  isCurrentSession?: boolean;
  isCurrentSubagent?: boolean;
  isExpanded?: boolean;
  isPinned?: boolean;
  isSelectAllChecked?: boolean;
  result?: 'success' | 'failed';
  selectedCount?: number;
  selectedSessionCount?: number;
  selectedSubagentCount?: number;
  selectableCount?: number;
  source?: SidebarAnalyticsSource;
  subagentStatus?: string;
  targetPinned?: boolean;
  targetSelected?: boolean;
  taskStatus?: string;
  visibleTaskCount?: number;
}

const reportSidebarAction = (
  actionType: string,
  options: SidebarAnalyticsOptions = {},
): void => {
  console.debug('[Sidebar] reporting sidebar action analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.SidebarAction,
    source: options.source ?? 'home_sidebar',
    actionType,
    activeView: options.activeView,
    agentType: options.agentType,
    hasActiveSubagent: options.hasActiveSubagent,
    isCollapsed: options.isCollapsed,
    isCurrentSession: options.isCurrentSession,
    isCurrentSubagent: options.isCurrentSubagent,
    isExpanded: options.isExpanded,
    isPinned: options.isPinned,
    isSelectAllChecked: options.isSelectAllChecked,
    result: options.result,
    selectedCount: options.selectedCount,
    selectedSessionCount: options.selectedSessionCount,
    selectedSubagentCount: options.selectedSubagentCount,
    selectableCount: options.selectableCount,
    subagentStatus: options.subagentStatus,
    targetPinned: options.targetPinned,
    targetSelected: options.targetSelected,
    taskStatus: options.taskStatus,
    visibleTaskCount: options.visibleTaskCount,
  });
};

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowKits,
  onShowMcp,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  updateBadge,
  hideLogin,
}) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const sessions = useSelector(selectCoworkSessions);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [batchAgentId, setBatchAgentId] = useState<string | null>(null);
  const [batchSelectableItems, setBatchSelectableItems] = useState<AgentSidebarBatchItem[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [deletedSessionIds, setDeletedSessionIds] = useState<string[]>([]);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [agentScrollEdges, setAgentScrollEdges] = useState({ top: false, bottom: false });
  const [isSidebarBannerVisible, setIsSidebarBannerVisible] = useState(false);
  const [showKitsNewBadge, setShowKitsNewBadge] = useState(false);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const agentScrollContainerRef = useRef<HTMLDivElement>(null);
  const isMac = window.electron.platform === 'darwin';
  const batchSelectableKeySet = useMemo(
    () => new Set(batchSelectableItems.map((item) => item.key)),
    [batchSelectableItems],
  );
  const batchSelectableItemByKey = useMemo(() => {
    const itemByKey = new Map<string, AgentSidebarBatchItem>();
    batchSelectableItems.forEach((item) => itemByKey.set(item.key, item));
    return itemByKey;
  }, [batchSelectableItems]);
  const selectedBatchSelectableCount = useMemo(() => {
    return batchSelectableItems.filter((item) => selectedKeys.has(item.key)).length;
  }, [batchSelectableItems, selectedKeys]);
  const isBatchSelectAllChecked =
    batchSelectableItems.length > 0 && selectedBatchSelectableCount === batchSelectableItems.length;
  const batchAgentName = batchAgentId ? getAgentDisplayNameById(batchAgentId, agents) : null;
  const getBatchSelectionSummary = useCallback(() => {
    const selectedItems = Array.from(selectedKeys)
      .filter((key) => batchSelectableKeySet.size === 0 || batchSelectableKeySet.has(key))
      .map((key) => batchSelectableItemByKey.get(key))
      .filter((item): item is AgentSidebarBatchItem => Boolean(item));
    const selectedSessionCount = selectedItems.filter(
      (item) => item.kind === AgentSidebarBatchItemKind.Session,
    ).length;
    const selectedSubagentCount = selectedItems.filter(
      (item) => item.kind === AgentSidebarBatchItemKind.Subagent,
    ).length;
    return {
      selectedCount: selectedItems.length,
      selectedSessionCount,
      selectedSubagentCount,
      selectableCount: batchSelectableItems.length,
    };
  }, [batchSelectableItemByKey, batchSelectableItems.length, batchSelectableKeySet, selectedKeys]);

  useEffect(() => {
    let isCurrent = true;

    const loadKitsNewBadgeState = async () => {
      try {
        const dismissedVersion = await window.electron.store.get(
          SidebarNewFeatureBadge.KitsDismissedVersionKey,
        );
        if (!isCurrent) return;
        setShowKitsNewBadge(dismissedVersion !== SidebarNewFeatureBadge.KitsVersion);
      } catch (error) {
        console.warn('[Sidebar] failed to load kits new feature badge state:', error);
      }
    };

    void loadKitsNewBadgeState();

    return () => {
      isCurrent = false;
    };
  }, []);

  const dismissKitsNewBadge = useCallback(() => {
    if (!showKitsNewBadge) return;
    setShowKitsNewBadge(false);
    void window.electron.store
      .set(
        SidebarNewFeatureBadge.KitsDismissedVersionKey,
        SidebarNewFeatureBadge.KitsVersion,
      )
      .catch((error) => {
        console.warn('[Sidebar] failed to save kits new feature badge state:', error);
      });
  }, [showKitsNewBadge]);

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener(CoworkUiEvent.ShortcutSearch, handleSearch);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutSearch, handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
    setIsBatchMode(false);
    setBatchAgentId(null);
    setBatchSelectableItems([]);
    setSelectedKeys(new Set());
    setShowBatchDeleteConfirm(false);
  }, [isCollapsed]);

  const handleSelectSession = async (session: CoworkSessionSummary) => {
    const agentId = session.agentId?.trim() || AgentId.Main;
    if (agentId !== currentAgentId) {
      agentService.switchAgent(agentId);
      await coworkService.loadSessions(agentId);
    }
    onShowCowork();
    await coworkService.loadSession(session.id);
  };

  const handleEnterBatchMode = useCallback((sessionId: string, agentId: string) => {
    reportSidebarAction('batch_mode_enter', {
      source: 'home_agent_sidebar',
      agentType: normalizeAgentId(agentId) === AgentId.Main ? 'main' : 'custom',
      selectedCount: 1,
    });
    setIsBatchMode(true);
    setBatchAgentId(agentId);
    setBatchSelectableItems([]);
    setSelectedKeys(new Set([createSessionBatchKey(sessionId)]));
  }, []);

  const handleExitBatchMode = useCallback(() => {
    reportSidebarAction('batch_mode_exit', {
      source: 'home_agent_sidebar',
      agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
      ...getBatchSelectionSummary(),
    });
    setIsBatchMode(false);
    setBatchAgentId(null);
    setBatchSelectableItems([]);
    setSelectedKeys(new Set());
    setShowBatchDeleteConfirm(false);
  }, [batchAgentId, getBatchSelectionSummary]);

  const handleBatchSelectableItemsChange = useCallback((items: AgentSidebarBatchItem[]) => {
    setBatchSelectableItems(items);
    setSelectedKeys((previous) => {
      if (!batchAgentId || items.length === 0) return previous;
      const itemKeySet = new Set(items.map((item) => item.key));
      const next = new Set(Array.from(previous).filter((key) => itemKeySet.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [batchAgentId]);

  const updateAgentScrollEdges = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      setAgentScrollEdges((previousEdges) => (
        previousEdges.top || previousEdges.bottom ? { top: false, bottom: false } : previousEdges
      ));
      return;
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextEdges = {
      top: element.scrollTop > 1,
      bottom: maxScrollTop - element.scrollTop > 1,
    };

    setAgentScrollEdges((previousEdges) => {
      if (previousEdges.top === nextEdges.top && previousEdges.bottom === nextEdges.bottom) {
        return previousEdges;
      }
      return nextEdges;
    });
  }, []);

  const handleAgentScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    updateAgentScrollEdges(event.currentTarget);
  }, [updateAgentScrollEdges]);

  const handleToggleSelection = useCallback((selectionKey: string, agentId: string) => {
    if (batchAgentId && normalizeAgentId(agentId) !== batchAgentId) return;
    setSelectedKeys(prev => {
      const next = new Set(prev);
      const targetSelected = !next.has(selectionKey);
      if (next.has(selectionKey)) {
        next.delete(selectionKey);
      } else {
        next.add(selectionKey);
      }
      reportSidebarAction('batch_item_toggle', {
        source: 'home_agent_sidebar',
        agentType: normalizeAgentId(agentId) === AgentId.Main ? 'main' : 'custom',
        selectedCount: next.size,
        selectableCount: batchSelectableItems.length,
        targetSelected,
      });
      return next;
    });
  }, [batchAgentId, batchSelectableItems.length]);

  const handleSelectAll = useCallback(() => {
    if (batchSelectableItems.length === 0) return;
    setSelectedKeys(prev => {
      const selectedVisibleCount = batchSelectableItems.filter((item) => prev.has(item.key)).length;
      if (selectedVisibleCount === batchSelectableItems.length) {
        reportSidebarAction('batch_select_all_toggle', {
          source: 'home_agent_sidebar',
          agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
          selectedCount: 0,
          selectableCount: batchSelectableItems.length,
          isSelectAllChecked: false,
        });
        return new Set();
      }
      reportSidebarAction('batch_select_all_toggle', {
        source: 'home_agent_sidebar',
        agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
        selectedCount: batchSelectableItems.length,
        selectableCount: batchSelectableItems.length,
        isSelectAllChecked: true,
      });
      return new Set(batchSelectableItems.map((item) => item.key));
    });
  }, [batchAgentId, batchSelectableItems]);

  const handleBatchDeleteClick = useCallback(() => {
    if (selectedKeys.size === 0) return;
    reportSidebarAction('batch_delete_confirm_open', {
      source: 'home_agent_sidebar',
      agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
      ...getBatchSelectionSummary(),
    });
    setShowBatchDeleteConfirm(true);
  }, [batchAgentId, getBatchSelectionSummary, selectedKeys.size]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedKeys.size === 0) return;
    const items = Array.from(selectedKeys)
      .filter((key) => batchSelectableKeySet.size === 0 || batchSelectableKeySet.has(key))
      .map((key) => batchSelectableItemByKey.get(key))
      .filter((item): item is AgentSidebarBatchItem => Boolean(item));
    if (items.length === 0) return;

    const subagentItems = items.filter(
      (item): item is AgentSidebarSubagentBatchItem => item.kind === AgentSidebarBatchItemKind.Subagent,
    );
    const sessionIds = items
      .filter((item) => item.kind === AgentSidebarBatchItemKind.Session)
      .map((item) => item.sessionId);
    const selectedSessionCount = sessionIds.length;
    const selectedSubagentCount = subagentItems.length;

    reportSidebarAction('batch_delete_submit', {
      source: 'home_agent_sidebar',
      agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
      selectedCount: items.length,
      selectedSessionCount,
      selectedSubagentCount,
      selectableCount: batchSelectableItems.length,
    });

    const deletedSubagents: AgentSidebarSubagentBatchItem[] = [];
    for (const item of subagentItems) {
      const deleted = await coworkService.deleteSubagentSession(item.parentSessionId, item.runId);
      if (deleted) {
        deletedSubagents.push(item);
      }
    }

    let deletedSessions = false;
    if (sessionIds.length > 0) {
      deletedSessions = await coworkService.deleteSessions(sessionIds);
    }

    if (!deletedSessions && deletedSubagents.length === 0) {
      reportSidebarAction('batch_delete_failed', {
        source: 'home_agent_sidebar',
        agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
        result: 'failed',
        selectedCount: items.length,
        selectedSessionCount,
        selectedSubagentCount,
        selectableCount: batchSelectableItems.length,
      });
      return;
    }
    reportSidebarAction('batch_delete_success', {
      source: 'home_agent_sidebar',
      agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
      result: 'success',
      selectedCount: items.length,
      selectedSessionCount,
      selectedSubagentCount,
      selectableCount: batchSelectableItems.length,
    });
    if (deletedSessions) {
      setDeletedSessionIds(sessionIds);
    }
    handleExitBatchMode();
  }, [
    batchAgentId,
    batchSelectableItemByKey,
    batchSelectableItems.length,
    batchSelectableKeySet,
    selectedKeys,
    handleExitBatchMode,
  ]);

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isCollapsed) return;
    event.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    resizeStartXRef.current = event.clientX;
    resizeStartWidthRef.current = sidebarWidth;
    document.body.classList.add('select-none');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const nextWidth = resizeStartWidthRef.current + moveEvent.clientX - resizeStartXRef.current;
      if (nextWidth < MIN_SIDEBAR_WIDTH) {
        isResizingRef.current = false;
        setIsResizing(false);
        document.body.classList.remove('select-none');
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        onToggleCollapse();
        return;
      }
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, nextWidth));
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      setIsResizing(false);
      document.body.classList.remove('select-none');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [isCollapsed, onToggleCollapse, sidebarWidth]);

  useEffect(() => {
    return () => {
      document.body.classList.remove('select-none');
    };
  }, []);

  useEffect(() => {
    const element = agentScrollContainerRef.current;
    if (!element) return;

    updateAgentScrollEdges(element);

    const resizeObserver = new ResizeObserver(() => updateAgentScrollEdges(element));
    resizeObserver.observe(element);
    if (element.firstElementChild) {
      resizeObserver.observe(element.firstElementChild);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateAgentScrollEdges]);

  return (
    <aside
      className={`relative shrink-0 overflow-hidden bg-surface-raised ${
        isResizing ? '' : 'sidebar-transition'
      }`}
      style={{ width: isCollapsed ? 0 : sidebarWidth }}
    >
      <div
        className={`flex h-full flex-col transition-opacity ease-out ${
          isCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
        style={{
          width: sidebarWidth,
          transitionDuration: `${SIDEBAR_COLLAPSE_TRANSITION_MS}ms`,
        }}
      >
      <div className="pt-3 pb-3">
        <div className="draggable sidebar-header-drag h-8 flex items-center justify-between px-3">
          <div className={`${isMac ? 'pl-[68px]' : ''}`}>{updateBadge}</div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
          >
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
          </button>
        </div>
        <div className="mt-[5px] space-y-0.5 px-3">
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('new_task', { activeView, isCollapsed });
              onNewChat();
            }}
            className={sidebarNavItemClassName}
          >
            <ComposeIcon className={sidebarCreateIconClassName} />
            {i18nService.t('newChat')}
          </button>
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_search', { activeView, isCollapsed });
              onShowCowork();
              setIsSearchOpen(true);
            }}
            className={sidebarNavItemClassName}
          >
            <SidebarSearchIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('search')}
          </button>
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_scheduled_tasks', { activeView, isCollapsed });
              setIsSearchOpen(false);
              onShowScheduledTasks();
            }}
            className={activeView === 'scheduledTasks' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'scheduledTasks' ? 'page' : undefined}
          >
            <SidebarAutomationIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('scheduledTasks')}
          </button>
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_kits', { activeView, isCollapsed });
              setIsSearchOpen(false);
              dismissKitsNewBadge();
              onShowKits();
            }}
            className={activeView === 'kits' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'kits' ? 'page' : undefined}
          >
            <SidebarKitsIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate">{i18nService.t('kits')}</span>
            {showKitsNewBadge && (
              <span className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-[#ff4f6d] px-1.5 text-[10px] font-semibold leading-none text-white">
                {i18nService.t('newFeatureBadge')}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_skills', { activeView, isCollapsed });
              setIsSearchOpen(false);
              onShowSkills();
            }}
            className={activeView === 'skills' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'skills' ? 'page' : undefined}
          >
            <SkillIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('skills')}
          </button>
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_mcp', { activeView, isCollapsed });
              setIsSearchOpen(false);
              onShowMcp();
            }}
            className={activeView === 'mcp' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'mcp' ? 'page' : undefined}
          >
            <SidebarMcpIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('mcpServers')}
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={agentScrollContainerRef}
          className={`scrollbar-hidden h-full overflow-y-auto px-2.5 ${
            isSidebarBannerVisible && !isBatchMode ? 'pb-[104px]' : 'pb-10'
          }`}
          onScroll={handleAgentScroll}
        >
          <MyAgentSidebarTree
            isBatchMode={isBatchMode}
            batchAgentId={batchAgentId}
            deletedSessionIds={deletedSessionIds}
            selectedKeys={selectedKeys}
            onShowCowork={onShowCowork}
            onTaskSelected={(params) => {
              console.debug('[Sidebar] reporting agent sidebar task selection analytics');
              void reportYdAnalyzer({
                action: LogReporterAction.SidebarAction,
                source: 'home_agent_sidebar',
                actionType: 'select_task',
                activeView,
                ...params,
              });
            }}
            onSidebarAction={(actionType, params) => {
              reportSidebarAction(actionType, {
                source: 'home_agent_sidebar',
                ...params,
              });
            }}
            onToggleSelection={handleToggleSelection}
            onEnterBatchMode={handleEnterBatchMode}
            onBatchSelectableItemsChange={handleBatchSelectableItemsChange}
          />
        </div>
        {!isBatchMode && (
          <SidebarAdBanner onVisibleChange={setIsSidebarBannerVisible} />
        )}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-surface-raised to-transparent transition-opacity duration-150 ${
            agentScrollEdges.top ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          className={`pointer-events-none absolute inset-x-0 top-[68px] z-10 h-3 bg-gradient-to-b from-surface-raised to-transparent transition-opacity duration-150 ${
            agentScrollEdges.top ? 'opacity-40' : 'opacity-0'
          }`}
        />
      </div>
      {!isCollapsed && (
        <div
          className="non-draggable absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
          onMouseDown={handleResizeStart}
        />
      )}
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
      />
      {isBatchMode ? (
        <div className="border-t border-border/60 px-3 pb-3 pt-2">
          <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-secondary">
              {i18nService
                .t('batchSelectionScope')
                .replace('{agent}', batchAgentName ?? '')
                .replace('{count}', String(selectedKeys.size))}
            </span>
            <button
              type="button"
              onClick={handleExitBatchMode}
              className="shrink-0 rounded-md px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              {i18nService.t('batchCancel')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[length:var(--lobster-text-sidebarCompact)] font-normal text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
              <input
                type="checkbox"
                checked={isBatchSelectAllChecked}
                onChange={handleSelectAll}
                disabled={batchSelectableItems.length === 0}
                className="h-3.5 w-3.5 shrink-0 rounded border-gray-300 accent-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600"
              />
              <span className="truncate">{i18nService.t('batchSelectAll')}</span>
            </label>
            <button
              type="button"
              onClick={handleBatchDeleteClick}
              disabled={selectedKeys.size === 0}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors ${
                selectedKeys.size > 0
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500'
              }`}
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {i18nService.t('batchDelete')} ({selectedKeys.size})
            </button>
          </div>
        </div>
      ) : (
        <div className="pb-2 pt-2">
          <div className="flex items-center gap-1 pl-3 pr-2 pt-1">
            {!hideLogin && (
              <div className="flex-1 min-w-0">
                <LoginButton />
              </div>
            )}
            <button
              type="button"
              onClick={() => onShowSettings()}
              className={`inline-flex h-7 items-center justify-start gap-1.5 rounded-md px-1.5 text-sm font-normal text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] ${hideLogin ? 'w-full' : 'shrink-0'}`}
              aria-label={i18nService.t('settings')}
            >
              <Cog6ToothIcon className="h-4 w-4 shrink-0" />
              {i18nService.t('settings')}
            </button>
          </div>
        </div>
      )}
      {/* Batch Delete Confirmation Modal */}
      {showBatchDeleteConfirm && (
        <Modal
          onClose={() => {
            reportSidebarAction('batch_delete_cancel', {
              source: 'home_agent_sidebar',
              agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
              ...getBatchSelectionSummary(),
            });
            setShowBatchDeleteConfirm(false);
          }}
          className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
              <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {i18nService.t('batchDeleteConfirmTitle')}
            </h2>
          </div>
          <div className="px-5 pb-4">
            <p className="text-sm text-secondary">
              {i18nService
                .t('batchDeleteConfirmMessage')
                .replace('{count}', String(selectedKeys.size))}
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
            <button
              onClick={() => {
                reportSidebarAction('batch_delete_cancel', {
                  source: 'home_agent_sidebar',
                  agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
                  ...getBatchSelectionSummary(),
                });
                setShowBatchDeleteConfirm(false);
              }}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              onClick={handleBatchDelete}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
            >
              {i18nService.t('batchDelete')} ({selectedKeys.size})
            </button>
          </div>
        </Modal>
      )}
      </div>
    </aside>
  );
};

export default Sidebar;
