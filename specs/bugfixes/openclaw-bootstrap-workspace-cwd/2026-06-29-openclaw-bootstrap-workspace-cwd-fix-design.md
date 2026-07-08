# OpenClaw Bootstrap Workspace 与 Run Cwd 混用修复设计文档

## 1. 概述

### 1.1 问题

升级 OpenClaw 后，用户在 LobsterAI Agent 设置中配置的三类内容不再生效：

- 助手身份，对应 `IDENTITY.md` 或 Agent 表中的 `identity`；
- 助手性格，对应 `SOUL.md` 或 Agent 表中的 `systemPrompt`；
- 关于你，对应 `USER.md`。

进一步排查确认，受影响范围不止这三类 profile 文件，还包括 OpenClaw workspace 下的
其它 markdown 上下文：

- `AGENTS.md`、`TOOLS.md`、`HEARTBEAT.md`、`BOOTSTRAP.md` 等 bootstrap/context 文件；
- root 长期记忆文件 `MEMORY.md`；
- 每日记忆目录 `memory/**/*.md` 的运行期读写和检索路径。

从用户视角看，设置页可以正常保存，但新建会话或继续会话时模型不再体现这些 profile
内容，也可能表现为长期记忆不生效、每日记忆不更新，或者新记忆被写到用户项目目录下。
问题同时影响主 Agent 和非主 Agent，并且与用户选择的任务工作目录有关。

### 1.2 根因

这不是设置保存失败，而是 OpenClaw run 入参里的 `workspaceDir` 和 `cwd` 语义被混用。

当前 LobsterAI 的目标路径模型是：

| 概念 | 用途 |
|------|------|
| OpenClaw agent workspace | 存放 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`MEMORY.md`、`memory/` |
| run cwd / task cwd | 用户项目目录，作为工具读写、命令执行和文件生成的默认目录 |

LobsterAI 侧已经按这个模型写入配置：

- `agents.defaults.workspace` 固定为 OpenClaw state 下的 `workspace-main`；
- 非主 Agent 使用 `workspace-{agentId}`；
- `agents.defaults.cwd` / `agents.list[].cwd` 保存用户选择的任务目录；
- 桌面 `chat.send` 每轮传入 `cwd: session.cwd`。

OpenClaw 自身仍通过 `workspaceDir` 加载 bootstrap/context 文件。也就是说，
`SOUL.md`、`IDENTITY.md`、`USER.md`、`MEMORY.md` 等 root markdown 是否注入系统提示，
取决于 run 时传入的 `workspaceDir` 是否指向 Agent workspace。

OpenClaw 的记忆目录也沿用同一个 workspace 语义：

