/**
 * IM Settings Component
 * Configuration UI for DingTalk, Feishu and Telegram IM bots
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { SignalIcon, XMarkIcon, CheckCircleIcon, XCircleIcon, ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { RootState } from '../../store';
import { imService } from '../../services/im';
import { setDingTalkConfig, setFeishuConfig, setTelegramOpenClawConfig, setQQConfig, setDiscordConfig, setNimConfig, setXiaomifengConfig, setWecomConfig, setWeixinConfig, setPopoConfig, clearError } from '../../store/slices/imSlice';
import { i18nService } from '../../services/i18n';
import type { IMPlatform, IMConnectivityCheck, IMConnectivityTestResult, IMGatewayConfig, TelegramOpenClawConfig, DiscordOpenClawConfig, FeishuOpenClawConfig, DingTalkOpenClawConfig, QQOpenClawConfig, WecomOpenClawConfig, PopoOpenClawConfig } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import WecomAIBotSDK from '@wecom/wecom-aibot-sdk';
import { QRCodeSVG } from 'qrcode.react';
import { SchemaForm } from './SchemaForm';
import type { UiHint } from './SchemaForm';

import {
  platformLogos,
  IM_GUIDE_URLS,
  PlatformGuide,
  verdictColorClass,
  checkLevelColorClass,
  translateIMError,
  deepSet,
} from './imSettingsShared';
import PopoConfig from './PopoConfig';
import DingTalkConfig from './DingTalkConfig';
import FeishuConfig from './FeishuConfig';
import TelegramConfig from './TelegramConfig';
import DiscordConfig from './DiscordConfig';

const IMSettings: React.FC = () => {
  const dispatch = useDispatch();
  const { config, status, isLoading } = useSelector((state: RootState) => state.im);
  const [activePlatform, setActivePlatform] = useState<IMPlatform>('weixin');
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
  // WeCom quick setup state
  const [wecomQuickSetupStatus, setWecomQuickSetupStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [wecomQuickSetupError, setWecomQuickSetupError] = useState<string>('');
  // Weixin QR login state
  const [weixinQrStatus, setWeixinQrStatus] = useState<'idle' | 'loading' | 'showing' | 'waiting' | 'success' | 'error'>('idle');
  const [weixinQrUrl, setWeixinQrUrl] = useState<string>('');
  const [weixinQrError, setWeixinQrError] = useState<string>('');
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

  const handleFeishuStartQr = async () => {
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
            dispatch(setFeishuConfig({ appId: pollResult.appId, appSecret: pollResult.appSecret, enabled: true }));
            await imService.updateConfig({ feishu: { ...config.feishu, appId: pollResult.appId, appSecret: pollResult.appSecret, enabled: true } });
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

  // Handle DingTalk OpenClaw config change
  const dtOpenClawConfig = config.dingtalk;
  const handleDingTalkOpenClawChange = (update: Partial<DingTalkOpenClawConfig>) => {
    dispatch(setDingTalkConfig(update));
  };
  const handleSaveDingTalkOpenClawConfig = async (override?: Partial<DingTalkOpenClawConfig>) => {
    if (!configLoaded) return;
    const configToSave = override
      ? { ...dtOpenClawConfig, ...override }
      : dtOpenClawConfig;
    await imService.persistConfig({ dingtalk: configToSave });
  };

  // Handle Feishu OpenClaw config change
  const fsOpenClawConfig = config.feishu;
  const handleFeishuOpenClawChange = (update: Partial<FeishuOpenClawConfig>) => {
    dispatch(setFeishuConfig(update));
  };
  const handleSaveFeishuOpenClawConfig = async (override?: Partial<FeishuOpenClawConfig>) => {
    if (!configLoaded) return;
    const configToSave = override
      ? { ...fsOpenClawConfig, ...override }
      : fsOpenClawConfig;
    await imService.persistConfig({ feishu: configToSave });
  };

  // Inline QR code state for feishu bot creation (mirroring WeCom quick-setup pattern)
  const [feishuQrStatus, setFeishuQrStatus] = useState<'idle' | 'loading' | 'showing' | 'success' | 'error'>('idle');
  const [feishuQrUrl, setFeishuQrUrl] = useState<string>('');
  const [feishuQrTimeLeft, setFeishuQrTimeLeft] = useState<number>(0);
  const [feishuQrError, setFeishuQrError] = useState<string>('');
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

  // Handle QQ OpenClaw config change
  const qqOpenClawConfig = config.qq;
  const handleQQOpenClawChange = (update: Partial<QQOpenClawConfig>) => {
    dispatch(setQQConfig(update));
  };
  const handleSaveQQOpenClawConfig = async (override?: Partial<QQOpenClawConfig>) => {
    if (!configLoaded) return;
    const configToSave = override
      ? { ...qqOpenClawConfig, ...override }
      : qqOpenClawConfig;
    await imService.persistConfig({ qq: configToSave });
  };

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


  // Handle Xiaomifeng config change
  const handleXiaomifengChange = (field: 'clientId' | 'secret', value: string) => {
    dispatch(setXiaomifengConfig({ [field]: value }));
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

      // Start polling for scan result
      setWeixinQrStatus('waiting');
      const waitResult = await window.electron.im.weixinQrLoginWait(startResult.sessionKey);
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
      await imService.persistConfig({ feishu: fsOpenClawConfig });
      return;
    }

    // For QQ, save qq config directly (OpenClaw mode)
    if (activePlatform === 'qq') {
      await imService.persistConfig({ qq: qqOpenClawConfig });
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
        const newEnabled = !dtOpenClawConfig.enabled;
        const success = await imService.updateConfig({ dingtalk: { ...dtOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setDingTalkConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
        return;
      }

      if (platform === 'feishu') {
        const newEnabled = !fsOpenClawConfig.enabled;
        const success = await imService.updateConfig({ feishu: { ...fsOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setFeishuConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
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
        const newEnabled = !qqOpenClawConfig.enabled;
        const success = await imService.updateConfig({ qq: { ...qqOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setQQConfig({ enabled: newEnabled }));
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
        }
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

  const dingtalkConnected = status.dingtalk.connected;
  const feishuConnected = status.feishu.connected;
  const telegramConnected = status.telegram.connected;
  const discordConnected = status.discord.connected;
  const nimConnected = status.nim.connected;
  const xiaomifengConnected = status.xiaomifeng?.connected ?? false;
  const qqConnected = status.qq?.connected ?? false;
  const wecomConnected = status.wecom?.connected ?? false;
  const weixinConnected = status.weixin?.connected ?? false;
  const popoConnected = status.popo?.connected ?? false;

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
      return !!tgOpenClawConfig.botToken;
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
    if (platform === 'weixin') return weixinConnected;
    if (platform === 'popo') return popoConnected;
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

    // For QQ, persist qq config and test (OpenClaw mode)
    if (platform === 'qq') {
      await imService.persistConfig({ qq: qqOpenClawConfig });
      const result = await runConnectivityTest(platform, {
        qq: qqOpenClawConfig,
      } as Partial<IMGatewayConfig>);
      if (!qqOpenClawConfig.enabled && result) {
        const authCheck = result.checks.find((c) => c.code === 'auth_check');
        if (authCheck && authCheck.level === 'pass') {
          toggleGateway(platform);
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
      await imService.persistConfig({ feishu: fsOpenClawConfig });
      const result = await runConnectivityTest(platform, {
        feishu: fsOpenClawConfig,
      } as Partial<IMGatewayConfig>);
      if (!fsOpenClawConfig.enabled && result) {
        const authCheck = result.checks.find((c) => c.code === 'auth_check');
        if (authCheck && authCheck.level === 'pass') {
          toggleGateway(platform);
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
    if (isEnabled && platform === 'xiaomifeng') {
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
      telegram: setTelegramOpenClawConfig,
      qq: setQQConfig,
      discord: setDiscordConfig,
      nim: setNimConfig,
      xiaomifeng: setXiaomifengConfig,
      wecom: setWecomConfig,
      weixin: setWeixinConfig,
      popo: setPopoConfig,
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

  const renderPairingSection = (platform: string) => (
    <div className="space-y-2">
      <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
          className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm font-mono uppercase tracking-widest transition-colors"
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
      <div className="w-48 flex-shrink-0 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-2 overflow-y-auto">
        {platforms.map((platform) => {
          const logo = platformLogos[platform];
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
                    src={logo}
                    alt={i18nService.t(platform)}
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
                src={platformLogos[activePlatform]}
                alt={i18nService.t(activePlatform)}
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
          <DingTalkConfig
            dtOpenClawConfig={dtOpenClawConfig}
            handleDingTalkOpenClawChange={handleDingTalkOpenClawChange}
            handleSaveDingTalkOpenClawConfig={handleSaveDingTalkOpenClawConfig}
            showSecrets={showSecrets}
            setShowSecrets={setShowSecrets}
            status={status}
            renderConnectivityTestButton={renderConnectivityTestButton}
            renderPairingSection={renderPairingSection}
          />
        )}

        {activePlatform === 'feishu' && (
          <FeishuConfig
            fsOpenClawConfig={fsOpenClawConfig}
            handleFeishuOpenClawChange={handleFeishuOpenClawChange}
            handleSaveFeishuOpenClawConfig={handleSaveFeishuOpenClawConfig}
            showSecrets={showSecrets}
            setShowSecrets={setShowSecrets}
            status={status}
            renderConnectivityTestButton={renderConnectivityTestButton}
            renderPairingSection={renderPairingSection}
            feishuQrStatus={feishuQrStatus}
            feishuQrUrl={feishuQrUrl}
            feishuQrTimeLeft={feishuQrTimeLeft}
            feishuQrError={feishuQrError}
            handleFeishuStartQr={handleFeishuStartQr}
          />
        )}

        {activePlatform === 'qq' && (
          <div className="space-y-3">
            <PlatformGuide
              steps={[
                i18nService.t('imQQGuideStep1'),
                i18nService.t('imQQGuideStep2'),
                i18nService.t('imQQGuideStep3'),
                i18nService.t('imQQGuideStep4'),
              ]}
              guideUrl={IM_GUIDE_URLS.qq}
            />
            {/* AppID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                AppID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={qqOpenClawConfig.appId}
                  onChange={(e) => handleQQOpenClawChange({ appId: e.target.value })}
                  onBlur={() => handleSaveQQOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder="102xxxxx"
                />
                {qqOpenClawConfig.appId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleQQOpenClawChange({ appId: '' }); void imService.persistConfig({ qq: { ...qqOpenClawConfig, appId: '' } }); }}
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
                  value={qqOpenClawConfig.appSecret}
                  onChange={(e) => handleQQOpenClawChange({ appSecret: e.target.value })}
                  onBlur={() => handleSaveQQOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {qqOpenClawConfig.appSecret && (
                    <button
                      type="button"
                      onClick={() => { handleQQOpenClawChange({ appSecret: '' }); void imService.persistConfig({ qq: { ...qqOpenClawConfig, appSecret: '' } }); }}
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
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('imQQCredentialHint')}
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
                    value={qqOpenClawConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as QQOpenClawConfig['dmPolicy'] };
                      handleQQOpenClawChange(update);
                      void handleSaveQQOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">{i18nService.t('imDmPolicyOpen')}</option>
                    <option value="pairing">{i18nService.t('imDmPolicyPairing')}</option>
                    <option value="allowlist">{i18nService.t('imDmPolicyAllowlist')}</option>
                  </select>
                </div>

                {/* Pairing Requests (shown when dmPolicy is 'pairing') */}
                {qqOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('qq')}

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
                          if (id && !qqOpenClawConfig.allowFrom.includes(id)) {
                            const newIds = [...qqOpenClawConfig.allowFrom, id];
                            handleQQOpenClawChange({ allowFrom: newIds });
                            setAllowedUserIdInput('');
                            void imService.persistConfig({ qq: { ...qqOpenClawConfig, allowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                      placeholder={i18nService.t('imQQUserIdPlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const id = allowedUserIdInput.trim();
                        if (id && !qqOpenClawConfig.allowFrom.includes(id)) {
                          const newIds = [...qqOpenClawConfig.allowFrom, id];
                          handleQQOpenClawChange({ allowFrom: newIds });
                          setAllowedUserIdInput('');
                          void imService.persistConfig({ qq: { ...qqOpenClawConfig, allowFrom: newIds } });
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {qqOpenClawConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {qqOpenClawConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = qqOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                              handleQQOpenClawChange({ allowFrom: newIds });
                              void imService.persistConfig({ qq: { ...qqOpenClawConfig, allowFrom: newIds } });
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
                    value={qqOpenClawConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as QQOpenClawConfig['groupPolicy'] };
                      handleQQOpenClawChange(update);
                      void handleSaveQQOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">Open</option>
                    <option value="allowlist">Allowlist</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>

                {/* History Limit */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    History Limit
                  </label>
                  <input
                    type="number"
                    value={qqOpenClawConfig.historyLimit}
                    onChange={(e) => handleQQOpenClawChange({ historyLimit: parseInt(e.target.value) || 50 })}
                    onBlur={() => handleSaveQQOpenClawConfig()}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                    min="1"
                    max="200"
                  />
                </div>

                {/* Markdown Support */}
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Markdown Support
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const update = { markdownSupport: !qqOpenClawConfig.markdownSupport };
                      handleQQOpenClawChange(update);
                      void handleSaveQQOpenClawConfig(update);
                    }}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                      qqOpenClawConfig.markdownSupport ? 'bg-claude-accent' : 'dark:bg-claude-darkSurface bg-claude-surface'
                    }`}
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      qqOpenClawConfig.markdownSupport ? 'translate-x-4' : 'translate-x-0'
                    }`} />
                  </button>
                </div>

                {/* Image Server Base URL */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    Image Server Base URL
                  </label>
                  <input
                    type="text"
                    value={qqOpenClawConfig.imageServerBaseUrl}
                    onChange={(e) => handleQQOpenClawChange({ imageServerBaseUrl: e.target.value })}
                    onBlur={() => handleSaveQQOpenClawConfig()}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                    placeholder="http://your-ip:18765"
                  />
                  <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('imQQImageServerHint')}
                  </p>
                </div>
              </div>
            </details>

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
          <TelegramConfig
            tgOpenClawConfig={tgOpenClawConfig}
            handleTelegramOpenClawChange={handleTelegramOpenClawChange}
            handleSaveTelegramOpenClawConfig={handleSaveTelegramOpenClawConfig}
            showSecrets={showSecrets}
            setShowSecrets={setShowSecrets}
            status={status}
            renderConnectivityTestButton={renderConnectivityTestButton}
            renderPairingSection={renderPairingSection}
          />
        )}

        {/* Discord Settings */}
        {activePlatform === 'discord' && (
          <DiscordConfig
            dcOpenClawConfig={dcOpenClawConfig}
            handleDiscordOpenClawChange={handleDiscordOpenClawChange}
            handleSaveDiscordOpenClawConfig={handleSaveDiscordOpenClawConfig}
            showSecrets={showSecrets}
            setShowSecrets={setShowSecrets}
            status={status}
            renderConnectivityTestButton={renderConnectivityTestButton}
            renderPairingSection={renderPairingSection}
          />
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
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">App Key</label>
                  <input
                    type="text"
                    value={config.nim.appKey}
                    onChange={(e) => dispatch(setNimConfig({ appKey: e.target.value }))}
                    onBlur={handleSaveConfig}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                    placeholder="your_app_key"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Account</label>
                  <input
                    type="text"
                    value={config.nim.account}
                    onChange={(e) => dispatch(setNimConfig({ account: e.target.value }))}
                    onBlur={handleSaveConfig}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                    placeholder="bot_account_id"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">Token</label>
                  <input
                    type="password"
                    value={config.nim.token}
                    onChange={(e) => dispatch(setNimConfig({ token: e.target.value }))}
                    onBlur={handleSaveConfig}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
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
                      onClick={() => { handleXiaomifengChange('clientId', ''); void imService.persistConfig({ xiaomifeng: { ...config.xiaomifeng, clientId: '' } }); }}
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
                      onClick={() => { handleXiaomifengChange('secret', ''); void imService.persistConfig({ xiaomifeng: { ...config.xiaomifeng, secret: '' } }); }}
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

        {/* Weixin (微信) Settings */}
        {activePlatform === 'weixin' && (
          <div className="space-y-3">
            {/* Scan QR code section */}
            <div className="rounded-lg border border-dashed dark:border-claude-darkBorder/60 border-claude-border/60 p-4 text-center space-y-3">
              {(weixinQrStatus === 'idle' || weixinQrStatus === 'error') && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleWeixinQrLogin()}
                    className="px-4 py-2.5 rounded-lg text-sm font-medium bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {i18nService.t('imWeixinScanBtn')}
                  </button>
                  <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
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
                  <ArrowPathIcon className="h-5 w-5 animate-spin text-claude-accent" />
                  <span className="text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('imWeixinQrLoading')}
                  </span>
                </div>
              )}
              {(weixinQrStatus === 'showing' || weixinQrStatus === 'waiting') && weixinQrUrl && (
                <div className="space-y-3">
                  <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('imWeixinQrScanPrompt')}
                  </p>
                  <div className="flex justify-center">
                    <div className="p-3 bg-white rounded-lg border dark:border-claude-darkBorder/40 border-claude-border/40">
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
              guideUrl={IM_GUIDE_URLS.weixin}
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
            <div className="rounded-lg border border-dashed dark:border-claude-darkBorder/60 border-claude-border/60 p-4 text-center space-y-2">
              <button
                type="button"
                disabled={wecomQuickSetupStatus === 'pending'}
                onClick={handleWecomQuickSetup}
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {wecomQuickSetupStatus === 'pending'
                  ? i18nService.t('imWecomQuickSetupPending')
                  : i18nService.t('imWecomScanBtn')}
              </button>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
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
              <div className="flex-1 border-t dark:border-claude-darkBorder/40 border-claude-border/40" />
              <span className="px-3 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary whitespace-nowrap">
                {i18nService.t('imWecomOrManual')}
              </span>
              <div className="flex-1 border-t dark:border-claude-darkBorder/40 border-claude-border/40" />
            </div>

            {/* Manual input section */}
            <PlatformGuide
              steps={[
                i18nService.t('imWecomGuideStep1'),
                i18nService.t('imWecomGuideStep2'),
                i18nService.t('imWecomGuideStep3'),
              ]}
              guideUrl={IM_GUIDE_URLS.wecom}
            />
            {/* Bot ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Bot ID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={wecomOpenClawConfig.botId}
                  onChange={(e) => handleWecomOpenClawChange({ botId: e.target.value })}
                  onBlur={() => handleSaveWecomOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
                  placeholder={i18nService.t('imWecomBotIdPlaceholder')}
                />
                {wecomOpenClawConfig.botId && (
                  <div className="absolute right-2 inset-y-0 flex items-center">
                    <button
                      type="button"
                      onClick={() => { handleWecomOpenClawChange({ botId: '' }); void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, botId: '' } }); }}
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
                  value={wecomOpenClawConfig.secret}
                  onChange={(e) => handleWecomOpenClawChange({ secret: e.target.value })}
                  onBlur={() => handleSaveWecomOpenClawConfig()}
                  className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
                  placeholder="••••••••••••"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {wecomOpenClawConfig.secret && (
                    <button
                      type="button"
                      onClick={() => { handleWecomOpenClawChange({ secret: '' }); void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, secret: '' } }); }}
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
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('imWecomCredentialHint')}
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
                    value={wecomOpenClawConfig.dmPolicy}
                    onChange={(e) => {
                      const update = { dmPolicy: e.target.value as WecomOpenClawConfig['dmPolicy'] };
                      handleWecomOpenClawChange(update);
                      void handleSaveWecomOpenClawConfig(update);
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
                {wecomOpenClawConfig.dmPolicy === 'pairing' && renderPairingSection('wecom')}

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
                          if (id && !wecomOpenClawConfig.allowFrom.includes(id)) {
                            const newIds = [...wecomOpenClawConfig.allowFrom, id];
                            handleWecomOpenClawChange({ allowFrom: newIds });
                            setAllowedUserIdInput('');
                            void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, allowFrom: newIds } });
                          }
                        }
                      }}
                      className="block flex-1 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
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
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors"
                    >
                      {i18nService.t('add') || '添加'}
                    </button>
                  </div>
                  {wecomOpenClawConfig.allowFrom.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {wecomOpenClawConfig.allowFrom.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border dark:text-claude-darkText text-claude-text"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => {
                              const newIds = wecomOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                              handleWecomOpenClawChange({ allowFrom: newIds });
                              void imService.persistConfig({ wecom: { ...wecomOpenClawConfig, allowFrom: newIds } });
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
                    value={wecomOpenClawConfig.groupPolicy}
                    onChange={(e) => {
                      const update = { groupPolicy: e.target.value as WecomOpenClawConfig['groupPolicy'] };
                      handleWecomOpenClawChange(update);
                      void handleSaveWecomOpenClawConfig(update);
                    }}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                  >
                    <option value="open">Open</option>
                    <option value="allowlist">Allowlist</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>

                {/* Send Thinking Message */}
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
                      wecomOpenClawConfig.sendThinkingMessage ? 'bg-claude-accent' : 'dark:bg-claude-darkSurface bg-claude-surface'
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
          <PopoConfig
            popoConfig={popoConfig}
            handlePopoChange={handlePopoChange}
            handleSavePopoConfig={handleSavePopoConfig}
            showSecrets={showSecrets}
            setShowSecrets={setShowSecrets}
            status={status}
            localIp={localIp}
            renderConnectivityTestButton={renderConnectivityTestButton}
            renderPairingSection={renderPairingSection}
          />
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
