import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { PaperAirplaneIcon, StopIcon, FolderIcon } from '@heroicons/react/24/solid';
import { PhotoIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import PaperClipIcon from '../icons/PaperClipIcon';
import XMarkIcon from '../icons/XMarkIcon';
import ModelSelector from '../ModelSelector';
import FolderSelectorPopover from './FolderSelectorPopover';
import CoworkImageLightbox from './CoworkImageLightbox';
import { createAttachmentMentionItem } from './mentions/attachmentMentions';
import type { AttachmentMentionItem } from './mentions/types';
import { SkillsButton, ActiveSkillBadge } from '../skills';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setDraftPrompt } from '../../store/slices/coworkSlice';
import { setSkills, toggleActiveSkill, setActiveSkillIds } from '../../store/slices/skillSlice';
import { selectAction, selectPrompt } from '../../store/slices/quickActionSlice';
import { Skill } from '../../types/skill';
import { CoworkImageAttachment } from '../../types/cowork';
import { getCompactFolderName } from '../../utils/path';
import { buildComposerPrompt, buildDraftTextFromDoc } from './composer/promptSerializer';
import { createSkillMentionItem, buildSlashCommandItems, type ComposerResourceItem, type SkillMentionItem } from './composer/types';
import { ResourceMention } from './composer/resourceMention';
import { SlashCommand } from './composer/slashCommand';

type CoworkAttachment = AttachmentMentionItem;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

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

const createDocFromText = (value: string): JSONContent => {
  const normalized = value.replace(/\r\n/g, '\n');
  const paragraphs = normalized.split(/\n{2,}/);
  return {
    type: 'doc',
    content: paragraphs.map((paragraph) => {
      const lines = paragraph.split('\n');
      const content: JSONContent[] = [];
      lines.forEach((line, index) => {
        if (line) {
          content.push({ type: 'text', text: line });
        }
        if (index < lines.length - 1) {
          content.push({ type: 'hardBreak' });
        }
      });
      return {
        type: 'paragraph',
        content,
      };
    }),
  };
};

const removeAttachmentMentionsFromEditor = (
  editor: NonNullable<ReturnType<typeof useEditor>>,
  attachmentId: string,
) => {
  const positions: number[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (
      node.type.name === 'resourceMention'
      && node.attrs.kind === 'attachment'
      && node.attrs.resourceId === attachmentId
    ) {
      positions.push(pos);
    }
  });

  if (positions.length === 0) {
    return;
  }

  const tr = editor.state.tr;
  positions.reverse().forEach((pos) => {
    const node = tr.doc.nodeAt(pos);
    if (!node) {
      return;
    }

    let from = pos;
    let to = pos + node.nodeSize;
    const nextCharacter = tr.doc.textBetween(to, to + 1, '', '');
    const previousCharacter = tr.doc.textBetween(Math.max(0, from - 1), from, '', '');

    if (nextCharacter === ' ') {
      to += 1;
    } else if (previousCharacter === ' ') {
      from -= 1;
    }

    tr.delete(from, to);
  });

  editor.view.dispatch(tr);
};

export interface CoworkPromptInputRef {
  setValue: (value: string) => void;
  focus: () => void;
}

interface CoworkPromptInputProps {
  onSubmit: (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  size?: 'normal' | 'large';
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  showModelSelector?: boolean;
  onManageSkills?: () => void;
  enableMentions?: boolean;
  sessionId?: string;
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
      onManageSkills,
      enableMentions = true,
      sessionId = '',
    } = props;

    const dispatch = useDispatch();
    const draftPrompt = useSelector((state: RootState) => state.cowork.draftPrompts[sessionId] ?? '');
    const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
    const skills = useSelector((state: RootState) => state.skill.skills);
    const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
    const quickActions = useSelector((state: RootState) => state.quickAction.actions);

