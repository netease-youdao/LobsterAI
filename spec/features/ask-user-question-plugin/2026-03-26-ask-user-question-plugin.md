# AskUserQuestion 插件 — 桌面端用户交互弹窗

## 概述

通过 OpenClaw 插件机制实现桌面端结构化用户交互弹窗，支持删除确认、单选、多选等场景。IM 端不受影响，命令全部直接执行。

## 问题背景

OpenClaw 引擎接管后，原有的 Claude Agent SDK `canUseTool` 执行前拦截机制不再可用。需要一种新方式实现：
- 桌面端：删除等危险操作弹窗确认，用户选择场景弹窗交互
- IM 端：所有命令直接执行，不弹窗

### 探索过的方案及放弃原因

| 方案 | 结果 | 放弃原因 |
|------|------|---------|
| gateway `allowlist + on-miss` | 弹窗可用 | 首次命令模型生成"需要审批"误提示，新安装体验差 |
| 预写入 allowlist | 部分解决 | 复合命令（`cd && git status`）shell 内置命令无法匹配 |
| `security: full` + 提示词文本确认 | 可用 | 删除确认 ~90%，非结构化，无法做单选/多选 |
| 修改 OpenClaw 源码 | — | 维护成本高，不可接受 |
| 插件 `callGatewayTool` | 不可行 | 插件 API 未暴露该函数 |

## 最终方案

**OpenClaw 插件 + HTTP callback + 桌面弹窗**

```
模型调用 AskUserQuestion 工具（结构化 JSON）
→ 插件 execute() 通过 HTTP POST /askuser 发送到 LobsterAI
→ McpBridgeServer 收到请求，创建 Promise 等待
→ IPC 通知渲染进程弹窗
→ 用户操作（确认/拒绝/选择/超时 120s）
→ HTTP response 返回给插件
→ 插件 execute() 返回结果给模型
→ 模型根据结果继续执行或取消
```

### 桌面端 vs IM 端隔离

插件通过 `sessionKey` 判断来源：
- `agent:main:lobsterai:*` → 桌面端 → 注册 AskUserQuestion 工具
- 其他（qqbot/dingtalk/weixin/feishu/wecom）→ IM → 返回 null，工具不可见

IM 端模型工具列表中没有 AskUserQuestion，自然不会调用，命令直接执行。

## 架构

```
┌─────────────────────────────────────────────────────┐
│ OpenClaw Gateway (独立进程)                          │
│                                                      │
│  ┌──────────────────────┐  ┌─────────────────────┐  │
│  │ ask-user-question    │  │ mcp-bridge 插件      │  │
│  │ 插件                 │  │ (共用 HTTP server)   │  │
│  │                      │  │                      │  │
│  │ execute() ──HTTP──┐  │  │                      │  │
│  └──────────────────┘│  │  └─────────────────────┘  │
│                       │  │                           │
└───────────────────────┼──┘                           │
                        │                              │
                   POST /askuser                       │
                        │                              │
┌───────────────────────▼──────────────────────────────┐
│ LobsterAI 主进程 (Electron)                          │
│                                                      │
│  McpBridgeServer ──IPC──▶ 渲染进程弹窗               │
│  (HTTP callback)          CoworkPermissionModal      │
│                           CoworkQuestionWizard       │
│                                                      │
│  用户选择 ◀──IPC── 弹窗结果                          │
│  HTTP response 返回给插件                             │
└──────────────────────────────────────────────────────┘
```

## 弹窗类型

| 条件 | 弹窗类型 | UI |
|------|---------|-----|
| 1 question + 2 options + 非 multiSelect | Confirm | 简单的允许/拒绝按钮 + 黄色 caution 警告 |
| 1 question + 3~4 options | Selection 单选 | 选项列表，选一个 |
| 1 question + multiSelect: true | Selection 多选 | 选项列表，可选多个 |
| 2+ questions | Wizard 向导 | 分步引导，逐题作答 |

弹窗标题区分：
- 删除/权限确认 → "需要权限确认" + 黄色图标
- 选择类 → "请选择" + 蓝色图标

## 涉及文件

### 新增

