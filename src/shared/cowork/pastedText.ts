/**
 * Large pastes in the Cowork composer become "pasted text" cards instead of
 * flooding the textarea. On submit each card is embedded in the prompt as a
 * tagged block, so the model, queued follow-ups, exports and history all keep
 * the full text; the UI parses the blocks back out to show them as cards.
 *
 * Both tags carry the same random id, so a pasted text that itself contains a
 * block (for example a copied earlier message) cannot close the outer one.
 */

export const COWORK_PASTED_TEXT_MIN_CHARS = 1_500;
export const COWORK_PASTED_TEXT_MIN_LINES = 25;
export const COWORK_PASTED_TEXT_PATH_PREFIX = 'pasted:';

const PREVIEW_MAX_CHARS = 80;
const PASTED_TEXT_ID_PATTERN = '[A-Za-z0-9_-]{1,64}';
const PASTED_TEXT_BLOCK_OPEN_MARKER = '<pasted_text id="';
const PASTED_TEXT_BLOCK_RE = new RegExp(
  `<pasted_text id="(${PASTED_TEXT_ID_PATTERN})">\\r?\\n([\\s\\S]*?)\\r?\\n</pasted_text id="\\1">`,
  'g',
);

export interface CoworkPastedTextBlock {
  id: string;
  text: string;
}

export interface CoworkPastedTextAttachmentLike {
  path: string;
  name: string;
  pastedText?: string;
}

export interface ExtractedPastedTextBlocks {
  text: string;
  blocks: CoworkPastedTextBlock[];
}

export const normalizePastedText = (text: string): string => text.replace(/\r\n?/g, '\n');

export const countPastedTextLines = (text: string): number => (
  text ? normalizePastedText(text).replace(/\n+$/, '').split('\n').length : 0
);

export const shouldPasteAsTextCard = (text: string): boolean => {
  if (!text.trim()) return false;
  const normalized = normalizePastedText(text);
  return normalized.length >= COWORK_PASTED_TEXT_MIN_CHARS
    || countPastedTextLines(normalized) >= COWORK_PASTED_TEXT_MIN_LINES;
};

/** First non-empty line, trimmed and shortened for card titles. */
export const getPastedTextPreview = (text: string): string => {
  const firstLine = normalizePastedText(text)
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? '';
  const characters = Array.from(firstLine);
  return characters.length > PREVIEW_MAX_CHARS
    ? `${characters.slice(0, PREVIEW_MAX_CHARS).join('')}…`
    : firstLine;
};

/** Leading text with whitespace collapsed, for the multi-line card preview. */
export const getPastedTextSnippet = (text: string, maxChars = 300): string => {
  const characters = Array.from(text.slice(0, maxChars * 4).replace(/\s+/g, ' ').trim());
  return characters.length > maxChars ? characters.slice(0, maxChars).join('') : characters.join('');
};

export const createPastedTextId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (uuid ? uuid.replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`)
    .slice(0, 12);
};

export const createPastedTextAttachment = (
  text: string,
  id: string = createPastedTextId(),
): Required<CoworkPastedTextAttachmentLike> => {
  const pastedText = normalizePastedText(text);
  return {
    path: `${COWORK_PASTED_TEXT_PATH_PREFIX}${id}`,
    name: getPastedTextPreview(pastedText),
    pastedText,
  };
};

export const isPastedTextAttachment = <T extends CoworkPastedTextAttachmentLike>(
  attachment: T,
): attachment is T & { pastedText: string } => (
  typeof attachment.pastedText === 'string'
  && attachment.path.startsWith(COWORK_PASTED_TEXT_PATH_PREFIX)
);

const getPastedTextAttachmentId = (path: string): string => {
  const id = path.slice(COWORK_PASTED_TEXT_PATH_PREFIX.length);
  return new RegExp(`^${PASTED_TEXT_ID_PATTERN}$`).test(id) ? id : createPastedTextId();
};

export const formatPastedTextBlock = (block: CoworkPastedTextBlock): string => (
  `<pasted_text id="${block.id}">\n${block.text}\n</pasted_text id="${block.id}">`
);

export const formatPastedTextAttachmentBlocks = (
  attachments: ReadonlyArray<CoworkPastedTextAttachmentLike>,
): string[] => attachments
  .filter(isPastedTextAttachment)
  .map(attachment => formatPastedTextBlock({
    id: getPastedTextAttachmentId(attachment.path),
    text: attachment.pastedText,
  }));

/** Splits pasted-text blocks out of a stored user message. */
export const extractPastedTextBlocks = (content: string): ExtractedPastedTextBlocks => {
  if (!content || !content.includes(PASTED_TEXT_BLOCK_OPEN_MARKER)) {
    return { text: content, blocks: [] };
  }
  const blocks: CoworkPastedTextBlock[] = [];
  const text = content.replace(
    new RegExp(PASTED_TEXT_BLOCK_RE.source, PASTED_TEXT_BLOCK_RE.flags),
    (_match, id: string, body: string) => {
      blocks.push({ id, text: body });
      return '';
    },
  );
  if (blocks.length === 0) return { text: content, blocks };
  return { text: text.replace(/(?:\r?\n){3,}/g, '\n\n').trim(), blocks };
};

/** Replaces each pasted-text block with its plain text, e.g. for copy or titles. */
export const expandPastedTextBlocks = (content: string): string => {
  if (!content || !content.includes(PASTED_TEXT_BLOCK_OPEN_MARKER)) return content;
  return content.replace(
    new RegExp(PASTED_TEXT_BLOCK_RE.source, PASTED_TEXT_BLOCK_RE.flags),
    (_match, _id: string, body: string) => body,
  );
};
