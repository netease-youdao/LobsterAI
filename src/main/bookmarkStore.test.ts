import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { BookmarkStore } from './bookmarkStore';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_type TEXT NOT NULL CHECK(message_type IN ('user', 'assistant')),
      content TEXT NOT NULL,
      session_title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, message_id)
    );
  `);
  return db;
}

describe('BookmarkStore', () => {
  let store: BookmarkStore;

  beforeEach(() => {
    const db = createTestDb();
    store = new BookmarkStore(db);
  });

  it('addBookmark creates a new bookmark and returns it', () => {
    const result = store.addBookmark({
      sessionId: 'session-1',
      messageId: 'msg-1',
      messageType: 'assistant',
      content: 'Hello world',
      sessionTitle: 'Test Session',
    });
    expect(result).toBeDefined();
    expect(result!.sessionId).toBe('session-1');
    expect(result!.messageId).toBe('msg-1');
    expect(result!.messageType).toBe('assistant');
    expect(result!.content).toBe('Hello world');
    expect(result!.sessionTitle).toBe('Test Session');
    expect(result!.id).toBeTruthy();
    expect(result!.createdAt).toBeGreaterThan(0);
  });

  it('addBookmark ignores duplicate session_id + message_id', () => {
    store.addBookmark({
      sessionId: 'session-1',
      messageId: 'msg-1',
      messageType: 'assistant',
      content: 'First',
      sessionTitle: 'Session',
    });
    const second = store.addBookmark({
      sessionId: 'session-1',
      messageId: 'msg-1',
      messageType: 'assistant',
      content: 'Duplicate',
      sessionTitle: 'Session',
    });
    expect(second).toBeDefined();
    expect(second!.content).toBe('First');
    const all = store.listBookmarks();
    expect(all).toHaveLength(1);
  });

  it('removeBookmark deletes a bookmark by id', () => {
    const bm = store.addBookmark({
      sessionId: 'session-1',
      messageId: 'msg-1',
      messageType: 'user',
      content: 'Hi',
      sessionTitle: 'S',
    });
    expect(store.listBookmarks()).toHaveLength(1);
    store.removeBookmark(bm!.id);
    expect(store.listBookmarks()).toHaveLength(0);
  });

  it('listBookmarks returns all bookmarks sorted by created_at DESC', () => {
    store.addBookmark({
      sessionId: 's-1',
      messageId: 'm-1',
      messageType: 'user',
      content: 'First',
      sessionTitle: 'S1',
    });
    store.addBookmark({
      sessionId: 's-2',
      messageId: 'm-2',
      messageType: 'assistant',
      content: 'Second',
      sessionTitle: 'S2',
    });
    const list = store.listBookmarks();
    expect(list).toHaveLength(2);
    expect(list[0].createdAt).toBeGreaterThanOrEqual(list[1].createdAt);
  });

  it('isBookmarked returns correct status', () => {
    expect(store.isBookmarked('s-1', 'm-1')).toEqual({ bookmarked: false });
    const bm = store.addBookmark({
      sessionId: 's-1',
      messageId: 'm-1',
      messageType: 'assistant',
      content: 'C',
      sessionTitle: 'S',
    });
    const result = store.isBookmarked('s-1', 'm-1');
    expect(result.bookmarked).toBe(true);
    expect(result.bookmarkId).toBe(bm!.id);
  });
});
