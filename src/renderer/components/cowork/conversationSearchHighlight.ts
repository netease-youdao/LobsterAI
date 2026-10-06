import { getVirtualSearchText } from '../../utils/searchDomProjection';
import {
  CONVERSATION_SEARCH_MATCH_LIMIT,
  type CoworkConversationSearchMatch,
} from './conversationSearch';
import { logConversationSearchWarning } from './conversationSearchLogger';

const ConversationSearchHighlightName = {
  Match: 'cowork-conversation-search-match',
  Active: 'cowork-conversation-search-active',
} as const;

interface HighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => boolean;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

export interface ConversationSearchHighlightResult {
  activeElement: HTMLElement | null;
  activeRange: Range | null;
}

interface ConversationSearchRangeOptions {
  requiredOccurrenceIndexes?: ReadonlySet<number>;
  maxOccurrences?: number;
}

interface TextNodeSpan {
  node: Text | null;
  start: number;
  end: number;
}

let hasLoggedHighlightFailure = false;

const logHighlightFailureOnce = (message: string, error: unknown): void => {
  if (hasLoggedHighlightFailure) return;
  hasLoggedHighlightFailure = true;
  logConversationSearchWarning(message, error);
};

const getHighlightApi = (): {
  registry: HighlightRegistryLike;
  HighlightClass: HighlightConstructor;
} | null => {
  if (typeof CSS === 'undefined' || typeof window === 'undefined') return null;
  const registry = (CSS as typeof CSS & { highlights?: HighlightRegistryLike }).highlights;
  const HighlightClass = (window as typeof window & { Highlight?: HighlightConstructor }).Highlight;
  if (!registry || !HighlightClass) return null;
  return { registry, HighlightClass };
};

const isExcludedTextNode = (node: Text, root: HTMLElement): boolean => {
  const parent = node.parentElement;
  if (!parent || !root.contains(parent)) return true;
  return Boolean(parent.closest([
    '[data-cowork-search-exclude="true"]',
    '[aria-hidden="true"]',
    'button',
    'script',
    'style',
  ].join(',')));
};

const collectTextNodeSpans = (root: HTMLElement): { text: string; spans: TextNodeSpan[] } => {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  const spans: TextNodeSpan[] = [];
  const chunks: string[] = [];
  let offset = 0;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      typeof HTMLElement !== 'undefined'
      && node instanceof HTMLElement
      && node.dataset.coworkSearchVirtualText === 'true'
    ) {
      const value = getVirtualSearchText(node);
      if (!value) continue;
      chunks.push(value);
      spans.push({ node: null, start: offset, end: offset + value.length });
      offset += value.length;
      continue;
    }
    if (!(node instanceof Text) || isExcludedTextNode(node, root)) continue;
    const value = node.data;
    if (!value) continue;
    chunks.push(value);
    spans.push({ node, start: offset, end: offset + value.length });
    offset += value.length;
  }

  return { text: chunks.join(''), spans };
};

const findTextNodeSpan = (
  spans: TextNodeSpan[],
  offset: number,
): TextNodeSpan | null => {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const span = spans[middle];
    if (offset < span.start) {
      high = middle - 1;
    } else if (offset >= span.end) {
      low = middle + 1;
    } else {
      return span;
    }
  }
  return null;
};

const createRange = (
  spans: TextNodeSpan[],
  start: number,
  end: number,
): Range | null => {
  const startSpan = findTextNodeSpan(spans, start);
  const endSpan = findTextNodeSpan(spans, end - 1);
  if (!startSpan?.node || !endSpan?.node) return null;

  const range = document.createRange();
  range.setStart(startSpan.node, start - startSpan.start);
  range.setEnd(endSpan.node, end - endSpan.start);
  return range;
};

