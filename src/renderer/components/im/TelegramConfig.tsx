/**
 * Telegram platform configuration component.
 * Extracted from IMSettings.tsx to reduce file size.
 */
import React, { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import type { IMPlatform, TelegramOpenClawConfig, IMGatewayStatus } from '../../types/im';
import { PlatformGuide, IM_GUIDE_URLS } from './imSettingsShared';

export interface TelegramConfigProps {
  tgOpenClawConfig: TelegramOpenClawConfig;
  handleTelegramOpenClawChange: (update: Partial<TelegramOpenClawConfig>) => void;
  handleSaveTelegramOpenClawConfig: (override?: Partial<TelegramOpenClawConfig>) => Promise<void>;
  showSecrets: Record<string, boolean>;
  setShowSecrets: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  status: IMGatewayStatus;
  renderConnectivityTestButton: (platform: IMPlatform) => React.ReactNode;
  renderPairingSection: (platform: string) => React.ReactNode;
}

const TelegramConfig: React.FC<TelegramConfigProps> = ({
  tgOpenClawConfig,
  handleTelegramOpenClawChange,
  handleSaveTelegramOpenClawConfig,
  showSecrets,
  setShowSecrets,
  status,
  renderConnectivityTestButton,
  renderPairingSection,
}) => {
  const [allowedUserIdInput, setAllowedUserIdInput] = useState('');

  return (
    <div className="space-y-3">
      <PlatformGuide
        steps={[
          i18nService.t('imTelegramGuideStep1'),
          i18nService.t('imTelegramGuideStep2'),
          i18nService.t('imTelegramGuideStep3'),
          i18nService.t('imTelegramGuideStep4'),
        ]}
        guideUrl={IM_GUIDE_URLS.telegram}
      />
      {/* Bot Token */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          Bot Token
        </label>
        <div className="relative">
          <input
            type={showSecrets['telegram.botToken'] ? 'text' : 'password'}
            value={tgOpenClawConfig.botToken}
            onChange={(e) => handleTelegramOpenClawChange({ botToken: e.target.value })}
            onBlur={() => handleSaveTelegramOpenClawConfig()}
            className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
            placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
          />
          <div className="absolute right-2 inset-y-0 flex items-center gap-1">
            {tgOpenClawConfig.botToken && (
              <button
                type="button"
                onClick={() => { handleTelegramOpenClawChange({ botToken: '' }); void imService.persistConfig({ telegram: { ...tgOpenClawConfig, botToken: '' } }); }}
                className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSecrets(prev => ({ ...prev, 'telegram.botToken': !prev['telegram.botToken'] }))}
              className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
              title={showSecrets['telegram.botToken'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
            >
              {showSecrets['telegram.botToken'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('imTelegramTokenHint')}
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
              value={tgOpenClawConfig.dmPolicy}
              onChange={(e) => {
                const update = { dmPolicy: e.target.value as TelegramOpenClawConfig['dmPolicy'] };
                handleTelegramOpenClawChange(update);
                void handleSaveTelegramOpenClawConfig(update);
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
          {tgOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('telegram')}

          {/* Allow From */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
                    if (id && !tgOpenClawConfig.allowFrom.includes(id)) {
                      const newIds = [...tgOpenClawConfig.allowFrom, id];
                      handleTelegramOpenClawChange({ allowFrom: newIds });
                      setAllowedUserIdInput('');
                      void imService.persistConfig({ telegram: { ...tgOpenClawConfig, allowFrom: newIds } });
                    }
                  }
                }}
                className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imTelegramUserIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = allowedUserIdInput.trim();
                  if (id && !tgOpenClawConfig.allowFrom.includes(id)) {
                    const newIds = [...tgOpenClawConfig.allowFrom, id];
                    handleTelegramOpenClawChange({ allowFrom: newIds });
                    setAllowedUserIdInput('');
                    void imService.persistConfig({ telegram: { ...tgOpenClawConfig, allowFrom: newIds } });
                  }
                }}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
              >
                {i18nService.t('add') || '添加'}
              </button>
            </div>
            {tgOpenClawConfig.allowFrom.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {tgOpenClawConfig.allowFrom.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                  >
                    {id}
                    <button
                      type="button"
                      onClick={() => {
                        const newIds = tgOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                        handleTelegramOpenClawChange({ allowFrom: newIds });
                        void imService.persistConfig({ telegram: { ...tgOpenClawConfig, allowFrom: newIds } });
                      }}
                      className="text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    >
                      <XMarkIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Streaming Mode */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Streaming
            </label>
            <select
              value={tgOpenClawConfig.streaming}
              onChange={(e) => {
                const update = { streaming: e.target.value as TelegramOpenClawConfig['streaming'] };
                handleTelegramOpenClawChange(update);
                void handleSaveTelegramOpenClawConfig(update);
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
              value={tgOpenClawConfig.proxy}
              onChange={(e) => handleTelegramOpenClawChange({ proxy: e.target.value })}
              onBlur={() => handleSaveTelegramOpenClawConfig()}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              placeholder="socks5://localhost:9050"
            />
          </div>

          {/* Group Policy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Group Policy
            </label>
            <select
              value={tgOpenClawConfig.groupPolicy}
              onChange={(e) => {
                const update = { groupPolicy: e.target.value as TelegramOpenClawConfig['groupPolicy'] };
                handleTelegramOpenClawChange(update);
                void handleSaveTelegramOpenClawConfig(update);
              }}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            >
              <option value="allowlist">Allowlist</option>
              <option value="open">Open</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          {/* Reply-to Mode */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Reply-to Mode
            </label>
            <select
              value={tgOpenClawConfig.replyToMode}
              onChange={(e) => {
                const update = { replyToMode: e.target.value as TelegramOpenClawConfig['replyToMode'] };
                handleTelegramOpenClawChange(update);
                void handleSaveTelegramOpenClawConfig(update);
              }}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            >
              <option value="off">Off</option>
              <option value="first">First</option>
              <option value="all">All</option>
            </select>
          </div>

          {/* History Limit */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              History Limit
            </label>
            <input
              type="number"
              value={tgOpenClawConfig.historyLimit}
              onChange={(e) => handleTelegramOpenClawChange({ historyLimit: parseInt(e.target.value) || 50 })}
              onBlur={() => handleSaveTelegramOpenClawConfig()}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              min="1"
              max="200"
            />
          </div>

          {/* Media Max MB */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Media Max (MB)
            </label>
            <input
              type="number"
              value={tgOpenClawConfig.mediaMaxMb}
              onChange={(e) => handleTelegramOpenClawChange({ mediaMaxMb: parseInt(e.target.value) || 5 })}
              onBlur={() => handleSaveTelegramOpenClawConfig()}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              min="1"
              max="50"
            />
          </div>

          {/* Link Preview */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Link Preview
            </label>
            <button
              type="button"
              onClick={() => {
                const update = { linkPreview: !tgOpenClawConfig.linkPreview };
                handleTelegramOpenClawChange(update);
                void handleSaveTelegramOpenClawConfig(update);
              }}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                tgOpenClawConfig.linkPreview ? 'bg-claude-accent' : 'dark:bg-claude-darkSurface bg-claude-surface'
              }`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                tgOpenClawConfig.linkPreview ? 'translate-x-4' : 'translate-x-0'
              }`} />
            </button>
          </div>

          {/* Webhook URL */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Webhook URL
            </label>
            <input
              type="text"
              value={tgOpenClawConfig.webhookUrl}
              onChange={(e) => handleTelegramOpenClawChange({ webhookUrl: e.target.value })}
              onBlur={() => handleSaveTelegramOpenClawConfig()}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              placeholder="https://example.com/telegram-webhook"
            />
          </div>

          {/* Webhook Secret */}
          {tgOpenClawConfig.webhookUrl && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Webhook Secret
              </label>
              <input
                type="password"
                value={tgOpenClawConfig.webhookSecret}
                onChange={(e) => handleTelegramOpenClawChange({ webhookSecret: e.target.value })}
                onBlur={() => handleSaveTelegramOpenClawConfig()}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="webhook-secret"
              />
            </div>
          )}
        </div>
      </details>

      <div className="pt-1">
        {renderConnectivityTestButton('telegram')}
      </div>

      {/* Error display */}
      {status.telegram?.lastError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {status.telegram.lastError}
        </div>
      )}
    </div>
  );
};

export default TelegramConfig;
