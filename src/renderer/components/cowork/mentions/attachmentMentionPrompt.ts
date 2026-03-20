import type { AttachmentMentionItem } from './types';
import { isMentionTokenUsed as isMentionTokenUsedInText } from './mentionTokenUtils';
import { resolveMentionEntries } from './mentionPrompt';

interface BuildPromptWithAttachmentMentionsParams {
  prompt: string;
  attachments: AttachmentMentionItem[];
  inputFileLabel: string;
  mentionSectionTitle: string;
  clipboardImageDescription: string;
  imageDescription: string;
  fileDescription: string;
}

interface BuildPromptWithAttachmentMentionsResult {
  prompt: string;
  unresolvedMentionTokens: string[];
}

const buildMentionDescription = (
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

export const buildPromptWithAttachmentMentions = ({
  prompt,
  attachments,
  inputFileLabel,
  mentionSectionTitle,
  clipboardImageDescription,
  imageDescription,
  fileDescription,
}: BuildPromptWithAttachmentMentionsParams): BuildPromptWithAttachmentMentionsResult => {
  const trimmedPrompt = prompt.trim();
  const attachmentLines = attachments
    .filter((attachment) => !attachment.path.startsWith('inline:'))
    .map((attachment) => `${inputFileLabel}: ${attachment.path}`)
    .join('\n');

  const { resolvedMentionLines, unresolvedMentionTokens } = resolveMentionEntries({
    value: trimmedPrompt,
    items: attachments,
    describeItem: (attachment) =>
      buildMentionDescription(
        attachment,
        clipboardImageDescription,
        imageDescription,
        fileDescription,
      ),
  });

  const sections = [trimmedPrompt];
  if (attachmentLines) {
    sections.push(attachmentLines);
  }
  if (resolvedMentionLines.length > 0) {
    sections.push(`${mentionSectionTitle}:\n${resolvedMentionLines.join('\n')}`);
  }

  return {
    prompt: sections.filter(Boolean).join('\n\n'),
    unresolvedMentionTokens,
  };
};

export const isMentionTokenUsed = (value: string, mentionToken: string): boolean => {
  return isMentionTokenUsedInText(value, mentionToken);
};
