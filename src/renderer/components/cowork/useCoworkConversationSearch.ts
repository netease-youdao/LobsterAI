import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { COWORK_SEARCH_MESSAGE_PAGE_SIZE } from '../../../shared/cowork/constants';
import type {
  CoworkSearchMessage,
  CoworkSearchMessageCursor,
  CoworkSearchMessagePage,
} from '../../../shared/cowork/search';
import type { CoworkMessage } from '../../types/cowork';
import {
  CONVERSATION_SEARCH_MATCH_LIMIT,
  ConversationSearchDirection,
  type ConversationSearchDirection as ConversationSearchDirectionValue,
  ConversationSearchErrorReason,
  type ConversationSearchErrorReason as ConversationSearchErrorReasonValue,
  ConversationSearchStatus,
  type ConversationSearchStatus as ConversationSearchStatusValue,
  type CoworkConversationSearchMatch,
  findConversationSearchMatches,
} from './conversationSearch';
import {
  isConversationSearchHistoryLimitError,
  loadConversationSearchHistory,
  measureConversationSearchHistoryContentCodeUnits,
  mergeConversationSearchHistoryMessages,
} from './conversationSearchHistoryLoader';
import {
  logConversationSearchDebug,
  logConversationSearchWarning,
} from './conversationSearchLogger';

// Streaming deltas can arrive many times per second. Re-scanning a complete
// conversation more frequently than this creates avoidable CPU and allocation
// pressure without making the result counter meaningfully more useful.
const STREAM_MESSAGE_MERGE_THROTTLE_MS = 1_000;
const SEARCH_MESSAGE_BATCH_SIZE = 200;
const NON_WHITESPACE_RE = /\S/;

type SearchableCurrentMessage = CoworkMessage & { type: 'user' | 'assistant' };

const isSearchableCurrentMessage = (
  message: CoworkMessage,
): message is SearchableCurrentMessage => (
  (message.type === 'user' || message.type === 'assistant')
  && message.metadata?.isThinking !== true
  && NON_WHITESPACE_RE.test(message.content)
);

interface ConversationSearchStreamReconciliation {
  messages: CoworkSearchMessage[];
  contentCodeUnits: number;
  hasContentUpdate: boolean;
  hasUnknownCurrentMessage: boolean;
}

/** Reconciles streamed message bodies and enforces the same retained-content budget. */
export const reconcileConversationSearchStreamMessages = (
  historyMessages: CoworkSearchMessage[],
  currentMessages: CoworkMessage[],
): ConversationSearchStreamReconciliation => {
  const currentById = new Map(
    currentMessages
      .filter(isSearchableCurrentMessage)
      .map(message => [message.id, message]),
  );
  const unknownCurrentIds = new Set(currentById.keys());
  const messages = historyMessages.map(message => {
    unknownCurrentIds.delete(message.id);
    const current = currentById.get(message.id);
    if (
      !current
      || (
        current.type === message.type
        && current.content === message.content
        && current.timestamp === message.timestamp
      )
    ) {
      return message;
    }
    return {
      id: current.id,
      type: current.type,
      content: current.content,
      timestamp: current.timestamp,
      absoluteMessageIndex: message.absoluteMessageIndex,
    };
  });
  return {
    messages,
    contentCodeUnits: measureConversationSearchHistoryContentCodeUnits(messages),
    hasContentUpdate: messages.some((message, index) => message !== historyMessages[index]),
    hasUnknownCurrentMessage: unknownCurrentIds.size > 0,
  };
};

interface ConversationSearchBatchResult {
  matches: CoworkConversationSearchMatch[];
  isResultLimitReached: boolean;
}