| 文件 | 说明 |
|------|------|
| `openclaw-extensions/ask-user-question/index.ts` | 插件入口，注册 AskUserQuestion 工具 |
| `openclaw-extensions/ask-user-question/openclaw.plugin.json` | 插件清单 |
| `openclaw-extensions/ask-user-question/package.json` | 包信息 |
| `src/main/libs/commandSafety.ts` | 危险命令检测模块 |
| `src/renderer/components/cowork/CoworkQuestionWizard.tsx` | 多问题向导弹窗组件 |

### 修改

| 文件 | 改动 |
|------|------|
| `src/main/libs/mcpBridgeServer.ts` | 新增 `/askuser` 路由、`onAskUser`/`resolveAskUser`/`onAskUserDismiss` API |
| `src/main/main.ts` | 注册 AskUser 回调、HTTP server 无 MCP 时也启动、permission respond 双路径 |
| `src/main/libs/openclawConfigSync.ts` | 插件配置同步、`ensureExecApprovalDefaults`、`MANAGED_EXEC_SAFETY_PROMPT` |
| `src/main/preload.ts` | 新增 `onStreamPermissionDismiss` IPC |
| `src/renderer/components/cowork/CoworkPermissionModal.tsx` | confirm 模式、弹窗标题区分、dangerLevel 分级 |
| `src/renderer/services/cowork.ts` | 监听 permissionDismiss 事件 |
| `src/renderer/services/i18n.ts` | 新增 i18n 翻译键 |
| `src/renderer/types/electron.d.ts` | 新增 IPC 类型定义 |
| `src/renderer/App.tsx` | AskUserQuestion 路由到 Wizard vs Modal |
| `src/main/libs/coworkRunner.ts` | 使用 commandSafety 替换内联正则 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 本地 auto-approve + channel auto-approve |

## exec-approvals.json 配置

应用启动时自动写入 `~/.openclaw/exec-approvals.json`：

```json
{
  "version": 1,
  "agents": {
    "main": {
      "security": "full",
      "ask": "off"
    }
  }
}
```

- `security: full` + `ask: off` → gateway 不触发任何审批流程
- 删除保护完全由 AskUserQuestion 插件 + 提示词实现

## 已知限制

1. **模型遵从度**：删除弹窗依赖模型调用 AskUserQuestion 工具（提示词引导），不是系统强制拦截。Claude 系列 ~95%，MiniMax/Kimi ~80-90%。
2. **同 session 重试**：拒绝删除后在同一 session 说"还是删除吧"，模型可能跳过弹窗直接执行。新 session 正常。
3. **超时**：弹窗 120 秒无操作自动关闭，视为拒绝。
4. **IM 选择场景**：IM 端无 AskUserQuestion 工具，选择场景退化为文本交互。
5. **钉钉/企微**：通过 HTTP API 接入，`messageChannel=webchat`，通过 `sessionKey` 前缀区分（非 `lobsterai:` 前缀）。

## 测试用例

### 删除确认

| 输入 | 预期（桌面端） | 预期（IM 端） |
|------|-------------|-------------|
| 帮我删除桌面的 test 文件夹 | Confirm 弹窗 → 允许/拒绝 | 直接删除 |
| 删除 /tmp/test.txt | Confirm 弹窗 | 直接删除 |
| 弹窗 120 秒不操作 | 自动关闭，视为拒绝 | — |

### 单选

| 输入 | 预期 |
|------|------|
| 帮我创建项目，选框架：React、Vue、Svelte | Selection 弹窗（3 选项）|

### 多选

| 输入 | 预期 |
|------|------|
| 桌面有 old.log、temp.txt、cache.dat 可以清理，帮我多选要删除哪些 | Selection 弹窗（multiSelect）|

### 连续问题

| 输入 | 预期 |
|------|------|
| 创建项目，确认：项目名（a/b/c）、语言（TS/JS/Python）、是否初始化 git（是/否） | Wizard 向导（3 步）|

### 非删除命令

| 输入 | 预期 |
|------|------|
| 查看桌面文件 | 直接执行，无弹窗 |
| 查看 git 状态 | 直接执行 |
| push 代码 | 直接执行 |
