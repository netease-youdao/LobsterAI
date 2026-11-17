import { describe, expect, test } from 'vitest';

import {
  HorizontalSwipeDetector,
  isInsideHorizontalScroller,
  normalizeWheelDelta,
  SwipeDirection,
  SwipePhase,
} from './horizontalSwipeGesture';

const OPTIONS = { threshold: 100, gestureGapMs: 200, axisDecisionDistance: 10, horizontalDominance: 1.5 };

const feedAll = (
  detector: HorizontalSwipeDetector,
  samples: Array<[deltaX: number, deltaY: number]>,
  startTime = 1000,
  claimed = false,
) => samples.map(([deltaX, deltaY], index) => detector.feed({ deltaX, deltaY, timeStamp: startTime + index * 16 }, claimed));

describe('HorizontalSwipeDetector', () => {
  test('a leftward scroll swipes back once the threshold is crossed', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    const updates = feedAll(detector, [[-20, 0], [-30, 1], [-30, 0], [-30, 0]]);
    expect(updates.slice(0, 3).map(update => update.phase)).toEqual([
      SwipePhase.Tracking,
      SwipePhase.Tracking,
      SwipePhase.Tracking,
    ]);
    expect(updates[1].progress).toBeCloseTo(0.5);
    expect(updates[3]).toEqual({ phase: SwipePhase.Triggered, direction: SwipeDirection.Back, progress: 1 });
  });

  test('a rightward scroll swipes forward', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    const updates = feedAll(detector, [[60, 0], [60, 0]]);
    expect(updates[1]).toMatchObject({ phase: SwipePhase.Triggered, direction: SwipeDirection.Forward });
  });

  test('fires once per gesture, so momentum does not switch twice', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    const updates = feedAll(detector, [[-120, 0], [-120, 0], [-120, 0], [-60, 0]]);
    expect(updates.filter(update => update.phase === SwipePhase.Triggered)).toHaveLength(1);
    expect(updates.slice(1).every(update => update.phase === SwipePhase.Ignored)).toBe(true);
  });

  test('a pause starts a new gesture that can fire again', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    feedAll(detector, [[-120, 0]], 1000);
    const [next] = feedAll(detector, [[-120, 0]], 1500);
    expect(next.phase).toBe(SwipePhase.Triggered);
  });

  test('vertical scrolling with sideways drift never swipes', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    const updates = feedAll(detector, [[4, 12], [8, 30], [-60, 10], [-80, 0], [-80, 0]]);
    expect(updates.some(update => update.phase === SwipePhase.Triggered)).toBe(false);
    expect(updates[updates.length - 1].phase).toBe(SwipePhase.Ignored);
  });

  test('waits for enough travel before deciding the axis', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    const [first] = feedAll(detector, [[-3, 0]]);
    expect(first.phase).toBe(SwipePhase.Idle);
  });

  test('a gesture claimed by horizontally scrollable content is ignored throughout', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    const updates = feedAll(detector, [[-120, 0], [-120, 0]], 1000, true);
    expect(updates.every(update => update.phase === SwipePhase.Ignored)).toBe(true);
  });

  test('reversing direction mid-gesture follows the fingers', () => {
    const detector = new HorizontalSwipeDetector(OPTIONS);
    const updates = feedAll(detector, [[-40, 0], [50, 0]]);
    expect(updates[0].direction).toBe(SwipeDirection.Back);
    expect(updates[1]).toMatchObject({ phase: SwipePhase.Tracking, direction: SwipeDirection.Forward });
  });
});

describe('normalizeWheelDelta', () => {
  test('converts line and page deltas to pixels', () => {
    expect(normalizeWheelDelta(3, 0, 800)).toBe(3);
    expect(normalizeWheelDelta(3, 1, 800)).toBe(48);
    expect(normalizeWheelDelta(1, 2, 800)).toBe(800);
  });
});

describe('isInsideHorizontalScroller', () => {
  const element = (scrollWidth: number, clientWidth: number, parentElement: Element | null = null) => (
    { scrollWidth, clientWidth, parentElement } as unknown as Element
  );

  test('finds an overflowing auto-scroll ancestor below the boundary', () => {
    const boundary = element(500, 500);
    const scroller = element(900, 500, boundary);
    const target = element(100, 100, scroller);
    const overflow = new Map<Element, string>([[scroller, 'auto']]);
    expect(isInsideHorizontalScroller(target, boundary, el => overflow.get(el) ?? 'visible')).toBe(true);
  });

  test('ignores clipped overflow and content that fits', () => {
    const boundary = element(500, 500);
    const clipped = element(900, 500, boundary);
    const fits = element(400, 400, clipped);
    const overflow = new Map<Element, string>([[clipped, 'hidden'], [fits, 'auto']]);
    expect(isInsideHorizontalScroller(fits, boundary, el => overflow.get(el) ?? 'visible')).toBe(false);
  });

  test('does not look at the boundary or above it', () => {
    const outer = element(900, 500);
    const boundary = element(900, 500, outer);
    const target = element(100, 100, boundary);
    expect(isInsideHorizontalScroller(target, boundary, () => 'auto')).toBe(false);
  });
});
