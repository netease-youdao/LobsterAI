import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

import { restoreConversationScrollAnchor } from './conversationScrollAnchor';
import {
  getSessionRestoreAnchorMessageIds,
  SessionViewportMode,
  type SessionViewportSnapshot,
} from './conversationSessionScrollState';

/**
 * Keep the restored anchor pinned briefly while images decode and neighbouring
 * lazy turns hydrate. Yields immediately on any reader input.
 */
export const CONVERSATION_SESSION_RESTORE_SETTLE_MS = 2500;
export const CONVERSATION_SESSION_RESTORE_PAGINATION_LOCK_MS = 180;

const READER_INTERRUPT_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;

interface ConversationSessionRestoreOptions {
  sessionId: string | undefined;
  snapshot: SessionViewportSnapshot | null;
  scrollContainerRef: RefObject<HTMLElement | null>;
  canRestore: () => boolean;
  onRestored?: (snapshot: SessionViewportSnapshot, matchedAnchor: boolean) => void;
  onInterrupt?: () => void;
}

const clampScrollTop = (container: HTMLElement, targetScrollTop: number): number => {
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.max(0, Math.min(maxScrollTop, targetScrollTop));
};

/**
 * Restores a previously saved reading position before the first paint when
 * switching back to a session, and keeps the anchor stable through initial
 * async layout settling without fighting the user.
 */
export function useConversationSessionRestore({
  sessionId,
  snapshot,
  scrollContainerRef,
  canRestore,
  onRestored,
  onInterrupt,
}: ConversationSessionRestoreOptions) {
  const [contentElement, setContentElement] = useState<HTMLElement | null>(null);
  // Session ID for which anchor pinning is currently released (after settle or user interrupt).
  const [releasedPinSessionId, setReleasedPinSessionId] = useState<string | null>(null);
  const isRestoringRef = useRef(false);
  const settleUntilRef = useRef(0);
  const activeSnapshotRef = useRef<SessionViewportSnapshot | null>(null);
  const canRestoreRef = useRef(canRestore);
  canRestoreRef.current = canRestore;
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  const onInterruptRef = useRef(onInterrupt);
  onInterruptRef.current = onInterrupt;

  const isReadingSnapshot = Boolean(
    sessionId
    && snapshot
    && snapshot.sessionId === sessionId
    && snapshot.mode === SessionViewportMode.Reading,
  );

  // Derive pinned anchor message IDs synchronously during render so the very
  // first commit of the restored session mounts the anchor turn immediately.
  const pinnedAnchorMessageIds = (
    isReadingSnapshot && releasedPinSessionId !== sessionId
      ? getSessionRestoreAnchorMessageIds(snapshot)
      : []
  );

  const cancelRestore = useCallback(() => {
    const wasActive = settleUntilRef.current > 0 || isRestoringRef.current;
    settleUntilRef.current = 0;
    isRestoringRef.current = false;
    activeSnapshotRef.current = null;
    if (sessionId) {
      setReleasedPinSessionId(current => (current === sessionId ? current : sessionId));
    }
    if (wasActive) {
      onInterruptRef.current?.();
    }
  }, [sessionId]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!isReadingSnapshot || !snapshot || !sessionId || !container) {
      settleUntilRef.current = 0;
      isRestoringRef.current = false;
      activeSnapshotRef.current = null;
      return;
    }

    setReleasedPinSessionId(current => (current === sessionId ? null : current));
    activeSnapshotRef.current = snapshot;
    isRestoringRef.current = true;
    settleUntilRef.current = performance.now() + CONVERSATION_SESSION_RESTORE_SETTLE_MS;

    let cancelled = false;
    let rafId: number | null = null;
    let paginationLockTimer: ReturnType<typeof setTimeout> | null = null;
    let settleEndTimer: ReturnType<typeof setTimeout> | null = null;

    const releasePaginationLock = () => {
      if (paginationLockTimer !== null) {
        clearTimeout(paginationLockTimer);
        paginationLockTimer = null;
      }
      isRestoringRef.current = false;
    };

    const finishSettle = (interrupted: boolean) => {
      if (cancelled) return;
      cancelled = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (settleEndTimer !== null) {
        clearTimeout(settleEndTimer);
        settleEndTimer = null;
      }
      releasePaginationLock();
      settleUntilRef.current = 0;
      activeSnapshotRef.current = null;
      setReleasedPinSessionId(sessionId);
      if (interrupted) {
        onInterruptRef.current?.();
      }
    };

    const applyPosition = (): boolean => {
      if (cancelled || !canRestoreRef.current()) return false;
      if (snapshot.anchor && restoreConversationScrollAnchor(container, snapshot.anchor)) {
        return true;
      }
      container.scrollTop = clampScrollTop(container, snapshot.scrollTop);
      return false;
    };

    const matchedImmediately = applyPosition();
    onRestoredRef.current?.(snapshot, matchedImmediately);

    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (cancelled) return;
      const matchedOnFrame = applyPosition();
      if (matchedOnFrame && !matchedImmediately) {
        onRestoredRef.current?.(snapshot, true);
      }
    });

    paginationLockTimer = setTimeout(() => {
      releasePaginationLock();
    }, CONVERSATION_SESSION_RESTORE_PAGINATION_LOCK_MS);

    settleEndTimer = setTimeout(() => {
      finishSettle(false);
    }, CONVERSATION_SESSION_RESTORE_SETTLE_MS);

    const handleInterrupt = () => finishSettle(true);
    READER_INTERRUPT_EVENTS.forEach(type => container.addEventListener(type, handleInterrupt, { passive: true }));

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (paginationLockTimer !== null) clearTimeout(paginationLockTimer);
      if (settleEndTimer !== null) clearTimeout(settleEndTimer);
      isRestoringRef.current = false;
      settleUntilRef.current = 0;
      activeSnapshotRef.current = null;
      READER_INTERRUPT_EVENTS.forEach(type => container.removeEventListener(type, handleInterrupt));
    };
  }, [isReadingSnapshot, scrollContainerRef, sessionId, snapshot]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!contentElement || !container || typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(() => {
      const currentSnapshot = activeSnapshotRef.current;
      if (
        !currentSnapshot
        || performance.now() > settleUntilRef.current
        || !canRestoreRef.current()
      ) {
        return;
      }
      if (currentSnapshot.anchor) {
        restoreConversationScrollAnchor(container, currentSnapshot.anchor);
      }
    });
    resizeObserver.observe(contentElement);
    return () => resizeObserver.disconnect();
  }, [contentElement, scrollContainerRef]);

  return {
    setContentElement,
    isRestoringRef,
    pinnedAnchorMessageIds,
    cancelRestore,
  };
}
