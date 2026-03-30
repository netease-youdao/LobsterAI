import React, { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { CheckIcon, MagnifyingGlassIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';

interface AgentMcpSelectorProps {
  selectedMcpIds: string[];
  onChange: (ids: string[]) => void;
  variant?: 'compact' | 'expanded';
}

const AgentMcpSelector: React.FC<AgentMcpSelectorProps> = ({ selectedMcpIds, onChange, variant = 'compact' }) => {
  const servers = useSelector((state: RootState) => state.mcp.servers);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');

  const enabledServers = useMemo(
    () => servers.filter((s) => s.enabled),
    [servers],
  );

  const filteredServers = useMemo(() => {
    if (!search.trim()) return enabledServers;
    const q = search.toLowerCase();
    return enabledServers.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [enabledServers, search]);

  const toggle = (serverId: string) => {
    if (selectedMcpIds.includes(serverId)) {
      onChange(selectedMcpIds.filter((id) => id !== serverId));
    } else {
      onChange([...selectedMcpIds, serverId]);
    }
  };

  const selectedCount = selectedMcpIds.length;
  const isExpanded = variant === 'expanded';
  const showList = isExpanded || expanded;

  const serverList = (
    <>
      {enabledServers.length > 5 && (
        <div className={isExpanded ? 'mb-2' : 'px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border'}>
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={i18nService.t('agentMcpSearch') || 'Search MCP servers...'}
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text"
            />
          </div>
        </div>
      )}
      <div className={isExpanded ? 'flex-1 overflow-y-auto' : 'max-h-48 overflow-y-auto'}>
        {filteredServers.length === 0 ? (
          <div className="px-3 py-3 text-sm dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50 text-center">
            {enabledServers.length === 0
              ? (i18nService.t('agentMcpEmpty') || 'No MCP servers configured. Add one in MCP Manager first.')
              : 'No matching MCP servers'}
          </div>
        ) : (
          filteredServers.map((server) => {
            const isSelected = selectedMcpIds.includes(server.id);
            return (
              <button
                key={server.id}
                type="button"
                onClick={() => toggle(server.id)}
                className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors rounded-lg ${
                  isSelected ? 'bg-claude-accent/5 dark:bg-claude-accent/10' : ''
                }`}
              >
                <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                  isSelected
                    ? 'bg-claude-accent border-claude-accent'
                    : 'dark:border-claude-darkBorder border-claude-border'
                }`}>
                  {isSelected && <CheckIcon className="h-3 w-3 text-white" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                    {server.name}
                  </div>
                  {server.description && (
                    <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 truncate">
                      {server.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </>
  );

  if (isExpanded) {
    return (
      <div className="flex flex-col h-full">
        <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mb-3">
          {selectedCount === 0
            ? (i18nService.t('agentMcpInheritGlobal') || 'None selected — all globally enabled MCPs will be used')
            : (i18nService.t('agentMcpSelectorDesc') || 'Select MCP tools for this Agent. Leave empty to use all globally enabled MCPs.')}
        </p>
        {serverList}
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
        {i18nService.t('agentMcpTab') || 'MCP Tools'}
      </label>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
      >
        <span className={selectedCount > 0 ? '' : 'dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50'}>
          {selectedCount > 0
            ? enabledServers
                .filter((s) => selectedMcpIds.includes(s.id))
                .map((s) => s.name)
                .join(', ')
            : (i18nService.t('agentMcpInheritGlobal') || 'None selected — all globally enabled MCPs will be used')}
        </span>
        {expanded
          ? <ChevronUpIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          : <ChevronDownIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />}
      </button>
      {showList && (
        <div className="mt-1 rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden">
          {serverList}
        </div>
      )}
      <p className="mt-1 text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
        {i18nService.t('agentMcpSelectorDesc') || 'Select MCP tools for this Agent. Leave empty to use all globally enabled MCPs.'}
      </p>
    </div>
  );
};

export default AgentMcpSelector;
