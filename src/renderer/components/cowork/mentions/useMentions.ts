import React, { useEffect, useMemo, useState } from 'react';
import type { MentionItem } from './types';
import {
  hasMentionBoundaryAfter,
  hasMentionBoundaryBefore,
  isMentionTokenUsed,
  type MentionQuery,
  parseMentionQuery,
} from './mentionTokenUtils';

interface UseMentionsParams {
  enabled: boolean;
  value: string;
  items: MentionItem[];
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  setValue: React.Dispatch<React.SetStateAction<string>>;
}

interface UseMentionsResult {
  isOpen: boolean;
  filteredItems: MentionItem[];
  highlightedIndex: number;
  invalidMentionTokens: string[];
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  handleSelectionChange: (nextPosition?: number | null) => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  handleSelectMention: (item: MentionItem) => void;
  registerRemovedMention: (item: MentionItem) => void;
  closePopover: () => void;
}

const NO_SPACE_REQUIRED_AFTER_MENTION_PATTERN = /[\s)\]}>,.!?:;]/;
const normalizeMentionDeletionRange = (
  value: string,
  start: number,
  end: number,
): { start: number; end: number } => {
  let nextStart = start;
  let nextEnd = end;
  const previousCharacter = value[nextStart - 1];
  const nextCharacter = value[nextEnd];

  if (nextCharacter === ' ') {
    nextEnd += 1;
  } else if (previousCharacter === ' ' && (nextEnd === value.length || nextCharacter === '\n')) {
    nextStart -= 1;
  }

  return {
    start: nextStart,
    end: nextEnd,
  };
};

const findMentionRangeAtBoundary = (
  value: string,
  caretPosition: number,
  direction: 'backward' | 'forward',
  mentionTokens: string[],
): { start: number; end: number } | null => {
  const sortedMentionTokens = [...mentionTokens].sort((left, right) => right.length - left.length);

  for (const mentionToken of sortedMentionTokens) {
    const needle = `@${mentionToken}`;
    let searchStart = 0;

    while (searchStart < value.length) {
      const matchIndex = value.indexOf(needle, searchStart);
      if (matchIndex === -1) {
        break;
      }

      const matchEnd = matchIndex + needle.length;
      if (!hasMentionBoundaryBefore(value, matchIndex) || !hasMentionBoundaryAfter(value, matchEnd)) {
        searchStart = matchIndex + needle.length;
        continue;
      }

      if (
        (direction === 'backward' && caretPosition === matchEnd)
        || (direction === 'forward' && caretPosition === matchIndex)
      ) {
        return normalizeMentionDeletionRange(value, matchIndex, matchEnd);
      }

      searchStart = matchIndex + needle.length;
    }
  }

  return null;
};

export const useMentions = ({
  enabled,
  value,
  items,
  textareaRef,
  setValue,
}: UseMentionsParams): UseMentionsResult => {
  const [caretPosition, setCaretPosition] = useState(0);
  const [activeQuery, setActiveQuery] = useState<MentionQuery | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [removedMentionTokens, setRemovedMentionTokens] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled || items.length === 0) {
      setActiveQuery(null);
      return;
    }

    setActiveQuery(parseMentionQuery(value, caretPosition));
  }, [caretPosition, enabled, items.length, value]);

  const filteredItems = !enabled || !activeQuery
    ? []
    : items.filter((item) => {
      if (!activeQuery.query) {
        return true;
      }
      const normalizedQuery = activeQuery.query.toLowerCase();
      return item.searchText.some((searchText) => searchText.toLowerCase().includes(normalizedQuery));
    });

  useEffect(() => {
    setHighlightedIndex(0);
  }, [activeQuery?.query, items.length]);

  useEffect(() => {
    if (!value && items.length === 0) {
      setRemovedMentionTokens([]);
      setHighlightedIndex(0);
    }
  }, [items.length, value]);

  const invalidMentionTokens = removedMentionTokens.filter((mentionToken) =>
    isMentionTokenUsed(value, mentionToken),
  );

  const knownMentionTokens = useMemo(
    () => Array.from(new Set([...items.map((item) => item.mentionToken), ...removedMentionTokens])),
    [items, removedMentionTokens],
  );

  const closePopover = () => {
    setActiveQuery(null);
  };

  const handleSelectionChange = (nextPosition?: number | null) => {
    if (typeof nextPosition === 'number') {
      setCaretPosition(nextPosition);
      return;
    }

    setCaretPosition(textareaRef.current?.selectionStart ?? 0);
  };

  const handleSelectMention = (item: MentionItem) => {
    if (!activeQuery) {
      return;
    }

    const mentionText = `@${item.mentionToken}`;
    const nextValue = `${value.slice(0, activeQuery.start)}${mentionText}${value.slice(activeQuery.end)}`;
    const nextCaretPosition = activeQuery.start + mentionText.length;
    const nextCharacter = nextValue[nextCaretPosition];
    const shouldAppendSpace = !nextCharacter || !NO_SPACE_REQUIRED_AFTER_MENTION_PATTERN.test(nextCharacter);
    const finalValue = shouldAppendSpace
      ? `${nextValue.slice(0, nextCaretPosition)} ${nextValue.slice(nextCaretPosition)}`
      : nextValue;
    const finalCaretPosition = shouldAppendSpace ? nextCaretPosition + 1 : nextCaretPosition;

    setValue(finalValue);
    setActiveQuery(null);

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(finalCaretPosition, finalCaretPosition);
      setCaretPosition(finalCaretPosition);
    });
  };

  const handleMentionBoundaryDeletion = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (knownMentionTokens.length === 0) {
      return false;
    }

    const textarea = event.currentTarget;
    if (textarea.selectionStart !== textarea.selectionEnd) {
      return false;
    }

    const direction = event.key === 'Backspace' ? 'backward' : event.key === 'Delete' ? 'forward' : null;
    if (!direction) {
      return false;
    }

    const range = findMentionRangeAtBoundary(value, textarea.selectionStart, direction, knownMentionTokens);
    if (!range) {
      return false;
    }

    event.preventDefault();
    const nextValue = `${value.slice(0, range.start)}${value.slice(range.end)}`;
    setValue(nextValue);

    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) {
        return;
      }
      nextTextarea.focus();
      nextTextarea.setSelectionRange(range.start, range.start);
      setCaretPosition(range.start);
    });

    return true;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!enabled) {
      return false;
    }

    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (isComposing) {
      return false;
    }

    if (handleMentionBoundaryDeletion(event)) {
      return true;
    }

    if (!activeQuery) {
      return false;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closePopover();
      return true;
    }

    if (filteredItems.length === 0) {
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        return true;
      }
      return false;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % filteredItems.length);
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      return true;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      handleSelectMention(filteredItems[highlightedIndex] ?? filteredItems[0]);
      return true;
    }

    return false;
  };

  const registerRemovedMention = (item: MentionItem) => {
    if (!isMentionTokenUsed(value, item.mentionToken)) {
      return;
    }

    setRemovedMentionTokens((prev) => {
      if (prev.includes(item.mentionToken)) {
        return prev;
      }
      return [...prev, item.mentionToken];
    });
  };

  return {
    isOpen: enabled && !!activeQuery,
    filteredItems,
    highlightedIndex,
    invalidMentionTokens,
    setHighlightedIndex,
    handleSelectionChange,
    handleKeyDown,
    handleSelectMention,
    registerRemovedMention,
    closePopover,
  };
};
