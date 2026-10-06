import {
  COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS,
  COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS,
  COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
  COWORK_SEARCH_MESSAGE_PAGE_SIZE,
} from '../../../shared/cowork/constants';
import type {
  CoworkSearchMessage,
  CoworkSearchMessageCursor,
  CoworkSearchMessagePage,
} from '../../../shared/cowork/search';

const MAX_CONVERSATION_SEARCH_HISTORY_PAGES = 500;

export const ConversationSearchHistoryLimitKind = {
  MixedRows: 'mixed_rows',
  TotalContentCodeUnits: 'total_content_code_units',
  MessageContentCodeUnits: 'message_content_code_units',
  Pages: 'pages',
} as const;
export type ConversationSearchHistoryLimitKind =
  typeof ConversationSearchHistoryLimitKind[keyof typeof ConversationSearchHistoryLimitKind];

/** Identifies an intentionally bounded search-history load (never a partial result). */
export class ConversationSearchHistoryLimitError extends Error {
  readonly name = 'ConversationSearchHistoryLimitError';

  constructor(
    readonly kind: ConversationSearchHistoryLimitKind,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`Conversation search history exceeded ${kind}: ${actual} > ${limit}`);
  }
}

export const isConversationSearchHistoryLimitError = (
  error: unknown,
): error is ConversationSearchHistoryLimitError => (
  error instanceof ConversationSearchHistoryLimitError
);

export interface ConversationSearchHistoryLoadResult {
  messages: CoworkSearchMessage[];
  /** First absolute mixed-message offset not inspected by this load. */
  endOffset: number;
  endCursor?: CoworkSearchMessageCursor;
  total: number;
  /** Searchable content retained before and during this load, in UTF-16 code units. */
  cumulativeContentCodeUnits: number;
}

/** Merge an incremental tail without reordering or duplicating cached rows. */
export function mergeConversationSearchHistoryMessages(
  existingMessages: CoworkSearchMessage[],
  incomingMessages: CoworkSearchMessage[],
): CoworkSearchMessage[] {
  const messagesById = new Map(existingMessages.map(message => [message.id, message]));
  for (const message of incomingMessages) {
    const existing = messagesById.get(message.id);
    if (existing && existing.absoluteMessageIndex !== message.absoluteMessageIndex) {
      throw new Error('Conversation search timeline shifted during tail refresh');
    }
    messagesById.set(message.id, message);
  }
  return [...messagesById.values()].sort(
    (left, right) => left.absoluteMessageIndex - right.absoluteMessageIndex,
  );
}

interface LoadConversationSearchHistoryOptions {
  loadPage: (options: {
    offset: number;
    limit: number;
    cursor?: CoworkSearchMessageCursor;
    knownTotal?: number;
  }) => Promise<CoworkSearchMessagePage>;
  isRequestCurrent: () => boolean;
  startOffset?: number;
  startCursor?: CoworkSearchMessageCursor;
  knownTotal?: number;
  /** Searchable content already retained by an incremental caller, in UTF-16 code units. */
  existingContentCodeUnits?: number;
  pageSize?: number;
  yieldBetweenPages?: () => Promise<void>;
}

const yieldToRenderer = (): Promise<void> => new Promise(resolve => {
  window.setTimeout(resolve, 0);
});

const assertFiniteNonNegativeInteger = (value: number, field: string): void => {
  if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
    throw new Error(`Invalid conversation search page ${field}`);
  }
};

const assertWithinLimit = (
  actual: number,
  limit: number,
  kind: ConversationSearchHistoryLimitKind,
): void => {
  if (actual > limit) {
    throw new ConversationSearchHistoryLimitError(kind, limit, actual);
  }
};

/** Validates and measures searchable message content using the shared renderer budget. */
export function measureConversationSearchHistoryContentCodeUnits(
  messages: Iterable<Pick<CoworkSearchMessage, 'content'>>,
  existingContentCodeUnits = 0,
): number {
  assertFiniteNonNegativeInteger(existingContentCodeUnits, 'existingContentCodeUnits');
  assertWithinLimit(
    existingContentCodeUnits,
    COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS,
    ConversationSearchHistoryLimitKind.TotalContentCodeUnits,
  );

  let contentCodeUnits = existingContentCodeUnits;
  for (const message of messages) {
    assertWithinLimit(
      message.content.length,
      COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS,
      ConversationSearchHistoryLimitKind.MessageContentCodeUnits,
    );
    contentCodeUnits += message.content.length;
    assertWithinLimit(
      contentCodeUnits,
      COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS,
      ConversationSearchHistoryLimitKind.TotalContentCodeUnits,
    );
  }
  return contentCodeUnits;
}

/**
 * Loads a lightweight search projection in bounded pages. Returning null means
 * the caller invalidated the request (search closed, session switched, or the
 * component unmounted); no partial history should be committed in that case.
 */
