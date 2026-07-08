# IM 会话模型双向同步修复设计文档

## 1. 概述

### 1.1 问题

用户通过 OpenClaw-backed IM channel 对话时，同一个 IM 对话的模型状态在 LobsterAI UI、OpenClaw runtime 和模型回复文本之间可能出现不一致。本次可复现样本来自微信，但问题机制基于通用 channel session/mapping，预计会影响所有使用 OpenClaw channel session 的 IM 平台。

1. 在 LobsterAI 中 IM 对话记录下方的模型选择列表从 `deepseek-v4-flash` 切到 `qwen3.7-max` 后，消息底部展示的实际模型是 `qwen3.7-max`，但在 IM 端询问“你现在是什么模型”时，助手仍回复自己是 `deepseek-v4-flash`。
2. 在 IM 端要求“切成 kimi2.6”后，助手回复已切换，后续实际请求也使用 `kimi-k2.6`，但 LobsterAI 中 IM 对话记录下方的模型选择列表仍显示 `qwen3.7-max`。

用户期望同一个 IM conversation 只有一个当前模型：

- 从 LobsterAI 中 IM 对话记录下方的模型选择列表切换模型后，IM 端询问当前模型应得到刚切换后的模型。
- 从 IM 端发起模型切换后，LobsterAI 中 IM 对话记录下方的模型选择列表也应同步更新。

### 1.2 调研结论

这不是单一的“模型没有切成功”，而是两个问题叠加：

1. **模型自报不可信**：用户在 LobsterAI 中 IM 对话记录下方的模型选择列表切到 Qwen 后，OpenClaw 实际已经用 Qwen 执行请求；助手回复自己还是 DeepSeek，是模型基于旧上下文或历史信息自报错误。
2. **OpenClaw -> LobsterAI 缺少反向同步**：IM 端通过 `session_status` 工具切到 Kimi 后，OpenClaw channel session 已更新并实际使用 Kimi，但 LobsterAI 本地 `cowork_sessions.model_override` 仍保留 Qwen，导致 UI 下拉显示旧模型。

现场日志和本地状态支持该结论：

- 本次微信样本中，15:37:09 附近的运行日志显示 channel session 的实际请求模型是 `qwen3.7-max-YoudaoInner`。
- IM 端要求切到 Kimi 后，OpenClaw session history 中出现 `session_status` 调用，结果包含 `changedModel: true` 和 `modelOverride: lobsterai-server/kimi-k2.6-YoudaoInner`。
- 之后 15:37:25/15:37:30 附近的运行日志显示实际请求模型是 `kimi-k2.6-YoudaoInner`。
- SQLite 中对应 LobsterAI Cowork session 的 `model_override` 仍是 `lobsterai-server/qwen3.7-max-YoudaoInner`。
- 最新消息 metadata 已记录 `model: kimi-k2.6-YoudaoInner`，说明每条消息的实际执行模型和 session 下拉状态已经分叉。

### 1.3 根因

当前存在两个“看起来都像 source of truth”的模型状态：

| 状态来源 | 当前用途 | 问题 |
|---|---|---|
| OpenClaw channel session | IM runtime 实际执行模型；`session_status` 可以修改 | IM 端切换后没有稳定反写 LobsterAI 本地 session |
| `cowork_sessions.model_override` | LobsterAI IM 对话记录下方的模型选择列表显示；UI patch 后本地持久化 | 只覆盖 LobsterAI IM 对话记录模型选择列表发起的切换，不能代表 OpenClaw 侧最新状态 |
| Assistant 文本回复 | 用户在 IM 端看到的“我是什么模型” | 可能来自历史上下文，不可作为权威状态 |
| 消息 `metadata.model` | 单条消息实际执行模型展示 | 只能说明某条消息使用的模型，不能自动等价为当前 session override |

相关现有链路：

1. `CoworkPromptInput` 的模型下拉通过 `resolveAgentModelSelection()` 优先读取 `currentSession.modelOverride`。
2. 用户在 LobsterAI 中 IM 对话记录下方的模型选择列表切换模型时，renderer 乐观更新本地 session，并调用 `coworkService.patchSession(sessionId, { model })`。
3. 主进程 `openclaw.session.patch` 调用 runtime `patchSession()`，并把 `patch.model` 写回 `cowork_sessions.model_override`。
4. `OpenClawRuntimeAdapter.patchSession()` 已优先命中 IM 的真实 `openclaw_session_key`，因此 UI -> OpenClaw 的 patch 路径基本正确。
5. `pollChannelSessions()` 只负责发现 channel session、创建 mapping、同步上下文等，不同步 session 级模型。
6. `reconcileWithHistory()` 会同步消息和每条 assistant 消息的 `metadata.model`，但不会更新 `cowork_sessions.model_override`。
7. IM 端通过 `session_status` 切换模型时，只改变 OpenClaw channel session；LobsterAI 本地 session 未被通知。

