import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import { MagnifyingGlassIcon, PuzzlePieceIcon, ClockIcon, GlobeAltIcon } from '@heroicons/react/24/outline';
import ComposeIcon from './icons/ComposeIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'skills' | 'scheduledTasks';
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
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
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  updateBadge,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
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

  const handleOpenWebUi = async () => {
    try {
      const result = await window.electron.webUi.open();
      if (!result?.success) {
        const msg = result?.error || i18nService.t('openWebUiFailed');
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: msg }));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : i18nService.t('openWebUiFailed');
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: msg }));
    }
  };

  return (
    <aside
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col sidebar-transition overflow-hidden ${
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
            className="w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
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
            <MagnifyingGlassIcon className="h-4 w-4" />
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
                ? 'dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
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
                ? 'dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <PuzzlePieceIcon className="h-4 w-4" />
            {i18nService.t('skills')}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <div className="px-3 pb-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkHistory')}
        </div>
        <CoworkSessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRenameSession}
        />
      </div>
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onTogglePin={handleTogglePin}
        onRenameSession={handleRenameSession}
      />
      <div className="px-3 pb-3 pt-1">
        <button
          type="button"
          onClick={handleOpenWebUi}
          className="w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('openWebUi')}
        >
          <GlobeAltIcon className="h-4 w-4" />
          {i18nService.t('openWebUi')}
        </button>
        <button
          type="button"
          onClick={() => onShowSettings()}
          className="w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('settings')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M14 17H5" /><path d="M19 7h-9" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></svg>
          {i18nService.t('settings')}
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
