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
import { setDingTalkConfig, setDingTalkInstanceConfig, setFeishuConfig, setFeishuInstanceConfig, setTelegramOpenClawConfig, setQQConfig, setQQInstanceConfig, setDiscordConfig, setNimConfig, setNeteaseBeeChanConfig, setWecomConfig, setWeixinConfig, setPopoConfig, clearError } from '../../store/slices/imSlice';
import { i18nService } from '../../services/i18n';
import type { IMConnectivityCheck, IMConnectivityTestResult, IMGatewayConfig, TelegramOpenClawConfig, DiscordOpenClawConfig, WecomOpenClawConfig, PopoOpenClawConfig } from '../../types/im';
import { MAX_QQ_INSTANCES, MAX_FEISHU_INSTANCES, MAX_DINGTALK_INSTANCES } from '../../types/im';
import QQInstanceSettings from './QQInstanceSettings';
import FeishuInstanceSettings from './FeishuInstanceSettings';
import DingTalkInstanceSettings from './DingTalkInstanceSettings';
import { PlatformRegistry } from '@shared/platform';
import type { Platform } from '@shared/platform';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import WecomAIBotSDK from '@wecom/wecom-aibot-sdk';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { SchemaForm } from './SchemaForm';
import type { UiHint } from './SchemaForm';
import Modal from '../common/Modal';



// Reusable guide card component for platform setup instructions
const PlatformGuide: React.FC<{
  title?: string;
  steps: string[];
  guideUrl?: string;
  guideLabel?: string;
}> = ({ title, steps, guideUrl, guideLabel }) => (
  <div className="mb-3 p-3 rounded-lg border border-dashed border-border-subtle">
    {title && (
      <p className="text-xs text-foreground leading-relaxed mb-1.5 font-medium">{title}</p>
    )}
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
        {guideLabel || i18nService.t('imViewGuide')}
      </button>
    )}
  </div>
);

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

