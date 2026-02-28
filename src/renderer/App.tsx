import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import WindowTitleBar from './components/window/WindowTitleBar';
import { CoworkView } from './components/cowork';
import { SkillsView } from './components/skills';
import { ScheduledTasksView } from './components/scheduledTasks';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import { configService } from './services/config';
import { apiService } from './services/api';
import { themeService } from './services/theme';
import { coworkService } from './services/cowork';
import { scheduledTaskService } from './services/scheduledTask';
import { checkForAppUpdate, type AppUpdateInfo, type AppUpdateDownloadProgress, UPDATE_POLL_INTERVAL_MS } from './services/appUpdate';
import { defaultConfig } from './config';
import { setAvailableModels, setSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import type { ApiConfig } from './services/api';
import type { CoworkPermissionResult } from './types/cowork';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from './services/i18n';
import { matchesShortcut } from './services/shortcuts';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateModal from './components/update/AppUpdateModal';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  const [mainView, setMainView] = useState<'cowork' | 'skills' | 'scheduledTasks'>('cowork');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateModalState, setUpdateModalState] = useState<'info' | 'downloading' | 'installing' | 'error'>('info');
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const pendingPermission = pendingPermissions[0] ?? null;
  const isWindows = window.electron.platform === 'win32';

  // 初始化应用
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      try {
        // 标记平台，用于 CSS 条件样式（如 Windows 标题栏按钮区域留白）
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        // 初始化配置
        await configService.init();
        
        // 初始化主题
        themeService.initialize();

        // 初始化语言
        await i18nService.initialize();
        
        const config = await configService.getConfig();
        
        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        // 从 providers 配置中加载可用模型列表到 Redux
        const providerModels: { id: string; name: string; provider?: string; supportsImage?: boolean }[] = [];
        if (config.providers) {
          Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
            if (providerConfig.enabled && providerConfig.models) {
              providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
                providerModels.push({
                  id: model.id,
                  name: model.name,
                  provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
                  supportsImage: model.supportsImage ?? false,
                });
              });
            }
          });
        }
        const fallbackModels = config.model.availableModels.map(model => ({
          id: model.id,
          name: model.name,
          supportsImage: model.supportsImage ?? false,
        }));
        const resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        if (resolvedModels.length > 0) {
          dispatch(setAvailableModels(resolvedModels));
          const preferredModel = resolvedModels.find(model => model.id === config.model.defaultModel) ?? resolvedModels[0];
          dispatch(setSelectedModel(preferredModel));
        }
        
        // 初始化定时任务服务
        await scheduledTaskService.init();

        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
      }
    };

    initializeApp();
  }, []);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
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
    if (config.model.defaultModel === selectedModel.id) return;
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: selectedModel.id,
      },
    });
  }, [isInitialized, selectedModel?.id]);

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

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
    coworkService.clearSession();
    dispatch(clearSelection());
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('cowork:focus-input', {
        detail: { clear: shouldClearInput },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

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

  const handleShowLogin = useCallback(() => {
    showToast(i18nService.t('featureInDevelopment'));
  }, [showToast]);

  const runUpdateCheck = useCallback(async () => {
    try {
      const currentVersion = await window.electron.appInfo.getVersion();
      const nextUpdate = await checkForAppUpdate(currentVersion);
      setUpdateInfo(nextUpdate);
      if (!nextUpdate) {
        setShowUpdateModal(false);
      }
    } catch (error) {
      console.error('Failed to check app update:', error);
      setUpdateInfo(null);
      setShowUpdateModal(false);
    }
  }, []);

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
    setShowUpdateModal(true);
  }, [updateInfo]);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    // If the URL is a fallback page (not a direct file download), open in browser
    if (updateInfo.url.includes('#') || updateInfo.url.endsWith('/download-list')) {
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

    setUpdateModalState('downloading');
    setDownloadProgress(null);
    setUpdateError(null);

    const unsubscribe = window.electron.appUpdate.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      const downloadResult = await window.electron.appUpdate.download(updateInfo.url);
      unsubscribe();

      if (!downloadResult.success) {
        // If user cancelled, handleCancelDownload already set the state — don't overwrite
        if (downloadResult.error === 'Download cancelled') {
          return;
        }
        setUpdateModalState('error');
        setUpdateError(downloadResult.error || i18nService.t('updateDownloadFailed'));
        return;
      }

      setUpdateModalState('installing');
      const installResult = await window.electron.appUpdate.install(downloadResult.filePath!);

      if (!installResult.success) {
        setUpdateModalState('error');
        setUpdateError(installResult.error || i18nService.t('updateInstallFailed'));
      }
      // If successful, app will quit and relaunch
    } catch (error) {
      unsubscribe();
      const msg = error instanceof Error ? error.message : '';
      // If user cancelled, handleCancelDownload already set the state — don't overwrite
      if (msg === 'Download cancelled') {
        return;
      }
      setUpdateModalState('error');
      setUpdateError(msg || i18nService.t('updateDownloadFailed'));
    }
  }, [updateInfo, showToast]);

  const handleCancelDownload = useCallback(async () => {
    await window.electron.appUpdate.cancelDownload();
    setUpdateModalState('info');
    setDownloadProgress(null);
  }, []);

  const handleRetryUpdate = useCallback(() => {
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
  }, []);

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
      const allModels: { id: string; name: string; provider?: string; supportsImage?: boolean }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
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

  // 监听定时任务查看会话事件
  useEffect(() => {
    const handleViewSession = async (event: Event) => {
      const { sessionId } = (event as CustomEvent).detail;
      if (sessionId) {
        setMainView('cowork');
        await coworkService.loadSession(sessionId);
      }
    };
    window.addEventListener('scheduledTask:viewSession', handleViewSession);
    return () => window.removeEventListener('scheduledTask:viewSession', handleViewSession);
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    let cancelled = false;

    const checkUpdate = async () => {
      if (cancelled) return;
      await runUpdateCheck();
    };

    void checkUpdate();
    const timer = window.setInterval(() => {
      void checkUpdate();
    }, UPDATE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isInitialized, runUpdateCheck]);

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

  const isOverlayActive = showSettings || showUpdateModal || pendingPermissions.length > 0;
  const updateBadge = updateInfo ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <div className="draggable relative h-9 shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      <WindowTitleBar isOverlayActive={isOverlayActive} />
    </div>
  ) : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-claude-accent to-claude-accentHover flex items-center justify-center shadow-glow-accent animate-pulse">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="w-24 h-1 rounded-full bg-claude-accent/20 overflow-hidden">
              <div className="h-full w-1/2 rounded-full bg-claude-accent animate-shimmer" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium">{i18nService.t('loading')}</div>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium text-center">{initError}</div>
            <button
              onClick={() => handleShowSettings()}
              className="px-6 py-2.5 bg-claude-accent hover:bg-claude-accentHover text-white rounded-xl shadow-md transition-colors text-sm font-medium"
            >
              {i18nService.t('openSettings')}
            </button>
          </div>
          {showSettings && (
            <Settings
              onClose={handleCloseSettings}
              initialTab={settingsOptions.initialTab}
              notice={settingsOptions.notice}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
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
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          updateBadge={!isSidebarCollapsed ? updateBadge : null}
        />
        <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div className="h-full rounded-xl dark:bg-claude-darkBg bg-claude-bg overflow-hidden">
            {mainView === 'skills' ? (
              <SkillsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : (
              <CoworkView
                onRequestAppSettings={handleShowSettings}
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
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateInfo={updateInfo}
          onCancel={() => {
            if (updateModalState === 'info' || updateModalState === 'error') {
              setShowUpdateModal(false);
              setUpdateModalState('info');
              setUpdateError(null);
              setDownloadProgress(null);
            }
          }}
          onConfirm={handleConfirmUpdate}
          modalState={updateModalState}
          downloadProgress={downloadProgress}
          errorMessage={updateError}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
        />
      )}
      {permissionModal}
    </div>
  );
};

export default App; 
