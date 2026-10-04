import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

type Options = {
  sessionId: string | undefined;
  offset: number;
  messageCount: number;
  containerRef: RefObject<HTMLDivElement>;
  loadPage: (sessionId: string) => Promise<boolean>;
};

type Request = { offset: number; height: number; settled: boolean; applied: boolean };

/** Keep pagination busy until the service promise settles, including no-op pages. */
export function useOlderMessagesPagination({
  sessionId,
  offset,
  messageCount,
  containerRef,
  loadPage,
}: Options) {
  const [isLoading, setIsLoading] = useState(false);
  const [settlement, setSettlement] = useState(0);
  const isLoadingRef = useRef(false);
  const requestRef = useRef<Request | null>(null);
  const automaticAttemptRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    requestRef.current = null;
    automaticAttemptRef.current = null;
    isLoadingRef.current = false;
    setIsLoading(false);
    return () => {
      requestRef.current = null;
      isLoadingRef.current = false;
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    const request = requestRef.current;
    if (!request?.settled) return;
    const container = containerRef.current;
    // Only prepended history changes the reading anchor. Live messages and
    // discarded/empty pages must not shift the user's position.
    if (container && request.applied && offset < request.offset) {
      container.scrollTop += container.scrollHeight - request.height;
    }
    requestRef.current = null;
    isLoadingRef.current = false;
  }, [settlement, offset, messageCount, containerRef]);

  const loadOlderMessages = useCallback(
    async (automatic = false) => {
      const container = containerRef.current;
      if (!sessionId || offset <= 0 || !container || isLoadingRef.current) return;
      const windowKey = `${offset}:${messageCount}`;
      // A no-op page may resolve normally. Do not retry it forever merely
      // because clearing the spinner renders the still-short viewport again.
      if (automatic && automaticAttemptRef.current === windowKey) return;
      automaticAttemptRef.current = windowKey;
      const request: Request = {
        offset,
        height: container.scrollHeight,
        settled: false,
        applied: false,
      };
      requestRef.current = request;
      isLoadingRef.current = true;
      setIsLoading(true);
      try {
        request.applied = await loadPage(sessionId);
      } catch (error) {
        console.warn('[CoworkSessionDetail] failed to load older messages.', error);
      } finally {
        if (requestRef.current === request) {
          request.settled = true;
          setIsLoading(false);
          setSettlement(value => value + 1);
        }
      }
    },
    [sessionId, offset, messageCount, containerRef, loadPage],
  );

  return { isLoading, isLoadingRef, loadOlderMessages };
}