## 2. 用户场景

### 场景 A：从 LobsterAI IM 对话记录下方切换模型

**Given** 用户打开一个已绑定 IM 平台的 OpenClaw-backed IM 对话，当前模型是 `deepseek-v4-flash`

**When** 用户在 LobsterAI 中 IM 对话记录下方的模型选择列表中选择 `qwen3.7-max`

**Then** LobsterAI 下拉显示 `qwen3.7-max`

**And** 后续 IM 消息实际使用 `qwen3.7-max`

**And** 用户在 IM 端询问当前模型时，助手应基于权威 session 状态回复 `qwen3.7-max`

### 场景 B：从 IM 端切换模型

**Given** IM 对话当前模型是 `qwen3.7-max`

**When** 用户在 IM 端说“切成 kimi2.6”

**Then** OpenClaw channel session 的模型切到 `kimi-k2.6`

**And** 后续 IM 消息实际使用 `kimi-k2.6`

**And** LobsterAI 中 IM 对话记录下方的模型选择列表同步显示 `kimi-k2.6`

### 场景 C：查询当前模型

**Given** 用户通过 LobsterAI 或 IM 端切换过当前 IM 会话模型

**When** 用户问“你现在是什么模型”、“当前用的哪个模型”

**Then** 助手不依赖历史上下文猜测，而是读取权威 session 状态或可信注入上下文后回答

### 场景 D：没有 session override

**Given** 某个 IM channel session 没有显式模型 override，运行时使用 agent/default 模型

**When** LobsterAI 同步该 session 状态

**Then** 本地 `cowork_sessions.model_override` 应清空，让下拉自然回落到 agent/default 模型，而不是保留旧 override

## 3. 功能需求

### FR-1：定义 IM 当前模型的权威来源

对 OpenClaw 原生 IM channel session，当前模型以 OpenClaw session 状态为 runtime authority。

LobsterAI 的 `cowork_sessions.model_override` 是 UI 和本地持久化镜像，必须跟随 OpenClaw channel session 的选中模型更新。

### FR-2：保留 LobsterAI IM 对话记录模型选择列表 -> OpenClaw 的现有切换能力

用户从 LobsterAI 中 IM 对话记录下方的模型选择列表切换模型时，继续通过 `openclaw.session.patch` 修改真实 OpenClaw channel session，并写回本地 `cowork_sessions.model_override`。

patch 成功后应尽量使用 OpenClaw 返回或随后读取到的 canonical model ref 校准本地值，避免 UI 保留未规范化的 provider/model 写法。

### FR-3：补齐 OpenClaw -> LobsterAI 的反向模型同步

当 OpenClaw channel session 的模型由 IM 端、OpenClaw 工具或其他 runtime 内部路径修改后，LobsterAI 应在 channel polling、history reconcile 或 turn completion 中发现该变化，并更新对应 Cowork session 的 `model_override`。

同步应触发 renderer session 刷新，让当前 IM 对话页和会话列表读取到新模型。

### FR-4：当前模型查询必须读取可信状态

用户问当前模型时，助手不能仅根据历史对话或模型自我认知回答。

IM/system prompt 或工具路由应要求这类问题读取 `session_status`，或使用 LobsterAI/OpenClaw 注入的可信 `currentModel` 上下文。

### FR-5：消息级模型 metadata 继续保留

每条 assistant 消息的 `metadata.model` 仍表示该消息实际使用的模型。它可以辅助诊断和回放展示，但不应替代 session 级当前模型状态。

## 4. 实现方案

### 4.1 Session 模型同步入口

新增一个 runtime adapter 内部同步方法，例如：

```typescript
private async syncChannelSessionModelOverride(options: {
  coworkSessionId: string;
  openClawSessionKey: string;
  modelRef: string | null;
  source: 'sessions-list' | 'history' | 'session-status';
}): Promise<void>
```

该方法负责：

1. 规范化 `modelRef` 为 LobsterAI 使用的 OpenClaw model ref，例如 `lobsterai-server/kimi-k2.6-YoudaoInner`。
2. 当 `modelRef` 有值且不同于 `cowork_sessions.model_override` 时，更新本地 session。
3. 当 OpenClaw 明确表示无 session override 时，清空本地 `model_override`。
4. 更新时避免无意义刷新 `updatedAt`，除非现有 store API 无法区分；若需要，优先新增或复用不影响会话排序的更新路径。
5. 发出 `cowork:sessions:changed` 或现有等价通知，确保 renderer 刷新。

### 4.2 从 `sessions.list` 同步模型

