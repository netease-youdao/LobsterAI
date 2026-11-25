import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SparklesIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  AgentCreateIconSource,
  AgentDraftErrorCode,
  AgentDraftLanguage,
  AgentDraftMode,
  type GeneratedAgentDraft,
  pickRandomAgentAvatarIcon,
  resolveAgentIconOnAiDraft,
  resolveAgentIconOnTitleChange,
  SubagentCollaborationMode,
} from '@shared/agent';
import { ExpertUiEvent } from '@shared/agent/presets';
import { ENABLE_EXPERT_PLAZA_UI } from '@shared/featureFlags';
import { ProviderName } from '@shared/providers';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../../services/agent';
import { saveAgentOnboardingMeta } from '../../services/agentOnboarding';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import { resolveThinkingLevelForModel } from '../../services/modelThinkingLevelMemory';
import type { RootState } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import type { IMGatewayConfig } from '../../types/im';
import type { Skill } from '../../types/skill';
import { getAgentDisplayName } from '../../utils/agentDisplay';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import Modal from '../common/Modal';
import ModelSelector from '../ModelSelector';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
} from '../settings/settingsTypography';
import AgentAvatarPicker from './AgentAvatarPicker';
import {
  countSelectedCollaborators,
  getDisplayedCollaboratorIds,
  isRestrictedCollaborationMode,
  resolveCollaborationPayloadOnSave,
  selectCollaborationScope,
  toggleCollaboratorAgent,
} from './agentCollaborationHelpers';
import AgentCollaborationSettings from './AgentCollaborationSettings';
import AgentConfirmDialog from './AgentConfirmDialog';
import { formatAgentDraftError } from './agentDraftErrors';
import AgentImBindingList from './AgentImBindingList';
import {
  AgentCreateAiActionKind,
  buildCreateDraftInputs,
  deriveAgentNameFromFolder,
  resolveCreateAiActionKind,
  resolveCreateSubmitDescription,
} from './agentPersonaHelpers';
import AgentSkillSelector from './AgentSkillSelector';
import AgentWorkingDirectoryField from './AgentWorkingDirectoryField';
import { AgentConfirmDialogVariant } from './constants';

type AgentCreateAnalyticsSource =
  | 'home_agent_sidebar'
  | 'home_agent_sidebar_empty'
  | 'agents_view'
  | 'agent_create_modal';

type AgentCreateActionType =
  | 'open'
  | 'close'
  | 'open_expert_plaza'
  | 'ai_draft_generate'
  | 'create_submit'
  | 'create_success'
  | 'create_failed'
  | 'discard_confirm_open'
  | 'discard_confirm_submit'
  | 'discard_confirm_cancel';

interface AiDraftUndoSnapshot {
  instructions: string;
  generatedDraft: GeneratedAgentDraft | null;
  seedGoal: string | null;
  hadUserInput: boolean;
  autoFilledName?: string;
  previousIcon?: string;
  previousIconSource?: AgentCreateIconSource;
}

const AGENT_CREATE_ANALYTICS_DEFAULT_SOURCE: AgentCreateAnalyticsSource = 'agent_create_modal';

const serializeAnalyticsList = (values: string[]): string | undefined => {
  const normalizedValues = values.map(value => value.trim()).filter(Boolean);
  return normalizedValues.length > 0 ? normalizedValues.join(',') : undefined;
};

const getModelAnalyticsSource = (model: Model | null): 'package' | 'custom' | undefined => {
  if (!model) return undefined;
  if (model.isServerModel || model.providerKey === ProviderName.LobsteraiServer) {
    return 'package';
  }
  return 'custom';
};

const getModelSelectorGroup = (model: Model | null): 'server' | 'user' | undefined => {
  if (!model) return undefined;
  return model.isServerModel || model.providerKey === ProviderName.LobsteraiServer ? 'server' : 'user';
};

interface AgentCreateModalProps {
  isOpen?: boolean;
  onClose: () => void;
  presentation?: 'modal' | 'page';
  source?: AgentCreateAnalyticsSource;
}

