import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { AgentId } from '@shared/agent';
import { ENABLE_EXPERT_PLAZA_UI } from '@shared/featureFlags';
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
import { MainView } from '../types/navigation';
import { getAgentDisplayNameById } from '../utils/agentDisplay';
import { getAccountConnectionState } from './accountConnectionState';
import {
  type AgentSidebarBatchItem,
  AgentSidebarBatchItemKind,
  createSessionBatchKey,
} from './agentSidebar/batchSelection';
import MyAgentSidebarTree from './agentSidebar/MyAgentSidebarTree';
import SidebarTaskFilterButton, { SIDEBAR_TASK_FILTER_ENABLED } from './agentSidebar/SidebarTaskFilterButton';
import SidebarTaskSearchButton from './agentSidebar/SidebarTaskSearchButton';
import { DEFAULT_SIDEBAR_TASK_FILTER, type SidebarTaskFilter } from './agentSidebar/taskFilter';
import Modal from './common/Modal';
import {
  type CoworkTaskSearchRequestEventDetail,
  CoworkTaskSearchRequestSource,
  CoworkUiEvent,
} from './cowork/constants';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import Cog6ToothIcon from './icons/Cog6ToothIcon';
import ComposeIcon from './icons/ComposeIcon';
import SidebarAutomationIcon from './icons/SidebarAutomationIcon';
import SidebarExpertIcon from './icons/SidebarExpertIcon';
import SidebarLibraryIcon from './icons/SidebarLibraryIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import TrashIcon from './icons/TrashIcon';
import LoginButton from './LoginButton';
import LowCreditPurchaseOfferCard from './LowCreditPurchaseOfferCard';
import SidebarCapabilitiesMenu from './SidebarCapabilitiesMenu';
import SidebarExperienceSlot from './SidebarExperienceSlot';
import { useSidebarPurchaseGuide } from './useSidebarPurchaseGuide';
import { useIsWindowFullscreen } from './window/useIsWindowFullscreen';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: MainView;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowKits: () => void;
  onShowSkills: () => void;
  onShowConnectors: () => void;
  onShowExperts: () => void;
  onShowLibrary: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  taskFilter: SidebarTaskFilter;
  hasUnreadCompletedTasks: boolean;
  onTaskFilterChange: (filter: SidebarTaskFilter) => void;
  onTaskFilterSummaryChange: (hasUnreadCompletedTasks: boolean) => void;
  onWidthChange?: (width: number) => void;
  updateNotice?: React.ReactNode;
  /** The expanded update card owns the sidebar bottom; temporarily hide the
   * promo banner while preserving it for a smooth return after collapse. */
  hideAdBanner?: boolean;
  hideLogin?: boolean;
  isEngineStartupOverlayVisible?: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_COLLAPSE_TRANSITION_MS = 200;
const SIDEBAR_LOGIN_PROMO_TIP_DURATION_MS = 5000;

const normalizeAgentId = (agentId?: string | null) => agentId?.trim() || AgentId.Main;
const SidebarNewFeatureBadge = {
  ExpertsDismissedVersionKey: 'sidebar.expertsNewFeatureBadge.dismissedVersion',
  // Bump this value in a release when the experts entry should show the badge again.
  ExpertsVersion: '2026-10-12',
} as const;
const sidebarNavItemClassName =
  'w-full inline-flex h-9 items-center gap-2.5 rounded-full px-2 text-left text-[length:var(--lobster-text-sidebarCompact)] font-normal text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
const activeSidebarNavItemClassName =
  `${sidebarNavItemClassName} bg-[color-mix(in_srgb,var(--lobster-surface-raised)_95%,black)] hover:bg-[color-mix(in_srgb,var(--lobster-surface-raised)_95%,black)] dark:bg-[color-mix(in_srgb,var(--lobster-surface-raised)_93%,white)] dark:hover:bg-[color-mix(in_srgb,var(--lobster-surface-raised)_93%,white)]`;
const sidebarNavIconClassName = 'h-[18px] w-[18px] shrink-0 text-foreground/75';
const sidebarBottomIconButtonClassName =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';

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

const writeSidebarRendererLog = (
  level: 'debug' | 'warn',
  message: string,
  error?: unknown,
): void => {
  try {
    window.electron?.log?.fromRenderer?.(level, 'Sidebar', message);
  } catch (logError) {
    const logErrorMessage = logError instanceof Error ? logError.message : String(logError);
    console.debug(`[Sidebar] renderer log unavailable: ${logErrorMessage}`, error);
  }
};