    const [attachments, setAttachments] = useState<CoworkAttachment[]>([]);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [isAddingFile, setIsAddingFile] = useState(false);
    const [imageVisionHint, setImageVisionHint] = useState(false);
    const [expandedImage, setExpandedImage] = useState<{ src: string; alt: string } | null>(null);
    const [draftText, setDraftText] = useState(draftPrompt);
    const [isEditorEmpty, setIsEditorEmpty] = useState(!draftPrompt.trim());

    const attachmentsRef = useRef<CoworkAttachment[]>([]);
    const activeSkillIdsRef = useRef<string[]>(activeSkillIds);
    const skillsRef = useRef<Skill[]>(skills);
    const disabledRef = useRef(disabled);
    const isStreamingRef = useRef(isStreaming);
    const showFolderSelectorRef = useRef(showFolderSelector);
    const workingDirectoryRef = useRef(workingDirectory);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const dragDepthRef = useRef(0);
    const nextClipboardImageIndexRef = useRef(1);
    const usedMentionTokensRef = useRef<Set<string>>(new Set());
    const handleSubmitRef = useRef<() => void>(() => {});

    const isLarge = size === 'large';
    const selectedModelSupportsImage = !!selectedModel?.supportsImage;
    const modelSupportsImageRef = useRef(selectedModelSupportsImage);

    const skillMentionItems = useMemo(
      () => skills.filter((skill) => skill.enabled).map(createSkillMentionItem),
      [skills],
    );
    const skillMentionItemsRef = useRef<SkillMentionItem[]>(skillMentionItems);
    const slashItems = useMemo(() => buildSlashCommandItems(quickActions), [quickActions]);
    const slashItemsRef = useRef(slashItems);
    const getResourceItems = useCallback((query: string): ComposerResourceItem[] => {
      if (!enableMentions) {
        return [];
      }
      const normalizedQuery = query.trim().toLowerCase();
      const attachmentItems = attachmentsRef.current;
      const allItems: ComposerResourceItem[] = [...attachmentItems, ...skillMentionItemsRef.current];

      if (!normalizedQuery) {
        return allItems.slice(0, 8);
      }

      return allItems
        .filter((item) => item.searchText.some((text) => text.toLowerCase().includes(normalizedQuery)))
        .slice(0, 8);
    }, [enableMentions]);

    const getSlashItems = useCallback((query: string) => {
      const normalizedQuery = query.trim().toLowerCase();
      const items = slashItemsRef.current;
      if (!normalizedQuery) {
        return items.slice(0, 8);
      }
      return items.filter((item) =>
        item.searchText.some((text) => text.toLowerCase().includes(normalizedQuery)),
      ).slice(0, 8);
    }, []);

