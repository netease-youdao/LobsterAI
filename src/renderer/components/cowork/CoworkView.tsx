import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { CoworkBrowserAnnotationMessageBatch } from '@shared/cowork/browserAnnotations';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { buildGoalSettingMessageMetadata } from '../../../common/goalCommandDisplay';
import { buildSessionTitleFromInput } from '../../../common/sessionTitle';
import { buildCoworkImageAttachmentPreviews } from '../../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import startupCreditEntryGiftUrl from '../../assets/startup-credit-entry-gift.svg';
import { EnterpriseQuotaPrompt } from '../../features/enterpriseAccount/components/EnterpriseQuotaPrompt';
import { refreshEnterpriseAccountContext } from '../../features/enterpriseAccount/context';
import {
  resolveBlockingEnterpriseQuotaReason,
  usesLobsterAIServerQuota,
} from '../../features/enterpriseAccount/modelQuotaGate';
import {
  selectEnterpriseAccountContext,
  selectIsEnterpriseAccount,
} from '../../features/enterpriseAccount/selectors';
import { agentService } from '../../services/agent';
import { coworkService } from '../../services/cowork';
import { buildCoworkCapabilitySelection } from '../../services/coworkCapabilitySelection';
import { i18nService } from '../../services/i18n';
import { quickActionService } from '../../services/quickAction';
import { RootState } from '../../store';
import {
  selectCoworkConfig,
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
} from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import { applyOptimisticGoalCommand } from '../../utils/goalCommand';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import CreditsResetCampaignFloat from '../CreditsResetCampaignFloat';
import { DailyCheckInHeaderEntry } from '../DailyCheckInActivity';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import { ModelAccessPromptKind, ModelAccessPromptModal } from '../ModelSelector';
import { PromptPanel, QuickActionBar } from '../quick-actions';
import type { SettingsOpenOptions } from '../Settings';
import HomeSkinEmblem from '../skin/HomeSkinEmblem';
import SkinAmbientEffects from '../skin/SkinAmbientEffects';
import SkinBackdrop, { SkinBackdropVariant } from '../skin/SkinBackdrop';
import {
  openStartupCreditCampaign,
  useStartupCreditCampaignEntry,
} from '../startupCreditCampaignBridge';
import { resolveModelThinkingLevel, useAgentSelectedModel } from './agentModelSelection';
import { CoworkUiEvent } from './constants';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import CoworkSessionDetail from './CoworkSessionDetail';
import { reportPromptTemplateAction } from './promptAnalytics';
import { buildCoworkContinuationSystemPrompt, buildCoworkSystemPrompt } from './skillSystemPrompt';

// Time-aware hero greeting: the brand mark stays as the logo, so the heading
// can greet the user instead of repeating the product name on every visit.
const resolveHomeGreetingKey = (date: Date = new Date()): string => {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'coworkGreetingMorning';
  if (hour >= 12 && hour < 18) return 'coworkGreetingAfternoon';
  if (hour >= 18 && hour < 23) return 'coworkGreetingEvening';
  return 'coworkGreetingLateNight';
};

