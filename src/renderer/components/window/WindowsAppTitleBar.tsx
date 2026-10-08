import React, { useCallback, useEffect } from 'react';

import SidebarTaskFilterButton from '../agentSidebar/SidebarTaskFilterButton';
import SidebarTaskSearchButton from '../agentSidebar/SidebarTaskSearchButton';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import WindowTitleBar from './WindowTitleBar';

interface WindowsAppTitleBarProps {
  isOverlayActive?: boolean;
  isSidebarCollapsed?: boolean;
  sidebarWidth?: number;
  /** Paint the strip above the sidebar in the sidebar color so the gray
   * sidebar and the white canvas both run up to the window's top edge. */
  sidebarColumnVisible?: boolean;
  onToggleSidebar?: () => void;
  onSearch?: () => void;
  onNewChat?: () => void;
  sidebarToggleLabel?: string;
  searchLabel: string;
  showFilterIcon?: boolean;
  filterLabel?: string;
  isFilterActive?: boolean;
  hasFilterNotice?: boolean;
  onToggleFilter?: () => void;
  newChatLabel?: string;
  updateBadge?: React.ReactNode;
}

const WindowsAppTitleBar: React.FC<WindowsAppTitleBarProps> = ({
  isOverlayActive = false,
  isSidebarCollapsed = false,
  sidebarWidth = 244,
  sidebarColumnVisible = false,
  onToggleSidebar,
  onSearch,
  onNewChat,
  sidebarToggleLabel,
  searchLabel,
  showFilterIcon = false,
  filterLabel,
  isFilterActive = false,
  hasFilterNotice = false,
  onToggleFilter,
  newChatLabel,
  updateBadge,
}) => {
  useEffect(() => {
    if (window.electron.platform !== 'win32') return;

    const message = 'Windows app title bar mounted';
    console.debug(`[WindowsAppTitleBar] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'WindowsAppTitleBar', message);
    } catch {
      // Best-effort diagnostic only.
    }
  }, []);

  const handleNewChatClick = useCallback(() => {
    const message = `new chat requested from top bar isSidebarCollapsed=${isSidebarCollapsed}`;
    console.debug(`[WindowsAppTitleBar] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'WindowsAppTitleBar', message);
    } catch {
      // Best-effort diagnostic only.
    }
    onNewChat?.();
  }, [isSidebarCollapsed, onNewChat]);

  if (window.electron.platform !== 'win32') {
    return null;
  }

  return (
    <div
      data-skin-app-titlebar="true"
      className="draggable flex h-9 shrink-0 items-center justify-between bg-background pl-3"
      style={sidebarColumnVisible
        ? { backgroundImage: `linear-gradient(to right, var(--lobster-surface-raised) ${sidebarWidth}px, transparent ${sidebarWidth}px)` }
        : undefined}
    >
      <div
        className={`flex h-full shrink-0 items-center ${isSidebarCollapsed ? 'gap-1' : 'justify-between'}`}
        style={isSidebarCollapsed ? undefined : { width: Math.max(0, sidebarWidth - 24) }}
      >
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <img
            src="logo.png"
            alt=""
            draggable={false}
            className="h-4 w-4 max-w-none shrink-0"
          />
          <span className={`${isSidebarCollapsed ? 'hidden' : 'min-w-0 truncate'} text-sm font-medium text-foreground`}>
            LobsterAI
          </span>
        </div>
        {(onToggleSidebar || onSearch || showFilterIcon || onNewChat || updateBadge) && (
          <div className="non-draggable flex shrink-0 items-center gap-1">
            {onToggleSidebar && (
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-foreground/80 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                aria-label={sidebarToggleLabel}
                title={sidebarToggleLabel}
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={isSidebarCollapsed} />
              </button>
            )}
            {onSearch && (
              <SidebarTaskSearchButton
                onClick={onSearch}
                label={searchLabel}
              />
            )}
            {showFilterIcon && onToggleFilter && (
              <SidebarTaskFilterButton
                isActive={isFilterActive}
                hasUnreadCompletedTasks={hasFilterNotice}
                label={filterLabel ?? ''}
                onClick={onToggleFilter}
              />
            )}
            {onNewChat && (
              <button
                type="button"
                onClick={handleNewChatClick}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-foreground/80 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                aria-label={newChatLabel}
                title={newChatLabel}
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
            )}
            {updateBadge}
          </div>
        )}
      </div>
      <WindowTitleBar inline isOverlayActive={isOverlayActive} />
    </div>
  );
};

export default WindowsAppTitleBar;
