/**
 * Discord platform configuration component.
 * Extracted from IMSettings.tsx to reduce file size.
 */
import React, { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import type { IMPlatform, DiscordOpenClawConfig, IMGatewayStatus } from '../../types/im';
import { PlatformGuide, IM_GUIDE_URLS } from './imSettingsShared';

export interface DiscordConfigProps {
  dcOpenClawConfig: DiscordOpenClawConfig;
  handleDiscordOpenClawChange: (update: Partial<DiscordOpenClawConfig>) => void;
  handleSaveDiscordOpenClawConfig: (override?: Partial<DiscordOpenClawConfig>) => Promise<void>;
  showSecrets: Record<string, boolean>;
  setShowSecrets: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  status: IMGatewayStatus;
  renderConnectivityTestButton: (platform: IMPlatform) => React.ReactNode;
  renderPairingSection: (platform: string) => React.ReactNode;
}

const DiscordConfig: React.FC<DiscordConfigProps> = ({
  dcOpenClawConfig,
  handleDiscordOpenClawChange,
  handleSaveDiscordOpenClawConfig,
  showSecrets,
  setShowSecrets,
  status,
  renderConnectivityTestButton,
  renderPairingSection,
}) => {
  const [discordAllowedUserIdInput, setDiscordAllowedUserIdInput] = useState('');
  const [discordServerAllowIdInput, setDiscordServerAllowIdInput] = useState('');

  return (
    <div className="space-y-3">
      <PlatformGuide
        steps={[
          i18nService.t('imDiscordGuideStep1'),
          i18nService.t('imDiscordGuideStep2'),
          i18nService.t('imDiscordGuideStep3'),
          i18nService.t('imDiscordGuideStep4'),
          i18nService.t('imDiscordGuideStep5'),
          i18nService.t('imDiscordGuideStep6'),
        ]}
        guideUrl={IM_GUIDE_URLS.discord}
      />
      {/* Bot Token */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          Bot Token
        </label>
        <div className="relative">
          <input
            type={showSecrets['discord.botToken'] ? 'text' : 'password'}
            value={dcOpenClawConfig.botToken}
            onChange={(e) => handleDiscordOpenClawChange({ botToken: e.target.value })}
            onBlur={() => handleSaveDiscordOpenClawConfig()}
            className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
            placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ..."
          />
          <div className="absolute right-2 inset-y-0 flex items-center gap-1">
            {dcOpenClawConfig.botToken && (
              <button
                type="button"
                onClick={() => { handleDiscordOpenClawChange({ botToken: '' }); void imService.persistConfig({ discord: { ...dcOpenClawConfig, botToken: '' } }); }}
                className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSecrets(prev => ({ ...prev, 'discord.botToken': !prev['discord.botToken'] }))}
              className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
              title={showSecrets['discord.botToken'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
            >
              {showSecrets['discord.botToken'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('imDiscordTokenHint')}
        </p>
      </div>

      {/* Advanced Settings (collapsible) */}
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent transition-colors">
          {i18nService.t('imAdvancedSettings')}
        </summary>
        <div className="mt-2 space-y-3 pl-2 border-l-2 border-claude-border/30 dark:border-claude-darkBorder/30">
          {/* DM Policy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              DM Policy
            </label>
            <select
              value={dcOpenClawConfig.dmPolicy}
              onChange={(e) => {
                const update = { dmPolicy: e.target.value as DiscordOpenClawConfig['dmPolicy'] };
                handleDiscordOpenClawChange(update);
                void handleSaveDiscordOpenClawConfig(update);
              }}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            >
              <option value="pairing">{i18nService.t('imDmPolicyPairing')}</option>
              <option value="allowlist">{i18nService.t('imDmPolicyAllowlist')}</option>
              <option value="open">{i18nService.t('imDmPolicyOpen')}</option>
              <option value="disabled">{i18nService.t('imDmPolicyDisabled')}</option>
            </select>
          </div>

          {/* Pairing Requests (shown when dmPolicy is 'pairing') */}
          {dcOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('discord')}

          {/* Allow From (User IDs) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Allow From (User IDs)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={discordAllowedUserIdInput}
                onChange={(e) => setDiscordAllowedUserIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const id = discordAllowedUserIdInput.trim();
                    if (id && !dcOpenClawConfig.allowFrom.includes(id)) {
                      const newIds = [...dcOpenClawConfig.allowFrom, id];
                      handleDiscordOpenClawChange({ allowFrom: newIds });
                      setDiscordAllowedUserIdInput('');
                      void imService.persistConfig({ discord: { ...dcOpenClawConfig, allowFrom: newIds } });
                    }
                  }
                }}
                className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imDiscordUserIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = discordAllowedUserIdInput.trim();
                  if (id && !dcOpenClawConfig.allowFrom.includes(id)) {
                    const newIds = [...dcOpenClawConfig.allowFrom, id];
                    handleDiscordOpenClawChange({ allowFrom: newIds });
                    setDiscordAllowedUserIdInput('');
                    void imService.persistConfig({ discord: { ...dcOpenClawConfig, allowFrom: newIds } });
                  }
                }}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
              >
                {i18nService.t('add') || '添加'}
              </button>
            </div>
            {dcOpenClawConfig.allowFrom.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {dcOpenClawConfig.allowFrom.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                  >
                    {id}
                    <button
                      type="button"
                      onClick={() => {
                        const newIds = dcOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                        handleDiscordOpenClawChange({ allowFrom: newIds });
                        void imService.persistConfig({ discord: { ...dcOpenClawConfig, allowFrom: newIds } });
                      }}
                      className="text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 transition-colors"
                    >
                      <XMarkIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Streaming */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Streaming
            </label>
            <select
              value={dcOpenClawConfig.streaming}
              onChange={(e) => {
                const update = { streaming: e.target.value as DiscordOpenClawConfig['streaming'] };
                handleDiscordOpenClawChange(update);
                void handleSaveDiscordOpenClawConfig(update);
              }}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            >
              <option value="off">Off</option>
              <option value="partial">Partial</option>
              <option value="block">Block</option>
              <option value="progress">Progress</option>
            </select>
          </div>

          {/* Proxy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Proxy
            </label>
            <input
              type="text"
              value={dcOpenClawConfig.proxy}
              onChange={(e) => handleDiscordOpenClawChange({ proxy: e.target.value })}
              onBlur={() => handleSaveDiscordOpenClawConfig()}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              placeholder="http://proxy:port"
            />
          </div>

          {/* Group Policy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Group Policy
            </label>
            <select
              value={dcOpenClawConfig.groupPolicy}
              onChange={(e) => {
                const update = { groupPolicy: e.target.value as DiscordOpenClawConfig['groupPolicy'] };
                handleDiscordOpenClawChange(update);
                void handleSaveDiscordOpenClawConfig(update);
              }}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            >
              <option value="allowlist">{i18nService.t('imGroupPolicyAllowlist')}</option>
              <option value="open">{i18nService.t('imGroupPolicyOpen')}</option>
              <option value="disabled">{i18nService.t('imGroupPolicyDisabled')}</option>
            </select>
          </div>

          {/* Group Allow From (Server IDs) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Group Allow From (Server IDs)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={discordServerAllowIdInput}
                onChange={(e) => setDiscordServerAllowIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const id = discordServerAllowIdInput.trim();
                    if (id && !dcOpenClawConfig.groupAllowFrom.includes(id)) {
                      const newIds = [...dcOpenClawConfig.groupAllowFrom, id];
                      handleDiscordOpenClawChange({ groupAllowFrom: newIds });
                      setDiscordServerAllowIdInput('');
                      void imService.persistConfig({ discord: { ...dcOpenClawConfig, groupAllowFrom: newIds } });
                    }
                  }
                }}
                className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imDiscordServerIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = discordServerAllowIdInput.trim();
                  if (id && !dcOpenClawConfig.groupAllowFrom.includes(id)) {
                    const newIds = [...dcOpenClawConfig.groupAllowFrom, id];
                    handleDiscordOpenClawChange({ groupAllowFrom: newIds });
                    setDiscordServerAllowIdInput('');
                    void imService.persistConfig({ discord: { ...dcOpenClawConfig, groupAllowFrom: newIds } });
                  }
                }}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
              >
                {i18nService.t('add') || '添加'}
              </button>
            </div>
            {dcOpenClawConfig.groupAllowFrom.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {dcOpenClawConfig.groupAllowFrom.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                  >
                    {id}
                    <button
                      type="button"
                      onClick={() => {
                        const newIds = dcOpenClawConfig.groupAllowFrom.filter((gid) => gid !== id);
                        handleDiscordOpenClawChange({ groupAllowFrom: newIds });
                        void imService.persistConfig({ discord: { ...dcOpenClawConfig, groupAllowFrom: newIds } });
                      }}
                      className="text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 transition-colors"
                    >
                      <XMarkIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* History Limit */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              History Limit
            </label>
            <input
              type="number"
              min={1}
              max={200}
              value={dcOpenClawConfig.historyLimit}
              onChange={(e) => {
                const val = parseInt(e.target.value) || 50;
                handleDiscordOpenClawChange({ historyLimit: val });
              }}
              onBlur={() => handleSaveDiscordOpenClawConfig()}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            />
          </div>

          {/* Media Max MB */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Media Max MB
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={dcOpenClawConfig.mediaMaxMb}
              onChange={(e) => {
                const val = parseInt(e.target.value) || 25;
                handleDiscordOpenClawChange({ mediaMaxMb: val });
              }}
              onBlur={() => handleSaveDiscordOpenClawConfig()}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            />
          </div>
        </div>
      </details>

      <div className="pt-1">
        {renderConnectivityTestButton('discord')}
      </div>

      {/* Bot username display */}
      {status.discord.botUsername && (
        <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
          Bot: {status.discord.botUsername}
        </div>
      )}

      {/* Error display */}
      {status.discord.lastError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {status.discord.lastError}
        </div>
      )}
    </div>
  );
};

export default DiscordConfig;
