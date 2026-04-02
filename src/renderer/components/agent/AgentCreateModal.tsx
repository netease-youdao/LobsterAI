import React, { useEffect, useState } from 'react';
import { agentService } from '../../services/agent';
import { imService } from '../../services/im';
import { i18nService } from '../../services/i18n';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import type { IMPlatform, IMGatewayConfig } from '../../types/im';
import AgentSkillSelector from './AgentSkillSelector';
import EmojiPicker from './EmojiPicker';

type CreateTab = 'basic' | 'skills' | 'im';

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

interface AgentCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const AgentCreateModal: React.FC<AgentCreateModalProps> = ({ isOpen, onClose }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [identity, setIdentity] = useState('');
  const [icon, setIcon] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<CreateTab>('basic');

  // IM binding state
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundPlatforms, setBoundPlatforms] = useState<Set<IMPlatform>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    imService.loadConfig().then((cfg) => {
      if (cfg) setImConfig(cfg);
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const resetForm = () => {
    setName('');
    setDescription('');
    setSystemPrompt('');
    setIdentity('');
    setIcon('');
    setSkillIds([]);
    setActiveTab('basic');
    setBoundPlatforms(new Set());
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const agent = await agentService.createAgent({
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        identity: identity.trim(),
        icon: icon.trim() || undefined,
        skillIds,
      });
      if (agent) {
        // Save IM bindings after agent is created
        if (boundPlatforms.size > 0 && imConfig) {
          const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
          for (const platform of boundPlatforms) {
            currentBindings[platform] = agent.id;
          }
          await imService.persistConfig({
            settings: { ...imConfig.settings, platformAgentBindings: currentBindings },
          });
          await imService.saveAndSyncConfig();
        }
        agentService.switchAgent(agent.id);
        onClose();
        resetForm();
      }
    } finally {
      setCreating(false);
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
    return (imConfig as unknown as Record<string, { enabled?: boolean }>)[platform]?.enabled === true;
  };

  const tabs: { key: CreateTab; label: string }[] = [
    { key: 'basic', label: i18nService.t('agentTabBasic') || 'Basic Info' },
    { key: 'skills', label: i18nService.t('agentTabSkills') || 'Skills' },
    { key: 'im', label: i18nService.t('agentTabIM') || 'IM Channels' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-2xl mx-4 rounded-xl shadow-xl bg-surface border border-border max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: agent icon + name + close */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-xl">{icon || '🤖'}</span>
            <h3 className="text-base font-semibold text-foreground">
              {name || (i18nService.t('createAgent') || 'Create Agent')}
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
                  {i18nService.t('agentName') || 'Name'} *
                </label>
                <div className="flex gap-2">
                  <EmojiPicker value={icon} onChange={setIcon} />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={i18nService.t('agentNamePlaceholder') || 'Agent name'}
                    className="flex-1 px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm"
                    autoFocus
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
                  placeholder={i18nService.t('agentDescriptionPlaceholder') || 'Brief description'}
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
                  placeholder={i18nService.t('systemPromptPlaceholder') || 'Describe the agent\'s role and behavior...'}
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
                          ? 'hover:bg-surface-raised cursor-pointer'
                          : 'opacity-50'
                      }`}
                      onClick={() => configured && handleToggleIMBinding(platform)}
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
                      </div>
                      <div className="flex items-center gap-2">
                        {configured ? (
                          <div
                            className={`relative w-9 h-5 rounded-full transition-colors ${
                              bound ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                            }`}
                          >
                            <div
                              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                                bound ? 'translate-x-4' : 'translate-x-0.5'
                              }`}
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-secondary/50">
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
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('cancel') || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? (i18nService.t('creating') || 'Creating...') : (i18nService.t('create') || 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentCreateModal;
