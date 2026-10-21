import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DesktopCompanionSize, DesktopCompanionTiming } from '../../shared/desktopCompanion/constants';
import type { CompanionRect } from '../../shared/desktopCompanion/geometry';
import { CompanionFileDragProximity } from './fileDragProximity';

const dwell = DesktopCompanionTiming.DropExpandDelayMs + DesktopCompanionTiming.DropProximityPollMs;
const orb = { x: -400, y: 40, ...DesktopCompanionSize.BrandOrb };
const center = { x: orb.x + orb.width / 2, y: orb.y + orb.height / 2 };
const radius = orb.width / 2 + DesktopCompanionSize.DropProximityPadding;
const near = { x: center.x + radius - 1, y: center.y };
const far = { x: center.x + radius + 100, y: center.y };
let watcher: CompanionFileDragProximity;

function setup() {
  const host = {
    getCursor: vi.fn(() => far),
    getOrbBounds: vi.fn<() => CompanionRect | null>(() => orb),
    onEnter: vi.fn(),
    onLeave: vi.fn(),
  };
  watcher = new CompanionFileDragProximity(host);
  return host;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { watcher?.stop(); vi.useRealTimers(); });

describe('file drag proximity', () => {
  test('opens after dwelling outside the native orb window, including on a display with negative coordinates', () => {
    const host = setup();
    watcher.start();
    vi.advanceTimersByTime(dwell * 2);
    expect(host.onEnter).not.toHaveBeenCalled();
    expect(near.x).toBeGreaterThan(orb.x + orb.width);
    host.getCursor.mockReturnValue(near);
    vi.advanceTimersByTime(dwell);
    expect(host.onEnter).toHaveBeenCalledTimes(1);
    expect(watcher.isActive).toBe(true);
    vi.advanceTimersByTime(dwell * 2);
    expect(host.onEnter).toHaveBeenCalledTimes(1);
  });

  test('briefly passing nearby does not accumulate dwell across separate visits', () => {
    const host = setup();
    host.getCursor.mockReturnValue(near);
    watcher.start();
    vi.advanceTimersByTime(DesktopCompanionTiming.DropProximityPollMs);
    host.getCursor.mockReturnValue(far);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropProximityPollMs);
    host.getCursor.mockReturnValue(near);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropExpandDelayMs);
    expect(host.onEnter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DesktopCompanionTiming.DropProximityPollMs);
    expect(host.onEnter).toHaveBeenCalledTimes(1);
  });

  test('uses a wider exit boundary so small pointer movements do not flicker', () => {
    const host = setup();
    host.getCursor.mockReturnValue(near);
    watcher.start();
    vi.advanceTimersByTime(dwell);
    host.getCursor.mockReturnValue({ x: center.x + radius + 10, y: center.y });
    vi.advanceTimersByTime(dwell);
    expect(host.onLeave).not.toHaveBeenCalled();
    host.getCursor.mockReturnValue({ x: center.x + radius + DesktopCompanionSize.DropProximityExitPadding + 1, y: center.y });
    vi.advanceTimersByTime(dwell);
    expect(host.onLeave).toHaveBeenCalledTimes(1);
    expect(watcher.isActive).toBe(false);
  });

  test('has a circular boundary rather than triggering at distant rectangle corners', () => {
    const host = setup();
    host.getCursor.mockReturnValue({ x: center.x + radius - 1, y: center.y + radius - 1 });
    watcher.start();
    vi.advanceTimersByTime(dwell);
    expect(host.onEnter).not.toHaveBeenCalled();
  });

  test('stopping a drag cancels pending expansion and stops polling', () => {
    const host = setup();
    host.getCursor.mockReturnValue(near);
    watcher.start();
    vi.advanceTimersByTime(DesktopCompanionTiming.DropProximityPollMs);
    watcher.stop();
    const reads = host.getCursor.mock.calls.length;
    vi.advanceTimersByTime(dwell * 2);
    expect(host.onEnter).not.toHaveBeenCalled();
    expect(host.getCursor).toHaveBeenCalledTimes(reads);
    watcher.start();
    vi.advanceTimersByTime(dwell);
    expect(host.onEnter).toHaveBeenCalledTimes(1);
  });

  test('losing the orb dismisses an active approach', () => {
    const host = setup();
    host.getCursor.mockReturnValue(near);
    watcher.start();
    vi.advanceTimersByTime(dwell);
    host.getOrbBounds.mockReturnValue(null);
    vi.advanceTimersByTime(dwell);
    expect(host.onLeave).toHaveBeenCalledTimes(1);
  });
});
