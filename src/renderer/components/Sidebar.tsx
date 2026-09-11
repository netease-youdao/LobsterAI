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
  createSessionBatchKey,
} from './agentSidebar/batchSelection';
import MyAgentSidebarTree from './agentSidebar/MyAgentSidebarTree';
import SidebarTaskFilterButton, { SIDEBAR_TASK_FILTER_ENABLED } from './agentSidebar/SidebarTaskFilterButton';
import SidebarTaskSearchButton from './agentSidebar/SidebarTaskSearchButton';
import Modal from './common/Modal';
import {
  type CoworkTaskSearchRequestEventDetail,
  CoworkTaskSearchRequestSource,
  CoworkUiEvent,
} from './cowork/constants';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import Cog6ToothIcon from './icons/Cog6ToothIcon';
import ComposeIcon from './icons/ComposeIcon';
import RemoteControlIcon from './icons/RemoteControlIcon';
import SidebarAutomationIcon from './icons/SidebarAutomationIcon';
import SidebarKitsIcon from './icons/SidebarKitsIcon';
import SidebarLibraryIcon from './icons/SidebarLibraryIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import SkillIcon from './icons/SkillIcon';
import TrashIcon from './icons/TrashIcon';
import LoginButton from './LoginButton';
import { RemoteControlPopover } from './remote/RemoteControlPopover';
import type { SettingsOpenOptions } from './Settings';
import SidebarExperienceSlot from './SidebarExperienceSlot';

