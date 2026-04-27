/**
 * IM Settings Component
 * Configuration UI for DingTalk, Feishu and Telegram IM bots
 */

import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { CheckCircleIcon, ExclamationTriangleIcon,SignalIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { Platform } from '@shared/platform';
import { PlatformRegistry } from '@shared/platform';
import WecomAIBotSDK from '@wecom/wecom-aibot-sdk';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect, useMemo, useRef,useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import { RootState } from '../../store';
import { clearError,setDingTalkConfig, setDingTalkInstanceConfig, setDiscordConfig, setDiscordInstanceConfig, setEmailInstanceConfig, setFeishuConfig, setFeishuInstanceConfig, setNeteaseBeeChanConfig, setNimConfig, setNimInstanceConfig, setPopoConfig, setQQConfig, setQQInstanceConfig, setTelegramInstanceConfig, setTelegramOpenClawConfig, setWecomConfig, setWecomInstanceConfig, setWeixinConfig } from '../../store/slices/imSlice';
import type { EmailInstanceConfig, IMConnectivityCheck, IMConnectivityTestResult, IMGatewayConfig, PopoOpenClawConfig } from '../../types/im';
import { MAX_DINGTALK_INSTANCES, MAX_DISCORD_INSTANCES, MAX_EMAIL_INSTANCES, MAX_FEISHU_INSTANCES, MAX_NIM_INSTANCES, MAX_QQ_INSTANCES, MAX_TELEGRAM_INSTANCES, MAX_WECOM_INSTANCES } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import Modal from '../common/Modal';
import TrashIcon from '../icons/TrashIcon';
import DingTalkInstanceSettings from './DingTalkInstanceSettings';
import DiscordInstanceSettings from './DiscordInstanceSettings';
import FeishuInstanceSettings from './FeishuInstanceSettings';
import NimInstanceSettings from './NimInstanceSettings';
import { nimFallbackInstanceSchema, nimFallbackUiHints } from './nimSchemaFallback';
import QQInstanceSettings from './QQInstanceSettings';
import type { UiHint } from './SchemaForm';
import TelegramInstanceSettings from './TelegramInstanceSettings';
import WecomInstanceSettings from './WecomInstanceSettings';



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
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [activeEmailInstanceId, setActiveEmailInstanceId] = useState<string | null>(null);
  const [activeWecomInstanceId, setActiveWecomInstanceId] = useState<string | null>(null);
  const [wecomExpanded, setWecomExpanded] = useState(false);
  const [activeNimInstanceId, setActiveNimInstanceId] = useState<string | null>(null);
  const [nimExpanded, setNimExpanded] = useState(false);
  const [activeTelegramInstanceId, setActiveTelegramInstanceId] = useState<string | null>(null);
  const [telegramExpanded, setTelegramExpanded] = useState(false);
  const [activeDiscordInstanceId, setActiveDiscordInstanceId] = useState<string | null>(null);
  const [discordExpanded, setDiscordExpanded] = useState(false);
  const [testingPlatform, setTestingPlatform] = useState<Platform | null>(null);
  const [connectivityResults, setConnectivityResults] = useState<Partial<Record<Platform, IMConnectivityTestResult>>>({});
  const [connectivityModalPlatform, setConnectivityModalPlatform] = useState<Platform | null>(null);
  const [language, setLanguage] = useState<'zh' | 'en'>(i18nService.getLanguage());
  const [configLoaded, setConfigLoaded] = useState(false);
  // Re-entrancy guard for gateway toggle to prevent rapid ON→OFF→ON
  const [togglingPlatform, setTogglingPlatform] = useState<Platform | null>(null);
  // Loading state for email instance toggle (stores instanceId being toggled on)
  const [emailToggleLoading, setEmailToggleLoading] = useState<string | null>(null);
  const [emailDrafts, setEmailDrafts] = useState<Record<string, { allowFrom?: string; a2aAgentDomains?: string }>>({});
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
  // POPO QR login state
  const [popoQrStatus, setPopoQrStatus] = useState<'idle' | 'loading' | 'showing' | 'waiting' | 'success' | 'error'>('idle');
  const [popoQrUrl, setPopoQrUrl] = useState<string>('');
  const [popoQrError, setPopoQrError] = useState<string>('');
  const popoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Reset popo QR login state when switching away from popo
  useEffect(() => {
    if (activePlatform !== 'popo') {
      if (popoTimerRef.current) { clearTimeout(popoTimerRef.current); popoTimerRef.current = null; }
      setPopoQrStatus('idle');
      setPopoQrUrl('');
      setPopoQrError('');
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
    if (!openclawSchema) {
      return { schema: nimFallbackInstanceSchema, hints: nimFallbackUiHints };
    }
    const { schema, uiHints } = openclawSchema;

    // Find the NIM channel key — could be 'nim' or 'openclaw-nim'
    const channelsProps = (schema as any)?.properties?.channels?.properties ?? {};
    const channelKey = channelsProps['openclaw-nim'] ? 'openclaw-nim' : channelsProps['nim'] ? 'nim' : null;
    if (!channelKey) {
      return { schema: nimFallbackInstanceSchema, hints: nimFallbackUiHints };
    }

    const channelSchema = channelsProps[channelKey] as Record<string, unknown>;
    const instanceSchema =
      ((channelSchema?.properties as Record<string, any> | undefined)?.accounts?.additionalProperties as Record<string, unknown> | undefined)
      || ((channelSchema?.properties as Record<string, any> | undefined)?.instances?.items as Record<string, unknown> | undefined);
    if (!instanceSchema) {
      return { schema: nimFallbackInstanceSchema, hints: nimFallbackUiHints };
    }

    const hints: Record<string, UiHint> = {};
    const accountHintPrefix = `channels.${channelKey}.accounts.`;
    const legacyInstancePrefix = `channels.${channelKey}.instances.0.`;
    let nextOrder = 0;

    for (const [key, rawValue] of Object.entries(uiHints)) {
      let relativePath: string | null = null;
      if (key.startsWith(accountHintPrefix)) {
        const suffix = key.slice(accountHintPrefix.length);
        const firstDot = suffix.indexOf('.');
        relativePath = firstDot >= 0 ? suffix.slice(firstDot + 1) : null;
      } else if (key.startsWith(legacyInstancePrefix)) {
        relativePath = key.slice(legacyInstancePrefix.length);
      }

      if (relativePath) {
        const value = rawValue as unknown as UiHint;
        hints[relativePath] = {
          ...value,
          order: value.order ?? nextOrder,
        };
        nextOrder += 1;
      }
    }

    delete hints.nimToken;

    return {
      schema: instanceSchema,
      hints: Object.keys(hints).length > 0 ? hints : nimFallbackUiHints,
    };
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
  // Telegram multi-instance config alias
  const tgMultiConfig = config.telegram;

  const qqMultiConfig = config.qq;

  const discordMultiConfig = config.discord;

  // State for POPO allow-from inputs
  const [popoAllowedUserIdInput, setPopoAllowedUserIdInput] = useState('');
  const [popoGroupAllowIdInput, setPopoGroupAllowIdInput] = useState('');


  // Handle NetEase Bee config change
  const handleNeteaseBeeChanChange = (field: 'clientId' | 'secret', value: string) => {
    dispatch(setNeteaseBeeChanConfig({ [field]: value }));
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

  const handlePopoQrLogin = async () => {
    setPopoQrStatus('loading');
    setPopoQrError('');
    try {
      const startResult = await window.electron.im.popoQrLoginStart();
      if (!isMountedRef.current) return;

      if (!startResult.success || !startResult.qrUrl) {
        setPopoQrStatus('error');
        setPopoQrError(startResult.message || i18nService.t('imPopoQrFailed'));
        return;
      }

      setPopoQrUrl(startResult.qrUrl);
      setPopoQrStatus('showing');

      // QR expires in ~10 minutes
      if (popoTimerRef.current) clearTimeout(popoTimerRef.current);
      popoTimerRef.current = setTimeout(() => {
        if (!isMountedRef.current) return;
        setPopoQrStatus('error');
        setPopoQrError(i18nService.t('imPopoQrExpired'));
      }, startResult.timeoutMs || 600000);

      // Start polling for scan result
      setPopoQrStatus('waiting');
      const pollResult = await window.electron.im.popoQrLoginPoll(startResult.taskToken!);
      if (popoTimerRef.current) { clearTimeout(popoTimerRef.current); popoTimerRef.current = null; }
      if (!isMountedRef.current) return;

      if (pollResult.success && pollResult.appKey && pollResult.appSecret && pollResult.aesKey) {
        setPopoQrStatus('success');
        // Auto-fill credentials and enable
        const update: Partial<PopoOpenClawConfig> = {
          appKey: pollResult.appKey,
          appSecret: pollResult.appSecret,
          aesKey: pollResult.aesKey,
          connectionMode: 'websocket',
          enabled: true,
        };
        handlePopoChange(update);
        dispatch(clearError());
        // Persist to DB with gateway sync so openclaw.json gets updated and gateway restarts
        await imService.updateConfig({ popo: { ...popoConfig, ...update } });
        // Explicitly trigger config sync to ensure openclaw.json is written immediately
        await window.electron.im.syncConfig();
        await imService.loadStatus();
      } else {
        setPopoQrStatus('error');
        setPopoQrError(pollResult.message || i18nService.t('imPopoQrFailed'));
      }
    } catch (err) {
      if (popoTimerRef.current) { clearTimeout(popoTimerRef.current); popoTimerRef.current = null; }
      if (!isMountedRef.current) return;
      setPopoQrStatus('error');
      setPopoQrError(String(err));
    }
  };


  const handleSaveConfig = async () => {
    if (!configLoaded) return;

    // For Telegram, save telegram config directly
    if (activePlatform === 'telegram') {
      await imService.persistConfig({ telegram: tgMultiConfig });
      return;
    }

    // For Discord, save discord config directly
    if (activePlatform === 'discord') {
      await imService.persistConfig({ discord: discordMultiConfig });
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

    // For WeCom, save is handled per-instance in WecomInstanceSettings
    if (activePlatform === 'wecom') {
      await imService.persistConfig({ wecom: config.wecom });
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

    // For Email, save the full email multi-instance config
    if (activePlatform === 'email') {
      await imService.persistConfig({ email: config.email ?? { instances: [] } });
      return;
    }

    await imService.persistConfig({ [activePlatform]: config[activePlatform] });
  };

  // ==================== Email instance helpers ====================

  const handleEmailGetApiKey = async () => {
    if (!activeEmailInstanceId) return;
    const apiKeyUrl = 'https://claw.163.com/projects/dashboard/?channel=LobsterAI#/api-keys';
    try {
      await window.electron.shell.openExternal(apiKeyUrl);
    } catch {
      alert('Failed to open browser. Please visit: ' + apiKeyUrl);
    }
  };

  // ==================== End email instance helpers ====================

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
        // Telegram multi-instance: toggle is handled per-instance in TelegramInstanceSettings
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
        // Discord multi-instance: toggle is handled per-instance in DiscordInstanceSettings
        return;
      }

      if (platform === 'qq' || platform === 'email' || platform === 'wecom' || platform === 'nim') {
        // Multi-instance platforms toggle per instance in their detail panels
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
  const telegramConnected = status.telegram?.instances?.some(i => i.connected) ?? false;
  const discordConnected = status.discord?.instances?.some(i => i.connected) ?? false;
  const nimConnected = status.nim?.instances?.some(i => i.connected) ?? false;
  const neteaseBeeChanConnected = status['netease-bee']?.connected ?? false;
  const qqConnected = status.qq?.instances?.some(i => i.connected) ?? false;
  const wecomConnected = status.wecom?.instances?.some(i => i.connected) ?? false;
  const weixinConnected = status.weixin?.connected ?? false;
  const popoConnected = status.popo?.connected ?? false;
  const emailConnected = status.email.instances.some(i => i.connected);

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
      return config.telegram.instances.some(i => !!i.botToken);
    }
    if (platform === 'discord') {
      return config.discord.instances.some(i => !!i.botToken);
    }
    if (platform === 'nim') {
      return config.nim.instances.some(i => !!(i.nimToken || (i.appKey && i.account && i.token)));
    }
    if (platform === 'netease-bee') {
      return !!(config['netease-bee'].clientId && config['netease-bee'].secret);
    }
    if (platform === 'qq') {
      return config.qq.instances.some(i => !!(i.appId && i.appSecret));
    }
    if (platform === 'wecom') {
      return config.wecom.instances.some(i => !!(i.botId && i.secret));
    }
    if (platform === 'weixin') {
      return true; // No credentials needed, connects via QR code in CLI
    }
    if (platform === 'popo') {
      return true; // Credentials provisioned via QR scan or manual input in openclaw.json
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
    if (platform === 'email') {
      return config.email.instances.some(i => i.enabled);
    }
    if (platform === 'nim') {
      return config.nim.instances?.some(i => i.enabled);
    }
    if (platform === 'wecom') {
      return config.wecom.instances?.some(i => i.enabled);
    }
    if (platform === 'telegram') {
      return config.telegram.instances?.some(i => i.enabled);
    }
    if (platform === 'discord') {
      return config.discord.instances?.some(i => i.enabled);
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
    if (platform === 'email') return emailConnected;
    return feishuConnected;
  };

  // Get platform transient starting status
  const getPlatformStarting = (platform: Platform): boolean => {
    if (platform === 'discord') return status.discord.instances?.[0]?.starting ?? false;
    return false;
  };

  const handleConnectivityTest = async (platform: Platform) => {
    // Re-entrancy guard: if a test is already running, do nothing.
    if (testingPlatform) return;

    setConnectivityModalPlatform(platform);
    setTestingPlatform(platform);

    // For Telegram, persist telegram config and test (multi-instance)
    if (platform === 'telegram') {
      await imService.persistConfig({ telegram: tgMultiConfig });
      const result = await runConnectivityTest(platform, {
        telegram: tgMultiConfig,
      } as Partial<IMGatewayConfig>);
      // Auto-enable: if the active instance is OFF and auth_check passed, turn on automatically
      if (activeTelegramInstanceId && result) {
        const inst = tgMultiConfig.instances.find(i => i.instanceId === activeTelegramInstanceId);
        if (inst && !inst.enabled) {
          const authCheck = result.checks.find((c) => c.code === 'auth_check');
          if (authCheck && authCheck.level === 'pass') {
            dispatch(setTelegramInstanceConfig({ instanceId: activeTelegramInstanceId, config: { enabled: true } }));
            await imService.updateTelegramInstanceConfig(activeTelegramInstanceId, { enabled: true });
          }
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

    // For Email, persist email config and test (OpenClaw mode)
    if (platform === 'email') {
      await imService.persistConfig({ email: config.email });
      // Pass only the active instance to avoid testing wrong instance
      const activeInstance = activeEmailInstanceId
        ? config.email.instances.find(i => i.instanceId === activeEmailInstanceId)
        : config.email.instances.find(i => i.enabled) || config.email.instances[0];
      await runConnectivityTest(platform, {
        email: { instances: activeInstance ? [activeInstance] : [] },
      } as Partial<IMGatewayConfig>);
      return;
    }

    // For WeCom, persist wecom config and test (OpenClaw mode)
    if (platform === 'wecom') {
      const wecomMultiConfig = config.wecom;
      await imService.persistConfig({ wecom: wecomMultiConfig });
      const result = await runConnectivityTest(platform, {
        wecom: wecomMultiConfig,
      } as Partial<IMGatewayConfig>);
      // Auto-enable: if the active instance is OFF and auth_check passed, turn on automatically
      if (activeWecomInstanceId && result) {
        const inst = wecomMultiConfig.instances.find(i => i.instanceId === activeWecomInstanceId);
        if (inst && !inst.enabled) {
          const authCheck = result.checks.find((c) => c.code === 'auth_check');
          if (authCheck && authCheck.level === 'pass') {
            dispatch(setWecomInstanceConfig({ instanceId: activeWecomInstanceId, config: { enabled: true } }));
            await imService.updateWecomInstanceConfig(activeWecomInstanceId, { enabled: true });
          }
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

    // For NIM, persist nim config and test (OpenClaw mode)
    if (platform === 'nim') {
      const nimMultiConfig = config.nim;
      await imService.persistConfig({ nim: nimMultiConfig });
      const result = await runConnectivityTest(platform, {
        nim: nimMultiConfig,
      } as Partial<IMGatewayConfig>);
      if (activeNimInstanceId && result) {
        const inst = nimMultiConfig.instances.find(i => i.instanceId === activeNimInstanceId);
        if (inst && !inst.enabled) {
          const authCheck = result.checks.find((c) => c.code === 'auth_check');
          if (authCheck && authCheck.level === 'pass') {
            dispatch(setNimInstanceConfig({ instanceId: activeNimInstanceId, config: { enabled: true } }));
            await imService.updateNimInstanceConfig(activeNimInstanceId, { enabled: true });
          }
        }
      }
      return;
    }

    // For Discord, persist discord config and test (OpenClaw mode)
    if (platform === 'discord') {
      await imService.persistConfig({ discord: discordMultiConfig });
      const result = await runConnectivityTest(platform, {
        discord: discordMultiConfig,
      } as Partial<IMGatewayConfig>);
      if (activeDiscordInstanceId && result) {
        const inst = discordMultiConfig.instances.find(i => i.instanceId === activeDiscordInstanceId);
        if (inst && !inst.enabled) {
          const authCheck = result.checks.find((c) => c.code === 'auth_check');
          if (authCheck && authCheck.level === 'pass') {
            dispatch(setDiscordInstanceConfig({ instanceId: activeDiscordInstanceId, config: { enabled: true } }));
            await imService.updateDiscordInstanceConfig(activeDiscordInstanceId, { enabled: true });
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
      email: null, // Email is multi-instance; toggle handled per-instance in EmailSettings
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

          if (platform === 'email') {
            return (
              <div key="email">
                {/* Email Platform Header - clickable to expand/collapse */}
                <div
                  onClick={() => { setActivePlatform('email'); setActiveEmailInstanceId(null); setEmailExpanded(!emailExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'email'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('email')} alt="Email" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'email' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('email')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{emailExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
                {/* Email Instance Sub-items */}
                {emailExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.email.instances.map((inst) => {
                      const instStatus = status.email.instances.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'email' && activeEmailInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('email'); setActiveEmailInstanceId(inst.instanceId); }}
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
                    {/* Add account button */}
                    <button
                      type="button"
                      disabled={config.email.instances.length >= MAX_EMAIL_INSTANCES}
                      onClick={async (e) => {
                        e.stopPropagation();
                        const inst = await imService.addEmailInstance(`Email ${config.email.instances.length + 1}`);
                        if (inst) { setActivePlatform('email'); setActiveEmailInstanceId(inst.instanceId); setEmailExpanded(true); }
                      }}
                      className="w-full flex items-center p-1.5 pl-2 rounded-lg text-sm text-secondary hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <span className="mr-1">+</span>
                      {i18nService.t('imEmailAddInstance')}
                    </button>
                  </div>
                )}
              </div>
            );
          }

          if (platform === 'nim') {
            return (
              <div key="nim">
                <div
                  onClick={() => { setActivePlatform('nim'); setActiveNimInstanceId(null); setNimExpanded(!nimExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'nim'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('nim')} alt="NIM" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'nim' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('nim')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{nimExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
                {nimExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.nim.instances.map((inst) => {
                      const instStatus = status.nim?.instances?.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'nim' && activeNimInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('nim'); setActiveNimInstanceId(inst.instanceId); }}
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

          if (platform === 'wecom') {
            return (
              <div key="wecom">
                {/* WeCom Platform Header - clickable to expand/collapse */}
                <div
                  onClick={() => { setActivePlatform('wecom'); setActiveWecomInstanceId(null); setWecomExpanded(!wecomExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'wecom'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('wecom')} alt="WeCom" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'wecom' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('wecom')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{wecomExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
                {/* WeCom Instance Sub-items */}
                {wecomExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.wecom.instances.map((inst) => {
                      const instStatus = status.wecom?.instances?.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'wecom' && activeWecomInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('wecom'); setActiveWecomInstanceId(inst.instanceId); }}
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

          if (platform === 'telegram') {
            return (
              <div key="telegram">
                {/* Telegram Platform Header - clickable to expand/collapse */}
                <div
                  onClick={() => { setActivePlatform('telegram'); setActiveTelegramInstanceId(null); setTelegramExpanded(!telegramExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'telegram'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('telegram')} alt="Telegram" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'telegram' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('telegram')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{telegramExpanded ? '▼' : '▶'}</span>
                </div>
                {/* Telegram Instance Sub-items */}
                {telegramExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.telegram.instances.map((inst) => {
                      const instStatus = status.telegram?.instances?.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'telegram' && activeTelegramInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('telegram'); setActiveTelegramInstanceId(inst.instanceId); }}
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

          if (platform === 'discord') {
            return (
              <div key="discord">
                {/* Discord Platform Header - clickable to expand/collapse */}
                <div
                  onClick={() => { setActivePlatform('discord'); setActiveDiscordInstanceId(null); setDiscordExpanded(!discordExpanded); }}
                  className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                    activePlatform === 'discord'
                      ? 'bg-primary-muted border border-primary shadow-subtle'
                      : 'bg-surface hover:bg-surface-raised border border-transparent'
                  }`}
                >
                  <div className="flex flex-1 items-center">
                    <div className="mr-2 flex h-7 w-7 items-center justify-center">
                      <img src={PlatformRegistry.logo('discord')} alt="Discord" className="w-6 h-6 object-contain rounded-md" />
                    </div>
                    <span className={`text-sm font-medium truncate ${activePlatform === 'discord' ? 'text-primary' : 'text-foreground'}`}>
                      {i18nService.t('discord')}
                    </span>
                  </div>
                  <span className="text-xs opacity-50">{discordExpanded ? '▼' : '▶'}</span>
                </div>
                {/* Discord Instance Sub-items */}
                {discordExpanded && (
                  <div className="ml-5 mt-1 space-y-1">
                    {config.discord.instances.map((inst) => {
                      const instStatus = status.discord?.instances?.find(s => s.instanceId === inst.instanceId);
                      const isSelected = activePlatform === 'discord' && activeDiscordInstanceId === inst.instanceId;
                      const dotColor = !inst.enabled ? 'bg-gray-400' : (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500');
                      return (
                        <div
                          key={inst.instanceId}
                          onClick={() => { setActivePlatform('discord'); setActiveDiscordInstanceId(inst.instanceId); }}
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
        {/* Header with status (hidden for multi-instance platforms that render per-instance headers) */}
        {activePlatform !== 'qq' && activePlatform !== 'feishu' && activePlatform !== 'dingtalk' && activePlatform !== 'email' && activePlatform !== 'wecom' && activePlatform !== 'nim' && activePlatform !== 'telegram' && activePlatform !== 'discord' && (
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

        {/* Email Settings (multi-instance, inline form like feishu/qq) */}
        {activePlatform === 'email' && !activeEmailInstanceId && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img src={PlatformRegistry.logo('email')} alt="Email" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
            <p className="text-sm text-secondary mb-4">
              {config.email.instances.length === 0
                ? i18nService.t('imEmailNoInstances')
                : i18nService.t('imEmailSelectInstance')}
            </p>
            {config.email.instances.length < MAX_EMAIL_INSTANCES && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const inst = await imService.addEmailInstance(`Email ${config.email.instances.length + 1}`);
                  if (inst) { setActivePlatform('email'); setActiveEmailInstanceId(inst.instanceId); setEmailExpanded(true); }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                + {i18nService.t('imEmailAddInstance')}
              </button>
            )}
          </div>
        )}
        {activePlatform === 'email' && activeEmailInstanceId && (() => {
          const inst = config.email.instances.find(i => i.instanceId === activeEmailInstanceId);
          if (!inst) return null;
          const instStatus = status.email.instances.find(s => s.instanceId === inst.instanceId);
          const inputClass = 'block w-full rounded-lg bg-surface border border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors';
          const labelClass = 'block text-xs font-medium text-secondary mb-1';
          return (
            <div className="space-y-4">
              {/* Instance Header: Name, Status, Enable Toggle, Delete */}
              <div className="flex items-center gap-3 pb-3 border-b border-border-subtle">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-surface border border-border-subtle p-1">
                    <img src={PlatformRegistry.logo('email')} alt="Email" className="w-4 h-4 object-contain rounded" />
                  </div>
                  <h3 className="text-sm font-medium text-foreground truncate">{inst.instanceName}</h3>
                </div>

                {/* Status badge */}
                <div className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${
                  instStatus?.connected
                    ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                    : 'bg-gray-500/15 text-gray-500 dark:text-gray-400'
                }`}>
                  {instStatus?.connected ? i18nService.t('connected') : i18nService.t('disconnected')}
                </div>

                {/* Enable toggle */}
                <button
                  type="button"
                  disabled={emailToggleLoading === inst.instanceId}
                  onClick={async () => {
                    const newEnabled = !inst.enabled;

                    // Turning OFF — no connectivity check needed
                    if (!newEnabled) {
                      const success = await imService.updateEmailInstanceConfig(inst.instanceId, { enabled: false });
                      if (success) {
                        dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { enabled: false } }));
                      }
                      return;
                    }

                    // Turning ON — run connectivity test first
                    if (emailToggleLoading) return;
                    setEmailToggleLoading(inst.instanceId);
                    try {
                      const result = await imService.testGateway('email', {
                        email: { instances: [inst] },
                      } as Partial<IMGatewayConfig>);
                      if (result && result.verdict !== 'fail') {
                        const success = await imService.updateEmailInstanceConfig(inst.instanceId, { enabled: true });
                        if (success) {
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { enabled: true } }));
                          dispatch(clearError());
                        }
                      } else {
                        void window.electron.dialog.showMessageBox({
                          type: 'warning',
                          message: i18nService.t('emailConnectivityFailAlert'),
                        });
                      }
                    } finally {
                      setEmailToggleLoading(null);
                    }
                  }}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    emailToggleLoading === inst.instanceId
                      ? 'cursor-wait bg-gray-400 dark:bg-gray-600'
                      : inst.enabled
                        ? `cursor-pointer ${instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500'}`
                        : 'cursor-pointer bg-gray-400 dark:bg-gray-600'
                  }`}
                  title={inst.enabled ? i18nService.t('imQQDisableInstance') : i18nService.t('imQQEnableInstance')}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
                    emailToggleLoading === inst.instanceId
                      ? 'translate-x-0 bg-gray-300 dark:bg-gray-500 animate-pulse'
                      : inst.enabled
                        ? 'translate-x-4 bg-white'
                        : 'translate-x-0 bg-white'
                  }`} />
                </button>

                {/* Delete button */}
                <button
                  type="button"
                  onClick={async () => {
                    await imService.deleteEmailInstance(inst.instanceId);
                    const remaining = config.email.instances.filter(i => i.instanceId !== inst.instanceId);
                    setActiveEmailInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
                  }}
                  className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex-shrink-0"
                  title={i18nService.t('delete') || 'Delete'}
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('delete')}
                </button>
              </div>

              {/* Email Address */}
              <div>
                <label className={labelClass}>{i18nService.t('emailAddress')} <span className="text-red-500">*</span></label>
                <input
                  type="email"
                  value={inst.email}
                  onChange={e => {
                    const email = e.target.value;
                    const instanceName = email.split('@')[0] || '';
                    dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { email, instanceName } }));
                  }}
                  onBlur={e => {
                    const email = e.target.value;
                    const instanceName = email.split('@')[0] || '';
                    void imService.persistEmailInstanceConfig(inst.instanceId, { email, instanceName, transport: 'ws' });
                  }}
                  placeholder={i18nService.t('emailAddressPlaceholder')}
                  className={inputClass}
                />
              </div>

              {/* API Key (always shown, transport is always ws) */}
              <div>
                <label className={labelClass}>{i18nService.t('emailApiKey')} <span className="text-red-500">*</span></label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showSecrets[`email.${inst.instanceId}.apiKey`] ? 'text' : 'password'}
                      value={inst.apiKey || ''}
                      onChange={e => dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { apiKey: e.target.value } }))}
                      onBlur={e => void imService.persistEmailInstanceConfig(inst.instanceId, { apiKey: e.target.value })}
                      placeholder={i18nService.t('emailApiKeyPlaceholder')}
                      className={`${inputClass} w-full pr-8`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecrets(prev => ({ ...prev, [`email.${inst.instanceId}.apiKey`]: !prev[`email.${inst.instanceId}.apiKey`] }))}
                      className="absolute right-2 inset-y-0 flex items-center p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={showSecrets[`email.${inst.instanceId}.apiKey`] ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                    >
                      {showSecrets[`email.${inst.instanceId}.apiKey`]
                        ? <EyeIcon className="h-4 w-4" />
                        : <EyeSlashIcon className="h-4 w-4" />}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleEmailGetApiKey()}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors whitespace-nowrap"
                  >
                    {i18nService.t('getApiKey')}
                  </button>
                </div>
                <p className="text-xs text-secondary mt-1">{i18nService.t('apiKeyHint')}</p>
              </div>

              {/* Advanced Options */}
              <details className="group">
                <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary transition-colors">
                  {i18nService.t('imAdvancedSettings')}
                </summary>
                <div className="mt-2 space-y-3 pl-2 border-l-2 border-border-subtle">
                  {/* Allow From (whitelist) */}
                  <div>
                    <label className={labelClass}>{i18nService.t('emailAllowFrom')}</label>
                    <input
                      type="text"
                      value={emailDrafts[inst.instanceId]?.allowFrom ?? (inst.allowFrom ?? ['*']).join(', ')}
                      onChange={e => setEmailDrafts(prev => ({ ...prev, [inst.instanceId]: { ...prev[inst.instanceId], allowFrom: e.target.value } }))}
                      onFocus={() => {
                        setEmailDrafts(prev => {
                          if (prev[inst.instanceId]?.allowFrom !== undefined) return prev;
                          return { ...prev, [inst.instanceId]: { ...prev[inst.instanceId], allowFrom: (inst.allowFrom ?? ['*']).join(', ') } };
                        });
                      }}
                      onBlur={e => {
                        const parsed = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                        dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { allowFrom: parsed } }));
                        void imService.persistEmailInstanceConfig(inst.instanceId, { allowFrom: parsed });
                        setEmailDrafts(prev => ({ ...prev, [inst.instanceId]: { ...prev[inst.instanceId], allowFrom: parsed.join(', ') } }));
                      }}
                      placeholder={i18nService.t('emailAllowFromPlaceholder')}
                      className={inputClass}
                    />
                    <p className="text-xs text-secondary mt-1">{i18nService.t('emailAllowFromHint')}</p>
                  </div>

                  {/* Reply Mode */}
                  <div>
                    <label className={labelClass}>{i18nService.t('emailReplyMode')}</label>
                    <select
                      value={inst.replyMode ?? 'complete'}
                      onChange={e => {
                        const replyMode = e.target.value as EmailInstanceConfig['replyMode'];
                        dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { replyMode } }));
                        void imService.persistEmailInstanceConfig(inst.instanceId, { replyMode });
                      }}
                      className={inputClass}
                    >
                      <option value="immediate">{i18nService.t('emailReplyModeImmediate')}</option>
                      <option value="accumulated">{i18nService.t('emailReplyModeAccumulated')}</option>
                      <option value="complete">{i18nService.t('emailReplyModeComplete')}</option>
                    </select>
                  </div>

                  {/* Reply To */}
                  <div>
                    <label className={labelClass}>{i18nService.t('emailReplyTo')}</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
                        <input
                          type="radio"
                          checked={inst.replyTo === 'sender' || !inst.replyTo}
                          onChange={() => {
                            dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { replyTo: 'sender' } }));
                            void imService.persistEmailInstanceConfig(inst.instanceId, { replyTo: 'sender' });
                          }}
                          className="accent-primary"
                        />
                        {i18nService.t('emailReplyToSender')}
                      </label>
                      <label className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
                        <input
                          type="radio"
                          checked={inst.replyTo === 'all'}
                          onChange={() => {
                            dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { replyTo: 'all' } }));
                            void imService.persistEmailInstanceConfig(inst.instanceId, { replyTo: 'all' });
                          }}
                          className="accent-primary"
                        />
                        {i18nService.t('emailReplyToAll')}
                      </label>
                    </div>
                  </div>

                  {/* A2A Config */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-secondary">{i18nService.t('emailA2aEnabled')}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const a2aEnabled = !(inst.a2aEnabled ?? true);
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { a2aEnabled } }));
                          void imService.persistEmailInstanceConfig(inst.instanceId, { a2aEnabled });
                        }}
                        className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer ${
                          (inst.a2aEnabled ?? true) ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-600'
                        }`}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          (inst.a2aEnabled ?? true) ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>
                    <div>
                      <label className={labelClass}>{i18nService.t('emailA2aAgentDomains')}</label>
                      <input
                        type="text"
                        value={emailDrafts[inst.instanceId]?.a2aAgentDomains ?? (inst.a2aAgentDomains ?? []).join(', ')}
                        onChange={e => setEmailDrafts(prev => ({ ...prev, [inst.instanceId]: { ...prev[inst.instanceId], a2aAgentDomains: e.target.value } }))}
                        onFocus={() => {
                          setEmailDrafts(prev => {
                            if (prev[inst.instanceId]?.a2aAgentDomains !== undefined) return prev;
                            return { ...prev, [inst.instanceId]: { ...prev[inst.instanceId], a2aAgentDomains: (inst.a2aAgentDomains ?? []).join(', ') } };
                          });
                        }}
                        onBlur={e => {
                          const parsed = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { a2aAgentDomains: parsed } }));
                          void imService.persistEmailInstanceConfig(inst.instanceId, { a2aAgentDomains: parsed });
                          setEmailDrafts(prev => ({ ...prev, [inst.instanceId]: { ...prev[inst.instanceId], a2aAgentDomains: parsed.join(', ') } }));
                        }}
                        placeholder={i18nService.t('emailA2aAgentDomainsPlaceholder')}
                        className={inputClass}
                      />
                      <p className="text-xs text-secondary mt-1">{i18nService.t('emailA2aAgentDomainsHint')}</p>
                    </div>
                    <div>
                      <label className={labelClass}>{i18nService.t('emailA2aMaxTurns')}</label>
                      <input
                        type="number"
                        value={inst.a2aMaxPingPongTurns ?? 20}
                        onChange={e => {
                          const a2aMaxPingPongTurns = parseInt(e.target.value) || 20;
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { a2aMaxPingPongTurns } }));
                        }}
                        onBlur={e => void imService.persistEmailInstanceConfig(inst.instanceId, {
                          a2aMaxPingPongTurns: parseInt(e.target.value) || 20,
                        })}
                        className={inputClass}
                      />
                    </div>
                  </div>
                </div>
              </details>

              {/* Connectivity test button */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => void handleConnectivityTest('email')}
                  disabled={testingPlatform === 'email'}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {testingPlatform === 'email'
                    ? i18nService.t('imConnectivityTesting')
                    : connectivityResults['email' as keyof typeof connectivityResults]
                      ? i18nService.t('imConnectivityRetest')
                      : i18nService.t('imConnectivityTest')}
                </button>
              </div>
            </div>
          );
        })()}

        {/* Telegram Settings (multi-instance) */}
        {activePlatform === 'telegram' && !activeTelegramInstanceId && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img src={PlatformRegistry.logo('telegram')} alt="Telegram" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
            <p className="text-sm text-secondary mb-4">
              {config.telegram.instances.length === 0
                ? (language === 'zh' ? '尚未添加 Telegram 实例，点击下方按钮添加' : 'No Telegram instances yet. Click below to add one.')
                : (language === 'zh' ? '请在左侧选择一个 Telegram 实例' : 'Select a Telegram instance from the sidebar.')}
            </p>
            {config.telegram.instances.length < MAX_TELEGRAM_INSTANCES && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const inst = await imService.addTelegramInstance(`Telegram Bot ${config.telegram.instances.length + 1}`);
                  if (inst) { setActiveTelegramInstanceId(inst.instanceId); setTelegramExpanded(true); }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                + {i18nService.t('imTelegramAddInstance')}
              </button>
            )}
          </div>
        )}
        {activePlatform === 'telegram' && activeTelegramInstanceId && (() => {
          const selectedInstance = config.telegram.instances.find(i => i.instanceId === activeTelegramInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.telegram?.instances?.find(s => s.instanceId === activeTelegramInstanceId);
          return (
            <TelegramInstanceSettings
              instance={selectedInstance}
              instanceStatus={selectedStatus}
              onConfigChange={(update) => {
                dispatch(setTelegramInstanceConfig({ instanceId: activeTelegramInstanceId, config: update }));
              }}
              onSave={async (override) => {
                const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                if (selectedInstance.enabled) {
                  await imService.updateTelegramInstanceConfig(activeTelegramInstanceId, configToSave);
                } else {
                  await imService.persistTelegramInstanceConfig(activeTelegramInstanceId, configToSave);
                }
              }}
              onRename={async (newName) => {
                dispatch(setTelegramInstanceConfig({ instanceId: activeTelegramInstanceId, config: { instanceName: newName } as any }));
                await imService.persistTelegramInstanceConfig(activeTelegramInstanceId, { instanceName: newName } as any);
              }}
              onDelete={async () => {
                await imService.deleteTelegramInstance(activeTelegramInstanceId);
                const remaining = config.telegram.instances.filter(i => i.instanceId !== activeTelegramInstanceId);
                setActiveTelegramInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
              }}
              onToggleEnabled={async () => {
                const newEnabled = !selectedInstance.enabled;
                if (newEnabled && !selectedInstance.botToken) return;
                const success = await imService.updateTelegramInstanceConfig(activeTelegramInstanceId, { enabled: newEnabled });
                if (success) {
                  dispatch(setTelegramInstanceConfig({ instanceId: activeTelegramInstanceId, config: { enabled: newEnabled } }));
                  if (newEnabled) dispatch(clearError());
                }
              }}
              onTestConnectivity={() => {
                void handleConnectivityTest('telegram');
              }}
              testingPlatform={testingPlatform}
              connectivityResults={connectivityResults}
              language={language}
            />
          );
        })()}

        {/* Discord Settings */}
        {activePlatform === 'discord' && !activeDiscordInstanceId && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img src={PlatformRegistry.logo('discord')} alt="Discord" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
            <p className="text-sm text-secondary mb-4">
              {config.discord.instances.length === 0
                ? (language === 'zh' ? '尚未添加 Discord 实例，点击下方按钮添加' : 'No Discord instances yet. Click below to add one.')
                : (language === 'zh' ? '请在左侧选择一个 Discord 实例' : 'Select a Discord instance from the sidebar.')}
            </p>
            {config.discord.instances.length < MAX_DISCORD_INSTANCES && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const inst = await imService.addDiscordInstance(`Discord Bot ${config.discord.instances.length + 1}`);
                  if (inst) { setActiveDiscordInstanceId(inst.instanceId); setDiscordExpanded(true); }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                + {language === 'zh' ? '添加 Discord 实例' : 'Add Discord Instance'}
              </button>
            )}
          </div>
        )}
        {activePlatform === 'discord' && activeDiscordInstanceId && (() => {
          const selectedInstance = config.discord.instances.find(i => i.instanceId === activeDiscordInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.discord?.instances?.find(s => s.instanceId === activeDiscordInstanceId);
          return (
            <DiscordInstanceSettings
              instance={selectedInstance}
              instanceStatus={selectedStatus}
              onConfigChange={(update) => {
                dispatch(setDiscordInstanceConfig({ instanceId: activeDiscordInstanceId, config: update }));
              }}
              onSave={async (override) => {
                const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                if (selectedInstance.enabled) {
                  await imService.updateDiscordInstanceConfig(activeDiscordInstanceId, configToSave);
                } else {
                  await imService.persistDiscordInstanceConfig(activeDiscordInstanceId, configToSave);
                }
              }}
              onRename={async (newName) => {
                dispatch(setDiscordInstanceConfig({ instanceId: activeDiscordInstanceId, config: { instanceName: newName } as any }));
                await imService.persistDiscordInstanceConfig(activeDiscordInstanceId, { instanceName: newName } as any);
              }}
              onDelete={async () => {
                await imService.deleteDiscordInstance(activeDiscordInstanceId);
                const remaining = config.discord.instances.filter(i => i.instanceId !== activeDiscordInstanceId);
                setActiveDiscordInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
              }}
              onToggleEnabled={async () => {
                const newEnabled = !selectedInstance.enabled;
                if (newEnabled && !selectedInstance.botToken) return;
                const success = await imService.updateDiscordInstanceConfig(activeDiscordInstanceId, { enabled: newEnabled });
                if (success) {
                  dispatch(setDiscordInstanceConfig({ instanceId: activeDiscordInstanceId, config: { enabled: newEnabled } }));
                  if (newEnabled) dispatch(clearError());
                }
              }}
              onTestConnectivity={() => {
                void handleConnectivityTest('discord');
              }}
              testingPlatform={testingPlatform}
              connectivityResults={connectivityResults}
              language={language}
            />
          );
        })()}

        {/* NIM (NetEase IM) Settings */}
        {activePlatform === 'nim' && !activeNimInstanceId && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img src={PlatformRegistry.logo('nim')} alt="NIM" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
            <p className="text-sm text-secondary mb-4">
              {config.nim.instances.length === 0
                ? (language === 'zh' ? '尚未添加云信实例，点击下方按钮添加' : 'No NIM instances yet. Click below to add one.')
                : (language === 'zh' ? '请在左侧选择一个云信实例' : 'Select a NIM instance from the sidebar.')}
            </p>
            {config.nim.instances.length < MAX_NIM_INSTANCES && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const inst = await imService.addNimInstance(`NIM Bot ${config.nim.instances.length + 1}`);
                  if (inst) { setActiveNimInstanceId(inst.instanceId); setNimExpanded(true); }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                + {i18nService.t('imNimAddInstance')}
              </button>
            )}
          </div>
        )}
        {activePlatform === 'nim' && activeNimInstanceId && (() => {
          const selectedInstance = config.nim.instances.find(i => i.instanceId === activeNimInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.nim?.instances?.find(s => s.instanceId === activeNimInstanceId);
          return (
            <NimInstanceSettings
              instance={selectedInstance}
              instanceStatus={selectedStatus}
              schemaData={nimSchemaData}
              onConfigChange={(update) => {
                dispatch(setNimInstanceConfig({ instanceId: activeNimInstanceId, config: update }));
              }}
              onSave={async (override) => {
                const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                if (selectedInstance.enabled) {
                  await imService.updateNimInstanceConfig(activeNimInstanceId, configToSave);
                } else {
                  await imService.persistNimInstanceConfig(activeNimInstanceId, configToSave);
                }
              }}
              onRename={async (newName) => {
                dispatch(setNimInstanceConfig({ instanceId: activeNimInstanceId, config: { instanceName: newName } as any }));
                await imService.persistNimInstanceConfig(activeNimInstanceId, { instanceName: newName } as any);
              }}
              onDelete={async () => {
                await imService.deleteNimInstance(activeNimInstanceId);
                const remaining = config.nim.instances.filter(i => i.instanceId !== activeNimInstanceId);
                setActiveNimInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
              }}
              onToggleEnabled={async () => {
                const newEnabled = !selectedInstance.enabled;
                if (newEnabled && !(selectedInstance.nimToken || (selectedInstance.appKey && selectedInstance.account && selectedInstance.token))) return;
                const success = await imService.updateNimInstanceConfig(activeNimInstanceId, { enabled: newEnabled });
                if (success) {
                  dispatch(setNimInstanceConfig({ instanceId: activeNimInstanceId, config: { enabled: newEnabled } }));
                  if (newEnabled) dispatch(clearError());
                }
              }}
              onTestConnectivity={() => {
                void handleConnectivityTest('nim');
              }}
              testingPlatform={testingPlatform}
              connectivityResults={connectivityResults}
              language={language}
            />
          );
        })()}

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

        {/* WeCom (企业微信) Multi-Instance Settings */}
        {activePlatform === 'wecom' && (() => {
          const wecomMultiConfig = config.wecom;
          const activeWecomInstance = activeWecomInstanceId
            ? wecomMultiConfig.instances.find(i => i.instanceId === activeWecomInstanceId)
            : null;
          const activeWecomStatus = activeWecomInstanceId
            ? status.wecom?.instances?.find(s => s.instanceId === activeWecomInstanceId)
            : undefined;

          if (activeWecomInstance) {
            return (
              <WecomInstanceSettings
                instance={activeWecomInstance}
                instanceStatus={activeWecomStatus}
                onConfigChange={(update) => {
                  dispatch(setWecomInstanceConfig({ instanceId: activeWecomInstanceId!, config: update }));
                }}
                onSave={async (override) => {
                  if (!configLoaded) return;
                  const configToSave = override
                    ? { ...activeWecomInstance, ...override }
                    : activeWecomInstance;
                  await imService.persistWecomInstanceConfig(activeWecomInstanceId!, configToSave);
                }}
                onRename={async (newName) => {
                  dispatch(setWecomInstanceConfig({ instanceId: activeWecomInstanceId!, config: { instanceName: newName } as any }));
                  await imService.persistWecomInstanceConfig(activeWecomInstanceId!, { instanceName: newName } as any);
                }}
                onDelete={async () => {
                  await imService.deleteWecomInstance(activeWecomInstanceId!);
                  setActiveWecomInstanceId(null);
                }}
                onToggleEnabled={async () => {
                  const newEnabled = !activeWecomInstance.enabled;
                  dispatch(setWecomInstanceConfig({ instanceId: activeWecomInstanceId!, config: { enabled: newEnabled } }));
                  await imService.updateWecomInstanceConfig(activeWecomInstanceId!, { enabled: newEnabled });
                }}
                onTestConnectivity={() => void handleConnectivityTest('wecom')}
                onQuickSetup={async () => {
                  setWecomQuickSetupStatus('pending');
                  setWecomQuickSetupError('');
                  try {
                    const bot = await WecomAIBotSDK.openBotInfoAuthWindow({ source: 'lobster-ai' });
                    if (!isMountedRef.current) return;
                    dispatch(setWecomInstanceConfig({ instanceId: activeWecomInstanceId!, config: { botId: bot.botid, secret: bot.secret, enabled: true } }));
                    dispatch(clearError());
                    await imService.updateWecomInstanceConfig(activeWecomInstanceId!, { botId: bot.botid, secret: bot.secret, enabled: true });
                    if (!isMountedRef.current) return;
                    await imService.loadStatus();
                    if (!isMountedRef.current) return;
                    setWecomQuickSetupStatus('success');
                  } catch (error: unknown) {
                    if (!isMountedRef.current) return;
                    setWecomQuickSetupStatus('error');
                    const err = error as { message?: string; code?: string };
                    setWecomQuickSetupError(err.message || err.code || 'Unknown error');
                  }
                }}
                quickSetupStatus={wecomQuickSetupStatus}
                quickSetupError={wecomQuickSetupError}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults as Record<string, IMConnectivityTestResult>}
                language={language}
                renderPairingSection={renderPairingSection}
              />
            );
          }

          // No instance selected - show placeholder
          return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <img src={PlatformRegistry.logo('wecom')} alt="WeCom" className="w-12 h-12 object-contain rounded-md mb-4 opacity-50" />
              <p className="text-sm text-secondary mb-4">
                {wecomMultiConfig.instances.length === 0
                  ? (language === 'zh' ? '尚未添加企业微信实例，点击下方按钮添加' : 'No WeCom instances yet. Click below to add one.')
                  : (language === 'zh' ? '请在左侧选择一个企业微信实例' : 'Select a WeCom instance from the sidebar.')}
              </p>
              {wecomMultiConfig.instances.length < MAX_WECOM_INSTANCES && (
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const name = `WeCom Bot ${wecomMultiConfig.instances.length + 1}`;
                    const inst = await imService.addWecomInstance(name);
                    if (inst) {
                      setActiveWecomInstanceId(inst.instanceId);
                      setWecomExpanded(true);
                    }
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  + {i18nService.t('imWecomAddInstance')}
                </button>
              )}
            </div>
          );
        })()}

        {activePlatform === 'popo' && (
          <div className="space-y-3">
            {/* Scan QR code section */}
            <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center space-y-3">
              {(popoQrStatus === 'idle' || popoQrStatus === 'error') && (
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
                  {popoQrStatus === 'error' && popoQrError && (
                    <div className="flex items-center justify-center gap-1.5 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                      <XCircleIcon className="h-4 w-4 flex-shrink-0" />
                      {popoQrError}
                    </div>
                  )}
                </>
              )}
              {popoQrStatus === 'loading' && (
                <div className="flex items-center justify-center gap-2 py-4">
                  <ArrowPathIcon className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-sm text-secondary">
                    {i18nService.t('imPopoQrLoading')}
                  </span>
                </div>
              )}
              {(popoQrStatus === 'showing' || popoQrStatus === 'waiting') && popoQrUrl && (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-foreground">
                    {i18nService.t('imPopoQrScanPrompt')}
                  </p>
                  <div className="flex justify-center">
                    <div className="p-3 bg-white rounded-lg border border-border-subtle">
                      <QRCodeSVG value={popoQrUrl} size={192} />
                    </div>
                  </div>
                  {popoQrStatus === 'waiting' && (
                    <p className="text-xs text-secondary animate-pulse">
                      {i18nService.t('imPopoQrWaiting')}
                    </p>
                  )}
                </div>
              )}
              {popoQrStatus === 'success' && (
                <div className="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                  <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                  {i18nService.t('imPopoQrSuccess')}
                </div>
              )}
            </div>

            {/* Platform Guide */}
            <PlatformGuide
              steps={[
                i18nService.t('imPopoGuideStep1'),
                i18nService.t('imPopoGuideStep2'),
                i18nService.t('imPopoGuideStep3'),
              ]}
                guideUrl={PlatformRegistry.guideUrl('popo')}
            />

            {/* Bound status badge */}
            {popoConfig.appKey && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                AppKey: {popoConfig.appKey}
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

            {/* Connectivity test */}
            <div className="pt-1">
              {renderConnectivityTestButton('popo')}
            </div>

            {/* Advanced Settings (collapsible) — credentials, connection mode, policies */}
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary transition-colors">
                {i18nService.t('imAdvancedSettings')}
              </summary>
              <div className="mt-2 space-y-3 pl-2 border-l-2 border-border-subtle">

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
                    <p className="text-xs text-amber-500">AES Key {i18nService.t('lang') === 'zh' ? '需要为 32 个字符' : 'must be 32 characters'}（{i18nService.t('lang') === 'zh' ? '当前' : 'current'} {popoConfig.aesKey.length}）</p>
                  )}
                </div>

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
