import {
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  AgentDraftErrorCode,
  AgentDraftLanguage,
  AgentDraftMode,
  AgentLegacyIdentityCleanupStatus,
  AgentModelSelectionMode,
  AgentRulePolishDirective,
  AgentSource,
  AgentUiEvent,
  normalizeSubagentCollaborationMode,
  SubagentCollaborationMode,
} from '@shared/agent';
import { ProviderName } from '@shared/providers';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../../services/agent';
import { saveAgentOnboardingMeta } from '../../services/agentOnboarding';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import { resolveThinkingLevelForModel } from '../../services/modelThinkingLevelMemory';
import { captureExpertModelSelection } from '../../services/newTaskModelSelection';
import { type RootState, store } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import type { Agent } from '../../types/agent';
import type { IMGatewayConfig } from '../../types/im';
import type { Skill } from '../../types/skill';
import { getAgentDisplayName, isDefaultAgentId, usesManagedPresetAvatar } from '../../utils/agentDisplay';
import { resolveOpenClawModelRef, toOpenClawModelRef } from '../../utils/openclawModelRef';
import Modal from '../common/Modal';
import TrashIcon from '../icons/TrashIcon';
import ModelSelector from '../ModelSelector';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
} from '../settings/settingsTypography';
import AgentAvatarPicker from './AgentAvatarPicker';
import {
  countSelectedCollaborators,
  getDisplayedCollaboratorIds,
  hasCollaborationChanged,
  isRestrictedCollaborationMode,
  resolveCollaborationPayloadOnSave,
  selectCollaborationScope,
  toggleCollaboratorAgent,
} from './agentCollaborationHelpers';
import AgentCollaborationSettings from './AgentCollaborationSettings';
import AgentConfirmDialog from './AgentConfirmDialog';
import { formatAgentDraftError } from './agentDraftErrors';
import {
  AGENT_DESCRIPTION_INPUT_CLASS,
  AGENT_HEADER_FIELDS_CLASS,
  AGENT_HEADER_IDENTITY_CLASS,
  AGENT_NAME_INPUT_CLASS,
} from './agentHeaderStyles';
import AgentImBindingList from './AgentImBindingList';
import {
  type AgentRuleTemplateOption,
  deriveUnifiedInstructions,
  resolveDescriptionOnAutoFill,
  resolvePersonaFilesOnSave,
  RulesUndoSource,
  UnifiedInstructionSource,
} from './agentPersonaHelpers';
import AgentRulesToolbar from './AgentRulesToolbar';
import AgentSkillSelector from './AgentSkillSelector';
import AgentWorkingDirectoryField from './AgentWorkingDirectoryField';
import { AgentConfirmDialogVariant, AgentPersonaFileTab } from './constants';

type AgentSettingsActionType =
  | 'open'
  | 'close'
  | 'ai_polish'
  | 'save_submit'
  | 'save_success'
  | 'save_failed'
  | 'discard_confirm_open'
  | 'discard_confirm_submit'
  | 'discard_confirm_cancel';

const AGENT_SETTINGS_ANALYTICS_SOURCE = 'agent_settings_panel';

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

interface AgentSettingsPanelProps {
  agentId: string | null;
  onClose: () => void;
}

