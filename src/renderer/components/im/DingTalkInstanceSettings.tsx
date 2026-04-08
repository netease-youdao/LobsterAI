/**
 * DingTalk Instance Settings Component
 * Configuration form for a single DingTalk bot instance in multi-instance mode
 */

import React, { useState } from 'react';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { SignalIcon, XMarkIcon } from '@heroicons/react/24/outline';
import TrashIcon from '../icons/TrashIcon';
import type { DingTalkInstanceConfig, DingTalkInstanceStatus, DingTalkOpenClawConfig, IMConnectivityTestResult } from '../../types/im';
import { i18nService } from '../../services/i18n';
import { PlatformRegistry } from '@shared/platform';

interface DingTalkInstanceSettingsProps {
  instance: DingTalkInstanceConfig;
  instanceStatus: DingTalkInstanceStatus | undefined;
  onConfigChange: (update: Partial<DingTalkOpenClawConfig>) => void;
  onSave: (override?: Partial<DingTalkOpenClawConfig>) => Promise<void>;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onTestConnectivity: () => void;
  testingPlatform: string | null;
  connectivityResults: Record<string, IMConnectivityTestResult>;
  language: 'zh' | 'en';
}

// Reusable guide card component for platform setup instructions
const PlatformGuide: React.FC<{
  steps: string[];
  guideUrl?: string;
}> = ({ steps, guideUrl }) => (
  <div className="mb-3 p-3 rounded-lg border border-dashed border-border-subtle">
    <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
    {guideUrl && (
      <button
        type="button"
        onClick={() => {
          window.electron.shell.openExternal(guideUrl).catch((err: unknown) => {
            console.error('[IM] Failed to open guide URL:', err);
          });
        }}
        className="mt-2 text-xs font-medium text-primary dark:text-primary hover:text-primary dark:hover:text-blue-200 underline underline-offset-2 transition-colors"
      >
        {i18nService.t('imViewGuide')}
      </button>
    )}
  </div>
);

