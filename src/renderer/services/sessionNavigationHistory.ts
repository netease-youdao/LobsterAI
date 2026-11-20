import { COWORK_TEMP_SESSION_ID_PREFIX } from '../../shared/cowork/constants';

/**
 * Back/forward history of the sessions the user has looked at, like a
 * browser's: opening a session from anywhere (sidebar, search, notification,
 * a new task) adds it after the current entry and drops the forward entries;
 * going back or forward only moves the cursor.
 */

export const SessionHistoryDirection = {
  Back: 'back',
  Forward: 'forward',
} as const;
export type SessionHistoryDirection = typeof SessionHistoryDirection[keyof typeof SessionHistoryDirection];

export interface SessionHistoryEntry {
  sessionId: string;
  agentId: string;
}

export const SESSION_HISTORY_LIMIT = 50;

export class SessionNavigationHistory {
  private entries: SessionHistoryEntry[] = [];
  private index = -1;
  /** The entry a back/forward step is opening, so its arrival does not count as a new visit. */
  private pendingIndex: number | null = null;

  constructor(private readonly limit = SESSION_HISTORY_LIMIT) {}

  /** Records the session the view now shows; null means the home view. */
  observe(sessionId: string | null, agentId: string): void {
    if (!sessionId || sessionId.startsWith(COWORK_TEMP_SESSION_ID_PREFIX)) return;

    const pendingIndex = this.pendingIndex;
    this.pendingIndex = null;
    if (pendingIndex !== null && this.entries[pendingIndex]?.sessionId === sessionId) {
      this.index = pendingIndex;
      this.entries[pendingIndex] = { sessionId, agentId };
      return;
    }

    const current = this.entries[this.index];
    if (current?.sessionId === sessionId) {
      if (current.agentId !== agentId) this.entries[this.index] = { sessionId, agentId };
      return;
    }

    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ sessionId, agentId });
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    this.index = this.entries.length - 1;
  }

  /**
   * The entry one step away from what the view shows. Off the history (home
   * view, a task still starting), back returns to the session just left.
   */
  resolveTargetIndex(direction: SessionHistoryDirection, currentSessionId: string | null): number | null {
    const onCurrentEntry = currentSessionId !== null
      && this.entries[this.index]?.sessionId === currentSessionId;
    const target = direction === SessionHistoryDirection.Back
      ? (onCurrentEntry ? this.index - 1 : this.index)
      : this.index + 1;
    return target >= 0 && target < this.entries.length ? target : null;
  }

  canNavigate(direction: SessionHistoryDirection, currentSessionId: string | null): boolean {
    return this.resolveTargetIndex(direction, currentSessionId) !== null;
  }

  /** Marks the step to `targetIndex` as started and returns the entry to open. */
  beginNavigation(targetIndex: number): SessionHistoryEntry | null {
    const entry = this.entries[targetIndex];
    if (!entry) return null;
    this.pendingIndex = targetIndex;
    return entry;
  }

  /** Drops an entry that can no longer be opened, such as a deleted session. */
  remove(sessionId: string): void {
    this.pendingIndex = null;
    let removedBeforeCursor = 0;
    this.entries = this.entries.filter((entry, entryIndex) => {
      if (entry.sessionId !== sessionId) return true;
      if (entryIndex <= this.index) removedBeforeCursor += 1;
      return false;
    });
    this.index = Math.min(this.index - removedBeforeCursor, this.entries.length - 1);
  }

  snapshot(): { entries: SessionHistoryEntry[]; index: number } {
    return { entries: this.entries.map(entry => ({ ...entry })), index: this.index };
  }
}
