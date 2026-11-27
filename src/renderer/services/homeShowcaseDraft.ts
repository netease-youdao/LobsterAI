import {
  HOME_SHOWCASE_DRAFT_KEY,
  HOME_SHOWCASE_MAX_ATTACHMENTS,
  type HomeShowcaseExample,
  ShowcaseRemixMode,
} from '../../shared/homeShowcase/constants';
import { store } from '../store';
import {
  setDraftAttachments,
  setDraftCollaborationMode,
  setDraftPrompt,
  setDraftSkillIds,
} from '../store/slices/coworkSlice';
import { setActiveSkillIds } from '../store/slices/skillSlice';
import { CoworkCollaborationMode } from '../types/cowork';
import type { LanguageType } from './i18n';
import {
  captureImageCreationDraft,
  type ImageCreationDraftBackup,
  restoreImageCreationDraft,
} from './imageCreationDraft';

export interface ShowcasePreparedFile {
  name: string;
  mimeType: string;
  base64Data: string;
  isImage?: boolean;
}

export interface ShowcaseRemixOptions {
  mode: ShowcaseRemixMode;
  language: LanguageType;
  customInput: string;
  selectedChoices: Record<string, string>;
  editedPrompt?: string;
  userFiles: ShowcasePreparedFile[];
  useSampleFiles: boolean;
}

export type HomeShowcaseDraftBackup = ImageCreationDraftBackup;

function encodeUtf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function resolveShowcaseSelections(
  example: HomeShowcaseExample,
  selectedChoices: Record<string, string>,
): {
  promptFragments: { zh: string[]; en: string[] };
  extraSkillIds: string[];
  usePlanMode: boolean;
} {
  const zhFragments: string[] = [];
  const enFragments: string[] = [];
  const extraSkillIds: string[] = [];
  let usePlanMode = false;

  for (const group of example.optionGroups) {
    const choiceId = selectedChoices[group.id] ?? group.defaultChoiceId;
    const choice = group.choices.find(item => item.id === choiceId) ?? group.choices[0];
    if (!choice) continue;
    if (choice.promptFragment.zh.trim()) zhFragments.push(choice.promptFragment.zh.trim());
    if (choice.promptFragment.en.trim()) enFragments.push(choice.promptFragment.en.trim());
    if (choice.extraSkillIds?.length) {
      for (const skillId of choice.extraSkillIds) {
        if (!extraSkillIds.includes(skillId)) extraSkillIds.push(skillId);
      }
    }
    if (choice.usePlanMode) usePlanMode = true;
  }

  return {
    promptFragments: { zh: zhFragments, en: enFragments },
    extraSkillIds,
    usePlanMode,
  };
}

export function buildShowcaseRemixPrompt(
  example: HomeShowcaseExample,
  options: Pick<ShowcaseRemixOptions, 'mode' | 'language' | 'customInput' | 'selectedChoices' | 'editedPrompt' | 'userFiles'>,
): string {
  if (options.editedPrompt?.trim()) {
    return options.editedPrompt.trim();
  }
  const { language, mode } = options;
  const selections = resolveShowcaseSelections(example, options.selectedChoices);
  const fragments = selections.promptFragments[language];

  let basePrompt: string;
  if (mode === ShowcaseRemixMode.Demo) {
    basePrompt = example.demoPrompt[language].trim();
  } else {
    const cleanedInput = options.customInput.trim();
    const fallbackInput = options.userFiles.length > 0
      ? (language === 'zh'
        ? `请基于我上传的附件（${options.userFiles.map(file => file.name).join('、')}）直接完成分析与制作。`
        : `Use my uploaded file(s) (${options.userFiles.map(file => file.name).join(', ')}) to complete this task.`)
      : example.customSlot.demoValue[language];
    basePrompt = example.customPromptTemplate[language]
      .replace(/\{\{input\}\}/g, cleanedInput || fallbackInput)
      .trim();
  }

  return [basePrompt, ...fragments].filter(Boolean).join('\n\n');
}

export async function prepareHomeShowcaseDraft(
  example: HomeShowcaseExample,
  options: ShowcaseRemixOptions,
  isCurrent: () => boolean,
): Promise<{ backup: HomeShowcaseDraftBackup; prompt: string } | null> {
  const backup = captureImageCreationDraft();
  const prompt = buildShowcaseRemixPrompt(example, options);
  if (!prompt.trim()) {
    throw new Error('Empty showcase prompt');
  }

  const shouldStageSamples = options.mode === ShowcaseRemixMode.Demo
    || (options.useSampleFiles && options.userFiles.length === 0);

  const samplePrepared: ShowcasePreparedFile[] = shouldStageSamples
    ? (example.sampleFiles ?? []).map(sample => ({
      name: sample.name,
      mimeType: sample.mimeType,
      base64Data: encodeUtf8ToBase64(sample.content),
      isImage: sample.mimeType.startsWith('image/'),
    }))
    : [];

  const filesToStage = options.mode === ShowcaseRemixMode.Demo
    ? samplePrepared
    : [...options.userFiles, ...samplePrepared];

  const existingAttachments = backup.attachments;
  if (existingAttachments.length + filesToStage.length > HOME_SHOWCASE_MAX_ATTACHMENTS) {
    throw new Error('Too many showcase attachments');
  }

  const state = store.getState();
  const currentAgent = state.agent.agents.find(agent => agent.id === state.agent.currentAgentId);
  const cwd = currentAgent?.workingDirectory || undefined;

  const stagedAttachments = [...existingAttachments];
  for (const file of filesToStage) {
    const saved = await window.electron.dialog.saveInlineFile({
      dataBase64: file.base64Data,
      fileName: file.name,
      mimeType: file.mimeType,
      cwd,
    });
    if (!saved.success || !saved.path) {
      throw new Error('Failed to stage showcase material');
    }
    stagedAttachments.push({
      path: saved.path,
      name: file.name,
      isImage: Boolean(file.isImage),
      ...(file.isImage ? { dataUrl: `data:${file.mimeType};base64,${file.base64Data}` } : {}),
    });
  }

  if (
    !isCurrent()
    || store.getState().cowork.currentSessionId
    || JSON.stringify(captureImageCreationDraft()) !== JSON.stringify(backup)
  ) {
    return null;
  }

  const selections = resolveShowcaseSelections(example, options.selectedChoices);
  const availableSkillIds = new Set(store.getState().skill.skills.map(skill => skill.id));
  const candidateSkillIds = [
    ...(example.skillId ? [example.skillId] : []),
    ...selections.extraSkillIds,
  ];
  const nextSkillIds = [...new Set(candidateSkillIds.filter(id => availableSkillIds.has(id)))];

  store.dispatch(setDraftPrompt({ sessionId: HOME_SHOWCASE_DRAFT_KEY, draft: prompt }));
  store.dispatch(setDraftAttachments({ draftKey: HOME_SHOWCASE_DRAFT_KEY, attachments: stagedAttachments }));
  store.dispatch(setActiveSkillIds(nextSkillIds));
  store.dispatch(setDraftSkillIds({ draftKey: HOME_SHOWCASE_DRAFT_KEY, skillIds: nextSkillIds }));
  store.dispatch(setDraftCollaborationMode({
    draftKey: HOME_SHOWCASE_DRAFT_KEY,
    mode: selections.usePlanMode ? CoworkCollaborationMode.Plan : CoworkCollaborationMode.Default,
  }));

  return { backup, prompt };
}

export function restoreHomeShowcaseDraft(backup: HomeShowcaseDraftBackup): boolean {
  return restoreImageCreationDraft(backup);
}
