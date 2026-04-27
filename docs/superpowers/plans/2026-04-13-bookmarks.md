# 收藏功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现消息收藏功能，用户可以在对话中星标收藏 user/assistant 消息，通过侧边栏入口查看收藏列表，并可跳转定位到原始会话位置。

**Architecture:** 新增 SQLite `bookmarks` 表存储收藏快照，通过 IPC 频道暴露 CRUD 操作，前端通过 Redux slice 维护收藏状态，新增 `BookmarksView` 页面和消息上的星标按钮。

**Tech Stack:** SQLite (better-sqlite3), Electron IPC, Redux Toolkit, React, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-13-bookmarks-design.md`

---

## 文件结构

| 操作 | 文件路径                                                      | 职责                               |
| ---- | ------------------------------------------------------------- | ---------------------------------- |
| 新建 | `src/bookmark/constants.ts`                                   | IPC 频道常量 + 消息类型常量        |
| 新建 | `src/main/bookmarkStore.ts`                                   | SQLite CRUD 操作                   |
| 新建 | `src/main/bookmarkStore.test.ts`                              | BookmarkStore 单元测试             |
| 新建 | `src/renderer/store/slices/bookmarkSlice.ts`                  | Redux slice                        |
| 新建 | `src/renderer/services/bookmark.ts`                           | 前端 service 层                    |
| 新建 | `src/renderer/components/BookmarksView.tsx`                   | 收藏列表页面                       |
| 修改 | `src/main/sqliteStore.ts:170`                                 | initializeTables 新增 bookmarks 表 |
| 修改 | `src/main/main.ts:3387`                                       | 注册 bookmark IPC handlers         |
| 修改 | `src/main/preload.ts:443`                                     | 新增 bookmark 命名空间             |
| 修改 | `src/renderer/types/electron.d.ts:497`                        | 新增 bookmark 类型声明             |
| 修改 | `src/renderer/types/cowork.ts:221`                            | 新增 Bookmark interface            |
| 修改 | `src/renderer/store/index.ts`                                 | 注册 bookmark reducer              |
| 修改 | `src/renderer/services/i18n.ts`                               | 新增 i18n 键                       |
| 修改 | `src/renderer/components/Sidebar.tsx:249`                     | 新增收藏按钮                       |
| 修改 | `src/renderer/App.tsx:43,267,700`                             | mainView 扩展 + 路由 + 跳转逻辑    |
| 修改 | `src/renderer/components/cowork/CoworkSessionDetail.tsx:1062` | 新增 BookmarkButton + 传参         |

---

### Task 1: 常量定义

**Files:**

- Create: `src/bookmark/constants.ts`

- [ ] **Step 1: 创建常量文件**

```ts
// src/bookmark/constants.ts
export const BookmarkMessageType = {
  User: 'user',
  Assistant: 'assistant',
} as const;
export type BookmarkMessageType = (typeof BookmarkMessageType)[keyof typeof BookmarkMessageType];

