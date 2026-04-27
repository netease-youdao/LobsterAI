import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface BookmarkRow {
  id: string;
  session_id: string;
  message_id: string;
  message_type: 'user' | 'assistant';
  content: string;
  session_title: string;
  created_at: number;
}

export interface BookmarkData {
  id: string;
  sessionId: string;
  messageId: string;
  messageType: 'user' | 'assistant';
  content: string;
  sessionTitle: string;
  createdAt: number;
}

function rowToData(row: BookmarkRow): BookmarkData {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    messageType: row.message_type,
    content: row.content,
    sessionTitle: row.session_title,
    createdAt: row.created_at,
  };
}

export class BookmarkStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  addBookmark(params: {
    sessionId: string;
    messageId: string;
    messageType: 'user' | 'assistant';
    content: string;
    sessionTitle: string;
  }): BookmarkData | undefined {
    const id = uuidv4();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO bookmarks (id, session_id, message_id, message_type, content, session_title, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        params.sessionId,
        params.messageId,
        params.messageType,
        params.content,
        params.sessionTitle,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM bookmarks WHERE session_id = ? AND message_id = ?')
      .get(params.sessionId, params.messageId) as BookmarkRow | undefined;

    return row ? rowToData(row) : undefined;
  }

  removeBookmark(id: string): void {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }

  listBookmarks(): BookmarkData[] {
    const rows = this.db
      .prepare('SELECT * FROM bookmarks ORDER BY created_at DESC')
      .all() as BookmarkRow[];
    return rows.map(rowToData);
  }

  isBookmarked(sessionId: string, messageId: string): { bookmarked: boolean; bookmarkId?: string } {
    const row = this.db
      .prepare('SELECT id FROM bookmarks WHERE session_id = ? AND message_id = ?')
      .get(sessionId, messageId) as { id: string } | undefined;

    return row ? { bookmarked: true, bookmarkId: row.id } : { bookmarked: false };
  }
}
