import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { CoworkBrowserAnnotationMessageBatch } from '@shared/cowork/browserAnnotations';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { buildGoalSettingMessageMetadata } from '../../../common/goalCommandDisplay';
import { buildSessionTitleFromInput, buildSessionTitleInput } from '../../../common/sessionTitle';
import { BlankDocumentKind } from '../../../shared/artifactPreview/blankDocument';
import { COWORK_TEMP_SESSION_ID_PREFIX } from '../../../shared/cowork/constants';
import { buildCoworkImageAttachmentPreviews } from '../../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import {
  HOME_SHOWCASE_EXPLORE_MORE_ID,
  type HomeShowcasePrimaryEntryId,
} from '../../../shared/homeShowcase/constants';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import startupCreditEntryGiftUrl from '../../assets/startup-credit-entry-gift.svg';
import { EnterpriseQuotaPrompt } from '../../features/enterpriseAccount/components/EnterpriseQuotaPrompt';
import { refreshEnterpriseAccountContext } from '../../features/enterpriseAccount/context';
import {
  selectEnterpriseAccountContext,
  selectIsEnterpriseAccount,
} from '../../features/enterpriseAccount/selectors';
import { agentService } from '../../services/agent';
import { openWorkspaceDirectoryInSystem } from '../../services/artifactWorkspace';
import { coworkService } from '../../services/cowork';
import { buildCoworkCapabilitySelection } from '../../services/coworkCapabilitySelection';
import { i18nService } from '../../services/i18n';
import { quickActionService } from '../../services/quickAction';
import { RootState, store } from '../../store';
import {
  selectCurrentSession,
  selectIsStreaming,
  selectSessionNavigationTargetId,
} from '../../store/selectors/coworkSelectors';
import { addMessage, setCurrentSession, setDraftCollaborationMode, setDraftKitIds, setDraftSkillIds, setStreaming, updateSessionGoal, updateSessionStatus } from '../../store/slices/coworkSlice';
import { clearActiveKits } from '../../store/slices/kitSlice';
import { clearSelection, selectAction, setActions } from '../../store/slices/quickActionSlice';
import { clearActiveSkills, setActiveSkillIds } from '../../store/slices/skillSlice';
import {
  CoworkCollaborationMode,
  type CoworkCollaborationMode as CoworkCollaborationModeType,
  type CoworkImageAttachment,
  type CoworkPermissionRequest,
  type CoworkPermissionResult,
  type CoworkSession,
  type OpenClawEngineStatus,
  type SubagentSessionSummary,
} from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import { isDefaultAgentId, usesManagedPresetAvatar } from '../../utils/agentDisplay';
import { applyOptimisticGoalCommand } from '../../utils/goalCommand';
import AgentSettingsPanel from '../agent/AgentSettingsPanel';
import { ArtifactNewTabContent, ArtifactPanel } from '../artifacts';
import { ArtifactFileShareProvider } from '../artifacts/ArtifactFileShareController';
import ImageStudioHost from '../artifacts/imageEditor/ImageStudioHost';
import CreditsResetCampaignFloat from '../CreditsResetCampaignFloat';
import { DailyCheckInHeaderEntry } from '../DailyCheckInActivity';
import HomeCreditsBadge from '../HomeCreditsBadge';
import HomeShowcaseHub from '../homeShowcase/HomeShowcaseHub';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import { ModelAccessPromptKind, ModelAccessPromptModal } from '../ModelSelector';
import type { SettingsOpenOptions } from '../Settings';
import HomeSkinEmblem from '../skin/HomeSkinEmblem';
import SkinAmbientEffects from '../skin/SkinAmbientEffects';
import SkinBackdrop, { SkinBackdropVariant } from '../skin/SkinBackdrop';
import {
  openStartupCreditCampaign,
  useStartupCreditCampaignEntry,
} from '../startupCreditCampaignBridge';
import { MAC_TRAFFIC_LIGHT_INSET_CLASS } from '../window/windowZoom';
import AgentHomeHero from './AgentHomeHero';
import {
  ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH,
  ArtifactPanelErrorBoundary,
  COWORK_DETAIL_MIN_WIDTH,
  PromptInputCollapseIcon,
  PromptInputExpandIcon,
} from './artifactPanelChrome';
import { CoworkUiEvent } from './constants';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import CoworkSessionDetail from './CoworkSessionDetail';
import {
  buildCoworkStartPlan,
  COWORK_START_BLOCK_MESSAGE_KEYS,
  CoworkStartBlock,
  isOpenClawReadyForSession,
  resolveCoworkStartBlock,
  shouldShowCoworkEngineNotice,
} from './coworkStartRequest';
import HomeArtifactPanelHeader from './HomeArtifactPanelHeader';
import {
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
} from './messageDisplayUtils';
import { reportPromptTemplateAction } from './promptAnalytics';
import SessionSwipeNavigator from './SessionSwipeNavigator';
import { buildCoworkContinuationSystemPrompt } from './skillSystemPrompt';
import { useHomeArtifactPanel } from './useHomeArtifactPanel';
import { useHomeStartContext } from './useHomeStartContext';

export const HOME_HEADLINE_FONT_FAMILY = '"Lobster Home Serif", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", Georgia, Cambria, "Times New Roman", "Songti SC", "STSong", serif';

const EMPTY_SUBAGENTS: SubagentSessionSummary[] = [];

