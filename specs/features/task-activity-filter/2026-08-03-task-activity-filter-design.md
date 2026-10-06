# LobsterAI 任务动态筛选（多 Agent）设计文档

状态：Draft  
日期：2026-08-03  
分类：功能  
参考：用户提供的 Codex 默认态/筛选态截图、`2026-05-07-my-agent-sidebar-redesign-design.md`、任务完成提醒相关设计

## 1. 概述

### 1.1 问题/背景

LobsterAI 当前在首页左侧侧边栏中，以「Agent 分组 → 任务会话」的树形结构展示任务。该结构适合浏览单个 Agent 的历史任务，但当多个 Agent 同时执行任务时，用户需要逐个展开 Agent，才能发现以下需要关注的状态：

- 任务已完成，但结果还没有查看；
- 任务正在等待用户授权或回答问题；
- 任务仍在运行；
- 用户希望快速回到最近处理过的任务。

Codex 的 Activity 入口提供了一个可借鉴的信息架构：默认视图保留项目树，点击入口后切换为跨项目的 `Priority` 与 `Recent` 任务视图。LobsterAI 具有多 Agent 概念，因此本设计将 **Agent 视为 Codex 中的项目上下文**，在任务动态视图中跨 Agent 聚合任务，同时明确展示每条任务所属的 Agent。

Codex 桌面端的完整实现逻辑没有公开源码可直接复用，因此本设计只参考其可观察交互，并为 LobsterAI 明确定义可测试、可复现的状态与排序规则。

### 1.2 目标

1. 在首页侧边栏展开/收起按钮右侧增加任务筛选图标，视觉风格与现有图标一致。
2. 侧边栏收起后不展示筛选按钮，也不占用标题栏空间。
3. 存在「已完成未查看」任务时，在筛选按钮上展示蓝色小点。
4. 点击筛选按钮后，将普通 Agent 树切换为统一的任务动态视图。
5. 任务动态视图固定包含 `Priority` 和 `Recent` 两个区域。
6. 跨 Agent 聚合需要关注的任务，并在每条任务中保留 Agent 上下文。
7. 明确多 Agent 场景下的优先级、时间排序、公平覆盖和去重规则。
8. 用户打开已完成未查看任务后，只清除该任务的未读状态，并实时更新筛选按钮蓝点。

### 1.3 非目标

- 不新增复杂筛选条件、下拉菜单、搜索框或用户自定义排序。
- 不新增任务状态、数据库表或 OpenClaw 协议。
- 不把任务动态做成完整通知中心或历史收件箱。
- 不改变 Agent 树原有的展开、收起、置顶、重命名、删除和批量操作语义。
- 不把系统通知、Dock 角标、Windows 任务栏提醒与本入口合并为同一套持久化状态。
- 不追求逐像素复刻 Codex；图标与颜色应遵循 LobsterAI 现有设计系统。

## 2. 概念与状态定义

### 2.1 两种侧边栏模式

| 模式 | 内容 | 进入方式 |
| --- | --- | --- |
| Agent 树模式 | 按 Agent 展示任务会话，保留展开/收起和置顶结构 | 默认模式；再次点击已激活的筛选按钮 |
| 任务动态模式 | 跨 Agent 展示 `Priority` 与 `Recent` | 点击未激活的筛选按钮 |

筛选按钮是模式切换入口，不是一次性弹窗。切换模式不改变当前 Agent、当前会话或 Agent 树的展开偏好。

### 2.2 任务关注状态

任务动态视图复用现有 `AgentSidebarIndicator` 派生状态：

| 状态 | 含义 | 是否进入 Priority | 是否触发筛选按钮蓝点 |
| --- | --- | --- | --- |
| `pending_permission` | 等待用户授权，或 AskUserQuestion 等待用户输入 | 是 | 否 |
| `completed_unread` | 任务已完成，用户尚未打开结果 | 是 | 是 |
| `running` | 任务仍在执行 | 是 | 否 |
| `none` | 普通已读或历史任务 | 否 | 否 |

同一任务在任一时刻只能使用一个最高优先级状态。状态判断顺序为：

```text
等待授权/输入 > 完成未查看 > 运行中 > 普通任务
```

例如某个后台 Agent 的任务已经完成，但会话摘要仍短暂保留 `running`，只要该 session 已进入未读集合，就应显示为 `completed_unread`，不能继续被旧的运行状态覆盖。

