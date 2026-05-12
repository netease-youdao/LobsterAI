import { CheckIcon, ChevronDownIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ArrowUpIcon, FolderIcon, StopIcon } from '@heroicons/react/24/solid';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { triggerSystemDictation } from '../../hooks/useSpeechToText';
import { agentService } from '../../services/agent';
import { configService } from '../../services/config';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { selectDraftPrompts } from '../../store/selectors/coworkSelectors';
import {
  addDraftAttachment,
  clearDraftAttachments,
  type DraftAttachment,
  setDraftAttachments,
  setDraftPrompt,
  updateCurrentSessionModelOverride,
} from '../../store/slices/coworkSlice';
import type { Model } from '../../store/slices/modelSlice';
import { setSkills, toggleActiveSkill } from '../../store/slices/skillSlice';
import { CoworkImageAttachment } from '../../types/cowork';
import { Skill } from '../../types/skill';
import { getAgentDisplayName, shouldUseDefaultAgentIcon } from '../../utils/agentDisplay';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import { getCompactFolderName } from '../../utils/path';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import DefaultAgentIcon from '../icons/DefaultAgentIcon';
import MicrophoneIcon from '../icons/MicrophoneIcon';
import PaperClipIcon from '../icons/PaperClipIcon';
import XMarkIcon from '../icons/XMarkIcon';
import ModelSelector from '../ModelSelector';
import { ActiveSkillBadge, SkillsButton } from '../skills';
import { resolveAgentModelSelection, resolveEffectiveModel, useAgentSelectedModel } from './agentModelSelection';
import AttachmentCard from './AttachmentCard';
import FolderSelectorPopover from './FolderSelectorPopover';
import { usePersistAgentModelSelection } from './usePersistAgentModelSelection';

// CoworkAttachment is aliased from the Redux-persisted DraftAttachment type
// so that attachment state survives view switches (cowork ↔ skills, etc.)
type CoworkAttachment = DraftAttachment;


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

const getFileNameFromPath = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

const getSkillDirectoryFromPath = (skillPath: string): string => {
  const normalized = skillPath.trim().replace(/\\/g, '/');
  return normalized.replace(/\/SKILL\.md$/i, '') || normalized;
};

const buildInlinedSkillPrompt = (skill: Skill): string => {
  const skillDirectory = getSkillDirectoryFromPath(skill.skillPath);
  return [
    `## Skill: ${skill.name}`,
    '<skill_context>',
    `  <location>${skill.skillPath}</location>`,
    `  <directory>${skillDirectory}</directory>`,
    '  <path_rules>',
    '    Resolve relative file references from this skill against <directory>.',
    '    Do not assume skills are under the current workspace directory.',
    '  </path_rules>',
    '</skill_context>',
    '',
    skill.prompt,
  ].join('\n');
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

const truncateDisplayText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) return trimmed;
  return `${characters.slice(0, maxLength).join('')}...`;
};

const getSendShortcutLabel = (value: string): string => {
  const option = SEND_SHORTCUT_OPTIONS.find(o => o.value === value);
  if (!option) return value;
  return isMacPlatform ? option.labelMac : option.label;
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
  setValue: (value: string) => void;
  /** 设置图片附件（用于重新编辑消息时还原图片） */
  setImageAttachments: (images: CoworkImageAttachment[]) => void;
  /** 聚焦输入框 */
  focus: () => void;
}

