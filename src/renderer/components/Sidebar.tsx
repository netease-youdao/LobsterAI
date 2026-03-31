import React, { useEffect, useState, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { agentService } from '../services/agent';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import LoginButton from './LoginButton';
import ComposeIcon from './icons/ComposeIcon';
import ConnectorIcon from './icons/ConnectorIcon';
import SearchIcon from './icons/SearchIcon';
import ClockIcon from './icons/ClockIcon';
import PuzzleIcon from './icons/PuzzleIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import TrashIcon from './icons/TrashIcon';
import { ExclamationTriangleIcon, UserGroupIcon } from '@heroicons/react/24/outline';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'mcp' | 'agents';
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowMcp: () => void;
  onShowAgents: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  updateBadge?: React.ReactNode;
}

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowMcp,
  onShowAgents,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  updateBadge,
}) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const filteredSessions = sessions.filter((s) => !s.agentId || s.agentId === currentAgentId);
  const [allAgentSessions, setAllAgentSessions] = useState<{ agentId?: string; status: string }[]>([]);

  // 直接查询全量 sessions 用于 badge 显示，不写入 Redux，不影响当前 agent 的会话列表
  useEffect(() => {
    window.electron?.cowork?.listSessions().then((result: { success?: boolean; sessions?: { agentId?: string; status: string }[] }) => {
      if (result?.success && Array.isArray(result.sessions)) {
        setAllAgentSessions(result.sessions);
      }
    });
  }, [sessions]); // sessions 变化（新增/完成/切换）时同步刷新
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
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

  const handleSelectSession = async (sessionId: string) => {
    onShowCowork();
    await coworkService.loadSession(sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await coworkService.deleteSession(sessionId);
  };

  const handleTogglePin = async (sessionId: string, pinned: boolean) => {
    await coworkService.setSessionPinned(sessionId, pinned);
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
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

  return (
    <aside
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col h-full min-h-0 sidebar-transition overflow-hidden ${
        isCollapsed ? 'w-0' : 'w-60'
      }`}
    >
      <div className="pt-3 pb-3">
        <div className="draggable sidebar-header-drag h-8 flex items-center justify-between px-3">
          <div className={`${isMac ? 'pl-[68px]' : ''}`}>
            {updateBadge}
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
          >
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
          </button>
        </div>
        <div className="mt-3 space-y-1 px-3">
          <button
            type="button"
            onClick={onNewChat}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'cowork'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <ComposeIcon className="h-4 w-4" />
            {i18nService.t('newChat')}
          </button>
          <button
            type="button"
            onClick={() => {
              onShowCowork();
              setIsSearchOpen(true);
            }}
            className="w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <SearchIcon className="h-4 w-4" />
            {i18nService.t('search')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowScheduledTasks();
            }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'scheduledTasks'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <ClockIcon className="h-4 w-4" />
            {i18nService.t('scheduledTasks')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowSkills();
            }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'skills'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <PuzzleIcon className="h-4 w-4" />
            {i18nService.t('skills')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowMcp();
            }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'mcp'
                ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <ConnectorIcon className="h-4 w-4" />
            {i18nService.t('mcpServers')}
          </button>
        </div>
      </div>
      <SidebarAgentList
        onShowCowork={onShowCowork}
        onShowAgents={() => { setIsSearchOpen(false); onShowAgents(); }}
        activeView={activeView}
        allSessions={allAgentSessions}
      />
      <div className="px-3 pb-1 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('coworkHistory')}
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <CoworkSessionList
          sessions={filteredSessions}
          currentSessionId={currentSessionId}
          isBatchMode={isBatchMode}
          selectedIds={selectedIds}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRenameSession}
          onToggleSelection={handleToggleSelection}
          onEnterBatchMode={handleEnterBatchMode}
        />
      </div>
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={filteredSessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onTogglePin={handleTogglePin}
        onRenameSession={handleRenameSession}
      />
      {isBatchMode ? (
        <div className="px-3 pb-3 pt-1 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <input
              type="checkbox"
              checked={selectedIds.size === filteredSessions.length && filteredSessions.length > 0}
              onChange={handleSelectAll}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-claude-accent cursor-pointer"
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
              className="px-3 py-1.5 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              {i18nService.t('batchCancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-3 pt-1 flex items-center gap-1">
          <LoginButton />
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => onShowSettings()}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={i18nService.t('settings')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M14 17H5" /><path d="M19 7h-9" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></svg>
            {i18nService.t('settings')}
          </button>
        </div>
      )}
      {/* Batch Delete Confirmation Modal */}
      {showBatchDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowBatchDeleteConfirm(false)}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('batchDeleteConfirmTitle')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('batchDeleteConfirmMessage').replace('{count}', String(selectedIds.size))}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={() => setShowBatchDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
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
          </div>
        </div>
      )}
    </aside>
  );
};

/* ── Simplified agent list for sidebar quick-switch ─── */

const SidebarAgentList: React.FC<{
  onShowCowork: () => void;
  onShowAgents: () => void;
  activeView: string;
  allSessions: { agentId?: string; status: string }[];
}> = ({ onShowCowork, onShowAgents, activeView, allSessions }) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const [isListCollapsed, setIsListCollapsed] = useState(false);

  useEffect(() => {
    agentService.loadAgents();
  }, []);

  const enabledAgents = agents.filter((a) => a.enabled);

  // Hide section if only the default main agent exists
  if (enabledAgents.length <= 1 && !enabledAgents.some((a) => a.source === 'preset')) {
    return null;
  }

  const handleSwitch = (agentId: string) => {
    if (agentId === currentAgentId) return;
    agentService.switchAgent(agentId);
    coworkService.loadSessions(agentId);
    onShowCowork();
  };

  const isActive = activeView === 'agents';

  return (
    <div className="px-3 pb-2">
      {/* 复用原导航按钮样式，右侧加收起 chevron */}
      <div
        className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors cursor-pointer ${
          isActive
            ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
        }`}
        onClick={onShowAgents}
      >
        <UserGroupIcon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{i18nService.t('myAgents')}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setIsListCollapsed((v) => !v); }}
          className="shrink-0 rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          aria-label={isListCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`h-3 w-3 transition-transform duration-200 ${isListCollapsed ? '-rotate-90' : ''}`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
      {!isListCollapsed && (
        <div className="mt-0.5 space-y-0.5">
          {enabledAgents.map((agent) => (
            <div
              key={agent.id}
              className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                currentAgentId === agent.id
                  ? 'bg-claude-accent/10 text-claude-accent'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
              onClick={() => handleSwitch(agent.id)}
            >
              <span className="text-base leading-none">{agent.icon || '🦞'}</span>
              <span className="truncate flex-1 text-xs font-medium">{agent.name}</span>
              {(() => {
                const agentSessions = allSessions.filter((s) => !s.agentId || s.agentId === agent.id);
                const total = agentSessions.length;
                const running = agentSessions.filter((s) => s.status === 'running').length;
                if (total === 0) return null;
                return (
                  <span className={`shrink-0 text-[10px] font-bold leading-none rounded-full px-1.5 py-0.5 text-center ${
                    running > 0
                      ? 'bg-claude-accent text-white'
                      : 'bg-black/10 dark:bg-white/15 text-claude-textSecondary dark:text-claude-darkTextSecondary'
                  }`}>
                    {running > 99 ? '99+' : running}/{total > 99 ? '99+' : total}
                  </span>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Sidebar;