### 2.3 「未查看」语义

`completed_unread` 表示任务完成后，用户还没有打开对应会话查看结果。它使用独立的 `completedUnreadSessionIds` 集合，不能直接复用同时包含后台消息提醒的通用 `unreadSessionIds`。它是 renderer 当前运行周期内的轻量 UI 状态：

- 非当前会话完成时加入未读集合；
- 用户打开该会话时从未读集合移除；
- 删除任务时从未读集合移除；
- Agent 维度的会话列表刷新不得误删其他 Agent 的未读状态；
- 第一阶段不新增数据库持久化，应用重启后的恢复行为沿用现有 Cowork 未读机制。

## 3. 用户场景

### 场景 1：默认状态查看入口

**Given** 用户位于首页 Cowork 视图，左侧侧边栏已展开  
**When** 页面完成加载  
**Then** 展开/收起按钮右侧展示筛选图标，默认不高亮

### 场景 2：收起侧边栏

**Given** 侧边栏处于展开状态  
**When** 用户点击收起按钮  
**Then** 筛选按钮不展示、不占位；任务动态模式状态不影响收起后的顶部操作布局

### 场景 3：后台 Agent 的任务完成

**Given** 用户正在查看 Agent A 的会话，Agent B 的任务正在运行  
**When** Agent B 的任务完成且用户尚未打开该会话  
**Then** Agent B 的任务进入 `completed_unread`，筛选按钮出现蓝色小点

### 场景 4：查看跨 Agent 的优先任务

**Given** 多个 Agent 分别存在等待授权、完成未查看和运行中的任务  
**When** 用户点击筛选按钮  
**Then** Agent 树切换为任务动态模式，`Priority` 按统一规则展示所有需要关注的任务，每条任务显示所属 Agent

### 场景 5：没有优先任务

**Given** 当前没有等待处理、完成未查看或运行中的任务  
**When** 用户打开任务动态模式  
**Then** `Priority` 展示空状态，`Recent` 仍展示最近的普通任务；两个区域始终存在

### 场景 6：多 Agent 最近任务公平覆盖

**Given** Agent A 在短时间内产生大量新任务，Agent B 也有近期任务  
**When** 用户查看 `Recent`  
**Then** 在展示数量允许时，Agent A 不应完全挤掉 Agent B；每条任务最终仍按全局更新时间倒序展示

### 场景 7：打开完成未查看任务

**Given** `Priority` 中存在 Agent B 的完成未查看任务  
**When** 用户点击该任务  
**Then** 应用切换到 Agent B 并打开对应会话，只清除该任务的未读状态；如果仍有其他完成未查看任务，筛选按钮蓝点继续展示

### 场景 8：退出任务动态模式

**Given** 筛选按钮处于激活状态  
**When** 用户再次点击筛选按钮  
**Then** 恢复原 Agent 树，之前各 Agent 的展开和「展开显示」状态保持不变

## 4. 功能需求

### FR-1：筛选入口与图标

- 筛选按钮位于首页侧边栏展开/收起按钮右侧。
- 只在 Cowork 首页且侧边栏展开时展示。
- macOS/Linux 使用侧边栏头部操作区；Windows 使用现有自定义标题栏操作区。
- 点击热区为 `32px × 32px`，图标视觉尺寸为 `16px × 16px`。
- 图标使用漏斗轮廓，不使用实心填充。
- 颜色使用 `currentColor`，线宽、端点和圆角风格与 `SidebarToggleIcon` 保持一致。
- 必须提供 `title`、`aria-label` 和 `aria-pressed`。
- 用户可见文案通过 renderer i18n 提供中英文版本。

### FR-2：按钮视觉状态

按钮包含三种可组合状态：

| 状态 | 视觉表现 |
| --- | --- |
| 默认 | 次级文字色，hover 使用现有标题栏浅色背景 |
| 激活 | 蓝色图标 + 淡蓝色圆角背景 |
| 有完成未读 | 右上角展示 `7px` 蓝色小点 |

蓝点与激活态相互独立：未打开任务动态模式时也可以显示蓝点；激活任务动态模式后，只要仍有完成未查看任务，蓝点继续存在。

### FR-3：蓝点聚合规则

