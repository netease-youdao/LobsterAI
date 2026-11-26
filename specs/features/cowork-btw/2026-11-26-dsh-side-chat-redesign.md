# DSH 侧边聊天（Side Chat）架构与右侧栏多 Tab 改造设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI 此前基于 OpenClaw 的一次性 `/btw` 能力实现了浮动侧边聊天小窗（`CoworkBtwFloatingPanel`）。迁移到 DeepSeek Harness（DSH）后，现有适配器实现存在明显局限：

1. **每次提问都重新 `session/fork` 后立即删除**：无法原生多轮延续上下文，只能由前端拼装 16K 文本模拟历史，既浪费上下文又无法稳定命中 KV Cache；
2. **首轮运行中不可用**：未传 `atSeq` 时 DSH `session/fork` 截断到最后一个 `turn/end`，主会话第一轮未结束时会直接报 `session/fork-unavailable`；
3. **缺少软只读语义与工具隔离**：fork 出来的 DSH session 未绑定主会话上下文/模型，也没有禁止 subagent 与定时任务，也未处理侧聊触发的审批；
4. **缺少流式展示与持久化**：只返回最终文本，不展示思考与工具调用步骤，刷新即丢失，也没有转正为正式对话或回流主对话的能力；
5. **交互形态落后于当前桌面端范式**：Codex App 与 Antigravity App 均已收敛为右侧面板多 Tab、原生多轮、软只读工具、可重开、可转正与可插回主对话的形态。

### 1.2 目标

- 基于 DSH `session/fork` 实现**原生多轮、一次分叉、KV Cache 友好**的侧边聊天执行层；
- 在 DSH Host Bundle 层注入缓存安全的**软只读运行时指令**，并硬拦截子智能体与定时任务工具；
- 侧边聊天元数据与完整消息流（含思考与工具调用）**随主会话持久化到 SQLite**，刷新/重启可重开，关 Tab 不删，主会话删除时级联清理；
- 完整流式输出（文本增量、思考增量、可折叠工具步骤）与 **Tab 内独立审批/提问**，绝不干扰或阻塞主任务；
- 将 UI 从旧版 `CoworkBtwFloatingPanel` 浮动小窗**完整替换为右侧栏多 Tab**（`ArtifactSpecialTab.SideChat`），打通 `/btw`、`/side`、主对话划词「在侧边聊天中提问」、右侧栏 `+` 新标签页（含新建与最近侧聊列表）全入口；
- 支持 **「转正为正式对话」（Promote）** 与 **「将回答插入主对话」（Insert）** 两个回流出口；
- 遵循仓库大文件拆分规范，将核心逻辑拆入独立模块，最小化对大文件的侵入。

## 2. 用户场景

### 场景 1: 主任务运行中通过 `/btw` 或 `/side` 发起侧边提问
**Given** 主会话已启动（即使第一轮仍在执行中）  
**When** 用户在主输入框输入 `/btw 这段重试逻辑最大重试几次？`  
**Then** 右侧面板打开一个新的 Side Chat Tab，自动从主会话分叉上下文并流式返回答案与只读工具步骤，主任务与主历史不受任何影响。

### 场景 2: 划词引用并多轮追问
**Given** 用户在主对话选中一段助手回复并点击「在侧边聊天中提问」  
**When** 右侧面板打开/切换到 Side Chat Tab 并在底部输入框带上可展开、可定位原句的引用胶囊，用户输入问题并继续追问第二轮  
**Then** 第二轮直接在同一 forked DSH session 上继续（原生多轮 + KV Cache 复用），点击引用胶囊可滚动高亮主对话原消息。

### 场景 3: 右侧栏 `+` 新标签页多开与重开历史侧聊
**Given** 主会话已有或尚无历史侧边聊天  
**When** 用户点击右侧栏 `+` 打开新标签页，点击「侧边聊天」新建，或点击「最近侧边聊天」中的某一条  
**Then** 右侧面板多开对应侧边聊天 Tab；关闭 Tab 不删除记录，应用重启后仍可从新标签页重新打开。

### 场景 4: 侧聊内审批、停止、转正与插回主对话
**Given** 侧边聊天正在执行需要确认的操作，或已完成回答  
**When** 用户在侧聊 Tab 内点击允许/拒绝，或点击停止，或点击「转正为正式对话」/「插入主对话」  
**Then** 审批仅作用于当前侧聊；停止会真正取消侧聊的 DSH turn；转正后创建独立正式 Cowork 会话并跳转；插入主对话会将回答填入主输入框草稿供编辑。

## 3. 功能需求