const AgentSettingsPanel: React.FC<AgentSettingsPanelProps> = ({ agentId, onClose }) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const defaultSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const mcpServers = useSelector((state: RootState) => state.mcp.servers);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [identity, setIdentity] = useState('');
  const [userInfo, setUserInfo] = useState('');
  const [unifiedText, setUnifiedText] = useState('');
  const [unifiedSource, setUnifiedSource] = useState<UnifiedInstructionSource>(UnifiedInstructionSource.Soul);
  const [unifiedEdited, setUnifiedEdited] = useState(false);
  const [rawFilesEdited, setRawFilesEdited] = useState(false);

  const [icon, setIcon] = useState('');
  const [modelOverride, setModelOverride] = useState<Model | null | undefined>(undefined);
  const [modelSelectionMode, setModelSelectionMode] = useState<AgentModelSelectionMode>(AgentModelSelectionMode.Explicit);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [restrictSkills, setRestrictSkills] = useState(false);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [subagentCollaborationMode, setSubagentCollaborationMode] = useState<SubagentCollaborationMode>(
    SubagentCollaborationMode.All,
  );
  const [subagentAllowAgentIds, setSubagentAllowAgentIds] = useState<string[]>([]);
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [polishStreaming, setPolishStreaming] = useState(false);
  const [activePolishDirective, setActivePolishDirective] = useState<AgentRulePolishDirective | null>(null);
  const [polishError, setPolishError] = useState<string | null>(null);
  const [undoRulesSnapshot, setUndoRulesSnapshot] = useState<{
    text: string;
    edited: boolean;
    rawEdited: boolean;
    source: RulesUndoSource;
    previousDescription?: string;
  } | null>(null);
  const [rulesMenuOpen, setRulesMenuOpen] = useState(false);
  const [pendingStarterPrompts, setPendingStarterPrompts] = useState<string[] | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [pendingOpenMemoryAfterDiscard, setPendingOpenMemoryAfterDiscard] = useState(false);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);

  // Collapsible advanced sections
  const [showImSection, setShowImSection] = useState(false);
  const [showPersonaFilesSection, setShowPersonaFilesSection] = useState(false);
  const [activePersonaFileTab, setActivePersonaFileTab] = useState<AgentPersonaFileTab>(AgentPersonaFileTab.Soul);

  const openedAgentIdRef = useRef<string | null>(null);
  const polishSeqRef = useRef(0);
  const activePolishRequestIdRef = useRef<string | null>(null);
  const polishSnapshotRef = useRef<{
    text: string;
    edited: boolean;
    rawEdited: boolean;
    description: string;
    shouldAutoFillDescription: boolean;
  } | null>(null);
  const rulesTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // IM binding state
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundKeys, setBoundKeys] = useState<Set<string>>(new Set());
  const [initialBoundKeys, setInitialBoundKeys] = useState<Set<string>>(new Set());

  const isMainAgent = isDefaultAgentId(agentId);
  const enabledSkills = useMemo(() => skills.filter(skill => skill.enabled), [skills]);
  const enabledMcpServers = useMemo(() => mcpServers.filter(server => server.enabled), [mcpServers]);
  const effectiveSkillIds = useMemo(
    () => (!isMainAgent && restrictSkills ? skillIds : []),
    [isMainAgent, restrictSkills, skillIds],
  );

  const storedModel = useMemo(
    () => (agent ? resolveOpenClawModelRef(agent.model, availableModels) ?? defaultSelectedModel ?? null : null),
    [agent, availableModels, defaultSelectedModel],
  );
  const storedModelRef = storedModel ? toOpenClawModelRef(storedModel) : '';
  const model = modelOverride === undefined ? storedModel : modelOverride;

  const initialValuesRef = useRef({
    name: '',
    description: '',
    systemPrompt: '',
    identity: '',
    userInfo: '',
    icon: '',
    workingDirectory: '',
    skillIds: [] as string[],
    subagentCollaborationMode: SubagentCollaborationMode.All as SubagentCollaborationMode,
    subagentAllowAgentIds: [] as string[],
  });

  const resolvedPersona = useMemo(() => resolvePersonaFilesOnSave({
    initialIdentity: initialValuesRef.current.identity,
    initialSystemPrompt: initialValuesRef.current.systemPrompt,
    rawIdentity: identity,
    rawSystemPrompt: systemPrompt,
    unifiedText,
    unifiedSource,
    unifiedEdited,
    rawFilesEdited,
  }), [identity, rawFilesEdited, systemPrompt, unifiedEdited, unifiedSource, unifiedText]);

  const getChangedFields = useCallback((): string[] => {
    const init = initialValuesRef.current;
    const changedFields: string[] = [];
    if (name !== init.name) changedFields.push('name');
    if (description !== init.description) changedFields.push('description');
    if (resolvedPersona.systemPrompt !== init.systemPrompt) changedFields.push('systemPrompt');
    if (resolvedPersona.identity !== init.identity) changedFields.push('identity');
    if (userInfo !== init.userInfo) changedFields.push('userInfo');
    if (icon !== init.icon) changedFields.push('icon');
    if ((model ? toOpenClawModelRef(model) : '') !== storedModelRef) changedFields.push('model');
    if (modelSelectionMode !== (agent?.modelSelectionMode ?? AgentModelSelectionMode.Explicit)) {
      changedFields.push('modelSelectionMode');
    }
    if (workingDirectory !== init.workingDirectory) changedFields.push('workingDirectory');
    if (
      effectiveSkillIds.length !== init.skillIds.length
      || effectiveSkillIds.some((id, idx) => id !== init.skillIds[idx])
    ) {
      changedFields.push('skillIds');
    }
    const collaborationDiff = hasCollaborationChanged(
      {
        mode: init.subagentCollaborationMode,
        allowAgentIds: init.subagentAllowAgentIds,
      },
      resolveCollaborationPayloadOnSave({
        mode: subagentCollaborationMode,
        allowAgentIds: subagentAllowAgentIds,
        initialAllowAgentIds: init.subagentAllowAgentIds,
      }),
    );
    if (collaborationDiff.modeChanged) {
      changedFields.push('subagentCollaborationMode');
    }
    if (collaborationDiff.allowAgentIdsChanged) {
      changedFields.push('subagentAllowAgentIds');
    }
    if (boundKeys.size !== initialBoundKeys.size || [...boundKeys].some(k => !initialBoundKeys.has(k))) {
      changedFields.push('imBindings');
    }
    return changedFields;
  }, [
    agent?.modelSelectionMode,
    boundKeys,
    description,
    effectiveSkillIds,
    icon,
    initialBoundKeys,
    model,
    modelSelectionMode,
    name,
    resolvedPersona.identity,
    resolvedPersona.systemPrompt,
    storedModelRef,
    subagentAllowAgentIds,
    subagentCollaborationMode,
    userInfo,
    workingDirectory,
  ]);

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

  const reportAgentSettingsAction = useCallback((
    actionType: AgentSettingsActionType,
    options: {
      changedFields?: string[];
      includeConfigDetails?: boolean;
      isDirty?: boolean;
      result?: 'success' | 'failed';
    } = {},
  ): void => {
    const changedFields = options.changedFields ?? [];
    const selectedSkills = options.includeConfigDetails ? getSelectedSkills() : [];
    const imPlatforms = options.includeConfigDetails ? getImPlatformsForAnalytics() : [];
    void reportYdAnalyzer({
      action: LogReporterAction.AgentSettingsAction,
      source: AGENT_SETTINGS_ANALYTICS_SOURCE,
      actionType,
      agentType: isDefaultAgentId(agentId) ? 'main' : 'custom',
      isDirty: options.isDirty,
      changedFieldCount: changedFields.length,
      changedFields: changedFields.length > 0 ? changedFields.join(',') : undefined,
      skillCount: effectiveSkillIds.length,
      imBindingCount: boundKeys.size,
      hasModel: Boolean(model),
      hasWorkingDirectory: workingDirectory.trim().length > 0,
      result: options.result,
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
    agentId,
    boundKeys.size,
    effectiveSkillIds.length,
    getImPlatformsForAnalytics,
    getSelectedSkills,
    model,
    workingDirectory,
  ]);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    polishSeqRef.current += 1;
    if (activePolishRequestIdRef.current) {
      void agentService.cancelGenerateDraft(activePolishRequestIdRef.current);
      activePolishRequestIdRef.current = null;
    }
    polishSnapshotRef.current = null;
    setShowDeleteConfirm(false);
    setShowUnsavedConfirm(false);
    setPendingOpenMemoryAfterDiscard(false);
    setMemoryCount(null);
    setNameTouched(false);
    setPolishing(false);
    setPolishStreaming(false);
    setActivePolishDirective(null);
    setPolishError(null);
    setUndoRulesSnapshot(null);
    setRulesMenuOpen(false);
    setPendingStarterPrompts(null);
    setShowImSection(false);
    setShowPersonaFilesSection(false);
    setActivePersonaFileTab(AgentPersonaFileTab.Soul);

    void (async () => {
      const a = await window.electron?.agents?.get(agentId);
      if (!a || cancelled) return;

      const [nextIdentity, nextSystemPrompt, nextUserInfo, memoryStats] = await Promise.all([
        coworkService.readBootstrapFile('IDENTITY.md', { agentId }),
        coworkService.readBootstrapFile('SOUL.md', { agentId }),
        coworkService.readBootstrapFile('USER.md', { agentId }),
        coworkService.getMemoryStats({ agentId }).catch(() => null),
      ]);
      if (cancelled) return;
      setMemoryCount(memoryStats?.created ?? 0);

      const unified = deriveUnifiedInstructions({
        identity: nextIdentity,
        systemPrompt: nextSystemPrompt,
      });

      const loadedSkillIds = a.skillIds ?? [];
      const nextCollaborationMode = normalizeSubagentCollaborationMode(a.subagentCollaborationMode);

      setAgent(a);
      setName(a.name);
      setDescription(a.description);
      setSystemPrompt(nextSystemPrompt);
      setIdentity(nextIdentity);
      setUserInfo(nextUserInfo);
      setUnifiedText(unified.text);
      setUnifiedSource(unified.source);
      setUnifiedEdited(false);
      setRawFilesEdited(false);
      setIcon(a.icon);
      setModelOverride(undefined);
      setModelSelectionMode(a.modelSelectionMode ?? AgentModelSelectionMode.Explicit);
      setWorkingDirectory(a.workingDirectory ?? '');
      setSkillIds(loadedSkillIds);
      setRestrictSkills(!isDefaultAgentId(agentId) && loadedSkillIds.length > 0);
      setSubagentCollaborationMode(nextCollaborationMode);
      setSubagentAllowAgentIds(a.subagentAllowAgentIds ?? []);
      initialValuesRef.current = {
        name: a.name,
        description: a.description,
        systemPrompt: nextSystemPrompt,
        identity: nextIdentity,
        userInfo: nextUserInfo,
        icon: a.icon,
        workingDirectory: a.workingDirectory ?? '',
        skillIds: loadedSkillIds,
        subagentCollaborationMode: nextCollaborationMode,
        subagentAllowAgentIds: a.subagentAllowAgentIds ?? [],
      };
    })();

    imService.loadConfig().then((cfg) => {
      if (cfg && !cancelled) {
        setImConfig(cfg);
        const bindings = cfg.settings?.platformAgentBindings || {};
        const bound = new Set<string>();
        for (const [key, boundAgentId] of Object.entries(bindings)) {
          if (boundAgentId === agentId) {
            bound.add(key);
          }
        }
        setBoundKeys(bound);
        setInitialBoundKeys(new Set(bound));
      }
    });

    return () => {
      cancelled = true;
      if (activePolishRequestIdRef.current) {
        void agentService.cancelGenerateDraft(activePolishRequestIdRef.current);
        activePolishRequestIdRef.current = null;
      }
      polishSnapshotRef.current = null;
    };
  }, [agentId]);

  useEffect(() => {
    if (!agentId) {
      openedAgentIdRef.current = null;
      return;
    }
    if (openedAgentIdRef.current === agentId) return;
    openedAgentIdRef.current = agentId;
    reportAgentSettingsAction('open', { isDirty: false });
  }, [agentId, reportAgentSettingsAction]);

  if (!agentId) return null;

  const openAgentMemorySettings = () => {
    onClose();
    window.dispatchEvent(
      new CustomEvent(AgentUiEvent.OpenMemorySettings, { detail: { agentId } }),
    );
  };

  const handleOpenMemorySettings = () => {
    const changedFields = getChangedFields();
    if (changedFields.length > 0) {
      setPendingOpenMemoryAfterDiscard(true);
      reportAgentSettingsAction('discard_confirm_open', { changedFields, isDirty: true });
      setShowUnsavedConfirm(true);
      return;
    }
    reportAgentSettingsAction('close', { isDirty: false });
    openAgentMemorySettings();
  };

  const handleClose = () => {
    const changedFields = getChangedFields();
    if (changedFields.length > 0) {
      setPendingOpenMemoryAfterDiscard(false);
      reportAgentSettingsAction('discard_confirm_open', { changedFields, isDirty: true });
      setShowUnsavedConfirm(true);
    } else {
      reportAgentSettingsAction('close', { isDirty: false });
      onClose();
    }
  };

  const handleConfirmDiscard = () => {
    reportAgentSettingsAction('discard_confirm_submit', {
      changedFields: getChangedFields(),
      isDirty: true,
    });
    const shouldOpenMemory = pendingOpenMemoryAfterDiscard;
    setPendingOpenMemoryAfterDiscard(false);
    setShowUnsavedConfirm(false);
    if (shouldOpenMemory) {
      openAgentMemorySettings();
    } else {
      onClose();
    }
  };

  const handleCancelDiscard = () => {
    reportAgentSettingsAction('discard_confirm_cancel', {
      changedFields: getChangedFields(),
      isDirty: true,
    });
    setPendingOpenMemoryAfterDiscard(false);
    setShowUnsavedConfirm(false);
  };

  const handleUnifiedTextChange = (nextText: string) => {
    setUnifiedText(nextText);
    setUnifiedEdited(true);
    setRawFilesEdited(false);
    if (polishError) setPolishError(null);
    if (undoRulesSnapshot) setUndoRulesSnapshot(null);
  };

  const handleUndoRules = () => {
    if (!undoRulesSnapshot || polishing) return;
    setUnifiedText(undoRulesSnapshot.text);
    setUnifiedEdited(undoRulesSnapshot.edited);
    setRawFilesEdited(undoRulesSnapshot.rawEdited);
    if (undoRulesSnapshot.previousDescription !== undefined) {
      setDescription(undoRulesSnapshot.previousDescription);
    }
    setUndoRulesSnapshot(null);
    setPolishError(null);
  };

  const cancelActivePolish = () => {
    polishSeqRef.current += 1;
    const activeId = activePolishRequestIdRef.current;
    activePolishRequestIdRef.current = null;
    if (activeId) {
      void agentService.cancelGenerateDraft(activeId);
    }
    const snapshot = polishSnapshotRef.current;
    polishSnapshotRef.current = null;
    setPolishing(false);
    setPolishStreaming(false);
    setActivePolishDirective(null);
    if (snapshot) {
      setUnifiedText(snapshot.text);
      setUnifiedEdited(snapshot.edited);
      setRawFilesEdited(snapshot.rawEdited);
      if (snapshot.shouldAutoFillDescription) {
        setDescription(snapshot.description);
      }
    }
  };

  const handleRawPersonaChange = (file: AgentPersonaFileTab, value: string) => {
    if (file === AgentPersonaFileTab.User) {
      setUserInfo(value);
      return;
    }
    const nextIdentity = file === AgentPersonaFileTab.Identity ? value : identity;
    const nextSystemPrompt = file === AgentPersonaFileTab.Soul ? value : systemPrompt;
    setIdentity(nextIdentity);
    setSystemPrompt(nextSystemPrompt);
    setRawFilesEdited(true);
    setUnifiedEdited(false);
    const derived = deriveUnifiedInstructions({
      identity: nextIdentity,
      systemPrompt: nextSystemPrompt,
    });
    setUnifiedText(derived.text);
    setUnifiedSource(derived.source);
  };

  const handleApplyRuleTemplate = (template: AgentRuleTemplateOption) => {
    if (polishing) return;
    const content = i18nService.t(template.contentKey);
    const autoFill = resolveDescriptionOnAutoFill(
      description,
      i18nService.t(template.descriptionKey),
    );
    const snapshot = {
      text: unifiedText,
      edited: unifiedEdited,
      rawEdited: rawFilesEdited,
      source: RulesUndoSource.Template,
      ...(autoFill.didFill ? { previousDescription: description } : {}),
    };
    setUnifiedText(content);
    setUnifiedEdited(true);
    setRawFilesEdited(false);
    if (autoFill.didFill) {
      setDescription(autoFill.nextDescription);
    }
    setPolishError(null);
    setUndoRulesSnapshot(snapshot);
    requestAnimationFrame(() => {
      rulesTextareaRef.current?.focus();
    });
  };

  const handleAiPolish = async (
    directive: AgentRulePolishDirective = AgentRulePolishDirective.Polish,
  ) => {
    if (polishing) {
      cancelActivePolish();
      return;
    }
    const reqSeq = ++polishSeqRef.current;
    const requestId = `agent-polish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const shouldAutoFillDescription = !description.trim();
    const snapshot = {
      text: unifiedText,
      edited: unifiedEdited,
      rawEdited: rawFilesEdited,
      description,
      shouldAutoFillDescription,
    };
    polishSnapshotRef.current = snapshot;
    activePolishRequestIdRef.current = requestId;
    setPolishing(true);
    setPolishStreaming(false);
    setActivePolishDirective(directive);
    setPolishError(null);
    setUndoRulesSnapshot(null);
    reportAgentSettingsAction('ai_polish', { isDirty: getChangedFields().length > 0 });

    const language = i18nService.getLanguage() === 'en'
      ? AgentDraftLanguage.En
      : AgentDraftLanguage.Zh;
    const displayName = isMainAgent && !nameTouched
      ? getAgentDisplayName({ id: agentId, name })
      : name;

    const result = await agentService.generateDraft(
      {
        requestId,
        mode: AgentDraftMode.Polish,
        name: displayName.trim() || undefined,
        goal: description.trim() || displayName.trim(),
        existingInstructions: snapshot.text.trim() || undefined,
        ...(directive !== AgentRulePolishDirective.Polish ? { polishDirective: directive } : {}),
        ...(shouldAutoFillDescription ? { includeDescription: true } : {}),
        workingDirectory: workingDirectory.trim() || undefined,
        language,
      },
      {
        onProgress: (preview) => {
          if (reqSeq !== polishSeqRef.current) return;
          if (shouldAutoFillDescription && preview.description !== undefined) {
            setPolishStreaming(true);
            setDescription(preview.description);
          }
          if (preview.instructions) {
            setPolishStreaming(true);
            setUnifiedText(preview.instructions);
            setUnifiedEdited(true);
            setRawFilesEdited(false);
            requestAnimationFrame(() => {
              const el = rulesTextareaRef.current;
              if (el) {
                el.scrollTop = el.scrollHeight;
              }
            });
          }
        },
      },
    );

    if (reqSeq !== polishSeqRef.current) return;
    activePolishRequestIdRef.current = null;
    polishSnapshotRef.current = null;
    setPolishing(false);
    setPolishStreaming(false);
    setActivePolishDirective(null);

    if (!result.success) {
      setUnifiedText(snapshot.text);
      setUnifiedEdited(snapshot.edited);
      setRawFilesEdited(snapshot.rawEdited);
      if (snapshot.shouldAutoFillDescription) {
        setDescription(snapshot.description);
      }
      if (result.errorCode !== AgentDraftErrorCode.Cancelled) {
        setPolishError(formatAgentDraftError(result.errorCode));
      }
      return;
    }

    setUnifiedText(result.draft.instructions);
    setUnifiedEdited(true);
    setRawFilesEdited(false);
    const autoFill = snapshot.shouldAutoFillDescription
      ? resolveDescriptionOnAutoFill(snapshot.description, result.draft.description)
      : { nextDescription: description, didFill: false };
    if (autoFill.didFill) {
      setDescription(autoFill.nextDescription);
    } else if (snapshot.shouldAutoFillDescription) {
      setDescription(snapshot.description);
    }
    if (snapshot.text.trim() !== result.draft.instructions.trim() || autoFill.didFill) {
      setUndoRulesSnapshot({
        text: snapshot.text,
        edited: snapshot.edited,
        rawEdited: snapshot.rawEdited,
        source: RulesUndoSource.Ai,
        ...(autoFill.didFill ? { previousDescription: snapshot.description } : {}),
      });
    }
    if (result.draft.starterPrompts.length > 0) {
      setPendingStarterPrompts(result.draft.starterPrompts);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    const changedFields = getChangedFields();
    reportAgentSettingsAction('save_submit', {
      changedFields,
      includeConfigDetails: true,
      isDirty: changedFields.length > 0,
    });
    setSaving(true);
    try {
      const modelRef = model ? toOpenClawModelRef(model) : '';
      const finalIdentity = resolvedPersona.identity;
      const finalSystemPrompt = resolvedPersona.systemPrompt;

      const resolvedCollaboration = resolveCollaborationPayloadOnSave({
        mode: subagentCollaborationMode,
        allowAgentIds: subagentAllowAgentIds,
        initialAllowAgentIds: initialValuesRef.current.subagentAllowAgentIds,
      });

      const result = await agentService.updateAgent(agentId, {
        name: name.trim(),
        description: description.trim(),
        systemPrompt: finalSystemPrompt.trim(),
        identity: finalIdentity.trim(),
        ...(!isMainAgent && agent?.source === AgentSource.Preset
          && (changedFields.includes('modelSelectionMode') || modelOverride !== undefined)
          ? { modelSelectionMode }
          : {}),
        ...(modelOverride !== undefined ? { model: modelRef } : {}),
        ...(modelOverride !== undefined && modelRef !== storedModelRef
          ? { thinkingLevel: resolveThinkingLevelForModel(model) }
          : {}),
        workingDirectory: workingDirectory.trim(),
        ...(icon.trim() !== initialValuesRef.current.icon ? { icon: icon.trim() } : {}),
        skillIds: effectiveSkillIds,
        subagentCollaborationMode: resolvedCollaboration.subagentCollaborationMode,
        subagentAllowAgentIds: resolvedCollaboration.subagentAllowAgentIds,
      });
      if (!result) {
        reportAgentSettingsAction('save_failed', {
          changedFields,
          includeConfigDetails: true,
          isDirty: changedFields.length > 0,
          result: 'failed',
        });
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
        return;
      }

      const bootstrapSaved = await Promise.all([
        coworkService.writeBootstrapFile('IDENTITY.md', finalIdentity, { agentId }),
        coworkService.writeBootstrapFile('SOUL.md', finalSystemPrompt, { agentId }),
        coworkService.writeBootstrapFile('USER.md', userInfo, { agentId }),
      ]);
      if (bootstrapSaved.some(saved => !saved)) {
        reportAgentSettingsAction('save_failed', {
          changedFields,
          includeConfigDetails: true,
          isDirty: changedFields.length > 0,
          result: 'failed',
        });
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
        return;
      }

      if (changedFields.includes('identity')) {
        const cleanupResult = await agentService.cleanupLegacyIdentityBlock(agentId);
        if (cleanupResult.status === AgentLegacyIdentityCleanupStatus.Failed) {
          console.warn('[AgentSettingsPanel] failed to clean legacy AGENTS.md identity block:', cleanupResult.error);
        }
      }

      if (pendingStarterPrompts && pendingStarterPrompts.length > 0) {
        saveAgentOnboardingMeta(agentId, { starterPrompts: pendingStarterPrompts });
      }

      const bindingsChanged =
        boundKeys.size !== initialBoundKeys.size
        || [...boundKeys].some(k => !initialBoundKeys.has(k));
      if (bindingsChanged && imConfig) {
        const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
        for (const key of Object.keys(currentBindings)) {
          if (currentBindings[key] === agentId) {
            delete currentBindings[key];
          }
        }
        if (isMainAgent) {
          for (const key of boundKeys) {
            delete currentBindings[key];
          }
        } else {
          for (const key of boundKeys) {
            currentBindings[key] = agentId;
          }
        }
        await imService.persistConfig({
          settings: { ...imConfig.settings, platformAgentBindings: currentBindings },
        });
        await imService.saveAndSyncConfig();
      }

      reportAgentSettingsAction('save_success', {
        changedFields,
        includeConfigDetails: true,
        isDirty: false,
        result: 'success',
      });
      onClose();
    } catch {
      reportAgentSettingsAction('save_failed', {
        changedFields,
        includeConfigDetails: true,
        isDirty: changedFields.length > 0,
        result: 'failed',
      });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const success = await agentService.deleteAgent(agentId);
    if (success) {
      setShowDeleteConfirm(false);
      onClose();
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
    .filter(candidate => candidate.enabled && candidate.id !== agentId)
    .sort((left, right) => getAgentDisplayName(left).localeCompare(getAgentDisplayName(right)));

  const nameInputValue = isMainAgent && !nameTouched
    ? getAgentDisplayName({ id: agentId, name })
    : name;

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

  const rawFileValue = activePersonaFileTab === AgentPersonaFileTab.Identity
    ? resolvedPersona.identity
    : activePersonaFileTab === AgentPersonaFileTab.Soul
      ? resolvedPersona.systemPrompt
      : userInfo;

  const hasGlobalCapabilities = enabledSkills.length > 0 || enabledMcpServers.length > 0;
  const capabilitiesDescription = !isMainAgent && restrictSkills && skillIds.length > 0
    ? i18nService.t('agentSettingsSkillScopeCustomCount').replace('{count}', String(skillIds.length))
    : hasGlobalCapabilities
      ? globalCapabilitiesSubtitle
      : i18nService.t('agentSettingsSkillScopeMainHint');

  const memoryDescription = memoryCount === null
    ? i18nService.t('loading')
    : isMainAgent
      ? memoryCount > 0
        ? i18nService.t('agentSettingsMemoryMainCount').replace('{count}', String(memoryCount))
        : i18nService.t('agentSettingsMemoryMainEmpty')
      : memoryCount > 0
        ? i18nService.t('agentSettingsMemoryExpertCount').replace('{count}', String(memoryCount))
        : i18nService.t('agentSettingsMemoryExpertEmpty');

  const hasRules = unifiedText.trim().length > 0;

  return (
    <>
      <Modal
        onClose={handleClose}
        onEscape={showDeleteConfirm || showUnsavedConfirm || rulesMenuOpen ? undefined : handleClose}
        overlayClassName="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4"
        className="modal-content flex h-[min(84vh,700px)] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 pt-5 pb-4">
          <div className={AGENT_HEADER_IDENTITY_CLASS}>
            <AgentAvatarPicker
              value={icon}
              onChange={setIcon}
              expertFallback={usesManagedPresetAvatar(agent) && icon === agent?.icon}
            />
            <div className={AGENT_HEADER_FIELDS_CLASS}>
              <div className="flex max-w-full items-center gap-2">
                <input
                  type="text"
                  value={nameInputValue}
                  onChange={(e) => {
                    setNameTouched(true);
                    setName(e.target.value);
                  }}
                  placeholder={i18nService.t('agentNamePlaceholder')}
                  aria-label={i18nService.t('agentName')}
                  className={AGENT_NAME_INPUT_CLASS}
                />
                {!isMainAgent && agent?.source === AgentSource.Preset && (
                  <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[11px] font-normal text-secondary">
                    {i18nService.t('agentSettingsSourcePresetBadge')}
                  </span>
                )}
              </div>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                readOnly={polishing}
                placeholder={i18nService.t('agentSettingsDescriptionPlaceholder')}
                title={i18nService.t('agentDescriptionHint')}
                aria-label={i18nService.t('agentDescription')}
                className={AGENT_DESCRIPTION_INPUT_CLASS}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label={i18nService.t('close')}
            className="-mr-1 -mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
          {/* 1. Role & Rules */}
          <section className="space-y-2.5">
            <div className="px-0.5">
              <h3 className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('agentRulesTitle')}
              </h3>
              <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                {i18nService.t('agentRulesHint')}
              </p>
            </div>

            <div
              className={`overflow-hidden rounded-xl border bg-surface transition-colors ${
                polishing
                  ? 'border-foreground/25 ring-2 ring-foreground/[0.06]'
                  : 'border-border-input focus-within:border-foreground/25'
              }`}
            >
              <textarea
                ref={rulesTextareaRef}
                value={unifiedText}
                onChange={(e) => handleUnifiedTextChange(e.target.value)}
                readOnly={polishing}
                placeholder={i18nService.t('agentRulesPlaceholder')}
                aria-label={i18nService.t('agentRulesTitle')}
                rows={6}
                className={`block min-h-[168px] w-full resize-y bg-transparent px-3.5 pt-3 pb-2.5 ${SETTINGS_ITEM_TITLE_TEXT} leading-[1.65] text-foreground placeholder:text-secondary/45 focus:outline-none`}
              />
              <AgentRulesToolbar
                hasRules={hasRules}
                polishing={polishing}
                polishStreaming={polishStreaming}
                activePolishDirective={activePolishDirective}
                undoSource={undoRulesSnapshot?.source ?? null}
                undoRestoresPreviousText={Boolean(undoRulesSnapshot?.text.trim())}
                onApplyTemplate={handleApplyRuleTemplate}
                onAiPolish={(directive) => void handleAiPolish(directive)}
                onCancelPolish={cancelActivePolish}
                onUndo={handleUndoRules}
                onMenuOpenChange={setRulesMenuOpen}
              />
            </div>

            {polishError && (
              <p className="px-0.5 text-xs text-amber-600 dark:text-amber-400">
                {polishError}
              </p>
            )}
          </section>

          {/* 2. Core Configuration Group */}
          <section className="space-y-2">
            <h3 className="px-0.5 text-xs font-medium text-secondary">
              {i18nService.t('agentSettingsBasicsGroup')}
            </h3>
            <div className="divide-y divide-border rounded-xl border border-border bg-surface">
              {/* Working Folder */}
              <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                    {i18nService.t('agentSettingsFolderSection')}
                  </div>
                  <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                    {i18nService.t('agentSettingsFolderSectionHint')}
                  </p>
                </div>
                <div className="shrink-0">
                  <AgentWorkingDirectoryField
                    value={workingDirectory}
                    onChange={setWorkingDirectory}
                    compact
                    bordered
                    placement="bottom"
                  />
                </div>
              </div>

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
                      triggerMaxWidthClassName="max-w-[232px]"
                      alignDropdownToTriggerEnd
                      dropdownDirection="auto"
                      value={model}
                      onChange={(nextModel) => {
                        setModelOverride(nextModel);
                        setModelSelectionMode(AgentModelSelectionMode.Explicit);
                      }}
                      portal
                    />
                  </div>
                </div>
                {!isMainAgent && agent?.source === AgentSource.Preset && (
                  <label
                    className="mt-2.5 inline-flex cursor-pointer items-center gap-2 text-xs text-secondary transition-colors hover:text-foreground"
                    title={i18nService.t('expertInheritModelHint')}
                  >
                    <input
                      type="checkbox"
                      checked={modelSelectionMode === AgentModelSelectionMode.Inherit}
                      onChange={(event) => {
                        setModelSelectionMode(
                          event.target.checked ? AgentModelSelectionMode.Inherit : AgentModelSelectionMode.Explicit,
                        );
                        if (event.target.checked) {
                          setModelOverride(
                            resolveOpenClawModelRef(
                              captureExpertModelSelection(store.getState(), agentId).model,
                              availableModels,
                            ),
                          );
                        }
                      }}
                      className="h-3.5 w-3.5 rounded border-border accent-foreground"
                    />
                    <span>{i18nService.t('expertInheritModel')}</span>
                  </label>
                )}
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

                  {isMainAgent ? (
                    <span className="shrink-0 text-xs text-secondary">
                      {i18nService.t('agentSettingsSkillScopeAllShort')}
                    </span>
                  ) : (
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
                  )}
                </div>

                {!isMainAgent && restrictSkills && (
                  <div className="mt-3 h-[340px] rounded-lg border border-border bg-surface-raised/25 p-3">
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

              {/* Long-Term Memory */}
              <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                    {i18nService.t('agentSettingsMemorySection')}
                  </div>
                  <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                    {memoryDescription}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleOpenMemorySettings}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised active:scale-[0.98]"
                >
                  <span>{i18nService.t('agentSettingsMemoryManageButton')}</span>
                  <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-secondary" />
                </button>
              </div>
            </div>
          </section>

          {/* 3. Advanced Settings Group */}
          <section className="space-y-2">
            <h3 className="px-0.5 text-xs font-medium text-secondary">
              {i18nService.t('agentSettingsAdvancedDivider')}
            </h3>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
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
                      agentId={agentId}
                      isMainAgent={isMainAgent}
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

              {/* Raw Persona Markdown Files */}
              <div>
                <button
                  type="button"
                  aria-expanded={showPersonaFilesSection}
                  onClick={() => setShowPersonaFilesSection(prev => !prev)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised/50"
                >
                  <span className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                    {i18nService.t('agentSettingsPersonaFilesTitle')}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-secondary">
                    <span>{i18nService.t('agentSettingsPersonaFilesBadge')}</span>
                    {showPersonaFilesSection ? (
                      <ChevronDownIcon className="h-4 w-4 text-secondary/70" />
                    ) : (
                      <ChevronRightIcon className="h-4 w-4 text-secondary/70" />
                    )}
                  </span>
                </button>
                {showPersonaFilesSection && (
                  <div className="space-y-3 border-t border-border-subtle bg-surface-raised/20 px-4 py-3.5">
                    <p className="text-xs leading-5 text-secondary">
                      {i18nService.t('agentSettingsPersonaFilesHint')}
                    </p>
                    <div className="inline-flex rounded-lg bg-surface-raised p-0.5">
                      {[
                        AgentPersonaFileTab.Soul,
                        AgentPersonaFileTab.Identity,
                        AgentPersonaFileTab.User,
                      ].map(fileTab => (
                        <button
                          key={fileTab}
                          type="button"
                          onClick={() => setActivePersonaFileTab(fileTab)}
                          className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                            activePersonaFileTab === fileTab
                              ? 'bg-surface font-medium text-foreground shadow-subtle'
                              : 'text-secondary hover:text-foreground'
                          }`}
                        >
                          {fileTab}
                        </button>
                      ))}
                    </div>
                    <textarea
                      rows={6}
                      value={rawFileValue}
                      onChange={(e) => handleRawPersonaChange(activePersonaFileTab, e.target.value)}
                      placeholder={i18nService.t('coworkBootstrapPlaceholder')}
                      aria-label={activePersonaFileTab}
                      className="w-full resize-y rounded-lg border border-border-input bg-surface px-3 py-2 font-mono text-xs leading-5 text-foreground placeholder:text-secondary/45 focus:border-foreground/25 focus:outline-none"
                    />
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3.5">
          <div>
            {!isMainAgent && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                title={i18nService.t('agentSettingsDeleteDescription')}
                className={`-ml-2 inline-flex h-9 items-center gap-1.5 rounded-xl px-3 ${SETTINGS_ITEM_TITLE_TEXT} font-medium text-secondary transition-colors hover:bg-destructive/10 hover:text-destructive`}
              >
                <TrashIcon className="h-4 w-4" />
                <span>{i18nService.t('delete')}</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className={`h-9 rounded-xl border border-border bg-surface px-4 ${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground transition-colors hover:bg-surface-raised active:scale-[0.98]`}
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!name.trim() || saving}
              className={`h-9 rounded-xl bg-action px-5 ${SETTINGS_ITEM_TITLE_TEXT} font-medium text-action-foreground transition-colors hover:bg-action-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {saving ? i18nService.t('saving') : i18nService.t('save')}
            </button>
          </div>
        </div>
      </Modal>

      {showDeleteConfirm && (
        <AgentConfirmDialog
          variant={AgentConfirmDialogVariant.Delete}
          title={i18nService.t('agentDeleteConfirmTitle')}
          message={i18nService.t('agentDeleteConfirmMessage').replace('{name}', name)}
          cancelLabel={i18nService.t('cancel')}
          confirmLabel={i18nService.t('delete')}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={handleDelete}
        />
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

export default AgentSettingsPanel;
