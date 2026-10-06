# Agent 子 Agent 委派配置设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI 基于 OpenClaw 运行 Agent。OpenClaw 已支持通过 `sessions_spawn.agentId` 将子任务委派给另一个已配置 Agent，但仅配置 `subagents.allowAgents` 不会让模型自动把 `taskName` 当成目标 Agent。

调研和实测中发现：

1. `subagents.allowAgents` 只声明允许显式委派的目标 Agent。
2. `sessions_spawn.taskName` 只是子任务的稳定别名，不是目标 Agent。
3. 如果 `sessions_spawn` 省略 `agentId`，OpenClaw 默认在当前 requester Agent 下启动普通 subagent。
4. 当 UI 只展示 `taskName` 时，容易误以为任务已委派给对应 Agent，但真实 session key 可能仍是 `agent:main:subagent:...`。

### 1.2 目标

本功能目标是让用户在 Agent 页面配置“当前 Agent 可委派哪些其它 Agent”，并由 LobsterAI 生成符合 OpenClaw 语义的配置，使 main Agent 可以通过自然语言协调预配置的协作 Agent。

目标包括：

1. 在 Agent 设置页提供“协作”入口，允许多选其它已启用 Agent。
2. 在 Agent 创建页提供同样的协作配置入口。
3. UI 不展示当前 Agent 自己，用户只选择其它协作 Agent。
4. 当用户未选择任何其它协作 Agent 时，不输出 OpenClaw `subagents` 配置。
5. 当用户选择了任意其它协作 Agent 时，生成 OpenClaw 配置时自动补入当前 Agent 自己，并启用 `requireAgentId: true`。
6. 不引入 OpenClaw A2A 配置，不修改 `tools.agentToAgent.*`。
7. 暂不配置 `delegationMode`，避免把提示词倾向和权限控制混在一起。

## 2. 用户场景

### 场景 1: 配置 main Agent 可委派专家 Agent

**Given** 用户已创建 `product-analyst`、`ts-engineer`、`qa-reviewer` 等 Agent。

**When** 用户在 main Agent 的“协作”设置中选择这些 Agent。

**Then** LobsterAI 保存用户选择，并在 OpenClaw 配置中为 main 输出可委派目标。

### 场景 2: main Agent 通过自然语言协调协作 Agent

**Given** main Agent 已允许调用 `product-analyst`、`ts-engineer`、`qa-reviewer`。

**When** 用户要求 main 先委派产品分析，再委派工程实现，最后委派 QA 审查。

**Then** main Agent 可调用 `sessions_spawn`，并通过显式 `agentId` 启动对应 Agent 的 subagent session。

### 场景 3: 用户不配置协作 Agent

**Given** 用户没有在“协作”设置中选择任何其它 Agent。

**When** LobsterAI 同步 OpenClaw 配置。

**Then** 不为该 Agent 输出 `subagents` 配置，保持 OpenClaw 默认普通 subagent 行为。

### 场景 4: 普通 self subagent 不被误禁用

**Given** 用户为某 Agent 配置了至少一个协作 Agent。

**When** OpenClaw 需要显式启动当前 Agent 自己作为普通 subagent。

**Then** 生成的 `allowAgents` 中包含当前 Agent 自己，因此 `requireAgentId: true` 不会阻断显式 self spawn。

## 3. 功能需求

### FR-1: Agent 数据模型保存用户选择

Agent 模型增加 `subagentAllowAgentIds`，只保存用户在 UI 中选择的其它协作 Agent ID。

保存规则：

1. 去除空字符串。
2. 去重。
3. UI 选择为空时保存空数组。
4. 不把自动补入的 self 写回 UI 状态或数据库字段。

### FR-2: Agent 设置页提供协作入口

Agent 设置页新增“协作”Tab，展示其它已启用 Agent 的多选列表。

列表规则：

1. 只展示已启用 Agent。
2. 不展示当前正在编辑的 Agent 自己。
3. 展示 Agent 名称和 ID，便于用户确认目标。
4. 多选结果写入当前 Agent 的 `subagentAllowAgentIds`。

