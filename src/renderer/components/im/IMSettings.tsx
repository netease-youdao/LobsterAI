/**
 * IM Settings Component
 * Configuration UI for DingTalk, Feishu and Telegram IM bots
 */

import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { ArrowLeftIcon, CheckCircleIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, EllipsisVerticalIcon, ExclamationTriangleIcon, PlusIcon, SignalIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { Platform } from '@shared/platform';
import { PlatformRegistry } from '@shared/platform';
import WecomAIBotSDK from '@wecom/wecom-aibot-sdk';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect, useMemo, useRef,useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import { RootState } from '../../store';
import { clearError,setDingTalkConfig, setDingTalkInstanceConfig, setDiscordConfig, setDiscordInstanceConfig, setEmailInstanceConfig, setFeishuConfig, setFeishuInstanceConfig, setNeteaseBeeChanConfig, setNimConfig, setNimInstanceConfig, setPopoInstanceConfig, setQQConfig, setQQInstanceConfig, setTelegramInstanceConfig, setTelegramOpenClawConfig, setWecomConfig, setWecomInstanceConfig, setWeixinConfig } from '../../store/slices/imSlice';
import type { EmailInstanceConfig, IMConnectivityCheck, IMConnectivityTestResult, IMGatewayConfig, WeixinOpenClawConfig } from '../../types/im';
import { MAX_DINGTALK_INSTANCES, MAX_DISCORD_INSTANCES, MAX_EMAIL_INSTANCES, MAX_FEISHU_INSTANCES, MAX_NIM_INSTANCES, MAX_POPO_INSTANCES, MAX_QQ_INSTANCES, MAX_TELEGRAM_INSTANCES, MAX_WECOM_INSTANCES } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import Modal from '../common/Modal';
import ComposeIcon from '../icons/ComposeIcon';
import EditIcon from '../icons/EditIcon';
import TrashIcon from '../icons/TrashIcon';
import DingTalkInstanceSettings from './DingTalkInstanceSettings';
import DiscordInstanceSettings from './DiscordInstanceSettings';
import FeishuInstanceSettings from './FeishuInstanceSettings';
import NimInstanceSettings from './NimInstanceSettings';
import { nimFallbackInstanceSchema, nimFallbackUiHints } from './nimSchemaFallback';
import PopoInstanceSettings from './PopoInstanceSettings';
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

const IM_AUTH_RESTART_ON_SAVE_OPTIONS = {
  markRestartOnSave: true,
} as const;

const IMAnalyticsSource = {
  Settings: 'settings_im',
} as const;

const checkLevelColorClass: Record<IMConnectivityCheck['level'], string> = {
  pass: 'text-green-600 dark:text-green-400',
  info: 'text-sky-600 dark:text-sky-400',
  warn: 'text-yellow-700 dark:text-yellow-300',
  fail: 'text-red-600 dark:text-red-400',
};

const MULTI_INSTANCE_PLATFORMS = new Set<Platform>([
  'dingtalk',
  'feishu',
  'qq',
  'email',
  'nim',
  'wecom',
  'telegram',
  'discord',
  'popo',
]);

type IMAnalyticsPlatformKind = 'single_instance' | 'multi_instance';
type IMAnalyticsInstanceOperation = 'added' | 'deleted' | 'enabled' | 'disabled';
type IMAnalyticsGatewayOperation = 'start' | 'stop';

const IM_CREDENTIAL_FIELDS = [
  'account',
  'aesKey',
  'apiKey',
  'appId',
  'appKey',
  'appSecret',
  'botId',
  'botToken',
  'clientId',
  'clientSecret',
  'email',
  'nimToken',
  'secret',
  'token',
  'webhookSecret',
] as const;

const getIMPlatformKind = (platform: Platform): IMAnalyticsPlatformKind => (
  MULTI_INSTANCE_PLATFORMS.has(platform) ? 'multi_instance' : 'single_instance'
);

const getIMInstancesFromConfig = (
  imConfig: IMGatewayConfig,
  platform: Platform,
): IMInstanceConfigCard[] => {
  if (!MULTI_INSTANCE_PLATFORMS.has(platform)) {
    return [];
  }
  const platformConfig = imConfig[platform as keyof IMGatewayConfig] as { instances?: IMInstanceConfigCard[] } | undefined;
  return Array.isArray(platformConfig?.instances) ? platformConfig.instances : [];
};

const countEnabledIMInstances = (instances: IMInstanceConfigCard[]): number => (
  instances.filter(instance => instance.enabled === true).length
);

const getIMPlatformEnabled = (imConfig: IMGatewayConfig, platform: Platform): boolean => {
  const instances = getIMInstancesFromConfig(imConfig, platform);
  if (instances.length > 0 || MULTI_INSTANCE_PLATFORMS.has(platform)) {
    return countEnabledIMInstances(instances) > 0;
  }
  const platformConfig = imConfig[platform as keyof IMGatewayConfig] as { enabled?: boolean } | undefined;
  return platformConfig?.enabled === true;
};

const hasIMAgentBinding = (imConfig: IMGatewayConfig, platform: Platform): boolean => {
  const binding = imConfig.settings?.platformAgentBindings?.[platform];
  return Boolean(binding && binding !== 'main');
};

const hasIMCredentialState = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return IM_CREDENTIAL_FIELDS.some(field => {
    const fieldValue = record[field];
    return typeof fieldValue === 'string' && fieldValue.trim().length > 0;
  });
};

const getIMCredentialStateCount = (imConfig: IMGatewayConfig, platform: Platform): number => {
  const instances = getIMInstancesFromConfig(imConfig, platform);
  if (instances.length > 0 || MULTI_INSTANCE_PLATFORMS.has(platform)) {
    return instances.filter(instance => hasIMCredentialState(instance)).length;
  }
  return hasIMCredentialState(imConfig[platform as keyof IMGatewayConfig]) ? 1 : 0;
};

const getIMConfigStringField = (
  value: unknown,
  field: string,
): string => {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' ? fieldValue : '';
};

const collectIMConfigFieldValues = (
  imConfig: IMGatewayConfig,
  platform: Platform,
  field: string,
): string => {
  const instances = getIMInstancesFromConfig(imConfig, platform);
  if (instances.length > 0 || MULTI_INSTANCE_PLATFORMS.has(platform)) {
    return instances.map(instance => getIMConfigStringField(instance, field)).join('|');
  }
  return getIMConfigStringField(imConfig[platform as keyof IMGatewayConfig], field);
};

const buildIMChangedKeys = (
  previousConfig: IMGatewayConfig | null,
  nextConfig: IMGatewayConfig,
  platform: Platform,
  fallback = 'config',
): string => {
  if (!previousConfig) {
    return fallback;
  }

  const changedKeys = new Set<string>();
  const previousInstances = getIMInstancesFromConfig(previousConfig, platform);
  const nextInstances = getIMInstancesFromConfig(nextConfig, platform);

  if (previousInstances.length !== nextInstances.length) {
    changedKeys.add('instance_count');
  }
  if (getIMPlatformEnabled(previousConfig, platform) !== getIMPlatformEnabled(nextConfig, platform)) {
    changedKeys.add('enabled');
  }
  if (countEnabledIMInstances(previousInstances) !== countEnabledIMInstances(nextInstances)) {
    changedKeys.add('enabled');
  }
  if (getIMCredentialStateCount(previousConfig, platform) !== getIMCredentialStateCount(nextConfig, platform)) {
    changedKeys.add('credential_state');
  }
  if (hasIMAgentBinding(previousConfig, platform) !== hasIMAgentBinding(nextConfig, platform)) {
    changedKeys.add('agent_binding');
  }
  if (
    collectIMConfigFieldValues(previousConfig, platform, 'dmPolicy')
    !== collectIMConfigFieldValues(nextConfig, platform, 'dmPolicy')
  ) {
    changedKeys.add('dm_policy');
  }
  if (
    collectIMConfigFieldValues(previousConfig, platform, 'replyMode')
    !== collectIMConfigFieldValues(nextConfig, platform, 'replyMode')
    || collectIMConfigFieldValues(previousConfig, platform, 'replyToMode')
    !== collectIMConfigFieldValues(nextConfig, platform, 'replyToMode')
    || collectIMConfigFieldValues(previousConfig, platform, 'replyTo')
    !== collectIMConfigFieldValues(nextConfig, platform, 'replyTo')
  ) {
    changedKeys.add('reply_mode');
  }
  if (
    collectIMConfigFieldValues(previousConfig, platform, 'connectionMode')
    !== collectIMConfigFieldValues(nextConfig, platform, 'connectionMode')
  ) {
    changedKeys.add('connection_mode');
  }

  return changedKeys.size > 0 ? Array.from(changedKeys).sort().join(',') : fallback;
};

const reportIMSettingsSaved = (
  platform: Platform,
  nextConfig: IMGatewayConfig,
  previousConfig: IMGatewayConfig | null = null,
  fallbackChangedKeys = 'config',
): void => {
  const instances = getIMInstancesFromConfig(nextConfig, platform);
  const isMultiInstance = MULTI_INSTANCE_PLATFORMS.has(platform);
  void reportYdAnalyzer({
    action: LogReporterAction.ImSettingsSaved,
    source: IMAnalyticsSource.Settings,
    platform,
    platformKind: getIMPlatformKind(platform),
    enabled: getIMPlatformEnabled(nextConfig, platform),
    instanceCount: isMultiInstance ? instances.length : undefined,
    enabledInstanceCount: isMultiInstance ? countEnabledIMInstances(instances) : undefined,
    changedKeys: buildIMChangedKeys(previousConfig, nextConfig, platform, fallbackChangedKeys),
    hasAgentBinding: hasIMAgentBinding(nextConfig, platform),
  });
};

