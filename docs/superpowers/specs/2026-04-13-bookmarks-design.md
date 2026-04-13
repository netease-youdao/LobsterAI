# 收藏功能设计文档

**日期：** 2026-04-13  
**状态：** 已批准

## 概述

新增收藏功能，用户可以对对话中的单条消息（user 和 assistant 类型）进行星标收藏。侧边栏新增入口，打开专用的收藏页面，列出所有已收藏消息，每条消息附带「跳转到会话」按钮，可精确定位到消息在原始会话中的位置。

## 需求

- 用户可收藏 `user` 和 `assistant` 类型的消息（不包含 tool_use / tool_result / system）
- 收藏操作是简单的星标切换——无备注、无标签
- 侧边栏新增收藏入口（第 7 位，位于「我的 Agent」之后），打开收藏页
- 收藏页使用紧凑列表布局：内容预览 + 来源会话名 + 时间 + 跳转按钮
- 点击「跳转」后切换到对应会话、滚动到目标消息、短暂高亮闪烁
- 收藏通过内容快照持久化，即使原始会话被删除，收藏内容仍可展示；跳转按钮在会话不存在时变为禁用状态

## 数据模型

### SQLite 表：`bookmarks`

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK(message_type IN ('user', 'assistant')),
  content      TEXT NOT NULL,
  session_title TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(session_id, message_id)
);
```

- `session_id` + `message_id` 唯一标识来源消息；UNIQUE 约束防止重复收藏同一条消息
- `content` 是收藏时的消息文本快照；即使原始会话被删除，内容仍可展示
- `session_title` 是收藏时的会话标题快照

### TypeScript 类型（新增到 `src/renderer/types/cowork.ts`）

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

## 后端层（Main Process）

### `src/main/bookmarkStore.ts`

负责 `bookmarks` 表的所有 SQL 操作：

| 函数                                 | 说明                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `addBookmark(params)`                | INSERT OR IGNORE（UNIQUE 约束处理重复）；返回新建或已存在的 `Bookmark` |
| `removeBookmark(id)`                 | 按 bookmark id 删除                                                    |
| `listBookmarks()`                    | 查询全部，按 `created_at DESC` 排序                                    |
| `isBookmarked(sessionId, messageId)` | 返回 `{ bookmarked: boolean; bookmarkId?: string }`                    |

### IPC 频道（常量定义在 `src/main/constants.ts`，注册在 `src/main/main.ts`）

| 频道                    | 类型   | 说明                      |
| ----------------------- | ------ | ------------------------- |
| `bookmark:add`          | invoke | 添加收藏；返回 `Bookmark` |
| `bookmark:remove`       | invoke | 按 `bookmarkId` 删除收藏  |
| `bookmark:list`         | invoke | 返回全部收藏列表          |
| `bookmark:isBookmarked` | invoke | 查询某条消息是否已收藏    |

### `src/main/preload.ts`

通过 `contextBridge` 暴露新的 `bookmark` 命名空间：

```ts
window.electron.bookmark = {
  add(params: Omit<Bookmark, 'id' | 'createdAt'>): Promise<Bookmark>
  remove(bookmarkId: string): Promise<void>
  list(): Promise<Bookmark[]>
  isBookmarked(sessionId: string, messageId: string): Promise<{ bookmarked: boolean; bookmarkId?: string }>
}
```

### `src/main/sqliteStore.ts`

在 `initDb()` 中新增 `bookmarks` 表的建表语句和唯一索引。

## 前端状态层

### Redux Slice：`src/renderer/store/slices/bookmarkSlice.ts`

```ts
interface BookmarkState {
  bookmarks: Bookmark[];
  // 派生的快速查找映射：`${sessionId}:${messageId}` → bookmarkId
  bookmarkedKeys: Record<string, string>;
  loading: boolean;
}

actions:
  setBookmarks(bookmarks: Bookmark[])   // 初始化/刷新时全量替换
  addBookmark(bookmark: Bookmark)        // 新增一条
  removeBookmark(bookmarkId: string)     // 移除一条
