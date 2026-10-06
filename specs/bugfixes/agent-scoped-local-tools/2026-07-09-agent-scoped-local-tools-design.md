# Agent 本地工具作用域修复设计文档

## 1. 概述

### 1.1 问题

PR #2285 引入指定 `agentId` 启用 subagent 后，QA 反馈 child session 中不支持调用 `AskUserQuestion`。进一步验证发现问题不只发生在 child session：

- main agent 普通桌面会话可以正常调用 `AskUserQuestion` 并弹出 LobsterAI 桌面选择窗口。
- 非 main agent 普通桌面会话无法看到 LobsterAI 的 `AskUserQuestion`，模型会误用飞书插件的 `feishu_ask_user_question`。
- 非 main agent 的 child session 同样无法使用 `AskUserQuestion`。
- LobsterAI 自注册的 `lobsterai_image_generate` / `lobsterai_video_generate` 已支持非 main 普通桌面会话，但不支持 child session。

用户期望是：

1. 桌面端普通 agent 会话和桌面端 child session 都可以使用 LobsterAI 本地交互工具。
2. IM 会话继续不出现桌面弹窗，保持原设计。
3. 图片/视频生成在 child session 中也能继承父会话的媒体模型选择。

### 1.2 根因

`ask-user-question` 插件最初设计于 2026-03-26，当时通过 `sessionKey` 区分桌面端和 IM 端：

```text
agent:main:lobsterai:* -> 桌面端
其他 -> IM 端
```

该设计的目标是避免 IM 端触发桌面弹窗，而不是刻意限制 main agent。但随着多 Agent 桌面会话和 delegated subagent child session 引入，桌面端 sessionKey 已扩展为：

```text
agent:<agentId>:lobsterai:<sessionId>
agent:<agentId>:subagent:<...>
```

`ask-user-question` 仍只判断 `agent:main:lobsterai:*`，因此非 main 桌面会话无法注册 `AskUserQuestion`。

媒体生成插件使用了较宽的桌面会话判断，已经允许 `agent:<agentId>:lobsterai:<sessionId>`，但未允许 `agent:<agentId>:subagent:<...>`。同时主进程媒体回调只通过 `parseManagedSessionKey()` 解析 sessionId，无法把 subagent key 映射回本地 child Cowork session。

## 2. 用户场景

### 场景 1：非 main agent 普通桌面会话询问用户

**Given** 用户在 `qa-reviewer` 等非 main agent 下新建桌面会话

**When** 模型需要结构化询问用户，例如单选、多选或删除确认

**Then** 工具列表中应包含 LobsterAI `AskUserQuestion`，并弹出桌面端交互窗口。

### 场景 2：桌面 child session 询问用户

**Given** 桌面主会话委派出非 main agent child session

**When** child session 需要结构化询问用户

**Then** `AskUserQuestion` 请求应归属到 materialized child Cowork session，不应落到 `__askuser__` 或错误会话。

### 场景 3：IM 会话及其子会话

**Given** 会话来自飞书、钉钉、微信、QQ、Telegram、Discord、企微、NIM、POPO 或 email 等 IM channel

**When** 模型需要用户确认或选择

**Then** 不应弹出 LobsterAI 桌面窗口。IM 会话仍按原设计走文本交互或平台插件自己的交互能力。

### 场景 4：child session 媒体生成

**Given** 用户在父桌面会话中选择了 LobsterAI 图片或视频模型

**When** child session 调用 `lobsterai_image_generate` 或 `lobsterai_video_generate`

**Then** 工具应可见，主进程回调应能解析 child session，并在 child 没有独立选择时继承父会话的媒体模型选择。

## 3. 功能需求

### 3.1 AskUserQuestion 支持所有本地桌面 agent

`AskUserQuestion` 插件应允许：

- legacy `lobsterai:<sessionId>`
- `agent:<agentId>:lobsterai:<sessionId>`
- `agent:<agentId>:subagent:<...>`

插件仍应拒绝 IM channel key，例如：

- `agent:<agentId>:feishu:...`
- `agent:<agentId>:dingtalk-connector:...`
- `agent:<agentId>:openclaw-weixin:...`
- 其他非 `lobsterai` / `subagent` 来源。

### 3.2 主进程必须保留 IM 保护

插件侧只根据 sessionKey 字符串做候选判断，不能作为最终安全边界。主进程收到 AskUser HTTP callback 后必须：

1. 根据 `agent:<agentId>:lobsterai:<sessionId>` 解析本地 Cowork session。
2. 根据 `cowork_sessions.claude_session_id` 反查 materialized child session。
3. 检查当前 session 及其 parent 链是否绑定在 `im_session_mappings`。
4. 如果无法解析为本地桌面 Cowork session，或属于 IM 会话链路，直接 deny，不发桌面弹窗事件。

### 3.3 媒体生成支持 child session

`lobsterai_image_generate` / `lobsterai_video_generate` 插件应允许 `agent:<agentId>:subagent:<...>`。

主进程媒体回调应支持：

- 通过 managed key 解析普通桌面会话。
- 通过 `cowork_sessions.claude_session_id` 反查 child session。
- child session 没有媒体选择时，向 parent session 回退查找媒体选择。

### 3.4 不调整 subagent 工具 deny 策略

