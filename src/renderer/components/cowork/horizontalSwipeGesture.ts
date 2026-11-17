/**
 * Turns horizontal wheel events into a back/forward swipe.
 *
 * Electron has no reliable two-finger swipe event (BrowserWindow 'swipe' needs
 * a non-default macOS trackpad setting and does not exist on Windows), but a
 * two-finger horizontal swipe on a macOS trackpad or a Windows precision
 * touchpad reaches the page as wheel events with deltaX. Each gesture locks to
 * one axis at its start, so vertical scrolling with some sideways drift never
 * switches sessions, and fires at most once until the wheel goes quiet.
 */

export const SwipeDirection = {
  Back: 'back',
  Forward: 'forward',
} as const;
export type SwipeDirection = typeof SwipeDirection[keyof typeof SwipeDirection];

export const SwipePhase = {
  /** Not decided yet, or no gesture running. */
  Idle: 'idle',
  /** Horizontal gesture under way; progress is in [0, 1). */
  Tracking: 'tracking',
  /** The threshold was crossed on this event; navigate now. */
  Triggered: 'triggered',
  /** The gesture is vertical, already fired, or belongs to scrollable content. */
  Ignored: 'ignored',
} as const;
export type SwipePhase = typeof SwipePhase[keyof typeof SwipePhase];

export interface SwipeWheelSample {
  deltaX: number;
  deltaY: number;
  /** Event time in ms. */
  timeStamp: number;
}

export interface SwipeUpdate {
  phase: SwipePhase;
  /** Set while tracking or on the triggering event. */
  direction: SwipeDirection | null;
  progress: number;
}

export interface HorizontalSwipeOptions {
  /** Horizontal distance in px that commits the swipe. */
  threshold: number;
  /** A pause this long between wheel events ends the gesture. */
  gestureGapMs: number;
  /** Distance in px the gesture travels before its axis is decided. */
  axisDecisionDistance: number;
  /** Horizontal travel must beat vertical travel by this factor. */
  horizontalDominance: number;
}

export const DEFAULT_HORIZONTAL_SWIPE_OPTIONS: HorizontalSwipeOptions = {
  threshold: 160,
  gestureGapMs: 220,
  axisDecisionDistance: 10,
  horizontalDominance: 1.6,
};

const GestureState = {
  Undecided: 'undecided',
  Horizontal: 'horizontal',
  Done: 'done',
} as const;
type GestureState = typeof GestureState[keyof typeof GestureState];

const IDLE_UPDATE: SwipeUpdate = { phase: SwipePhase.Idle, direction: null, progress: 0 };
const IGNORED_UPDATE: SwipeUpdate = { phase: SwipePhase.Ignored, direction: null, progress: 0 };

/** Scrolling left reveals what came before, the same mapping browsers use. */
const directionOf = (distanceX: number): SwipeDirection => (
  distanceX < 0 ? SwipeDirection.Back : SwipeDirection.Forward
);

export class HorizontalSwipeDetector {
  private readonly options: HorizontalSwipeOptions;
  private state: GestureState = GestureState.Undecided;
  private lastTimeStamp = Number.NEGATIVE_INFINITY;
  private distanceX = 0;
  private distanceY = 0;

  constructor(options: Partial<HorizontalSwipeOptions> = {}) {
    this.options = { ...DEFAULT_HORIZONTAL_SWIPE_OPTIONS, ...options };
  }

  /** Whether the next sample starts a new gesture. */
  isGestureStart(timeStamp: number): boolean {
    return timeStamp - this.lastTimeStamp > this.options.gestureGapMs;
  }

  reset(): void {
    this.state = GestureState.Undecided;
    this.lastTimeStamp = Number.NEGATIVE_INFINITY;
    this.distanceX = 0;
    this.distanceY = 0;
  }

  /**
   * Feeds one wheel event. `claimed` marks a gesture that started over content
   * which scrolls horizontally itself; that content keeps the whole gesture.
   */
  feed(sample: SwipeWheelSample, claimed = false): SwipeUpdate {
    if (this.isGestureStart(sample.timeStamp)) {
      this.reset();
      if (claimed) this.state = GestureState.Done;
    }
    this.lastTimeStamp = sample.timeStamp;
    if (this.state === GestureState.Done) return IGNORED_UPDATE;

    this.distanceX += sample.deltaX;
    this.distanceY += sample.deltaY;

    if (this.state === GestureState.Undecided) {
      const absX = Math.abs(this.distanceX);
      const absY = Math.abs(this.distanceY);
      if (absX + absY < this.options.axisDecisionDistance) return IDLE_UPDATE;
      if (absX < absY * this.options.horizontalDominance) {
        this.state = GestureState.Done;
        return IGNORED_UPDATE;
      }
      this.state = GestureState.Horizontal;
    }

    const direction = directionOf(this.distanceX);
    const progress = Math.abs(this.distanceX) / this.options.threshold;
    if (progress >= 1) {
      this.state = GestureState.Done;
      return { phase: SwipePhase.Triggered, direction, progress: 1 };
    }
    return { phase: SwipePhase.Tracking, direction, progress };
  }
}

/** Wheel deltas in px, whatever unit the event reports them in. */
export const normalizeWheelDelta = (
  delta: number,
  deltaMode: number,
  pageSize: number,
): number => {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * pageSize;
  return delta;
};

const HORIZONTALLY_SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

/** Whether any element from target up to (not including) boundary scrolls horizontally. */
export const isInsideHorizontalScroller = (
  target: Element | null,
  boundary: Element,
  getOverflowX: (element: Element) => string = element => getComputedStyle(element).overflowX,
): boolean => {
  let element: Element | null = target;
  while (element && element !== boundary) {
    if (
      element.scrollWidth > element.clientWidth + 1
      && HORIZONTALLY_SCROLLABLE_OVERFLOW.has(getOverflowX(element))
    ) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
};
