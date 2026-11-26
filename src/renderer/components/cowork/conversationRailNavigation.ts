export const RAIL_NAVIGATION_TOP_OFFSET_PX = 12;
export const RAIL_NAVIGATION_SETTLE_TOLERANCE_PX = 4;
export const RAIL_NAVIGATION_WINDOW_PAGE_SIZE = 60;
export const RAIL_NAVIGATION_WINDOW_LEADING_CONTEXT = 6;
export const RAIL_NAVIGATION_SETTLE_DELAYS_MS = [120, 360, 800] as const;
export const RAIL_NAVIGATION_PAGINATION_RELEASE_DELAY_MS = 120;

export const RailNavigationMode = {
  ScrollLoadedDom: 'scroll_loaded_dom',
  ForceRenderLoadedTurn: 'force_render_loaded_turn',
  LoadMessageWindow: 'load_message_window',
  RefreshRailIndex: 'refresh_rail_index',
} as const;
export type RailNavigationMode = typeof RailNavigationMode[keyof typeof RailNavigationMode];

export interface RailNavigationTargetLike {
  messageId: string | null;
  turnIndex: number;
  isLoaded: boolean;
  isPlaceholder?: boolean;
}

export interface RailNavigationScrollContainer {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect: () => { top: number };
  scrollTo: (options: { top: number; behavior: ScrollBehavior }) => void;
  addEventListener: (
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}

const RAIL_NAVIGATION_INTERRUPT_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;

export const resolveRailNavigationMode = (
  item: RailNavigationTargetLike,
  hasMountedMessageTarget: boolean,
): RailNavigationMode => {
  if (item.isPlaceholder || !item.messageId) {
    return RailNavigationMode.RefreshRailIndex;
  }
  if (hasMountedMessageTarget) {
    return RailNavigationMode.ScrollLoadedDom;
  }
  if (item.isLoaded && item.turnIndex >= 0) {
    return RailNavigationMode.ForceRenderLoadedTurn;
  }
  return RailNavigationMode.LoadMessageWindow;
};

export const getRailTargetScrollTop = (
  container: Pick<RailNavigationScrollContainer, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'getBoundingClientRect'>,
  targetTop: number,
  topOffset = RAIL_NAVIGATION_TOP_OFFSET_PX,
): number | null => {
  const containerTop = container.getBoundingClientRect().top;
  if (!Number.isFinite(containerTop) || !Number.isFinite(targetTop)) return null;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const rawTop = container.scrollTop + (targetTop - containerTop) - topOffset;
  if (!Number.isFinite(rawTop)) return null;
  return Math.max(0, Math.min(maxScrollTop, rawTop));
};

export const shouldAdjustRailTargetScroll = (
  currentScrollTop: number,
  desiredScrollTop: number,
  tolerance = RAIL_NAVIGATION_SETTLE_TOLERANCE_PX,
): boolean => (
  Number.isFinite(currentScrollTop)
  && Number.isFinite(desiredScrollTop)
  && Math.abs(desiredScrollTop - currentScrollTop) > tolerance
);

export const alignRailTargetInContainer = (
  container: Pick<RailNavigationScrollContainer, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'getBoundingClientRect' | 'scrollTo'>,
  targetRect: { top: number },
  behavior: ScrollBehavior,
  topOffset = RAIL_NAVIGATION_TOP_OFFSET_PX,
  tolerance = RAIL_NAVIGATION_SETTLE_TOLERANCE_PX,
): boolean => {
  const desiredTop = getRailTargetScrollTop(container, targetRect.top, topOffset);
  if (desiredTop === null) return false;
  if (!shouldAdjustRailTargetScroll(container.scrollTop, desiredTop, tolerance)) {
    return false;
  }
  container.scrollTo({ top: desiredTop, behavior });
  return true;
};

interface RailNavigationSettleOptions {
  isCurrent: () => boolean;
  getContainer: () => RailNavigationScrollContainer | null;
  getContentElement: () => HTMLElement | null;
  getTargetRect: () => { top: number } | null;
  allowContinuousCorrection: boolean;
  onRelease: () => void;
}

/**
 * Keeps a jumped-to rail turn pinned at the top of the viewport while sibling
 * lazy turns hydrate or images decode above it, and yields immediately when
 * the user manually scrolls or interacts with the conversation.
 */
export const scheduleRailNavigationSettle = ({
  isCurrent,
  getContainer,
  getContentElement,
  getTargetRect,
  allowContinuousCorrection,
  onRelease,
}: RailNavigationSettleOptions): (() => void) => {
  const timerIds = new Set<ReturnType<typeof setTimeout>>();
  let resizeObserver: ResizeObserver | null = null;
  let stopped = false;

  const container = getContainer();

  const cleanup = () => {
    timerIds.forEach(timerId => globalThis.clearTimeout(timerId));
    timerIds.clear();
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (container) {
      RAIL_NAVIGATION_INTERRUPT_EVENTS.forEach(type => {
        container.removeEventListener(type, handleUserInterrupt);
      });
    }
  };

  const stop = (release: boolean) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    if (release) onRelease();
  };

  const handleUserInterrupt: EventListener = () => {
    stop(true);
  };

  const correctPosition = () => {
    if (stopped) return;
    if (!isCurrent()) {
      stop(true);
      return;
    }
    const latestContainer = getContainer();
    const targetRect = getTargetRect();
    if (!latestContainer || !targetRect) return;
    alignRailTargetInContainer(latestContainer, targetRect, 'auto');
  };

  const schedule = (callback: () => void, delayMs: number) => {
    const timerId = globalThis.setTimeout(() => {
      timerIds.delete(timerId);
      if (!stopped) callback();
    }, delayMs);
    timerIds.add(timerId);
  };

  if (container) {
    RAIL_NAVIGATION_INTERRUPT_EVENTS.forEach(type => {
      container.addEventListener(type, handleUserInterrupt, { passive: true });
    });
  }

  const contentElement = getContentElement();
  if (allowContinuousCorrection && contentElement && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      correctPosition();
    });
    resizeObserver.observe(contentElement);
  }

  RAIL_NAVIGATION_SETTLE_DELAYS_MS.forEach((delayMs, index) => {
    const isFinalCheck = index === RAIL_NAVIGATION_SETTLE_DELAYS_MS.length - 1;
    schedule(() => {
      if (!isCurrent()) {
        stop(true);
        return;
      }
      if (allowContinuousCorrection) {
        correctPosition();
      }
      if (isFinalCheck) {
        schedule(() => stop(true), RAIL_NAVIGATION_PAGINATION_RELEASE_DELAY_MS);
      }
    }, delayMs);
  });

  return () => stop(false);
};