当前 subagent 工具策略裁剪的是 `agents_list`、`sessions_spawn`、`subagents`、`cron`、`gateway` 等委派/网关/定时任务工具，不包含 AskUser 和媒体生成。本修复不调整 subagent deny list。

### 3.5 不处理 Feishu AskUser 暴露问题

`feishu_ask_user_question` 在桌面会话中仍可见是误用诱因之一，但不是本次修复范围。本次只确保 LobsterAI 桌面 AskUser 在正确会话中可见，并保留 IM 不弹桌面窗的约束。

## 4. 实现方案

### 4.1 AskUserQuestion 插件 sessionKey 判定

在 `openclaw-extensions/ask-user-question/` 下新增独立 sessionKey helper，避免继续 hardcode `agent:main:lobsterai:*`。

候选会话判断只允许：

```text
lobsterai:*
agent:*:lobsterai:*
agent:*:subagent:*
```

该 helper 只负责工具注册可见性，不负责最终桌面/IM 判定。

### 4.2 本地 Cowork session 反查

在主进程新增本地 OpenClaw sessionKey resolver：

- managed key：使用 `parseManagedSessionKey()` 取出 sessionId，并确认 `cowork_sessions` 中存在该 session。
- child key：使用 `cowork_sessions.claude_session_id = sessionKey` 反查 materialized child session。
- IM 判断：从当前 session 沿 `parent_session_id` 向上查找，如果任一 session 存在 `im_session_mappings.cowork_session_id`，视为 IM 会话链路。

AskUser callback 使用 desktop resolver。无法解析或属于 IM 链路时返回 `{ behavior: 'deny' }`，避免 HTTP callback 挂起。

### 4.3 媒体生成 child session 支持

媒体插件的 `isLobsterAiDesktopSessionKey()` 增加 `agent:*:subagent:*` 支持。

媒体回调中的 sessionId 提取从 `parseManagedSessionKey()` 切换为本地 resolver，使 child key 能映射到 materialized child Cowork session。

媒体模型选择按以下顺序解析：

1. child session 自己的 `mediaSelectionBySession`。
2. parent session 的 `mediaSelectionBySession`。
3. 继续向上查找，最多 16 层，防止异常循环。

### 4.4 UI 弹窗策略

本次采用低风险处理：

- AskUser permission 仍按 resolved sessionId 派发。
- child session 触发的 AskUser 归属到 child session。
- 不把 child AskUser 改成全局弹窗，也不强制映射到 parent session。

这保持现有 UI selector 行为，避免扩大弹窗展示范围。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 非 main 普通桌面会话 | 注册 `AskUserQuestion`，回调解析到该 session |
| 桌面 child session 已 materialized | 注册 `AskUserQuestion`，通过 `claude_session_id` 反查 child session |
| 桌面 child session 尚未 materialized | 主进程解析失败并 deny，避免挂起或弹错会话 |
| IM 普通会话 | 插件层通常不注册；即使误传 callback，主进程 IM mapping 检查后 deny |
| IM 派生 child session | 如果 parent 在 IM mapping 中，主进程沿 parent 链识别并 deny |
| child 媒体生成没有独立模型选择 | 继承 parent 的媒体模型选择 |
| parent 链异常循环 | 最多查找 16 层，超过后停止 |

## 6. 涉及文件

### 新增

| 文件 | 说明 |
|------|------|
| `openclaw-extensions/ask-user-question/sessionKey.ts` | AskUser 插件 sessionKey 候选判断 |
| `src/main/libs/openclawLocalSessionResolver.ts` | 主进程 OpenClaw sessionKey 到 Cowork session 的本地解析与 IM 保护 |
| `tests/openclaw-extensions/ask-user-question/sessionKey.test.ts` | AskUser sessionKey 判定测试 |
| `src/main/libs/openclawLocalSessionResolver.test.ts` | 本地 session resolver 测试 |

### 修改

| 文件 | 改动 |
|------|------|
| `openclaw-extensions/ask-user-question/index.ts` | 使用新的 sessionKey helper，支持非 main 桌面 agent 和 subagent candidate |
| `openclaw-extensions/lobster-media-generation/sessionKey.ts` | 允许 `agent:*:subagent:*` |
| `src/main/mcp/mcpRuntime.ts` | AskUser callback 使用本地桌面 session resolver，并对非桌面/未知会话 deny |
| `src/main/main.ts` | 媒体 callback 使用本地 session resolver，并支持 parent media selection 回退 |
| `tests/openclaw-extensions/lobster-media-generation/sessionKey.test.ts` | 增加 subagent sessionKey 覆盖 |

## 7. 验收标准

1. main agent 普通桌面会话继续可以调用 `AskUserQuestion` 并弹窗。
2. 非 main agent 普通桌面会话可以调用 `AskUserQuestion`，不再误用飞书 AskUser。
3. 桌面 child session 的 `AskUserQuestion` callback 能映射到 materialized child Cowork session。
4. IM 会话及其 child 链路不会触发 LobsterAI 桌面弹窗。
5. 普通非 main agent 继续可以使用 `lobsterai_image_generate` / `lobsterai_video_generate`。
6. 桌面 child session 可以看到 LobsterAI 图片/视频生成工具。
7. child session 媒体生成在没有独立选择时继承 parent 的媒体模型选择。
8. 不修改 `vendor/openclaw-runtime/current` 作为最终状态。
9. 相关 Vitest、touched-file ESLint 和 Electron 主进程编译通过。
