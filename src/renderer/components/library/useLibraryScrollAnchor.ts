import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  captureLibraryScrollAnchor,
  captureLibrarySessionScrollAnchor,
  type LibraryScrollAnchor,
  type LibraryScrollRestoration,
} from './libraryScrollAnchor';

const DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End', ' ']);
const SCROLL_KEYS = new Set([...DOWN_KEYS, 'ArrowUp', 'PageUp', 'Home']);

export const useLibraryScrollAnchor = (
  scrollContainerRef: RefObject<HTMLElement | null>,
  contextKey: string,
  onDegraded: () => void,
  layoutKey?: string,
) => {
  const [restoration, setRestoration] = useState<LibraryScrollRestoration>();
  const [appendArmed, setAppendArmed] = useState(true);
  const appendArmedRef = useRef(true);
  const generation = useRef(0);
  const sequence = useRef(0);
  const context = useRef(contextKey);
  const pending = useRef<LibraryScrollRestoration>();
  context.current = `${contextKey}:${layoutKey ?? ''}`;

  useLayoutEffect(() => {
    generation.current += 1;
    pending.current = undefined;
    setRestoration(undefined);
    appendArmedRef.current = true;
    setAppendArmed(true);
  }, [contextKey]);

  useLayoutEffect(() => {
    generation.current += 1;
    pending.current = undefined;
    setRestoration(undefined);
  }, [layoutKey]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return undefined;
    let touchY: number | undefined;
    let pointerActive = false;
    let lastScrollTop = root.scrollTop;
    const userInput = (down: boolean): void => {
      generation.current += 1;
      pending.current = undefined;
      setRestoration(undefined);
      if (down) {
        appendArmedRef.current = true;
        setAppendArmed(true);
      }
    };
    const wheel = (event: WheelEvent): void => {
      if (event.deltaY !== 0) userInput(event.deltaY > 0);
    };
    const touchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY;
      userInput(false);
    };
    const touchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY;
      if (nextY !== undefined && touchY !== undefined) userInput(nextY < touchY);
      touchY = nextY;
    };
    const keyDown = (event: KeyboardEvent): void => {
      if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
      // Space activates disclosure buttons; it is not downward scroll intent.
      if (event.key === ' ' && (event.target as HTMLElement).closest('button, [role="button"]')) return;
      if (SCROLL_KEYS.has(event.key)) userInput(DOWN_KEYS.has(event.key) && !event.shiftKey);
    };
    const pointerDown = (event: PointerEvent): void => {
      // Scrollbar dragging targets the scroll container, not a file/card control.
      pointerActive = event.target === root;
      if (pointerActive) userInput(false);
    };
    const pointerUp = (): void => { pointerActive = false; };
    const scroll = (): void => {
      if (pointerActive) userInput(root.scrollTop > lastScrollTop);
      lastScrollTop = root.scrollTop;
    };
    root.addEventListener('wheel', wheel, { passive: true });
    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchmove', touchMove, { passive: true });
    root.addEventListener('keydown', keyDown);
    root.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointerup', pointerUp);
    root.addEventListener('scroll', scroll, { passive: true });
    return () => {
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('keydown', keyDown);
      root.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointerup', pointerUp);
      root.removeEventListener('scroll', scroll);
    };
  }, [scrollContainerRef]);

  const capture = useCallback(() => (
    captureLibraryScrollAnchor(scrollContainerRef.current, generation.current)
  ), [scrollContainerRef]);
  const captureSession = useCallback((sessionId: string) => (
    captureLibrarySessionScrollAnchor(scrollContainerRef.current, generation.current, sessionId)
  ), [scrollContainerRef]);
  const pauseAppend = useCallback(() => {
    appendArmedRef.current = false;
    setAppendArmed(false);
  }, []);
  const isAppendArmed = useCallback(() => appendArmedRef.current, []);
  const restore = useCallback((anchor: LibraryScrollAnchor, isCurrent: () => boolean): void => {
    const expectedContext = context.current;
    const request: LibraryScrollRestoration = {
      ...anchor,
      id: ++sequence.current,
      isCurrent: () => isCurrent()
        && context.current === expectedContext
        && generation.current === anchor.userGeneration,
    };
    pending.current = request;
    appendArmedRef.current = false;
    setAppendArmed(false);
    setRestoration(request);
  }, []);
  const finish = useCallback((id: number, degraded: boolean): void => {
    if (pending.current?.id !== id) return;
    if (degraded && pending.current.isCurrent()) onDegraded();
    pending.current = undefined;
    setRestoration(undefined);
  }, [onDegraded]);

  return { capture, captureSession, pauseAppend, isAppendArmed, restore, restoration, finish, appendArmed };
};
