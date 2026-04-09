import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import type { RootState } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import type { IMGatewayConfig,IMPlatform } from '../../types/im';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import Modal from '../common/Modal';
import ModelSelector from '../ModelSelector';
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
  const [model, setModel] = useState<Model | null>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<CreateTab>('basic');
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);

  // IM binding state
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundPlatforms, setBoundPlatforms] = useState<Set<IMPlatform>>(new Set());

  const isDirty = useCallback((): boolean => {
    return !!(name || description || systemPrompt || identity || icon || skillIds.length > 0 || boundPlatforms.size > 0);
  }, [name, description, systemPrompt, identity, icon, skillIds, boundPlatforms]);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setDescription('');
    setSystemPrompt('');
    setIdentity('');
    setIcon('');
    setSkillIds([]);
    setActiveTab('basic');
    setShowUnsavedConfirm(false);
    setBoundPlatforms(new Set());
    imService.loadConfig().then((cfg) => {
      if (cfg) setImConfig(cfg);
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || model || !globalSelectedModel) return;
    setModel(globalSelectedModel);
  }, [globalSelectedModel, isOpen, model]);

  if (!isOpen) return null;

  const resetForm = () => {
    setName('');
    setDescription('');
    setSystemPrompt('');
    setIdentity('');
    setIcon('');
    setModel(null);
    setSkillIds([]);
    setActiveTab('basic');
    setBoundPlatforms(new Set());
  };

  const handleClose = () => {
    if (isDirty()) {
      setShowUnsavedConfirm(true);
    } else {
      onClose();
    }
  };

  const handleConfirmDiscard = () => {
    setShowUnsavedConfirm(false);
    onClose();
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
        model: model ? toOpenClawModelRef(model) : '',
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
      } else {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentCreateFailed') }));
      }
    } catch {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentCreateFailed') }));
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
    <>
    <Modal isOpen={isOpen} onClose={handleClose} className="w-full max-w-2xl mx-4 rounded-xl shadow-xl bg-surface border border-border max-h-[80vh] flex flex-col">
        {/* Header: agent icon + name + close */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-xl">{icon || '🤖'}</span>
            <h3 className="text-base font-semibold text-foreground">
              {name || (i18nService.t('createAgent') || 'Create Agent')}
            </h3>
          </div>
          <button type="button" onClick={handleClose} className="p-1 rounded-lg hover:bg-surface-raised">
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
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  {i18nService.t('agentDefaultModel') || 'Agent Default Model'}
                </label>
                <ModelSelector
                  value={model}
                  onChange={setModel}
                />
                {availableModels.length > 0 && (
                  <p className="mt-1 text-xs text-secondary/70">
                    {i18nService.t('agentModelOpenClawOnly') || 'This setting only applies to the OpenClaw engine'}
                  </p>
                )}
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
            onClick={handleClose}
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
    </Modal>

    {/* Unsaved Changes Confirmation Modal */}
    {showUnsavedConfirm && (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        onClick={() => setShowUnsavedConfirm(false)}
      >
        <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
        <div
          className="relative w-80 rounded-xl shadow-2xl bg-surface border border-border p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex flex-col items-center text-center">
            <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
              <ExclamationTriangleIcon className="w-5 h-5 text-amber-500" />
            </div>
            <h3 className="text-sm font-semibold text-foreground mb-2">
              {i18nService.t('agentUnsavedTitle') || 'Unsaved Changes'}
            </h3>
            <p className="text-sm text-secondary mb-5">
              {i18nService.t('agentUnsavedMessage') || 'You have unsaved changes. Are you sure you want to discard them?'}
            </p>
            <div className="flex items-center gap-3 w-full">
              <button
                type="button"
                onClick={() => setShowUnsavedConfirm(false)}
                className="flex-1 px-4 py-2 text-sm rounded-lg text-foreground border border-border hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('cancel') || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="flex-1 px-4 py-2 text-sm rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
              >
                {i18nService.t('discard') || 'Discard'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default AgentCreateModal;