优先在 `OpenClawRuntimeAdapter.pollChannelSessions()` 读取 OpenClaw `sessions.list` 返回的 session row 中的模型字段。

采用顺序：

1. 如果 row 暴露 session override，例如 `modelOverride`、`model` 或等价字段，使用该字段同步。
2. 如果 row 明确表示无 override，则清空本地 `model_override`。
3. 如果 row 不包含模型字段，不在该路径做推断，交给 history/session-status fallback。

这个路径延迟最多一个 polling 周期，适合处理 IM 端自然语言切模型后的 UI 下拉同步。

### 4.3 从 history reconcile 补充同步

如果 `sessions.list` 不暴露模型字段，或为了缩短 turn 后同步延迟，`reconcileWithHistory()` 可以从 OpenClaw history 中提取可信模型状态：

1. 优先读取 OpenClaw custom entry 中的 `model-snapshot` 或 `session_status` 工具结果。
2. 当确认存在 `changedModel: true` 和新的 `modelOverride` 时，同步 session override。
3. 如果没有 session 级快照，仅有 assistant `entry.model`，只在满足“这是最新 assistant 且 OpenClaw 无更权威字段”的情况下作为 fallback。
4. 不从 assistant 文本内容解析模型名。

### 4.4 UI 切换成功后的校准

`coworkService.patchSession()` 成功返回后，renderer 仍按现有逻辑用主进程返回的 session 覆盖 optimistic 状态。

主进程 patch 成功后可增加一次轻量校准：

1. 优先使用 OpenClaw `sessions.patch` 返回值中的 canonical model。
2. 如果 patch 返回值没有模型字段，保持当前 `patch.model` 写回逻辑。
3. 随后的 `pollChannelSessions()` 或 `reconcileWithHistory()` 仍可再次校准。

### 4.5 当前模型问题的回答策略

在 OpenClaw IM 相关 prompt、tool routing 或 LobsterAI 注入上下文中增加规则：

```text
When the user asks what model you are currently using, read the current session
status or trusted currentModel context. Do not answer from memory or prior
conversation text.
```

推荐策略：

1. 首选让模型调用 `session_status` 读取当前 session 模型。
2. 若当前 OpenClaw 能稳定注入可信 `currentModel`，可用该值直接回答。
3. 回复用户时展示用户可识别名称，例如 `Qwen 3.7 Max` 或 `Kimi K2.6`，必要时带 provider/model id。

### 4.6 不采用的方案

| 方案 | 不采用原因 |
|---|---|
| 只修正助手回答文本 | 只能解决“问模型答错”，不能解决 LobsterAI 下拉不更新 |
| 只用最新 assistant `metadata.model` 覆盖 session override | metadata 是单条消息事实，不一定代表当前 session override，尤其在默认模型和临时运行模型场景下会误判 |
| 给 `im_session_mappings` 新增 model 字段 | 模型属于 session 状态，已有 `cowork_sessions.model_override` 更适合承载 UI 镜像；mapping 表只应保存 conversation/session/key/agent 关系 |
| 从 assistant 回复文本解析模型名 | 文本可能自报错误、同义词不稳定、多语言混杂，不能作为权威数据 |
| 每次渲染下拉都实时请求 OpenClaw | 会增加 UI 延迟和 runtime 耦合，且不能替代本地持久化 |

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| LobsterAI IM 对话记录下方的模型选择列表切换模型 | 保持现有 `openclaw.session.patch`，patch 真实 channel key，并写回本地 override |
| IM 端通过 `session_status` 切换模型 | OpenClaw session 成功后，通过 polling/history 同步回本地 `model_override` |
| IM 端切换模型但 LobsterAI 当前未打开该会话 | 后台同步本地 session，用户下次打开时下拉已是新模型 |
| `sessions.list` 无模型字段 | 使用 history 中的 session 级快照或 `session_status` 工具结果作为 fallback |
| 只有 assistant `metadata.model` | 默认只用于消息展示；除非没有更权威字段且是最新运行结果，才作为保守 fallback |
| OpenClaw 表示无 session override | 清空本地 `model_override`，让 UI 回落到 agent/default 模型 |
| 本地 override 与 OpenClaw override 相同 | 不写 SQLite，不触发会话排序变化 |
| OpenClaw 返回未知模型 ref | 保留原始 ref 用于状态一致性；UI 若无法解析，应沿用现有未知模型展示/降级逻辑 |
| 模型查询问题 | 强制读取 session status 或可信 currentModel，不基于历史文本猜测 |
| 多 IM 平台 | 逻辑基于 channel session key 与 mapping，不应只对微信 hardcode |

## 6. 涉及文件

