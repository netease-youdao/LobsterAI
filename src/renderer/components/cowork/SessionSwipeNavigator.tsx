import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { sessionNavigationService } from '../../services/sessionNavigation';
import { SessionHistoryDirection } from '../../services/sessionNavigationHistory';
import {
  DEFAULT_HORIZONTAL_SWIPE_OPTIONS,
  HorizontalSwipeDetector,
  isInsideHorizontalScroller,
  normalizeWheelDelta,
  SwipeDirection,
  SwipePhase,
} from './horizontalSwipeGesture';

/** Areas marked data-session-swipe-area="true" step through viewed sessions on a horizontal swipe. */
const SESSION_SWIPE_AREA_SELECTOR = '[data-session-swipe-area="true"]';

const INDICATOR_SIZE = 36;
const INDICATOR_EDGE_GAP = 16;
const INDICATOR_TRAVEL = 28;
const INDICATOR_LINGER_MS = DEFAULT_HORIZONTAL_SWIPE_OPTIONS.gestureGapMs + 40;
const INDICATOR_COMMIT_MS = 260;

interface SwipeIndicator {
  direction: SessionHistoryDirection;
  progress: number;
  triggered: boolean;
  areaLeft: number;
  areaRight: number;
  areaCenterY: number;
}

const toHistoryDirection = (direction: SwipeDirection): SessionHistoryDirection => (
  direction === SwipeDirection.Back ? SessionHistoryDirection.Back : SessionHistoryDirection.Forward
);

/**
 * Listens for horizontal two-finger swipes over any session swipe area and
 * steps back/forward through viewed sessions, with an edge arrow that follows
 * the fingers the way Safari's back/forward swipe does. The wheel listener is
 * passive, so vertical scrolling is never delayed.
 */
const SessionSwipeNavigator: React.FC = () => {
  const [indicator, setIndicator] = useState<SwipeIndicator | null>(null);

  useEffect(() => {
    const detector = new HorizontalSwipeDetector();
    let area: Element | null = null;
    let claimed = true;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const hideAfter = (delayMs: number) => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setIndicator(null), delayMs);
    };

    const handleWheel = (event: WheelEvent) => {
      // Ctrl is a pinch zoom; Shift turns a mouse wheel sideways on purpose.
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

      const target = event.target instanceof Element ? event.target : null;
      if (detector.isGestureStart(event.timeStamp)) {
        area = target?.closest(SESSION_SWIPE_AREA_SELECTOR) ?? null;
        claimed = !area || isInsideHorizontalScroller(target, area);
      }

      const update = detector.feed({
        deltaX: normalizeWheelDelta(event.deltaX, event.deltaMode, window.innerWidth),
        deltaY: normalizeWheelDelta(event.deltaY, event.deltaMode, window.innerHeight),
        timeStamp: event.timeStamp,
      }, claimed);
      if (!area || !update.direction) return;
      if (update.phase !== SwipePhase.Tracking && update.phase !== SwipePhase.Triggered) return;

      const direction = toHistoryDirection(update.direction);
      if (!sessionNavigationService.canNavigate(direction)) {
        // Nothing that way: show no arrow, like a browser with no history.
        setIndicator(null);
        return;
      }

      const rect = area.getBoundingClientRect();
      const triggered = update.phase === SwipePhase.Triggered;
      setIndicator({
        direction,
        progress: update.progress,
        triggered,
        areaLeft: rect.left,
        areaRight: rect.right,
        areaCenterY: rect.top + rect.height / 2,
      });
      if (triggered) {
        void sessionNavigationService.navigate(direction);
        hideAfter(INDICATOR_COMMIT_MS);
      } else {
        hideAfter(INDICATOR_LINGER_MS);
      }
    };

    document.addEventListener('wheel', handleWheel, { passive: true, capture: true });
    return () => {
      document.removeEventListener('wheel', handleWheel, { capture: true });
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  if (!indicator) return null;

  const isBack = indicator.direction === SessionHistoryDirection.Back;
  const slide = (1 - indicator.progress) * INDICATOR_TRAVEL;
  const Icon = isBack ? ChevronLeftIcon : ChevronRightIcon;
  const style: React.CSSProperties = {
    top: indicator.areaCenterY - INDICATOR_SIZE / 2,
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    opacity: Math.min(1, 0.2 + indicator.progress),
    transform: `translateX(${isBack ? -slide : slide}px) scale(${indicator.triggered ? 1.08 : 1})`,
    ...(isBack
      ? { left: indicator.areaLeft + INDICATOR_EDGE_GAP }
      : { left: indicator.areaRight - INDICATOR_EDGE_GAP - INDICATOR_SIZE }),
  };

  return createPortal(
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed z-50 flex items-center justify-center rounded-full border shadow-lg transition-[transform,opacity,background-color] duration-100 ease-out ${
        indicator.triggered
          ? 'border-primary bg-primary text-white'
          : 'border-border bg-surface text-secondary'
      }`}
      style={style}
    >
      <Icon className="h-5 w-5" strokeWidth={2} />
    </div>,
    document.body,
  );
};

export default SessionSwipeNavigator;
