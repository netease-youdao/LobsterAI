# OpenClaw 任务目录与 Agent Workspace 提示词分离设计

## 1. 概述

### 1.1 问题

LobsterAI 同时存在两类目录：

- 用户可见的任务工作目录（session cwd），用于项目源码、生成文档、图片、构建中间产物和最终交付物；
- OpenClaw Agent Workspace，位于 LobsterAI `userData/openclaw/state/workspace-*`，用于 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`MEMORY.md` 和 `memory/**` 等持久化 Agent 文件。

当前 LobsterAI 已在工具执行层把两者分开，但 OpenClaw system prompt 仍把 Agent Workspace 描述为唯一工作目录：

```text
## Workspace
Your working directory is: <agent-workspace>
Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.
```

因此模型可能主动把 PPT、图片、临时文件和最终产物写入通常位于 C 盘的 Agent Workspace，而不是用户指定的项目目录，造成目录语义混乱和系统盘空间占用。

### 1.2 根因

OpenClaw 上游默认把 `workspaceDir` 同时视为 Agent 引导文件目录和运行工作目录。LobsterAI 的现有 OpenClaw 补丁已经引入 `effectiveWorkspace` 与 `effectiveCwd`：

- bootstrap、skills、memory 及 Agent 持久文件继续使用 `effectiveWorkspace`；
- 普通文件工具与 shell 工具使用 `effectiveCwd`；
- 但 `buildEmbeddedSystemPrompt()` 只接收 `workspaceDir: effectiveWorkspace`，导致提示词与实际工具相对路径基准不一致。

这不是 LobsterAI 配置同步层可以完整解决的问题，因为错误文案由 OpenClaw 内部 system prompt 构建器生成，且普通运行和 compact 重建提示词都经过该构建器。因此采用与固定 OpenClaw 版本绑定的小型源码 patch。

## 2. 调研结论

### 2.1 文档与源码

调研固定版本 `v2026.6.1`、当前 OpenClaw 主线和本地集成代码后，结论如下：

