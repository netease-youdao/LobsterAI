import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { agentService } from '../../services/agent';
import { imService } from '../../services/im';
import { i18nService } from '../../services/i18n';
import { XMarkIcon, TrashIcon } from '@heroicons/react/24/outline';
import type { Agent } from '../../types/agent';
import type { IMPlatform, IMGatewayConfig } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import AgentSkillSelector from './AgentSkillSelector';

type SettingsTab = 'basic' | 'skills' | 'im';

const IM_PLATFORMS: { key: IMPlatform; logo: string }[] = [
  { key: 'dingtalk', logo: 'dingding.png' },
  { key: 'feishu', logo: 'feishu.png' },
  { key: 'qq', logo: 'qq_bot.jpeg' },
  { key: 'telegram', logo: 'telegram.svg' },
  { key: 'discord', logo: 'discord.svg' },
  { key: 'nim', logo: 'nim.png' },
  { key: 'xiaomifeng', logo: 'xiaomifeng.png' },
  { key: 'weixin', logo: 'weixin.png' },
  { key: 'wecom', logo: 'wecom.png' },
  { key: 'popo', logo: 'popo.png' },
];

interface AgentSettingsPanelProps {
  agentId: string | null;
  onClose: () => void;
  onSwitchAgent?: (agentId: string) => void;
}

const AgentSettingsPanel: React.FC<AgentSettingsPanelProps> = ({ agentId, onClose, onSwitchAgent }) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
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

  // IM binding state
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundPlatforms, setBoundPlatforms] = useState<Set<IMPlatform>>(new Set());
  const [initialBoundPlatforms, setInitialBoundPlatforms] = useState<Set<IMPlatform>>(new Set());

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
    // Load IM config for bindings
    imService.loadConfig().then((cfg) => {
      if (cfg) {
        setImConfig(cfg);
        const bindings = cfg.settings?.platformAgentBindings || {};
        const bound = new Set<IMPlatform>();
        for (const [platform, boundAgentId] of Object.entries(bindings)) {
          if (boundAgentId === agentId) {
            bound.add(platform as IMPlatform);
          }
        }
        setBoundPlatforms(bound);
        setInitialBoundPlatforms(new Set(bound));
      }
    });
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
        boundPlatforms.size !== initialBoundPlatforms.size ||
        [...boundPlatforms].some((p) => !initialBoundPlatforms.has(p));
      if (bindingsChanged && imConfig) {
        const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
        // Remove old bindings for this agent
        for (const key of Object.keys(currentBindings)) {
          if (currentBindings[key] === agentId) {
            delete currentBindings[key];
          }
        }
        // Add new bindings
        for (const platform of boundPlatforms) {
          currentBindings[platform] = agentId;
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

  const handleToggleIMBinding = (platform: IMPlatform) => {
    const next = new Set(boundPlatforms);
    if (next.has(platform)) {
      next.delete(platform);
    } else {
      next.add(platform);
    }
    setBoundPlatforms(next);
  };

  const isPlatformConfigured = (platform: IMPlatform): boolean => {
    if (!imConfig) return false;
    return imConfig[platform]?.enabled === true;
  };

  const isMainAgent = agentId === 'main';

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'basic', label: i18nService.t('agentTabBasic') || 'Basic Info' },
    { key: 'skills', label: i18nService.t('agentTabSkills') || 'Skills' },
    { key: 'im', label: i18nService.t('agentTabIM') || 'IM Channels' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-2xl mx-4 rounded-xl shadow-xl bg-white dark:bg-claude-darkSurface border dark:border-claude-darkBorder border-claude-border max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: agent icon + name + close */}
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2">
            <span className="text-xl">{icon || '🤖'}</span>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {name || (i18nService.t('agentSettings') || 'Agent Settings')}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover">
            <XMarkIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b dark:border-claude-darkBorder border-claude-border px-5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === tab.key
                  ? 'text-claude-accent'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-claude-accent rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-[300px]">
          {activeTab === 'basic' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('agentName') || 'Name'}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    placeholder="🤖"
                    className="w-12 px-2 py-2 text-center rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-lg"
                    maxLength={4}
                  />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('agentDescription') || 'Description'}
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('systemPrompt') || 'System Prompt'}
                </label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('agentIdentity') || 'Identity'}
                </label>
                <textarea
                  value={identity}
                  onChange={(e) => setIdentity(e.target.value)}
                  rows={3}
                  placeholder={i18nService.t('agentIdentityPlaceholder') || 'Identity description (IDENTITY.md)...'}
                  className="w-full px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm resize-none"
                />
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <AgentSkillSelector selectedSkillIds={skillIds} onChange={setSkillIds} variant="expanded" />
          )}

          {activeTab === 'im' && (
            <div>
              <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mb-4">
                {i18nService.t('agentIMBindHint') || 'Select IM channels this Agent responds to'}
              </p>
              <div className="space-y-1">
                {IM_PLATFORMS
                  .filter(({ key }) => (getVisibleIMPlatforms(i18nService.getLanguage()) as readonly string[]).includes(key))
                  .map(({ key: platform, logo }) => {
                  const configured = isPlatformConfigured(platform);
                  const bound = boundPlatforms.has(platform);
                  return (
                    <div
                      key={platform}
                      className={`flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors ${
                        configured
                          ? 'hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover cursor-pointer'
                          : 'opacity-50'
                      }`}
                      onClick={() => configured && handleToggleIMBinding(platform)}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center">
                          <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
                        </div>
                        <div>
                          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                            {i18nService.t(platform)}
                          </div>
                          {!configured && (
                            <div className="text-xs dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50">
                              {i18nService.t('agentIMNotConfiguredHint') || 'Please configure in Settings > IM Bots first'}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {configured ? (
                          <div
                            className={`relative w-9 h-5 rounded-full transition-colors ${
                              bound ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
                            }`}
                          >
                            <div
                              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                                bound ? 'translate-x-4' : 'translate-x-0.5'
                              }`}
                            />
                          </div>
                        ) : (
                          <span className="text-xs dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50">
                            {i18nService.t('agentIMNotConfigured') || 'Not configured'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
          <div>
            {!isMainAgent && !showDeleteConfirm && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                <TrashIcon className="h-4 w-4" />
                {i18nService.t('delete') || 'Delete'}
              </button>
            )}
            {showDeleteConfirm && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-500">{i18nService.t('confirmDelete') || 'Confirm?'}</span>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="px-2 py-1 text-xs font-medium rounded bg-red-500 text-white hover:bg-red-600"
                >
                  {i18nService.t('delete') || 'Delete'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-2 py-1 text-xs font-medium rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  {i18nService.t('cancel') || 'Cancel'}
                </button>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {onSwitchAgent && agentId !== currentAgentId && (
              <button
                type="button"
                onClick={() => onSwitchAgent(agentId)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-claude-accent text-claude-accent hover:bg-claude-accent/10 transition-colors"
              >
                {i18nService.t('switchToAgent') || 'Use this Agent'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              {i18nService.t('cancel') || 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!name.trim() || saving}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? (i18nService.t('saving') || 'Saving...') : (i18nService.t('save') || 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentSettingsPanel;
