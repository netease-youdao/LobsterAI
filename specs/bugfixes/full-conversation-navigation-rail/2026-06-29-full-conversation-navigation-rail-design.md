# 全量会话导航轨道修复设计文档

## 1. 概述

### 1.1 问题

测试反馈：Cowork 对话页右侧消息导航轨道目前只展示已经加载到前端的消息。长对话首次打开时，后端默认只返回最后 `30` 条消息；更早的历史消息需要用户向上滚动到顶部附近后才会分页加载。因此，右侧轨道在长对话中只代表“当前已加载窗口”，不能代表完整会话。

该问题会造成三个明显体验风险：

| 操作 | 当前行为 | 期望行为 |
|------|---------|---------|
| 打开超过 100 条消息的会话 | 右侧轨道只显示最后一页消息对应的短横线 | 右侧轨道显示整场会话的消息分布 |
| 想通过轨道跳到早期消息 | 早期消息未加载，轨道上没有对应入口 | 可以直接点击全量轨道中的早期位置并加载目标消息窗口 |
| 向上滚动逐步加载旧消息 | 轨道随着加载页逐步变长，比例和当前位置不断变化 | 轨道总量和比例稳定，正文分页加载不影响全局导航结构 |

### 1.2 根因

右侧轨道的数据源是 `currentSession.messages`，而该数组是分页后的正文消息窗口，不是完整会话历史。

**关键代码路径**：

```typescript
const messages = currentSession?.messages;
const displayItems = useMemo(() => messages ? buildDisplayItems(messages) : [], [messages]);
const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);
const railItems = useMemo(() => buildRailItems(turns), [turns]);
```

打开会话时，主进程使用 `COWORK_MESSAGE_PAGE_SIZE = 30` 作为默认消息页大小：

```typescript
const totalMessages = this.countSessionMessages(id);
const messageOffset = Math.max(0, totalMessages - messageLimit);
const messages = this.getPagedSessionMessages(id, messageLimit, messageOffset);
```

因此，对 140 条消息的会话，首次进入时 `currentSession.messages` 只包含 offset `110` 之后的 30 条消息。`buildRailItems()` 只能基于这 30 条生成轨道，更早的 110 条消息在轨道上不可见。

`LazyRenderTurn` 只解决 DOM 渲染性能问题：远离视口的 turn 会渲染占位并缓存高度。它不能弥补未进入 `currentSession.messages` 的历史消息，因为这些消息既没有正文数据，也没有轻量索引数据。

## 2. 用户场景

### 场景 1: 首次打开长对话

**Given** 用户打开一条超过 100 条消息的 Cowork 会话
**When** 首屏只加载最后一页正文消息
**Then** 右侧消息导航轨道仍展示整场会话的消息分布，而不是只展示最后一页

### 场景 2: 点击轨道跳到已加载消息

**Given** 用户打开长对话，目标消息已经在当前 `currentSession.messages` 窗口中
**When** 用户点击右侧轨道中对应消息
**Then** 页面直接滚动到对应消息，保持现有 smooth/auto 跳转策略

### 场景 3: 点击轨道跳到未加载历史消息

**Given** 用户打开长对话，目标消息位于尚未加载的历史区间
**When** 用户点击右侧轨道中对应消息
**Then** 前端先加载包含目标消息的消息窗口，再滚动到该目标消息

### 场景 4: 滚动顶部继续加载旧消息

**Given** 用户仍按原方式向上滚动到已加载窗口顶部
**When** 触发 `loadMoreMessages`
**Then** 正文继续 prepend 旧消息，但右侧全量轨道总数和比例不发生结构性跳变

### 场景 5: 会话流式输出新消息

**Given** 当前会话正在运行并产生新消息
**When** 新用户消息、助手消息或最终回复写入本地状态
**Then** 右侧轨道应追加或刷新新增消息的轻量轨道项，且不破坏当前滚动位置

## 3. 功能需求

### FR-1: 轨道数据必须与正文分页解耦

