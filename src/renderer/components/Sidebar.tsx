import { ExclamationTriangleIcon, PuzzlePieceIcon } from '@heroicons/react/24/outline';
import { AgentId } from '@shared/agent';
import { ENABLE_EXPERT_PLAZA_UI } from '@shared/featureFlags';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { ShortcutAction } from '../config';
import { agentService } from '../services/agent';
import { coworkService } from '../services/cowork';
import {
  dispatchDshPluginsChanged,
  DSH_PLUGINS_CHANGED_EVENT,
  type DshEmbeddedPluginTarget,
  dshHostService,
  type DshPluginEntry,
  type DshPluginsChangedDetail,
} from '../services/dshHost';
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
import {
  SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME,
  SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME,
} from './agentSidebar/sidebarHeaderTooltip';
import SidebarTaskSearchButton from './agentSidebar/SidebarTaskSearchButton';
import { DEFAULT_SIDEBAR_TASK_FILTER, type SidebarTaskFilter } from './agentSidebar/taskFilter';
import { useShortcutHint } from './agentSidebar/useShortcutHint';
import Modal from './common/Modal';
import {
  type CoworkTaskSearchRequestEventDetail,
  CoworkTaskSearchRequestSource,
  CoworkUiEvent,
} from './cowork/constants';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import { getSidebarPluginPanels } from './dsh/pluginViewModel';
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
import Tooltip, { TooltipAlign, TooltipPosition } from './ui/Tooltip';
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
  activePluginPanelId?: string | null;
  onSelectPluginPanel?: (plugin: DshEmbeddedPluginTarget) => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  taskFilter: SidebarTaskFilter;
  onTaskFilterChange: (filter: SidebarTaskFilter) => void;
  onWidthChange?: (width: number) => void;
  updateNotice?: React.ReactNode;
  /** The expanded update card owns the sidebar bottom; temporarily hide the
   * promo banner while preserving it for a smooth return after collapse. */
  hideAdBanner?: boolean;
  hideLogin?: boolean;
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
const sidebarNavItemBaseClassName =
  'group w-full inline-flex h-[34px] items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[length:var(--lobster-text-sidebarCompact)] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35';
const sidebarNavItemClassName =
  `${sidebarNavItemBaseClassName} font-normal text-foreground/90 hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground`;
const activeSidebarNavItemClassName =
  `${sidebarNavItemBaseClassName} font-medium text-foreground bg-[var(--lobster-sidebar-item-hover)]`;
const sidebarNavIconClassName =
  'h-[17px] w-[17px] shrink-0 text-foreground/65 transition-colors group-hover:text-foreground';
