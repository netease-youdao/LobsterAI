import type { ConversationScrollAnchor } from './conversationScrollAnchor';

export const SessionViewportMode = {
  Bottom: 'bottom',
  Reading: 'reading',
} as const;
export type SessionViewportMode = typeof SessionViewportMode[keyof typeof SessionViewportMode];

export const MAX_SAVED_SESSION_VIEWPORTS = 50;
export const SESSION_RESTORE_WINDOW_PAGE_SIZE = 60;
export const SESSION_RESTORE_WINDOW_LEADING_CONTEXT = 12;

export interface SessionViewportSnapshot {
  sessionId: string;
  mode: SessionViewportMode;
  /** Visible message/turn anchors when mode is Reading (null in Bottom mode). */
  anchor: ConversationScrollAnchor | null;
  /** 0-based message index of the primary anchor in full session history. */
  anchorAbsoluteIndex: number | null;
  messagesOffset: number;
  loadedMessageCount: number;
  totalMessagesAtSave: number;
  /** Optional tail signature to detect streaming growth on the final message. */
  lastMessageIdAtSave?: string | null;
  lastMessageLengthAtSave?: number;
  scrollTop: number;
  railIndex: number;
  savedAt: number;
}

export interface SessionRestoreWindowRequest {
  offset: number;
  limit: number;
  expectedMessageId?: string;
}

type ActiveViewportCapturer = () => SessionViewportSnapshot | null;

/**
 * In-memory per-session viewport LRU store. Preserves where the user left off
 * when switching between concurrent tasks during the current app session.
 */
export class SessionViewportStore {
  private readonly maxEntries: number;
  private readonly snapshots = new Map<string, SessionViewportSnapshot>();
  private activeCapturer: { sessionId: string; capture: ActiveViewportCapturer } | null = null;

  constructor(maxEntries = MAX_SAVED_SESSION_VIEWPORTS) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  save(snapshot: SessionViewportSnapshot): void {
    if (!snapshot.sessionId) return;
    if (this.snapshots.has(snapshot.sessionId)) {
      this.snapshots.delete(snapshot.sessionId);
    }
    this.snapshots.set(snapshot.sessionId, snapshot);
    while (this.snapshots.size > this.maxEntries) {
      const oldestKey = this.snapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.snapshots.delete(oldestKey);
    }
  }

  get(sessionId: string): SessionViewportSnapshot | null {
    if (!sessionId) return null;
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) return null;
    // Touch LRU order so active tasks stay retained while switching across many sessions.
    this.snapshots.delete(sessionId);
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  delete(sessionId: string): void {
    if (!sessionId) return;
    this.snapshots.delete(sessionId);
  }

  deleteMany(sessionIds: readonly string[]): void {
    sessionIds.forEach(sessionId => this.delete(sessionId));
  }

  clear(): void {
    this.snapshots.clear();
  }

  size(): number {
    return this.snapshots.size;
  }

  registerActiveCapturer(sessionId: string, capture: ActiveViewportCapturer): () => void {
    const entry = { sessionId, capture };
    this.activeCapturer = entry;
    return () => {
      if (this.activeCapturer === entry) {
        this.activeCapturer = null;
      }
    };
  }

  /**
   * Synchronously capture the mounted conversation's viewport right before
   * Redux switches to another session and replaces the DOM.
   */
  captureActiveViewport(expectedSessionId?: string): SessionViewportSnapshot | null {
    const active = this.activeCapturer;
    if (!active) return null;
    if (expectedSessionId && active.sessionId !== expectedSessionId) return null;
    const snapshot = active.capture();
    if (snapshot) {
      this.save(snapshot);
    }
    return snapshot;
  }
}

export const sessionViewportStore = new SessionViewportStore();

export const getSessionRestoreAnchorMessageIds = (
  snapshot: SessionViewportSnapshot | null | undefined,
): string[] => {
  if (!snapshot || snapshot.mode !== SessionViewportMode.Reading || !snapshot.anchor) {
    return [];
  }
  return snapshot.anchor.candidates.map(candidate => candidate.messageId);
};

export const hasUnreadProgressSinceSnapshot = (
  snapshot: SessionViewportSnapshot | null | undefined,
  currentTotalMessages: number,
  currentLastMessage?: { id?: string | null; contentLength?: number } | null,
): boolean => {
  if (!snapshot || snapshot.mode !== SessionViewportMode.Reading) return false;
  if (Number.isFinite(currentTotalMessages) && currentTotalMessages > snapshot.totalMessagesAtSave) {
    return true;
  }
  if (
    currentLastMessage?.id
    && snapshot.lastMessageIdAtSave
    && currentLastMessage.id === snapshot.lastMessageIdAtSave
    && typeof snapshot.lastMessageLengthAtSave === 'number'
    && typeof currentLastMessage.contentLength === 'number'
    && currentLastMessage.contentLength > snapshot.lastMessageLengthAtSave
  ) {
    return true;
  }
  return false;
};

/**
 * Determine whether `loadSession` should pre-fetch a historical window before
 * applying the session to Redux so a returning reader lands directly on their
 * saved spot without flashing the bottom page first.
 */
export const getSessionRestoreWindow = (
  snapshot: SessionViewportSnapshot | null | undefined,
  defaultSessionOffset: number,
  defaultSessionLoadedCount: number,
  totalMessages: number,
  defaultMessageIds?: ReadonlySet<string>,
): SessionRestoreWindowRequest | null => {
  if (!snapshot || snapshot.mode !== SessionViewportMode.Reading) return null;
  const safeTotal = Math.max(0, Math.floor(totalMessages));
  if (safeTotal <= 0) return null;

  const safeDefaultOffset = Math.max(0, Math.floor(defaultSessionOffset));
  const safeDefaultLoadedCount = Math.max(0, Math.floor(defaultSessionLoadedCount));
  const primaryMessageId = snapshot.anchor?.candidates[0]?.messageId;

  // Already present in the default tail page returned by getSession.
  if (primaryMessageId && defaultMessageIds?.has(primaryMessageId)) {
    return null;
  }

  // If the entire session is already loaded in the default page, nothing extra to fetch.
  if (safeDefaultOffset === 0 && safeDefaultLoadedCount >= safeTotal) {
    return null;
  }

  const rawTargetIndex = snapshot.anchorAbsoluteIndex ?? snapshot.messagesOffset;
  if (!Number.isFinite(rawTargetIndex)) return null;
  const clampedTargetIndex = Math.max(0, Math.min(safeTotal - 1, Math.floor(rawTargetIndex)));

  // If the target index falls inside the default page and wasn't found by ID,
  // either no ID was needed or the old message was removed; let the default page load.
  if (clampedTargetIndex >= safeDefaultOffset) {
    return null;
  }

  const pageSize = Math.min(safeTotal, SESSION_RESTORE_WINDOW_PAGE_SIZE);
  const maxOffset = Math.max(0, safeTotal - pageSize);
  const offset = Math.max(0, Math.min(maxOffset, clampedTargetIndex - SESSION_RESTORE_WINDOW_LEADING_CONTEXT));

  return {
    offset,
    limit: pageSize,
    ...(primaryMessageId ? { expectedMessageId: primaryMessageId } : undefined),
  };
};