### FR-1: DSH Host Bundle 软只读与工具保护
- `bindSessionContext` 支持 `sideChat?: boolean`。
- `persona-scope.mjs` 通过 `ctx.systemPrompt.context`（`required: true`, `interpolate: false`）为侧聊会话追加软只读运行时指令，不改写系统提示词头部以保护 KV Cache。
- `tool-disclosure.mjs` 在 `ctx.tools.guard` 中对侧聊会话硬拦截 `subagent`、`delegate_agent`、`lobster_schedule`、`send_message`、`interrupt_agent`、`wait_agent`、`list_agents`、`list_subagent_models`，不改动工具 schema 列表。

### FR-2: SQLite 持久化与生命周期
- 新增独立 `CoworkSideChatStore` 管理两张表：
  - `cowork_side_chats`（`id`, `parent_session_id`, `dsh_session_id`, `title`, `status`, `forked_from_message_id`, `forked_at_seq`, `created_at`, `updated_at`, `last_error`）
  - `cowork_side_chat_messages`（`id`, `side_chat_id`, `type`, `content`, `metadata`, `created_at`）
- 关 Tab 不删数据；删除侧边聊天同时删除 SQLite 记录并清理 DSH session 目录；删除主会话时级联取消运行中侧聊并清理全部关联记录与 DSH session 文件。

### FR-3: 一次 Fork 原生多轮与首轮兜底
- 创建/首问时执行一次 DSH `session/fork`：
  - 默认优先无 `atSeq` fork（命中最新已完成轮次）；
  - 若报 `session/fork-unavailable`（例如首轮尚在运行），查询主会话最新事件 `seq` 传入 `atSeq`（利用 DSH `buildForkSeed` 的 `openTurnClosers`）；
  - 若主会话尚无任何可 fork 事件，则新建独立 DSH session 并在首次消息附带当前主会话快照摘要。
- 同步主会话的 `agentId`、`cwd`、`modelOverride`、`thinkingLevel`、`permissionPreset`、`executionMode`、`allowedSkillIds`。
- 后续轮次直接复用同一个 `dsh_session_id` 调用 `promptSession` + `followSession`。

### FR-4: 流式输出、独立审批与取消
- 通过 `CoworkSideChatIpcChannel` 推送流式增量（`message`、`messageUpdate`、`status`、`permissionRequest`、`permissionResolved`、`changed`）。
- `dshRuntimeAdapter.handleHostWaterfall` 优先识别侧聊 DSH session 归属，将审批/提问路由至侧聊而非主会话。
- 停止侧聊会同时中止本地 stream 并调用 `client.cancelSession(dshSessionId)`。

### FR-5: 转正为正式对话与插入主对话
- **转正（Promote）**：仅在侧聊空闲且有消息时可用。使用 `coworkStore.forkSession`（复制主会话上下文）并追加侧聊消息，绑定新的/当前 DSH session（若继续保留原侧聊不冲突，优先 fork 一份 DSH session 或转移并解除侧聊绑定，移除 `sideChat: true` 上下文标记），关闭该侧聊 Tab 并切换到新正式会话。
- **插入主对话（Insert）**：在侧聊助手回答操作栏提供「插入主对话」，将回答内容追加到主会话输入框草稿（不自动发送）并聚焦主输入框。

### FR-6: 右侧栏多 Tab UI 与移除旧浮窗
- `ArtifactSpecialTab` 增加 `SideChat: 'sideChat'`；`ArtifactPanel` 支持多开 `sideChatTabs`。
- `ArtifactNewTabContent` 增加「侧边聊天」入口卡片和当前主会话的「最近侧边聊天」列表。
- 新建 `SideChatPanelContent`，复用 `ConversationTurnsView`、`SelectedTextSnippetBadge`、`PermissionRequestInline` 样式模式。
- 移除 `CoworkBtwFloatingPanel.tsx`、`coworkBtwPanelGeometry.ts` 及其测试，清理旧浮窗渲染与 Redux 状态。

## 4. 实现方案

### 4.1 模块划分与大文件边界

