/**
 * WeCom Instance Settings Component
 * Configuration form for a single WeCom bot instance in multi-instance mode
 */

import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { CheckCircleIcon, SignalIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { PlatformRegistry } from '@shared/platform';
import React, { useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { IMConnectivityTestResult,WecomInstanceConfig, WecomInstanceStatus, WecomOpenClawConfig } from '../../types/im';
import TrashIcon from '../icons/TrashIcon';

interface WecomInstanceSettingsProps {
  instance: WecomInstanceConfig;
  instanceStatus: WecomInstanceStatus | undefined;
  onConfigChange: (update: Partial<WecomOpenClawConfig>) => void;
  onSave: (override?: Partial<WecomOpenClawConfig>) => Promise<void>;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onTestConnectivity: () => void;
  onQuickSetup: () => void;
  quickSetupStatus: 'idle' | 'pending' | 'success' | 'error';
  quickSetupError: string;
  testingPlatform: string | null;
  connectivityResults: Record<string, IMConnectivityTestResult>;
  language: 'zh' | 'en';
  renderPairingSection: (platform: string) => React.ReactNode;
}

const WecomInstanceSettings: React.FC<WecomInstanceSettingsProps> = ({
  instance,
  instanceStatus,
  onConfigChange,
  onSave,
  onRename,
  onDelete,
  onToggleEnabled,
  onTestConnectivity,
  onQuickSetup,
  quickSetupStatus,
  quickSetupError,
  testingPlatform,
  connectivityResults,
  language,
  renderPairingSection,
}) => {
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [allowedUserIdInput, setAllowedUserIdInput] = useState('');
  const [groupAllowInput, setGroupAllowInput] = useState('');
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

  return (
    <div className="space-y-3">
      {/* Instance Header: Name, Status, Enable Toggle, Delete */}
      <div className="flex items-center gap-3 pb-3 border-b border-border-subtle">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-surface border border-border-subtle p-1">
            <img
              src={PlatformRegistry.logo('wecom')}
              alt="WeCom"
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
              title={language === 'zh' ? '点击重命名' : 'Click to rename'}
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
          disabled={!instance.enabled && !(instance.botId && instance.secret)}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            instance.enabled
              ? (instanceStatus?.connected ? 'bg-green-500' : 'bg-yellow-500')
              : 'bg-gray-400 dark:bg-gray-600'
          } ${!instance.enabled && !(instance.botId && instance.secret) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          title={instance.enabled ? (language === 'zh' ? '禁用' : 'Disable') : (!(instance.botId && instance.secret) ? i18nService.t('imInstanceFillCredentials') : (language === 'zh' ? '启用' : 'Enable'))}
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
          title={language === 'zh' ? '删除实例' : 'Delete instance'}
        >
          <TrashIcon className="h-4 w-4" />
          {language === 'zh' ? '删除' : 'Delete'}
        </button>
      </div>

      {/* Quick Setup via QR Code */}
      <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center space-y-2">
        <button
          type="button"
          disabled={quickSetupStatus === 'pending'}
          onClick={onQuickSetup}
          className="px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {quickSetupStatus === 'pending'
            ? i18nService.t('imWecomQuickSetupPending')
            : i18nService.t('imWecomScanBtn')}
        </button>
        <p className="text-xs text-secondary">
          {i18nService.t('imWecomScanHint')}
        </p>
        {quickSetupStatus === 'success' && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
            <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
            {i18nService.t('imWecomQuickSetupSuccess')}
          </div>
        )}
        {quickSetupStatus === 'error' && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
            <XCircleIcon className="h-4 w-4 flex-shrink-0" />
            {i18nService.t('imWecomQuickSetupError')}: {quickSetupError}
          </div>
        )}
      </div>

      {/* Divider with "or manually enter" */}
      <div className="relative flex items-center">
        <div className="flex-1 border-t border-border-subtle" />
        <span className="px-3 text-xs text-secondary whitespace-nowrap">
          {i18nService.t('imWecomOrManual')}
        </span>
        <div className="flex-1 border-t border-border-subtle" />
      </div>

      {/* Guide */}
      <div className="mb-3 p-3 rounded-lg border border-dashed border-border-subtle">
        <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
          <li>{i18nService.t('imWecomGuideStep1')}</li>
          <li>{i18nService.t('imWecomGuideStep2')}</li>
          <li>{i18nService.t('imWecomGuideStep3')}</li>
        </ol>
        {PlatformRegistry.guideUrl('wecom') && (
          <button
            type="button"
            onClick={() => {
              window.electron.shell.openExternal(PlatformRegistry.guideUrl('wecom')!).catch((err: unknown) => {
                console.error('[IM] Failed to open guide URL:', err);
              });
            }}
            className="mt-2 text-xs font-medium text-primary dark:text-primary hover:text-primary dark:hover:text-blue-200 underline underline-offset-2 transition-colors"
          >
            {i18nService.t('imViewGuide')}
          </button>
        )}
      </div>

      {/* Bot ID */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">
          Bot ID
        </label>
        <div className="relative">
          <input
            type="text"
            value={instance.botId}
            onChange={(e) => onConfigChange({ botId: e.target.value })}
            onBlur={() => void onSave()}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
            placeholder={i18nService.t('imWecomBotIdPlaceholder')}
          />
          {instance.botId && (
            <div className="absolute right-2 inset-y-0 flex items-center">
              <button
                type="button"
                onClick={() => { onConfigChange({ botId: '' }); void onSave({ botId: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Secret */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">
          Secret
        </label>
        <div className="relative">
          <input
            type={showSecrets['secret'] ? 'text' : 'password'}
            value={instance.secret}
            onChange={(e) => onConfigChange({ secret: e.target.value })}
            onBlur={() => void onSave()}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
            placeholder="••••••••••••"
          />
          <div className="absolute right-2 inset-y-0 flex items-center gap-1">
            {instance.secret && (
              <button
                type="button"
                onClick={() => { onConfigChange({ secret: '' }); void onSave({ secret: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSecrets(prev => ({ ...prev, 'secret': !prev['secret'] }))}
              className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
              title={showSecrets['secret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
            >
              {showSecrets['secret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-secondary">
          {i18nService.t('imWecomCredentialHint')}
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
                const update = { dmPolicy: e.target.value as WecomOpenClawConfig['dmPolicy'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="open">{i18nService.t('imDmPolicyOpen')}</option>
              <option value="pairing">{i18nService.t('imDmPolicyPairing')}</option>
              <option value="allowlist">{i18nService.t('imDmPolicyAllowlist')}</option>
              <option value="disabled">{i18nService.t('imDmPolicyDisabled')}</option>
            </select>
          </div>

          {/* Pairing Requests (shown when dmPolicy is 'pairing') */}
          {instance.dmPolicy === 'pairing' && renderPairingSection('wecom')}

          {/* Allow From */}
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
                placeholder={i18nService.t('imWecomUserIdPlaceholder')}
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
                const update = { groupPolicy: e.target.value as WecomOpenClawConfig['groupPolicy'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="open">Open</option>
              <option value="allowlist">Allowlist</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          {/* Group Allow From */}
          {instance.groupPolicy === 'allowlist' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">
                Group Allow From (Group IDs)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={groupAllowInput}
                  onChange={(e) => setGroupAllowInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const id = groupAllowInput.trim();
                      if (id && !instance.groupAllowFrom.includes(id)) {
                        const newIds = [...instance.groupAllowFrom, id];
                        onConfigChange({ groupAllowFrom: newIds });
                        setGroupAllowInput('');
                        void onSave({ groupAllowFrom: newIds });
                      }
                    }
                  }}
                  className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  placeholder={language === 'zh' ? '输入群ID' : 'Enter Group ID'}
                />
                <button
                  type="button"
                  onClick={() => {
                    const id = groupAllowInput.trim();
                    if (id && !instance.groupAllowFrom.includes(id)) {
                      const newIds = [...instance.groupAllowFrom, id];
                      onConfigChange({ groupAllowFrom: newIds });
                      setGroupAllowInput('');
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

          {/* Send Thinking Message */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-secondary">
              {i18nService.t('imSendThinkingMessage')}
            </label>
            <button
              type="button"
              onClick={() => {
                const update = { sendThinkingMessage: !instance.sendThinkingMessage };
                onConfigChange(update);
                void onSave(update);
              }}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                instance.sendThinkingMessage ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                instance.sendThinkingMessage ? 'translate-x-4' : 'translate-x-0'
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
          disabled={testingPlatform === 'wecom'}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
        >
          <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
          {testingPlatform === 'wecom'
            ? i18nService.t('imConnectivityTesting')
            : connectivityResults['wecom' as keyof typeof connectivityResults]
              ? i18nService.t('imConnectivityRetest')
              : i18nService.t('imConnectivityTest')}
        </button>
      </div>

      {/* Error display */}
      {instanceStatus?.lastError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {instanceStatus.lastError}
        </div>
      )}
    </div>
  );
};

export default WecomInstanceSettings;