    const starterKitExtension = useMemo(() => StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      code: false,
      heading: false,
      horizontalRule: false,
      orderedList: false,
      strike: false,
    }), []);
    const resourceMentionExtension = useMemo(() => ResourceMention.configure({
      emptyText: i18nService.t('coworkMentionNoResults'),
      suggestion: {
        char: '@',
        allowSpaces: false,
        items: ({ query }) => getResourceItems(query),
        command: ({ props: item }) => {
          if (item.kind === 'skill' && !activeSkillIdsRef.current.includes(item.skillId)) {
            dispatch(toggleActiveSkill(item.skillId));
          }
        },
      },
    }), [dispatch, getResourceItems]);
    const slashCommandExtension = useMemo(() => SlashCommand.configure({
      emptyText: i18nService.t('coworkSlashNoResults'),
      suggestion: {
        char: '/',
        allowSpaces: true,
        startOfLine: false,
        items: ({ query }) => getSlashItems(query),
        command: ({ props: item }) => {
          dispatch(selectAction(item.actionId));
          dispatch(selectPrompt(item.promptId));
          if (item.skillMapping && skillsRef.current.some((skill) => skill.id === item.skillMapping)) {
            dispatch(setActiveSkillIds([item.skillMapping]));
          }
        },
      },
    }), [dispatch, getSlashItems]);
    const editorExtensions = useMemo(
      () => [starterKitExtension, resourceMentionExtension, slashCommandExtension],
      [resourceMentionExtension, slashCommandExtension, starterKitExtension],
    );
    const editorContentClassName = useMemo(
      () => (isLarge
        ? 'min-h-[60px] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words px-4 pt-2.5 pb-2 text-[15px] leading-6 text-claude-text dark:text-claude-darkText focus:outline-none'
        : 'min-h-[24px] max-h-[200px] flex-1 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-claude-text dark:text-claude-darkText focus:outline-none'),
      [isLarge],
    );

    useEffect(() => {
      attachmentsRef.current = attachments;
    }, [attachments]);

    useEffect(() => {
      activeSkillIdsRef.current = activeSkillIds;
    }, [activeSkillIds]);

    useEffect(() => {
      skillsRef.current = skills;
    }, [skills]);

    useEffect(() => {
      skillMentionItemsRef.current = skillMentionItems;
    }, [skillMentionItems]);

    useEffect(() => {
      slashItemsRef.current = slashItems;
    }, [quickActions, slashItems]);

    useEffect(() => {
      disabledRef.current = disabled;
      isStreamingRef.current = isStreaming;
      showFolderSelectorRef.current = showFolderSelector;
      workingDirectoryRef.current = workingDirectory;
      modelSupportsImageRef.current = selectedModelSupportsImage;
    }, [disabled, isStreaming, selectedModelSupportsImage, showFolderSelector, workingDirectory]);

    const editor = useEditor({
      immediatelyRender: true,
      extensions: editorExtensions,
      content: createDocFromText(draftPrompt),
      editorProps: {
        attributes: {
          class: editorContentClassName,
        },
        handleKeyDown: (_view, event) => {
          if (event.isComposing || event.keyCode === 229) {
            return false;
          }

          const activeTrigger = (editor?.storage as unknown as Record<string, unknown> | undefined)?.__composerTrigger;
          if (event.key === 'Enter' && activeTrigger) {
            return false;
          }

          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            editor?.commands.setHardBreak();
            return true;
          }

          if (event.key === 'Enter' && !event.shiftKey && !disabledRef.current && !isStreamingRef.current) {
            event.preventDefault();
            handleSubmitRef.current();
            return true;
          }

          return false;
        },
        handlePaste: (_view, event) => {
          if (disabledRef.current || isStreamingRef.current) {
            return false;
          }
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0) {
            return false;
          }
          event.preventDefault();
          void handleIncomingFiles(files);
          return true;
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        const doc = currentEditor.getJSON();
        const nextDraftText = buildDraftTextFromDoc(doc);
        setDraftText(nextDraftText);
        setIsEditorEmpty(currentEditor.isEmpty);
      },
    }, [editorContentClassName, editorExtensions]);

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

    useEffect(() => {
      if (!editor) {
        return;
      }

      if (draftPrompt === draftText) {
        return;
      }

      const timer = setTimeout(() => {
        dispatch(setDraftPrompt({ sessionId, draft: draftText }));
      }, 300);

      return () => clearTimeout(timer);
    }, [dispatch, draftPrompt, draftText, editor]);

    useEffect(() => {
      if (workingDirectory?.trim()) {
        setShowFolderRequiredWarning(false);
      }
    }, [workingDirectory]);

    useEffect(() => {
      const handleFocusInput = (event: Event) => {
        const detail = (event as CustomEvent<{ clear?: boolean }>).detail;
        const shouldClear = detail?.clear ?? true;
        if (shouldClear) {
          editor?.commands.clearContent(true);
          attachmentsRef.current = [];
          setAttachments([]);
          setExpandedImage(null);
          setImageVisionHint(false);
          setDraftText('');
          setIsEditorEmpty(true);
          nextClipboardImageIndexRef.current = 1;
          usedMentionTokensRef.current = new Set();
        }
        requestAnimationFrame(() => {
          editor?.commands.focus('end');
        });
      };

      window.addEventListener('cowork:focus-input', handleFocusInput);
      return () => {
        window.removeEventListener('cowork:focus-input', handleFocusInput);
      };
    }, [editor]);

    React.useImperativeHandle(ref, () => ({
      setValue: (newValue: string) => {
        editor?.commands.setContent(createDocFromText(newValue), { emitUpdate: false });
        setDraftText(newValue);
        setIsEditorEmpty(!newValue.trim());
      },
      focus: () => {
        editor?.commands.focus('end');
      },
    }), [editor]);

    const handleSubmit = useCallback(() => {
      if (!editor) {
        return;
      }

      if (showFolderSelectorRef.current && !workingDirectoryRef.current?.trim()) {
        setShowFolderRequiredWarning(true);
        return;
      }

      const currentDoc = editor.getJSON();
      const { prompt: finalPrompt, skillIds } = buildComposerPrompt({
        doc: currentDoc,
        attachments: attachmentsRef.current,
        skills: skillMentionItemsRef.current,
        inputFileLabel: i18nService.t('coworkInputFileLabel'),
        attachmentSectionTitle: i18nService.t('coworkAttachmentReferencesTitle'),
        skillSectionTitle: i18nService.t('coworkSkillReferencesTitle'),
        clipboardImageDescription: i18nService.t('coworkAttachmentReferenceClipboardDescription'),
        imageDescription: i18nService.t('coworkAttachmentReferenceImageDescription'),
        fileDescription: i18nService.t('coworkAttachmentReferenceFileDescription'),
      });

      if ((!finalPrompt.trim() && attachmentsRef.current.length === 0) || isStreamingRef.current || disabledRef.current) {
        return;
      }

      setShowFolderRequiredWarning(false);

      const imageAtts: CoworkImageAttachment[] = [];
      for (const attachment of attachmentsRef.current) {
        if (modelSupportsImageRef.current && attachment.isImage && attachment.dataUrl) {
          const extracted = extractBase64FromDataUrl(attachment.dataUrl);
          if (extracted) {
            imageAtts.push({
              name: attachment.label,
              mimeType: extracted.mimeType,
              base64Data: extracted.base64Data,
            });
          }
        }
      }

      const effectiveSkillIds = Array.from(new Set([...activeSkillIdsRef.current, ...skillIds]));
      const activeSkills = effectiveSkillIds
        .map((id) => skillsRef.current.find((skill) => skill.id === id))
        .filter((skill): skill is Skill => skill !== undefined);
      const skillPrompt = activeSkills.length > 0
        ? activeSkills.map(buildInlinedSkillPrompt).join('\n\n')
        : undefined;

      onSubmit(finalPrompt, skillPrompt, imageAtts.length > 0 ? imageAtts : undefined);

      editor.commands.clearContent(true);
      attachmentsRef.current = [];
      dispatch(setDraftPrompt({ sessionId, draft: '' }));
      setDraftText('');
      setIsEditorEmpty(true);
      setAttachments([]);
      setImageVisionHint(false);
      setExpandedImage(null);
      nextClipboardImageIndexRef.current = 1;
      usedMentionTokensRef.current = new Set();
    }, [dispatch, editor, onSubmit]);

    handleSubmitRef.current = handleSubmit;

    const handleStopClick = () => {
      if (onStop) {
        onStop();
      }
    };

    const truncatePath = (path: string, maxLength = 30): string => {
      if (!path) return i18nService.t('noFolderSelected');
      return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
    };

    const handleFolderSelect = (path: string) => {
      if (onWorkingDirectoryChange) {
        onWorkingDirectoryChange(path);
      }
    };

    const createLocalAttachment = useCallback((params: {
      path: string;
      name: string;
      isImage?: boolean;
      dataUrl?: string;
      sourceKindOverride?: CoworkAttachment['sourceKind'];
    }): CoworkAttachment => {
      const existingAttachments = attachmentsRef.current;
      const isClipboardImage = params.sourceKindOverride === 'clipboard_image' || (params.isImage && params.path.startsWith('inline:'));
      const clipboardImageIndex = isClipboardImage ? nextClipboardImageIndexRef.current++ : undefined;
      const nextAttachment = createAttachmentMentionItem({
        path: params.path,
        name: params.name,
        isImage: params.isImage,
        dataUrl: params.dataUrl,
        clipboardImageIndex,
        existingItems: existingAttachments,
        reservedMentionTokens: Array.from(usedMentionTokensRef.current),
        sourceKindOverride: params.sourceKindOverride,
      });
      usedMentionTokensRef.current.add(nextAttachment.mentionToken);
      return nextAttachment;
    }, []);

    const addAttachment = useCallback((filePath: string, imageInfo?: {
      isImage: boolean;
      dataUrl?: string;
      sourceKindOverride?: CoworkAttachment['sourceKind'];
    }) => {
      if (!filePath) {
        return;
      }
      if (attachmentsRef.current.some((attachment) => attachment.path === filePath)) {
        return;
      }

      const nextAttachment = createLocalAttachment({
        path: filePath,
        name: getFileNameFromPath(filePath),
        isImage: imageInfo?.isImage,
        dataUrl: imageInfo?.dataUrl,
        sourceKindOverride: imageInfo?.sourceKindOverride,
      });

      const nextAttachments = [...attachmentsRef.current, nextAttachment];
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
    }, [createLocalAttachment]);

    const addImageAttachmentFromDataUrl = useCallback((name: string, dataUrl: string) => {
      const pseudoPath = `inline:${name}:${Date.now()}`;
      const nextAttachment = createLocalAttachment({
        path: pseudoPath,
        name,
        isImage: true,
        dataUrl,
      });

      const nextAttachments = [...attachmentsRef.current, nextAttachment];
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
    }, [createLocalAttachment]);

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
          cwd: workingDirectoryRef.current,
        });
        if (result.success && result.path) {
          return result.path;
        }
        return null;
      } catch (error) {
        console.error('Failed to save inline file:', error);
        return null;
      }
    }, [fileToBase64]);

    const handleIncomingFiles = useCallback(async (fileList: FileList | File[]) => {
      if (disabledRef.current || isStreamingRef.current) return;
      const files = Array.from(fileList ?? []);
      if (files.length === 0) return;

      let hasImageWithoutVision = false;
      for (const file of files) {
        const nativePath = getNativeFilePath(file);
        const fileIsImage = nativePath ? isImagePath(nativePath) : isImageMimeType(file.type);

        if (fileIsImage) {
          let imageDataUrl: string | undefined;
          if (nativePath) {
            try {
              const result = await window.electron.dialog.readFileAsDataUrl(nativePath);
              if (result.success && result.dataUrl) {
                imageDataUrl = result.dataUrl;
              }
            } catch (error) {
              console.error('Failed to read image as data URL:', error);
            }
          } else {
            try {
              imageDataUrl = await fileToDataUrl(file);
            } catch (error) {
              console.error('Failed to read image from clipboard:', error);
            }
          }

          if (modelSupportsImageRef.current) {
            if (nativePath) {
              addAttachment(nativePath, { isImage: true, dataUrl: imageDataUrl });
            } else if (imageDataUrl) {
              addImageAttachmentFromDataUrl(file.name, imageDataUrl);
            } else {
              const stagedPath = await saveInlineFile(file);
              if (stagedPath) {
                addAttachment(stagedPath, {
                  isImage: true,
                  sourceKindOverride: 'clipboard_image',
                });
              }
            }
            continue;
          }

          hasImageWithoutVision = true;
          if (nativePath) {
            addAttachment(nativePath, { isImage: true, dataUrl: imageDataUrl });
            continue;
          }

          const stagedPath = await saveInlineFile(file);
          if (stagedPath) {
            addAttachment(stagedPath, {
              isImage: true,
              dataUrl: imageDataUrl,
              sourceKindOverride: 'clipboard_image',
            });
          }
          continue;
        }

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
    }, [addAttachment, addImageAttachmentFromDataUrl, fileToDataUrl, getNativeFilePath, saveInlineFile]);

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
            let imageDataUrl: string | undefined;
            try {
              const readResult = await window.electron.dialog.readFileAsDataUrl(filePath);
              if (readResult.success && readResult.dataUrl) {
                imageDataUrl = readResult.dataUrl;
              }
            } catch (error) {
              console.error('Failed to read image as data URL:', error);
            }

            if (!selectedModelSupportsImage) {
              hasImageWithoutVision = true;
            }

            addAttachment(filePath, { isImage: true, dataUrl: imageDataUrl });
            continue;
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
    }, [addAttachment, disabled, isAddingFile, isStreaming, selectedModelSupportsImage]);

    const handleSelectSkill = useCallback((skill: Skill) => {
      dispatch(toggleActiveSkill(skill.id));
    }, [dispatch]);

    const handleManageSkills = useCallback(() => {
      if (onManageSkills) {
        onManageSkills();
      }
    }, [onManageSkills]);

    const handleRemoveAttachment = useCallback((attachment: CoworkAttachment) => {
      const nextAttachments = attachmentsRef.current.filter((item) => item.path !== attachment.path);
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);

      if (attachment.isImage && expandedImage?.alt === attachment.label) {
        setExpandedImage(null);
      }

      if (editor) {
        removeAttachmentMentionsFromEditor(editor, attachment.mentionId);
      }
    }, [editor, expandedImage]);

    const containerClass = isLarge
      ? 'relative rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-card focus-within:shadow-elevated focus-within:ring-1 focus-within:ring-claude-accent/40 focus-within:border-claude-accent'
      : 'relative flex items-end gap-2 p-3 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface';

    const editorClass = isLarge ? 'w-full' : 'flex-1';
    const enhancedContainerClass = isDraggingFiles
      ? `${containerClass} ring-2 ring-claude-accent/50 border-claude-accent/60`
      : containerClass;

    const canSubmit = !disabled && (!!draftText.trim() || attachments.length > 0);

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

    return (
      <div className="relative">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.mentionId}
                className={`group inline-flex max-w-full items-center gap-1 rounded-full border py-1 text-xs dark:text-claude-darkText text-claude-text transition-colors ${
                  attachment.isImage
                    ? 'px-1.5 dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface hover:border-claude-accent/50 dark:hover:border-claude-accent/50'
                    : 'gap-1.5 px-2.5 dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface'
                }`}
                title={attachment.path}
              >
                {attachment.isImage ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (!attachment.dataUrl) return;
                      setExpandedImage({ src: attachment.dataUrl, alt: attachment.label });
                    }}
                    className={`inline-flex min-w-0 items-center gap-2 rounded-full pr-1 transition-all ${
                      attachment.dataUrl
                        ? 'cursor-pointer hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                        : 'cursor-default'
                    }`}
                    disabled={!attachment.dataUrl}
                  >
                    {attachment.dataUrl ? (
                      <span className="flex h-8 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-black/5 transition-transform transition-colors group-hover:border-claude-accent/50 dark:border-claude-darkBorder/50 border-claude-border/50 dark:bg-white/5 group-hover:scale-[1.02]">
                        <img
                          src={attachment.dataUrl}
                          alt={attachment.label}
                          className="h-full w-full object-contain"
                        />
                      </span>
                    ) : (
                      <PhotoIcon className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" />
                    )}
                    <span className="truncate max-w-[180px]">{attachment.label}</span>
                  </button>
                ) : (
                  <>
                    <PaperClipIcon className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="truncate max-w-[180px]">{attachment.label}</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(attachment)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('coworkAttachmentRemove')}
                  title={i18nService.t('coworkAttachmentRemove')}
                >
                  <XMarkIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {imageVisionHint && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <ExclamationTriangleIcon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>
              {i18nService.getLanguage() === 'zh'
                ? '当前模型未启用图片输入，图片将以文件路径形式发送。若该模型本身支持图片理解，可在模型配置中开启图片输入选项。'
                : 'Image input is not enabled for the current model. Images will be sent as file paths. If the model supports vision, you can enable image input in the model configuration.'}
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
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-claude-accent/10 text-xs font-medium text-claude-accent">
              {i18nService.t('coworkDropFileHint')}
            </div>
          )}
          {isLarge ? (
            <>
              <div className={editorClass}>
                {editor && (
                  <div className="relative">
                    {isEditorEmpty && (
                      <div className="pointer-events-none absolute left-4 top-2.5 text-[15px] leading-6 text-claude-textSecondary/60 dark:text-claude-darkTextSecondary/60">
                        {placeholder}
                      </div>
                    )}
                    <EditorContent editor={editor} />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between px-4 pb-2 pt-1.5">
                <div className="flex items-center gap-2 relative">
                  {showFolderSelector && (
                    <>
                      <div className="relative group">
                        <button
                          ref={folderButtonRef}
                          type="button"
                          onClick={() => setShowFolderMenu(!showFolderMenu)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                        >
                          <FolderIcon className="h-4 w-4" />
                          <span className="max-w-[150px] truncate text-xs">
                            {truncatePath(workingDirectory)}
                          </span>
                        </button>
                        {!showFolderMenu && (
                          <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none z-50 max-w-[400px] break-all whitespace-nowrap">
                            {truncatePath(workingDirectory, 120)}
                          </div>
                        )}
                      </div>
                      <FolderSelectorPopover
                        isOpen={showFolderMenu}
                        onClose={() => setShowFolderMenu(false)}
                        onSelectFolder={handleFolderSelect}
                        anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
                      />
                    </>
                  )}
                  {showModelSelector && <ModelSelector dropdownDirection="up" />}
                  <button
                    type="button"
                    onClick={handleAddFile}
                    className="flex items-center justify-center p-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                    title={i18nService.t('coworkAddFile')}
                    aria-label={i18nService.t('coworkAddFile')}
                    disabled={disabled || isStreaming || isAddingFile}
                  >
                    <PaperClipIcon className="h-4 w-4" />
                  </button>
                  <SkillsButton
                    onSelectSkill={handleSelectSkill}
                    onManageSkills={handleManageSkills}
                  />
                  <ActiveSkillBadge />
                </div>
                <div className="flex items-center gap-2">
                  {isStreaming ? (
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
                      className="p-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Send"
                    >
                      <PaperAirplaneIcon className="h-5 w-5" />
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={editorClass}>
                {editor && (
                  <div className="relative">
                    {isEditorEmpty && (
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {placeholder}
                      </div>
                    )}
                    <EditorContent editor={editor} />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleAddFile}
                  className="flex-shrink-0 p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                  title={i18nService.t('coworkAddFile')}
                  aria-label={i18nService.t('coworkAddFile')}
                  disabled={disabled || isStreaming || isAddingFile}
                >
                  <PaperClipIcon className="h-4 w-4" />
                </button>
              </div>
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
                  className="flex-shrink-0 p-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Send"
                >
                  <PaperAirplaneIcon className="h-4 w-4" />
                </button>
              )}
            </>
          )}
        </div>
        {showFolderRequiredWarning && (
          <div className="mt-2 text-xs text-red-500 dark:text-red-400">
            {i18nService.t('coworkSelectFolderFirst')}
          </div>
        )}
        <CoworkImageLightbox
          imageSrc={expandedImage?.src ?? null}
          imageAlt={expandedImage?.alt}
          onClose={() => setExpandedImage(null)}
        />
      </div>
    );
  },
);

CoworkPromptInput.displayName = 'CoworkPromptInput';

export default CoworkPromptInput;
