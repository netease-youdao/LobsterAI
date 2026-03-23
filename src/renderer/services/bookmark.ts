/**
 * Bookmark service — persists per-session message bookmarks using the
 * existing KV store (`window.electron.store`).
 *
 * Storage keys:
 *   `bookmarks:{sessionId}` → BookmarkEntry[]   (per-session entries)
 *   `bookmarks:__index`     → string[]           (session IDs that have bookmarks)
 */

export interface BookmarkEntry {
  /** Message ID that is bookmarked */
  messageId: string;
  /** ISO timestamp when the bookmark was created */
  createdAt: string;
}

export interface GlobalBookmarkEntry extends BookmarkEntry {
  /** Session ID this bookmark belongs to */
  sessionId: string;
  /** Session title at the time of loading (filled by caller) */
  sessionTitle?: string;
  /** Preview text of the bookmarked message (filled by caller) */
  preview?: string;
  /** Message type (user/assistant) */
  messageType?: string;
}

const storageKey = (sessionId: string) => `bookmarks:${sessionId}`;
const INDEX_KEY = 'bookmarks:__index';

class BookmarkService {
  /** In-memory cache keyed by sessionId */
  private cache = new Map<string, BookmarkEntry[]>();
  /** Cached global index of session IDs that have bookmarks */
  private indexCache: string[] | null = null;
  private listeners: Array<() => void> = [];

  /** Load bookmarks for a session (returns cached if available) */
  async load(sessionId: string): Promise<BookmarkEntry[]> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const raw = await window.electron.store.get(storageKey(sessionId));
    const entries: BookmarkEntry[] = Array.isArray(raw) ? raw : [];
    this.cache.set(sessionId, entries);
    return entries;
  }

  /** Check if a message is bookmarked */
  isBookmarked(sessionId: string, messageId: string): boolean {
    const entries = this.cache.get(sessionId);
    if (!entries) return false;
    return entries.some((e) => e.messageId === messageId);
  }

  /** Toggle bookmark on a message. Returns true if added, false if removed. */
  async toggle(sessionId: string, messageId: string): Promise<boolean> {
    const entries = await this.load(sessionId);
    const index = entries.findIndex((e) => e.messageId === messageId);
    if (index >= 0) {
      entries.splice(index, 1);
      await this.persist(sessionId, entries);
      this.notify();
      return false;
    }
    entries.push({ messageId, createdAt: new Date().toISOString() });
    await this.persist(sessionId, entries);
    this.notify();
    return true;
  }

  /** Remove all bookmarks for a session (e.g. when session is deleted) */
  async clear(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    await window.electron.store.remove(storageKey(sessionId));
    await this.removeFromIndex(sessionId);
    this.notify();
  }

  /** Load the global index of session IDs that contain bookmarks */
  async loadIndex(): Promise<string[]> {
    if (this.indexCache) return this.indexCache;
    const raw = await window.electron.store.get(INDEX_KEY);
    this.indexCache = Array.isArray(raw) ? raw : [];
    return this.indexCache;
  }

  /** Load all bookmarks across all sessions (for global bookmarks view) */
  async loadAll(): Promise<GlobalBookmarkEntry[]> {
    const sessionIds = await this.loadIndex();
    const all: GlobalBookmarkEntry[] = [];
    for (const sessionId of sessionIds) {
      const entries = await this.load(sessionId);
      for (const entry of entries) {
        all.push({ ...entry, sessionId });
      }
    }
    // Sort by createdAt descending (newest first)
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return all;
  }

  /** Get the total number of bookmarks across all sessions */
  async getTotalCount(): Promise<number> {
    const sessionIds = await this.loadIndex();
    let count = 0;
    for (const sessionId of sessionIds) {
      const entries = await this.load(sessionId);
      count += entries.length;
    }
    return count;
  }

  /** Subscribe to bookmark changes */
  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Invalidate cache for a session so next load fetches from store */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /** Invalidate global index cache */
  invalidateIndex(): void {
    this.indexCache = null;
  }

  private async persist(sessionId: string, entries: BookmarkEntry[]): Promise<void> {
    this.cache.set(sessionId, entries);
    if (entries.length === 0) {
      await window.electron.store.remove(storageKey(sessionId));
      await this.removeFromIndex(sessionId);
    } else {
      await window.electron.store.set(storageKey(sessionId), entries);
      await this.addToIndex(sessionId);
    }
  }

  private async addToIndex(sessionId: string): Promise<void> {
    const index = await this.loadIndex();
    if (!index.includes(sessionId)) {
      index.push(sessionId);
      this.indexCache = index;
      await window.electron.store.set(INDEX_KEY, index);
    }
  }

  private async removeFromIndex(sessionId: string): Promise<void> {
    const index = await this.loadIndex();
    const pos = index.indexOf(sessionId);
    if (pos >= 0) {
      index.splice(pos, 1);
      this.indexCache = index;
      if (index.length === 0) {
        await window.electron.store.remove(INDEX_KEY);
      } else {
        await window.electron.store.set(INDEX_KEY, index);
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const bookmarkService = new BookmarkService();