| 模块 | 职责 |
|---|---|
| `dsh-bundles/lobsterai-host/plugins/ops-rpc-helpers.mjs` / `persona-helpers.mjs` / `persona-scope.mjs` / `tool-disclosure-helpers.mjs` / `tool-disclosure.mjs` | 侧聊会话上下文标记、缓存安全软只读指令、子智能体/定时任务执行拦截 |
| `src/shared/cowork/sideChat.ts` & `src/shared/cowork/constants.ts` | 侧聊状态枚举、IPC 通道常量、数据结构与纯辅助函数 |
| `src/main/coworkSideChatStore.ts` | 独立 SQLite 表初始化、CRUD、级联删除 |
| `src/main/libs/dsh/dshSideChatManager.ts` | 侧聊 DSH fork、流式翻译、取消、审批归属解析、转正与清理 |
| `src/main/ipcHandlers/coworkSideChat/` | 独立 IPC handlers 与单测 |
| `src/renderer/store/slices/sideChatSlice.ts` | 侧聊列表、消息、流式更新、打开 Tab、草稿、引用胶囊与待审批状态 |
| `src/renderer/services/coworkSideChat.ts` | 侧聊 preload 封装与流式事件监听分发 |
| `src/renderer/components/cowork/useCoworkSideChats.ts` | 在 `CoworkSessionDetail` 中编排侧聊 Tab、划词、`/btw`、转正与插入主对话 |
| `src/renderer/components/artifacts/SideChatPanelContent.tsx` | 右侧栏侧边聊天主体 UI |

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 主会话首轮运行中发起 `/btw` | 自动获取最新事件 `seq` 传 `atSeq` fork；若无事件则新建独立 DSH session 并注入当前主会话文本快照 |
| 侧聊执行中用户点击停止 | 中止本地 `followSession` 并调 `client.cancelSession(dshSessionId)`，状态恢复 `idle` 并保留已输出内容 |
| 侧聊执行中用户关闭 Tab | 仅隐藏 Tab，不停止后台执行、不删除记录，状态点与未读提示仍更新，可随时从 `+` 页重开 |
| 删除主会话 | 取消所有运行中侧聊，删除全部关联 SQLite 记录并清理对应 DSH session 目录 |
| 侧聊触发审批时主任务也在跑 | 审批按 `sideChatId` 隔离路由，只在对应侧聊 Tab 内展示审批卡片，不阻塞主任务 |
| 转正为正式对话时侧聊仍在运行 | 按钮禁用，提示等待当前回答完成后再转正 |
| 应用重启后在历史侧聊继续追问 | 从 SQLite 恢复侧聊与 `dshSessionId`，继续向同一 DSH session 发送 `promptSession`（若底层 DSH 文件缺失则优雅重建） |

## 6. 涉及文件

- `dsh-bundles/lobsterai-host/plugins/ops-rpc-helpers.mjs`
- `dsh-bundles/lobsterai-host/plugins/persona-helpers.mjs`
- `dsh-bundles/lobsterai-host/plugins/persona-scope.mjs`
- `dsh-bundles/lobsterai-host/plugins/tool-disclosure-helpers.mjs`
- `dsh-bundles/lobsterai-host/plugins/tool-disclosure.mjs`
- `src/shared/cowork/sideChat.ts`, `src/shared/cowork/btw.ts`, `src/shared/cowork/constants.ts`
- `src/main/coworkSideChatStore.ts`, `src/main/coworkSideChatStore.test.ts`
- `src/main/libs/dsh/dshHostManager.ts`
- `src/main/libs/dsh/dshSideChatManager.ts`, `src/main/libs/dsh/dshSideChatManager.test.ts`
- `src/main/libs/agentEngine/dshRuntimeAdapter.ts`, `src/main/libs/agentEngine/coworkEngineRouter.ts`, `src/main/libs/agentEngine/types.ts`
- `src/main/ipcHandlers/coworkSideChat/handlers.ts`, `index.ts`, `handlers.test.ts`
- `src/main/main.ts`, `src/main/preload.ts`, `src/main/i18n.ts`
- `src/renderer/types/electron.d.ts`, `src/renderer/services/i18n.ts`
- `src/renderer/store/index.ts`, `src/renderer/store/slices/artifactSlice.ts`, `src/renderer/store/slices/coworkSlice.ts`, `src/renderer/store/slices/sideChatSlice.ts`
- `src/renderer/services/coworkSideChat.ts`, `src/renderer/services/cowork.ts`
- `src/renderer/components/cowork/useCoworkSideChats.ts`, `CoworkSessionDetail.tsx`, `CoworkPromptInput.tsx`
- `src/renderer/components/artifacts/ArtifactPanel.tsx`, `ArtifactNewTabContent.tsx`, `SideChatPanelContent.tsx`
- 删除：`CoworkBtwFloatingPanel.tsx`, `coworkBtwPanelGeometry.ts`, `coworkBtwPanelGeometry.test.ts`

## 7. 验收标准

- `/btw`、`/side`、主对话划词「在侧边聊天中提问」、右侧栏 `+` 页新建与历史列表均可打开右侧栏 Side Chat Tab。
- 侧边聊天首轮与后续多轮复用同一个 forked DSH session，具备流式文本、思考过程、可折叠工具步骤与 Tab 内审批。
- 侧边聊天不会向主对话写入任何消息，不会中断或修改主对话运行态，且无法调用 subagent/delegate/schedule 工具。
- 刷新或重启应用后，侧边聊天仍可在主会话右侧 `+` 页列表中看到并重开继续对话；删除主会话后无孤儿数据与残留 DSH session。
- 支持「插入主对话」和「转正为正式对话」。
- 旧版浮动小窗组件已移除，相关单测、TypeScript 编译、ESLint 与 `npm run dsh:upgrade-check` 全部通过。
