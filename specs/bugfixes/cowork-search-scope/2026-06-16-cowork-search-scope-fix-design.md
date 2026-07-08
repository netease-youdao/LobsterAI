# Cowork 任务搜索范围受限修复 Spec

## 问题描述

用户在左侧导航点击“搜索任务”打开 Cowork 搜索弹窗后，输入关键词只能命中弹窗当前加载到的任务。若目标任务不在最近一批任务中，即使标题完全匹配，也不会出现在搜索结果里。

### 现象

- 搜索弹窗默认展示近期任务
- 输入关键词后，只在弹窗已加载的任务中做过滤
- 历史任务数量超过当前搜索加载上限时，较早任务无法被搜索到
- 首页左侧“我的 Agent”历史任务列表展开后能看到更多任务，但搜索弹窗仍无法命中这些较早任务

---

## 根因分析

搜索弹窗和首页历史任务列表不是复用同一份前端状态，但它们共用底层 Cowork 会话表与 `cowork:session:list` IPC。

| 入口 | 前端状态 | 数据请求 | 搜索/分页行为 |
|------|----------|----------|---------------|
| 搜索弹窗 | `CoworkSearchModal.searchSessions` | `coworkService.listSessionsForSearch(100, 0)` | 拉取最近 100 条后在前端过滤 |
| 首页历史任务列表 | `useAgentSidebarState.taskPreviewsByAgentId` | `coworkService.listSessionsForAgentPreview(agentId, limit, offset)` | 按 Agent 分页加载，展开时继续拉取 |
| Redux Cowork 会话列表 | `cowork.sessions` | `coworkService.loadSessions(agentId?)` | 当前 Agent 的首屏分页数据 |

当前搜索弹窗存在两个限制：

1. `SEARCH_SESSION_LIMIT = 100`，打开弹窗只请求 `limit=100, offset=0`
2. 关键词过滤发生在渲染器侧，只过滤 `searchSessions`，没有将搜索词传到 SQLite 查询层

因此搜索实际范围是“最近 100 条任务”，不是全量历史任务。

### 关键路径

1. `CoworkSearchModal` 打开时调用 `listSessionsForSearch(SEARCH_SESSION_LIMIT, 0)`
2. `coworkService.listSessionsForSearch` 直接调用 `window.electron.cowork.listSessions({ limit, offset })`
3. 主进程 `cowork:session:list` 调用 `store.listSessions(limit, offset, agentId)`
4. `CoworkStore.listSessions` 执行 `ORDER BY ... LIMIT ? OFFSET ?`，没有搜索条件
5. 弹窗输入框变化后，`filteredSessions` 在前端对这批结果做 `title.includes(query)` 与 `agentName.includes(query)`

---

## 解决方案

### 修复 1：为列表 IPC 增加可选搜索参数

扩展 `cowork:session:list` 的 options，新增可选字段：

```typescript
{
  limit?: number;
  offset?: number;
  agentId?: string;
  searchQuery?: string;
}
```

兼容原则：

- `searchQuery` 为空或只包含空白字符时，保持现有 `listSessions/countSessions` 行为不变
- 只有搜索弹窗传入非空 `searchQuery` 时，才走数据库搜索分支
- 不改变默认排序、分页语义、返回结构和 `hasMore` 计算方式

### 修复 2：在 CoworkStore 增加数据库侧搜索方法

新增专用方法，避免改变现有 `listSessions` 的默认行为：

```typescript
searchSessions(options: {
  query: string;
  limit?: number;
  offset?: number;
  agentId?: string;
}): CoworkSessionSummary[]

countSearchSessions(options: {
  query: string;
  agentId?: string;
}): number
```

搜索范围：