export const findConversationSearchMatchesInBatches = async (
  messages: CoworkSearchMessage[],
  query: string,
  isRequestCurrent: () => boolean,
): Promise<ConversationSearchBatchResult | null> => {
  const matches: CoworkConversationSearchMatch[] = [];

  for (let startIndex = 0; startIndex < messages.length; startIndex += SEARCH_MESSAGE_BATCH_SIZE) {
    if (!isRequestCurrent()) return null;

    const endIndex = Math.min(startIndex + SEARCH_MESSAGE_BATCH_SIZE, messages.length);
    const batchMessages = messages.slice(startIndex, endIndex);
    const absoluteIndexById = new Map(
      batchMessages.map(message => [message.id, message.absoluteMessageIndex]),
    );
    const remainingMatchCapacity = CONVERSATION_SEARCH_MATCH_LIMIT - matches.length;
    const batchMatches = findConversationSearchMatches(
      batchMessages,
      query,
      0,
      remainingMatchCapacity + 1,
    ).map(match => ({
      ...match,
      absoluteMessageIndex: absoluteIndexById.get(match.messageId)
        ?? match.absoluteMessageIndex,
    }));
    if (batchMatches.length > remainingMatchCapacity) {
      matches.push(...batchMatches.slice(0, remainingMatchCapacity));
      return { matches, isResultLimitReached: true };
    }
    matches.push(...batchMatches);

    if (endIndex < messages.length) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
  }

  return isRequestCurrent() ? { matches, isResultLimitReached: false } : null;
};

interface UseCoworkConversationSearchOptions {
  sessionId?: string;
  currentMessages: CoworkMessage[];
  currentTotalMessages?: number;
  loadMessagePage: (options: {
    offset: number;
    limit: number;
    cursor?: CoworkSearchMessageCursor;
    knownTotal?: number;
  }) => Promise<CoworkSearchMessagePage>;
  debounceMs?: number;
}

export interface CoworkConversationSearchController {
  isOpen: boolean;
  query: string;
  status: ConversationSearchStatusValue;
  errorReason: ConversationSearchErrorReasonValue | null;
  matches: CoworkConversationSearchMatch[];
  isResultLimitReached: boolean;
  activeMatch: CoworkConversationSearchMatch | null;
  activeMatchIndex: number;
  focusRequestKey: number;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  navigate: (direction: ConversationSearchDirectionValue) => void;
}

