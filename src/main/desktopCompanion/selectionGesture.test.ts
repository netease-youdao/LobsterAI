import { describe, expect, test } from 'vitest';

import { SelectionGestureTracker } from './selectionGesture';

function click(tracker: SelectionGestureTracker, x: number, at: number, held = 80): boolean {
  tracker.down({ x, y: 100 }, at);
  return tracker.up({ x, y: 100 }, at + held) !== null;
}

describe('SelectionGestureTracker', () => {
  test('a drag of at least 8 points selects; a smaller one is a click', () => {
    const tracker = new SelectionGestureTracker();
    tracker.down({ x: 100, y: 100 }, 0);
    expect(tracker.up({ x: 107, y: 100 }, 300)).toBeNull();
    tracker.down({ x: 100, y: 100 }, 2_000);
    expect(tracker.up({ x: 100, y: 108 }, 2_300)).toEqual({ start: { x: 100, y: 100 }, end: { x: 100, y: 108 } });
  });

  test('a press held longer than 15 s is not a selection', () => {
    const tracker = new SelectionGestureTracker();
    tracker.down({ x: 100, y: 100 }, 0);
    expect(tracker.up({ x: 300, y: 100 }, 15_001)).toBeNull();
  });

  test('two quick clicks in place make a double-click, and a third click still counts', () => {
    const tracker = new SelectionGestureTracker();
    expect(click(tracker, 100, 0)).toBe(false);
    expect(click(tracker, 102, 200)).toBe(true);
    expect(click(tracker, 101, 400)).toBe(true);
  });

  test('a double-click is reported where its second click was pressed and released', () => {
    const tracker = new SelectionGestureTracker();
    click(tracker, 100, 0);
    tracker.down({ x: 101, y: 100 }, 200);
    expect(tracker.up({ x: 102, y: 101 }, 280)).toEqual({ start: { x: 101, y: 100 }, end: { x: 102, y: 101 } });
  });

  test('a slow, moved, or long-held second click is not a double-click', () => {
    const tracker = new SelectionGestureTracker();
    click(tracker, 100, 0);
    expect(click(tracker, 100, 700)).toBe(false);
    expect(click(tracker, 104, 900)).toBe(false);
    expect(click(tracker, 104, 1_100, 600)).toBe(false);
  });

  test('a release without a press is ignored and forgets the previous click', () => {
    const tracker = new SelectionGestureTracker();
    click(tracker, 100, 0);
    expect(tracker.up({ x: 100, y: 100 }, 150)).toBeNull();
    expect(click(tracker, 100, 250)).toBe(false);
  });
});
