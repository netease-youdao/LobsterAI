# OpenClaw 会话级模型 Override 方案

## 背景

当前 Cowork 发送框和页面头部的模型选择器，改的是当前 `agent` 的默认模型配置，不是当前会话的模型 override。

这和期望行为不一致。你希望的是：

- 切换模型时，仅影响当前会话
- 底层通过 OpenClaw 的 `sessions.patch` 能力落到会话级别
- 不要把这次切换写回 `agents.model`

## 现状分析

### 1. 当前 UI 选择模型后，直接写 agent

发送框里的模型切换逻辑在：

- [src/renderer/components/cowork/CoworkPromptInput.tsx](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/components/cowork/CoworkPromptInput.tsx)

核心行为：

- `ModelSelector.value` 使用 `resolveAgentModelSelection(...)`
- `resolveAgentModelSelection(...)` 读的是 `currentAgent.model`
- `onChange` 里直接执行 `agentService.updateAgent(currentAgent.id, { model: toOpenClawModelRef(nextModel) })`

页面头部也是同样逻辑：

- [src/renderer/components/cowork/CoworkView.tsx](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/components/cowork/CoworkView.tsx)

因此现在的“切换模型”本质是：

1. 修改 agent 默认模型
2. 后续所有新会话都可能跟着变
3. 当前已存在会话并没有显式 session override 概念

### 2. 当前 Cowork 本地状态没有 session-level model 字段

LobsterAI 的会话结构目前没有会话 override 模型字段：

- [src/renderer/types/cowork.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/types/cowork.ts)
- [src/main/coworkStore.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/coworkStore.ts)

`CoworkSession` / `CoworkSessionSummary` 里只有：

- `agentId`
- `systemPrompt`
- `cwd`
- `status`
- `messages`

没有这些字段：

- `modelOverride`
- `modelProviderOverride`
- `effectiveModel`

所以前端只能退回去读 `agent.model`，这也是现在逻辑会绑定到 agent 的根本原因。

### 3. OpenClaw 已经支持会话级模型 patch

OpenClaw 客户端已经直接暴露：

- [/Users/yunxin/Documents/open-source/openclaw/src/tui/gateway-chat.ts](/Users/yunxin/Documents/open-source/openclaw/src/tui/gateway-chat.ts)

```ts
async patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult> {
  return await this.client.request<SessionsPatchResult>("sessions.patch", opts);
}
```

真正的服务端 patch 逻辑在：

- [/Users/yunxin/Documents/open-source/openclaw/src/gateway/sessions-patch.ts](/Users/yunxin/Documents/open-source/openclaw/src/gateway/sessions-patch.ts)
- [/Users/yunxin/Documents/open-source/openclaw/src/sessions/model-overrides.ts](/Users/yunxin/Documents/open-source/openclaw/src/sessions/model-overrides.ts)

它的关键行为是：

- `patch.model = "provider/model"` 或 alias 时，会解析并校验为 allowlisted model
- patch 成功后，写入 `providerOverride` / `modelOverride`
- 如果 patch 到默认模型，会清掉 override，而不是冗余保存
- 切模型时会清掉旧的 `authProfileOverride`
- 还会清掉已记录的 runtime model 字段，保证状态显示及时切换到新的 override

OpenClaw 会话模型解析优先级也已经明确：

- [/Users/yunxin/Documents/open-source/openclaw/src/gateway/session-utils.ts](/Users/yunxin/Documents/open-source/openclaw/src/gateway/session-utils.ts)

优先级是：

1. 最近一次 runtime model
2. session override (`providerOverride` / `modelOverride`)
3. agent/default model

这正是你要的能力。

## 当前调用链

### 新建会话

入口：

- [src/renderer/components/cowork/CoworkView.tsx](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/components/cowork/CoworkView.tsx)
- [src/renderer/services/cowork.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/services/cowork.ts)
- [src/main/main.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/main.ts)
- [src/main/libs/agentEngine/coworkEngineRouter.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/libs/agentEngine/coworkEngineRouter.ts)
- [src/main/libs/agentEngine/openclawRuntimeAdapter.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/libs/agentEngine/openclawRuntimeAdapter.ts)

OpenClaw runtime 在 `runTurn()` 里按 `sessionId + agentId` 生成 managed `sessionKey`：

- `agentId = options.agentId || session.agentId || 'main'`
- `sessionKey = this.toSessionKey(sessionId, agentId)`

也就是说，LobsterAI 其实已经能稳定定位到对应的 OpenClaw session，只是没有暴露 “patch 当前 session” 这条能力。

