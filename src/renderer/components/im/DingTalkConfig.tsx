/**
 * DingTalk platform configuration component.
 * Extracted from IMSettings.tsx to reduce file size.
 */
import React, { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import type { IMPlatform, DingTalkOpenClawConfig, IMGatewayStatus } from '../../types/im';
import { PlatformGuide, IM_GUIDE_URLS } from './imSettingsShared';

export interface DingTalkConfigProps {
  dtOpenClawConfig: DingTalkOpenClawConfig;
  handleDingTalkOpenClawChange: (update: Partial<DingTalkOpenClawConfig>) => void;
  handleSaveDingTalkOpenClawConfig: (override?: Partial<DingTalkOpenClawConfig>) => Promise<void>;
  showSecrets: Record<string, boolean>;
  setShowSecrets: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  status: IMGatewayStatus;
  renderConnectivityTestButton: (platform: IMPlatform) => React.ReactNode;
  renderPairingSection: (platform: string) => React.ReactNode;
}

const DingTalkConfig: React.FC<DingTalkConfigProps> = ({
  dtOpenClawConfig,
  handleDingTalkOpenClawChange,
  handleSaveDingTalkOpenClawConfig,
  showSecrets,
  setShowSecrets,
  status,
  renderConnectivityTestButton,
  renderPairingSection,
}) => {
  const [dingtalkAllowedUserIdInput, setDingtalkAllowedUserIdInput] = useState('');

  return (
          <div className="space-y-3">
            <PlatformGuide
              steps={[
                i18nService.t('imDingtalkGuideStep1'),
                i18nService.t('imDingtalkGuideStep2'),
                i18nService.t('imDingtalkGuideStep3'),
                i18nService.t('imDingtalkGuideStep4'),
              ]}
              guideUrl={IM_GUIDE_URLS.dingtalk}
            />
            {/* Client ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Client ID (AppKey)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={dtOpenClawConfig.clientId}
                  onChange={(e) => handleDingTalkOpenClawChange({ clientId: e.target.value })}
                  onBlur={() => handleSaveDingTalkOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="dingxxxxxx"
                />
                {dtOpenClawConfig.clientId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleDingTalkOpenClawChange({ clientId: '' }); void imService.persistConfig({ dingtalk: { ...dtOpenClawConfig, clientId: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Client Secret */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Client Secret (AppSecret)
              </label>
              <div className="relative">
                <input
                  type={showSecrets['dingtalk.clientSecret'] ? 'text' : 'password'}
                  value={dtOpenClawConfig.clientSecret}
                  onChange={(e) => handleDingTalkOpenClawChange({ clientSecret: e.target.value })}
                  onBlur={() => handleSaveDingTalkOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {dtOpenClawConfig.clientSecret && (
                    <button
                      type="button"
                      onClick={() => { handleDingTalkOpenClawChange({ clientSecret: '' }); void imService.persistConfig({ dingtalk: { ...dtOpenClawConfig, clientSecret: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'dingtalk.clientSecret': !prev['dingtalk.clientSecret'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['dingtalk.clientSecret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['dingtalk.clientSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
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
                    value={dtOpenClawConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as DingTalkOpenClawConfig['dmPolicy'] };
                      handleDingTalkOpenClawChange(update);
                      void handleSaveDingTalkOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">{i18nService.t('imDmPolicyOpen')}</option>
                    <option value="pairing">{i18nService.t('imDmPolicyPairing')}</option>
                    <option value="allowlist">{i18nService.t('imDmPolicyAllowlist')}</option>
                  </select>
                </div>

                {/* Pairing Requests (shown when dmPolicy is 'pairing') */}
                {dtOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('dingtalk')}

                {/* Allow From (User IDs) */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Allow From (User IDs)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={dingtalkAllowedUserIdInput}
                      onChange={(e) => setDingtalkAllowedUserIdInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const id = dingtalkAllowedUserIdInput.trim();
                          if (id && !dtOpenClawConfig.allowFrom.includes(id)) {
                            const newIds = [...dtOpenClawConfig.allowFrom, id];
                            handleDingTalkOpenClawChange({ allowFrom: newIds });
                            setDingtalkAllowedUserIdInput('');
                            void imService.persistConfig({ dingtalk: { ...dtOpenClawConfig, allowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('imDingtalkUserIdPlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const id = dingtalkAllowedUserIdInput.trim();
                        if (id && !dtOpenClawConfig.allowFrom.includes(id)) {
                          const newIds = [...dtOpenClawConfig.allowFrom, id];
                          handleDingTalkOpenClawChange({ allowFrom: newIds });
                          setDingtalkAllowedUserIdInput('');
                          void imService.persistConfig({ dingtalk: { ...dtOpenClawConfig, allowFrom: newIds } });
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {dtOpenClawConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {dtOpenClawConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = dtOpenClawConfig.allowFrom.filter((x) => x !== id);
                              handleDingTalkOpenClawChange({ allowFrom: newIds });
                              void imService.persistConfig({ dingtalk: { ...dtOpenClawConfig, allowFrom: newIds } });
                            }}
                            className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 transition-colors"
                          >
                            <XMarkIcon className="h-3 w-3" />
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
                    value={dtOpenClawConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as DingTalkOpenClawConfig['groupPolicy'] };
                      handleDingTalkOpenClawChange(update);
                      void handleSaveDingTalkOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">{i18nService.t('imGroupPolicyOpen')}</option>
                    <option value="allowlist">{i18nService.t('imGroupPolicyAllowlist')}</option>
                  </select>
                </div>

                {/* Session Timeout (deprecated) */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary opacity-60">
                    {i18nService.t('imSessionTimeout')}
                  </label>
                  <input
                    type="number"
                    value={Math.round(dtOpenClawConfig.sessionTimeout / 60000)}
                    onChange={(e) => {
                      const minutes = parseInt(e.target.value, 10);
                      if (!isNaN(minutes) && minutes > 0) {
                        handleDingTalkOpenClawChange({ sessionTimeout: minutes * 60000 });
                      }
                    }}
                    onBlur={() => handleSaveDingTalkOpenClawConfig()}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors opacity-60"
                    min="1"
                    placeholder="30"
                  />
                </div>

                {/* Separate Session by Conversation */}
                <label className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <input
                    type="checkbox"
                    checked={dtOpenClawConfig.separateSessionByConversation}
                    onChange={(e) => {
                      const update = { separateSessionByConversation: e.target.checked };
                      handleDingTalkOpenClawChange(update);
                      void handleSaveDingTalkOpenClawConfig(update);
                    }}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  <span>
                    {i18nService.t('imSeparateSessionByConversation')}
                    <span className="ml-1 opacity-60">— {i18nService.t('imSeparateSessionByConversationDesc')}</span>
                  </span>
                </label>

                {/* Group Session Scope (only visible when separateSessionByConversation is on) */}
                {dtOpenClawConfig.separateSessionByConversation && (
                  <div className="space-y-1.5 pl-4">
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('imGroupSessionScope')}
                    </label>
                    <select
                      value={dtOpenClawConfig.groupSessionScope}
                      onChange={(e) => {
                        const update = { groupSessionScope: e.target.value as 'group' | 'group_sender' };
                        handleDingTalkOpenClawChange(update);
                        void handleSaveDingTalkOpenClawConfig(update);
                      }}
                      className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                    >
                      <option value="group">{i18nService.t('imGroupSessionScopeGroup')}</option>
                      <option value="group_sender">{i18nService.t('imGroupSessionScopeGroupSender')}</option>
                    </select>
                  </div>
                )}

                {/* Shared Memory Across Conversations */}
                <label className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <input
                    type="checkbox"
                    checked={dtOpenClawConfig.sharedMemoryAcrossConversations}
                    onChange={(e) => {
                      const update = { sharedMemoryAcrossConversations: e.target.checked };
                      handleDingTalkOpenClawChange(update);
                      void handleSaveDingTalkOpenClawConfig(update);
                    }}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  <span>
                    {i18nService.t('imSharedMemoryAcrossConversations')}
                    <span className="ml-1 opacity-60">— {i18nService.t('imSharedMemoryAcrossConversationsDesc')}</span>
                  </span>
                </label>

                {/* Gateway Base URL */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('imGatewayBaseUrl')}
                  </label>
                  <input
                    type="text"
                    value={dtOpenClawConfig.gatewayBaseUrl}
                    onChange={(e) => {
                      handleDingTalkOpenClawChange({ gatewayBaseUrl: e.target.value });
                    }}
                    onBlur={() => handleSaveDingTalkOpenClawConfig()}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                    placeholder={i18nService.t('imGatewayBaseUrlPlaceholder')}
                  />
                </div>

                {/* Debug */}
                <label className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <input
                    type="checkbox"
                    checked={dtOpenClawConfig.debug}
                    onChange={(e) => {
                      const update = { debug: e.target.checked };
                      handleDingTalkOpenClawChange(update);
                      void handleSaveDingTalkOpenClawConfig(update);
                    }}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  {i18nService.t('imDebugMode')}
                </label>
              </div>
            </details>

            <div className="pt-1">
              {renderConnectivityTestButton('dingtalk')}
            </div>

            {/* Error display */}
            {status.dingtalk?.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.dingtalk?.lastError}
              </div>
            )}
          </div>
  );
};

export default DingTalkConfig;