右侧轨道不能继续只依赖 `currentSession.messages`。长对话打开时，正文仍按现有分页策略加载最后 `30` 条；轨道需要单独获取完整会话的轻量索引。

### FR-2: 提供全量轻量 rail index

主进程需要提供按会话读取的轻量消息索引，至少包含：

- `messageId`
- `type`
- `sequence`
- `messageOffset`
- `timestamp`
- `preview`
- `contentLen`
- 可选 `turnOrdinal`
- 可选 `railRole`

该接口不能返回完整 `content`，避免长会话一次性把所有正文传到 renderer。

### FR-3: rail item 必须能定位到数据库消息顺序

每个轨道项必须携带足够信息，用于判断目标消息是否已加载，以及需要从哪个 offset 加载目标窗口。不能只使用当前渲染窗口内的 `turnIndex`。

### FR-4: 点击未加载轨道项时按窗口加载

当用户点击的轨道项不在当前已加载消息窗口中时，前端应通过 `getSessionMessages({ sessionId, limit, offset })` 加载包含目标消息的窗口，并替换或扩展当前正文窗口，随后滚动到目标 DOM。

### FR-5: 保持现有顶部滚动加载行为

用户手动向上滚动接近顶部时，现有 `loadMoreMessages()` prepend 旧消息的行为应继续可用。全量 rail index 只改变轨道数据源和点击跳转能力，不应取消普通滚动加载。

### FR-6: 流式消息期间轨道保持可用

运行中的会话新增消息时，轨道应能基于本地新增消息即时追加临时 rail item。会话重新加载或 rail index 刷新后，再与主进程持久化索引对齐。

## 4. 实现方案

### 4.1 新增轻量轨道索引类型

建议新增共享类型，避免主进程、preload、renderer 各自定义结构。

**候选位置**：`src/shared/cowork/rail.ts`

```typescript
export interface CoworkMessageRailIndexItem {
  messageId: string;
  type: 'user' | 'assistant';
  sequence: number | null;
  messageOffset: number;
  timestamp: number;
  preview: string;
  contentLen: number;
}
```

只为 `user` 和有正文内容的 `assistant` 消息生成轨道项。`tool_use`、`tool_result`、`system` 默认不单独进入 rail，保持当前 `buildRailItems()` 的用户/助手粒度。

### 4.2 主进程新增 rail index 查询

**位置**：`src/main/coworkStore.ts`

新增方法：

```typescript
getSessionMessageRailIndex(sessionId: string): CoworkMessageRailIndexItem[] {
  const rows = this.getAll<{
    id: string;
    type: string;
    content: string;
    created_at: number;
    sequence: number | null;
  }>(
    `
    SELECT id, type, content, created_at, sequence
    FROM cowork_messages
    WHERE session_id = ?
      AND type IN ('user', 'assistant')
      AND TRIM(content) <> ''
    ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
    `,
    [sessionId],
  );

  return rows.map(row => ({
    messageId: row.id,
    type: row.type as 'user' | 'assistant',
    sequence: row.sequence,
    timestamp: row.created_at,
    preview: getRailPreview(row.content),
    contentLen: row.content.length,
  }));
}
```

`getRailPreview()` 应复用或抽出与 renderer `stripRailLabelMarkdown()` 一致的纯逻辑，限制长度为 50 字符左右。主进程只返回 preview，不返回完整 content。

### 4.3 新增 IPC 和 preload API

**位置**：

- `src/shared/cowork/constants.ts`
- `src/main/main.ts`
- `src/main/preload.ts`
- `src/renderer/types/electron.d.ts`

新增 IPC channel 常量，例如：

```typescript
GetSessionMessageRailIndex: 'cowork:session:getMessageRailIndex'
```

新增 renderer 可调用 API：

```typescript
getSessionMessageRailIndex(sessionId: string): Promise<{
  success: boolean;
  items?: CoworkMessageRailIndexItem[];
  error?: string;
}>;
```

IPC handler 只做读取和返回，不改变 session 状态。

### 4.4 Redux 存储 rail index

**位置**：`src/renderer/store/slices/coworkSlice.ts`