export const getConversationSearchRanges = (
  root: HTMLElement,
  query: string,
  options: ConversationSearchRangeOptions = {},
): Range[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const requestedMaxOccurrences = options.maxOccurrences
    ?? CONVERSATION_SEARCH_MATCH_LIMIT;
  const maxOccurrences = Number.isFinite(requestedMaxOccurrences)
    ? Math.max(0, Math.min(
      CONVERSATION_SEARCH_MATCH_LIMIT,
      Math.floor(requestedMaxOccurrences),
    ))
    : CONVERSATION_SEARCH_MATCH_LIMIT;
  if (maxOccurrences === 0) return [];

  const remainingRequiredOccurrences = options.requiredOccurrenceIndexes
    ? new Set(Array.from(options.requiredOccurrenceIndexes).filter(index => (
      Number.isInteger(index)
      && index >= 0
      && index < maxOccurrences
    )))
    : null;
  if (remainingRequiredOccurrences?.size === 0) return [];

  const { text, spans } = collectTextNodeSpans(root);
  const normalizedText = text.toLowerCase();
  const ranges: Range[] = [];
  let searchFrom = 0;
  let occurrenceIndex = 0;

  while (
    occurrenceIndex < maxOccurrences
    && searchFrom <= normalizedText.length - normalizedQuery.length
  ) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, searchFrom);
    if (matchIndex < 0) break;
    if (!remainingRequiredOccurrences || remainingRequiredOccurrences.has(occurrenceIndex)) {
      const range = createRange(spans, matchIndex, matchIndex + normalizedQuery.length);
      // Keep source occurrence indexes stable even if a DOM boundary cannot be
      // represented. Consumers intentionally address this as a sparse array.
      if (range) ranges[occurrenceIndex] = range;
      remainingRequiredOccurrences?.delete(occurrenceIndex);
    }
    searchFrom = matchIndex + normalizedQuery.length;
    occurrenceIndex += 1;
    if (remainingRequiredOccurrences?.size === 0) break;
  }

  return ranges;
};

export function clearConversationSearchHighlights(): void {
  const api = getHighlightApi();
  if (!api) return;
  try {
    api.registry.delete(ConversationSearchHighlightName.Match);
    api.registry.delete(ConversationSearchHighlightName.Active);
  } catch (error) {
    logHighlightFailureOnce('Failed to clear browser search highlights.', error);
  }
}

export function applyConversationSearchHighlights(
  container: HTMLElement,
  query: string,
  matches: CoworkConversationSearchMatch[],
  activeMatchKey: string | null,
): ConversationSearchHighlightResult {
  try {
    clearConversationSearchHighlights();

    const api = getHighlightApi();
    const messageElements = new Map<string, HTMLElement>();
    for (const element of container.querySelectorAll<HTMLElement>('[data-cowork-search-message-id]')) {
      const messageId = element.dataset.coworkSearchMessageId;
      if (messageId) messageElements.set(messageId, element);
    }
    const groupedMatches = new Map<string, CoworkConversationSearchMatch[]>();
    let retainedMatchCount = 0;
    for (const match of matches) {
      if (retainedMatchCount >= CONVERSATION_SEARCH_MATCH_LIMIT) break;
      retainedMatchCount += 1;
      if (!messageElements.has(match.messageId)) continue;
      const messageMatches = groupedMatches.get(match.messageId) ?? [];
      messageMatches.push(match);
      groupedMatches.set(match.messageId, messageMatches);
    }

    const regularRanges: Range[] = [];
    const activeRanges: Range[] = [];
    let activeElement: HTMLElement | null = null;
    let activeRange: Range | null = null;

    for (const [messageId, messageMatches] of groupedMatches) {
      const element = messageElements.get(messageId);
      if (!element) continue;
      const requiredOccurrenceIndexes = new Set(
        messageMatches.map(match => match.occurrenceIndex),
      );
      const ranges = getConversationSearchRanges(element, query, {
        requiredOccurrenceIndexes,
        maxOccurrences: CONVERSATION_SEARCH_MATCH_LIMIT,
      });

      for (const match of messageMatches) {
        const range = ranges[match.occurrenceIndex];
        if (match.key === activeMatchKey) {
          activeElement = element;
          activeRange = range ?? null;
          if (range) activeRanges.push(range);
        } else if (range) {
          regularRanges.push(range);
        }
      }
    }

    if (api) {
      if (regularRanges.length > 0) {
        api.registry.set(
          ConversationSearchHighlightName.Match,
          new api.HighlightClass(...regularRanges),
        );
      }
      if (activeRanges.length > 0) {
        api.registry.set(
          ConversationSearchHighlightName.Active,
          new api.HighlightClass(...activeRanges),
        );
      }
    }

    hasLoggedHighlightFailure = false;
    return { activeElement, activeRange };
  } catch (error) {
    logHighlightFailureOnce('Failed to apply browser search highlights.', error);
    return { activeElement: null, activeRange: null };
  }
}