export function useCoworkConversationSearch({
  sessionId,
  currentMessages,
  currentTotalMessages = currentMessages.length,
  loadMessagePage,
  debounceMs = 120,
}: UseCoworkConversationSearchOptions): CoworkConversationSearchController {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [status, setStatus] = useState<ConversationSearchStatusValue>(ConversationSearchStatus.Idle);
  const [errorReason, setErrorReason] = useState<ConversationSearchErrorReasonValue | null>(null);
  const [fullMessages, setFullMessages] = useState<CoworkSearchMessage[]>([]);
  const [matches, setMatches] = useState<CoworkConversationSearchMatch[]>([]);
  const [isResultLimitReached, setIsResultLimitReached] = useState(false);
  const [activeMatchKey, setActiveMatchKey] = useState<string | null>(null);
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const [streamRefreshVersion, setStreamRefreshVersion] = useState(0);
  const loadRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const streamMergeTimerRef = useRef<number | null>(null);
  const tailLoadInFlightRef = useRef(false);
  const loadedHistoryEndOffsetRef = useRef(0);
  const loadedHistoryCursorRef = useRef<CoworkSearchMessageCursor | undefined>(undefined);
  const loadedHistoryContentCodeUnitsRef = useRef(0);
  const latestCurrentMessagesRef = useRef(currentMessages);
  const latestCurrentTotalMessagesRef = useRef(currentTotalMessages);
  const latestSessionIdRef = useRef(sessionId);
  const isOpenRef = useRef(false);
  const statusRef = useRef<ConversationSearchStatusValue>(ConversationSearchStatus.Idle);
  const fullMessagesRef = useRef<CoworkSearchMessage[]>([]);
  const loadMessagePageRef = useRef(loadMessagePage);
  const previousSessionIdRef = useRef(sessionId);
  const hasLoggedResultLimitRef = useRef(false);

  latestCurrentMessagesRef.current = currentMessages;
  latestCurrentTotalMessagesRef.current = currentTotalMessages;
  latestSessionIdRef.current = sessionId;
  isOpenRef.current = isOpen;
  statusRef.current = status;
  fullMessagesRef.current = fullMessages;

  useEffect(() => {
    loadMessagePageRef.current = loadMessagePage;
  }, [loadMessagePage]);

  const enterError = useCallback((message: string, error: unknown) => {
    loadRequestRef.current += 1;
    searchRequestRef.current += 1;
    if (streamMergeTimerRef.current !== null) {
      window.clearTimeout(streamMergeTimerRef.current);
      streamMergeTimerRef.current = null;
    }
    statusRef.current = ConversationSearchStatus.Error;
    fullMessagesRef.current = [];
    loadedHistoryEndOffsetRef.current = 0;
    loadedHistoryCursorRef.current = undefined;
    loadedHistoryContentCodeUnitsRef.current = 0;
    tailLoadInFlightRef.current = false;
    setStatus(ConversationSearchStatus.Error);
    setErrorReason(isConversationSearchHistoryLimitError(error)
      ? ConversationSearchErrorReason.HistoryTooLarge
      : ConversationSearchErrorReason.Unavailable);
    setFullMessages([]);
    setMatches([]);
    setIsResultLimitReached(false);
    setActiveMatchKey(null);
    setStreamRefreshVersion(0);
    hasLoggedResultLimitRef.current = false;
    logConversationSearchWarning(message, error);
  }, []);

  const reset = useCallback(() => {
    loadRequestRef.current += 1;
    searchRequestRef.current += 1;
    if (streamMergeTimerRef.current !== null) {
      window.clearTimeout(streamMergeTimerRef.current);
      streamMergeTimerRef.current = null;
    }
    isOpenRef.current = false;
    statusRef.current = ConversationSearchStatus.Idle;
    fullMessagesRef.current = [];
    loadedHistoryEndOffsetRef.current = 0;
    loadedHistoryCursorRef.current = undefined;
    loadedHistoryContentCodeUnitsRef.current = 0;
    tailLoadInFlightRef.current = false;
    setIsOpen(false);
    setQueryState('');
    setStatus(ConversationSearchStatus.Idle);
    setErrorReason(null);
    setFullMessages([]);
    setMatches([]);
    setIsResultLimitReached(false);
    setActiveMatchKey(null);
    setStreamRefreshVersion(0);
    hasLoggedResultLimitRef.current = false;
  }, []);

  useEffect(() => () => {
    loadRequestRef.current += 1;
    searchRequestRef.current += 1;
    isOpenRef.current = false;
    if (streamMergeTimerRef.current !== null) {
      window.clearTimeout(streamMergeTimerRef.current);
      streamMergeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    if (isOpenRef.current) {
      logConversationSearchDebug('Resetting conversation search after session change.');
    }
    previousSessionIdRef.current = sessionId;
    reset();
  }, [reset, sessionId]);

  useEffect(() => {
    if (
      !isOpen
      || status !== ConversationSearchStatus.Ready
    ) return;
    if (streamMergeTimerRef.current !== null) return;

    streamMergeTimerRef.current = window.setTimeout(() => {
      streamMergeTimerRef.current = null;
      if (!isOpenRef.current || statusRef.current !== ConversationSearchStatus.Ready) return;

      const hasUninspectedTimelineTail = latestCurrentTotalMessagesRef.current
        > loadedHistoryEndOffsetRef.current;
      let reconciliation: ConversationSearchStreamReconciliation;
      try {
        reconciliation = reconcileConversationSearchStreamMessages(
          fullMessagesRef.current,
          latestCurrentMessagesRef.current,
        );
      } catch (error) {
        enterError('Streamed conversation search content exceeded its safe budget.', error);
        return;
      }
      loadedHistoryContentCodeUnitsRef.current = reconciliation.contentCodeUnits;
      if (reconciliation.hasContentUpdate) {
        fullMessagesRef.current = reconciliation.messages;
        setFullMessages(reconciliation.messages);
      }

      if (
        (!reconciliation.hasUnknownCurrentMessage && !hasUninspectedTimelineTail)
        || tailLoadInFlightRef.current
      ) return;
      const requestId = loadRequestRef.current;
      const requestSessionId = latestSessionIdRef.current;
      const startOffset = loadedHistoryEndOffsetRef.current;
      const startCursor = loadedHistoryCursorRef.current;
      tailLoadInFlightRef.current = true;
      void loadConversationSearchHistory({
        startOffset,
        startCursor,
        knownTotal: latestCurrentTotalMessagesRef.current,
        existingContentCodeUnits: loadedHistoryContentCodeUnitsRef.current,
        pageSize: COWORK_SEARCH_MESSAGE_PAGE_SIZE,
        loadPage: options => loadMessagePageRef.current(options),
        isRequestCurrent: () => (
          requestId === loadRequestRef.current
          && requestSessionId === latestSessionIdRef.current
          && isOpenRef.current
          && statusRef.current === ConversationSearchStatus.Ready
        ),
      }).then(result => {
        if (
          !result
          || requestId !== loadRequestRef.current
          || requestSessionId !== latestSessionIdRef.current
        ) return;
        const mergedMessages = mergeConversationSearchHistoryMessages(
          fullMessagesRef.current,
          result.messages,
        );
        const latestById = new Map(
          latestCurrentMessagesRef.current
            .filter(isSearchableCurrentMessage)
            .map(message => [message.id, message]),
        );
        const nextMessages = mergedMessages
          .map(message => {
            const current = latestById.get(message.id);
            if (!current) return message;
            return {
              id: current.id,
              type: current.type,
              content: current.content,
              timestamp: current.timestamp,
              absoluteMessageIndex: message.absoluteMessageIndex,
            };
          })
          .sort((left, right) => left.absoluteMessageIndex - right.absoluteMessageIndex);
        const nextContentCodeUnits = measureConversationSearchHistoryContentCodeUnits(nextMessages);
        loadedHistoryEndOffsetRef.current = result.endOffset;
        loadedHistoryCursorRef.current = result.endCursor;
        loadedHistoryContentCodeUnitsRef.current = nextContentCodeUnits;
        fullMessagesRef.current = nextMessages;
        setFullMessages(nextMessages);
        if (latestCurrentTotalMessagesRef.current > result.endOffset) {
          setStreamRefreshVersion(value => value + 1);
        }
      }).catch((error: unknown) => {
        if (
          requestId !== loadRequestRef.current
          || requestSessionId !== latestSessionIdRef.current
        ) return;
        enterError('Failed to refresh streamed conversation search history.', error);
      }).finally(() => {
        if (
          requestId === loadRequestRef.current
          && requestSessionId === latestSessionIdRef.current
        ) {
          tailLoadInFlightRef.current = false;
        }
      });
    }, STREAM_MESSAGE_MERGE_THROTTLE_MS);
  }, [
    currentMessages,
    currentTotalMessages,
    enterError,
    isOpen,
    status,
    streamRefreshVersion,
  ]);

  const open = useCallback(() => {
    if (!sessionId) return;
    if (!isOpenRef.current) {
      logConversationSearchDebug('Opening conversation search.');
    }
    isOpenRef.current = true;
    setIsOpen(true);
    setFocusRequestKey(value => value + 1);

    if (
      fullMessagesRef.current.length > 0
      || statusRef.current === ConversationSearchStatus.Loading
      || statusRef.current === ConversationSearchStatus.Ready
    ) return;

    const requestId = ++loadRequestRef.current;
    const requestSessionId = sessionId;
    statusRef.current = ConversationSearchStatus.Loading;
    setStatus(ConversationSearchStatus.Loading);
    setErrorReason(null);
    void loadConversationSearchHistory({
      pageSize: COWORK_SEARCH_MESSAGE_PAGE_SIZE,
      loadPage: options => loadMessagePageRef.current(options),
      isRequestCurrent: () => (
        requestId === loadRequestRef.current
        && requestSessionId === latestSessionIdRef.current
        && isOpenRef.current
      ),
    }).then(result => {
      if (
        !result
        || requestId !== loadRequestRef.current
        || requestSessionId !== latestSessionIdRef.current
      ) return;
      loadedHistoryEndOffsetRef.current = result.endOffset;
      loadedHistoryCursorRef.current = result.endCursor;
      loadedHistoryContentCodeUnitsRef.current = result.cumulativeContentCodeUnits;
      fullMessagesRef.current = result.messages;
      statusRef.current = ConversationSearchStatus.Ready;
      setFullMessages(result.messages);
      setStatus(ConversationSearchStatus.Ready);
      logConversationSearchDebug(
        `Loaded lightweight conversation search history; searchableMessages=${result.messages.length}; totalMessages=${result.total}.`,
      );
    }).catch((error: unknown) => {
      if (
        requestId !== loadRequestRef.current
        || requestSessionId !== latestSessionIdRef.current
      ) return;
      enterError('Failed to load conversation history.', error);
    });
  }, [enterError, sessionId]);

  const close = useCallback(() => {
    if (isOpenRef.current) {
      logConversationSearchDebug('Closing conversation search and releasing cached history.');
    }
    reset();
  }, [reset]);

  const setQuery = useCallback((nextQuery: string) => {
    searchRequestRef.current += 1;
    setQueryState(nextQuery);
    setMatches([]);
    setIsResultLimitReached(false);
    setActiveMatchKey(null);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      searchRequestRef.current += 1;
      setMatches([]);
      setIsResultLimitReached(false);
      setActiveMatchKey(null);
      if (status !== ConversationSearchStatus.Loading && status !== ConversationSearchStatus.Error) {
        setStatus(ConversationSearchStatus.Ready);
      }
      return undefined;
    }

    if (status === ConversationSearchStatus.Loading || status === ConversationSearchStatus.Error) {
      return undefined;
    }

    const requestId = ++searchRequestRef.current;
    const timer = window.setTimeout(() => {
      void findConversationSearchMatchesInBatches(
        fullMessages,
        trimmedQuery,
        () => requestId === searchRequestRef.current,
      ).then(result => {
        if (!result || requestId !== searchRequestRef.current) return;

        const { matches: nextMatches, isResultLimitReached: nextLimitReached } = result;
        if (nextLimitReached && !hasLoggedResultLimitRef.current) {
          hasLoggedResultLimitRef.current = true;
          logConversationSearchWarning(
            `Search result limit reached; retained=${CONVERSATION_SEARCH_MATCH_LIMIT}.`,
          );
        }

        setMatches(nextMatches);
        setIsResultLimitReached(nextLimitReached);
        setActiveMatchKey(previousKey => {
          if (previousKey && nextMatches.some(match => match.key === previousKey)) {
            return previousKey;
          }
          return nextMatches[0]?.key ?? null;
        });
        setStatus(ConversationSearchStatus.Ready);
      }).catch((error: unknown) => {
        if (requestId !== searchRequestRef.current) return;
        enterError('Failed to search conversation history.', error);
      });
    }, debounceMs);

    return () => window.clearTimeout(timer);
  }, [debounceMs, enterError, fullMessages, isOpen, query, status]);

  const activeMatchIndex = useMemo(() => {
    if (!activeMatchKey) return -1;
    return matches.findIndex(match => match.key === activeMatchKey);
  }, [activeMatchKey, matches]);

  const activeMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] : null;

  const navigate = useCallback((direction: ConversationSearchDirectionValue) => {
    if (matches.length === 0) return;

    const currentIndex = activeMatchKey
      ? matches.findIndex(match => match.key === activeMatchKey)
      : -1;
    const nextIndex = direction === ConversationSearchDirection.Previous
      ? (currentIndex <= 0 ? matches.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex >= matches.length - 1 ? 0 : currentIndex + 1);
    setActiveMatchKey(matches[nextIndex].key);
  }, [activeMatchKey, matches]);

  // Effects reset state immediately after a session switch. Hide the stale
  // controller state during the intervening render so it cannot navigate the
  // new session using an old message index.
  const isSessionStateCurrent = previousSessionIdRef.current === sessionId;

  return {
    isOpen: isSessionStateCurrent ? isOpen : false,
    query: isSessionStateCurrent ? query : '',
    status: isSessionStateCurrent ? status : ConversationSearchStatus.Idle,
    errorReason: isSessionStateCurrent ? errorReason : null,
    matches: isSessionStateCurrent ? matches : [],
    isResultLimitReached: isSessionStateCurrent ? isResultLimitReached : false,
    activeMatch: isSessionStateCurrent ? activeMatch : null,
    activeMatchIndex: isSessionStateCurrent ? activeMatchIndex : -1,
    focusRequestKey,
    open,
    close,
    setQuery,
    navigate,
  };
}
