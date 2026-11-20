import { extractPastedTextBlocks } from '../../../shared/cowork/pastedText';
import type { CoworkMessage } from '../../types/cowork';
import { extractUserMessageFileAttachments } from '../../utils/userMessageFileAttachments';

/**
 * Up/Down recall of the prompts already sent in a session, the way a shell or
 * the Codex composer does it: Up in an empty composer brings back the latest
 * prompt, further Ups walk older ones, Down walks back to the draft.
 */

export const PromptHistoryDirection = {
  Older: 'older',
  Newer: 'newer',
} as const;
export type PromptHistoryDirection = typeof PromptHistoryDirection[keyof typeof PromptHistoryDirection];

export const PROMPT_HISTORY_LIMIT = 100;

export interface PromptHistoryBrowse {
  /** The composer the browse started in; a session switch ends it. */
  draftKey: string;
  /** Sent prompts, newest first, captured when the browse started. */
  entries: string[];
  /** The entry the composer shows; 0 is the newest. */
  index: number;
  /** What the composer held before the browse, shown again past the newest entry. */
  draft: string;
}

export interface PromptHistoryInput {
  direction: PromptHistoryDirection;
  draftKey: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  browse: PromptHistoryBrowse | null;
  /** Read only when a new browse starts, so the session is not scanned on every key press. */
  loadEntries: () => string[];
}

export interface PromptHistoryStep {
  value: string;
  /** null once the composer is back on the draft. */
  browse: PromptHistoryBrowse | null;
}

/** The text a user typed into a sent prompt, without the cards the composer appended to it. */
export const getRecallablePromptText = (message: CoworkMessage): string => {
  const { text: withFileLines } = extractPastedTextBlocks(message.content || '');
  const { text } = extractUserMessageFileAttachments(withFileLines);
  return text.trim();
};

/** Sent prompts of a session, newest first, without blanks or back-to-back repeats. */
export const collectPromptHistoryEntries = (
  messages: readonly CoworkMessage[],
  limit = PROMPT_HISTORY_LIMIT,
): string[] => {
  const entries: string[] = [];
  for (let index = messages.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const message = messages[index];
    if (message.type !== 'user') continue;
    const text = getRecallablePromptText(message);
    if (!text || entries[entries.length - 1] === text) continue;
    entries.push(text);
  }
  return entries;
};

const isCaretOnFirstLine = (value: string, selectionStart: number): boolean => (
  !value.slice(0, selectionStart).includes('\n')
);

const isCaretOnLastLine = (value: string, selectionEnd: number): boolean => (
  !value.slice(selectionEnd).includes('\n')
);

/**
 * The composer value one step through the history, or null when the key should
 * keep its normal caret movement. A browse only starts from an empty composer
 * and only continues while the recalled prompt is unedited, so typed drafts are
 * never replaced.
 */
export const resolvePromptHistoryStep = (input: PromptHistoryInput): PromptHistoryStep | null => {
  const { direction, draftKey, value, selectionStart, selectionEnd } = input;
  if (selectionStart !== selectionEnd) return null;

  const browse = input.browse
    && input.browse.draftKey === draftKey
    && input.browse.entries[input.browse.index] === value
    ? input.browse
    : null;

  if (direction === PromptHistoryDirection.Older) {
    if (browse) {
      if (!isCaretOnFirstLine(value, selectionStart)) return null;
      const nextIndex = browse.index + 1;
      if (nextIndex >= browse.entries.length) return null;
      return { value: browse.entries[nextIndex], browse: { ...browse, index: nextIndex } };
    }
    if (value.trim()) return null;
    const entries = input.loadEntries();
    if (entries.length === 0) return null;
    return { value: entries[0], browse: { draftKey, entries, index: 0, draft: value } };
  }

  if (!browse || !isCaretOnLastLine(value, selectionEnd)) return null;
  if (browse.index === 0) return { value: browse.draft, browse: null };
  const nextIndex = browse.index - 1;
  return { value: browse.entries[nextIndex], browse: { ...browse, index: nextIndex } };
};
