import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  PauseCircleIcon,
  PlayCircleIcon,
} from '@heroicons/react/24/outline';
import { ArrowUpIcon, FolderIcon } from '@heroicons/react/24/solid';
import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { ProviderName } from '@shared/providers';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  type CoworkGoal,
  CoworkGoalStatus,
  formatCoworkGoalUsage,
} from '../../../shared/cowork/goal';
import {
  COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES,
  formatCoworkImageAttachmentLimit,
  validateCoworkImageAttachmentSize,
} from '../../../shared/cowork/imageAttachments';
import { isPlanImplementationApproval } from '../../../shared/cowork/planMode';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import { agentService } from '../../services/agent';
import { configService } from '../../services/config';
import { coworkService } from '../../services/cowork';
import { getPortalPricingUrl } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import { getInstalledKitSkillIds } from '../../services/kitCapability';
import {
  LogReporterAction,
  LogReporterEntry,
  reportYdAnalyzer,
} from '../../services/logReporter';
import { resolveLocalizedText, skillService } from '../../services/skill';
import { RootState } from '../../store';
import { selectDraftPrompts } from '../../store/selectors/coworkSelectors';
import {
  AsrQuotaStatus,
  ensureAsrQuotaFreshForDay,
  getLocalAsrQuotaDayKey,
  resetAsrQuota,
} from '../../store/slices/asrQuotaSlice';
import {
  addDraftAttachment,
  clearDraftAttachments,
  clearDraftSelectedTextSnippets,
  type DraftAttachment,
  PlanConfirmationState,
  removeDraftSelectedTextSnippet,
  setDraftAttachments,
  setDraftCollaborationMode,
  setDraftKitIds,
  setDraftPrompt,
  setDraftSelectedTextSnippets,
  setDraftSkillIds,
  setPlanConfirmationHandled,
  updateCurrentSessionModelOverride,
  updateSessionGoal,
} from '../../store/slices/coworkSlice';
import { setActiveKitIds, toggleActiveKit } from '../../store/slices/kitSlice';
import type { Model } from '../../store/slices/modelSlice';
import { setActiveSkillIds, setSkills, toggleActiveSkill } from '../../store/slices/skillSlice';
import { CoworkCollaborationMode, CoworkImageAttachment } from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import { Skill } from '../../types/skill';
import { getAgentDisplayName, shouldUseDefaultAgentIcon } from '../../utils/agentDisplay';
import { applyOptimisticGoalCommand } from '../../utils/goalCommand';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import { getCompactFolderName } from '../../utils/path';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import type { BrowserAnnotationPayload } from '../artifacts';
import {
  ACTIVE_CONTEXT_BADGE_BUTTON_CLASS,
  ACTIVE_CONTEXT_BADGE_ICON_CLASS,
  ACTIVE_CONTEXT_BADGE_ICON_WRAP_CLASS,
  ACTIVE_CONTEXT_BADGE_REMOVE_ICON_CLASS,
} from '../common/activeContextBadgeStyles';
import Modal from '../common/Modal';
import DefaultAgentIcon from '../icons/DefaultAgentIcon';
import GoalIcon from '../icons/GoalIcon';
import PaperClipIcon from '../icons/PaperClipIcon';
import PencilIcon from '../icons/PencilIcon';
import PlanModeIcon from '../icons/PlanModeIcon';
import PromptAddIcon from '../icons/PromptAddIcon';
import SkillIcon from '../icons/SkillIcon';
import TaskPauseIcon from '../icons/TaskPauseIcon';
import TrashIcon from '../icons/TrashIcon';
import XMarkIcon from '../icons/XMarkIcon';
import { ActiveKitBadge, KitsButton } from '../kits';
import ModelSelector, {
  ModelAccessPromptKind,
  ModelAccessPromptModal,
  type ModelSelectorChangeMeta,
  ModelSelectorGroup,
} from '../ModelSelector';
import { ActiveSkillBadge, SkillsPopover } from '../skills';
import { resolveAgentModelSelection, resolveEffectiveModel, useAgentSelectedModel } from './agentModelSelection';
import AttachmentCard from './AttachmentCard';
import { CoworkUiEvent } from './constants';
import FolderSelectorPopover from './FolderSelectorPopover';
import { getCaretPixelPosition } from './getCaretPosition';
import MediaMentionPicker from './MediaMentionPicker';
import {
  buildMediaMentionSegments,
  computeMediaLabels,
  extractMediaReferencesFromPrompt,
  type MediaLabel,
  MediaMentionSegmentKind,
  resolveMediaMentionTrigger,
} from './mediaMentionUtils';
import MediaModelPicker from './MediaModelPicker';
import {
  getAttachmentAnalyticsParams,
  getKitAnalyticsParams,
  getModelAnalyticsParams,
  getPromptAnalyticsConversationState,
  getPromptAnalyticsSurface,
  getPromptTextAnalyticsParams,
  getSkillAnalyticsParams,
  reportPromptControlAction,
  reportPromptSubmit,
} from './promptAnalytics';
import { buildSelectedKitContextPrompt } from './selectedKitContextPrompt';
import { buildSelectedSkillRoutingPrompt } from './selectedSkillRoutingPrompt';
import SelectedTextSnippetBadge from './SelectedTextSnippetBadge';
import { buildPlanModeSystemPrompt } from './skillSystemPrompt';
import { usePersistAgentModelSelection } from './usePersistAgentModelSelection';
import { useCoworkVoiceInput } from './voiceInput/useCoworkVoiceInput';
import VoiceInputButton from './voiceInput/VoiceInputButton';
import VoiceInputRecordingStatus from './voiceInput/VoiceInputRecordingStatus';
import { getCoworkVoiceRecordingUiState } from './voiceInput/voiceInputUiState';

const logPromptModelSelection = (
  level: 'debug' | 'warn',
  message: string,
): void => {
  if (level === 'warn') {
    console.warn(`[CoworkPromptInput] ${message}`);
  } else {
    console.debug(`[CoworkPromptInput] ${message}`);
  }
  window.electron?.log?.fromRenderer?.(level, 'CoworkPromptInput', message);
};

const summarizePromptShape = (prompt: string): string => {
  const lines = prompt.length > 0 ? prompt.split('\n') : [];
  const blankLines = lines.filter(line => line.trim().length === 0).length;
  const orderedListLines = lines.filter(line => /^\s*\d+\.\s+/.test(line)).length;
  return `chars=${prompt.length}, lines=${lines.length}, blankLines=${blankLines}, orderedListLines=${orderedListLines}`;
};

const getModelAnalyticsSource = (model: Model, selectorGroup: ModelSelectorChangeMeta['group']): string => {
  if (model.isServerModel || model.providerKey === ProviderName.LobsteraiServer || selectorGroup === ModelSelectorGroup.Server) {
    return 'package';
  }
  return 'custom';
};

const reportModelSelected = (
  model: Model,
  selectorGroup: ModelSelectorChangeMeta['group'],
  target: 'agent' | 'session',
  agentId: string,
  sessionId?: string,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.ModelSelected,
    modelId: model.id,
    modelName: model.name,
    modelSource: getModelAnalyticsSource(model, selectorGroup),
    providerKey: model.providerKey,
    provider: model.provider,
    selectorGroup,
    target,
    agentId,
    sessionId,
    isServerModel: model.isServerModel === true,
  });
};

// CoworkAttachment is aliased from the Redux-persisted DraftAttachment type
// so that attachment state survives view switches (cowork ↔ skills, etc.)
type CoworkAttachment = DraftAttachment;

const IMAGE_ATTACHMENT_PREVIEW_MAX_DIMENSION = 512;
const IMAGE_ATTACHMENT_PREVIEW_QUALITY = 0.78;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif']);

const isImagePath = (filePath: string): boolean => {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
};

const isImageMimeType = (mimeType: string): boolean => {
  return mimeType.startsWith('image/');
};

const extractBase64FromDataUrl = (dataUrl: string): { mimeType: string; base64Data: string } | null => {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const DEFAULT_FREE_ASR_LIMIT_SECONDS = 20 * 60;
const DEFAULT_SUBSCRIBED_ASR_LIMIT_SECONDS = 200 * 60;

const formatVoiceInputQuotaLimit = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds >= 3600 && safeSeconds % 3600 === 0) {
    return i18nService.t('voiceInputQuotaHours').replace('{count}', `${safeSeconds / 3600}`);
  }
  const minutes = Math.max(1, Math.ceil(safeSeconds / 60));
  return i18nService.t('voiceInputQuotaMinutes').replace('{count}', `${minutes}`);
};

const createImagePreviewDataUrl = async (dataUrl: string): Promise<string> => {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load image preview'));
    image.src = dataUrl;
  });

  const scale = Math.min(
    1,
    IMAGE_ATTACHMENT_PREVIEW_MAX_DIMENSION / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height, 1),
  );
  const width = Math.max(1, Math.round((img.naturalWidth || img.width || 1) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || img.height || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create image preview canvas');
  }
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', IMAGE_ATTACHMENT_PREVIEW_QUALITY);
};

const getFileNameFromPath = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

const SEND_SHORTCUT_OPTIONS = [
  { value: 'Enter', label: 'Enter', labelMac: 'Enter' },
  { value: 'Shift+Enter', label: 'Shift+Enter', labelMac: 'Shift+Enter' },
  { value: 'Ctrl+Enter', label: 'Ctrl+Enter', labelMac: 'Cmd+Enter' },
  { value: 'Alt+Enter', label: 'Alt+Enter', labelMac: 'Option+Enter' },
] as const;

const isMacPlatform = navigator.platform.includes('Mac');

const ContextLabelMaxLength = {
  Folder: 12,
  Agent: 12,
  DefaultFolder: 30,
} as const;

const READ_ONLY_CONTEXT_COMPACT_WIDTH = 168;
const LARGE_TOOLBAR_COMPACT_WIDTH = 520;
type GoalInputMode = 'start' | 'set';

const truncateDisplayText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) return trimmed;
  return `${characters.slice(0, maxLength).join('')}...`;
};

const getSendShortcutLabel = (value: string): string => {
  if (!value) return i18nService.t('shortcutNotSet');
  const option = SEND_SHORTCUT_OPTIONS.find(o => o.value === value);
  if (!option) return value;
  return isMacPlatform ? option.labelMac : option.label;
};

const getGoalStatusLabel = (goal: CoworkGoal): string => {
  switch (goal.status) {
    case CoworkGoalStatus.Active:
      return i18nService.t('coworkGoalStatusActive');
    case CoworkGoalStatus.Paused:
      return i18nService.t('coworkGoalStatusPaused');
    case CoworkGoalStatus.Blocked:
      return i18nService.t('coworkGoalStatusBlocked');
    case CoworkGoalStatus.UsageLimited:
      return i18nService.t('coworkGoalStatusUsageLimited');
    case CoworkGoalStatus.BudgetLimited:
      return i18nService.t('coworkGoalStatusBudgetLimited');
    case CoworkGoalStatus.Complete:
      return i18nService.t('coworkGoalStatusComplete');
  }
};

const getGoalSummary = (goal: CoworkGoal): string => {
  const usage = formatCoworkGoalUsage(goal);
  return [getGoalStatusLabel(goal), usage].filter(Boolean).join(' · ');
};

interface AgentSelectorOption {
  id: string;
  name?: string;
  icon?: string;
  enabled?: boolean;
}

const AgentContextAvatar: React.FC<{ agent: AgentSelectorOption; className?: string }> = ({ agent, className = 'h-4 w-4' }) => {
  if (shouldUseDefaultAgentIcon(agent)) {
    return <DefaultAgentIcon className={className} />;
  }

  return (
    <AgentAvatarIcon
      value={agent.icon}
      className={className}
      iconClassName={className}
      legacyClassName="text-[13px]"
      fallbackText={getAgentDisplayName(agent).trim().slice(0, 1).toUpperCase() || 'A'}
    />
  );
};

export interface CoworkPromptInputRef {
  /** 设置输入框值 */
  setValue: (value: string, inputSource?: 'template') => void;
  /** 设置图片附件（用于重新编辑消息时还原图片） */
  setImageAttachments: (images: CoworkImageAttachment[]) => void;
  /** 设置选中的 assistant 文本片段（用于重新编辑消息时还原上下文） */
  setSelectedTextSnippets: (snippets: CoworkSelectedTextSnippet[]) => void;
  /** 插入浏览器注释截图和注释文本 */
  insertBrowserAnnotation: (annotation: BrowserAnnotationPayload) => void;
  /** 聚焦输入框 */
  focus: () => void;
}

interface CoworkPromptInputProps {
  onSubmit: (
    prompt: string,
    skillPrompt?: string,
    imageAttachments?: CoworkImageAttachment[],
    mediaReferences?: MediaAttachmentRef[],
    selectedTextSnippets?: CoworkSelectedTextSnippet[],
    collaborationMode?: CoworkCollaborationMode,
  ) => boolean | void | Promise<boolean | void>;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  size?: 'normal' | 'large' | 'compact';
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  showModelSelector?: boolean;
  showAgentSelector?: boolean;
  showReadOnlyContext?: boolean;
  readOnlyContextTrailingText?: string;
  contextAgentId?: string;
  onManageSkills?: () => void;
  onManageKits?: () => void;
  sessionId?: string;
  contextUsageControl?: React.ReactNode;
  goal?: CoworkGoal | null;
  onGoalCommand?: (command: string) => boolean | void | Promise<boolean | void>;
  /** When true, hides attachment/skill buttons but keeps the input box visible (disabled) */
  remoteManaged?: boolean;
}

const EMPTY_ATTACHMENTS: CoworkAttachment[] = [];
const EMPTY_SELECTED_TEXT_SNIPPETS: CoworkSelectedTextSnippet[] = [];