const logTaskSearchRequest = (
  source: CoworkTaskSearchRequestSource,
  activeView: SidebarProps['activeView'],
): void => {
  try {
    const message = `task search requested source=${source} activeView=${activeView} platform=${window.electron?.platform ?? 'unknown'}`;
    console.debug(`[Sidebar] ${message}`);
    writeSidebarRendererLog('debug', message);
  } catch (error) {
    // Task search must remain available when renderer diagnostic logging fails.
    console.debug('[Sidebar] task search diagnostic logging unavailable:', error);
  }
};

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowCowork,
  onShowScheduledTasks,
  onShowKits,
  onShowSkills,
  onShowConnectors,
  onShowExperts,
  onShowLibrary,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  taskFilter,
  hasUnreadCompletedTasks,
  onTaskFilterChange,
  onTaskFilterSummaryChange,
  onWidthChange,
  updateNotice,
  hideAdBanner,
  hideLogin,
  isEngineStartupOverlayVisible = false,
}) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const isAuthLoading = useSelector((state: RootState) => state.auth.isLoading);
  const accountConnectionState = useSelector((state: RootState) => getAccountConnectionState(state.auth));
  const sessions = useSelector(selectCoworkSessions);
  const currentSessionId = useSelector(selectCurrentSessionId);
  // The home page is the "new task" view, so its nav item reads as selected there.
  const isNewTaskViewActive = activeView === MainView.Cowork && !currentSessionId;
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
  const [showExpertsNewBadge, setShowExpertsNewBadge] = useState(false);
  const [showLoginPromoTip, setShowLoginPromoTip] = useState(true);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const agentScrollContainerRef = useRef<HTMLDivElement>(null);
  const purchaseGuide = useSidebarPurchaseGuide();
  const canShowPurchaseGuide = !isCollapsed && !isBatchMode && !hideLogin && !isEngineStartupOverlayVisible;
  const paymentGuideVisible = canShowPurchaseGuide && purchaseGuide.candidate !== null;
  const paymentGuideOwnsSlot = canShowPurchaseGuide && (paymentGuideVisible || purchaseGuide.loading);
  const isWindows = window.electron.platform === 'win32';
  const isMac = window.electron.platform === 'darwin';
  const showHeaderRow = !isWindows;
  const isWindowFullscreen = useIsWindowFullscreen();
  // macOS hides the traffic lights in full screen; take their slot instead of leaving a gap.
  const alignHeaderStart = isMac && isWindowFullscreen;
  const showLoginPromo = !hideLogin && !isAuthLoading && !isLoggedIn && !accountConnectionState;
  const shouldShowLoginPromoTip = showLoginPromo && showLoginPromoTip;
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
    return {
      selectedCount: selectedItems.length,
      selectedSessionCount,
      selectedSubagentCount: 0,
      selectableCount: batchSelectableItems.length,
    };
  }, [batchSelectableItemByKey, batchSelectableItems.length, batchSelectableKeySet, selectedKeys]);

  useEffect(() => {
    let isCurrent = true;

    const loadExpertsNewBadgeState = async () => {
      try {
        const dismissedVersion = await window.electron.store.get(
          SidebarNewFeatureBadge.ExpertsDismissedVersionKey,
        );
        if (!isCurrent) return;
        setShowExpertsNewBadge(dismissedVersion !== SidebarNewFeatureBadge.ExpertsVersion);
      } catch (error) {
        console.warn('[Sidebar] failed to load experts new feature badge state:', error);
      }
    };

    void loadExpertsNewBadgeState();

    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (!showLoginPromo) {
      setShowLoginPromoTip(true);
      return undefined;
    }

    if (isEngineStartupOverlayVisible) {
      if (showLoginPromoTip) {
        const message = 'pausing login promo tip auto-hide while engine startup overlay is visible';
        console.debug(`[Sidebar] ${message}`);
        writeSidebarRendererLog('debug', message);
      }
      return undefined;
    }

    if (!showLoginPromoTip) {
      return undefined;
    }

    const startMessage = 'starting login promo tip auto-hide timer';
    console.debug(`[Sidebar] ${startMessage}`);
    writeSidebarRendererLog('debug', startMessage);

    const hideTimer = window.setTimeout(() => {
      const message = 'auto hiding login promo tip';
      console.debug(`[Sidebar] ${message}`);
      writeSidebarRendererLog('debug', message);
      setShowLoginPromoTip(false);
    }, SIDEBAR_LOGIN_PROMO_TIP_DURATION_MS);

    return () => {
      window.clearTimeout(hideTimer);
    };
  }, [isEngineStartupOverlayVisible, showLoginPromo, showLoginPromoTip]);

  const dismissExpertsNewBadge = useCallback(() => {
    if (!showExpertsNewBadge) return;
    setShowExpertsNewBadge(false);
    void window.electron.store
      .set(
        SidebarNewFeatureBadge.ExpertsDismissedVersionKey,
        SidebarNewFeatureBadge.ExpertsVersion,
      )
      .catch((error) => {
        console.warn('[Sidebar] failed to save experts new feature badge state:', error);
      });
  }, [showExpertsNewBadge]);

  const openTaskSearch = useCallback((source: CoworkTaskSearchRequestSource) => {
    logTaskSearchRequest(source, activeView);
    onShowCowork();
    setIsSearchOpen(true);
  }, [activeView, onShowCowork]);

  useEffect(() => {
    const handleSearch = (event: Event) => {
      const detail = (event as CustomEvent<CoworkTaskSearchRequestEventDetail>).detail;
      openTaskSearch(detail?.source ?? CoworkTaskSearchRequestSource.UiEvent);
    };
    window.addEventListener(CoworkUiEvent.ShortcutSearch, handleSearch);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutSearch, handleSearch);
    };
  }, [openTaskSearch]);

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
    try {
      if (agentId !== currentAgentId) {
        agentService.switchAgent(agentId, { targetSessionId: session.id });
        await coworkService.loadSessions(agentId);
      }
      onShowCowork();
      await coworkService.loadSession(session.id);
    } finally {
      coworkService.finishSessionNavigation(session.id);
    }
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

    const sessionIds = items
      .filter((item) => item.kind === AgentSidebarBatchItemKind.Session)
      .map((item) => item.sessionId);
    const selectedSessionCount = sessionIds.length;

    reportSidebarAction('batch_delete_submit', {
      source: 'home_agent_sidebar',
      agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
      selectedCount: items.length,
      selectedSessionCount,
      selectedSubagentCount: 0,
      selectableCount: batchSelectableItems.length,
    });

    let deletedSessions = false;
    if (sessionIds.length > 0) {
      deletedSessions = await coworkService.deleteSessions(sessionIds);
    }

    if (!deletedSessions) {
      reportSidebarAction('batch_delete_failed', {
        source: 'home_agent_sidebar',
        agentType: batchAgentId === AgentId.Main ? 'main' : 'custom',
        result: 'failed',
        selectedCount: items.length,
        selectedSessionCount,
        selectedSubagentCount: 0,
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
      selectedSubagentCount: 0,
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
      const clampedWidth = Math.min(MAX_SIDEBAR_WIDTH, nextWidth);
      setSidebarWidth(clampedWidth);
      onWidthChange?.(clampedWidth);
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
  }, [isCollapsed, onToggleCollapse, onWidthChange, sidebarWidth]);

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
      data-skin-sidebar="true"
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
        {showHeaderRow && (
          <div
            className={`draggable sidebar-header-drag h-8 flex items-center px-3 ${
              alignHeaderStart ? 'justify-start gap-0.5' : 'justify-end'
            }`}
          >
            {!isWindows && (
              <>
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-foreground/80 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
                  aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
                >
                  <SidebarToggleIcon className="h-[18px] w-[18px]" isCollapsed={isCollapsed} />
                </button>
                {!isCollapsed && (
                  <>
                    <SidebarTaskSearchButton
                      onClick={() => {
                        reportSidebarAction('open_search', { activeView, isCollapsed });
                        openTaskSearch(CoworkTaskSearchRequestSource.SidebarHeader);
                      }}
                      className="non-draggable"
                      label={i18nService.t('search')}
                    />
                    {SIDEBAR_TASK_FILTER_ENABLED && activeView === MainView.Cowork && (
                      <SidebarTaskFilterButton
                        filter={taskFilter}
                        onChange={onTaskFilterChange}
                        hasUnreadCompletedTasks={hasUnreadCompletedTasks}
                        label={i18nService.t('sidebarFilter')}
                        className="non-draggable"
                      />
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
        <div className="mt-[5px] space-y-0.5 px-3">
          <button
            type="button"
            data-onboarding-target="new-task"
            onClick={() => {
              reportSidebarAction('new_task', { activeView, isCollapsed });
              onNewChat();
            }}
            className={isNewTaskViewActive ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={isNewTaskViewActive ? 'page' : undefined}
          >
            <ComposeIcon className={sidebarNavIconClassName} />
            {i18nService.t('newChat')}
          </button>
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_scheduled_tasks', { activeView, isCollapsed });
              setIsSearchOpen(false);
              onShowScheduledTasks();
            }}
            className={activeView === MainView.ScheduledTasks ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === MainView.ScheduledTasks ? 'page' : undefined}
          >
            <SidebarAutomationIcon className={sidebarNavIconClassName} />
            {i18nService.t('scheduledTasks')}
          </button>
          {ENABLE_EXPERT_PLAZA_UI && (
            <button
              type="button"
              onClick={() => {
                reportSidebarAction('open_experts', { activeView, isCollapsed });
                setIsSearchOpen(false);
                dismissExpertsNewBadge();
                onShowExperts();
              }}
              className={activeView === MainView.Experts ? activeSidebarNavItemClassName : sidebarNavItemClassName}
              aria-current={activeView === MainView.Experts ? 'page' : undefined}
            >
              <SidebarExpertIcon className={sidebarNavIconClassName} />
              <span className="min-w-0 truncate">{i18nService.t('expertPlaza')}</span>
              {showExpertsNewBadge && (
                <span className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-[#ff4f6d] px-1.5 text-[10px] font-semibold leading-none text-white">
                  {i18nService.t('newFeatureBadge')}
                </span>
              )}
            </button>
          )}
          <SidebarCapabilitiesMenu
            activeView={activeView}
            isCollapsed={isCollapsed}
            className={sidebarNavItemClassName}
            activeClassName={activeSidebarNavItemClassName}
            iconClassName={sidebarNavIconClassName}
            onSelect={(view) => {
              const destinations = {
                [MainView.Kits]: { action: 'open_kits', navigate: onShowKits },
                [MainView.Skills]: { action: 'open_skills', navigate: onShowSkills },
                [MainView.Connectors]: { action: 'open_mcp', navigate: onShowConnectors },
              };
              const destination = destinations[view];
              reportSidebarAction(destination.action, { activeView, isCollapsed });
              setIsSearchOpen(false);
              destination.navigate();
            }}
          />
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_library', { activeView, isCollapsed });
              setIsSearchOpen(false);
              onShowLibrary();
            }}
            className={activeView === MainView.Library ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === MainView.Library ? 'page' : undefined}
          >
            <SidebarLibraryIcon className={sidebarNavIconClassName} />
            <span className="min-w-0 truncate">{i18nService.t('librarySidebarTitle')}</span>
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={agentScrollContainerRef}
          className={`scrollbar-hidden h-full overflow-y-auto px-[18px] ${
            isSidebarBannerVisible && !isBatchMode ? 'pb-[128px]' : 'pb-10'
          }`}
          onScroll={handleAgentScroll}
        >
          <MyAgentSidebarTree
            isBatchMode={isBatchMode}
            batchAgentId={batchAgentId}
            deletedSessionIds={deletedSessionIds}
            selectedKeys={selectedKeys}
            taskFilter={taskFilter}
            onClearTaskFilter={() => onTaskFilterChange(DEFAULT_SIDEBAR_TASK_FILTER)}
            onShowCowork={onShowCowork}
            onTaskFilterSummaryChange={onTaskFilterSummaryChange}
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
          <SidebarExperienceSlot
            hidden={hideAdBanner || paymentGuideOwnsSlot}
            onVisibleChange={setIsSidebarBannerVisible}
          />
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
      {!isBatchMode && (updateNotice || paymentGuideVisible) && (
        <div className="non-draggable px-3 pt-1.5">
          <div hidden={paymentGuideOwnsSlot}>{updateNotice}</div>
          {paymentGuideVisible && purchaseGuide.candidate && (
            <LowCreditPurchaseOfferCard
              offer={purchaseGuide.candidate.offer}
              variant={purchaseGuide.candidate.variant}
              onClose={purchaseGuide.dismiss}
            />
          )}
        </div>
      )}
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
        <div className="pb-2.5 pt-2">
          <div className="flex items-end pl-3 pr-2 pt-1">
            {!hideLogin && (
              <div className="shrink-0">
                <LoginButton
                  contentLeftOffset={isCollapsed ? 0 : sidebarWidth}
                  loggedOutVariant="sidebarPromo"
                  loginPromoTipVisible={shouldShowLoginPromoTip}
                />
              </div>
            )}
            <div className="ml-auto flex shrink-0 items-center justify-end">
              <button
                type="button"
                onClick={() => onShowSettings()}
                className={sidebarBottomIconButtonClassName}
                aria-label={i18nService.t('settings')}
              >
                <Cog6ToothIcon className="h-[18px] w-[18px] shrink-0" />
              </button>
            </div>
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