// Helper function to deep-set a value in nested object by dot path
function deepSet(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const result = { ...obj };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = { ...(current[keys[i]] as Record<string, unknown> || {}) };
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

const IMSettings: React.FC = () => {
  const dispatch = useDispatch();
  const { config, status, isLoading } = useSelector((state: RootState) => state.im);
  const [activePlatform, setActivePlatform] = useState<Platform>('weixin');
  const [activeQQInstanceId, setActiveQQInstanceId] = useState<string | null>(null);
  const [qqExpanded, setQqExpanded] = useState(false);
  const [activeFeishuInstanceId, setActiveFeishuInstanceId] = useState<string | null>(null);
  const [feishuExpanded, setFeishuExpanded] = useState(false);
  const [activeDingTalkInstanceId, setActiveDingTalkInstanceId] = useState<string | null>(null);
  const [dingtalkExpanded, setDingtalkExpanded] = useState(false);
  const [testingPlatform, setTestingPlatform] = useState<Platform | null>(null);
  const [connectivityResults, setConnectivityResults] = useState<Partial<Record<Platform, IMConnectivityTestResult>>>({});
  const [connectivityModalPlatform, setConnectivityModalPlatform] = useState<Platform | null>(null);
  const [language, setLanguage] = useState<'zh' | 'en'>(i18nService.getLanguage());
  const [allowedUserIdInput, setAllowedUserIdInput] = useState('');
  const [configLoaded, setConfigLoaded] = useState(false);
  // Re-entrancy guard for gateway toggle to prevent rapid ON→OFF→ON
  const [togglingPlatform, setTogglingPlatform] = useState<Platform | null>(null);
  // Track visibility of password fields (eye toggle)
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  // WeCom quick setup state
  const [wecomQuickSetupStatus, setWecomQuickSetupStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [wecomQuickSetupError, setWecomQuickSetupError] = useState<string>('');
  // Weixin QR login state
  const [weixinQrStatus, setWeixinQrStatus] = useState<'idle' | 'loading' | 'showing' | 'waiting' | 'success' | 'error'>('idle');
  const [weixinQrUrl, setWeixinQrUrl] = useState<string>('');
  const [weixinQrError, setWeixinQrError] = useState<string>('');
  const weixinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localIp, setLocalIp] = useState<string>('');
  const isMountedRef = useRef(true);

  // OpenClaw config schema for schema-driven forms
  const [openclawSchema, setOpenclawSchema] = useState<{ schema: Record<string, unknown>; uiHints: Record<string, Record<string, unknown>> } | null>(null);

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // Track component mounted state for async operations
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Fetch local IP for POPO webhook placeholder
  useEffect(() => {
    window.electron?.im?.getLocalIp?.().then((ip: string) => {
      if (isMountedRef.current) setLocalIp(ip);
    }).catch(() => {});
  }, []);

  // Cleanup feishu QR timers on unmount
  useEffect(() => {
    return () => {
      if (feishuQrPollTimerRef.current) clearInterval(feishuQrPollTimerRef.current);
      if (feishuQrCountdownTimerRef.current) clearInterval(feishuQrCountdownTimerRef.current);
    };
  }, []);

  // Reset feishu QR state when switching away from feishu
  useEffect(() => {
    if (activePlatform !== 'feishu') {
      if (feishuQrPollTimerRef.current) { clearInterval(feishuQrPollTimerRef.current); feishuQrPollTimerRef.current = null; }
      if (feishuQrCountdownTimerRef.current) { clearInterval(feishuQrCountdownTimerRef.current); feishuQrCountdownTimerRef.current = null; }
      setFeishuQrStatus('idle');
      setFeishuQrUrl('');
      setFeishuQrError('');
    }
  }, [activePlatform]);

  // @ts-ignore: will be used when QR flow is wired to FeishuInstanceSettings
  const _handleFeishuStartQr = async () => {
    if (feishuQrPollTimerRef.current) clearInterval(feishuQrPollTimerRef.current);
    if (feishuQrCountdownTimerRef.current) clearInterval(feishuQrCountdownTimerRef.current);
    setFeishuQrStatus('loading');
    setFeishuQrError('');
    try {
      const result = await window.electron.feishu.install.qrcode(false);
      if (!isMountedRef.current) return;
      setFeishuQrUrl(result.url);
      feishuQrDeviceCodeRef.current = result.deviceCode;
      const expireIn = result.expireIn ?? 300;
      setFeishuQrTimeLeft(expireIn);
      setFeishuQrStatus('showing');

      // Countdown
      feishuQrCountdownTimerRef.current = setInterval(() => {
        setFeishuQrTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(feishuQrCountdownTimerRef.current!);
            feishuQrCountdownTimerRef.current = null;
            if (feishuQrPollTimerRef.current) { clearInterval(feishuQrPollTimerRef.current); feishuQrPollTimerRef.current = null; }
            setFeishuQrStatus('error');
            setFeishuQrError(i18nService.t('feishuBotCreateWizardQrcodeExpired'));
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      // Poll
      const intervalMs = Math.max(result.interval ?? 5, 3) * 1000;
      feishuQrPollTimerRef.current = setInterval(async () => {
        try {
          const pollResult = await window.electron.feishu.install.poll(feishuQrDeviceCodeRef.current);
          if (!isMountedRef.current) return;
          if (pollResult.done && pollResult.appId && pollResult.appSecret) {
            clearInterval(feishuQrPollTimerRef.current!); feishuQrPollTimerRef.current = null;
            clearInterval(feishuQrCountdownTimerRef.current!); feishuQrCountdownTimerRef.current = null;
            // QR flow creates a new instance with the scanned credentials
            const inst = await imService.addFeishuInstance('Feishu Bot');
            if (inst) {
              await imService.updateFeishuInstanceConfig(inst.instanceId, {
                appId: pollResult.appId,
                appSecret: pollResult.appSecret,
                enabled: true,
              });
              setActiveFeishuInstanceId(inst.instanceId);
              setFeishuExpanded(true);
            }
            if (!isMountedRef.current) return;   // re-check after async updateConfig
            setFeishuQrStatus('success');
          } else if (pollResult.error && pollResult.error !== 'authorization_pending' && pollResult.error !== 'slow_down') {
            clearInterval(feishuQrPollTimerRef.current!); feishuQrPollTimerRef.current = null;
            clearInterval(feishuQrCountdownTimerRef.current!); feishuQrCountdownTimerRef.current = null;
            setFeishuQrStatus('error');
            setFeishuQrError(pollResult.error);
          }
        } catch { /* keep retrying */ }
      }, intervalMs);
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setFeishuQrStatus('error');
      setFeishuQrError(err?.message || '获取二维码失败');
    }
  };

  // Reset wecom quick setup state when switching away from wecom
  useEffect(() => {
    if (activePlatform !== 'wecom') {
      setWecomQuickSetupStatus('idle');
      setWecomQuickSetupError('');
    }
  }, [activePlatform]);

  // Reset weixin QR login state when switching away from weixin
  useEffect(() => {
    if (activePlatform !== 'weixin') {
      if (weixinTimerRef.current) { clearTimeout(weixinTimerRef.current); weixinTimerRef.current = null; }
      setWeixinQrStatus('idle');
      setWeixinQrUrl('');
      setWeixinQrError('');
    }
  }, [activePlatform]);

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
        // Fetch OpenClaw config schema for schema-driven rendering
        imService.getOpenClawConfigSchema().then(schema => {
          if (schema && isMountedRef.current) setOpenclawSchema(schema);
        });
      }
    });
    return () => {
      cancelled = true;
      setConfigLoaded(false);
      imService.destroy();
    };
  }, []);

  // Extract NIM channel schema and hints from the full OpenClaw config schema
  const nimSchemaData = useMemo(() => {
    if (!openclawSchema) return null;
    const { schema, uiHints } = openclawSchema;

    // Find the NIM channel key — could be 'nim' or 'openclaw-nim'
    const channelsProps = (schema as any)?.properties?.channels?.properties ?? {};
    const channelKey = channelsProps['openclaw-nim'] ? 'openclaw-nim' : channelsProps['nim'] ? 'nim' : null;
    if (!channelKey) return null;

    const channelSchema = channelsProps[channelKey] as Record<string, unknown>;
    if (!channelSchema) return null;

    // Filter and strip prefix from uiHints
    const prefix = `channels.${channelKey}.`;
    const hints: Record<string, UiHint> = {};
    for (const [key, value] of Object.entries(uiHints)) {
      if (key.startsWith(prefix)) {
        hints[key.slice(prefix.length)] = value as unknown as UiHint;
      }
    }

    return { schema: channelSchema, hints };
  }, [openclawSchema]);

  // Handle DingTalk multi-instance config
  const dingtalkMultiConfig = config.dingtalk;

  // Handle Feishu multi-instance config
  const feishuMultiConfig = config.feishu;

  // Inline QR code state for feishu bot creation (mirroring WeCom quick-setup pattern)
  // These are used by handleFeishuStartQr which creates instances via QR flow
  // @ts-ignore: will be used when QR flow is wired to FeishuInstanceSettings
  const [_feishuQrStatus, setFeishuQrStatus] = useState<'idle' | 'loading' | 'showing' | 'success' | 'error'>('idle');
  // @ts-ignore
  const [_feishuQrUrl, setFeishuQrUrl] = useState<string>('');
  // @ts-ignore
  const [_feishuQrTimeLeft, setFeishuQrTimeLeft] = useState<number>(0);
  // @ts-ignore
  const [_feishuQrError, setFeishuQrError] = useState<string>('');
  // These don't need to be state — they don't affect rendering directly
  const feishuQrDeviceCodeRef = useRef<string>('');
  const feishuQrPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const feishuQrCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pairing state for OpenClaw platforms
  const [pairingCodeInput, setPairingCodeInput] = useState<Record<string, string>>({});
  const [pairingStatus, setPairingStatus] = useState<Record<string, { type: 'success' | 'error'; message: string } | null>>({});

  const handleApprovePairing = async (platform: string, code: string) => {
    setPairingStatus((prev) => ({ ...prev, [platform]: null }));
    const result = await imService.approvePairingCode(platform, code);
    if (result.success) {
      setPairingStatus((prev) => ({ ...prev, [platform]: { type: 'success', message: i18nService.t('imPairingCodeApproved').replace('{code}', code) } }));
    } else {
      setPairingStatus((prev) => ({ ...prev, [platform]: { type: 'error', message: result.error || i18nService.t('imPairingCodeInvalid') } }));
    }
  };
  // Handle Telegram OpenClaw config change
  const tgOpenClawConfig = config.telegram;
  const handleTelegramOpenClawChange = (update: Partial<TelegramOpenClawConfig>) => {
    dispatch(setTelegramOpenClawConfig(update));
  };
  const handleSaveTelegramOpenClawConfig = async (override?: Partial<TelegramOpenClawConfig>) => {
    if (!configLoaded) return;
    const configToSave = override
      ? { ...tgOpenClawConfig, ...override }
      : tgOpenClawConfig;
    await imService.persistConfig({ telegram: configToSave });
  };

  const qqMultiConfig = config.qq;

  // Handle Discord OpenClaw config change
  const dcOpenClawConfig = config.discord;
  const handleDiscordOpenClawChange = (update: Partial<DiscordOpenClawConfig>) => {
    dispatch(setDiscordConfig(update));
  };
  const handleSaveDiscordOpenClawConfig = async (override?: Partial<DiscordOpenClawConfig>) => {
    if (!configLoaded) return;
    const configToSave = override
      ? { ...dcOpenClawConfig, ...override }
      : dcOpenClawConfig;
    await imService.persistConfig({ discord: configToSave });
  };

  // State for Discord allow-from inputs
  const [discordAllowedUserIdInput, setDiscordAllowedUserIdInput] = useState('');
  const [discordServerAllowIdInput, setDiscordServerAllowIdInput] = useState('');

  // State for POPO allow-from inputs
  const [popoAllowedUserIdInput, setPopoAllowedUserIdInput] = useState('');
  const [popoGroupAllowIdInput, setPopoGroupAllowIdInput] = useState('');


  // Handle NetEase Bee config change
  const handleNeteaseBeeChanChange = (field: 'clientId' | 'secret', value: string) => {
    dispatch(setNeteaseBeeChanConfig({ [field]: value }));
  };

  // Handle WeCom OpenClaw config change
  const wecomOpenClawConfig = config.wecom;
  const handleWecomOpenClawChange = (update: Partial<WecomOpenClawConfig>) => {
    dispatch(setWecomConfig(update));
  };
  const handleSaveWecomOpenClawConfig = async (override?: Partial<WecomOpenClawConfig>) => {
    if (!configLoaded) return;
    const configToSave = override
      ? { ...wecomOpenClawConfig, ...override }
      : wecomOpenClawConfig;
    await imService.persistConfig({ wecom: configToSave });
  };

  // Handle Weixin OpenClaw config
  const weixinOpenClawConfig = config.weixin;

  // Handle POPO OpenClaw config change
  const popoConfig = config.popo;
  const handlePopoChange = (update: Partial<PopoOpenClawConfig>) => {
    dispatch(setPopoConfig(update));
  };
  const handleSavePopoConfig = async (override?: Partial<PopoOpenClawConfig>) => {
    if (!configLoaded) return;
    const configToSave = override
      ? { ...popoConfig, ...override }
      : popoConfig;
    await imService.persistConfig({ popo: configToSave });
  };

  const handleWecomQuickSetup = async () => {
    setWecomQuickSetupStatus('pending');
    setWecomQuickSetupError('');
    try {
      const bot = await WecomAIBotSDK.openBotInfoAuthWindow({
        source: 'lobster-ai',
      });
      if (!isMountedRef.current) return;

      // Save credentials + enable in one atomic operation.
      // im:config:set handler in main process already calls
      // syncOpenClawConfig({ restartGatewayIfRunning: true }) when wecom config changes,
      // so we do NOT call stopGateway/startGateway here to avoid redundant gateway restarts.
      const fullConfig = { ...wecomOpenClawConfig, botId: bot.botid, secret: bot.secret, enabled: true };
      dispatch(setWecomConfig({ botId: bot.botid, secret: bot.secret, enabled: true }));
      dispatch(clearError());
      await imService.updateConfig({ wecom: fullConfig });
      if (!isMountedRef.current) return;
      // Refresh status so the UI reflects the new connected state immediately.
      // OpenClaw channels derive `connected` from config, but updateConfig only
      // reloads config — status needs a separate refresh.
      await imService.loadStatus();
      if (!isMountedRef.current) return;
      setWecomQuickSetupStatus('success');
    } catch (error: unknown) {
      if (!isMountedRef.current) return;
      // Roll back optimistic Redux dispatch so UI matches persisted state
      dispatch(setWecomConfig({
        botId: wecomOpenClawConfig.botId,
        secret: wecomOpenClawConfig.secret,
        enabled: wecomOpenClawConfig.enabled,
      }));
      setWecomQuickSetupStatus('error');
      const err = error as { message?: string; code?: string };
      setWecomQuickSetupError(err.message || err.code || 'Unknown error');
    }
  };

  const handleWeixinQrLogin = async () => {
    setWeixinQrStatus('loading');
    setWeixinQrError('');
    try {
      const startResult = await window.electron.im.weixinQrLoginStart();
      if (!isMountedRef.current) return;

      if (!startResult.success || !startResult.qrDataUrl) {
        setWeixinQrStatus('error');
        setWeixinQrError(startResult.message || i18nService.t('imWeixinQrFailed'));
        return;
      }

      setWeixinQrUrl(startResult.qrDataUrl);
      setWeixinQrStatus('showing');

      // QR expires in ~2 minutes. Show error and let user retry.
      if (weixinTimerRef.current) clearTimeout(weixinTimerRef.current);
      weixinTimerRef.current = setTimeout(() => {
        if (!isMountedRef.current) return;
        setWeixinQrStatus('error');
        setWeixinQrError(i18nService.t('imWeixinQrExpired'));
      }, 120000);

      // Start polling for scan result
      setWeixinQrStatus('waiting');
      const waitResult = await window.electron.im.weixinQrLoginWait(startResult.sessionKey);
      if (weixinTimerRef.current) { clearTimeout(weixinTimerRef.current); weixinTimerRef.current = null; }
      if (!isMountedRef.current) return;

      if (waitResult.success && waitResult.connected) {
        setWeixinQrStatus('success');
        // Enable weixin and save config with accountId
        const accountId = waitResult.accountId || '';
        const fullConfig = { ...weixinOpenClawConfig, enabled: true, accountId };
        dispatch(setWeixinConfig({ enabled: true, accountId }));
        dispatch(clearError());
        await imService.updateConfig({ weixin: fullConfig });
        await imService.loadStatus();
      } else {
        setWeixinQrStatus('error');
        setWeixinQrError(waitResult.message || i18nService.t('imWeixinQrFailed'));
      }
    } catch (err) {
      if (weixinTimerRef.current) { clearTimeout(weixinTimerRef.current); weixinTimerRef.current = null; }
      if (!isMountedRef.current) return;
      setWeixinQrStatus('error');
      setWeixinQrError(String(err));
    }
  };


  const handleSaveConfig = async () => {
    if (!configLoaded) return;

    // For Telegram, save telegram config directly
    if (activePlatform === 'telegram') {
      await imService.persistConfig({ telegram: tgOpenClawConfig });
      return;
    }

    // For Discord, save discord config directly
    if (activePlatform === 'discord') {
      await imService.persistConfig({ discord: dcOpenClawConfig });
      return;
    }

    // For Feishu, save feishu config directly
    if (activePlatform === 'feishu') {
      await imService.persistConfig({ feishu: feishuMultiConfig });
      return;
    }

    // For QQ, save qq config directly (OpenClaw mode)
    if (activePlatform === 'qq') {
      await imService.persistConfig({ qq: qqMultiConfig });
      return;
    }

    // For WeCom, save wecom config directly (OpenClaw mode)
    if (activePlatform === 'wecom') {
      await imService.persistConfig({ wecom: wecomOpenClawConfig });
      return;
    }

    // For Weixin, save weixin config directly (OpenClaw mode)
    if (activePlatform === 'weixin') {
      await imService.persistConfig({ weixin: weixinOpenClawConfig });
      return;
    }

    // For POPO, save popo config directly (OpenClaw mode)
    if (activePlatform === 'popo') {
      await imService.persistConfig({ popo: popoConfig });
      return;
    }

    await imService.persistConfig({ [activePlatform]: config[activePlatform] });
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
    platform: Platform,
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
  const toggleGateway = async (platform: Platform) => {
    // Re-entrancy guard: if a toggle is already in progress for this platform, bail out.
    // This prevents rapid ON→OFF→ON clicks from causing concurrent native SDK init/uninit.
    if (togglingPlatform === platform) return;
    setTogglingPlatform(platform);

    try {
      // All OpenClaw platforms: im:config:set handler already calls
      // syncOpenClawConfig({ restartGatewayIfRunning: true }), so no startGateway/stopGateway needed.
      // Only updateConfig + loadStatus is required.
      // Pessimistic UI update: wait for IPC to complete before updating Redux state.
      // This prevents UI/backend state divergence when rapidly toggling, since the
      // backend debounces syncOpenClawConfig calls with a 600ms window.
      if (platform === 'telegram') {
        const newEnabled = !tgOpenClawConfig.enabled;
        const success = await imService.updateConfig({ telegram: { ...tgOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setTelegramOpenClawConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
        return;
      }

      if (platform === 'dingtalk') {
        // DingTalk multi-instance: toggle is handled per-instance in DingTalkInstanceSettings
        return;
      }

      if (platform === 'feishu') {
        // Feishu multi-instance: toggle is handled per-instance in FeishuInstanceSettings
        return;
      }

      if (platform === 'discord') {
        const newEnabled = !dcOpenClawConfig.enabled;
        const success = await imService.updateConfig({ discord: { ...dcOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setDiscordConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
        return;
      }

      if (platform === 'qq') {
        // QQ multi-instance: toggle is handled per-instance in QQInstanceSettings
        return;
      }

      if (platform === 'wecom') {
        const newEnabled = !wecomOpenClawConfig.enabled;
        const success = await imService.updateConfig({ wecom: { ...wecomOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setWecomConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
        return;
      }

      if (platform === 'weixin') {
        const newEnabled = !weixinOpenClawConfig.enabled;
        const success = await imService.updateConfig({ weixin: { ...weixinOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setWeixinConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
        return;
      }

      if (platform === 'popo') {
        const newEnabled = !popoConfig.enabled;
        const success = await imService.updateConfig({ popo: { ...popoConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setPopoConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
        return;
      }
      if (platform === 'nim') {
        const newEnabled = !config.nim.enabled;
        const success = await imService.updateConfig({ nim: { ...config.nim, enabled: newEnabled } });
        if (success) {
          dispatch(setNimConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
        return;
      }

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

  const dingtalkConnected = status.dingtalk?.instances?.some(i => i.connected) ?? false;
  const feishuConnected = status.feishu?.instances?.some(i => i.connected) ?? false;
  const telegramConnected = status.telegram.connected;
  const discordConnected = status.discord.connected;
  const nimConnected = status.nim.connected;
  const neteaseBeeChanConnected = status['netease-bee']?.connected ?? false;
  const qqConnected = status.qq?.instances?.some(i => i.connected) ?? false;
  const wecomConnected = status.wecom?.connected ?? false;
  const weixinConnected = status.weixin?.connected ?? false;
  const popoConnected = status.popo?.connected ?? false;

  // Compute visible platforms based on language
  const platforms = useMemo<Platform[]>(() => {
    return getVisibleIMPlatforms(language) as Platform[];
  }, [language]);

  // Ensure activePlatform is always in visible platforms when language changes
  useEffect(() => {
    if (platforms.length > 0 && !platforms.includes(activePlatform)) {
      // If current activePlatform is not visible, switch to first visible platform
      setActivePlatform(platforms[0]);
    }
  }, [platforms, activePlatform]);

  // Check if platform can be started
  const canStart = (platform: Platform): boolean => {
    if (platform === 'dingtalk') {
      return config.dingtalk.instances.some(i => !!(i.clientId && i.clientSecret));
    }
    if (platform === 'telegram') {
      return !!tgOpenClawConfig.botToken;
    }
    if (platform === 'discord') {
      return !!config.discord.botToken;
    }
    if (platform === 'nim') {
      return !!(config.nim.appKey && config.nim.account && config.nim.token);
    }
    if (platform === 'netease-bee') {
      return !!(config['netease-bee'].clientId && config['netease-bee'].secret);
    }
    if (platform === 'qq') {
      return config.qq.instances.some(i => !!(i.appId && i.appSecret));
    }
    if (platform === 'wecom') {
      return !!(wecomOpenClawConfig.botId && wecomOpenClawConfig.secret);
    }
    if (platform === 'weixin') {
      return true; // No credentials needed, connects via QR code in CLI
    }
    if (platform === 'popo') {
      const effectiveMode = config.popo.connectionMode || (config.popo.token ? 'webhook' : 'websocket');
      if (effectiveMode === 'webhook') {
        return !!(config.popo.appKey && config.popo.appSecret && config.popo.token && config.popo.aesKey);
      }
      return !!(config.popo.appKey && config.popo.appSecret && config.popo.aesKey);
    }
    return config.feishu.instances?.some(i => !!(i.appId && i.appSecret));
  };

  // Get platform enabled state (persisted toggle state)
  const isPlatformEnabled = (platform: Platform): boolean => {
    if (platform === 'dingtalk') {
      return config.dingtalk.instances?.some(i => i.enabled);
    }
    if (platform === 'qq') {
      return config.qq.instances.some(i => i.enabled);
    }
    if (platform === 'feishu') {
      return config.feishu.instances?.some(i => i.enabled);
    }
    return (config[platform] as { enabled: boolean }).enabled;
  };

  // Get platform connection status (runtime state)
  const getPlatformConnected = (platform: Platform): boolean => {
    if (platform === 'dingtalk') return dingtalkConnected;
    if (platform === 'telegram') return telegramConnected;
    if (platform === 'discord') return discordConnected;
    if (platform === 'nim') return nimConnected;
    if (platform === 'netease-bee') return neteaseBeeChanConnected;
    if (platform === 'qq') return qqConnected;
    if (platform === 'wecom') return wecomConnected;
    if (platform === 'weixin') return weixinConnected;
    if (platform === 'popo') return popoConnected;
    return feishuConnected;
  };

  // Get platform transient starting status
  const getPlatformStarting = (platform: Platform): boolean => {
    if (platform === 'discord') return status.discord.starting;
    return false;
  };

  const handleConnectivityTest = async (platform: Platform) => {
    // Re-entrancy guard: if a test is already running, do nothing.
    if (testingPlatform) return;

    setConnectivityModalPlatform(platform);
    setTestingPlatform(platform);

    // For Telegram, persist telegram config and test
    if (platform === 'telegram') {
      await imService.persistConfig({ telegram: tgOpenClawConfig });
      const result = await runConnectivityTest(platform, {
        telegram: tgOpenClawConfig,
      } as Partial<IMGatewayConfig>);
      // Auto-enable: if OFF and auth_check passed, turn on automatically
      if (!tgOpenClawConfig.enabled && result) {
        const authCheck = result.checks.find((c) => c.code === 'auth_check');
        if (authCheck && authCheck.level === 'pass') {
          toggleGateway(platform);
        }
      }
      return;
    }

    // For DingTalk, persist dingtalk config and test (OpenClaw mode)
    if (platform === 'dingtalk') {
      await imService.persistConfig({ dingtalk: dingtalkMultiConfig });
      const result = await runConnectivityTest(platform, {
        dingtalk: dingtalkMultiConfig,
      } as Partial<IMGatewayConfig>);
      // Auto-enable: if the active instance is OFF and auth_check passed, turn on automatically
      if (activeDingTalkInstanceId && result) {
        const inst = dingtalkMultiConfig.instances.find(i => i.instanceId === activeDingTalkInstanceId);
        if (inst && !inst.enabled) {
          const authCheck = result.checks.find((c) => c.code === 'auth_check');
          if (authCheck && authCheck.level === 'pass') {
            dispatch(setDingTalkInstanceConfig({ instanceId: activeDingTalkInstanceId, config: { enabled: true } }));
            await imService.updateDingTalkInstanceConfig(activeDingTalkInstanceId, { enabled: true });
          }
        }
      }
      return;
    }

    // For QQ, persist qq config and test (OpenClaw mode)
    if (platform === 'qq') {
      await imService.persistConfig({ qq: qqMultiConfig });
      const result = await runConnectivityTest(platform, {
        qq: qqMultiConfig,
      } as Partial<IMGatewayConfig>);
      // Auto-enable: if the active instance is OFF and auth_check passed, turn on automatically
      if (activeQQInstanceId && result) {
        const inst = qqMultiConfig.instances.find(i => i.instanceId === activeQQInstanceId);
        if (inst && !inst.enabled) {
          const authCheck = result.checks.find((c) => c.code === 'auth_check');
          if (authCheck && authCheck.level === 'pass') {
            dispatch(setQQInstanceConfig({ instanceId: activeQQInstanceId, config: { enabled: true } }));
            await imService.updateQQInstanceConfig(activeQQInstanceId, { enabled: true });
          }
        }
      }
      return;
    }

    // For WeCom, persist wecom config and test (OpenClaw mode)
    if (platform === 'wecom') {
      await imService.persistConfig({ wecom: wecomOpenClawConfig });
      const result = await runConnectivityTest(platform, {
        wecom: wecomOpenClawConfig,
      } as Partial<IMGatewayConfig>);
      if (!wecomOpenClawConfig.enabled && result) {
        const authCheck = result.checks.find((c) => c.code === 'auth_check');
        if (authCheck && authCheck.level === 'pass') {
          toggleGateway(platform);
        }
      }
      return;
    }

    // For Weixin, persist weixin config and test (OpenClaw mode)
    if (platform === 'weixin') {
      await imService.persistConfig({ weixin: weixinOpenClawConfig });
      const result = await runConnectivityTest(platform, {
        weixin: weixinOpenClawConfig,
      } as Partial<IMGatewayConfig>);
      if (!weixinOpenClawConfig.enabled && result) {
        const authCheck = result.checks.find((c) => c.code === 'auth_check');
        if (authCheck && authCheck.level === 'pass') {
          toggleGateway(platform);
        }
      }
      return;
    }

    // For Feishu, persist feishu config and test (OpenClaw mode)
    if (platform === 'feishu') {
      await imService.persistConfig({ feishu: feishuMultiConfig });
      const result = await runConnectivityTest(platform, {
        feishu: feishuMultiConfig,
      } as Partial<IMGatewayConfig>);
      // Auto-enable: if the active instance is OFF and auth_check passed, turn on automatically
      if (activeFeishuInstanceId && result) {
        const inst = feishuMultiConfig.instances.find(i => i.instanceId === activeFeishuInstanceId);
        if (inst && !inst.enabled) {
          const authCheck = result.checks.find((c) => c.code === 'auth_check');
          if (authCheck && authCheck.level === 'pass') {
            dispatch(setFeishuInstanceConfig({ instanceId: activeFeishuInstanceId, config: { enabled: true } }));
            await imService.updateFeishuInstanceConfig(activeFeishuInstanceId, { enabled: true });
          }
        }
      }
      return;
    }

    // 1. Persist latest config to backend (without changing enabled state)
    await imService.persistConfig({
      [platform]: config[platform],
    } as Partial<IMGatewayConfig>);

    const isEnabled = isPlatformEnabled(platform);

    // For NIM, skip the frontend stop/start cycle entirely.
    // The backend's testNimConnectivity already manages the SDK lifecycle
    // (stop main → probe with temp instance → restart main) under a mutex,
    // so doing stop/start here would cause a race condition and potential crash.
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
  const handlePlatformToggle = (platform: Platform) => {
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
  const getSetConfigAction = (platform: Platform) => {
    const actionMap: Record<Platform, any> = {
      dingtalk: setDingTalkConfig,
      feishu: setFeishuConfig,
      telegram: setTelegramOpenClawConfig,
      qq: setQQConfig,
      discord: setDiscordConfig,
      nim: setNimConfig,
      'netease-bee': setNeteaseBeeChanConfig,
      wecom: setWecomConfig,
      weixin: setWeixinConfig,
      popo: setPopoConfig,
    };
    return actionMap[platform];
  };

  const renderConnectivityTestButton = (platform: Platform) => (
    <button
      type="button"
      onClick={() => handleConnectivityTest(platform)}
      disabled={isLoading || testingPlatform === platform}
      className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
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

  const renderPairingSection = (platform: string) => (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-secondary">
        {i18nService.t('imPairingApproval')}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={pairingCodeInput[platform] || ''}
          onChange={(e) => {
            setPairingCodeInput((prev) => ({ ...prev, [platform]: e.target.value.toUpperCase() }));
            if (pairingStatus[platform]) setPairingStatus((prev) => ({ ...prev, [platform]: null }));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const code = (pairingCodeInput[platform] || '').trim();
              if (code) {
                void handleApprovePairing(platform, code).then(() => {
                  setPairingCodeInput((prev) => ({ ...prev, [platform]: '' }));
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
            const code = (pairingCodeInput[platform] || '').trim();
            if (code) {
              void handleApprovePairing(platform, code).then(() => {
                setPairingCodeInput((prev) => ({ ...prev, [platform]: '' }));
              });
            }
          }}
          className="px-3 py-2 rounded-lg text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400 hover:bg-green-500/25 transition-colors"
        >
          {i18nService.t('imPairingApprove')}
        </button>
      </div>
      {pairingStatus[platform] && (
        <p className={`text-xs ${pairingStatus[platform]!.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {pairingStatus[platform]!.type === 'success' ? '\u2713' : '\u2717'} {pairingStatus[platform]!.message}
        </p>
      )}
    </div>
  );

  return (
    <div className="flex h-full gap-4">
      {/* Platform List - Left Side */}
      <div className="w-48 flex-shrink-0 border-r border-border pr-3 space-y-2 overflow-y-auto">
        {platforms.map((platform) => {
                const logo = PlatformRegistry.logo(platform);
           const isEnabled = isPlatformEnabled(platform);
          const isConnected = getPlatformConnected(platform) || getPlatformStarting(platform);
          const canToggle = isEnabled || canStart(platform);

          if (platform === 'dingtalk') {
            return (
              <div key="dingtalk">
                {/* DingTalk Platform Header - clickable to expand/collapse */}
                <div
                  onClick={() => { setActivePlatform('dingtalk'); setActiveDingTalkInstanceId(null); setDingtalkExpanded(!dingtalkExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'dingtalk'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('dingtalk')} alt="DingTalk" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'dingtalk' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('dingtalk')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{dingtalkExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
                {/* DingTalk Instance Sub-items */}
                {dingtalkExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.dingtalk.instances.map((inst) => {
                      const instStatus = status.dingtalk?.instances?.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'dingtalk' && activeDingTalkInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('dingtalk'); setActiveDingTalkInstanceId(inst.instanceId); }}
                          className={`flex items-center p-1.5 pl-2 rounded-lg cursor-pointer transition-colors text-sm ${
                            isSelected
                              ? 'bg-primary/10 dark:bg-primary/20'
                              : 'hover:bg-surface-raised'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full ${dotColor} mr-2 flex-shrink-0`} />
                          <span className={`truncate flex-1 ${isSelected ? 'text-primary font-medium' : 'text-foreground'}`}>
                            {inst.instanceName}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          if (platform === 'feishu') {
            return (
              <div key="feishu">
                {/* Feishu Platform Header - clickable to expand/collapse */}
                <div
                  onClick={() => { setActivePlatform('feishu'); setActiveFeishuInstanceId(null); setFeishuExpanded(!feishuExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'feishu'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('feishu')} alt="Feishu" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'feishu' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('feishu')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{feishuExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
                {/* Feishu Instance Sub-items */}
                {feishuExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.feishu.instances.map((inst) => {
                      const instStatus = status.feishu?.instances?.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'feishu' && activeFeishuInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('feishu'); setActiveFeishuInstanceId(inst.instanceId); }}
                          className={`flex items-center p-1.5 pl-2 rounded-lg cursor-pointer transition-colors text-sm ${
                            isSelected
                              ? 'bg-primary/10 dark:bg-primary/20'
                              : 'hover:bg-surface-raised'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full ${dotColor} mr-2 flex-shrink-0`} />
                          <span className={`truncate flex-1 ${isSelected ? 'text-primary font-medium' : 'text-foreground'}`}>
                            {inst.instanceName}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          if (platform === 'qq') {
            return (
              <div key="qq">
                {/* QQ Platform Header - clickable to expand/collapse */}
                <div
                  onClick={() => { setActivePlatform('qq'); setActiveQQInstanceId(null); setQqExpanded(!qqExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'qq'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('qq')} alt="QQ" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'qq' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('qq')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{qqExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
                {/* QQ Instance Sub-items */}
                {qqExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.qq.instances.map((inst) => {
                      const instStatus = status.qq?.instances?.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'qq' && activeQQInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('qq'); setActiveQQInstanceId(inst.instanceId); }}
                          className={`flex items-center p-1.5 pl-2 rounded-lg cursor-pointer transition-colors text-sm ${
                            isSelected
                              ? 'bg-primary/10 dark:bg-primary/20'
                              : 'hover:bg-surface-raised'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full ${dotColor} mr-2 flex-shrink-0`} />
                          <span className={`truncate flex-1 ${isSelected ? 'text-primary font-medium' : 'text-foreground'}`}>
                            {inst.instanceName}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div
              key={platform}
              onClick={() => setActivePlatform(platform)}
              className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                activePlatform === platform
                  ? 'bg-primary-muted border border-primary shadow-subtle'
                  : 'bg-surface hover:bg-surface-raised border border-transparent'
              }`}
            >
              <div className="flex flex-1 items-center">
                <div className="mr-2 flex h-7 w-7 items-center justify-center">
                  <img
                    src={logo}
                    alt={i18nService.t(platform)}
                    className="w-6 h-6 object-contain rounded-md"
                  />
                </div>
                <span className={`text-sm font-medium truncate ${
                  activePlatform === platform
                    ? 'text-primary'
                    : 'text-foreground'
                }`}>
                  {i18nService.t(platform)}
                </span>
              </div>
              <div className="flex items-center ml-2">
                <div
                  className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                    isEnabled
                      ? (isConnected ? 'bg-green-500' : 'bg-yellow-500')
                      : 'bg-gray-400 dark:bg-gray-600'
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
        {/* Header with status (hidden for QQ which has per-instance headers) */}
        {activePlatform !== 'qq' && activePlatform !== 'feishu' && activePlatform !== 'dingtalk' && (
        <div className="flex items-center gap-3 pb-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
             <div className="flex h-7 w-7 items-center justify-center rounded-md bg-surface border border-border-subtle p-1">
               <img
                src={PlatformRegistry.logo(activePlatform)}
                 alt={i18nService.t(activePlatform)}
                 className="w-4 h-4 object-contain rounded"
               />
            </div>
            <h3 className="text-sm font-medium text-foreground">
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
        )}


        {/* DingTalk Settings (multi-instance) */}
        {activePlatform === 'dingtalk' && !activeDingTalkInstanceId && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img src={PlatformRegistry.logo('dingtalk')} alt="DingTalk" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
            <p className="text-sm text-secondary mb-4">
              {config.dingtalk.instances.length === 0
                ? (language === 'zh' ? '尚未添加钉钉实例，点击下方按钮添加' : 'No DingTalk instances yet. Click below to add one.')
                : (language === 'zh' ? '请在左侧选择一个钉钉实例' : 'Select a DingTalk instance from the sidebar.')}
            </p>
            {config.dingtalk.instances.length < MAX_DINGTALK_INSTANCES && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const inst = await imService.addDingTalkInstance(`DingTalk Bot ${config.dingtalk.instances.length + 1}`);
                  if (inst) { setActiveDingTalkInstanceId(inst.instanceId); setDingtalkExpanded(true); }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                + {i18nService.t('imDingTalkAddInstance')}
              </button>
            )}
          </div>
        )}
        {activePlatform === 'dingtalk' && activeDingTalkInstanceId && (() => {
          const selectedInstance = config.dingtalk.instances.find(i => i.instanceId === activeDingTalkInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.dingtalk?.instances?.find(s => s.instanceId === activeDingTalkInstanceId);
          return (
            <DingTalkInstanceSettings
              instance={selectedInstance}
              instanceStatus={selectedStatus}
              onConfigChange={(update) => {
                dispatch(setDingTalkInstanceConfig({ instanceId: activeDingTalkInstanceId, config: update }));
              }}
              onSave={async (override) => {
                const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                if (selectedInstance.enabled) {
                  await imService.updateDingTalkInstanceConfig(activeDingTalkInstanceId, configToSave);
                } else {
                  await imService.persistDingTalkInstanceConfig(activeDingTalkInstanceId, configToSave);
                }
              }}
              onRename={async (newName) => {
                dispatch(setDingTalkInstanceConfig({ instanceId: activeDingTalkInstanceId, config: { instanceName: newName } as any }));
                await imService.persistDingTalkInstanceConfig(activeDingTalkInstanceId, { instanceName: newName } as any);
              }}
              onDelete={async () => {
                await imService.deleteDingTalkInstance(activeDingTalkInstanceId);
                const remaining = config.dingtalk.instances.filter(i => i.instanceId !== activeDingTalkInstanceId);
                setActiveDingTalkInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
              }}
              onToggleEnabled={async () => {
                const newEnabled = !selectedInstance.enabled;
                if (newEnabled && !(selectedInstance.clientId && selectedInstance.clientSecret)) return;
                const success = await imService.updateDingTalkInstanceConfig(activeDingTalkInstanceId, { enabled: newEnabled });
                if (success) {
                  dispatch(setDingTalkInstanceConfig({ instanceId: activeDingTalkInstanceId, config: { enabled: newEnabled } }));
                  if (newEnabled) dispatch(clearError());
                }
              }}
              onTestConnectivity={() => {
                void handleConnectivityTest('dingtalk');
              }}
              testingPlatform={testingPlatform}
              connectivityResults={connectivityResults}
              language={language}
            />
          );
        })()}

        {/* Feishu Settings (multi-instance) */}
        {activePlatform === 'feishu' && !activeFeishuInstanceId && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img src={PlatformRegistry.logo('feishu')} alt="Feishu" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
            <p className="text-sm text-secondary mb-4">
              {config.feishu.instances.length === 0
                ? (language === 'zh' ? '尚未添加飞书实例，点击下方按钮添加' : 'No Feishu instances yet. Click below to add one.')
                : (language === 'zh' ? '请在左侧选择一个飞书实例' : 'Select a Feishu instance from the sidebar.')}
            </p>
            {config.feishu.instances.length < MAX_FEISHU_INSTANCES && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const inst = await imService.addFeishuInstance(`Feishu Bot ${config.feishu.instances.length + 1}`);
                  if (inst) { setActiveFeishuInstanceId(inst.instanceId); setFeishuExpanded(true); }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                + {i18nService.t('imFeishuAddInstance')}
              </button>
            )}
          </div>
        )}
        {activePlatform === 'feishu' && activeFeishuInstanceId && (() => {
          const selectedInstance = config.feishu.instances.find(i => i.instanceId === activeFeishuInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.feishu?.instances?.find(s => s.instanceId === activeFeishuInstanceId);
          return (
            <FeishuInstanceSettings
              instance={selectedInstance}
              instanceStatus={selectedStatus}
              onConfigChange={(update) => {
                dispatch(setFeishuInstanceConfig({ instanceId: activeFeishuInstanceId, config: update }));
              }}
              onSave={async (override) => {
                const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                if (selectedInstance.enabled) {
                  await imService.updateFeishuInstanceConfig(activeFeishuInstanceId, configToSave);
                } else {
                  await imService.persistFeishuInstanceConfig(activeFeishuInstanceId, configToSave);
                }
              }}
              onRename={async (newName) => {
                dispatch(setFeishuInstanceConfig({ instanceId: activeFeishuInstanceId, config: { instanceName: newName } as any }));
                await imService.persistFeishuInstanceConfig(activeFeishuInstanceId, { instanceName: newName } as any);
              }}
              onDelete={async () => {
                await imService.deleteFeishuInstance(activeFeishuInstanceId);
                const remaining = config.feishu.instances.filter(i => i.instanceId !== activeFeishuInstanceId);
                setActiveFeishuInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
              }}
              onToggleEnabled={async () => {
                const newEnabled = !selectedInstance.enabled;
                if (newEnabled && !(selectedInstance.appId && selectedInstance.appSecret)) return;
                const success = await imService.updateFeishuInstanceConfig(activeFeishuInstanceId, { enabled: newEnabled });
                if (success) {
                  dispatch(setFeishuInstanceConfig({ instanceId: activeFeishuInstanceId, config: { enabled: newEnabled } }));
                  if (newEnabled) dispatch(clearError());
                }
              }}
              onTestConnectivity={() => {
                void handleConnectivityTest('feishu');
              }}
              testingPlatform={testingPlatform}
              connectivityResults={connectivityResults}
              language={language}
            />
          );
        })()}

        {/* QQ Settings (multi-instance) */}
        {activePlatform === 'qq' && !activeQQInstanceId && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img src={PlatformRegistry.logo('qq')} alt="QQ" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
            <p className="text-sm text-secondary mb-4">
              {config.qq.instances.length === 0
                ? (language === 'zh' ? '尚未添加 QQ 实例，点击下方按钮添加' : 'No QQ instances yet. Click below to add one.')
                : (language === 'zh' ? '请在左侧选择一个 QQ 实例' : 'Select a QQ instance from the sidebar.')}
            </p>
            {config.qq.instances.length < MAX_QQ_INSTANCES && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const inst = await imService.addQQInstance(`QQ Bot ${config.qq.instances.length + 1}`);
                  if (inst) { setActiveQQInstanceId(inst.instanceId); setQqExpanded(true); }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                + {i18nService.t('imQQAddInstance')}
              </button>
            )}
          </div>
        )}
        {activePlatform === 'qq' && activeQQInstanceId && (() => {
          const selectedInstance = config.qq.instances.find(i => i.instanceId === activeQQInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.qq?.instances?.find(s => s.instanceId === activeQQInstanceId);
          return (
            <QQInstanceSettings
              instance={selectedInstance}
              instanceStatus={selectedStatus}
              onConfigChange={(update) => {
                dispatch(setQQInstanceConfig({ instanceId: activeQQInstanceId, config: update }));
              }}
              onSave={async (override) => {
                const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                if (selectedInstance.enabled) {
                  await imService.updateQQInstanceConfig(activeQQInstanceId, configToSave);
                } else {
                  await imService.persistQQInstanceConfig(activeQQInstanceId, configToSave);
                }
              }}
              onRename={async (newName) => {
                dispatch(setQQInstanceConfig({ instanceId: activeQQInstanceId, config: { instanceName: newName } as any }));
                await imService.persistQQInstanceConfig(activeQQInstanceId, { instanceName: newName } as any);
              }}
              onDelete={async () => {
                await imService.deleteQQInstance(activeQQInstanceId);
                const remaining = config.qq.instances.filter(i => i.instanceId !== activeQQInstanceId);
                setActiveQQInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
              }}
              onToggleEnabled={async () => {
                const newEnabled = !selectedInstance.enabled;
                if (newEnabled && !(selectedInstance.appId && selectedInstance.appSecret)) return;
                const success = await imService.updateQQInstanceConfig(activeQQInstanceId, { enabled: newEnabled });
                if (success) {
                  dispatch(setQQInstanceConfig({ instanceId: activeQQInstanceId, config: { enabled: newEnabled } }));
                  if (newEnabled) dispatch(clearError());
                }
              }}
              onTestConnectivity={() => {
                void handleConnectivityTest('qq');
              }}
              testingPlatform={testingPlatform}
              connectivityResults={connectivityResults}
              language={language}
            />
          );
        })()}

        {/* Telegram Settings */}
        {activePlatform === 'telegram' && (
          <div className="space-y-3">
            <PlatformGuide
              steps={[
                i18nService.t('imTelegramGuideStep1'),
                i18nService.t('imTelegramGuideStep2'),
                i18nService.t('imTelegramGuideStep3'),
                i18nService.t('imTelegramGuideStep4'),
              ]}
                guideUrl={PlatformRegistry.guideUrl('telegram')}
            />
            {/* Bot Token */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">
                Bot Token
              </label>
              <div className="relative">
                <input
                  type={showSecrets['telegram.botToken'] ? 'text' : 'password'}
                  value={tgOpenClawConfig.botToken}
                  onChange={(e) => handleTelegramOpenClawChange({ botToken: e.target.value })}
                  onBlur={() => handleSaveTelegramOpenClawConfig()}
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {tgOpenClawConfig.botToken && (
                    <button
                      type="button"
                      onClick={() => { handleTelegramOpenClawChange({ botToken: '' }); void imService.persistConfig({ telegram: { ...tgOpenClawConfig, botToken: '' } }); }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'telegram.botToken': !prev['telegram.botToken'] }))}
                    className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                    title={showSecrets['telegram.botToken'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['telegram.botToken'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <p className="text-xs text-secondary">
                {i18nService.t('imTelegramTokenHint')}
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
                    value={tgOpenClawConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as TelegramOpenClawConfig['dmPolicy'] };
                      handleTelegramOpenClawChange(update);
                      void handleSaveTelegramOpenClawConfig(update);
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
                {tgOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('telegram')}

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
                          if (id && !tgOpenClawConfig.allowFrom.includes(id)) {
                            const newIds = [...tgOpenClawConfig.allowFrom, id];
                            handleTelegramOpenClawChange({ allowFrom: newIds });
                            setAllowedUserIdInput('');
                            void imService.persistConfig({ telegram: { ...tgOpenClawConfig, allowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
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
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {tgOpenClawConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {tgOpenClawConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = tgOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                              handleTelegramOpenClawChange({ allowFrom: newIds });
                              void imService.persistConfig({ telegram: { ...tgOpenClawConfig, allowFrom: newIds } });
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

                {/* Streaming Mode */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    Streaming
                  </label>
                  <select
                    value={tgOpenClawConfig.streaming}
                    onChange={(e) => {
                      const update = { streaming: e.target.value as TelegramOpenClawConfig['streaming'] };
                      handleTelegramOpenClawChange(update);
                      void handleSaveTelegramOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  >
                    <option value="off">Off</option>
                    <option value="partial">Partial</option>
                    <option value="block">Block</option>
                    <option value="progress">Progress</option>
                  </select>
                </div>

                {/* Proxy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    Proxy
                  </label>
                  <input
                    type="text"
                    value={tgOpenClawConfig.proxy}
                    onChange={(e) => handleTelegramOpenClawChange({ proxy: e.target.value })}
                    onBlur={() => handleSaveTelegramOpenClawConfig()}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                    placeholder="socks5://localhost:9050"
                  />
                </div>

                {/* Group Policy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    Group Policy
                  </label>
                  <select
                    value={tgOpenClawConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as TelegramOpenClawConfig['groupPolicy'] };
                      handleTelegramOpenClawChange(update);
                      void handleSaveTelegramOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  >
                    <option value="allowlist">Allowlist</option>
                    <option value="open">Open</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>

                {/* Reply-to Mode */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    Reply-to Mode
                  </label>
                  <select
                    value={tgOpenClawConfig.replyToMode}
                    onChange={(e) => {
                      const update = { replyToMode: e.target.value as TelegramOpenClawConfig['replyToMode'] };
                      handleTelegramOpenClawChange(update);
                      void handleSaveTelegramOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  >
                    <option value="off">Off</option>
                    <option value="first">First</option>
                    <option value="all">All</option>
                  </select>
                </div>

                {/* History Limit */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    History Limit
                  </label>
                  <input
                    type="number"
                    value={tgOpenClawConfig.historyLimit}
                    onChange={(e) => handleTelegramOpenClawChange({ historyLimit: parseInt(e.target.value) || 50 })}
                    onBlur={() => handleSaveTelegramOpenClawConfig()}
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
                    value={tgOpenClawConfig.mediaMaxMb}
                    onChange={(e) => handleTelegramOpenClawChange({ mediaMaxMb: parseInt(e.target.value) || 5 })}
                    onBlur={() => handleSaveTelegramOpenClawConfig()}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                    min="1"
                    max="50"
                  />
                </div>

                {/* Link Preview */}
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-secondary">
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
                      tgOpenClawConfig.linkPreview ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      tgOpenClawConfig.linkPreview ? 'translate-x-4' : 'translate-x-0'
                    }`} />
                  </button>
                </div>

                {/* Webhook URL */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    Webhook URL
                  </label>
                  <input
                    type="text"
                    value={tgOpenClawConfig.webhookUrl}
                    onChange={(e) => handleTelegramOpenClawChange({ webhookUrl: e.target.value })}
                    onBlur={() => handleSaveTelegramOpenClawConfig()}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                    placeholder="https://example.com/telegram-webhook"
                  />
                </div>

                {/* Webhook Secret */}
                {tgOpenClawConfig.webhookUrl && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-secondary">
                      Webhook Secret
                    </label>
                    <input
                      type="password"
                      value={tgOpenClawConfig.webhookSecret}
                      onChange={(e) => handleTelegramOpenClawChange({ webhookSecret: e.target.value })}
                      onBlur={() => handleSaveTelegramOpenClawConfig()}
                      className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                      placeholder="webhook-secret"
                    />
                  </div>
                )}
              </div>
            </details>

            <div className="pt-1">
              {renderConnectivityTestButton('telegram')}
            </div>
          </div>
        )}

        {/* Discord Settings */}
        {activePlatform === 'discord' && (
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
                guideUrl={PlatformRegistry.guideUrl('discord')}
            />
            {/* Bot Token */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">
                Bot Token
              </label>
              <div className="relative">
                <input
                  type={showSecrets['discord.botToken'] ? 'text' : 'password'}
                  value={dcOpenClawConfig.botToken}
                  onChange={(e) => handleDiscordOpenClawChange({ botToken: e.target.value })}
                  onBlur={() => handleSaveDiscordOpenClawConfig()}
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ..."
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {dcOpenClawConfig.botToken && (
                    <button
                      type="button"
                      onClick={() => { handleDiscordOpenClawChange({ botToken: '' }); void imService.persistConfig({ discord: { ...dcOpenClawConfig, botToken: '' } }); }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'discord.botToken': !prev['discord.botToken'] }))}
                    className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                    title={showSecrets['discord.botToken'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['discord.botToken'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <p className="text-xs text-secondary">
                {i18nService.t('imDiscordTokenHint')}
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
                    value={dcOpenClawConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as DiscordOpenClawConfig['dmPolicy'] };
                      handleDiscordOpenClawChange(update);
                      void handleSaveDiscordOpenClawConfig(update);
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
                {dcOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('discord')}

                {/* Allow From (User IDs) */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
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
                      className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
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
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {dcOpenClawConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {dcOpenClawConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = dcOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                              handleDiscordOpenClawChange({ allowFrom: newIds });
                              void imService.persistConfig({ discord: { ...dcOpenClawConfig, allowFrom: newIds } });
                            }}
                            className="text-secondary hover:text-red-500 transition-colors"
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
                  <label className="block text-xs font-medium text-secondary">
                    Streaming
                  </label>
                  <select
                    value={dcOpenClawConfig.streaming}
                    onChange={(e) => {
                      const update = { streaming: e.target.value as DiscordOpenClawConfig['streaming'] };
                      handleDiscordOpenClawChange(update);
                      void handleSaveDiscordOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  >
                    <option value="off">Off</option>
                    <option value="partial">Partial</option>
                    <option value="block">Block</option>
                    <option value="progress">Progress</option>
                  </select>
                </div>

                {/* Proxy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    Proxy
                  </label>
                  <input
                    type="text"
                    value={dcOpenClawConfig.proxy}
                    onChange={(e) => handleDiscordOpenClawChange({ proxy: e.target.value })}
                    onBlur={() => handleSaveDiscordOpenClawConfig()}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                    placeholder="http://proxy:port"
                  />
                </div>

                {/* Group Policy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    Group Policy
                  </label>
                  <select
                    value={dcOpenClawConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as DiscordOpenClawConfig['groupPolicy'] };
                      handleDiscordOpenClawChange(update);
                      void handleSaveDiscordOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  >
                    <option value="allowlist">{i18nService.t('imGroupPolicyAllowlist')}</option>
                    <option value="open">{i18nService.t('imGroupPolicyOpen')}</option>
                    <option value="disabled">{i18nService.t('imGroupPolicyDisabled')}</option>
                  </select>
                </div>

                {/* Group Allow From (Server IDs) */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
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
                      className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
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
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {dcOpenClawConfig.groupAllowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {dcOpenClawConfig.groupAllowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = dcOpenClawConfig.groupAllowFrom.filter((gid) => gid !== id);
                              handleDiscordOpenClawChange({ groupAllowFrom: newIds });
                              void imService.persistConfig({ discord: { ...dcOpenClawConfig, groupAllowFrom: newIds } });
                            }}
                            className="text-secondary hover:text-red-500 transition-colors"
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
                  <label className="block text-xs font-medium text-secondary">
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
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Media Max MB */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
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
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
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
        )}

        {/* NIM (NetEase IM) Settings */}
        {activePlatform === 'nim' && (
          <div className="space-y-3">
            <PlatformGuide
              title={i18nService.t('nimCredentialsGuide')}
              steps={[
                i18nService.t('nimGuideStep1'),
                i18nService.t('nimGuideStep2'),
                i18nService.t('nimGuideStep3'),
                i18nService.t('nimGuideStep4'),
              ]}
            />

            {nimSchemaData ? (
              <SchemaForm
                schema={nimSchemaData.schema}
                hints={nimSchemaData.hints}
                value={config.nim as unknown as Record<string, unknown>}
                onChange={(path, value) => {
                  const updated = deepSet({ ...config.nim } as unknown as Record<string, unknown>, path, value);
                  dispatch(setNimConfig(updated as any));
                }}
                onBlur={handleSaveConfig}
                showSecrets={showSecrets}
                onToggleSecret={(path) => setShowSecrets(prev => ({ ...prev, [path]: !prev[path] }))}
              />
            ) : (
              /* Fallback: minimal credential inputs when schema not yet loaded */
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">App Key</label>
                  <input
                    type="text"
                    value={config.nim.appKey}
                    onChange={(e) => dispatch(setNimConfig({ appKey: e.target.value }))}
                    onBlur={handleSaveConfig}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                    placeholder="your_app_key"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">Account</label>
                  <input
                    type="text"
                    value={config.nim.account}
                    onChange={(e) => dispatch(setNimConfig({ account: e.target.value }))}
                    onBlur={handleSaveConfig}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                    placeholder="bot_account_id"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">Token</label>
                  <input
                    type="password"
                    value={config.nim.token}
                    onChange={(e) => dispatch(setNimConfig({ token: e.target.value }))}
                    onBlur={handleSaveConfig}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                    placeholder="••••••••••••"
                  />
                </div>
              </div>
            )}

            <div className="pt-1">
              {renderConnectivityTestButton('nim')}
            </div>

            {status.nim.botAccount && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Account: {status.nim.botAccount}
              </div>
            )}

            {status.nim.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {translateIMError(status.nim.lastError)}
              </div>
            )}
          </div>
        )}

        {/* 小蜜蜂设置*/}
        {activePlatform === 'netease-bee' && (
          <div className="space-y-3">
            {/* Client ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">
                Client ID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={config['netease-bee'].clientId}
                  onChange={(e) => handleNeteaseBeeChanChange('clientId', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder={i18nService.t('neteaseBeeChanClientIdPlaceholder') || '您的Client ID'}
                />
                {config['netease-bee'].clientId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleNeteaseBeeChanChange('clientId', ''); void imService.persistConfig({ 'netease-bee': { ...config['netease-bee'], clientId: '' } }); }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
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
              <label className="block text-xs font-medium text-secondary">
                Client Secret
              </label>
              <div className="relative">
                <input
                  type={showSecrets['netease-bee.secret'] ? 'text' : 'password'}
                  value={config['netease-bee'].secret}
                  onChange={(e) => handleNeteaseBeeChanChange('secret', e.target.value)}
                  onBlur={handleSaveConfig}
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {config['netease-bee'].secret && (
                    <button
                      type="button"
                      onClick={() => { handleNeteaseBeeChanChange('secret', ''); void imService.persistConfig({ 'netease-bee': { ...config['netease-bee'], secret: '' } }); }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'netease-bee.secret': !prev['netease-bee.secret'] }))}
                    className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                    title={showSecrets['netease-bee.secret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['netease-bee.secret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-1">
              {renderConnectivityTestButton('netease-bee')}
            </div>

            {/* Bot account display */}
            {status['netease-bee']?.botAccount && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Account: {status['netease-bee'].botAccount}
              </div>
            )}

            {/* Error display */}
            {status['netease-bee']?.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {translateIMError(status['netease-bee'].lastError)}
              </div>
            )}
          </div>
        )}

        {/* Weixin (微信) Settings */}
        {activePlatform === 'weixin' && (
          <div className="space-y-3">
            {/* Scan QR code section */}
            <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center space-y-3">
              {(weixinQrStatus === 'idle' || weixinQrStatus === 'error') && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleWeixinQrLogin()}
                    className="px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {i18nService.t('imWeixinScanBtn')}
                  </button>
                  <p className="text-xs text-secondary">
                    {i18nService.t('imWeixinScanHint')}
                  </p>
                  {weixinQrStatus === 'error' && weixinQrError && (
                    <div className="flex items-center justify-center gap-1.5 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                      <XCircleIcon className="h-4 w-4 flex-shrink-0" />
                      {weixinQrError}
                    </div>
                  )}
                </>
              )}
              {weixinQrStatus === 'loading' && (
                <div className="flex items-center justify-center gap-2 py-4">
                  <ArrowPathIcon className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-sm text-secondary">
                    {i18nService.t('imWeixinQrLoading')}
                  </span>
                </div>
              )}
              {(weixinQrStatus === 'showing' || weixinQrStatus === 'waiting') && weixinQrUrl && (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-foreground">
                    {i18nService.t('imWeixinQrScanPrompt')}
                  </p>
                  <div className="flex justify-center">
                    <div className="p-3 bg-white rounded-lg border border-border-subtle">
                      <QRCodeSVG value={weixinQrUrl} size={192} />
                    </div>
                  </div>
                </div>
              )}
              {weixinQrStatus === 'success' && (
                <div className="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                  <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                  {i18nService.t('imWeixinQrSuccess')}
                </div>
              )}
            </div>

            {/* Platform Guide */}
            <PlatformGuide
              steps={[
                i18nService.t('imWeixinGuideStep1'),
                i18nService.t('imWeixinGuideStep2'),
                i18nService.t('imWeixinGuideStep3'),
              ]}
                guideUrl={PlatformRegistry.guideUrl('weixin')}
            />

            {/* Connectivity test */}
            <div className="pt-1">
              {renderConnectivityTestButton('weixin')}
            </div>

            {/* Account ID display */}
            {weixinOpenClawConfig.accountId && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Account ID: {weixinOpenClawConfig.accountId}
              </div>
            )}

            {/* Error display */}
            {status.weixin?.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.weixin.lastError}
              </div>
            )}
          </div>
        )}

        {/* WeCom (企业微信) Settings */}
        {activePlatform === 'wecom' && (
          <div className="space-y-3">
            {/* Scan QR code section */}
            <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center space-y-2">
              <button
                type="button"
                disabled={wecomQuickSetupStatus === 'pending'}
                onClick={handleWecomQuickSetup}
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {wecomQuickSetupStatus === 'pending'
                  ? i18nService.t('imWecomQuickSetupPending')
                  : i18nService.t('imWecomScanBtn')}
              </button>
              <p className="text-xs text-secondary">
                {i18nService.t('imWecomScanHint')}
              </p>
              {wecomQuickSetupStatus === 'success' && (
                <div className="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                  <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                  {i18nService.t('imWecomQuickSetupSuccess')}
                </div>
              )}
              {wecomQuickSetupStatus === 'error' && (
                <div className="flex items-center justify-center gap-1.5 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                  <XCircleIcon className="h-4 w-4 flex-shrink-0" />
                  {i18nService.t('imWecomQuickSetupError')}: {wecomQuickSetupError}
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

            {/* Manual input section */}
            <PlatformGuide
              steps={[
                i18nService.t('imWecomGuideStep1'),
                i18nService.t('imWecomGuideStep2'),
                i18nService.t('imWecomGuideStep3'),
              ]}
                guideUrl={PlatformRegistry.guideUrl('wecom')}
            />
            {/* Bot ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">
                Bot ID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={wecomOpenClawConfig.botId}
                  onChange={(e) => handleWecomOpenClawChange({ botId: e.target.value })}
                  onBlur={() => handleSaveWecomOpenClawConfig()}
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder={i18nService.t('imWecomBotIdPlaceholder')}
                />
                {wecomOpenClawConfig.botId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleWecomOpenClawChange({ botId: '' }); void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, botId: '' } }); }}
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
                  type={showSecrets['wecom.secret'] ? 'text' : 'password'}
                  value={wecomOpenClawConfig.secret}
                  onChange={(e) => handleWecomOpenClawChange({ secret: e.target.value })}
                  onBlur={() => handleSaveWecomOpenClawConfig()}
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {wecomOpenClawConfig.secret && (
                    <button
                      type="button"
                      onClick={() => { handleWecomOpenClawChange({ secret: '' }); void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, secret: '' } }); }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'wecom.secret': !prev['wecom.secret'] }))}
                    className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                    title={showSecrets['wecom.secret'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['wecom.secret'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
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
                    value={wecomOpenClawConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as WecomOpenClawConfig['dmPolicy'] };
                      handleWecomOpenClawChange(update);
                      void handleSaveWecomOpenClawConfig(update);
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
                {wecomOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('wecom')}

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
                          if (id && !wecomOpenClawConfig.allowFrom.includes(id)) {
                            const newIds = [...wecomOpenClawConfig.allowFrom, id];
                            handleWecomOpenClawChange({ allowFrom: newIds });
                            setAllowedUserIdInput('');
                            void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, allowFrom: newIds } });
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
                        if (id && !wecomOpenClawConfig.allowFrom.includes(id)) {
                          const newIds = [...wecomOpenClawConfig.allowFrom, id];
                          handleWecomOpenClawChange({ allowFrom: newIds });
                          setAllowedUserIdInput('');
                          void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, allowFrom: newIds } });
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {wecomOpenClawConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {wecomOpenClawConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = wecomOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                              handleWecomOpenClawChange({ allowFrom: newIds });
                              void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, allowFrom: newIds } });
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
                    value={wecomOpenClawConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as WecomOpenClawConfig['groupPolicy'] };
                      handleWecomOpenClawChange(update);
                      void handleSaveWecomOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">Open</option>
                    <option value="allowlist">Allowlist</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>

                {/* Send Thinking Message */}
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-secondary">
                    {i18nService.t('imSendThinkingMessage')}
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const update = { sendThinkingMessage: !wecomOpenClawConfig.sendThinkingMessage };
                      handleWecomOpenClawChange(update);
                      void handleSaveWecomOpenClawConfig(update);
                    }}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                      wecomOpenClawConfig.sendThinkingMessage ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      wecomOpenClawConfig.sendThinkingMessage ? 'translate-x-4' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
              </div>
            </details>

            {/* Connectivity test */}
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

        {activePlatform === 'popo' && (
          <div className="space-y-3">
            {/* Platform Guide */}
            <PlatformGuide
              steps={[
                i18nService.t('imPopoGuideStep1'),
                i18nService.t('imPopoGuideStep2'),
                i18nService.t('imPopoGuideStep3'),
              ]}
                guideUrl={PlatformRegistry.guideUrl('popo')}
            />

            {/* Connection Mode selector */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">
                {i18nService.t('imPopoConnectionMode')}
              </label>
              <select
                value={popoConfig.connectionMode || (popoConfig.token ? 'webhook' : 'websocket')}
                onChange={(e) => {
                  const update = { connectionMode: e.target.value as PopoOpenClawConfig['connectionMode'] };
                  handlePopoChange(update);
                  void handleSavePopoConfig(update);
                }}
                className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
              >
                <option value="websocket">{i18nService.t('imPopoConnectionModeWebsocket')}</option>
                <option value="webhook">{i18nService.t('imPopoConnectionModeWebhook')}</option>
              </select>
            </div>

            {/* Credential hint */}
            <p className="text-xs text-secondary">
              {i18nService.t('imPopoCredentialHint')}
            </p>

            {/* AppKey input */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-secondary">AppKey</label>
              <div className="relative">
                <input
                  type="text"
                  value={popoConfig.appKey}
                  onChange={(e) => handlePopoChange({ appKey: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="AppKey"
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
                />
                {popoConfig.appKey && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ appKey: '' });
                        void handleSavePopoConfig({ appKey: '' });
                      }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
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
              <label className="block text-xs font-medium text-secondary">AppSecret</label>
              <div className="relative">
                <input
                  type={showSecrets['popo.appSecret'] ? 'text' : 'password'}
                  value={popoConfig.appSecret}
                  onChange={(e) => handlePopoChange({ appSecret: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="••••••••••••"
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {popoConfig.appSecret && (
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ appSecret: '' });
                        void handleSavePopoConfig({ appSecret: '' });
                      }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'popo.appSecret': !prev['popo.appSecret'] }))}
                    className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
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
              <label className="block text-xs font-medium text-secondary">Token</label>
              <div className="relative">
                <input
                  type={showSecrets['popo.token'] ? 'text' : 'password'}
                  value={popoConfig.token}
                  onChange={(e) => handlePopoChange({ token: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="••••••••••••"
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {popoConfig.token && (
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ token: '' });
                        void handleSavePopoConfig({ token: '' });
                      }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'popo.token': !prev['popo.token'] }))}
                    className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
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
              <label className="block text-xs font-medium text-secondary">AES Key</label>
              <div className="relative">
                <input
                  type={showSecrets['popo.aesKey'] ? 'text' : 'password'}
                  value={popoConfig.aesKey}
                  onChange={(e) => handlePopoChange({ aesKey: e.target.value })}
                  onBlur={() => void handleSavePopoConfig()}
                  placeholder="••••••••••••"
                  className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {popoConfig.aesKey && (
                    <button
                      type="button"
                      onClick={() => {
                        handlePopoChange({ aesKey: '' });
                        void handleSavePopoConfig({ aesKey: '' });
                      }}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, 'popo.aesKey': !prev['popo.aesKey'] }))}
                    className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                    title={showSecrets['popo.aesKey'] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                  >
                    {showSecrets['popo.aesKey'] ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {popoConfig.aesKey && popoConfig.aesKey.length !== 32 && (
                <p className="text-xs text-amber-500">AES Key {i18nService.t('imPopoAesKeyLengthWarning')}（{i18nService.t('imPopoAesKeyLengthCurrent')} {popoConfig.aesKey.length}）</p>
              )}
            </div>

            {/* Advanced Settings (collapsible) */}
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary transition-colors">
                {i18nService.t('imAdvancedSettings')}
              </summary>
              <div className="mt-2 space-y-3 pl-2 border-l-2 border-border-subtle">
                {/* Webhook fields (webhook mode only) */}
                {(popoConfig.connectionMode || (popoConfig.token ? 'webhook' : 'websocket')) === 'webhook' && (
                <>
                {/* Webhook Base URL */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">Webhook Base URL</label>
                  <input
                    type="text"
                    value={popoConfig.webhookBaseUrl}
                    onChange={(e) => handlePopoChange({ webhookBaseUrl: e.target.value })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder={localIp ? `http://${localIp}` : i18nService.t('imPopoWebhookPlaceholder')}
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Webhook Path */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">Webhook Path</label>
                  <input
                    type="text"
                    value={popoConfig.webhookPath}
                    onChange={(e) => handlePopoChange({ webhookPath: e.target.value })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder="/popo/callback"
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Webhook Port */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">Webhook Port</label>
                  <input
                    type="number"
                    value={popoConfig.webhookPort}
                    onChange={(e) => handlePopoChange({ webhookPort: parseInt(e.target.value) || 3100 })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder="3100"
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  />
                </div>
                </>
                )}

                {/* DM Policy */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
                    DM Policy
                  </label>
                  <select
                    value={popoConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as PopoOpenClawConfig['dmPolicy'] };
                      handlePopoChange(update);
                      void handleSavePopoConfig(update);
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
                {popoConfig.dmPolicy === 'pairing' && renderPairingSection('popo')}

                {/* Allow From */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">
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
                      className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('imPopoUserIdPlaceholder')}
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
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {popoConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {popoConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = popoConfig.allowFrom.filter((uid) => uid !== id);
                              handlePopoChange({ allowFrom: newIds });
                              void imService.persistConfig({ popo: { ...popoConfig, allowFrom: newIds } });
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
                    value={popoConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as PopoOpenClawConfig['groupPolicy'] };
                      handlePopoChange(update);
                      void handleSavePopoConfig(update);
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
                  <label className="block text-xs font-medium text-secondary">
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
                      className="block flex-1 rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('imPopoGroupIdPlaceholder')}
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
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {popoConfig.groupAllowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {popoConfig.groupAllowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-surface border-border-subtle border text-foreground"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = popoConfig.groupAllowFrom.filter((gid) => gid !== id);
                              handlePopoChange({ groupAllowFrom: newIds });
                              void imService.persistConfig({ popo: { ...popoConfig, groupAllowFrom: newIds } });
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
                    value={popoConfig.textChunkLimit}
                    onChange={(e) => handlePopoChange({ textChunkLimit: parseInt(e.target.value) || 3000 })}
                    onBlur={() => void handleSavePopoConfig()}
                    placeholder="3000"
                    className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
                  />
                </div>

                {/* Rich Text Chunk Limit */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-secondary">Rich Text Chunk Limit</label>
                  <input
                    type="number"
                    value={popoConfig.richTextChunkLimit}
                    onChange={(e) => handlePopoChange({ richTextChunkLimit: parseInt(e.target.value) || 5000 })}
                    onBlur={() => void handleSavePopoConfig()}
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
                      const next = !popoConfig.debug;
                      handlePopoChange({ debug: next });
                      void handleSavePopoConfig({ debug: next });
                    }}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                      popoConfig.debug ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
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
        )}

        {connectivityModalPlatform && (
          <Modal onClose={() => setConnectivityModalPlatform(null)} overlayClassName="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" className="w-full max-w-2xl bg-surface rounded-2xl shadow-modal border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="text-sm font-semibold text-foreground">
                  {`${i18nService.t(connectivityModalPlatform)} ${i18nService.t('imConnectivitySectionTitle')}`}
                </div>
                <button
                  type="button"
                  aria-label={i18nService.t('close')}
                  onClick={() => setConnectivityModalPlatform(null)}
                  className="p-1 rounded-md hover:bg-surface-raised text-secondary"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="p-4 max-h-[65vh] overflow-y-auto">
                {testingPlatform === connectivityModalPlatform ? (
                  <div className="text-sm text-secondary">
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
                      <div className="text-[11px] text-secondary">
                        {`${i18nService.t('imConnectivityLastChecked')}: ${formatTestTime(connectivityResults[connectivityModalPlatform]!.testedAt)}`}
                      </div>
                    </div>

                    <div className="space-y-2">
                      {connectivityResults[connectivityModalPlatform]!.checks.map((check, index) => (
                        <div
                          key={`${check.code}-${index}`}
                          className="rounded-lg border border-border-subtle px-2.5 py-2 bg-surface"
                        >
                          <div className={`text-xs font-medium ${checkLevelColorClass[check.level]}`}>
                            {getCheckTitle(check.code)}
                          </div>
                          <div className="mt-1 text-xs text-secondary">
                            {check.message}
                          </div>
                          {getCheckSuggestion(check) && (
                            <div className="mt-1 text-[11px] text-secondary">
                              {`${i18nService.t('imConnectivitySuggestion')}: ${getCheckSuggestion(check)}`}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-secondary">
                    {i18nService.t('imConnectivityNoResult')}
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t border-border flex items-center justify-end">
                {renderConnectivityTestButton(connectivityModalPlatform)}
              </div>
          </Modal>
        )}
      </div>
    </div>
  );
};

export default IMSettings;
