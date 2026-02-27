import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { configService } from '../services/config';
import { apiService } from '../services/api';
import { themeService } from '../services/theme';
import { i18nService, LanguageType } from '../services/i18n';
import { decryptSecret, encryptWithPassword, decryptWithPassword, EncryptedPayload, PasswordEncryptedPayload } from '../services/encryption';
import { coworkService } from '../services/cowork';
import { imService } from '../services/im';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import ErrorMessage from './ErrorMessage';
import { XMarkIcon, Cog6ToothIcon, PlusCircleIcon, TrashIcon, PencilIcon, SignalIcon, CheckCircleIcon, XCircleIcon, CubeIcon, ChatBubbleLeftIcon, ShieldCheckIcon, EnvelopeIcon } from '@heroicons/react/24/outline';
import BrainIcon from './icons/BrainIcon';
import { useDispatch, useSelector } from 'react-redux';
import { setAvailableModels } from '../store/slices/modelSlice';
import { RootState } from '../store';
import ThemedSelect from './ui/ThemedSelect';
import type {
  CoworkExecutionMode,
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
  CoworkSandboxProgress,
  CoworkSandboxStatus,
} from '../types/cowork';
import IMSettings from './im/IMSettings';
import EmailSkillConfig from './skills/EmailSkillConfig';
import { defaultConfig, type AppConfig, getVisibleProviders } from '../config';
import {
  OpenAIIcon,
  DeepSeekIcon,
  GeminiIcon,
  AnthropicIcon,
  MoonshotIcon,
  ZhipuIcon,
  MiniMaxIcon,
  QwenIcon,
  XiaomiIcon,
  VolcengineIcon,
  OpenRouterIcon,
  OllamaIcon,
  CustomProviderIcon,
} from './icons/providers';

type TabType = 'general' | 'model' | 'coworkSandbox' | 'coworkMemory' | 'shortcuts' | 'im' | 'email';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
}

const providerKeys = [
  'openai',
  'gemini',
  'anthropic',
  'deepseek',
  'moonshot',
  'zhipu',
  'minimax',
  'qwen',
  'xiaomi',
  'volcengine',
  'openrouter',
  'ollama',
  'custom',
] as const;

type ProviderType = (typeof providerKeys)[number];
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type Model = NonNullable<ProviderConfig['models']>[number];
type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
};

interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: 2;
  exportedAt: string;
  encryption: {
    algorithm: 'AES-GCM';
    keySource: 'password';
    keyDerivation: 'PBKDF2';
  };
  providers: Record<string, ProviderExportEntry>;
}

interface ProvidersImportEntry {
  enabled?: boolean;
  apiKey?: EncryptedPayload | PasswordEncryptedPayload | string;
  apiKeyEncrypted?: string;
  apiKeyIv?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersImportPayload {
  type?: string;
  version?: number;
  encryption?: {
    algorithm?: string;
    keySource?: string;
    keyDerivation?: string;
  };
  providers?: Record<string, ProvidersImportEntry>;
}

const providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }> = {
  openai: { label: 'OpenAI', icon: <OpenAIIcon /> },
  deepseek: { label: 'DeepSeek', icon: <DeepSeekIcon /> },
  gemini: { label: 'Gemini', icon: <GeminiIcon /> },
  anthropic: { label: 'Anthropic', icon: <AnthropicIcon /> },
  moonshot: { label: 'Moonshot', icon: <MoonshotIcon /> },
  zhipu: { label: 'Zhipu', icon: <ZhipuIcon /> },
  minimax: { label: 'MiniMax', icon: <MiniMaxIcon /> },
  qwen: { label: 'Qwen', icon: <QwenIcon /> },
  xiaomi: { label: 'Xiaomi', icon: <XiaomiIcon /> },
  volcengine: { label: 'Volcengine', icon: <VolcengineIcon /> },
  openrouter: { label: 'OpenRouter', icon: <OpenRouterIcon /> },
  ollama: { label: 'Ollama', icon: <OllamaIcon /> },
  custom: { label: 'Custom', icon: <CustomProviderIcon /> },
};

const providerSwitchableDefaultBaseUrls: Partial<Record<ProviderType, { anthropic: string; openai: string }>> = {
  deepseek: {
    anthropic: 'https://api.deepseek.com/anthropic',
    openai: 'https://api.deepseek.com',
  },
  moonshot: {
    anthropic: 'https://api.moonshot.cn/anthropic',
    openai: 'https://api.moonshot.cn/v1',
  },
  zhipu: {
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
    openai: 'https://open.bigmodel.cn/api/paas/v4',
  },
  minimax: {
    anthropic: 'https://api.minimaxi.com/anthropic',
    openai: 'https://api.minimaxi.com/v1',
  },
  qwen: {
    anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  xiaomi: {
    anthropic: 'https://api.xiaomimimo.com/anthropic',
    openai: 'https://api.xiaomimimo.com/v1/chat/completions',
  },
  volcengine: {
    anthropic: 'https://ark.cn-beijing.volces.com/api/compatible',
    openai: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  openrouter: {
    anthropic: 'https://openrouter.ai/api',
    openai: 'https://openrouter.ai/api/v1',
  },
  ollama: {
    anthropic: 'http://localhost:11434',
    openai: 'http://localhost:11434/v1',
  },
  custom: {
    anthropic: '',
    openai: '',
  },
};

const providerRequiresApiKey = (provider: ProviderType) => provider !== 'ollama';
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '').toLowerCase();
const normalizeApiFormat = (value: unknown): 'anthropic' | 'openai' => (
  value === 'openai' ? 'openai' : 'anthropic'
);
const getFixedApiFormatForProvider = (provider: string): 'anthropic' | 'openai' | null => {
  if (provider === 'openai' || provider === 'gemini') {
    return 'openai';
  }
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  return null;
};
const getEffectiveApiFormat = (provider: string, value: unknown): 'anthropic' | 'openai' => (
  getFixedApiFormatForProvider(provider) ?? normalizeApiFormat(value)
);
const shouldShowApiFormatSelector = (provider: string): boolean => (
  getFixedApiFormatForProvider(provider) === null
);
const getProviderDefaultBaseUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai'
): string | null => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  return defaults ? defaults[apiFormat] : null;
};
const shouldAutoSwitchProviderBaseUrl = (provider: ProviderType, currentBaseUrl: string): boolean => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  if (!defaults) {
    return false;
  }

  const normalizedCurrent = normalizeBaseUrl(currentBaseUrl);
  return (
    normalizedCurrent === normalizeBaseUrl(defaults.anthropic)
    || normalizedCurrent === normalizeBaseUrl(defaults.openai)
  );
};
const buildOpenAICompatibleChatCompletionsUrl = (baseUrl: string, provider: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }

  const isGeminiLike = provider === 'gemini' || normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1')
        ? `${normalized.slice(0, -3)}v1beta`
        : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  // Handle /v1, /v4 etc. versioned paths
  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};
const buildOpenAIResponsesUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/responses';
  }
  if (normalized.endsWith('/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/v1/responses`;
};
const shouldUseOpenAIResponsesForProvider = (provider: string): boolean => (
  provider === 'openai'
);
const shouldUseMaxCompletionTokensForOpenAI = (provider: string, modelId?: string): boolean => {
  if (provider !== 'openai') {
    return false;
  }
  const normalizedModel = (modelId ?? '').toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return resolvedModel.startsWith('gpt-5')
    || resolvedModel.startsWith('o1')
    || resolvedModel.startsWith('o3')
    || resolvedModel.startsWith('o4');
};
const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ])
  ) as ProvidersConfig;
};

const getDefaultActiveProvider = (): ProviderType => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = providerKeys.find(providerKey => providers[providerKey]?.enabled);
  return firstEnabledProvider ?? providerKeys[0];
};