- 蓝点只由所有已启用 Agent 中的 `completed_unread` 任务聚合。
- 等待授权/输入和运行中任务可以进入 `Priority`，但不触发按钮蓝点。
- 任意一个符合条件的任务存在时显示蓝点；全部已查看或删除后隐藏。
- 切换当前 Agent、按 Agent 刷新会话列表、展开/收起 Agent 都不能误清除其他 Agent 的未读状态。
- 用户打开某个任务时，只清除该 session 的未读状态，不做全局清空。

### FR-4：任务动态视图结构

任务动态模式替换侧边栏内的 Agent 树内容，结构固定为：

```text
Priority
  [需要关注的任务]
  或「没有需要关注的任务」

Recent
  Today / Yesterday / 本地化日期
    [最近任务]
  或「暂无最近任务」
```

要求：

- `Priority` 和 `Recent` 始终展示，不因其中一个区域为空而隐藏另一个区域。
- 任务动态模式不展示「我的 Agent」、Agent 置顶分区和 Agent 展开/收起行。
- 单条任务使用两行布局：第一行任务标题，第二行 Agent 名称与 Agent 图标。
- 标题和 Agent 名称均单行截断。
- 任务行保留选中态、状态图标和原有任务操作菜单。

### FR-5：Priority 收录与排序

`Priority` 收录所有需要用户关注或仍有活动的任务，并采用确定性排序：

1. 等待用户授权/输入；
2. 完成未查看；
3. 运行中；
4. 同一类别内按 `updatedAt || createdAt` 倒序；
5. 时间完全相同时，按 Agent 当前稳定顺序、再按 Agent 内任务稳定顺序打破平局。

产品理由：等待授权/输入会阻塞任务，应最先处理；完成未查看代表已有结果等待消费；运行中主要用于让用户了解当前活动，不应挤到阻塞任务之前。

Priority 第一阶段不设总条数上限。任务置顶状态只影响 Agent 树，不影响 Priority 排序。

### FR-6：Recent 收录、多 Agent 公平与排序

`Recent` 默认最多展示 5 条不属于 Priority 的任务。任务选择分为两步：

1. **Agent 覆盖**：从每个有候选任务的已启用 Agent 中选出最新一条，并按这些任务的更新时间倒序取至上限；
2. **补足名额**：若仍未满 5 条，再从其余候选任务中按全局更新时间倒序补足。

选中最终集合后，展示顺序统一按 `updatedAt || createdAt` 倒序。该规则带来以下结果：

- Agent 数量不超过 5 时，每个有普通近期任务的 Agent 至少出现一条；
- Agent 数量超过 5 时，展示「各 Agent 最新任务」中时间最新的 5 个 Agent；
- 单一 Agent 不会在存在其他 Agent 候选任务时占满 Recent；
- Priority 任务不在 Recent 重复出现；
- Agent 置顶和任务置顶不影响 Recent 排序。

Recent 按用户本地时区分组：当天显示 `Today/今天`，前一天显示 `Yesterday/昨天`，更早日期使用本地化月日；跨年时补充年份。

### FR-7：任务点击与上下文切换

点击任务动态中的任务后：

1. 根据任务的 `agentId` 判断所属 Agent；
2. 调用现有 Agent 切换流程；
3. 回到 Cowork 主工作区；
4. 加载对应 session；
5. 标记该 session 已查看；
6. 重新派生 Priority、Recent 与按钮蓝点。

任务动态模式保持激活，用户可以连续处理多个 Agent 的优先任务。再次点击筛选按钮才退出该模式。

### FR-8：实时状态更新

任务动态视图必须随现有 Redux 会话状态与流事件实时更新：

```text
普通任务 -> running -> pending_permission -> running -> completed_unread -> none
```

并非所有任务都会经过全部状态。需要满足：

- 新运行任务可进入 Priority；
- 收到权限请求或 AskUserQuestion 时提升到 Priority 顶部类别；
- 请求被处理后恢复为运行中或当前实际状态；
- 非当前会话完成时进入完成未查看；
- 当前正在查看的会话完成时不产生完成未读；
- 打开、删除任务或 Agent 被删除后及时清理对应视图项。

### FR-9：多 Agent 数据边界

- Activity 数据源覆盖所有已启用 Agent 的已加载任务，不依赖 Agent 在普通树中是否展开，也不受普通树默认只显示 6 条的裁剪影响。
- 默认 Agent 的空 ID/历史 ID 必须统一归一化为 `main`。
- 禁用或删除的 Agent 不进入新一轮 Activity 聚合。
- Agent 维度的异步任务加载结果需要按 `agentId` 合并，不能用一个 Agent 的返回结果覆盖其他 Agent。
- 同一 session 只能归属一个 Agent；若数据异常出现重复，以最新会话摘要和归一化后的 `agentId` 为准。
- 跨 Agent 未读集合是全局集合，局部会话列表刷新只允许更新当前返回的任务，不允许用局部 ID 集合裁剪全局未读集合。