1. OpenClaw 的默认模型是“一个 workspace 承担所有目录角色”，system prompt 明确使用“single global workspace”。
2. LobsterAI 的 session cwd 与 Agent Workspace 是产品层有意分离的两个概念，工具层已经按此执行。
3. 普通 `read/write/edit/apply_patch/exec` 的相对路径基于 task cwd；自动 memory flush 的写入根目录则被单独限制在 Agent Workspace。
4. 普通对话中的“记住这个”仍可能由通用文件工具执行。若完全隐藏 Agent Workspace 的绝对路径，模型会把 `MEMORY.md` 或 `memory/**` 相对写到 task cwd。因此不能只显示 task cwd，也不能简单把传入 prompt 的 `workspaceDir` 替换成 cwd。
5. OpenClaw 社区也持续出现 cwd/workspace 混用诉求，例如 [#32637](https://github.com/openclaw/openclaw/issues/32637)、[#40825](https://github.com/openclaw/openclaw/issues/40825) 和 [#43900](https://github.com/openclaw/openclaw/issues/43900)。其中每 Agent 独立 cwd 的提案未被上游采纳，LobsterAI 仍需维护集成层行为。

### 2.2 运行数据

本地问题样本中，session cwd 是用户项目目录，但模型明确选择在 `workspace-main` 下创建 PPT 中间目录和最终文件，和旧 system prompt 的指令一致。

一次本地磁盘快照显示：Agent Workspace 本身约 `0.44 MiB`，但 OpenClaw state 总量约 `237.7 MiB`，主要来自 sessions、browser、compile cache 和 memory index；另有 MCP packages 约 `61.84 MiB`、logs 约 `8.71 MiB`。因此本修复能阻止新的任务产物误入 Workspace，但不能替代 state、缓存和日志的保留/迁移策略。

### 2.3 方案比较

| 方案 | 结果 | 结论 |
|------|------|------|
| 只把 `workspaceDir` 改成 task cwd | 任务产物正确，但 bootstrap/memory/skills 目录语义被破坏 | 不采用 |
| 完全隐藏 Agent Workspace | 降低普通产物写入概率，但普通 memory 写入可能落到 task cwd | 不采用 |
| 在普通任务提示中只追加 cwd 说明 | 与原“single global workspace”并存，形成互相冲突的指令 | 不采用 |
| 条件替换原 Workspace 段，明确两个目录角色 | 与工具实际行为一致，同时保留 memory 能力 | 采用 |

## 3. 用户场景

### 场景 1：生成任务产物

**Given** session cwd 与 Agent Workspace 不同

**When** 用户要求生成代码、PPT、图片或其他文件

**Then** 模型把中间文件和最终交付物写入 task cwd，不把 Agent Workspace 当作构建或导出目录。

### 场景 2：写入持久记忆

**Given** 用户要求 Agent 记住长期信息

**When** 模型需要更新 `MEMORY.md` 或 `memory/**`

**Then** 模型使用 Agent Workspace 下的绝对路径，不把记忆文件写入项目目录。

### 场景 3：未分离目录或沙箱运行

**Given** runtime cwd 未提供、与 workspace 相同，或运行在现有 sandbox 模式

**When** 构建 system prompt

**Then** 保留 OpenClaw 原有 Workspace/沙箱文案，不改变上游兼容行为。

### 场景 4：上下文压缩

**Given** 会话触发 compact 并重建 system prompt

**When** compact 使用同一 session cwd

**Then** 重建后的提示词继续包含相同的目录角色，不退回旧 Workspace 文案。

## 4. 功能需求

### FR-1：传递运行目录

`buildAgentSystemPrompt()` 和 `buildEmbeddedSystemPrompt()` 增加可选 `runtimeCwd`；普通 embedded attempt 与 compact 路径均传入 `effectiveCwd`。

### FR-2：条件替换原段落

仅当非 sandbox 且规范化后的 `runtimeCwd !== workspaceDir` 时，用 `## Directory Roles` 替换原 `## Workspace` 段。不得同时保留“single global workspace”冲突文案。

### FR-3：明确目录职责

新段落必须明确：

- task cwd：用户文件、源码、生成文档/图片、中间产物、临时文件和最终交付物；
- Agent Workspace：仅限 OpenClaw 持久 Agent 文件；
- 普通文件与 shell 工具的相对路径基于 task cwd；
- 持久 Agent 文件使用 Agent Workspace 下的绝对路径；
- 除非用户明确指定，不得把 Agent Workspace 用作 scratch、build、export 或 deliverables 目录；
- 用户明确指定的其他路径仍优先，但受工具策略约束。

### FR-4：提示词缓存隔离

稳定前缀缓存键必须包含规范化后的 runtime cwd 及最终目录段，避免同一 Agent 在不同项目会话间复用错误路径。

### FR-5：兼容现有策略

- 不改变 Agent Workspace 的创建位置、memory flush 根目录或工具权限策略；
- 不改变 sandbox 的容器/宿主路径说明；
- `tools.fs.workspaceOnly` 在目录分离时应把 scratch 路径描述为 task cwd；
- 原 workspace commit reminder 在目录分离时应消除“this workspace”的歧义。

## 5. 实现方案

### 5.1 OpenClaw 版本化 patch

新增 `scripts/patches/v2026.6.1/zz-openclaw-task-cwd-system-prompt.patch`，修改：

- `src/agents/system-prompt.ts`：接收 `runtimeCwd`，构造条件化 Directory Roles，并纳入缓存键；
- `src/agents/embedded-agent-runner/system-prompt.ts`：向配置化 prompt 构建器转发 `runtimeCwd`；
- `src/agents/embedded-agent-runner/run/attempt.ts`：普通运行传入 `effectiveCwd`；
- `src/agents/embedded-agent-runner/compact.ts`：compact 重建时传入 `effectiveCwd`；
- 对应 OpenClaw 测试：覆盖目录分离、缓存隔离、fallback、sandbox、转发和 attempt 集成。

补丁文件使用 `zz-` 前缀，使其在已有 cwd/workspace 分离补丁之后应用。

### 5.2 LobsterAI 契约测试与补丁校验

LobsterAI 增加补丁内容契约测试，并在 `apply-openclaw-patches.cjs` 中登记关键目标和哨兵文本，确保版本升级或补丁冲突时尽早失败，而不是静默丢失 runtime cwd 传递。

### 5.3 最终提示词形态

目录分离时，原 Workspace 段被替换为：

```text
## Directory Roles
Task working directory: <runtime-cwd>
Agent workspace: <agent-workspace>

<task cwd、持久 Agent 文件、相对路径、禁止误用和用户显式路径规则>
```

这是原段落的条件替换，不是在整体提示词末尾追加第二套目录说明。

## 6. 边界与非目标

| 场景 | 处理方式 |
|------|----------|
| `runtimeCwd` 未传入 | 回退到 `workspaceDir`，保持原文案 |
| 两个路径相同 | 保持原文案 |
| sandbox 运行 | 保持现有容器/宿主 Workspace 说明 |
| 用户显式要求输出到其他目录 | 按用户路径执行，仍受工具策略约束 |
| 普通 memory 更新 | 使用 Agent Workspace 绝对路径 |
| 自动 memory flush | 继续使用现有受限 workspace 写入工具，不受本 patch 影响 |
| `exec` 显式写入任意可访问路径 | system prompt 只能降低误写概率，不能形成文件系统级硬隔离 |
| OpenClaw state/cache/logs 占用 C 盘 | 不属于本修复；需另行设计目录迁移和保留策略 |

本次不新增专用 `memory_write` 工具，也不对所有任务产物实施硬路径拦截。若后续需要强保证，可在 artifact 输出层增加路径校验，或用专用 memory 工具消除通用写工具的双目录语义。

## 7. 验收标准

1. cwd 与 workspace 分离时，prompt 包含两个绝对路径及明确职责，不包含“single global workspace”。
2. cwd 未提供或等于 workspace 时，原 Workspace 文案保持不变。
3. sandbox prompt 保持原 `/workspace` 和宿主挂载说明，不显示 Directory Roles。
4. 普通 embedded attempt 与 compact 均传递 `effectiveCwd`。
5. 同一 workspace、不同 runtime cwd 生成各自正确的稳定提示词，不发生缓存串用。
6. prompt 明确保留 `MEMORY.md` 与 `memory/**` 的 Agent Workspace 写入语义。
7. OpenClaw 定向测试、LobsterAI 补丁契约测试、补丁强校验及 Electron TypeScript 编译通过。
8. 不覆盖 `D:\github\openclaw` 中与本功能无关的既有未提交改动。