const Settings: React.FC<SettingsProps> = ({ onClose, initialTab, notice }) => {
  const dispatch = useDispatch();
  // 状态
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'general');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [language, setLanguage] = useState<LanguageType>('zh');
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [useSystemProxy, setUseSystemProxy] = useState(false);
  const [isUpdatingAutoLaunch, setIsUpdatingAutoLaunch] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(notice ?? null);
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | null>(null);
  const [isTestResultModalOpen, setIsTestResultModalOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isImportingProviders, setIsImportingProviders] = useState(false);
  const [isExportingProviders, setIsExportingProviders] = useState(false);
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const didSaveRef = useRef(false);

  // Add state for active provider
  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());

  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());
  
  // 创建引用来确保内容区域的滚动
  const contentRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  
  // 快捷键设置
  const [shortcuts, setShortcuts] = useState({
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  });

  // State for model editing
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newModelSupportsImage, setNewModelSupportsImage] = useState(false);
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  const coworkConfig = useSelector((state: RootState) => state.cowork.config);
  const imConfig = useSelector((state: RootState) => state.im.config);

  const [coworkExecutionMode, setCoworkExecutionMode] = useState<CoworkExecutionMode>(coworkConfig.executionMode || 'local');
  const [coworkMemoryEnabled, setCoworkMemoryEnabled] = useState<boolean>(coworkConfig.memoryEnabled ?? true);
  const [coworkMemoryLlmJudgeEnabled, setCoworkMemoryLlmJudgeEnabled] = useState<boolean>(coworkConfig.memoryLlmJudgeEnabled ?? false);
  const [coworkMemoryEntries, setCoworkMemoryEntries] = useState<CoworkUserMemoryEntry[]>([]);
  const [coworkMemoryStats, setCoworkMemoryStats] = useState<CoworkMemoryStats | null>(null);
  const [coworkMemoryListLoading, setCoworkMemoryListLoading] = useState<boolean>(false);
  const [coworkMemoryQuery, setCoworkMemoryQuery] = useState<string>('');
  const [coworkMemoryEditingId, setCoworkMemoryEditingId] = useState<string | null>(null);
  const [coworkMemoryDraftText, setCoworkMemoryDraftText] = useState<string>('');
  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [coworkSandboxStatus, setCoworkSandboxStatus] = useState<CoworkSandboxStatus | null>(null);
  const [coworkSandboxLoading, setCoworkSandboxLoading] = useState(true);
  const [coworkSandboxProgress, setCoworkSandboxProgress] = useState<CoworkSandboxProgress | null>(null);
  const [coworkSandboxInstalling, setCoworkSandboxInstalling] = useState(false);

  useEffect(() => {
    setCoworkExecutionMode(coworkConfig.executionMode || 'local');
    setCoworkMemoryEnabled(coworkConfig.memoryEnabled ?? true);
    setCoworkMemoryLlmJudgeEnabled(coworkConfig.memoryLlmJudgeEnabled ?? false);
  }, [
    coworkConfig.executionMode,
    coworkConfig.memoryEnabled,
    coworkConfig.memoryLlmJudgeEnabled,
  ]);

  const loadCoworkSandboxStatus = useCallback(async () => {
    setCoworkSandboxLoading(true);
    try {
      const status = await coworkService.getSandboxStatus();
      setCoworkSandboxStatus(status);
      if (status?.progress) {
        setCoworkSandboxProgress(status.progress);
      }
    } catch (loadError) {
      console.error('Failed to load cowork sandbox status:', loadError);
      setCoworkSandboxStatus(null);
    } finally {
      setCoworkSandboxLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCoworkSandboxStatus();
  }, [loadCoworkSandboxStatus]);

  useEffect(() => {
    const unsubscribe = coworkService.onSandboxDownloadProgress((progress) => {
      setCoworkSandboxProgress(progress);
      if (progress.percent !== undefined && progress.percent >= 1) {
        void loadCoworkSandboxStatus();
      }
    });
    return () => unsubscribe();
  }, [loadCoworkSandboxStatus]);

  useEffect(() => {
    try {
      const config = configService.getConfig();
      
      // Set general settings
      initialThemeRef.current = config.theme;
      initialLanguageRef.current = config.language;
      setTheme(config.theme);
      setLanguage(config.language);
      setUseSystemProxy(config.useSystemProxy ?? false);

      // Load auto-launch setting
      window.electron.autoLaunch.get().then(({ enabled }) => {
        setAutoLaunchState(enabled);
      }).catch(err => {
        console.error('Failed to load auto-launch setting:', err);
      });
      
      // Set up providers based on saved config
      if (config.api) {
        // For backward compatibility with older config
        // Initialize active provider based on baseUrl
        const normalizedApiBaseUrl = config.api.baseUrl.toLowerCase();
        if (normalizedApiBaseUrl.includes('openai')) {
          setActiveProvider('openai');
          setProviders(prev => ({
            ...prev,
            openai: {
              ...prev.openai,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('deepseek')) {
          setActiveProvider('deepseek');
          setProviders(prev => ({
            ...prev,
            deepseek: {
              ...prev.deepseek,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('moonshot.ai') || normalizedApiBaseUrl.includes('moonshot.cn')) {
          setActiveProvider('moonshot');
          setProviders(prev => ({
            ...prev,
            moonshot: {
              ...prev.moonshot,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('bigmodel.cn')) {
          setActiveProvider('zhipu');
          setProviders(prev => ({
            ...prev,
            zhipu: {
              ...prev.zhipu,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('minimax')) {
          setActiveProvider('minimax');
          setProviders(prev => ({
            ...prev,
            minimax: {
              ...prev.minimax,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('dashscope')) {
          setActiveProvider('qwen');
          setProviders(prev => ({
            ...prev,
            qwen: {
              ...prev.qwen,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('openrouter.ai')) {
          setActiveProvider('openrouter');
          setProviders(prev => ({
            ...prev,
            openrouter: {
              ...prev.openrouter,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('googleapis')) {
          setActiveProvider('gemini');
          setProviders(prev => ({
            ...prev,
            gemini: {
              ...prev.gemini,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('anthropic')) {
          setActiveProvider('anthropic');
          setProviders(prev => ({
            ...prev,
            anthropic: {
              ...prev.anthropic,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('ollama') || normalizedApiBaseUrl.includes('11434')) {
          setActiveProvider('ollama');
          setProviders(prev => ({
            ...prev,
            ollama: {
              ...prev.ollama,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        }
      }
      
      // Load provider-specific configurations if available
      // 合并已保存的配置和默认配置，确保新添加的 provider 能被显示
      if (config.providers) {
        setProviders(prev => {
          const merged = {
            ...prev,  // 保留默认的 providers（包括新添加的 anthropic）
            ...config.providers,  // 覆盖已保存的配置
          };
          return Object.fromEntries(
            Object.entries(merged).map(([providerKey, providerConfig]) => {
              const models = providerConfig.models?.map(model => ({
                ...model,
                supportsImage: model.supportsImage ?? false,
              }));
              return [
                providerKey,
                {
                  ...providerConfig,
                  apiFormat: getEffectiveApiFormat(providerKey, (providerConfig as ProviderConfig).apiFormat),
                  models,
                },
              ];
            })
          ) as ProvidersConfig;
        });
      }
      
      // 加载快捷键设置
      if (config.shortcuts) {
        setShortcuts(prev => ({
          ...prev,
          ...config.shortcuts,
        }));
      }
    } catch (error) {
      setError('Failed to load settings');
    }
  }, []);

  useEffect(() => {
    return () => {
      if (didSaveRef.current) {
        return;
      }
      themeService.setTheme(initialThemeRef.current);
      i18nService.setLanguage(initialLanguageRef.current, { persist: false });
    };
  }, []);

  // 监听标签页切换，确保内容区域滚动到顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  useEffect(() => {
    setNoticeMessage(notice ?? null);
  }, [notice]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // Compute visible providers based on language
  const visibleProviders = useMemo(() => {
    const visibleKeys = getVisibleProviders(language);
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of visibleKeys) {
      if (providers[key as keyof ProvidersConfig]) {
        filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
      }
    }
    return filtered as ProvidersConfig;
  }, [language, providers]);

  // Ensure activeProvider is always in visibleProviders when language changes
  useEffect(() => {
    const visibleKeys = Object.keys(visibleProviders) as ProviderType[];
    if (visibleKeys.length > 0 && !visibleKeys.includes(activeProvider)) {
      // If current activeProvider is not visible, switch to first visible provider
      const firstEnabledVisible = visibleKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider(firstEnabledVisible ?? visibleKeys[0]);
    }
  }, [visibleProviders, activeProvider]);

  // Handle provider change
  const handleProviderChange = (provider: ProviderType) => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
    setActiveProvider(provider);
    // 切换 provider 时清除测试结果
    setIsTestResultModalOpen(false);
    setTestResult(null);
  };

  // Handle provider configuration change
  const handleProviderConfigChange = (provider: ProviderType, field: string, value: string) => {
    setProviders(prev => {
      if (field === 'apiFormat') {
        const nextApiFormat = getEffectiveApiFormat(provider, value);
        const nextProviderConfig: ProviderConfig = {
          ...prev[provider],
          apiFormat: nextApiFormat,
        };

        // Only auto-switch URL when current value is still a known default URL.
        if (shouldAutoSwitchProviderBaseUrl(provider, prev[provider].baseUrl)) {
          const defaultBaseUrl = getProviderDefaultBaseUrl(provider, nextApiFormat);
          if (defaultBaseUrl) {
            nextProviderConfig.baseUrl = defaultBaseUrl;
          }
        }

        return {
          ...prev,
          [provider]: nextProviderConfig,
        };
      }

      // Handle codingPlanEnabled toggle for zhipu
      if (field === 'codingPlanEnabled' && provider === 'zhipu') {
        const codingPlanEnabled = value === 'true';
        return {
          ...prev,
          zhipu: {
            ...prev.zhipu,
            codingPlanEnabled,
          },
        };
      }

      // Handle codingPlanEnabled toggle for qwen
      if (field === 'codingPlanEnabled' && provider === 'qwen') {
        const codingPlanEnabled = value === 'true';
        return {
          ...prev,
          qwen: {
            ...prev.qwen,
            codingPlanEnabled,
          },
        };
      }

      // Handle codingPlanEnabled toggle for volcengine
      if (field === 'codingPlanEnabled' && provider === 'volcengine') {
        const codingPlanEnabled = value === 'true';
        return {
          ...prev,
          volcengine: {
            ...prev.volcengine,
            codingPlanEnabled,
          },
        };
      }

      // Handle codingPlanEnabled toggle for moonshot
      if (field === 'codingPlanEnabled' && provider === 'moonshot') {
        const codingPlanEnabled = value === 'true';
        return {
          ...prev,
          moonshot: {
            ...prev.moonshot,
            codingPlanEnabled,
          },
        };
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          [field]: value,
        },
      };
    });
  };

  const hasCoworkConfigChanges = coworkExecutionMode !== coworkConfig.executionMode
    || coworkMemoryEnabled !== coworkConfig.memoryEnabled
    || coworkMemoryLlmJudgeEnabled !== coworkConfig.memoryLlmJudgeEnabled;

  const coworkSandboxDisabled = !coworkSandboxStatus?.supported
    || !coworkSandboxStatus?.runtimeReady
    || !coworkSandboxStatus?.imageReady;

  const coworkSandboxStatusHint = useMemo(() => {
    if (coworkSandboxLoading) return i18nService.t('coworkSandboxChecking');
    if (!coworkSandboxStatus?.supported) return i18nService.t('coworkSandboxUnsupported');
    if (coworkSandboxStatus?.downloading) return i18nService.t('coworkSandboxDownloading');
    if (!coworkSandboxStatus?.runtimeReady) return i18nService.t('coworkSandboxRuntimeMissing');
    if (!coworkSandboxStatus?.imageReady) return i18nService.t('coworkSandboxImageMissing');
    return '';
  }, [coworkSandboxLoading, coworkSandboxStatus]);

  const coworkSandboxPercent = useMemo(() => {
    if (!coworkSandboxProgress) return null;
    if (coworkSandboxProgress.percent !== undefined && Number.isFinite(coworkSandboxProgress.percent)) {
      return Math.min(100, Math.max(0, Math.round(coworkSandboxProgress.percent * 100)));
    }
    if (coworkSandboxProgress.total && coworkSandboxProgress.total > 0) {
      return Math.min(100, Math.max(0, Math.round((coworkSandboxProgress.received / coworkSandboxProgress.total) * 100)));
    }
    return null;
  }, [coworkSandboxProgress]);

  const coworkSandboxStageLabel = coworkSandboxProgress?.stage === 'image'
    ? (i18nService.getLanguage() === 'zh' ? '镜像' : 'Image')
    : (i18nService.getLanguage() === 'zh' ? '运行时' : 'Runtime');

  const handleInstallCoworkSandbox = async () => {
    setCoworkSandboxInstalling(true);
    try {
      const result = await coworkService.installSandbox();
      if (result?.status) {
        setCoworkSandboxStatus(result.status);
        if (result.status.progress) {
          setCoworkSandboxProgress(result.status.progress);
        }
      }
    } finally {
      setCoworkSandboxInstalling(false);
    }
  };

  const loadCoworkMemoryData = useCallback(async () => {
    setCoworkMemoryListLoading(true);
    try {
      const [entries, stats] = await Promise.all([
        coworkService.listMemoryEntries({
          query: coworkMemoryQuery.trim() || undefined,
        }),
        coworkService.getMemoryStats(),
      ]);
      setCoworkMemoryEntries(entries);
      setCoworkMemoryStats(stats);
    } catch (loadError) {
      console.error('Failed to load cowork memory data:', loadError);
      setCoworkMemoryEntries([]);
      setCoworkMemoryStats(null);
    } finally {
      setCoworkMemoryListLoading(false);
    }
  }, [
    coworkMemoryQuery,
  ]);

  useEffect(() => {
    if (activeTab !== 'coworkMemory') return;
    void loadCoworkMemoryData();
  }, [activeTab, loadCoworkMemoryData]);

  const resetCoworkMemoryEditor = () => {
    setCoworkMemoryEditingId(null);
    setCoworkMemoryDraftText('');
    setShowMemoryModal(false);
  };

  const handleSaveCoworkMemoryEntry = async () => {
    const text = coworkMemoryDraftText.trim();
    if (!text) return;

    setCoworkMemoryListLoading(true);
    try {
      if (coworkMemoryEditingId) {
        await coworkService.updateMemoryEntry({
          id: coworkMemoryEditingId,
          text,
          status: 'created',
          isExplicit: true,
        });
      } else {
        await coworkService.createMemoryEntry({
          text,
          isExplicit: true,
        });
      }
      resetCoworkMemoryEditor();
      await loadCoworkMemoryData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('coworkMemoryCrudSaveFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleEditCoworkMemoryEntry = (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryEditingId(entry.id);
    setCoworkMemoryDraftText(entry.text);
    setShowMemoryModal(true);
  };

  const handleDeleteCoworkMemoryEntry = async (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryListLoading(true);
    try {
      await coworkService.deleteMemoryEntry({ id: entry.id });
      if (coworkMemoryEditingId === entry.id) {
        resetCoworkMemoryEditor();
      }
      await loadCoworkMemoryData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : i18nService.t('coworkMemoryCrudDeleteFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const getMemoryStatusLabel = (status: CoworkUserMemoryEntry['status']): string => {
    if (status === 'created') return i18nService.t('coworkMemoryStatusActive');
    if (status === 'stale') return i18nService.t('coworkMemoryStatusInactive');
    return i18nService.t('coworkMemoryStatusDeleted');
  };

  const formatMemoryUpdatedAt = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return '-';
    }
  };

  const handleOpenCoworkMemoryModal = () => {
    resetCoworkMemoryEditor();
    setShowMemoryModal(true);
  };

  // Toggle provider enabled status
  const toggleProviderEnabled = (provider: ProviderType) => {
    const providerConfig = providers[provider];
    const isEnabling = !providerConfig.enabled;
    const missingApiKey = providerRequiresApiKey(provider) && !providerConfig.apiKey.trim();

    if (isEnabling && missingApiKey) {
      setError(i18nService.t('apiKeyRequired'));
      return;
    }

    setProviders(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        enabled: !prev[provider].enabled
      }
    }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const normalizedProviders = Object.fromEntries(
        Object.entries(providers).map(([providerKey, providerConfig]) => [
          providerKey,
          {
            ...providerConfig,
            apiFormat: getEffectiveApiFormat(providerKey, providerConfig.apiFormat),
          },
        ])
      ) as ProvidersConfig;

      // Find the first enabled provider to use as the primary API
      const firstEnabledProvider = Object.entries(normalizedProviders).find(
        ([_, config]) => config.enabled
      );

      const primaryProvider = firstEnabledProvider
        ? firstEnabledProvider[1]
        : normalizedProviders[activeProvider];

      await configService.updateConfig({
        api: {
          key: primaryProvider.apiKey,
          baseUrl: primaryProvider.baseUrl,
        },
        providers: normalizedProviders, // Save all providers configuration
        theme,
        language,
        useSystemProxy,
        shortcuts,
      });

      // 应用主题
      themeService.setTheme(theme);

      // 应用语言
      i18nService.setLanguage(language, { persist: false });

      // Set API with the primary provider
      apiService.setConfig({
        apiKey: primaryProvider.apiKey,
        baseUrl: primaryProvider.baseUrl,
      });

      // 更新 Redux store 中的可用模型列表
      const allModels: { id: string; name: string; provider?: string; supportsImage?: boolean }[] = [];
      Object.entries(normalizedProviders).forEach(([providerName, config]) => {
        if (config.enabled && config.models) {
          config.models.forEach(model => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));

      if (hasCoworkConfigChanges) {
        await coworkService.updateConfig({
          executionMode: coworkExecutionMode,
          memoryEnabled: coworkMemoryEnabled,
          memoryLlmJudgeEnabled: coworkMemoryLlmJudgeEnabled,
        });
      }

      // Save IM config
      await imService.updateConfig(imConfig);

      didSaveRef.current = true;
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // 标签页切换处理
  const handleTabChange = (tab: TabType) => {
    if (tab !== 'model') {
      setIsAddingModel(false);
      setIsEditingModel(false);
      setEditingModelId(null);
      setNewModelName('');
      setNewModelId('');
      setNewModelSupportsImage(false);
      setModelFormError(null);
    }
    setActiveTab(tab);
  };

  // 快捷键更新处理
  const handleShortcutChange = (key: keyof typeof shortcuts, value: string) => {
    setShortcuts(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // 阻止点击设置窗口时事件传播到背景
  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Handlers for model operations
  const handleAddModel = () => {
    setIsAddingModel(true);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleEditModel = (modelId: string, modelName: string, supportsImage?: boolean) => {
    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    setNewModelSupportsImage(!!supportsImage);
    setModelFormError(null);
  };

  const handleDeleteModel = (modelId: string) => {
    if (!providers[activeProvider].models) return;
    
    const updatedModels = providers[activeProvider].models.filter(
      model => model.id !== modelId
    );
    
    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));
  };

  const handleSaveNewModel = () => {
    const modelId = newModelId.trim();

    if (activeProvider === 'ollama') {
      // For Ollama, only the model name (stored as modelId) is required
      if (!modelId) {
        setModelFormError(i18nService.t('ollamaModelNameRequired'));
        return;
      }
    } else {
      const modelName = newModelName.trim();
      if (!modelName || !modelId) {
        setModelFormError(i18nService.t('modelNameAndIdRequired'));
        return;
      }
    }

    // For Ollama, auto-fill display name from modelId if not provided
    const modelName = activeProvider === 'ollama'
      ? (newModelName.trim() && newModelName.trim() !== modelId ? newModelName.trim() : modelId)
      : newModelName.trim();

    const currentModels = providers[activeProvider].models ?? [];
    const duplicateModel = currentModels.find(
      model => model.id === modelId && (!isEditingModel || model.id !== editingModelId)
    );
    if (duplicateModel) {
      setModelFormError(i18nService.t('modelIdExists'));
      return;
    }

    const nextModel = {
      id: modelId,
      name: modelName,
      supportsImage: newModelSupportsImage,
    };
    const updatedModels = isEditingModel && editingModelId
      ? currentModels.map(model => (model.id === editingModelId ? nextModel : model))
      : [...currentModels, nextModel];

    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));

    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleCancelModelEdit = () => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleModelDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelModelEdit();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveNewModel();
    }
  };

  const showTestResultModal = (
    result: Omit<ProviderConnectionTestResult, 'provider'>,
    provider: ProviderType
  ) => {
    setTestResult({
      ...result,
      provider,
    });
    setIsTestResultModalOpen(true);
  };

  // 测试 API 连接
  const handleTestConnection = async () => {
    const testingProvider = activeProvider;
    const providerConfig = providers[testingProvider];
    setIsTesting(true);
    setIsTestResultModalOpen(false);
    setTestResult(null);

    if (providerRequiresApiKey(testingProvider) && !providerConfig.apiKey) {
      showTestResultModal({ success: false, message: i18nService.t('apiKeyRequired') }, testingProvider);
      setIsTesting(false);
      return;
    }

    // 获取第一个可用模型
    const firstModel = providerConfig.models?.[0];
    if (!firstModel) {
      showTestResultModal({ success: false, message: i18nService.t('noModelsConfigured') }, testingProvider);
      setIsTesting(false);
      return;
    }

    try {
      let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
      // Apply Coding Plan endpoint switch
      let effectiveBaseUrl = providerConfig.baseUrl;
      let effectiveApiFormat = getEffectiveApiFormat(testingProvider, providerConfig.apiFormat);
      
      // Handle Zhipu GLM Coding Plan endpoint switch
      if (testingProvider === 'zhipu' && (providerConfig as { codingPlanEnabled?: boolean }).codingPlanEnabled) {
        if (effectiveApiFormat === 'anthropic') {
          effectiveBaseUrl = 'https://open.bigmodel.cn/api/anthropic';
        } else {
          effectiveBaseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
          effectiveApiFormat = 'openai';
        }
      }
      // Handle Qwen Coding Plan endpoint switch
      if (testingProvider === 'qwen' && (providerConfig as { codingPlanEnabled?: boolean }).codingPlanEnabled) {
        if (effectiveApiFormat === 'anthropic') {
          effectiveBaseUrl = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
        } else {
          effectiveBaseUrl = 'https://coding.dashscope.aliyuncs.com/v1';
          effectiveApiFormat = 'openai';
        }
      }
      // Handle Volcengine Coding Plan endpoint switch
      if (testingProvider === 'volcengine' && (providerConfig as { codingPlanEnabled?: boolean }).codingPlanEnabled) {
        if (effectiveApiFormat === 'anthropic') {
          effectiveBaseUrl = 'https://ark.cn-beijing.volces.com/api/coding';
        } else {
          effectiveBaseUrl = 'https://ark.cn-beijing.volces.com/api/coding/v3';
          effectiveApiFormat = 'openai';
        }
      }
      // Handle Moonshot Coding Plan endpoint switch
      if (testingProvider === 'moonshot' && (providerConfig as { codingPlanEnabled?: boolean }).codingPlanEnabled) {
        if (effectiveApiFormat === 'anthropic') {
          effectiveBaseUrl = 'https://api.kimi.com/coding';
        } else {
          effectiveBaseUrl = 'https://api.kimi.com/coding/v1';
          effectiveApiFormat = 'openai';
        }
      }
      
      const normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
      // 统一为两种协议格式：
      // - anthropic: /v1/messages
      // - openai provider: /v1/responses
      // - other openai-compatible providers: /v1/chat/completions
      const useAnthropicFormat = effectiveApiFormat === 'anthropic';

      if (useAnthropicFormat) {
        const anthropicUrl = normalizedBaseUrl.endsWith('/v1')
          ? `${normalizedBaseUrl}/messages`
          : `${normalizedBaseUrl}/v1/messages`;
        response = await window.electron.api.fetch({
          url: anthropicUrl,
          method: 'POST',
          headers: {
            'x-api-key': providerConfig.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: firstModel.id,
            max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else {
        const useResponsesApi = shouldUseOpenAIResponsesForProvider(testingProvider);
        const openaiUrl = useResponsesApi
          ? buildOpenAIResponsesUrl(normalizedBaseUrl)
          : buildOpenAICompatibleChatCompletionsUrl(normalizedBaseUrl, testingProvider);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (providerConfig.apiKey) {
          headers.Authorization = `Bearer ${providerConfig.apiKey}`;
        }
        const openAIRequestBody: Record<string, unknown> = useResponsesApi
          ? {
              model: firstModel.id,
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
              max_output_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            }
          : {
              model: firstModel.id,
              messages: [{ role: 'user', content: 'Hi' }],
            };
        if (!useResponsesApi && shouldUseMaxCompletionTokensForOpenAI(testingProvider, firstModel.id)) {
          openAIRequestBody.max_completion_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
        } else {
          if (!useResponsesApi) {
            openAIRequestBody.max_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
          }
        }
        response = await window.electron.api.fetch({
          url: openaiUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody),
        });
      }

      if (response.ok) {
        showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
      } else {
        const data = response.data || {};
        // 提取错误信息
        const errorMessage = data.error?.message || data.message || `${i18nService.t('connectionFailed')}: ${response.status}`;
        if (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('model output limit was reached')) {
          showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
          return;
        }
        showTestResultModal({ success: false, message: errorMessage }, testingProvider);
      }
    } catch (err) {
      showTestResultModal({
        success: false,
        message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
      }, testingProvider);
    } finally {
      setIsTesting(false);
    }
  };

  const buildProvidersExport = async (password: string): Promise<ProvidersExportPayload> => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([providerKey, providerConfig]) => {
        const apiKey = await encryptWithPassword(providerConfig.apiKey, password);
        return [
          providerKey,
          {
            enabled: providerConfig.enabled,
            apiKey,
            baseUrl: providerConfig.baseUrl,
            apiFormat: getEffectiveApiFormat(providerKey, providerConfig.apiFormat),
            codingPlanEnabled: (providerConfig as ProviderConfig).codingPlanEnabled,
            models: providerConfig.models,
          },
        ] as const;
      })
    );

    return {
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      exportedAt: new Date().toISOString(),
      encryption: {
        algorithm: 'AES-GCM',
        keySource: 'password',
        keyDerivation: 'PBKDF2',
      },
      providers: Object.fromEntries(entries),
    };
  };

  const normalizeModels = (models?: Model[]) =>
    models?.map(model => ({
      ...model,
      supportsImage: model.supportsImage ?? false,
    }));

  const DEFAULT_EXPORT_PASSWORD = EXPORT_PASSWORD;

  const handleExportProviders = async () => {
    setError(null);
    setIsExportingProviders(true);

    try {
      const payload = await buildProvidersExport(DEFAULT_EXPORT_PASSWORD);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_ID}-providers-${date}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.error('Failed to export providers:', err);
      setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExportingProviders(false);
    }
  };

  const handleImportProvidersClick = () => {
    importInputRef.current?.click();
  };

  const handleImportProviders = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    setError(null);

    try {
      const raw = await file.text();
      let payload: ProvidersImportPayload;
      try {
        payload = JSON.parse(raw) as ProvidersImportPayload;
      } catch (parseError) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      if (!payload || payload.type !== EXPORT_FORMAT_TYPE || !payload.providers) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if it's version 2 (password-based encryption)
      if (payload.version === 2 && payload.encryption?.keySource === 'password') {
        await processImportPayloadWithPassword(payload);
        return;
      }

      // Version 1 (legacy local-store key) - try to decrypt with local key
      if (payload.version === 1) {
        await processImportPayloadWithLocalKey(payload);
        return;
      }

      setError(i18nService.t('invalidProvidersFile'));
    } catch (err) {
      console.error('Failed to import providers:', err);
      setError(i18nService.t('importProvidersFailed'));
    }
  };

  const processImportPayloadWithLocalKey = async (payload: ProvidersImportPayload) => {
    setIsImportingProviders(true);
    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;
      for (const providerKey of providerKeys) {
        const providerData = payload.providers?.[providerKey];
        if (!providerData) {
          continue;
        }

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          try {
            apiKey = await decryptSecret(providerData.apiKey as EncryptedPayload);
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        } else if (typeof providerData.apiKeyEncrypted === 'string' && typeof providerData.apiKeyIv === 'string') {
          try {
            apiKey = await decryptSecret({ encrypted: providerData.apiKeyEncrypted, iv: providerData.apiKeyIv });
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? providers[providerKey].apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  const processImportPayloadWithPassword = async (payload: ProvidersImportPayload) => {
    if (!payload.providers) {
      return;
    }

    setIsImportingProviders(true);

    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;

      for (const providerKey of providerKeys) {
        const providerData = payload.providers[providerKey];
        if (!providerData) {
          continue;
        }

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          const apiKeyObj = providerData.apiKey as PasswordEncryptedPayload;
          if (apiKeyObj.salt) {
            // Version 2 password-based encryption
            try {
              apiKey = await decryptWithPassword(apiKeyObj, DEFAULT_EXPORT_PASSWORD);
            } catch (error) {
              hadDecryptFailure = true;
              console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
            }
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? providers[providerKey].apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if any key was successfully decrypted
      const anyKeyDecrypted = Object.entries(providerUpdates).some(
        ([key, update]) => update?.apiKey && update.apiKey !== providers[key]?.apiKey
      );

      if (!anyKeyDecrypted && hadDecryptFailure) {
        // All decryptions failed - likely wrong password
        setError(i18nService.t('decryptProvidersFailed'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  // 渲染标签页
  const sidebarTabs: { key: TabType; label: string; icon: React.ReactNode }[] = useMemo(() => [
    { key: 'general',        label: i18nService.t('general'),        icon: <Cog6ToothIcon className="h-5 w-5" /> },
    { key: 'model',          label: i18nService.t('model'),          icon: <CubeIcon className="h-5 w-5" /> },
    { key: 'im',             label: i18nService.t('imBot'),          icon: <ChatBubbleLeftIcon className="h-5 w-5" /> },
    { key: 'email',          label: i18nService.t('emailTab'),       icon: <EnvelopeIcon className="h-5 w-5" /> },
    { key: 'coworkMemory',   label: i18nService.t('coworkMemoryTitle'), icon: <BrainIcon className="h-5 w-5" /> },
    { key: 'coworkSandbox',  label: i18nService.t('coworkSandbox'),  icon: <ShieldCheckIcon className="h-5 w-5" /> },
    { key: 'shortcuts',      label: i18nService.t('shortcuts'),      icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5"><rect x="2" y="4" width="20" height="14" rx="2" /><line x1="6" y1="8" x2="8" y2="8" /><line x1="10" y1="8" x2="12" y2="8" /><line x1="14" y1="8" x2="16" y2="8" /><line x1="6" y1="12" x2="8" y2="12" /><line x1="10" y1="12" x2="14" y2="12" /><line x1="16" y1="12" x2="18" y2="12" /><line x1="8" y1="15.5" x2="16" y2="15.5" /></svg> },
  ], [language]);

  const activeTabLabel = useMemo(() => {
    return sidebarTabs.find(t => t.key === activeTab)?.label ?? '';
  }, [activeTab, sidebarTabs]);

  const renderTabContent = () => {
    switch(activeTab) {
      case 'general':
        return (
          <div className="space-y-8">
            {/* Language Section */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('language')}
              </h4>
              <div className="w-[140px] shrink-0">
                <ThemedSelect
                  id="language"
                  value={language}
                  onChange={(value) => {
                    const nextLanguage = value as LanguageType;
                    setLanguage(nextLanguage);
                    i18nService.setLanguage(nextLanguage, { persist: false });
                  }}
                  options={[
                    { value: 'zh', label: i18nService.t('chinese') },
                    { value: 'en', label: i18nService.t('english') }
                  ]}
                />
              </div>
            </div>

            {/* Auto-launch Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('autoLaunch')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('autoLaunchDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoLaunch}
                  onClick={async () => {
                    if (isUpdatingAutoLaunch) return;
                    const next = !autoLaunch;
                    setIsUpdatingAutoLaunch(true);
                    try {
                      const result = await window.electron.autoLaunch.set(next);
                      if (result.success) {
                        setAutoLaunchState(next);
                      } else {
                        setError(result.error || 'Failed to update auto-launch setting');
                      }
                    } catch (err) {
                      console.error('Failed to set auto-launch:', err);
                      setError('Failed to update auto-launch setting');
                    } finally {
                      setIsUpdatingAutoLaunch(false);
                    }
                  }}
                  disabled={isUpdatingAutoLaunch}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingAutoLaunch ? 'opacity-50 cursor-not-allowed' : ''
                  } ${
                    autoLaunch
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoLaunch ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* System proxy Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('useSystemProxy')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('useSystemProxyDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useSystemProxy}
                  onClick={() => {
                    setUseSystemProxy((prev) => !prev);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    useSystemProxy
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      useSystemProxy ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* Appearance Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('appearance')}
              </h4>
              <div className="grid grid-cols-3 gap-4">
                {([
                  { value: 'light' as const, label: i18nService.t('light') },
                  { value: 'dark' as const, label: i18nService.t('dark') },
                  { value: 'system' as const, label: i18nService.t('system') },
                ]).map((option) => {
                  const isSelected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setTheme(option.value);
                        themeService.setTheme(option.value);
                      }}
                      className={`flex flex-col items-center rounded-xl border-2 p-3 transition-colors cursor-pointer ${
                        isSelected
                          ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                          : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 dark:hover:border-claude-accent/50'
                      }`}
                    >
                      <svg viewBox="0 0 120 80" className="w-full h-auto rounded-md mb-2 overflow-hidden" xmlns="http://www.w3.org/2000/svg">
                        {option.value === 'light' && (
                          <>
                            <rect width="120" height="80" fill="#F8F9FB" />
                            <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#E2E4E7" />
                          </>
                        )}
                        {option.value === 'dark' && (
                          <>
                            <rect width="120" height="80" fill="#0F1117" />
                            <rect x="0" y="0" width="30" height="80" fill="#151820" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#252930" />
                          </>
                        )}
                        {option.value === 'system' && (
                          <>
                            <defs>
                              <clipPath id="left-half">
                                <rect x="0" y="0" width="60" height="80" />
                              </clipPath>
                              <clipPath id="right-half">
                                <rect x="60" y="0" width="60" height="80" />
                              </clipPath>
                            </defs>
                            {/* Light half */}
                            <g clipPath="url(#left-half)">
                              <rect width="120" height="80" fill="#F8F9FB" />
                              <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            </g>
                            {/* Dark half */}
                            <g clipPath="url(#right-half)">
                              <rect width="120" height="80" fill="#0F1117" />
                              <rect x="0" y="0" width="30" height="80" fill="#151820" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            </g>
                            {/* Divider line */}
                            <line x1="60" y1="0" x2="60" y2="80" stroke="#888" strokeWidth="0.5" />
                          </>
                        )}
                      </svg>
                      <span className={`text-xs font-medium ${
                        isSelected
                          ? 'text-claude-accent'
                          : 'dark:text-claude-darkText text-claude-text'
                      }`}>
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );

      case 'email':
        return <EmailSkillConfig />;

      case 'coworkSandbox':
        return (
          <div className="space-y-6">
            <div className="space-y-3">
              <label className="block text-sm font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('coworkExecutionMode')}
              </label>
              <div className="space-y-2">
                {([
                  {
                    value: 'auto',
                    label: i18nService.t('coworkExecutionModeAuto'),
                    hint: i18nService.t('coworkExecutionModeAutoHint'),
                  },
                  {
                    value: 'local',
                    label: i18nService.t('coworkExecutionModeLocal'),
                    hint: i18nService.t('coworkExecutionModeLocalHint'),
                  },
                  {
                    value: 'sandbox',
                    label: i18nService.t('coworkExecutionModeSandbox'),
                    hint: i18nService.t('coworkExecutionModeSandboxHint'),
                  },
                ] as Array<{ value: CoworkExecutionMode; label: string; hint: string }>).map((option) => {
                  const isDisabled = option.value === 'sandbox' && coworkSandboxDisabled;
                  return (
                    <label
                      key={option.value}
                      className={`flex items-start gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${
                        isDisabled
                          ? 'cursor-not-allowed opacity-60 dark:border-claude-darkBorder border-claude-border'
                          : 'cursor-pointer dark:border-claude-darkBorder border-claude-border hover:border-claude-accent'
                      }`}
                    >
                      <input
                        type="radio"
                        name="cowork-execution-mode"
                        value={option.value}
                        checked={coworkExecutionMode === option.value}
                        onChange={() => setCoworkExecutionMode(option.value)}
                        disabled={isDisabled}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium dark:text-claude-darkText text-claude-text">
                          {option.label}
                        </span>
                        <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {option.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {coworkSandboxStatusHint && (
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {coworkSandboxStatusHint}
                </div>
              )}

              {coworkSandboxProgress && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <span>
                      {coworkSandboxStageLabel}
                    </span>
                    {coworkSandboxPercent !== null && (
                      <span>{coworkSandboxPercent}%</span>
                    )}
                  </div>
                  <div className="h-2 rounded-full dark:bg-claude-darkBorder bg-claude-border overflow-hidden">
                    <div
                      className="h-full bg-claude-accent transition-all"
                      style={{ width: `${coworkSandboxPercent ?? 0}%` }}
                    />
                  </div>
                </div>
              )}

              {coworkSandboxDisabled && coworkSandboxStatus?.supported && (
                <button
                  type="button"
                  onClick={handleInstallCoworkSandbox}
                  disabled={coworkSandboxInstalling || coworkSandboxLoading}
                  className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-white text-sm font-medium transition-colors disabled:opacity-50 active:scale-[0.98]"
                >
                  {coworkSandboxInstalling ? i18nService.t('coworkSandboxInstalling') : i18nService.t('coworkSandboxInstall')}
                </button>
              )}

              {coworkSandboxDisabled && !coworkSandboxStatus?.supported && (
                <div className="text-xs text-blue-500 dark:text-blue-400">
                  {i18nService.t('coworkSandboxSelectionBlocked')}
                </div>
              )}
            </div>
          </div>
        );

      case 'coworkMemory':
        return (
          <div className="space-y-6">
            <div className="space-y-3 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
              <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('coworkMemoryTitle')}
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={coworkMemoryEnabled}
                  onChange={(event) => setCoworkMemoryEnabled(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm dark:text-claude-darkText text-claude-text">
                    {i18nService.t('coworkMemoryEnabled')}
                  </span>
                  <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryEnabledHint')}
                  </span>
                  <span className="mt-1 block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemorySimpleHint')}
                  </span>
                </span>
              </label>
              <label className={`flex items-start gap-3 ${coworkMemoryEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                <input
                  type="checkbox"
                  checked={coworkMemoryLlmJudgeEnabled}
                  onChange={(event) => setCoworkMemoryLlmJudgeEnabled(event.target.checked)}
                  disabled={!coworkMemoryEnabled}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm dark:text-claude-darkText text-claude-text">
                    {i18nService.t('coworkMemoryLlmJudgeEnabled')}
                  </span>
                  <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryLlmJudgeEnabledHint')}
                  </span>
                </span>
              </label>
            </div>

            <div className="space-y-4 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('coworkMemoryCrudTitle')}
                  </div>
                  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryManageHint')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleOpenCoworkMemoryModal}
                  className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white text-sm transition-colors active:scale-[0.98]"
                >
                  <PlusCircleIcon className="h-4 w-4 mr-1.5" />
                  {i18nService.t('coworkMemoryCrudCreate')}
                </button>
              </div>

              {coworkMemoryStats && (
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {`${i18nService.t('coworkMemoryTotalLabel')}: ${coworkMemoryStats.created + coworkMemoryStats.stale} · ${i18nService.t('coworkMemoryActiveLabel')}: ${coworkMemoryStats.created} · ${i18nService.t('coworkMemoryInactiveLabel')}: ${coworkMemoryStats.stale}`}
                </div>
              )}

              <input
                type="text"
                value={coworkMemoryQuery}
                onChange={(event) => setCoworkMemoryQuery(event.target.value)}
                placeholder={i18nService.t('coworkMemorySearchPlaceholder')}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
              />

              <div className="max-h-[500px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
                {coworkMemoryListLoading ? (
                  <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('loading')}
                  </div>
                ) : coworkMemoryEntries.length === 0 ? (
                  <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkMemoryEmpty')}
                  </div>
                ) : (
                  <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                    {coworkMemoryEntries.map((entry) => (
                      <div key={entry.id} className="px-3 py-3 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 space-y-1 min-w-0">
                            <div className="font-medium dark:text-claude-darkText text-claude-text break-words">
                              {entry.text}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">
                                {getMemoryStatusLabel(entry.status)}
                              </span>
                              <span>
                                {`${i18nService.t('coworkMemoryUpdatedAt')}: ${formatMemoryUpdatedAt(entry.updatedAt)}`}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => handleEditCoworkMemoryEntry(entry)}
                              className="rounded border px-2 py-1 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                            >
                              {i18nService.t('edit')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleDeleteCoworkMemoryEntry(entry); }}
                              className="rounded border px-2 py-1 text-red-500 dark:border-claude-darkBorder border-claude-border hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60 transition-colors"
                              disabled={coworkMemoryListLoading}
                            >
                              {i18nService.t('delete')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>
        );

      case 'model':
        return (
          <div className="flex h-full">
            {/* Provider List - Left Side */}
            <div className="w-2/5 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-1.5 overflow-y-auto">
              <div className="flex items-center justify-between mb-2 px-1">
                <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('modelProviders')}
                </h3>
                <div className="flex items-center space-x-1">
                  <button
                    type="button"
                    onClick={handleImportProvidersClick}
                    disabled={isImportingProviders || isExportingProviders}
                    className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('import')}
                  </button>
                  <button
                    type="button"
                    onClick={handleExportProviders}
                    disabled={isImportingProviders || isExportingProviders}
                    className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('export')}
                  </button>
                </div>
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImportProviders}
              />
              {Object.entries(visibleProviders).map(([provider, config]) => {
                const providerKey = provider as ProviderType;
                const providerInfo = providerMeta[providerKey];
                const missingApiKey = providerRequiresApiKey(providerKey) && !config.apiKey.trim();
                const canToggleProvider = config.enabled || !missingApiKey;
                return (
                  <div
                    key={provider}
                    onClick={() => handleProviderChange(providerKey)}
                    className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                      activeProvider === provider
                        ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30 shadow-subtle'
                        : 'dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-transparent'
                    }`}
                  >
                    <div className="flex flex-1 items-center">
                      <div className="mr-2 flex h-7 w-7 items-center justify-center">
                        <span className="dark:text-claude-darkText text-claude-text">
                          {providerInfo?.icon}
                        </span>
                      </div>
                      <span className={`text-sm font-medium truncate ${
                        activeProvider === provider
                          ? 'text-claude-accent'
                          : 'dark:text-claude-darkText text-claude-text'
                      }`}>
                        {providerInfo?.label ?? provider.charAt(0).toUpperCase() + provider.slice(1)}
                      </span>
                    </div>
                    <div className="flex items-center ml-2">
                      <div
                        title={!canToggleProvider ? i18nService.t('configureApiKey') : undefined}
                        className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                          config.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                        } ${
                          canToggleProvider ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canToggleProvider) {
                            return;
                          }
                          toggleProviderEnabled(providerKey);
                        }}
                      >
                        <div
                          className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                            config.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Provider Settings - Right Side */}
            <div className="w-3/5 pl-4 space-y-4 overflow-y-auto">
              <div className="flex items-center justify-between pb-2 border-b dark:border-claude-darkBorder border-claude-border">
                <h3 className="text-base font-medium dark:text-claude-darkText text-claude-text">
                  {(providerMeta[activeProvider]?.label ?? activeProvider.charAt(0).toUpperCase() + activeProvider.slice(1))} {i18nService.t('providerSettings')}
                </h3>
                <div
                  className={`px-2 py-0.5 rounded-lg text-xs font-medium ${
                    providers[activeProvider].enabled
                      ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                      : 'bg-red-500/20 text-red-600 dark:text-red-400'
                  }`}
                >
                  {providers[activeProvider].enabled ? i18nService.t('providerStatusOn') : i18nService.t('providerStatusOff')}
                </div>
              </div>

              {providerRequiresApiKey(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiKey`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('apiKey')}
                  </label>
                  <input
                    type="password"
                    id={`${activeProvider}-apiKey`}
                    value={providers[activeProvider].apiKey}
                    onChange={(e) => handleProviderConfigChange(activeProvider, 'apiKey', e.target.value)}
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    placeholder={i18nService.t('apiKeyPlaceholder')}
                  />
                </div>
              )}

              <div>
                <label htmlFor={`${activeProvider}-baseUrl`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                  {i18nService.t('baseUrl')}
                </label>
                <input
                  type="text"
                  id={`${activeProvider}-baseUrl`}
                  value={
                    activeProvider === 'zhipu' && providers.zhipu.codingPlanEnabled
                      ? (getEffectiveApiFormat('zhipu', providers.zhipu.apiFormat) === 'anthropic'
                          ? 'https://open.bigmodel.cn/api/anthropic'
                          : 'https://open.bigmodel.cn/api/coding/paas/v4')
                      : activeProvider === 'qwen' && providers.qwen.codingPlanEnabled
                        ? (getEffectiveApiFormat('qwen', providers.qwen.apiFormat) === 'anthropic'
                            ? 'https://coding.dashscope.aliyuncs.com/apps/anthropic'
                            : 'https://coding.dashscope.aliyuncs.com/v1')
                        : activeProvider === 'volcengine' && providers.volcengine.codingPlanEnabled
                          ? (getEffectiveApiFormat('volcengine', providers.volcengine.apiFormat) === 'anthropic'
                              ? 'https://ark.cn-beijing.volces.com/api/coding'
                              : 'https://ark.cn-beijing.volces.com/api/coding/v3')
                          : activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled
                            ? (getEffectiveApiFormat('moonshot', providers.moonshot.apiFormat) === 'anthropic'
                                ? 'https://api.kimi.com/coding'
                                : 'https://api.kimi.com/coding/v1')
                            : providers[activeProvider].baseUrl
                  }
                  onChange={(e) => handleProviderConfigChange(activeProvider, 'baseUrl', e.target.value)}
                  disabled={(activeProvider === 'zhipu' && providers.zhipu.codingPlanEnabled) || (activeProvider === 'qwen' && providers.qwen.codingPlanEnabled) || (activeProvider === 'volcengine' && providers.volcengine.codingPlanEnabled) || (activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled)}
                  className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs ${(activeProvider === 'zhipu' && providers.zhipu.codingPlanEnabled) || (activeProvider === 'qwen' && providers.qwen.codingPlanEnabled) || (activeProvider === 'volcengine' && providers.volcengine.codingPlanEnabled) || (activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled) ? 'opacity-50 cursor-not-allowed' : ''}`}
                  placeholder={i18nService.t('baseUrlPlaceholder')}
                />
                {activeProvider === 'custom' && (
                <div className="mt-1.5 space-y-0.5 text-[11px] text-claude-secondaryText dark:text-claude-darkSecondaryText">
                  <p>
                    <span className="text-sm text-claude-accent/50 mr-1">•</span>
                    {i18nService.t('baseUrlHint1')}
                    <code className="ml-1 text-claude-accent/80 dark:text-claude-accent/70 break-all">{i18nService.t('baseUrlHintExample1')}</code>
                  </p>
                  <p>
                    <span className="text-sm text-claude-accent/50 mr-1">•</span>
                    {i18nService.t('baseUrlHint2')}
                    <code className="ml-1 text-claude-accent/80 dark:text-claude-accent/70 break-all">{i18nService.t('baseUrlHintExample2')}</code>
                  </p>
                </div>
                )}
                {/* GLM Coding Plan 提示 */}
                {activeProvider === 'zhipu' && providers.zhipu.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
                    <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                      <span className="font-medium">GLM Coding Plan:</span> {i18nService.t('zhipuCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Qwen Coding Plan 提示 */}
                {activeProvider === 'qwen' && providers.qwen.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
                    <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('qwenCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Volcengine Coding Plan 提示 */}
                {activeProvider === 'volcengine' && providers.volcengine.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
                    <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('volcengineCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Moonshot Coding Plan 提示 */}
                {activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
                    <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('moonshotCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
              </div>

              {/* API 格式选择器 */}
              {shouldShowApiFormatSelector(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiFormat`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('apiFormat')}
                  </label>
                  <div className="flex items-center space-x-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="anthropic"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) !== 'openai'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'anthropic')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                      />
                      <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                        {i18nService.t('apiFormatNative')}
                      </span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="openai"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) === 'openai'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'openai')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                      />
                      <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                        {i18nService.t('apiFormatOpenAI')}
                      </span>
                    </label>
                  </div>
                  <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('apiFormatHint')}
                  </p>
                </div>
              )}

              {/* GLM Coding Plan 开关 (仅 Zhipu) */}
              {activeProvider === 'zhipu' && (
                <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                        GLM Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('zhipuCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.zhipu.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('zhipu', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
                  </label>
                </div>
              )}

              {/* Qwen Coding Plan 开关 (仅 Qwen) */}
              {activeProvider === 'qwen' && (
                <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                        订阅套餐
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('qwenCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.qwen.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('qwen', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
                  </label>
                </div>
              )}

              {/* Volcengine Coding Plan 开关 (仅 Volcengine) */}
              {activeProvider === 'volcengine' && (
                <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('volcengineCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.volcengine.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('volcengine', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
                  </label>
                </div>
              )}

              {/* Moonshot Coding Plan 开关 (仅 Moonshot) */}
              {activeProvider === 'moonshot' && (
                <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('moonshotCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.moonshot.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('moonshot', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
                  </label>
                </div>
              )}

              {/* 测试连接按钮 */}
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isTesting || (providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey)}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('availableModels')}
                  </h3>
                  <button
                    type="button"
                    onClick={handleAddModel}
                    className="inline-flex items-center text-xs text-claude-accent hover:text-claude-accentHover"
                  >
                    <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                    {i18nService.t('addModel')}
                  </button>
                </div>

                {/* Models List */}
                <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                  {providers[activeProvider].models?.map(model => (
                    <div
                      key={model.id}
                      className="dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-2 rounded-xl dark:border-claude-darkBorder border-claude-border border transition-colors hover:border-claude-accent group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                          <span className="dark:text-claude-darkText text-claude-text font-medium text-[11px]">{model.name}</span>
                        </div>
                        <div className="flex items-center space-x-1">
                          <span className="text-[10px] px-1.5 py-0.5 bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary">{model.id}</span>
                          {model.supportsImage && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                              {i18nService.t('imageInput')}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleEditModel(model.id, model.name, model.supportsImage)}
                            className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <PencilIcon className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteModel(model.id)}
                            className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <TrashIcon className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {(!providers[activeProvider].models || providers[activeProvider].models.length === 0) && (
                    <div className="dark:bg-claude-darkSurface/20 bg-claude-surface/20 p-2.5 rounded-xl border dark:border-claude-darkBorder/50 border-claude-border/50 text-center">
                      <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('noModelsAvailable')}</p>
                      <button
                        type="button"
                        onClick={handleAddModel}
                        className="mt-1.5 inline-flex items-center text-[11px] font-medium text-claude-accent hover:text-claude-accentHover"
                      >
                        <PlusCircleIcon className="h-3 w-3 mr-1" />
                        {i18nService.t('addFirstModel')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );

      case 'shortcuts':
        return (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('keyboardShortcuts')}
              </label>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('newChat')}</span>
                  <input
                    type="text"
                    value={shortcuts.newChat}
                    onChange={(e) => handleShortcutChange('newChat', e.target.value)}
                    data-shortcut-input="true"
                    className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('search')}</span>
                  <input
                    type="text"
                    value={shortcuts.search}
                    onChange={(e) => handleShortcutChange('search', e.target.value)}
                    data-shortcut-input="true"
                    className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('openSettings')}</span>
                  <input
                    type="text"
                    value={shortcuts.settings}
                    onChange={(e) => handleShortcutChange('settings', e.target.value)}
                    data-shortcut-input="true"
                    className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
                  />
                </div>
              </div>
            </div>
          </div>
        );

      case 'im':
        return <IMSettings />;

      default:
        return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="flex w-[900px] h-[80vh] rounded-2xl dark:border-claude-darkBorder border-claude-border border shadow-modal overflow-hidden modal-content"
        onClick={handleSettingsClick}
      >
        {/* Left sidebar */}
        <div className="w-[220px] shrink-0 flex flex-col dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted border-r dark:border-claude-darkBorder border-claude-border rounded-l-2xl overflow-y-auto">
          <div className="px-5 pt-5 pb-3">
            <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('settings')}</h2>
          </div>
          <nav className="flex flex-col gap-0.5 px-3 pb-4">
            {sidebarTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  activeTab === tab.key
                    ? 'bg-claude-accent/10 text-claude-accent'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right content */}
        <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden dark:bg-claude-darkBg bg-claude-bg rounded-r-2xl">
          {/* Content header */}
          <div className="flex justify-between items-center px-6 pt-5 pb-3 shrink-0">
            <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{activeTabLabel}</h3>
            <button
              onClick={onClose}
              className="dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text p-1.5 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-lg transition-colors"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {noticeMessage && (
            <div className="px-6">
              <ErrorMessage
                message={noticeMessage}
                onClose={() => setNoticeMessage(null)}
              />
            </div>
          )}

          {error && (
            <div className="px-6">
              <ErrorMessage
                message={error}
                onClose={() => setError(null)}
              />
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
            {/* Tab content */}
            <div
              ref={contentRef}
              className="px-6 py-4 flex-1 overflow-y-auto"
            >
              {renderTabContent()}
            </div>

            {/* Footer buttons */}
            <div className="flex justify-end space-x-4 p-4 dark:border-claude-darkBorder border-claude-border border-t dark:bg-claude-darkBg bg-claude-bg shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl transition-colors text-sm font-medium border dark:border-claude-darkBorder border-claude-border active:scale-[0.98]"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 py-2 bg-claude-accent hover:bg-claude-accentHover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
              >
                {isSaving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
          </form>

          {isTestResultModalOpen && testResult && (
            <div
              className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4"
              onClick={() => setIsTestResultModalOpen(false)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={i18nService.t('connectionTestResult')}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                    {i18nService.t('connectionTestResult')}
                  </h4>
                  <button
                    type="button"
                    onClick={() => setIsTestResultModalOpen(false)}
                    className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <span>{providerMeta[testResult.provider]?.label ?? testResult.provider}</span>
                  <span className="text-[11px]">•</span>
                  <span className={`inline-flex items-center gap-1 ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {testResult.success ? (
                      <CheckCircleIcon className="h-4 w-4" />
                    ) : (
                      <XCircleIcon className="h-4 w-4" />
                    )}
                    {testResult.success ? i18nService.t('connectionSuccess') : i18nService.t('connectionFailed')}
                  </span>
                </div>

                <p className="mt-3 text-xs leading-5 dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                  {testResult.message}
                </p>

                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsTestResultModalOpen(false)}
                    className="px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('close')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {(isAddingModel || isEditingModel) && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4"
              onClick={handleCancelModelEdit}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleModelDialogKeyDown}
                className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                    {isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                  </h4>
                  <button
                    type="button"
                    onClick={handleCancelModelEdit}
                    className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                {modelFormError && (
                  <p className="mb-3 text-xs text-red-600 dark:text-red-400">
                    {modelFormError}
                  </p>
                )}

                <div className="space-y-3">
                  {activeProvider === 'ollama' ? (
                    <>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('ollamaModelName')}
                        </label>
                        <input
                          autoFocus
                          type="text"
                          value={newModelId}
                          onChange={(e) => {
                            setNewModelId(e.target.value);
                            if (!newModelName || newModelName === newModelId) {
                              setNewModelName(e.target.value);
                            }
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder={i18nService.t('ollamaModelNamePlaceholder')}
                        />
                        <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                          {i18nService.t('ollamaModelNameHint')}
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('ollamaDisplayName')}
                        </label>
                        <input
                          type="text"
                          value={newModelName === newModelId ? '' : newModelName}
                          onChange={(e) => {
                            setNewModelName(e.target.value || newModelId);
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder={i18nService.t('ollamaDisplayNamePlaceholder')}
                        />
                        <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                          {i18nService.t('ollamaDisplayNameHint')}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('modelName')}
                        </label>
                        <input
                          autoFocus
                          type="text"
                          value={newModelName}
                          onChange={(e) => {
                            setNewModelName(e.target.value);
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder="GPT-4"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                          {i18nService.t('modelId')}
                        </label>
                        <input
                          type="text"
                          value={newModelId}
                          onChange={(e) => {
                            setNewModelId(e.target.value);
                            if (modelFormError) {
                              setModelFormError(null);
                            }
                          }}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                          placeholder="gpt-4"
                        />
                      </div>
                    </>
                  )}
                  <div className="flex items-center space-x-2">
                    <input
                      id={`${activeProvider}-supportsImage`}
                      type="checkbox"
                      checked={newModelSupportsImage}
                      onChange={(e) => setNewModelSupportsImage(e.target.checked)}
                      className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface border-claude-border dark:border-claude-darkBorder rounded"
                    />
                    <label
                      htmlFor={`${activeProvider}-supportsImage`}
                      className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      {i18nService.t('supportsImageInput')}
                    </label>
                  </div>
                </div>

                <div className="flex justify-end space-x-2 mt-4">
                  <button
                    type="button"
                    onClick={handleCancelModelEdit}
                    className="px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveNewModel}
                    className="px-3 py-1.5 text-xs text-white bg-claude-accent hover:bg-claude-accentHover rounded-xl active:scale-[0.98]"
                  >
                    {i18nService.t('save')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Memory Modal */}
          {showMemoryModal && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4"
              onClick={resetCoworkMemoryEditor}
            >
              <div
                className="dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border rounded-2xl shadow-xl w-full max-w-md"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-5 pt-5 pb-4 border-b dark:border-claude-darkBorder border-claude-border">
                  <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                    {coworkMemoryEditingId ? i18nService.t('coworkMemoryCrudUpdate') : i18nService.t('coworkMemoryCrudCreate')}
                  </h3>
                </div>

                <div className="px-5 py-4 space-y-4">
                  {coworkMemoryEditingId && (
                    <div className="rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('coworkMemoryEditingTag')}
                    </div>
                  )}
                  <textarea
                    value={coworkMemoryDraftText}
                    onChange={(event) => setCoworkMemoryDraftText(event.target.value)}
                    placeholder={i18nService.t('coworkMemoryCrudTextPlaceholder')}
                    autoFocus
                    className="min-h-[200px] w-full rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30"
                  />
                </div>

                <div className="flex justify-end space-x-2 px-5 pb-5">
                  <button
                    type="button"
                    onClick={resetCoworkMemoryEditor}
                    className="px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border transition-colors"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleSaveCoworkMemoryEntry(); }}
                    disabled={!coworkMemoryDraftText.trim() || coworkMemoryListLoading}
                    className="px-3 py-1.5 text-sm text-white bg-claude-accent hover:bg-claude-accentHover rounded-xl disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {coworkMemoryEditingId ? i18nService.t('save') : i18nService.t('coworkMemoryCrudCreate')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Settings; 
