# 功能规格说明：Airi × LobsterAI 会话化 Agent Bridge 重构

**Feature ID**: 002-airi-lobster-session-bridge  
**创建时间**: 2026-03-27  
**状态**: Draft

## 问题陈述

当前 Airi 与 LobsterAI 已经实现了基础可用的直连能力，但整合方式仍然是“把 LobsterAI 当作 OpenAI 文本兼容接口来调用”。这种方式只能覆盖最简单的文本问答，无法稳定承载 Agent 运行时的完整能力，因此出现了以下系统性问题：

1. **流式回复失真**：Airi 只消费 `delta.content`，没有对齐 LobsterAI 的会话事件、工具事件、状态事件和最终消息对账机制，导致回复内容不完整、消失或与实际会话状态脱节。
2. **动作驱动丢失**：Airi 的 Live2D 动作、等待态、说话口型依赖标准聊天生命周期 hook；当前 `lobster-agent` 走 UI 内特判分支，绕开统一 orchestrator，导致等待回复期间动作缺失、回复过程口型与情绪不同步。
3. **思考与工具过程不可见**：LobsterAI 的思考态、工具调用、权限请求、完成状态并未被结构化同步到 Airi，用户只能看到结果文本，看不到 Agent 的过程状态。
4. **文件链路不稳定**：当前文件上传后通过绝对路径拼接到 prompt，缺少 fileId、session 归属、生命周期、回收和最终对账，容易造成跨轮次混乱和安全边界不清。
5. **技能链路仅完成浅接入**：Airi 目前只支持列出与勾选技能，尚未完整承接 LobsterAI 的技能配置、启停、详情查看、安装与风险确认流程。

因此，本功能的目标不是继续堆叠 UI 特判，而是建立一条 **会话化、事件化、可回放、可扩展** 的 Agent Bridge，使 Airi 成为 LobsterAI 的稳定交互壳。

## 目标

- 让 Airi 与 LobsterAI 共享稳定的 session/turn 语义，而不是“一次请求一个临时聊天”。
- 让 Airi 通过结构化事件驱动流式文本、动作、技能、工具、权限和文件能力。
- 让 Airi 侧重新回到统一聊天主链，避免 `lobster-agent` 在 UI 层继续分叉。
- 在不破坏现有 `v1/chat/completions` 兼容接口的前提下，新增更稳定的 Bridge 协议。

## 用户场景与测试

### 场景 1：用户在 Airi 中发起文本对话

**假设** 用户已在 Airi 中选择 Lobster Agent 作为服务来源  
**当** 用户发送一条纯文本消息  
**那么** Airi 应立即显示等待态动作  
**并且** 在 LobsterAI 返回流式事件时逐步显示回复内容  
**并且** 回复完成后显示与 LobsterAI 最终消息一致的结果

### 场景 2：用户在 Airi 中上传图片并提问

**假设** 用户已在同一会话中上传图片  
**当** 用户发送“你看到了什么”  
**那么** 图片引用应通过会话化附件机制发送到 LobsterAI  
**并且** Airi 应以流式方式显示识图结果  
**并且** 不出现内容消失、structured clone 异常或路径泄露

### 场景 3：用户在 Airi 中上传文档并启用技能

**假设** 用户勾选若干技能并上传文档  
**当** 用户发送需要读取文件并调用技能的请求  
**那么** LobsterAI 应在同一会话内收到 `skillIds` 与 `fileIds`  
**并且** Airi 能看到思考态、工具态、完成态  
**并且** 如出现权限请求，Airi 侧可接收并回复

### 场景 4：用户进行多轮对话

**假设** 用户已经完成至少一轮对话  
**当** 用户继续追问上一轮内容  
**那么** LobsterAI 应复用同一个 runtime session  
**并且** 不需要依赖 UI 重新拼接全部历史  
**并且** Airi 与 LobsterAI 的最终消息历史保持一致

## 功能需求

### FR-1：建立会话化 Bridge 协议