interface SidebarProps {
  onShowSettings: (options?: SettingsOpenOptions) => void;
  hideDeviceManagement?: boolean;
  onShowLogin: () => void;
  remoteControlOpen: boolean;
  onRemoteControlOpenChange: (open: boolean) => void;
  remoteControlBlocked?: boolean;
  onBatchModeChange?: (active: boolean) => void;
  activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'kits' | 'mcp' | 'library';
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowKits: () => void;
  onShowLibrary: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isTaskFilterActive: boolean;
  hasUnreadCompletedTasks: boolean;
  onToggleTaskFilter: () => void;
  onTaskFilterSummaryChange: (hasUnreadCompletedTasks: boolean) => void;
  onWidthChange?: (width: number) => void;
  updateNotice?: React.ReactNode;
  /** The expanded update card owns the sidebar bottom; temporarily hide the
   * promo banner while preserving it for a smooth return after collapse. */
  hideAdBanner?: boolean;
  hideLogin?: boolean;
  isEngineStartupOverlayVisible?: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 244;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_COLLAPSE_TRANSITION_MS = 200;
const SIDEBAR_LOGIN_PROMO_TIP_DURATION_MS = 5000;
const SIDEBAR_LOGIN_PROMO_TIP_FADE_MS = 220;

const SidebarPromoStar: React.FC<{ className?: string; idPrefix: string }> = ({
  className,
  idPrefix,
}) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <filter id={`${idPrefix}-soft-shadow`} x="-45%" y="-45%" width="190%" height="190%">
        <feDropShadow dx="0" dy="2.5" stdDeviation="2.2" floodColor="#ffb300" floodOpacity="0.42" />
      </filter>
      <radialGradient id={`${idPrefix}-glow`} cx="54%" cy="58%" r="52%">
        <stop offset="0%" stopColor="#fff070" stopOpacity="0.95" />
        <stop offset="100%" stopColor="#ffc400" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${idPrefix}-fill`} cx="31%" cy="25%" r="78%">
        <stop offset="0%" stopColor="#fffbd1" />
        <stop offset="26%" stopColor="#fff26b" />
        <stop offset="62%" stopColor="#ffd51c" />
        <stop offset="100%" stopColor="#ffae00" />
      </radialGradient>
      <radialGradient id={`${idPrefix}-shine`} cx="31%" cy="24%" r="42%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
        <stop offset="46%" stopColor="#fff8a8" stopOpacity="0.55" />
        <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${idPrefix}-lower-shade`} cx="72%" cy="78%" r="62%">
        <stop offset="0%" stopColor="#f19a00" stopOpacity="0.46" />
        <stop offset="58%" stopColor="#f7ae00" stopOpacity="0.18" />
        <stop offset="100%" stopColor="#ffd92e" stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`${idPrefix}-rim`} x1="5" y1="4" x2="18" y2="20">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.68" />
        <stop offset="44%" stopColor="#fff5a3" stopOpacity="0.2" />
        <stop offset="100%" stopColor="#ffb000" stopOpacity="0" />
      </linearGradient>
    </defs>
    <path
      d="M12 1.1c1.42 5.5 4.9 9.02 10.9 10.9-6 1.88-9.48 5.4-10.9 10.9C10.58 17.4 7.1 13.88 1.1 12 7.1 10.12 10.58 6.6 12 1.1Z"
      fill={`url(#${idPrefix}-glow)`}
      opacity="0.7"
      transform="scale(1.1 1.08) translate(-1.1 -0.95)"
    />
    <path
      d="M12 1.35c1.36 5.3 4.76 8.7 10.65 10.65C16.76 13.95 13.36 17.35 12 22.65 10.64 17.35 7.24 13.95 1.35 12 7.24 10.05 10.64 6.65 12 1.35Z"
      fill={`url(#${idPrefix}-fill)`}
      filter={`url(#${idPrefix}-soft-shadow)`}
    />
    <path
      d="M12 1.35c1.36 5.3 4.76 8.7 10.65 10.65C16.76 13.95 13.36 17.35 12 22.65 10.64 17.35 7.24 13.95 1.35 12 7.24 10.05 10.64 6.65 12 1.35Z"
      fill={`url(#${idPrefix}-lower-shade)`}
    />
    <path
      d="M10.6 4.55c.62 2.55 2.45 4.42 5.12 5.22-2.88.52-4.83 2.42-5.48 5.33-.52-2.72-2.25-4.48-4.92-5.16 2.65-.72 4.42-2.55 5.28-5.39Z"
      fill={`url(#${idPrefix}-shine)`}
    />
    <path
      d="M12 2.7c1.12 4.45 4.08 7.42 8.9 9.3-4.82 1.88-7.78 4.85-8.9 9.3-1.12-4.45-4.08-7.42-8.9-9.3 4.82-1.88 7.78-4.85 8.9-9.3Z"
      fill="none"
      stroke={`url(#${idPrefix}-rim)`}
      strokeWidth="0.65"
    />
  </svg>
);

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
const sidebarBottomIconButtonClassName =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';

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
  hideDeviceManagement = false,
  onShowLogin,
  remoteControlOpen,
  onRemoteControlOpenChange,
  remoteControlBlocked = false,
  onBatchModeChange,
  activeView,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowKits,
  onShowLibrary,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  isTaskFilterActive,
  hasUnreadCompletedTasks,
  onToggleTaskFilter,
  onTaskFilterSummaryChange,
  onWidthChange,
  updateNotice,
  hideAdBanner,
  hideLogin,
  isEngineStartupOverlayVisible = false,
}) => {
  const remoteControlButton = useRef<HTMLButtonElement>(null);
  const closeRemoteControl = useCallback(() => onRemoteControlOpenChange(false), [onRemoteControlOpenChange]);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const isAuthLoading = useSelector((state: RootState) => state.auth.isLoading);
  const sessions = useSelector(selectCoworkSessions);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  useEffect(() => { onBatchModeChange?.(isBatchMode); }, [isBatchMode, onBatchModeChange]);
  const canShowRemoteControl = !isCollapsed && !isBatchMode && !remoteControlBlocked;
  useEffect(() => {
    if (!canShowRemoteControl && remoteControlOpen) closeRemoteControl();
  }, [canShowRemoteControl, remoteControlOpen, closeRemoteControl]);

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
  const [showLoginPromoTip, setShowLoginPromoTip] = useState(true);
  const [isLoginPromoTipFading, setIsLoginPromoTipFading] = useState(false);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const agentScrollContainerRef = useRef<HTMLDivElement>(null);
  const isWindows = window.electron.platform === 'win32';
  const showHeaderRow = !isWindows;
  const showLoginPromo = !hideLogin && !isAuthLoading && !isLoggedIn;
  const shouldShowLoginPromoTip = showLoginPromo && showLoginPromoTip;
  const shouldReserveLoginPromoTipSpace = shouldShowLoginPromoTip;
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

  useEffect(() => {
    if (!showLoginPromo) {
      setShowLoginPromoTip(true);
      setIsLoginPromoTipFading(false);
      return undefined;
    }

    if (isEngineStartupOverlayVisible) {
      if (showLoginPromoTip) {
        const message = 'pausing login promo tip auto-hide while engine startup overlay is visible';
        console.debug(`[Sidebar] ${message}`);
        writeSidebarRendererLog('debug', message);
        setIsLoginPromoTipFading(false);
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
      setIsLoginPromoTipFading(true);
    }, SIDEBAR_LOGIN_PROMO_TIP_DURATION_MS);

    const removeTimer = window.setTimeout(() => {
      setShowLoginPromoTip(false);
      setIsLoginPromoTipFading(false);
    }, SIDEBAR_LOGIN_PROMO_TIP_DURATION_MS + SIDEBAR_LOGIN_PROMO_TIP_FADE_MS);

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
    };
  }, [isEngineStartupOverlayVisible, showLoginPromo, showLoginPromoTip]);

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
          <div className="draggable sidebar-header-drag h-8 flex items-center justify-end px-3">
            {!isWindows && (
              <>
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                  aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
                >
                  <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
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
                    {SIDEBAR_TASK_FILTER_ENABLED && activeView === 'cowork' && (
                      <SidebarTaskFilterButton
                        isActive={isTaskFilterActive}
                        hasUnreadCompletedTasks={hasUnreadCompletedTasks}
                        label={i18nService.t('sidebarFilter')}
                        onClick={onToggleTaskFilter}
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
            className={sidebarNavItemClassName}
          >
            <ComposeIcon className={sidebarCreateIconClassName} />
            {i18nService.t('newChat')}
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
            className={activeView === 'skills' || activeView === 'mcp' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'skills' || activeView === 'mcp' ? 'page' : undefined}
          >
            <SkillIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate">{i18nService.t('skillsAndConnectors')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              reportSidebarAction('open_library', { activeView, isCollapsed });
              setIsSearchOpen(false);
              onShowLibrary();
            }}
            className={activeView === 'library' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'library' ? 'page' : undefined}
          >
            <SidebarLibraryIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate">{i18nService.t('librarySidebarTitle')}</span>
          </button>
        </div>
      </div>
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
            isTaskFilterActive={isTaskFilterActive}
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
            hidden={hideAdBanner}
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
      {!isBatchMode && updateNotice && (
        <div className="non-draggable px-3 pt-1.5">{updateNotice}</div>
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
        <div
          className={`pb-2.5 transition-[padding-top] duration-200 ease-out ${
            shouldReserveLoginPromoTipSpace ? 'pt-3.5' : 'pt-2'
          }`}
        >
          <div className="flex items-end pl-3 pr-2 pt-1">
            {!hideLogin && (
              <div
                className={`relative shrink-0 transition-[padding-top] duration-200 ease-out ${
                  shouldReserveLoginPromoTipSpace ? 'pt-9' : ''
                }`}
              >
                {shouldShowLoginPromoTip && (
                  <div
                    className={`pointer-events-none absolute left-0 top-0 z-10 inline-flex h-7 w-max max-w-[10.5rem] items-center rounded-lg rounded-bl-[3px] bg-gradient-to-r from-[#ff3f67] to-[#f6538d] pl-3 pr-8 text-[13px] font-semibold leading-none text-white shadow-[0_5px_14px_rgba(255,63,103,0.24)] transition-all duration-[220ms] ease-out ${
                      isLoginPromoTipFading ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100'
                    }`}
                    aria-hidden="true"
                  >
                    <span className="min-w-0 whitespace-nowrap">
                      {i18nService.t('sidebarLoginFreeToken')}
                    </span>
                    <SidebarPromoStar
                      idPrefix="sidebar-login-promo-star-small"
                      className="absolute right-[8px] top-[2px] h-4 w-4 drop-shadow-[0_2px_5px_rgba(255,193,7,0.58)]"
                    />
                    <SidebarPromoStar
                      idPrefix="sidebar-login-promo-star-large"
                      className="absolute -bottom-[5px] -right-[7px] h-6 w-6 drop-shadow-[0_5px_10px_rgba(255,178,0,0.52)]"
                    />
                    <span className="absolute -bottom-1 left-8 h-2.5 w-3 rotate-45 rounded-[2px] bg-[#ff3f67]" />
                  </div>
                )}
                <LoginButton
                  onActivate={closeRemoteControl}
                  onOpenDeviceManagement={hideDeviceManagement ? undefined : () => { closeRemoteControl(); onShowSettings({ initialTab: 'remoteDevices' }); }}
                  dismissMenu={remoteControlOpen}
                  contentLeftOffset={isCollapsed ? 0 : sidebarWidth}
                  loggedOutVariant="sidebarPromo"
                />
              </div>
            )}
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
              <button
                type="button"
                ref={remoteControlButton}
                onClick={() => onRemoteControlOpenChange(!remoteControlOpen)}
                className={`${sidebarBottomIconButtonClassName} !h-8 !w-8 ${remoteControlOpen ? 'bg-primary-muted text-primary' : ''}`}
                title={i18nService.t('remoteTitle')}
                aria-label={i18nService.t('remoteTitle')}
                aria-haspopup="dialog"
                aria-expanded={remoteControlOpen && canShowRemoteControl}
              >
                <RemoteControlIcon className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                onClick={() => { closeRemoteControl(); onShowSettings(); }}
                className={sidebarBottomIconButtonClassName}
                aria-label={i18nService.t('settings')}
              >
                <Cog6ToothIcon className="h-4 w-4 shrink-0" />
              </button>
            </div>
          </div>
        </div>
      )}
      {remoteControlOpen && canShowRemoteControl && (
        <RemoteControlPopover anchorRef={remoteControlButton} onClose={closeRemoteControl}
          onLogin={onShowLogin} loginAllowed={!hideLogin} />
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
