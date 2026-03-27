import type { AttachmentMentionItem, AttachmentMentionSourceKind } from './types';

interface CreateAttachmentMentionItemParams {
  path: string;
  name: string;
  isImage?: boolean;
  dataUrl?: string;
  clipboardImageIndex?: number;
  existingItems?: AttachmentMentionItem[];
  reservedMentionTokens?: string[];
  sourceKindOverride?: AttachmentMentionSourceKind;
}

const IMAGE_NAME_PREFIX = 'image';
const SAFE_MENTION_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

const getBaseNameFromPath = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

const createMentionId = (): string => {
  return `mention-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const getSourceKind = (path: string, isImage?: boolean): AttachmentMentionSourceKind => {
  if (isImage && path.startsWith('inline:')) {
    return 'clipboard_image';
  }
  if (isImage) {
    return 'file_image';
  }
  return 'file';
};

const getAttachmentLabel = ({
  path,
  name,
  sourceKind,
  clipboardImageIndex,
}: {
  path: string;
  name: string;
  sourceKind: AttachmentMentionSourceKind;
  clipboardImageIndex?: number;
}): string => {
  if (sourceKind === 'clipboard_image' && clipboardImageIndex) {
    return `${IMAGE_NAME_PREFIX}-${clipboardImageIndex}.png`;
  }
  return getBaseNameFromPath(path) || name;
};

const splitExtension = (value: string): { stem: string; extension: string } => {
  const match = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(value);
  return {
    stem: match?.[1] || value,
    extension: match?.[2] || '',
  };
};

const slugifyTokenStem = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
};

const getTokenFallback = (sourceKind: AttachmentMentionSourceKind): string => {
  if (sourceKind === 'clipboard_image') {
    return IMAGE_NAME_PREFIX;
  }
  if (sourceKind === 'file_image') {
    return 'image-file';
  }
  return 'file';
};

const ensureUniqueMentionToken = (
  candidate: string,
  existingItems: AttachmentMentionItem[],
  reservedMentionTokens: string[],
): string => {
  const existingTokens = new Set([
    ...existingItems.map((item) => item.mentionToken),
    ...reservedMentionTokens,
  ]);

  if (!existingTokens.has(candidate)) {
    return candidate;
  }

  const { stem, extension } = splitExtension(candidate);
  let suffix = 2;
  while (existingTokens.has(`${stem}-${suffix}${extension}`)) {
    suffix += 1;
  }
  return `${stem}-${suffix}${extension}`;
};

const getMentionToken = ({
  label,
  sourceKind,
  existingItems,
  reservedMentionTokens,
}: {
  label: string;
  sourceKind: AttachmentMentionSourceKind;
  existingItems: AttachmentMentionItem[];
  reservedMentionTokens: string[];
}): string => {
  const { stem, extension } = splitExtension(label);
  const fallback = getTokenFallback(sourceKind);
  const safeStem = slugifyTokenStem(stem, fallback);
  const safeExtension = SAFE_MENTION_TOKEN_PATTERN.test(extension) ? extension.toLowerCase() : '';
  const preferredToken = SAFE_MENTION_TOKEN_PATTERN.test(label)
    ? label
    : `${safeStem}${safeExtension}`;

  return ensureUniqueMentionToken(preferredToken, existingItems, reservedMentionTokens);
};

export const createAttachmentMentionItem = ({
  path,
  name,
  isImage,
  dataUrl,
  clipboardImageIndex,
  existingItems = [],
  reservedMentionTokens = [],
  sourceKindOverride,
}: CreateAttachmentMentionItemParams): AttachmentMentionItem => {
  const sourceKind = sourceKindOverride ?? getSourceKind(path, isImage);
  const label = getAttachmentLabel({
    path,
    name,
    sourceKind,
    clipboardImageIndex,
  });
  const mentionToken = getMentionToken({
    label,
    sourceKind,
    existingItems,
    reservedMentionTokens,
  });

  return {
    mentionId: createMentionId(),
    kind: 'attachment',
    path,
    name,
    label,
    mentionToken,
    sourceKind,
    searchText: [label, mentionToken, name].filter(Boolean),
    isImage,
    dataUrl,
  };
};
