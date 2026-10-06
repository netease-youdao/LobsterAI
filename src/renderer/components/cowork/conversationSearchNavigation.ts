export interface ConversationSearchRectLike {
  top: number;
  width: number;
  height: number;
}

export const CONVERSATION_SEARCH_CENTER_TOLERANCE_PX = 8;
const CONVERSATION_SEARCH_SETTLE_DELAYS_MS = [120, 360, 800, 1400] as const;
const CONVERSATION_SEARCH_PAGINATION_RELEASE_DELAY_MS = 120;

interface ConversationSearchScrollContainer {
  scrollTop: number;
  clientHeight: number;
  getBoundingClientRect: () => ConversationSearchRectLike;
  scrollTo: (options: { top: number; behavior: 'auto' }) => void;
}

interface ConversationSearchSettleOptions {
  isCurrent: () => boolean;
  getContainer: () => ConversationSearchScrollContainer | null;
  getTargetRect: () => ConversationSearchRectLike | null;
  onSettled: (result: { correctionCount: number; observedDelta: number }) => void;
  onTargetUnavailable: () => void;
  onError: (error: unknown) => void;
  onRelease: () => void;
}

export const isUsableConversationSearchRect = (
  rect: ConversationSearchRectLike,
): boolean => (
  Number.isFinite(rect.top)
  && Number.isFinite(rect.width)
  && Number.isFinite(rect.height)
  && rect.width > 0
  && rect.height > 0
);

export const getConversationSearchCenterDelta = (
  containerRect: Pick<ConversationSearchRectLike, 'top'>,
  containerHeight: number,
  targetRect: Pick<ConversationSearchRectLike, 'top' | 'height'>,
): number => (
  targetRect.top
  - containerRect.top
  - ((containerHeight - targetRect.height) / 2)
);

export const shouldCorrectConversationSearchPosition = (
  delta: number,
  tolerance = CONVERSATION_SEARCH_CENTER_TOLERANCE_PX,
): boolean => Number.isFinite(delta) && Math.abs(delta) > tolerance;

export const scheduleConversationSearchSettle = ({
  isCurrent,
  getContainer,
  getTargetRect,
  onSettled,
  onTargetUnavailable,
  onError,
  onRelease,
}: ConversationSearchSettleOptions): (() => void) => {
  const timerIds = new Set<ReturnType<typeof setTimeout>>();
  let correctionCount = 0;
  let stopped = false;

  const clearTimers = () => {
    timerIds.forEach(timerId => globalThis.clearTimeout(timerId));
    timerIds.clear();
  };
  const stop = (release: boolean) => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    if (release) onRelease();
  };
  const schedule = (callback: () => void, delayMs: number) => {
    const timerId = globalThis.setTimeout(() => {
      timerIds.delete(timerId);
      if (!stopped) callback();
    }, delayMs);
    timerIds.add(timerId);
  };

  CONVERSATION_SEARCH_SETTLE_DELAYS_MS.forEach((delayMs, index) => {
    schedule(() => {
      try {
        if (!isCurrent()) {
          stop(true);
          return;
        }
        const isFinalCheck = index === CONVERSATION_SEARCH_SETTLE_DELAYS_MS.length - 1;
        const container = getContainer();
        const targetRect = getTargetRect();
        if (container && targetRect) {
          const delta = getConversationSearchCenterDelta(
            container.getBoundingClientRect(),
            container.clientHeight,
            targetRect,
          );
          if (shouldCorrectConversationSearchPosition(delta)) {
            container.scrollTo({ top: container.scrollTop + delta, behavior: 'auto' });
            correctionCount += 1;
          }
          if (isFinalCheck) {
            onSettled({ correctionCount, observedDelta: delta });
          }
        } else if (isFinalCheck) {
          onTargetUnavailable();
        }
        if (isFinalCheck) {
          schedule(() => stop(true), CONVERSATION_SEARCH_PAGINATION_RELEASE_DELAY_MS);
        }
      } catch (error) {
        try {
          onError(error);
        } finally {
          stop(true);
        }
      }
    }, delayMs);
  });

  return () => stop(false);
};