export async function loadConversationSearchHistory({
  loadPage,
  isRequestCurrent,
  startOffset = 0,
  startCursor,
  knownTotal,
  existingContentCodeUnits = 0,
  pageSize = COWORK_SEARCH_MESSAGE_PAGE_SIZE,
  yieldBetweenPages = yieldToRenderer,
}: LoadConversationSearchHistoryOptions): Promise<ConversationSearchHistoryLoadResult | null> {
  assertFiniteNonNegativeInteger(startOffset, 'startOffset');
  if (startOffset > 0 && !startCursor) {
    throw new Error('Conversation search cursor is required for an incremental load');
  }
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new Error('Invalid conversation search page size');
  }
  if (knownTotal !== undefined) {
    assertFiniteNonNegativeInteger(knownTotal, 'knownTotal');
  }
  assertWithinLimit(
    startOffset,
    COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
    ConversationSearchHistoryLimitKind.MixedRows,
  );
  if (knownTotal !== undefined) {
    assertWithinLimit(
      knownTotal,
      COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      ConversationSearchHistoryLimitKind.MixedRows,
    );
  }

  const messages: CoworkSearchMessage[] = [];
  const messageIndexById = new Map<string, number>();
  let offset = startOffset;
  let cursor = startCursor;
  let total = Math.max(startOffset, knownTotal ?? startOffset);
  let isFirstPage = true;
  let previousReportedTotal: number | null = null;
  let lastMessageIndex = -1;
  let pageCount = 0;
  let contentCodeUnits = measureConversationSearchHistoryContentCodeUnits(
    [],
    existingContentCodeUnits,
  );

  while (isFirstPage || offset < total) {
    isFirstPage = false;
    pageCount += 1;
    if (pageCount > MAX_CONVERSATION_SEARCH_HISTORY_PAGES) {
      throw new ConversationSearchHistoryLimitError(
        ConversationSearchHistoryLimitKind.Pages,
        MAX_CONVERSATION_SEARCH_HISTORY_PAGES,
        pageCount,
      );
    }
    if (!isRequestCurrent()) return null;

    const page = await loadPage({
      offset,
      limit: Math.floor(pageSize),
      cursor,
      knownTotal: knownTotal === undefined && pageCount === 1 ? undefined : total,
    });
    if (!isRequestCurrent()) return null;

    assertFiniteNonNegativeInteger(page.offset, 'offset');
    assertFiniteNonNegativeInteger(page.nextOffset, 'nextOffset');
    assertFiniteNonNegativeInteger(page.total, 'total');
    assertWithinLimit(
      Math.max(page.total, page.nextOffset),
      COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      ConversationSearchHistoryLimitKind.MixedRows,
    );
    if (page.offset !== offset) {
      throw new Error('Conversation search page offset mismatch');
    }
    if (page.nextOffset < page.offset) {
      throw new Error('Conversation search page moved backwards');
    }
    if (page.nextOffset - page.offset > Math.floor(pageSize)) {
      throw new Error('Conversation search page exceeded its requested range');
    }
    if (page.nextOffset > page.offset && !page.nextCursor) {
      throw new Error('Conversation search page did not advance its cursor');
    }
    if (
      cursor
      && page.nextOffset > page.offset
      && page.nextCursor
      && page.nextCursor.sortValue === cursor.sortValue
      && page.nextCursor.createdAt === cursor.createdAt
      && page.nextCursor.rowId === cursor.rowId
    ) {
      throw new Error('Conversation search page reused its cursor');
    }
    if (previousReportedTotal !== null && page.total < previousReportedTotal) {
      throw new Error('Conversation search timeline changed while loading');
    }
    previousReportedTotal = page.total;

    total = Math.max(page.total, page.nextOffset);
    for (const message of page.messages) {
      assertFiniteNonNegativeInteger(message.absoluteMessageIndex, 'message index');
      if (
        message.absoluteMessageIndex < page.offset
        || message.absoluteMessageIndex >= page.nextOffset
      ) {
        throw new Error('Conversation search message index was outside its page');
      }
      const previousIndex = messageIndexById.get(message.id);
      if (previousIndex !== undefined) {
        if (previousIndex !== message.absoluteMessageIndex) {
          throw new Error('Conversation search timeline shifted while loading');
        }
        continue;
      }
      contentCodeUnits = measureConversationSearchHistoryContentCodeUnits(
        [message],
        contentCodeUnits,
      );
      if (message.absoluteMessageIndex <= lastMessageIndex) {
        throw new Error('Conversation search messages were not monotonic');
      }
      messageIndexById.set(message.id, message.absoluteMessageIndex);
      lastMessageIndex = message.absoluteMessageIndex;
      messages.push(message);
    }

    if (page.nextOffset === offset) {
      if (offset >= total) break;
      throw new Error('Conversation search history page made no progress');
    }

    offset = page.nextOffset;
    cursor = page.nextCursor ?? cursor;
    if (offset < total) {
      await yieldBetweenPages();
    }
  }

  return isRequestCurrent()
    ? {
        messages,
        endOffset: offset,
        endCursor: cursor,
        total,
        cumulativeContentCodeUnits: contentCodeUnits,
      }
    : null;
}
