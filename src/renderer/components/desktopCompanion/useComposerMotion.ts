import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

import { DesktopCompanionPanelPlacement } from '../../../shared/desktopCompanion/constants';

export const ComposerExit = { Dismiss: 'dismiss', Handoff: 'handoff' } as const;
export type ComposerExit = typeof ComposerExit[keyof typeof ComposerExit];

/** The card grows from, and shrinks back into, the corner that points at the orb. */
const MOTION_ORIGIN: Record<DesktopCompanionPanelPlacement, string> = {
  [DesktopCompanionPanelPlacement.Left]: '100% 100%',
  [DesktopCompanionPanelPlacement.Right]: '0% 100%',
  [DesktopCompanionPanelPlacement.Center]: '50% 100%',
};

const ENTER_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: 'translateY(8px) scale(0.94)' },
  { opacity: 1, transform: 'none' },
];
const ENTER_OPTIONS: KeyframeAnimationOptions = { duration: 220, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' };

const EXIT_KEYFRAMES: Record<ComposerExit, Keyframe[]> = {
  // Escape: the card goes back toward the orb.
  [ComposerExit.Dismiss]: [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: 'scale(0.96)' },
  ],
  // A sent task: the card folds down to a strip at its bottom edge, where the
  // task's status strip comes out next.
  [ComposerExit.Handoff]: [
    { opacity: 1, clipPath: 'inset(0px 0px 0px 0px round 24px)' },
    { opacity: 1, clipPath: 'inset(calc(100% - 44px) 0px 0px 0px round 14px)', offset: 0.75 },
    { opacity: 0, clipPath: 'inset(calc(100% - 44px) 0px 0px 0px round 14px)' },
  ],
};
const EXIT_DURATION_MS: Record<ComposerExit, number> = {
  [ComposerExit.Dismiss]: 120,
  [ComposerExit.Handoff]: 200,
};

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Pops the composer card out of the orb each time the panel opens, and returns
 * a function that plays it out before the panel hides. `ref` is the card's
 * visual layer; the measured box around it keeps its size, so the window does
 * not follow the animation.
 */
export function useComposerMotion(
  ref: RefObject<HTMLElement | null>,
  visible: boolean,
  placement: DesktopCompanionPanelPlacement,
  revision: number,
): (exit: ComposerExit) => Promise<void> {
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    animationRef.current?.cancel();
    animationRef.current = null;
    // Invisible between openings, so a reopened window never flashes the last frame.
    element.style.opacity = visible ? '' : '0';
    if (!visible) return;
    element.style.transformOrigin = MOTION_ORIGIN[placementRef.current];
    const animation = prefersReducedMotion() ? null : element.animate(ENTER_KEYFRAMES, ENTER_OPTIONS);
    animationRef.current = animation;
    // Hold the transparent first frame until the native window has been shown.
    if (animation) { animation.pause(); animation.currentTime = 0; }
    let active = true;
    // The first frame also reports the card's measured size. Wait one more frame
    // so the window is positioned and Chromium has painted before revealing it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void window.electron.desktopCompanion.panelReady(revision).then(shown => {
          if (active && shown && animationRef.current === animation) animation?.play();
        }).catch(error => console.error('[CompanionComposer] failed to show the panel', error));
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      animation?.cancel();
      if (animationRef.current === animation) animationRef.current = null;
    };
  }, [ref, visible, revision]);

  return useCallback(async (exit: ComposerExit) => {
    const element = ref.current;
    if (!element || prefersReducedMotion()) return;
    element.style.transformOrigin = MOTION_ORIGIN[placementRef.current];
    animationRef.current?.cancel();
    const duration = EXIT_DURATION_MS[exit];
    const animation = element.animate(EXIT_KEYFRAMES[exit], { duration, easing: 'ease-in', fill: 'forwards' });
    animationRef.current = animation;
    // Never hold the panel open on an animation the window is not painting.
    await Promise.race([
      animation.finished.then(() => undefined, () => undefined),
      new Promise<void>(resolve => setTimeout(resolve, duration + 80)),
    ]);
  }, [ref]);
}
