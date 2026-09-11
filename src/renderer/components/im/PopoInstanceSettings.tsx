/**
 * POPO Instance Settings Component
 * Configuration form for a single POPO bot instance in multi-instance mode
 */

import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { ArrowPathIcon, CheckCircleIcon, SignalIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { PlatformRegistry } from '@shared/platform';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect,useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { IMConnectivityTestResult,PopoInstanceConfig, PopoInstanceStatus, PopoOpenClawConfig } from '../../types/im';

const PairingSection: React.FC<{
  platform: string;
  accountId: string;
}> = ({ platform, accountId }) => {
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [pairingStatus, setPairingStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleApprovePairing = async (code: string) => {
    setPairingStatus(null);
    try {
      const result = await window.electron.im.approvePairingCode(platform, code, accountId);
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
          {pairingStatus.type === 'success' ? '✓' : '✗'} {pairingStatus.message}
        </p>
      )}
    </div>
  );
};

interface PopoInstanceSettingsProps {
  instance: PopoInstanceConfig;
  instanceStatus: PopoInstanceStatus | undefined;
  onConfigChange: (update: Partial<PopoOpenClawConfig>) => void;
  onSave: (override?: Partial<PopoOpenClawConfig>) => Promise<void>;
  onRename: (newName: string) => void;
  onTestConnectivity: () => void;
  testingPlatform: string | null;
  connectivityResults: Record<string, IMConnectivityTestResult>;
  language: 'zh' | 'en';
  headerLeading?: React.ReactNode;
}

const PopoInstanceSettings: React.FC<PopoInstanceSettingsProps> = ({
  instance,
  instanceStatus,
  onConfigChange,
  onSave,
  onRename,
  onTestConnectivity,
  testingPlatform,
  connectivityResults,
  language,
  headerLeading,
}) => {
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [allowedUserIdInput, setAllowedUserIdInput] = useState('');
  const [groupAllowIdInput, setGroupAllowIdInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(instance.instanceName);

  // QR code scanning state
  const [qrStatus, setQrStatus] = useState<'idle' | 'loading' | 'showing' | 'waiting' | 'success' | 'error'>('idle');
  const [qrUrl, setQrUrl] = useState('');
  const [qrError, setQrError] = useState('');
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Sync nameValue when instance changes
  useEffect(() => {
    setNameValue(instance.instanceName);
    setEditingName(false);
  }, [instance.instanceId, instance.instanceName]);

  const handleNameBlur = () => {
    setEditingName(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== instance.instanceName) {
      onRename(trimmed);
    } else {
      setNameValue(instance.instanceName);
    }
  };

  const handlePopoQrLogin = async () => {
    setQrStatus('loading');
    setQrError('');
    try {
      const result = await window.electron.im.popoQrLoginStart();
      if (!isMountedRef.current) return;
      if (result.success && result.qrUrl) {
        setQrUrl(result.qrUrl);
        setQrStatus('showing');
        // Start polling
        setQrStatus('waiting');
        const pollResult = await window.electron.im.popoQrLoginPoll(result.taskToken!);
        if (!isMountedRef.current) return;
        if (pollResult.success && pollResult.appKey && pollResult.appSecret && pollResult.aesKey) {
          setQrStatus('success');
          await onSave({ appKey: pollResult.appKey, appSecret: pollResult.appSecret, aesKey: pollResult.aesKey, enabled: true });
        } else {
          setQrStatus('error');
          setQrError(pollResult.message || 'QR login failed');
        }
      } else {
        setQrStatus('error');
        setQrError(result.message || 'Failed to start QR login');
      }
    } catch {
      if (!isMountedRef.current) return;
      setQrStatus('error');
      setQrError('QR login failed');
    }
  };

  const effectiveConnectionMode = instance.connectionMode || (instance.token ? 'webhook' : 'websocket');
  const isWebhookMode = effectiveConnectionMode === 'webhook';
  const hasCredentials = !!(instance.appKey && instance.appSecret && instance.aesKey);
  const shouldShowQrPanel = !hasCredentials || (qrStatus !== 'idle' && qrStatus !== 'success');
  const connectivityResult = connectivityResults['popo'];

  return (
    <div className="space-y-3">
      {/* Instance Header: Name and Status */}
      <div className="flex items-center gap-3 pb-3 border-b border-border-subtle">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {headerLeading}
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
      </div>

      {/* Scan QR code section */}
      {shouldShowQrPanel && (
      <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center space-y-3">
        {(qrStatus === 'idle' || qrStatus === 'error') && (
          <>
            <button
              type="button"
              onClick={() => void handlePopoQrLogin()}
              className="px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {i18nService.t('imPopoScanBtn')}
            </button>
            <p className="text-xs text-secondary">
              {i18nService.t('imPopoScanHint')}
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
          <div className="flex items-center justify-center gap-2 py-4">
            <ArrowPathIcon className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm text-secondary">
              {i18nService.t('imPopoQrLoading')}
            </span>
          </div>
        )}
        {(qrStatus === 'showing' || qrStatus === 'waiting') && qrUrl && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">
              {i18nService.t('imPopoQrScanPrompt')}
            </p>
            <div className="flex justify-center">
              <div className="p-3 bg-white rounded-lg border border-border-subtle">
                <QRCodeSVG value={qrUrl} size={192} />
              </div>
            </div>
            {qrStatus === 'waiting' && (
              <p className="text-xs text-secondary animate-pulse">
                {i18nService.t('imPopoQrWaiting')}
              </p>
            )}
          </div>
        )}
        {qrStatus === 'success' && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
            <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
            {i18nService.t('imPopoQrSuccess')}
          </div>
        )}
      </div>
      )}

      {/* Platform Guide */}
      <div className="mb-3 p-3 rounded-lg border border-dashed border-border-subtle">
        <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
          <li>{i18nService.t('imPopoGuideStep1')}</li>
          <li>{i18nService.t('imPopoGuideStep2')}</li>
          <li>{i18nService.t('imPopoGuideStep3')}</li>
        </ol>
        {PlatformRegistry.guideUrl('popo') && (
          <button
            type="button"
            onClick={() => { window.electron.shell.openExternal(PlatformRegistry.guideUrl('popo')!).catch(() => {}); }}
            className="mt-2 text-xs font-medium text-primary hover:text-primary underline underline-offset-2 transition-colors"
          >
            {i18nService.t('imViewGuide')}
          </button>
        )}
      </div>

      {/* Bound status badge */}
      {instance.appKey && (
        <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
          AppKey: {instance.appKey}
        </div>
      )}

      {/* AES Key input (quick access) */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-secondary">AES Key</label>
        <div className="relative">
          <input
            type={showSecrets['aesKey'] ? 'text' : 'password'}
            value={instance.aesKey}
            onChange={(e) => onConfigChange({ aesKey: e.target.value })}
            onBlur={() => void onSave()}
            placeholder="••••••••••••"
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
          />
          <div className="absolute right-2 inset-y-0 flex items-center gap-1">
            {instance.aesKey && (
              <button
                type="button"
                onClick={() => { onConfigChange({ aesKey: '' }); void onSave({ aesKey: '' }); }}
                className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                title={i18nService.t('clear') || 'Clear'}
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSecrets(prev => ({ ...prev, aesKey: !prev.aesKey }))}
              className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
            >
              {showSecrets.aesKey ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {instance.aesKey && instance.aesKey.length !== 32 && (
          <p className="text-xs text-amber-500">
            AES Key {language === 'zh' ? '需要为 32 个字符' : 'must be 32 characters'}（{language === 'zh' ? '当前' : 'current'} {instance.aesKey.length}）
          </p>
        )}
      </div>

      {/* Connectivity test */}
      <div className="pt-1">
        <button
          type="button"
          onClick={onTestConnectivity}
          disabled={testingPlatform === 'popo'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface border border-border-subtle hover:bg-surface-raised transition-colors disabled:opacity-50"
        >
          {testingPlatform === 'popo' ? (
            <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <SignalIcon className="h-3.5 w-3.5" />
          )}
          {i18nService.t('imConnectivityTest')}
        </button>
        {connectivityResult && (
          <div className="mt-2 space-y-1">
            {connectivityResult.checks.map((check, idx) => (
              <div key={idx} className={`flex items-start gap-1.5 text-xs ${
                check.level === 'pass' ? 'text-green-600 dark:text-green-400' :
                check.level === 'fail' ? 'text-red-500' : 'text-secondary'
              }`}>
                {check.level === 'pass' ? <CheckCircleIcon className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> :
                 check.level === 'fail' ? <XCircleIcon className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> :
                 <SignalIcon className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                <span>{check.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Advanced Settings (collapsible) */}
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary transition-colors">
          {i18nService.t('imAdvancedSettings')}
        </summary>
        <div className="mt-2 space-y-3 pl-2 border-l-2 border-border-subtle">

          {/* Connection Mode */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">
              {i18nService.t('imPopoConnectionMode')}
            </label>
            <select
              value={effectiveConnectionMode}
              onChange={(e) => {
                const update = { connectionMode: e.target.value as PopoOpenClawConfig['connectionMode'] };
                onConfigChange(update);
                void onSave(update);
              }}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            >
              <option value="websocket">{i18nService.t('imPopoConnectionModeWebsocket')}</option>
              <option value="webhook">{i18nService.t('imPopoConnectionModeWebhook')}</option>
            </select>
          </div>

          <p className="text-xs text-secondary">{i18nService.t('imPopoCredentialHint')}</p>

          {/* AppKey */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">AppKey</label>
            <div className="relative">
              <input
                type="text"
                value={instance.appKey}
                onChange={(e) => onConfigChange({ appKey: e.target.value })}
                onBlur={() => void onSave()}
                placeholder="AppKey"
                className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
              />
              {instance.appKey && (
                <div className="absolute right-2 inset-y-0 flex items-center">
                  <button type="button" onClick={() => { onConfigChange({ appKey: '' }); void onSave({ appKey: '' }); }} className="p-0.5 rounded text-secondary hover:text-primary transition-colors" title={i18nService.t('clear') || 'Clear'}>
                    <XCircleIconSolid className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* AppSecret */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">AppSecret</label>
            <div className="relative">
              <input
                type={showSecrets.appSecret ? 'text' : 'password'}
                value={instance.appSecret}
                onChange={(e) => onConfigChange({ appSecret: e.target.value })}
                onBlur={() => void onSave()}
                placeholder="••••••••••••"
                className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
              />
              <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                {instance.appSecret && (
                  <button type="button" onClick={() => { onConfigChange({ appSecret: '' }); void onSave({ appSecret: '' }); }} className="p-0.5 rounded text-secondary hover:text-primary transition-colors" title={i18nService.t('clear') || 'Clear'}>
                    <XCircleIconSolid className="h-4 w-4" />
                  </button>
                )}
                <button type="button" onClick={() => setShowSecrets(prev => ({ ...prev, appSecret: !prev.appSecret }))} className="p-0.5 rounded text-secondary hover:text-primary transition-colors">
                  {showSecrets.appSecret ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* Token (webhook mode only) */}
          {isWebhookMode && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">Token</label>
              <div className="relative">
                <input
                  type={showSecrets.token ? 'text' : 'password'}
                  value={instance.token}
                  onChange={(e) => onConfigChange({ token: e.target.value })}
                  onBlur={() => void onSave()}
                  placeholder="••••••••••••"
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {instance.token && (
                    <button type="button" onClick={() => { onConfigChange({ token: '' }); void onSave({ token: '' }); }} className="p-0.5 rounded text-secondary hover:text-primary transition-colors" title={i18nService.t('clear') || 'Clear'}>
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button type="button" onClick={() => setShowSecrets(prev => ({ ...prev, token: !prev.token }))} className="p-0.5 rounded text-secondary hover:text-primary transition-colors">
                    {showSecrets.token ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AES Key (in advanced) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">AES Key</label>
            <div className="relative">
              <input
                type={showSecrets.aesKeyAdv ? 'text' : 'password'}
                value={instance.aesKey}
                onChange={(e) => onConfigChange({ aesKey: e.target.value })}
                onBlur={() => void onSave()}
                placeholder="••••••••••••"
                className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
              />
              <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                {instance.aesKey && (
                  <button type="button" onClick={() => { onConfigChange({ aesKey: '' }); void onSave({ aesKey: '' }); }} className="p-0.5 rounded text-secondary hover:text-primary transition-colors" title={i18nService.t('clear') || 'Clear'}>
                    <XCircleIconSolid className="h-4 w-4" />
                  </button>
                )}
                <button type="button" onClick={() => setShowSecrets(prev => ({ ...prev, aesKeyAdv: !prev.aesKeyAdv }))} className="p-0.5 rounded text-secondary hover:text-primary transition-colors">
                  {showSecrets.aesKeyAdv ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {instance.aesKey && instance.aesKey.length !== 32 && (
              <p className="text-xs text-amber-500">
                AES Key {language === 'zh' ? '需要为 32 个字符' : 'must be 32 characters'}（{language === 'zh' ? '当前' : 'current'} {instance.aesKey.length}）
              </p>
            )}
          </div>

          {/* Webhook fields (webhook mode only) */}
          {isWebhookMode && (
            <>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-secondary">Webhook Base URL</label>
                <input
                  type="text"
                  value={instance.webhookBaseUrl}
                  onChange={(e) => onConfigChange({ webhookBaseUrl: e.target.value })}
                  onBlur={() => void onSave()}
                  placeholder={i18nService.t('imPopoWebhookPlaceholder')}
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-secondary">Webhook Path</label>
                <input
                  type="text"
                  value={instance.webhookPath}
                  onChange={(e) => onConfigChange({ webhookPath: e.target.value })}
                  onBlur={() => void onSave()}
                  placeholder="/popo/callback"
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-secondary">Webhook Port</label>
                <input
                  type="number"
                  value={instance.webhookPort}
                  onChange={(e) => onConfigChange({ webhookPort: parseInt(e.target.value) || 3100 })}
                  onBlur={() => void onSave()}
                  placeholder="3100"
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                />
              </div>
            </>
          )}

          {/* DM Policy */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">DM Policy</label>
            <select
              value={instance.dmPolicy}
              onChange={(e) => {
                const update = { dmPolicy: e.target.value as PopoOpenClawConfig['dmPolicy'] };
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
          {instance.dmPolicy === 'pairing' && (
            <PairingSection platform="popo" accountId={instance.instanceId.slice(0, 8)} />
          )}

          {/* Allow From */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">Allow From (User IDs)</label>
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
                      onConfigChange({ allowFrom: [...instance.allowFrom, id] });
                      setAllowedUserIdInput('');
                      void onSave({ allowFrom: [...instance.allowFrom, id] });
                    }
                  }
                }}
                className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imPopoUserIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = allowedUserIdInput.trim();
                  if (id && !instance.allowFrom.includes(id)) {
                    onConfigChange({ allowFrom: [...instance.allowFrom, id] });
                    setAllowedUserIdInput('');
                    void onSave({ allowFrom: [...instance.allowFrom, id] });
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
                  <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground">
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
            <label className="block text-xs font-medium text-secondary">Group Policy</label>
            <select
              value={instance.groupPolicy}
              onChange={(e) => {
                const update = { groupPolicy: e.target.value as PopoOpenClawConfig['groupPolicy'] };
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
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">Group Allow From (Chat IDs)</label>
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
                      onConfigChange({ groupAllowFrom: [...instance.groupAllowFrom, id] });
                      setGroupAllowIdInput('');
                      void onSave({ groupAllowFrom: [...instance.groupAllowFrom, id] });
                    }
                  }
                }}
                className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                placeholder={i18nService.t('imPopoGroupIdPlaceholder')}
              />
              <button
                type="button"
                onClick={() => {
                  const id = groupAllowIdInput.trim();
                  if (id && !instance.groupAllowFrom.includes(id)) {
                    onConfigChange({ groupAllowFrom: [...instance.groupAllowFrom, id] });
                    setGroupAllowIdInput('');
                    void onSave({ groupAllowFrom: [...instance.groupAllowFrom, id] });
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
                  <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground">
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

          {/* Text Chunk Limit */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">Text Chunk Limit</label>
            <input
              type="number"
              value={instance.textChunkLimit}
              onChange={(e) => onConfigChange({ textChunkLimit: parseInt(e.target.value) || 3000 })}
              onBlur={() => void onSave()}
              placeholder="3000"
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            />
          </div>

          {/* Rich Text Chunk Limit */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-secondary">Rich Text Chunk Limit</label>
            <input
              type="number"
              value={instance.richTextChunkLimit}
              onChange={(e) => onConfigChange({ richTextChunkLimit: parseInt(e.target.value) || 5000 })}
              onBlur={() => void onSave()}
              placeholder="5000"
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            />
          </div>

          {/* Debug toggle */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-secondary">Debug</label>
            <button
              type="button"
              onClick={() => {
                const next = !instance.debug;
                onConfigChange({ debug: next });
                void onSave({ debug: next });
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

      {/* Error display */}
      {instanceStatus?.lastError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {instanceStatus.lastError}
        </div>
      )}
    </div>
  );
};

export default PopoInstanceSettings;