### 继续会话

继续会话时走的仍然是同一个 `sessionId`，最终会映射到同一个 managed `sessionKey`。

这意味着：

- 只要在发送前或切换时调用一次 `sessions.patch`
- 后续 `chat.send` 就会自动落到该会话的 override 模型

## 问题拆解

### 问题 1：UI 的模型来源错了

现在 UI 读的是：

- `currentAgent.model`
- 若为空则回退到 `globalSelectedModel`

正确的会话级语义应该是：

1. 当前 session 的 override model
2. 若无 override，则显示当前 agent/default effective model
3. Home 空态下没有 session 时，才允许显示 agent/default model

### 问题 2：缺少 session patch IPC

现在已有：

- `openclaw:sessionPolicy:get`
- `openclaw:sessionPolicy:set`

但没有：

- `openclaw:session:getModelOverride`
- `openclaw:session:setModelOverride`

或者更通用的：

- `openclaw:session:patch`

### 问题 3：本地会话元数据没有同步面

即便主进程把 `sessions.patch` 调成功了，前端如果没有本地 session 元数据字段，仍然没法正确显示“当前会话已切到哪个模型”。

### 问题 4：新会话首次发送前的时序

“新对话页面还没真正创建 session 时”就点了模型切换，会有两种语义：

1. 改 agent 默认模型
2. 仅把这次即将创建的会话的初始 override 设好

既然目标是“会话级”，则推荐第二种，但这要求在新会话创建前先保留一个“待应用的 session override model”。

## 推荐方案

## 总体原则

- 保留 `agent.model` 作为 agent 默认模型
- 新增 `session.modelOverride` 作为会话级模型
- 通信接口设计成通用 `session patch`，模型只是第一批落地字段之一
- Cowork 区的模型选择器默认操作 session override，不再直接改 agent
- 只有 Agent 设置页才改 `agent.model`

## 方案分层

### A. 先补会话模型字段

需要在 LobsterAI 本地会话模型里加字段：

- `modelOverride?: string`
- `effectiveModel?: string`

建议 renderer/main 两侧类型同时补：

- [src/renderer/types/cowork.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/types/cowork.ts)
- [src/main/coworkStore.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/coworkStore.ts)

推荐语义：

- `modelOverride`
  表示用户显式设置到当前 session 的 OpenClaw model ref，例如 `anthropic/claude-sonnet-4-6`
- `effectiveModel`
  表示当前 UI 用来展示的有效模型。可等于 override，也可等于 agent/default fallback

更稳妥的做法是只持久化 `modelOverride`，`effectiveModel` 在读取时计算，避免双写漂移。

### B. 在 SQLite 的 `cowork_sessions` 表新增列

建议新增：

- `model_override TEXT NOT NULL DEFAULT ''`

原因：

- 当前会话列表和详情都依赖本地 SQLite
- 需要在重启应用后保留会话级 override 展示
- 仅存在于内存中的 sessionKey -> override 映射不够

`effectiveModel` 不建议入库，运行时由：

1. `model_override`
2. `agent.model`
3. `globalSelectedModel`

共同计算即可。

### C. 新增通用 OpenClaw session patch IPC

建议直接设计成通用 patch 接口，遵守仓库的字符串常量规则，不要直接写裸字符串。

例如新增模块：

- `src/main/openclawSession/constants.ts`

建议至少包含：

```ts
export const OpenClawSessionIpc = {
  Patch: 'openclaw:session:patch',
  Get: 'openclaw:session:get',
} as const;
```

建议 patch payload 也定义成通用结构，而不是模型专用结构。例如：

```ts
export interface OpenClawSessionPatchInput {
  sessionId: string;
  patch: {
    model?: string | null;
    thinkingLevel?: string | null;
    reasoningLevel?: string | null;
    elevatedLevel?: string | null;
    responseUsage?: 'off' | 'tokens' | 'full' | null;
    sendPolicy?: 'allow' | 'deny' | null;
  };
}
```

这里的字段不需要第一版一次性全做完，但接口形态应当从一开始就是通用 patch。

主进程职责：

1. 根据 `sessionId` 找到本地会话
2. 用 `agentId` 推导 managed `sessionKey`
3. 将 `sessionId + patch` 转成 OpenClaw `sessions.patch` 所需参数
4. patch 成功后同步更新 LobsterAI 本地已持久化的 session 元数据
5. 返回给 renderer 最新 session 数据

第一版即便只真正落地 `patch.model`，接口层也应设计成通用 patch，而不是 `setModel`/`clearModel` 风格的专用接口。

