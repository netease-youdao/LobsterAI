import { store } from '../store';
import {
  setBookmarks,
  setLoading,
  addBookmark,
  removeBookmark,
} from '../store/slices/bookmarkSlice';
import type { Bookmark } from '../types/cowork';

class BookmarkService {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadBookmarks();
    this.initialized = true;
  }

  async loadBookmarks(): Promise<void> {
    store.dispatch(setLoading(true));
    try {
      const result = await window.electron.bookmark.list();
      if (result.success && result.bookmarks) {
        store.dispatch(setBookmarks(result.bookmarks));
      }
    } catch (error) {
      console.error('[BookmarkService] failed to load bookmarks:', error);
      store.dispatch(setLoading(false));
    }
  }

  async add(params: {
    sessionId: string;
    messageId: string;
    messageType: 'user' | 'assistant';
    content: string;
    sessionTitle: string;
  }): Promise<boolean> {
    try {
      const result = await window.electron.bookmark.add(params);
      if (result.success && result.bookmark) {
        store.dispatch(addBookmark(result.bookmark as Bookmark));
        return true;
      }
      return false;
    } catch (error) {
      console.error('[BookmarkService] failed to add bookmark:', error);
      return false;
    }
  }

  async remove(bookmarkId: string): Promise<boolean> {
    try {
      const result = await window.electron.bookmark.remove(bookmarkId);
      if (result.success) {
        store.dispatch(removeBookmark(bookmarkId));
        return true;
      }
      return false;
    } catch (error) {
      console.error('[BookmarkService] failed to remove bookmark:', error);
      return false;
    }
  }

  isBookmarked(sessionId: string, messageId: string): { bookmarked: boolean; bookmarkId?: string } {
    const state = store.getState();
    const key = `${sessionId}:${messageId}`;
    const bookmarkId = state.bookmark.bookmarkedKeys[key];
    return bookmarkId ? { bookmarked: true, bookmarkId } : { bookmarked: false };
  }
}

export const bookmarkService = new BookmarkService();
