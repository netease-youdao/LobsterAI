/**
 * Discord Instance Settings Component
 * Configuration form for a single Discord bot instance in multi-instance mode
 */

import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { SignalIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { PlatformRegistry } from '@shared/platform';
import React, { useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { DiscordInstanceConfig, DiscordInstanceStatus, DiscordOpenClawConfig, DiscordOpenClawGuildConfig, IMConnectivityTestResult } from '../../types/im';
import TrashIcon from '../icons/TrashIcon';

interface DiscordInstanceSettingsProps {
  instance: DiscordInstanceConfig;
  instanceStatus: DiscordInstanceStatus | undefined;
  onConfigChange: (update: Partial<DiscordOpenClawConfig>) => void;
  onSave: (override?: Partial<DiscordOpenClawConfig>) => Promise<void>;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onTestConnectivity: () => void;
  testingPlatform: string | null;
  connectivityResults: Record<string, IMConnectivityTestResult>;
  language: 'zh' | 'en';
}

const DiscordInstanceSettings: React.FC<DiscordInstanceSettingsProps> = ({
  instance,
  instanceStatus,
  onConfigChange,
  onSave,
  onRename,
  onDelete,
  onToggleEnabled,
  onTestConnectivity,
  testingPlatform,
  connectivityResults,
  language,
}) => {
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [allowedUserIdInput, setAllowedUserIdInput] = useState('');
  const [groupAllowFromInput, setGroupAllowFromInput] = useState('');
  const [guildIdInput, setGuildIdInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(instance.instanceName);

  // Sync nameValue when instance changes
  React.useEffect(() => {
    setNameValue(instance.instanceName);
    setEditingName(false);
  }, [instance.instanceId]);

  const handleNameBlur = () => {
    setEditingName(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== instance.instanceName) {
      onRename(trimmed);
    } else {
      setNameValue(instance.instanceName);
    }
  };

  const handleGuildConfigChange = (guildId: string, update: Partial<DiscordOpenClawGuildConfig>) => {
    const currentGuild = instance.guilds[guildId] ?? {};
    const newGuilds = { ...instance.guilds, [guildId]: { ...currentGuild, ...update } };
    onConfigChange({ guilds: newGuilds });
    void onSave({ guilds: newGuilds });
  };

  const handleRemoveGuild = (guildId: string) => {
    const newGuilds = { ...instance.guilds };
    delete newGuilds[guildId];
    onConfigChange({ guilds: newGuilds });
    void onSave({ guilds: newGuilds });
  };

  return (
    <div className="space-y-3">
      {/* Instance Header: Name, Status, Enable Toggle, Delete */}
      <div className="flex items-center gap-3 pb-3 border-b border-border-subtle">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-surface border border-border-subtle p-1">
            <img
              src={PlatformRegistry.logo('discord')}
              alt="Discord"
              className="w-4 h-4 object-contain rounded"
            />
          </div>
          {editingName ? (
            <input
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameBlur();
                if (e.key === 'Escape') { setNameValue(instance.instanceName); setEditingName(false); }
              }}
              autoFocus
              className="text-sm font-medium text-foreground bg-transparent border-b border-primary focus:outline-none px-0 py-0"
            />
          ) : (
            <span
              className="text-sm font-medium text-foreground cursor-pointer hover:text-primary transition-colors truncate border-b border-dashed border-gray-400 dark:border-secondary/50 hover:border-primary pb-px"
              onClick={() => setEditingName(true)}
              title={i18nService.t('imDiscordClickToRename')}
            >
              {instance.instanceName}
            </span>
          )}
        </div>

        {/* Status badge */}
        <div className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${
          instanceStatus?.connected
            ? 'bg-green-500/15 text-green-600 dark:text-green-400'
            : 'bg-gray-500/15 text-gray-500 dark:text-gray-400'
        }`}>
          {instanceStatus?.connected
            ? i18nService.t('connected')
            : i18nService.t('disconnected')}
        </div>

        {/* Enable toggle */}
        <button
          type="button"
          onClick={onToggleEnabled}
          disabled={!instance.enabled && !instance.botToken}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            instance.enabled
              ? (instanceStatus?.connected ? 'bg-green-500' : 'bg-yellow-500')
              : 'bg-gray-400 dark:bg-gray-600'
          } ${!instance.enabled && !instance.botToken ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          title={instance.enabled ? i18nService.t('imDiscordDisableInstance') : (!instance.botToken ? i18nService.t('imInstanceFillCredentials') : i18nService.t('imDiscordEnableInstance'))}
        >
          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            instance.enabled ? 'translate-x-4' : 'translate-x-0'
          }`} />
        </button>

        {/* Delete button */}
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex-shrink-0"
          title={i18nService.t('imDiscordDeleteInstance')}
        >
          <TrashIcon className="h-4 w-4" />
          {language === 'zh' ? '删除' : 'Delete'}
        </button>
      </div>

      {/* Guide */}
      <div className="mb-3 p-3 rounded-lg border border-dashed border-border-subtle">
        <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
          <li>{i18nService.t('imDiscordGuideStep1')}</li>
          <li>{i18nService.t('imDiscordGuideStep2')}</li>
          <li>{i18nService.t('imDiscordGuideStep3')}</li>
          <li>{i18nService.t('imDiscordGuideStep4')}</li>
          <li>{i18nService.t('imDiscordGuideStep5')}</li>
          <li>{i18nService.t('imDiscordGuideStep6')}</li>
        </ol>
        {PlatformRegistry.guideUrl('discord') && (
          <button
            type="button"
            onClick={() => {
              window.electron.shell.openExternal(PlatformRegistry.guideUrl('discord')!).catch((err: unknown) => {
                console.error('[IM] Failed to open guide URL:', err);
              });
            }}
            className="mt-2 text-xs font-medium text-primary dark:text-primary hover:text-primary dark:hover:text-blue-200 underline underline-offset-2 transition-colors"
          >
            {i18nService.t('imViewGuide')}
          </button>
        )}
      </div>

      {/* Bot Token */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">
          Bot Token
        </label>
        <div className="relative">
          <input
            type={showSecrets['botToken'] ? 'text' : 'password'}
            value={instance.botToken}
            onChange={(e) => onConfigChange({ botToken: e.target.value })}
            onBlur={() => void onSave()}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
            placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ..."
          />
          <div className="absolute right-2 inset-y-0 flex items-center gap-1">
            {instance.botToken && (
              <button
                type="button"
                onClick={() => { onConfigChange({ botToken: '' }); void onSave({ botToken: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSecrets(prev => ({ ...prev, 'botToken': !prev['botToken'] }))}
              className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
              title={showSecrets['botToken'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
            >
              {showSecrets['botToken'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-secondary">
          {i18nService.t('imDiscordTokenHint')}
        </p>
      </div>

      {/* Advanced Settings (collapsible) */}
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary transition-colors">
          {i18nService.t('imAdvancedSettings')}
        </summary>
        <div className="mt-2 space-y-3 pl-2 border-l-2 border-border-subtle">
          {/* DM Policy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              DM Policy
            </label>
            <select
              value={instance.dmPolicy}
              onChange={(e) => {
                const update = { dmPolicy: e.target.value as DiscordOpenClawConfig['dmPolicy'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="pairing">{i18nService.t('imDmPolicyPairing')}</option>
              <option value="allowlist">{i18nService.t('imDmPolicyAllowlist')}</option>
              <option value="open">{i18nService.t('imDmPolicyOpen')}</option>
              <option value="disabled">{i18nService.t('imDmPolicyDisabled')}</option>
            </select>
          </div>

          {/* Allow From (User IDs) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              Allow From (User IDs)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={allowedUserIdInput}
                onChange={(e) => setAllowedUserIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const id = allowedUserIdInput.trim();
                    if (id && !instance.allowFrom.includes(id)) {
                      const newIds = [...instance.allowFrom, id];
                      onConfigChange({ allowFrom: newIds });
                      setAllowedUserIdInput('');
                      void onSave({ allowFrom: newIds });
                    }
                  }
                }}
                className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imDiscordUserIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = allowedUserIdInput.trim();
                  if (id && !instance.allowFrom.includes(id)) {
                    const newIds = [...instance.allowFrom, id];
                    onConfigChange({ allowFrom: newIds });
                    setAllowedUserIdInput('');
                    void onSave({ allowFrom: newIds });
                  }
                }}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                {i18nService.t('add') || '添加'}
              </button>
            </div>
            {instance.allowFrom.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {instance.allowFrom.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                  >
                    {id}
                    <button
                      type="button"
                      onClick={() => {
                        const newIds = instance.allowFrom.filter((uid) => uid !== id);
                        onConfigChange({ allowFrom: newIds });
                        void onSave({ allowFrom: newIds });
                      }}
                      className="text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    >
                      <XMarkIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Group Policy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              Group Policy
            </label>
            <select
              value={instance.groupPolicy}
              onChange={(e) => {
                const update = { groupPolicy: e.target.value as DiscordOpenClawConfig['groupPolicy'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="allowlist">{i18nService.t('imGroupPolicyAllowlist')}</option>
              <option value="open">{i18nService.t('imGroupPolicyOpen')}</option>
              <option value="disabled">{i18nService.t('imGroupPolicyDisabled')}</option>
            </select>
          </div>

          {/* Group Allow From (Server IDs) */}
          {instance.groupPolicy === 'allowlist' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">
                Group Allow From (Server IDs)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={groupAllowFromInput}
                  onChange={(e) => setGroupAllowFromInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const id = groupAllowFromInput.trim();
                      if (id && !instance.groupAllowFrom.includes(id)) {
                        const newIds = [...instance.groupAllowFrom, id];
                        onConfigChange({ groupAllowFrom: newIds });
                        setGroupAllowFromInput('');
                        void onSave({ groupAllowFrom: newIds });
                      }
                    }
                  }}
                  className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  placeholder={i18nService.t('imDiscordServerIdPlaceholder')}
                />
                <button
                  type="button"
                  onClick={() => {
                    const id = groupAllowFromInput.trim();
                    if (id && !instance.groupAllowFrom.includes(id)) {
                      const newIds = [...instance.groupAllowFrom, id];
                      onConfigChange({ groupAllowFrom: newIds });
                      setGroupAllowFromInput('');
                      void onSave({ groupAllowFrom: newIds });
                    }
                  }}
                  className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  {i18nService.t('add') || '添加'}
                </button>
              </div>
              {instance.groupAllowFrom.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {instance.groupAllowFrom.map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                    >
                      {id}
                      <button
                        type="button"
                        onClick={() => {
                          const newIds = instance.groupAllowFrom.filter((gid) => gid !== id);
                          onConfigChange({ groupAllowFrom: newIds });
                          void onSave({ groupAllowFrom: newIds });
                        }}
                        className="text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      >
                        <XMarkIcon className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Per-Guild Settings */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              {language === 'zh' ? 'Guild 独立配置' : 'Per-Guild Settings'}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={guildIdInput}
                onChange={(e) => setGuildIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const id = guildIdInput.trim();
                    if (id && !instance.guilds[id]) {
                      const newGuilds = { ...instance.guilds, [id]: { requireMention: true } };
                      onConfigChange({ guilds: newGuilds });
                      setGuildIdInput('');
                      void onSave({ guilds: newGuilds });
                    }
                  }
                }}
                className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imDiscordGuildIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = guildIdInput.trim();
                  if (id && !instance.guilds[id]) {
                    const newGuilds = { ...instance.guilds, [id]: { requireMention: true } };
                    onConfigChange({ guilds: newGuilds });
                    setGuildIdInput('');
                    void onSave({ guilds: newGuilds });
                  }
                }}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                {i18nService.t('add') || '添加'}
              </button>
            </div>
            {Object.keys(instance.guilds).length > 0 && (
              <div className="mt-2 space-y-2">
                {Object.entries(instance.guilds).map(([guildId, guildCfg]) => (
                  <div
                    key={guildId}
                    className="p-2 rounded-lg bg-surface border border-border-subtle space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-foreground">{guildId}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveGuild(guildId)}
                        className="text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {/* requireMention toggle */}
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-secondary">
                        Require @mention
                      </label>
                      <button
                        type="button"
                        onClick={() => handleGuildConfigChange(guildId, { requireMention: !guildCfg.requireMention })}
                        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                          guildCfg.requireMention ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          guildCfg.requireMention ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>
                    {/* Guild-level systemPrompt */}
                    <div className="space-y-1">
                      <label className="text-xs text-secondary">
                        {language === 'zh' ? '系统提示词' : 'System Prompt'}
                      </label>
                      <textarea
                        value={guildCfg.systemPrompt ?? ''}
                        onChange={(e) => {
                          const currentGuild = instance.guilds[guildId] ?? {};
                          const newGuilds = { ...instance.guilds, [guildId]: { ...currentGuild, systemPrompt: e.target.value } };
                          onConfigChange({ guilds: newGuilds });
                        }}
                        onBlur={() => void onSave()}
                        rows={2}
                        className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs transition-colors resize-y"
                        placeholder={language === 'zh' ? '该 Guild 专属系统提示词（可选）' : 'Custom system prompt for this guild (optional)'}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Streaming */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              Streaming
            </label>
            <select
              value={instance.streaming}
              onChange={(e) => {
                const update = { streaming: e.target.value as DiscordOpenClawConfig['streaming'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="off">Off</option>
              <option value="partial">Partial</option>
              <option value="block">Block</option>
              <option value="progress">Progress</option>
            </select>
          </div>

          {/* Proxy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              Proxy
            </label>
            <input
              type="text"
              value={instance.proxy}
              onChange={(e) => onConfigChange({ proxy: e.target.value })}
              onBlur={() => void onSave()}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
              placeholder="http://proxy:port"
            />
          </div>

          {/* History Limit */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              History Limit
            </label>
            <input
              type="number"
              value={instance.historyLimit}
              onChange={(e) => onConfigChange({ historyLimit: parseInt(e.target.value) || 50 })}
              onBlur={() => void onSave()}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
              min="1"
              max="200"
            />
          </div>

          {/* Media Max MB */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              Media Max MB
            </label>
            <input
              type="number"
              value={instance.mediaMaxMb}
              onChange={(e) => onConfigChange({ mediaMaxMb: parseInt(e.target.value) || 25 })}
              onBlur={() => void onSave()}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
              min="1"
              max="100"
            />
          </div>

          {/* Debug */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-secondary">
              Debug
            </label>
            <button
              type="button"
              onClick={() => {
                const update = { debug: !instance.debug };
                onConfigChange(update);
                void onSave(update);
              }}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                instance.debug ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                instance.debug ? 'translate-x-4' : 'translate-x-0'
              }`} />
            </button>
          </div>
        </div>
      </details>

      {/* Connectivity test button */}
      <div className="pt-1">
        <button
          type="button"
          onClick={onTestConnectivity}
          disabled={testingPlatform === 'discord'}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
        >
          <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
          {testingPlatform === 'discord'
            ? i18nService.t('imConnectivityTesting')
            : connectivityResults['discord' as keyof typeof connectivityResults]
              ? i18nService.t('imConnectivityRetest')
              : i18nService.t('imConnectivityTest')}
        </button>
      </div>

      {/* Bot username display */}
      {instanceStatus?.botUsername && (
        <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
          Bot: {instanceStatus.botUsername}
        </div>
      )}

      {/* Error display */}
      {instanceStatus?.lastError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {instanceStatus.lastError}
        </div>
      )}
    </div>
  );
};

export default DiscordInstanceSettings;