在 cowork state 中新增：

```typescript
messageRailIndexBySessionId: Record<string, CoworkMessageRailIndexItem[]>;
messageRailIndexLoadingBySessionId: Record<string, boolean>;
```

新增 actions：

- `setMessageRailIndexLoading({ sessionId, loading })`
- `setMessageRailIndex({ sessionId, items })`
- `appendMessageRailIndexItem({ sessionId, item })` 或在 `addMessage` 中同步维护
- `clearMessageRailIndex({ sessionId })`，用于删除会话或必要的重载

会话切换时不要清空其他会话的 rail index，避免来回切换重复请求。

### 4.5 coworkService 加载 rail index

**位置**：`src/renderer/services/cowork.ts`

新增方法：

```typescript
async loadSessionMessageRailIndex(sessionId: string): Promise<CoworkMessageRailIndexItem[]> {
  const result = await window.electron.cowork.getSessionMessageRailIndex(sessionId);
  if (result.success && result.items) {
    store.dispatch(setMessageRailIndex({ sessionId, items: result.items }));
    return result.items;
  }
  return [];
}
```

`loadSession(sessionId)` 成功后可以并行或随后触发 rail index 加载。rail index 加载失败时，页面应降级为当前 `currentSession.messages` 生成的局部轨道。

### 4.6 CoworkSessionDetail 使用全量 rail index 并按对话轮次分组

**位置**：`src/renderer/components/cowork/CoworkSessionDetail.tsx`

轨道的视觉 item 不再按单条 `user` / `assistant` 消息拆分，而是按一轮对话聚合：

- 一条用户消息开始一个 rail item。
- 紧随其后的助手消息作为该 rail item 的回答摘要。
- 如果存在没有用户消息的助手消息，则作为独立 rail item 降级展示。
- 点击 rail item 时定位到该轮的起始消息，优先使用用户消息；没有用户消息时使用助手消息。

将 `RailItem` 从当前窗口 turn 结构扩展为可表达全局对话轮次：

```typescript
type RailItem = {
  key: string;
  messageId: string | null;
  absoluteIndex: number;
  title: string;
  summary: string;
  contentLen: number;
  isLoaded: boolean;
  loadedTurnIndex: number | null;
};
```

rail items 优先来自 `messageRailIndexBySessionId[currentSession.id]`。当 rail index 未加载或为空时，保留当前 `buildRailItems(turns)` 作为降级路径。

同时构建已加载消息到 DOM 的映射：

```typescript
const loadedRailTargetByMessageId = new Map<string, HTMLElement>();
```

当前 JSX 中已经给 user/assistant 外层标记了 `data-rail-index`。需要改为稳定的 `data-rail-message-id`，避免全量轨道 index 与当前分页窗口 index 不一致。

tooltip 展示需要类似 IDE/Codex 小地图预览：

- 第一行加粗显示该轮用户问题摘要。
- 第二行显示助手回答摘要，最多 2 行截断。
- 底部显示来源标识，例如 `LobsterAI`，用于说明该 tooltip 来自当前 Cowork 会话。
- rail index 尚未返回时允许短暂显示“未加载消息”兜底；rail index 成功后所有 item 都应展示真实摘要。

轨道短线样式需要与 Codex 小地图一致：

- 默认状态下所有轨道短线使用统一短宽度，不再根据消息长度绘制长短。
- 当前 active item 使用更深颜色和最长宽度。
- 鼠标 hover 某个 item 时，以 hover item 为中心，向上下邻近若干条逐步缩短，形成阶梯视觉。
- hover 阶梯只影响视觉宽度和颜色，不改变 rail item 数据、tooltip 数据、点击定位或懒加载逻辑。
- 轨道整体保持内容高度自适应，仅受最大高度限制；item 过多时中间轨道列表内部滚动，箭头不被撑到上下两端。
- 点击 rail item 定位到懒渲染占位 turn 时，应临时强制渲染目标 turn 并重试定位真实消息节点，避免页面跳到空白占位区域后需要用户手动滚动才展示内容。
- 只有当前加载窗口包含会话真实末尾时，滚到底部才允许 rail 高亮吸附到最终 item；中间分页窗口的局部底部仍应按当前可见 turn 计算高亮。
- rail 导航到非末尾 item 时必须暂停自动滚底状态，避免目标窗口加载后被 auto-scroll effect 覆盖回最后一条高亮。
- 消息列表滚动或 prepend 旧消息导致 rail item 布局变化时，右侧 rail 容器应自动滚动，保持当前高亮 item 在 rail 可视范围内；高亮为第一条时 rail 必须回到顶部。