// Pairing section component
const PairingSection: React.FC<{
  platform: string;
}> = ({ platform }) => {
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [pairingStatus, setPairingStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleApprovePairing = async (code: string) => {
    setPairingStatus(null);
    try {
      const result = await window.electron.im.approvePairingCode(platform, code);
      if (result.success) {
        setPairingStatus({ type: 'success', message: i18nService.t('imPairingCodeApproved').replace('{code}', code) });
      } else {
        setPairingStatus({ type: 'error', message: result.error || i18nService.t('imPairingCodeInvalid') });
      }
    } catch {
      setPairingStatus({ type: 'error', message: i18nService.t('imPairingCodeInvalid') });
    }
  };

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-secondary">
        {i18nService.t('imPairingApproval')}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={pairingCodeInput}
          onChange={(e) => {
            setPairingCodeInput(e.target.value.toUpperCase());
            if (pairingStatus) setPairingStatus(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const code = pairingCodeInput.trim();
              if (code) {
                void handleApprovePairing(code).then(() => {
                  setPairingCodeInput('');
                });
              }
            }
          }}
          className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm font-mono uppercase tracking-widest transition-colors"
          placeholder={i18nService.t('imPairingCodePlaceholder')}
          maxLength={8}
        />
        <button
          type="button"
          onClick={() => {
            const code = pairingCodeInput.trim();
            if (code) {
              void handleApprovePairing(code).then(() => {
                setPairingCodeInput('');
              });
            }
          }}
          className="px-3 py-2 rounded-lg text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400 hover:bg-green-500/25 transition-colors"
        >
          {i18nService.t('imPairingApprove')}
        </button>
      </div>
      {pairingStatus && (
        <p className={`text-xs ${pairingStatus.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {pairingStatus.type === 'success' ? '\u2713' : '\u2717'} {pairingStatus.message}
        </p>
      )}
    </div>
  );
};

const DingTalkInstanceSettings: React.FC<DingTalkInstanceSettingsProps> = ({
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
              src={PlatformRegistry.logo('dingtalk')}
              alt="DingTalk"
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
          disabled={!instance.enabled && !(instance.clientId && instance.clientSecret)}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            instance.enabled
              ? (instanceStatus?.connected ? 'bg-green-500' : 'bg-yellow-500')
              : 'bg-gray-400 dark:bg-gray-600'
          } ${!instance.enabled && !(instance.clientId && instance.clientSecret) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          title={instance.enabled
            ? (language === 'zh' ? '禁用此实例' : 'Disable this instance')
            : (!(instance.clientId && instance.clientSecret)
              ? i18nService.t('imInstanceFillCredentials')
              : (language === 'zh' ? '启用此实例' : 'Enable this instance'))}
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
          title={language === 'zh' ? '删除此实例' : 'Delete this instance'}
        >
          <TrashIcon className="h-4 w-4" />
          {language === 'zh' ? '删除' : 'Delete'}
        </button>
      </div>

      {/* Guide */}
      <PlatformGuide
        steps={[
          i18nService.t('imDingtalkGuideStep1'),
          i18nService.t('imDingtalkGuideStep2'),
          i18nService.t('imDingtalkGuideStep3'),
          i18nService.t('imDingtalkGuideStep4'),
        ]}
        guideUrl={PlatformRegistry.guideUrl('dingtalk')}
      />

      {/* Client ID (AppKey) */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">
          Client ID (AppKey)
        </label>
        <div className="relative">
          <input
            type="text"
            value={instance.clientId}
            onChange={(e) => onConfigChange({ clientId: e.target.value })}
            onBlur={() => void onSave()}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
            placeholder="dingxxxxxx"
          />
          {instance.clientId && (
            <div className="absolute right-2 inset-y-0 flex items-center">
              <button
                type="button"
                onClick={() => { onConfigChange({ clientId: '' }); void onSave({ clientId: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Client Secret (AppSecret) */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">
          Client Secret (AppSecret)
        </label>
        <div className="relative">
          <input
            type={showSecrets['clientSecret'] ? 'text' : 'password'}
            value={instance.clientSecret}
            onChange={(e) => onConfigChange({ clientSecret: e.target.value })}
            onBlur={() => void onSave()}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
            placeholder="••••••••••••"
          />
          <div className="absolute right-2 inset-y-0 flex items-center gap-1">
            {instance.clientSecret && (
              <button
                type="button"
                onClick={() => { onConfigChange({ clientSecret: '' }); void onSave({ clientSecret: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSecrets(prev => ({ ...prev, 'clientSecret': !prev['clientSecret'] }))}
              className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
              title={showSecrets['clientSecret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
            >
              {showSecrets['clientSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
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
                const update = { dmPolicy: e.target.value as DingTalkOpenClawConfig['dmPolicy'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="open">{i18nService.t('imDmPolicyOpen')}</option>
              <option value="pairing">{i18nService.t('imDmPolicyPairing')}</option>
              <option value="allowlist">{i18nService.t('imDmPolicyAllowlist')}</option>
            </select>
          </div>

          {/* Pairing Requests (shown when dmPolicy is 'pairing') */}
          {instance.dmPolicy === 'pairing' && (
            <PairingSection platform="dingtalk" />
          )}

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
                placeholder={i18nService.t('imDingtalkUserIdPlaceholder')}
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
                const update = { groupPolicy: e.target.value as DingTalkOpenClawConfig['groupPolicy'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="open">{i18nService.t('imGroupPolicyOpen')}</option>
              <option value="allowlist">{i18nService.t('imGroupPolicyAllowlist')}</option>
            </select>
          </div>

          {/* Session Timeout (deprecated) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary opacity-60">
              {i18nService.t('imSessionTimeout')}
            </label>
            <input
              type="number"
              value={Math.round(instance.sessionTimeout / 60000)}
              onChange={(e) => {
                const minutes = parseInt(e.target.value, 10);
                if (!isNaN(minutes) && minutes > 0) {
                  onConfigChange({ sessionTimeout: minutes * 60000 });
                }
              }}
              onBlur={() => void onSave()}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors opacity-60"
              min="1"
              placeholder="30"
            />
          </div>

          {/* Separate Session by Conversation */}
          <label className="flex items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={instance.separateSessionByConversation}
              onChange={(e) => {
                const update = { separateSessionByConversation: e.target.checked };
                onConfigChange(update);
                void onSave(update);
              }}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            <span>
              {i18nService.t('imSeparateSessionByConversation')}
              <span className="ml-1 opacity-60">— {i18nService.t('imSeparateSessionByConversationDesc')}</span>
            </span>
          </label>

          {/* Group Session Scope (only visible when separateSessionByConversation is on) */}
          {instance.separateSessionByConversation && (
            <div className="space-y-1.5 pl-4">
              <label className="block text-xs font-medium text-secondary">
                {i18nService.t('imGroupSessionScope')}
              </label>
              <select
                value={instance.groupSessionScope}
                onChange={(e) => {
                  const update = { groupSessionScope: e.target.value as 'group' | 'group_sender' };
                  onConfigChange(update);
                  void onSave(update);
                }}
                className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
              >
                <option value="group">{i18nService.t('imGroupSessionScopeGroup')}</option>
                <option value="group_sender">{i18nService.t('imGroupSessionScopeGroupSender')}</option>
              </select>
            </div>
          )}

          {/* Shared Memory Across Conversations */}
          <label className="flex items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={instance.sharedMemoryAcrossConversations}
              onChange={(e) => {
                const update = { sharedMemoryAcrossConversations: e.target.checked };
                onConfigChange(update);
                void onSave(update);
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
            <label className="block text-xs font-medium text-secondary">
              {i18nService.t('imGatewayBaseUrl')}
            </label>
            <input
              type="text"
              value={instance.gatewayBaseUrl}
              onChange={(e) => {
                onConfigChange({ gatewayBaseUrl: e.target.value });
              }}
              onBlur={() => void onSave()}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
              placeholder={i18nService.t('imGatewayBaseUrlPlaceholder')}
            />
          </div>

          {/* Debug */}
          <label className="flex items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={instance.debug}
              onChange={(e) => {
                const update = { debug: e.target.checked };
                onConfigChange(update);
                void onSave(update);
              }}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            {i18nService.t('imDebugMode')}
          </label>
        </div>
      </details>

      {/* Connectivity test button */}
      <div className="pt-1">
        <button
          type="button"
          onClick={onTestConnectivity}
          disabled={testingPlatform === 'dingtalk'}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
        >
          <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
          {testingPlatform === 'dingtalk'
            ? i18nService.t('imConnectivityTesting')
            : connectivityResults['dingtalk' as keyof typeof connectivityResults]
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

export default DingTalkInstanceSettings;
