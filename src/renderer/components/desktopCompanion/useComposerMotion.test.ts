import { type EffectCallback, type RefObject, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DesktopCompanionPanelPlacement } from '../../../shared/desktopCompanion/constants';
import { ComposerExit, useComposerMotion } from './useComposerMotion';

vi.mock('react', () => ({
  useLayoutEffect: vi.fn(),
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
}));

const panelReady = vi.fn<(revision: number) => Promise<boolean>>();
let reducedMotion = false;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
let cleanup: ReturnType<EffectCallback>;
let animation: {
  currentTime: number | null;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  finished: Promise<void>;
};
let element: { style: { opacity: string; transformOrigin: string }; animate: ReturnType<typeof vi.fn> };

function TestComposer(visible = true, revision = 10) {
  const exit = useComposerMotion(
    { current: element } as unknown as RefObject<HTMLElement>, visible, DesktopCompanionPanelPlacement.Left, revision,
  );
  const effects = vi.mocked(useLayoutEffect).mock.calls;
  cleanup = effects[effects.length - 1][0]();
  return exit;
}

function nextFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach(callback => callback(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  frames = new Map();
  frameId = 0;
  reducedMotion = false;
  panelReady.mockResolvedValue(true);
  animation = { currentTime: null, pause: vi.fn(), play: vi.fn(), cancel: vi.fn(), finished: Promise.resolve() };
  element = { style: { opacity: '', transformOrigin: '' }, animate: vi.fn(() => animation) };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: reducedMotion }),
    electron: { desktopCompanion: { panelReady } },
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('composer opening motion', () => {
  test('paints the paused first frame before revealing the window and playing the entrance', async () => {
    let reveal: (shown: boolean) => void = () => {};
    panelReady.mockReturnValue(new Promise(resolve => { reveal = resolve; }));
    TestComposer();
    expect(animation.pause).toHaveBeenCalledOnce();
    expect(animation.currentTime).toBe(0);
    nextFrame();
    expect(panelReady).not.toHaveBeenCalled();
    nextFrame();
    expect(panelReady).toHaveBeenCalledExactlyOnceWith(10);
    expect(animation.play).not.toHaveBeenCalled();
    reveal(true);
    await Promise.resolve();
    expect(animation.play).toHaveBeenCalledOnce();
  });

  test('closing before paint cancels the entrance and never requests a native show', () => {
    TestComposer();
    nextFrame();
    cleanup?.();
    TestComposer(false);
    nextFrame();
    expect(animation.cancel).toHaveBeenCalled();
    expect(element.style.opacity).toBe('0');
    expect(panelReady).not.toHaveBeenCalled();
  });

  test('a delayed reply cannot restart an entrance after it was closed', async () => {
    let reveal: (shown: boolean) => void = () => {};
    panelReady.mockReturnValue(new Promise(resolve => { reveal = resolve; }));
    TestComposer();
    nextFrame();
    nextFrame();
    cleanup?.();
    TestComposer(false);
    reveal(true);
    await Promise.resolve();
    expect(animation.play).not.toHaveBeenCalled();
    expect(element.style.opacity).toBe('0');
  });

  test('an invalidated opening does not play, and a new opening has its own acknowledgement', async () => {
    panelReady.mockResolvedValueOnce(false);
    TestComposer(true, 10);
    nextFrame();
    nextFrame();
    await Promise.resolve();
    expect(animation.play).not.toHaveBeenCalled();
    cleanup?.();
    // A rapid close/reopen may never render visible=false; the opening revision changes.
    TestComposer(true, 12);
    nextFrame();
    nextFrame();
    await Promise.resolve();
    expect(panelReady.mock.calls).toEqual([[10], [12]]);
    expect(animation.play).toHaveBeenCalledOnce();
  });

  test('reduced motion still paints and reveals the card without an animation', async () => {
    reducedMotion = true;
    TestComposer();
    nextFrame();
    nextFrame();
    await Promise.resolve();
    expect(panelReady).toHaveBeenCalledExactlyOnceWith(10);
    expect(element.animate).not.toHaveBeenCalled();
    expect(element.style.opacity).toBe('');
  });

  test('an exit replaces the entrance instead of leaving two animations on the card', async () => {
    const exit = TestComposer();
    nextFrame();
    nextFrame();
    await Promise.resolve();
    await exit(ComposerExit.Dismiss);
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(element.animate).toHaveBeenCalledTimes(2);
  });
});