分组只发生在 renderer 侧，不改变主进程轻量索引接口。主进程仍返回单条消息级别的轻量 preview，以避免一次性传输完整历史正文。

### 4.7 点击未加载 rail item 时加载目标窗口

新增导航流程：

```typescript
const navigateToRailItem = async (railIndex: number) => {
  const item = railItems[railIndex];
  if (!item) return;

  const loadedTarget = findLoadedTarget(item.messageId);
  if (loadedTarget) {
    scrollToLoadedTarget(loadedTarget);
    return;
  }

  await loadMessageWindowAroundRailItem(item);
  requestAnimationFrame(() => {
    const target = findLoadedTarget(item.messageId);
    if (target) scrollToLoadedTarget(target);
  });
};
```

目标 offset 计算优先使用 rail index 的 `messageOffset`。该值按完整 `cowork_messages` 顺序计算，而不是按 rail item 顺序计算，避免会话中夹杂 `tool_use`、`tool_result` 或 `system` 消息时跳转偏移：

```typescript
const PAGE_SIZE = 50;
const targetOffset = Math.max(0, item.messageOffset - Math.floor(PAGE_SIZE / 2));
```

加载窗口有两种可选策略：

1. **替换窗口**：将当前 `currentSession.messages` 替换为目标窗口，`messagesOffset = targetOffset`。实现简单，但用户从底部跳到早期消息后，原底部窗口会被移出当前状态。
2. **合并窗口**：把目标窗口与现有窗口按 sequence/id 合并，并维护 loaded ranges。体验更连续，但状态和滚动恢复复杂。

本次修复建议采用 **替换窗口 + 保留滚动顶部 prepend 行为** 作为第一阶段方案。理由是它能直接满足“点击全量轨道导航到未加载消息”，同时避免在 Redux 中引入多区间 loaded ranges。后续如果需要无缝多窗口缓存，再单独设计。

为支持替换窗口，`coworkSlice.ts` 需要新增 action：

```typescript
setMessageWindow({
  sessionId,
  messages,
  messagesOffset,
  totalMessages,
});
```

该 action 只在当前 session 匹配时更新 `currentSession.messages`、`messagesOffset`、`totalMessages`。

### 4.8 当前 rail index 同步逻辑调整

当前滚动监听通过 turn midpoint 推导 `currentRailIndex`。全量 rail 后，需要基于可见的已加载 DOM 节点同步到全局 rail index。

建议：

1. 每个可定位 DOM 节点写入 `data-rail-message-id`。
2. 构建 `messageId -> railIndex` map。
3. 滚动时在当前可见 turn 内找到最近的 user/assistant anchor。
4. 用 `messageIdToRailIndex.get(messageId)` 更新 active rail。
5. 滚动到底部时仍 snap 到最后一个 rail item。

未加载区间不会有 DOM anchor，但 rail 自身仍完整可见。用户点击未加载 rail item 时由 4.7 加载窗口。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| rail index 加载失败 | 降级使用当前已加载消息生成局部 rail，并记录 warn 诊断 |
| 会话消息数少于默认页大小 | rail index 与当前消息窗口一致，不额外改变体验 |
| 点击未加载 rail item 后接口失败 | 保持当前窗口，toast 或静默 warn，不改变 active rail |
| 点击 rail item 时会话已切换 | requestId 或 sessionId 校验，不写入旧会话状态 |
| 流式中的 assistant 消息内容持续增长 | 本地 rail item 可更新 `preview/contentLen`，持久化刷新后对齐 |
| 消息缺少 sequence | 使用 `created_at` 和查询顺序生成 `absoluteIndex`，不要依赖 nullable sequence 做唯一定位 |
| 目标窗口加载后目标消息仍不存在 | 不滚动，记录诊断，避免 active rail 假跳转 |
| 用户从早期窗口点击回最后一条 | 按同一窗口加载逻辑加载底部附近窗口，并滚动到目标 |
| 顶部 prepend 与 rail 点击加载同时发生 | 使用 loading guard，避免并发更新 currentSession.messages |