- 首期只搜索任务标题 `cowork_sessions.title`
- 可选按 `agentId` 限定，用于后续复用到 Agent 内搜索时保持一致
- 匹配使用 SQLite `LIKE`，并对 `%`、`_`、`\` 做转义，避免用户输入通配符导致结果范围异常

排序规则：

- 与现有列表保持一致：
  - pinned 任务优先
  - pinned 按 `pin_order/updated_at/created_at` 升序
  - 非 pinned 按 `updated_at` 降序
  - 最后按 `updated_at` 降序兜底

### 修复 3：搜索弹窗改为查询数据库，而不是只过滤已加载结果

搜索弹窗行为调整：

- 无关键词时：继续展示近期任务，使用现有 `listSessionsForSearch(limit, offset)`
- 有关键词时：调用 `listSessionsForSearch(limit, offset, searchQuery)`，由主进程返回数据库搜索结果
- 输入变化加短 debounce，避免每次按键立即 IPC 请求
- 请求使用递增 request id 或 cancelled 标记，避免较慢的旧请求覆盖新结果
- 保留本地 agent 名称过滤作为补充，但不作为唯一搜索范围

建议首期限制：

- 每次搜索返回 `SEARCH_SESSION_LIMIT` 条
- 不在本次修复中新增“加载更多搜索结果”交互，避免扩大 UI 改动面
- `hasMore=true` 时可后续增加滚动加载，本次只保证搜索范围从“已加载 100 条”提升为“数据库全量匹配的前 100 条”

---

## 影响控制

### 不应改变的行为

| 场景 | 保持方式 |
|------|----------|
| 首页左侧历史任务首屏 | 不传 `searchQuery`，继续走原 `listSessions` |
| 首页“展开显示”分页 | 不传 `searchQuery`，继续按 Agent 分页加载 |
| 快捷键打开第 N 个任务 | 不传 `searchQuery`，保持当前排序和分页 |
| Cowork Redux 会话列表 | `loadSessions(agentId?)` 不传搜索词，行为不变 |
| 删除、置顶、重命名后的列表更新 | 不修改现有 reducer 和列表合并逻辑 |

### 需要避免的风险

1. 不要直接把 `listSessions` 改成默认搜索逻辑，否则可能影响所有历史任务列表入口
2. 不要改变 `cowork:session:list` 的默认返回排序，否则快捷键任务槽位和首页列表顺序会变化
3. 不要将搜索结果写入 Redux `cowork.sessions`，否则会污染首页历史任务状态
4. 不要用前端一次性拉全量任务再过滤，历史数据较多时会放大 IPC 和渲染开销

---

## 涉及文件

| 文件 | 变更 |
|------|------|
| `src/main/coworkStore.ts` | 新增 `searchSessions` / `countSearchSessions`，复用现有 summary row 映射与排序规则 |
| `src/main/main.ts` | 扩展 `cowork:session:list` options；当 `searchQuery` 非空时调用搜索方法 |
| `src/main/preload.ts` | 扩展 `listSessions` options 类型，新增 `searchQuery?: string` |
| `src/renderer/types/electron.d.ts` | 同步扩展 `window.electron.cowork.listSessions` 类型 |
| `src/renderer/services/cowork.ts` | 扩展 `listSessionsForSearch` 参数，搜索弹窗专用，不写 Redux |
| `src/renderer/components/cowork/CoworkSearchModal.tsx` | 输入关键词时请求数据库搜索结果；无关键词时保留近期任务展示 |
| `src/main/coworkStore.test.ts` | 增加搜索范围、转义、agentId 限定、排序与计数测试 |

---

## 验证方法

### 功能验证

1. 准备超过 100 条 Cowork 任务，其中第 101 条之后包含唯一标题，例如 `深层历史任务搜索验证`
2. 打开“搜索任务”弹窗
3. 输入 `深层历史任务搜索验证`
4. 验证目标任务出现在搜索结果中
5. 清空输入框，验证弹窗恢复展示近期任务
6. 点击搜索结果，验证能正常切换到对应会话

### 回归验证

| 场景 | 预期 |
|------|------|
| 首页左侧 Main Agent 任务列表 | 首屏仍显示 6 条，顺序不变 |
| 点击“展开显示” | 能继续分页加载更多任务 |
| 置顶任务 | 首页与搜索弹窗默认近期列表中仍优先显示 |
| 搜索不存在的标题 | 显示“未找到匹配任务” |
| 搜索包含 `%`、`_`、`\` 的标题 | 按普通字符匹配，不扩大结果 |
| 快捷键打开当前 Agent 第 1-9 个任务 | 仍按首页列表顺序打开 |
| 删除或重命名任务后再搜索 | 搜索结果反映最新 SQLite 数据 |

### 自动化验证

- 运行 `npm run lint`
- 运行 `npm test -- coworkStore`
- 若后续新增渲染器测试，覆盖：
  - 输入非空搜索词会调用带 `searchQuery` 的 `listSessions`
  - 清空搜索词会回到近期任务请求
  - 旧请求不会覆盖新请求结果

---

## 已知边界

1. 首期只搜索任务标题，不搜索消息正文、工作目录、Agent 名称或 tool 输出内容。
2. 搜索弹窗仍只展示前 `SEARCH_SESSION_LIMIT` 条匹配结果；若匹配结果超过上限，本次不新增滚动加载交互。
3. Agent 名称匹配如果继续保留在前端，只能作用于当前返回结果；完整 Agent 名称数据库搜索需额外维护 agent 元数据索引，不纳入本次修复。
4. SQLite `LIKE` 的大小写行为受 SQLite 默认规则影响；中英文标题的包含匹配满足当前需求，不引入 FTS 索引。
5. 本次修复不改变现有首页历史任务列表的数据加载策略，避免影响首屏性能与快捷键任务槽位。