- **FR-1.1**：系统必须为每个 Airi 会话绑定一个 Lobster runtime session，而不是每轮请求新建临时 session。
- **FR-1.2**：Bridge 层必须维护 `airiSessionId -> lobsterSessionId` 的映射关系。
- **FR-1.3**：Bridge 事件必须包含 `sessionId`、`turnId`、`seq`、`createdAt` 等基础元信息。
- **FR-1.4**：系统必须支持首轮 `startSession` 与后续 `continueSession` 两种调用路径。

### FR-2：统一事件流

- **FR-2.1**：LobsterAI 必须向 Airi 输出结构化事件流，而不只是文本 delta。
- **FR-2.2**：事件流至少包含：
  - `session.bound`
  - `assistant.delta`
  - `assistant.final`
  - `tool.call`
  - `tool.result`
  - `permission.request`
  - `state.changed`
  - `done`
  - `error`
- **FR-2.3**：Airi 必须以 `assistant.delta` 作为流式预览来源。
- **FR-2.4**：Airi 必须以 `assistant.final` 或最终历史快照作为持久化与最终展示依据。

### FR-3：恢复 Airi 标准聊天主链

- **FR-3.1**：`lobster-agent` 不得继续在 `ChatArea.vue` 中维持独立的发送、流式与消息落盘逻辑。
- **FR-3.2**：Lobster Bridge 必须重新接入 airi 的统一聊天 orchestrator，使标准 hook 能被触发。
- **FR-3.3**：Airi 的 context bridge、语音、动作、日志与会话持久化必须继续沿用统一生命周期。

### FR-4：动作与等待态同步

- **FR-4.1**：Airi 必须在 `state.changed=think` 或发送后无首 token 的等待阶段触发等待态动作。
- **FR-4.2**：Airi 必须在收到 `assistant.delta` 的首个文本增量时触发说话态和口型。
- **FR-4.3**：Airi 必须在 `tool.call` 与 `tool.result` 阶段切换工具执行相关动作或状态。
- **FR-4.4**：Airi 必须在 `done` 或 `assistant.final` 后恢复完成态或 idle。
- **FR-4.5**：动作主驱动应优先来自结构化状态事件，ACT token 仅作为兼容回退。

### FR-5：思考与过程可视化

- **FR-5.1**：LobsterAI 的思考态应可被结构化同步到 Airi，而不是依赖模型把思考写进最终回复。
- **FR-5.2**：Airi 必须能显示当前在思考、调用工具、等待权限、回复完成等状态。
- **FR-5.3**：过程展示与最终回复必须分层，避免过程流污染最终文本消息。

### FR-6：技能完整接入

- **FR-6.1**：Airi 必须支持拉取 Lobster 技能列表与启用状态。
- **FR-6.2**：Airi 必须支持切换技能启停。
- **FR-6.3**：Airi 必须支持查看技能详情与配置项。
- **FR-6.4**：Airi 必须支持将选中的 `skillIds` 与当前 turn 绑定发送。
- **FR-6.5**：技能路由与 prompt 编排主权仍由 LobsterAI 持有。

### FR-7：文件与图片完整接入

- **FR-7.1**：Airi 上传附件后，LobsterAI 必须返回 `fileId`，而不是暴露物理路径给 Airi。
- **FR-7.2**：图片附件必须以视觉输入方式进入同一会话。
- **FR-7.3**：普通文件必须以 `fileId` 形式绑定到当前 turn。
- **FR-7.4**：LobsterAI 必须负责 `fileId -> 物理文件` 的内部映射、生命周期和回收。
- **FR-7.5**：Airi 不得再通过 prompt 拼接绝对路径来引用文件。

### FR-8：权限请求闭环

- **FR-8.1**：当 LobsterAI 运行时需要权限确认时，必须能通过 Bridge 发送 `permission.request`。
- **FR-8.2**：Airi 必须能提交 `allow/deny` 等结构化结果回到 LobsterAI。
- **FR-8.3**：同一权限请求只能被所属会话处理一次。

### FR-9：保留兼容退路

