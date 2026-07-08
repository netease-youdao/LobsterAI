# 子智能体右侧面板设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI 已经通过 OpenClaw 子会话能力记录 subagent run，并在主会话中展示子智能体工具调用结果。此前 UI 同时存在两类入口：

- sidebar 中把 subagent session 展示为主会话下的子行；
- 会话内容中展示可点击的 subagent chip，并跳转到独立的 subagent 会话详情页。

这种方式存在几个问题：

- sidebar 层级变深，容易和主 Agent 会话列表混在一起；
- 点击 subagent 后切换到整页详情，和 Codex 当前将子任务放在右侧上下文区域查看的模式不一致；
- 从 subagent 详情回到主会话时，sidebar 和主会话状态容易出现空白或不同步；
- artifact 区域已经承担文件、浏览器、预览等辅助上下文展示，适合作为 subagent 会话详情的承载面。

### 1.2 目标

- 在 artifact 右侧区域增加“子智能体”tab，作为 subagent 列表和详情的统一入口。
- 会话正文里的 subagent chip 点击后，在右侧面板内打开详情，而不是替换主会话页面。
- sidebar 不再展示 subagent session 子行，保持主会话列表简洁。
- 不影响现有 artifact、文件列表、浏览器 tab 的打开、关闭、切换和预览逻辑。
- 历史 subagent run 继续通过现有 OpenClaw/LobsterAI 本地数据读取，无需迁移。

## 2. 用户场景

### 场景 1: 从右上角打开子智能体面板

**Given** 当前主会话存在或可能存在 subagent run  
**When** 用户点击 artifact 区域右上角的加号菜单，并选择“子智能体”  
**Then** 右侧 artifact 面板打开“子智能体”tab，展示当前会话的 subagent 列表。

### 场景 2: 从会话正文跳转子智能体详情

**Given** 主会话中的某个 Subagent 工具调用关联了 subagent run
**When** 用户点击该工具调用下方的 subagent chip
**Then** 主会话保持在左侧，右侧 artifact 面板切换到“子智能体”tab，并展示该 subagent 的历史消息。

### 场景 3: 查看完成或运行中的子智能体

**Given** subagent run 状态为 running、done 或 error  
**When** 用户打开子智能体列表或详情  
**Then** UI 展示对应状态；running 状态下继续轮询列表和详情历史，完成后停止不必要轮询。

### 场景 4: 使用 sidebar 切换主会话

**Given** 用户正在查看主会话或右侧 subagent 详情  
**When** 用户从 sidebar 切换到另一个主会话  
**Then** sidebar 只展示主会话；右侧子智能体选择态按会话重置，不出现空白整页 subagent 详情。

## 3. 功能需求

### FR-1: artifact 右侧区域新增子智能体 tab

- `ArtifactSpecialTab` 增加 `Subagents`。
- artifact panel 接收 `subagentPanel` 节点，并在 active special tab 为 `Subagents` 时渲染。
- 现有 File List、Browser、Artifact Preview 的优先级和 fallback 行为保持不变。

### FR-2: 子智能体入口

- artifact tab add menu 增加“子智能体”选项。
- 子智能体 tab 使用轻量机器人线性图标，和现有打开文件、浏览器图标保持一致。
- 打开入口时拉取当前主会话的 subagent runs。

### FR-3: 子智能体列表

- 列表按 running、done、error 分组。
- 每一项展示名称、任务摘要、状态点、运行中或耗时信息。
- 点击列表项进入右侧详情态。

### FR-4: 子智能体详情

- 详情在同一个右侧 panel 内展示，不替换 `CoworkView` 主内容。
- 通过现有 `getSubTaskHistory` 读取子会话消息。
- 无历史消息但存在 task 时，合成只读 user message，避免空态误导。
- running 状态下轮询历史和状态。

### FR-5: 会话正文跳转

- 主会话根据 Subagent 工具调用的 tool call id 关联 subagent run。
- 每个 subagent chip 跟随创建它的 Subagent 工具调用展示，不在 assistant turn 末尾集中展示。
- chip 在工具调用块内轻量展示，避免影响 assistant 正文和 artifact 卡片布局。
- 点击 chip 打开右侧“子智能体”tab 并进入对应详情。

### FR-6: sidebar 不再展示 subagent 子行