### D. 在 OpenClawRuntimeAdapter 内增加通用 patch helper

建议在：

- [src/main/libs/agentEngine/openclawRuntimeAdapter.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/libs/agentEngine/openclawRuntimeAdapter.ts)

新增类似能力：

```ts
async patchSession(
  sessionId: string,
  patch: {
    model?: string | null;
    thinkingLevel?: string | null;
    reasoningLevel?: string | null;
    elevatedLevel?: string | null;
    responseUsage?: 'off' | 'tokens' | 'full' | null;
    sendPolicy?: 'allow' | 'deny' | null;
  },
): Promise<void>
```

内部逻辑：

1. `const session = this.store.getSession(sessionId)`
2. `const agentId = session?.agentId || 'main'`
3. `const sessionKey = this.toSessionKey(sessionId, agentId)`
4. `await this.ensureGatewayClientReady()`
5. `await client.request('sessions.patch', { key: sessionKey, ...patch })`

为什么放在 runtime adapter 合适：

- `sessionKey` 生成逻辑已经在这里
- 以后若要查询 OpenClaw 当前 session 的更多元数据，也能继续收敛在这一层
- 主进程 IPC handler 不需要了解 OpenClaw 内部 sessionKey 拼法

### E. CoworkEngineRouter 补一个可选 patch 能力

当前 `CoworkRuntime` 接口只有：

- `startSession`
- `continueSession`
- `stopSession`

建议增加可选方法：

```ts
patchSession?(
  sessionId: string,
  patch: {
    model?: string | null;
    thinkingLevel?: string | null;
    reasoningLevel?: string | null;
    elevatedLevel?: string | null;
    responseUsage?: 'off' | 'tokens' | 'full' | null;
    sendPolicy?: 'allow' | 'deny' | null;
  },
): Promise<void>;
```

然后：

- `openclawRuntimeAdapter` 实现它
- `claudeRuntimeAdapter` 返回 unsupported 或 no-op
- `coworkEngineRouter` 透传到当前 engine

这样主进程 IPC 不需要直接耦合具体 runtime 实现。

### F. renderer 增加 session-level service 方法

在：

- [src/renderer/services/cowork.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/services/cowork.ts)

新增：

- `patchSession(sessionId: string, patch: OpenClawSessionPatch)`
- 可以在其上再封装 `setSessionModelOverride(...)`

职责：

1. 调 preload 暴露的 `window.electron.openclaw.session.patch`
2. 拿到返回的 session
3. 更新 Redux `currentSession` / `sessions`

### G. preload 和类型声明同步扩展

需要修改：

- [src/main/preload.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/preload.ts)
- [src/renderer/types/electron.d.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/types/electron.d.ts)

在 `window.electron.openclaw` 下新增：

- `session.get`
- `session.patch`

## UI 行为建议

### 1. 有当前 session 时，模型选择器改为通过通用 patch 操作 session override

适用位置：

- [src/renderer/components/cowork/CoworkPromptInput.tsx](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/components/cowork/CoworkPromptInput.tsx)
- [src/renderer/components/cowork/CoworkView.tsx](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/components/cowork/CoworkView.tsx)

建议行为：

- 如果 `currentSession` 存在，`onChange` 改为 `coworkService.patchSession(currentSession.id, { model: toOpenClawModelRef(nextModel) })`
- 不再调用 `agentService.updateAgent(...)`

### 2. 无当前 session 时，不直接改 agent，改为“待创建会话 override”

这是最符合“会话级”的空态行为。

建议新增一个 Home 草稿态字段：

- `draftSessionModelOverrideByDraftKey`

至少支持：

- `__home__` 的新会话草稿 override
- 会话草稿切换时保留对应选择

新建会话成功后：

1. 先创建本地 session
2. 在真正 `startSession()` 前调用一次 `patchSession(session.id, { model: draftModelOverride })`
3. 再执行首条 `chat.send`

这样第一轮就会用对模型。

如果你想先降低改造范围，也可以采用过渡方案：

- 空态下仍显示 agent/default model
- 只有进入 session 后，模型选择器才改为 session override

但这会留下一个语义不一致点：空态选的仍不是会话级。

### 3. 显示逻辑改为 resolveSessionModelSelection

当前用的是：

- `resolveAgentModelSelection(...)`

建议抽出新的选择逻辑：

```ts
resolveSessionModelSelection({
  sessionModelOverride,
  agentModel,
  availableModels,
  fallbackModel,
  engine,
})
```

优先级：

1. `sessionModelOverride`
2. `agentModel`
3. `fallbackModel`

