import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { usePointerPassThrough } from './usePointerPassThrough';

vi.mock('react', () => ({ useEffect: vi.fn() }));

describe('companion pointer pass-through', () => {
  let root: EventTarget;
  let windowTarget: EventTarget;
  let cleanup: (() => void) | void;
  const setPassThrough = vi.fn();
  const card = { closest: () => card };
  const margin = { closest: () => null };

  const move = (target: EventTarget, type: string, x: number, y: number) => {
    target.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y }));
  };

  function TestSurface({ surfaceKey, initialPassThrough }: { surfaceKey: string | null; initialPassThrough: boolean }) {
    usePointerPassThrough(surfaceKey, setPassThrough, initialPassThrough);
    return null;
  }

  const mount = (key: string | null = 'selection', initialPassThrough = true) => {
    TestSurface({ surfaceKey: key, initialPassThrough });
    const effects = vi.mocked(useEffect).mock.calls;
    cleanup = effects[effects.length - 1][0]();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    root = new EventTarget();
    windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('document', {
      documentElement: root,
      elementFromPoint: (x: number, y: number) => {
        if (x < 0 || x >= 444 || y < 0 || y >= 244) return null;
        return x >= 22 && x < 422 && y >= 22 && y < 222 ? card : margin;
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
  });

  test('entering the native title bar keeps clicks on the card after a renderer mouseleave', () => {
    mount();
    move(windowTarget, 'mousemove', 222, 120);
    // Electron owns the title bar, so this event comes from the root even
    // though the pointer is still over the drag grip inside the card.
    move(root, 'mouseleave', 222, 30);
    move(root, 'mouseleave', 180, 40);
    expect(setPassThrough.mock.calls).toEqual([[true], [false]]);
  });

  test('a forwarded move directly from the margin to the title bar captures clicks', () => {
    mount();
    move(windowTarget, 'mousemove', 222, 10);
    move(windowTarget, 'mousemove', 222, 30);
    expect(setPassThrough.mock.calls).toEqual([[true], [false]]);
  });

  test('only the transparent margin or a real window exit restores pass-through', () => {
    mount();
    move(windowTarget, 'mousemove', 222, 30);
    move(root, 'mouseleave', 222, 10);
    move(windowTarget, 'mousemove', 222, 120);
    move(root, 'mouseleave', -1, 120);
    expect(setPassThrough.mock.calls).toEqual([[true], [false], [true], [false], [true]]);
  });

  test('preserves an initially interactive surface and removes its listeners on cleanup', () => {
    mount('result', false);
    move(windowTarget, 'mousemove', 222, 120);
    expect(setPassThrough.mock.calls).toEqual([[false]]);
    cleanup?.();
    cleanup = undefined;
    move(windowTarget, 'mousemove', 5, 5);
    move(root, 'mouseleave', -1, 120);
    expect(setPassThrough.mock.calls).toEqual([[false]]);
  });

  test('does not change mouse handling when no surface is open', () => {
    mount(null);
    move(windowTarget, 'mousemove', 222, 120);
    move(root, 'mouseleave', -1, 120);
    expect(setPassThrough).not.toHaveBeenCalled();
  });
});
