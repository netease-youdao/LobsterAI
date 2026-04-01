import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { agentService } from '../../services/agent';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { PlusIcon, EllipsisHorizontalIcon, TrashIcon, ExclamationTriangleIcon, XMarkIcon, PencilSquareIcon, ChatBubbleLeftIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import type { PresetAgent } from '../../types/agent';
import AgentCreateModal from './AgentCreateModal';
import AgentSettingsPanel from './AgentSettingsPanel';
import AgentSearchModal from './AgentSearchModal';
import Tooltip from '../ui/Tooltip';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import PushPinIcon from '../icons/PushPinIcon';

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
  const [previewAgentId, setPreviewAgentId] = useState<string | null>(null);
  const [addingPreset, setAddingPreset] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'community' | 'mine'>('community');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

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

  const handleTogglePin = useCallback(async (agentId: string, pinned: boolean) => {
    await agentService.updateAgent(agentId, { sidebarPinned: pinned });
  }, []);

  const handleDeleteAgent = useCallback(async (agentId: string) => {
    await agentService.deleteAgent(agentId);
    setPreviewAgentId(null);
  }, []);

  const handleEditAgent = useCallback((agentId: string) => {
    setPreviewAgentId(null);
    setSettingsAgentId(agentId);
  }, []);

  const previewAgent = previewAgentId ? agents.find((a) => a.id === previewAgentId) : null;

  return (
    <div className="flex-1 flex flex-col bg-background h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold text-foreground">
            {i18nService.t('myAgents')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
        <div className="max-w-3xl mx-auto px-4 py-6">
          {/* Subtitle */}
          <p className="text-sm text-secondary mb-6">
            {i18nService.t('agentsSubtitle')}
          </p>

          {/* Preset Agents Section */}
          {(presetAgents.length > 0 || uninstalledPresets.length > 0) && (
            <div className="mb-8">
              <h2 className="text-sm font-medium text-secondary mb-3">
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
                {uninstalledPresets.map((preset) => {
                  const isEn = i18nService.getLanguage() === 'en';
                  return (
                    <UninstalledPresetCard
                      key={preset.id}
                      icon={preset.icon}
                      name={isEn && preset.nameEn ? preset.nameEn : preset.name}
                      description={isEn && preset.descriptionEn ? preset.descriptionEn : preset.description}
                      isAdding={addingPreset === preset.id}
                      onAdd={() => handleAddPreset(preset.id)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Custom Agents Section */}
          <div>
            <h2 className="text-sm font-medium text-secondary mb-3">
              {i18nService.t('myCustomAgents')}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {customAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agentId={agent.id}
                  icon={agent.icon}
                  name={agent.name}
                  description={agent.description}
                  isActive={agent.id === currentAgentId}
                  sidebarPinned={agent.sidebarPinned}
                  isMain={false}
                  onClick={() => setPreviewAgentId(agent.id)}
                  onTogglePin={handleTogglePin}
                  onDelete={handleDeleteAgent}
                  onEdit={handleEditAgent}
                />
              ))}
              {/* Create new agent card */}
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed border-border hover:border-primary hover:bg-primary/5 transition-colors min-h-[140px] cursor-pointer"
              >
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-primary/10">
                  <PlusIcon className="h-5 w-5 text-primary" />
                </div>
                <span className="text-sm font-medium text-primary">
                  {i18nService.t('createNewAgent')}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Agent Preview Modal */}
      {previewAgent && (
        <AgentPreviewModal
          agent={previewAgent}
          onClose={() => setPreviewAgentId(null)}
          onStartChat={async () => {
            setPreviewAgentId(null);
            setIsSearchOpen(false);
            if (!previewAgent.sidebarPinned) {
              await agentService.updateAgent(previewAgent.id, { sidebarPinned: true });
            }
            handleSwitchAgent(previewAgent.id);
          }}
          onEdit={() => {
            setIsSearchOpen(false);
            handleEditAgent(previewAgent.id);
          }}
          onDelete={() => handleDeleteAgent(previewAgent.id)}
        />
      )}

      {/* Modals */}
      <AgentSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        agents={enabledAgents}
        onSelectAgent={(agentId) => setPreviewAgentId(agentId)}
      />
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

/* ── Agent Preview Modal ─────────────────────────────── */

const AgentPreviewModal: React.FC<{
  agent: { id: string; icon: string; name: string; description: string; source: string };
  onClose: () => void;
  onStartChat: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ agent, onClose, onStartChat, onEdit, onDelete }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <>
      <div
        className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50"
        onClick={onClose}
      >
        <div
          className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header with actions */}
          <div className="flex items-center justify-end gap-1 px-4 pt-4">
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <EllipsisHorizontalIcon className="h-5 w-5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-9 z-20 min-w-[140px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg py-1">
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); onEdit(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    <PencilSquareIcon className="h-4 w-4" />
                    {i18nService.t('editAgent')}
                  </button>
                  {agent.id !== 'main' && (
                    <button
                      type="button"
                      onClick={() => { setMenuOpen(false); setShowDeleteConfirm(true); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-500 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                    >
                      <TrashIcon className="h-4 w-4" />
                      {i18nService.t('deleteAgent')}
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Agent info */}
          <div className="flex flex-col items-center px-6 pb-2 pt-2">
            <div className="w-16 h-16 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover flex items-center justify-center text-4xl mb-3">
              {agent.icon || '🤖'}
            </div>
            <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text text-center">
              {agent.name}
            </h2>
            {agent.description && (
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary text-center mt-1.5 line-clamp-3">
                {agent.description}
              </p>
            )}
          </div>

          {/* Start Chat button */}
          <div className="px-6 py-5">
            <button
              type="button"
              onClick={onStartChat}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-claude-text dark:bg-claude-darkText text-claude-bg dark:text-claude-darkBg font-medium text-sm hover:opacity-90 transition-opacity"
            >
              <ChatBubbleLeftIcon className="h-5 w-5" />
              {i18nService.t('startChatWithAgent')}
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirmation modal (layered on top) */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false); }}
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
                {i18nService.t('confirmDeleteAgent')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('confirmDeleteAgentMessage')}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => { setShowDeleteConfirm(false); onDelete(); }}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('deleteAgent')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

/* ── Agent Card (installed) ─────────────────────────── */

const AgentCard: React.FC<{
  agentId: string;
  icon: string;
  name: string;
  description: string;
  isActive: boolean;
  sidebarPinned: boolean;
  isMain: boolean;
  onClick: () => void;
}> = ({ icon, name, description, isActive, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex flex-col items-start gap-2 p-4 rounded-xl border-2 text-left transition-all min-h-[140px] hover:shadow-md hover:bg-surface-raised ${
      isActive
        ? 'border-primary bg-primary/5'
        : 'border-border'
    }`}
  >
    <span className="text-3xl">{icon || '🤖'}</span>
    <div className="min-w-0 w-full">
      <div className="text-sm font-semibold text-foreground truncate">
        {name}
      </div>
      {description && (
        <div className="text-xs text-secondary mt-0.5 line-clamp-2">
          {description}
        </div>
      )}
    </>
  );
};

/* ── Uninstalled Preset Card ─────────────────────────── */

const UninstalledPresetCard: React.FC<{
  icon: string;
  name: string;
  description: string;
  isAdding: boolean;
  onAdd: () => void;
}> = ({ icon, name, description, isAdding, onAdd }) => (
  <div className="flex flex-col items-start gap-2 p-4 rounded-xl border-2 border-dashed border-border opacity-60 hover:opacity-80 transition-opacity min-h-[140px]">
    <span className="text-3xl">{icon || '🤖'}</span>
    <div className="min-w-0 w-full flex-1">
      <div className="text-sm font-semibold text-foreground truncate">
        {name}
      </div>
      {description && (
        <div className="text-xs text-secondary mt-0.5 line-clamp-2">
          {description}
        </div>
      )}
    </div>
    <button
      type="button"
      onClick={onAdd}
      disabled={isAdding}
      className="self-end px-3 py-1 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors"
    >
      {isAdding ? '...' : i18nService.t('addAgent')}
    </button>
  </div>
);

export default AgentsView;