核心代码：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
  - `pollChannelSessions()`
  - `reconcileWithHistory()`
  - `patchSession()`
  - 可新增 `syncChannelSessionModelOverride()`
- `src/main/libs/openclawChannelSessionSync.ts`
  - 确认 channel session key 与 Cowork session mapping 可用于反向同步定位
- `src/main/coworkStore.ts`
  - 需要可更新 `model_override`，并尽量避免无意义刷新 `updatedAt`
- `src/main/im/imStore.ts`
  - 不新增 model 字段；继续提供 `openclaw_session_key` 映射
- `src/main/main.ts`
  - `openclaw.session.patch` 成功后的本地写回和事件通知校准
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
  - 确认模型下拉继续读取 `currentSession.modelOverride`
- `src/renderer/components/cowork/agentModelSelection.ts`
  - 保持 session override 优先级
- `src/renderer/services/i18n.ts`
  - 如果新增用户可见错误或状态提示，补齐中英文文案

可能涉及 OpenClaw 版本化 patch：

- 如果 `session_status` 问题或可信 `currentModel` 注入只能在 OpenClaw 内部完成，应新增 `scripts/patches/<openclaw.version>/...patch`，不要直接修改 sibling OpenClaw checkout 作为最终状态。

测试：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- `src/main/libs/openclawChannelSessionSync.test.ts`
- `src/main/im/imStore.test.ts`
- `src/renderer/components/cowork/agentModelSelection.test.ts`
- 如涉及 renderer 状态同步，可补 `src/renderer/store/slices/coworkSlice.test.ts`

## 7. 测试计划

### 7.1 单元测试

1. `pollChannelSessions()` 从 channel session row 读到 `modelOverride` 后，更新对应 Cowork session 的 `model_override`。
2. `pollChannelSessions()` 读到无 override 状态后，清空旧的 `model_override`。
3. `reconcileWithHistory()` 解析到 `session_status changedModel: true` 后，更新本地 `model_override`。
4. `reconcileWithHistory()` 只有 assistant 文本声称某模型时，不更新 session override。
5. `reconcileWithHistory()` 保留 assistant `metadata.model` 作为单条消息展示，不与 session override 混淆。
6. 本地 override 与 OpenClaw override 相同时，不重复写入，不刷新会话排序。
7. LobsterAI IM 对话记录下方的模型选择列表发起 `patchSession()` 后仍能 patch 真实 IM `openclaw_session_key`，保持 2026-05-06 修复不回退。
8. 当前模型查询 prompt/tool routing 能覆盖“你是什么模型/当前模型/用的哪个模型”的问题。

推荐运行：

```bash
npm test -- openclawRuntimeAdapter openclawChannelSessionSync imStore
npm test -- agentModelSelection
```

### 7.2 类型与 lint

涉及 TypeScript 文件后运行：

```bash
npm run compile:electron
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <touched-files>
```

### 7.3 手动验证

1. 绑定微信或任一 OpenClaw-backed IM 平台，打开某个 IM 对话。
2. 在 LobsterAI IM 对话记录下方的模型选择列表切到 `qwen3.7-max`，IM 端继续发消息，确认日志和消息底部均为 Qwen。
3. 在 IM 端问“你现在是什么模型”，确认回复来自 session status/currentModel，回答 Qwen。
4. 在 IM 端要求切到 `kimi2.6`，确认下一轮日志和消息底部为 Kimi。
5. 回到 LobsterAI IM 对话页，确认下拉同步显示 Kimi。
6. 再从 LobsterAI IM 对话记录下方的模型选择列表切回其他模型，确认 IM 端后续实际请求和模型查询回复一致。
7. 如条件允许，至少在另一个 OpenClaw-backed IM 平台重复核心切换流程，确认没有平台特判依赖。
8. 重启应用后打开同一 IM 对话，确认下拉仍与 OpenClaw channel session 状态一致。

## 8. 验收标准

1. LobsterAI IM 对话记录下方的模型选择列表发起的模型切换能继续命中真实 OpenClaw channel session。
2. IM 端发起的模型切换能同步更新 LobsterAI 中 IM 对话记录下方的模型选择列表。
3. 当前模型查询不再依赖模型自报或历史上下文，回答与 session 状态一致。
4. 消息底部展示的单条消息模型 metadata 保持准确。
5. `cowork_sessions.model_override` 不再长期停留在 OpenClaw channel session 的旧模型。
6. 无 session override 时，本地 override 被清空，UI 回落到 agent/default 模型。
7. 多 IM 平台使用同一 channel session 同步机制，不出现微信专用 hardcode。
8. 不新增 `im_session_mappings` 的模型字段，不破坏既有 conversation/session/key 映射语义。
9. 相关单元测试、Electron TypeScript 编译和 touched-file ESLint 通过。
