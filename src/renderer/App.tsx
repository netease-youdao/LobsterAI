import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo,useRef, useState } from 'react';
import { useDispatch,useSelector } from 'react-redux';

import {
  APP_UPDATE_HEARTBEAT_INTERVAL_MS,
  APP_UPDATE_POLL_INTERVAL_MS,
  type AppUpdateInfo,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
} from '../shared/appUpdate/constants';
import AgentsView from './components/agent/AgentsView';
import { CoworkView } from './components/cowork';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import EngineStartupOverlay from './components/cowork/EngineStartupOverlay';
import { McpView } from './components/mcp';
import PrivacyDialog from './components/PrivacyDialog';
import { ScheduledTasksView } from './components/scheduledTasks';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import { SkillsView } from './components/skills';
import Toast from './components/Toast';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateModal from './components/update/AppUpdateModal';
import WelcomeDialog from './components/WelcomeDialog';
import WindowTitleBar from './components/window/WindowTitleBar';
import { defaultConfig, getProviderDisplayName } from './config';
import type { ApiConfig } from './services/api';
import { apiService } from './services/api';
import { authService } from './services/auth';
import { configService } from './services/config';
import { coworkService } from './services/cowork';
import { i18nService } from './services/i18n';
import { scheduledTaskService } from './services/scheduledTask';
import { matchesShortcut } from './services/shortcuts';
import { themeService } from './services/theme';
import { RootState, store } from './store';
import {
  selectCurrentSessionId,
  selectFirstPendingPermission,
} from './store/selectors/coworkSelectors';
import { setDraftPrompt } from './store/slices/coworkSlice';
import { setAvailableModels, setSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import type { CoworkPermissionResult } from './types/cowork';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  const [mainView, setMainView] = useState<'cowork' | 'skills' | 'scheduledTasks' | 'mcp' | 'agents'>('cowork');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateRuntimeState>({
    status: AppUpdateStatus.Idle,
    source: null,
    info: null,
    progress: null,
    readyFilePath: null,
    readyFileHash: null,
    errorMessage: null,
  });
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState<boolean | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [enterpriseConfig, setEnterpriseConfig] = useState<{
    ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
    disableUpdate?: boolean;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const previousUpdateStatusRef = useRef<AppUpdateRuntimeState['status']>(AppUpdateStatus.Idle);
  const shouldInstallReadyUpdateRef = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const pendingPermission = useSelector(selectFirstPendingPermission);
  const authUser = useSelector((state: RootState) => state.auth.user);
  const isWindows = window.electron.platform === 'win32';

  const waitWithTimeout = useCallback(
    async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            window.clearTimeout(timer);
            reject(error);
          }
        );
      });
    },
    []
  );

  // 初始化应用
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      try {
        console.info('[App] initializeApp: start');
        // 标记平台，用于 CSS 条件样式（如 Windows 标题栏按钮区域留白）
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        // 初始化配置
        console.info('[App] initializeApp: configService.init');
        await waitWithTimeout(configService.init(), 5000, 'configService.init');

        // Load enterprise config if present
        const entConfig = await window.electron.enterprise.getConfig();
        setEnterpriseConfig(entConfig);

        // 初始化主题
        console.info('[App] initializeApp: themeService.initialize');
        themeService.initialize();

        // 初始化语言
        console.info('[App] initializeApp: i18nService.initialize');
        await waitWithTimeout(i18nService.initialize(), 5000, 'i18nService.initialize');

        // 初始化认证服务（恢复登录状态）
        console.info('[App] initializeApp: authService.init');
        await authService.init();

        console.info('[App] initializeApp: configService.getConfig');
        const config = await configService.getConfig();
        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        // 从 providers 配置中加载可用模型列表到 Redux
        const providerModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[] = [];
        if (config.providers) {
          Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
            if (providerConfig.enabled && providerConfig.models) {
              providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
                providerModels.push({
                  id: model.id,
                  name: model.name,
                  provider: getProviderDisplayName(providerName, providerConfig),
                  providerKey: providerName,
                  supportsImage: model.supportsImage ?? false,
                });
              });
            }
          });
        }
        const fallbackModels = config.model.availableModels.map(model => ({
          id: model.id,
          name: model.name,
          providerKey: undefined,
          supportsImage: model.supportsImage ?? false,
        }));
        const resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        if (resolvedModels.length > 0) {
          dispatch(setAvailableModels(resolvedModels));
          // Search all available models (including server models loaded by authService)
          // so that a previously selected server model is correctly restored.
          const allModels = store.getState().model.availableModels;
          const preferredModel = allModels.find(
            model => model.id === config.model.defaultModel
              && (!config.model.defaultModelProvider || model.providerKey === config.model.defaultModelProvider)
          ) ?? allModels[0];
          dispatch(setSelectedModel(preferredModel));
        }

        // 检查隐私协议是否已同意（必须在 setIsInitialized 之前）
        const agreed = await window.electron.store.get('privacy_agreed');
        setPrivacyAgreed(agreed === true);

        setIsInitialized(true);
        console.info('[App] initializeApp: shell ready');


        // 初始化定时任务服务，但不阻塞首屏
        void waitWithTimeout(scheduledTaskService.init(), 5000, 'scheduledTaskService.init').catch((error) => {
          console.error('[App] initializeApp: scheduledTaskService.init failed:', error);
        });

      } catch (error) {
        console.error('Failed to initialize app:', error);
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
      }
    };

    void initializeApp();
  }, [dispatch, waitWithTimeout]);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Listen for Copilot token auto-refresh events from the main process
  useEffect(() => {
    const removeListener = window.electron.githubCopilot.onTokenUpdated(({ token, baseUrl }) => {
      console.log('[App] received Copilot token update from main process');
      const currentConfig = configService.getConfig();
      const copilotProvider = currentConfig.providers?.['github-copilot'];
      if (copilotProvider) {
        void configService.updateConfig({
          providers: {
            ...currentConfig.providers,
            'github-copilot': {
              ...copilotProvider,
              apiKey: token,
              ...(baseUrl ? { baseUrl } : {}),
            },
          },
        } as Partial<typeof currentConfig>);
      }
    });
    return removeListener;
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Renderer] Network online');
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      console.log('[Renderer] Network offline');
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isInitialized || !selectedModel?.id) return;
    const config = configService.getConfig();
    if (
      config.model.defaultModel === selectedModel.id
      && (config.model.defaultModelProvider ?? '') === (selectedModel.providerKey ?? '')
    ) {
      return;
    }
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: selectedModel.id,
        defaultModelProvider: selectedModel.providerKey,
      },
    });
  }, [isInitialized, selectedModel?.id, selectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions({
      initialTab: options?.initialTab,
      notice: options?.notice,
    });
    setShowSettings(true);
  }, []);

  const handleShowSkills = useCallback(() => {
    setMainView('skills');
  }, []);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const handleShowScheduledTasks = useCallback(() => {
    setMainView('scheduledTasks');
  }, []);

  const handleShowMcp = useCallback(() => {
    setMainView('mcp');
  }, []);

  const handleShowAgents = useCallback(() => {
    setMainView('agents');
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    // Only clear when already on home (no session) — preserve __home__ draft when returning from a session
    const shouldClearInput = mainView === 'cowork' && !currentSessionId;
    coworkService.clearSession();
    dispatch(clearSelection());
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('cowork:focus-input', {
        detail: { clear: shouldClearInput },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const handleCreateSkillByChat = useCallback(() => {
    dispatch(setDraftPrompt({ sessionId: '__home__', draft: i18nService.t('skillCreatorPrompt') }));
    coworkService.clearSession();
    dispatch(clearSelection());
    setMainView('cowork');
  }, [dispatch]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadInitialUpdateState = async () => {
      try {
        const state = await window.electron.appUpdate.getState();
        if (mounted) {
          setAppUpdateState(state);
          previousUpdateStatusRef.current = state.status;
        }
      } catch (error) {
        console.error('[App] failed to load initial app update state:', error);
      }
    };

    void loadInitialUpdateState();

    const unsubscribe = window.electron.appUpdate.onStateChanged((state) => {
      const previousStatus = previousUpdateStatusRef.current;
      previousUpdateStatusRef.current = state.status;
      setAppUpdateState(state);

      if (state.status === AppUpdateStatus.Ready && previousStatus !== AppUpdateStatus.Ready) {
        if (shouldInstallReadyUpdateRef.current && state.readyFilePath) {
          shouldInstallReadyUpdateRef.current = false;
          void window.electron.appUpdate.installReady().then((installResult) => {
            if (!installResult.success) {
              showToast(installResult.error || i18nService.t('updateInstallFailed'));
            }
          });
        }
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleShowLogin = useCallback(() => {
    showToast(i18nService.t('featureInDevelopment'));
  }, [showToast]);

  const runUpdateCheck = useCallback(async () => {
    try {
      const result = await window.electron.appUpdate.checkNow({ userId: authUser?.yid });
      setAppUpdateState(result.state);
      if (!result.success) {
        console.error('[App] app update check failed:', result.error);
      }
    } catch (error) {
      console.error('Failed to check app update:', error);
    }
  }, [authUser]);

  const updateInfo = appUpdateState.info;

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;
    setShowUpdateModal(true);
  }, [updateInfo]);

  const handleUpdateFound = useCallback((_info: AppUpdateInfo) => {
    setShowUpdateModal(true);
  }, []);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    if (appUpdateState.readyFilePath) {
      shouldInstallReadyUpdateRef.current = false;
      const installResult = await window.electron.appUpdate.installReady();
      if (!installResult.success) {
        showToast(installResult.error || i18nService.t('updateInstallFailed'));
      }
      return;
    }

    if (appUpdateState.status === AppUpdateStatus.Error || appUpdateState.status === AppUpdateStatus.Available) {
      const isManualUrl = updateInfo.url.includes('#') || updateInfo.url.endsWith('/download-list');
      if (!isManualUrl) {
        shouldInstallReadyUpdateRef.current = appUpdateState.status === AppUpdateStatus.Available;
        const retryResult = await window.electron.appUpdate.retryDownload();
        if (!retryResult.success) {
          shouldInstallReadyUpdateRef.current = false;
          showToast(i18nService.t('updateDownloadFailed'));
        }
        return;
      }
    }

    if (updateInfo.url.includes('#') || updateInfo.url.endsWith('/download-list')) {
      shouldInstallReadyUpdateRef.current = false;
      setShowUpdateModal(false);
      try {
        const result = await window.electron.shell.openExternal(updateInfo.url);
        if (!result.success) {
          showToast(i18nService.t('updateOpenFailed'));
        }
      } catch (error) {
        console.error('Failed to open update url:', error);
        showToast(i18nService.t('updateOpenFailed'));
      }
      return;
    }
  }, [appUpdateState.readyFilePath, appUpdateState.status, showToast, updateInfo]);

  const handleCancelDownload = useCallback(async () => {
    shouldInstallReadyUpdateRef.current = false;
    await window.electron.appUpdate.cancelDownload();
  }, []);

  const handleRetryUpdate = useCallback(async () => {
    if (!updateInfo) return;
    if (updateInfo.url.includes('#') || updateInfo.url.endsWith('/download-list')) {
      shouldInstallReadyUpdateRef.current = false;
      setShowUpdateModal(false);
      await window.electron.shell.openExternal(updateInfo.url);
      return;
    }
    shouldInstallReadyUpdateRef.current = false;
    await window.electron.appUpdate.retryDownload();
  }, [updateInfo]);

  const handlePrivacyAccept = useCallback(async () => {
    await window.electron.store.set('privacy_agreed', true);
    setPrivacyAgreed(true);
    setShowWelcome(true);
  }, []);

  const handlePrivacyReject = useCallback(() => {
    // 立刻隐藏窗口，让用户感觉立即关闭
    window.electron.window.close();
  }, []);

  const handleWelcomeClose = useCallback(() => setShowWelcome(false), []);
  const handleWelcomeLogin = useCallback(async () => {
    setShowWelcome(false);
    await authService.login();
  }, []);
  const handleWelcomeCustomModel = useCallback(() => {
    setShowWelcome(false);
    handleShowSettings({ initialTab: 'model' });
  }, [handleShowSettings]);

  const handlePermissionResponse = useCallback(async (result: CoworkPermissionResult) => {
    if (!pendingPermission) return;
    await coworkService.respondToPermission(pendingPermission.requestId, result);
  }, [pendingPermission]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: getProviderDisplayName(providerName, providerConfig),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
      if (allModels.length > 0) {
        dispatch(setAvailableModels(allModels));
      }
    }
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      if (matchesShortcut(event, activeShortcuts.newChat)) {
        event.preventDefault();
        handleNewChat();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.search)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:search'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.settings)) {
        event.preventDefault();
        handleShowSettings();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleShowSettings, handleNewChat]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      if (message) showToast(message);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // 监听托盘菜单打开设置的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:openSettings', () => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // 监听托盘菜单新建任务的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:newTask', () => {
      handleNewChat();
    });
    return unsubscribe;
  }, [handleNewChat]);

  useEffect(() => {
    if (!isInitialized) return;

    // Enterprise mode: completely skip update detection
    if (enterpriseConfig?.disableUpdate) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async (reason: 'startup' | 'heartbeat' | 'visibility') => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < APP_UPDATE_POLL_INTERVAL_MS) return;
      lastCheckTime = now;
      console.log(`[App] auto update check triggered, reason=${reason}, at=${new Date(now).toISOString()}`);
      await runUpdateCheck();
    };

    // 启动时立即检查
    void maybeCheck('startup');

    // 心跳：每 30 分钟检测是否距上次检查已超过 12 小时
    const timer = window.setInterval(() => {
      void maybeCheck('heartbeat');
    }, APP_UPDATE_HEARTBEAT_INTERVAL_MS);

    // 窗口恢复可见时检测（覆盖休眠唤醒场景）
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeCheck('visibility');
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, runUpdateCheck, enterpriseConfig]);

  // 根据场景选择使用哪个权限组件
  const permissionModal = useMemo(() => {
    if (!pendingPermission) return null;

    // 检查是否为 AskUserQuestion 且有多个问题 -> 使用向导式组件
    const isQuestionTool = pendingPermission.toolName === 'AskUserQuestion';
    if (isQuestionTool && pendingPermission.toolInput) {
      const rawQuestions = (pendingPermission.toolInput as Record<string, unknown>).questions;
      const hasMultipleQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 1;

      if (hasMultipleQuestions) {
        return (
          <CoworkQuestionWizard
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
          />
        );
      }
    }

    // 其他情况使用原有的权限模态框
    return (
      <CoworkPermissionModal
        permission={pendingPermission}
        onRespond={handlePermissionResponse}
      />
    );
  }, [pendingPermission, handlePermissionResponse]);

  const isOverlayActive = showSettings || showUpdateModal || pendingPermission !== null;
  const shouldShowUpdateBadge =
    updateInfo &&
    appUpdateState.status !== AppUpdateStatus.Checking &&
    appUpdateState.status !== AppUpdateStatus.Downloading;
  const updateBadge = shouldShowUpdateBadge ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      status={appUpdateState.status}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <div className="draggable relative h-9 shrink-0 bg-surface-raised">
      <WindowTitleBar isOverlayActive={isOverlayActive} />
    </div>
  ) : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex items-center justify-center bg-background">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center shadow-glow-accent animate-pulse">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="w-24 h-1 rounded-full bg-primary/20 overflow-hidden">
              <div className="h-full w-1/2 rounded-full bg-primary animate-shimmer" />
            </div>
            <div className="text-foreground text-xl font-medium">{i18nService.t('loading')}</div>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center bg-background">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="text-foreground text-xl font-medium text-center">{initError}</div>
            <button
              onClick={() => handleShowSettings()}
              className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl shadow-md transition-colors text-sm font-medium"
            >
              {i18nService.t('openSettings')}
            </button>
          </div>
          {showSettings && (
            <Settings
              onClose={handleCloseSettings}
              initialTab={settingsOptions.initialTab}
              notice={settingsOptions.notice}
              onUpdateFound={handleUpdateFound}
              enterpriseConfig={enterpriseConfig}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-surface-raised">
      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          onShowLogin={handleShowLogin}
          onShowSettings={handleShowSettings}
          activeView={mainView}
          onShowSkills={handleShowSkills}
          onShowCowork={handleShowCowork}
          onShowScheduledTasks={handleShowScheduledTasks}
          onShowMcp={handleShowMcp}
          onShowAgents={handleShowAgents}
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          updateBadge={!isSidebarCollapsed ? updateBadge : null}
          hideLogin={enterpriseConfig?.ui?.login === 'hide'}
        />
        <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div className="relative h-full min-h-0 rounded-xl bg-background overflow-hidden">
            <EngineStartupOverlay />
            {mainView === 'skills' ? (
              <SkillsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                onCreateSkillByChat={handleCreateSkillByChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                readOnly={enterpriseConfig?.ui?.skills === 'readonly'}
              />
            ) : mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'mcp' ? (
              <McpView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'agents' ? (
              <AgentsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                onShowCowork={handleShowCowork}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : (
              <CoworkView
                onRequestAppSettings={privacyAgreed === true && !showWelcome ? handleShowSettings : undefined}
                onShowSkills={handleShowSkills}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            )}
          </div>
        </div>
      </div>

      {/* 设置窗口显示在所有主内容之上，但不影响主界面的交互 */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          initialTab={settingsOptions.initialTab}
          notice={settingsOptions.notice}
          onUpdateFound={handleUpdateFound}
          enterpriseConfig={enterpriseConfig}
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateState={appUpdateState}
          onCancel={() => {
            if (appUpdateState.status !== AppUpdateStatus.Downloading && appUpdateState.status !== AppUpdateStatus.Installing) {
              setShowUpdateModal(false);
            }
          }}
          onConfirm={handleConfirmUpdate}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
        />
      )}
      {permissionModal}
      {privacyAgreed === false && (
        <PrivacyDialog
          onAccept={handlePrivacyAccept}
          onReject={handlePrivacyReject}
        />
      )}
      {showWelcome && (
        <WelcomeDialog
          onLogin={handleWelcomeLogin}
          onCustomModel={handleWelcomeCustomModel}
          onClose={handleWelcomeClose}
        />
      )}
    </div>
  );
};

export default App; 
