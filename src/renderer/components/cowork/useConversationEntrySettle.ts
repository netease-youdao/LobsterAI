import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

/**
 * How long after a session opens its conversation may still grow on its own:
 * images decoding, lazily mounted turns, detected artifacts arriving.
 */
export const CONVERSATION_ENTRY_SETTLE_MS = 4000;

// Input that means the reader is taking over the viewport (scrolling, dragging
// the scrollbar, expanding a block, keyboard scrolling).
const READER_INTERRUPT_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;

interface ConversationEntrySettleOptions {
  sessionId: string | undefined;
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** Whether the conversation is still following its newest content (no navigation, search, or export owns it). */
  canHoldBottom: () => boolean;
}

/**
 * Opening a session lands on its newest content, but the conversation keeps
 * growing for a moment as images decode and turns mount, which pushes the
 * bottom out of view in visible jumps. Place the viewport at the bottom before
 * the first paint, then keep it there on every content resize (also before
 * paint) until the reader interacts or the settle window ends.
 *
 * Returns a ref callback for the element that wraps the conversation content.
 */
export function useConversationEntrySettle({
  sessionId,
  scrollContainerRef,
  canHoldBottom,
}: ConversationEntrySettleOptions): (element: HTMLElement | null) => void {
  const [contentElement, setContentElement] = useState<HTMLElement | null>(null);
  const settleUntilRef = useRef(0);
  const canHoldBottomRef = useRef(canHoldBottom);
  canHoldBottomRef.current = canHoldBottom;

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!sessionId || !container) return;
    settleUntilRef.current = performance.now() + CONVERSATION_ENTRY_SETTLE_MS;
    container.scrollTop = container.scrollHeight;

    const endSettle = () => {
      settleUntilRef.current = 0;
    };
    READER_INTERRUPT_EVENTS.forEach(type => container.addEventListener(type, endSettle, { passive: true }));
    return () => {
      READER_INTERRUPT_EVENTS.forEach(type => container.removeEventListener(type, endSettle));
    };
  }, [scrollContainerRef, sessionId]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!contentElement || !container || typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(() => {
      if (performance.now() > settleUntilRef.current || !canHoldBottomRef.current()) return;
      container.scrollTop = container.scrollHeight;
    });
    resizeObserver.observe(contentElement);
    return () => resizeObserver.disconnect();
  }, [contentElement, scrollContainerRef]);

  return setContentElement;
}
