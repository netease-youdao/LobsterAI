/**
 * Feishu Instance Settings Component
 * Configuration form for a single Feishu bot instance in multi-instance mode
 */

import React, { useState, useRef, useEffect } from 'react';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { ArrowPathIcon, CheckCircleIcon, SignalIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import TrashIcon from '../icons/TrashIcon';
import { QRCodeSVG } from 'qrcode.react';
import type { FeishuInstanceConfig, FeishuInstanceStatus, FeishuOpenClawConfig, IMConnectivityTestResult } from '../../types/im';
import { i18nService } from '../../services/i18n';
import { PlatformRegistry } from '@shared/platform';

interface FeishuInstanceSettingsProps {
  instance: FeishuInstanceConfig;
  instanceStatus: FeishuInstanceStatus | undefined;
  onConfigChange: (update: Partial<FeishuOpenClawConfig>) => void;
  onSave: (override?: Partial<FeishuOpenClawConfig>) => Promise<void>;
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

const FeishuInstanceSettings: React.FC<FeishuInstanceSettingsProps> = ({
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
  const [groupAllowIdInput, setGroupAllowIdInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(instance.instanceName);

  // QR code scanning state
  const [qrStatus, setQrStatus] = useState<'idle' | 'loading' | 'showing' | 'success' | 'error'>('idle');
  const [qrUrl, setQrUrl] = useState('');
  const [qrTimeLeft, setQrTimeLeft] = useState(0);
  const [qrError, setQrError] = useState('');
  const qrDeviceCodeRef = useRef('');
  const qrPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (qrPollTimerRef.current) clearInterval(qrPollTimerRef.current);
      if (qrCountdownTimerRef.current) clearInterval(qrCountdownTimerRef.current);
    };
  }, []);

  const handleStartQr = async () => {
    if (qrPollTimerRef.current) clearInterval(qrPollTimerRef.current);
    if (qrCountdownTimerRef.current) clearInterval(qrCountdownTimerRef.current);
    setQrStatus('loading');
    setQrError('');
    try {
      const result = await window.electron.feishu.install.qrcode(false);
      if (!isMountedRef.current) return;
      setQrUrl(result.url);
      qrDeviceCodeRef.current = result.deviceCode;
      const expireIn = (result as any).expireIn ?? 300;
      setQrTimeLeft(expireIn);
      setQrStatus('showing');

      qrCountdownTimerRef.current = setInterval(() => {
        setQrTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(qrCountdownTimerRef.current!);
            qrCountdownTimerRef.current = null;
            if (qrPollTimerRef.current) { clearInterval(qrPollTimerRef.current); qrPollTimerRef.current = null; }
            setQrStatus('error');
            setQrError(i18nService.t('feishuBotCreateWizardQrcodeExpired'));
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      const intervalMs = Math.max((result as any).interval ?? 5, 3) * 1000;
      qrPollTimerRef.current = setInterval(async () => {
        try {
          const pollResult = await window.electron.feishu.install.poll(qrDeviceCodeRef.current);
          if (!isMountedRef.current) return;
          if (pollResult.done && pollResult.appId && pollResult.appSecret) {
            clearInterval(qrPollTimerRef.current!); qrPollTimerRef.current = null;
            clearInterval(qrCountdownTimerRef.current!); qrCountdownTimerRef.current = null;
            onConfigChange({ appId: pollResult.appId, appSecret: pollResult.appSecret, enabled: true });
            await onSave({ appId: pollResult.appId, appSecret: pollResult.appSecret, enabled: true });
            setQrStatus('success');
          } else if (pollResult.error && pollResult.error !== 'authorization_pending' && pollResult.error !== 'slow_down') {
            clearInterval(qrPollTimerRef.current!); qrPollTimerRef.current = null;
            clearInterval(qrCountdownTimerRef.current!); qrCountdownTimerRef.current = null;
            setQrStatus('error');
            setQrError(pollResult.error);
          }
        } catch { /* keep retrying */ }
      }, intervalMs);
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setQrStatus('error');
      setQrError(err?.message || '获取二维码失败');
    }
  };

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
              src={PlatformRegistry.logo('feishu')}
              alt="Feishu"
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
          disabled={!instance.enabled && !(instance.appId && instance.appSecret)}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            instance.enabled
              ? (instanceStatus?.connected ? 'bg-green-500' : 'bg-yellow-500')
              : 'bg-gray-400 dark:bg-gray-600'
          } ${!instance.enabled && !(instance.appId && instance.appSecret) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          title={instance.enabled
            ? (language === 'zh' ? '禁用此实例' : 'Disable this instance')
            : (!(instance.appId && instance.appSecret)
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

      {/* Scan QR code section */}
      <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center space-y-3">
        {(qrStatus === 'idle' || qrStatus === 'error') && (
          <>
            <button
              type="button"
              onClick={() => void handleStartQr()}
              className="px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {i18nService.t('feishuBotCreateWizardScanBtn')}
            </button>
            <p className="text-xs text-secondary">
              {i18nService.t('feishuBotCreateWizardScanHint')}
            </p>
            {qrStatus === 'error' && qrError && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                <XCircleIcon className="h-4 w-4 flex-shrink-0" />
                {qrError}
              </div>
            )}
          </>
        )}
        {qrStatus === 'loading' && (
          <div className="flex flex-col items-center gap-2 py-2">
            <ArrowPathIcon className="h-7 w-7 text-primary animate-spin" />
            <span className="text-xs text-secondary">{i18nService.t('feishuBotCreateWizardGenerating') || '正在生成二维码…'}</span>
          </div>
        )}
        {qrStatus === 'showing' && qrUrl && (
          <div className="flex flex-col items-center gap-2">
            <div className="p-2 bg-white rounded-lg inline-block">
              <QRCodeSVG value={qrUrl} size={160} />
            </div>
            <p className="text-xs text-secondary max-w-[240px]">
              {i18nService.t('feishuBotCreateWizardQrcodeDesc')}
            </p>
            <p className="text-xs text-secondary">
              {qrTimeLeft}s
            </p>
          </div>
        )}
        {qrStatus === 'success' && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
            <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
            {i18nService.t('feishuBotCreateWizardSuccessTitle')}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="relative flex items-center">
        <div className="flex-1 border-t border-border-subtle" />
        <span className="px-3 text-xs text-secondary whitespace-nowrap">
          {i18nService.t('feishuBotCreateWizardOrManual') || i18nService.t('or') || '或'}
        </span>
        <div className="flex-1 border-t border-border-subtle" />
      </div>

      {/* Guide */}
      <PlatformGuide
        steps={[
          i18nService.t('imFeishuGuideStep1'),
          i18nService.t('imFeishuGuideStep2'),
        ]}
        guideUrl={PlatformRegistry.guideUrl('feishu')}
      />

      {/* App ID */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">
          App ID
        </label>
        <div className="relative">
          <input
            type="text"
            value={instance.appId}
            onChange={(e) => onConfigChange({ appId: e.target.value })}
            onBlur={() => void onSave()}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
            placeholder="cli_xxxxx"
          />
          {instance.appId && (
            <div className="absolute right-2 inset-y-0 flex items-center">
              <button
                type="button"
                onClick={() => { onConfigChange({ appId: '' }); void onSave({ appId: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
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
        <label className="block text-xs font-medium text-secondary">
          App Secret
        </label>
        <div className="relative">
          <input
            type={showSecrets['appSecret'] ? 'text' : 'password'}
            value={instance.appSecret}
            onChange={(e) => onConfigChange({ appSecret: e.target.value })}
            onBlur={() => void onSave()}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
            placeholder="••••••••••••"
          />
          <div className="absolute right-2 inset-y-0 flex items-center gap-1">
            {instance.appSecret && (
              <button
                type="button"
                onClick={() => { onConfigChange({ appSecret: '' }); void onSave({ appSecret: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSecrets(prev => ({ ...prev, 'appSecret': !prev['appSecret'] }))}
              className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
              title={showSecrets['appSecret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
            >
              {showSecrets['appSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Domain */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">
          Domain
        </label>
        <select
          value={instance.domain}
          onChange={(e) => {
            const update = { domain: e.target.value };
            onConfigChange(update);
            void onSave(update);
          }}
          className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
        >
          <option value="feishu">{i18nService.t('imFeishuDomainFeishu')}</option>
          <option value="lark">{i18nService.t('imFeishuDomainLark')}</option>
        </select>
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
                const update = { dmPolicy: e.target.value as FeishuOpenClawConfig['dmPolicy'] };
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

          {/* Pairing Requests (shown when dmPolicy is 'pairing') */}
          {instance.dmPolicy === 'pairing' && (
            <PairingSection platform="feishu" />
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
                placeholder={i18nService.t('imFeishuUserIdPlaceholder')}
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
                const update = { groupPolicy: e.target.value as FeishuOpenClawConfig['groupPolicy'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="allowlist">Allowlist</option>
              <option value="open">Open</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          {/* Group Allow From */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              Group Allow From (Chat IDs)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={groupAllowIdInput}
                onChange={(e) => setGroupAllowIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const id = groupAllowIdInput.trim();
                    if (id && !instance.groupAllowFrom.includes(id)) {
                      const newIds = [...instance.groupAllowFrom, id];
                      onConfigChange({ groupAllowFrom: newIds });
                      setGroupAllowIdInput('');
                      void onSave({ groupAllowFrom: newIds });
                    }
                  }
                }}
                className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imFeishuChatIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = groupAllowIdInput.trim();
                  if (id && !instance.groupAllowFrom.includes(id)) {
                    const newIds = [...instance.groupAllowFrom, id];
                    onConfigChange({ groupAllowFrom: newIds });
                    setGroupAllowIdInput('');
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

          {/* Streaming Output Toggle */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-xs font-medium text-secondary">
                  {i18nService.t('imFeishuStreaming')}
                </label>
                <p className="text-[11px] text-tertiary mt-0.5">
                  {i18nService.t('imFeishuStreamingDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const update = { streaming: !instance.streaming };
                  onConfigChange(update);
                  void onSave(update);
                }}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer ${
                  instance.streaming ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                }`}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  instance.streaming ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
            </div>
          </div>

          {/* Footer Options (visible when streaming is enabled) */}
          {instance.streaming && (
            <div className="space-y-2 pl-3 border-l-2 border-primary/20">
              <div className="flex items-center justify-between">
                <label className="text-xs text-secondary">
                  {i18nService.t('imFeishuFooterStatus')}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const newFooter = { ...instance.footer, status: !instance.footer?.status };
                    const update = { footer: newFooter };
                    onConfigChange(update);
                    void onSave(update);
                  }}
                  className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer ${
                    instance.footer?.status ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    instance.footer?.status ? 'translate-x-3' : 'translate-x-0'
                  }`} />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-secondary">
                  {i18nService.t('imFeishuFooterElapsed')}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const newFooter = { ...instance.footer, elapsed: !instance.footer?.elapsed };
                    const update = { footer: newFooter };
                    onConfigChange(update);
                    void onSave(update);
                  }}
                  className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer ${
                    instance.footer?.elapsed ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    instance.footer?.elapsed ? 'translate-x-3' : 'translate-x-0'
                  }`} />
                </button>
              </div>
            </div>
          )}

          {/* Reply Mode */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              Reply Mode
            </label>
            <select
              value={instance.replyMode}
              onChange={(e) => {
                const update = { replyMode: e.target.value as FeishuOpenClawConfig['replyMode'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="auto">{i18nService.t('imReplyModeAuto')}</option>
              <option value="static">{i18nService.t('imReplyModeStatic')}</option>
              <option value="streaming">{i18nService.t('imReplyModeStreaming')}</option>
            </select>
          </div>

          {/* Block Streaming */}
          {instance.replyMode !== 'streaming' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-xs font-medium text-secondary">
                    {i18nService.t('imFeishuBlockStreaming')}
                  </label>
                  <p className="text-[11px] text-tertiary mt-0.5">
                    {i18nService.t('imFeishuBlockStreamingDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const update = { blockStreaming: !instance.blockStreaming };
                    onConfigChange(update);
                    void onSave(update);
                  }}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer ${
                    instance.blockStreaming ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    instance.blockStreaming ? 'translate-x-4' : 'translate-x-0'
                  }`} />
                </button>
              </div>
            </div>
          )}

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
              Media Max (MB)
            </label>
            <input
              type="number"
              value={instance.mediaMaxMb}
              onChange={(e) => onConfigChange({ mediaMaxMb: parseInt(e.target.value) || 30 })}
              onBlur={() => void onSave()}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
              min="1"
              max="50"
            />
          </div>
        </div>
      </details>

      {/* Connectivity test button */}
      <div className="pt-1">
        <button
          type="button"
          onClick={onTestConnectivity}
          disabled={testingPlatform === 'feishu'}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
        >
          <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
          {testingPlatform === 'feishu'
            ? i18nService.t('imConnectivityTesting')
            : connectivityResults['feishu' as keyof typeof connectivityResults]
              ? i18nService.t('imConnectivityRetest')
              : i18nService.t('imConnectivityTest')}
        </button>
      </div>

      {/* Error display */}
      {instanceStatus?.error && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {instanceStatus.error}
        </div>
      )}
    </div>
  );
};

export default FeishuInstanceSettings;