const logCoworkViewModel = (message: string): void => {
  console.debug(`[CoworkView] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('debug', 'CoworkView', message.slice(0, 500));
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
  const [isInitialized, setIsInitialized] = useState(false);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawEngineStatus | null>(null);
  const [isRestartingGateway, setIsRestartingGateway] = useState(false);
  // Shown when a session start is blocked because no usable model config exists;
  // guides the user to plan models instead of pushing them into custom-model settings.
  const [modelAccessPrompt, setModelAccessPrompt] = useState<ModelAccessPromptKind | null>(null);
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
  const homeQuotaReason = enterpriseAccountContext?.quotaStatus.available === false
    ? enterpriseAccountContext.quotaStatus.reason
    : null;
  const currentSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    currentSessionIdRef.current = currentSession?.id ?? null;
  }, [currentSession?.id]);

  useEffect(() => {
    if (!isHomeView || !hasEnterpriseAccount) return;
    void refreshEnterpriseAccountContext();
  }, [enterpriseAccountId, hasEnterpriseAccount, isHomeView]);
  const config = useSelector(selectCoworkConfig);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const quickActions = useSelector((state: RootState) => state.quickAction.actions);
  const selectedActionId = useSelector((state: RootState) => state.quickAction.selectedActionId);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const startupCreditEntry = useStartupCreditCampaignEntry();
  const agents = useSelector((state: RootState) => state.agent.agents);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const shouldPresentConversation = Boolean(currentSession || sessionNavigationTargetId);
  const currentAgentWorkingDirectory = currentAgent?.workingDirectory?.trim() || config.workingDirectory || '';
  const currentAgentSelectedModel = useAgentSelectedModel(currentAgentId, currentAgent?.model ?? '');
  const currentAgentSelectedModelRef = currentAgentSelectedModel
    ? toOpenClawModelRef(currentAgentSelectedModel)
    : '';
  const homeModelUsesServerQuota = usesLobsterAIServerQuota(currentAgentSelectedModel);
  const blockingHomeQuotaReason = resolveBlockingEnterpriseQuotaReason(
    homeQuotaReason,
    currentAgentSelectedModel,
  );
  const currentAgentThinkingLevel = resolveModelThinkingLevel(
    currentAgentSelectedModel,
    currentAgent?.thinkingLevel,
  );
  const homeDraftCollaborationMode = useSelector((state: RootState) => (
    state.cowork.draftCollaborationModes.__home__ || CoworkCollaborationMode.Default
  ));
  const mediaSelection = useSelector((state: RootState) => {
    const key = currentSession?.id || '__home__';
    return state.cowork.mediaSelection[key];
  });

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
      case 'not_installed':
        return i18nService.t('coworkOpenClawNotInstalledNotice');
      case 'installing':
        return i18nService.t('coworkOpenClawInstalling');
      case 'ready':
        return i18nService.t('coworkOpenClawReadyNotice');
      case 'starting':
        return i18nService.t('coworkOpenClawStarting');
      case 'error':
        return i18nService.t('coworkOpenClawError');
      case 'running':
      default:
        return i18nService.t('coworkOpenClawRunning');
    }
  };

  const isOpenClawReadyForSession = (status: OpenClawEngineStatus | null): boolean => {
    if (!status) return false;
    return status.phase === 'running' || status.phase === 'ready';
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
    const init = async () => {
      try {
        await coworkService.init();
        const initialEngineStatus = coworkService.getOpenClawEngineStatusSnapshot();
        if (!cancelled && initialEngineStatus) {
          setOpenClawStatus(initialEngineStatus);
        }
        // Load quick actions with localization
        quickActionService.initialize();
        const actions = await quickActionService.getLocalizedActions();
        if (!cancelled) {
          dispatch(setActions(actions));
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
  ): Promise<boolean | void> => {
    console.log('[CoworkView] handleStartSession: imageAttachments diagnosis', {
      hasImageAttachments: !!imageAttachments,
      count: imageAttachments?.length ?? 0,
      details: imageAttachments?.map(a => ({ name: a.name, mimeType: a.mimeType, base64Length: a.base64Data?.length ?? 0 })) ?? [],
    });
    if (blockingHomeQuotaReason) {
      logCoworkViewModel(`blocked new session submission for enterprise quota reason ${blockingHomeQuotaReason}`);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('enterpriseQuotaHomeSubmitBlocked'),
      }));
      return false;
    }
    if (openClawStatus && !isOpenClawReadyForSession(openClawStatus)) {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('coworkErrorEngineNotReady') }));
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
      const tempSessionId = `temp-${Date.now()}`;
      const fallbackTitle = buildSessionTitleFromInput(
        prompt,
        i18nService.t('coworkDefaultSessionTitle')
      );
      const now = Date.now();
      const optimisticGoal = applyOptimisticGoalCommand(prompt, null, tempSessionId, now);

      // Capture active skill IDs and kit IDs before clearing them
      const sessionSkillIds = [...activeSkillIds];
      const sessionKitIds = [...activeKitIds];

      const {
        directSkillIds,
        runtimeSkillIds,
        kitReferences,
        resolvedKitCapabilities,
      } = buildCapabilitySelection(sessionSkillIds, sessionKitIds);
      const isPlanMode = collaborationMode === CoworkCollaborationMode.Plan;
      const goalSettingMetadata = buildGoalSettingMessageMetadata(prompt);
      const displayDirectSkillIds = directSkillIds;
      const displayKitIds = sessionKitIds;
      const effectiveRuntimeSkillIds = isPlanMode ? [] : runtimeSkillIds;
      if (isPlanMode && (directSkillIds.length > 0 || runtimeSkillIds.length > 0 || sessionKitIds.length > 0)) {
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

      // Combine skill prompt with system prompt.
      // OpenClaw loads skills natively via skills.load.extraDirs, so skip the
      // auto-routing prompt to avoid injecting Claude SDK tool-calling instructions
      // that confuse non-Claude models (e.g. kimi-k2.5 falls back to text-based
      // tool calls, producing empty tool names and err=true failures).
      const combinedSystemPrompt = buildCoworkSystemPrompt(skillPrompt, config.systemPrompt);

      // Start the actual session immediately with fallback title
      const sessionModelOverride = currentAgentSelectedModelRef;
      logCoworkViewModel(
        `creating session with model ${sessionModelOverride || 'default'}; agent model is ${currentAgent?.model || 'empty'}; server quota model is ${homeModelUsesServerQuota}`,
      );
      const { session: startedSession, error: startError } = await coworkService.startSession({
        prompt,
        title: fallbackTitle,
        cwd: currentAgentWorkingDirectory || undefined,
        systemPrompt: combinedSystemPrompt,
        activeSkillIds: displayDirectSkillIds.length > 0 ? displayDirectSkillIds : undefined,
        runtimeSkillIds: isPlanMode ? [] : (effectiveRuntimeSkillIds.length > 0 ? effectiveRuntimeSkillIds : undefined),
        kitIds: displayKitIds.length > 0 ? displayKitIds : undefined,
        kitReferences: displayKitIds.length > 0 ? kitReferences : undefined,
        resolvedKitCapabilities: displayKitIds.length > 0 ? resolvedKitCapabilities : undefined,
        agentId: currentAgentId,
        modelOverride: sessionModelOverride,
        thinkingLevel: currentAgentThinkingLevel,
        imageAttachments,
        mediaSelection: mediaSelection && mediaSelection.mode !== 'none' ? mediaSelection : undefined,
        mediaReferences,
        selectedTextSnippets,
        browserAnnotations,
      });

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
      if (optimisticGoal !== undefined) {
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
  ) => {
    if (!currentSession) return false;
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
        runtimeSkillIds: isPlanMode ? [] : (effectiveRuntimeSkillIds.length > 0 ? effectiveRuntimeSkillIds : undefined),
        kitIds: displayKitIds.length > 0 ? displayKitIds : undefined,
        kitReferences: displayKitIds.length > 0 ? kitReferences : undefined,
        resolvedKitCapabilities: displayKitIds.length > 0 ? resolvedKitCapabilities : undefined,
        imageAttachments,
        mediaSelection: mediaSelection && mediaSelection.mode !== 'none' ? mediaSelection : undefined,
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
    if (currentSession.id.startsWith('temp-') && pendingStartRef.current) {
      pendingStartRef.current.cancelled = true;
      pendingStartRef.current.cancellationAction = 'stop';
    }
    await coworkService.stopSession(currentSession.id);
  }, [currentSession]);

  // Get selected quick action
  const selectedAction = React.useMemo(() => {
    return quickActions.find(action => action.id === selectedActionId);
  }, [quickActions, selectedActionId]);

  // Deselect quick action: restore the chip bar and deactivate the auto-enabled skill
  const handleQuickActionDeselect = () => {
    const action = quickActions.find(a => a.id === selectedActionId);
    dispatch(clearSelection());
    if (action && activeSkillIds.includes(action.skillMapping)) {
      dispatch(setActiveSkillIds(activeSkillIds.filter(id => id !== action.skillMapping)));
    }
  };

  // Handle quick action button click: select action + activate skill in one batch.
  // Clicking the selected chip again collapses the prompt panel.
  const handleActionSelect = (actionId: string) => {
    if (actionId === selectedActionId) {
      handleQuickActionDeselect();
      return;
    }
    dispatch(selectAction(actionId));
    const action = quickActions.find(a => a.id === actionId);
    if (action) {
      const targetSkill = skills.find(s => s.id === action.skillMapping);
      console.debug(`[CoworkView] reporting prompt template analytics: template_card_click ${action.id}`);
      reportPromptTemplateAction({
        templateActionType: 'template_card_click',
        templateId: action.id,
        templateName: action.label,
        templateIndex: quickActions.findIndex(item => item.id === action.id),
        mappedSkillId: action.skillMapping,
        mappedSkillName: targetSkill?.name,
        hasAutoEnabledSkill: Boolean(targetSkill),
        params: {
          promptCount: action.prompts.length,
          modelId: currentAgentSelectedModel?.id,
          modelName: currentAgentSelectedModel?.name,
          agentId: currentAgentId,
          isMainAgent: currentAgentId === 'main',
          isPlanMode: homeDraftCollaborationMode === CoworkCollaborationMode.Plan,
        },
      });
      if (targetSkill) {
        dispatch(setActiveSkillIds([targetSkill.id]));
      }
    }
  };

  // When the mapped skill is deactivated from input area, restore the QuickActionBar.
  // Only applies when the mapped skill exists (and thus was auto-enabled on select);
  // otherwise a missing skill would make the prompt panel impossible to open.
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

  // Handle prompt selection from QuickAction
  const handleQuickActionPromptSelect = (prompt: string, promptId?: string) => {
    if (selectedAction) {
      const selectedPrompt = selectedAction.prompts.find(item => item.id === promptId);
      const targetSkill = skills.find(skill => skill.id === selectedAction.skillMapping);
      console.debug(`[CoworkView] reporting prompt template analytics: template_prompt_click ${selectedAction.id}/${promptId ?? 'unknown'}`);
      reportPromptTemplateAction({
        templateActionType: 'template_prompt_click',
        templateId: selectedAction.id,
        templateName: selectedAction.label,
        templateIndex: quickActions.findIndex(item => item.id === selectedAction.id),
        mappedSkillId: selectedAction.skillMapping,
        mappedSkillName: targetSkill?.name,
        promptId,
        promptName: selectedPrompt?.label,
        promptIndex: selectedAction.prompts.findIndex(item => item.id === promptId),
        promptLength: prompt.length,
        hasAutoEnabledSkill: activeSkillIds.includes(selectedAction.skillMapping),
        params: {
          modelId: currentAgentSelectedModel?.id,
          modelName: currentAgentSelectedModel?.name,
          agentId: currentAgentId,
          isMainAgent: currentAgentId === 'main',
          isPlanMode: homeDraftCollaborationMode === CoworkCollaborationMode.Plan,
        },
      });
    }
    // Fill the prompt into input
    promptInputRef.current?.setValue(prompt, 'template');
    promptInputRef.current?.focus();
  };

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
    return (
      <div className="flex-1 h-full flex flex-col bg-background">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-secondary">
            {i18nService.t('loading')}
          </div>
        </div>
      </div>
    );
  }

  const shouldShowEngineStatus = Boolean(openClawStatus && openClawStatus.phase !== 'running');
  const isEngineError = openClawStatus?.phase === 'error';
  const isEngineReady = isOpenClawReadyForSession(openClawStatus);

  const homeHeader = (
    <div className="draggable relative z-10 flex h-12 items-center justify-between px-4 shrink-0">
      <div className="non-draggable h-8 flex items-center">
        {isSidebarCollapsed && !isWindows && (
          <div className={`flex items-center gap-1 mr-2 ${isMac ? 'pl-[68px]' : ''}`}>
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
      <div className="non-draggable flex items-center">
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
      </div>
    </div>
  );

  // Non-blocking engine states (ready/not_installed/installing) float below
  // the title bar as a lightweight notice; starting and blocking startup
  // failures render as global overlays in App.tsx.
  const engineStatusBanner = shouldShowEngineStatus && !isEngineError && openClawStatus && openClawStatus.phase !== 'starting' ? (
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
            onClick={() => onRequestAppSettings?.({ initialTab: 'coworkAgentEngine' })}
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

  return (
    <div data-skin-cowork="true" className="relative flex-1 flex flex-col bg-background h-full">
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
        <>
          {/* Engine status banner for non-blocking states */}
          {engineStatusBanner}

          {/* Header */}
          {homeHeader}

          {/* Main content */}
          <div className="relative z-10 flex-1 overflow-y-auto min-h-0">
            <div className="relative flex min-h-full w-full min-w-[320px] flex-col items-center px-4 py-8">
              {/* Flexible spacers (2:3) keep the welcome block at the optical
                  center on tall windows; min-h preserves breathing room before
                  the page starts scrolling on short windows. */}
              <div aria-hidden="true" className="w-full min-h-[56px] flex-[2_0_0px]" />
              {/* Welcome Section - staggered entrance animation */}
              <div data-skin-home-copy="true" className="w-full max-w-3xl text-center">
                <HomeSkinEmblem
                  className="mx-auto h-12 w-12 animate-fade-in-up"
                />
                <h2
                  className="mt-4 text-2xl font-semibold leading-[var(--lobster-leading-2xl)] tracking-normal text-foreground animate-fade-in-up"
                  style={{ animationDelay: '70ms', animationFillMode: 'both' }}
                >
                  {i18nService.t(resolveHomeGreetingKey())}
                </h2>
                <p
                  className="mt-1.5 text-sm font-normal leading-[var(--lobster-leading-sm)] text-secondary animate-fade-in-up"
                  style={{ animationDelay: '120ms', animationFillMode: 'both' }}
                >
                  {i18nService.t('coworkHomeTagline')}
                </p>
              </div>

              {/* Prompt Input Area - Large version with folder selector */}
              <div
                className="relative z-30 mt-8 w-full max-w-3xl animate-fade-in-up"
                style={{ animationDelay: '180ms', animationFillMode: 'both' }}
              >
                <CoworkPromptInput
                  ref={promptInputRef}
                  onSubmit={handleStartSession}
                  onStop={handleStopSession}
                  isStreaming={isStreaming}
                  disabled={!isEngineReady}
                  submitDisabled={Boolean(blockingHomeQuotaReason)}
                  placeholder={i18nService.t('coworkPlaceholder')}
                  size="large"
                  workingDirectory={currentAgentWorkingDirectory}
                  onWorkingDirectoryChange={async (dir: string) => {
                    await agentService.updateAgent(currentAgentId, { workingDirectory: dir });
                  }}
                  showFolderSelector={true}
                  showModelSelector={true}
                  showAgentSelector={true}
                  onManageSkills={() => onShowSkills?.()}
                  onManageKits={() => onShowKits?.()}
                  onGoalCommand={handleStartGoalSession}
                />
                <EnterpriseQuotaPrompt
                  reason={blockingHomeQuotaReason}
                  surface="home"
                />
              </div>

              {/* Quick Actions */}
              <div
                className="relative z-0 mt-8 flex w-full max-w-3xl flex-col items-center animate-fade-in-up"
                style={{ animationDelay: '260ms', animationFillMode: 'both' }}
              >
                <QuickActionBar
                  actions={quickActions}
                  selectedActionId={selectedActionId}
                  onActionSelect={handleActionSelect}
                />
                {selectedAction && (
                  <div className="mt-4 w-full">
                    <PromptPanel
                      action={selectedAction}
                      onPromptSelect={handleQuickActionPromptSelect}
                      onClose={handleQuickActionDeselect}
                    />
                  </div>
                )}
                <CreditsResetCampaignFloat />
              </div>

              <div aria-hidden="true" className="w-full min-h-[24px] flex-[3_0_0px]" />
            </div>
          </div>
        </>
      )}
      {modelAccessPrompt && (
        <ModelAccessPromptModal
          promptKind={modelAccessPrompt}
          onClose={() => setModelAccessPrompt(null)}
        />
      )}
    </div>
  );
};

export default CoworkView;
