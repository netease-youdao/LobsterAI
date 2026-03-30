import React, { useState, useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import SearchIcon from '../icons/SearchIcon';
import ConnectorIcon from '../icons/ConnectorIcon';
import Cog6ToothIcon from '../icons/Cog6ToothIcon';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { setMcpServers } from '../../store/slices/mcpSlice';
import { updateSessionActiveMcpIds, setPendingActiveMcpIds } from '../../store/slices/coworkSlice';
import { RootState } from '../../store';

interface McpPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onManageMcp: () => void;
  anchorRef: React.RefObject<HTMLElement>;
  /** When provided, the popover operates in per-session mode */
  sessionId?: string;
}

const McpPopover: React.FC<McpPopoverProps> = ({
  isOpen,
  onClose,
  onManageMcp,
  anchorRef,
  sessionId,
}) => {
  const dispatch = useDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [maxListHeight, setMaxListHeight] = useState(256);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const servers = useSelector((state: RootState) => state.mcp.servers);
  const activeMcpIds = useSelector((state: RootState) =>
    sessionId
      ? state.cowork.currentSession?.activeMcpIds ?? null
      : state.cowork.pendingActiveMcpIds
  );

  const isServerActive = (serverId: string): boolean => {
    return activeMcpIds === null || activeMcpIds.includes(serverId);
  };

  const filteredServers = servers.filter(s =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    if (isOpen) {
      mcpService.loadServers().then(loaded => {
        dispatch(setMcpServers(loaded));
      });
      if (anchorRef.current) {
        const anchorRect = anchorRef.current.getBoundingClientRect();
        const availableHeight = anchorRect.top - 120 - 60;
        setMaxListHeight(Math.max(120, Math.min(256, availableHeight)));
      }
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen, anchorRef, dispatch]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsidePopover = popoverRef.current?.contains(target);
      const isInsideAnchor = anchorRef.current?.contains(target);

      if (!isInsidePopover && !isInsideAnchor) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleToggle = async (serverId: string) => {
    if (togglingIds.has(serverId)) return;

    const currentlyActive = isServerActive(serverId);
    let newIds: string[] | null;

    if (activeMcpIds === null) {
      newIds = servers.map(s => s.id).filter(id => id !== serverId);
    } else if (currentlyActive) {
      const updated = activeMcpIds.filter(id => id !== serverId);
      newIds = updated.length === 0 ? [] : updated;
    } else {
      const updated = [...activeMcpIds, serverId];
      newIds = updated.length === servers.length ? null : updated;
    }

    if (sessionId) {
      setTogglingIds(prev => new Set(prev).add(serverId));
      try {
        await window.electron.cowork.setSessionActiveMcpIds({ sessionId, mcpIds: newIds });
        dispatch(updateSessionActiveMcpIds({ sessionId, mcpIds: newIds }));
      } catch (_err) {
        console.error('[McpPopover] setSessionActiveMcpIds error:', _err);
      } finally {
        setTogglingIds(prev => {
          const next = new Set(prev);
          next.delete(serverId);
          return next;
        });
      }
    } else {
      dispatch(setPendingActiveMcpIds(newIds));
    }
  };

  const handleManageMcp = () => {
    onManageMcp();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl z-50"
    >
      {/* Search input */}
      <div className="p-3 border-b dark:border-claude-darkBorder border-claude-border">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={i18nService.t('searchMcpServers')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          />
        </div>
      </div>

      {/* Server list */}
      <div className="overflow-y-auto py-1" style={{ maxHeight: `${maxListHeight}px` }}>
        {filteredServers.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('noMcpServersAvailable')}
          </div>
        ) : (
          filteredServers.map((server) => {
            const active = isServerActive(server.id);
            return (
              <button
                key={server.id}
                onClick={() => handleToggle(server.id)}
                disabled={togglingIds.has(server.id)}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50"
              >
                <div className="mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
                  <ConnectorIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium truncate block dark:text-claude-darkText text-claude-text">
                    {server.name}
                  </span>
                  {server.description && (
                    <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate mt-0.5">
                      {server.description}
                    </p>
                  )}
                </div>
                <div className={`mt-1 w-8 h-[18px] rounded-full flex items-center flex-shrink-0 transition-colors ${
                  active ? 'bg-claude-accent justify-end' : 'dark:bg-claude-darkBorder bg-claude-border justify-start'
                }`}>
                  <div className="w-3.5 h-3.5 rounded-full bg-white mx-0.5 shadow-sm" />
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer - Manage MCP */}
      <div className="border-t dark:border-claude-darkBorder border-claude-border">
        <button
          onClick={handleManageMcp}
          className="w-full flex items-center justify-between px-4 py-3 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors rounded-b-xl"
        >
          <span>{i18nService.t('manageMcp')}</span>
          <Cog6ToothIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        </button>
      </div>
    </div>
  );
};

export default McpPopover;
