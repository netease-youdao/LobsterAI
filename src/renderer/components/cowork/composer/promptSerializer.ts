import type { JSONContent } from '@tiptap/core';
import type { AttachmentMentionItem } from '../mentions/types';
import type { SkillMentionItem, ComposerPromptBuildResult } from './types';

interface BuildComposerPromptParams {
  doc: JSONContent | null;
  attachments: AttachmentMentionItem[];
  skills: SkillMentionItem[];
  inputFileLabel: string;
  attachmentSectionTitle: string;
  skillSectionTitle: string;
  clipboardImageDescription: string;
  imageDescription: string;
  fileDescription: string;
}

const appendText = (parts: string[], value: string) => {
  if (!value) {
    return;
  }
  parts.push(value);
};

const walk = (
  node: JSONContent | null | undefined,
  parts: string[],
  attachmentIds: Set<string>,
  skillIds: Set<string>,
) => {
  if (!node) {
    return;
  }

  if (node.type === 'text') {
    appendText(parts, node.text ?? '');
    return;
  }

  if (node.type === 'hardBreak') {
    parts.push('\n');
    return;
  }

  if (node.type === 'resourceMention') {
    const attrs = node.attrs ?? {};
    if (attrs.kind === 'attachment' && typeof attrs.resourceId === 'string') {
      attachmentIds.add(attrs.resourceId);
      appendText(parts, `@${attrs.mentionToken ?? attrs.label ?? attrs.resourceId}`);
      return;
    }

    if (attrs.kind === 'skill' && typeof attrs.resourceId === 'string') {
      skillIds.add(attrs.resourceId);
      appendText(parts, `@${attrs.mentionToken ?? attrs.label ?? attrs.resourceId}`);
      return;
    }
  }

  node.content?.forEach((child) => walk(child, parts, attachmentIds, skillIds));
  if (node.type === 'paragraph') {
    parts.push('\n');
  }
};

const buildAttachmentDescription = (
  attachment: AttachmentMentionItem,
  clipboardImageDescription: string,
  imageDescription: string,
  fileDescription: string,
): string => {
  if (attachment.sourceKind === 'clipboard_image') {
    return clipboardImageDescription;
  }
  if (attachment.sourceKind === 'file_image') {
    return attachment.path.startsWith('inline:')
      ? imageDescription
      : `${imageDescription}: ${attachment.path}`;
  }
  return attachment.path.startsWith('inline:')
    ? fileDescription
    : `${fileDescription}: ${attachment.path}`;
};

export const buildComposerPrompt = ({
  doc,
  attachments,
  skills,
  inputFileLabel,
  attachmentSectionTitle,
  skillSectionTitle,
  clipboardImageDescription,
  imageDescription,
  fileDescription,
}: BuildComposerPromptParams): ComposerPromptBuildResult => {
  const parts: string[] = [];
  const attachmentIds = new Set<string>();
  const skillIds = new Set<string>();

  walk(doc, parts, attachmentIds, skillIds);

  const promptText = parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const attachmentById = new Map(attachments.map((attachment) => [attachment.mentionId, attachment] as const));
  const skillById = new Map(skills.map((skill) => [skill.skillId, skill] as const));

  const fileLines = attachments
    .filter((attachment) => !attachment.path.startsWith('inline:') && !attachmentIds.has(attachment.mentionId))
    .map((attachment) => `${inputFileLabel}: ${attachment.path}`)
    .join('\n');

  const attachmentMentionLines = Array.from(attachmentIds)
    .map((id) => attachmentById.get(id))
    .filter((attachment): attachment is AttachmentMentionItem => attachment !== undefined)
    .map((attachment) => `@${attachment.mentionToken} => ${buildAttachmentDescription(
      attachment,
      clipboardImageDescription,
      imageDescription,
      fileDescription,
    )}`);

  const skillMentionLines = Array.from(skillIds)
    .map((id) => skillById.get(id))
    .filter((skill): skill is SkillMentionItem => skill !== undefined)
    .map((skill) => `@${skill.mentionToken} => ${skill.name}`);

  const sections = [promptText];
  if (fileLines) {
    sections.push(fileLines);
  }
  if (attachmentMentionLines.length > 0) {
    sections.push(`${attachmentSectionTitle}:\n${attachmentMentionLines.join('\n')}`);
  }
  if (skillMentionLines.length > 0) {
    sections.push(`${skillSectionTitle}:\n${skillMentionLines.join('\n')}`);
  }

  return {
    prompt: sections.filter(Boolean).join('\n\n'),
    attachmentIds: Array.from(attachmentIds),
    skillIds: Array.from(skillIds),
  };
};

export const buildDraftTextFromDoc = (doc: JSONContent | null): string => {
  const parts: string[] = [];
  walk(doc, parts, new Set<string>(), new Set<string>());
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
