/**
 * IM Settings Component
 * Configuration UI for DingTalk, Feishu and Telegram IM bots
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { SignalIcon, XMarkIcon, CheckCircleIcon, XCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { RootState } from '../../store';
import { imService } from '../../services/im';
import { setDingTalkConfig, setFeishuConfig, setQQConfig, setTelegramConfig, setDiscordConfig, setNimConfig, setXiaomifengConfig, setWecomConfig, clearError } from '../../store/slices/imSlice';
import { i18nService } from '../../services/i18n';
import type { IMPlatform, IMConnectivityCheck, IMConnectivityTestResult, IMGatewayConfig } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';

// Platform metadata
const platformMeta: Record<IMPlatform, { label: string; logo: string }> = {
  dingtalk: { label: '钉钉', logo: 'dingding.png' },
  feishu: { label: '飞书', logo: 'feishu.png' },
  qq: { label: 'QQ', logo: 'qq_bot.jpeg' },
  telegram: { label: 'Telegram', logo: 'telegram.svg' },
  discord: { label: 'Discord', logo: 'discord.svg' },
  nim: { label: '云信', logo: 'nim.png' },
  xiaomifeng: { label: '小蜜蜂', logo: 'xiaomifeng.png' },
  wecom: { label: '企业微信', logo: 'wecom.png' },
};

const verdictColorClass: Record<IMConnectivityTestResult['verdict'], string> = {
  pass: 'bg-green-500/15 text-green-600 dark:text-green-400',
  warn: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
  fail: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

const checkLevelColorClass: Record<IMConnectivityCheck['level'], string> = {
  pass: 'text-green-600 dark:text-green-400',
  info: 'text-sky-600 dark:text-sky-400',
  warn: 'text-yellow-700 dark:text-yellow-300',
  fail: 'text-red-600 dark:text-red-400',
};

// Map of backend error messages to i18n keys
const errorMessageI18nMap: Record<string, string> = {
  '账号已在其它地方登录': 'kickedByOtherClient',
};

// Helper function to translate IM error messages
function translateIMError(error: string | null): string {
  if (!error) return '';
  const i18nKey = errorMessageI18nMap[error];
  if (i18nKey) {
    return i18nService.t(i18nKey);
  }
  return error;
}

const IMSettings: React.FC = () => {
  const dispatch = useDispatch();
  const { config, status, isLoading } = useSelector((state: RootState) => state.im);
  const [activePlatform, setActivePlatform] = useState<IMPlatform>('dingtalk');
  const [testingPlatform, setTestingPlatform] = useState<IMPlatform | null>(null);
  const [connectivityResults, setConnectivityResults] = useState<Partial<Record<IMPlatform, IMConnectivityTestResult>>>({});
  const [connectivityModalPlatform, setConnectivityModalPlatform] = useState<IMPlatform | null>(null);
  const [language, setLanguage] = useState<'zh' | 'en'>(i18nService.getLanguage());
  const [allowedUserIdInput, setAllowedUserIdInput] = useState('');
  const [configLoaded, setConfigLoaded] = useState(false);
  // Re-entrancy guard for gateway toggle to prevent rapid ON→OFF→ON
  const [togglingPlatform, setTogglingPlatform] = useState<IMPlatform | null>(null);
  // Track visibility of password fields (eye toggle)
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  // Track the last-persisted NIM credentials so we can detect real changes on save
  const savedNimConfigRef = useRef<{ appKey: string; account: string; token: string }>({
    appKey: config.nim.appKey,
    account: config.nim.account,
    token: config.nim.token,
  });

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // Reset password visibility when switching platforms
  useEffect(() => {
    setShowSecrets({});
  }, [activePlatform]);

  // Initialize IM service and subscribe status updates
  useEffect(() => {
    let cancelled = false;
    void imService.init().then(() => {
      if (!cancelled) {
        setConfigLoaded(true);
      }
    });
    return () => {
      cancelled = true;
      setConfigLoaded(false);
      imService.destroy();
    };
  }, []);

  // Handle DingTalk config change
  const handleDingTalkChange = (field: 'clientId' | 'clientSecret', value: string) => {
    dispatch(setDingTalkConfig({ [field]: value }));
  };

  // Handle Feishu config change
  const handleFeishuChange = (field: 'appId' | 'appSecret', value: string) => {
    dispatch(setFeishuConfig({ [field]: value }));
  };

  // Handle QQ config change
  const handleQQChange = (field: 'appId' | 'appSecret', value: string) => {
    dispatch(setQQConfig({ [field]: value }));
  };

  // Handle Telegram config change
  const handleTelegramChange = (field: 'botToken' | 'allowedUserIds', value: string | string[]) => {
    dispatch(setTelegramConfig({ [field]: value }));
  };

  // Handle Discord config change
  const handleDiscordChange = (field: 'botToken', value: string) => {
    dispatch(setDiscordConfig({ [field]: value }));
  };

  // Handle NIM config change
  const handleNimChange = (
    field: 'appKey' | 'account' | 'token' | 'accountWhitelist' | 'teamPolicy' | 'teamAllowlist' | 'qchatEnabled' | 'qchatServerIds',
    value: string | boolean
  ) => {
    dispatch(setNimConfig({ [field]: value }));
  };

  // Handle Xiaomifeng config change
  const handleXiaomifengChange = (field: 'clientId' | 'secret', value: string) => {
    dispatch(setXiaomifengConfig({ [field]: value }));
  };

  // Handle WeCom config change
  const handleWecomChange = (field: 'botId' | 'secret', value: string) => {
    dispatch(setWecomConfig({ [field]: value }));
  };

  // Save config on blur — also auto-triggers NIM connectivity test when
  // the NIM toggle is ON and credential fields have changed.
  const handleSaveConfig = async () => {
    if (!configLoaded) return;
    await imService.updateConfig({ [activePlatform]: config[activePlatform] });

    // Detect NIM credential changes while the gateway is enabled (only for NIM platform)
    if (activePlatform === 'nim') {
      const prev = savedNimConfigRef.current;
      const cur = config.nim;
      const nimCredentialsChanged =
        cur.appKey !== prev.appKey ||
        cur.account !== prev.account ||
        cur.token !== prev.token;

      // Update the snapshot regardless
      savedNimConfigRef.current = { appKey: cur.appKey, account: cur.account, token: cur.token };

      if (nimCredentialsChanged && cur.enabled && cur.appKey && cur.account && cur.token) {
        // Auto-run connectivity test: stop → start → test (silently, no modal)
        await imService.stopGateway('nim');
        await imService.startGateway('nim');
        await runConnectivityTest('nim', { nim: cur } as Partial<IMGatewayConfig>);
      }
    }
  };

  // Save NIM config with explicit updated fields (for select/toggle that need immediate save)
  // This avoids the race condition where Redux state hasn't updated yet
  const saveNimConfigWithUpdate = async (updates: Partial<typeof config.nim>) => {
    if (!configLoaded) return;
    const updatedNimConfig = { ...config.nim, ...updates };
    await imService.updateConfig({ nim: updatedNimConfig });
  };

  const getCheckTitle = (code: IMConnectivityCheck['code']): string => {
    return i18nService.t(`imConnectivityCheckTitle_${code}`);
  };

  const getCheckSuggestion = (check: IMConnectivityCheck): string | undefined => {
    if (check.suggestion) {
      return check.suggestion;
    }
    if (check.code === 'gateway_running' && check.level === 'pass') {
      return undefined;
    }
    const suggestion = i18nService.t(`imConnectivityCheckSuggestion_${check.code}`);
    if (suggestion.startsWith('imConnectivityCheckSuggestion_')) {
      return undefined;
    }
    return suggestion;
  };

  const formatTestTime = (timestamp: number): string => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return String(timestamp);
    }
  };

  const runConnectivityTest = async (
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult | null> => {
    setTestingPlatform(platform);
    const result = await imService.testGateway(platform, configOverride);
    if (result) {
      setConnectivityResults((prev) => ({ ...prev, [platform]: result }));
    }
    setTestingPlatform(null);
    return result;
  };

  // Toggle gateway on/off and persist enabled state
  const toggleGateway = async (platform: IMPlatform) => {
    // Re-entrancy guard: if a toggle is already in progress for this platform, bail out.
    // This prevents rapid ON→OFF→ON clicks from causing concurrent native SDK init/uninit.
    if (togglingPlatform === platform) return;
    setTogglingPlatform(platform);

    try {
      const isEnabled = config[platform].enabled;
      const newEnabled = !isEnabled;

      // Map platform to its Redux action
      const setConfigAction = getSetConfigAction(platform);

      // Update Redux state
      dispatch(setConfigAction({ enabled: newEnabled }));

      // Persist the updated config (construct manually since Redux state hasn't re-rendered yet)
      await imService.updateConfig({ [platform]: { ...config[platform], enabled: newEnabled } });

      if (newEnabled) {
        dispatch(clearError());
        const success = await imService.startGateway(platform);
        if (!success) {
          // Rollback enabled state on failure
          dispatch(setConfigAction({ enabled: false }));
          await imService.updateConfig({ [platform]: { ...config[platform], enabled: false } });
        } else {
          await runConnectivityTest(platform, {
            [platform]: { ...config[platform], enabled: true },
          } as Partial<IMGatewayConfig>);
        }
      } else {
        await imService.stopGateway(platform);
      }
    } finally {
      setTogglingPlatform(null);
    }
  };

  const dingtalkConnected = status.dingtalk.connected;
  const feishuConnected = status.feishu.connected;
  const telegramConnected = status.telegram.connected;
  const discordConnected = status.discord.connected;
  const nimConnected = status.nim.connected;
  const xiaomifengConnected = status.xiaomifeng?.connected ?? false;
  const qqConnected = status.qq?.connected ?? false;
  const wecomConnected = status.wecom?.connected ?? false;

  // Compute visible platforms based on language
  const platforms = useMemo<IMPlatform[]>(() => {
    return getVisibleIMPlatforms(language) as IMPlatform[];
  }, [language]);

  // Ensure activePlatform is always in visible platforms when language changes
  useEffect(() => {
    if (platforms.length > 0 && !platforms.includes(activePlatform)) {
      // If current activePlatform is not visible, switch to first visible platform
      setActivePlatform(platforms[0]);
    }
  }, [platforms, activePlatform]);

  // Check if platform can be started
  const canStart = (platform: IMPlatform): boolean => {
    if (platform === 'dingtalk') {
      return !!(config.dingtalk.clientId && config.dingtalk.clientSecret);
    }
    if (platform === 'telegram') {
      return !!config.telegram.botToken;
    }
    if (platform === 'discord') {
      return !!config.discord.botToken;
    }
    if (platform === 'nim') {
      return !!(config.nim.appKey && config.nim.account && config.nim.token);
    }
    if (platform === 'xiaomifeng') {
      return !!(config.xiaomifeng.clientId && config.xiaomifeng.secret);
    }
    if (platform === 'qq') {
      return !!(config.qq.appId && config.qq.appSecret);
    }
    if (platform === 'wecom') {
      return !!(config.wecom.botId && config.wecom.secret);
    }
    return !!(config.feishu.appId && config.feishu.appSecret);
  };

  // Get platform enabled state (persisted toggle state)
  const isPlatformEnabled = (platform: IMPlatform): boolean => {
    return config[platform].enabled;
  };

  // Get platform connection status (runtime state)
  const getPlatformConnected = (platform: IMPlatform): boolean => {
    if (platform === 'dingtalk') return dingtalkConnected;
    if (platform === 'telegram') return telegramConnected;
    if (platform === 'discord') return discordConnected;
    if (platform === 'nim') return nimConnected;
    if (platform === 'xiaomifeng') return xiaomifengConnected;
    if (platform === 'qq') return qqConnected;
    if (platform === 'wecom') return wecomConnected;
    return feishuConnected;
  };

  // Get platform transient starting status
  const getPlatformStarting = (platform: IMPlatform): boolean => {
    if (platform === 'discord') return status.discord.starting;
    return false;
  };

  const handleConnectivityTest = async (platform: IMPlatform) => {
    // Re-entrancy guard: if a test is already running, do nothing.
    if (testingPlatform) return;

    setConnectivityModalPlatform(platform);
    // 1. Persist latest config to backend (without changing enabled state)
    await imService.updateConfig({
      [platform]: config[platform],
    } as Partial<IMGatewayConfig>);

    const isEnabled = isPlatformEnabled(platform);

    // For NIM, skip the frontend stop/start cycle entirely.
    // The backend's testNimConnectivity already manages the SDK lifecycle
    // (stop main → probe with temp instance → restart main) under a mutex,
    // so doing stop/start here would cause a race condition and potential crash.
    if (isEnabled && platform !== 'nim') {
      // Gateway is ON: restart it to pick up the latest credentials, then run the
      // gateway_running check (which also calls runAuthProbe internally via testGateway).
      await imService.stopGateway(platform);
      await imService.startGateway(platform);
    }
    // When the gateway is OFF we skip stop/start entirely.
    // The main process testGateway → runAuthProbe will spawn an isolated
    // temporary NimGateway (for NIM) or use stateless HTTP calls for other
    // platforms, so no historical messages are ingested and the main
    // gateway state is never touched.

    // Run connectivity test (always passes configOverride so the backend uses
    // the latest unsaved credential values from the form).
    const result = await runConnectivityTest(platform, {
      [platform]: config[platform],
    } as Partial<IMGatewayConfig>);

    // Auto-enable: if the platform was OFF but auth_check passed, start it automatically.
    if (!isEnabled && result) {
      const authCheck = result.checks.find((c) => c.code === 'auth_check');
      if (authCheck && authCheck.level === 'pass') {
        toggleGateway(platform);
      }
    }
  };

  // Handle platform toggle
  const handlePlatformToggle = (platform: IMPlatform) => {
    // Block toggle if a toggle is already in progress for any platform
    if (togglingPlatform) return;
    const isEnabled = isPlatformEnabled(platform);
    // Can toggle ON if credentials are present, can always toggle OFF
    const canToggle = isEnabled || canStart(platform);
    if (canToggle && !isLoading) {
      setActivePlatform(platform);
      toggleGateway(platform);
    }
  };

  // Toggle gateway on/off - map platform to Redux action
  const getSetConfigAction = (platform: IMPlatform) => {
    const actionMap: Record<IMPlatform, any> = {
      dingtalk: setDingTalkConfig,
      feishu: setFeishuConfig,
      qq: setQQConfig,
      telegram: setTelegramConfig,
      discord: setDiscordConfig,
      nim: setNimConfig,
      xiaomifeng: setXiaomifengConfig,
      wecom: setWecomConfig,
    };
    return actionMap[platform];
  };

  const renderConnectivityTestButton = (platform: IMPlatform) => (
    <button
      type="button"
      onClick={() => handleConnectivityTest(platform)}
      disabled={isLoading || testingPlatform === platform}
      className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
    >
      <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
      {testingPlatform === platform
        ? i18nService.t('imConnectivityTesting')
        : connectivityResults[platform]
          ? i18nService.t('imConnectivityRetest')
          : i18nService.t('imConnectivityTest')}
    </button>
  );

  useEffect(() => {
    if (!connectivityModalPlatform) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConnectivityModalPlatform(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connectivityModalPlatform]);

  return (
    <div className="flex h-full gap-4">
      {/* Platform List - Left Side */}
      <div className="w-48 flex-shrink-0 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-2 overflow-y-auto">
        {platforms.map((platform) => {
          const meta = platformMeta[platform];
          const isEnabled = isPlatformEnabled(platform);
          const isConnected = getPlatformConnected(platform) || getPlatformStarting(platform);
          const canToggle = isEnabled || canStart(platform);
          return (
            <div
              key={platform}
              onClick={() => setActivePlatform(platform)}
              className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                activePlatform === platform
                  ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30 shadow-subtle'
                  : 'dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-transparent'
              }`}
            >
              <div className="flex flex-1 items-center">
                <div className="mr-2 flex h-7 w-7 items-center justify-center">
                  <img
                    src={meta.logo}
                    alt={meta.label}
                    className="w-6 h-6 object-contain rounded-md"
                  />
                </div>
                <span className={`text-sm font-medium truncate ${
                  activePlatform === platform
                    ? 'text-claude-accent'
                    : 'dark:text-claude-darkText text-claude-text'
                }`}>
                  {i18nService.t(platform)}
                </span>
              </div>
              <div className="flex items-center ml-2">
                <div
                  className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                    isEnabled
                      ? (isConnected ? 'bg-green-500' : 'bg-yellow-500')
                      : 'dark:bg-claude-darkBorder bg-claude-border'
                  } ${(!canToggle || togglingPlatform === platform) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePlatformToggle(platform);
                  }}
                >
                  <div
                    className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                      isEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Platform Settings - Right Side */}
      <div className="flex-1 min-w-0 pl-4 pr-2 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
        {/* Header with status */}
        <div className="flex items-center gap-3 pb-3 border-b dark:border-claude-darkBorder/60 border-claude-border/60">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-white dark:bg-claude-darkBorder/30 p-1">
              <img
                src={platformMeta[activePlatform].logo}
                alt={platformMeta[activePlatform].label}
                className="w-4 h-4 object-contain rounded"
              />
            </div>
            <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {`${i18nService.t(activePlatform)}${i18nService.t('settings')}`}
            </h3>
          </div>
          <div className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            getPlatformConnected(activePlatform) || getPlatformStarting(activePlatform)
              ? 'bg-green-500/15 text-green-600 dark:text-green-400'
              : 'bg-gray-500/15 text-gray-500 dark:text-gray-400'
          }`}>
            {getPlatformConnected(activePlatform)
              ? i18nService.t('connected')
              : getPlatformStarting(activePlatform)
                ? (i18nService.t('starting') || '启动中')
                : i18nService.t('disconnected')}
          </div>
        </div>

        {/* DingTalk Settings */}
        {activePlatform === 'dingtalk' && (
          <div className="space-y-3">
            {/* Client ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Client ID (AppKey)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.dingtalk.clientId}
                  onChange={(e) => handleDingTalkChange('clientId', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="dingxxxxxx"
                />
                {config.dingtalk.clientId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleDingTalkChange('clientId', ''); void imService.updateConfig({ dingtalk: { ...config.dingtalk, clientId: '' } }); }}
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
                  value={config.dingtalk.clientSecret}
                  onChange={(e) => handleDingTalkChange('clientSecret', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.dingtalk.clientSecret && (
                    <button
                      type="button"
                      onClick={() => { handleDingTalkChange('clientSecret', ''); void imService.updateConfig({ dingtalk: { ...config.dingtalk, clientSecret: '' } }); }}
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

            <div className="pt-1">
              {renderConnectivityTestButton('dingtalk')}
            </div>

            {/* Error display */}
            {status.dingtalk.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.dingtalk.lastError}
              </div>
            )}
          </div>
        )}

        {/* Feishu Settings */}
        {activePlatform === 'feishu' && (
          <div className="space-y-3">
            {/* App ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                App ID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.feishu.appId}
                  onChange={(e) => handleFeishuChange('appId', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="cli_xxxxx"
                />
                {config.feishu.appId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleFeishuChange('appId', ''); void imService.updateConfig({ feishu: { ...config.feishu, appId: '' } }); }}
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
                  value={config.feishu.appSecret}
                  onChange={(e) => handleFeishuChange('appSecret', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.feishu.appSecret && (
                    <button
                      type="button"
                      onClick={() => { handleFeishuChange('appSecret', ''); void imService.updateConfig({ feishu: { ...config.feishu, appSecret: '' } }); }}
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

            <div className="pt-1">
              {renderConnectivityTestButton('feishu')}
            </div>

            {/* Error display */}
            {status.feishu.error && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.feishu.error}
              </div>
            )}
          </div>
        )}

        {/* QQ Settings */}
        {activePlatform === 'qq' && (
          <div className="space-y-3">
            {/* AppID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                AppID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.qq.appId}
                  onChange={(e) => handleQQChange('appId', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="102xxxxx"
                />
                {config.qq.appId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleQQChange('appId', ''); void imService.updateConfig({ qq: { ...config.qq, appId: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* AppSecret */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                AppSecret
              </label>
              <div className="relative">
                <input
                  type={showSecrets['qq.appSecret'] ? 'text' : 'password'}
                  value={config.qq.appSecret}
                  onChange={(e) => handleQQChange('appSecret', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.qq.appSecret && (
                    <button
                      type="button"
                      onClick={() => { handleQQChange('appSecret', ''); void imService.updateConfig({ qq: { ...config.qq, appSecret: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'qq.appSecret': !prev['qq.appSecret'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['qq.appSecret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['qq.appSecret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-1">
              {renderConnectivityTestButton('qq')}
            </div>

            {/* Error display */}
            {status.qq?.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.qq.lastError}
              </div>
            )}
          </div>
        )}

        {/* Telegram Settings */}
        {activePlatform === 'telegram' && (
          <div className="space-y-3">
            {/* Bot Token */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Bot Token
              </label>
              <div className="relative">
                <input
                  type={showSecrets['telegram.botToken'] ? 'text' : 'password'}
                  value={config.telegram.botToken}
                  onChange={(e) => handleTelegramChange('botToken', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.telegram.botToken && (
                    <button
                      type="button"
                      onClick={() => { handleTelegramChange('botToken', ''); void imService.updateConfig({ telegram: { ...config.telegram, botToken: '' } }); }}
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
                {i18nService.t('telegramTokenHint') || '从 @BotFather 获取 Bot Token'}
              </p>
            </div>

            {/* Allowed User IDs */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Allowed User IDs
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
                      if (id && !(config.telegram.allowedUserIds || []).includes(id)) {
                        const newIds = [...(config.telegram.allowedUserIds || []), id];
                        handleTelegramChange('allowedUserIds', newIds);
                        setAllowedUserIdInput('');
                        void imService.updateConfig({ telegram: { ...config.telegram, allowedUserIds: newIds } });
                      }
                    }
                  }}
                  className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  placeholder={i18nService.t('telegramAllowedUserIdsPlaceholder') || '输入 Telegram User ID'}
                />
                <button
                  type="button"
                  onClick={() => {
                    const id = allowedUserIdInput.trim();
                    if (id && !(config.telegram.allowedUserIds || []).includes(id)) {
                      const newIds = [...(config.telegram.allowedUserIds || []), id];
                      handleTelegramChange('allowedUserIds', newIds);
                      setAllowedUserIdInput('');
                      void imService.updateConfig({ telegram: { ...config.telegram, allowedUserIds: newIds } });
                    }
                  }}
                  className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                >
                  {i18nService.t('add') || '添加'}
                </button>
              </div>
              {(config.telegram.allowedUserIds || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {(config.telegram.allowedUserIds || []).map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                    >
                      {id}
                      <button
                        type="button"
                        onClick={() => {
                          const newIds = (config.telegram.allowedUserIds || []).filter((uid) => uid !== id);
                          handleTelegramChange('allowedUserIds', newIds);
                          void imService.updateConfig({ telegram: { ...config.telegram, allowedUserIds: newIds } });
                        }}
                        className="text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      >
                        <XMarkIcon className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('telegramAllowedUserIdsHint') || '限制只有白名单中的用户可以与 Bot 交互。留空则允许所有用户。'}
              </p>
            </div>

            <div className="pt-1">
              {renderConnectivityTestButton('telegram')}
            </div>

            {/* Bot username display */}
            {status.telegram.botUsername && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Bot: @{status.telegram.botUsername}
              </div>
            )}

            {/* Error display */}
            {status.telegram.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.telegram.lastError}
              </div>
            )}
          </div>
        )}

        {/* Discord Settings */}
        {activePlatform === 'discord' && (
          <div className="space-y-3">
            {/* Bot Token */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Bot Token
              </label>
              <div className="relative">
                <input
                  type={showSecrets['discord.botToken'] ? 'text' : 'password'}
                  value={config.discord.botToken}
                  onChange={(e) => handleDiscordChange('botToken', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ..."
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.discord.botToken && (
                    <button
                      type="button"
                      onClick={() => { handleDiscordChange('botToken', ''); void imService.updateConfig({ discord: { ...config.discord, botToken: '' } }); }}
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
                从 Discord Developer Portal 获取 Bot Token
              </p>
            </div>

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
        )}

        {/* NIM (NetEase IM) Settings */}
        {activePlatform === 'nim' && (
          <div className="space-y-3">
            {/* How to get NIM credentials */}
            <div className="mb-3 p-3 rounded-lg bg-blue-50/50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30">
              <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
                {i18nService.t('nimCredentialsGuide') || '如何获取云信凭证：'}
              </p>
              <ol className="mt-2 text-xs text-blue-600 dark:text-blue-400 space-y-1 list-decimal list-inside">
                <li>{i18nService.t('nimGuideStep1') || '登录网易云信控制台（yunxin.163.com）'}</li>
                <li>{i18nService.t('nimGuideStep2') || '创建或选择应用，获取 App Key'}</li>
                <li>{i18nService.t('nimGuideStep3') || '在"账号数-子功能配置"中创建 IM 账号（accid）'}</li>
                <li>{i18nService.t('nimGuideStep4') || '为该账号生成 Token（密码）- 建议长期有效'}</li>
              </ol>
            </div>

            {/* App Key */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                App Key
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.nim.appKey}
                  onChange={(e) => handleNimChange('appKey', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="your_app_key"
                />
                {config.nim.appKey && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleNimChange('appKey', ''); void imService.updateConfig({ nim: { ...config.nim, appKey: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('nimAppKeyHint') || '从云信控制台应用信息中获取'}
              </p>
            </div>

            {/* Account */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Account (accid)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.nim.account}
                  onChange={(e) => handleNimChange('account', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder={i18nService.t('nimAccountPlaceholder') || 'bot_account_id'}
                />
                {config.nim.account && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleNimChange('account', ''); void imService.updateConfig({ nim: { ...config.nim, account: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('nimAccountHint') || '在云信控制台"账号管理"中创建的 IM 账号 ID'}
              </p>
            </div>

            {/* Token */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Token
              </label>
              <div className="relative">
                <input
                  type={showSecrets['nim.token'] ? 'text' : 'password'}
                  value={config.nim.token}
                  onChange={(e) => handleNimChange('token', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.nim.token && (
                    <button
                      type="button"
                      onClick={() => { handleNimChange('token', ''); void imService.updateConfig({ nim: { ...config.nim, token: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'nim.token': !prev['nim.token'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['nim.token'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['nim.token'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('nimTokenHint') || '为该账号生成的访问凭证（建议设置为长期有效）'}
              </p>
            </div>

            {/* Account Whitelist */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('nimAccountWhitelist') || '白名单账号'}
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.nim.accountWhitelist}
                  onChange={(e) => handleNimChange('accountWhitelist', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="account1,account2"
                />
                {config.nim.accountWhitelist && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleNimChange('accountWhitelist', ''); void imService.updateConfig({ nim: { ...config.nim, accountWhitelist: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('nimAccountWhitelistHint') || '填写允许与机器人对话的云信账号，多个账号用逗号分隔。留空则不限制，响应所有账号的消息。'}
              </p>
            </div>

            {/* Team Policy (群消息策略) */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('nimTeamPolicy') || '群消息策略'}
              </label>
              <select
                value={config.nim.teamPolicy || 'disabled'}
                onChange={(e) => {
                  const newValue = e.target.value as 'disabled' | 'open' | 'allowlist';
                  handleNimChange('teamPolicy', newValue);
                  saveNimConfigWithUpdate({ teamPolicy: newValue });
                }}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              >
                <option value="disabled">{i18nService.t('nimTeamPolicyDisabled') || '禁用 - 不响应群消息'}</option>
                <option value="open">{i18nService.t('nimTeamPolicyOpen') || '开放 - 响应所有群的@消息'}</option>
                <option value="allowlist">{i18nService.t('nimTeamPolicyAllowlist') || '白名单 - 仅响应指定群的@消息'}</option>
              </select>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('nimTeamPolicyHint') || '群消息仅响应@机器人的消息'}
              </p>
            </div>

            {/* Team Allowlist - only show when policy is 'allowlist' */}
            {config.nim.teamPolicy === 'allowlist' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('nimTeamAllowlist') || '群白名单'}
                </label>
                <input
                  type="text"
                  value={config.nim.teamAllowlist || ''}
                  onChange={(e) => handleNimChange('teamAllowlist', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  placeholder="team_id_1,team_id_2"
                />
                <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('nimTeamAllowlistHint') || '填写允许响应的群ID，多个用逗号分隔'}
                </p>
              </div>
            )}

            {/* QChat Enable Toggle */}
            <div className="flex items-center justify-between py-2">
              <div>
                <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('nimQChatEnabled') || '启用圈组 (QChat)'}
                </label>
                <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary mt-0.5">
                  {i18nService.t('nimQChatEnabledHint') || '订阅圈组消息，仅响应@机器人的消息'}
                </p>
              </div>
              <div
                className={`w-10 h-5 rounded-full flex items-center transition-colors cursor-pointer ${
                  config.nim.qchatEnabled ? 'bg-green-500' : 'dark:bg-claude-darkBorder bg-claude-border'
                }`}
                onClick={() => {
                  const newValue = !config.nim.qchatEnabled;
                  handleNimChange('qchatEnabled', newValue);
                  saveNimConfigWithUpdate({ qchatEnabled: newValue });
                }}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white shadow-md transform transition-transform ${
                    config.nim.qchatEnabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </div>
            </div>

            {/* QChat Server IDs - only show when QChat is enabled */}
            {config.nim.qchatEnabled && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('nimQChatServerIds') || '圈组服务器 ID'}
                </label>
                <input
                  type="text"
                  value={config.nim.qchatServerIds || ''}
                  onChange={(e) => handleNimChange('qchatServerIds', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  placeholder={i18nService.t('nimQChatServerIdsPlaceholder') || '留空自动发现所有已加入的服务器'}
                />
                <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('nimQChatServerIdsHint') || '指定要订阅的服务器 ID，多个用逗号分隔。留空则自动订阅所有已加入的服务器。'}
                </p>
              </div>
            )}

            <div className="pt-1">
              {renderConnectivityTestButton('nim')}
            </div>

            {/* Bot account display */}
            {status.nim.botAccount && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Account: {status.nim.botAccount}
              </div>
            )}

            {/* Error display */}
            {status.nim.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.nim.lastError}
              </div>
            )}
          </div>
        )}

        {/* 小蜜蜂设置*/}
        {activePlatform === 'xiaomifeng' && (
          <div className="space-y-3">
            {/* Client ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Client ID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.xiaomifeng.clientId}
                  onChange={(e) => handleXiaomifengChange('clientId', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder={i18nService.t('xiaomifengClientIdPlaceholder') || '您的Client ID'}
                />
                {config.xiaomifeng.clientId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleXiaomifengChange('clientId', ''); void imService.updateConfig({ xiaomifeng: { ...config.xiaomifeng, clientId: '' } }); }}
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
                Client Secret
              </label>
              <div className="relative">
                <input
                  type={showSecrets['xiaomifeng.secret'] ? 'text' : 'password'}
                  value={config.xiaomifeng.secret}
                  onChange={(e) => handleXiaomifengChange('secret', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.xiaomifeng.secret && (
                    <button
                      type="button"
                      onClick={() => { handleXiaomifengChange('secret', ''); void imService.updateConfig({ xiaomifeng: { ...config.xiaomifeng, secret: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'xiaomifeng.secret': !prev['xiaomifeng.secret'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['xiaomifeng.secret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['xiaomifeng.secret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-1">
              {renderConnectivityTestButton('xiaomifeng')}
            </div>

            {/* Bot account display */}
            {status.xiaomifeng?.botAccount && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Account: {status.xiaomifeng.botAccount}
              </div>
            )}

            {/* Error display */}
            {status.xiaomifeng?.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {translateIMError(status.xiaomifeng.lastError)}
              </div>
            )}
          </div>
        )}

        {/* WeCom (企业微信) Settings */}
        {activePlatform === 'wecom' && (
          <div className="space-y-3">
            {/* Bot ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Bot ID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config.wecom.botId}
                  onChange={(e) => handleWecomChange('botId', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder={i18nService.t('wecomBotIdPlaceholder') || '您的 Bot ID'}
                />
                {config.wecom.botId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleWecomChange('botId', ''); void imService.updateConfig({ wecom: { ...config.wecom, botId: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
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
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Secret
              </label>
              <div className="relative">
                <input
                  type={showSecrets['wecom.secret'] ? 'text' : 'password'}
                  value={config.wecom.secret}
                  onChange={(e) => handleWecomChange('secret', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config.wecom.secret && (
                    <button
                      type="button"
                      onClick={() => { handleWecomChange('secret', ''); void imService.updateConfig({ wecom: { ...config.wecom, secret: '' } }); }}
                      className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'wecom.secret': !prev['wecom.secret'] }))}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={showSecrets['wecom.secret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['wecom.secret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-1">
              {renderConnectivityTestButton('wecom')}
            </div>

            {/* Bot ID display */}
            {status.wecom?.botId && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Bot ID: {status.wecom.botId}
              </div>
            )}

            {/* Error display */}
            {status.wecom?.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.wecom.lastError}
              </div>
            )}
          </div>
        )}

        {connectivityModalPlatform && (
          <div
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
            onClick={() => setConnectivityModalPlatform(null)}
          >
            <div
              className="w-full max-w-2xl dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal border dark:border-claude-darkBorder border-claude-border overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border flex items-center justify-between">
                <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {`${i18nService.t(connectivityModalPlatform)} ${i18nService.t('imConnectivitySectionTitle')}`}
                </div>
                <button
                  type="button"
                  aria-label={i18nService.t('close')}
                  onClick={() => setConnectivityModalPlatform(null)}
                  className="p-1 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="p-4 max-h-[65vh] overflow-y-auto">
                {testingPlatform === connectivityModalPlatform ? (
                  <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('imConnectivityTesting')}
                  </div>
                ) : connectivityResults[connectivityModalPlatform] ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${verdictColorClass[connectivityResults[connectivityModalPlatform]!.verdict]}`}>
                        {connectivityResults[connectivityModalPlatform]!.verdict === 'pass' ? (
                          <CheckCircleIcon className="h-3.5 w-3.5" />
                        ) : connectivityResults[connectivityModalPlatform]!.verdict === 'warn' ? (
                          <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                        ) : (
                          <XCircleIcon className="h-3.5 w-3.5" />
                        )}
                        {i18nService.t(`imConnectivityVerdict_${connectivityResults[connectivityModalPlatform]!.verdict}`)}
                      </div>
                      <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {`${i18nService.t('imConnectivityLastChecked')}: ${formatTestTime(connectivityResults[connectivityModalPlatform]!.testedAt)}`}
                      </div>
                    </div>

                    <div className="space-y-2">
                      {connectivityResults[connectivityModalPlatform]!.checks.map((check, index) => (
                        <div
                          key={`${check.code}-${index}`}
                          className="rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 px-2.5 py-2 dark:bg-claude-darkSurface/25 bg-white/70"
                        >
                          <div className={`text-xs font-medium ${checkLevelColorClass[check.level]}`}>
                            {getCheckTitle(check.code)}
                          </div>
                          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {check.message}
                          </div>
                          {getCheckSuggestion(check) && (
                            <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              {`${i18nService.t('imConnectivitySuggestion')}: ${getCheckSuggestion(check)}`}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('imConnectivityNoResult')}
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t dark:border-claude-darkBorder border-claude-border flex items-center justify-end">
                {renderConnectivityTestButton(connectivityModalPlatform)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default IMSettings;