const AgentCreateModal: React.FC<AgentCreateModalProps> = ({
  isOpen = true,
  onClose,
  presentation = 'modal',
  source = AGENT_CREATE_ANALYTICS_DEFAULT_SOURCE,
}) => {
  const globalSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const mcpServers = useSelector((state: RootState) => state.mcp.servers);

  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [icon, setIcon] = useState<string>(() => pickRandomAgentAvatarIcon({
    existingIcons: agents.filter(agent => agent.enabled).map(agent => agent.icon),
  }));
  const [iconSource, setIconSource] = useState<AgentCreateIconSource>(AgentCreateIconSource.InitialRandom);
  const [model, setModel] = useState<Model | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [restrictSkills, setRestrictSkills] = useState(false);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [subagentCollaborationMode, setSubagentCollaborationMode] = useState<SubagentCollaborationMode>(
    SubagentCollaborationMode.All,
  );
  const [subagentAllowAgentIds, setSubagentAllowAgentIds] = useState<string[]>([]);
  const [boundKeys, setBoundKeys] = useState<Set<string>>(new Set());
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showImSection, setShowImSection] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [streamingDraftPreview, setStreamingDraftPreview] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [generatedDraft, setGeneratedDraft] = useState<GeneratedAgentDraft | null>(null);
  const [aiUndoSnapshot, setAiUndoSnapshot] = useState<AiDraftUndoSnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);

  const agentsRef = useRef(agents);
  const initialIconRef = useRef(icon);
  const lastInitialIconRef = useRef<string | null>(null);
  const iconRef = useRef(icon);
  const iconSourceRef = useRef<AgentCreateIconSource>(iconSource);
  const initialModelRef = useRef('');
  const initializedOpenRef = useRef(false);
  const openPlazaOnCloseRef = useRef(false);
  const draftRequestSeqRef = useRef(0);
  const activeDraftRequestIdRef = useRef<string | null>(null);
  const seedGoalRef = useRef<string | null>(null);
  const preDraftSnapshotRef = useRef<{
    instructions: string;
    generatedDraft: GeneratedAgentDraft | null;
    aiUndoSnapshot: AiDraftUndoSnapshot | null;
    seedGoal: string | null;
  } | null>(null);
  const instructionsTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => () => {
    if (activeDraftRequestIdRef.current) {
      void agentService.cancelGenerateDraft(activeDraftRequestIdRef.current);
      activeDraftRequestIdRef.current = null;
    }
  }, []);

  const updateIconState = useCallback((nextIcon: string, nextSource: AgentCreateIconSource) => {
    iconRef.current = nextIcon;
    iconSourceRef.current = nextSource;
    setIcon(nextIcon);
    setIconSource(nextSource);
  }, []);

  const enabledSkills = useMemo(() => skills.filter(skill => skill.enabled), [skills]);
  const enabledMcpServers = useMemo(() => mcpServers.filter(server => server.enabled), [mcpServers]);

  const effectiveSkillIds = useMemo(
    () => (restrictSkills ? skillIds : []),
    [restrictSkills, skillIds],
  );

  const resolvedCollaboration = useMemo(
    () => resolveCollaborationPayloadOnSave({
      mode: subagentCollaborationMode,
      allowAgentIds: subagentAllowAgentIds,
    }),
    [subagentAllowAgentIds, subagentCollaborationMode],
  );

  const hasAdvancedOverrides = useMemo(() => {
    const currentModelRef = model ? toOpenClawModelRef(model) : '';
    return (
      currentModelRef !== initialModelRef.current
      || (restrictSkills && skillIds.length > 0)
      || resolvedCollaboration.subagentCollaborationMode !== SubagentCollaborationMode.All
      || resolvedCollaboration.subagentAllowAgentIds.length > 0
      || boundKeys.size > 0
    );
  }, [
    boundKeys.size,
    model,
    resolvedCollaboration.subagentAllowAgentIds.length,
    resolvedCollaboration.subagentCollaborationMode,
    restrictSkills,
    skillIds.length,
  ]);

  const getChangedFields = useCallback((): string[] => {
    const changedFields: string[] = [];
    if (name.trim()) changedFields.push('name');
    if (instructions.trim()) changedFields.push('systemPrompt');
    if (iconSource === AgentCreateIconSource.UserCustom && icon !== initialIconRef.current) {
      changedFields.push('icon');
    }
    if ((model ? toOpenClawModelRef(model) : '') !== initialModelRef.current) changedFields.push('model');
    if (workingDirectory.trim()) changedFields.push('workingDirectory');
    if (effectiveSkillIds.length > 0) changedFields.push('skillIds');
    if (resolvedCollaboration.subagentCollaborationMode !== SubagentCollaborationMode.All) {
      changedFields.push('subagentCollaborationMode');
    }
    if (resolvedCollaboration.subagentAllowAgentIds.length > 0) {
      changedFields.push('subagentAllowAgentIds');
    }
    if (boundKeys.size > 0) changedFields.push('imBindings');
    return changedFields;
  }, [
    boundKeys.size,
    effectiveSkillIds.length,
    icon,
    iconSource,
    instructions,
    model,
    name,
    resolvedCollaboration.subagentAllowAgentIds.length,
    resolvedCollaboration.subagentCollaborationMode,
    workingDirectory,
  ]);

  const isDirty = useCallback((): boolean => getChangedFields().length > 0, [getChangedFields]);

  const getSelectedSkills = useCallback((): Skill[] => (
    effectiveSkillIds
      .map(skillId => skills.find(skill => skill.id === skillId))
      .filter((skill): skill is Skill => Boolean(skill))
  ), [effectiveSkillIds, skills]);

  const getImPlatformsForAnalytics = useCallback((): string[] => {
    const platforms = new Set<string>();
    boundKeys.forEach((key) => {
      const platform = key.split(':')[0]?.trim();
      if (platform) platforms.add(platform);
    });
    return Array.from(platforms).sort();
  }, [boundKeys]);

  const reportAgentCreateAction = useCallback((
    actionType: AgentCreateActionType,
    options: {
      changedFields?: string[];
      errorCode?: 'create_agent_failed' | 'unknown';
      includeConfigDetails?: boolean;
      isDirty?: boolean;
      result?: 'success' | 'failed';
    } = {},
  ): void => {
    const changedFields = options.changedFields ?? [];
    const selectedSkills = options.includeConfigDetails ? getSelectedSkills() : [];
    const imPlatforms = options.includeConfigDetails ? getImPlatformsForAnalytics() : [];
    void reportYdAnalyzer({
      action: LogReporterAction.AgentCreateAction,
      source,
      actionType,
      creationMode: generatedDraft ? 'ai_assisted' : 'quick',
      isDirty: options.isDirty,
      changedFieldCount: changedFields.length,
      changedFields: changedFields.length > 0 ? changedFields.join(',') : undefined,
      skillCount: effectiveSkillIds.length,
      imBindingCount: boundKeys.size,
      hasModel: Boolean(model),
      hasWorkingDirectory: workingDirectory.trim().length > 0,
      result: options.result,
      errorCode: options.errorCode,
      modelId: options.includeConfigDetails ? model?.id : undefined,
      modelName: options.includeConfigDetails ? model?.name : undefined,
      modelSource: options.includeConfigDetails ? getModelAnalyticsSource(model) : undefined,
      providerKey: options.includeConfigDetails ? model?.providerKey : undefined,
      provider: options.includeConfigDetails ? model?.provider : undefined,
      selectorGroup: options.includeConfigDetails ? getModelSelectorGroup(model) : undefined,
      skillIds: options.includeConfigDetails ? serializeAnalyticsList(selectedSkills.map(skill => skill.id)) : undefined,
      skillNames: options.includeConfigDetails ? serializeAnalyticsList(selectedSkills.map(skill => skill.name)) : undefined,
      builtInSkillCount: options.includeConfigDetails
        ? selectedSkills.filter(skill => skill.isBuiltIn).length
        : undefined,
      customSkillCount: options.includeConfigDetails
        ? selectedSkills.filter(skill => !skill.isBuiltIn).length
        : undefined,
      imPlatforms: options.includeConfigDetails ? serializeAnalyticsList(imPlatforms) : undefined,
    });
  }, [
    boundKeys.size,
    effectiveSkillIds.length,
    generatedDraft,
    getImPlatformsForAnalytics,
    getSelectedSkills,
    model,
    source,
    workingDirectory,
  ]);

  const cancelActiveDraft = useCallback((restoreSnapshot: boolean) => {
    draftRequestSeqRef.current += 1;
    const activeId = activeDraftRequestIdRef.current;
    activeDraftRequestIdRef.current = null;
    if (activeId) {
      void agentService.cancelGenerateDraft(activeId);
    }
    const snapshot = preDraftSnapshotRef.current;
    preDraftSnapshotRef.current = null;
    setGenerating(false);
    setStreamingDraftPreview(false);
    if (restoreSnapshot && snapshot) {
      setInstructions(snapshot.instructions);
      setGeneratedDraft(snapshot.generatedDraft);
      setAiUndoSnapshot(snapshot.aiUndoSnapshot);
      seedGoalRef.current = snapshot.seedGoal;
    }
  }, []);

  const resetForm = useCallback(() => {
    cancelActiveDraft(false);
    const nextInitialIcon = pickRandomAgentAvatarIcon({
      existingIcons: agentsRef.current.filter(agent => agent.enabled).map(agent => agent.icon),
      excludeIcon: lastInitialIconRef.current,
    });
    lastInitialIconRef.current = nextInitialIcon;
    initialIconRef.current = nextInitialIcon;
    seedGoalRef.current = null;
    setName('');
    setInstructions('');
    updateIconState(nextInitialIcon, AgentCreateIconSource.InitialRandom);
    setModel(globalSelectedModel ?? null);
    setWorkingDirectory('');
    setRestrictSkills(false);
    setSkillIds([]);
    setSubagentCollaborationMode(SubagentCollaborationMode.All);
    setSubagentAllowAgentIds([]);
    setBoundKeys(new Set());
    setShowAdvanced(false);
    setShowImSection(false);
    setGenerating(false);
    setStreamingDraftPreview(false);
    setDraftError(null);
    setGeneratedDraft(null);
    setAiUndoSnapshot(null);
    setShowUnsavedConfirm(false);
  }, [cancelActiveDraft, globalSelectedModel, updateIconState]);

  useEffect(() => {
    if (!isOpen) {
      initializedOpenRef.current = false;
      cancelActiveDraft(false);
      return;
    }
    if (initializedOpenRef.current) return;
    initializedOpenRef.current = true;
    openPlazaOnCloseRef.current = false;
    initialModelRef.current = globalSelectedModel ? toOpenClawModelRef(globalSelectedModel) : '';
    resetForm();
    reportAgentCreateAction('open', { isDirty: false });
    imService.loadConfig().then((cfg) => {
      if (cfg) setImConfig(cfg);
    });
  }, [cancelActiveDraft, globalSelectedModel, isOpen, reportAgentCreateAction, resetForm]);

  useEffect(() => {
    if (!isOpen || model || !globalSelectedModel) return;
    if (!initialModelRef.current) {
      initialModelRef.current = toOpenClawModelRef(globalSelectedModel);
    }
    setModel(globalSelectedModel);
  }, [globalSelectedModel, isOpen, model]);

  if (!isOpen) return null;

  const closeEditor = () => {
    draftRequestSeqRef.current += 1;
    onClose();
    if (openPlazaOnCloseRef.current) {
      window.dispatchEvent(new Event(ExpertUiEvent.OpenPlaza));
    }
  };

  const handleClose = () => {
    const changedFields = getChangedFields();
    if (changedFields.length > 0) {
      reportAgentCreateAction('discard_confirm_open', {
        changedFields,
        isDirty: true,
      });
      setShowUnsavedConfirm(true);
    } else {
      reportAgentCreateAction('close', { isDirty: false });
      closeEditor();
    }
  };

  const handleConfirmDiscard = () => {
    reportAgentCreateAction('discard_confirm_submit', {
      changedFields: getChangedFields(),
      isDirty: true,
    });
    setShowUnsavedConfirm(false);
    closeEditor();
  };

  const handleCancelDiscard = () => {
    openPlazaOnCloseRef.current = false;
    reportAgentCreateAction('discard_confirm_cancel', {
      changedFields: getChangedFields(),
      isDirty: true,
    });
    setShowUnsavedConfirm(false);
  };

  const handleNameChange = (nextName: string) => {
    setName(nextName);
    const resolvedIcon = resolveAgentIconOnTitleChange({
      title: nextName,
      initialIcon: initialIconRef.current,
      currentIcon: iconRef.current,
      currentSource: iconSourceRef.current,
    });
    if (resolvedIcon.icon !== iconRef.current || resolvedIcon.source !== iconSourceRef.current) {
      updateIconState(resolvedIcon.icon, resolvedIcon.source);
    }
  };

  const handleFolderChange = (nextFolder: string) => {
    setWorkingDirectory(nextFolder);
    if (nextFolder.trim()) {
      const derivedName = deriveAgentNameFromFolder(name, nextFolder);
      if (derivedName !== name) {
        handleNameChange(derivedName);
      }
    }
  };

  const handleInstructionsChange = (nextValue: string) => {
    setInstructions(nextValue);
    if (draftError) setDraftError(null);
    if (aiUndoSnapshot) setAiUndoSnapshot(null);
    if (!nextValue.trim()) {
      setGeneratedDraft(null);
      seedGoalRef.current = null;
    }
  };

  const handleUndoAiDraft = () => {
    if (!aiUndoSnapshot || generating) return;
    setInstructions(aiUndoSnapshot.instructions);
    setGeneratedDraft(aiUndoSnapshot.generatedDraft);
    seedGoalRef.current = aiUndoSnapshot.seedGoal;
    if (aiUndoSnapshot.autoFilledName && name === aiUndoSnapshot.autoFilledName) {
      setName('');
    }
    if (
      aiUndoSnapshot.previousIcon
      && aiUndoSnapshot.previousIconSource
      && iconSourceRef.current === AgentCreateIconSource.AiDraft
    ) {
      updateIconState(aiUndoSnapshot.previousIcon, aiUndoSnapshot.previousIconSource);
    }
    setAiUndoSnapshot(null);
    setDraftError(null);
    requestAnimationFrame(() => {
      instructionsTextareaRef.current?.focus();
    });
  };

  const canGenerateWithAi = Boolean(name.trim() || instructions.trim() || workingDirectory.trim());
  const isAiOutputUnmodified = Boolean(generatedDraft && instructions === generatedDraft.instructions);
  const aiActionKind = resolveCreateAiActionKind({ instructions, isAiOutputUnmodified });

  const handleGenerateDraft = async () => {
    if (generating) {
      cancelActiveDraft(true);
      return;
    }
    if (!canGenerateWithAi) return;
    const reqSeq = ++draftRequestSeqRef.current;
    const requestId = `agent-create-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const draftInputs = buildCreateDraftInputs({
      actionKind: aiActionKind,
      name,
      instructions,
      workingDirectory,
      seedGoal: seedGoalRef.current,
      hasExistingDraft: Boolean(generatedDraft),
    });
    const snapshot = {
      instructions,
      generatedDraft,
      aiUndoSnapshot,
      seedGoal: seedGoalRef.current,
    };
    const previousIcon = iconRef.current;
    const previousIconSource = iconSourceRef.current;
    preDraftSnapshotRef.current = snapshot;
    activeDraftRequestIdRef.current = requestId;
    setGenerating(true);
    setStreamingDraftPreview(false);
    setDraftError(null);
    setAiUndoSnapshot(null);
    reportAgentCreateAction('ai_draft_generate', { isDirty: isDirty() });

    const language = i18nService.getLanguage() === 'en'
      ? AgentDraftLanguage.En
      : AgentDraftLanguage.Zh;

    const result = await agentService.generateDraft(
      {
        requestId,
        mode: AgentDraftMode.Create,
        name: name.trim() || undefined,
        goal: draftInputs.goal,
        workingDirectory: workingDirectory.trim() || undefined,
        ...(draftInputs.existingInstructions ? { existingInstructions: draftInputs.existingInstructions } : {}),
        language,
      },
      {
        onProgress: (preview) => {
          if (reqSeq !== draftRequestSeqRef.current) return;
          if (preview.instructions !== undefined) {
            setStreamingDraftPreview(true);
            setInstructions(preview.instructions);
            requestAnimationFrame(() => {
              const el = instructionsTextareaRef.current;
              if (el) {
                el.scrollTop = el.scrollHeight;
              }
            });
          }
        },
      },
    );

    if (reqSeq !== draftRequestSeqRef.current) return;
    activeDraftRequestIdRef.current = null;
    preDraftSnapshotRef.current = null;
    setGenerating(false);
    setStreamingDraftPreview(false);

    if (!result.success) {
      setInstructions(snapshot.instructions);
      setGeneratedDraft(snapshot.generatedDraft);
      setAiUndoSnapshot(snapshot.aiUndoSnapshot);
      seedGoalRef.current = snapshot.seedGoal;
      if (result.errorCode !== AgentDraftErrorCode.Cancelled) {
        setDraftError(formatAgentDraftError(result.errorCode));
      }
      return;
    }

    const { draft } = result;
    setGeneratedDraft(draft);
    seedGoalRef.current = draftInputs.nextSeedGoal;
    const nextDraftName = !name.trim() && draft.name ? draft.name : undefined;
    if (nextDraftName) {
      setName(nextDraftName);
    }
    setInstructions(draft.instructions);
    const resolvedIcon = resolveAgentIconOnAiDraft({
      draftAvatarSvg: draft.avatarSvg,
      draftName: nextDraftName ?? name,
      currentIcon: iconRef.current,
      currentSource: iconSourceRef.current,
    });
    const iconChangedByAi = resolvedIcon.icon !== iconRef.current || resolvedIcon.source !== iconSourceRef.current;
    if (iconChangedByAi) {
      updateIconState(resolvedIcon.icon, resolvedIcon.source);
    }
    setAiUndoSnapshot({
      instructions: snapshot.instructions,
      generatedDraft: snapshot.generatedDraft,
      seedGoal: snapshot.seedGoal,
      hadUserInput: aiActionKind === AgentCreateAiActionKind.Refine,
      ...(nextDraftName ? { autoFilledName: nextDraftName } : {}),
      ...(iconChangedByAi ? { previousIcon, previousIconSource } : {}),
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || creating || generating) return;
    const changedFields = getChangedFields();
    reportAgentCreateAction('create_submit', {
      changedFields,
      includeConfigDetails: true,
      isDirty: changedFields.length > 0,
    });
    setCreating(true);
    try {
      const trimmedInstructions = instructions.trim();
      const effectiveDescription = resolveCreateSubmitDescription({
        instructions: trimmedInstructions,
        generatedDescription: generatedDraft?.description,
      });

      const agent = await agentService.createAgent({
        name: name.trim(),
        description: effectiveDescription,
        systemPrompt: trimmedInstructions,
        identity: '',
        model: model ? toOpenClawModelRef(model) : '',
        thinkingLevel: resolveThinkingLevelForModel(model),
        workingDirectory: workingDirectory.trim(),
        icon: icon.trim() || undefined,
        skillIds: effectiveSkillIds,
        subagentCollaborationMode: resolvedCollaboration.subagentCollaborationMode,
        subagentAllowAgentIds: resolvedCollaboration.subagentAllowAgentIds,
      });
      if (agent) {
        if (generatedDraft && generatedDraft.starterPrompts.length > 0) {
          saveAgentOnboardingMeta(agent.id, {
            starterPrompts: generatedDraft.starterPrompts,
          });
        }
        if (boundKeys.size > 0 && imConfig) {
          const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
          for (const key of boundKeys) {
            currentBindings[key] = agent.id;
          }
          await imService.persistConfig({
            settings: { ...imConfig.settings, platformAgentBindings: currentBindings },
          });
          await imService.saveAndSyncConfig();
        }
        agentService.switchAgent(agent.id);
        reportAgentCreateAction('create_success', {
          changedFields,
          includeConfigDetails: true,
          isDirty: false,
          result: 'success',
        });
        onClose();
        resetForm();
      } else {
        reportAgentCreateAction('create_failed', {
          changedFields,
          errorCode: 'create_agent_failed',
          includeConfigDetails: true,
          isDirty: changedFields.length > 0,
          result: 'failed',
        });
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentCreateFailed') }));
      }
    } catch {
      reportAgentCreateAction('create_failed', {
        changedFields,
        errorCode: 'unknown',
        includeConfigDetails: true,
        isDirty: changedFields.length > 0,
        result: 'failed',
      });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentCreateFailed') }));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleIMBinding = (key: string) => {
    setBoundKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSelectCollaborationScope = (restricted: boolean) => {
    const next = selectCollaborationScope({
      currentMode: subagentCollaborationMode,
      allowAgentIds: subagentAllowAgentIds,
      restricted,
    });
    setSubagentCollaborationMode(next.mode);
    setSubagentAllowAgentIds(next.allowAgentIds);
  };

  const handleToggleSubagentAllowAgent = (targetAgentId: string) => {
    const next = toggleCollaboratorAgent({
      mode: subagentCollaborationMode,
      allowAgentIds: subagentAllowAgentIds,
      targetAgentId,
    });
    setSubagentCollaborationMode(next.mode);
    setSubagentAllowAgentIds(next.allowAgentIds);
  };

  const availableSubagentAgents = agents
    .filter(candidate => candidate.enabled)
    .sort((left, right) => getAgentDisplayName(left).localeCompare(getAgentDisplayName(right)));

  const isRestrictedCollab = isRestrictedCollaborationMode(subagentCollaborationMode);
  const displayedAllowAgentIds = getDisplayedCollaboratorIds(subagentCollaborationMode, subagentAllowAgentIds);
  const availableCandidateIds = new Set(availableSubagentAgents.map(candidate => candidate.id));
  const selectedCollaboratorCount = countSelectedCollaborators(displayedAllowAgentIds, availableCandidateIds);

  const collabDescription = !isRestrictedCollab
    ? availableSubagentAgents.length > 0
      ? i18nService.t('agentSubagentsScopeAllHint').replace('{count}', String(availableSubagentAgents.length))
      : i18nService.t('agentSubagentsScopeAllEmptyHint')
    : selectedCollaboratorCount > 0
      ? i18nService.t('agentSubagentsScopeCustomCount').replace('{count}', String(selectedCollaboratorCount))
      : i18nService.t('agentSubagentsAllowlistEmptyHint');

  const imSummaryLabel = boundKeys.size > 0
    ? i18nService.t('agentSettingsImSummaryCount').replace('{count}', String(boundKeys.size))
    : i18nService.t('agentSettingsImSummaryNone');

  const globalCapabilitiesSubtitle = enabledMcpServers.length > 0
    ? i18nService.t('agentSettingsCapabilitiesGlobalStats')
        .replace('{skills}', String(enabledSkills.length))
        .replace('{mcps}', String(enabledMcpServers.length))
    : i18nService.t('agentSettingsCapabilitiesGlobalSkillsOnly')
        .replace('{skills}', String(enabledSkills.length));

  const hasGlobalCapabilities = enabledSkills.length > 0 || enabledMcpServers.length > 0;
  const capabilitiesDescription = restrictSkills && skillIds.length > 0
    ? i18nService.t('agentSettingsSkillScopeCustomCount').replace('{count}', String(skillIds.length))
    : hasGlobalCapabilities
      ? globalCapabilitiesSubtitle
      : i18nService.t('agentSettingsCapabilitiesGlobalSummary');

  const aiActionLabel = (() => {
    switch (aiActionKind) {
      case AgentCreateAiActionKind.Regenerate:
        return i18nService.t('agentCreateAiRegenerate');
      case AgentCreateAiActionKind.Refine:
        return i18nService.t('agentCreateAiRefine');
      default:
        return i18nService.t('agentCreateAiGenerate');
    }
  })();

  const editorContent = (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/70 px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">
            {i18nService.t('createNewAgent')}
          </h2>
          <p className="mt-0.5 text-xs text-secondary">
            {i18nService.t('agentCreateSubtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-4 [scrollbar-gutter:stable]">
        {/* 1. Avatar + Name */}
        <div className="flex items-center gap-3.5">
          <AgentAvatarPicker
            value={icon}
            onChange={(nextIcon) => {
              updateIconState(nextIcon, AgentCreateIconSource.UserCustom);
            }}
          />
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && name.trim() && !creating && !generating) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder={i18nService.t('agentCreateNamePlaceholder')}
              aria-label={i18nService.t('agentName')}
              className="h-10 w-full rounded-xl border border-border-input bg-transparent px-3.5 text-sm font-medium text-foreground placeholder:font-normal placeholder:text-secondary/50 focus:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-foreground/[0.06]"
              autoFocus
            />
          </div>
        </div>

        {/* 2. Unified Goal / Role & Rules with in-place AI generation */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <label htmlFor="agent-create-goal" className="text-sm font-medium text-foreground">
              {i18nService.t('agentCreateGoalLabel')}
            </label>
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-secondary">
              {i18nService.t('agentCreateOptionalTag')}
            </span>
          </div>

          <div
            className={`overflow-hidden rounded-xl border bg-surface transition-colors ${
              generating
                ? 'border-foreground/25 ring-2 ring-foreground/[0.06]'
                : 'border-border-input focus-within:border-foreground/30 focus-within:ring-2 focus-within:ring-foreground/[0.06]'
            }`}
          >
            <textarea
              ref={instructionsTextareaRef}
              id="agent-create-goal"
              rows={5}
              value={instructions}
              onChange={(e) => handleInstructionsChange(e.target.value)}
              readOnly={generating}
              placeholder={i18nService.t('agentCreateGoalPlaceholder')}
              className="block min-h-[132px] max-h-[260px] w-full resize-y bg-transparent px-3.5 pt-3 pb-2.5 text-sm leading-6 text-foreground placeholder:text-secondary/50 focus:outline-none"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-raised/45 px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-1.5">
                {generating ? (
                  <span className="inline-flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-foreground/80">
                    <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground" />
                    <span>
                      {streamingDraftPreview
                        ? i18nService.t('agentRulesAiStreaming')
                        : i18nService.t('agentCreateAiGenerating')}
                    </span>
                  </span>
                ) : aiUndoSnapshot ? (
                  <div className="flex flex-wrap items-center gap-1.5 px-1 animate-fade-in">
                    <span className="text-xs text-secondary">
                      {aiUndoSnapshot.hadUserInput
                        ? i18nService.t('agentCreateAiRefinedHint')
                        : i18nService.t('agentCreateAiGeneratedHint')}
                    </span>
                    <span className="text-secondary/35" aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={handleUndoAiDraft}
                      className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
                    >
                      <ArrowUturnLeftIcon className="h-3 w-3 shrink-0" />
                      <span>
                        {aiUndoSnapshot.hadUserInput
                          ? i18nService.t('agentRulesAiUndo')
                          : i18nService.t('agentRulesUndoAction')}
                      </span>
                    </button>
                  </div>
                ) : !canGenerateWithAi ? (
                  <span className="px-1 text-xs text-secondary/75">
                    {i18nService.t('agentCreateAiReadyHint')}
                  </span>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => void handleGenerateDraft()}
                disabled={!generating && !canGenerateWithAi}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-surface px-2.5 text-xs font-medium text-foreground shadow-subtle transition-colors hover:bg-surface-raised active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 ${
                  generating ? 'border-foreground/20' : 'border-border'
                }`}
              >
                {generating ? (
                  <StopIcon className="h-3.5 w-3.5" />
                ) : (
                  <SparklesIcon className="h-3.5 w-3.5 text-secondary" />
                )}
                <span>
                  {generating ? i18nService.t('agentRulesAiStop') : aiActionLabel}
                </span>
              </button>
            </div>
          </div>

          {draftError && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {draftError}
            </p>
          )}
        </div>

        {/* 3. Linked Folder (compact single row matching AgentSettingsPanel) */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('agentCreateFolderLabel')}
              </span>
              <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-secondary">
                {i18nService.t('agentCreateOptionalTag')}
              </span>
            </div>
            <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
              {i18nService.t('agentCreateFolderHint')}
            </p>
          </div>
          <div className="shrink-0">
            <AgentWorkingDirectoryField
              value={workingDirectory}
              onChange={handleFolderChange}
              compact
              bordered
              placement="top"
            />
          </div>
        </div>

        {/* 4. Collapsible Advanced Options (aligned with AgentSettingsPanel) */}
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <button
            type="button"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(prev => !prev)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised/50"
          >
            <div className="flex min-w-0 items-center gap-2">
              {showAdvanced ? (
                <ChevronDownIcon className="h-4 w-4 shrink-0 text-secondary" />
              ) : (
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
              )}
              <span className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('agentCreateAdvancedToggle')}
              </span>
              {hasAdvancedOverrides && (
                <span className="rounded-full bg-foreground/[0.08] px-2 py-0.5 text-[11px] font-medium text-foreground">
                  {i18nService.t('agentCreateAdvancedCustomBadge')}
                </span>
              )}
            </div>
            {!showAdvanced && (
              <span className="truncate text-xs text-secondary/80">
                {i18nService.t('agentCreateAdvancedSummary')}
              </span>
            )}
          </button>

          {showAdvanced && (
            <div className="divide-y divide-border border-t border-border">
              {/* Default Model */}
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                      {i18nService.t('agentSettingsModelSection')}
                    </div>
                    <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                      {i18nService.t('agentSettingsModelSectionHint')}
                    </p>
                  </div>
                  <div className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-surface px-0.5">
                    <ModelSelector
                      compact
                      hideCustomProviderName
                      triggerMaxWidthClassName="max-w-[216px]"
                      alignDropdownToTriggerEnd
                      dropdownDirection="auto"
                      value={model}
                      onChange={setModel}
                      portal
                    />
                  </div>
                </div>
              </div>

              {/* Capabilities & Tools */}
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                      {i18nService.t('agentSettingsCapabilitiesSection')}
                    </div>
                    <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                      {capabilitiesDescription}
                    </p>
                  </div>

                  <div className="inline-flex shrink-0 rounded-lg bg-surface-raised p-0.5">
                    <button
                      type="button"
                      onClick={() => setRestrictSkills(false)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        !restrictSkills
                          ? 'bg-surface font-medium text-foreground shadow-subtle'
                          : 'text-secondary hover:text-foreground'
                      }`}
                    >
                      {i18nService.t('agentSettingsSkillScopeAllShort')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRestrictSkills(true)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        restrictSkills
                          ? 'bg-surface font-medium text-foreground shadow-subtle'
                          : 'text-secondary hover:text-foreground'
                      }`}
                    >
                      {i18nService.t('agentSettingsSkillScopeCustomShort')}
                    </button>
                  </div>
                </div>

                {restrictSkills && (
                  <div className="mt-3 h-[268px] rounded-lg border border-border bg-surface-raised/25 p-3">
                    <AgentSkillSelector selectedSkillIds={skillIds} onChange={setSkillIds} />
                  </div>
                )}

                {enabledMcpServers.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2.5">
                    <span
                      className="mr-1 text-xs text-secondary"
                      title={i18nService.t('agentSettingsMcpSummaryHint')}
                    >
                      {i18nService.t('agentSettingsMcpSummaryTitle')}
                    </span>
                    {enabledMcpServers.map(server => (
                      <span
                        key={server.id}
                        className="max-w-[160px] truncate rounded-md bg-surface-raised px-2 py-0.5 text-xs text-foreground/85"
                      >
                        {server.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* IM Channels */}
              <div>
                <button
                  type="button"
                  aria-expanded={showImSection}
                  onClick={() => setShowImSection(prev => !prev)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised/50"
                >
                  <span className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                    {i18nService.t('agentTabIM')}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-secondary">
                    <span>{imSummaryLabel}</span>
                    {showImSection ? (
                      <ChevronDownIcon className="h-4 w-4 text-secondary/70" />
                    ) : (
                      <ChevronRightIcon className="h-4 w-4 text-secondary/70" />
                    )}
                  </span>
                </button>
                {showImSection && (
                  <div className="border-t border-border-subtle bg-surface-raised/20 px-4 py-3.5">
                    <AgentImBindingList
                      imConfig={imConfig}
                      boundKeys={boundKeys}
                      agents={agents}
                      onToggleBinding={handleToggleIMBinding}
                      onBeforeOpenImSettings={onClose}
                    />
                  </div>
                )}
              </div>

              {/* Multi-Agent Collaboration */}
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                      {i18nService.t('agentSubagentsTitle')}
                    </div>
                    <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                      {collabDescription}
                    </p>
                  </div>

                  <div
                    className="inline-flex shrink-0 rounded-lg bg-surface-raised p-0.5"
                    role="group"
                    aria-label={i18nService.t('agentSubagentsTitle')}
                  >
                    <button
                      type="button"
                      aria-pressed={!isRestrictedCollab}
                      onClick={() => handleSelectCollaborationScope(false)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        !isRestrictedCollab
                          ? 'bg-surface font-medium text-foreground shadow-subtle'
                          : 'text-secondary hover:text-foreground'
                      }`}
                    >
                      {i18nService.t('agentSubagentsScopeAllShort')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={isRestrictedCollab}
                      onClick={() => handleSelectCollaborationScope(true)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        isRestrictedCollab
                          ? 'bg-surface font-medium text-foreground shadow-subtle'
                          : 'text-secondary hover:text-foreground'
                      }`}
                    >
                      {i18nService.t('agentSubagentsScopeCustomShort')}
                    </button>
                  </div>
                </div>

                {isRestrictedCollab && (
                  <div className="mt-3 max-h-[240px] overflow-y-auto rounded-lg border border-border bg-surface-raised/25 p-2">
                    <AgentCollaborationSettings
                      allowAgentIds={displayedAllowAgentIds}
                      candidates={availableSubagentAgents}
                      onToggleAllowAgent={handleToggleSubagentAllowAgent}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/70 px-6 py-3.5">
        <div className="min-w-0">
          {ENABLE_EXPERT_PLAZA_UI && (
            <button
              type="button"
              onClick={() => {
                reportAgentCreateAction('open_expert_plaza', { isDirty: isDirty() });
                openPlazaOnCloseRef.current = true;
                handleClose();
              }}
              className="group inline-flex items-center gap-1 text-xs text-secondary transition-colors hover:text-foreground"
            >
              <span>{i18nService.t('agentCreateExplorePlazaHint')}</span>
              <span className="font-medium text-foreground group-hover:underline underline-offset-2">
                {i18nService.t('agentCreateExplorePlazaLink')} →
              </span>
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="h-9 rounded-xl border border-border bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised active:scale-[0.98]"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!name.trim() || creating || generating}
            className="h-9 rounded-xl bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? i18nService.t('creating') : i18nService.t('create')}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {presentation === 'page' ? (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
          {editorContent}
        </div>
      ) : (
        <Modal
          isOpen={isOpen}
          onClose={handleClose}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/15 dark:bg-black/50"
          className="flex max-h-[86vh] w-[calc(100vw-48px)] max-w-[580px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_16px_48px_rgba(0,0,0,0.16)]"
        >
          {editorContent}
        </Modal>
      )}

      {showUnsavedConfirm && (
        <AgentConfirmDialog
          variant={AgentConfirmDialogVariant.Unsaved}
          title={i18nService.t('agentUnsavedTitle')}
          message={i18nService.t('agentUnsavedMessage')}
          cancelLabel={i18nService.t('agentUnsavedStay')}
          confirmLabel={i18nService.t('agentUnsavedDiscard')}
          onCancel={handleCancelDiscard}
          onConfirm={handleConfirmDiscard}
        />
      )}
    </>
  );
};

export default AgentCreateModal;
