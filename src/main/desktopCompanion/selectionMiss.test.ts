import { beforeEach, expect, test, vi } from 'vitest';

import { SELECTION_MISS_WAIT_MS, SelectionMissTracker } from './selectionMiss';

let onMiss: ReturnType<typeof vi.fn>;
let tracker: SelectionMissTracker;

beforeEach(() => {
  vi.useFakeTimers();
  onMiss = vi.fn();
  tracker = new SelectionMissTracker(onMiss);
});

test('reports the app once when no selection follows the gesture in time', () => {
  tracker.expect('wps.exe');
  vi.advanceTimersByTime(SELECTION_MISS_WAIT_MS - 1);
  expect(onMiss).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onMiss).toHaveBeenCalledExactlyOnceWith('wps.exe');
});

test('a selection arriving in time is not a miss', () => {
  tracker.expect('wps.exe');
  vi.advanceTimersByTime(500);
  tracker.resolve();
  vi.advanceTimersByTime(SELECTION_MISS_WAIT_MS);
  expect(onMiss).not.toHaveBeenCalled();
});

test('a selection handled just before its own release is not a miss', () => {
  tracker.resolve();
  vi.advanceTimersByTime(50);
  tracker.expect('chrome.exe');
  vi.advanceTimersByTime(SELECTION_MISS_WAIT_MS);
  expect(onMiss).not.toHaveBeenCalled();
});

test('a newer gesture replaces the one being watched', () => {
  tracker.expect('chrome.exe');
  vi.advanceTimersByTime(1_000);
  tracker.expect('wps.exe');
  vi.advanceTimersByTime(SELECTION_MISS_WAIT_MS);
  expect(onMiss).toHaveBeenCalledExactlyOnceWith('wps.exe');
});

test('cancel drops the gesture being watched', () => {
  tracker.expect('wps.exe');
  tracker.cancel();
  vi.advanceTimersByTime(SELECTION_MISS_WAIT_MS);
  expect(onMiss).not.toHaveBeenCalled();
});
