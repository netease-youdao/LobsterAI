import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { agentService } from '../../services/agent';
import { imService } from '../../services/im';
import { i18nService } from '../../services/i18n';
import { XMarkIcon } from '@heroicons/react/24/outline';
import TrashIcon from '../icons/TrashIcon';
import type { Agent } from '../../types/agent';
import type { Platform } from '@shared/platform';
import type { IMGatewayConfig } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import { PlatformRegistry } from '@shared/platform';
import AgentSkillSelector from './AgentSkillSelector';
import EmojiPicker from './EmojiPicker';
import Modal from '../common/Modal';

type SettingsTab = 'basic' | 'skills' | 'im';

const MULTI_INSTANCE_PLATFORMS: Platform[] = ['dingtalk', 'feishu', 'qq'];

interface AgentSettingsPanelProps {
  agentId: string | null;
  onClose: () => void;
  onSwitchAgent?: (agentId: string) => void;
}

const AgentSettingsPanel: React.FC<AgentSettingsPanelProps> = ({ agentId, onClose, onSwitchAgent }) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const imStatus = useSelector((state: RootState) => state.im.status);
  const [, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [identity, setIdentity] = useState('');
  const [icon, setIcon] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic');

  // IM binding state — keys are 'telegram' (single) or 'dingtalk:<instanceId>' (multi)
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundKeys, setBoundKeys] = useState<Set<string>>(new Set());
  const [initialBoundKeys, setInitialBoundKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!agentId) return;
    setActiveTab('basic');
    setShowDeleteConfirm(false);
    window.electron?.agents?.get(agentId).then((a) => {
      if (a) {
        setAgent(a);
        setName(a.name);
        setDescription(a.description);
        setSystemPrompt(a.systemPrompt);
        setIdentity(a.identity);
        setIcon(a.icon);
        setSkillIds(a.skillIds ?? []);
      }
    });
    // Load IM config and status for bindings
    imService.loadConfig().then((cfg) => {
      if (cfg) {
        setImConfig(cfg);
        const bindings = cfg.settings?.platformAgentBindings || {};
        const bound = new Set<string>();
        for (const [key, boundAgentId] of Object.entries(bindings)) {
          if (boundAgentId === agentId) {
            bound.add(key);
          }
        }
        setBoundKeys(bound);
        setInitialBoundKeys(new Set(bound));
      }
    });
    imService.loadStatus();
  }, [agentId]);

  if (!agentId) return null;

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await agentService.updateAgent(agentId, {
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        identity: identity.trim(),
        icon: icon.trim(),
        skillIds,
      });
      // Persist IM bindings if changed
      const bindingsChanged =
        boundKeys.size !== initialBoundKeys.size ||
        [...boundKeys].some((k) => !initialBoundKeys.has(k));
      if (bindingsChanged && imConfig) {
        const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
        // Remove old bindings for this agent
        for (const key of Object.keys(currentBindings)) {
          if (currentBindings[key] === agentId) {
            delete currentBindings[key];
          }
        }
        // Add new bindings
        for (const key of boundKeys) {
          currentBindings[key] = agentId;
        }
        await imService.persistConfig({
          settings: { ...imConfig.settings, platformAgentBindings: currentBindings },
        });
        await imService.saveAndSyncConfig();
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const success = await agentService.deleteAgent(agentId);
    if (success) {
      onClose();
    }
  };

  const handleToggleIMBinding = (key: string) => {
    const next = new Set(boundKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setBoundKeys(next);
  };

  /** Check if a multi-instance platform has any enabled+connected instances */
  const getConnectedInstances = (platform: Platform) => {
    if (!imConfig) return [];
    const cfg = imConfig[platform] as any;
    const instances = cfg?.instances;
    if (!Array.isArray(instances)) return [];
    const statusInstances = (imStatus as any)?.[platform]?.instances;
    return instances.filter((inst: any) => {
      if (!inst.enabled) return false;
      const instStatus = Array.isArray(statusInstances)
        ? statusInstances.find((s: any) => s.instanceId === inst.instanceId)
        : null;
      return instStatus?.connected === true;
    });
  };

  const isPlatformConfigured = (platform: Platform): boolean => {
    if (!imConfig) return false;
    if (MULTI_INSTANCE_PLATFORMS.includes(platform)) {
      return getConnectedInstances(platform).length > 0;
    }
    return (imConfig[platform] as any)?.enabled === true;
  };

  /** Resolve agent name by id */
  const getAgentName = (aid: string): string | null => {
    if (!aid || aid === 'main') return null;
    const agent = agents.find((a) => a.id === aid);
    return agent?.name || aid;
  };

  const isMainAgent = agentId === 'main';

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'basic', label: i18nService.t('agentTabBasic') || 'Basic Info' },
    { key: 'skills', label: i18nService.t('agentTabSkills') || 'Skills' },
    { key: 'im', label: i18nService.t('agentTabIM') || 'IM Channels' },
  ];

  const renderToggle = (isOn: boolean) => (
    <div
      className={`relative w-9 h-5 rounded-full transition-colors ${
        isOn ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          isOn ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </div>
  );

  const renderMultiInstancePlatform = (platform: Platform) => {
    const connectedInstances = getConnectedInstances(platform);
    const logo = PlatformRegistry.logo(platform);
    const bindings = imConfig?.settings?.platformAgentBindings || {};

    if (connectedInstances.length === 0) {
      // No connected instances — show disabled row like single-instance unconfigured
      return (
        <div
          key={platform}
          className="flex items-center justify-between px-3 py-2.5 rounded-lg opacity-50"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center">
              <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">
                {i18nService.t(platform)}
              </div>
              <div className="text-xs text-secondary/50">
                {i18nService.t('agentIMNotConfiguredHint') || 'Please configure in Settings > IM Bots first'}
              </div>
            </div>
          </div>
          <span className="text-xs text-secondary/50">
            {i18nService.t('agentIMNotConfigured') || 'Not configured'}
          </span>
        </div>
      );
    }

    return (
      <div key={platform} className="rounded-lg border border-border overflow-hidden">
        {/* Platform header */}
        <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-raised">
          <div className="flex h-8 w-8 items-center justify-center">
            <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
          </div>
          <span className="text-sm font-semibold text-foreground">
            {i18nService.t(platform)}
          </span>
        </div>
        {/* Instance list */}
        {connectedInstances.map((inst: any, idx: number) => {
          const bindingKey = `${platform}:${inst.instanceId}`;
          const isBound = boundKeys.has(bindingKey);
          const otherAgentId = bindings[bindingKey];
          const boundToOther = otherAgentId && otherAgentId !== agentId;
          const otherAgentName = boundToOther ? getAgentName(otherAgentId) : null;

          return (
            <div
              key={inst.instanceId}
              className={`flex items-center justify-between px-3 py-2 pl-14 transition-colors cursor-pointer hover:bg-surface-raised ${
                idx < connectedInstances.length - 1 ? 'border-b border-border-subtle' : ''
              } ${boundToOther ? 'opacity-55' : ''}`}
              onClick={() => !boundToOther && handleToggleIMBinding(bindingKey)}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                <span className="text-sm text-foreground">
                  {inst.instanceName}
                </span>
                {boundToOther && otherAgentName && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
                  </span>
                )}
              </div>
              {boundToOther ? (
                <div className="w-9 h-5" />
              ) : (
                renderToggle(isBound)
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderSingleInstancePlatform = (platform: Platform) => {
    const logo = PlatformRegistry.logo(platform);
    const configured = isPlatformConfigured(platform);
    const isBound = boundKeys.has(platform);
    const bindings = imConfig?.settings?.platformAgentBindings || {};
    const otherAgentId = bindings[platform];
    const boundToOther = configured && otherAgentId && otherAgentId !== agentId;
    const otherAgentName = boundToOther ? getAgentName(otherAgentId) : null;

    return (
      <div
        key={platform}
        className={`flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors ${
          configured && !boundToOther
            ? 'hover:bg-surface-raised cursor-pointer'
            : boundToOther ? 'opacity-55' : 'opacity-50'
        }`}
        onClick={() => configured && !boundToOther && handleToggleIMBinding(platform)}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center">
            <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">
              {i18nService.t(platform)}
            </div>
            {!configured && (
              <div className="text-xs text-secondary/50">
                {i18nService.t('agentIMNotConfiguredHint') || 'Please configure in Settings > IM Bots first'}
              </div>
            )}
          </div>
          {boundToOther && otherAgentName && (
            <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
              {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {configured ? (
            boundToOther ? <div className="w-9 h-5" /> : renderToggle(isBound)
          ) : (
            <span className="text-xs text-secondary/50">
              {i18nService.t('agentIMNotConfigured') || 'Not configured'}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal onClose={onClose} className="w-full max-w-2xl mx-4 rounded-xl shadow-xl bg-surface border border-border max-h-[80vh] flex flex-col">
        {/* Header: agent icon + name + close */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-xl">{icon || '🤖'}</span>
            <h3 className="text-base font-semibold text-foreground">
              {name || (i18nService.t('agentSettings') || 'Agent Settings')}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-surface-raised">
            <XMarkIcon className="h-5 w-5 text-secondary" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-border px-5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === tab.key
                  ? 'text-primary'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-[300px]">
          {activeTab === 'basic' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  {i18nService.t('agentName') || 'Name'}
                </label>
                <div className="flex gap-2">
                  <EmojiPicker value={icon} onChange={setIcon} />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  {i18nService.t('agentDescription') || 'Description'}
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  {i18nService.t('systemPrompt') || 'System Prompt'}
                </label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  {i18nService.t('agentIdentity') || 'Identity'}
                </label>
                <textarea
                  value={identity}
                  onChange={(e) => setIdentity(e.target.value)}
                  rows={3}
                  placeholder={i18nService.t('agentIdentityPlaceholder') || 'Identity description (IDENTITY.md)...'}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm resize-none"
                />
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <AgentSkillSelector selectedSkillIds={skillIds} onChange={setSkillIds} />
          )}

          {activeTab === 'im' && (
            <div>
              <p className="text-xs text-secondary/60 mb-4">
                {i18nService.t('agentIMBindHint') || 'Select IM channels this Agent responds to'}
              </p>
              <div className="space-y-1">
                {PlatformRegistry.platforms
                  .filter((platform) => (getVisibleIMPlatforms(i18nService.getLanguage()) as readonly string[]).includes(platform))
                  .map((platform) => {
                    if (MULTI_INSTANCE_PLATFORMS.includes(platform)) {
                      return renderMultiInstancePlatform(platform);
                    }
                    return renderSingleInstancePlatform(platform);
                  })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border">
          <div>
            {!isMainAgent && !showDeleteConfirm && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                <TrashIcon className="h-4 w-4" />
                {i18nService.t('delete')}
              </button>
            )}
            {showDeleteConfirm && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-500">{i18nService.t('confirmDelete')}</span>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="px-2 py-1 text-xs font-medium rounded bg-red-500 text-white hover:bg-red-600"
                >
                  {i18nService.t('delete')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-2 py-1 text-xs font-medium rounded text-secondary hover:bg-surface-raised"
                >
                  {i18nService.t('cancel')}
                </button>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {onSwitchAgent && agentId !== currentAgentId && (
              <button
                type="button"
                onClick={() => onSwitchAgent(agentId)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-primary text-primary hover:bg-primary/10 transition-colors"
              >
                {i18nService.t('switchToAgent') || 'Use this Agent'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel') || 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!name.trim() || saving}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? (i18nService.t('saving') || 'Saving...') : (i18nService.t('save') || 'Save')}
            </button>
          </div>
        </div>
    </Modal>
  );
};

export default AgentSettingsPanel;
