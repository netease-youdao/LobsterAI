/**
 * POPO platform configuration component.
 * Extracted from IMSettings.tsx to reduce file size.
 */
import React, { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import type { IMPlatform, PopoOpenClawConfig, IMGatewayStatus } from '../../types/im';
import { PlatformGuide, IM_GUIDE_URLS } from './imSettingsShared';

export interface PopoConfigProps {
  popoConfig: PopoOpenClawConfig;
  handlePopoChange: (update: Partial<PopoOpenClawConfig>) => void;
  handleSavePopoConfig: (override?: Partial<PopoOpenClawConfig>) => Promise<void>;
  showSecrets: Record<string, boolean>;
  setShowSecrets: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  status: IMGatewayStatus;
  localIp: string;
  renderConnectivityTestButton: (platform: IMPlatform) => React.ReactNode;
  renderPairingSection: (platform: string) => React.ReactNode;
}

const PopoConfig: React.FC<PopoConfigProps> = ({
  popoConfig,
  handlePopoChange,
  handleSavePopoConfig,
  showSecrets,
  setShowSecrets,
  status,
  localIp,
  renderConnectivityTestButton,
  renderPairingSection,
}) => {
  const [popoAllowedUserIdInput, setPopoAllowedUserIdInput] = useState('');
  const [popoGroupAllowIdInput, setPopoGroupAllowIdInput] = useState('');

  return (
          <div className="space-y-3">
            {/* Platform Guide */}
            <PlatformGuide
              steps={[
                i18nService.t('imPopoGuideStep1'),
                i18nService.t('imPopoGuideStep2'),
                i18nService.t('imPopoGuideStep3'),
              ]}
              guideUrl={IM_GUIDE_URLS.popo}
            />

            {/* Connection Mode selector */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('imPopoConnectionMode')}
              </label>
              <select
                value={popoConfig.connectionMode || (popoConfig.token ? 'webhook' : 'websocket')}
                onChange={(e) => {
                  const update = { connectionMode: e.target.value as PopoOpenClawConfig['connectionMode'] };
                  handlePopoChange(update);
                  void handleSavePopoConfig(update);
                }}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              >
                <option value="websocket">{i18nService.t('imPopoConnectionModeWebsocket')}</option>
                <option value="webhook">{i18nService.t('imPopoConnectionModeWebhook')}</option>
              </select>
            </div>

            {/* Credential hint */}
            <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('imPopoCredentialHint')}
            </p>

            {/* AppKey input */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">AppKey</label>
              <div className="relative">
                <input
                  type="text"
                  value={popoConfig.appKey}
                  onChange={(e) => handlePopoChange({ appKey: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="AppKey"
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                />
                {popoConfig.appKey && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ appKey: '' });
                        void handleSavePopoConfig({ appKey: '' });
                      }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* AppSecret input */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">AppSecret</label>
              <div className="relative">
                <input
                  type={showSecrets['popo.appSecret'] ? 'text' : 'password'}
                  value={popoConfig.appSecret}
                  onChange={(e) => handlePopoChange({ appSecret: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="••••••••••••"
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {popoConfig.appSecret && (
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ appSecret: '' });
                        void handleSavePopoConfig({ appSecret: '' });
                      }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'popo.appSecret': !prev['popo.appSecret'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['popo.appSecret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['popo.appSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Token input (webhook mode only) */}
            {(popoConfig.connectionMode || (popoConfig.token ? 'webhook' : 'websocket')) === 'webhook' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Token</label>
              <div className="relative">
                <input
                  type={showSecrets['popo.token'] ? 'text' : 'password'}
                  value={popoConfig.token}
                  onChange={(e) => handlePopoChange({ token: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="••••••••••••"
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {popoConfig.token && (
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ token: '' });
                        void handleSavePopoConfig({ token: '' });
                      }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'popo.token': !prev['popo.token'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['popo.token'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['popo.token'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
            )}

            {/* AES Key input */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">AES Key</label>
              <div className="relative">
                <input
                  type={showSecrets['popo.aesKey'] ? 'text' : 'password'}
                  value={popoConfig.aesKey}
                  onChange={(e) => handlePopoChange({ aesKey: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="••••••••••••"
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {popoConfig.aesKey && (
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ aesKey: '' });
                        void handleSavePopoConfig({ aesKey: '' });
                      }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'popo.aesKey': !prev['popo.aesKey'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['popo.aesKey'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['popo.aesKey'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {popoConfig.aesKey && popoConfig.aesKey.length !== 32 && (
                <p className="text-xs text-amber-500">AES Key {i18nService.t('lang') === 'zh' ? '需要为 32 个字符' : 'must be 32 characters'}（{i18nService.t('lang') === 'zh' ? '当前' : 'current'} {popoConfig.aesKey.length}）</p>
              )}
            </div>

            {/* Advanced Settings (collapsible) */}
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent transition-colors">
                {i18nService.t('imAdvancedSettings')}
              </summary>
              <div className="mt-2 space-y-3 pl-2 border-l-2 border-claude-border/30 dark:border-claude-darkBorder/30">
                {/* Webhook fields (webhook mode only) */}
                {(popoConfig.connectionMode || (popoConfig.token ? 'webhook' : 'websocket')) === 'webhook' && (
                <>
                {/* Webhook Base URL */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Webhook Base URL</label>
                  <input
                    type="text"
                    value={popoConfig.webhookBaseUrl}
                    onChange={(e) => handlePopoChange({ webhookBaseUrl: e.target.value })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder={localIp ? `http://${localIp}` : (i18nService.t('lang') === 'zh' ? '外部域名（可选，不填则自动检测本机 IP）' : 'External domain (optional, auto-detects local IP)')}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Webhook Path */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Webhook Path</label>
                  <input
                    type="text"
                    value={popoConfig.webhookPath}
                    onChange={(e) => handlePopoChange({ webhookPath: e.target.value })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder="/popo/callback"
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Webhook Port */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Webhook Port</label>
                  <input
                    type="number"
                    value={popoConfig.webhookPort}
                    onChange={(e) => handlePopoChange({ webhookPort: parseInt(e.target.value) || 3100 })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder="3100"
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  />
                </div>
                </>
                )}

                {/* DM Policy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    DM Policy
                  </label>
                  <select
                    value={popoConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as PopoOpenClawConfig['dmPolicy'] };
                      handlePopoChange(update);
                      void handleSavePopoConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">{i18nService.t('imDmPolicyOpen')}</option>
                    <option value="pairing">{i18nService.t('imDmPolicyPairing')}</option>
                    <option value="allowlist">{i18nService.t('imDmPolicyAllowlist')}</option>
                    <option value="disabled">{i18nService.t('imDmPolicyDisabled')}</option>
                  </select>
                </div>

                {/* Pairing Requests (shown when dmPolicy is 'pairing') */}
                {popoConfig.dmPolicy === 'pairing' && renderPairingSection('popo')}

                {/* Allow From */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Allow From (User IDs)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={popoAllowedUserIdInput}
                      onChange={(e) => setPopoAllowedUserIdInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const id = popoAllowedUserIdInput.trim();
                          if (id && !popoConfig.allowFrom.includes(id)) {
                            const newIds = [...popoConfig.allowFrom, id];
                            handlePopoChange({ allowFrom: newIds });
                            setPopoAllowedUserIdInput('');
                            void imService.persistConfig({ popo: { ...popoConfig, allowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('lang') === 'zh' ? '输入用户 ID 后回车添加' : 'Enter user ID and press Enter'}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const id = popoAllowedUserIdInput.trim();
                        if (id && !popoConfig.allowFrom.includes(id)) {
                          const newIds = [...popoConfig.allowFrom, id];
                          handlePopoChange({ allowFrom: newIds });
                          setPopoAllowedUserIdInput('');
                          void imService.persistConfig({ popo: { ...popoConfig, allowFrom: newIds } });
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {popoConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {popoConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = popoConfig.allowFrom.filter((uid) => uid !== id);
                              handlePopoChange({ allowFrom: newIds });
                              void imService.persistConfig({ popo: { ...popoConfig, allowFrom: newIds } });
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

                {/* Group Policy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Group Policy
                  </label>
                  <select
                    value={popoConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as PopoOpenClawConfig['groupPolicy'] };
                      handlePopoChange(update);
                      void handleSavePopoConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">Open</option>
                    <option value="allowlist">Allowlist</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>

                {/* Group Allow From */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Group Allow From (Chat IDs)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={popoGroupAllowIdInput}
                      onChange={(e) => setPopoGroupAllowIdInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const id = popoGroupAllowIdInput.trim();
                          if (id && !popoConfig.groupAllowFrom.includes(id)) {
                            const newIds = [...popoConfig.groupAllowFrom, id];
                            handlePopoChange({ groupAllowFrom: newIds });
                            setPopoGroupAllowIdInput('');
                            void imService.persistConfig({ popo: { ...popoConfig, groupAllowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('lang') === 'zh' ? '输入群组 ID 后回车添加' : 'Enter group ID and press Enter'}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const id = popoGroupAllowIdInput.trim();
                        if (id && !popoConfig.groupAllowFrom.includes(id)) {
                          const newIds = [...popoConfig.groupAllowFrom, id];
                          handlePopoChange({ groupAllowFrom: newIds });
                          setPopoGroupAllowIdInput('');
                          void imService.persistConfig({ popo: { ...popoConfig, groupAllowFrom: newIds } });
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {popoConfig.groupAllowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {popoConfig.groupAllowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = popoConfig.groupAllowFrom.filter((gid) => gid !== id);
                              handlePopoChange({ groupAllowFrom: newIds });
                              void imService.persistConfig({ popo: { ...popoConfig, groupAllowFrom: newIds } });
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

                {/* Text Chunk Limit */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Text Chunk Limit</label>
                  <input
                    type="number"
                    value={popoConfig.textChunkLimit}
                    onChange={(e) => handlePopoChange({ textChunkLimit: parseInt(e.target.value) || 3000 })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder="3000"
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Rich Text Chunk Limit */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Rich Text Chunk Limit</label>
                  <input
                    type="number"
                    value={popoConfig.richTextChunkLimit}
                    onChange={(e) => handlePopoChange({ richTextChunkLimit: parseInt(e.target.value) || 5000 })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder="5000"
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Debug toggle */}
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Debug</label>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !popoConfig.debug;
                      handlePopoChange({ debug: next });
                      void handleSavePopoConfig({ debug: next });
                    }}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                      popoConfig.debug ? 'bg-claude-accent' : 'dark:bg-claude-darkSurface bg-claude-surface'
                    }`}
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      popoConfig.debug ? 'translate-x-4' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
              </div>
            </details>

            {/* Connectivity test */}
            <div className="pt-1">
              {renderConnectivityTestButton('popo')}
            </div>

            {/* Error display */}
            {status.popo?.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.popo.lastError}
              </div>
            )}
          </div>
  );
};

export default PopoConfig;