并区分两类异常：

- session override 无效
- agent model 无效

这样 UI 才能给对提示，不会把“session override 丢失”误报成 agent 配置问题。

## 推荐实施顺序

### 第一阶段：打通主链路

1. 给 `cowork_sessions` 增加 `model_override`
2. 扩展 `CoworkSession` 类型
3. 新增 `openclaw.session.patch`
4. 在 `openclawRuntimeAdapter` 内实现通用 `patchSession(...)`
5. 有 session 时，两个模型选择器都改成操作 session override

这一阶段完成后，已有会话内切模型就会符合预期。

### 第二阶段：补齐新会话空态体验

1. 为 `__home__` 草稿增加 `draftSessionModelOverride`
2. 新建会话时先 patch 再首发消息
3. 空态模型显示改为草稿 override

这一阶段完成后，整个 Cowork 区模型语义才彻底统一为“会话级”。

### 第三阶段：补齐可视化与容错

1. UI 增加“已覆盖当前会话模型”的提示
2. 增加“恢复为 agent 默认模型”的 clear 操作
3. 无效 override 时展示明确错误
4. 给切换后刷新失败、gateway catalog 不可用等情况补错误提示

## 风险与注意点

### 1. 不要把 session override 和 agent 默认模型混写

最重要的边界：

- Cowork 会话内的模型切换，只能改 session
- Agent 管理页里的模型设置，才改 `agent.model`

### 2. `sessions.patch` 可能失败于模型校验

OpenClaw 会校验：

- 空字符串非法
- model catalog 不可用时会返回 unavailable
- 不在 allowlist 内的 model 会被拒绝

所以 renderer 不能做“乐观更新后不回滚”，应该以后端返回成功为准。

### 3. 需要考虑 currentSession 为空但已有 draft 的情况

这是当前交互最容易被忽略的缺口。只改“已存在 session”路径，会导致：

- 进入新会话前选模型没有效果
- 用户仍然觉得模型切换是坏的

### 4. 如果保留 header 和 input 两处选择器，必须共用同一状态源

否则会出现：

- 顶部显示 session override
- 底部还在显示 agent model

或相反。

### 5. `effectiveModel` 最好不要持久化

因为它是导出值，不是真实 source of truth。

真实 source 建议只有：

- `session.modelOverride`
- `agent.model`
- `globalSelectedModel`

## 最小可行改造

如果只做最小闭环，我建议范围控制在：

1. 数据层新增 `model_override`
2. OpenClaw runtime 新增通用 `patchSession`
3. `currentSession` 存在时，Cowork 顶部和输入框模型切换都改用 session patch
4. Agent 设置页保持不变

这个版本已经能解决你提的核心问题：

- 当前会话改模型，不再污染 agent 默认模型

## 建议变更文件清单

高优先级：

- [src/renderer/components/cowork/CoworkPromptInput.tsx](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/components/cowork/CoworkPromptInput.tsx)
- [src/renderer/components/cowork/CoworkView.tsx](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/components/cowork/CoworkView.tsx)
- [src/renderer/services/cowork.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/services/cowork.ts)
- [src/renderer/types/cowork.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/types/cowork.ts)
- [src/renderer/types/electron.d.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/renderer/types/electron.d.ts)
- [src/main/preload.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/preload.ts)
- [src/main/main.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/main.ts)
- [src/main/coworkStore.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/coworkStore.ts)
- [src/main/libs/agentEngine/types.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/libs/agentEngine/types.ts)
- [src/main/libs/agentEngine/coworkEngineRouter.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/libs/agentEngine/coworkEngineRouter.ts)
- [src/main/libs/agentEngine/openclawRuntimeAdapter.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/libs/agentEngine/openclawRuntimeAdapter.ts)

建议新增：

- [src/main/openclawSession/constants.ts](/Users/yunxin/Documents/open-source/LobsterAI/src/main/openclawSession/constants.ts)

可选优化：

- `src/renderer/components/cowork/agentModelSelection.ts`
  可改名或新增 `sessionModelSelection.ts`

## 结论

当前实现确实是“改当前 agent 的模型”，不是“改当前会话的模型”。从 OpenClaw 的现有能力看，正确方向不是继续沿用 `agentService.updateAgent()`，而是让 LobsterAI 显式接入 `sessions.patch`，并在本地会话结构里持久化 `model_override`。

最合理的目标架构是：

- `agent.model` 负责默认值
- `session.modelOverride` 负责会话覆盖
- Cowork 内模型选择器优先操作 session override
- Agent 管理界面继续操作 agent 默认模型