const reportIMConnectionTested = (
  platform: Platform,
  result: IMConnectivityTestResult | null,
): void => {
  const checks = result?.checks ?? [];
  void reportYdAnalyzer({
    action: LogReporterAction.ImConnectionTested,
    source: IMAnalyticsSource.Settings,
    platform,
    platformKind: getIMPlatformKind(platform),
    result: result?.verdict ?? 'failed',
    checkCount: result ? checks.length : undefined,
    failedCheckCount: result ? checks.filter(check => check.level === 'fail').length : undefined,
    warningCheckCount: result ? checks.filter(check => check.level === 'warn').length : undefined,
  });
};

const reportIMInstanceChanged = (
  platform: Platform,
  operation: IMAnalyticsInstanceOperation,
  instanceCount: number,
  enabledInstanceCount: number,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.ImInstanceChanged,
    source: IMAnalyticsSource.Settings,
    platform,
    operation,
    instanceCount,
    enabledInstanceCount,
  });
};

const reportIMGatewayToggledAction = (
  platform: Platform,
  operation: IMAnalyticsGatewayOperation,
  result: 'success' | 'failed',
  failureReason?: string,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.ImGatewayToggled,
    source: IMAnalyticsSource.Settings,
    platform,
    operation,
    result,
    platformKind: getIMPlatformKind(platform),
    failureReason,
  });
};

const WeixinRuntimeLastError = {
  Disabled: 'disabled',
  NotConfigured: 'not configured',
} as const;

const IMSaveReminderTarget = {
  Platform: 'platform',
} as const;

const IMRuntimeDisplayState = {
  Disabled: 'disabled',
  PendingSave: 'pendingSave',
  Connecting: 'connecting',
  Starting: 'starting',
  Connected: 'connected',
  Failed: 'failed',
} as const;
type IMRuntimeDisplayState = typeof IMRuntimeDisplayState[keyof typeof IMRuntimeDisplayState];

type IMInstanceConfigCard = {
  instanceId: string;
  instanceName: string;
  enabled: boolean;
  [key: string]: unknown;
};

type IMInstanceStatusCard = {
  instanceId: string;
  instanceName?: string;
  connected?: boolean;
  starting?: boolean;
  lastError?: string | null;
  error?: string | null;
  botAccount?: string | null;
  botOpenId?: string | null;
  botUsername?: string | null;
  botId?: string | null;
  email?: string | null;
};

type IMInstanceTarget = {
  platform: Platform;
  instanceId: string;
};