const activeSidebarNavIconClassName = 'h-[17px] w-[17px] shrink-0 text-foreground';
const sidebarBottomIconButtonClassName =
  `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-secondary transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground ${SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME}`;

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
  activePluginPanelId,
  onSelectPluginPanel,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  taskFilter,
  onTaskFilterChange,
  onWidthChange,
  updateNotice,
  hideAdBanner,
  hideLogin,
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
  const [hasAgentBottomScrollEdge, setHasAgentBottomScrollEdge] = useState(false);
  const [isSidebarBannerVisible, setIsSidebarBannerVisible] = useState(false);
  const [showExpertsNewBadge, setShowExpertsNewBadge] = useState(false);
  const [showLoginPromoTip, setShowLoginPromoTip] = useState(true);
  const [installedDshPlugins, setInstalledDshPlugins] = useState<DshPluginEntry[]>([]);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const agentScrollContainerRef = useRef<HTMLDivElement>(null);
  const purchaseGuide = useSidebarPurchaseGuide();
  const canShowPurchaseGuide = !isCollapsed && !isBatchMode && !hideLogin;
  const paymentGuideVisible = canShowPurchaseGuide && purchaseGuide.candidate !== null;
  const paymentGuideOwnsSlot = canShowPurchaseGuide && (paymentGuideVisible || purchaseGuide.loading);
  const isWindows = window.electron.platform === 'win32';
  const isMac = window.electron.platform === 'darwin';
  const showHeaderRow = !isWindows;
  const isWindowFullscreen = useIsWindowFullscreen();
  const toggleSidebarShortcutHint = useShortcutHint(ShortcutAction.ToggleSidebar);
  const newChatShortcutHint = useShortcutHint(ShortcutAction.NewChat);
  const settingsShortcutHint = useShortcutHint(ShortcutAction.Settings);
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
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let externalRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const MAX_STARTUP_RETRIES = 3;

    const loadPlugins = async (broadcastToApp = false) => {
      try {
        const res = await dshHostService.listPlugins();
        if (!active) return;
        if (res?.ok) {
          const nextPlugins = res.plugins ?? [];
          setInstalledDshPlugins(nextPlugins);
          if (broadcastToApp) {
            dispatchDshPluginsChanged(nextPlugins);
          }
          if (!res.hmrAvailable && retryCount < MAX_STARTUP_RETRIES) {
            retryCount += 1;
            retryTimer = setTimeout(() => {
              void loadPlugins();
            }, 2500);
          }
        }
      } catch {
        // Non-fatal: sidebar continues normally if DSH plugin list is unavailable.
      }
    };

    const handlePluginsChanged = (event: Event) => {
      const detail = (event as CustomEvent<DshPluginsChangedDetail>).detail;
      if (detail?.plugins) {
        setInstalledDshPlugins(detail.plugins);
      } else {
        void loadPlugins();
      }
    };

    const unsubscribeHostPluginsChanged = dshHostService.onPluginsChanged(() => {
      if (externalRefreshTimer !== null) clearTimeout(externalRefreshTimer);
      externalRefreshTimer = setTimeout(() => {
        externalRefreshTimer = null;
        if (active) {
          void loadPlugins(true);
        }
      }, 300);
    });

    void loadPlugins();
    window.addEventListener(DSH_PLUGINS_CHANGED_EVENT, handlePluginsChanged);
    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (externalRefreshTimer !== null) clearTimeout(externalRefreshTimer);
      unsubscribeHostPluginsChanged();
      window.removeEventListener(DSH_PLUGINS_CHANGED_EVENT, handlePluginsChanged);
    };
  }, []);

  const sidebarLanguage: 'zh' | 'en' = i18nService.getLanguage() === 'en' ? 'en' : 'zh';
  const sidebarPluginPanels = useMemo(
    () => getSidebarPluginPanels(installedDshPlugins, sidebarLanguage, (key) => i18nService.t(key)),
    [installedDshPlugins, sidebarLanguage],
  );

  useEffect(() => {
    if (!showLoginPromo) {
      setShowLoginPromoTip(true);
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
  }, [showLoginPromo, showLoginPromoTip]);

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
      setHasAgentBottomScrollEdge(false);
      return;
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const hasBottomEdge = maxScrollTop - element.scrollTop > 1;
    setHasAgentBottomScrollEdge((previous) => (previous === hasBottomEdge ? previous : hasBottomEdge));
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

  const toggleSidebarLabel = isCollapsed ? i18nService.t('expand') : i18nService.t('collapse');

  return (
    <aside
      data-skin-sidebar="true"
      className={`relative shrink-0 overflow-hidden bg-[var(--lobster-sidebar-bg)] ${
        isCollapsed ? '' : 'border-r border-border'
      } ${isResizing ? '' : 'sidebar-transition'}`}
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
      <div className="pt-2.5 pb-2.5">
        {showHeaderRow && (
          <div
            // When left-aligned, 13px (not 12px) puts the toggle icon's drawn edge in line
            // with the nav icons below, whose artwork sits about 1.6px further in.
            className={`draggable sidebar-header-drag h-8 flex items-center ${
              alignHeaderStart ? 'justify-start gap-0.5 pl-[13px] pr-2.5' : 'justify-end gap-0.5 px-2.5'
            }`}
          >
            {!isWindows && (
              <>
                <Tooltip
                  className="non-draggable shrink-0"
                  align={alignHeaderStart ? TooltipAlign.Start : TooltipAlign.Center}
                  bubbleClassName={SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME}
                  content={(
                    <span className="inline-flex items-center gap-1.5">
                      <span>{toggleSidebarLabel}</span>
                      {toggleSidebarShortcutHint && (
                        <span className="text-white/55">{toggleSidebarShortcutHint}</span>
                      )}
                    </span>
                  )}
                >
                  <button
                    type="button"
                    onClick={onToggleCollapse}
                    className={`non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground transition-colors ${SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME}`}
                    aria-label={toggleSidebarLabel}
                  >
                    <SidebarToggleIcon className="h-[18px] w-[18px]" isCollapsed={isCollapsed} />
                  </button>
                </Tooltip>
                {!isCollapsed && (
                  <SidebarTaskSearchButton
                    onClick={() => {
                      reportSidebarAction('open_search', { activeView, isCollapsed });
                      openTaskSearch(CoworkTaskSearchRequestSource.SidebarHeader);
                    }}
                    className="non-draggable"
                    tooltipAlign={alignHeaderStart ? TooltipAlign.Center : TooltipAlign.End}
                    label={i18nService.t('search')}
                  />
                )}
              </>
            )}
          </div>
        )}
        {/* Keep the highlighted nav item clear of the icon row above it; Windows has no row here. */}
        <div className={`${showHeaderRow ? 'mt-2.5' : 'mt-[6px]'} space-y-0.5 px-2.5`}>
          <button
            type="button"
            data-onboarding-target="new-task"
            onClick={() => {
              reportSidebarAction('new_task', { activeView, isCollapsed });
              onNewChat();
            }}
            className={isNewTaskViewActive
              ? activeSidebarNavItemClassName
              : `${sidebarNavItemBaseClassName} font-medium text-foreground/90 hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground`}
            aria-current={isNewTaskViewActive ? 'page' : undefined}
          >
            <ComposeIcon className={isNewTaskViewActive ? activeSidebarNavIconClassName : sidebarNavIconClassName} />
            <span className="min-w-0 flex-1 truncate">{i18nService.t('newChat')}</span>
            {newChatShortcutHint && (
              <span
                aria-hidden="true"
                className="shrink-0 text-[11px] font-normal tracking-wide text-secondary/80 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              >
                {newChatShortcutHint}
              </span>
            )}
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
            <SidebarAutomationIcon
              className={activeView === MainView.ScheduledTasks ? activeSidebarNavIconClassName : sidebarNavIconClassName}
            />
            <span className="min-w-0 truncate">{i18nService.t('scheduledTasks')}</span>
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
              <SidebarExpertIcon
                className={activeView === MainView.Experts ? activeSidebarNavIconClassName : sidebarNavIconClassName}
              />
              <span className="min-w-0 truncate">{i18nService.t('expertPlaza')}</span>
              {showExpertsNewBadge && (
                <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-rose-500/12 px-1.5 text-[10px] font-semibold leading-none text-rose-600 dark:bg-rose-500/20 dark:text-rose-400">
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
            activeIconClassName={activeSidebarNavIconClassName}
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
            <SidebarLibraryIcon
              className={activeView === MainView.Library ? activeSidebarNavIconClassName : sidebarNavIconClassName}
            />
            <span className="min-w-0 truncate">{i18nService.t('librarySidebarTitle')}</span>
          </button>
          {sidebarPluginPanels.map((panel) => {
            const isPanelActive =
              activeView === MainView.PluginPanel && activePluginPanelId === panel.panelId;
            return (
              <button
                key={panel.panelId}
                type="button"
                title={panel.title}
                onClick={() => {
                  reportSidebarAction('open_plugin_panel', { activeView, isCollapsed });
                  setIsSearchOpen(false);
                  onSelectPluginPanel?.({
                    name: panel.name,
                    panelId: panel.panelId,
                    title: panel.title,
                    ...(panel.icon ? { icon: panel.icon } : {}),
                  });
                }}
                className={isPanelActive ? activeSidebarNavItemClassName : sidebarNavItemClassName}
                aria-current={isPanelActive ? 'page' : undefined}
              >
                {panel.icon ? (
                  <img
                    src={panel.icon}
                    alt=""
                    className="h-[17px] w-[17px] shrink-0 rounded object-contain"
                  />
                ) : (
                  <PuzzlePieceIcon
                    className={isPanelActive ? activeSidebarNavIconClassName : sidebarNavIconClassName}
                  />
                )}
                <span className="min-w-0 truncate">{panel.title}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="mx-3 shrink-0 border-t border-border" role="separator" />
      <div className="relative min-h-0 flex-1">
        <div
          ref={agentScrollContainerRef}
          className={`scrollbar-hidden h-full overflow-y-auto px-2.5 ${
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
            onTaskFilterChange={onTaskFilterChange}
            onClearTaskFilter={() => onTaskFilterChange(DEFAULT_SIDEBAR_TASK_FILTER)}
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
          <SidebarExperienceSlot
            hidden={hideAdBanner || paymentGuideOwnsSlot}
            onVisibleChange={setIsSidebarBannerVisible}
          />
        )}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-[25] h-10 bg-gradient-to-t from-[var(--lobster-sidebar-bg)] via-[var(--lobster-sidebar-bg)]/80 to-transparent transition-opacity duration-150 ${
            hasAgentBottomScrollEdge ? 'opacity-100' : 'opacity-0'
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
        <div className="non-draggable px-2.5 pb-1.5 pt-1">
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
        <div className="border-t border-border px-2.5 pb-2.5 pt-2">
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
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-secondary transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground"
            >
              {i18nService.t('batchCancel')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 text-[length:var(--lobster-text-sidebarCompact)] font-normal text-foreground transition-colors hover:bg-[var(--lobster-sidebar-item-hover)]">
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
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors ${
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
        <div className="border-t border-border px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            {!hideLogin && (
              <div className="min-w-0 shrink-0">
                <LoginButton
                  contentLeftOffset={isCollapsed ? 0 : sidebarWidth}
                  loggedOutVariant="sidebarPromo"
                  loginPromoTipVisible={shouldShowLoginPromoTip}
                />
              </div>
            )}
            <div className="ml-auto flex shrink-0 items-center justify-end">
              <Tooltip
                className="shrink-0"
                position={TooltipPosition.Top}
                align={TooltipAlign.End}
                bubbleClassName={SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME}
                content={(
                  <span className="inline-flex items-center gap-1.5">
                    <span>{i18nService.t('settings')}</span>
                    {settingsShortcutHint && (
                      <span className="text-white/55">{settingsShortcutHint}</span>
                    )}
                  </span>
                )}
              >
                <button
                  type="button"
                  onClick={() => onShowSettings()}
                  className={sidebarBottomIconButtonClassName}
                  aria-label={i18nService.t('settings')}
                >
                  <Cog6ToothIcon className="h-[17px] w-[17px] shrink-0" />
                </button>
              </Tooltip>
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
