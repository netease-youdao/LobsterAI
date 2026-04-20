import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { Platform } from '@shared/platform';
import { PlatformRegistry } from '@shared/platform';
import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import type { RootState } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import type {
  DingTalkInstanceConfig,
  FeishuInstanceConfig,
  IMGatewayConfig,
  QQInstanceConfig,
  WecomInstanceConfig,
} from '../../types/im';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import Modal from '../common/Modal';
import ModelSelector from '../ModelSelector';
import AgentAvatar from './AgentAvatar';
import AgentAvatarField from './AgentAvatarField';
import AgentSkillSelector from './AgentSkillSelector';

type CreateTab = 'basic' | 'skills' | 'im';
type MultiInstancePlatform = 'dingtalk' | 'feishu' | 'qq' | 'wecom';
type MultiInstanceConfig =
  | DingTalkInstanceConfig
  | FeishuInstanceConfig
  | QQInstanceConfig
  | WecomInstanceConfig;

const MULTI_INSTANCE_PLATFORMS: MultiInstancePlatform[] = ['dingtalk', 'feishu', 'qq', 'wecom'];

const isMultiInstancePlatform = (platform: Platform): platform is MultiInstancePlatform =>
  MULTI_INSTANCE_PLATFORMS.includes(platform as MultiInstancePlatform);

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
  const [avatarSourcePath, setAvatarSourcePath] = useState('');
  const [avatarPreviewSrc, setAvatarPreviewSrc] = useState('');
  const [model, setModel] = useState<Model | null>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<CreateTab>('basic');
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundKeys, setBoundKeys] = useState<Set<string>>(new Set());

  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const agents = useSelector((state: RootState) => state.agent.agents);

  const isDirty = useCallback((): boolean => {
    return !!(
      name
      || description
      || systemPrompt
      || identity
      || icon
      || avatarSourcePath
      || avatarPreviewSrc
      || skillIds.length > 0
      || boundKeys.size > 0
    );
  }, [
    name,
    description,
    systemPrompt,
    identity,
    icon,
    avatarSourcePath,
    avatarPreviewSrc,
    skillIds,
    boundKeys,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setDescription('');
    setSystemPrompt('');
    setIdentity('');
    setIcon('');
    setAvatarSourcePath('');
    setAvatarPreviewSrc('');
    setSkillIds([]);
    setActiveTab('basic');
    setShowUnsavedConfirm(false);
    setBoundKeys(new Set());
    imService.loadConfig().then((cfg) => {
      if (cfg) {
        setImConfig(cfg);
      }
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
    setAvatarSourcePath('');
    setAvatarPreviewSrc('');
    setModel(null);
    setSkillIds([]);
    setActiveTab('basic');
    setBoundKeys(new Set());
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
        avatarSourcePath: avatarSourcePath || undefined,
        skillIds,
      });
      if (!agent) {
        return;
      }
      if (boundKeys.size > 0 && imConfig) {
        const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
        for (const key of boundKeys) {
          currentBindings[key] = agent.id;
        }
        await imService.persistConfig({
          settings: { ...imConfig.settings, platformAgentBindings: currentBindings },
        });
        await imService.saveAndSyncConfig();
      }
      agentService.switchAgent(agent.id);
      onClose();
      resetForm();
    } finally {
      setCreating(false);
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

  const getEnabledInstances = (platform: MultiInstancePlatform) => {
    if (!imConfig) return [];
    const cfg = imConfig[platform];
    const instances = cfg?.instances;
    if (!Array.isArray(instances)) return [];
    return instances.filter((inst: MultiInstanceConfig) => inst.enabled);
  };

  const isPlatformConfigured = (platform: Platform): boolean => {
    if (!imConfig) return false;
    if (isMultiInstancePlatform(platform)) {
      return getEnabledInstances(platform).length > 0;
    }
    return 'enabled' in imConfig[platform] && imConfig[platform].enabled === true;
  };

  const getAgentName = (agentId: string): string | null => {
    if (!agentId || agentId === 'main') return null;
    const agent = agents.find((item) => item.id === agentId);
    return agent?.name || agentId;
  };

  const tabs: { key: CreateTab; label: string }[] = [
    { key: 'basic', label: i18nService.t('agentTabBasic') || 'Basic Info' },
    { key: 'skills', label: i18nService.t('agentTabSkills') || 'Skills' },
    { key: 'im', label: i18nService.t('agentTabIM') || 'IM Channels' },
  ];

  const renderToggle = (isOn: boolean) => (
    <div
      className={`relative h-5 w-9 rounded-full transition-colors ${
        isOn ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <div
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          isOn ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </div>
  );

  const renderMultiInstancePlatform = (platform: MultiInstancePlatform) => {
    const enabledInstances = getEnabledInstances(platform);
    const logo = PlatformRegistry.logo(platform);
    const bindings = imConfig?.settings?.platformAgentBindings || {};

    if (enabledInstances.length === 0) {
      return (
        <div
          key={platform}
          className="flex items-center justify-between rounded-lg px-3 py-2.5 opacity-50"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center">
              <img src={logo} alt={i18nService.t(platform)} className="h-6 w-6 rounded object-contain" />
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
      <div key={platform} className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-3 bg-surface-raised px-3 py-2.5">
          <div className="flex h-8 w-8 items-center justify-center">
            <img src={logo} alt={i18nService.t(platform)} className="h-6 w-6 rounded object-contain" />
          </div>
          <span className="text-sm font-semibold text-foreground">
            {i18nService.t(platform)}
          </span>
        </div>
        {enabledInstances.map((inst: MultiInstanceConfig, idx: number) => {
          const bindingKey = `${platform}:${inst.instanceId}`;
          const isBound = boundKeys.has(bindingKey);
          const otherAgentId = bindings[bindingKey];
          const boundToOther = !!otherAgentId;
          const otherAgentName = boundToOther ? getAgentName(otherAgentId) : null;

          return (
            <div
              key={inst.instanceId}
              className={`flex cursor-pointer items-center justify-between px-3 py-2 pl-14 transition-colors hover:bg-surface-raised ${
                idx < enabledInstances.length - 1 ? 'border-b border-border-subtle' : ''
              } ${boundToOther ? 'opacity-55' : ''}`}
              onClick={() => !boundToOther && handleToggleIMBinding(bindingKey)}
            >
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-green-500" />
                <span className="text-sm text-foreground">
                  {inst.instanceName}
                </span>
                {boundToOther && otherAgentName && (
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                    {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
                  </span>
                )}
              </div>
              {boundToOther ? <div className="h-5 w-9" /> : renderToggle(isBound)}
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
    const boundToOther = configured && !!otherAgentId;
    const otherAgentName = boundToOther ? getAgentName(otherAgentId) : null;

    return (
      <div
        key={platform}
        className={`flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
          configured && !boundToOther
            ? 'cursor-pointer hover:bg-surface-raised'
            : boundToOther ? 'opacity-55' : 'opacity-50'
        }`}
        onClick={() => configured && !boundToOther && handleToggleIMBinding(platform)}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center">
            <img src={logo} alt={i18nService.t(platform)} className="h-6 w-6 rounded object-contain" />
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
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
              {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {configured ? (
            boundToOther ? <div className="h-5 w-9" /> : renderToggle(isBound)
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
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <AgentAvatar
              icon={icon}
              avatarPreviewSrc={avatarPreviewSrc}
              name={name || (i18nService.t('createAgent') || 'Create Agent')}
              className="h-8 w-8"
              emojiClassName="text-xl"
            />
            <h3 className="text-base font-semibold text-foreground">
              {name || (i18nService.t('createAgent') || 'Create Agent')}
            </h3>
          </div>
          <button type="button" onClick={handleClose} className="rounded-lg p-1 hover:bg-surface-raised">
            <XMarkIcon className="h-5 w-5 text-secondary" />
          </button>
        </div>

        <div className="flex border-b border-border px-5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-primary'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>

        <div className="min-h-[300px] flex-1 overflow-y-auto px-5 py-4">
          {activeTab === 'basic' && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-secondary">
                  {i18nService.t('agentAvatar') || 'Avatar'}
                </label>
                <AgentAvatarField
                  icon={icon}
                  avatarPreviewSrc={avatarPreviewSrc}
                  fallbackIcon="🤖"
                  name={name}
                  onIconChange={setIcon}
                  onAvatarSelected={({ sourcePath, previewSrc }) => {
                    setAvatarSourcePath(sourcePath);
                    setAvatarPreviewSrc(previewSrc);
                  }}
                  onAvatarRemoved={() => {
                    setAvatarSourcePath('');
                    setAvatarPreviewSrc('');
                  }}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-secondary">
                  {i18nService.t('agentName') || 'Name'} *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={i18nService.t('agentNamePlaceholder') || 'Agent name'}
                  className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-secondary">
                  {i18nService.t('agentDescription') || 'Description'}
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={i18nService.t('agentDescriptionPlaceholder') || 'Brief description'}
                  className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-secondary">
                  {i18nService.t('systemPrompt') || 'System Prompt'}
                </label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder={i18nService.t('systemPromptPlaceholder') || 'Describe the agent\'s role and behavior...'}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-secondary">
                  {i18nService.t('agentIdentity') || 'Identity'}
                </label>
                <textarea
                  value={identity}
                  onChange={(e) => setIdentity(e.target.value)}
                  rows={3}
                  placeholder={i18nService.t('agentIdentityPlaceholder') || 'Identity description (IDENTITY.md)...'}
                  className="w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-secondary">
                  {i18nService.t('agentDefaultModel') || 'Agent Default Model'}
                </label>
                <ModelSelector value={model} onChange={setModel} />
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
              <p className="mb-4 text-xs text-secondary/60">
                {i18nService.t('agentIMBindHint') || 'Select IM channels this Agent responds to'}
              </p>
              <div className="space-y-1">
                {PlatformRegistry.platforms
                  .filter((platform) => (getVisibleIMPlatforms(i18nService.getLanguage()) as readonly string[]).includes(platform))
                  .map((platform) => {
                    if (isMultiInstancePlatform(platform)) {
                      return renderMultiInstancePlatform(platform);
                    }
                    return renderSingleInstancePlatform(platform);
                  })}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised"
          >
            {i18nService.t('cancel') || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? (i18nService.t('creating') || 'Creating...') : (i18nService.t('create') || 'Create')}
          </button>
        </div>
      </Modal>

      {showUnsavedConfirm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          onClick={() => setShowUnsavedConfirm(false)}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative w-80 rounded-xl border border-border bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />
              </div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">
                {i18nService.t('agentUnsavedTitle') || 'Unsaved Changes'}
              </h3>
              <p className="mb-5 text-sm text-secondary">
                {i18nService.t('agentUnsavedMessage') || 'You have unsaved changes. Are you sure you want to discard them?'}
              </p>
              <div className="flex w-full items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowUnsavedConfirm(false)}
                  className="flex-1 rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised"
                >
                  {i18nService.t('cancel') || 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDiscard}
                  className="flex-1 rounded-lg bg-amber-500 px-4 py-2 text-sm text-white transition-colors hover:bg-amber-600"
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