- `MyAgentSidebarTree` 不再使用 `useSubagentSessions` 拉取 subagent 列表。
- `AgentTreeNode` 不再渲染 `SubagentTaskRow`。
- sidebar 批量选择仅包含主会话 session，不包含 subagent run。

## 4. 实现方案

### 4.1 数据来源

继续复用 LobsterAI 已有 Cowork IPC：

- `listSubagentSessions(parentSessionId)`：读取父会话下的 subagent runs；
- `getSubTaskHistory({ parentSessionId, agentId, sessionKey })`：读取某个 subagent 的历史消息；
- `deleteSubagentSession(parentSessionId, runId)`：保留服务能力，但本轮 UI 不再从 sidebar 暴露删除入口。

OpenClaw 侧仍是运行时和子会话数据来源；LobsterAI 侧维护的 `subagent_runs`、`subagent_messages` 继续作为 UI 查询和历史兼容层。

### 4.2 Redux 和 panel 状态

- `artifactSlice` 增加 `activateArtifactSubagentTab`。
- `CoworkSessionDetail` 维护：
  - 当前会话 subagent 列表；
  - subagent 列表 loading 状态；
  - 当前右侧 panel 选中的 subagent；
  - 当前会话是否打开了 subagent special tab。
- 关闭 subagent tab 时清空选中 subagent，并按现有 artifact tab fallback 规则切回 artifact、browser、file list 或关闭 panel。

### 4.3 UI 组件

- `SubagentPanelContent`：
  - 列表态：展示 grouped subagent runs；
  - 详情态：展示选中 subagent 的只读对话历史；
  - 详情顶部提供返回列表按钮。
- `SubagentTurnLinks`：
  - 渲染主会话 turn 下的 chip；
  - 使用 `COWORK_DETAIL_GUTTER_CLASS` 和 `COWORK_DETAIL_CONTENT_CLASS` 与正文对齐。
- `SubagentIcon`：
  - 使用 `currentColor` 的简化机器人线性 SVG；
  - 不引入第三方图标依赖。

### 4.4 sidebar 调整

- 移除 sidebar 对 subagent runs 的渲染依赖。
- 主会话切换仍会发送清空 subagent 选择事件，作为兼容遗留监听的低成本保护。
- 保留 subagent 数据模型和服务层，不做数据迁移。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 当前会话没有 subagent run | 右侧面板展示空态“当前会话暂无子智能体” |
| subagent 仍在运行 | 列表和详情按 5 秒间隔轮询 |
| subagent 历史消息为空但 task 存在 | 合成只读用户消息展示初始任务 |
| 用户关闭当前 active 子智能体 tab | 优先切到已有 artifact tab，其次 browser、file list，最后关闭 panel |
| 用户从 sidebar 切换主会话 | 清空当前会话 subagent 列表、loading 和选中态 |
| 历史数据缺少 messages | 列表仍能展示 run summary，详情以 task 合成消息兜底 |

## 6. 涉及文件

- `src/renderer/store/slices/artifactSlice.ts`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/components/artifacts/ArtifactPanel.tsx`
- `src/renderer/components/artifacts/SubagentPanelContent.tsx`
- `src/renderer/components/cowork/SubagentTurnLinks.tsx`
- `src/renderer/components/cowork/AssistantTurnBlock.tsx`
- `src/renderer/components/cowork/ToolCallGroup.tsx`
- `src/renderer/components/icons/SubagentIcon.tsx`
- `src/renderer/components/cowork/CoworkView.tsx`
- `src/renderer/components/agentSidebar/AgentTreeNode.tsx`
- `src/renderer/components/agentSidebar/MyAgentSidebarTree.tsx`
- `src/renderer/components/Sidebar.tsx`
- `src/renderer/services/i18n.ts`

## 7. 验收标准

- artifact 加号菜单中可以看到“子智能体”入口。
- 点击入口后，右侧 panel 出现“子智能体”tab 和列表/空态。
- 点击 Subagent 工具调用下方的 subagent chip，不离开主会话页面，右侧 panel 展示该 subagent 详情。
- 关闭或切换“子智能体”tab 不影响已有 artifact 文件预览、文件列表和浏览器 tab。
- sidebar 不再展示主会话下的 subagent 子行。
- 从 subagent 详情返回或切换主会话后，sidebar 和主会话内容不出现空白。
- 变更文件通过 ESLint，生产构建通过。
