import type { JSONContent } from '@tiptap/react';
import type { AttachmentMentionItem } from '../mentions/types';
import type { Skill } from '../../../types/skill';
import type { LocalizedQuickAction, LocalizedPrompt } from '../../../types/quickAction';

export type ComposerSuggestionTrigger = '@' | '/';

export interface ComposerQueryMatch {
  trigger: ComposerSuggestionTrigger;
  query: string;
  from: number;
  to: number;
}

export interface AttachmentSuggestionItem {
  id: string;
  kind: 'attachment';
  attachment: AttachmentMentionItem;
  title: string;
  subtitle: string;
  searchText: string[];
}

export interface SkillSuggestionItem {
  id: string;
  kind: 'skill';
  skill: Skill;
  title: string;
  subtitle: string;
  searchText: string[];
}

export interface PromptSuggestionItem {
  id: string;
  kind: 'prompt';
  action: LocalizedQuickAction;
  prompt: LocalizedPrompt;
  title: string;
  subtitle: string;
  searchText: string[];
}

export type ComposerSuggestionItem =
  | AttachmentSuggestionItem
  | SkillSuggestionItem
  | PromptSuggestionItem;

export interface ComposerSuggestionState {
  match: ComposerQueryMatch | null;
  items: ComposerSuggestionItem[];
  highlightedIndex: number;
  position: { top: number; left: number } | null;
}

export interface ComposerSerializationResult {
  prompt: string;
  referencedAttachments: AttachmentMentionItem[];
  referencedSkillIds: string[];
}

export interface ComposerDocumentContext {
  attachmentsById: Map<string, AttachmentMentionItem>;
}

export interface ComposerEditorStateSnapshot {
  json: JSONContent;
  text: string;
  referencedAttachments: AttachmentMentionItem[];
  referencedSkillIds: string[];
}

export interface SkillMentionItem {
  id: string;
  kind: 'skill';
  skillId: string;
  label: string;
  mentionToken: string;
  name: string;
  description?: string;
  isOfficial: boolean;
  searchText: string[];
}

export type ComposerResourceItem = AttachmentMentionItem | SkillMentionItem;

export interface SlashCommandItem {
  id: string;
  kind: 'slash';
  actionId: string;
  actionLabel: string;
  promptId: string;
  label: string;
  description?: string;
  prompt: string;
  skillMapping: string;
  searchText: string[];
}

export interface ComposerPromptBuildResult {
  prompt: string;
  attachmentIds: string[];
  skillIds: string[];
}

export interface ResourceMentionAttrs {
  kind: 'attachment' | 'skill';
  resourceId: string;
  mentionToken: string;
  label: string;
  description?: string;
  path?: string;
  sourceKind?: string;
  isImage?: boolean;
  dataUrl?: string;
  isOfficial?: boolean;
}

export const createSkillMentionItem = (skill: Skill): SkillMentionItem => ({
  id: `skill-${skill.id}`,
  kind: 'skill',
  skillId: skill.id,
  label: skill.name,
  mentionToken: skill.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || skill.id,
  name: skill.name,
  description: skill.description,
  isOfficial: skill.isOfficial,
  searchText: [skill.name, skill.id, skill.description].filter(Boolean),
});

export const buildSlashCommandItems = (actions: LocalizedQuickAction[]): SlashCommandItem[] => {
  return actions.flatMap((action) =>
    action.prompts.map((prompt) => ({
      id: `${action.id}:${prompt.id}`,
      kind: 'slash',
      actionId: action.id,
      actionLabel: action.label,
      promptId: prompt.id,
      label: prompt.label,
      description: prompt.description,
      prompt: prompt.prompt,
      skillMapping: action.skillMapping,
      searchText: [action.label, prompt.label, prompt.description, prompt.prompt].filter(
        (value): value is string => Boolean(value),
      ),
    })),
  );
};