export const BookmarkIpcChannel = {
  Add: 'bookmark:add',
  Remove: 'bookmark:remove',
  List: 'bookmark:list',
  IsBookmarked: 'bookmark:isBookmarked',
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add src/bookmark/constants.ts
git commit -m "feat(bookmark): add IPC channel and message type constants"
```

---

### Task 2: Bookmark 类型定义

**Files:**

- Modify: `src/renderer/types/cowork.ts` (文件末尾追加)

- [ ] **Step 1: 在 cowork.ts 末尾追加 Bookmark interface**

在文件最后一行之后追加：

```ts
export interface Bookmark {
  id: string;
  sessionId: string;
  messageId: string;
  messageType: 'user' | 'assistant';
  content: string;
  sessionTitle: string;
  createdAt: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/types/cowork.ts
git commit -m "feat(bookmark): add Bookmark type definition"
```

---

### Task 3: SQLite 表初始化

**Files:**

- Modify: `src/main/sqliteStore.ts:170` (在 `mcp_servers` 建表语句之后，migrations 代码之前)

- [ ] **Step 1: 在 initializeTables() 中新增 bookmarks 表**

在 `src/main/sqliteStore.ts` 的 `mcp_servers` 建表语句（约第 171 行 `);` 之后），`// Migrations` 注释（约第 173 行）之前，插入：

```ts
// Create bookmarks table
this.db.exec(`
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
```

- [ ] **Step 2: Commit**

```bash
git add src/main/sqliteStore.ts
git commit -m "feat(bookmark): add bookmarks table to SQLite schema"
```

---

### Task 4: BookmarkStore 单元测试（红灯）

**Files:**

- Create: `src/main/bookmarkStore.test.ts`

- [ ] **Step 1: 编写 BookmarkStore 测试**

```ts
// src/main/bookmarkStore.test.ts
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
    // Should return the existing bookmark
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
    // Small delay to ensure different timestamp
    store.addBookmark({
      sessionId: 's-2',
      messageId: 'm-2',
      messageType: 'assistant',
      content: 'Second',
      sessionTitle: 'S2',
    });
    const list = store.listBookmarks();
    expect(list).toHaveLength(2);
    // Most recent first
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
```

- [ ] **Step 2: 运行测试，确认红灯**

```bash
npm test -- bookmarkStore
```

预期：FAIL，`Cannot find module './bookmarkStore'`

- [ ] **Step 3: Commit**

```bash
git add src/main/bookmarkStore.test.ts
git commit -m "test(bookmark): add BookmarkStore unit tests (red)"
```

---

### Task 5: BookmarkStore 实现（绿灯）

**Files:**

- Create: `src/main/bookmarkStore.ts`

- [ ] **Step 1: 实现 BookmarkStore**

```ts
// src/main/bookmarkStore.ts
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

    // Return the existing or newly inserted bookmark
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
```

- [ ] **Step 2: 运行测试，确认绿灯**

```bash
npm test -- bookmarkStore
```

预期：全部 PASS (5 tests)

- [ ] **Step 3: Commit**

```bash
git add src/main/bookmarkStore.ts
git commit -m "feat(bookmark): implement BookmarkStore with SQLite CRUD"
```

---

### Task 6: IPC 频道注册

**Files:**

- Modify: `src/main/main.ts:3387` (在 `// ==================== Scheduled Task IPC Handlers` 之前插入)

- [ ] **Step 1: 在 main.ts 顶部添加 import**

在 `src/main/main.ts` 的 import 区域添加：

```ts
import { BookmarkStore } from './bookmarkStore';
import { BookmarkIpcChannel } from '../bookmark/constants';
```

- [ ] **Step 2: 添加 BookmarkStore 惰性初始化**

在 `src/main/main.ts` 约第 666 行（`let preventSleepBlockerId` 之后）添加模块级变量：

```ts
let bookmarkStore: BookmarkStore | null = null;
```

在约第 850 行（`getCoworkStore` 函数之后）添加惰性初始化函数，与现有 `getCoworkStore()` 模式一致：

```ts
const getBookmarkStore = () => {
  if (!bookmarkStore) {
    bookmarkStore = new BookmarkStore(getStore().getDatabase());
  }
  return bookmarkStore;
};
```

- [ ] **Step 3: 注册 4 个 IPC handlers**

在 `// ==================== Scheduled Task IPC Handlers` 注释之前插入：

```ts
// ========== Bookmark IPC Handlers ==========

ipcMain.handle(
  BookmarkIpcChannel.Add,
  async (
    _event,
    params: {
      sessionId: string;
      messageId: string;
      messageType: 'user' | 'assistant';
      content: string;
      sessionTitle: string;
    },
  ) => {
    try {
      const bookmark = getBookmarkStore().addBookmark(params);
      return { success: true, bookmark };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add bookmark',
      };
    }
  },
);

ipcMain.handle(BookmarkIpcChannel.Remove, async (_event, bookmarkId: string) => {
  try {
    getBookmarkStore().removeBookmark(bookmarkId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to remove bookmark',
    };
  }
});

ipcMain.handle(BookmarkIpcChannel.List, async () => {
  try {
    const bookmarks = getBookmarkStore().listBookmarks();
    return { success: true, bookmarks };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list bookmarks',
    };
  }
});

ipcMain.handle(
  BookmarkIpcChannel.IsBookmarked,
  async (_event, sessionId: string, messageId: string) => {
    try {
      const result = getBookmarkStore().isBookmarked(sessionId, messageId);
      return { success: true, ...result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check bookmark',
      };
    }
  },
);
```

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(bookmark): register bookmark IPC handlers in main process"
```

---

### Task 7: Preload 层 + 类型声明

**Files:**

- Modify: `src/main/preload.ts:443` (在 `scheduledTasks` 命名空间之前插入)
- Modify: `src/renderer/types/electron.d.ts:497` (在 `scheduledTasks` 类型声明之前插入)

- [ ] **Step 1: 在 preload.ts 中新增 bookmark 命名空间**

在 `src/main/preload.ts` 的 `scheduledTasks` 命名空间之前（约第 401 行前），插入：

```ts
    bookmark: {
      add: (params: { sessionId: string; messageId: string; messageType: string; content: string; sessionTitle: string }) =>
        ipcRenderer.invoke(BookmarkIpcChannel.Add, params),
      remove: (bookmarkId: string) =>
        ipcRenderer.invoke(BookmarkIpcChannel.Remove, bookmarkId),
      list: () =>
        ipcRenderer.invoke(BookmarkIpcChannel.List),
      isBookmarked: (sessionId: string, messageId: string) =>
        ipcRenderer.invoke(BookmarkIpcChannel.IsBookmarked, sessionId, messageId),
    },
```

同时在 preload.ts 顶部添加 import：

```ts
import { BookmarkIpcChannel } from '../bookmark/constants';
```

- [ ] **Step 2: 在 electron.d.ts 中添加 bookmark 类型声明**

在 `src/renderer/types/electron.d.ts` 的 `scheduledTasks` 类型声明之前插入：

```ts
bookmark: {
  add: (params: {
    sessionId: string;
    messageId: string;
    messageType: string;
    content: string;
    sessionTitle: string;
  }) => Promise<{ success: boolean; bookmark?: Bookmark; error?: string }>;
  remove: (bookmarkId: string) => Promise<{ success: boolean; error?: string }>;
  list: () => Promise<{ success: boolean; bookmarks?: Bookmark[]; error?: string }>;
  isBookmarked: (sessionId: string, messageId: string) =>
    Promise<{
      success: boolean;
      bookmarked?: boolean;
      bookmarkId?: string;
      error?: string;
    }>;
}
```

确保 `Bookmark` 类型已在该文件中 import 或可用（从 `cowork` 类型文件中引入）。

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.ts src/renderer/types/electron.d.ts
git commit -m "feat(bookmark): expose bookmark API in preload and add type declarations"
```

---

### Task 8: i18n 键

**Files:**

- Modify: `src/renderer/services/i18n.ts`
- Modify: `src/main/i18n.ts` (如果需要主进程翻译)

- [ ] **Step 1: 在 zh 部分添加键（约第 1316 行前）**

在 `src/renderer/services/i18n.ts` 的 `zh` 对象末尾、闭合 `}` 之前添加：

```ts
    bookmarks: '收藏',
    bookmarkAdd: '收藏',
    bookmarkRemove: '取消收藏',
    bookmarkAdded: '已收藏',
    bookmarkRemoved: '已取消收藏',
    noBookmarks: '暂无收藏，在对话中点击 ☆ 收藏消息',
    jumpToMessage: '跳转到会话',
    sessionDeleted: '会话已删除',
    aiReply: 'AI 回复',
    userMessage: '用户消息',
    removeBookmark: '移除收藏',
```

- [ ] **Step 2: 在 en 部分添加对应键（约第 2620 行前）**

```ts
    bookmarks: 'Bookmarks',
    bookmarkAdd: 'Bookmark',
    bookmarkRemove: 'Remove bookmark',
    bookmarkAdded: 'Bookmarked',
    bookmarkRemoved: 'Removed from bookmarks',
    noBookmarks: 'No bookmarks yet. Click ☆ on any message to save it.',
    jumpToMessage: 'Jump to message',
    sessionDeleted: 'Session deleted',
    aiReply: 'AI reply',
    userMessage: 'User message',
    removeBookmark: 'Remove bookmark',
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat(bookmark): add i18n keys for bookmark feature"
```

---

### Task 9: Redux Slice

**Files:**

- Create: `src/renderer/store/slices/bookmarkSlice.ts`
- Modify: `src/renderer/store/index.ts`

- [ ] **Step 1: 创建 bookmarkSlice.ts**

```ts
// src/renderer/store/slices/bookmarkSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { Bookmark } from '../../types/cowork';

interface BookmarkState {
  bookmarks: Bookmark[];
  bookmarkedKeys: Record<string, string>; // `${sessionId}:${messageId}` → bookmarkId
  loading: boolean;
}

function buildBookmarkedKeys(bookmarks: Bookmark[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const bm of bookmarks) {
    keys[`${bm.sessionId}:${bm.messageId}`] = bm.id;
  }
  return keys;
}

const initialState: BookmarkState = {
  bookmarks: [],
  bookmarkedKeys: {},
  loading: false,
};

const bookmarkSlice = createSlice({
  name: 'bookmark',
  initialState,
  reducers: {
    setBookmarks(state, action: PayloadAction<Bookmark[]>) {
      state.bookmarks = action.payload;
      state.bookmarkedKeys = buildBookmarkedKeys(action.payload);
      state.loading = false;
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    addBookmark(state, action: PayloadAction<Bookmark>) {
      state.bookmarks.unshift(action.payload);
      const bm = action.payload;
      state.bookmarkedKeys[`${bm.sessionId}:${bm.messageId}`] = bm.id;
    },
    removeBookmark(state, action: PayloadAction<string>) {
      const idx = state.bookmarks.findIndex(bm => bm.id === action.payload);
      if (idx !== -1) {
        const bm = state.bookmarks[idx];
        delete state.bookmarkedKeys[`${bm.sessionId}:${bm.messageId}`];
        state.bookmarks.splice(idx, 1);
      }
    },
  },
});

export const { setBookmarks, setLoading, addBookmark, removeBookmark } = bookmarkSlice.actions;
export default bookmarkSlice.reducer;
```

- [ ] **Step 2: 在 store/index.ts 中注册 reducer**

在 `src/renderer/store/index.ts` 中添加 import 和 reducer：

```ts
import bookmarkReducer from './slices/bookmarkSlice';
```

在 `configureStore` 的 `reducer` 对象中添加：

```ts
    bookmark: bookmarkReducer,
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/slices/bookmarkSlice.ts src/renderer/store/index.ts
git commit -m "feat(bookmark): add Redux bookmark slice and register in store"
```

---

### Task 10: Bookmark Service

**Files:**

- Create: `src/renderer/services/bookmark.ts`

- [ ] **Step 1: 创建 bookmark service**

```ts
// src/renderer/services/bookmark.ts
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
```

- [ ] **Step 2: 在 App.tsx 中初始化 service**

在 `src/renderer/App.tsx` 的 import 区域添加：

```ts
import { bookmarkService } from './services/bookmark';
```

在 `initializeApp` 函数中（约第 96-184 行），与其他 service init 并列添加：

```ts
await bookmarkService.init();
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/services/bookmark.ts src/renderer/App.tsx
git commit -m "feat(bookmark): add BookmarkService and initialize on app startup"
```

---

### Task 11: 消息上的星标按钮

**Files:**

- Modify: `src/renderer/components/cowork/CoworkSessionDetail.tsx`

- [ ] **Step 1: 在 CopyButton 和 ReEditButton 后面（约第 1160 行前）定义 BookmarkButton 组件**

```tsx
// Bookmark star button — toggles message bookmark status
const BookmarkButton: React.FC<{
  sessionId: string;
  messageId: string;
  messageType: 'user' | 'assistant';
  content: string;
  sessionTitle: string;
  visible: boolean;
}> = ({ sessionId, messageId, messageType, content, sessionTitle, visible }) => {
  const bookmarkedKeys = useSelector((state: RootState) => state.bookmark.bookmarkedKeys);
  const key = `${sessionId}:${messageId}`;
  const bookmarkId = bookmarkedKeys[key];
  const isBookmarked = Boolean(bookmarkId);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isBookmarked) {
      await bookmarkService.remove(bookmarkId);
    } else {
      await bookmarkService.add({ sessionId, messageId, messageType, content, sessionTitle });
    }
  };

  // Starred: always show; Unstarred: show on hover
  const isVisible = isBookmarked || visible;

  return (
    <button
      onClick={handleClick}
      className={`p-1.5 rounded-md hover:bg-surface-raised transition-all duration-200 ${
        isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      title={isBookmarked ? i18nService.t('bookmarkRemove') : i18nService.t('bookmarkAdd')}
    >
      {isBookmarked ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1"
          className="w-4 h-4 text-yellow-500"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 text-[var(--icon-secondary)]"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      )}
    </button>
  );
};
```

同时在文件顶部添加必要的 import：

```ts
import { bookmarkService } from '../../services/bookmark';
```

注意：`useSelector` 和 `RootState` 应已在文件中 import，检查确认。

- [ ] **Step 2: 在 UserMessageItem 中添加 BookmarkButton**

修改 `UserMessageItem` 组件（约第 1161 行）：

1. 在 props 中新增 `sessionId` 和 `sessionTitle`：

```tsx
export const UserMessageItem: React.FC<{
  message: CoworkMessage;
  skills: Skill[];
  onReEdit?: (message: CoworkMessage) => void;
  sessionId: string;
  sessionTitle: string;
}> = React.memo(({ message, skills, onReEdit, sessionId, sessionTitle }) => {
```

2. 在 action buttons 行（约第 1215 行）的 `CopyButton` 之后添加 `BookmarkButton`：

```tsx
<div className="flex items-center justify-end gap-1.5 mt-1">
  {onReEdit && (
    <ReEditButton
      visible={isHovered}
      onClick={() => onReEdit(message)}
    />
  )}
  <CopyButton
    content={message.content}
    visible={isHovered}
  />
  <BookmarkButton
    sessionId={sessionId}
    messageId={message.id}
    messageType="user"
    content={message.content}
    sessionTitle={sessionTitle}
    visible={isHovered}
  />
  {messageSkills.length > 0 && (
```

- [ ] **Step 3: 在 AssistantMessageItem 中添加 BookmarkButton**

修改 `AssistantMessageItem` 组件（约第 1265 行）：

1. 在 props 中新增：

```tsx
const AssistantMessageItem: React.FC<{
  message: CoworkMessage;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showCopyButton?: boolean;
  sessionId?: string;
  sessionTitle?: string;
}> = ({
  message, resolveLocalFilePath, mapDisplayText, showCopyButton = false, sessionId, sessionTitle,
}) => {
```

2. 在 `CopyButton` 所在的 div 中添加 `BookmarkButton`（约第 1293 行）：

```tsx
{
  showCopyButton && (
    <div className="flex items-center gap-1.5 mt-1">
      <CopyButton content={displayContent} visible={isHovered} />
      {sessionId && sessionTitle && (
        <BookmarkButton
          sessionId={sessionId}
          messageId={message.id}
          messageType="assistant"
          content={message.content}
          sessionTitle={sessionTitle}
          visible={isHovered}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: 在 AssistantTurnBlock 中传递 sessionId 和 sessionTitle**

修改 `AssistantTurnBlock` 的 props（约第 1402 行），新增：

```tsx
export const AssistantTurnBlock: React.FC<{
  turn: ConversationTurn;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showTypingIndicator?: boolean;
  showCopyButtons?: boolean;
  sessionId?: string;
  sessionTitle?: string;
}>;
```

在渲染 `AssistantMessageItem` 处（约第 1515 行）传递新 props：

```tsx
<AssistantMessageItem
  key={item.message.id}
  message={item.message}
  resolveLocalFilePath={resolveLocalFilePath}
  mapDisplayText={mapDisplayText}
  showCopyButton={showCopyButtons && !hasToolGroupAfter}
  sessionId={sessionId}
  sessionTitle={sessionTitle}
/>
```

- [ ] **Step 5: 在调用 UserMessageItem 和 AssistantTurnBlock 的父组件中传递 sessionId 和 sessionTitle**

在 `CoworkSessionDetail` 内部渲染 `UserMessageItem` 和 `AssistantTurnBlock` 的地方，添加 `sessionId={currentSession.id}` 和 `sessionTitle={currentSession.title}` 属性。搜索 `<UserMessageItem` 和 `<AssistantTurnBlock` 在文件中的所有使用位置，逐一添加。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/cowork/CoworkSessionDetail.tsx
git commit -m "feat(bookmark): add star button to user and assistant messages"
```

---

### Task 12: BookmarksView 页面

**Files:**

- Create: `src/renderer/components/BookmarksView.tsx`

- [ ] **Step 1: 创建 BookmarksView 组件**

```tsx
// src/renderer/components/BookmarksView.tsx
import React, { useCallback } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../store';
import type { Bookmark } from '../types/cowork';
import { bookmarkService } from '../services/bookmark';
import { i18nService } from '../services/i18n';

// Relative time helper
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return i18nService.t('justNow') || 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const BookmarkItem: React.FC<{
  bookmark: Bookmark;
  sessionExists: boolean;
  onJump: (bookmark: Bookmark) => void;
  onRemove: (bookmarkId: string) => void;
}> = React.memo(({ bookmark, sessionExists, onJump, onRemove }) => {
  const [isHovered, setIsHovered] = React.useState(false);
  const isUser = bookmark.messageType === 'user';
  const badgeColor = isUser ? 'text-blue-500 bg-blue-500/10' : 'text-purple-500 bg-purple-500/10';
  const borderColor = isUser ? 'border-l-blue-500' : 'border-l-purple-500';

  // Truncate content to ~5 lines
  const lines = bookmark.content.split('\n');
  const truncated = lines.length > 5 ? lines.slice(0, 5).join('\n') + '...' : bookmark.content;

  return (
    <div
      className={`bg-surface rounded-lg p-3 border-l-[3px] ${borderColor} hover:bg-surface-raised transition-colors`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${badgeColor}`}>
          {isUser ? i18nService.t('userMessage') : i18nService.t('aiReply')}
        </span>
        <span className="text-xs text-muted">
          {bookmark.sessionTitle} · {formatRelativeTime(bookmark.createdAt)}
        </span>
      </div>
      <div className="text-sm text-foreground whitespace-pre-wrap break-words line-clamp-5">
        {truncated}
      </div>
      <div className="flex items-center justify-end gap-2 mt-2">
        <button
          onClick={() => onRemove(bookmark.id)}
          className={`text-xs text-muted hover:text-red-500 transition-colors ${
            isHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {i18nService.t('removeBookmark')}
        </button>
        <button
          onClick={() => sessionExists && onJump(bookmark)}
          disabled={!sessionExists}
          className={`text-xs font-medium transition-colors ${
            sessionExists
              ? 'text-primary hover:text-primary/80 cursor-pointer'
              : 'text-muted cursor-not-allowed'
          }`}
          title={sessionExists ? i18nService.t('jumpToMessage') : i18nService.t('sessionDeleted')}
        >
          {sessionExists ? `→ ${i18nService.t('jumpToMessage')}` : i18nService.t('sessionDeleted')}
        </button>
      </div>
    </div>
  );
});

interface BookmarksViewProps {
  onJumpToMessage: (sessionId: string, messageId: string) => void;
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

const BookmarksView: React.FC<BookmarksViewProps> = ({
  onJumpToMessage,
  isSidebarCollapsed,
  onToggleSidebar,
}) => {
  const bookmarks = useSelector((state: RootState) => state.bookmark.bookmarks);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const sessionIds = React.useMemo(() => new Set(sessions.map(s => s.id)), [sessions]);

  const handleJump = useCallback(
    (bookmark: Bookmark) => {
      onJumpToMessage(bookmark.sessionId, bookmark.messageId);
    },
    [onJumpToMessage],
  );

  const handleRemove = useCallback(async (bookmarkId: string) => {
    await bookmarkService.remove(bookmarkId);
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        {isSidebarCollapsed && (
          <button
            onClick={onToggleSidebar}
            className="p-1.5 rounded-md hover:bg-surface-raised transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-secondary"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <line x1="9" x2="9" y1="3" y2="21" />
            </svg>
          </button>
        )}
        <h1 className="text-lg font-semibold text-foreground">{i18nService.t('bookmarks')}</h1>
        <span className="text-sm text-muted">{bookmarks.length}</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {bookmarks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-muted mb-4"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <p className="text-sm text-muted max-w-xs">{i18nService.t('noBookmarks')}</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-3">
            {bookmarks.map(bookmark => (
              <BookmarkItem
                key={bookmark.id}
                bookmark={bookmark}
                sessionExists={sessionIds.has(bookmark.sessionId)}
                onJump={handleJump}
                onRemove={handleRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default BookmarksView;
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/BookmarksView.tsx
git commit -m "feat(bookmark): add BookmarksView page component"
```

---

### Task 13: 侧边栏入口

**Files:**

- Modify: `src/renderer/components/Sidebar.tsx:249` (在 Agents 按钮之后)

- [ ] **Step 1: 扩展 SidebarProps**

在 `SidebarProps` interface（约第 25 行）中新增：

```ts
  onShowBookmarks: () => void;
```

同时将 `activeView` 类型扩展为：

```ts
activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'mcp' | 'agents' | 'bookmarks';
```

- [ ] **Step 2: 在 Agents 按钮后追加 Bookmarks 按钮**

在 `src/renderer/components/Sidebar.tsx` 的 Agents 按钮（约第 249 行 `</button>` 之后）插入：

```tsx
<button
  type="button"
  onClick={() => {
    setIsSearchOpen(false);
    onShowBookmarks();
  }}
  className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
    activeView === 'bookmarks'
      ? 'bg-primary/10 text-primary hover:bg-primary/20'
      : 'text-secondary hover:text-foreground hover:bg-surface-raised'
  }`}
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4"
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
  {i18nService.t('bookmarks')}
</button>
```

- [ ] **Step 3: 解构新 prop**

在组件函数签名的解构处添加 `onShowBookmarks`。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat(bookmark): add bookmarks entry to sidebar navigation"
```

---

### Task 14: App 路由 + 跳转逻辑

**Files:**

- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 扩展 mainView 类型**

将第 43 行的 `useState` 类型扩展：

```ts
const [mainView, setMainView] = useState<
  'cowork' | 'skills' | 'scheduledTasks' | 'mcp' | 'agents' | 'bookmarks'
>('cowork');
```

- [ ] **Step 2: 新增 pendingScrollToMessageId 状态**

在 `mainView` 状态附近添加：

```ts
const [pendingScrollToMessageId, setPendingScrollToMessageId] = useState<string | null>(null);
```

- [ ] **Step 3: 新增 handleShowBookmarks 回调**

在其他 `handleShow*` 回调（约第 267-285 行）附近添加：

```ts
const handleShowBookmarks = useCallback(() => {
  setMainView('bookmarks');
}, []);
```

- [ ] **Step 4: 新增 handleJumpToMessage 回调**

```ts
const handleJumpToMessage = useCallback((sessionId: string, messageId: string) => {
  // Switch to cowork view, load the session, and set pending scroll target
  coworkService.loadSession(sessionId);
  setPendingScrollToMessageId(messageId);
  setMainView('cowork');
}, []);
```

- [ ] **Step 5: 传递 props 到 Sidebar**

在 `<Sidebar>` 组件调用处（约第 682 行）添加：

```tsx
onShowBookmarks = { handleShowBookmarks };
```

同时将 `activeView` 改为 `mainView`（如果尚未直接传递的话）。

- [ ] **Step 6: 添加 BookmarksView 路由**

在视图路由的三元表达式中（约第 700 行），在 `mainView === 'agents'` 分支之后、`CoworkView` 默认分支之前，插入：

```tsx
) : mainView === 'bookmarks' ? (
  <BookmarksView
    onJumpToMessage={handleJumpToMessage}
    isSidebarCollapsed={isSidebarCollapsed}
    onToggleSidebar={() => setIsSidebarCollapsed(false)}
  />
```

在文件顶部添加 import：

```ts
import BookmarksView from './components/BookmarksView';
```

- [ ] **Step 7: 将 pendingScrollToMessageId 传递给 CoworkView → CoworkSessionDetail**

Props 传递链：

1. `App.tsx`：在 `<CoworkView>` 上添加 `pendingScrollToMessageId={pendingScrollToMessageId}` 和 `onClearPendingScroll={() => setPendingScrollToMessageId(null)}`
2. `CoworkViewProps`（`src/renderer/components/cowork/CoworkView.tsx:32`）：新增 `pendingScrollToMessageId?: string | null` 和 `onClearPendingScroll?: () => void`
3. `CoworkView` 内部渲染 `<CoworkSessionDetail>`（约第 559 行）时透传这两个 props
4. `CoworkSessionDetailProps`（`src/renderer/components/cowork/CoworkSessionDetail.tsx:42`）：新增 `pendingScrollToMessageId?: string | null` 和 `onClearPendingScroll?: () => void`

`CoworkSessionDetail` 在 session 加载完毕后检查 `pendingScrollToMessageId`：

```ts
useEffect(() => {
  if (!pendingScrollToMessageId || !currentSession?.messages?.length) return;

  // Find the message DOM element and scroll to it
  const timer = setTimeout(() => {
    const el = document.querySelector(`[data-message-id="${pendingScrollToMessageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('bookmark-flash');
      setTimeout(() => el.classList.remove('bookmark-flash'), 1500);
    }
    onClearPendingScroll?.();
  }, 300); // small delay to let virtualized list render

  return () => clearTimeout(timer);
}, [pendingScrollToMessageId, currentSession?.id]);
```

- [ ] **Step 8: 给消息元素添加 data-message-id 属性**

在 `CoworkSessionDetail.tsx` 中渲染每个 turn 或 message 的外层 `<div>` 上添加 `data-message-id={message.id}` 属性，让跳转逻辑能通过 `querySelector` 定位。

具体位置：

- `UserMessageItem` 的最外层 `<div>`（约第 1179 行）：添加 `data-message-id={message.id}`
- `AssistantMessageItem` 的最外层 `<div>`（约第 1280 行）：添加 `data-message-id={message.id}`

- [ ] **Step 9: 添加 CSS 高亮动画**

在项目的全局 CSS 文件中（或在 `CoworkSessionDetail.tsx` 所在目录的样式中）添加：

```css
@keyframes bookmarkFlash {
  0% {
    background-color: rgba(250, 204, 21, 0.3);
  }
  100% {
    background-color: transparent;
  }
}
.bookmark-flash {
  animation: bookmarkFlash 1.5s ease-out;
}
```

如果项目使用 Tailwind 且无全局 CSS 文件，可以在 `src/renderer/index.css` 或对应的入口样式文件中添加。

- [ ] **Step 10: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/cowork/CoworkSessionDetail.tsx src/renderer/index.css
git commit -m "feat(bookmark): add app routing, jump-to-message navigation with flash animation"
```

---

### Task 15: 手动验证

- [ ] **Step 1: 启动开发环境**

```bash
npm run electron:dev
```

- [ ] **Step 2: 端到端验证**

执行以下验证路径：

1. 打开一个会话，发送消息，确认消息上出现星标按钮（hover 显示）
2. 点击星标，确认变为实心黄色星标（常驻显示）
3. 打开侧边栏「收藏」页面，确认收藏条目出现
4. 点击「跳转到会话」，确认切换到对应会话并滚动到目标消息，消息短暂高亮
5. 再次点击星标取消收藏，确认收藏页移除该条目
6. 删除一个有收藏的会话，确认收藏页内容快照仍显示，跳转按钮变灰
7. 切换语言（中 ↔ 英），确认所有新增文案正确显示

- [ ] **Step 3: 运行 lint 和测试**

```bash
npm run lint
npm test -- bookmarkStore
```

预期：lint 无新 error，测试全部 PASS。

- [ ] **Step 4: 最终 Commit**

如有遗留修复：

```bash
git add -A
git commit -m "fix(bookmark): address review feedback and lint issues"
```