const CoworkPromptInput = React.forwardRef<CoworkPromptInputRef, CoworkPromptInputProps>(
  (props, ref) => {
    const {
      onSubmit,
      onStop,
      isStreaming = false,
      placeholder = 'Enter your task...',
      disabled = false,
      size = 'normal',
      workingDirectory = '',
      onWorkingDirectoryChange,
      showFolderSelector = false,
      showModelSelector = false,
      showAgentSelector = false,
      showReadOnlyContext = false,
      readOnlyContextTrailingText,
      contextAgentId,
      onManageSkills,
      onManageKits,
      sessionId,
      contextUsageControl,
      goal,
      onGoalCommand,
      remoteManaged = false,
    } = props;
    const dispatch = useDispatch();
    const draftKey = sessionId || '__home__';
    const draftPrompt = useSelector((state: RootState) => selectDraftPrompts(state)[draftKey] || '');
    const attachments = useSelector((state: RootState) => state.cowork.draftAttachments[draftKey] || EMPTY_ATTACHMENTS) as CoworkAttachment[];
    const selectedTextSnippets = useSelector((state: RootState) => state.cowork.draftSelectedTextSnippets[draftKey] || EMPTY_SELECTED_TEXT_SNIPPETS);
    const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
    const agents = useSelector((state: RootState) => state.agent.agents);
    const coworkAgentEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);
    const availableModels = useSelector((state: RootState) => state.model.availableModels);
    const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
    const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
    const authQuota = useSelector((state: RootState) => state.auth.quota);
    const asrQuota = useSelector((state: RootState) => state.asrQuota);
    const [value, setValue] = useState(draftPrompt);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [isAddingFile, setIsAddingFile] = useState(false);
    const [imageVisionHint, setImageVisionHint] = useState(false);
    const [isPatchingModel, setIsPatchingModel] = useState(false);
    const [showAgentMenu, setShowAgentMenu] = useState(false);
    const [isReadOnlyContextCompact, setIsReadOnlyContextCompact] = useState(false);
    const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
    const [mentionFilter, setMentionFilter] = useState('');
    const [mentionCursorPos, setMentionCursorPos] = useState(0);
    const [mentionPickerPosition, setMentionPickerPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
    const [textareaScrollTop, setTextareaScrollTop] = useState(0);
    const [showAddMenu, setShowAddMenu] = useState(false);
    const [showSkillsPopover, setShowSkillsPopover] = useState(false);
    const [goalInputActive, setGoalInputActive] = useState(false);
    const [goalInputMode, setGoalInputMode] = useState<GoalInputMode>('start');
    const [goalEditModalOpen, setGoalEditModalOpen] = useState(false);
    const [goalEditDraft, setGoalEditDraft] = useState('');
    const [goalEditSaving, setGoalEditSaving] = useState(false);
    const [modelAccessPrompt, setModelAccessPrompt] = useState<ModelAccessPromptKind | null>(null);
    const [showVoiceLoginPrompt, setShowVoiceLoginPrompt] = useState(false);
    const [showVoiceQuotaPrompt, setShowVoiceQuotaPrompt] = useState(false);
    const [isLargeToolbarCompact, setIsLargeToolbarCompact] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const addMenuButtonRef = useRef<HTMLButtonElement>(null);
    const addMenuRef = useRef<HTMLDivElement>(null);
    const goalEditTextareaRef = useRef<HTMLTextAreaElement>(null);
    const skillMenuItemRef = useRef<HTMLButtonElement>(null);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const agentButtonRef = useRef<HTMLButtonElement>(null);
    const agentMenuRef = useRef<HTMLDivElement>(null);
    const readOnlyContextGroupRef = useRef<HTMLDivElement>(null);
    const largeToolbarRef = useRef<HTMLDivElement>(null);
    const dragDepthRef = useRef(0);
    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const modelPatchRequestIdRef = useRef(0);
    const skillSubmenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const goalInputBaselineRef = useRef<string | null>(null);
    const goalInputReturnDraftRef = useRef<string | null>(null);
    const draftStartedAnalyticsRef = useRef(false);
    const inputSourceOverrideRef = useRef<'template' | null>(null);

  // 暴露方法给父组件
  React.useImperativeHandle(ref, () => ({
    setValue: (newValue: string, inputSource?: 'template') => {
      setValue(newValue);
      if (inputSource) {
        inputSourceOverrideRef.current = inputSource;
      } else if (!newValue.trim()) {
        inputSourceOverrideRef.current = null;
      }
      // 触发自动调整高度
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = 'auto';
          textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
        }
      });
    },
    setImageAttachments: (images: CoworkImageAttachment[]) => {
      const newAttachments: CoworkAttachment[] = images.map((img, idx) => ({
        path: img.localPath ?? `inline:${img.name}:reedit-${Date.now()}-${idx}`,
        name: img.name,
        isImage: true,
        dataUrl: `data:${img.mimeType};base64,${img.base64Data}`,
      }));
      dispatch(setDraftAttachments({ draftKey, attachments: newAttachments }));
    },
    setSelectedTextSnippets: (snippets: CoworkSelectedTextSnippet[]) => {
      dispatch(setDraftSelectedTextSnippets({ draftKey, snippets }));
    },
    insertBrowserAnnotation: (annotation) => {
      const timestamp = Date.now();
      const imageName = `${i18nService.t('artifactBrowserAnnotationImageName')}-${timestamp}.png`;
      const annotationArea = [
        `shape=${annotation.annotation.shape}`,
        `color=${annotation.annotation.color}`,
        `x=${annotation.annotation.x}`,
        `y=${annotation.annotation.y}`,
        `width=${annotation.annotation.width}`,
        `height=${annotation.annotation.height}`,
      ].join(', ');
      const pageLabel = i18nService.t('artifactBrowserAnnotationPromptPage');
      const elementLabel = i18nService.t('artifactBrowserAnnotationPromptElement');
      const elementSummary = [
        annotation.element.tagName,
        annotation.element.text ? `"${annotation.element.text}"` : '',
        `${annotation.element.width}x${annotation.element.height}`,
      ].filter(Boolean).join(', ');
      const annotationPrompt = [
        i18nService.t('artifactBrowserAnnotationPromptTitle'),
        i18nService.t('artifactBrowserAnnotationPromptTarget'),
        '',
        `${i18nService.t('artifactBrowserAnnotationPromptScreenshot')}: ${annotation.screenshot.width} x ${annotation.screenshot.height}`,
        `${i18nService.t('artifactBrowserAnnotationPromptArea')}: ${annotationArea}`,
        annotation.pageTitle || annotation.pageUrl ? `${pageLabel}: ${[annotation.pageTitle, annotation.pageUrl].filter(Boolean).join(' - ')}` : '',
        elementSummary ? `${elementLabel}: ${elementSummary}` : '',
        '',
        `${i18nService.t('artifactBrowserAnnotationPromptComment')}:`,
        annotation.comment.trim(),
      ].filter(line => line !== '').join('\n');
      const nextValue = value.trim() ? `${value.trim()}\n\n${annotationPrompt}` : annotationPrompt;
      setValue(nextValue);
      dispatch(setDraftPrompt({ sessionId: draftKey, draft: nextValue }));
      dispatch(addDraftAttachment({
        draftKey,
        attachment: {
          path: `inline:${imageName}:${timestamp}`,
          name: imageName,
          isImage: true,
          dataUrl: annotation.imageDataUrl,
        },
      }));
      setImageVisionHint(!modelSupportsImage);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const hasActiveSkills = activeSkillIds.some(id => skills.some(skill => skill.id === id));
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const hasActiveKits = activeKitIds.length > 0;
  const draftKitIdsForKey = useSelector((state: RootState) => state.cowork.draftKitIds[draftKey]);
  const draftSkillIdsForKey = useSelector((state: RootState) => state.cowork.draftSkillIds[draftKey]);
  const draftCollaborationMode = useSelector(
    (state: RootState) => state.cowork.draftCollaborationModes[draftKey] || CoworkCollaborationMode.Default
  );
  const planConfirmation = useSelector(
    (state: RootState) => state.cowork.planConfirmations[draftKey]
  );
  const isPlanMode = draftCollaborationMode === CoworkCollaborationMode.Plan;
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const currentAgentSelectedModel = useAgentSelectedModel(currentAgentId, currentAgent?.model ?? '');
  const {
    isPersistingAgentModel,
    persistAgentModelSelection,
  } = usePersistAgentModelSelection({
    agentId: currentAgentId,
    syncDefaultModel: currentAgentId === 'main' || currentAgent?.isDefault === true,
  });
  const {
    selectedModel: agentSelectedModel,
    hasInvalidExplicitModel: agentModelIsInvalid,
  } = resolveAgentModelSelection({
    sessionModel: currentSession && currentSession.id === sessionId ? currentSession.modelOverride : '',
    agentModel: currentAgent?.model ?? '',
    availableModels,
    fallbackModel: currentAgentSelectedModel,
    engine: coworkAgentEngine,
  });

  const isCompact = size === 'compact';
  const isLarge = size === 'large' || isCompact;
  const useHomeContextLayout = isLarge && showAgentSelector;
  const useCompactSendButton = isLarge && (useHomeContextLayout || showReadOnlyContext || isCompact);
  const hasActiveContext = hasActiveSkills || hasActiveKits || isPlanMode || goalInputActive;
  const hasAttachments = attachments.length > 0;
  const minHeight = isCompact
    ? hasAttachments ? 30 : hasActiveContext ? 30 : 28
    : isLarge
      ? useHomeContextLayout
        ? hasAttachments ? 34 : hasActiveContext ? 36 : 52
        : hasAttachments ? 38 : hasActiveContext ? 44 : 60
      : 24;
  const maxHeight = isCompact ? 96 : 200;

  const effectiveSelectedModel = resolveEffectiveModel({
    sessionId,
    agentSelectedModel,
    globalSelectedModel: currentAgentSelectedModel,
  });
  const modelSupportsImage = !!effectiveSelectedModel?.supportsImage;

  const resolveSubmitModelAccessPrompt = useCallback((): ModelAccessPromptKind | null => {
    const hasAccessibleUserModel = availableModels.some(
      model => !model.isServerModel && model.accessible !== false
    );
    if (!isLoggedIn && !hasAccessibleUserModel) {
      return ModelAccessPromptKind.Login;
    }
    if (
      effectiveSelectedModel?.providerKey === ProviderName.LobsteraiServer
      && effectiveSelectedModel.accessible === false
    ) {
      return isLoggedIn ? ModelAccessPromptKind.Subscribe : ModelAccessPromptKind.Login;
    }
    return null;
  }, [
    availableModels,
    effectiveSelectedModel?.accessible,
    effectiveSelectedModel?.providerKey,
    isLoggedIn,
  ]);

  const {
    handleVoiceInput,
    stopVoiceRecordingAndRecognize,
    isVoiceRecording,
    isVoiceRecognizing,
    recordingElapsedSeconds,
  } = useCoworkVoiceInput({
    draftKey,
    value,
    setValue,
    textareaRef,
    minHeight,
    maxHeight,
    isLoggedIn,
    disabled,
    onQuotaExhausted: () => setShowVoiceQuotaPrompt(true),
  });

  const isAsrSubscribed = authQuota?.subscriptionStatus === AuthSubscriptionStatus.Active;
  const isAsrQuotaExhaustedToday = asrQuota.status === AsrQuotaStatus.Exhausted
    && asrQuota.dayKey === getLocalAsrQuotaDayKey();
  const voiceInputLocksEditing = isVoiceRecording || isVoiceRecognizing;
  const promptAnalyticsSurface = getPromptAnalyticsSurface(sessionId);
  const promptAnalyticsConversationState = getPromptAnalyticsConversationState(sessionId);

  const getPromptContextAnalyticsParams = useCallback(() => {
    const matchedSession = currentSession?.id === sessionId ? currentSession : null;
    return {
      surface: promptAnalyticsSurface,
      conversationState: promptAnalyticsConversationState,
      agentId: currentAgentId,
      isMainAgent: currentAgentId === 'main',
      agentSource: currentAgent?.source,
      agentSkillCount: currentAgent?.skillIds.length ?? 0,
      hasWorkingDirectory: workingDirectory.trim().length > 0,
      isPlanMode,
      sessionMessageCount: matchedSession?.totalMessages,
      sessionCreatedAt: matchedSession?.createdAt,
    };
  }, [
    currentAgent?.skillIds.length,
    currentAgent?.source,
    currentAgentId,
    currentSession,
    isPlanMode,
    promptAnalyticsConversationState,
    promptAnalyticsSurface,
    sessionId,
    workingDirectory,
  ]);

  const getPromptCapabilityAnalyticsParams = useCallback(() => ({
    ...getSkillAnalyticsParams(activeSkillIds, skills),
    ...getKitAnalyticsParams(activeKitIds, marketplaceKits, installedKits),
    ...getAttachmentAnalyticsParams(attachments),
    ...getModelAnalyticsParams(effectiveSelectedModel),
    selectedTextSnippetCount: selectedTextSnippets.length,
  }), [
    activeKitIds,
    activeSkillIds,
    attachments,
    effectiveSelectedModel,
    installedKits,
    marketplaceKits,
    selectedTextSnippets.length,
    skills,
  ]);

  const reportPromptControl = useCallback((
    controlType: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => {
    console.debug(`[CoworkPromptInput] reporting prompt control analytics: ${controlType}`);
    reportPromptControlAction({
      controlType,
      surface: promptAnalyticsSurface,
      conversationState: promptAnalyticsConversationState,
      params: {
        agentId: currentAgentId,
        isMainAgent: currentAgentId === 'main',
        hasWorkingDirectory: workingDirectory.trim().length > 0,
        isPlanMode,
        ...params,
      },
    });
  }, [
    currentAgentId,
    isPlanMode,
    promptAnalyticsConversationState,
    promptAnalyticsSurface,
    workingDirectory,
  ]);

  const getPromptInputSource = useCallback((
    submitMethod: 'button' | 'keyboard' | 'voice',
    mediaReferenceCount = 0,
  ): string => {
    if (submitMethod === 'voice') return 'voice';
    if (inputSourceOverrideRef.current) return inputSourceOverrideRef.current;
    if (selectedTextSnippets.length > 0) return 'selected_text';
    if (mediaReferenceCount > 0) return 'media_reference';
    return sessionId ? 'history_continue' : 'typed';
  }, [selectedTextSnippets.length, sessionId]);

  const ensureFreshAsrQuota = useCallback(() => {
    dispatch(ensureAsrQuotaFreshForDay(getLocalAsrQuotaDayKey()));
  }, [dispatch]);

  useEffect(() => {
    if (!isLoggedIn) {
      dispatch(resetAsrQuota());
      return;
    }
    ensureFreshAsrQuota();
  }, [dispatch, ensureFreshAsrQuota, isLoggedIn]);

  const handleVoiceInputClick = useCallback(() => {
    if (isVoiceRecording) {
      reportPromptControl('voice_record_stop', {
        recordingElapsedSeconds,
      });
      void handleVoiceInput();
      return;
    }
    if (disabled) {
      reportPromptControl('voice_record_blocked', {
        blockedReason: 'disabled',
      });
      return;
    }
    if (!isLoggedIn) {
      reportPromptControl('voice_record_blocked', {
        blockedReason: 'login_required',
      });
      setShowVoiceLoginPrompt(true);
      return;
    }
    const todayKey = getLocalAsrQuotaDayKey();
    if (asrQuota.dayKey && asrQuota.dayKey !== todayKey) {
      dispatch(ensureAsrQuotaFreshForDay(todayKey));
    } else if (asrQuota.status === AsrQuotaStatus.Exhausted && asrQuota.dayKey === todayKey) {
      reportPromptControl('voice_record_blocked', {
        blockedReason: 'quota_exhausted',
        asrQuotaStatus: asrQuota.status,
      });
      setShowVoiceQuotaPrompt(true);
      return;
    }
    reportPromptControl('voice_record_start', {
      asrQuotaStatus: asrQuota.status,
      isAsrSubscribed,
    });
    void handleVoiceInput();
  }, [
    asrQuota.dayKey,
    asrQuota.status,
    disabled,
    dispatch,
    handleVoiceInput,
    isAsrSubscribed,
    isLoggedIn,
    isVoiceRecording,
    recordingElapsedSeconds,
    reportPromptControl,
  ]);

  // Load skills on mount
  useEffect(() => {
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    };
    loadSkills();
  }, [dispatch]);

  useEffect(() => {
    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    });
    return () => {
      unsubscribe();
    };
  }, [dispatch]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
    }
  }, [value, minHeight, maxHeight]);

  useEffect(() => {
    const handleFocusInput = (event: Event) => {
      const detail = (event as CustomEvent<{ clear?: boolean; resetCollaborationMode?: boolean; text?: string }>).detail;
      const shouldClear = detail?.clear ?? true;
      if (detail?.resetCollaborationMode) {
        dispatch(setDraftCollaborationMode({ draftKey, mode: CoworkCollaborationMode.Default }));
      }
      if (detail?.text !== undefined) {
        setValue(detail.text);
        dispatch(clearDraftAttachments(draftKey));
        dispatch(clearDraftSelectedTextSnippets(draftKey));
        setImageVisionHint(false);
      } else if (shouldClear) {
        setValue('');
        dispatch(clearDraftAttachments(draftKey));
        dispatch(clearDraftSelectedTextSnippets(draftKey));
        dispatch(setDraftKitIds({ draftKey, kitIds: [] }));
        dispatch(setActiveKitIds([]));
        setImageVisionHint(false);
      }
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    };
    window.addEventListener(CoworkUiEvent.FocusInput, handleFocusInput);
    return () => {
      window.removeEventListener(CoworkUiEvent.FocusInput, handleFocusInput);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      if (skillSubmenuCloseTimerRef.current) clearTimeout(skillSubmenuCloseTimerRef.current);
    };
  }, [dispatch, draftKey]);

  useEffect(() => {
    if (workingDirectory?.trim()) {
      setShowFolderRequiredWarning(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    if (!isLarge || !showReadOnlyContext || useHomeContextLayout) {
      setIsReadOnlyContextCompact(false);
      return;
    }

    const element = readOnlyContextGroupRef.current;
    if (!element) return;

    const updateCompactState = () => {
      setIsReadOnlyContextCompact(element.getBoundingClientRect().width < READ_ONLY_CONTEXT_COMPACT_WIDTH);
    };

    updateCompactState();
    if (typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(updateCompactState);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [isLarge, showReadOnlyContext, useHomeContextLayout]);

  useEffect(() => {
    if (!isLarge || useHomeContextLayout) {
      setIsLargeToolbarCompact(false);
      return;
    }

    const element = largeToolbarRef.current;
    if (!element) return;

    const updateCompactState = () => {
      const nextCompact = element.getBoundingClientRect().width < LARGE_TOOLBAR_COMPACT_WIDTH;
      setIsLargeToolbarCompact(current => (current === nextCompact ? current : nextCompact));
    };

    updateCompactState();
    if (typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(updateCompactState);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [isLarge, useHomeContextLayout]);

  useEffect(() => {
    if (!showAgentMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!agentButtonRef.current?.contains(target) && !agentMenuRef.current?.contains(target)) {
        setShowAgentMenu(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowAgentMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [showAgentMenu]);

  useEffect(() => {
    if (!showAddMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!addMenuButtonRef.current?.contains(target) && !addMenuRef.current?.contains(target)) {
        setShowAddMenu(false);
        setShowSkillsPopover(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowAddMenu(false);
        setShowSkillsPopover(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [showAddMenu]);

  useEffect(() => {
    if (!showAddMenu) {
      setShowSkillsPopover(false);
      if (skillSubmenuCloseTimerRef.current) {
        clearTimeout(skillSubmenuCloseTimerRef.current);
        skillSubmenuCloseTimerRef.current = null;
      }
    }
  }, [showAddMenu]);

  useEffect(() => {
    modelPatchRequestIdRef.current += 1;
    setIsPatchingModel(false);
    draftStartedAnalyticsRef.current = false;
  }, [sessionId]);

  // Sync value from draft when sessionId changes
  useEffect(() => {
    setValue(draftPrompt);
    // Re-derive imageVisionHint from the new session's draft attachments
    const hasImageWithoutVision = !modelSupportsImage && attachments.some(a => a.isImage || isImagePath(a.path));
    setImageVisionHint(hasImageWithoutVision);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]); // intentionally omit other deps to only trigger on session switch

  useEffect(() => {
    if (value !== draftPrompt) {
      const timer = setTimeout(() => {
        dispatch(setDraftPrompt({ sessionId: draftKey, draft: value }));
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [value, draftPrompt, dispatch, draftKey]);

  useEffect(() => {
    if (!value) {
      setTextareaScrollTop(0);
    }
  }, [value]);

  // Restore active kit/skill IDs from draft when draftKey changes
  useEffect(() => {
    dispatch(setActiveKitIds(draftKitIdsForKey || []));
    dispatch(setActiveSkillIds(draftSkillIdsForKey || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]); // intentionally only trigger on session/draft switch

  // Persist active kit IDs to draft store
  useEffect(() => {
    dispatch(setDraftKitIds({ draftKey, kitIds: activeKitIds }));
  }, [activeKitIds, draftKey, dispatch]);

  // Persist active skill IDs to draft store
  useEffect(() => {
    dispatch(setDraftSkillIds({ draftKey, skillIds: activeSkillIds }));
  }, [activeSkillIds, draftKey, dispatch]);

  const mediaLabels = useMemo(() => computeMediaLabels(attachments), [attachments]);
  const mediaMentionSegments = useMemo(
    () => buildMediaMentionSegments(value, mediaLabels),
    [mediaLabels, value]
  );
  const hasMediaMentionHighlight = mediaMentionSegments.some(
    segment => segment.kind === MediaMentionSegmentKind.Mention
  );

  const handleMentionSelect = useCallback((item: MediaLabel) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = value.slice(0, mentionCursorPos);
    const after = value.slice(textarea.selectionStart);
    // Remove the partial @filter text that the user typed
    const atIdx = before.lastIndexOf('@');
    const token = `@${item.label} `;
    const newValue = before.slice(0, atIdx) + token + after;
    const nextCursorPos = before.slice(0, atIdx).length + token.length;
    setValue(newValue);
    setMentionPickerOpen(false);
    setMentionFilter('');
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursorPos, nextCursorPos);
      setMentionCursorPos(nextCursorPos);
    });
  }, [value, mentionCursorPos]);

  const handleTextareaScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    setTextareaScrollTop(e.currentTarget.scrollTop);
  }, []);

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    if (!newValue.trim()) {
      inputSourceOverrideRef.current = null;
    }
    if (!draftStartedAnalyticsRef.current && newValue.trim().length > 0) {
      draftStartedAnalyticsRef.current = true;
      reportPromptControl('draft_started', {
        promptLength: newValue.trim().length,
        ...getPromptTextAnalyticsParams(newValue),
      });
    }

    // Detect @ mention trigger
    const cursorPos = e.target.selectionStart;
    const mentionTrigger = mediaLabels.length > 0
      ? resolveMediaMentionTrigger(newValue, cursorPos)
      : null;
    if (mentionTrigger) {
      setMentionPickerOpen(true);
      setMentionFilter(mentionTrigger.filter);
      setMentionCursorPos(mentionTrigger.cursorPos);
      const caretPos = getCaretPixelPosition(e.target, mentionTrigger.atIndex);
      setMentionPickerPosition({ top: caretPos.top, left: caretPos.left });
      return;
    }
    setMentionPickerOpen(false);
  }, [mediaLabels, reportPromptControl]);

  const handleTextareaFocus = useCallback(() => {
    reportPromptControl('input_focus', {
      hasPrompt: value.trim().length > 0,
      attachmentCount: attachments.length,
    });
  }, [attachments.length, reportPromptControl, value]);

  const resetGoalInput = useCallback((restoreDraft: boolean) => {
    const restoredDraft = restoreDraft ? goalInputReturnDraftRef.current : null;
    goalInputBaselineRef.current = null;
    goalInputReturnDraftRef.current = null;
    setGoalInputActive(false);
    setGoalInputMode('start');
    if (restoreDraft) {
      const nextDraft = restoredDraft ?? '';
      setValue(nextDraft);
      dispatch(setDraftPrompt({ sessionId: draftKey, draft: nextDraft }));
    }
  }, [dispatch, draftKey]);

  const handleSubmit = useCallback(async (submitMethod: 'button' | 'keyboard' | 'voice' = 'button') => {
    let effectiveSubmitMethod = submitMethod;
    if (showFolderSelector && !workingDirectory?.trim()) {
      reportPromptControl('submit_blocked', {
        blockedReason: 'working_directory_required',
        submitMethod: effectiveSubmitMethod,
        ...getPromptTextAnalyticsParams(value),
        ...getPromptCapabilityAnalyticsParams(),
      });
      setShowFolderRequiredWarning(true);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      warningTimerRef.current = setTimeout(() => {
        setShowFolderRequiredWarning(false);
        warningTimerRef.current = null;
      }, 3000);
      return;
    }

    let submitValue = value;
    if (isVoiceRecording) {
      effectiveSubmitMethod = 'voice';
      const recognizedValue = await stopVoiceRecordingAndRecognize();
      if (recognizedValue === null) {
        reportPromptControl('submit_blocked', {
          blockedReason: 'voice_recognition_failed',
          submitMethod: effectiveSubmitMethod,
          ...getPromptCapabilityAnalyticsParams(),
        });
        return;
      }
      submitValue = recognizedValue;
    }

    const trimmedValue = submitValue.trim();
    if (goalInputActive && !trimmedValue) {
      reportPromptControl('submit_blocked', {
        blockedReason: 'empty_goal',
        submitMethod: effectiveSubmitMethod,
        ...getPromptCapabilityAnalyticsParams(),
      });
      return;
    }
    if (
      goalInputActive
      && goalInputMode === 'set'
      && goalInputBaselineRef.current !== null
      && trimmedValue === goalInputBaselineRef.current
    ) {
      console.debug('[CoworkGoal] goal edit submitted without changes; cancelling edit mode.');
      resetGoalInput(true);
      return;
    }
    const goalCommandCanRunWhileStreaming = goalInputActive && !!sessionId && !!onGoalCommand;
    if (isStreaming && !goalCommandCanRunWhileStreaming) {
      reportPromptControl('submit_blocked', {
        blockedReason: 'streaming',
        submitMethod: effectiveSubmitMethod,
        ...getPromptTextAnalyticsParams(trimmedValue),
        ...getPromptCapabilityAnalyticsParams(),
      });
      showToast(i18nService.t('coworkSessionStillRunning'));
      return;
    }
    if ((!trimmedValue && attachments.length === 0) || disabled || isPatchingModel) {
      reportPromptControl('submit_blocked', {
        blockedReason: !trimmedValue && attachments.length === 0
          ? 'empty'
          : disabled
            ? 'disabled'
            : 'model_patching',
        submitMethod: effectiveSubmitMethod,
        ...getPromptTextAnalyticsParams(trimmedValue),
        ...getPromptCapabilityAnalyticsParams(),
      });
      return;
    }
    setShowFolderRequiredWarning(false);

    const exitsPlanModeForImplementation = isPlanMode
      && isPlanImplementationApproval(trimmedValue);
    const awaitingPlanConfirmation = planConfirmation?.state === PlanConfirmationState.Awaiting
      ? planConfirmation
      : null;
    const effectivePlanMode = isPlanMode && !goalInputActive && !exitsPlanModeForImplementation;
    const effectiveCollaborationMode = effectivePlanMode
      ? CoworkCollaborationMode.Plan
      : CoworkCollaborationMode.Default;

    const accessPrompt = resolveSubmitModelAccessPrompt();
    if (accessPrompt) {
      reportPromptControl('submit_blocked', {
        blockedReason: 'model_access_required',
        accessPrompt,
        submitMethod: effectiveSubmitMethod,
        ...getPromptTextAnalyticsParams(trimmedValue),
        ...getPromptCapabilityAnalyticsParams(),
      });
      setModelAccessPrompt(accessPrompt);
      return;
    }

    if (goalInputActive && sessionId && onGoalCommand) {
      const goalCommand = `/goal ${goalInputMode} ${trimmedValue}`;
      console.debug(`[CoworkGoal] submitting goal command via goal IPC for session ${sessionId}.`);
      const accepted = await Promise.resolve(onGoalCommand(goalCommand)).then((result) => result !== false).catch((error) => {
        console.warn(`[CoworkGoal] failed to submit goal command for session ${sessionId}.`, error);
        return false;
      });
      if (!accepted) {
        reportPromptControl('submit_blocked', {
          blockedReason: 'goal_command_rejected',
          submitMethod: effectiveSubmitMethod,
          ...getPromptTextAnalyticsParams(trimmedValue),
          ...getPromptCapabilityAnalyticsParams(),
        });
        return;
      }
      resetGoalInput(false);
      setValue('');
      dispatch(setDraftPrompt({ sessionId: draftKey, draft: '' }));
      setShowAddMenu(false);
      reportPromptSubmit({
        ...getPromptContextAnalyticsParams(),
        submitMethod: effectiveSubmitMethod,
        promptLength: trimmedValue.length,
        promptLineCount: trimmedValue.length > 0 ? trimmedValue.split('\n').length : 0,
        hasPrompt: trimmedValue.length > 0,
        params: {
          ...getPromptCapabilityAnalyticsParams(),
          ...getPromptTextAnalyticsParams(trimmedValue),
          inputSource: getPromptInputSource(effectiveSubmitMethod, 0),
          mediaReferenceCount: 0,
          selectedTextSnippetCount: selectedTextSnippets.length,
          effectiveCollaborationMode,
        },
      });
      return;
    }

    // Get selected skill routing metadata, including skills from active kits.
    // OpenClaw loads SKILL.md files natively; do not inline full skill bodies here.
    const kitSkillIds = activeKitIds.flatMap(kitId => getInstalledKitSkillIds(installedKits[kitId]));
    const allSkillIds = [...new Set([...activeSkillIds, ...kitSkillIds])];
    const activeSkills = allSkillIds
      .map(id => skills.find(s => s.id === id))
      .filter((s): s is Skill => s !== undefined);
    const kitPrompt = buildSelectedKitContextPrompt(activeKitIds, marketplaceKits, installedKits);
    const skillPrompt = effectivePlanMode
      ? buildPlanModeSystemPrompt()
      : [
        kitPrompt,
        buildSelectedSkillRoutingPrompt(activeSkills),
      ].filter(Boolean).join('\n\n') || undefined;
    if (effectivePlanMode) {
      logPromptModelSelection(
        'debug',
        `submitting prompt in plan mode for draft ${draftKey}; selected skill routing suppressed`
      );
    } else if (exitsPlanModeForImplementation) {
      logPromptModelSelection(
        'debug',
        `exiting plan mode for approved implementation in draft ${draftKey}`,
      );
    }

    // Extract image attachments (with base64 data) for vision-capable models
    console.debug('[CoworkPromptInput] handleSubmit: attachment diagnosis', {
      totalAttachments: attachments.length,
      modelSupportsImage,
      effectiveModelId: effectiveSelectedModel?.id ?? null,
      ...getAttachmentAnalyticsParams(attachments),
      imageAttachmentDataUrlCount: attachments.filter(item => item.isImage && item.dataUrl).length,
    });
    const imageAtts: CoworkImageAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.isImage && attachment.dataUrl) {
        const extracted = extractBase64FromDataUrl(attachment.dataUrl);
        if (extracted) {
          const sizeValidation = validateCoworkImageAttachmentSize({
            base64Data: extracted.base64Data,
          });
          if (!sizeValidation.ok) {
            console.warn('[CoworkPromptInput] image attachment exceeded single-file limit:', {
              mimeType: extracted.mimeType,
              sizeBytes: sizeValidation.sizeBytes,
              maxBytes: sizeValidation.maxBytes,
              base64Length: extracted.base64Data.length,
            });
            showToast(
              i18nService.t('coworkImageAttachmentTooLarge')
                .replace('{name}', attachment.name)
                .replace('{limit}', formatCoworkImageAttachmentLimit(sizeValidation.maxBytes)),
            );
            reportPromptControl('submit_blocked', {
              blockedReason: 'image_attachment_too_large',
              submitMethod: effectiveSubmitMethod,
              ...getPromptTextAnalyticsParams(trimmedValue),
              attachmentCount: attachments.length,
              imageAttachmentCount: attachments.filter(item => item.isImage).length,
            });
            return;
          }

          let previewMimeType: string | undefined;
          let previewBase64Data: string | undefined;
          if (sizeValidation.sizeBytes > COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES) {
            try {
              const previewDataUrl = await createImagePreviewDataUrl(attachment.dataUrl);
              const preview = extractBase64FromDataUrl(previewDataUrl);
              if (preview) {
                previewMimeType = preview.mimeType;
                previewBase64Data = preview.base64Data;
              }
            } catch (error) {
              console.warn('[CoworkPromptInput] failed to create image preview:', error);
            }
            if (!previewBase64Data) {
              showToast(
                i18nService.t('coworkImageAttachmentPreviewFailed')
                  .replace('{name}', attachment.name),
              );
              reportPromptControl('submit_blocked', {
                blockedReason: 'image_preview_failed',
                submitMethod: effectiveSubmitMethod,
                ...getPromptTextAnalyticsParams(trimmedValue),
                attachmentCount: attachments.length,
                imageAttachmentCount: attachments.filter(item => item.isImage).length,
              });
              return;
            }
          }

          imageAtts.push({
            name: attachment.name,
            mimeType: extracted.mimeType,
            base64Data: extracted.base64Data,
            sizeBytes: sizeValidation.sizeBytes,
            ...(!attachment.path.startsWith('inline:') ? { localPath: attachment.path } : {}),
            ...(previewMimeType && previewBase64Data ? { previewMimeType, previewBase64Data } : {}),
          });
        } else {
          console.warn('[CoworkPromptInput] handleSubmit: extractBase64FromDataUrl returned null', {
            isImage: attachment.isImage,
            hasDataUrl: !!attachment.dataUrl,
            dataUrlLength: attachment.dataUrl.length,
          });
        }
      } else if (attachment.isImage) {
        console.warn('[CoworkPromptInput] handleSubmit: image attachment missing dataUrl', {
          isImage: attachment.isImage,
          hasDataUrl: !!attachment.dataUrl,
        });
      }
    }

    // Build prompt with ALL attachments that have real file paths (both regular files and images).
    // Image attachments also need their file paths in the prompt so the model knows
    // where the original files are located (e.g., for skills like seedream that need --image <path>).
    // Note: inline/clipboard images have pseudo-paths starting with 'inline:' and are excluded.
    // Note: image attachments that already carry base64 data are excluded — their content
    // is delivered via the attachments parameter of chat.send. Including the file path
    // would trigger OpenClaw's Native-image detection, which rejects paths outside allowed
    // directories and can drop the base64 image during sanitization (macOS-only bug).
    const attachmentLines = attachments
      .filter((a) => !a.path.startsWith('inline:') && !(a.isImage && a.dataUrl))
      .map((attachment) => `${i18nService.t('inputFileLabel')}: ${attachment.path}`)
      .join('\n');
    const goalCommandPrompt = goalInputActive ? `/goal ${goalInputMode} ${trimmedValue}` : trimmedValue;
    const finalPrompt = goalCommandPrompt
      ? (attachmentLines ? `${goalCommandPrompt}\n\n${attachmentLines}` : goalCommandPrompt)
      : attachmentLines;

    logPromptModelSelection(
      'debug',
      `submitting prompt summary: ${summarizePromptShape(finalPrompt)}, attachments=${attachments.length}, imageAttachments=${imageAtts.length}`
    );

    if (imageAtts.length > 0) {
      console.debug('[CoworkPromptInput] handleSubmit: passing imageAtts to onSubmit', {
        count: imageAtts.length,
        base64Lengths: imageAtts.map(a => a.base64Data.length),
      });
    } else if (attachments.some(a => a.isImage || isImagePath(a.path))) {
      console.warn('[CoworkPromptInput] handleSubmit: has image-like attachments but imageAtts is EMPTY — images will NOT be sent as base64', {
        imageAttachmentCount: attachments.filter(a => a.isImage || isImagePath(a.path)).length,
        imageAttachmentDataUrlCount: attachments.filter(a => (a.isImage || isImagePath(a.path)) && a.dataUrl).length,
      });
    }

    // Resolve @media tokens into MediaAttachmentRef array
    const mediaReferences = extractMediaReferencesFromPrompt(finalPrompt, mediaLabels);

    const result = await onSubmit(
      finalPrompt,
      skillPrompt,
      imageAtts.length > 0 ? imageAtts : undefined,
      mediaReferences.length > 0 ? mediaReferences : undefined,
      selectedTextSnippets.length > 0 ? selectedTextSnippets : undefined,
      effectiveCollaborationMode,
    );
    if (result === false) {
      reportPromptControl('submit_blocked', {
        blockedReason: 'submit_rejected',
        submitMethod: effectiveSubmitMethod,
        ...getPromptTextAnalyticsParams(trimmedValue),
        ...getPromptCapabilityAnalyticsParams(),
      });
      return;
    }
    if (goalInputActive && sessionId) {
      const optimisticGoal = applyOptimisticGoalCommand(finalPrompt, goal, sessionId);
      if (optimisticGoal !== undefined) {
        console.debug(`[CoworkGoal] applying optimistic goal after submit for session ${sessionId}.`);
        dispatch(updateSessionGoal({ sessionId, goal: optimisticGoal }));
      }
    }
    const promptLineCount = trimmedValue.length > 0 ? trimmedValue.split('\n').length : 0;
    reportPromptSubmit({
      ...getPromptContextAnalyticsParams(),
      submitMethod: effectiveSubmitMethod,
      promptLength: trimmedValue.length,
      promptLineCount,
      hasPrompt: trimmedValue.length > 0,
      params: {
        ...getPromptCapabilityAnalyticsParams(),
        ...getPromptTextAnalyticsParams(trimmedValue),
        inputSource: getPromptInputSource(effectiveSubmitMethod, mediaReferences.length),
        mediaReferenceCount: mediaReferences.length,
        selectedTextSnippetCount: selectedTextSnippets.length,
        effectiveCollaborationMode,
      },
    });
    if (awaitingPlanConfirmation) {
      dispatch(setPlanConfirmationHandled({
        sessionId: draftKey,
        messageId: awaitingPlanConfirmation.messageId,
      }));
      logPromptModelSelection(
        'debug',
        exitsPlanModeForImplementation
          ? `direct input confirmed proposed plan ${awaitingPlanConfirmation.messageId} for draft ${draftKey}`
          : `direct input adjusted proposed plan ${awaitingPlanConfirmation.messageId} for draft ${draftKey}`,
      );
    }
    if (exitsPlanModeForImplementation) {
      dispatch(setDraftCollaborationMode({ draftKey, mode: CoworkCollaborationMode.Default }));
    }
    setValue('');
    dispatch(setDraftPrompt({ sessionId: draftKey, draft: '' }));
    dispatch(clearDraftAttachments(draftKey));
    dispatch(clearDraftSelectedTextSnippets(draftKey));
    setImageVisionHint(false);
    resetGoalInput(false);
    draftStartedAnalyticsRef.current = false;
    inputSourceOverrideRef.current = null;
  }, [value, isVoiceRecording, stopVoiceRecordingAndRecognize, goalInputActive, goalInputMode, resetGoalInput, isStreaming, disabled, isPatchingModel, onSubmit, onGoalCommand, activeSkillIds, skills, activeKitIds, marketplaceKits, installedKits, attachments, showFolderSelector, workingDirectory, dispatch, draftKey, effectiveSelectedModel?.id, modelSupportsImage, mediaLabels, selectedTextSnippets, resolveSubmitModelAccessPrompt, isPlanMode, planConfirmation, reportPromptControl, getPromptCapabilityAnalyticsParams, getPromptContextAnalyticsParams, getPromptInputSource, goal, sessionId]);

  const handleSelectSkill = useCallback((skill: Skill) => {
    const willSelect = !activeSkillIds.includes(skill.id);
    reportPromptControl('skill_toggle', {
      skillId: skill.id,
      skillName: skill.name,
      skillSource: skill.isBuiltIn ? 'built_in' : skill.isOfficial ? 'official' : 'custom',
      targetEnabled: willSelect,
      activeSkillCount: activeSkillIds.length + (willSelect ? 1 : -1),
    });
    dispatch(toggleActiveSkill(skill.id));
  }, [activeSkillIds, dispatch, reportPromptControl]);

  const handleManageSkills = useCallback(() => {
    reportPromptControl('manage_skills_click', {
      activeSkillCount: activeSkillIds.length,
    });
    setShowAddMenu(false);
    setShowSkillsPopover(false);
    if (onManageSkills) {
      onManageSkills();
    }
  }, [activeSkillIds.length, onManageSkills, reportPromptControl]);

  const handleSelectKit = useCallback((kitId: string) => {
    const willSelect = !activeKitIds.includes(kitId);
    const marketplaceKit = marketplaceKits.find(kit => kit.id === kitId);
    const installedKit = installedKits[kitId];
    reportPromptControl('kit_toggle', {
      kitId,
      kitName: marketplaceKit ? resolveLocalizedText(marketplaceKit.name) : installedKit?.id ?? kitId,
      kitSource: marketplaceKit ? 'lobsterai-kits' : 'installed',
      targetEnabled: willSelect,
      isInstalled: !!installedKit,
      skillCount: installedKit?.skills?.skillIds.length ?? marketplaceKit?.skills?.list.length,
      mcpServerCount: installedKit?.mcpServers.length ?? marketplaceKit?.mcpServers?.length,
      connectorCount: installedKit?.connectors.length ?? marketplaceKit?.connectors?.length,
    });
    dispatch(toggleActiveKit(kitId));
    if (willSelect) {
      void reportYdAnalyzer({
        action: LogReporterAction.ExpertKitSelected,
        kitId,
        kitName: marketplaceKit ? resolveLocalizedText(marketplaceKit.name) : undefined,
        kitSource: marketplaceKit ? 'lobsterai-kits' : 'installed',
        isInstalled: !!installedKit,
        skillCount: installedKit?.skills?.skillIds.length ?? marketplaceKit?.skills?.list.length,
        mcpServerCount: installedKit?.mcpServers.length ?? marketplaceKit?.mcpServers?.length,
        connectorCount: installedKit?.connectors.length ?? marketplaceKit?.connectors?.length,
      });
    }
  }, [activeKitIds, dispatch, installedKits, marketplaceKits, reportPromptControl]);

  const handleManageKits = useCallback(() => {
    reportPromptControl('manage_kits_click', {
      activeKitCount: activeKitIds.length,
    });
    if (onManageKits) {
      onManageKits();
    }
  }, [activeKitIds.length, onManageKits, reportPromptControl]);

  const handleSelectAgent = useCallback((agentId: string) => {
    if (!agentId || agentId === currentAgentId) {
      setShowAgentMenu(false);
      return;
    }
    const nextAgent = agents.find(agent => agent.id === agentId);
    reportPromptControl('agent_selected', {
      targetAgentId: agentId,
      targetIsMainAgent: agentId === 'main',
      targetAgentSource: nextAgent?.source,
      targetAgentSkillCount: nextAgent?.skillIds.length ?? 0,
      hasAgentModel: Boolean(nextAgent?.model),
      agentModelId: nextAgent?.model,
    });
    agentService.switchAgent(agentId);
    setShowAgentMenu(false);
  }, [agents, currentAgentId, reportPromptControl]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;

    if (event.key === 'Backspace' && !isComposing) {
      const textarea = event.currentTarget;
      const cursorPos = textarea.selectionStart;
      if (cursorPos === textarea.selectionEnd && cursorPos > 0) {
        const textBefore = value.slice(0, cursorPos);
        const mentionMatch = textBefore.match(/@(图片|视频|音频)\d+ ?$/);
        if (mentionMatch) {
          event.preventDefault();
          const tokenStart = cursorPos - mentionMatch[0].length;
          const newValue = value.slice(0, tokenStart) + value.slice(cursorPos);
          setValue(newValue);
          requestAnimationFrame(() => {
            textarea.setSelectionRange(tokenStart, tokenStart);
          });
          return;
        }
      }
    }

    if (event.key !== 'Enter' || isComposing) return;

    // Use synced state (kept up-to-date via config-updated event) so that
    // changes made in the Settings panel are reflected immediately without
    // requiring a configService read at event time.
    const sendKey = currentSendShortcut;

    let isSendCombo = false;
    switch (sendKey) {
      case '':
        isSendCombo = false;
        break;
      case 'Enter':
        isSendCombo = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
        break;
      case 'Shift+Enter':
        isSendCombo = event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
        break;
      case 'Ctrl+Enter':
        isSendCombo = isMacPlatform
          ? event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
          : event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
        break;
      case 'Alt+Enter':
        isSendCombo = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
        break;
      default:
        // Unknown config value — fall back to bare Enter so the user can always send
        isSendCombo = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
        break;
    }

    const goalCommandCanRunWhileStreaming = goalInputActive && !!sessionId && !!onGoalCommand;
    if (isSendCombo && isStreaming && !goalCommandCanRunWhileStreaming) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkSessionStillRunning'),
      }));
    } else if (isSendCombo && !disabled && !isPatchingModel) {
      event.preventDefault();
      handleSubmit('keyboard');
    } else {
      // Any non-send Enter combo inserts a newline.
      // Shift+Enter inserts newline natively; for other combos use execCommand.
      if (!event.shiftKey) {
        event.preventDefault();
        document.execCommand('insertText', false, '\n');
      }
    }
  };

  const handleStopClick = () => {
    reportPromptControl('stop_streaming', {
      ...getPromptCapabilityAnalyticsParams(),
    });
    if (onStop) {
      onStop();
    }
  };

  const containerClass = isCompact
    ? 'relative rounded-2xl border border-border bg-surface shadow-subtle'
    : isLarge
    ? useHomeContextLayout
      ? 'relative rounded-2xl'
      : `relative rounded-2xl border border-border bg-surface ${showReadOnlyContext ? '' : 'shadow-card'}`
    : 'relative flex items-end gap-2 p-3 rounded-xl border border-border bg-surface';

  const textareaClass = isCompact
    ? `w-full resize-none bg-transparent px-4 pb-1.5 text-sm leading-[var(--lobster-leading-sm)] text-foreground placeholder:dark:text-foregroundSecondary/60 placeholder:text-secondary/60 focus:outline-none min-h-[${minHeight}px] max-h-[${maxHeight}px] ${hasActiveContext ? 'pt-1.5' : 'pt-2'}`
    : isLarge
    ? `w-full resize-none bg-transparent px-4 pb-2 text-foreground placeholder:dark:text-foregroundSecondary/60 placeholder:text-secondary/60 focus:outline-none min-h-[${minHeight}px] max-h-[${maxHeight}px] ${
      useHomeContextLayout
        ? `${hasActiveContext ? 'pt-2' : 'pt-3'} text-sm leading-[var(--lobster-leading-prompt)]`
        : `${hasActiveContext ? 'pt-2' : 'pt-2.5'} text-[length:var(--lobster-text-promptLarge)] leading-[var(--lobster-leading-promptLarge)]`
    }`
    : 'flex-1 resize-none bg-transparent text-foreground placeholder:placeholder:text-secondary focus:outline-none text-sm leading-relaxed min-h-[24px] max-h-[200px]';

  const truncatePath = (path: string, maxLength: number = ContextLabelMaxLength.DefaultFolder): string => {
    if (!path) return i18nService.t('noFolderSelected');
    const folderName = getCompactFolderName(path) || i18nService.t('noFolderSelected');
    return truncateDisplayText(folderName, maxLength);
  };

  const hasWorkingDirectory = workingDirectory.trim().length > 0;

  const handleFolderSelect = (path: string) => {
    reportPromptControl('working_directory_selected', {
      source: showReadOnlyContext ? 'conversation_context' : 'home_context',
      hasSelectedFolder: path.trim().length > 0,
    });
    if (onWorkingDirectoryChange) {
      onWorkingDirectoryChange(path);
    }
  };

  const handleOpenWorkingDirectory = useCallback(async () => {
    const path = workingDirectory.trim();
    if (!path) return;
    reportPromptControl('working_directory_open', {
      source: 'read_only_context',
    });

    try {
      const result = await window.electron.shell.openPath(path);
      if (!result?.success) {
        console.error('[CoworkPromptInput] failed to open folder:', result?.error);
      }
    } catch (error) {
      console.error('[CoworkPromptInput] failed to open folder:', error);
    }
  }, [reportPromptControl, workingDirectory]);

  const addAttachment = useCallback((filePath: string, imageInfo?: { isImage: boolean; dataUrl?: string }) => {
    if (!filePath) return;
    dispatch(addDraftAttachment({
      draftKey,
      attachment: {
        path: filePath,
        name: getFileNameFromPath(filePath),
        isImage: imageInfo?.isImage,
        dataUrl: imageInfo?.dataUrl,
      },
    }));
  }, [dispatch, draftKey]);

  const addImageAttachmentFromDataUrl = useCallback((name: string, dataUrl: string) => {
    // Use the dataUrl as the unique key (no file path for inline images)
    const pseudoPath = `inline:${name}:${Date.now()}`;
    dispatch(addDraftAttachment({
      draftKey,
      attachment: {
        path: pseudoPath,
        name,
        isImage: true,
        dataUrl,
      },
    }));
  }, [dispatch, draftKey]);

  const fileToDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const getNativeFilePath = useCallback((file: File): string | null => {
    const maybePath = (file as File & { path?: string }).path;
    if (typeof maybePath === 'string' && maybePath.trim()) {
      return maybePath;
    }
    return null;
  }, []);

  const saveInlineFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const dataBase64 = await fileToBase64(file);
      if (!dataBase64) {
        return null;
      }
      const result = await window.electron.dialog.saveInlineFile({
        dataBase64,
        fileName: file.name,
        mimeType: file.type,
        cwd: workingDirectory,
      });
      if (result.success && result.path) {
        return result.path;
      }
      return null;
    } catch (error) {
      console.error('Failed to save inline file:', error);
      return null;
    }
  }, [fileToBase64, workingDirectory]);

  const handleIncomingFiles = useCallback(async (fileList: FileList | File[], source: 'drop' | 'paste' | 'picker' | 'unknown' = 'unknown') => {
    if (disabled || isStreaming || voiceInputLocksEditing) {
      reportPromptControl('attachment_add_blocked', {
        source,
        blockedReason: disabled ? 'disabled' : isStreaming ? 'streaming' : 'voice_input_active',
      });
      return;
    }
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    let hasImageWithoutVision = false;
    const incomingAttachments = files.map(file => ({
      path: file.name,
      name: file.name,
      isImage: isImageMimeType(file.type) || isImagePath(file.name),
      size: file.size,
    }));
    for (const file of files) {
      const nativePath = getNativeFilePath(file);

      // Check if this is an image file and model supports images
      const fileIsImage = nativePath
        ? isImagePath(nativePath)
        : isImageMimeType(file.type);

      console.log('[CoworkPromptInput] handleIncomingFiles: processing file', {
        name: file.name,
        type: file.type,
        size: file.size,
        nativePath,
        fileIsImage,
        modelSupportsImage,
        effectiveModelId: effectiveSelectedModel?.id ?? null,
        effectiveModelSupportsImage: effectiveSelectedModel?.supportsImage ?? null,
      });

      if (fileIsImage) {
        if (modelSupportsImage) {
          // For images on vision-capable models, read as data URL
          if (nativePath) {
            try {
              const result = await window.electron.dialog.readFileAsDataUrl(nativePath);
              if (result.success && result.dataUrl) {
                console.log('[CoworkPromptInput] handleIncomingFiles: native image read OK', { nativePath, dataUrlLength: result.dataUrl.length });
                addAttachment(nativePath, { isImage: true, dataUrl: result.dataUrl });
                continue;
              }
              console.warn('[CoworkPromptInput] handleIncomingFiles: readFileAsDataUrl returned falsy', { nativePath, success: result.success });
            } catch (error) {
              console.error('Failed to read image as data URL:', error);
            }
            // Fallback: add as regular file attachment
            console.warn('[CoworkPromptInput] handleIncomingFiles: native image fallback to path-only (no dataUrl)', { nativePath });
            addAttachment(nativePath);
          } else {
            // No native path (clipboard/drag from browser):
            // 1. Read as dataUrl for preview + base64 vision
            // 2. Save to disk so the agent can access the file in later turns
            let dataUrl: string | null = null;
            try {
              dataUrl = await fileToDataUrl(file);
              console.log('[CoworkPromptInput] handleIncomingFiles: clipboard fileToDataUrl OK', { dataUrlLength: dataUrl?.length ?? 0 });
            } catch (error) {
              console.error('[CoworkPromptInput] handleIncomingFiles: clipboard fileToDataUrl FAILED:', error);
            }

            const stagedPath = await saveInlineFile(file);
            console.log('[CoworkPromptInput] handleIncomingFiles: clipboard saveInlineFile result', { stagedPath, hasDataUrl: !!dataUrl });

            if (stagedPath) {
              addAttachment(stagedPath, {
                isImage: true,
                dataUrl: dataUrl ?? undefined,
              });
            } else if (dataUrl) {
              console.warn('Clipboard image saved only in memory (disk save failed)');
              addImageAttachmentFromDataUrl(file.name, dataUrl);
            } else {
              console.error('Failed to process clipboard image: both dataUrl and disk save failed');
            }
          }
          continue;
        }
        // Model doesn't support image input — add as file path and show hint
        console.warn('[CoworkPromptInput] handleIncomingFiles: image skipped vision path because modelSupportsImage=false', {
          fileName: file.name,
          effectiveModelId: effectiveSelectedModel?.id ?? null,
          effectiveModelSupportsImage: effectiveSelectedModel?.supportsImage ?? null,
        });
        hasImageWithoutVision = true;
      }

      // Non-image file or model doesn't support images: use original flow
      if (nativePath) {
        addAttachment(nativePath);
        continue;
      }

      const stagedPath = await saveInlineFile(file);
      if (stagedPath) {
        addAttachment(stagedPath);
      }
    }
    if (hasImageWithoutVision) {
      setImageVisionHint(true);
    }
    reportPromptControl('attachment_add_success', {
      source,
      modelSupportsImage,
      hasImageWithoutVision,
      ...getAttachmentAnalyticsParams(incomingAttachments),
    });
  }, [addAttachment, addImageAttachmentFromDataUrl, disabled, effectiveSelectedModel, fileToDataUrl, getNativeFilePath, isStreaming, modelSupportsImage, reportPromptControl, saveInlineFile, voiceInputLocksEditing]);

  const handleAddFile = useCallback(async () => {
    if (isAddingFile || disabled || isStreaming || voiceInputLocksEditing) {
      reportPromptControl('attachment_add_blocked', {
        source: 'picker',
        blockedReason: isAddingFile ? 'adding_file' : disabled ? 'disabled' : isStreaming ? 'streaming' : 'voice_input_active',
      });
      return;
    }
    reportPromptControl('attach_file_click', {
      source: 'picker',
    });
    setShowAddMenu(false);
    setIsAddingFile(true);
    try {
      const result = await window.electron.dialog.selectFiles({
        title: i18nService.t('coworkAddFile'),
      });
      if (!result.success || result.paths.length === 0) {
        reportPromptControl('attachment_add_cancelled', {
          source: 'picker',
        });
        return;
      }
      let hasImageWithoutVision = false;
      for (const filePath of result.paths) {
        if (isImagePath(filePath)) {
          if (modelSupportsImage) {
            try {
              const readResult = await window.electron.dialog.readFileAsDataUrl(filePath);
              if (readResult.success && readResult.dataUrl) {
                console.debug('[CoworkPromptInput] handleAddFile: image read OK', {
                  dataUrlLength: readResult.dataUrl.length,
                });
                addAttachment(filePath, { isImage: true, dataUrl: readResult.dataUrl });
                continue;
              }
              console.warn('[CoworkPromptInput] handleAddFile: readFileAsDataUrl returned falsy');
            } catch (error) {
              console.error('Failed to read image as data URL:', error);
            }
          } else {
            console.warn('[CoworkPromptInput] handleAddFile: image skipped vision path because modelSupportsImage=false', {
              effectiveModelId: effectiveSelectedModel?.id ?? null,
            });
            hasImageWithoutVision = true;
          }
        }
        addAttachment(filePath);
      }
      if (hasImageWithoutVision) {
        setImageVisionHint(true);

      }
      reportPromptControl('attachment_add_success', {
        source: 'picker',
        selectedFileCount: result.paths.length,
        modelSupportsImage,
        hasImageWithoutVision,
        ...getAttachmentAnalyticsParams(result.paths.map(filePath => ({
          path: filePath,
          name: getFileNameFromPath(filePath),
          isImage: isImagePath(filePath),
        }))),
      });
    } catch (error) {
      console.error('Failed to select file:', error);
      reportPromptControl('attachment_add_failed', {
        source: 'picker',
        errorCode: 'select_files_failed',
      });
    } finally {
      setIsAddingFile(false);
    }
  }, [addAttachment, effectiveSelectedModel, isAddingFile, disabled, isStreaming, modelSupportsImage, reportPromptControl, voiceInputLocksEditing]);

  const handleOpenAddMenu = useCallback(() => {
    reportPromptControl(showAddMenu ? 'add_menu_close' : 'add_menu_open', {
      activeSkillCount: activeSkillIds.length,
      activeKitCount: activeKitIds.length,
    });
    setShowSkillsPopover(false);
    setShowAddMenu(prev => !prev);
  }, [activeKitIds.length, activeSkillIds.length, reportPromptControl, showAddMenu]);

  const handleOpenSkillsPopover = useCallback(() => {
    if (skillSubmenuCloseTimerRef.current) {
      clearTimeout(skillSubmenuCloseTimerRef.current);
      skillSubmenuCloseTimerRef.current = null;
    }
    if (!showSkillsPopover) {
      reportPromptControl('skill_menu_open', {
        activeSkillCount: activeSkillIds.length,
      });
    }
    setShowAddMenu(true);
    setShowSkillsPopover(true);
  }, [activeSkillIds.length, reportPromptControl, showSkillsPopover]);

  const cancelCloseSkillsPopover = useCallback(() => {
    if (skillSubmenuCloseTimerRef.current) {
      clearTimeout(skillSubmenuCloseTimerRef.current);
      skillSubmenuCloseTimerRef.current = null;
    }
  }, []);

  const handleCloseSkillsPopover = useCallback(() => {
    if (skillSubmenuCloseTimerRef.current) {
      clearTimeout(skillSubmenuCloseTimerRef.current);
      skillSubmenuCloseTimerRef.current = null;
    }
    setShowSkillsPopover(false);
  }, []);

  const scheduleCloseSkillsPopover = useCallback(() => {
    if (skillSubmenuCloseTimerRef.current) {
      clearTimeout(skillSubmenuCloseTimerRef.current);
    }
    skillSubmenuCloseTimerRef.current = setTimeout(() => {
      const activeElement = document.activeElement;
      if (activeElement && addMenuRef.current?.contains(activeElement)) {
        logPromptModelSelection('debug', 'kept skill submenu open because focus remains inside prompt tools menu');
        skillSubmenuCloseTimerRef.current = null;
        return;
      }
      setShowSkillsPopover(false);
      skillSubmenuCloseTimerRef.current = null;
    }, 120);
  }, []);

  const handleTogglePlanMode = useCallback(() => {
    const nextMode = isPlanMode ? CoworkCollaborationMode.Default : CoworkCollaborationMode.Plan;
    logPromptModelSelection('debug', `plan mode ${nextMode === CoworkCollaborationMode.Plan ? 'enabled' : 'disabled'} for draft ${draftKey}`);
    reportPromptControl(nextMode === CoworkCollaborationMode.Plan ? 'plan_mode_enabled' : 'plan_mode_disabled', {
      entry: LogReporterEntry.PromptToolsMenu,
    });
    if (nextMode === CoworkCollaborationMode.Plan && goalInputActive) {
      logPromptModelSelection('debug', `goal input mode disabled because plan mode was enabled for draft ${draftKey}`);
      resetGoalInput(true);
    }
    dispatch(setDraftCollaborationMode({
      draftKey,
      mode: nextMode,
    }));
    if (nextMode === CoworkCollaborationMode.Default && planConfirmation?.state === PlanConfirmationState.Awaiting) {
      dispatch(setPlanConfirmationHandled({
        sessionId: draftKey,
        messageId: planConfirmation.messageId,
      }));
    }
    if (nextMode === CoworkCollaborationMode.Plan) {
      void reportYdAnalyzer({
        action: LogReporterAction.PlanModeEnabled,
        entry: LogReporterEntry.PromptToolsMenu,
      });
    }
  }, [dispatch, draftKey, goalInputActive, isPlanMode, planConfirmation?.messageId, planConfirmation?.state, reportPromptControl, resetGoalInput]);

  const handleEnableGoalInput = useCallback((mode: GoalInputMode = 'start', initialValue?: string) => {
    if (disabled || voiceInputLocksEditing || !onGoalCommand) return;
    handleCloseSkillsPopover();
    setShowAddMenu(false);
    goalInputReturnDraftRef.current = value;
    goalInputBaselineRef.current = mode === 'set' && initialValue !== undefined
      ? initialValue.trim()
      : null;
    if (isPlanMode) {
      logPromptModelSelection('debug', `plan mode disabled because goal input mode was enabled for draft ${draftKey}`);
      dispatch(setDraftCollaborationMode({
        draftKey,
        mode: CoworkCollaborationMode.Default,
      }));
      if (planConfirmation?.state === PlanConfirmationState.Awaiting) {
        dispatch(setPlanConfirmationHandled({
          sessionId: draftKey,
          messageId: planConfirmation.messageId,
        }));
      }
      reportPromptControl('plan_mode_disabled', {
        entry: 'goal_mode',
      });
    }
    setGoalInputMode(mode);
    setGoalInputActive(true);
    if (initialValue !== undefined) {
      setValue(initialValue);
      dispatch(setDraftPrompt({ sessionId: draftKey, draft: initialValue }));
    }
    reportPromptControl('goal_mode_open', {
      entry: LogReporterEntry.PromptToolsMenu,
      hasGoal: !!goal,
      mode,
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [
    disabled,
    dispatch,
    draftKey,
    goal,
    handleCloseSkillsPopover,
    isPlanMode,
    onGoalCommand,
    planConfirmation?.messageId,
    planConfirmation?.state,
    reportPromptControl,
    value,
    voiceInputLocksEditing,
  ]);

  const handleOpenGoalEditModal = useCallback((initialValue: string) => {
    if (disabled || voiceInputLocksEditing || !onGoalCommand) return;
    handleCloseSkillsPopover();
    setShowAddMenu(false);
    setGoalEditDraft(initialValue);
    setGoalEditModalOpen(true);
    console.debug('[CoworkGoal] opening goal edit modal.');
    requestAnimationFrame(() => {
      goalEditTextareaRef.current?.focus();
      goalEditTextareaRef.current?.select();
    });
  }, [disabled, handleCloseSkillsPopover, onGoalCommand, voiceInputLocksEditing]);

  const handleCloseGoalEditModal = useCallback(() => {
    if (goalEditSaving) return;
    setGoalEditModalOpen(false);
    setGoalEditDraft('');
    console.debug('[CoworkGoal] closing goal edit modal.');
  }, [goalEditSaving]);

  const handleSubmitGoalEditModal = useCallback(async () => {
    if (!goal || !sessionId || !onGoalCommand || goalEditSaving) return;
    const trimmedValue = goalEditDraft.trim();
    if (!trimmedValue) return;
    if (trimmedValue === goal.objective.trim()) {
      handleCloseGoalEditModal();
      return;
    }
    setGoalEditSaving(true);
    console.debug(`[CoworkGoal] submitting goal edit modal for session ${sessionId}.`);
    try {
      const accepted = await Promise.resolve(onGoalCommand(`/goal set ${trimmedValue}`))
        .then((result) => result !== false);
      if (!accepted) {
        console.warn(`[CoworkGoal] goal edit modal command was rejected for session ${sessionId}.`);
        return;
      }
      setGoalEditModalOpen(false);
      setGoalEditDraft('');
    } catch (error) {
      console.warn(`[CoworkGoal] failed to submit goal edit modal for session ${sessionId}.`, error);
    } finally {
      setGoalEditSaving(false);
    }
  }, [goal, goalEditDraft, goalEditSaving, handleCloseGoalEditModal, onGoalCommand, sessionId]);

  const handleGoalCommandClick = useCallback((command: string) => {
    if (disabled || voiceInputLocksEditing || !onGoalCommand) return;
    const goalAction = command.split(/\s+/, 2)[1] ?? 'unknown';
    console.debug(`[CoworkGoal] prompt goal status action=${goalAction}`);
    reportPromptControl('goal_status_action', {
      action: goalAction,
      hasGoal: !!goal,
    });
    void Promise.resolve(onGoalCommand(command)).then((result) => {
      if (result === false) return;
      if (!sessionId) return;
      const optimisticGoal = applyOptimisticGoalCommand(command, goal, sessionId);
      if (optimisticGoal !== undefined) {
        console.debug(`[CoworkGoal] applying optimistic goal action=${goalAction} for session ${sessionId}.`);
        dispatch(updateSessionGoal({ sessionId, goal: optimisticGoal }));
      }
    }).catch((error) => {
      console.warn(`[CoworkGoal] prompt goal status action=${goalAction} failed.`, error);
    });
  }, [disabled, dispatch, goal, onGoalCommand, reportPromptControl, sessionId, voiceInputLocksEditing]);

  const handleDisablePlanMode = useCallback((event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (!isPlanMode) return;
    logPromptModelSelection('debug', `plan mode disabled from active badge for draft ${draftKey}`);
    reportPromptControl('plan_mode_disabled', {
      entry: 'active_context_badge',
    });
    dispatch(setDraftCollaborationMode({
      draftKey,
      mode: CoworkCollaborationMode.Default,
    }));
    if (planConfirmation?.state === PlanConfirmationState.Awaiting) {
      dispatch(setPlanConfirmationHandled({
        sessionId: draftKey,
        messageId: planConfirmation.messageId,
      }));
    }
  }, [dispatch, draftKey, isPlanMode, planConfirmation?.messageId, planConfirmation?.state, reportPromptControl]);

  const handleRemoveAttachment = useCallback((path: string) => {
    const attachment = attachments.find(item => item.path === path);
    reportPromptControl('attachment_remove', {
      ...getAttachmentAnalyticsParams(attachment ? [attachment] : []),
    });
    dispatch(setDraftAttachments({
      draftKey,
      attachments: attachments.filter((attachment) => attachment.path !== path),
    }));
  }, [attachments, dispatch, draftKey, reportPromptControl]);

  const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) return false;
    if (dataTransfer.files.length > 0) return true;
    return Array.from(dataTransfer.types).includes('Files');
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (!disabled && !isStreaming) {
      setIsDraggingFiles(true);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled || isStreaming || voiceInputLocksEditing ? 'none' : 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (disabled || isStreaming || voiceInputLocksEditing) return;
    void handleIncomingFiles(event.dataTransfer.files, 'drop');
  };

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || isStreaming || voiceInputLocksEditing) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void handleIncomingFiles(files, 'paste');
  }, [disabled, handleIncomingFiles, isStreaming, voiceInputLocksEditing]);

  const canSubmit = !disabled && !isVoiceRecognizing && !isPatchingModel && !agentModelIsInvalid && (!!value.trim() || hasAttachments);
  const enhancedContainerClass = isDraggingFiles
    ? `${containerClass} ring-2 ring-primary/50 border-primary/60`
    : containerClass;

  const [currentSendShortcut, setCurrentSendShortcut] = useState(
    () => configService.getConfig().shortcuts?.sendMessage ?? 'Enter'
  );
  const sendButtonTitle = `${i18nService.t('sendMessage')} (${getSendShortcutLabel(currentSendShortcut)})`;
  const stopButtonLabel = i18nService.t('stop');
  const goalCommandCanRunWhileStreaming = goalInputActive && !!sessionId && !!onGoalCommand;
  const currentAgentForDisplay: AgentSelectorOption = currentAgent ?? {
    id: currentAgentId,
    name: currentAgentId,
    icon: '',
    enabled: true,
  };
  const enabledAgentOptions = agents.filter((agent) => agent.enabled || agent.id === currentAgentId);
  const agentOptions = enabledAgentOptions.some((agent) => agent.id === currentAgentForDisplay.id)
    ? enabledAgentOptions
    : [currentAgentForDisplay, ...enabledAgentOptions];
  const currentAgentName = getAgentDisplayName(currentAgentForDisplay);
  const homeContextAgentName = truncateDisplayText(currentAgentName, ContextLabelMaxLength.Agent);
  const readOnlyContextAgentId = contextAgentId?.trim() || currentAgentId;
  const readOnlyContextAgent = agents.find((agent) => agent.id === readOnlyContextAgentId);
  const readOnlyContextAgentForDisplay: AgentSelectorOption = readOnlyContextAgent ?? {
    id: readOnlyContextAgentId,
    name: readOnlyContextAgentId,
    icon: '',
    enabled: true,
  };
  const readOnlyContextAgentName = getAgentDisplayName(readOnlyContextAgentForDisplay);
  const readOnlyContextAgentLabel = truncateDisplayText(readOnlyContextAgentName, ContextLabelMaxLength.Agent);
  const useLargeToolbarCompactLayout = isLargeToolbarCompact && !useHomeContextLayout;
  const largeToolbarGapClass = useLargeToolbarCompactLayout ? 'gap-1.5' : 'gap-3';
  const largeToolbarControlGapClass = useLargeToolbarCompactLayout ? 'gap-1' : 'gap-2';
  const largeModelTriggerMaxWidthClassName = useLargeToolbarCompactLayout ? 'max-w-[150px]' : undefined;

  // Sync when config is updated elsewhere (e.g. Settings panel)
  useEffect(() => {
    const syncFromConfig = () => {
      const latest = configService.getConfig().shortcuts?.sendMessage ?? 'Enter';
      setCurrentSendShortcut(latest);
    };
    window.addEventListener('config-updated', syncFromConfig);
    return () => window.removeEventListener('config-updated', syncFromConfig);
  }, []);

  const largeModelSelector = showModelSelector ? (
    <div className="flex flex-col items-start gap-1">
      <ModelSelector
        compact={useHomeContextLayout}
        dropdownDirection="up"
        alignDropdownToTriggerEnd={useHomeContextLayout}
        portal={showReadOnlyContext}
        triggerMaxWidthClassName={largeModelTriggerMaxWidthClassName}
        disabled={isPatchingModel || isPersistingAgentModel}
        value={agentModelIsInvalid && currentSession?.modelOverride
          ? { id: '__invalid__', name: currentSession.modelOverride.split('/').pop() || currentSession.modelOverride } as Model
          : effectiveSelectedModel}
        onChange={async (nextModel, meta: ModelSelectorChangeMeta) => {
          if (isPatchingModel || isPersistingAgentModel) return;
          if (!nextModel) return;
          const selectedModel = meta.group === ModelSelectorGroup.Server
            ? availableModels.find(model => (
              model.isServerModel
              && model.id === nextModel.id
              && model.accessible !== false
            )) ?? nextModel
            : nextModel;
          const modelRef = toOpenClawModelRef(selectedModel);
          if (sessionId) {
            const requestId = modelPatchRequestIdRef.current + 1;
            modelPatchRequestIdRef.current = requestId;
            const previousModelOverride = currentSession?.id === sessionId
              ? currentSession.modelOverride
              : '';

            setIsPatchingModel(true);
            logPromptModelSelection(
              'debug',
              `switching session ${sessionId} to ${modelRef}; selector group is ${meta.group}; server model is ${selectedModel.isServerModel === true}`,
            );
            dispatch(updateCurrentSessionModelOverride({ sessionId, modelOverride: modelRef }));

            try {
              const patchedSession = await coworkService.patchSession(sessionId, { model: modelRef });
              if (requestId !== modelPatchRequestIdRef.current) return;

              if (!patchedSession) {
                dispatch(updateCurrentSessionModelOverride({
                  sessionId,
                  modelOverride: previousModelOverride,
                }));
                logPromptModelSelection('warn', `model switch for session ${sessionId} returned no session`);
                window.dispatchEvent(new CustomEvent('app:showToast', {
                  detail: i18nService.t('coworkModelSwitchFailed'),
                }));
                return;
              }

              logPromptModelSelection('debug', `switched session ${sessionId} to ${patchedSession.modelOverride || modelRef}`);
              reportModelSelected(selectedModel, meta.group, 'session', currentAgentId, sessionId);
              if (currentAgent && agentModelIsInvalid) {
                void agentService.updateAgent(currentAgent.id, { model: modelRef });
              }
              void coworkService.refreshContextUsage(sessionId, { notifyCompaction: false });
            } catch (error) {
              if (requestId === modelPatchRequestIdRef.current) {
                dispatch(updateCurrentSessionModelOverride({
                  sessionId,
                  modelOverride: previousModelOverride,
                }));
                console.warn(`[CoworkPromptInput] model switch for session ${sessionId} failed:`, error);
                window.electron?.log?.fromRenderer?.('warn', 'CoworkPromptInput', `model switch for session ${sessionId} failed`);
                window.dispatchEvent(new CustomEvent('app:showToast', {
                  detail: i18nService.t('coworkModelSwitchFailed'),
                }));
              }
            } finally {
              if (requestId === modelPatchRequestIdRef.current) {
                setIsPatchingModel(false);
              }
            }
            return;
          }
          logPromptModelSelection(
            'debug',
            `persisting agent ${currentAgentId} model ${modelRef}; selector group is ${meta.group}; server model is ${selectedModel.isServerModel === true}`,
          );
          await persistAgentModelSelection(selectedModel);
          reportModelSelected(selectedModel, meta.group, 'agent', currentAgentId);
        }}
      />
      {agentModelIsInvalid && (
        <span className="max-w-60 text-[11px] leading-4 text-red-500">
          {i18nService.t('agentModelInvalidHint')}
        </span>
      )}
    </div>
  ) : null;

  const addMenuAction = !remoteManaged ? (
    <div className="relative">
      <button
        ref={addMenuButtonRef}
        type="button"
        onClick={handleOpenAddMenu}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
        title={i18nService.t('add')}
        aria-label={i18nService.t('add')}
        aria-haspopup="menu"
        aria-expanded={showAddMenu || showSkillsPopover}
      >
        <PromptAddIcon className="h-5 w-5" />
      </button>

      {showAddMenu && (
        <div
          ref={addMenuRef}
          className="absolute bottom-full left-0 z-50 mb-2 w-48 rounded-xl border border-border bg-surface py-1 shadow-popover"
          role="menu"
          onMouseEnter={cancelCloseSkillsPopover}
          onMouseLeave={scheduleCloseSkillsPopover}
        >
          <button
            type="button"
            onClick={handleAddFile}
            onMouseEnter={handleCloseSkillsPopover}
            onFocus={handleCloseSkillsPopover}
            disabled={disabled || isStreaming || isAddingFile || voiceInputLocksEditing}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
            role="menuitem"
          >
            <PaperClipIcon className="h-5 w-5 shrink-0 text-secondary" />
            <span className="min-w-0 truncate">{i18nService.t('coworkAddFile')}</span>
          </button>
          <button
            ref={skillMenuItemRef}
            type="button"
            onClick={handleOpenSkillsPopover}
            onMouseEnter={handleOpenSkillsPopover}
            onFocus={handleOpenSkillsPopover}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors ${
              showSkillsPopover ? 'bg-surface-raised' : 'hover:bg-surface-raised'
            }`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={showSkillsPopover}
          >
            <SkillIcon className="h-5 w-5 shrink-0 text-secondary" />
            <span className="min-w-0 flex-1 truncate">{i18nService.t('useSkill')}</span>
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (goal?.objective) {
                handleOpenGoalEditModal(goal.objective);
              } else {
                handleEnableGoalInput('start');
              }
            }}
            onMouseEnter={handleCloseSkillsPopover}
            onFocus={handleCloseSkillsPopover}
            disabled={disabled || voiceInputLocksEditing || !onGoalCommand}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              goalInputActive ? 'bg-surface-raised text-foreground' : 'text-foreground hover:bg-surface-raised'
            }`}
            role="menuitem"
          >
            <GoalIcon className="h-5 w-5 shrink-0 text-secondary" />
            <span className="shrink-0 text-foreground">{i18nService.t('coworkGoal')}</span>
            {goal?.objective && (
              <span className="min-w-0 flex-1 truncate text-secondary">
                {goal.objective}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={handleTogglePlanMode}
            onMouseEnter={handleCloseSkillsPopover}
            onFocus={handleCloseSkillsPopover}
            disabled={disabled || isStreaming || voiceInputLocksEditing}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
            role="menuitemcheckbox"
            aria-checked={isPlanMode}
          >
            <PlanModeIcon className="h-5 w-5 shrink-0 text-secondary" />
            <span className="min-w-0 flex-1 truncate">{i18nService.t('coworkPlanMode')}</span>
            <span
              className={`relative h-5 w-9 rounded-full transition-colors ${
                isPlanMode ? 'bg-primary' : 'bg-neutral-200 dark:bg-neutral-700'
              }`}
              aria-hidden="true"
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  isPlanMode ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>

          <SkillsPopover
            isOpen={showSkillsPopover}
            onClose={() => setShowSkillsPopover(false)}
            onSelectSkill={handleSelectSkill}
            onManageSkills={handleManageSkills}
            anchorRef={skillMenuItemRef as React.RefObject<HTMLElement>}
            asSubmenu
            autoFocusSearch={false}
            onMouseEnter={cancelCloseSkillsPopover}
            onMouseLeave={scheduleCloseSkillsPopover}
          />
        </div>
      )}
    </div>
  ) : null;

  const largeInputActions = !remoteManaged ? (
    <div className="flex items-center gap-0.5">
      {addMenuAction}
      <KitsButton
        onSelectKit={handleSelectKit}
        onManageKits={handleManageKits}
        onOpenChange={(open) => {
          reportPromptControl(open ? 'kit_menu_open' : 'kit_menu_close', {
            activeKitCount: activeKitIds.length,
          });
        }}
      />
    </div>
  ) : null;

  const renderVoiceInputButton = (buttonClassName: string, iconClassName: string) => (
    <VoiceInputButton
      buttonClassName={buttonClassName}
      iconClassName={iconClassName}
      isLoggedIn={isLoggedIn}
      disabled={disabled}
      isQuotaExhausted={isAsrQuotaExhaustedToday}
      isRecording={isVoiceRecording}
      isRecognizing={isVoiceRecognizing}
      onClick={handleVoiceInputClick}
    />
  );
  const hasPromptText = Boolean(value.trim());
  const voiceRecordingUiState = getCoworkVoiceRecordingUiState({
    isLarge,
    isStreaming,
    isVoiceRecording,
  });

  const largeInputToolActions = (
    <div className={`flex items-center ${useLargeToolbarCompactLayout ? 'gap-0' : 'gap-0.5'}`}>
      {largeInputActions}
      <MediaModelPicker draftKey={draftKey} disabled={disabled || voiceInputLocksEditing} />
    </div>
  );
  const largeSendButtonSizeClass = useCompactSendButton ? 'h-7 w-7' : 'h-8 w-8';
  const largeSendIconSizeClass = useCompactSendButton ? 'h-4 w-4' : 'h-[18px] w-[18px]';
  const largeVoiceInputButton = !remoteManaged ? renderVoiceInputButton(
    `flex ${largeSendButtonSizeClass} shrink-0 items-center justify-center rounded-full`,
    largeSendIconSizeClass,
  ) : null;

  const largeTaskStopButton = (
    <button
      type="button"
      onClick={handleStopClick}
      className="flex h-[34px] w-[34px] items-center justify-center rounded-full transition-all hover:opacity-90 active:scale-95 focus:outline-none focus:ring-2 focus:ring-primary/40"
      aria-label={stopButtonLabel}
      title={stopButtonLabel}
    >
      <TaskPauseIcon className="h-[34px] w-[34px]" aria-hidden="true" />
    </button>
  );

  const canUseSubmitButton = canSubmit && (!isStreaming || goalCommandCanRunWhileStreaming);
  const largeSubmitButton = (
    <button
      type="button"
      onClick={() => handleSubmit('button')}
      disabled={!canUseSubmitButton}
      className={`flex ${largeSendButtonSizeClass} shrink-0 items-center justify-center rounded-full transition-all ${
        canUseSubmitButton
          ? 'bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800 active:scale-95 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200'
          : 'cursor-not-allowed bg-neutral-300 text-white dark:bg-neutral-700 dark:text-neutral-500'
      }`}
      aria-label={i18nService.t('sendMessage')}
      title={sendButtonTitle}
    >
      <ArrowUpIcon className={largeSendIconSizeClass} />
    </button>
  );

  const largeSendButton = voiceRecordingUiState.showTaskStopButton
    ? largeTaskStopButton
    : largeSubmitButton;

  const attachmentPreviewContent = hasAttachments ? (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const ml = mediaLabels.find(m => m.attachment.path === attachment.path);
        return (
          <AttachmentCard
            key={attachment.path}
            attachment={attachment}
            onRemove={handleRemoveAttachment}
            label={ml?.label}
          />
        );
      })}
    </div>
  ) : null;

  const largeAttachmentPreview = hasAttachments ? (
    <div className={`${isCompact ? 'max-h-[88px] px-3 pb-1 pt-2' : 'max-h-[156px] px-4 pb-1 pt-3'} overflow-y-auto`}>
      {attachmentPreviewContent}
    </div>
  ) : null;

  const selectedTextSnippetPreview = selectedTextSnippets.length > 0 ? (
    <div className={`${isCompact ? 'px-3 pt-2' : 'px-4 pt-3'}`}>
      <SelectedTextSnippetBadge
        snippets={selectedTextSnippets}
        onClear={() => dispatch(clearDraftSelectedTextSnippets(draftKey))}
        onRemove={(snippetId) => dispatch(removeDraftSelectedTextSnippet({ draftKey, snippetId }))}
      />
    </div>
  ) : null;

  const goalActionsDisabled = disabled || voiceInputLocksEditing || !onGoalCommand;
  const sessionGoalStatusBar = goal && !goalInputActive ? (() => {
    const summary = getGoalSummary(goal);
    const detail = goal.lastStatusNote
      ? `${summary}: ${goal.objective} - ${goal.lastStatusNote}`
      : `${summary}: ${goal.objective}`;
    const canTogglePause = goal.status !== CoworkGoalStatus.Complete;
    const pauseCommand = goal.status === CoworkGoalStatus.Active ? '/goal pause' : '/goal resume';
    const pauseLabel = goal.status === CoworkGoalStatus.Active
      ? i18nService.t('coworkGoalPause')
      : i18nService.t('coworkGoalResume');
    return (
      <div className={`${isCompact ? 'px-3 pt-2' : 'px-4 pt-3'}`}>
        <div
          role="status"
          title={detail}
          aria-label={detail}
          className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-raised/70 px-2.5 py-1.5 text-xs text-secondary"
        >
          <GoalIcon className={`h-4 w-4 shrink-0 ${
            goal.status === CoworkGoalStatus.Active
              ? 'text-primary'
              : goal.status === CoworkGoalStatus.Complete
                ? 'text-green-600 dark:text-green-400'
                : 'text-warning'
          }`} />
          <span className="shrink-0 font-semibold text-foreground">{summary}</span>
          <span className="min-w-0 flex-1 truncate">{goal.objective}</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => handleOpenGoalEditModal(goal.objective)}
              disabled={goalActionsDisabled}
              className="rounded-md p-1 text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={i18nService.t('coworkGoalEdit')}
              aria-label={i18nService.t('coworkGoalEdit')}
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
            {canTogglePause && (
              <button
                type="button"
                onClick={() => handleGoalCommandClick(pauseCommand)}
                disabled={goalActionsDisabled}
                className="rounded-md p-1 text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={pauseLabel}
                aria-label={pauseLabel}
              >
                {goal.status === CoworkGoalStatus.Active
                  ? <PauseCircleIcon className="h-3.5 w-3.5" />
                  : <PlayCircleIcon className="h-3.5 w-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => handleGoalCommandClick('/goal clear')}
              disabled={goalActionsDisabled}
              className="rounded-md p-1 text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={i18nService.t('coworkGoalClear')}
              aria-label={i18nService.t('coworkGoalClear')}
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  })() : null;

  const planModeBadge = isPlanMode ? (
    <button
      type="button"
      onClick={handleDisablePlanMode}
      className={ACTIVE_CONTEXT_BADGE_BUTTON_CLASS}
      title={i18nService.t('coworkClearPlanMode')}
      aria-label={i18nService.t('coworkClearPlanMode')}
    >
      <span className={ACTIVE_CONTEXT_BADGE_ICON_WRAP_CLASS}>
        <PlanModeIcon className={ACTIVE_CONTEXT_BADGE_ICON_CLASS} />
        <XMarkIcon className={ACTIVE_CONTEXT_BADGE_REMOVE_ICON_CLASS} />
      </span>
      <span className="min-w-0 truncate">
        {i18nService.t('coworkPlanMode')}
      </span>
    </button>
  ) : null;

  const goalModeBadge = goalInputActive ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        resetGoalInput(true);
      }}
      className={ACTIVE_CONTEXT_BADGE_BUTTON_CLASS}
      title={i18nService.t('coworkGoalClearInputMode')}
      aria-label={i18nService.t('coworkGoalClearInputMode')}
    >
      <span className={ACTIVE_CONTEXT_BADGE_ICON_WRAP_CLASS}>
        <GoalIcon className={ACTIVE_CONTEXT_BADGE_ICON_CLASS} />
        <XMarkIcon className={ACTIVE_CONTEXT_BADGE_REMOVE_ICON_CLASS} />
      </span>
      <span className="min-w-0 truncate">
        {i18nService.t('coworkGoal')}
      </span>
    </button>
  ) : null;

  const compactAttachmentPreview = hasAttachments ? (
    <div className="mb-2 max-h-[164px] overflow-y-auto rounded-xl bg-black/[0.035] p-2 dark:bg-white/[0.055]">
      {attachmentPreviewContent}
    </div>
  ) : null;

  const activeSkillContextRow = isLarge && hasActiveContext ? (
    <div
      className={`flex cursor-text flex-wrap items-center gap-x-2 gap-y-1 px-4 ${isCompact ? 'pt-2' : 'pt-4'}`}
      onClick={() => {
        if (!disabled && !voiceInputLocksEditing) textareaRef.current?.focus();
      }}
    >
      <ActiveSkillBadge />
      <ActiveKitBadge />
      {goalModeBadge}
      {planModeBadge}
    </div>
  ) : null;
  const textareaPlaceholder = goalInputActive
    ? i18nService.t('coworkGoalInputPlaceholder')
    : placeholder;

  const renderMentionTextarea = ({
    rows,
    placeholder: textareaPlaceholderText,
    style,
    wrapperClassName = 'relative w-full',
  }: {
    rows: number;
    placeholder: string;
        style?: React.CSSProperties;
        wrapperClassName?: string;
      }) => (
        <div className={wrapperClassName}>
      {value && hasMediaMentionHighlight && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
        >
          <div
            className={`${textareaClass} whitespace-pre-wrap break-words text-transparent`}
            style={{
              ...style,
              transform: `translateY(-${textareaScrollTop}px)`,
            }}
          >
            {mediaMentionSegments.map((segment, idx) => (
              segment.kind === MediaMentionSegmentKind.Mention ? (
                <span
                  key={`${segment.kind}-${idx}`}
                  className="rounded bg-primary/15 text-transparent"
                >
                  {segment.text}
                </span>
              ) : (
                <React.Fragment key={`${segment.kind}-${idx}`}>
                  {segment.text}
                </React.Fragment>
              )
            ))}
            <span>{'\u200b'}</span>
          </div>
        </div>
      )}
        <textarea
          ref={textareaRef}
          value={value}
        onChange={handleTextareaChange}
        onFocus={handleTextareaFocus}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onScroll={handleTextareaScroll}
        placeholder={voiceRecordingUiState.shouldHideInputPlaceholder ? '' : textareaPlaceholderText}
        disabled={disabled || voiceInputLocksEditing}
        rows={rows}
        className={`${textareaClass} relative z-10`}
        style={{
          ...style,
          caretColor: 'var(--lobster-text-primary)',
          }}
        />
      </div>
    );

  const readOnlyContextRow = isLarge && showReadOnlyContext && !useHomeContextLayout ? (
    <div className="mt-2 grid min-h-7 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4">
      <div ref={readOnlyContextGroupRef} className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={handleOpenWorkingDirectory}
          disabled={!hasWorkingDirectory}
          className={`flex h-7 items-center rounded-lg text-[13px] text-secondary transition-colors ${
            hasWorkingDirectory ? 'hover:bg-background/80 hover:text-foreground' : 'cursor-default'
          } ${
            isReadOnlyContextCompact
              ? 'w-7 flex-none justify-center'
              : 'min-w-0 max-w-[260px] shrink gap-1.5 px-2'
          }`}
          title={workingDirectory || i18nService.t('noFolderSelected')}
          aria-label={i18nService.t('coworkOpenFolder')}
        >
          <FolderIcon className="h-4 w-4 shrink-0" />
          {!isReadOnlyContextCompact && (
            <span className="min-w-0 truncate">
              {truncatePath(workingDirectory, ContextLabelMaxLength.Folder)}
            </span>
          )}
        </button>
        <div
          className={`flex h-7 items-center rounded-lg text-[13px] text-secondary ${
            isReadOnlyContextCompact
              ? 'w-7 flex-none justify-center'
              : 'min-w-0 max-w-[220px] shrink gap-1.5 px-2'
          }`}
          title={`${i18nService.t('coworkCurrentAgent')}: ${readOnlyContextAgentName}`}
        >
          <AgentContextAvatar agent={readOnlyContextAgentForDisplay} />
          {!isReadOnlyContextCompact && (
            <span className="min-w-0 truncate">{readOnlyContextAgentLabel}</span>
          )}
        </div>
      </div>
      {readOnlyContextTrailingText && (
        <span className="pointer-events-none min-w-0 max-w-full select-none truncate text-center text-[13px] text-muted opacity-85">
          {readOnlyContextTrailingText}
        </span>
      )}
      <div aria-hidden="true" />
    </div>
  ) : null;

  const voiceQuotaLimitSeconds = asrQuota.limitSecondsToday
    ?? (isAsrSubscribed ? DEFAULT_SUBSCRIBED_ASR_LIMIT_SECONDS : DEFAULT_FREE_ASR_LIMIT_SECONDS);
  const voiceQuotaLimitText = formatVoiceInputQuotaLimit(voiceQuotaLimitSeconds);
  const voiceQuotaDescription = i18nService
    .t(isAsrSubscribed ? 'voiceInputQuotaExhaustedSubscribedDesc' : 'voiceInputQuotaExhaustedFreeDesc')
    .replace('{limit}', voiceQuotaLimitText);
  const handleVoiceQuotaPrimary = async () => {
    if (isAsrSubscribed) {
      setShowVoiceQuotaPrompt(false);
      return;
    }
    setShowVoiceQuotaPrompt(false);
    await window.electron.shell.openExternal(getPortalPricingUrl());
  };
  const normalizedGoalEditDraft = goalEditDraft.trim();
  const canSaveGoalEdit = Boolean(
    goal
    && normalizedGoalEditDraft
    && normalizedGoalEditDraft !== goal.objective.trim()
    && !goalEditSaving
  );

  return (
    <div className="relative">
      {goalEditModalOpen && (
        <Modal
          onClose={handleCloseGoalEditModal}
          overlayClassName="fixed inset-0 z-[10050] flex items-center justify-center modal-backdrop px-4"
          className="w-full max-w-xl rounded-2xl border border-border bg-surface p-6 shadow-modal"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cowork-goal-edit-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                handleCloseGoalEditModal();
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleSubmitGoalEditModal();
              }
            }}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div className="flex flex-col gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-raised text-secondary">
                  <GoalIcon className="h-5 w-5" />
                </div>
                <h2 id="cowork-goal-edit-title" className="text-xl font-semibold text-foreground">
                  {i18nService.t('coworkGoalEdit')}
                </h2>
              </div>
              <button
                type="button"
                onClick={handleCloseGoalEditModal}
                disabled={goalEditSaving}
                className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={i18nService.t('cancel')}
                title={i18nService.t('cancel')}
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
            <textarea
              ref={goalEditTextareaRef}
              value={goalEditDraft}
              onChange={(event) => setGoalEditDraft(event.target.value)}
              disabled={goalEditSaving}
              placeholder={i18nService.t('coworkGoalInputPlaceholder')}
              className="min-h-[220px] w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-70"
            />
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseGoalEditModal}
                disabled={goalEditSaving}
                className="rounded-xl bg-surface-raised px-5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitGoalEditModal()}
                disabled={!canSaveGoalEdit}
                className="rounded-xl bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-muted disabled:opacity-100"
              >
                {i18nService.t('save')}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {!isLarge && compactAttachmentPreview}
      {!isLarge && selectedTextSnippetPreview}
      {imageVisionHint && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <ExclamationTriangleIcon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>
            {i18nService.t('imageVisionHint')}
          </span>
          <button
            type="button"
            onClick={() => setImageVisionHint(false)}
            className="ml-auto flex-shrink-0 rounded-full p-0.5 hover:bg-amber-200/50 dark:hover:bg-amber-800/50"
          >
            <XMarkIcon className="h-3 w-3" />
          </button>
        </div>
      )}
      <div
        className={enhancedContainerClass}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFiles && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-primary/10 text-xs font-medium text-primary">
            {i18nService.t('coworkDropFileHint')}
          </div>
        )}
        {isLarge ? (
          useHomeContextLayout ? (
            <>
              <div className="relative z-10 rounded-2xl border border-border bg-surface shadow-card transition-[border-color,box-shadow] duration-200 focus-within:border-primary/35 focus-within:shadow-elevated">
                {largeAttachmentPreview}
                {selectedTextSnippetPreview}
                {sessionGoalStatusBar}
                {activeSkillContextRow}
                {renderMentionTextarea({
                  rows: 2,
                  placeholder: textareaPlaceholder,
                  style: { minHeight: `${minHeight}px` },
                })}
                {mentionPickerOpen && (
                  <MediaMentionPicker
                    items={mediaLabels}
                    filter={mentionFilter}
                    position={mentionPickerPosition}
                    onSelect={handleMentionSelect}
                    onDismiss={() => setMentionPickerOpen(false)}
                  />
                )}
                <div ref={largeToolbarRef} className={`relative flex items-center justify-between ${largeToolbarGapClass} px-4 pb-2 pt-1`}>
                  {voiceRecordingUiState.showFooterRecordingStatus && (
                    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center">
                      <VoiceInputRecordingStatus
                        elapsedSeconds={recordingElapsedSeconds}
                        showHint={!hasPromptText}
                      />
                    </div>
                  )}
                  <div className={`flex min-w-0 items-center ${largeToolbarControlGapClass}`}>
                    {voiceRecordingUiState.showLargeInputControls && largeInputToolActions}
                  </div>
                  <div className={`flex shrink-0 items-center ${largeToolbarControlGapClass}`}>
                    {contextUsageControl}
                    {voiceRecordingUiState.showLargeModelSelector && largeModelSelector}
                    {largeVoiceInputButton}
                    {largeSendButton}
                  </div>
                </div>
              </div>
              <div className="-mt-2 flex min-h-10 items-center gap-1 rounded-b-2xl bg-black/[0.035] px-4 pb-2 pt-3.5 dark:bg-white/[0.05]">
                {showFolderSelector && (
                  <div className="relative min-w-0 shrink">
                    <button
                      ref={folderButtonRef as React.RefObject<HTMLButtonElement>}
                      type="button"
                      onClick={() => {
                        reportPromptControl(showFolderMenu ? 'working_directory_selector_close' : 'working_directory_selector_open', {
                          source: 'home_context',
                        });
                        setShowFolderMenu(!showFolderMenu);
                      }}
                      className={`flex h-7 max-w-[260px] items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors ${
                        showFolderRequiredWarning
                          ? 'ring-1 ring-warning text-warning animate-shake'
                          : `text-secondary hover:bg-background/80 hover:text-foreground ${
                            showFolderMenu ? 'bg-background/80 text-foreground' : ''
                          }`
                      }`}
                    >
                      <FolderIcon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">
                        {truncatePath(workingDirectory, ContextLabelMaxLength.Folder)}
                      </span>
                      <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
                    </button>
                    <FolderSelectorPopover
                      isOpen={showFolderMenu}
                      onClose={() => setShowFolderMenu(false)}
                      onSelectFolder={handleFolderSelect}
                      anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
                      portal
                    />
                    {showFolderRequiredWarning && (
                      <div className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded-md bg-surface-raised px-2 py-1 text-xs text-warning shadow-subtle animate-fade-in-up">
                        {i18nService.t('coworkSelectFolderFirst')}
                      </div>
                    )}
                  </div>
                )}
                <div className="relative min-w-0 shrink">
                  <button
                    ref={agentButtonRef}
                    type="button"
                    onClick={() => {
                      reportPromptControl(showAgentMenu ? 'agent_selector_close' : 'agent_selector_open', {
                        agentCount: agentOptions.length,
                      });
                      setShowAgentMenu(!showAgentMenu);
                    }}
                    className={`flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg px-2 text-[13px] text-secondary transition-colors hover:bg-background/80 hover:text-foreground ${
                      showAgentMenu ? 'bg-background/80 text-foreground' : ''
                    }`}
                    aria-label={i18nService.t('coworkSelectAgent')}
                    title={`${i18nService.t('coworkCurrentAgent')}: ${currentAgentName}`}
                  >
                    <AgentContextAvatar agent={currentAgentForDisplay} />
                    <span className="min-w-0 truncate">{homeContextAgentName}</span>
                    <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
                  </button>
                  {showAgentMenu && (
                    <div
                      ref={agentMenuRef}
                      className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-popover"
                    >
                      {agentOptions.map((agent) => {
                        const isSelectedAgent = agent.id === currentAgentId;
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            onClick={() => handleSelectAgent(agent.id)}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-raised ${
                              isSelectedAgent ? 'bg-surface-raised/70 text-foreground' : 'text-foreground'
                            }`}
                          >
                            <AgentContextAvatar agent={agent} />
                            <span className="min-w-0 flex-1 truncate">{getAgentDisplayName(agent)}</span>
                            {isSelectedAgent && <CheckIcon className="h-4 w-4 shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              {largeAttachmentPreview}
              {selectedTextSnippetPreview}
              {sessionGoalStatusBar}
              {activeSkillContextRow}
              {renderMentionTextarea({
                rows: isCompact ? 1 : 2,
                placeholder: textareaPlaceholder,
                style: { minHeight: `${minHeight}px` },
              })}
              {mentionPickerOpen && (
                <MediaMentionPicker
                  items={mediaLabels}
                  filter={mentionFilter}
                  position={mentionPickerPosition}
                  onSelect={handleMentionSelect}
                  onDismiss={() => setMentionPickerOpen(false)}
                />
              )}
              <div ref={largeToolbarRef} className={`relative flex items-center justify-between ${largeToolbarGapClass} px-4 ${isCompact ? 'pb-1.5 pt-0.5' : 'pb-2 pt-1.5'}`}>
                {voiceRecordingUiState.showFooterRecordingStatus && (
                  <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center">
                    <VoiceInputRecordingStatus
                      elapsedSeconds={recordingElapsedSeconds}
                      showHint={!hasPromptText}
                    />
                  </div>
                )}
                <div className={`relative flex min-w-0 items-center ${largeToolbarControlGapClass}`}>
                  {voiceRecordingUiState.showLargeInputControls && showFolderSelector && (
                    <>
                      <div className="flex items-center">
                        <button
                          ref={folderButtonRef as React.RefObject<HTMLButtonElement>}
                          type="button"
                          onClick={() => setShowFolderMenu(!showFolderMenu)}
                          className={`flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-lg text-sm transition-colors ${
                            showFolderRequiredWarning
                              ? 'ring-1 ring-warning text-warning animate-shake'
                              : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                          }`}
                        >
                          <FolderIcon className="h-4 w-4 flex-shrink-0" />
                          <span className="max-w-[150px] truncate text-xs">
                            {truncatePath(workingDirectory)}
                          </span>
                          {workingDirectory && (
                            <span
                              role="button"
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleFolderSelect('');
                              }}
                              className="flex-shrink-0 ml-0.5 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                            >
                              <XMarkIcon className="h-3 w-3" />
                            </span>
                          )}
                        </button>
                      </div>
                      <FolderSelectorPopover
                        isOpen={showFolderMenu}
                        onClose={() => setShowFolderMenu(false)}
                        onSelectFolder={handleFolderSelect}
                        anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
                      />
                      {showFolderRequiredWarning && (
                        <div className="absolute left-0 top-full mt-1 px-2 py-1 rounded-md bg-surface-raised text-warning text-xs whitespace-nowrap animate-fade-in-up shadow-subtle z-10">
                          {i18nService.t('coworkSelectFolderFirst')}
                        </div>
                      )}
                    </>
                  )}
                  {voiceRecordingUiState.showLargeInputControls && largeInputToolActions}
                </div>
                <div className={`flex shrink-0 items-center ${largeToolbarControlGapClass}`}>
                  {contextUsageControl}
                  {voiceRecordingUiState.showLargeModelSelector && largeModelSelector}
                  {largeVoiceInputButton}
                  {largeSendButton}
                </div>
              </div>
            </>
          )
        ) : (
          <>
            {renderMentionTextarea({
              rows: 1,
              placeholder,
              wrapperClassName: 'relative flex-1',
            })}
            {mentionPickerOpen && (
              <MediaMentionPicker
                items={mediaLabels}
                filter={mentionFilter}
                position={mentionPickerPosition}
                onSelect={handleMentionSelect}
                onDismiss={() => setMentionPickerOpen(false)}
              />
            )}

            {!remoteManaged && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleAddFile}
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                  title={i18nService.t('coworkAddFile')}
                  aria-label={i18nService.t('coworkAddFile')}
                  disabled={disabled || isStreaming || isAddingFile || voiceInputLocksEditing}
                >
                  <PaperClipIcon className="h-5 w-5" />
                </button>
                {renderVoiceInputButton(
                  'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full',
                  'h-5 w-5',
                )}
              </div>
            )}

            {isStreaming ? (
              <div className="flex flex-shrink-0 items-center gap-3">
                {contextUsageControl}
                {goalCommandCanRunWhileStreaming && (
                  <button
                    type="button"
                    onClick={() => handleSubmit('button')}
                    disabled={!canUseSubmitButton}
                    className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-all ${
                      canUseSubmitButton
                        ? 'bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800 active:scale-95 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200'
                        : 'cursor-not-allowed bg-neutral-300 text-white dark:bg-neutral-700 dark:text-neutral-500'
                    }`}
                    aria-label={i18nService.t('sendMessage')}
                    title={sendButtonTitle}
                  >
                    <ArrowUpIcon className="h-[17px] w-[17px]" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleStopClick}
                  className="flex h-[34px] w-[34px] items-center justify-center rounded-full transition-all hover:opacity-90 active:scale-95 focus:outline-none focus:ring-2 focus:ring-primary/40"
                  aria-label={stopButtonLabel}
                  title={stopButtonLabel}
                >
                  <TaskPauseIcon className="h-[34px] w-[34px]" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="flex flex-shrink-0 items-center gap-3">
                {contextUsageControl}
                <button
                  type="button"
                  onClick={() => handleSubmit('button')}
                  disabled={!canSubmit}
                  className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-all ${
                    canSubmit
                      ? 'bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800 active:scale-95 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200'
                      : 'cursor-not-allowed bg-neutral-300 text-white dark:bg-neutral-700 dark:text-neutral-500'
                  }`}
                  aria-label={i18nService.t('sendMessage')}
                  title={sendButtonTitle}
                >
                  <ArrowUpIcon className="h-[17px] w-[17px]" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {readOnlyContextRow}
      {modelAccessPrompt && (
        <ModelAccessPromptModal
          promptKind={modelAccessPrompt}
          onClose={() => setModelAccessPrompt(null)}
        />
      )}
      {showVoiceLoginPrompt && (
        <ModelAccessPromptModal
          promptKind={ModelAccessPromptKind.Login}
          titleKey="voiceInputLoginTitle"
          descriptionKey="voiceInputLoginDesc"
          showLearnMore={false}
          onClose={() => setShowVoiceLoginPrompt(false)}
        />
      )}
      {showVoiceQuotaPrompt && (
        <Modal
          onClose={() => setShowVoiceQuotaPrompt(false)}
          overlayClassName="fixed inset-0 z-[10050] flex items-center justify-center modal-backdrop px-4"
          className="modal-content w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-modal"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-base font-semibold leading-6 text-foreground">
                {i18nService.t('voiceInputQuotaExhaustedTitle')}
              </div>
              <div className="mt-1.5 text-sm leading-5 text-secondary">
                {voiceQuotaDescription}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowVoiceQuotaPrompt(false)}
              className="-mr-1 -mt-1 rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => { void handleVoiceQuotaPrimary(); }}
            className="mt-5 w-full rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
          >
            {i18nService.t(isAsrSubscribed ? 'voiceInputQuotaAcknowledge' : 'voiceInputUpgradeSubscription')}
          </button>
        </Modal>
      )}
    </div>
  );
  }
);

CoworkPromptInput.displayName = 'CoworkPromptInput';

export default CoworkPromptInput;