const logCoworkViewModel = (message: string, level: 'debug' | 'warn' = 'debug'): void => {
  if (level === 'warn') console.warn(`[CoworkView] ${message}`);
  else console.debug(`[CoworkView] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.(level, 'CoworkView', message.slice(0, 500));
  } catch {
    // Diagnostics must never interrupt model selection.
  }
};

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  onShowSkills?: () => void;
  onShowKits?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  minimizedPermission?: CoworkPermissionRequest | null;
  onRestorePermission?: () => void;
  onRespondToPermission?: (result: CoworkPermissionResult) => void;
}

const CoworkView: React.FC<CoworkViewProps> = ({
  onRequestAppSettings,
  onShowSkills,
  onShowKits,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  minimizedPermission,
  onRestorePermission,
  onRespondToPermission,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const [isInitialized, setIsInitialized] = useState(() => coworkService.isInitialized());
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawEngineStatus | null>(
    () => coworkService.getOpenClawEngineStatusSnapshot(),
  );
  const [isRestartingGateway, setIsRestartingGateway] = useState(false);
  // Shown when a session start is blocked because no usable model config exists;
  // guides the user to plan models instead of pushing them into custom-model settings.
  const [modelAccessPrompt, setModelAccessPrompt] = useState<ModelAccessPromptKind | null>(null);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [agentHeroMetaRevision, setAgentHeroMetaRevision] = useState(0);
  // Track if we're starting/continuing a session to prevent duplicate submissions
  const isStartingRef = useRef(false);
  const isContinuingRef = useRef(false);
  // Track pending start request so stop can cancel delayed startup.
  const pendingStartRef = useRef<{
    requestId: number;
    cancelled: boolean;
    cancellationAction: 'stop' | 'delete' | null;
  } | null>(null);
  const startRequestIdRef = useRef(0);
  // Ref for CoworkPromptInput
  const promptInputRef = useRef<CoworkPromptInputRef>(null);

  const currentSession = useSelector(selectCurrentSession);
  const isHomeView = !currentSession;
  const sessionNavigationTargetId = useSelector(selectSessionNavigationTargetId);
  const isStreaming = useSelector(selectIsStreaming);
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const enterpriseAccountContext = useSelector(selectEnterpriseAccountContext);
  const isEnterpriseAccount = useSelector(selectIsEnterpriseAccount);
  const enterpriseAccountId = enterpriseAccountContext?.enterpriseId;
  const hasEnterpriseAccount = enterpriseAccountContext !== null;
  const currentSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    currentSessionIdRef.current = currentSession?.id ?? null;
  }, [currentSession?.id]);

  useEffect(() => {
    if (!isHomeView || !hasEnterpriseAccount) return;
    void refreshEnterpriseAccountContext();
  }, [enterpriseAccountId, hasEnterpriseAccount, isHomeView]);
  const {
    config,
    currentAgentId,
    currentAgent,
    workingDirectory: currentAgentWorkingDirectory,
    selectedModel: currentAgentSelectedModel,
    selectedModelRef: currentAgentSelectedModelRef,
    startModel: homeStartModel,
    usesServerQuota: homeModelUsesServerQuota,
    quotaReason: homeQuotaReason,
    blockingQuotaReason: blockingHomeQuotaReason,
    thinkingLevel: currentAgentThinkingLevel,
  } = useHomeStartContext();

  const homePanel = useHomeArtifactPanel({
    isActive: isHomeView,
    workingDirectory: currentAgentWorkingDirectory,
    promptInputRef,
  });

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const quickActions = useSelector((state: RootState) => state.quickAction.actions);
  const selectedActionId = useSelector((state: RootState) => state.quickAction.selectedActionId);
  const startupCreditEntry = useStartupCreditCampaignEntry();
  const shouldPresentConversation = Boolean(currentSession || sessionNavigationTargetId);
  const homeDraftCollaborationMode = useSelector((state: RootState) => (
    state.cowork.draftCollaborationModes.__home__ || CoworkCollaborationMode.Default
  ));
  const mediaSelection = useSelector((state: RootState) => {
    const key = currentSession?.id || '__home__';
    return state.cowork.mediaSelection[key];
  });

  useEffect(() => {
    if (!homeStartModel.unavailableModelRef) return;
    logCoworkViewModel(
      `agent ${currentAgentId} model ${homeStartModel.unavailableModelRef} is unavailable; new sessions would use ${currentAgentSelectedModelRef || 'none'}`
        + (homeStartModel.crossesBillingSide ? ', which bills the other side, so starting is blocked' : ''),
      homeStartModel.crossesBillingSide ? 'warn' : 'debug',
    );
  }, [
    currentAgentId,
    currentAgentSelectedModelRef,
    homeStartModel.crossesBillingSide,
    homeStartModel.unavailableModelRef,
  ]);

  useEffect(() => {
    if (!isHomeView || !hasEnterpriseAccount) return;
    if (!homeQuotaReason) {
      logCoworkViewModel('enterprise quota gate inactive; no blocking reason');
      return;
    }
    if (blockingHomeQuotaReason) {
      logCoworkViewModel(
        homeModelUsesServerQuota
          ? `enterprise quota gate active for ${homeQuotaReason}; model ${currentAgentSelectedModelRef || 'unresolved'} uses server quota`
          : `enterprise quota gate active for ${homeQuotaReason}; selected model is unresolved`,
      );
      return;
    }
    logCoworkViewModel(
      `enterprise quota gate bypassed for ${homeQuotaReason}; model ${currentAgentSelectedModelRef || 'unresolved'} does not use enterprise quota`,
    );
  }, [
    blockingHomeQuotaReason,
    currentAgentSelectedModelRef,
    hasEnterpriseAccount,
    homeModelUsesServerQuota,
    homeQuotaReason,
    isHomeView,
  ]);

  const buildCapabilitySelection = useCallback((skillIds: string[], kitIds: string[]) => {
    return buildCoworkCapabilitySelection(
      skillIds,
      kitIds,
      skills,
      installedKits,
      marketplaceKits,
    );
  }, [installedKits, marketplaceKits, skills]);

  const resolveEngineStatusText = (status: OpenClawEngineStatus): string => {
    switch (status.phase) {
      case OpenClawEnginePhase.NotInstalled:
        return i18nService.t('coworkOpenClawNotInstalledNotice');
      case OpenClawEnginePhase.Installing:
        return i18nService.t('coworkOpenClawInstalling');
      case OpenClawEnginePhase.Ready:
        return i18nService.t('coworkOpenClawReadyNotice');
      case OpenClawEnginePhase.Starting:
        return i18nService.t('coworkOpenClawStarting');
      case OpenClawEnginePhase.Error:
        return i18nService.t('coworkOpenClawError');
      case OpenClawEnginePhase.Running:
      default:
        return i18nService.t('coworkOpenClawRunning');
    }
  };

  const handleRestartGateway = async () => {
    if (isRestartingGateway) return;
    setIsRestartingGateway(true);
    try {
      await coworkService.restartOpenClawGateway();
    } catch (error) {
      console.error('[CoworkView] Failed to restart gateway:', error);
    } finally {
      setIsRestartingGateway(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    quickActionService.initialize();
    void quickActionService.getLocalizedActions()
      .then((actions) => {
        if (!cancelled) {
          dispatch(setActions(actions));
        }
      })
      .catch((error) => {
        console.error('[CoworkView] failed to load quick actions:', error);
      });

    const init = async () => {
      try {
        await coworkService.init();
        const initialEngineStatus = coworkService.getOpenClawEngineStatusSnapshot();
        if (!cancelled && initialEngineStatus) {
          setOpenClawStatus(initialEngineStatus);
        }
      } catch (error) {
        console.error('[CoworkView] initialization failed:', error);
        try {
          window.electron?.log?.fromRenderer?.(
            'error',
            'CoworkView',
            `initialization failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } catch {
          // Diagnostic logging must not keep the view in a loading state.
        }
      } finally {
        if (!cancelled) {
          // Individual service stages are best-effort and can recover via
          // their event listeners; never leave the whole view spinning.
          setIsInitialized(true);
        }
      }
      // Intentionally no API-config check here: mounting this view (e.g. when
      // switching sidebar tabs) must never pop up the custom-model settings
      // page. Missing config is surfaced at send time instead.
    };
    void init();

    const unsubscribeOpenClawStatus = coworkService.onOpenClawEngineStatus((status) => {
      setOpenClawStatus(status);
    });

    // Subscribe to language changes to reload quick actions
    const unsubscribe = quickActionService.subscribe(async () => {
      try {
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to reload quick actions:', error);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeOpenClawStatus();
    };
  }, [dispatch]);

  const handleStartSession = async (
    prompt: string,
    skillPrompt?: string,
    imageAttachments?: CoworkImageAttachment[],
    mediaReferences?: MediaAttachmentRef[],
    selectedTextSnippets?: CoworkSelectedTextSnippet[],
    browserAnnotations?: CoworkBrowserAnnotationMessageBatch[],
    collaborationMode: CoworkCollaborationModeType = CoworkCollaborationMode.Default,
    titleInput: string = buildSessionTitleInput(prompt),
  ): Promise<boolean | void> => {
    console.log('[CoworkView] handleStartSession: imageAttachments diagnosis', {
      hasImageAttachments: !!imageAttachments,
      count: imageAttachments?.length ?? 0,
      details: imageAttachments?.map(a => ({ name: a.name, mimeType: a.mimeType, base64Length: a.base64Data?.length ?? 0 })) ?? [],
    });
    const startBlock = resolveCoworkStartBlock({
      blockingQuotaReason: blockingHomeQuotaReason,
      engineStatus: openClawStatus,
      crossesBillingSide: homeStartModel.crossesBillingSide,
    });
    if (startBlock) {
      if (startBlock === CoworkStartBlock.EnterpriseQuota) {
        logCoworkViewModel(`blocked new session submission for enterprise quota reason ${blockingHomeQuotaReason}`);
      } else if (startBlock === CoworkStartBlock.ModelBillingSide) {
        logCoworkViewModel(
          `blocked new session: agent model ${homeStartModel.unavailableModelRef} is unavailable and ${currentAgentSelectedModelRef || 'none'} bills the other side`,
          'warn',
        );
      }
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t(COWORK_START_BLOCK_MESSAGE_KEYS[startBlock]) }));
      return false;
    }
    // Prevent duplicate submissions
    if (isStartingRef.current) return false;
    isStartingRef.current = true;
    const requestId = ++startRequestIdRef.current;
    pendingStartRef.current = { requestId, cancelled: false, cancellationAction: null };
    const isPendingStartCancelled = () => {
      const pending = pendingStartRef.current;
      return !pending || pending.requestId !== requestId || pending.cancelled;
    };
    const getPendingCancellationAction = () => {
      const pending = pendingStartRef.current;
      if (!pending || pending.requestId !== requestId || !pending.cancelled) {
        return null;
      }
      return pending.cancellationAction;
    };

    try {
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          // No usable model config: steer toward plan models (login/subscribe)
          // rather than opening the custom-model settings page uninvited.
          setModelAccessPrompt(
            isLoggedIn ? ModelAccessPromptKind.Subscribe : ModelAccessPromptKind.Login,
          );
          isStartingRef.current = false;
          return false;
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }

      // Create a temporary session with user message to show immediately
      const tempSessionId = `${COWORK_TEMP_SESSION_ID_PREFIX}${Date.now()}`;
      const fallbackTitle = buildSessionTitleFromInput(
        prompt,
        i18nService.t('coworkDefaultSessionTitle')
      );
      const now = Date.now();
      const optimisticGoal = applyOptimisticGoalCommand(prompt, null, tempSessionId, now);

      // Capture active skill IDs and kit IDs before clearing them
      const sessionSkillIds = [...activeSkillIds];
      const sessionKitIds = [...activeKitIds];

      const capabilities = buildCapabilitySelection(sessionSkillIds, sessionKitIds);
      const { kitReferences, resolvedKitCapabilities } = capabilities;
      const startPlan = buildCoworkStartPlan({
        prompt,
        title: fallbackTitle,
        skillPrompt,
        configSystemPrompt: config.systemPrompt,
        kitIds: sessionKitIds,
        capabilities,
        inheritedSkillIds: store.getState().cowork.draftInheritedSkillIds.__home__,
        collaborationMode,
        cwd: currentAgentWorkingDirectory,
        agentId: currentAgentId,
        modelRef: currentAgentSelectedModelRef,
        modelPresetId: currentAgentSelectedModel?.presetId,
        thinkingLevel: currentAgentThinkingLevel,
        imageAttachments,
        mediaSelection,
        mediaReferences,
        selectedTextSnippets,
        browserAnnotations,
      });
      const isPlanMode = startPlan.isPlanMode;
      const goalSettingMetadata = buildGoalSettingMessageMetadata(prompt);
      const displayDirectSkillIds = startPlan.displaySkillIds;
      const displayKitIds = startPlan.displayKitIds;
      const effectiveRuntimeSkillIds = startPlan.runtimeSkillIds;
      if (startPlan.suppressedCapabilities) {
        logCoworkViewModel('suppressed selected capabilities for a plan-mode start turn');
      }
      const imageAttachmentPreviews = buildCoworkImageAttachmentPreviews(imageAttachments);

      const tempSession: CoworkSession = {
        id: tempSessionId,
        title: fallbackTitle,
        claudeSessionId: null,
        scheduledTaskId: null,
        status: 'running',
        pinned: false,
        createdAt: now,
        updatedAt: now,
        cwd: currentAgentWorkingDirectory,
        systemPrompt: '',
        modelOverride: currentAgentSelectedModelRef,
        thinkingLevel: currentAgentThinkingLevel ?? '',
        executionMode: config.executionMode || 'local',
        activeSkillIds: effectiveRuntimeSkillIds,
        activeKitIds: displayKitIds.length > 0 ? displayKitIds : undefined,
        agentId: currentAgentId,
        ...(optimisticGoal !== undefined ? { goal: optimisticGoal } : {}),
        messages: [
          {
            id: `msg-${now}`,
            type: 'user',
            content: prompt,
            timestamp: now,
            metadata: (displayDirectSkillIds.length > 0 || displayKitIds.length > 0 || imageAttachmentPreviews?.length || (selectedTextSnippets && selectedTextSnippets.length > 0) || (browserAnnotations && browserAnnotations.length > 0) || goalSettingMetadata)
              ? {
                ...goalSettingMetadata,
                ...(displayDirectSkillIds.length > 0 ? { skillIds: displayDirectSkillIds } : {}),
                ...(displayKitIds.length > 0 ? {
                  kitIds: displayKitIds,
                  kitReferences,
                  resolvedKitCapabilities,
                } : {}),
                ...(selectedTextSnippets && selectedTextSnippets.length > 0 ? { selectedTextSnippets } : {}),
                ...(browserAnnotations && browserAnnotations.length > 0 ? { browserAnnotations } : {}),
                ...(imageAttachmentPreviews?.length ? { imageAttachmentPreviews } : {}),
              }
              : undefined,
          },
        ],
        messagesOffset: 0,
        totalMessages: 1,
      };

      // Immediately show the session detail page with user message
      dispatch(setCurrentSession(tempSession));
      currentSessionIdRef.current = tempSessionId;
      if (isPlanMode) {
        dispatch(setDraftCollaborationMode({
          draftKey: tempSessionId,
          mode: CoworkCollaborationMode.Plan,
        }));
      }
      dispatch(setStreaming(true));

      // Clear active skills, kits and quick action selection after starting session
      // so they don't persist to next session
      dispatch(clearActiveSkills());
      dispatch(clearActiveKits());
      dispatch(setDraftKitIds({ draftKey: '__home__', kitIds: [] }));
      dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: [] }));
      dispatch(clearSelection());

      // Start the actual session immediately with fallback title
      logCoworkViewModel(
        `creating session with model ${currentAgentSelectedModelRef || 'default'}; agent model is ${currentAgent?.model || 'empty'}; server quota model is ${homeModelUsesServerQuota}`,
      );
      const { session: startedSession, error: startError } = await coworkService.startSession(startPlan.options);

      if (!startedSession && startError) {
        // Show the error as a system message in the temp session
        dispatch(addMessage({
          sessionId: tempSessionId,
          message: {
            id: `error-${Date.now()}`,
            type: 'system',
            content: i18nService.t('coworkErrorSessionStartFailed').replace('{error}', startError),
            timestamp: Date.now(),
          },
        }));
        dispatch(updateSessionStatus({ sessionId: tempSessionId, status: 'error' }));
        return false;
      }
      if (!startedSession) {
        return false;
      }
      if (currentSessionIdRef.current === tempSessionId) {
        logCoworkViewModel(`replacing temp session ${tempSessionId} with started session ${startedSession.id}`);
        dispatch(setCurrentSession(startedSession));
        dispatch(setStreaming(startedSession.status === 'running'));
        currentSessionIdRef.current = startedSession.id;
      } else {
        logCoworkViewModel(
          `skipped temp session replacement for ${startedSession.id}; `
          + `current=${currentSessionIdRef.current ?? 'none'} temp=${tempSessionId}`,
        );
      }
      if (!startedSession.goal && optimisticGoal !== undefined) {
        const startedGoal = applyOptimisticGoalCommand(prompt, null, startedSession.id, Date.now());
        if (startedGoal !== undefined) {
          console.debug(`[CoworkGoal] applying optimistic goal after session start for session ${startedSession.id}.`);
          dispatch(updateSessionGoal({ sessionId: startedSession.id, goal: startedGoal }));
        }
      }
      if (isPlanMode) {
        dispatch(setDraftCollaborationMode({
          draftKey: startedSession.id,
          mode: CoworkCollaborationMode.Plan,
        }));
      }

      // Stop immediately if user cancelled while startup request was in flight.
      if (isPendingStartCancelled() && startedSession) {
        await coworkService.stopSession(startedSession.id);
        if (getPendingCancellationAction() === 'delete') {
          await coworkService.deleteSession(startedSession.id);
        }
      } else {
        void coworkService.generateSessionTitle(startedSession.id, titleInput, startedSession.title);
      }
    } finally {
      if (pendingStartRef.current?.requestId === requestId) {
        pendingStartRef.current = null;
      }
      isStartingRef.current = false;
    }
  };

  const handleStartGoalSession = (command: string) => {
    console.debug('[CoworkGoal] dispatching new goal session from home prompt.');
    void handleStartSession(command);
  };

  const handleContinueSession = async (
    prompt: string,
    skillPrompt?: string,
    imageAttachments?: CoworkImageAttachment[],
    mediaReferences?: MediaAttachmentRef[],
    selectedTextSnippets?: CoworkSelectedTextSnippet[],
    browserAnnotations?: CoworkBrowserAnnotationMessageBatch[],
    collaborationMode: CoworkCollaborationModeType = CoworkCollaborationMode.Default,
    titleInput?: string,
  ) => {
    if (!currentSession) return false;
    // A rejected start only exists in the optimistic UI, not in the database.
    // Once the engine recovers, a new submission must create a real session.
    if (currentSession.id.startsWith(COWORK_TEMP_SESSION_ID_PREFIX)) {
      return handleStartSession(
        prompt, skillPrompt, imageAttachments, mediaReferences,
        selectedTextSnippets, browserAnnotations, collaborationMode, titleInput,
      );
    }
    // Prevent duplicate submissions
    if (isContinuingRef.current) return false;
    if (openClawStatus && !isOpenClawReadyForSession(openClawStatus)) {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('coworkErrorEngineNotReady') }));
      return false;
    }

    isContinuingRef.current = true;
    try {
      console.log('[CoworkView] handleContinueSession called', {
        hasImageAttachments: !!imageAttachments,
        imageAttachmentsCount: imageAttachments?.length ?? 0,
        imageAttachmentsNames: imageAttachments?.map(a => a.name),
        imageAttachmentsBase64Lengths: imageAttachments?.map(a => a.base64Data.length),
      });

      // Capture active skill IDs and kit IDs before clearing
      const sessionSkillIds = [...activeSkillIds];
      const sessionKitIds = [...activeKitIds];

      const {
        directSkillIds,
        runtimeSkillIds,
        kitReferences,
        resolvedKitCapabilities,
      } = buildCapabilitySelection(sessionSkillIds, sessionKitIds);
      const isPlanMode = collaborationMode === CoworkCollaborationMode.Plan;
      const displayDirectSkillIds = directSkillIds;
      const displayKitIds = sessionKitIds;
      const effectiveRuntimeSkillIds = isPlanMode ? [] : runtimeSkillIds;
      if (isPlanMode && (directSkillIds.length > 0 || runtimeSkillIds.length > 0 || sessionKitIds.length > 0)) {
        logCoworkViewModel('suppressed selected capabilities for a plan-mode continue turn');
      }

      // Only send a continuation system prompt when this turn selects new skills.
      // Otherwise the main process falls back to the session prompt created on the first turn.
      const combinedSystemPrompt = buildCoworkContinuationSystemPrompt(skillPrompt, config.systemPrompt);

      const sent = await coworkService.continueSession({
        sessionId: currentSession.id,
        prompt,
        systemPrompt: combinedSystemPrompt,
        activeSkillIds: displayDirectSkillIds.length > 0 ? displayDirectSkillIds : undefined,
        inheritedSkillIds: store.getState().cowork.draftInheritedSkillIds[currentSession.id],
        runtimeSkillIds: isPlanMode ? [] : (effectiveRuntimeSkillIds.length > 0 ? effectiveRuntimeSkillIds : undefined),
        kitIds: displayKitIds.length > 0 ? displayKitIds : undefined,
        kitReferences: displayKitIds.length > 0 ? kitReferences : undefined,
        resolvedKitCapabilities: displayKitIds.length > 0 ? resolvedKitCapabilities : undefined,
        imageAttachments,
        mediaSelection,
        mediaReferences,
        selectedTextSnippets,
        browserAnnotations,
      });
      if (sent && (sessionSkillIds.length > 0 || sessionKitIds.length > 0)) {
        dispatch(clearActiveSkills());
        dispatch(clearActiveKits());
        dispatch(setDraftKitIds({ draftKey: currentSession.id, kitIds: [] }));
        dispatch(setDraftSkillIds({ draftKey: currentSession.id, skillIds: [] }));
      }
      return sent;
    } finally {
      isContinuingRef.current = false;
    }
  };

  const handleStopSession = useCallback(async () => {
    if (!currentSession) return;
    if (currentSession.id.startsWith(COWORK_TEMP_SESSION_ID_PREFIX) && pendingStartRef.current) {
      pendingStartRef.current.cancelled = true;
      pendingStartRef.current.cancellationAction = 'stop';
    }
    await coworkService.stopSession(currentSession.id);
  }, [currentSession]);

  const handleHomeCategorySelect = (entryId: HomeShowcasePrimaryEntryId | null) => {
    const previousAction = quickActions.find(a => a.id === selectedActionId);
    if (!entryId || entryId === selectedActionId) {
      dispatch(clearSelection());
      if (previousAction && activeSkillIds.includes(previousAction.skillMapping)) {
        dispatch(setActiveSkillIds(activeSkillIds.filter(id => id !== previousAction.skillMapping)));
      }
      return;
    }

    dispatch(selectAction(entryId));
    const action = entryId === HOME_SHOWCASE_EXPLORE_MORE_ID
      ? undefined
      : quickActions.find(a => a.id === entryId);
    const targetSkill = action ? skills.find(s => s.id === action.skillMapping) : undefined;
    console.debug(`[CoworkView] reporting prompt template analytics: template_card_click ${entryId}`);
    reportPromptTemplateAction({
      templateActionType: 'template_card_click',
      templateId: entryId,
      templateName: action?.label ?? entryId,
      templateIndex: quickActions.findIndex(item => item.id === entryId),
      mappedSkillId: action?.skillMapping,
      mappedSkillName: targetSkill?.name,
      hasAutoEnabledSkill: Boolean(targetSkill),
      params: {
        promptCount: action?.prompts.length ?? 0,
        modelId: currentAgentSelectedModel?.id,
        modelName: currentAgentSelectedModel?.name,
        agentId: currentAgentId,
        isMainAgent: currentAgentId === 'main',
        isPlanMode: homeDraftCollaborationMode === CoworkCollaborationMode.Plan,
      },
    });
    if (targetSkill) {
      dispatch(setActiveSkillIds([targetSkill.id]));
    } else if (previousAction && activeSkillIds.includes(previousAction.skillMapping)) {
      dispatch(setActiveSkillIds(activeSkillIds.filter(id => id !== previousAction.skillMapping)));
    }
  };

  // When the mapped skill is deactivated from input area, restore the home category grid.
  // Only applies when the mapped skill exists (and thus was auto-enabled on select);
  // otherwise a missing skill would make the showcase gallery impossible to open.
  useEffect(() => {
    if (!selectedActionId) return;
    const action = quickActions.find(a => a.id === selectedActionId);
    if (action) {
      const mappedSkillExists = skills.some(s => s.id === action.skillMapping);
      if (mappedSkillExists && !activeSkillIds.includes(action.skillMapping)) {
        dispatch(clearSelection());
      }
    }
  }, [activeSkillIds, dispatch, quickActions, selectedActionId, skills]);

  useEffect(() => {
    const handleNewSession = () => {
      // Only clear when already on home (no session) — preserve __home__ draft when returning from a session
      const shouldClear = !currentSession;
      coworkService.clearSession({ restoreAgentSkills: true });
      dispatch(clearSelection());
      dispatch(setDraftCollaborationMode({
        draftKey: '__home__',
        mode: CoworkCollaborationMode.Default,
      }));
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: shouldClear, resetCollaborationMode: true },
      }));
    };
    window.addEventListener(CoworkUiEvent.ShortcutNewSession, handleNewSession);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutNewSession, handleNewSession);
    };
  }, [dispatch, currentSession]);

  useEffect(() => {
    window.addEventListener(CoworkUiEvent.ShortcutStopSession, handleStopSession);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutStopSession, handleStopSession);
    };
  }, [handleStopSession]);

  useEffect(() => {
    if (!currentSession || currentSession.status !== 'running') return;

    const runningSessionId = currentSession.id;
    const handleWindowFocus = () => {
      // A plain load returns only the latest message page, which would drop
      // the history already on screen mid-run; keep the loaded range instead.
      void coworkService.loadSession(runningSessionId, { preserveLoadedRange: true });
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [currentSession]);

  if (!isInitialized) {
    return <div className="flex-1 h-full flex flex-col bg-background" />;
  }

  const shouldShowEngineNotice = shouldShowCoworkEngineNotice(openClawStatus);
  const isEngineReady = openClawStatus === null || isOpenClawReadyForSession(openClawStatus);

  const homeHeader = (
    <div
      className={`draggable relative z-30 flex h-12 shrink-0 items-center justify-between overflow-visible ${
        homePanel.isArtifactPanelVisible ? 'border-b border-border' : ''
      } ${
        homePanel.isArtifactPanelExpanded ? 'bg-background pl-0 pr-4' : 'px-4'
      }`}
    >
      {!homePanel.isArtifactPanelExpanded && (
        <div
          className={`flex h-full min-w-0 flex-1 items-center justify-between gap-2 ${
            homePanel.isArtifactPanelVisible ? 'pr-3' : 'pr-2'
          }`}
        >
          <div className="non-draggable h-8 flex shrink-0 items-center">
            {isSidebarCollapsed && !isWindows && (
              <div className={`flex items-center gap-1 mr-2 ${isMac ? MAC_TRAFFIC_LIGHT_INSET_CLASS : ''}`}>
                <button
                  type="button"
                  onClick={onToggleSidebar}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                >
                  <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
                </button>
                <button
                  type="button"
                  onClick={onNewChat}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                >
                  <ComposeIcon className="h-4 w-4" />
                </button>
                {updateBadge}
              </div>
            )}
          </div>
          <div className="non-draggable flex min-w-0 items-center">
            {!isEnterpriseAccount && startupCreditEntry.available && (
              <button
                type="button"
                onClick={() => openStartupCreditCampaign()}
                className="mr-2 inline-flex h-8 max-w-[240px] items-center gap-2 rounded-full border border-[#F0B58E] bg-[#FFF7F0] px-3 text-xs font-medium text-[#7C351C] shadow-[0_3px_12px_rgba(235,94,40,0.16)] transition-colors hover:border-[#E89C6C] hover:bg-[#FFEBDD] dark:border-[#704530] dark:bg-[#352A25] dark:text-[#F5C4A5] dark:shadow-[0_3px_14px_rgba(0,0,0,0.32)] dark:hover:bg-[#403029]"
              >
                <img
                  src={startupCreditEntryGiftUrl}
                  alt=""
                  aria-hidden="true"
                  className="startup-credit-entry-gift h-5 w-5 shrink-0"
                />
                <span className="truncate">
                  {startupCreditEntry.label || i18nService.t('startupCreditMenuEntry')}
                </span>
              </button>
            )}
            <DailyCheckInHeaderEntry
              enabled={!isEnterpriseAccount}
              suppressed={!startupCreditEntry.resolved
                || startupCreditEntry.available}
            />
            <HomeCreditsBadge />
          </div>
        </div>
      )}
      <HomeArtifactPanelHeader
        isPanelOpen={homePanel.isPanelOpen}
        isArtifactPanelVisible={homePanel.isArtifactPanelVisible}
        isArtifactPanelTransitioning={homePanel.isArtifactPanelTransitioning}
        isArtifactPanelExpanded={homePanel.isArtifactPanelExpanded}
        artifactHeaderWidth={homePanel.layout.artifactHeaderWidth}
        needsMacTrafficLightInsetWhenExpanded={Boolean(isSidebarCollapsed && !isWindows && isMac)}
        artifactTabsScrollRef={homePanel.artifactTabsScrollRef}
        isFileListPreviewTabOpen={homePanel.isFileListPreviewTabOpen}
        browserTabs={homePanel.browserTabs}
        activeBrowserTabId={homePanel.activeBrowserTabId}
        artifactTabsWithArtifacts={homePanel.artifactTabsWithArtifacts}
        activeArtifactPreviewTab={homePanel.activeArtifactPreviewTab}
        activeSpecialPreviewTab={homePanel.activeSpecialPreviewTab}
        isNewTabPreviewTabOpen={homePanel.isNewTabPreviewTabOpen}
        renamingArtifactTabId={homePanel.renamingArtifactTabId}
        shouldShowArtifactAddButton={homePanel.shouldShowArtifactAddButton}
        shouldPinArtifactAddTab={homePanel.shouldPinArtifactAddTab}
        artifactTabsCanScrollLeft={homePanel.artifactTabsCanScrollLeft}
        artifactTabsCanScrollRight={homePanel.artifactTabsCanScrollRight}
        artifactTabActionTargets={homePanel.artifactTabActionTargets}
        onActivateFileListTab={homePanel.handleActivateArtifactFileListTab}
        onCloseFileListTab={homePanel.handleCloseArtifactFileListTab}
        onActivateBrowserTab={homePanel.handleActivateArtifactBrowserTab}
        onCloseBrowserTab={homePanel.handleCloseArtifactBrowserTab}
        onStartArtifactTabRename={homePanel.handleStartArtifactTabRename}
        onCancelArtifactTabRename={(tabId) => {
          homePanel.setRenamingArtifactTabId(current => (current === tabId ? null : current));
        }}
        onCommitArtifactTabRename={homePanel.handleCommitArtifactTabRename}
        onActivateArtifactTab={homePanel.handleActivateArtifactTab}
        onCloseArtifactTab={homePanel.handleCloseArtifactTab}
        onActivateNewTab={homePanel.handleActivateArtifactNewTab}
        onCloseNewTab={homePanel.handleCloseArtifactNewTab}
        onOpenNewTab={homePanel.handleOpenArtifactNewTab}
        onToggleExpanded={homePanel.handleToggleArtifactPanelExpanded}
        onTogglePanel={homePanel.handleToggleArtifactPanel}
      />
    </div>
  );

  // Cold start ('starting'), idle auto-start ('ready'), and active ('running')
  // stay completely silent here (in-flight prompt waits surface inside the turn's
  // ActivityIndicator), while blocking startup failures render globally via
  // EngineFailureOverlay in App.tsx.
  const engineStatusBanner = shouldShowEngineNotice && openClawStatus ? (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-amber-200 bg-surface p-4 shadow-lg animate-fade-in-down dark:border-amber-900/60">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
            <ExclamationTriangleIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {resolveEngineStatusText(openClawStatus)}
              {typeof openClawStatus.progressPercent === 'number' && (
                <span className="ml-1 font-normal text-secondary">
                  ({Math.round(openClawStatus.progressPercent)}%)
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => onRequestAppSettings?.({ initialTab: 'general' })}
            className="text-xs text-secondary underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            {i18nService.t('coworkOpenClawGoToSettingsInstall')}
          </button>
          <button
            type="button"
            onClick={handleRestartGateway}
            disabled={isRestartingGateway}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
          >
            {isRestartingGateway && (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
            )}
            {i18nService.t('coworkOpenClawRestartGateway')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const isAgentHome = !isDefaultAgentId(currentAgentId) && Boolean(currentAgent) && !selectedActionId;

  return (
    <div data-skin-cowork="true" className="relative flex-1 flex flex-col bg-background h-full overflow-hidden">
      <SessionSwipeNavigator />
      <SkinBackdrop
        variant={shouldPresentConversation
          ? SkinBackdropVariant.Conversation
          : SkinBackdropVariant.Home}
      />
      <SkinAmbientEffects visible={!shouldPresentConversation} />

      {currentSession ? (
        <div className="relative z-10 flex-1 flex flex-col h-full">
          {engineStatusBanner}
          <CoworkSessionDetail
            onManageSkills={() => onShowSkills?.()}
            onManageKits={() => onShowKits?.()}
            onContinue={handleContinueSession}
            onStop={handleStopSession}
            isSidebarCollapsed={isSidebarCollapsed}
            onToggleSidebar={onToggleSidebar}
            onNewChat={onNewChat}
            updateBadge={updateBadge}
            minimizedPermission={minimizedPermission}
            onRestorePermission={onRestorePermission}
            onRespondToPermission={onRespondToPermission}
          />
        </div>
      ) : (
        <ArtifactFileShareProvider sessionId={homePanel.sessionId}>
          <div className="relative z-10 flex flex-1 flex-col h-full overflow-hidden">
            {/* Engine status banner for non-blocking states */}
            {engineStatusBanner}

            {/* Header */}
            {homeHeader}

            {/* Content row: home canvas/composer + right artifact panel */}
            <div ref={homePanel.contentRowRef} className="relative flex-1 flex overflow-hidden">
              <div
                data-popover-boundary="true"
                className="relative flex-1 flex flex-col h-full min-w-0"
                style={{ minWidth: homePanel.isArtifactPanelExpanded ? 0 : COWORK_DETAIL_MIN_WIDTH }}
              >
                {/* Upper scrollable canvas: editorial headline, quick-action cards, and expanded galleries */}
                <div
                  data-session-swipe-area="true"
                  className="relative z-10 min-h-0 flex-1 overflow-y-auto scrollbar-hidden"
                >
                  <div className={`relative flex min-h-full w-full min-w-[320px] flex-col items-center pb-4 pt-4 ${COWORK_DETAIL_GUTTER_CLASS}`}>
                    {/* Flexible spacers center the agent hero vertically above the bottom-docked
                        composer, seat the default headline/cards gently toward it, and tighten
                        smoothly when a cover gallery opens below. */}
                    <div
                      aria-hidden="true"
                      className={
                        selectedActionId
                          ? 'w-full min-h-[12px] flex-[0.4_0_0px]'
                          : isAgentHome
                            ? 'w-full min-h-[24px] flex-1'
                            : 'w-full min-h-[28px] flex-[3_0_0px]'
                      }
                    />

                    {isAgentHome && currentAgent ? (
                      <div className={`${COWORK_DETAIL_CONTENT_CLASS} flex flex-col items-center`}>
                        <AgentHomeHero
                          agent={currentAgent}
                          effectiveWorkingDirectory={currentAgentWorkingDirectory}
                          metaRevision={agentHeroMetaRevision}
                          onOpenSettings={() => setSettingsAgentId(currentAgent.id)}
                          onChangeIcon={async icon => {
                            if (icon === currentAgent.icon && !usesManagedPresetAvatar(currentAgent)) {
                              return;
                            }
                            const updated = await agentService.updateAgent(currentAgent.id, { icon });
                            if (!updated) {
                              window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
                            }
                          }}
                          onUsePrompt={prompt => {
                            promptInputRef.current?.setValue(prompt, 'template');
                            promptInputRef.current?.focus();
                          }}
                        />
                      </div>
                    ) : (
                      <>
                        <div data-skin-home-copy="true" className={`${COWORK_DETAIL_CONTENT_CLASS} text-center`}>
                          <HomeSkinEmblem
                            onlyWhenCustom
                            className="mx-auto mb-4 h-12 w-12 animate-fade-in-up"
                          />
                          <h2
                            className={`font-medium leading-[1.3] tracking-[-0.015em] text-foreground transition-all duration-200 animate-fade-in-up ${
                              selectedActionId ? 'text-[22px] sm:text-[24px]' : 'text-[30px] sm:text-[32px]'
                            }`}
                            style={{
                              fontFamily: HOME_HEADLINE_FONT_FAMILY,
                              fontFeatureSettings: '"palt" 1',
                              animationDelay: '40ms',
                              animationFillMode: 'both',
                            }}
                          >
                            {i18nService.t('coworkHomeHeadline')}
                          </h2>
                        </div>

                        <div
                          className={`relative z-0 flex flex-col items-center animate-fade-in-up ${selectedActionId ? 'mt-5' : 'mt-8'} ${COWORK_DETAIL_CONTENT_CLASS}`}
                          style={{ animationDelay: '100ms', animationFillMode: 'both' }}
                        >
                          <HomeShowcaseHub
                            selectedCategoryId={selectedActionId}
                            onCategorySelect={handleHomeCategorySelect}
                            onDraftReady={prompt => {
                              promptInputRef.current?.setValue(prompt, 'template');
                              promptInputRef.current?.focus();
                            }}
                          />
                          <CreditsResetCampaignFloat />
                        </div>
                      </>
                    )}

                    <div
                      aria-hidden="true"
                      className={
                        selectedActionId
                          ? 'w-full min-h-[12px] flex-[0.5_0_0px]'
                          : isAgentHome
                            ? 'w-full min-h-[24px] flex-1'
                            : 'w-full min-h-[16px] flex-[1.5_0_0px]'
                      }
                    />
                  </div>
                </div>

                {/* Bottom-docked unified composer (aligned with session detail composer width) */}
                <div
                  ref={homePanel.promptInputAreaRef}
                  className={`relative shrink-0 ${COWORK_DETAIL_GUTTER_CLASS} ${
                    homePanel.isArtifactPanelExpanded
                      ? 'z-50 bg-background pb-2 pt-1'
                      : 'z-30 pb-6 pt-2'
                  } ${homePanel.isArtifactPanelExpanded && homePanel.isExpandedPromptInputHidden ? 'hidden' : ''}`}
                >
                  {homePanel.isArtifactPanelExpanded && !homePanel.isExpandedPromptInputHidden && (
                    <button
                      type="button"
                      onClick={homePanel.handleToggleExpandedPromptInput}
                      className="absolute right-3 top-1 z-20 inline-flex h-5 w-5 items-center justify-center rounded-md border border-border bg-surface-raised text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-foreground"
                      aria-label={i18nService.t('artifactBrowserHideInput')}
                      title={i18nService.t('artifactBrowserHideInput')}
                    >
                      <PromptInputCollapseIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <div className={COWORK_DETAIL_CONTENT_CLASS}>
                    <CoworkPromptInput
                      ref={promptInputRef}
                      onSubmit={handleStartSession}
                      onStop={handleStopSession}
                      isStreaming={isStreaming}
                      disabled={!isEngineReady}
                      submitDisabled={Boolean(blockingHomeQuotaReason)}
                      placeholder={i18nService.t('coworkPlaceholder')}
                      size={homePanel.isArtifactPanelExpanded ? 'compact' : 'large'}
                      workingDirectory={currentAgentWorkingDirectory}
                      onWorkingDirectoryChange={async (dir: string) => {
                        await agentService.updateAgent(currentAgentId, { workingDirectory: dir });
                      }}
                      showFolderSelector={true}
                      showModelSelector={true}
                      showAgentSelector={true}
                      enablePageFileDrop={true}
                      onManageSkills={() => onShowSkills?.()}
                      onManageKits={() => onShowKits?.()}
                      onGoalCommand={handleStartGoalSession}
                    />
                    <EnterpriseQuotaPrompt
                      reason={blockingHomeQuotaReason}
                      surface="home"
                    />
                  </div>
                </div>
                {homePanel.isArtifactPanelExpanded && homePanel.isExpandedPromptInputHidden && (
                  <button
                    type="button"
                    onClick={homePanel.handleToggleExpandedPromptInput}
                    className="absolute bottom-2 right-2 z-50 inline-flex h-5 w-5 items-center justify-center rounded-md border border-border bg-surface-raised text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-foreground"
                    aria-label={i18nService.t('artifactBrowserShowInput')}
                    title={i18nService.t('artifactBrowserShowInput')}
                  >
                    <PromptInputExpandIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {homePanel.shouldRenderArtifactPanel && (
                <div
                  className={`${
                    homePanel.layout.artifactPanelIsOverlay
                      ? 'absolute inset-x-0 top-0 z-40 overflow-hidden bg-background'
                      : 'h-full shrink-0 overflow-hidden'
                  } ${
                    homePanel.isArtifactPanelTransitioning
                      ? 'transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none'
                      : ''
                  } ${homePanel.isArtifactPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                  style={homePanel.layout.artifactPanelIsOverlay
                    ? {
                        bottom: homePanel.layout.artifactPanelOverlayBottom,
                        width: 'auto',
                        maxWidth: 'none',
                      }
                    : {
                        width: homePanel.layout.artifactPanelFrameWidth,
                        maxWidth: homePanel.artifactPanelMaxWidth + ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH,
                      }}
                  aria-hidden={!homePanel.isPanelOpen}
                >
                  <div
                    className="flex h-full"
                    style={{ width: homePanel.layout.artifactPanelInnerWidth }}
                  >
                    <ArtifactPanelErrorBoundary onClose={homePanel.handleClosePanel}>
                      <ArtifactPanel
                        key={homePanel.sessionId}
                        sessionId={homePanel.sessionId}
                        artifacts={homePanel.homeArtifacts}
                        workingDirectory={currentAgentWorkingDirectory}
                        activeSpecialTab={homePanel.activeSpecialPreviewTab}
                        minPanelWidth={homePanel.layout.artifactPanelRenderMinWidth}
                        maxPanelWidth={homePanel.layout.artifactPanelRenderMaxWidth}
                        isPanelExpanded={homePanel.isArtifactPanelExpanded}
                        browserTabs={homePanel.browserTabsForPanel}
                        activeBrowserTabId={homePanel.activeBrowserTabId}
                        onBrowserAddressChange={homePanel.handleBrowserPreviewAddressChange}
                        onBrowserUrlChange={homePanel.handleBrowserPreviewUrlChange}
                        onBrowserTitleChange={homePanel.handleBrowserPreviewTitleChange}
                        onBrowserLocalServiceContextChange={homePanel.handleBrowserLocalServiceContextChange}
                        onOpenFileListTab={homePanel.handleOpenArtifactFileListTab}
                        onOpenBrowserTab={homePanel.handleOpenArtifactBrowserTab}
                        onOpenLocalServiceInBrowser={homePanel.handleOpenLocalServiceArtifact}
                        onOpenHtmlFileInBrowser={homePanel.handleOpenHtmlFileInBrowser}
                        newTabPanel={(
                          <ArtifactNewTabContent
                            sessionId={homePanel.sessionId}
                            workingDirectory={currentAgentWorkingDirectory}
                            artifacts={homePanel.homeArtifacts}
                            subagents={EMPTY_SUBAGENTS}
                            onSelectArtifact={homePanel.handleNewTabSelectArtifact}
                            onOpenLocalFilePath={homePanel.handleNewTabOpenLocalFilePath}
                            onOpenLocalFilePicker={homePanel.handleNewTabOpenLocalFilePicker}
                            onCreateBlankDocument={homePanel.handleNewTabCreateBlankDocument}
                            onOpenFileList={homePanel.handleNewTabOpenFileList}
                            onOpenBrowserUrl={homePanel.handleNewTabOpenBrowserUrl}
                          />
                        )}
                        onOpenLocalFilePicker={() => void homePanel.handleNewTabOpenLocalFilePicker()}
                        onOpenWorkspaceFile={homePanel.handleOpenWorkspaceFilePath}
                        onCreateBlankDocumentFromFileList={() => void homePanel.handleNewTabCreateBlankDocument(BlankDocumentKind.Word)}
                        onRevealWorkspaceFromFileList={currentAgentWorkingDirectory
                          ? () => void openWorkspaceDirectoryInSystem(currentAgentWorkingDirectory)
                          : undefined}
                        onAnnotationSend={homePanel.handleAnnotationSendRequest}
                        onAddSelectedText={homePanel.handleAddSelectedTextSnippet}
                        selectedTextEnabled={true}
                      />
                    </ArtifactPanelErrorBoundary>
                  </div>
                </div>
              )}
            </div>
          </div>
          <ImageStudioHost sessionId={homePanel.sessionId} />
        </ArtifactFileShareProvider>
      )}
      {modelAccessPrompt && (
        <ModelAccessPromptModal
          promptKind={modelAccessPrompt}
          onClose={() => setModelAccessPrompt(null)}
        />
      )}
      <AgentSettingsPanel
        agentId={settingsAgentId}
        onClose={() => {
          setSettingsAgentId(null);
          setAgentHeroMetaRevision(v => v + 1);
        }}
      />
    </div>
  );
};

export default CoworkView;
