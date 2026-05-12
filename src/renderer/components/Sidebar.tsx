import { Cog6ToothIcon, CpuChipIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { AgentId } from '@shared/agent';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../services/agent';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import { RootState } from '../store';
import {
  selectCoworkSessions,
  selectCurrentSessionId,
} from '../store/selectors/coworkSelectors';
import type { CoworkSessionSummary } from '../types/cowork';
import MyAgentSidebarTree from './agentSidebar/MyAgentSidebarTree';
import Modal from './common/Modal';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import ClockIcon from './icons/ClockIcon';
import ComposeIcon from './icons/ComposeIcon';
import ConnectorIcon from './icons/ConnectorIcon';
import PuzzleIcon from './icons/PuzzleIcon';
import SearchIcon from './icons/SearchIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import TrashIcon from './icons/TrashIcon';
import LoginButton from './LoginButton';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'mcp' | 'localInference';
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowMcp: () => void;
  onShowLocalInference: () => void;
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
const sidebarNavItemClassName =
  'w-full inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-[14px] font-normal text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
const activeSidebarNavItemClassName =
  `${sidebarNavItemClassName} bg-black/[0.06] hover:bg-black/[0.06] dark:bg-white/[0.07] dark:hover:bg-white/[0.07]`;
const sidebarCreateIconClassName = 'h-4 w-4 shrink-0 text-secondary/40 dark:text-secondary/45';

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowMcp,
  onShowLocalInference,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  updateBadge,
  hideLogin,
}) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const sessions = useSelector(selectCoworkSessions);
  const filteredSessions = sessions.filter(s => !s.agentId || s.agentId === currentAgentId);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [agentScrollEdges, setAgentScrollEdges] = useState({ top: false, bottom: false });
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const agentScrollContainerRef = useRef<HTMLDivElement>(null);
  const isMac = window.electron.platform === 'darwin';

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
    setIsBatchMode(false);
    setSelectedIds(new Set());
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

  const handleEnterBatchMode = useCallback((sessionId: string) => {
    setIsBatchMode(true);
    setSelectedIds(new Set([sessionId]));
  }, []);

  const handleExitBatchMode = useCallback(() => {
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, []);

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

  const handleToggleSelection = useCallback((sessionId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === filteredSessions.length) {
        return new Set();
      }
      return new Set(filteredSessions.map(s => s.id));
    });
  }, [filteredSessions]);

  const handleBatchDeleteClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setShowBatchDeleteConfirm(true);
  }, [selectedIds.size]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    await coworkService.deleteSessions(ids);
    handleExitBatchMode();
  }, [selectedIds, handleExitBatchMode]);

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
            onClick={onNewChat}
            className={sidebarNavItemClassName}
          >
            <ComposeIcon className={sidebarCreateIconClassName} />
            {i18nService.t('newChat')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowLocalInference();
            }}
            className={activeView === 'localInference' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'localInference' ? 'page' : undefined}
          >
            <CpuChipIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('localInferenceTitle')}
          </button>
          <button
            type="button"
            onClick={() => {
              onShowCowork();
              setIsSearchOpen(true);
            }}
            className={sidebarNavItemClassName}
          >
            <SearchIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('search')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowScheduledTasks();
            }}
            className={activeView === 'scheduledTasks' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'scheduledTasks' ? 'page' : undefined}
          >
            <ClockIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('scheduledTasks')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowSkills();
            }}
            className={activeView === 'skills' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'skills' ? 'page' : undefined}
          >
            <PuzzleIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('skills')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowMcp();
            }}
            className={activeView === 'mcp' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'mcp' ? 'page' : undefined}
          >
            <ConnectorIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('mcpServers')}
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={agentScrollContainerRef}
          className="scrollbar-hidden h-full overflow-y-auto px-2.5 pb-10"
          onScroll={handleAgentScroll}
        >
          <MyAgentSidebarTree
            isBatchMode={isBatchMode}
            selectedIds={selectedIds}
            onShowCowork={onShowCowork}
            onToggleSelection={handleToggleSelection}
            onEnterBatchMode={handleEnterBatchMode}
          />
        </div>
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-surface-raised to-transparent transition-opacity duration-150 ${
            agentScrollEdges.top ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          className={`pointer-events-none absolute inset-x-0 top-[68px] z-10 h-10 bg-gradient-to-b from-surface-raised to-transparent transition-opacity duration-150 ${
            agentScrollEdges.top ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-16 bg-gradient-to-t from-surface-raised to-transparent transition-opacity duration-150 ${
            agentScrollEdges.bottom ? 'opacity-100' : 'opacity-0'
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
        <div className="px-3 pb-3 pt-1 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer text-sm text-secondary">
            <input
              type="checkbox"
              checked={selectedIds.size === filteredSessions.length && filteredSessions.length > 0}
              onChange={handleSelectAll}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-primary cursor-pointer"
            />
            {i18nService.t('batchSelectAll')}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBatchDeleteClick}
              disabled={selectedIds.size === 0}
              className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                selectedIds.size > 0
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
              }`}
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {selectedIds.size > 0 ? `${selectedIds.size}` : ''}
            </button>
            <button
              type="button"
              onClick={handleExitBatchMode}
              className="px-3 py-1.5 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('batchCancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1 px-3 pb-1 pt-1">
          <div className="flex items-center gap-1">
          {!hideLogin && (
            <div className="flex-1 min-w-0">
              <LoginButton />
            </div>
          )}
          <button
            type="button"
            onClick={() => onShowSettings()}
            className={`inline-flex h-7 items-center justify-start gap-2 rounded-md px-1.5 text-[14px] font-normal text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] ${hideLogin ? 'w-full' : 'shrink-0'}`}
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
          onClose={() => setShowBatchDeleteConfirm(false)}
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
                .replace('{count}', String(selectedIds.size))}
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
            <button
              onClick={() => setShowBatchDeleteConfirm(false)}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              onClick={handleBatchDelete}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
            >
              {i18nService.t('batchDelete')} ({selectedIds.size})
            </button>
          </div>
        </Modal>
      )}
      </div>
    </aside>
  );
};

export default Sidebar;