### FR-10：空状态、加载失败与稳定性

| 场景 | 处理方式 |
| --- | --- |
| 没有已启用 Agent | Priority 与 Recent 分别显示空状态 |
| 有 Agent 但没有任务 | Priority 与 Recent 分别显示空状态 |
| 只有 Priority 任务 | Recent 显示空状态，不重复 Priority 任务 |
| 单个 Agent 加载失败 | 不阻断其他 Agent 展示；沿用现有日志和重试能力 |
| 任务时间戳缺失 | 使用 `createdAt`；两者均无效时按稳定输入顺序兜底 |
| 多条任务时间相同 | 使用 Agent 顺序和 Agent 内任务顺序稳定排序，避免列表抖动 |
| 侧边栏收起时仍有未读 | 按钮隐藏；重新展开后根据实时状态恢复蓝点 |
| 当前会话被删除 | 清除对应 Activity 项、选择态和未读态 |

### FR-11：可访问性与键盘行为

- 筛选按钮必须是原生 `button`，支持键盘聚焦、Enter 和 Space 激活。
- 激活状态通过 `aria-pressed` 暴露。
- 任务动态容器提供可读的 `aria-label`。
- 任务行继续使用现有树项/选择语义，不因两行布局丢失键盘和屏幕阅读器信息。
- 蓝点为装饰元素，使用 `aria-hidden`；按钮文案不依赖颜色表达功能。

### FR-12：埋点与 i18n

- 点击筛选按钮沿用 sidebar action 埋点，action 为 `task_filter_toggle`。
- 埋点至少包含目标激活状态、当前视图和侧边栏展开状态，不上报任务标题等内容。
- 新增文案必须同时提供中文和英文：

| key | zh | en |
| --- | --- | --- |
| `sidebarFilter` | 筛选任务 | Filter tasks |
| `sidebarActivity` | 任务动态 | Task activity |
| `sidebarActivityPriority` | 优先级 | Priority |
| `sidebarActivityNoPriority` | 没有需要关注的任务 | No tasks need your attention |
| `sidebarActivityRecent` | 最近 | Recent |
| `sidebarActivityNoRecent` | 暂无最近任务 | No recent tasks |
| `sidebarTaskOpenFailed` | 打开任务失败，请重试 | Failed to open the task. Please try again. |

日期分组复用已有 `today` 与 `yesterday` 文案。

## 5. 实现方案

### 5.1 状态所有权

`App.tsx` 维护当前窗口级状态：

```typescript
isTaskFilterActive: boolean;
hasUnreadCompletedTasks: boolean;
```

- `isTaskFilterActive` 控制 Agent 树模式与任务动态模式切换；
- `hasUnreadCompletedTasks` 由 Agent 侧边栏状态向上汇总，供 macOS/Linux 侧边栏头部和 Windows 自定义标题栏复用；
- 第一阶段不持久化筛选模式，应用重启后回到 Agent 树模式。

### 5.2 组件边界

```text
src/renderer/components/agentSidebar/
  SidebarTaskFilterButton.tsx      # 按钮、激活态与蓝点
  AgentSidebarActivityView.tsx     # Priority、Recent 与日期分组
  taskFilter.ts                    # 跨 Agent 聚合和纯排序逻辑
  taskFilter.test.ts               # 排序、去重和多 Agent 覆盖测试
  MyAgentSidebarTree.tsx           # 两种模式切换与任务点击编排
  AgentTaskRow.tsx                 # 复用任务行，增加 Agent 上下文布局
```

图标放入现有图标目录：

```text
src/renderer/components/icons/SidebarFilterIcon.tsx
```

`Sidebar.tsx` 和 `WindowsAppTitleBar.tsx` 只负责在正确平台与展开状态下放置入口，不承载排序业务逻辑。

### 5.3 数据流