- `loadWorkspaceBootstrapFiles(workspaceDir)` 会从 `workspaceDir` 读取
  `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、
  `BOOTSTRAP.md`、`MEMORY.md`；
- memory host / memory-core 会把 `workspaceDir/MEMORY.md` 和
  `workspaceDir/memory/**/*.md` 作为默认记忆语料；
- memory flush、post-compaction refresh 等运行期维护流程也基于当前 run 的
  `workspaceDir` 定位每日记忆文件。

本次升级后的 v2026.6.1 patch 在 `getReplyFromConfig()` 中先正确计算出：

```text
workspaceDir = Agent workspace
runCwd = 用户任务目录
```

但随后把下游 agent run 的 `workspaceDir` 传成了 `runCwd`。结果 OpenClaw 会去用户项目
目录读取 `SOUL.md`、`IDENTITY.md`、`USER.md`、`MEMORY.md` 和 `memory/`，而这些文件
实际在 LobsterAI 管理的 OpenClaw workspace 中，因此 profile、root memory 和每日记忆
会一起偏离正确位置。

`systemPromptOverride` 不是可行修复方向。新版 OpenClaw 已将
`agents.defaults.systemPromptOverride` 和 `agents.list[].systemPromptOverride` 标记为
legacy removed，继续使用会与当前 runtime schema 相冲突。

## 2. 用户场景

### 场景 A: 主 Agent 身份和性格在桌面任务中生效

**Given** 用户在主 Agent 设置中配置 `IDENTITY.md`、`SOUL.md`、`USER.md`
**When** 用户在任意项目目录中新建 Cowork 任务
**Then** OpenClaw 注入来自 `workspace-main` 的 profile 文件，同时工具 cwd 仍是用户项目目录。

### 场景 B: 非主 Agent 使用自己的身份和性格

**Given** Agent B 配置了独立的助手身份、助手性格和工作目录
**When** 用户切换到 Agent B 新建任务
**Then** OpenClaw 注入 `workspace-{agentId}` 中的 `SOUL.md`、`IDENTITY.md`、`USER.md`，
工具执行和文件生成默认落在 Agent B 的工作目录。

### 场景 C: 用户项目目录没有 profile 文件

**Given** 用户项目目录中没有 `SOUL.md`、`IDENTITY.md`、`USER.md`
**When** 用户在该目录发起任务
**Then** Agent 设置仍然生效；OpenClaw 不应依赖用户项目目录存在这些文件。

### 场景 D: 切换 Agent 工作目录不丢失 profile

**Given** 用户把某个 Agent 的工作目录从 `/repo/old` 改为 `/repo/new`
**When** 后续从桌面或 IM 继续使用该 Agent
**Then** `cwd` 切换到 `/repo/new`，但 `SOUL.md`、`IDENTITY.md`、`USER.md` 仍来自固定
Agent workspace。

### 场景 E: IM / native channel 入站任务保持同样语义

**Given** 某 IM 渠道绑定到非主 Agent
**When** 用户从 IM 发起任务
**Then** channel run 的 bootstrap workspace 是绑定 Agent 的 workspace，run cwd 是绑定
Agent 的工作目录，二者不得互相覆盖。

### 场景 F: root 长期记忆 `MEMORY.md` 生效

**Given** 主 Agent 或非主 Agent workspace 中存在 `MEMORY.md`，用户项目目录中没有该文件
**When** 用户在该项目目录中新建或继续任务
**Then** OpenClaw 使用 Agent workspace 中的 `MEMORY.md` 作为长期记忆上下文或记忆语料，
不依赖用户项目目录中存在同名文件。

### 场景 G: 每日记忆目录写入 Agent workspace

**Given** 会话触发 memory flush、compaction 后刷新或 memory-core 的每日记忆流程
**When** 当前任务 cwd 是用户项目目录
**Then** 新增或读取的每日记忆文件仍位于 Agent workspace 的 `memory/` 目录下，而不是
用户项目目录的 `memory/` 目录下。

## 3. 功能需求

### FR-1: `workspaceDir` 必须始终表示 Agent bootstrap workspace

所有 OpenClaw agent run 入口中，传给 bootstrap/context loader 的 `workspaceDir` 必须指向
Agent workspace，而不是用户任务目录。

包括但不限于：

- 桌面 `chat.send` 经 gateway dispatch 的 run；
- IM / native channel 的 `dispatchReplyFromConfig()` run；
- fast directive / prepared reply run；
- follow-up、cron、heartbeat、compaction successor 等复用同一 reply runtime 的入口。

### FR-2: `cwd` 必须独立表示用户任务目录

工具执行、文件读写、相对路径解析、默认产物目录必须使用独立的 `cwd`：

1. per-run `replyOptions.cwd` / `chat.send.cwd`；
2. `agents.list[agentId].cwd`；
3. main/default Agent 使用 `agents.defaults.cwd`；
4. 最后才回退到 Agent workspace。

非主 Agent 不允许在未检查自身 `cwd` 的情况下直接使用 main/default cwd。

### FR-3: 不把 profile 文件拼进用户消息作为主修复

LobsterAI 侧不应通过把 `SOUL.md`、`IDENTITY.md`、`USER.md` 拼进用户消息来规避本问题。
这些内容应该继续作为 OpenClaw system/project context 注入。

可接受的 LobsterAI 防御仅限于：

- 诊断日志；
- 回归测试；
- 在检测到 `workspaceDir` 异常时 fail fast 或给出明确 warning；
- 保留现有 `[LobsterAI system instructions]` 机制用于 LobsterAI 自己的全局系统提示。

### FR-4: 不恢复 `systemPromptOverride`

不得重新向 `openclaw.json` 写入 `agents.defaults.systemPromptOverride` 或
`agents.list[].systemPromptOverride`。该字段已被 OpenClaw 移除，恢复它只会制造新的配置
schema 或 doctor 迁移问题。

### FR-5: existing sessions 不应永久固化错误 workspace

已有 session 下一轮继续时应重新使用正确路径语义：

- session 的 `cwd` 可以继续来自 `CoworkSession.cwd` 或 OpenClaw session entry；
- bootstrap workspace 必须根据 session key / agentId 重新解析为 Agent workspace；
- 如果 OpenClaw session entry 中已有错误的 workspace 派生状态，修复后应通过下一轮
run 或必要的 session patch/restart 纠正，而不是只影响新会话。

### FR-6: root memory 与每日记忆必须保持 Agent workspace 绑定

记忆相关路径必须遵循与 bootstrap 文件相同的 workspace/cwd 边界：

1. `MEMORY.md` 作为 root 记忆文件时，只应从 Agent workspace 读取；
2. `memory/**/*.md` 作为每日记忆语料时，只应默认扫描 Agent workspace 下的目录；
3. memory flush 或 post-compaction refresh 写入相对路径 `memory/<date>.md` 时，根目录
   必须是 Agent workspace；
4. 用户项目目录中的 `MEMORY.md` 或 `memory/` 不应覆盖 LobsterAI Agent 的长期记忆，除非
   用户显式把该目录配置为 Agent workspace 或显式添加为 memory search extra path。

## 4. 实现方案

### 4.1 修正 OpenClaw v2026.6.1 patch

修复应落在 LobsterAI 管理的 OpenClaw 版本 patch 中，而不是手改相邻 OpenClaw checkout
作为最终状态。

需要调整的 patch：

```text
scripts/patches/v2026.6.1/openclaw-im-bound-agent-run-cwd.patch
```

目标行为：

```text
workspaceDir: workspaceDir
cwd: runCwd
```

而不是：

```text
workspaceDir: runCwd
```

其中：

- `workspaceDir` 来自 `ensureAgentWorkspace()` / `resolveAgentWorkspaceDir()`；
- `runCwd` 来自 `resolveAgentRunCwd(cfg, agentId, resolvedOpts?.cwd) ?? workspaceDir`；
- 下游 embedded agent / reply run / prepared reply 都同时拿到两者；
- bootstrap loader、root memory、memory host / flush、workspace hooks 继续使用
  `workspaceDir`；
- tools、shell、file outputs、runtime prompt cwd 继续使用 `cwd`。

### 4.2 梳理受影响入口

当前需要重点检查以下调用点：

1. `src/auto-reply/reply/get-reply.ts`
   - `runPreparedReply()` 参数；
   - 普通 reply run 参数；
   - fallback / auto-fallback / fast directive run 参数。
2. `src/gateway/server-methods/chat.ts`
   - `chat.send` 已通过 `replyOptions.cwd` 传入 `p.cwd`；
   - 修复后该 `cwd` 只能影响工具目录，不能覆盖 bootstrap workspace。
3. `src/agents/embedded-agent-runner/run.ts`
   - `resolveRunWorkspaceDir()` 继续基于 `params.workspaceDir` 解析 Agent workspace；
   - `params.cwd` 单独进入 attempt / tool runtime。
4. `src/agents/bootstrap-files.ts`
   - 必须继续从 `params.workspaceDir` 加载 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、
     `USER.md`、`MEMORY.md`。
5. `src/plugin-sdk/memory-host-core.ts` 和 `packages/memory-host-sdk/src/host/internal.ts`
   - 默认 root memory 与 daily-note 语料必须继续解析为 `workspaceDir/MEMORY.md` 和
     `workspaceDir/memory/**/*.md`。
6. `src/auto-reply/reply/agent-runner-memory.ts`
   - memory flush / post-compaction refresh 使用的 `run.workspaceDir` 必须是 Agent
     workspace；
   - `run.cwd` 只能影响任务工具目录，不能影响记忆文件根目录。

如果某条路径只有 `workspaceDir` 没有 `cwd`，应补齐 `cwd` 参数，而不是把
`workspaceDir` 改成 cwd。

### 4.3 LobsterAI 侧保持现有配置语义

LobsterAI 侧不需要推翻现有 workspace/cwd 解耦：

- `openclawConfigSync.ts` 继续写：
  - `agents.defaults.workspace = getMainAgentWorkspacePath(stateDir)`；
  - `agents.defaults.cwd = taskWorkingDirectory`；
  - `agents.list[].workspace = state/workspace-{agentId}`；
  - `agents.list[].cwd = agent.workingDirectory`。
- `syncPerAgentWorkspaces()` 继续把非主 Agent 的 `SOUL.md`、`IDENTITY.md`、`USER.md`、
  `AGENTS.md`、`MEMORY.md` 和 `memory/` 写入或确保存在于 `state/workspace-{agentId}`。
- `OpenClawRuntimeAdapter` 继续在 `chat.send` 中传入 `cwd: session.cwd`。

如果后续发现 `chat.send` 仍无法让 OpenClaw 正确区分两者，应修 OpenClaw gateway/reply
runtime，而不是回退 LobsterAI 的 workspace 解耦。

### 4.4 增加诊断和防御

建议增加低频 debug 日志或测试辅助断言：

- run 启动时记录 `agentId`、`sessionKey`、`workspaceDir`、`cwd`；
- 当 `workspaceDir === cwd` 且 cwd 是用户项目目录时，确认这是否是用户显式把 Agent
  workspace 设置成项目目录；如果不是，给出 warning；
- OpenClaw config sync 测试中断言 main workspace 和 default cwd 是两个独立字段；
- runtime patch 测试中断言 bootstrap context marker 来自 workspace，而不是 cwd。

日志仍需遵守现有规范：英文、低频、以模块 tag 开头，避免在每个 stream chunk 打印。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户项目目录中刚好也有 `SOUL.md` | 不应作为 LobsterAI Agent profile 注入，除非它是 OpenClaw workspace 本身 |
| Agent 未设置 workingDirectory | `cwd` 按现有 fallback 解析；`workspaceDir` 仍是 Agent workspace |
| 用户显式把 workingDirectory 设为 Agent workspace | 允许 `cwd === workspaceDir`，但这只是用户选择，不应成为默认路径 |
| IM 绑定非主 Agent | `workspaceDir` 用绑定 Agent workspace，`cwd` 用绑定 Agent cwd |
| 继续旧 session | 下一轮 run 使用修复后的 workspace/cwd 解析；必要时通过 gateway restart 刷新 runtime config |
| OpenClaw 独立使用且没有 `cwd` | 兼容回退到 `workspaceDir` |
| `systemPromptOverride` 老配置存在 | 交给 OpenClaw doctor/legacy migration 移除，不新增写入 |
| 用户项目目录中存在 `MEMORY.md` 或 `memory/` | 不应作为 LobsterAI Agent 的默认长期记忆，除非用户显式配置该目录为 Agent workspace 或 extra path |
| 修复前已有记忆写入用户项目目录 | 不自动迁移，先通过诊断暴露；如需迁移应另开数据修复方案，避免误搬用户项目文件 |
| memory dreaming 后台任务 | 以 OpenClaw config 中的 Agent workspace 为准；修复重点是交互 run 中错误传入的 `workspaceDir` |

## 6. 涉及文件

| 文件 | 说明 |
|------|------|
| `scripts/patches/v2026.6.1/openclaw-im-bound-agent-run-cwd.patch` | 修复 OpenClaw reply runtime 中 `workspaceDir` 与 `cwd` 的传参语义 |
| `scripts/apply-openclaw-patches.cjs` | 如有必要，增加 patch 应用后的源码强校验，防止部分应用 |
| `src/main/libs/openclawConfigSync.ts` | 保持 workspace/cwd 解耦语义，并补充测试断言 |
| `src/main/libs/openclawAgentModels.ts` | 保持 `agents.list[].workspace` 与 `agents.list[].cwd` 分别写入 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 保持 `chat.send.cwd` 作为 per-run task cwd |
| `tests/openclawConfigSync.test.mjs` 或 `src/main/libs/openclawConfigSync.runtime.test.ts` | 增加配置层回归覆盖 |
| OpenClaw patch 内测试文件 | 增加 workspace/cwd 分离的运行时回归 |
| OpenClaw `src/agents/workspace.ts` / `src/agents/bootstrap-files.ts` | 作为测试依据，确认 `MEMORY.md` 仍从 `workspaceDir` 加载 |
| OpenClaw `src/plugin-sdk/memory-host-core.ts` / `packages/memory-host-sdk/src/host/internal.ts` | 作为测试依据，确认 `memory/**/*.md` 仍从 Agent workspace 扫描 |
| OpenClaw `src/auto-reply/reply/agent-runner-memory.ts` | 确认 memory flush 和 compaction refresh 使用正确 workspace |

## 7. 验收标准

### 7.1 配置层验收

生成的 `openclaw.json` 必须满足：

```json5
{
  "agents": {
    "defaults": {
      "workspace": ".../openclaw/state/workspace-main",
      "cwd": "/path/to/user/task-dir"
    },
    "list": [
      {
        "id": "agent-b",
        "workspace": ".../openclaw/state/workspace-agent-b",
        "cwd": "/path/to/agent-b/task-dir"
      }
    ]
  }
}
```

`workspace` 和 `cwd` 字段应能在测试中分别断言，不允许把用户任务目录写入
`workspace` 来修复 profile 注入。

### 7.2 OpenClaw runtime 验收

新增或保留定向测试，构造：

```text
workspaceDir = /tmp/openclaw-agent-workspace
cwd = /tmp/user-project
```

在 `workspaceDir` 中写入：

```text
SOUL.md: SOUL_CONTEXT_MARKER
IDENTITY.md: IDENTITY_CONTEXT_MARKER
USER.md: USER_CONTEXT_MARKER
MEMORY.md: MEMORY_ROOT_MARKER
memory/2026-06-29.md: DAILY_MEMORY_MARKER
```

在 `cwd` 中不写这些文件，也不创建 `memory/` 目录。

断言：

- 最终 system prompt 包含三个 marker；
- root memory marker 来自 `workspaceDir/MEMORY.md`，没有从 cwd 读取同名文件；
- 如测试启用 memory 工具或 memory host，daily-note 语料来自
  `workspaceDir/memory/2026-06-29.md`；
- memory flush 目标相对路径 `memory/<date>.md` 解析到 `workspaceDir` 下；
- 工具 runtime / shell / file output 的 cwd 是 `/tmp/user-project`；
- `workspaceDir` 没有被替换成 `/tmp/user-project`；
- `systemPromptOverride` 没有出现在生成配置或 patch 后源码路径中。

### 7.3 LobsterAI 桌面验收

手动或自动验证：

1. 修改主 Agent 的助手身份、助手性格、关于你；
2. 选择一个不包含 `SOUL.md` / `IDENTITY.md` / `USER.md` 的项目目录；
3. 新建任务并要求 Agent 复述身份/风格约束；
4. 在 Agent workspace 的 `MEMORY.md` 或 `memory/<date>.md` 中放入唯一记忆 marker；
5. 要求 Agent 回忆该 marker，必要时显式要求使用记忆检索；
6. 要求 Agent 执行 `pwd` 或创建一个小文件；
7. 确认回复体现 profile 和记忆，且 `pwd` / 文件路径落在项目目录。

### 7.4 非主 Agent 与 IM 验收

至少验证一个非主 Agent：

1. Agent B 设置不同的身份、性格、工作目录；
2. 从桌面切换到 Agent B 新建任务；
3. 从一个绑定到 Agent B 的 IM 渠道发起任务；
4. 确认两条路径都注入 Agent B profile，且 cwd 是 Agent B 工作目录。

### 7.5 构建与测试

建议运行：

```bash
npm run openclaw:patch
npm test -- openclawConfigSync
npm run compile:electron
```

如果修改 OpenClaw patch 内测试，还需要在 OpenClaw checkout / runtime build 流程中运行相应
Vitest 定向测试。建议覆盖：

- workspace/cwd 分离的 reply runtime 测试；
- bootstrap context 包含 `MEMORY.md` 的测试；
- memory host 扫描 `workspaceDir/memory/**/*.md` 的测试；
- memory flush 目标路径保持在 Agent workspace 的测试。

最终执行：

```bash
npm run openclaw:runtime:host
```

文档变更本身不要求测试；实现修复时必须按上述门禁验证。
