/**
 * Feishu platform configuration component.
 * Extracted from IMSettings.tsx to reduce file size.
 */
import React, { useState } from 'react';
import { XMarkIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { QRCodeSVG } from 'qrcode.react';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import type { IMPlatform, FeishuOpenClawConfig, IMGatewayStatus } from '../../types/im';
import { PlatformGuide, IM_GUIDE_URLS } from './imSettingsShared';

export interface FeishuConfigProps {
  fsOpenClawConfig: FeishuOpenClawConfig;
  handleFeishuOpenClawChange: (update: Partial<FeishuOpenClawConfig>) => void;
  handleSaveFeishuOpenClawConfig: (override?: Partial<FeishuOpenClawConfig>) => Promise<void>;
  showSecrets: Record<string, boolean>;
  setShowSecrets: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  status: IMGatewayStatus;
  renderConnectivityTestButton: (platform: IMPlatform) => React.ReactNode;
  renderPairingSection: (platform: string) => React.ReactNode;
  // QR code props
  feishuQrStatus: 'idle' | 'loading' | 'showing' | 'success' | 'error';
  feishuQrUrl: string;
  feishuQrTimeLeft: number;
  feishuQrError: string;
  handleFeishuStartQr: () => Promise<void>;
}

const FeishuConfig: React.FC<FeishuConfigProps> = ({
  fsOpenClawConfig,
  handleFeishuOpenClawChange,
  handleSaveFeishuOpenClawConfig,
  showSecrets,
  setShowSecrets,
  status,
  renderConnectivityTestButton,
  renderPairingSection,
  feishuQrStatus,
  feishuQrUrl,
  feishuQrTimeLeft,
  feishuQrError,
  handleFeishuStartQr,
}) => {
  const [feishuAllowedUserIdInput, setFeishuAllowedUserIdInput] = useState('');
  const [feishuGroupAllowIdInput, setFeishuGroupAllowIdInput] = useState('');

  return (
          <div className="space-y-3">
            {/* Scan QR code section */}
            <div className="rounded-lg border border-dashed dark:border-claude-darkBorder/60 border-claude-border/60 p-4 text-center space-y-3">
              {(feishuQrStatus === 'idle' || feishuQrStatus === 'error') && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleFeishuStartQr()}
                    className="px-4 py-2.5 rounded-lg text-sm font-medium bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {i18nService.t('feishuBotCreateWizardScanBtn')}
                  </button>
                  <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('feishuBotCreateWizardScanHint')}
                  </p>
                  {feishuQrStatus === 'error' && feishuQrError && (
                    <div className="flex items-center justify-center gap-1.5 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                      <XCircleIcon className="h-4 w-4 flex-shrink-0" />
                      {feishuQrError}
                    </div>
                  )}
                </>
              )}
              {feishuQrStatus === 'loading' && (
                <div className="flex flex-col items-center gap-2 py-2">
                  <ArrowPathIcon className="h-7 w-7 text-claude-accent animate-spin" />
                  <span className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">正在生成二维码…</span>
                </div>
              )}
              {feishuQrStatus === 'showing' && feishuQrUrl && (
                <div className="flex flex-col items-center gap-2">
                  <div className="p-2 bg-white rounded-lg inline-block">
                    <QRCodeSVG value={feishuQrUrl} size={160} />
                  </div>
                  <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary max-w-[240px]">
                    {i18nService.t('feishuBotCreateWizardQrcodeDesc')}
                  </p>
                  <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {feishuQrTimeLeft}s
                  </p>
                </div>
              )}
              {feishuQrStatus === 'success' && (
                <div className="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                  <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                  {i18nService.t('feishuBotCreateWizardSuccessTitle')}
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="relative flex items-center">
              <div className="flex-1 border-t dark:border-claude-darkBorder/40 border-claude-border/40" />
              <span className="px-3 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary whitespace-nowrap">
                {i18nService.t('feishuBotCreateWizardOrManual')}
              </span>
              <div className="flex-1 border-t dark:border-claude-darkBorder/40 border-claude-border/40" />
            </div>

            {/* Manual guide */}
            <PlatformGuide
              steps={[
                i18nService.t('imFeishuGuideStep1'),
                i18nService.t('imFeishuGuideStep2'),
              ]}
              guideUrl={IM_GUIDE_URLS.feishu}
            />
            {/* App ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                App ID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={fsOpenClawConfig.appId}
                  onChange={(e) => handleFeishuOpenClawChange({ appId: e.target.value })}
                  onBlur={() => handleSaveFeishuOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="cli_xxxxx"
                />
                {fsOpenClawConfig.appId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleFeishuOpenClawChange({ appId: '' }); void imService.persistConfig({ feishu: { ...fsOpenClawConfig, appId: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* App Secret */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                App Secret
              </label>
              <div className="relative">
                <input
                  type={showSecrets['feishu.appSecret'] ? 'text' : 'password'}
                  value={fsOpenClawConfig.appSecret}
                  onChange={(e) => handleFeishuOpenClawChange({ appSecret: e.target.value })}
                  onBlur={() => handleSaveFeishuOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {fsOpenClawConfig.appSecret && (
                    <button
                      type="button"
                      onClick={() => { handleFeishuOpenClawChange({ appSecret: '' }); void imService.persistConfig({ feishu: { ...fsOpenClawConfig, appSecret: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'feishu.appSecret': !prev['feishu.appSecret'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['feishu.appSecret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['feishu.appSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Domain */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Domain
              </label>
              <select
                value={fsOpenClawConfig.domain}
                onChange={(e) => {
                  const update = { domain: e.target.value };
                  handleFeishuOpenClawChange(update);
                  void handleSaveFeishuOpenClawConfig(update);
                }}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              >
                <option value="feishu">{i18nService.t('imFeishuDomainFeishu')}</option>
                <option value="lark">{i18nService.t('imFeishuDomainLark')}</option>
              </select>
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
                    value={fsOpenClawConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as FeishuOpenClawConfig['dmPolicy'] };
                      handleFeishuOpenClawChange(update);
                      void handleSaveFeishuOpenClawConfig(update);
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
                {fsOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('feishu')}

                {/* Allow From (User IDs) */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Allow From (User IDs)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={feishuAllowedUserIdInput}
                      onChange={(e) => setFeishuAllowedUserIdInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const id = feishuAllowedUserIdInput.trim();
                          if (id && !fsOpenClawConfig.allowFrom.includes(id)) {
                            const newIds = [...fsOpenClawConfig.allowFrom, id];
                            handleFeishuOpenClawChange({ allowFrom: newIds });
                            setFeishuAllowedUserIdInput('');
                            void imService.persistConfig({ feishu: { ...fsOpenClawConfig, allowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('imFeishuUserIdPlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const id = feishuAllowedUserIdInput.trim();
                        if (id && !fsOpenClawConfig.allowFrom.includes(id)) {
                          const newIds = [...fsOpenClawConfig.allowFrom, id];
                          handleFeishuOpenClawChange({ allowFrom: newIds });
                          setFeishuAllowedUserIdInput('');
                          void imService.persistConfig({ feishu: { ...fsOpenClawConfig, allowFrom: newIds } });
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {fsOpenClawConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {fsOpenClawConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = fsOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                              handleFeishuOpenClawChange({ allowFrom: newIds });
                              void imService.persistConfig({ feishu: { ...fsOpenClawConfig, allowFrom: newIds } });
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
                    value={fsOpenClawConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as FeishuOpenClawConfig['groupPolicy'] };
                      handleFeishuOpenClawChange(update);
                      void handleSaveFeishuOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="allowlist">Allowlist</option>
                    <option value="open">Open</option>
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
                      value={feishuGroupAllowIdInput}
                      onChange={(e) => setFeishuGroupAllowIdInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const id = feishuGroupAllowIdInput.trim();
                          if (id && !fsOpenClawConfig.groupAllowFrom.includes(id)) {
                            const newIds = [...fsOpenClawConfig.groupAllowFrom, id];
                            handleFeishuOpenClawChange({ groupAllowFrom: newIds });
                            setFeishuGroupAllowIdInput('');
                            void imService.persistConfig({ feishu: { ...fsOpenClawConfig, groupAllowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('imFeishuChatIdPlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const id = feishuGroupAllowIdInput.trim();
                        if (id && !fsOpenClawConfig.groupAllowFrom.includes(id)) {
                          const newIds = [...fsOpenClawConfig.groupAllowFrom, id];
                          handleFeishuOpenClawChange({ groupAllowFrom: newIds });
                          setFeishuGroupAllowIdInput('');
                          void imService.persistConfig({ feishu: { ...fsOpenClawConfig, groupAllowFrom: newIds } });
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {fsOpenClawConfig.groupAllowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {fsOpenClawConfig.groupAllowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = fsOpenClawConfig.groupAllowFrom.filter((gid) => gid !== id);
                              handleFeishuOpenClawChange({ groupAllowFrom: newIds });
                              void imService.persistConfig({ feishu: { ...fsOpenClawConfig, groupAllowFrom: newIds } });
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

                {/* Reply Mode */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Reply Mode
                  </label>
                  <select
                    value={fsOpenClawConfig.replyMode}
                    onChange={(e) => {
                      const update = { replyMode: e.target.value as FeishuOpenClawConfig['replyMode'] };
                      handleFeishuOpenClawChange(update);
                      void handleSaveFeishuOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="auto">{i18nService.t('imReplyModeAuto')}</option>
                    <option value="static">{i18nService.t('imReplyModeStatic')}</option>
                    <option value="streaming">{i18nService.t('imReplyModeStreaming')}</option>
                  </select>
                </div>

                {/* History Limit */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    History Limit
                  </label>
                  <input
                    type="number"
                    value={fsOpenClawConfig.historyLimit}
                    onChange={(e) => handleFeishuOpenClawChange({ historyLimit: parseInt(e.target.value) || 50 })}
                    onBlur={() => handleSaveFeishuOpenClawConfig()}
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
                    value={fsOpenClawConfig.mediaMaxMb}
                    onChange={(e) => handleFeishuOpenClawChange({ mediaMaxMb: parseInt(e.target.value) || 30 })}
                    onBlur={() => handleSaveFeishuOpenClawConfig()}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                    min="1"
                    max="50"
                  />
                </div>
              </div>
            </details>

            <div className="pt-1">
              {renderConnectivityTestButton('feishu')}
            </div>

            {/* Error display */}
            {status.feishu?.error && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.feishu?.error}
              </div>
            )}

          </div>

  );
};

export default FeishuConfig;