```text
Agent 列表 + 各 Agent 会话摘要
  + completedUnreadSessionIds
  + pendingPermissionSessionIds
  + currentSessionId
          |
          v
useAgentSidebarState 派生共享任务节点
  + 普通树可见节点（按 6 条/展开数量裁剪）
  + Activity 已加载节点（不按普通树可见数量裁剪）
          |
          v
taskFilter 跨 Agent 扁平化、去重、Priority 排序、Recent 选取
          |
          +--> AgentSidebarActivityView
          |
          +--> hasUnreadCompletedTasks --> 筛选按钮蓝点
```

### 5.4 排序实现

建议将排序保持为纯函数，避免组件渲染顺序影响结果：

```typescript
const priorityRank = {
  pending_permission: 0,
  completed_unread: 1,
  running: 2,
} as const;

function buildActivityView(agentNodes): ActivityView {
  const items = flattenWithStableIndexes(agentNodes);
  const priority = items
    .filter(isPriority)
    .sort(byPriorityRankThenRecencyThenStableIndex);

  const recentCandidates = items
    .filter((item) => !isPriority(item))
    .sort(byRecencyThenStableIndex);
  const recent = selectRecentWithAgentCoverage(recentCandidates, 5)
    .sort(byRecencyThenStableIndex);

  return { priority, recent };
}
```

业务状态字符串继续使用 `AgentSidebarIndicator` 常量，不新增跨文件裸字符串。

### 5.5 已读清理与 Agent 局部刷新

现有会话列表可能按 Agent 分页或局部刷新。若全量与局部刷新共用相同 reducer，切换 Agent 时会误删其他 Agent 的未读状态，导致蓝点和 Priority 错误消失；若所有刷新都永久保留 ID，又会失去原有的无效状态清理边界。

本功能要求：

- `setSessions` 保持全量快照语义，清理不在快照中的通用未读和完成未读 ID；
- `setAgentSessions` 用于 Agent 局部快照，保留其他 Agent 的通用未读和完成未读 ID；
- 当前打开的 session 通过统一 `markSessionRead` 清理；
- 删除 session 时显式清理该 ID；
- session 重新进入运行态时清除旧的完成未读标记，但保留仍有意义的通用后台消息未读状态。

### 5.6 异常处理与关键日志

- 用户切换任务动态模式时记录一次 `TaskActivity` debug 日志，包含平台、目标模式和是否存在完成未读，不包含任务标题或消息内容。
- Agent 任务预览加载失败或 IPC Promise 被拒绝时记录 `AgentSidebar` warn/error 日志，并保留现有重试入口。
- 跨 Agent 打开任务失败时记录 sessionId、agentId 和错误摘要，同时显示本地化 toast。
- renderer 关键日志通过 `window.electron.log.fromRenderer` 尽力写入主日志；日志失败不得阻断交互。
- 不在渲染、排序、滚动和流式消息循环中新增高频日志。

### 5.7 无新增 IPC 与存储迁移

本功能完全复用现有 Agent、Cowork session、权限请求、未读集合和任务点击链路，不新增：

- preload API；
- renderer/main IPC channel；
- SQLite 表或迁移；
- OpenClaw config 或 gateway 协议。

## 6. 涉及文件

| 文件 | 变更 |
| --- | --- |
| `src/renderer/App.tsx` | 持有任务动态模式和全局蓝点摘要 |
| `src/renderer/components/Sidebar.tsx` | macOS/Linux 入口布局、状态透传 |
| `src/renderer/components/window/WindowsAppTitleBar.tsx` | Windows 展开态入口布局 |
| `src/renderer/components/icons/SidebarFilterIcon.tsx` | 新增统一风格漏斗图标 |
| `src/renderer/components/agentSidebar/SidebarTaskFilterButton.tsx` | 按钮视觉与可访问性 |
| `src/renderer/components/agentSidebar/AgentSidebarActivityView.tsx` | Priority/Recent 视图 |
| `src/renderer/components/agentSidebar/taskFilter.ts` | 跨 Agent 聚合与排序 |
| `src/renderer/components/agentSidebar/AgentTaskRow.tsx` | 展示 Agent 上下文的两行任务行 |
| `src/renderer/components/agentSidebar/MyAgentSidebarTree.tsx` | 两种模式切换和任务交互 |
| `src/renderer/components/agentSidebar/useAgentSidebarState.ts` | 状态优先级和多 Agent 数据派生 |
| `src/renderer/services/cowork.ts` | 区分全量与 Agent 局部会话刷新 |
| `src/renderer/store/selectors/coworkSelectors.ts` | 提供完成未查看 selector |
| `src/renderer/store/slices/coworkDeleteState.ts` | 删除任务时同步清理完成未读 |
| `src/renderer/store/slices/coworkSlice.ts` | 防止 Agent 局部刷新误清全局未读 |
| `src/renderer/services/i18n.ts` | 中英文文案 |
| 对应 `.test.ts` 文件 | 纯逻辑和 reducer 回归测试 |

