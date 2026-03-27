import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { agentService } from '../../services/agent';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { PlusIcon } from '@heroicons/react/24/outline';
import type { PresetAgent } from '../../types/agent';
import AgentCreateModal from './AgentCreateModal';
import AgentSettingsPanel from './AgentSettingsPanel';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface AgentsViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  onShowCowork?: () => void;
  updateBadge?: React.ReactNode;
}

const AgentsView: React.FC<AgentsViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  onShowCowork,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const agents = useSelector((state: RootState) => state.agent.agents);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const [presets, setPresets] = useState<PresetAgent[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [addingPreset, setAddingPreset] = useState<string | null>(null);

  useEffect(() => {
    agentService.loadAgents();
    agentService.getPresets().then(setPresets);
  }, []);

  // Refresh presets when agents change (to update installed status)
  useEffect(() => {
    agentService.getPresets().then(setPresets);
  }, [agents]);

  const enabledAgents = agents.filter((a) => a.enabled && a.id !== 'main');
  const presetAgents = enabledAgents.filter((a) => a.source === 'preset');
  const customAgents = enabledAgents.filter((a) => a.source === 'custom');
  const uninstalledPresets = presets.filter((p) => !p.installed);

  const handleAddPreset = async (presetId: string) => {
    setAddingPreset(presetId);
    try {
      await agentService.addPreset(presetId);
    } finally {
      setAddingPreset(null);
    }
  };

  const handleSwitchAgent = (agentId: string) => {
    agentService.switchAgent(agentId);
    coworkService.loadSessions(agentId);
    onShowCowork?.();
  };

  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('myAgents')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
        <div className="max-w-3xl mx-auto px-4 py-6">
          {/* Subtitle */}
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-6">
            {i18nService.t('agentsSubtitle')}
          </p>

          {/* Preset Agents Section */}
          {(presetAgents.length > 0 || uninstalledPresets.length > 0) && (
            <div className="mb-8">
              <h2 className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
                {i18nService.t('presetAgents')}
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {/* Installed presets */}
                {presetAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    icon={agent.icon}
                    name={agent.name}
                    description={agent.description}
                    isActive={agent.id === currentAgentId}
                    onClick={() => setSettingsAgentId(agent.id)}
                  />
                ))}
                {/* Uninstalled presets */}
                {uninstalledPresets.map((preset) => (
                  <UninstalledPresetCard
                    key={preset.id}
                    icon={preset.icon}
                    name={preset.name}
                    description={preset.description}
                    isAdding={addingPreset === preset.id}
                    onAdd={() => handleAddPreset(preset.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Custom Agents Section */}
          <div>
            <h2 className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
              {i18nService.t('myCustomAgents')}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {customAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  icon={agent.icon}
                  name={agent.name}
                  description={agent.description}
                  isActive={agent.id === currentAgentId}
                  onClick={() => setSettingsAgentId(agent.id)}
                />
              ))}
              {/* Create new agent card */}
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed dark:border-claude-darkBorder border-claude-border hover:border-claude-accent dark:hover:border-claude-accent hover:bg-claude-accent/5 dark:hover:bg-claude-accent/5 transition-colors min-h-[140px] cursor-pointer"
              >
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-claude-accent/10 dark:bg-claude-accent/20">
                  <PlusIcon className="h-5 w-5 text-claude-accent" />
                </div>
                <span className="text-sm font-medium text-claude-accent">
                  {i18nService.t('createNewAgent')}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <AgentCreateModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
      <AgentSettingsPanel
        agentId={settingsAgentId}
        onClose={() => setSettingsAgentId(null)}
        onSwitchAgent={(id) => {
          setSettingsAgentId(null);
          handleSwitchAgent(id);
        }}
      />
    </div>
  );
};

/* ── Agent Card (installed) ─────────────────────────── */

const AgentCard: React.FC<{
  icon: string;
  name: string;
  description: string;
  isActive: boolean;
  onClick: () => void;
}> = ({ icon, name, description, isActive, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex flex-col items-start gap-2 p-4 rounded-xl border-2 text-left transition-all min-h-[140px] hover:shadow-md dark:hover:shadow-none dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover ${
      isActive
        ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
        : 'dark:border-claude-darkBorder border-claude-border'
    }`}
  >
    <span className="text-3xl">{icon || '🤖'}</span>
    <div className="min-w-0 w-full">
      <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">
        {name}
      </div>
      {description && (
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 line-clamp-2">
          {description}
        </div>
      )}
    </div>
  </button>
);

/* ── Uninstalled Preset Card ─────────────────────────── */

const UninstalledPresetCard: React.FC<{
  icon: string;
  name: string;
  description: string;
  isAdding: boolean;
  onAdd: () => void;
}> = ({ icon, name, description, isAdding, onAdd }) => (
  <div className="flex flex-col items-start gap-2 p-4 rounded-xl border-2 border-dashed dark:border-claude-darkBorder border-claude-border opacity-60 hover:opacity-80 transition-opacity min-h-[140px]">
    <span className="text-3xl">{icon || '🤖'}</span>
    <div className="min-w-0 w-full flex-1">
      <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">
        {name}
      </div>
      {description && (
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 line-clamp-2">
          {description}
        </div>
      )}
    </div>
    <button
      type="button"
      onClick={onAdd}
      disabled={isAdding}
      className="self-end px-3 py-1 text-xs font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-50 transition-colors"
    >
      {isAdding ? '...' : (i18nService.t('addAgent') || 'Add')}
    </button>
  </div>
);

export default AgentsView;
