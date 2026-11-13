import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DesktopCompanionSize, DesktopCompanionTiming } from '../../shared/desktopCompanion/constants';
import type { CompanionPoint, CompanionRect } from '../../shared/desktopCompanion/geometry';
import { CompanionLauncherHover } from './companionLauncher';

const { LauncherOpenDelayMs: openDelay, LauncherCloseDelayMs: closeDelay, LauncherPollMs: poll } = DesktopCompanionTiming;
const orb = { x: 1200, y: 400, ...DesktopCompanionSize.BrandOrb };
const card = { x: orb.x - 254, y: orb.y - 150, width: 276, height: 223 };
const onOrb = { x: orb.x + 30, y: orb.y + 30 };
const onCard = { x: card.x + 100, y: card.y + 100 };
const away = { x: 200, y: 200 };
let hover: CompanionLauncherHover;

function setup() {
  let open = false;
  const host = {
    getCursor: vi.fn<() => CompanionPoint>(() => onOrb),
    getOrbBounds: vi.fn<() => CompanionRect | null>(() => orb),
    getCardBounds: vi.fn<() => CompanionRect | null>(() => (open ? card : null)),
    canOpen: vi.fn(() => true),
    isOpen: vi.fn(() => open),
    open: vi.fn(() => { open = true; return true; }),
    close: vi.fn(() => { open = false; }),
    /** Something else took the stage. */
    replace: () => { open = false; },
  };
  hover = new CompanionLauncherHover(host);
  return host;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { hover?.reset(); vi.useRealTimers(); });

describe('launcher hover intent', () => {
  test('opens once the pointer has rested on the orb, not when it only passes over', () => {
    const host = setup();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay - 1);
    hover.setOrbHover(false);
    vi.advanceTimersByTime(openDelay * 2);
    expect(host.open).not.toHaveBeenCalled();

    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay - 1);
    expect(host.open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.open).toHaveBeenCalledOnce();
  });

  test('does not open when something more important is showing, or the pointer left unreported', () => {
    const host = setup();
    host.canOpen.mockReturnValue(false);
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay);
    expect(host.open).not.toHaveBeenCalled();

    host.canOpen.mockReturnValue(true);
    hover.setOrbHover(false);
    hover.setOrbHover(true);
    host.getCursor.mockReturnValue(away);
    vi.advanceTimersByTime(openDelay);
    expect(host.open).not.toHaveBeenCalled();
  });

  test('stays while the pointer moves between the orb and the card', () => {
    const host = setup();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay);
    hover.setOrbHover(false);
    host.getCursor.mockReturnValue(onCard);
    vi.advanceTimersByTime(closeDelay * 4);
    host.getCursor.mockReturnValue(onOrb);
    hover.setOrbHover(true);
    vi.advanceTimersByTime(closeDelay * 4);
    expect(host.close).not.toHaveBeenCalled();
    expect(host.open).toHaveBeenCalledOnce();
  });

  test('closes after the pointer has been away for a moment, and forgives a brief overshoot', () => {
    const host = setup();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay);
    host.getCursor.mockReturnValue(away);
    vi.advanceTimersByTime(closeDelay - poll);
    host.getCursor.mockReturnValue(onCard);
    vi.advanceTimersByTime(poll * 2);
    host.getCursor.mockReturnValue(away);
    vi.advanceTimersByTime(closeDelay);
    expect(host.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(poll * 2);
    expect(host.close).toHaveBeenCalledOnce();

    const reads = host.getCursor.mock.calls.length;
    vi.advanceTimersByTime(closeDelay * 4);
    expect(host.getCursor).toHaveBeenCalledTimes(reads);
  });

  test('a press closes it and keeps it closed until the pointer leaves and comes back', () => {
    const host = setup();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay);
    hover.suppress();
    expect(host.close).toHaveBeenCalledOnce();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay * 2);
    expect(host.open).toHaveBeenCalledOnce();

    hover.setOrbHover(false);
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay);
    expect(host.open).toHaveBeenCalledTimes(2);
  });

  test('a press before it opens cancels the pending opening', () => {
    const host = setup();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay - 1);
    hover.suppress();
    vi.advanceTimersByTime(openDelay);
    expect(host.open).not.toHaveBeenCalled();
    expect(host.close).not.toHaveBeenCalled();
  });

  test('stops watching when something else takes its place, without closing that', () => {
    const host = setup();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay);
    host.replace();
    host.getCursor.mockReturnValue(away);
    vi.advanceTimersByTime(closeDelay * 4);
    expect(host.close).not.toHaveBeenCalled();
    const reads = host.getCursor.mock.calls.length;
    vi.advanceTimersByTime(closeDelay * 4);
    expect(host.getCursor).toHaveBeenCalledTimes(reads);
  });

  test('losing the orb closes an open launcher', () => {
    const host = setup();
    hover.setOrbHover(true);
    vi.advanceTimersByTime(openDelay);
    host.getOrbBounds.mockReturnValue(null);
    host.getCursor.mockReturnValue(onOrb);
    vi.advanceTimersByTime(closeDelay + poll * 2);
    expect(host.close).toHaveBeenCalledOnce();
  });
});