```

每次 `setBookmarks` / `addBookmark` / `removeBookmark` 都会重新计算 `bookmarkedKeys`，确保星标状态查询同步完成、无 IPC 开销。

### Service：`src/renderer/services/bookmark.ts`

| 函数                                 | 说明                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `init()`                             | 通过 IPC 获取全量列表 → `dispatch(setBookmarks(...))`               |
| `add(params)`                        | 调用 IPC `bookmark:add` → 成功后 `dispatch(addBookmark(...))`       |
| `remove(bookmarkId)`                 | 调用 IPC `bookmark:remove` → 成功后 `dispatch(removeBookmark(...))` |
| `isBookmarked(sessionId, messageId)` | 从 Redux `bookmarkedKeys` 读取——无需 IPC                            |

`bookmarkService.init()` 在 `src/renderer/App.tsx` 启动时调用，与现有 `coworkService.init()` 并列。

## UI 层

### 消息组件中的星标按钮（`src/renderer/components/cowork/CoworkSessionDetail.tsx`）

在 `UserMessageItem` 和 `AssistantMessageItem` 中新增：

- **未收藏：** 空心星图标（☆），鼠标悬停时显示，与现有 `CopyButton` 并列
- **已收藏：** 实心星图标（★），常驻显示；再次点击取消收藏
- 状态从 `bookmarkService.isBookmarked()` 同步读取（来自 Redux）
- 点击后调用 `bookmarkService.add()` 或 `bookmarkService.remove()`；IPC 确认后更新状态

### 侧边栏入口（`src/renderer/components/Sidebar.tsx`）

在现有「我的 Agent」按钮之后新增按钮（顶部导航组第 7 位）：

```tsx
<button onClick={() => onShowBookmarks()}>
  <StarIcon />
  {t('bookmarks')}
</button>
```

`App.tsx` 的 `mainView` 类型扩展为：`'cowork' | 'skills' | 'scheduledTasks' | 'mcp' | 'agents' | 'bookmarks'`

### 收藏页面（`src/renderer/components/BookmarksView.tsx`）

```
BookmarksView
├── 页面标题：t('bookmarks')
├── 空状态提示（无收藏时展示）
└── 收藏列表（按 created_at DESC 排序）
    └── BookmarkItem（每条记录）
        ├── 类型标签："AI 回复" | "用户消息"
        ├── 内容预览（最多 5 行，超出截断省略）
        ├── 来源会话标题 + 相对时间
        ├── 跳转按钮（会话已删除时禁用 + tooltip 提示）
        └── 删除收藏按钮（鼠标悬停时出现）
```

### 跳转到消息的导航逻辑

用户点击「跳转」时：

1. `App.tsx` 设置 `mainView → 'cowork'` 并将 `currentSessionId` 设为收藏项的 `sessionId`
2. `App.tsx` 设置 `pendingScrollToMessageId: string | null` 为收藏项的 `messageId`
3. `CoworkSessionDetail` 在挂载后或会话加载完成后检查 `pendingScrollToMessageId`；若有值则调用 `scrollToMessage(messageId)` 并清空该状态
4. `scrollToMessage` 找到目标消息的 DOM 元素，滚动使其可见，并通过临时添加 className 触发 CSS 高亮动画（`@keyframes bookmarkFlash`，约 1.5 秒后还原）

会话存在性检查：跳转按钮渲染前，检查 `sessionId` 是否存在于 Redux 的会话列表中。

## i18n 键

在 `src/renderer/services/i18n.ts` 的 `zh` 和 `en` 两个部分中新增：

| 键                | 中文                              | 英文                                                 |
| ----------------- | --------------------------------- | ---------------------------------------------------- |
| `bookmarks`       | 收藏                              | Bookmarks                                            |
| `bookmarkAdded`   | 已收藏                            | Bookmarked                                           |
| `bookmarkRemoved` | 已取消收藏                        | Removed from bookmarks                               |
| `noBookmarks`     | 暂无收藏，在对话中点击 ☆ 收藏消息 | No bookmarks yet. Click ☆ on any message to save it. |
| `jumpToMessage`   | 跳转到会话                        | Jump to message                                      |
| `sessionDeleted`  | 会话已删除                        | Session deleted                                      |
| `aiReply`         | AI 回复                           | AI reply                                             |
| `userMessage`     | 用户消息                          | User message                                         |

## 错误处理

- `bookmark:add` IPC 失败：显示简短的 toast 错误提示；Redux 状态不变
- `bookmark:remove` IPC 失败：同上；星标状态保持不变
- 会话已删除：跳转按钮渲染为 `disabled` 状态，附带 tooltip 显示 `t('sessionDeleted')`；内容快照正常展示

## 测试

- 单元测试在 `src/main/bookmarkStore.test.ts` 中，覆盖：增、删、查全部、查是否已收藏、重复收藏防护
- 手动验证：收藏消息 → 出现在收藏页 → 跳转正确定位 → 取消收藏后移除 → 删除会话后内容快照保留但跳转按钮禁用