## 6. 涉及文件

- `src/shared/cowork/rail.ts` — 新增全量轨道轻量索引类型和 preview 相关纯逻辑
- `src/shared/cowork/constants.ts` — 新增 rail index IPC channel 常量
- `src/main/coworkStore.ts` — 新增 `getSessionMessageRailIndex()`，按顺序读取轻量消息索引
- `src/main/main.ts` — 新增 `cowork:session:getMessageRailIndex` IPC handler
- `src/main/preload.ts` — 暴露 `getSessionMessageRailIndex()` 给 renderer
- `src/renderer/types/electron.d.ts` — 补充 preload 类型
- `src/renderer/store/slices/coworkSlice.ts` — 存储 rail index，新增窗口替换 action
- `src/renderer/services/cowork.ts` — 新增 rail index 加载和目标窗口加载方法
- `src/renderer/components/cowork/CoworkSessionDetail.tsx` — 使用全量 rail index 渲染轨道，支持未加载目标跳转
- `src/renderer/components/cowork/LazyRenderTurn.tsx` — 原则上无需修改；仅在发现占位高度影响目标滚动时再调整

## 7. 验收标准

1. 打开 140 条消息测试会话时，右侧轨道首次展示全量消息分布，而不是只展示最后 30 条。
2. 首次打开长会话后，不向 renderer 传输完整历史正文；正文仍只加载分页窗口。
3. 点击当前已加载窗口内的轨道项，可以直接滚动到目标消息。
4. 点击未加载历史区间的轨道项，会加载包含目标消息的窗口，并滚动到目标消息。
5. 手动向上滚动到顶部附近仍能触发旧消息 prepend 加载。
6. rail index 加载失败时，对话页仍能使用当前局部轨道，不阻塞会话阅读。
7. 运行中会话新增消息时，轨道能追加或刷新新增用户/助手消息入口。
8. 轨道视觉 item 按一问一答合并展示；140 条交替 user/assistant 消息应展示约 70 个轨道 item。
9. tooltip 应显示该轮用户问题摘要和助手回答摘要，而不是只显示单条消息或占位 `Message N`。
10. 合并后的 rail item 点击仍能加载并定位到该轮起始消息，不受 tool/system 消息夹杂影响。
11. 轨道默认短线宽度统一；hover 时邻近 item 呈现从中心向外递减的阶梯宽度。
12. 轨道高度保持内容自适应，仅超出最大高度时滚动；上下箭头应靠近轨道内容。
13. 点击任意已加载或刚加载的 rail item 后，目标消息内容应直接可见，不应停留在 LazyRenderTurn 占位空白区域。
14. 滚到中间分页窗口底部时，rail 高亮应对应当前可见 turn；只有会话真实底部才高亮最终 item。
15. 首次进入会话后点击最上方 rail item，应滚到第一条消息并高亮第一条，不应被自动滚底逻辑恢复到最后一条。
16. 首次进入会话后连续向上滚动并触发多次 prepend，消息到达顶部时右侧 rail 应自动滚动到顶部并展示第一条高亮 item，不需要用户手动滚动 rail。
17. 目标实现后，相关 TypeScript 文件通过 changed-file ESLint：

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <touched files>
```

14. 相关分页和 Redux 行为需要补 Vitest 覆盖，至少包括：
   - rail index action 写入和缓存
   - `setMessageWindow` 替换窗口
   - `prependMessages` 与窗口替换后的 offset 行为
   - 点击未加载 rail item 时计算目标 offset
