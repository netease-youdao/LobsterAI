import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo,useRef, useState } from 'react';
import { useDispatch,useSelector } from 'react-redux';

import {
  APP_UPDATE_HEARTBEAT_INTERVAL_MS,
  APP_UPDATE_POLL_INTERVAL_MS,
  type AppUpdateInfo,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
  isManualDownloadUrl,
} from '../shared/appUpdate/constants';
import {
  LibraryNavigationEvent,
  LibrarySourceFilter,
} from '../shared/library/constants';
import type { LibrarySessionRef } from '../shared/library/types';
import { OpenClawEnginePhase } from '../shared/openclawEngine/constants';
import { ProviderAuthType, ProviderName, ProviderRegistry } from '../shared/providers';
import { SIDEBAR_TASK_FILTER_ENABLED } from './components/agentSidebar/SidebarTaskFilterButton';
import { CoworkView } from './components/cowork';
import {
  CoworkShortcutDirection,
  type CoworkTaskSearchRequestEventDetail,
  CoworkTaskSearchRequestSource,
  CoworkUiEvent,
} from './components/cowork/constants';
import {
  ConversationSearchShortcutTarget,
  resolveConversationSearchShortcutTarget,
} from './components/cowork/conversationSearchShortcut';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import EngineFailureOverlay from './components/cowork/EngineFailureOverlay';
import EngineStartupOverlay from './components/cowork/EngineStartupOverlay';
import KitsView from './components/kits/KitsView';
import LibraryView from './components/library/LibraryView';
import NewUserOnboardingOverlay, {
  NewUserOnboardingStep,
  type NewUserOnboardingStep as NewUserOnboardingStepType,
} from './components/NewUserOnboardingOverlay';
import { ScheduledTasksView } from './components/scheduledTasks';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import { SkillsAndConnectorsView, SkillsConnectorsSection } from './components/skillsAndConnectors';
import SkinBackdrop, { SkinBackdropVariant } from './components/skin/SkinBackdrop';
import SkinPresentationScope from './components/skin/SkinPresentationScope';
import StartupCreditCampaign from './components/StartupCreditCampaign';
import Toast, { type ToastEventDetail } from './components/Toast';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateBlockingPanel from './components/update/AppUpdateBlockingPanel';
import AppUpdateCard from './components/update/AppUpdateCard';
import { formatAppUpdateError } from './components/update/appUpdateErrorText';
import AppUpdateInstallConfirmDialog from './components/update/AppUpdateInstallConfirmDialog';
import AppUpdateInteractionOverlay from './components/update/AppUpdateInteractionOverlay';
import {
  isAppUpdateInteractionBlockingStatus,
  shouldBlockAppInteractionForUpdate,
} from './components/update/appUpdateInteractionState';
import AppUpdateModal from './components/update/AppUpdateModal';
import { shouldShowAppUpdateNotice } from './components/update/appUpdateNoticeState';
import WindowsAppTitleBar from './components/window/WindowsAppTitleBar';
import { defaultConfig, getProviderDisplayName, ShortcutAction } from './config';
import { selectIsEnterpriseAccount } from './features/enterpriseAccount/selectors';
import { SkinProvider } from './providers/SkinProvider';
import type { ApiConfig } from './services/api';
import { apiService } from './services/api';
import { authService } from './services/auth';
import { configService } from './services/config';
import { coworkService } from './services/cowork';
import { i18nService } from './services/i18n';
import {
  beginLatestAsyncRequest,
  invalidateLatestAsyncRequest,
  isLatestAsyncRequest,
} from './services/latestAsyncRequest';
import { LogReporterAction, reportYdAnalyzer } from './services/logReporter';
import { getOnboardingErrorCode, reportOnboardingAction } from './services/onboardingAnalytics';
import { scheduledTaskService } from './services/scheduledTask';
import { isTextEditingSafeShortcut, matchesShortcut } from './services/shortcuts';
import { themeService } from './services/theme';
import { applyTypographyPreferences } from './services/typography';
import { RootState, store } from './store';
import {
  selectCurrentSessionId,
  selectFirstCurrentSessionPendingPermission,
  selectHasRunningCoworkSessions,
  selectPendingPermissions,
} from './store/selectors/coworkSelectors';
import { openArtifactPreviewTab } from './store/slices/artifactSlice';
import {
  clearDraftAttachments,
  clearDraftSelectedTextSnippets,
  setDraftCollaborationMode,
  setDraftKitIds,
  setDraftPrompt,
  setDraftSkillIds,
} from './store/slices/coworkSlice';
import { setActiveKitIds } from './store/slices/kitSlice';
import { setAvailableModels, setDefaultSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import { setActiveSkillIds } from './store/slices/skillSlice';
import { CoworkCollaborationMode, type CoworkPermissionResult } from './types/cowork';

const AGENT_TASK_SLOT_SHORTCUT_ACTIONS = [
  ShortcutAction.OpenAgentTask1,
  ShortcutAction.OpenAgentTask2,
  ShortcutAction.OpenAgentTask3,
  ShortcutAction.OpenAgentTask4,
  ShortcutAction.OpenAgentTask5,
  ShortcutAction.OpenAgentTask6,
  ShortcutAction.OpenAgentTask7,
  ShortcutAction.OpenAgentTask8,
  ShortcutAction.OpenAgentTask9,
] as const;

const NEW_USER_WELCOME_AFTER_LOGIN_STORAGE_KEY = 'lobsterai:newUserWelcomeAfterLogin';
const NEW_USER_WELCOME_AFTER_LOGIN_RESTART_GRACE_MS = 1800;
const NEW_USER_WELCOME_AFTER_LOGIN_ENGINE_SETTLE_MS = 700;
const NEW_USER_WELCOME_UNAUTHENTICATED_RETURN_DELAY_MS = 600;
const NEW_USER_WELCOME_AUTH_CALLBACK_SUPPRESSION_MS = 5000;

const setNewUserWelcomeAfterLoginPending = (): void => {
  try {
    window.localStorage.setItem(NEW_USER_WELCOME_AFTER_LOGIN_STORAGE_KEY, String(Date.now()));
  } catch {
    // Best-effort only; the login flow can still succeed without this handoff marker.
  }
};

const getNewUserWelcomeAfterLoginPendingAgeMs = (): number | null => {
  try {
    const rawValue = window.localStorage.getItem(NEW_USER_WELCOME_AFTER_LOGIN_STORAGE_KEY);
    if (!rawValue) return null;
    const startedAt = Number(rawValue);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(Date.now() - startedAt, 0);
  } catch {
    return null;
  }
};

const hasNewUserWelcomeAfterLoginPending = (): boolean => (
  getNewUserWelcomeAfterLoginPendingAgeMs() !== null
);

const consumeNewUserWelcomeAfterLoginPending = (): boolean => {
  try {
    if (!hasNewUserWelcomeAfterLoginPending()) {
      return false;
    }
    window.localStorage.removeItem(NEW_USER_WELCOME_AFTER_LOGIN_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};

const SETTINGS_TAB_SHORTCUT_ACTIONS: Array<{
  action: ShortcutAction;
  initialTab: NonNullable<SettingsOpenOptions['initialTab']>;
}> = [
  { action: ShortcutAction.OpenSettingsGeneral, initialTab: 'general' },
  { action: ShortcutAction.OpenSettingsAppearance, initialTab: 'appearance' },
  { action: ShortcutAction.OpenSettingsAgentEngine, initialTab: 'coworkAgentEngine' },
  { action: ShortcutAction.OpenSettingsModel, initialTab: 'model' },
  { action: ShortcutAction.OpenSettingsIm, initialTab: 'im' },
  { action: ShortcutAction.OpenSettingsBrowser, initialTab: 'browserWebAccess' },
  { action: ShortcutAction.OpenSettingsEmail, initialTab: 'email' },
  { action: ShortcutAction.OpenSettingsMemory, initialTab: 'coworkMemory' },
  { action: ShortcutAction.OpenSettingsDreaming, initialTab: 'coworkDreaming' },
  { action: ShortcutAction.OpenSettingsPlugins, initialTab: 'plugins' },
  { action: ShortcutAction.OpenSettingsAbout, initialTab: 'about' },
];

type NewUserOnboardingCompletionSource = 'skip' | 'next' | 'start_experience';

/** Used for config + i18n init; longer on Windows where main-process IPC can stall during cold start. */
const INIT_STEP_TIMEOUT_MS_WINDOWS = 24_000;
const INIT_STEP_TIMEOUT_MS_DEFAULT = 16_000;
/** Field evidence (2026-08): early renderer↔main invokes can stall ~25-30s and
 * then recover, so retries with fresh invokes rescue startup where a single
 * long timeout cannot. */
const INIT_STEP_RETRY_TIMEOUT_MS = 8_000;
const INIT_CONFIG_MAX_ATTEMPTS = 3;
const INIT_AUTO_RETRY_DELAY_MS = 8_000;
const INIT_AUTO_RETRY_MAX = 2;
const INIT_CONFIG_REPAIR_DELAY_MS = 15_000;
const INIT_CONFIG_REPAIR_MAX = 4;
const INIT_REQUIRED_GATE_MAX_ATTEMPTS = 2;

export const InitPassMode = {
  Startup: 'startup',
  Retry: 'retry',
  Repair: 'repair',
} as const;
export type InitPassMode = typeof InitPassMode[keyof typeof InitPassMode];

const logAppUpdateRendererLifecycle = (
  message: string,
  level: 'debug' | 'warn' = 'debug',
): void => {
  if (level === 'warn') {
    console.warn(`[AppUpdate] ${message}`);
  } else {
    console.debug(`[AppUpdate] ${message}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'AppUpdate', message);
  } catch {
    // Best-effort diagnostic only.
  }
};

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions & { requestId: number }>({ requestId: 0 });
  const [mainView, setMainView] = useState<'cowork' | 'skills' | 'scheduledTasks' | 'kits' | 'mcp' | 'library'>('cowork');
  const [libraryNavigationRequest, setLibraryNavigationRequest] = useState<{
    source: LibrarySourceFilter;
    requestId: number;
  }>({
    source: LibrarySourceFilter.Local,
    requestId: 0,
  });
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<ToastEventDetail | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isTaskFilterActive, setIsTaskFilterActive] = useState(false);
  const [hasUnreadCompletedTasks, setHasUnreadCompletedTasks] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(244);
  const initialOpenClawEngineStatusRef = useRef(coworkService.getOpenClawEngineStatusSnapshot());
  const [isEngineStartupOverlayVisible, setIsEngineStartupOverlayVisible] = useState(
    () => initialOpenClawEngineStatusRef.current?.phase === OpenClawEnginePhase.Starting,
  );
  const [hasResolvedEngineStartupOverlayState, setHasResolvedEngineStartupOverlayState] = useState(
    () => initialOpenClawEngineStatusRef.current !== null,
  );
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
  const [showUpdateInstallConfirm, setShowUpdateInstallConfirm] = useState(false);
  const [isUpdateCardExpanded, setIsUpdateCardExpanded] = useState(false);
  const [isUserInitiatedUpdateFlowActive, setIsUserInitiatedUpdateFlowActive] = useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState<boolean | null>(null);
  const [newUserOnboardingStep, setNewUserOnboardingStep] =
    useState<NewUserOnboardingStepType>(NewUserOnboardingStep.NewTask);
  const [isNewUserOnboardingDismissed, setIsNewUserOnboardingDismissed] = useState(false);
  const [newUserWelcomeAfterLoginSignal, setNewUserWelcomeAfterLoginSignal] = useState(0);
  const [enterpriseConfig, setEnterpriseConfig] = useState<{
    ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
    disableUpdate?: boolean;
  } | null>(null);
  const [enterpriseConfigLoaded, setEnterpriseConfigLoaded] = useState(false);
  const toastTimerRef = useRef<number | null>(null);
  const askAiFocusTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const hasReportedAppStartedRef = useRef(false);
  const initPassRunningRef = useRef(false);
  const initRetryTimerRef = useRef<number | null>(null);
  const initAutoRetryCountRef = useRef(0);
  const initRepairCountRef = useRef(0);
  const requiredStartupGatesReadyRef = useRef(false);
  const coreStartupServicesInitializedRef = useRef(false);
  const enterpriseGateRequestIdRef = useRef(0);
  const privacyGateRequestIdRef = useRef(0);
  const pendingNewUserWelcomeAfterLoginSawStartupRef = useRef(false);
  const pendingNewUserWelcomeAfterLoginWaitingLoggedRef = useRef(false);
  const pendingNewUserWelcomeAuthCallbackAtRef = useRef(0);
  const isUserInitiatedUpdateFlowActiveRef = useRef(false);
  const dispatch = useDispatch();
  const defaultSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const pendingPermission = useSelector(selectFirstCurrentSessionPendingPermission);
  const pendingPermissions = useSelector(selectPendingPermissions);
  const authUser = useSelector((state: RootState) => state.auth.user);
  const isEnterpriseAccount = useSelector(selectIsEnterpriseAccount);
  const isWindows = window.electron.platform === 'win32';
  const [minimizedPermissionIds, setMinimizedPermissionIds] = useState<string[]>([]);
  const isPendingPermissionMinimized = pendingPermission
    ? minimizedPermissionIds.includes(pendingPermission.requestId)
    : false;
  const isPermissionModalOpen = pendingPermission !== null && !isPendingPermissionMinimized;
  const isUpdateInteractionBlocked = shouldBlockAppInteractionForUpdate(
    isUserInitiatedUpdateFlowActive,
    appUpdateState.status,
  );
  const shouldShowNewUserOnboarding =
    privacyAgreed === false
    && !isNewUserOnboardingDismissed
    && hasResolvedEngineStartupOverlayState
    && !isEngineStartupOverlayVisible
    && !isUpdateInteractionBlocked;

  useEffect(() => {
    if (!shouldShowNewUserOnboarding) return;
    console.log(`[Onboarding] showing new user onboarding step=${newUserOnboardingStep}`);
    reportOnboardingAction('guide_exposure', {
      source: 'first_run_gate',
      step: newUserOnboardingStep,
    });
    setMainView('cowork');
    setIsSidebarCollapsed(false);
  }, [newUserOnboardingStep, shouldShowNewUserOnboarding]);

  useEffect(() => {
    let isCurrent = true;
    const resolveOverlayVisible = (phase?: string | null) =>
      phase === OpenClawEnginePhase.Starting;

    coworkService.getOpenClawEngineStatus()
      .then((status) => {
        if (!isCurrent) return;
        setIsEngineStartupOverlayVisible(resolveOverlayVisible(status?.phase));
        setHasResolvedEngineStartupOverlayState(true);
      })
      .catch((error) => {
        console.debug('[App] failed to refresh OpenClaw engine status for sidebar promo timing:', error);
        if (isCurrent) {
          setHasResolvedEngineStartupOverlayState(true);
        }
      });

    const unsubscribe = coworkService.onOpenClawEngineStatus((status) => {
      setIsEngineStartupOverlayVisible(resolveOverlayVisible(status.phase));
      setHasResolvedEngineStartupOverlayState(true);
    });

    return () => {
      isCurrent = false;
      unsubscribe();
    };
  }, []);

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
  const applyConfigToApp = useCallback((log?: (label: string) => void) => {
    const config = configService.getConfig();
    applyTypographyPreferences(config);
    const apiConfig: ApiConfig = {
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    };
    apiService.setConfig(apiConfig);

    const providerModels: { id: string; name: string; provider?: string; providerKey?: string; openClawProviderId?: string; supportsImage?: boolean }[] = [];
    if (config.providers) {
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          const openClawProviderId = ProviderRegistry.getOpenClawProviderIdForConfig(providerName, providerConfig);
          if (providerName === ProviderName.Minimax && providerConfig.authType === ProviderAuthType.OAuth) {
            log?.('MiniMax OAuth provider resolved to OpenClaw minimax-portal');
          }
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
            providerModels.push({
              id: model.id,
              name: model.name,
              provider: getProviderDisplayName(providerName, providerConfig),
              providerKey: providerName,
              openClawProviderId,
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
    }
    dispatch(setAvailableModels(providerModels));
    if (providerModels.length > 0) {
      const allModels = store.getState().model.availableModels;
      const preferredModel = allModels.find(
        model => model.id === config.model.defaultModel
          && (!config.model.defaultModelProvider || model.providerKey === config.model.defaultModelProvider)
      ) ?? allModels[0];
      dispatch(setDefaultSelectedModel(preferredModel));
    }
    return providerModels;
  }, [dispatch]);

  const runInitPassRef = useRef<(mode: InitPassMode) => void>(() => {});

  const runInitPass = useCallback(async (mode: InitPassMode): Promise<void> => {
    if (initPassRunningRef.current) {
      return;
    }
    initPassRunningRef.current = true;
    if (initRetryTimerRef.current !== null) {
      window.clearTimeout(initRetryTimerRef.current);
      initRetryTimerRef.current = null;
    }

    const t0 = performance.now();
    const log = (level: 'info' | 'error', label: string) => {
      const elapsed = Math.round(performance.now() - t0);
      const msg = `initializeApp: ${label} (+${elapsed}ms)`;
      if (level === 'error') {
        console.error(`[App] ${msg}`);
      } else {
        console.info(`[App] ${msg}`);
      }
      try { window.electron?.log?.fromRenderer?.(level, 'App', msg); } catch { /* preload may not expose this yet */ }
    };
    const mark = (label: string) => log('info', label);
    const markError = (label: string) => log('error', label);

    const scheduleNextPass = (nextMode: InitPassMode, delayMs: number) => {
      initRetryTimerRef.current = window.setTimeout(() => {
        initRetryTimerRef.current = null;
        runInitPassRef.current(nextMode);
      }, delayMs);
    };

    // Runs one init step; retries issue a FRESH invoke because a timed-out
    // promise is left running (its late completion must stay harmless).
    const runStep = async (
      label: string,
      run: () => Promise<unknown>,
      opts: { attempts: number; firstTimeoutMs: number },
    ): Promise<boolean> => {
      for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        const timeoutMs = attempt === 1 ? opts.firstTimeoutMs : INIT_STEP_RETRY_TIMEOUT_MS;
        try {
          await waitWithTimeout(run(), timeoutMs, label);
          if (attempt > 1) {
            mark(`${label} recovered on attempt ${attempt}`);
          }
          return true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          markError(`${label} attempt ${attempt}/${opts.attempts} failed: ${msg}`);
        }
      }
      return false;
    };

    const finishShell = (providerModelCount: number, readyLabel: string) => {
      if (!requiredStartupGatesReadyRef.current) {
        throw new Error('Required privacy and enterprise startup gates are unresolved.');
      }
      setIsInitialized(true);
      setInitError(null);
      mark(readyLabel);
      if (!hasReportedAppStartedRef.current) {
        hasReportedAppStartedRef.current = true;
        void reportYdAnalyzer({
          action: LogReporterAction.AppStarted,
          providerModelCount,
          hasLoggedInUser: !!store.getState().auth.user?.yid,
        });
      }
    };

    try {
      mark(`start (mode=${mode})`);
      document.documentElement.classList.add(`platform-${window.electron.platform}`);

      const initTimeoutMs =
        window.electron.platform === 'win32'
          ? INIT_STEP_TIMEOUT_MS_WINDOWS
          : INIT_STEP_TIMEOUT_MS_DEFAULT;
      const isRepair = mode === InitPassMode.Repair;

      // Privacy consent and enterprise UI policy are authorization gates, not
      // optional startup data. Resolve them before any degraded/default-config
      // path can expose the application shell. Both calls run in parallel and
      // use fresh IPC invokes on retry to recover from an early renderer/main
      // handshake stall.
      if (!requiredStartupGatesReadyRef.current) {
        const [enterpriseReady, privacyReady] = await Promise.all([
          runStep('enterprise.getConfig', async () => {
            const requestId = beginLatestAsyncRequest(enterpriseGateRequestIdRef);
            const result = await window.electron.enterprise.getConfig();
            if (!isLatestAsyncRequest(enterpriseGateRequestIdRef, requestId)) return;
            if (!result.success) {
              throw new Error(result.error || 'Enterprise UI config is unavailable.');
            }
            setEnterpriseConfig(result.config);
            setEnterpriseConfigLoaded(true);
          }, {
            attempts: INIT_REQUIRED_GATE_MAX_ATTEMPTS,
            firstTimeoutMs: INIT_STEP_RETRY_TIMEOUT_MS,
          }),
          runStep('privacy check', async () => {
            const requestId = beginLatestAsyncRequest(privacyGateRequestIdRef);
            const agreed = await window.electron.store.get('privacy_agreed');
            if (!isLatestAsyncRequest(privacyGateRequestIdRef, requestId)) return;
            setPrivacyAgreed(agreed === true);
          }, {
            attempts: INIT_REQUIRED_GATE_MAX_ATTEMPTS,
            firstTimeoutMs: INIT_STEP_RETRY_TIMEOUT_MS,
          }),
        ]);
        if (!enterpriseReady || !privacyReady) {
          throw new Error(
            `Required startup gates unavailable (enterprise=${enterpriseReady}, privacy=${privacyReady}).`,
          );
        }
        requiredStartupGatesReadyRef.current = true;
        mark('required privacy and enterprise gates done');
      }

      mark('configService.init begin');
      const configReady = await runStep('configService.init', () => configService.init(), {
        attempts: isRepair ? 2 : INIT_CONFIG_MAX_ATTEMPTS,
        firstTimeoutMs: isRepair ? INIT_STEP_RETRY_TIMEOUT_MS : initTimeoutMs,
      });

      if (!configReady) {
        if (isRepair) {
          if (initRepairCountRef.current < INIT_CONFIG_REPAIR_MAX) {
            initRepairCountRef.current += 1;
            markError(`config repair still failing — retry ${initRepairCountRef.current}/${INIT_CONFIG_REPAIR_MAX} in ${INIT_CONFIG_REPAIR_DELAY_MS}ms`);
            scheduleNextPass(InitPassMode.Repair, INIT_CONFIG_REPAIR_DELAY_MS);
          } else {
            markError('config repair attempts exhausted — app keeps default config until next launch');
          }
          return;
        }
        // Keep the application usable on defaults while a background pass
        // repairs persisted config. Core services still initialize below so
        // auth/listeners and scheduled tasks are never skipped.
        markError('configService.init unavailable — starting with default config, background repair scheduled');
        initRepairCountRef.current = 1;
      } else {
        mark('configService.init done');
      }

      if (isRepair) {
        const repairedModels = applyConfigToApp(mark);
        const repairedConfig = configService.getConfig();
        themeService.applyPersistedSelection({
          mode: repairedConfig.theme,
          themeId: repairedConfig.themeId,
        });
        i18nService.setLanguage(repairedConfig.language, { persist: false });
        mark(`config repaired and applied (${repairedModels.length} provider models)`);
        return;
      }

      if (!coreStartupServicesInitializedRef.current) {
        themeService.initialize();
        mark('themeService done');

        mark('i18nService.initialize begin');
        const i18nReady = await runStep('i18nService.initialize', () => i18nService.initialize(), {
          // Keep one invocation alive after a timeout. Starting a concurrent
          // locale initialization would let late IPC results race each other.
          attempts: 1,
          firstTimeoutMs: initTimeoutMs,
        });
        mark(i18nReady ? 'i18nService.initialize done' : 'i18nService.initialize degraded — using persisted language hint');

        // Single attempt: authService.init() re-entry tears down listeners, so a
        // concurrent retry could stack them; its in-flight run self-completes
        // once IPC recovers.
        mark('authService.init begin');
        const authReady = await runStep('authService.init', () => authService.init(), {
          attempts: 1,
          firstTimeoutMs: INIT_STEP_RETRY_TIMEOUT_MS,
        });
        mark(authReady ? 'authService.init done' : 'authService.init pending (auth restore completes in background)');
        coreStartupServicesInitializedRef.current = true;
      }

      const providerModels = applyConfigToApp(mark);
      mark('model resolution done');

      finishShell(
        providerModels.length,
        configReady ? 'shell ready' : 'shell ready (degraded: default config)',
      );

      void waitWithTimeout(scheduledTaskService.init(), 5000, 'scheduledTaskService.init').catch((error) => {
        console.error('[App] initializeApp: scheduledTaskService.init failed:', error);
      });

      if (!configReady) {
        // Schedule only after the startup pass releases its in-flight guard;
        // otherwise a slow core-service init can consume and lose the timer.
        scheduleNextPass(InitPassMode.Repair, INIT_CONFIG_REPAIR_DELAY_MS);
      }

    } catch (error) {
      const elapsed = Math.round(performance.now() - t0);
      const msg = error instanceof Error ? error.message : String(error);
      const detail = `initializeApp FAILED after ${elapsed}ms (mode=${mode}): ${msg}`;
      console.error(`[App] ${detail}`);
      try { window.electron?.log?.fromRenderer?.('error', 'App', detail); } catch { /* best-effort */ }
      if (mode === InitPassMode.Repair) {
        // The shell is already up in degraded mode — never replace it with the
        // error page from a background pass.
        return;
      }
      setInitError(i18nService.t('initializationError'));
      setIsInitialized(true);
      if (initAutoRetryCountRef.current < INIT_AUTO_RETRY_MAX) {
        initAutoRetryCountRef.current += 1;
        markError(`scheduling automatic init retry ${initAutoRetryCountRef.current}/${INIT_AUTO_RETRY_MAX} in ${INIT_AUTO_RETRY_DELAY_MS}ms`);
        // Retries silently behind the error page; success swaps straight into
        // the app without flashing the loading screen.
        scheduleNextPass(InitPassMode.Retry, INIT_AUTO_RETRY_DELAY_MS);
      }
    } finally {
      initPassRunningRef.current = false;
    }
  }, [applyConfigToApp, waitWithTimeout]);

  useEffect(() => {
    runInitPassRef.current = (mode: InitPassMode) => { void runInitPass(mode); };
  }, [runInitPass]);

  const handleInitRetry = useCallback(() => {
    if (initPassRunningRef.current) {
      return;
    }
    initAutoRetryCountRef.current = 0;
    setInitError(null);
    setIsInitialized(false);
    void runInitPass(InitPassMode.Retry);
  }, [runInitPass]);

  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;
    void runInitPass(InitPassMode.Startup);
  }, [runInitPass]);

  useEffect(() => () => {
    if (initRetryTimerRef.current !== null) {
      window.clearTimeout(initRetryTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (authUser) {
      void authService.fetchProfileSummary();
    }
  }, [authUser]);

  // Listen for Copilot token auto-refresh events from the main process
  useEffect(() => {
    const removeListener = window.electron.githubCopilot.onTokenUpdated(({ token, baseUrl }) => {
      console.log('[App] received Copilot token update from main process');
      apiService.setProviderRuntimeCredential(ProviderName.Copilot, {
        apiKey: token,
        ...(baseUrl ? { baseUrl } : {}),
      });
    });
    return removeListener;
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Renderer] Network online');
      window.electron.networkStatus.send('online');
      // A startup load that failed while offline has no other retry trigger.
      void authService.refreshServerModels();
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
    if (!isInitialized || !defaultSelectedModel?.id) return;
    const config = configService.getConfig();
    if (
      config.model.defaultModel === defaultSelectedModel.id
      && (config.model.defaultModelProvider ?? '') === (defaultSelectedModel.providerKey ?? '')
    ) {
      return;
    }
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: defaultSelectedModel.id,
        defaultModelProvider: defaultSelectedModel.providerKey,
      },
    });
  }, [isInitialized, defaultSelectedModel?.id, defaultSelectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions((current) => ({
      initialTab: options?.initialTab,
      notice: options?.notice,
      noticeI18nKey: options?.noticeI18nKey,
      noticeExtra: options?.noticeExtra,
      requestId: current.requestId + 1,
    }));
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

  const handleShowLibrary = useCallback(() => {
    setLibraryNavigationRequest(current => ({
      source: LibrarySourceFilter.Local,
      requestId: current.requestId + 1,
    }));
    setMainView('library');
  }, []);

  useEffect(() => {
    const handleOpenCloudLibrary = (): void => {
      setLibraryNavigationRequest(current => ({
        source: LibrarySourceFilter.Cloud,
        requestId: current.requestId + 1,
      }));
      setMainView('library');
    };
    window.addEventListener(LibraryNavigationEvent.OpenCloud, handleOpenCloudLibrary);
    return () => {
      window.removeEventListener(LibraryNavigationEvent.OpenCloud, handleOpenCloudLibrary);
    };
  }, []);

  const handleOpenLibrarySession = useCallback((session: LibrarySessionRef) => {
    setMainView('cowork');
    void coworkService.loadSession(session.sessionId).then(loaded => {
      if (!loaded || !session.sessionArtifactId) return;
      dispatch(openArtifactPreviewTab({
        sessionId: session.sessionId,
        artifactId: session.sessionArtifactId,
      }));
    });
  }, [dispatch]);

  const handleShowKits = useCallback(() => {
    setMainView('kits');
  }, []);

  const handleSkillsConnectorsSectionChange = useCallback((section: SkillsConnectorsSection) => {
    if (section === SkillsConnectorsSection.Connectors) {
      handleShowMcp();
    } else {
      handleShowSkills();
    }
  }, [handleShowMcp, handleShowSkills]);

  const openHomeWithKit = useCallback((kitId: string, text?: string) => {
    dispatch(setActiveKitIds([kitId]));
    coworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    if (text !== undefined) {
      dispatch(setDraftCollaborationMode({
        draftKey: '__home__',
        mode: CoworkCollaborationMode.Default,
      }));
      // Set the draft prompt before switching view, so that when CoworkPromptInput
      // mounts/updates with draftKey='__home__', it picks up the text.
      dispatch(setDraftPrompt({ sessionId: '__home__', draft: text }));
    }
    dispatch(setDraftKitIds({ draftKey: '__home__', kitIds: [kitId] }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        // Without text, keep any existing home draft and just focus with the kit selected
        detail: text !== undefined ? { resetCollaborationMode: true, text } : { clear: false },
      }));
    }, 0);
  }, [dispatch]);

  const handleKitTryAsking = useCallback((text: string, kitId: string) => {
    openHomeWithKit(kitId, text);
  }, [openHomeWithKit]);

  const handleKitUse = useCallback((kitId: string) => {
    openHomeWithKit(kitId);
  }, [openHomeWithKit]);

  const handleSkillUse = useCallback((skillId: string) => {
    dispatch(setActiveSkillIds([skillId]));
    coworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: [skillId] }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: false },
      }));
    }, 0);
  }, [dispatch]);

  const handleToggleSidebar = useCallback(() => {
    const nextCollapsed = !isSidebarCollapsed;
    const message = `sidebar toggle requested activeView=${mainView} nextCollapsed=${nextCollapsed} platform=${window.electron.platform}`;
    console.debug(`[AppLayout] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'AppLayout', message);
    } catch {
      // Logging should never block sidebar interactions.
    }
    void reportYdAnalyzer({
      action: LogReporterAction.SidebarAction,
      source: 'home_sidebar',
      actionType: isSidebarCollapsed ? 'expand_sidebar' : 'collapse_sidebar',
      activeView: mainView,
      isCollapsed: isSidebarCollapsed,
    });
    setIsSidebarCollapsed((prev) => !prev);
  }, [isSidebarCollapsed, mainView]);

  const handleToggleTaskFilter = useCallback(() => {
    const nextActive = !isTaskFilterActive;
    const message = `task activity toggle requested activeView=${mainView} nextActive=${nextActive} hasUnreadCompleted=${hasUnreadCompletedTasks} platform=${window.electron.platform}`;
    console.debug(`[TaskActivity] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'TaskActivity', message);
    } catch {
      // Diagnostics must never block the sidebar interaction.
    }
    void reportYdAnalyzer({
      action: LogReporterAction.SidebarAction,
      source: 'home_sidebar',
      actionType: 'task_filter_toggle',
      activeView: mainView,
      isCollapsed: isSidebarCollapsed,
      targetSelected: nextActive,
    });
    setIsTaskFilterActive(nextActive);
  }, [hasUnreadCompletedTasks, isSidebarCollapsed, isTaskFilterActive, mainView]);

  const handleOpenTaskSearch = useCallback(() => {
    void reportYdAnalyzer({
      action: LogReporterAction.SidebarAction,
      source: 'home_sidebar',
      actionType: 'open_search',
      activeView: mainView,
      isCollapsed: isSidebarCollapsed,
    });
    window.dispatchEvent(new CustomEvent<CoworkTaskSearchRequestEventDetail>(
      CoworkUiEvent.ShortcutSearch,
      { detail: { source: CoworkTaskSearchRequestSource.WindowsTitleBar } },
    ));
  }, [isSidebarCollapsed, mainView]);

  const handleNewChat = useCallback(() => {
    // Only clear when already on home (no session) — preserve __home__ draft when returning from a session
    const shouldClearInput = mainView === 'cowork' && !currentSessionId;
    coworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: CoworkCollaborationMode.Default,
    }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: shouldClearInput, resetCollaborationMode: true },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const handleCreateSkillByChat = useCallback(() => {
    dispatch(setDraftPrompt({ sessionId: '__home__', draft: i18nService.t('skillCreatorPrompt') }));
    coworkService.clearSession();
    dispatch(clearSelection());
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: CoworkCollaborationMode.Default,
    }));
    setMainView('cowork');
  }, [dispatch]);

  const showToast = useCallback((toast: string | ToastEventDetail) => {
    const detail = typeof toast === 'string' ? { message: toast } : toast;
    if (!detail.message) return;
    setToastMessage(detail);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    // Toasts carrying an action button stay longer so the user can reach it.
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, detail.actionLabel && detail.onAction ? 6000 : 2200);
  }, []);

  const startUserInitiatedUpdateFlow = useCallback((reason: string) => {
    if (!isUserInitiatedUpdateFlowActiveRef.current) {
      logAppUpdateRendererLifecycle(`interaction lock started reason=${reason}`);
    }
    isUserInitiatedUpdateFlowActiveRef.current = true;
    setIsUserInitiatedUpdateFlowActive(true);
  }, []);

  const stopUserInitiatedUpdateFlow = useCallback((reason: string) => {
    if (!isUserInitiatedUpdateFlowActiveRef.current) return;

    isUserInitiatedUpdateFlowActiveRef.current = false;
    setIsUserInitiatedUpdateFlowActive(false);
    logAppUpdateRendererLifecycle(`interaction lock released reason=${reason}`);
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadInitialUpdateState = async () => {
      try {
        const state = await window.electron.appUpdate.getState();
        if (mounted) {
          setAppUpdateState(state);
          // A previous install attempt quit the app without completing
          // (e.g. the installer never launched) — re-prompt the user.
          if (state.status === AppUpdateStatus.Ready && state.installIncomplete) {
            setShowUpdateModal(true);
          }
        }
        // Silent installs relaunch the app with no visible install step, so
        // this toast is the only confirmation the update actually happened.
        const completed = await window.electron.appUpdate.getCompletedUpdate?.();
        if (mounted && completed?.version) {
          showToast(`${i18nService.t('updateInstalledToast')} v${completed.version}`);
        }
      } catch (error) {
        console.error('[App] failed to load initial app update state:', error);
      }
    };

    void loadInitialUpdateState();

    const unsubscribe = window.electron.appUpdate.onStateChanged((state) => {
      setAppUpdateState(state);

      // Downloads finish silently into the sidebar card; the interaction lock
      // only spans the install the user explicitly confirmed.
      if (!isAppUpdateInteractionBlockingStatus(state.status)) {
        stopUserInitiatedUpdateFlow(`state=${state.status}`);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [showToast, stopUserInitiatedUpdateFlow]);

  const handleShowLogin = useCallback(() => {
    showToast(i18nService.t('featureInDevelopment'));
  }, [showToast]);

  const runUpdateCheck = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.electron.appUpdate.checkNow({ userId: authUser?.yid });
      setAppUpdateState(result.state);
      if (!result.success) {
        console.error('[App] app update check failed:', result.error);
        return false;
      }
      return true;
    } catch (error) {
      console.error('Failed to check app update:', error);
      return false;
    }
  }, [authUser]);

  const updateInfo = appUpdateState.info;

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;

    const message = `update modal requested status=${appUpdateState.status} source=${appUpdateState.source ?? 'none'} version=${updateInfo.latestVersion}`;
    logAppUpdateRendererLifecycle(message);
    setShowUpdateModal(true);
  }, [appUpdateState.source, appUpdateState.status, updateInfo]);

  const handleUpdateFound = useCallback((_info: AppUpdateInfo) => {
    setShowUpdateModal(true);
  }, []);

  const installReadyUpdate = useCallback(async () => {
    if (!updateInfo) return;

    setShowUpdateInstallConfirm(false);
    setShowUpdateModal(false);
    startUserInitiatedUpdateFlow(
      `install-ready version=${updateInfo.latestVersion}`,
    );
    try {
      const installResult = await window.electron.appUpdate.installReady();
      if (!installResult.success) {
        stopUserInitiatedUpdateFlow('install-result-failed');
        showToast(
          installResult.error
            ? formatAppUpdateError(installResult.error)
            : i18nService.t('updateInstallFailed'),
        );
      }
    } catch (error) {
      stopUserInitiatedUpdateFlow('install-ipc-failed');
      console.error('[AppUpdate] failed to install ready update:', error);
      showToast(i18nService.t('updateInstallFailed'));
    }
  }, [showToast, startUserInitiatedUpdateFlow, stopUserInitiatedUpdateFlow, updateInfo]);

  // Installing quits the app, which cuts short every running turn and
  // scheduled task. The renderer only knows the sessions it has loaded, so the
  // main process is also asked about IM-driven sessions and cron runs.
  const requestInstallReadyUpdate = useCallback(async () => {
    let hasActiveWorkloads = selectHasRunningCoworkSessions(store.getState());
    if (!hasActiveWorkloads) {
      try {
        const result = await window.electron.appUpdate.getActiveWorkloads?.();
        hasActiveWorkloads = result?.hasActiveWorkloads === true;
      } catch (error) {
        console.warn('[AppUpdate] failed to query active workloads before install:', error);
      }
    }
    if (hasActiveWorkloads) {
      logAppUpdateRendererLifecycle('install needs confirmation: tasks are still running');
      setShowUpdateModal(false);
      setShowUpdateInstallConfirm(true);
      return;
    }
    await installReadyUpdate();
  }, [installReadyUpdate]);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    if (appUpdateState.readyFilePath) {
      await requestInstallReadyUpdate();
      return;
    }

    if (isManualDownloadUrl(updateInfo.url)) {
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

    if (appUpdateState.status === AppUpdateStatus.Error || appUpdateState.status === AppUpdateStatus.Available) {
      // The download runs silently in the background; the sidebar card comes
      // back as "ready" once the installer has been verified.
      setShowUpdateModal(false);
      try {
        const retryResult = await window.electron.appUpdate.retryDownload();
        if (
          !retryResult.success
          || retryResult.state.status !== AppUpdateStatus.Downloading
        ) {
          logAppUpdateRendererLifecycle(
            `background download did not start state=${retryResult.state.status}`,
            'warn',
          );
          showToast(i18nService.t('updateDownloadFailed'));
          return;
        }
        showToast(i18nService.t('updateDownloadStartedToast'));
      } catch (error) {
        console.error('[AppUpdate] failed to start update download:', error);
        showToast(i18nService.t('updateDownloadFailed'));
      }
    }
  }, [
    appUpdateState.readyFilePath,
    appUpdateState.status,
    requestInstallReadyUpdate,
    showToast,
    updateInfo,
  ]);

  const handleRetryUpdate = useCallback(async () => {
    await handleConfirmUpdate();
  }, [handleConfirmUpdate]);

  // Continuing from the welcome screen (login or custom model) counts as accepting the agreement.
  const acceptPrivacyAgreement = useCallback(async () => {
    await window.electron.store.set('privacy_agreed', true);
    // Invalidate an earlier timed-out read before committing the user's newer
    // consent so its late response cannot put the welcome gate back on screen.
    invalidateLatestAsyncRequest(privacyGateRequestIdRef);
    setPrivacyAgreed(true);
  }, []);

  // Release the first-launch gate once login completes in an external auth flow.
  useEffect(() => {
    if (privacyAgreed === false && authUser) {
      void acceptPrivacyAgreement().catch((error) => {
        console.warn('[Onboarding] failed to persist privacy agreement after login callback:', error);
      });
    }
  }, [privacyAgreed, authUser, acceptPrivacyAgreement]);

  const finishNewUserOnboarding = useCallback((source: NewUserOnboardingCompletionSource) => {
    console.log(`[Onboarding] completing new user onboarding source=${source}`);
    setIsNewUserOnboardingDismissed(true);
    if (privacyAgreed === false) {
      void acceptPrivacyAgreement()
        .then(() => {
          console.log(`[Onboarding] privacy agreement accepted from onboarding source=${source}`);
        })
        .catch((error) => {
          console.warn(
            `[Onboarding] failed to persist privacy agreement from onboarding source=${source}:`,
            error,
          );
        });
    }
  }, [acceptPrivacyAgreement, privacyAgreed]);

  const openNewUserWelcomeTask = useCallback((source: string) => {
    setMainView('cowork');
    console.log(`[Onboarding] opening new user welcome task source=${source}`);
    void coworkService.seedNewUserWelcomeTask()
      .then((result) => {
        if (!result.session) {
          console.warn(
            `[Onboarding] new user welcome task seed returned no session source=${source}: `
            + `${result.error ?? 'unknown error'}`,
          );
          reportOnboardingAction('welcome_task_open_result', {
            source,
            result: 'failed',
            errorCode: result.error ? 'seed_failed' : 'unknown',
          });
          showToast(i18nService.t('newUserWelcomeTaskCreateFailed'));
          return;
        }
        console.log(
          `[Onboarding] new user welcome task opened source=${source} session=${result.session.id}`,
        );
        reportOnboardingAction('welcome_task_open_result', {
          source,
          result: 'success',
          created: result.created === true,
        });
      })
      .catch((error) => {
        console.warn(`[Onboarding] failed to open new user welcome task source=${source}:`, error);
        reportOnboardingAction('welcome_task_open_result', {
          source,
          result: 'failed',
          errorCode: getOnboardingErrorCode(error),
        });
        showToast(i18nService.t('newUserWelcomeTaskCreateFailed'));
      });
  }, [showToast]);

  useEffect(() => {
    const unsubscribe = window.electron.auth.onCallback(() => {
      pendingNewUserWelcomeAuthCallbackAtRef.current = Date.now();
      if (hasNewUserWelcomeAfterLoginPending()) {
        console.log('[Onboarding] auth callback observed during new user login handoff');
        reportOnboardingAction('auth_callback_observed', {
          source: 'new_user_onboarding',
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authUser || !hasNewUserWelcomeAfterLoginPending()) {
      pendingNewUserWelcomeAfterLoginSawStartupRef.current = false;
      pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current = false;
      return;
    }

    const snapshotPhase = coworkService.getOpenClawEngineStatusSnapshot()?.phase ?? null;
    const isOpenClawStarting =
      isEngineStartupOverlayVisible || snapshotPhase === OpenClawEnginePhase.Starting;

    if (isOpenClawStarting) {
      pendingNewUserWelcomeAfterLoginSawStartupRef.current = true;
      if (!pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current) {
        console.log(
          '[Onboarding] login callback detected; waiting for OpenClaw startup before opening '
          + `new user welcome task phase=${snapshotPhase ?? 'unknown'}`,
        );
        reportOnboardingAction('login_success_wait_gateway', {
          source: 'new_user_onboarding',
          phase: snapshotPhase ?? 'unknown',
        });
        pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current = true;
      }
      return;
    }

    const delayMs = pendingNewUserWelcomeAfterLoginSawStartupRef.current
      ? NEW_USER_WELCOME_AFTER_LOGIN_ENGINE_SETTLE_MS
      : NEW_USER_WELCOME_AFTER_LOGIN_RESTART_GRACE_MS;

    if (!pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current) {
      console.log(
        '[Onboarding] login callback detected; delaying new user welcome task open for '
        + `gateway restart grace delay=${delayMs}ms phase=${snapshotPhase ?? 'unknown'}`,
      );
      pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current = true;
    }

    const timer = window.setTimeout(() => {
      const latestPhase = coworkService.getOpenClawEngineStatusSnapshot()?.phase ?? null;
      if (latestPhase === OpenClawEnginePhase.Starting) {
        pendingNewUserWelcomeAfterLoginSawStartupRef.current = true;
        setNewUserWelcomeAfterLoginSignal((value) => value + 1);
        return;
      }

      if (!consumeNewUserWelcomeAfterLoginPending()) {
        pendingNewUserWelcomeAfterLoginSawStartupRef.current = false;
        pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current = false;
        return;
      }

      console.log(
        '[Onboarding] OpenClaw startup settled; opening pending new user welcome task '
        + `phase=${latestPhase ?? 'unknown'} sawStartup=${pendingNewUserWelcomeAfterLoginSawStartupRef.current}`,
      );
      reportOnboardingAction('login_success_gateway_settled', {
        source: 'new_user_onboarding',
        phase: latestPhase ?? 'unknown',
        sawStartup: pendingNewUserWelcomeAfterLoginSawStartupRef.current,
      });
      pendingNewUserWelcomeAfterLoginSawStartupRef.current = false;
      pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current = false;
      setIsNewUserOnboardingDismissed(true);
      openNewUserWelcomeTask('start_experience_login_callback');
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    authUser,
    isEngineStartupOverlayVisible,
    newUserWelcomeAfterLoginSignal,
    openNewUserWelcomeTask,
  ]);

  useEffect(() => {
    if (authUser) return undefined;

    let returnTimer: number | null = null;

    const clearReturnTimer = () => {
      if (returnTimer === null) return;
      window.clearTimeout(returnTimer);
      returnTimer = null;
    };

    const scheduleUnauthenticatedReturnOpen = (source: string) => {
      const pendingAgeMs = getNewUserWelcomeAfterLoginPendingAgeMs();
      if (pendingAgeMs === null) return;

      clearReturnTimer();
      const delayMs = NEW_USER_WELCOME_UNAUTHENTICATED_RETURN_DELAY_MS;
      console.log(
        '[Onboarding] app returned during new user login handoff; verifying auth state '
        + `source=${source} delay=${delayMs}ms pendingAge=${Math.round(pendingAgeMs)}ms`,
      );

      returnTimer = window.setTimeout(() => {
        returnTimer = null;
        if (!hasNewUserWelcomeAfterLoginPending()) return;
        if (store.getState().auth.isLoggedIn) return;

        const lastCallbackAgeMs = Date.now() - pendingNewUserWelcomeAuthCallbackAtRef.current;
        if (lastCallbackAgeMs >= 0 && lastCallbackAgeMs < NEW_USER_WELCOME_AUTH_CALLBACK_SUPPRESSION_MS) {
          console.log(
            '[Onboarding] auth callback recently observed; waiting for login exchange before '
            + `opening fallback welcome task callbackAge=${lastCallbackAgeMs}ms`,
          );
          return;
        }

        if (!consumeNewUserWelcomeAfterLoginPending()) return;

        console.log(
          '[Onboarding] login handoff returned without authenticated callback; opening '
          + `new user welcome task source=${source}`,
        );
        reportOnboardingAction('login_return_without_auth', {
          source,
          pendingAge: Math.round(getNewUserWelcomeAfterLoginPendingAgeMs() ?? 0),
        });
        pendingNewUserWelcomeAfterLoginSawStartupRef.current = false;
        pendingNewUserWelcomeAfterLoginWaitingLoggedRef.current = false;
        setIsNewUserOnboardingDismissed(true);
        openNewUserWelcomeTask(source);
      }, delayMs);
    };

    const unsubscribeWindowState = window.electron.window.onStateChanged((state) => {
      if (!state.isFocused) return;
      scheduleUnauthenticatedReturnOpen('start_experience_window_focus_without_login');
    });

    const handleWindowFocus = () => {
      scheduleUnauthenticatedReturnOpen('start_experience_dom_focus_without_login');
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      scheduleUnauthenticatedReturnOpen('start_experience_visibility_without_login');
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearReturnTimer();
      unsubscribeWindowState();
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authUser, openNewUserWelcomeTask]);

  const handleNewUserOnboardingSkip = useCallback(() => {
    reportOnboardingAction('guide_skip_click', {
      source: 'new_user_onboarding',
      step: newUserOnboardingStep,
    });
    finishNewUserOnboarding('skip');
    if (privacyAgreed !== false) return;

    openNewUserWelcomeTask('skip');
  }, [finishNewUserOnboarding, newUserOnboardingStep, openNewUserWelcomeTask, privacyAgreed]);

  const handleNewUserOnboardingNext = useCallback(() => {
    if (newUserOnboardingStep === NewUserOnboardingStep.NewTask) {
      console.log('[Onboarding] advancing new user onboarding step=new-task next=prompt-input');
      reportOnboardingAction('guide_next_click', {
        source: 'new_user_onboarding',
        step: newUserOnboardingStep,
        nextStep: NewUserOnboardingStep.PromptInput,
      });
      setNewUserOnboardingStep(NewUserOnboardingStep.PromptInput);
      return;
    }
    finishNewUserOnboarding('next');
  }, [finishNewUserOnboarding, newUserOnboardingStep]);

  const handleNewUserOnboardingStartExperience = useCallback(() => {
    console.log('[Onboarding] start experience clicked; starting login handoff');
    reportOnboardingAction('guide_start_experience_click', {
      source: 'new_user_onboarding',
      step: newUserOnboardingStep,
    });
    setNewUserWelcomeAfterLoginPending();
    setNewUserWelcomeAfterLoginSignal((value) => value + 1);
    finishNewUserOnboarding('start_experience');
    void authService.login()
      .then((result) => {
        if (!result.success) {
          console.warn(
            `[Onboarding] login handoff from new user onboarding failed: ${result.error ?? 'unknown error'}`,
          );
          reportOnboardingAction('login_redirect_result', {
            source: 'new_user_onboarding',
            result: 'failed',
            errorCode: result.error ? 'login_redirect_failed' : 'unknown',
          });
          consumeNewUserWelcomeAfterLoginPending();
          showToast(i18nService.t('welcomeLoginFailed'));
          return;
        }
        console.log('[Onboarding] login handoff from new user onboarding succeeded');
        reportOnboardingAction('login_redirect_result', {
          source: 'new_user_onboarding',
          result: 'success',
        });
        setNewUserWelcomeAfterLoginSignal((value) => value + 1);
      })
      .catch((error) => {
        console.warn('[Onboarding] failed to start login from new user onboarding:', error);
        reportOnboardingAction('login_redirect_result', {
          source: 'new_user_onboarding',
          result: 'failed',
          errorCode: getOnboardingErrorCode(error),
        });
        consumeNewUserWelcomeAfterLoginPending();
        showToast(i18nService.t('welcomeLoginFailed'));
      });
  }, [finishNewUserOnboarding, newUserOnboardingStep, showToast]);

  const handlePermissionResponse = useCallback(async (result: CoworkPermissionResult) => {
    if (!pendingPermission) return;
    await coworkService.respondToPermission(pendingPermission.requestId, result);
  }, [pendingPermission]);

  const handleMinimizePermission = useCallback(() => {
    if (!pendingPermission) return;
    setMinimizedPermissionIds((previous) => (
      previous.includes(pendingPermission.requestId)
        ? previous
        : [...previous, pendingPermission.requestId]
    ));
  }, [pendingPermission]);

  const handleRestorePermission = useCallback(() => {
    if (!pendingPermission) return;
    setMinimizedPermissionIds((previous) => (
      previous.filter((requestId) => requestId !== pendingPermission.requestId)
    ));
  }, [pendingPermission]);

  useEffect(() => {
    const activeRequestIds = new Set(pendingPermissions.map((permission) => permission.requestId));
    setMinimizedPermissionIds((previous) => {
      const next = previous.filter((requestId) => activeRequestIds.has(requestId));
      return next.length === previous.length ? previous : next;
    });
  }, [pendingPermissions]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; openClawProviderId?: string; supportsImage?: boolean }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          const openClawProviderId = ProviderRegistry.getOpenClawProviderIdForConfig(providerName, providerConfig);
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: getProviderDisplayName(providerName, providerConfig),
              providerKey: providerName,
              openClawProviderId,
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));
    }
  };

  const handleStartAiSkinFromSettings = (text: string, kitId: string) => {
    handleCloseSettings();
    openHomeWithKit(kitId, text);
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  const isTextEditingActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    if (activeElement.isContentEditable) return true;
    if (activeElement instanceof HTMLTextAreaElement) return true;
    if (activeElement instanceof HTMLSelectElement) return true;
    return activeElement instanceof HTMLInputElement;
  };

  const isCoworkSearchEligibleEditorActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return Boolean(activeElement.closest([
      '[data-skin-prompt-input="true"]',
      '[data-cowork-conversation-search="true"]',
    ].join(',')));
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || isShortcutInputActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      const isTextEditing = isTextEditingActive();
      const matchesAction = (action: ShortcutAction) => {
        const binding = activeShortcuts[action];
        // While typing, only run shortcuts carrying a Cmd/Ctrl modifier so plain keys keep inserting text.
        if (isTextEditing && !isTextEditingSafeShortcut(binding)) return false;
        return matchesShortcut(event, binding);
      };

      if (showSettings) {
        if (matchesAction(ShortcutAction.ShowShortcuts)) {
          event.preventDefault();
          handleShowSettings({ initialTab: 'shortcuts' });
        }
        return;
      }

      if (showUpdateModal || isPermissionModalOpen || isUpdateInteractionBlocked) return;

      if (matchesAction(ShortcutAction.Search)) {
        const shortcutTarget = resolveConversationSearchShortcutTarget({
          isCoworkView: mainView === 'cowork',
          hasCurrentSession: Boolean(currentSessionId),
          isTextEditing,
          isCoworkSearchEligibleEditor: isCoworkSearchEligibleEditorActive(),
        });
        if (shortcutTarget === ConversationSearchShortcutTarget.Conversation) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutConversationSearch));
        } else if (shortcutTarget === ConversationSearchShortcutTarget.History) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent<CoworkTaskSearchRequestEventDetail>(
            CoworkUiEvent.ShortcutSearch,
            { detail: { source: CoworkTaskSearchRequestSource.KeyboardShortcut } },
          ));
        }
        return;
      }

      if (matchesAction(ShortcutAction.NewChat)) {
        event.preventDefault();
        handleNewChat();
        return;
      }

      if (matchesAction(ShortcutAction.Settings)) {
        event.preventDefault();
        handleShowSettings();
        return;
      }

      if (matchesAction(ShortcutAction.ShowShortcuts)) {
        event.preventDefault();
        handleShowSettings({ initialTab: 'shortcuts' });
        return;
      }

      const settingsTabShortcut = SETTINGS_TAB_SHORTCUT_ACTIONS.find(({ action }) => matchesAction(action));
      if (settingsTabShortcut) {
        event.preventDefault();
        handleShowSettings({ initialTab: settingsTabShortcut.initialTab });
        return;
      }

      if (matchesAction(ShortcutAction.FocusPrompt)) {
        event.preventDefault();
        setMainView('cowork');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
            detail: { clear: false },
          }));
        }, 0);
        return;
      }

      if (matchesAction(ShortcutAction.StopCurrentTask)) {
        event.preventDefault();
        if (mainView === 'cowork') {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutStopSession));
        } else if (currentSessionId) {
          void coworkService.stopSession(currentSessionId);
        }
        return;
      }

      if (matchesAction(ShortcutAction.ToggleSidebar)) {
        event.preventDefault();
        handleToggleSidebar();
        return;
      }

      if (matchesAction(ShortcutAction.ToggleArtifacts)) {
        event.preventDefault();
        setMainView('cowork');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutToggleArtifacts));
        }, 0);
        return;
      }

      if (matchesAction(ShortcutAction.PreviousAgent)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutSwitchAgent, {
          detail: { direction: CoworkShortcutDirection.Previous },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.NextAgent)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutSwitchAgent, {
          detail: { direction: CoworkShortcutDirection.Next },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.ShowCurrentAgentTasks)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutShowCurrentAgentTasks));
        return;
      }

      if (matchesAction(ShortcutAction.CollapseCurrentAgentTasks)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutCollapseCurrentAgentTasks));
        return;
      }

      const taskSlotIndex = AGENT_TASK_SLOT_SHORTCUT_ACTIONS.findIndex(action => matchesAction(action));
      if (taskSlotIndex >= 0) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutOpenAgentTaskSlot, {
          detail: { slot: taskSlotIndex + 1 },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.OpenCowork)) {
        event.preventDefault();
        handleShowCowork();
        return;
      }

      if (matchesAction(ShortcutAction.OpenScheduledTasks)) {
        event.preventDefault();
        handleShowScheduledTasks();
        return;
      }

      if (matchesAction(ShortcutAction.OpenKits)) {
        event.preventDefault();
        handleShowKits();
        return;
      }

      if (matchesAction(ShortcutAction.OpenSkills)) {
        event.preventDefault();
        handleShowSkills();
        return;
      }

      if (matchesAction(ShortcutAction.OpenMcp)) {
        event.preventDefault();
        handleShowMcp();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    currentSessionId,
    handleNewChat,
    handleShowCowork,
    handleShowKits,
    handleShowMcp,
    handleShowScheduledTasks,
    handleShowSettings,
    handleShowSkills,
    handleToggleSidebar,
    isUpdateInteractionBlocked,
    mainView,
    isPermissionModalOpen,
    showSettings,
    showUpdateModal,
  ]);

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
      const detail = (e as CustomEvent<string | ToastEventDetail>).detail;
      if (detail) showToast(detail);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // Listen for ask-ai events: close settings, open a new chat, and pre-fill its input.
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text !== 'string' || !text.trim()) {
        console.warn('[AskAI] ignored navigation request because the prompt was empty.');
        return;
      }

      const coworkState = store.getState().cowork;
      const diagnostic = [
        'opening new chat with prefilled prompt;',
        `hadCurrentSession=${Boolean(coworkState.currentSessionId)},`,
        `remoteManaged=${coworkState.remoteManaged},`,
        `promptLength=${text.length}`,
      ].join(' ');
      console.debug(`[AskAI] ${diagnostic}`);
      try {
        window.electron?.log?.fromRenderer?.('debug', 'AskAI', diagnostic);
      } catch {
        // Logging must not block navigation.
      }

      coworkService.clearSession({ restoreAgentSkills: true });
      dispatch(clearSelection());
      dispatch(setDraftCollaborationMode({
        draftKey: '__home__',
        mode: CoworkCollaborationMode.Default,
      }));
      dispatch(setDraftPrompt({ sessionId: '__home__', draft: text }));
      dispatch(clearDraftAttachments('__home__'));
      dispatch(clearDraftSelectedTextSnippets('__home__'));
      setShowSettings(false);
      setMainView('cowork');
      if (askAiFocusTimerRef.current !== null) {
        window.clearTimeout(askAiFocusTimerRef.current);
      }
      askAiFocusTimerRef.current = window.setTimeout(() => {
        askAiFocusTimerRef.current = null;
        window.dispatchEvent(
          new CustomEvent(CoworkUiEvent.FocusInput, {
            detail: { text },
          }),
        );
      }, 50);
    };
    window.addEventListener('app:ask-ai', handler);
    return () => {
      window.removeEventListener('app:ask-ai', handler);
      if (askAiFocusTimerRef.current !== null) {
        window.clearTimeout(askAiFocusTimerRef.current);
        askAiFocusTimerRef.current = null;
      }
    };
  }, [dispatch]);

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
    const unsubscribe = window.electron.cowork.onOpenSessionFromNotification?.(({ sessionId }) => {
      setShowSettings(false);
      setMainView('cowork');
      void coworkService.loadSession(sessionId);
    });
    void window.electron.cowork.notifyOpenSessionFromNotificationReady?.();
    return unsubscribe;
  }, []);

  // Tell the main process which session is currently visible so desktop
  // notifications for that session can be suppressed and cleared.
  useEffect(() => {
    const visibleSessionId = mainView === 'cowork' && !showSettings ? currentSessionId ?? null : null;
    void window.electron.cowork.setActiveSession?.(visibleSessionId)?.catch?.((error: unknown) => {
      console.debug('[App] failed to report active session:', error);
    });
  }, [mainView, showSettings, currentSessionId]);

  useEffect(() => {
    if (!isInitialized) return;

    // Enterprise mode: completely skip update detection
    if (enterpriseConfig?.disableUpdate) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async (reason: 'startup' | 'heartbeat' | 'visibility' | 'online') => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < APP_UPDATE_POLL_INTERVAL_MS) return;
      // 离线时不发起注定失败的检查（休眠唤醒后网络栈尚未恢复的窗口会返回
      // ERR_NETWORK_IO_SUSPENDED），等 'online' 事件再补查。
      if (!navigator.onLine) {
        console.log(`[App] auto update check skipped while offline, reason=${reason}`);
        return;
      }
      lastCheckTime = now;
      console.log(`[App] auto update check triggered, reason=${reason}, at=${new Date(now).toISOString()}`);
      const ok = await runUpdateCheck();
      // 失败的检查不占用 2 小时轮询窗口：释放门槛让 30 分钟心跳、
      // 窗口重新可见或网络恢复时能尽快重试。
      if (!ok && !cancelled && lastCheckTime === now) {
        lastCheckTime = 0;
      }
    };

    // 启动时立即检查
    void maybeCheck('startup');

    // 心跳：每 30 分钟检测是否距上次检查已超过 2 小时
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

    // 网络恢复时补一次检查（唤醒场景下网络恢复晚于窗口可见，
    // 离线跳过的那次检查在这里补上）
    const handleOnline = () => {
      void maybeCheck('online');
    };
    window.addEventListener('online', handleOnline);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [isInitialized, runUpdateCheck, enterpriseConfig]);

  // 根据场景选择使用哪个权限组件。最小化时保持组件挂载（仅视觉隐藏），
  // 避免重新展开后丢失用户已选择/已输入的内容；key 按 requestId 隔离不同请求的状态。
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
            key={pendingPermission.requestId}
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
            onMinimize={handleMinimizePermission}
            hidden={isPendingPermissionMinimized}
          />
        );
      }
    }

    // 其他情况使用原有的权限模态框
    return (
      <CoworkPermissionModal
        key={pendingPermission.requestId}
        permission={pendingPermission}
        onRespond={handlePermissionResponse}
        onMinimize={handleMinimizePermission}
        hidden={isPendingPermissionMinimized}
      />
    );
  }, [pendingPermission, handlePermissionResponse, handleMinimizePermission, isPendingPermissionMinimized]);

  const isOverlayActive = showSettings
    || showUpdateModal
    || showUpdateInstallConfirm
    || isPermissionModalOpen
    || isUpdateInteractionBlocked
    || shouldShowNewUserOnboarding;
  // Downloads stay silent: the badge and sidebar card only appear once the
  // installer is ready or the update needs the user's attention.
  const shouldShowUpdateNotice = shouldShowAppUpdateNotice(appUpdateState);
  const updateBadge = shouldShowUpdateNotice ? (
    <AppUpdateBadge
      updateState={appUpdateState}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const updateCard = shouldShowUpdateNotice ? (
    <AppUpdateCard
      updateState={appUpdateState}
      onUpdate={handleConfirmUpdate}
      onShowDetails={handleOpenUpdateModal}
      onExpandedChange={setIsUpdateCardExpanded}
    />
  ) : null;
  const canUseWindowsTopBarActions = isInitialized && !initError && !isUpdateInteractionBlocked;
  const canUseWindowsCollapsedTopBarActions = canUseWindowsTopBarActions && isSidebarCollapsed;
  const collapsedHeaderUpdateBadge = isSidebarCollapsed && !isWindows ? updateBadge : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <WindowsAppTitleBar
      isOverlayActive={isOverlayActive}
      isSidebarCollapsed={isSidebarCollapsed}
      sidebarWidth={sidebarWidth}
      onToggleSidebar={canUseWindowsTopBarActions ? handleToggleSidebar : undefined}
      onSearch={canUseWindowsTopBarActions && !isSidebarCollapsed
        ? handleOpenTaskSearch
        : undefined}
      onNewChat={canUseWindowsCollapsedTopBarActions ? handleNewChat : undefined}
      sidebarToggleLabel={isSidebarCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
      searchLabel={i18nService.t('search')}
      showFilterIcon={SIDEBAR_TASK_FILTER_ENABLED && canUseWindowsTopBarActions && !isSidebarCollapsed && mainView === 'cowork'}
      filterLabel={i18nService.t('sidebarFilter')}
      isFilterActive={isTaskFilterActive}
      hasFilterNotice={hasUnreadCompletedTasks}
      onToggleFilter={handleToggleTaskFilter}
      newChatLabel={i18nService.t('newChat')}
      updateBadge={canUseWindowsCollapsedTopBarActions ? updateBadge : null}
    />
  ) : null;

  if (!isInitialized) {
    // index.html's static splash shows the same startup page until React
    // mounts; rendering EngineStartupOverlay from the first frame keeps the
    // whole startup on one continuous screen with no visual handoff.
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 bg-surface" />
        <EngineStartupOverlay bootstrapping />
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
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={handleInitRetry}
                className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium"
              >
                {i18nService.t('retry')}
              </button>
              <button
                onClick={() => window.electron.appInfo.relaunch()}
                className="px-6 py-2.5 border border-border text-foreground hover:bg-surface-raised rounded-xl transition-colors text-sm font-medium"
              >
                {i18nService.t('restartApp')}
              </button>
              {enterpriseConfigLoaded && privacyAgreed === true && (
                <button
                  onClick={() => handleShowSettings()}
                  className="px-6 py-2.5 border border-border text-foreground hover:bg-surface-raised rounded-xl transition-colors text-sm font-medium"
                >
                  {i18nService.t('openSettings')}
                </button>
              )}
            </div>
          </div>
          {showSettings && (
            <SkinProvider>
              <Settings
                onClose={handleCloseSettings}
                initialTab={settingsOptions.initialTab}
                initialTabRequestId={settingsOptions.requestId}
                notice={settingsOptions.notice}
                onUpdateFound={handleUpdateFound}
                enterpriseConfig={enterpriseConfig}
              />
            </SkinProvider>
          )}
        </div>
      </div>
    );
  }

  return (
    <SkinProvider>
      <SkinPresentationScope
        enabled
        className="h-screen overflow-hidden flex flex-col bg-surface-raised"
      >
      {toastMessage && (
        <Toast
          message={toastMessage.message}
          actionLabel={toastMessage.actionLabel}
          onAction={toastMessage.onAction}
          closeLabel={i18nService.t('close')}
          onClose={() => setToastMessage(null)}
        />
      )}
      <StartupCreditCampaign
        enabled={privacyAgreed === true && !isEnterpriseAccount}
      />
      {windowsStandaloneTitleBar}
      <div
        className="relative flex flex-1 min-h-0 overflow-hidden"
        aria-busy={isUpdateInteractionBlocked}
      >
        <Sidebar
          onShowLogin={handleShowLogin}
          onShowSettings={handleShowSettings}
          activeView={mainView}
          onShowSkills={handleShowSkills}
          onShowCowork={handleShowCowork}
          onShowScheduledTasks={handleShowScheduledTasks}
          onShowKits={handleShowKits}
          onShowLibrary={handleShowLibrary}
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          isTaskFilterActive={isTaskFilterActive}
          hasUnreadCompletedTasks={hasUnreadCompletedTasks}
          onToggleTaskFilter={handleToggleTaskFilter}
          onTaskFilterSummaryChange={setHasUnreadCompletedTasks}
          onWidthChange={setSidebarWidth}
          updateNotice={!isSidebarCollapsed && !isUpdateInteractionBlocked ? updateCard : null}
          hideAdBanner={isUpdateCardExpanded}
          hideLogin={enterpriseConfig?.ui?.login === 'hide'}
          isEngineStartupOverlayVisible={isEngineStartupOverlayVisible}
        />
        <div className={`flex-1 min-w-0 transition-[padding] duration-200 ease-out ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div
            data-skin-cowork-frame={mainView === 'cowork' ? 'true' : undefined}
            data-skin-management-frame={mainView !== 'cowork' ? 'true' : undefined}
            className="relative h-full min-h-0 rounded-xl border border-border bg-background overflow-hidden"
          >
            {mainView !== 'cowork' && (
              <SkinBackdrop variant={SkinBackdropVariant.Management} />
            )}
            <EngineStartupOverlay />
            {mainView === 'skills' || mainView === 'mcp' ? (
              <SkillsAndConnectorsView
                activeSection={mainView === 'mcp' ? SkillsConnectorsSection.Connectors : SkillsConnectorsSection.Skills}
                onSectionChange={handleSkillsConnectorsSectionChange}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                onCreateSkillByChat={handleCreateSkillByChat}
                onUseSkill={handleSkillUse}
                updateBadge={collapsedHeaderUpdateBadge}
                skillsReadOnly={enterpriseConfig?.ui?.skills === 'readonly'}
              />
            ) : mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
              />
            ) : mainView === 'kits' ? (
              <KitsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
                onTryAsking={handleKitTryAsking}
                onUseKit={handleKitUse}
              />
            ) : mainView === 'library' ? (
              <LibraryView
                isAuthenticated={Boolean(authUser)}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onOpenSession={handleOpenLibrarySession}
                sitesHidden={enterpriseConfig?.ui?.sites === 'hide'}
                sitesReadOnly={enterpriseConfig?.ui?.sites === 'readonly'}
                updateBadge={collapsedHeaderUpdateBadge}
                requestedSource={libraryNavigationRequest.source}
                navigationRequestId={libraryNavigationRequest.requestId}
              />
            ) : (
              <CoworkView
                onRequestAppSettings={handleShowSettings}
                onShowSkills={handleShowSkills}
                onShowKits={handleShowKits}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
                minimizedPermission={isPendingPermissionMinimized ? pendingPermission : null}
                onRestorePermission={handleRestorePermission}
                onRespondToPermission={handlePermissionResponse}
              />
            )}
          </div>
        </div>
        {isUpdateInteractionBlocked && (
          <AppUpdateInteractionOverlay>
            <AppUpdateBlockingPanel updateState={appUpdateState} />
          </AppUpdateInteractionOverlay>
        )}
        {shouldShowNewUserOnboarding && (
          <NewUserOnboardingOverlay
            step={newUserOnboardingStep}
            onNext={handleNewUserOnboardingNext}
            onSkip={handleNewUserOnboardingSkip}
            onStartExperience={handleNewUserOnboardingStartExperience}
          />
        )}
      </div>

      <EngineFailureOverlay
        onRequestAppSettings={handleShowSettings}
        suspended={showSettings || showUpdateModal || showUpdateInstallConfirm || isPermissionModalOpen}
      />

      {/* 设置窗口显示在所有主内容之上，但不影响主界面的交互 */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          onStartAiSkin={handleStartAiSkinFromSettings}
          initialTab={settingsOptions.initialTab}
          initialTabRequestId={settingsOptions.requestId}
          notice={settingsOptions.notice}
          onUpdateFound={handleUpdateFound}
          enterpriseConfig={enterpriseConfig}
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateState={appUpdateState}
          onCancel={() => {
            if (appUpdateState.status !== AppUpdateStatus.Installing) {
              setShowUpdateModal(false);
            }
          }}
          onConfirm={handleConfirmUpdate}
          onRetry={handleRetryUpdate}
        />
      )}
      {showUpdateInstallConfirm && (
        <AppUpdateInstallConfirmDialog
          onCancel={() => setShowUpdateInstallConfirm(false)}
          onConfirm={() => void installReadyUpdate()}
        />
      )}
      {permissionModal}
      </SkinPresentationScope>
    </SkinProvider>
  );
};

export default App;
