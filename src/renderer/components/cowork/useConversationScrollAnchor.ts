import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

import {
  captureConversationScrollAnchor,
  type ConversationScrollAnchor,
  restoreConversationScrollAnchor,
} from './conversationScrollAnchor';

interface ConversationScrollAnchorOptions {
  sessionId: string | undefined;
  messagesOffset: number;
  scrollContainerRef: RefObject<HTMLElement | null>;
  canRestore: () => boolean;
  loadMessages: (beforePrepend: (newOffset: number) => boolean) => Promise<boolean>;
}

interface OlderMessagesRequest {
  sessionId: string;
  offset: number;
  expectedOffset?: number;
  anchor: ConversationScrollAnchor | null;
  /** The page has committed and only the pin of its remounted anchor turn is outstanding. */
  awaitingPin?: boolean;
  settleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Upper bound for a fetched page to commit and restore. Both normally happen
 * within a frame; this only guarantees the loading guard cannot outlive them.
 */
export const OLDER_MESSAGES_SETTLE_TIMEOUT_MS = 1500;

const DIAGNOSTIC_TAG = 'ConversationScrollAnchor';

const reportDiagnostic = (level: 'debug' | 'warn', message: string): void => {
  (level === 'warn' ? console.warn : console.debug)(`[${DIAGNOSTIC_TAG}] ${message}`);
  if (typeof window !== 'undefined') window.electron?.log?.fromRenderer?.(level, DIAGNOSTIC_TAG, message);
};

const clearSettleTimer = (request: OlderMessagesRequest | null): void => {
  if (request?.settleTimer === undefined) return;
  clearTimeout(request.settleTimer);
  request.settleTimer = undefined;
};

/** Owns history-page restoration while leaving following, search and navigation in control. */
export function useConversationScrollAnchor(options: ConversationScrollAnchorOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [contentElement, setContentElement] = useState<HTMLElement | null>(null);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const isLoadingMoreMessagesRef = useRef(false);
  const [anchorMessageId, setAnchorMessageId] = useState<string | null>(null);
  const requestRef = useRef<OlderMessagesRequest | null>(null);
  const automaticAttemptRef = useRef<Pick<OlderMessagesRequest, 'sessionId' | 'offset'> | null>(null);
  const readingAnchorRef = useRef<ConversationScrollAnchor | null>(null);

  const finishRequest = useCallback((request: OlderMessagesRequest) => {
    if (requestRef.current !== request) return;
    clearSettleTimer(request);
    requestRef.current = null;
    isLoadingMoreMessagesRef.current = false;
    setIsLoadingMoreMessages(false);
    setAnchorMessageId(null);
  }, []);

  useLayoutEffect(() => {
    clearSettleTimer(requestRef.current);
    requestRef.current = null;
    readingAnchorRef.current = null;
    automaticAttemptRef.current = null;
    isLoadingMoreMessagesRef.current = false;
    setIsLoadingMoreMessages(false);
    setAnchorMessageId(null);
    return () => {
      clearSettleTimer(requestRef.current);
      requestRef.current = null;
      readingAnchorRef.current = null;
    };
  }, [options.sessionId]);

  const loadOlderMessages = useCallback(async ({ automatic = false }: { automatic?: boolean } = {}): Promise<boolean> => {
    const current = optionsRef.current;
    if (!current.sessionId || current.messagesOffset <= 0 || requestRef.current) return false;
    if (automatic && automaticAttemptRef.current?.sessionId === current.sessionId
      && automaticAttemptRef.current.offset === current.messagesOffset) return false;
    const request: OlderMessagesRequest = {
      sessionId: current.sessionId,
      offset: current.messagesOffset,
      anchor: null,
    };
    requestRef.current = request;
    if (automatic) automaticAttemptRef.current = request;
    isLoadingMoreMessagesRef.current = true;
    setIsLoadingMoreMessages(true);
    let loaded = false;
    try {
      loaded = await current.loadMessages((newOffset) => {
        const latest = optionsRef.current;
        if (requestRef.current !== request || latest.sessionId !== request.sessionId
          || latest.messagesOffset !== request.offset) return false;
        request.expectedOffset = newOffset;
        const container = latest.scrollContainerRef.current;
        request.anchor = container && latest.canRestore() ? captureConversationScrollAnchor(container) : null;
        readingAnchorRef.current = request.anchor;
        // The leading partial turn can acquire a new React key during prepend.
        // Keep the anchor's content mounted through that commit, even if its
        // new wrapper initially lies outside the lazy-render viewport.
        setAnchorMessageId(request.anchor?.candidates[0]?.messageId ?? null);
        return true;
      });
      return loaded;
    } catch (error) {
      console.warn('[ConversationScrollAnchor] Failed to load older messages.', error);
      return false;
    } finally {
      // A successful page is released by its layout commit, not by an unrelated
      // streaming append or the promise resolving before React has committed.
      if (!loaded || request.expectedOffset === undefined) {
        finishRequest(request);
      } else if (requestRef.current === request) {
        // The commit and the anchor pin each depend on a later render. Never
        // let a render that does not arrive keep history loading blocked.
        request.settleTimer = setTimeout(() => {
          request.settleTimer = undefined;
          if (requestRef.current !== request) return;
          reportDiagnostic(
            'warn',
            `released an older message page for session ${request.sessionId} that did not settle within `
            + `${OLDER_MESSAGES_SETTLE_TIMEOUT_MS}ms; offset=${request.offset}; expectedOffset=${request.expectedOffset}; `
            + `currentOffset=${optionsRef.current.messagesOffset}; awaitingPin=${request.awaitingPin === true}.`,
          );
          readingAnchorRef.current = null;
          finishRequest(request);
        }, OLDER_MESSAGES_SETTLE_TIMEOUT_MS);
      }
    }
  }, [finishRequest]);

  useLayoutEffect(() => {
    const request = requestRef.current;
    const current = optionsRef.current;
    if (!request || request.sessionId !== current.sessionId || request.offset === current.messagesOffset) return;
    const container = current.scrollContainerRef.current;
    if (request.expectedOffset === current.messagesOffset && request.anchor && container && current.canRestore()) {
      const restored = restoreConversationScrollAnchor(container, request.anchor);
      // External-store updates can commit before the local state that pins a
      // remounted turn. Let that state commit before giving up on its anchor.
      // A reader gesture can cancel that pin before it commits, so the wait
      // must be ended by the gesture itself rather than by another render.
      if (!restored && anchorMessageId !== request.anchor.candidates[0]?.messageId) {
        request.awaitingPin = true;
        return;
      }
      readingAnchorRef.current = captureConversationScrollAnchor(container, { includeTurnFallback: false });
    } else {
      readingAnchorRef.current = null;
    }
    finishRequest(request);
  }, [options.sessionId, options.messagesOffset, anchorMessageId, finishRequest]);

  useLayoutEffect(() => {
    const container = options.scrollContainerRef.current;
    if (!container || !contentElement) return;
    const capture = () => {
      if (requestRef.current?.anchor) return;
      // A turn's bottom can grow below the reader during streaming. Only use
      // that fallback for prepend, where the added content is known to precede it.
      readingAnchorRef.current = optionsRef.current.canRestore()
        ? captureConversationScrollAnchor(container, { includeTurnFallback: false })
        : null;
    };
    const interrupt = () => {
      readingAnchorRef.current = null;
      const request = requestRef.current;
      if (request?.awaitingPin) {
        // Dropping the pin may leave its state unchanged, so no render would
        // re-run the commit effect that releases this already committed page.
        reportDiagnostic(
          'debug',
          `reader gesture cancelled a pending history restore for session ${request.sessionId}; offset=${request.expectedOffset}.`,
        );
        finishRequest(request);
        return;
      }
      if (request) request.anchor = null;
      setAnchorMessageId(null);
    };
    const resizeObserver = new ResizeObserver(() => {
      if (!optionsRef.current.canRestore()) {
        readingAnchorRef.current = null;
        return;
      }
      const anchor = readingAnchorRef.current;
      if (anchor && !requestRef.current?.anchor && restoreConversationScrollAnchor(container, anchor)) capture();
    });
    resizeObserver.observe(contentElement);
    container.addEventListener('scroll', capture, { passive: true });
    const interruptEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    interruptEvents.forEach(event => container.addEventListener(event, interrupt, { passive: true }));
    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('scroll', capture);
      interruptEvents.forEach(event => container.removeEventListener(event, interrupt));
    };
  }, [contentElement, finishRequest, options.sessionId, options.scrollContainerRef]);

  return { loadOlderMessages, isLoadingMoreMessages, isLoadingMoreMessagesRef, anchorMessageId, setContentElement };
}
