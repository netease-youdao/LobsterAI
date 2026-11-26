import React, { useEffect, useRef, useState } from 'react';

import { ConversationScrollAnchorAttribute } from './conversationScrollAnchor';

/**
 * LazyRenderTurn — Viewport-based lazy rendering wrapper for conversation turns.
 *
 * Renders a lightweight placeholder when the turn is far from the viewport,
 * and renders the actual content when it enters (or is near) the viewport.
 * Once rendered, keeps a cached height so the placeholder matches the real size.
 *
 * This dramatically reduces DOM node count and React reconciliation work
 * for long conversations (200+ turns).
 */

interface LazyRenderTurnProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Session identifier to scope cached heights across recent sessions */
  sessionId?: string;
  /** Unique key for height cache */
  turnId: string;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  lastMessageId?: string;
  /** Vertical margin around viewport to pre-render (px) */
  rootMargin?: number;
  /** Whether this turn should always be rendered (e.g. last turn during streaming) */
  alwaysRender?: boolean;
  children: React.ReactNode;
}

const DEFAULT_HEIGHT_CACHE_SESSION_KEY = '__default__';
const MAX_CACHED_HEIGHT_SESSIONS = 12;

// Per-session LRU height cache survives session switches so returning to a
// recent task starts with accurate placeholder heights instead of 80px stubs.
const sessionHeightCaches = new Map<string, Map<string, number>>();

const getSessionHeightCache = (sessionId?: string, createIfMissing = false): Map<string, number> | null => {
  const key = sessionId || DEFAULT_HEIGHT_CACHE_SESSION_KEY;
  let cache = sessionHeightCaches.get(key);
  if (cache) {
    sessionHeightCaches.delete(key);
    sessionHeightCaches.set(key, cache);
    return cache;
  }
  if (!createIfMissing) return null;
  cache = new Map<string, number>();
  sessionHeightCaches.set(key, cache);
  while (sessionHeightCaches.size > MAX_CACHED_HEIGHT_SESSIONS) {
    const oldestKey = sessionHeightCaches.keys().next().value;
    if (oldestKey === undefined) break;
    sessionHeightCaches.delete(oldestKey);
  }
  return cache;
};

const getCachedTurnHeight = (sessionId: string | undefined, turnId: string): number | undefined => (
  getSessionHeightCache(sessionId, false)?.get(turnId)
);

const setCachedTurnHeight = (sessionId: string | undefined, turnId: string, height: number): void => {
  if (!(height > 0)) return;
  getSessionHeightCache(sessionId, true)?.set(turnId, height);
};

const LazyRenderTurn: React.FC<LazyRenderTurnProps> = ({
  sessionId,
  turnId,
  scrollContainerRef,
  lastMessageId,
  rootMargin = 600,
  alwaysRender = false,
  children,
  style,
  ...restProps
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(alwaysRender);

  // Observe intersection
  useEffect(() => {
    if (alwaysRender) {
      setIsVisible(true);
      return;
    }

    const el = containerRef.current;
    const root = scrollContainerRef.current;
    if (!el || !root) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const nowVisible = entry.isIntersecting;
        if (!nowVisible) {
          const height = el.getBoundingClientRect().height;
          if (height > 0) setCachedTurnHeight(sessionId, turnId, height);
        }
        setIsVisible(nowVisible);
      },
      {
        root,
        rootMargin: `${rootMargin}px 0px ${rootMargin}px 0px`,
      },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [alwaysRender, rootMargin, scrollContainerRef, sessionId, turnId]);

  // Cache height when visible content is rendered
  useEffect(() => {
    if (!isVisible) return;
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      if (h > 0) {
        setCachedTurnHeight(sessionId, turnId, h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isVisible, sessionId, turnId]);

  const shouldRender = isVisible || alwaysRender;
  const cachedHeight = getCachedTurnHeight(sessionId, turnId);

  return (
    <div
      ref={containerRef}
      {...restProps}
      {...{ [ConversationScrollAnchorAttribute.Turn]: shouldRender ? lastMessageId : undefined }}
      style={{
        ...style,
        // Unmeasured placeholders must not replace a real message as Chromium's
        // reading anchor when a fast upward gesture crosses the render buffer.
        overflowAnchor: shouldRender ? style?.overflowAnchor : 'none',
        ...(!shouldRender && cachedHeight
          ? { height: cachedHeight, minHeight: cachedHeight }
          : undefined),
      }}
    >
      {shouldRender ? children : (
        <div
          style={{ height: cachedHeight || 80 }}
          className="bg-background"
        />
      )}
    </div>
  );
};

export default LazyRenderTurn;

/** Clear cached heights for a specific session, or all sessions when omitted. */
export const clearHeightCache = (sessionId?: string) => {
  if (sessionId) {
    sessionHeightCaches.delete(sessionId);
    return;
  }
  sessionHeightCaches.clear();
};