## 7. 测试与验证计划

### 7.1 单元测试

`taskFilter.test.ts` 至少覆盖：

1. 等待授权/输入、完成未查看、运行中的跨 Agent Priority 排序；
2. 同类别内按更新时间倒序；
3. Priority 不在 Recent 重复出现；
4. Recent 最多 5 条；
5. Recent 优先覆盖不同 Agent，再补足剩余名额；
6. 超过 5 个 Agent 时按各 Agent 最新任务时间选取；
7. 空 Agent、空任务和 `recentLimit = 0`；
8. 相同时间戳下排序稳定。

`useAgentSidebarState.test.ts` 至少覆盖：

1. 等待授权/输入高于其他状态；
2. 完成未查看高于过期的 `running` 摘要；
3. 普通运行中任务显示 running；
4. 当前已读任务不显示蓝点。

`coworkSlice.test.ts` 至少覆盖：

1. Agent A 的会话列表刷新不会清除 Agent B 的未读 ID；
2. 打开 session 只清除对应未读 ID；
3. 删除 session 清理对应未读 ID；
4. 通用后台消息未读不会被误判为完成未读；
5. 全量刷新清理无效 ID，Agent 局部刷新保留其他 Agent 状态；
6. 已完成任务重新运行时退出完成未读状态。

### 7.2 手工验证

- macOS：筛选按钮位置、图标线条、拖拽区与点击区不冲突。
- Windows：自定义标题栏展开时展示，收起时隐藏，不影响新建任务和更新按钮布局。
- 浅色/深色主题：默认、hover、激活和蓝点对比度正确。
- 多 Agent：至少准备 3 个 Agent，分别制造等待输入、完成未查看、运行中和普通历史任务，验证排序与 Agent 标签。
- 会话点击：从 Activity 跨 Agent 打开任务，确认 Agent 切换、会话加载、未读清理和蓝点聚合。
- 侧边栏收起/展开：按钮正确隐藏和恢复，Agent 树展开偏好不丢失。
- 中英文：标题、空状态、日期分组不出现硬编码或截断异常。

### 7.3 质量门禁

```bash
npm test
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <changed-files>
npm run build
git diff --check
```

## 8. 验收标准

- [ ] 首页侧边栏展开时，展开/收起按钮右侧展示统一风格的筛选图标。
- [ ] 侧边栏收起后，筛选按钮完全隐藏且不占位。
- [ ] 任一已启用 Agent 存在完成未查看任务时，按钮展示蓝色小点。
- [ ] 等待授权/输入和运行中任务不单独触发按钮蓝点。
- [ ] 点击按钮后进入包含 Priority 和 Recent 的任务动态模式；再次点击恢复 Agent 树。
- [ ] Priority 按「等待授权/输入 → 完成未查看 → 运行中 → 同类按时间倒序」排列。
- [ ] Recent 不重复 Priority，最多 5 条，并在数量允许时覆盖不同 Agent。
- [ ] 每条 Activity 任务明确展示所属 Agent。
- [ ] 跨 Agent 点击任务能够切换 Agent 并加载正确 session。
- [ ] 打开完成未查看任务后，只清除该任务未读；其他未读仍使按钮保持蓝点。
- [ ] Agent 局部会话刷新不会误清其他 Agent 的未读状态。
- [ ] Agent 树原有展开、置顶、重命名、删除与批量操作不受影响。
- [ ] 中英文、浅色/深色、macOS/Windows 布局均通过验证。
- [ ] 相关单测、变更文件 ESLint、renderer build 和 diff 检查通过。

## 9. 后续增强

以下能力不纳入本期，可在真实使用数据验证后单独设计：

- 按状态、Agent 或时间范围自定义筛选；
- Priority 数量过多时的折叠和分页；
- Activity 模式与未读集合跨应用重启持久化；
- 为等待授权、等待输入和运行中增加不同的二级分组；
- Activity 独立搜索与键盘快捷键；
- 基于全量 session 索引而非侧边栏预览数据构建 Activity。
