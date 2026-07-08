import { ArrowPathIcon, ExclamationTriangleIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { buildGoalSettingMessageMetadata } from '../../../common/goalCommandDisplay';
import { buildSessionTitleFromInput } from '../../../common/sessionTitle';
import { buildCoworkImageAttachmentPreviews } from '../../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import { agentService } from '../../services/agent';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import {
  buildKitReferences,
  resolveSelectedKitCapabilities,
} from '../../services/kitCapability';
import { quickActionService } from '../../services/quickAction';
import { RootState } from '../../store';
import {
  selectCoworkConfig,
  selectCurrentSession,
  selectIsStreaming,
} from '../../store/selectors/coworkSelectors';
import { addMessage, setCurrentSession, setDraftCollaborationMode, setDraftKitIds, setDraftSkillIds, setStreaming, updateSessionGoal, updateSessionStatus } from '../../store/slices/coworkSlice';
import { clearActiveKits } from '../../store/slices/kitSlice';
import { clearSelection,selectAction, setActions } from '../../store/slices/quickActionSlice';
import { clearActiveSkills, setActiveSkillIds } from '../../store/slices/skillSlice';
import { CoworkCollaborationMode, type CoworkCollaborationMode as CoworkCollaborationModeType, type CoworkImageAttachment, type CoworkSession, type OpenClawEngineStatus } from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import { applyOptimisticGoalCommand } from '../../utils/goalCommand';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import CreditsResetCampaignFloat from '../CreditsResetCampaignFloat';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import { PromptPanel, QuickActionBar } from '../quick-actions';
import type { SettingsOpenOptions } from '../Settings';
import WindowTitleBar from '../window/WindowTitleBar';
import { useAgentSelectedModel } from './agentModelSelection';
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
  window.electron?.log?.fromRenderer?.('debug', 'CoworkView', message);
};

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  onShowSkills?: () => void;
  onShowKits?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const CoworkView: React.FC<CoworkViewProps> = ({ onRequestAppSettings, onShowSkills, onShowKits, isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const [isInitialized, setIsInitialized] = useState(false);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawEngineStatus | null>(null);
  const [isRestartingGateway, setIsRestartingGateway] = useState(false);
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
  const isStreaming = useSelector(selectIsStreaming);
  const config = useSelector(selectCoworkConfig);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const quickActions = useSelector((state: RootState) => state.quickAction.actions);
  const selectedActionId = useSelector((state: RootState) => state.quickAction.selectedActionId);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const currentAgentWorkingDirectory = currentAgent?.workingDirectory?.trim() || config.workingDirectory || '';
  const currentAgentSelectedModel = useAgentSelectedModel(currentAgentId, currentAgent?.model ?? '');
  const homeDraftCollaborationMode = useSelector((state: RootState) => (
    state.cowork.draftCollaborationModes.__home__ || CoworkCollaborationMode.Default
  ));
  const mediaSelection = useSelector((state: RootState) => {
    const key = currentSession?.id || '__home__';
    return state.cowork.mediaSelection[key];
  });

  const resolveRoutableSkillIds = useCallback((skillIds: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const skillId of skillIds) {
      if (seen.has(skillId)) continue;
      seen.add(skillId);
      const skill = skills.find(s => s.id === skillId);
      if (!skill?.enabled || !skill.skillPath.trim()) continue;
      result.push(skillId);
    }
    return result;
  }, [skills]);

  const buildCapabilitySelection = useCallback((skillIds: string[], kitIds: string[]) => {
    const directSkillIds = resolveRoutableSkillIds(skillIds);
    const resolvedKitCapabilities = resolveSelectedKitCapabilities(kitIds, installedKits);
    const runtimeSkillIds = resolveRoutableSkillIds([
      ...directSkillIds,
      ...resolvedKitCapabilities.skillIds,
    ]);
    const kitReferences = buildKitReferences(kitIds, marketplaceKits);

    return {
      directSkillIds,
      runtimeSkillIds,
      kitReferences,
      resolvedKitCapabilities,
    };
  }, [installedKits, marketplaceKits, resolveRoutableSkillIds]);

  const buildApiConfigNotice = (error?: string): { noticeI18nKey: string; noticeExtra?: string } => {
    const key = 'coworkModelSettingsRequired';
    if (!error) {
      return { noticeI18nKey: key };
    }
    const normalizedError = error.trim();
    if (
      normalizedError.startsWith('No enabled provider found for model:')
      || normalizedError === 'No available model configured in enabled providers.'
    ) {
      return { noticeI18nKey: key };
    }
    return { noticeI18nKey: key, noticeExtra: error };
  };

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
    const init = async () => {
      await coworkService.init();
      const initialEngineStatus = await coworkService.getOpenClawEngineStatus();
      if (initialEngineStatus) {
        setOpenClawStatus(initialEngineStatus);
      }
      // Load quick actions with localization
      try {
        quickActionService.initialize();
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to load quick actions:', error);
      }
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          onRequestAppSettings?.({
            initialTab: 'model',
            ...buildApiConfigNotice(apiConfig.error),
          });
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }
      setIsInitialized(true);
    };
    init();

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
      unsubscribe();
      unsubscribeOpenClawStatus();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  const handleStartSession = async (
    prompt: string,
    skillPrompt?: string,
    imageAttachments?: CoworkImageAttachment[],
    mediaReferences?: MediaAttachmentRef[],
    selectedTextSnippets?: CoworkSelectedTextSnippet[],
    collaborationMode: CoworkCollaborationModeType = CoworkCollaborationMode.Default,
  ): Promise<boolean | void> => {
    console.log('[CoworkView] handleStartSession: imageAttachments diagnosis', {
      hasImageAttachments: !!imageAttachments,
      count: imageAttachments?.length ?? 0,
      details: imageAttachments?.map(a => ({ name: a.name, mimeType: a.mimeType, base64Length: a.base64Data?.length ?? 0 })) ?? [],
    });
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
          onRequestAppSettings?.({
            initialTab: 'model',
            ...buildApiConfigNotice(apiConfig.error),
          });
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
        status: 'running',
        pinned: false,
        createdAt: now,
        updatedAt: now,
        cwd: currentAgentWorkingDirectory,
        systemPrompt: '',
        modelOverride: currentAgentSelectedModel ? toOpenClawModelRef(currentAgentSelectedModel) : '',
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
            metadata: (displayDirectSkillIds.length > 0 || displayKitIds.length > 0 || imageAttachmentPreviews?.length || (selectedTextSnippets && selectedTextSnippets.length > 0) || goalSettingMetadata)
              ? {
                ...goalSettingMetadata,
                ...(displayDirectSkillIds.length > 0 ? { skillIds: displayDirectSkillIds } : {}),
                ...(displayKitIds.length > 0 ? {
                  kitIds: displayKitIds,
                  kitReferences,
                  resolvedKitCapabilities,
                } : {}),
                ...(selectedTextSnippets && selectedTextSnippets.length > 0 ? { selectedTextSnippets } : {}),
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
      const sessionModelOverride = currentAgentSelectedModel ? toOpenClawModelRef(currentAgentSelectedModel) : '';
      logCoworkViewModel(
        `creating session with model ${sessionModelOverride || 'default'}; agent model is ${currentAgent?.model || 'empty'}; server model is ${currentAgentSelectedModel?.isServerModel === true}`,
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
        imageAttachments,
        mediaSelection: mediaSelection && mediaSelection.mode !== 'none' ? mediaSelection : undefined,
        mediaReferences,
        selectedTextSnippets,
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

  // Handle quick action button click: select action + activate skill in one batch
  const handleActionSelect = (actionId: string) => {
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

  // When the mapped skill is deactivated from input area, restore the QuickActionBar
  useEffect(() => {
    if (!selectedActionId) return;
    const action = quickActions.find(a => a.id === selectedActionId);
    if (action) {
      const skillStillActive = activeSkillIds.includes(action.skillMapping);
      if (!skillStillActive) {
        dispatch(clearSelection());
      }
    }
  }, [activeSkillIds, dispatch, quickActions, selectedActionId]);

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
      void coworkService.loadSession(runningSessionId);
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [currentSession]);

  if (!isInitialized) {
    return (
      <div className="flex-1 h-full flex flex-col bg-background">
        <div className="draggable flex h-12 items-center justify-end px-4 border-b border-border shrink-0">
          <WindowTitleBar inline />
        </div>
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
    <div className="draggable flex h-12 items-center justify-between px-4 shrink-0">
      <div className="non-draggable h-8 flex items-center">
        {isSidebarCollapsed && (
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
        <div className="flex items-center gap-1.5 mr-2 px-2.5 py-1">
          <ShieldCheckIcon className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          <span className="text-xs text-green-600 dark:text-green-400 whitespace-nowrap">
            {i18nService.t('lobsterGuardEnabled')}
          </span>
        </div>
        <WindowTitleBar inline />
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

  // When there's a current session, show the session detail view
  if (currentSession) {
    return (
      <div className="relative flex-1 flex flex-col h-full">
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
        />
      </div>
    );
  }

  // Home view - no current session
  return (
    <div className="relative flex-1 flex flex-col bg-background h-full">
      {/* Engine status banner for non-blocking states */}
      {engineStatusBanner}

      {/* Header */}
      {homeHeader}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto min-h-0 relative">
        <div className="relative flex min-h-full w-full min-w-[320px] flex-col items-center px-4 py-8">
          {/* Flexible spacers (2:3) keep the welcome block at the optical
              center on tall windows; min-h preserves breathing room before
              the page starts scrolling on short windows. */}
          <div aria-hidden="true" className="w-full min-h-[56px] flex-[2_0_0px]" />
          {/* Welcome Section - staggered entrance animation */}
          <div className="w-full max-w-3xl text-center">
            <img
              src="logo.png"
              alt="LobsterAI"
              className="mx-auto h-12 w-12 animate-fade-in-up"
            />
            <h2
              className="mt-4 text-2xl font-semibold leading-[var(--lobster-leading-2xl)] tracking-normal text-foreground animate-fade-in-up"
              style={{ animationDelay: '70ms', animationFillMode: 'both' }}
            >
              {i18nService.t(resolveHomeGreetingKey())}
            </h2>
            <p
              className="mt-2 text-[length:var(--lobster-text-promptLarge)] font-normal leading-[var(--lobster-leading-promptLarge)] text-secondary animate-fade-in-up"
              style={{ animationDelay: '120ms', animationFillMode: 'both' }}
            >
              {i18nService.t('coworkHomeTagline')}
            </p>
          </div>

          {/* Prompt Input Area - Large version with folder selector */}
          <div
            className="relative z-30 mt-9 w-full max-w-3xl animate-fade-in-up"
            style={{ animationDelay: '180ms', animationFillMode: 'both' }}
          >
            <CoworkPromptInput
              ref={promptInputRef}
              onSubmit={handleStartSession}
              onStop={handleStopSession}
              isStreaming={isStreaming}
              disabled={!isEngineReady}
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
          </div>

          {/* Quick Actions */}
          <div
            className="relative z-0 mt-8 flex w-full max-w-3xl flex-col items-center animate-fade-in-up"
            style={{ animationDelay: '260ms', animationFillMode: 'both' }}
          >
            {selectedAction ? (
              <PromptPanel
                action={selectedAction}
                onPromptSelect={handleQuickActionPromptSelect}
              />
            ) : (
              <QuickActionBar actions={quickActions} onActionSelect={handleActionSelect} />
            )}
            <CreditsResetCampaignFloat />
          </div>

          <div aria-hidden="true" className="w-full min-h-[24px] flex-[3_0_0px]" />
        </div>
      </div>
    </div>
  );
};

export default CoworkView;