type IMInstanceRenameTarget = IMInstanceTarget & {
  value: string;
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
  const [activeFeishuInstanceId, setActiveFeishuInstanceId] = useState<string | null>(null);
  const [activeDingTalkInstanceId, setActiveDingTalkInstanceId] = useState<string | null>(null);
  const [activeEmailInstanceId, setActiveEmailInstanceId] = useState<string | null>(null);
  const [activeWecomInstanceId, setActiveWecomInstanceId] = useState<string | null>(null);
  const [activeNimInstanceId, setActiveNimInstanceId] = useState<string | null>(null);
  const [activeTelegramInstanceId, setActiveTelegramInstanceId] = useState<string | null>(null);
  const [activeDiscordInstanceId, setActiveDiscordInstanceId] = useState<string | null>(null);
  const [activePopoInstanceId, setActivePopoInstanceId] = useState<string | null>(null);
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
  const [instanceMenuTarget, setInstanceMenuTarget] = useState<IMInstanceTarget | null>(null);
  const [renamingInstance, setRenamingInstance] = useState<IMInstanceRenameTarget | null>(null);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<IMInstanceTarget | null>(null);
  const [saveReminderTargets, setSaveReminderTargets] = useState<Record<string, boolean>>({});
  const [isDeletingInstance, setIsDeletingInstance] = useState(false);
  // WeCom quick setup state
  const [wecomQuickSetupStatus, setWecomQuickSetupStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [wecomQuickSetupError, setWecomQuickSetupError] = useState<string>('');
  // Weixin QR login state
  const [weixinQrStatus, setWeixinQrStatus] = useState<'idle' | 'loading' | 'showing' | 'waiting' | 'success' | 'error'>('idle');
  const [weixinQrUrl, setWeixinQrUrl] = useState<string>('');
  const [weixinQrError, setWeixinQrError] = useState<string>('');
  const [weixinAllowFromInput, setWeixinAllowFromInput] = useState<string>('');
  const [isWeixinDmPolicyMenuOpen, setIsWeixinDmPolicyMenuOpen] = useState(false);
  const weixinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const weixinDmPolicyMenuRef = useRef<HTMLDivElement>(null);
  const [_localIp, setLocalIp] = useState<string>('');
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

  useEffect(() => {
    if (!instanceMenuTarget) return undefined;
    const closeInstanceMenu = () => setInstanceMenuTarget(null);
    document.addEventListener('pointerdown', closeInstanceMenu);
    return () => document.removeEventListener('pointerdown', closeInstanceMenu);
  }, [instanceMenuTarget]);

  useEffect(() => {
    if (!isWeixinDmPolicyMenuOpen) return undefined;

    const closeWeixinDmPolicyMenu = (event: PointerEvent) => {
      if (weixinDmPolicyMenuRef.current?.contains(event.target as Node)) return;
      setIsWeixinDmPolicyMenuOpen(false);
    };

    const handleWeixinDmPolicyMenuKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsWeixinDmPolicyMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeWeixinDmPolicyMenu);
    document.addEventListener('keydown', handleWeixinDmPolicyMenuKeydown);
    return () => {
      document.removeEventListener('pointerdown', closeWeixinDmPolicyMenu);
      document.removeEventListener('keydown', handleWeixinDmPolicyMenuKeydown);
    };
  }, [isWeixinDmPolicyMenuOpen]);

  useEffect(() => {
    setInstanceMenuTarget(null);
    setRenamingInstance(null);
    setDeleteConfirmTarget(null);
    setIsWeixinDmPolicyMenuOpen(false);
  }, [activePlatform]);

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
              }, IM_AUTH_RESTART_ON_SAVE_OPTIONS);
              setActiveFeishuInstanceId(inst.instanceId);
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


  // Handle NetEase Bee config change
  const handleNeteaseBeeChanChange = (field: 'clientId' | 'secret', value: string) => {
    dispatch(setNeteaseBeeChanConfig({ [field]: value }));
  };

  // Handle Weixin OpenClaw config
  const weixinOpenClawConfig = config.weixin;
  const weixinRuntimeAccountId = status.weixin?.accountId || '';
  const weixinAccountId = weixinOpenClawConfig.accountId || weixinRuntimeAccountId;
  const weixinDmPolicyOptions: Array<{ value: WeixinOpenClawConfig['dmPolicy']; label: string }> = [
    { value: 'open', label: i18nService.t('imDmPolicyOpen') },
    { value: 'pairing', label: i18nService.t('imDmPolicyPairing') },
    { value: 'allowlist', label: i18nService.t('imDmPolicyAllowlist') },
    { value: 'disabled', label: i18nService.t('imDmPolicyDisabled') },
  ];

  const updateWeixinDmPolicy = (dmPolicy: WeixinOpenClawConfig['dmPolicy']) => {
    setIsWeixinDmPolicyMenuOpen(false);
    if (dmPolicy === weixinOpenClawConfig.dmPolicy) return;
    void imService.updateConfig({ weixin: { ...weixinOpenClawConfig, dmPolicy } });
  };

  const persistConnectedWeixinConfig = async (accountId: string) => {
    dispatch(setWeixinConfig({ enabled: true, accountId }));
    setSaveReminderTarget('weixin', null, true);
    dispatch(clearError());
    await imService.loadConfig();
    await imService.loadStatus();
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
      if (!startResult.sessionKey) {
        setWeixinQrStatus('error');
        setWeixinQrError(i18nService.t('imWeixinQrFailed'));
        return;
      }

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

      if (waitResult.success && (waitResult.connected || waitResult.alreadyConnected)) {
        const accountId = waitResult.accountId || weixinAccountId;
        if (!accountId) {
          setWeixinQrStatus('error');
          setWeixinQrError(i18nService.t('imWeixinQrAccountMissing'));
          return;
        }

        setWeixinQrStatus('success');
        await persistConnectedWeixinConfig(accountId);
        reportIMSettingsSaved('weixin', config, null, 'credential_state,enabled');
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
      const success = await imService.persistConfig({ telegram: tgMultiConfig });
      if (success) reportIMSettingsSaved('telegram', config);
      return;
    }

    // For Discord, save discord config directly
    if (activePlatform === 'discord') {
      const success = await imService.persistConfig({ discord: discordMultiConfig });
      if (success) reportIMSettingsSaved('discord', config);
      return;
    }

    // For Feishu, save feishu config directly
    if (activePlatform === 'feishu') {
      const success = await imService.persistConfig({ feishu: feishuMultiConfig });
      if (success) reportIMSettingsSaved('feishu', config);
      return;
    }

    // For QQ, save qq config directly (OpenClaw mode)
    if (activePlatform === 'qq') {
      const success = await imService.persistConfig({ qq: qqMultiConfig });
      if (success) reportIMSettingsSaved('qq', config);
      return;
    }

    // For WeCom, save is handled per-instance in WecomInstanceSettings
    if (activePlatform === 'wecom') {
      const success = await imService.persistConfig({ wecom: config.wecom });
      if (success) reportIMSettingsSaved('wecom', config);
      return;
    }

    // For Weixin, save weixin config directly (OpenClaw mode)
    if (activePlatform === 'weixin') {
      const success = await imService.persistConfig({ weixin: weixinOpenClawConfig });
      if (success) reportIMSettingsSaved('weixin', config);
      return;
    }

    // For Email, save the full email multi-instance config
    if (activePlatform === 'email') {
      const success = await imService.persistConfig({ email: config.email ?? { instances: [] } });
      if (success) reportIMSettingsSaved('email', config);
      return;
    }

    const success = await imService.persistConfig({ [activePlatform]: config[activePlatform] });
    if (success) reportIMSettingsSaved(activePlatform, config);
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
    reportIMConnectionTested(platform, result);
    setTestingPlatform(null);
    return result;
  };

  const getSaveReminderTargetKey = (platform: Platform, instanceId?: string | null): string => (
    `${platform}:${instanceId ?? IMSaveReminderTarget.Platform}`
  );

  const setSaveReminderTarget = (platform: Platform, instanceId: string | null, enabled: boolean) => {
    const key = getSaveReminderTargetKey(platform, instanceId);
    setSaveReminderTargets((current) => {
      const next = { ...current };
      if (enabled) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return next;
    });
  };

  const hasSaveReminderTarget = (platform: Platform, instanceId?: string | null): boolean => (
    saveReminderTargets[getSaveReminderTargetKey(platform, instanceId)] === true
  );

  // Toggle IM enabled state as pending settings config. Gateway runtime is
  // applied by the global Save action.
  const toggleGateway = async (platform: Platform) => {
    // Re-entrancy guard: if a toggle is already in progress for this platform, bail out.
    // This prevents rapid ON→OFF→ON clicks from racing local config writes.
    if (togglingPlatform === platform) return;
    setTogglingPlatform(platform);

    try {
      // Settings toggles are saved as pending config changes. The global Save
      // button later asks main to diff IM config and restart the gateway once
      // when the change affects channel runtime.
      // Pessimistic UI update: wait for IPC to complete before updating Redux state.
      // This prevents UI/backend state divergence when rapidly toggling.
      if (platform === 'telegram') {
        // Telegram multi-instance: toggle is handled from the instance overview cards.
        return;
      }

      if (platform === 'dingtalk') {
        // DingTalk multi-instance: toggle is handled from the instance overview cards.
        return;
      }

      if (platform === 'feishu') {
        // Feishu multi-instance: toggle is handled from the instance overview cards.
        return;
      }

      if (platform === 'discord') {
        // Discord multi-instance: toggle is handled from the instance overview cards.
        return;
      }

      if (platform === 'qq' || platform === 'email' || platform === 'wecom' || platform === 'nim') {
        // Multi-instance platforms toggle per instance from their overview cards or account detail.
        return;
      }

      if (platform === 'weixin') {
        const newEnabled = !weixinOpenClawConfig.enabled;
        const operation: IMAnalyticsGatewayOperation = newEnabled ? 'start' : 'stop';
        const success = await imService.updateConfig({ weixin: { ...weixinOpenClawConfig, enabled: newEnabled } });
        if (success) {
          dispatch(setWeixinConfig({ enabled: newEnabled }));
          setSaveReminderTarget(platform, null, newEnabled);
          if (newEnabled) dispatch(clearError());
          await imService.loadStatus();
          reportIMGatewayToggledAction(platform, operation, 'success');
        } else {
          reportIMGatewayToggledAction(platform, operation, 'failed', 'config_update_failed');
        }
        return;
      }

      if (platform === 'popo') {
        // POPO multi-instance: toggle is handled from the instance overview cards.
        return;
      }

      const isEnabled = config[platform].enabled;
      const newEnabled = !isEnabled;
      const operation: IMAnalyticsGatewayOperation = newEnabled ? 'start' : 'stop';

      // Map platform to its Redux action
      const setConfigAction = getSetConfigAction(platform);

      // Persist the updated config (construct manually since Redux state hasn't re-rendered yet)
      const success = await imService.updateConfig({ [platform]: { ...config[platform], enabled: newEnabled } });
      if (success) {
        dispatch(setConfigAction({ enabled: newEnabled }));
        setSaveReminderTarget(platform, null, newEnabled);
        if (newEnabled) dispatch(clearError());
        await imService.loadStatus();
        reportIMGatewayToggledAction(platform, operation, 'success');
      } else {
        reportIMGatewayToggledAction(platform, operation, 'failed', 'config_update_failed');
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
  const weixinConnected = Boolean(weixinOpenClawConfig.enabled && status.weixin?.connected);
  const weixinLastError = status.weixin?.lastError ?? null;
  const isWeixinCredentialMissingError = Boolean(
    weixinOpenClawConfig.enabled
    && weixinAccountId
    && weixinLastError?.trim().toLowerCase().includes(WeixinRuntimeLastError.NotConfigured)
  );
  const shouldShowWeixinError = Boolean(
    weixinLastError && weixinLastError.trim().toLowerCase() !== WeixinRuntimeLastError.Disabled
  );
  const popoConnected = status.popo?.instances?.some(i => i.connected) ?? false;
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
    if (platform === 'popo') {
      return config.popo.instances?.some(i => i.enabled);
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

  const getPlatformDisplayState = (platform: Platform): IMRuntimeDisplayState => {
    if (hasSaveReminderTarget(platform)) return IMRuntimeDisplayState.PendingSave;
    if (!isPlatformEnabled(platform)) return IMRuntimeDisplayState.Disabled;
    if (getPlatformConnected(platform)) return IMRuntimeDisplayState.Connected;
    if (getPlatformStarting(platform)) return IMRuntimeDisplayState.Starting;
    if (platform === 'weixin' && shouldShowWeixinError) return IMRuntimeDisplayState.Failed;
    return IMRuntimeDisplayState.Connecting;
  };

  const getPlatformStatusLabel = (platform: Platform): string => {
    const displayState = getPlatformDisplayState(platform);
    if (displayState === IMRuntimeDisplayState.PendingSave) return i18nService.t('pendingSave');
    if (displayState === IMRuntimeDisplayState.Connecting) return i18nService.t('connecting');
    if (displayState === IMRuntimeDisplayState.Starting) return i18nService.t('starting');
    if (displayState === IMRuntimeDisplayState.Connected) return i18nService.t('connected');
    if (displayState === IMRuntimeDisplayState.Failed) return i18nService.t('connectionFailed');
    return i18nService.t('disconnected');
  };

  const getPlatformStatusColorClass = (platform: Platform): string => {
    const displayState = getPlatformDisplayState(platform);
    if (displayState === IMRuntimeDisplayState.Connected) {
      return 'bg-green-500/15 text-green-600 dark:text-green-400';
    }
    if (displayState === IMRuntimeDisplayState.Connecting || displayState === IMRuntimeDisplayState.Starting) {
      return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
    }
    if (displayState === IMRuntimeDisplayState.PendingSave) {
      return 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300';
    }
    if (displayState === IMRuntimeDisplayState.Failed) {
      return 'bg-red-500/15 text-red-600 dark:text-red-400';
    }
    return 'bg-gray-500/15 text-gray-500 dark:text-gray-400';
  };

  const getPlatformSwitchColorClass = (platform: Platform): string => {
    const displayState = getPlatformDisplayState(platform);
    if (displayState === IMRuntimeDisplayState.Connected) return 'bg-green-500';
    if (displayState === IMRuntimeDisplayState.Connecting || displayState === IMRuntimeDisplayState.Starting) return 'bg-sky-500';
    if (displayState === IMRuntimeDisplayState.Failed) return 'bg-red-500';
    if (displayState === IMRuntimeDisplayState.PendingSave) return 'bg-yellow-500';
    return 'bg-gray-300 dark:bg-gray-600';
  };

  const getPlatformStatusDotClass = (platform: Platform): string | null => {
    const displayState = getPlatformDisplayState(platform);
    if (displayState === IMRuntimeDisplayState.Connected) return 'bg-green-500';
    if (displayState === IMRuntimeDisplayState.Connecting || displayState === IMRuntimeDisplayState.Starting) {
      return 'animate-pulse bg-sky-500';
    }
    if (displayState === IMRuntimeDisplayState.PendingSave) return 'bg-yellow-500';
    if (displayState === IMRuntimeDisplayState.Failed) return 'bg-red-500';
    return null;
  };

  const renderSaveReminder = (platform: Platform) => (
    <div className="rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-300">
      {i18nService.t('imChannelEnabledPendingSave').replace('{platform}', i18nService.t(platform))}
    </div>
  );

  const shouldShowInstanceSaveReminder = (
    platform: Platform,
    instance: IMInstanceConfigCard,
    _instanceStatus?: IMInstanceStatusCard,
  ): boolean => (
    hasSaveReminderTarget(platform, instance.instanceId)
  );

  const renderInstanceSaveReminder = (
    platform: Platform,
    instance: IMInstanceConfigCard,
    _instanceStatus?: IMInstanceStatusCard,
  ) => (
    shouldShowInstanceSaveReminder(platform, instance, _instanceStatus) ? renderSaveReminder(platform) : null
  );

  const renderPlatformRuntimeNotice = (platform: Platform) => {
    const displayState = getPlatformDisplayState(platform);
    if (displayState === IMRuntimeDisplayState.PendingSave) return renderSaveReminder(platform);

    if (displayState === IMRuntimeDisplayState.Connecting || displayState === IMRuntimeDisplayState.Starting) {
      return (
        <div className="flex items-center gap-2 rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
          <ArrowPathIcon className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
          <span>{i18nService.t('imChannelConnecting').replace('{platform}', i18nService.t(platform))}</span>
        </div>
      );
    }

    if (displayState === IMRuntimeDisplayState.Failed) {
      return (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {i18nService.t('imChannelConnectionFailed').replace('{platform}', i18nService.t(platform))}
        </div>
      );
    }

    return null;
  };

  const shouldPollWeixinRuntimeStatus = Boolean(
    configLoaded
    && weixinOpenClawConfig.enabled
    && !weixinConnected
    && !hasSaveReminderTarget('weixin')
  );

  useEffect(() => {
    if (!shouldPollWeixinRuntimeStatus) return undefined;

    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      timer = setTimeout(() => {
        void pollStatus();
      }, delayMs);
    };

    const pollStatus = async () => {
      attempts += 1;
      await imService.loadStatus();
      if (stopped || attempts >= 18) return;
      schedulePoll(attempts < 8 ? 2000 : 5000);
    };

    schedulePoll(1500);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [shouldPollWeixinRuntimeStatus]);

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
            setSaveReminderTarget('telegram', activeTelegramInstanceId, true);
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
            setSaveReminderTarget('dingtalk', activeDingTalkInstanceId, true);
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
            setSaveReminderTarget('qq', activeQQInstanceId, true);
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
            setSaveReminderTarget('wecom', activeWecomInstanceId, true);
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
            setSaveReminderTarget('feishu', activeFeishuInstanceId, true);
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
            setSaveReminderTarget('nim', activeNimInstanceId, true);
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
            setSaveReminderTarget('discord', activeDiscordInstanceId, true);
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
      popo: null, // POPO is multi-instance; toggle handled per-instance in PopoInstanceSettings
      email: null, // Email is multi-instance; toggle handled per-instance in EmailSettings
    };
    return actionMap[platform];
  };

  const renderConnectivityTestButton = (platform: Platform) => (
    <button
      type="button"
      onClick={() => handleConnectivityTest(platform)}
      disabled={isLoading || testingPlatform === platform}
      className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]"
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

  const isMultiInstancePlatform = (platform: Platform) => MULTI_INSTANCE_PLATFORMS.has(platform);

  const setActiveInstanceForPlatform = (platform: Platform, instanceId: string | null) => {
    if (platform === 'dingtalk') setActiveDingTalkInstanceId(instanceId);
    if (platform === 'feishu') setActiveFeishuInstanceId(instanceId);
    if (platform === 'qq') setActiveQQInstanceId(instanceId);
    if (platform === 'email') setActiveEmailInstanceId(instanceId);
    if (platform === 'nim') setActiveNimInstanceId(instanceId);
    if (platform === 'wecom') setActiveWecomInstanceId(instanceId);
    if (platform === 'telegram') setActiveTelegramInstanceId(instanceId);
    if (platform === 'discord') setActiveDiscordInstanceId(instanceId);
    if (platform === 'popo') setActivePopoInstanceId(instanceId);
  };

  const getInstancesForPlatform = (platform: Platform): IMInstanceConfigCard[] => {
    if (platform === 'dingtalk') return config.dingtalk.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'feishu') return config.feishu.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'qq') return config.qq.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'email') return config.email.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'nim') return config.nim.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'wecom') return config.wecom.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'telegram') return config.telegram.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'discord') return config.discord.instances as unknown as IMInstanceConfigCard[];
    if (platform === 'popo') return config.popo.instances as unknown as IMInstanceConfigCard[];
    return [];
  };

  const getStatusesForPlatform = (platform: Platform): IMInstanceStatusCard[] => {
    if (platform === 'dingtalk') return status.dingtalk?.instances ?? [];
    if (platform === 'feishu') return status.feishu?.instances ?? [];
    if (platform === 'qq') return status.qq?.instances ?? [];
    if (platform === 'email') return status.email?.instances ?? [];
    if (platform === 'nim') return status.nim?.instances ?? [];
    if (platform === 'wecom') return status.wecom?.instances ?? [];
    if (platform === 'telegram') return status.telegram?.instances ?? [];
    if (platform === 'discord') return status.discord?.instances ?? [];
    if (platform === 'popo') return status.popo?.instances ?? [];
    return [];
  };

  const getMaxInstancesForPlatform = (platform: Platform): number => {
    if (platform === 'dingtalk') return MAX_DINGTALK_INSTANCES;
    if (platform === 'feishu') return MAX_FEISHU_INSTANCES;
    if (platform === 'qq') return MAX_QQ_INSTANCES;
    if (platform === 'email') return MAX_EMAIL_INSTANCES;
    if (platform === 'nim') return MAX_NIM_INSTANCES;
    if (platform === 'wecom') return MAX_WECOM_INSTANCES;
    if (platform === 'telegram') return MAX_TELEGRAM_INSTANCES;
    if (platform === 'discord') return MAX_DISCORD_INSTANCES;
    if (platform === 'popo') return MAX_POPO_INSTANCES;
    return 0;
  };

  const getStringField = (instance: IMInstanceConfigCard, field: string): string => {
    const value = instance[field];
    return typeof value === 'string' ? value : '';
  };

  const hasInstanceCredentials = (platform: Platform, instance: IMInstanceConfigCard): boolean => {
    if (platform === 'dingtalk') return !!(getStringField(instance, 'clientId') && getStringField(instance, 'clientSecret'));
    if (platform === 'feishu') return !!(getStringField(instance, 'appId') && getStringField(instance, 'appSecret'));
    if (platform === 'qq') return !!(getStringField(instance, 'appId') && getStringField(instance, 'appSecret'));
    if (platform === 'email') return !!(getStringField(instance, 'email') && getStringField(instance, 'apiKey'));
    if (platform === 'nim') {
      return !!(
        getStringField(instance, 'nimToken')
        || (getStringField(instance, 'appKey') && getStringField(instance, 'account') && getStringField(instance, 'token'))
      );
    }
    if (platform === 'wecom') return !!(getStringField(instance, 'botId') && getStringField(instance, 'secret'));
    if (platform === 'telegram') return !!getStringField(instance, 'botToken');
    if (platform === 'discord') return !!getStringField(instance, 'botToken');
    if (platform === 'popo') return !!(getStringField(instance, 'appKey') && getStringField(instance, 'appSecret') && getStringField(instance, 'aesKey'));
    return false;
  };

  const getDmPolicyLabel = (policy?: string): string => {
    if (policy === 'pairing') return i18nService.t('imDmPolicyPairing');
    if (policy === 'allowlist') return i18nService.t('imDmPolicyAllowlist');
    if (policy === 'disabled') return i18nService.t('imDmPolicyDisabled');
    return i18nService.t('imDmPolicyOpen');
  };

  const addInstanceForPlatform = async (platform: Platform) => {
    const instancesBefore = getInstancesForPlatform(platform);
    const count = instancesBefore.length;
    let instance: IMInstanceConfigCard | null = null;

    if (platform === 'dingtalk') instance = await imService.addDingTalkInstance(`DingTalk Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'feishu') instance = await imService.addFeishuInstance(`Feishu Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'qq') instance = await imService.addQQInstance(`QQ Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'email') instance = await imService.addEmailInstance(`Email ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'nim') instance = await imService.addNimInstance(`NIM Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'wecom') instance = await imService.addWecomInstance(`WeCom Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'telegram') instance = await imService.addTelegramInstance(`Telegram Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'discord') instance = await imService.addDiscordInstance(`Discord Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;
    if (platform === 'popo') instance = await imService.addPopoInstance(`POPO Bot ${count + 1}`) as unknown as IMInstanceConfigCard | null;

    if (instance) {
      setActivePlatform(platform);
      setActiveInstanceForPlatform(platform, instance.instanceId);
      reportIMInstanceChanged(
        platform,
        'added',
        count + 1,
        countEnabledIMInstances(instancesBefore) + (instance.enabled ? 1 : 0),
      );
    }
  };

  const isSameInstanceTarget = (target: IMInstanceTarget | null, platform: Platform, instanceId: string): boolean => (
    target?.platform === platform && target.instanceId === instanceId
  );

  const renameInstanceFromCard = async (platform: Platform, instanceId: string, instanceName: string) => {
    const update = { instanceName } as any;
    let success = false;

    if (platform === 'dingtalk') success = await imService.persistDingTalkInstanceConfig(instanceId, update);
    if (platform === 'feishu') success = await imService.persistFeishuInstanceConfig(instanceId, update);
    if (platform === 'qq') success = await imService.persistQQInstanceConfig(instanceId, update);
    if (platform === 'email') success = await imService.persistEmailInstanceConfig(instanceId, update);
    if (platform === 'nim') success = await imService.persistNimInstanceConfig(instanceId, update);
    if (platform === 'wecom') success = await imService.persistWecomInstanceConfig(instanceId, update);
    if (platform === 'telegram') success = await imService.persistTelegramInstanceConfig(instanceId, update);
    if (platform === 'discord') success = await imService.persistDiscordInstanceConfig(instanceId, update);
    if (platform === 'popo') success = await imService.persistPopoInstanceConfig(instanceId, update);

    return success;
  };

  const deleteInstanceFromCard = async (platform: Platform, instanceId: string) => {
    setInstanceMenuTarget(null);
    if (isSameInstanceTarget(renamingInstance, platform, instanceId)) {
      setRenamingInstance(null);
    }

    const instancesBefore = getInstancesForPlatform(platform);
    const deletedInstance = instancesBefore.find(instance => instance.instanceId === instanceId);
    let success = false;
    if (platform === 'dingtalk') success = await imService.deleteDingTalkInstance(instanceId);
    if (platform === 'feishu') success = await imService.deleteFeishuInstance(instanceId);
    if (platform === 'qq') success = await imService.deleteQQInstance(instanceId);
    if (platform === 'email') success = await imService.deleteEmailInstance(instanceId);
    if (platform === 'nim') success = await imService.deleteNimInstance(instanceId);
    if (platform === 'wecom') success = await imService.deleteWecomInstance(instanceId);
    if (platform === 'telegram') success = await imService.deleteTelegramInstance(instanceId);
    if (platform === 'discord') success = await imService.deleteDiscordInstance(instanceId);
    if (platform === 'popo') success = await imService.deletePopoInstance(instanceId);

    if (success) {
      await imService.loadStatus();
      reportIMInstanceChanged(
        platform,
        'deleted',
        Math.max(0, instancesBefore.length - 1),
        Math.max(0, countEnabledIMInstances(instancesBefore) - (deletedInstance?.enabled ? 1 : 0)),
      );
    }

    return success;
  };

  const confirmDeleteInstanceFromCard = async () => {
    if (!deleteConfirmTarget || isDeletingInstance) return;

    setIsDeletingInstance(true);
    try {
      const deleted = await deleteInstanceFromCard(deleteConfirmTarget.platform, deleteConfirmTarget.instanceId);
      if (deleted) {
        setDeleteConfirmTarget(null);
      }
    } finally {
      setIsDeletingInstance(false);
    }
  };

  const finishRenamingInstanceFromCard = async (platform: Platform, instance: IMInstanceConfigCard) => {
    const currentRenamingInstance = renamingInstance;
    if (!currentRenamingInstance || !isSameInstanceTarget(currentRenamingInstance, platform, instance.instanceId)) return;

    const nextName = currentRenamingInstance.value.trim();
    setRenamingInstance(null);
    if (!nextName || nextName === instance.instanceName) return;

    await renameInstanceFromCard(platform, instance.instanceId, nextName);
  };

  const toggleInstanceFromCard = async (platform: Platform, instance: IMInstanceConfigCard) => {
    const enabled = !instance.enabled;
    if (enabled && !hasInstanceCredentials(platform, instance)) return;

    let success = false;
    const reloadStatusOptions = { reloadStatus: true };
    if (platform === 'dingtalk') success = await imService.updateDingTalkInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'feishu') success = await imService.updateFeishuInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'qq') success = await imService.updateQQInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'email') success = await imService.updateEmailInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'nim') success = await imService.updateNimInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'wecom') success = await imService.updateWecomInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'telegram') success = await imService.updateTelegramInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'discord') success = await imService.updateDiscordInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);
    if (platform === 'popo') success = await imService.updatePopoInstanceConfig(instance.instanceId, { enabled }, reloadStatusOptions);

    if (!success) return;
    if (platform === 'dingtalk') dispatch(setDingTalkInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'feishu') dispatch(setFeishuInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'qq') dispatch(setQQInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'email') dispatch(setEmailInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'nim') dispatch(setNimInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'wecom') dispatch(setWecomInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'telegram') dispatch(setTelegramInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'discord') dispatch(setDiscordInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    if (platform === 'popo') dispatch(setPopoInstanceConfig({ instanceId: instance.instanceId, config: { enabled } }));
    setSaveReminderTarget(platform, instance.instanceId, enabled);
    if (enabled) dispatch(clearError());
    const instancesBefore = getInstancesForPlatform(platform);
    reportIMInstanceChanged(
      platform,
      enabled ? 'enabled' : 'disabled',
      instancesBefore.length,
      Math.max(0, countEnabledIMInstances(instancesBefore) + (enabled ? 1 : -1)),
    );
  };

  const renderInstanceToggle = (platform: Platform, instance: IMInstanceConfigCard, connected: boolean) => {
    const canEnable = instance.enabled || hasInstanceCredentials(platform, instance);
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void toggleInstanceFromCard(platform, instance);
        }}
        disabled={!canEnable}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
          instance.enabled
            ? (connected ? 'bg-green-500' : 'bg-yellow-500')
            : 'bg-gray-300 dark:bg-gray-600'
        } ${canEnable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
        aria-label={instance.enabled ? i18nService.t('stop') : i18nService.t('start')}
      >
        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          instance.enabled ? 'translate-x-4' : 'translate-x-0'
        }`} />
      </button>
    );
  };

  const renderMultiInstanceOverview = (platform: Platform) => {
    const instances = getInstancesForPlatform(platform);
    const instanceStatuses = getStatusesForPlatform(platform);
    const connectedCount = instanceStatuses.filter((item) => item.connected).length;
    const maxInstances = getMaxInstancesForPlatform(platform);
    const canAdd = instances.length < maxInstances;
    const hasInstancesNeedingSave = instances.some((instance) => {
      const instanceStatus = instanceStatuses.find((item) => item.instanceId === instance.instanceId);
      return shouldShowInstanceSaveReminder(platform, instance, instanceStatus);
    });

    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3 border-b border-border-subtle pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-medium leading-5 text-foreground">
                {i18nService.t('imChannelBotsTitle').replace('{platform}', i18nService.t(platform))}
              </h3>
              <p className="mt-0.5 whitespace-nowrap text-xs text-green-600 dark:text-green-400">
                {i18nService.t('imInstanceSummary')
                  .replace('{connected}', String(connectedCount))
                  .replace('{total}', String(instances.length))}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(154px,1fr))] gap-3">
          {instances.map((instance) => {
            const instanceStatus = instanceStatuses.find((item) => item.instanceId === instance.instanceId);
            const connected = !!instanceStatus?.connected;
            const lastError = instanceStatus?.lastError || instanceStatus?.error || null;
            const isMenuOpen = isSameInstanceTarget(instanceMenuTarget, platform, instance.instanceId);
            const isRenaming = isSameInstanceTarget(renamingInstance, platform, instance.instanceId);
            return (
              <div
                key={instance.instanceId}
                role="button"
                tabIndex={0}
                onClick={() => setActiveInstanceForPlatform(platform, instance.instanceId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setActiveInstanceForPlatform(platform, instance.instanceId);
                  }
                }}
                className="group relative flex min-h-[82px] flex-col rounded-lg border border-border-subtle bg-surface p-3 text-left transition-colors hover:border-primary/40 hover:bg-surface-raised"
              >
                {isMenuOpen && (
                  <div
                    className="absolute right-3 top-10 z-20 min-w-[108px] overflow-hidden rounded-lg border border-border-subtle bg-surface py-1 shadow-popover"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setInstanceMenuTarget(null);
                        setActiveInstanceForPlatform(platform, instance.instanceId);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
                    >
                      <ComposeIcon className="h-3.5 w-3.5" />
                      {i18nService.t('edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInstanceMenuTarget(null);
                        setRenamingInstance({ platform, instanceId: instance.instanceId, value: instance.instanceName });
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
                    >
                      <EditIcon className="h-3.5 w-3.5" />
                      {i18nService.t('rename')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInstanceMenuTarget(null);
                        setDeleteConfirmTarget({ platform, instanceId: instance.instanceId });
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                      {i18nService.t('delete')}
                    </button>
                  </div>
                )}
                <div className="flex items-start gap-2.5">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 p-1">
                    <img
                      src={PlatformRegistry.logo(platform)}
                      alt={i18nService.t(platform)}
                      className="h-6 w-6 rounded-md object-contain"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    {isRenaming ? (
                      <input
                        type="text"
                        value={renamingInstance?.value ?? instance.instanceName}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setRenamingInstance((current) => (
                            current && isSameInstanceTarget(current, platform, instance.instanceId)
                              ? { ...current, value: nextValue }
                              : current
                          ));
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setRenamingInstance(null);
                          }
                        }}
                        onBlur={() => void finishRenamingInstanceFromCard(platform, instance)}
                        className="block w-full rounded-md border border-primary/50 bg-surface px-1.5 py-0.5 text-sm font-medium leading-5 text-foreground outline-none"
                        autoFocus
                      />
                    ) : (
                      <div className="truncate text-sm font-medium leading-5 text-foreground">
                        {instance.instanceName}
                      </div>
                    )}
                    <div className={`mt-0.5 flex items-center gap-1 text-xs ${
                      connected ? 'text-green-600 dark:text-green-400' : 'text-secondary'
                    }`}>
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                        connected ? 'bg-green-500' : instance.enabled ? 'bg-yellow-500' : 'bg-gray-400'
                      }`} />
                      <span className="truncate">
                        {connected ? i18nService.t('connected') : i18nService.t('disconnected')}
                      </span>
                    </div>
                    {lastError && (
                      <p className="mt-1 line-clamp-1 text-xs text-red-500">
                        {translateIMError(lastError)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1 pl-1">
                    {renderInstanceToggle(platform, instance, connected)}
                    <button
                      type="button"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        setInstanceMenuTarget(isMenuOpen ? null : { platform, instanceId: instance.instanceId });
                      }}
                      className="rounded-md p-1 text-secondary opacity-70 transition-colors hover:bg-surface-raised hover:text-foreground group-hover:opacity-100"
                      aria-label={i18nService.t('imInstanceActionMenu')}
                      title={i18nService.t('imInstanceActionMenu')}
                    >
                      <EllipsisVerticalIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {canAdd && (
            <button
              type="button"
              onClick={() => void addInstanceForPlatform(platform)}
              className="flex min-h-[82px] flex-col items-center justify-center rounded-lg border border-dashed border-border-subtle bg-surface text-secondary transition-colors hover:border-primary/50 hover:bg-surface-raised hover:text-primary"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-raised">
                <PlusIcon className="h-4 w-4" />
              </span>
              <span className="mt-2 text-sm font-medium">
                {i18nService.t('imAddBot')}
              </span>
            </button>
          )}
        </div>

        {hasInstancesNeedingSave && renderSaveReminder(platform)}
      </div>
    );
  };

  const renderBackToInstanceList = (platform: Platform) => (
    <button
      type="button"
      onClick={() => setActiveInstanceForPlatform(platform, null)}
      className="-ml-1 inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/25"
      aria-label={i18nService.t('imBackToBotList').replace('{platform}', i18nService.t(platform))}
      title={i18nService.t('imBackToBotList').replace('{platform}', i18nService.t(platform))}
    >
      <ArrowLeftIcon className="h-3.5 w-3.5 flex-shrink-0" />
      <span>{i18nService.t('back')}</span>
    </button>
  );

  const deleteConfirmInstance = deleteConfirmTarget
    ? getInstancesForPlatform(deleteConfirmTarget.platform).find((instance) => instance.instanceId === deleteConfirmTarget.instanceId)
    : null;

  return (
    <div className="flex h-full gap-3">
      {/* Platform List - Left Side */}
      <div className="w-44 flex-shrink-0 space-y-1.5 overflow-y-auto border-r border-border pr-3">
        {platforms.map((platform) => {
          const logo = PlatformRegistry.logo(platform);
          const isActive = activePlatform === platform;
          const isEnabled = isPlatformEnabled(platform);
          const statusDotClass = getPlatformStatusDotClass(platform);
          const canToggle = isEnabled || canStart(platform);

          return (
            <button
              type="button"
              key={platform}
              onClick={() => {
                setActivePlatform(platform);
                if (isMultiInstancePlatform(platform)) {
                  setActiveInstanceForPlatform(platform, null);
                }
              }}
              className={`flex w-full items-center rounded-xl border p-2 text-left transition-colors ${
                isActive
                  ? 'border-primary bg-primary-muted shadow-subtle'
                  : 'border-transparent bg-surface hover:bg-surface-raised'
              }`}
            >
              <div className="mr-2 flex h-7 w-7 flex-shrink-0 items-center justify-center">
                <img
                  src={logo}
                  alt={i18nService.t(platform)}
                  className="h-6 w-6 rounded-md object-contain"
                />
              </div>
              <div className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[14px] font-normal leading-5 text-foreground/80">
                    {i18nService.t(platform)}
                  </span>
                  {statusDotClass && (
                    <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusDotClass}`} />
                  )}
                </span>
              </div>
              {!isMultiInstancePlatform(platform) && (
                <span
                  className={`ml-2 flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors ${
                    isEnabled ? getPlatformSwitchColorClass(platform) : 'bg-gray-300 dark:bg-gray-600'
                  } ${(!canToggle || togglingPlatform === platform) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    handlePlatformToggle(platform);
                  }}
                >
                  <span
                    className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                      isEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Platform Settings - Right Side */}
      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pl-3 pr-4 [scrollbar-gutter:stable]">
        {/* Header with status (only for single-instance platforms without per-instance headers) */}
        {(activePlatform === 'weixin' || activePlatform === 'netease-bee') && (
          <div className="flex items-center gap-3 border-b border-border-subtle pb-4">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-foreground">
                {`${i18nService.t(activePlatform)}${i18nService.t('settings')}`}
              </h3>
            </div>
            <div className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${getPlatformStatusColorClass(activePlatform)}`}>
              {(() => {
                const displayState = getPlatformDisplayState(activePlatform);
                return (displayState === IMRuntimeDisplayState.Connecting || displayState === IMRuntimeDisplayState.Starting) ? (
                  <ArrowPathIcon className="h-3 w-3 animate-spin" />
                ) : null;
              })()}
              {getPlatformStatusLabel(activePlatform)}
            </div>
            {activePlatform === 'weixin' && (
              <div className="ml-auto flex items-center gap-2">
                {renderConnectivityTestButton('weixin')}
                <button
                  type="button"
                  onClick={() => void handleWeixinQrLogin()}
                  disabled={weixinQrStatus === 'loading' || weixinQrStatus === 'waiting'}
                  className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {weixinAccountId ? i18nService.t('imRescan') : i18nService.t('imWeixinScanBtn')}
                </button>
              </div>
            )}
          </div>
        )}


        {/* DingTalk Settings (multi-instance) */}
        {activePlatform === 'dingtalk' && !activeDingTalkInstanceId && renderMultiInstanceOverview('dingtalk')}
        {activePlatform === 'dingtalk' && activeDingTalkInstanceId && (() => {
          const selectedInstance = config.dingtalk.instances.find(i => i.instanceId === activeDingTalkInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.dingtalk?.instances?.find(s => s.instanceId === activeDingTalkInstanceId);
          return (
            <div className="space-y-4">
              <DingTalkInstanceSettings
                instance={selectedInstance}
                instanceStatus={selectedStatus}
                headerLeading={renderBackToInstanceList('dingtalk')}
                onConfigChange={(update) => {
                  dispatch(setDingTalkInstanceConfig({ instanceId: activeDingTalkInstanceId, config: update }));
                }}
                onSave={async (override) => {
                  const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                  const restartOnSaveOptions = override?.enabled === true && !!override.clientId && !!override.clientSecret
                    ? IM_AUTH_RESTART_ON_SAVE_OPTIONS
                    : undefined;
                  let success = false;
                  if (selectedInstance.enabled || restartOnSaveOptions) {
                    success = await imService.updateDingTalkInstanceConfig(activeDingTalkInstanceId, configToSave, restartOnSaveOptions);
                  } else {
                    success = await imService.persistDingTalkInstanceConfig(activeDingTalkInstanceId, configToSave);
                  }
                  if (success) reportIMSettingsSaved('dingtalk', config);
                  if (typeof override?.enabled === 'boolean') {
                    setSaveReminderTarget('dingtalk', activeDingTalkInstanceId, override.enabled);
                  }
                }}
                onRename={async (newName) => {
                  dispatch(setDingTalkInstanceConfig({ instanceId: activeDingTalkInstanceId, config: { instanceName: newName } as any }));
                  await imService.persistDingTalkInstanceConfig(activeDingTalkInstanceId, { instanceName: newName } as any);
                }}
                onTestConnectivity={() => {
                  void handleConnectivityTest('dingtalk');
                }}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults}
                language={language}
              />
              {renderInstanceSaveReminder('dingtalk', selectedInstance as unknown as IMInstanceConfigCard, selectedStatus)}
            </div>
          );
        })()}

        {/* Feishu Settings (multi-instance) */}
        {activePlatform === 'feishu' && !activeFeishuInstanceId && renderMultiInstanceOverview('feishu')}
        {activePlatform === 'feishu' && activeFeishuInstanceId && (() => {
          const selectedInstance = config.feishu.instances.find(i => i.instanceId === activeFeishuInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.feishu?.instances?.find(s => s.instanceId === activeFeishuInstanceId);
          return (
            <div className="space-y-4">
              <FeishuInstanceSettings
                instance={selectedInstance}
                instanceStatus={selectedStatus}
                headerLeading={renderBackToInstanceList('feishu')}
                onConfigChange={(update) => {
                  dispatch(setFeishuInstanceConfig({ instanceId: activeFeishuInstanceId, config: update }));
                }}
                onSave={async (override) => {
                  const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                  const restartOnSaveOptions = override?.enabled === true && !!override.appId && !!override.appSecret
                    ? IM_AUTH_RESTART_ON_SAVE_OPTIONS
                    : undefined;
                  let success = false;
                  if (selectedInstance.enabled || restartOnSaveOptions) {
                    success = await imService.updateFeishuInstanceConfig(activeFeishuInstanceId, configToSave, restartOnSaveOptions);
                  } else {
                    success = await imService.persistFeishuInstanceConfig(activeFeishuInstanceId, configToSave);
                  }
                  if (success) reportIMSettingsSaved('feishu', config);
                  if (typeof override?.enabled === 'boolean') {
                    setSaveReminderTarget('feishu', activeFeishuInstanceId, override.enabled);
                  }
                }}
                onRename={async (newName) => {
                  dispatch(setFeishuInstanceConfig({ instanceId: activeFeishuInstanceId, config: { instanceName: newName } as any }));
                  await imService.persistFeishuInstanceConfig(activeFeishuInstanceId, { instanceName: newName } as any);
                }}
                onTestConnectivity={() => {
                  void handleConnectivityTest('feishu');
                }}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults}
                language={language}
              />
              {renderInstanceSaveReminder('feishu', selectedInstance as unknown as IMInstanceConfigCard, selectedStatus)}
            </div>
          );
        })()}

        {/* QQ Settings (multi-instance) */}
        {activePlatform === 'qq' && !activeQQInstanceId && renderMultiInstanceOverview('qq')}
        {activePlatform === 'qq' && activeQQInstanceId && (() => {
          const selectedInstance = config.qq.instances.find(i => i.instanceId === activeQQInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.qq?.instances?.find(s => s.instanceId === activeQQInstanceId);
          return (
            <div className="space-y-4">
              <QQInstanceSettings
                instance={selectedInstance}
                instanceStatus={selectedStatus}
                headerLeading={renderBackToInstanceList('qq')}
                onConfigChange={(update) => {
                  dispatch(setQQInstanceConfig({ instanceId: activeQQInstanceId, config: update }));
                }}
                onSave={async (override) => {
                  const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                  let success = false;
                  if (selectedInstance.enabled) {
                    success = await imService.updateQQInstanceConfig(activeQQInstanceId, configToSave);
                  } else {
                    success = await imService.persistQQInstanceConfig(activeQQInstanceId, configToSave);
                  }
                  if (success) reportIMSettingsSaved('qq', config);
                  if (typeof override?.enabled === 'boolean') {
                    setSaveReminderTarget('qq', activeQQInstanceId, override.enabled);
                  }
                }}
                onRename={async (newName) => {
                  dispatch(setQQInstanceConfig({ instanceId: activeQQInstanceId, config: { instanceName: newName } as any }));
                  await imService.persistQQInstanceConfig(activeQQInstanceId, { instanceName: newName } as any);
                }}
                onTestConnectivity={() => {
                  void handleConnectivityTest('qq');
                }}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults}
              />
              {renderInstanceSaveReminder('qq', selectedInstance as unknown as IMInstanceConfigCard, selectedStatus)}
            </div>
          );
        })()}

        {/* Email Settings (multi-instance, inline form like feishu/qq) */}
        {activePlatform === 'email' && !activeEmailInstanceId && renderMultiInstanceOverview('email')}
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
                  {renderBackToInstanceList('email')}
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
                        setSaveReminderTarget('email', inst.instanceId, false);
                        reportIMInstanceChanged(
                          'email',
                          'disabled',
                          config.email.instances.length,
                          Math.max(0, countEnabledIMInstances(config.email.instances as unknown as IMInstanceConfigCard[]) - 1),
                        );
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
                      reportIMConnectionTested('email', result);
                      if (result && result.verdict !== 'fail') {
                        const success = await imService.updateEmailInstanceConfig(inst.instanceId, { enabled: true });
                        if (success) {
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { enabled: true } }));
                          setSaveReminderTarget('email', inst.instanceId, true);
                          dispatch(clearError());
                          reportIMInstanceChanged(
                            'email',
                            'enabled',
                            config.email.instances.length,
                            countEnabledIMInstances(config.email.instances as unknown as IMInstanceConfigCard[]) + 1,
                          );
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
                    const success = await imService.deleteEmailInstance(inst.instanceId);
                    if (success) {
                      const remaining = config.email.instances.filter(i => i.instanceId !== inst.instanceId);
                      setActiveEmailInstanceId(remaining.length > 0 ? remaining[0].instanceId : null);
                      reportIMInstanceChanged(
                        'email',
                        'deleted',
                        remaining.length,
                        countEnabledIMInstances(remaining as unknown as IMInstanceConfigCard[]),
                      );
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex-shrink-0"
                  title={i18nService.t('delete') || 'Delete'}
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('delete')}
                </button>
              </div>

              {renderInstanceSaveReminder('email', inst as unknown as IMInstanceConfigCard, instStatus)}

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
        {activePlatform === 'telegram' && !activeTelegramInstanceId && renderMultiInstanceOverview('telegram')}
        {activePlatform === 'telegram' && activeTelegramInstanceId && (() => {
          const selectedInstance = config.telegram.instances.find(i => i.instanceId === activeTelegramInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.telegram?.instances?.find(s => s.instanceId === activeTelegramInstanceId);
          return (
            <div className="space-y-4">
              <TelegramInstanceSettings
                instance={selectedInstance}
                instanceStatus={selectedStatus}
                headerLeading={renderBackToInstanceList('telegram')}
                onConfigChange={(update) => {
                  dispatch(setTelegramInstanceConfig({ instanceId: activeTelegramInstanceId, config: update }));
                }}
                onSave={async (override) => {
                  const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                  let success = false;
                  if (selectedInstance.enabled) {
                    success = await imService.updateTelegramInstanceConfig(activeTelegramInstanceId, configToSave);
                  } else {
                    success = await imService.persistTelegramInstanceConfig(activeTelegramInstanceId, configToSave);
                  }
                  if (success) reportIMSettingsSaved('telegram', config);
                  if (typeof override?.enabled === 'boolean') {
                    setSaveReminderTarget('telegram', activeTelegramInstanceId, override.enabled);
                  }
                }}
                onRename={async (newName) => {
                  dispatch(setTelegramInstanceConfig({ instanceId: activeTelegramInstanceId, config: { instanceName: newName } as any }));
                  await imService.persistTelegramInstanceConfig(activeTelegramInstanceId, { instanceName: newName } as any);
                }}
                onTestConnectivity={() => {
                  void handleConnectivityTest('telegram');
                }}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults}
                language={language}
              />
              {renderInstanceSaveReminder('telegram', selectedInstance as unknown as IMInstanceConfigCard, selectedStatus)}
            </div>
          );
        })()}

        {/* Discord Settings */}
        {activePlatform === 'discord' && !activeDiscordInstanceId && renderMultiInstanceOverview('discord')}
        {activePlatform === 'discord' && activeDiscordInstanceId && (() => {
          const selectedInstance = config.discord.instances.find(i => i.instanceId === activeDiscordInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.discord?.instances?.find(s => s.instanceId === activeDiscordInstanceId);
          return (
            <div className="space-y-4">
              <DiscordInstanceSettings
                instance={selectedInstance}
                instanceStatus={selectedStatus}
                headerLeading={renderBackToInstanceList('discord')}
                onConfigChange={(update) => {
                  dispatch(setDiscordInstanceConfig({ instanceId: activeDiscordInstanceId, config: update }));
                }}
                onSave={async (override) => {
                  const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                  let success = false;
                  if (selectedInstance.enabled) {
                    success = await imService.updateDiscordInstanceConfig(activeDiscordInstanceId, configToSave);
                  } else {
                    success = await imService.persistDiscordInstanceConfig(activeDiscordInstanceId, configToSave);
                  }
                  if (success) reportIMSettingsSaved('discord', config);
                  if (typeof override?.enabled === 'boolean') {
                    setSaveReminderTarget('discord', activeDiscordInstanceId, override.enabled);
                  }
                }}
                onRename={async (newName) => {
                  dispatch(setDiscordInstanceConfig({ instanceId: activeDiscordInstanceId, config: { instanceName: newName } as any }));
                  await imService.persistDiscordInstanceConfig(activeDiscordInstanceId, { instanceName: newName } as any);
                }}
                onTestConnectivity={() => {
                  void handleConnectivityTest('discord');
                }}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults}
                language={language}
              />
              {renderInstanceSaveReminder('discord', selectedInstance as unknown as IMInstanceConfigCard, selectedStatus)}
            </div>
          );
        })()}

        {/* NIM (NetEase IM) Settings */}
        {activePlatform === 'nim' && !activeNimInstanceId && renderMultiInstanceOverview('nim')}
        {activePlatform === 'nim' && activeNimInstanceId && (() => {
          const selectedInstance = config.nim.instances.find(i => i.instanceId === activeNimInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.nim?.instances?.find(s => s.instanceId === activeNimInstanceId);
          return (
            <div className="space-y-4">
              <NimInstanceSettings
                instance={selectedInstance}
                instanceStatus={selectedStatus}
                schemaData={nimSchemaData}
                headerLeading={renderBackToInstanceList('nim')}
                onConfigChange={(update) => {
                  dispatch(setNimInstanceConfig({ instanceId: activeNimInstanceId, config: update }));
                }}
                onSave={async (override) => {
                  const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                  const restartOnSaveOptions = override?.enabled === true
                    && (!!override.nimToken || !!(override.appKey && override.account && override.token))
                    ? IM_AUTH_RESTART_ON_SAVE_OPTIONS
                    : undefined;
                  let success = false;
                  if (selectedInstance.enabled || restartOnSaveOptions) {
                    success = await imService.updateNimInstanceConfig(activeNimInstanceId, configToSave, restartOnSaveOptions);
                  } else {
                    success = await imService.persistNimInstanceConfig(activeNimInstanceId, configToSave);
                  }
                  if (success) reportIMSettingsSaved('nim', config);
                  if (typeof override?.enabled === 'boolean') {
                    setSaveReminderTarget('nim', activeNimInstanceId, override.enabled);
                  }
                }}
                onRename={async (newName) => {
                  dispatch(setNimInstanceConfig({ instanceId: activeNimInstanceId, config: { instanceName: newName } as any }));
                  await imService.persistNimInstanceConfig(activeNimInstanceId, { instanceName: newName } as any);
                }}
                onTestConnectivity={() => {
                  void handleConnectivityTest('nim');
                }}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults}
              />
              {renderInstanceSaveReminder('nim', selectedInstance as unknown as IMInstanceConfigCard, selectedStatus)}
            </div>
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

            {renderPlatformRuntimeNotice('netease-bee')}

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
            {(!weixinAccountId || (weixinQrStatus !== 'idle' && weixinQrStatus !== 'success')) && (
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
            )}

            {weixinAccountId && (
              <div className="rounded-xl border border-border-subtle bg-surface p-3 shadow-subtle">
                <div className="space-y-4">
                  <section>
                    <h4 className="mb-2 text-xs font-medium text-secondary">
                      {i18nService.t('imAccountSection')}
                    </h4>
                    <div className="flex min-h-[42px] items-center rounded-lg border border-border-subtle bg-surface px-3">
                      <span className="text-xs font-medium text-foreground">
                        {i18nService.t('imAccountIdLabel')}
                      </span>
                      <span className="ml-auto min-w-0 truncate pl-4 text-xs font-medium text-secondary select-text" title={weixinAccountId}>
                        {weixinAccountId}
                      </span>
                    </div>
                  </section>

                  <section>
                    <h4 className="mb-2 text-xs font-medium text-secondary">
                      {i18nService.t('imReceivePermission')}
                    </h4>
                    <div className="relative" ref={weixinDmPolicyMenuRef}>
                      <button
                        type="button"
                        onClick={() => setIsWeixinDmPolicyMenuOpen((open) => !open)}
                        className={`flex min-h-[42px] w-full items-center rounded-lg border px-3 text-left transition-colors ${
                          isWeixinDmPolicyMenuOpen
                            ? 'border-primary bg-surface-raised shadow-subtle'
                            : 'border-border-subtle bg-surface hover:border-border hover:bg-surface-raised'
                        }`}
                        aria-haspopup="listbox"
                        aria-expanded={isWeixinDmPolicyMenuOpen}
                      >
                        <span className="text-xs font-medium text-foreground">
                          {i18nService.t('imDmPolicyLabel')}
                        </span>
                        <span className="ml-auto text-xs font-medium text-foreground">
                          {getDmPolicyLabel(weixinOpenClawConfig.dmPolicy)}
                        </span>
                        <ChevronDownIcon className={`ml-2 h-3.5 w-3.5 flex-shrink-0 text-secondary transition-transform ${isWeixinDmPolicyMenuOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {isWeixinDmPolicyMenuOpen && (
                        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-surface shadow-popover popover-enter">
                          <div
                            className="py-1"
                            role="listbox"
                            aria-label={i18nService.t('imDmPolicyLabel')}
                          >
                            {weixinDmPolicyOptions.map((option) => {
                              const selected = option.value === weixinOpenClawConfig.dmPolicy;
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  onClick={() => updateWeixinDmPolicy(option.value)}
                                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                                    selected
                                      ? 'bg-primary/10 text-primary'
                                      : 'text-foreground hover:bg-surface-raised'
                                  }`}
                                >
                                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                  {selected && <CheckIcon className="h-3.5 w-3.5 flex-shrink-0" />}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>

                  <details className="group">
                    <summary className="flex min-h-[42px] cursor-pointer list-none items-center rounded-lg border border-border-subtle bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:border-border hover:bg-surface-raised [&::-webkit-details-marker]:hidden">
                      {i18nService.t('imAdvancedSettings')}
                      <ChevronRightIcon className="ml-auto h-3.5 w-3.5 text-secondary transition-transform group-open:rotate-90" />
                    </summary>
                    <div className="mt-3 rounded-lg border border-border-subtle bg-surface p-3">
                      <label className="block text-xs font-medium text-secondary">
                        {i18nService.t('imAllowFromLabel')}
                      </label>
                      <div className="mt-2 flex gap-2">
                        <input
                          type="text"
                          value={weixinAllowFromInput}
                          onChange={(e) => setWeixinAllowFromInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const id = weixinAllowFromInput.trim();
                              if (id && !weixinOpenClawConfig.allowFrom.includes(id)) {
                                const newIds = [...weixinOpenClawConfig.allowFrom, id];
                                setWeixinAllowFromInput('');
                                void imService.updateConfig({ weixin: { ...weixinOpenClawConfig, allowFrom: newIds } });
                              }
                            }
                          }}
                          className="block flex-1 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-foreground transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30"
                          placeholder={i18nService.t('imAllowFromPlaceholder')}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const id = weixinAllowFromInput.trim();
                            if (id && !weixinOpenClawConfig.allowFrom.includes(id)) {
                              const newIds = [...weixinOpenClawConfig.allowFrom, id];
                              setWeixinAllowFromInput('');
                              void imService.updateConfig({ weixin: { ...weixinOpenClawConfig, allowFrom: newIds } });
                            }
                          }}
                          className="rounded-md bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                        >
                          {i18nService.t('add')}
                        </button>
                      </div>
                      {weixinOpenClawConfig.allowFrom.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {weixinOpenClawConfig.allowFrom.map((id) => (
                            <span
                              key={id}
                              className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface px-2 py-0.5 text-xs text-foreground"
                            >
                              {id}
                              <button
                                type="button"
                                onClick={() => {
                                  const newIds = weixinOpenClawConfig.allowFrom.filter((uid) => uid !== id);
                                  void imService.updateConfig({ weixin: { ...weixinOpenClawConfig, allowFrom: newIds } });
                                }}
                                className="text-secondary transition-colors hover:text-red-500 dark:hover:text-red-400"
                                aria-label={i18nService.t('delete')}
                              >
                                <XMarkIcon className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            )}

            {renderPlatformRuntimeNotice('weixin')}

            {/* Error display */}
            {shouldShowWeixinError && weixinLastError && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
                {isWeixinCredentialMissingError
                  ? i18nService.t('imWeixinCredentialsMissing')
                  : translateIMError(weixinLastError)}
              </div>
            )}

            {/* Platform Guide */}
            {!weixinAccountId && (
              <PlatformGuide
                steps={[
                  i18nService.t('imWeixinGuideStep1'),
                  i18nService.t('imWeixinGuideStep2'),
                  i18nService.t('imWeixinGuideStep3'),
                ]}
                guideUrl={PlatformRegistry.guideUrl('weixin')}
              />
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
              <div className="space-y-4">
                <WecomInstanceSettings
                  instance={activeWecomInstance}
                  instanceStatus={activeWecomStatus}
                  headerLeading={renderBackToInstanceList('wecom')}
                  onConfigChange={(update) => {
                    dispatch(setWecomInstanceConfig({ instanceId: activeWecomInstanceId!, config: update }));
                  }}
                  onSave={async (override) => {
                    if (!configLoaded) return;
                    const configToSave = override
                      ? { ...activeWecomInstance, ...override }
                      : activeWecomInstance;
                    const success = await imService.persistWecomInstanceConfig(activeWecomInstanceId!, configToSave);
                    if (success) reportIMSettingsSaved('wecom', config);
                    if (typeof override?.enabled === 'boolean') {
                      setSaveReminderTarget('wecom', activeWecomInstanceId!, override.enabled);
                    }
                  }}
                  onRename={async (newName) => {
                    dispatch(setWecomInstanceConfig({ instanceId: activeWecomInstanceId!, config: { instanceName: newName } as any }));
                    await imService.persistWecomInstanceConfig(activeWecomInstanceId!, { instanceName: newName } as any);
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
                      const quickSetupSaved = await imService.updateWecomInstanceConfig(
                        activeWecomInstanceId!,
                        { botId: bot.botid, secret: bot.secret, enabled: true },
                        IM_AUTH_RESTART_ON_SAVE_OPTIONS,
                      );
                      if (quickSetupSaved) {
                        reportIMSettingsSaved('wecom', config, null, 'credential_state,enabled');
                      }
                      setSaveReminderTarget('wecom', activeWecomInstanceId!, true);
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
                {renderInstanceSaveReminder('wecom', activeWecomInstance as unknown as IMInstanceConfigCard, activeWecomStatus)}
              </div>
            );
          }

          return renderMultiInstanceOverview('wecom');
        })()}

        {activePlatform === 'popo' && !activePopoInstanceId && renderMultiInstanceOverview('popo')}
        {activePlatform === 'popo' && activePopoInstanceId && (() => {
          const selectedInstance = config.popo.instances.find(i => i.instanceId === activePopoInstanceId);
          if (!selectedInstance) return null;
          const selectedStatus = status.popo?.instances?.find(s => s.instanceId === activePopoInstanceId);
          return (
            <div className="space-y-4">
              <PopoInstanceSettings
                instance={selectedInstance}
                instanceStatus={selectedStatus}
                headerLeading={renderBackToInstanceList('popo')}
                onConfigChange={(update) => {
                  dispatch(setPopoInstanceConfig({ instanceId: activePopoInstanceId, config: update }));
                }}
                onSave={async (override) => {
                  const configToSave = override ? { ...selectedInstance, ...override } : selectedInstance;
                  const restartOnSaveOptions = override?.enabled === true
                    && !!override.appKey
                    && !!override.appSecret
                    && !!override.aesKey
                    ? IM_AUTH_RESTART_ON_SAVE_OPTIONS
                    : undefined;
                  let success = false;
                  if (selectedInstance.enabled || restartOnSaveOptions) {
                    success = await imService.updatePopoInstanceConfig(activePopoInstanceId, configToSave, restartOnSaveOptions);
                  } else {
                    success = await imService.persistPopoInstanceConfig(activePopoInstanceId, configToSave);
                  }
                  if (success) reportIMSettingsSaved('popo', config);
                  if (typeof override?.enabled === 'boolean') {
                    setSaveReminderTarget('popo', activePopoInstanceId, override.enabled);
                  }
                }}
                onRename={async (newName) => {
                  dispatch(setPopoInstanceConfig({ instanceId: activePopoInstanceId, config: { instanceName: newName } as any }));
                  await imService.persistPopoInstanceConfig(activePopoInstanceId, { instanceName: newName } as any);
                }}
                onTestConnectivity={() => {
                  void handleConnectivityTest('popo');
                }}
                testingPlatform={testingPlatform}
                connectivityResults={connectivityResults}
                language={language}
              />
              {renderInstanceSaveReminder('popo', selectedInstance as unknown as IMInstanceConfigCard, selectedStatus)}
            </div>
          );
        })()}

        {deleteConfirmTarget && deleteConfirmInstance && (
          <Modal
            onClose={() => {
              if (!isDeletingInstance) setDeleteConfirmTarget(null);
            }}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('imDeleteBotConfirmTitle')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('imDeleteBotConfirmMessage')
                .replace('{platform}', i18nService.t(deleteConfirmTarget.platform))
                .replace('{name}', deleteConfirmInstance.instanceName)}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmTarget(null)}
                disabled={isDeletingInstance}
                className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteInstanceFromCard()}
                disabled={isDeletingInstance}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('confirmDelete')}
              </button>
            </div>
          </Modal>
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