interface CoworkPromptInputProps {
  onSubmit: (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => boolean | void | Promise<boolean | void>;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  size?: 'normal' | 'large';
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  showModelSelector?: boolean;
  showAgentSelector?: boolean;
  showReadOnlyContext?: boolean;
  readOnlyContextTrailingText?: string;
  contextAgentId?: string;
  onManageSkills?: () => void;
  sessionId?: string;
  /** When true, hides attachment/skill buttons but keeps the input box visible (disabled) */
  remoteManaged?: boolean;
}

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
      sessionId,
      remoteManaged = false,
    } = props;
    const dispatch = useDispatch();
    const draftKey = sessionId || '__home__';
    const draftPrompt = useSelector((state: RootState) => selectDraftPrompts(state)[draftKey] || '');
    const attachments = useSelector((state: RootState) => state.cowork.draftAttachments[draftKey] || []) as CoworkAttachment[];
    const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
    const agents = useSelector((state: RootState) => state.agent.agents);
    const coworkAgentEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);
    const availableModels = useSelector((state: RootState) => state.model.availableModels);
    const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
    const [value, setValue] = useState(draftPrompt);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [isAddingFile, setIsAddingFile] = useState(false);
    const [imageVisionHint, setImageVisionHint] = useState(false);
    const [isPatchingModel, setIsPatchingModel] = useState(false);
    const [showAgentMenu, setShowAgentMenu] = useState(false);
    const [isReadOnlyContextCompact, setIsReadOnlyContextCompact] = useState(false);

    const handleVoiceInput = useCallback(async () => {
      if (isMacPlatform) {
        const dictationShortcut = configService.getConfig().shortcuts?.macDictation;
        if (!dictationShortcut) {
          // First use — guide user to configure dictation shortcut in Settings
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: i18nService.t('voiceInputNeedConfig'),
          }));
          window.dispatchEvent(new CustomEvent('app:showSettings', {
            detail: { initialTab: 'shortcuts' },
          }));
          return;
        }
      }
      textareaRef.current?.focus();
      const shortcut = isMacPlatform ? configService.getConfig().shortcuts?.macDictation : undefined;
      const result = await triggerSystemDictation(shortcut);
      if (!result.success && result.error === 'permission_denied') {
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('voiceInputPermissionDenied'),
        }));
        window.electron.shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
    }, []);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const agentButtonRef = useRef<HTMLButtonElement>(null);
    const agentMenuRef = useRef<HTMLDivElement>(null);
    const readOnlyContextGroupRef = useRef<HTMLDivElement>(null);
    const dragDepthRef = useRef(0);
    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const modelPatchRequestIdRef = useRef(0);

  // 暴露方法给父组件
  React.useImperativeHandle(ref, () => ({
    setValue: (newValue: string) => {
      setValue(newValue);
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
        path: `inline:${img.name}:reedit-${Date.now()}-${idx}`,
        name: img.name,
        isImage: true,
        dataUrl: `data:${img.mimeType};base64,${img.base64Data}`,
      }));
      dispatch(setDraftAttachments({ draftKey, attachments: newAttachments }));
    },
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
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

  const isLarge = size === 'large';
  const useHomeContextLayout = isLarge && showAgentSelector;
  const minHeight = isLarge ? (useHomeContextLayout ? 52 : 60) : 24;
  const maxHeight = isLarge ? 200 : 200;

  const effectiveSelectedModel = resolveEffectiveModel({
    sessionId,
    agentSelectedModel,
    globalSelectedModel: currentAgentSelectedModel,
  });
  const modelSupportsImage = !!effectiveSelectedModel?.supportsImage;

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
      const detail = (event as CustomEvent<{ clear?: boolean; text?: string }>).detail;
      const shouldClear = detail?.clear ?? true;
      if (detail?.text !== undefined) {
        setValue(detail.text);
        dispatch(clearDraftAttachments(draftKey));
        setImageVisionHint(false);
      } else if (shouldClear) {
        setValue('');
        dispatch(clearDraftAttachments(draftKey));
        setImageVisionHint(false);
      }
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    };
    window.addEventListener('cowork:focus-input', handleFocusInput);
    return () => {
      window.removeEventListener('cowork:focus-input', handleFocusInput);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
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
    modelPatchRequestIdRef.current += 1;
    setIsPatchingModel(false);
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

  const handleSubmit = useCallback(async () => {
    if (showFolderSelector && !workingDirectory?.trim()) {
      setShowFolderRequiredWarning(true);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      warningTimerRef.current = setTimeout(() => {
        setShowFolderRequiredWarning(false);
        warningTimerRef.current = null;
      }, 3000);
      return;
    }

    const trimmedValue = value.trim();
    if ((!trimmedValue && attachments.length === 0) || isStreaming || disabled || isPatchingModel) return;
    setShowFolderRequiredWarning(false);

    // Get active skills prompts and combine them
    const activeSkills = activeSkillIds
      .map(id => skills.find(s => s.id === id))
      .filter((s): s is Skill => s !== undefined);
    const skillPrompt = activeSkills.length > 0
      ? activeSkills.map(buildInlinedSkillPrompt).join('\n\n')
      : undefined;

    // Extract image attachments (with base64 data) for vision-capable models
    console.log('[CoworkPromptInput] handleSubmit: attachment diagnosis', {
      totalAttachments: attachments.length,
      modelSupportsImage,
      effectiveModelId: effectiveSelectedModel?.id ?? null,
      attachmentDetails: attachments.map(a => ({
        path: a.path,
        name: a.name,
        isImage: a.isImage,
        hasDataUrl: !!a.dataUrl,
        dataUrlLength: a.dataUrl?.length ?? 0,
      })),
    });
    const imageAtts: CoworkImageAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.isImage && attachment.dataUrl) {
        const extracted = extractBase64FromDataUrl(attachment.dataUrl);
        if (extracted) {
          imageAtts.push({
            name: attachment.name,
            mimeType: extracted.mimeType,
            base64Data: extracted.base64Data,
          });
        } else {
          console.warn('[CoworkPromptInput] handleSubmit: extractBase64FromDataUrl returned null', {
            name: attachment.name,
            dataUrlPrefix: attachment.dataUrl.slice(0, 60),
          });
        }
      } else if (attachment.isImage) {
        console.warn('[CoworkPromptInput] handleSubmit: image attachment missing dataUrl', {
          path: attachment.path,
          name: attachment.name,
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
    const finalPrompt = trimmedValue
      ? (attachmentLines ? `${trimmedValue}\n\n${attachmentLines}` : trimmedValue)
      : attachmentLines;

    if (imageAtts.length > 0) {
      console.log('[CoworkPromptInput] handleSubmit: passing imageAtts to onSubmit', {
        count: imageAtts.length,
        names: imageAtts.map(a => a.name),
        base64Lengths: imageAtts.map(a => a.base64Data.length),
      });
    } else if (attachments.some(a => a.isImage || isImagePath(a.path))) {
      console.warn('[CoworkPromptInput] handleSubmit: has image-like attachments but imageAtts is EMPTY — images will NOT be sent as base64', {
        imageAttachments: attachments.filter(a => a.isImage || isImagePath(a.path)).map(a => ({
          path: a.path,
          isImage: a.isImage,
          hasDataUrl: !!a.dataUrl,
        })),
      });
    }
    const result = await onSubmit(finalPrompt, skillPrompt, imageAtts.length > 0 ? imageAtts : undefined);
    if (result === false) return;
    setValue('');
    dispatch(setDraftPrompt({ sessionId: draftKey, draft: '' }));
    dispatch(clearDraftAttachments(draftKey));
    setImageVisionHint(false);
  }, [value, isStreaming, disabled, isPatchingModel, onSubmit, activeSkillIds, skills, attachments, showFolderSelector, workingDirectory, dispatch, draftKey, effectiveSelectedModel?.id, modelSupportsImage]);

  const handleSelectSkill = useCallback((skill: Skill) => {
    dispatch(toggleActiveSkill(skill.id));
  }, [dispatch]);

  const handleManageSkills = useCallback(() => {
    if (onManageSkills) {
      onManageSkills();
    }
  }, [onManageSkills]);

  const handleSelectAgent = useCallback((agentId: string) => {
    if (!agentId || agentId === currentAgentId) {
      setShowAgentMenu(false);
      return;
    }
    agentService.switchAgent(agentId);
    setShowAgentMenu(false);
  }, [currentAgentId]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (event.key !== 'Enter' || isComposing) return;

    // Use synced state (kept up-to-date via config-updated event) so that
    // changes made in the Settings panel are reflected immediately without
    // requiring a configService read at event time.
    const sendKey = currentSendShortcut;

    let isSendCombo = false;
    switch (sendKey) {
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

    if (isSendCombo && !isStreaming && !disabled && !isPatchingModel) {
      event.preventDefault();
      handleSubmit();
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
    if (onStop) {
      onStop();
    }
  };

  const containerClass = isLarge
    ? useHomeContextLayout
      ? 'relative rounded-2xl'
      : `relative rounded-2xl border border-border bg-surface ${showReadOnlyContext ? '' : 'shadow-card'}`
    : 'relative flex items-end gap-2 p-3 rounded-xl border border-border bg-surface';

  const textareaClass = isLarge
    ? `w-full resize-none bg-transparent px-4 pb-2 text-foreground placeholder:dark:text-foregroundSecondary/60 placeholder:text-secondary/60 focus:outline-none min-h-[${minHeight}px] max-h-[${maxHeight}px] ${
      useHomeContextLayout
        ? 'pt-3 text-[14px] leading-[22px]'
        : 'pt-2.5 text-[15px] leading-[23px]'
    }`
    : 'flex-1 resize-none bg-transparent text-foreground placeholder:placeholder:text-secondary focus:outline-none text-sm leading-relaxed min-h-[24px] max-h-[200px]';

  const truncatePath = (path: string, maxLength: number = ContextLabelMaxLength.DefaultFolder): string => {
    if (!path) return i18nService.t('noFolderSelected');
    const folderName = getCompactFolderName(path) || i18nService.t('noFolderSelected');
    return truncateDisplayText(folderName, maxLength);
  };

  const hasWorkingDirectory = workingDirectory.trim().length > 0;

  const handleFolderSelect = (path: string) => {
    if (onWorkingDirectoryChange) {
      onWorkingDirectoryChange(path);
    }
  };

  const handleOpenWorkingDirectory = useCallback(async () => {
    const path = workingDirectory.trim();
    if (!path) return;

    try {
      const result = await window.electron.shell.openPath(path);
      if (!result?.success) {
        console.error('[CoworkPromptInput] failed to open folder:', result?.error);
      }
    } catch (error) {
      console.error('[CoworkPromptInput] failed to open folder:', error);
    }
  }, [workingDirectory]);

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

  const handleIncomingFiles = useCallback(async (fileList: FileList | File[]) => {
    if (disabled || isStreaming) return;
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    let hasImageWithoutVision = false;
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
  }, [addAttachment, addImageAttachmentFromDataUrl, disabled, effectiveSelectedModel, fileToDataUrl, getNativeFilePath, isStreaming, modelSupportsImage, saveInlineFile]);

  const handleAddFile = useCallback(async () => {
    if (isAddingFile || disabled || isStreaming) return;
    setIsAddingFile(true);
    try {
      const result = await window.electron.dialog.selectFiles({
        title: i18nService.t('coworkAddFile'),
      });
      if (!result.success || result.paths.length === 0) return;
      let hasImageWithoutVision = false;
      for (const filePath of result.paths) {
        if (isImagePath(filePath)) {
          if (modelSupportsImage) {
            try {
              const readResult = await window.electron.dialog.readFileAsDataUrl(filePath);
              if (readResult.success && readResult.dataUrl) {
                console.log('[CoworkPromptInput] handleAddFile: image read OK', { filePath, dataUrlLength: readResult.dataUrl.length });
                addAttachment(filePath, { isImage: true, dataUrl: readResult.dataUrl });
                continue;
              }
              console.warn('[CoworkPromptInput] handleAddFile: readFileAsDataUrl returned falsy', { filePath });
            } catch (error) {
              console.error('Failed to read image as data URL:', error);
            }
          } else {
            console.warn('[CoworkPromptInput] handleAddFile: image skipped vision path because modelSupportsImage=false', {
              filePath,
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
    } catch (error) {
      console.error('Failed to select file:', error);
    } finally {
      setIsAddingFile(false);
    }
  }, [addAttachment, effectiveSelectedModel, isAddingFile, disabled, isStreaming, modelSupportsImage]);

  const handleRemoveAttachment = useCallback((path: string) => {
    dispatch(setDraftAttachments({
      draftKey,
      attachments: attachments.filter((attachment) => attachment.path !== path),
    }));
  }, [attachments, dispatch, draftKey]);

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
    event.dataTransfer.dropEffect = disabled || isStreaming ? 'none' : 'copy';
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
    if (disabled || isStreaming) return;
    void handleIncomingFiles(event.dataTransfer.files);
  };

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || isStreaming) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void handleIncomingFiles(files);
  }, [disabled, handleIncomingFiles, isStreaming]);

  const canSubmit = !disabled && !isPatchingModel && !agentModelIsInvalid && (!!value.trim() || attachments.length > 0);
  const enhancedContainerClass = isDraggingFiles
    ? `${containerClass} ring-2 ring-primary/50 border-primary/60`
    : containerClass;

  const [currentSendShortcut, setCurrentSendShortcut] = useState(
    () => configService.getConfig().shortcuts?.sendMessage ?? 'Enter'
  );
  const sendButtonTitle = `${i18nService.t('sendMessage')} (${getSendShortcutLabel(currentSendShortcut)})`;
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
        disabled={isPatchingModel || isPersistingAgentModel}
        value={agentModelIsInvalid && currentSession?.modelOverride
          ? { id: '__invalid__', name: currentSession.modelOverride.split('/').pop() || currentSession.modelOverride } as Model
          : agentSelectedModel}
        onChange={async (nextModel) => {
          if (isPatchingModel || isPersistingAgentModel) return;
          if (!nextModel) return;
          const modelRef = toOpenClawModelRef(nextModel);
          if (sessionId) {
            const requestId = modelPatchRequestIdRef.current + 1;
            modelPatchRequestIdRef.current = requestId;
            const previousModelOverride = currentSession?.id === sessionId
              ? currentSession.modelOverride
              : '';

            setIsPatchingModel(true);
            dispatch(updateCurrentSessionModelOverride({ sessionId, modelOverride: modelRef }));

            try {
              const patchedSession = await coworkService.patchSession(sessionId, { model: modelRef });
              if (requestId !== modelPatchRequestIdRef.current) return;

              if (!patchedSession) {
                dispatch(updateCurrentSessionModelOverride({
                  sessionId,
                  modelOverride: previousModelOverride,
                }));
                window.dispatchEvent(new CustomEvent('app:showToast', {
                  detail: i18nService.t('coworkModelSwitchFailed'),
                }));
                return;
              }

              if (currentAgent && agentModelIsInvalid) {
                void agentService.updateAgent(currentAgent.id, { model: modelRef });
              }
            } catch {
              if (requestId === modelPatchRequestIdRef.current) {
                dispatch(updateCurrentSessionModelOverride({
                  sessionId,
                  modelOverride: previousModelOverride,
                }));
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
          await persistAgentModelSelection(nextModel);
        }}
      />
      {agentModelIsInvalid && (
        <span className="max-w-60 text-[11px] leading-4 text-red-500">
          {i18nService.t('agentModelInvalidHint')}
        </span>
      )}
    </div>
  ) : null;

  const largeInputActions = !remoteManaged ? (
    <>
      <button
        type="button"
        onClick={handleAddFile}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
        title={i18nService.t('coworkAddFile')}
        aria-label={i18nService.t('coworkAddFile')}
        disabled={disabled || isStreaming || isAddingFile}
      >
        <PaperClipIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={handleVoiceInput}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
        title={i18nService.t('voiceInput')}
        aria-label={i18nService.t('voiceInput')}
        disabled={disabled || isStreaming}
      >
        <MicrophoneIcon className="h-4 w-4" />
      </button>
      <SkillsButton
        onSelectSkill={handleSelectSkill}
        onManageSkills={handleManageSkills}
      />
      <ActiveSkillBadge />
    </>
  ) : null;

  const largeSendButton = isStreaming ? (
    <button
      type="button"
      onClick={handleStopClick}
      className="p-2 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
      aria-label="Stop"
    >
      <StopIcon className="h-5 w-5" />
    </button>
  ) : (
    <button
      type="button"
      onClick={handleSubmit}
      disabled={!canSubmit}
      className={`flex h-8 w-8 items-center justify-center rounded-full transition-all ${
        canSubmit
          ? 'bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800 active:scale-95 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200'
          : 'cursor-not-allowed bg-neutral-300 text-white dark:bg-neutral-700 dark:text-neutral-500'
      }`}
      aria-label={i18nService.t('sendMessage')}
      title={sendButtonTitle}
    >
      <ArrowUpIcon className="h-[18px] w-[18px]" />
    </button>
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

  return (
    <div className="relative">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 max-h-[136px] overflow-y-auto">
          {attachments.map((attachment) => (
            <AttachmentCard
              key={attachment.path}
              attachment={attachment}
              onRemove={handleRemoveAttachment}
            />
          ))}
        </div>
      )}
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
              <div className="relative z-10 rounded-2xl border border-border bg-surface shadow-card">
                <textarea
                  ref={textareaRef}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={placeholder}
                  disabled={disabled}
                  rows={2}
                  className={textareaClass}
                  style={{ minHeight: `${minHeight}px` }}
                />
                <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
                  <div className="flex min-w-0 items-center gap-2">
                    {largeInputActions}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {largeModelSelector}
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
                      onClick={() => setShowFolderMenu(!showFolderMenu)}
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
                    onClick={() => setShowAgentMenu(!showAgentMenu)}
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
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={placeholder}
                disabled={disabled}
                rows={2}
                className={textareaClass}
                style={{ minHeight: `${minHeight}px` }}
              />
              <div className="flex items-center justify-between px-4 pb-2 pt-1.5">
                <div className="flex items-center gap-2 relative">
                  {showFolderSelector && (
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
                  {largeModelSelector}
                  {largeInputActions}
                </div>
                <div className="flex items-center gap-2">
                  {largeSendButton}
                </div>
              </div>
            </>
          )
        ) : (
          <>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className={textareaClass}
            />

            {!remoteManaged && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleAddFile}
                  className="flex-shrink-0 p-1.5 rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                  title={i18nService.t('coworkAddFile')}
                  aria-label={i18nService.t('coworkAddFile')}
                  disabled={disabled || isStreaming || isAddingFile}
                >
                  <PaperClipIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={handleVoiceInput}
                  className="flex-shrink-0 p-1.5 rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                  title={i18nService.t('voiceInput')}
                  aria-label={i18nService.t('voiceInput')}
                  disabled={disabled || isStreaming}
                >
                  <MicrophoneIcon className="h-4 w-4" />
                </button>
              </div>
            )}

            {isStreaming ? (
              <button
                type="button"
                onClick={handleStopClick}
                className="flex-shrink-0 p-2 rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                aria-label="Stop"
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
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
            )}
          </>
        )}
      </div>
      {readOnlyContextRow}
    </div>
  );
  }
);

CoworkPromptInput.displayName = 'CoworkPromptInput';

export default CoworkPromptInput;