### FR-3: Agent 创建页提供协作入口

Agent 创建弹窗新增“协作”Tab，允许创建时预先选择已有 Agent 作为协作目标。

创建页中尚未存在当前 Agent ID，因此不能完全按设置页排除 self。配置同步层必须兜底过滤后续可能与新 Agent ID 相同的选择。

### FR-4: OpenClaw 配置生成规则

同步 OpenClaw 配置时，LobsterAI 基于 Agent 的 `subagentAllowAgentIds` 生成 `agents.list[].subagents`。

当用户选择为空时：

```json5
{
  id: "main"
  // 不输出 subagents
}
```

当用户选择了其它协作 Agent 时：

```json5
{
  id: "main",
  subagents: {
    allowAgents: ["main", "product-analyst", "ts-engineer", "qa-reviewer"],
    requireAgentId: true
  }
}
```

其中：

1. `allowAgents[0]` 是当前 Agent 自己。
2. 后续元素是用户在 UI 中选择的协作 Agent。
3. 如果历史数据里包含 self，生成配置时过滤掉重复 self。
4. 只有存在至少一个其它协作 Agent 时才生成 `subagents`。
5. `requireAgentId: true` 用于阻止省略 `agentId` 后静默落回 requester Agent。

### FR-5: 不配置 A2A

本功能只使用 OpenClaw native subagent 能力，不启用 A2A。

不生成或修改：

```json5
{
  tools: {
    agentToAgent: {
      enabled: true
    }
  }
}
```

### FR-6: 不配置 delegationMode

`agents.defaults.subagents.delegationMode` 和 `agents.list[].subagents.delegationMode` 只影响 prompt guidance，不改变权限或目标解析。

本次不设置该字段，避免引入额外行为变化。

## 4. 实现方案

### 4.1 数据层

SQLite `agents` 表增加 `subagent_allow_agent_ids` 字段，保存 JSON 字符串数组。

Agent CRUD 需要支持：

1. 创建 Agent 时写入 `subagentAllowAgentIds`。
2. 更新 Agent 时写入 `subagentAllowAgentIds`。
3. 读取 Agent 时解析为数组。
4. 旧数据缺失字段时默认空数组。

### 4.2 Renderer 层

Agent 设置页：

1. 新增“协作”Tab。
2. 加载并展示其它已启用 Agent。
3. 勾选结果进入 `subagentAllowAgentIds`。
4. 保存时通过既有 Agent update API 提交。

Agent 创建页：

1. 新增“协作”Tab。
2. 展示已有已启用 Agent。
3. 创建时通过 Agent create API 提交 `subagentAllowAgentIds`。
4. 重置弹窗和应用模板时清空选择，避免脏状态残留。

### 4.3 OpenClaw 配置同步层

`openclawAgentModels.buildAgentEntry` 负责把 LobsterAI Agent 转成 OpenClaw Agent entry。

转换规则：

1. `normalizeSubagentAllowAgentIds` 只保留用户选择的其它 Agent。
2. `buildSubagentConfig` 在输出配置时补入 `agent.id`。
3. 当选择列表为空时返回 `undefined`，不输出 `subagents`。
4. 当选择列表非空时输出 `allowAgents` 和 `requireAgentId`。

### 4.4 已知运行时观察

实测期望行为：

1. `agents_list` 应返回 requester 可显式委派的 Agent，包括 self 和 UI 选择的协作 Agent。
2. 调用 `sessions_spawn` 时必须传 `agentId`。
3. 真实子会话 key 应形如 `agent:product-analyst:subagent:<uuid>`，而不是 `agent:main:subagent:<uuid>`。
4. 子会话 trajectory 应落在对应 Agent 目录，例如 `openclaw/state/agents/product-analyst/sessions/`。

后续实现补充：