- **FR-9.1**：现有 `/v1/chat/completions` 兼容接口仍需保留，作为纯文本降级通道。
- **FR-9.2**：当 Bridge 不可用时，系统可以退回兼容模式，但必须明确关闭过程态、技能深接入和文件会话化能力。

## 非功能需求

### NFR-1：流式体验

- 首个结构化状态事件应在用户发送后尽快到达，优先用于等待态反馈。
- 文本 delta 必须逐步渲染，不允许整段完成后一次性显示。

### NFR-2：一致性

- 同一 turn 的最终文本、工具结果、状态收尾和会话历史必须可对账。
- Airi 页面刷新后，应能通过 session 绑定恢复当前 Lobster 会话状态。

### NFR-3：可维护性

- UI 层不得直接拼接 Agent 协议细节。
- 协议适配逻辑应集中在 Bridge Client/Server 层。

### NFR-4：安全性

- `fileId` 必须是不透明句柄，不能泄露绝对路径。
- 会话事件不得广播给无关窗口。
- 权限请求必须带会话归属与一次性能力标识。

## 设计原则

### 原则 1：协议优先，不再 UI 特判

不再让 `ChatArea.vue` 直接读取 SSE、直接落盘消息、直接拼接 prompt 或直接控制工具状态。所有 Lobster 事件必须先经过 Bridge 协议，再进入 airi 标准主链。

### 原则 2：会话优先，不再“一次请求一会话”

Bridge 以 session 为中心维护上下文、技能、文件和权限归属，减少 UI 人工补历史的复杂度。

### 原则 3：结构化事件优先，文本兼容为辅

动作、思考、工具、权限不再依赖模型输出文本推断，而以结构化事件驱动。

## 拟修改范围

### Airi 侧

- `packages/stage-layouts/src/components/Widgets/ChatArea.vue`
- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-ui/src/types/chat.ts`
- 新增 `packages/stage-ui/src/services/lobster-bridge.ts`
- 视情况新增权限状态与技能配置相关 store

### LobsterAI 侧

- `src/main/libs/agentApiServer.ts`
- `src/main/libs/coworkRunner.ts`
- `src/main/main.ts`
- 新增 `src/main/libs/agentBridgeSessionStore.ts`
- 新增 Bridge 权限/文件/session 相关辅助模块

## 成功标准

| 指标 | 目标 |
|------|------|
| 文本首个增量显示 | 用户发送后能够看到逐步流式文本，而非整段完成后出现 |
| 等待态动作 | 发送后到首 token 前出现等待态动作 |
| 回复过程动作 | 首 token、工具执行、完成阶段均有对应动作或状态反馈 |
| 多轮上下文 | 连续多轮对话不丢失 runtime session 上下文 |
| 图片识别 | 图片可在 Airi 中上传并被 LobsterAI 正确识别 |
| 文件引用 | 文件通过 `fileId` 会话化引用，无物理路径泄露 |
| 技能集成 | Airi 中可查看、启停、选择技能并在同一 turn 生效 |
| 权限闭环 | Airi 可接收并回应权限请求 |

## 范围

### In Scope

- Airi 与 LobsterAI 的会话化 Bridge 设计
- 流式事件桥接与最终对账
- 动作状态映射
- 技能查看、启停、选择与配置入口
- 图片与文件的会话化上传/引用
- 权限请求与回应通道

### Out of Scope

- 重做 LobsterAI 原生桌面 UI
- 重写 Airi 全部聊天系统
- 替换现有 LLM Provider 体系中其他 Provider 的协议
- 云端部署、远程多租户桥接

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| UI 继续保留旧直连分支导致双轨逻辑冲突 | 高 | 逐步收口为单一 Bridge 入口 |
| 流式预览与最终历史不一致 | 高 | 设计 `assistant.final`/snapshot 对账机制 |
| 文件句柄与会话解绑导致引用失效 | 中 | fileId 与 session/turn 强绑定 |
| 权限请求未绑定会话导致越权响应 | 高 | 引入一次性 capability 与 session 归属校验 |
| 动作仍依赖文本 marker 导致不稳定 | 中 | 以 `state.changed` 为主驱动 |