1. OpenClaw transcript/trajectory 能正确记录多轮 yield 后的 `ts-engineer`、`qa-reviewer` subagent。
2. LobsterAI final sync 会回填后续自动推进产生的 `sessions_spawn`、`sessions_yield` 工具结果，避免只记录第一段 spawn。
3. 协作 Agent 的 subagent run 会 materialize 为可继续对话的 Cowork child session，并通过 `childCoworkSessionId` 与父会话中的 subagent run 关联。
4. self subagent 不 materialize 为独立 Cowork child session，避免在 sidebar 中出现不必要的“当前 Agent 调用当前 Agent”会话。
5. `taskName` 作为展示别名写入 subagent run 的 `label`，但不改变 `agentId` 的身份语义；`agentId` 仍用于 OpenClaw 目标路由、session key 解析和 materialize 判断。
6. `getSubTaskHistory` 只按明确的 run/session key 读取历史，不再按 `agentId` 做模糊匹配，避免失败的 subagent 调用映射到错误会话。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户未选择任何协作 Agent | 不输出 `subagents`，保持 OpenClaw 默认行为 |
| 用户选择了一个或多个协作 Agent | 输出 `allowAgents: [self, ...selected]` 和 `requireAgentId: true` |
| 历史数据中包含 self | 配置生成时过滤重复 self；如果 self-only，则不输出 `subagents` |
| 协作 Agent 后续被禁用或删除 | 当前实现按保存的 ID 输出；OpenClaw 会在目标不存在时拒绝或从 `agents_list` 中省略，后续可补清理机制 |
| 普通 subagent 需要 self target | 因 `allowAgents` 自动包含 self，模型显式传 `agentId: self` 时可继续运行 |
| 模型省略 `agentId` | `requireAgentId: true` 使 OpenClaw 拒绝该调用，避免静默跑到 requester 自己 |
| 用户期望 A2A 群聊 | 本功能不覆盖；A2A 需要另行配置 `tools.agentToAgent.*` 和 session 可见性 |

## 6. 涉及文件

已实现或计划涉及的主要文件：

1. `src/main/coworkStore.ts`
2. `src/main/sqliteStore.ts`
3. `src/main/preload.ts`
4. `src/main/libs/openclawAgentModels.ts`
5. `src/main/libs/openclawAgentModels.test.ts`
6. `src/renderer/services/agent.ts`
7. `src/renderer/store/slices/agentSlice.ts`
8. `src/renderer/types/agent.ts`
9. `src/renderer/components/agent/AgentSettingsPanel.tsx`
10. `src/renderer/components/agent/AgentCreateModal.tsx`
11. `src/renderer/services/i18n.ts`
12. `src/main/libs/agentEngine/subagent/tracker.ts`
13. `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
14. `src/main/subagentRunStore.ts`
15. `src/main/subagentMessageStore.ts`
16. `src/renderer/components/artifacts/SubagentPanelContent.tsx`
17. `src/renderer/components/cowork/SubagentTurnLinks.tsx`

## 7. 验收标准

1. 数据库中 Agent 可保存和读取 `subagentAllowAgentIds`。
2. 设置页可配置当前 Agent 允许调用的其它 Agent，且不展示当前 Agent 自己。
3. 创建页可在创建 Agent 时选择协作 Agent。
4. UI 选择为空时，生成的 OpenClaw Agent entry 不包含 `subagents`。
5. UI 选择非空时，生成的 OpenClaw Agent entry 包含当前 Agent 自己、用户选择的 Agent，以及 `requireAgentId: true`。
6. 不生成 `tools.agentToAgent.enabled`。
7. 不生成 `delegationMode`。
8. `sessions_spawn` 显式传 `agentId: "product-analyst"` 后，真实 session key 为 `agent:product-analyst:subagent:<uuid>`。
9. 协作 Agent 的 subagent run 在本地有 `childCoworkSessionId`，可作为对应 Agent 下的普通会话继续对话。
10. self subagent 不生成独立 child session。
11. subagent 列表和 chip 展示优先使用 `label`/`taskName`，而不是把 self subagent 展示成 `main`。
12. 后续自动推进产生的 subagent 工具结果可在父会话中回填展示。
13. 相关单元测试覆盖配置生成的空选择、self-only、正常协作选择三种情况。
14. touched TypeScript/TSX 文件通过 ESLint changed-file 检查。
