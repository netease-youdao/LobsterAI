# LobsterAI Cowork Steer 设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI Cowork 当前把一次用户提交视为一个完整 turn。Agent 运行期间，
输入框通常进入 busy 状态，用户只能停止当前任务，或等任务结束后再发送下一条
follow-up。这会带来几个协作问题：

- 用户发现 Agent 正在偏离方向时，只能强制停止，丢失当前上下文和已完成工作。
- 用户想追加约束、纠正误解、补充遗漏信息时，只能等待当前任务结束。
- 长任务中，用户的即时反馈无法进入当前推理和后续工具调用，只能成为下一轮。
- 普通“排队 follow-up”与“立即调整当前任务方向”在产品上没有区分。

Codex 中的 `Steer` 能力解决的是同一问题：在一个 active turn 仍在运行时，
用户可以提交一段 steering instruction，让运行中的 Agent 在下一个可接收输入的
边界采纳新方向。它不是普通新会话消息，也不是强制中断重试，而是对当前 turn 的
同轮追加输入。

LobsterAI 需要在 Cowork 中实现类似能力，并与当前 OpenClaw runtime、Cowork
消息持久化、输入框 busy 状态、权限弹窗、计划模式、目标模式、IM 渠道和
scheduled task 等现有状态机兼容。

### 1.2 术语

- **Steer**：用户在 Agent 当前 turn 运行期间提交的同轮方向修正。
- **普通 follow-up**：当前 turn 结束后才作为新用户 turn 提交的后续消息。
- **Pending steer**：已由用户提交，但尚未被 runtime 确认进入当前 active turn
  的 steer。
- **Rejected steer**：runtime 返回当前 turn 不支持 steer 后，客户端保留并在
  本轮结束后转为普通 follow-up 的 steer。
- **Active turn**：OpenClaw 当前正在执行、可被追加输入的运行中 turn。
- **Steer boundary**：runtime 能安全接收 pending input 的边界，例如模型输出后、
  工具调用结果后或 runtime 内部 mailbox delivery 检查点。

## 2. 目标

1. 在 Cowork 输入框中提供运行中可用的 `Steer` 提交入口。
2. 让用户在不中断当前任务的情况下追加方向修正、限制条件或补充信息。
3. 明确区分 `Steer` 与普通 queued follow-up，避免用户误以为所有运行中输入都会
   立即生效。
4. 在 OpenClaw 支持同轮 steering 时，优先调用 runtime 的 steer 能力。
5. 在 runtime 当前 turn 不支持 steering 时，自动降级为本轮结束后的 follow-up。
6. 在 UI 中展示 pending/rejected steer 状态，用户能理解消息何时生效。
7. 支持用户选择“立即中断并发送 pending steers”，保留对紧急纠偏的控制。
8. 保持现有停止任务、权限审批、计划模式、目标模式、附件和技能选择行为不回归。
9. 为 IM/自动任务等非主输入框来源保留可扩展接口，但第一版只在 Cowork 桌面输入
   框中启用。
10. 所有用户可见字符串纳入中英文 i18n。

## 3. 非目标

- 不实现 Codex App 前端的完整交互复刻；LobsterAI 采用自身输入框布局和视觉语言。
- 不把 steer 当作普通 message 立即插入历史对话气泡；pending 状态应显示在输入区
  附近，直到 runtime 确认或降级。
- 不要求所有 turn 类型都支持 steer。计划确认、review、compact、用户 shell、
  媒体生成轮次等可以选择拒绝 steering。
- 不让 steer 绕过权限审批、沙箱策略、计划模式工具限制或用户 stop 操作。
- 不新增独立 agent runtime。OpenClaw 仍是唯一运行时。
- 不为第一版实现跨设备或 IM 渠道的 steer 按钮。
- 不在第一版修改 OpenClaw 源码，除非确认当前 LobsterAI 侧没有可用集成点。

## 4. 产品语义

### 4.1 Steer 与 Follow-up 的差异

```text
普通 follow-up
  用户输入 -> 当前 turn 继续运行 -> turn 完成 -> 新 turn 开始

Steer
  用户输入 -> 当前 turn 仍运行 -> runtime 接收 steer -> 当前 turn 后续步骤采纳
```

用户点击或选择 `Steer` 时，输入框 placeholder 使用类似
“补充当前任务的方向...”的文案，提交按钮显示 `Steer` 状态。提交后：

- 如果当前 session 没有运行中 turn，按普通提交处理。
- 如果当前 session 有运行中 turn 且 runtime 支持 steer，发送 steer。
- 如果 runtime 暂时无法确认 active turn，先保存为 pending steer，等待下一个
  active turn id 或运行态事件。
- 如果 runtime 明确拒绝 steer，移动到 rejected steer 队列，本轮结束后自动作为
  follow-up 发送或恢复到输入框。

### 4.2 入口与可见状态

第一版建议在 Cowork 输入框运行中状态展示两个入口：

1. **Stop**：保留现有停止任务按钮。
2. **Steer**：在运行中允许输入和提交 steering instruction。

当用户点击 `Steer` 后：

- 输入框进入 steer composing 状态。
- 附件、文件上传和图片粘贴默认禁用，避免运行中追加复杂 payload。
- 技能/kit 选择保持只读展示，不允许在 steer 中切换。
- Enter 或发送按钮提交 steer。
- Esc 退出 steer composing 状态并恢复运行中只读输入框。

### 4.3 Pending Preview

提交 steer 后，在输入框上方显示紧凑 preview：

```text
将于下个工具/结果边界提交
↳ 请先不要改数据库，只生成迁移计划
Esc 立即中断并发送
```

如果 runtime 拒绝同轮 steering：

```text
本轮结束后提交
↳ 请先不要改数据库，只生成迁移计划
```

普通 queued follow-up 继续使用独立区域，文案不能和 steer 混在一起。显示顺序：

1. pending steer；
2. rejected steer；
3. ordinary queued follow-up。

### 4.4 立即中断并发送

当存在 pending steer 且当前任务仍在运行时，用户可以点击 preview 中的操作或按
快捷键触发：

1. 发送 stop/interrupt 到 runtime；
2. 等当前 turn 进入 interrupted 状态；
3. 将 pending steers 合并为一条普通用户消息；
4. 立即开始新 turn。

这个行为适用于用户认为“继续跑下去会浪费时间或造成风险”的场景。它必须和普通
Stop 区分：普通 Stop 只停止任务并恢复输入，Steer interrupt 是“停止并发送已写好
的 steer”。

## 5. 系统不变量

### INV-1: 普通提交不受影响

未处于 steer composing 且没有 pending steer 时：

- Enter/Send 行为保持当前逻辑。
- 运行中普通输入仍按现有 busy/queue 策略处理。
- 不发送 steer 类型 IPC。
- 不新增用户消息 metadata。

### INV-2: Steer 必须绑定 active turn

每个 steer 请求必须带上当前 runtime active turn 标识或等价 precondition。若
runtime 返回 active turn mismatch：

- 最多使用 runtime 返回的新 active turn id 重试一次；
- 重试失败后不得静默丢弃；
- 保留为 pending 或 rejected，并在 UI 展示状态。

### INV-3: 不绕过安全策略

Steer 只是追加用户意图，不提升权限：

- 不能自动批准权限弹窗。
- 不能改变 sandbox mode。
- 不能绕过 plan mode 的只读限制。
- 不能在 stop 后继续执行已被用户终止的工具。

### INV-4: Pending steer 不作为已完成历史

Pending steer 在 runtime 确认前不应写成普通 user message 气泡。它可以进入
本地 UI state 或 message metadata cache，但不能让历史看起来像已经被 Agent
处理过。

### INV-5: 降级必须可见

当同轮 steering 被拒绝时，用户必须看到 steer 已降级为本轮结束后的 follow-up。
不得在后台悄悄丢弃，也不得误显示为“已发送到当前 turn”。

### INV-6: 完成后清理运行态

当当前 turn completed、interrupted、failed 或 session 切换时：

- 已被 runtime 接收并入历史的 pending steer 从 preview 中移除。
- rejected steer 按策略提交或恢复到输入框。
- session 切换不得把 A 会话的 pending steer 带到 B 会话输入框。

### INV-7: 计划模式与 Steer 不冲突

如果当前 turn 是计划模式：

- steer 可以用于“调整计划方向”。
- steer 不得让模型开始写文件。
- 如果用户 steer 内容是“按计划实现”，不能作为同轮 steer 直接注入。它必须走计划
  确认语义：先完成/中断当前计划 turn，再以默认模式提交实现请求。

### INV-8: Goal、Plan、Steer 输入模式必须互斥

同一时间输入框只能处于一个 composing 模式：

- `Normal`：普通 follow-up。
- `Goal`：`/goal` 控制指令。
- `Plan`：下一次普通提交注入 plan mode system prompt。
- `Steer`：运行中给 active turn 的方向修正。

切换规则必须显式：

- 开启 Goal input 时，现有代码会关闭 Plan mode，并把 awaiting plan confirmation
  标记为 handled。Steer 不应改变这个行为。
- 开启 Plan mode 时，现有代码会关闭 Goal input。Steer 不应让 Goal 与 Plan 同时
  处于 composing。
- 开启 Steer composing 时，不修改普通 draft 的 Plan/Goal 状态；Steer draft 使用
  独立 state 保存，退出后恢复原普通 draft。
- 如果 Goal input 已激活，运行中 Enter 仍优先提交 Goal command，而不是 Steer。

## 6. 架构设计

### 6.0 Codex 参考实现拆解

Open-source Codex 把 Steer、Plan、Goal 分在三个不同层次：

1. **Steer 是 active turn 输入**：app-server 协议提供 `turn/steer`，参数包含
   `threadId`、`input`、`clientUserMessageId` 和必填的 `expectedTurnId`。Core 的
   `Session::steer_input()` 要求存在 active turn，并校验 expected turn id。
2. **Plan 是 collaboration mode**：`turn/start` 可以携带 `collaborationMode`。
   Plan mode 是当前 turn 的运行策略，不是用户消息队列。Codex 还会在 extension
   idle work 中拒绝 Plan mode 下自动启动新 turn。
3. **Goal 是 thread-level state**：Codex app-server 有 `thread/goal/set|get|clear`
   和 `thread/goal/updated|cleared` notification。TUI 的 `/goal` 不走普通
   `turn/start`，而是发 goal state RPC。
4. **TUI 只生成 UserTurn op，App 层决定 start 还是 steer**：当有 active turn id
   时，App 层优先调用 `turn/steer`；没有 active turn 或 active turn race 消失时，
   才回退到 `turn/start`。
5. **Steer 不直接进历史气泡**：TUI 在 agent turn running 时设置
   `renderInHistory=false`，把用户输入放进 `pendingSteers` preview；普通 user
   message 只有 `turn/start` 时才进入历史展示。
6. **不可 steer 的 turn 降级可见**：Review/Compact 返回
   `activeTurnNotSteerable`，TUI 把 pending steer 移到 `rejectedSteersQueue`，预览为
   “本轮结束后提交”。
7. **Pending preview 三段分区**：Codex UI 顺序展示 pending steers、rejected
   steers、queued follow-up inputs，并提供 “interrupt and send immediately”。
8. **Plan 实现确认不是 steer**：Plan mode 完成后弹出 “Implement this plan?”，确认
   后以 Default collaboration mode 提交 `Implement the plan.`，而不是把实现请求注入
   到当前 Plan turn。
9. **Goal 与 interrupt 有联动**：TUI 在用户中断运行任务时会暂停 active goal，避免
   长目标在用户明确打断后继续自动推进。

对 LobsterAI 的启发：

- 输入框不应直接把 “running 下的 Enter” 改成普通发送；它应该产出明确 submit intent。
- Steer 应复用普通消息构建能力，但必须有独立的 UI/history policy。
- Plan/Goal/Steer 不应混成一个 boolean；需要显式模式与显式路由。
- active turn id race、non-steerable、interrupt-and-send 都应是 first-class 状态。

### 6.1 Renderer

主要涉及：

- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/services/cowork.ts`
- `src/renderer/store/slices/coworkSlice.ts`
- `src/renderer/services/i18n.ts`

新增 renderer 状态：

```ts
export const CoworkInputMode = {
  Normal: 'normal',
  Goal: 'goal',
  Plan: 'plan',
  Steer: 'steer',
} as const;
export type CoworkInputMode = typeof CoworkInputMode[keyof typeof CoworkInputMode];

export const CoworkSteerStatus = {
  Pending: 'pending',
  Accepted: 'accepted',
  Rejected: 'rejected',
  SendingAfterInterrupt: 'sending_after_interrupt',
} as const;
export type CoworkSteerStatus =
  typeof CoworkSteerStatus[keyof typeof CoworkSteerStatus];

export interface CoworkPendingSteer {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
  status: CoworkSteerStatus;
  targetTurnId?: string;
  error?: string;
}
```

建议在 `coworkSlice` 中新增 session-scoped steer 状态，而不是复用
`draftPrompts[draftKey]`：

```ts
export interface CoworkSteerDraftState {
  draftsBySessionId: Record<string, string>;
  pendingBySessionId: Record<string, CoworkPendingSteer[]>;
  rejectedBySessionId: Record<string, CoworkPendingSteer[]>;
}
```

原因：

- 当前 `CoworkPromptInput` 的 `value` 会通过 300ms debounce 写入普通
  `draftPrompts`。
- Goal input 也复用同一个 `value`，并通过 `goalInputReturnDraftRef` 恢复普通 draft。
- Plan mode 存在 `draftCollaborationModes[draftKey]` 和 `planConfirmations`。
- 如果 Steer 也复用 `value`，会污染普通 draft、Plan approval 文案和 Goal draft。

实现建议：

- `value` 继续代表普通/Goal/Plan 输入。
- `steerValue` 或 Redux `steerDrafts[sessionId]` 只在 Steer composing 时绑定
  textarea。
- `handleTextareaChange` 根据当前 submit intent 写入 `value` 或 `steerValue`。
- `handleSubmit` 先解析 submit intent，再分别走 goal / steer / normal-plan 分支。
- `canSubmit`、send button title、placeholder、附件禁用态都从 submit intent 派生。

Renderer 责任：

1. 允许运行中进入 steer composing。
2. 运行中只允许提交 steer，不允许新增附件或切换模型/kit/skill。
3. 调用 `coworkService.submitSteer()`。
4. 展示 pending/rejected steer preview。
5. 处理“立即中断并发送”操作。
6. 将 stream status event 映射到清理 pending state。

输入模式优先级：

```text
Goal composing > Steer composing > Plan draft mode > Normal draft
```

含义：

- Goal composing 是显式控制会话目标，运行中也允许通过 `sessions.goal` 提交。
- Steer composing 只在 session running 时可用，且使用独立 steer draft。
- Plan draft mode 影响下一次普通提交的 system prompt，不自动影响 steer。
- Normal draft 保存用户普通 follow-up，不因进入/退出 steer 而丢失。

当前 `CoworkPromptInput` 已经让 Goal 与 Plan 互斥：开启 Goal 会关闭 Plan，开启 Plan
会重置 Goal input。Steer 应作为第三个 transient composing mode，而不是复用
`goalInputActive` 或 `draftCollaborationMode`。

更推荐的派生模型：

```ts
type CoworkSubmitIntent =
  | { kind: 'goal'; canRunWhileStreaming: true }
  | { kind: 'steer'; canRunWhileStreaming: true }
  | { kind: 'plan'; canRunWhileStreaming: false }
  | { kind: 'normal'; canRunWhileStreaming: false };
```

`handleKeyDown` 和 `handleSubmit` 都应使用同一个 `resolveSubmitIntent()`，避免目前
键盘入口和按钮入口各自判断 streaming 的逻辑继续分叉。

### 6.2 Shared IPC

新增共享常量，避免裸字符串：

```ts
export const CoworkIpcChannel = {
  // existing...
  SubmitSteer: 'cowork:submit-steer',
  InterruptAndSubmitSteers: 'cowork:interrupt-and-submit-steers',
} as const;
```

请求/响应类型：

```ts
export interface CoworkSubmitSteerRequest {
  sessionId: string;
  text: string;
  clientSteerId: string;
}

export interface CoworkSubmitSteerResponse {
  success: boolean;
  status: 'accepted' | 'pending' | 'rejected' | 'queued_follow_up';
  activeTurnId?: string;
  error?: string;
}
```

Stream event：

```ts
export interface CoworkSteerUpdateEvent {
  sessionId: string;
  clientSteerId: string;
  status: CoworkSteerStatus;
  activeTurnId?: string;
  error?: string;
}
```

### 6.3 Main Process

主要涉及：

- `src/main/main.ts`
- `src/main/libs/agentEngine/coworkEngineRouter.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/coworkStore.ts`
- `src/shared/cowork/*`

Main 责任：

1. 校验 session 存在且属于 OpenClaw runtime。
2. 查询或缓存当前 session 的 active turn / running state。
3. 将 steer 交给 OpenClaw adapter。
4. 根据 adapter 返回结果发出 `CoworkSteerUpdateEvent`。
5. 在 runtime 不支持 steer 时降级为本地 queued follow-up。
6. 在 session stop、completed、failed 时清理或转发 pending steer。

### 6.4 OpenClaw Runtime Adapter

第一版优先走 OpenClaw 原生 active-run queue / steering 能力。如果 OpenClaw
gateway 暴露类似 Codex `turn/steer`、`chat.steer`、`agent` active-run queue
fallback，或可公开封装 `queueEmbeddedAgentMessageWithOutcomeAsync(...,
{ steeringMode: "all" })` 的 RPC，LobsterAI 应在 adapter 内封装为：

```ts
interface CoworkAgentRuntime {
  submitSteer?(params: {
    sessionId: string;
    sessionKey: string;
    activeTurnId: string;
    text: string;
    clientSteerId: string;
  }): Promise<CoworkRuntimeSteerResult>;
}
```

注意：不要仅凭方法名接入 `sessions.steer`。当前 OpenClaw 源码中
`sessions.steer` 走的是 `handleSessionSend(..., interruptIfActive: true)`，会先
中断 active run 再 `chat.send` 新消息，更接近“interrupt and send”，不是 Codex
截图里的同轮 steer。LobsterAI 的 `Steer` 主路径必须保持当前 turn 继续运行，只
在用户选择“立即中断并发送”时才调用 abort/stop。

如果当前 pinned OpenClaw 还没有可用的同轮 steering RPC：

- Phase 1 可以只实现 UI 与本地 rejected/queued follow-up 降级，不宣称同轮生效。
- 或使用 OpenClaw 版本 scoped patch 增加一个明确的 session active-run queue RPC。
- 不允许通过向 transcript 文件写入文本等脆弱方式模拟 steer。

### 6.5 Active Turn Tracking

Adapter 需要维护 session 级 active turn state：

```ts
interface CoworkActiveTurnState {
  sessionId: string;
  sessionKey: string;
  activeTurnId?: string;
  kind?: 'regular' | 'review' | 'compact' | 'unknown';
  startedAt?: number;
  updatedAt: number;
}
```

来源优先级：

1. OpenClaw stream event 中的 turn id / run id。
2. OpenClaw `sessions.list` 或 `chat.status` 返回的 running metadata。
3. LobsterAI 本地 streaming state fallback。

没有 reliable active turn id 时，不直接调用 steer；先进入 pending，并等待下一个
runtime event 补齐。

### 6.6 当前 LobsterAI 对接点与异常点

基于当前代码，Steer 不能复用普通继续会话链路，原因如下：

1. `CoworkPromptInput` 在 `isStreaming` 时会阻止普通 submit，并直接提示
   `coworkSessionStillRunning`。键盘发送入口也会在 streaming 状态提前拦截。
2. `CoworkSessionDetail` 传给输入框的是 `isSessionBusy = isStreaming ||
   isContextMaintenance`。这意味着 context maintenance 期间也会被视为运行中，
   steer UI 需要区分“agent turn streaming”和“上下文维护 busy”。
3. 文件、图片、拖拽、粘贴入口目前都以 `disabled || isStreaming ||
   voiceInputLocksEditing` 为禁用条件。Steer composing 需要允许纯文本编辑，但
   继续禁用这些复杂输入。
4. `coworkService.continueSession()` 会乐观设置 `setStreaming(true)` 并调用
   preload 的 `cowork:session:continue`。这条路径不适合 steer，因为它会创建
   普通 user message 和新 turn。
5. `OpenClawRuntimeAdapter.runTurn()` 内部有 `activeTurns.has(sessionId)` guard，
   active turn 存在时直接抛 `Session ... is still running.`。所以即使前端放开
   发送，复用 `continueSession()` 也会失败。
6. `runTurn()` 会先把用户输入写入 `cowork_messages` 并 emit 普通 user message。
   Pending steer 在 runtime 确认前不能走这段持久化逻辑。
7. Goal command 是现有“运行中可发送控制指令”的先例：它走独立 `sessions.goal`
   RPC；active turn 存在时会写入 `pendingGoalContinuations`，在 turn cleanup 后
   再启动普通 continuation。Steer 应采用同样的控制通道思路，但同轮 steering
   成功时不启动新 turn。
8. `cleanupSessionTurn()` 当前只处理 pending goal continuation。Steer 需要在
   同一 cleanup 时机清理 accepted/pending 状态，或把 rejected steer 转为普通
   follow-up。

推荐新增独立链路：

```text
CoworkPromptInput.onSteer
  -> coworkService.submitSteer
  -> preload cowork.submitSteer
  -> main cowork:session:steer handler
  -> CoworkEngineRouter.submitSteer
  -> OpenClawRuntimeAdapter.submitSteer
  -> OpenClaw active-run queue/steer RPC
```

这条链路不得调用 `coworkService.continueSession()`，也不得进入
`OpenClawRuntimeAdapter.runTurn()`。

### 6.7 Goal / Plan / Steer 优先级

实现时建议使用显式输入模式派生函数：

```ts
function resolveCoworkSubmitIntent(state: PromptState): SubmitIntent {
  if (state.goalInputActive) return { kind: 'goal' };
  if (state.steerInputActive) return { kind: 'steer' };
  if (state.isPlanMode) return { kind: 'plan_or_plan_approval' };
  return { kind: 'normal' };
}
```

提交路由：

| 当前状态 | Enter / Send 行为 | 说明 |
| --- | --- | --- |
| Goal composing | `onGoalCommand()` | 运行中也可用，不走 steer。 |
| Running + Steer composing | `submitSteer()` | 不写普通 user message。 |
| Running + Normal draft | 阻止普通发送，提示 session running | 保持当前默认，除非用户点 Steer。 |
| Running + Plan draft mode | 不允许普通 Plan submit；可点 Steer 调整当前计划 turn | 避免在 active turn 中开启第二个 plan turn。 |
| Idle + Plan draft mode | 普通 `onSubmit()` + plan system prompt | 保持现有计划生成流程。 |
| Idle + awaiting plan confirmation + 用户确认执行 | 退出 Plan 后普通 `onContinue()` | 不走 steer。 |
| Running + pending permission | 允许编辑 steer draft，但默认 pending，不自动改变审批 | 用户仍需显式 allow/deny。 |

Goal command 的后续 continuation 目前在 adapter 里通过 `pendingGoalContinuations`
排队，并在 `cleanupSessionTurn()` 正常完成后启动。Steer 的 rejected/follow-up
降级可以借鉴这个机制，但 accepted steer 不能启动新 turn。

### 6.8 LobsterAI 推荐实现形态

第一版建议把实现拆成四层，尽量贴近 Codex 的责任边界：

1. **Prompt Input 层：只做 intent 与 draft**
   - 新增 `steerInputActive` 和 `steerValue`。
   - 点击 `Steer` 时不清空普通 `value`。
   - 退出 Steer 时恢复普通 textarea 内容。
   - Steer 模式禁用 attachments、media mention、selected text snippet、skill/kit 切换。
   - 键盘和按钮共用 `resolveSubmitIntent()`。

2. **Session Detail 层：展示 preview 与操作**
   - 在 `CoworkSessionDetail` 中渲染 pending/rejected/queued follow-up preview。
   - preview 只显示当前 session 的 steer state。
   - `Esc` 或按钮触发 interrupt-and-submit，不调用普通 Stop。
   - Plan confirmation UI 仍只在 `!isSessionBusy` 后出现。

3. **Service / Store 层：管理 steer 生命周期**
   - `coworkSlice` 管理 `steerDrafts`、`pendingSteers`、`rejectedSteers`。
   - `coworkService.submitSteer()` 只更新 steer state，不设置全局 `setStreaming(true)`。
   - 监听 `cowork:stream:steer` 更新 accepted/rejected/committed。
   - session 切换、delete、stop、complete 时清理对应 steer state。

4. **Main / Adapter 层：runtime routing**
   - `submitSteer` 必须绕开 `continueSession()` 和 `runTurn()`。
   - Adapter 使用 active turn/session key 调 OpenClaw 同轮 queue/steer API。
   - 如果 active turn missing，按 Codex 语义可回退为普通 follow-up，但必须 UI 可见。
   - 如果 non-steerable/context maintenance/compaction，进入 rejected queue。
   - interrupt-and-submit 才调用 `stopSession()`/`chat.abort` 后再 `continueSession()`。

需要避免的实现：

- 不要把 running 下普通 Enter 改成自动 steer。Codex 也会区分 pending steer preview
  与 queued follow-up。
- 不要把 `/goal ...` 作为 steer 文本注入 active turn。
- 不要把 Plan “开始实现”作为 steer 注入正在生成计划的 turn。
- 不要复用 `sessions.steer` 作为主路径，除非确认它不会 abort active run。

## 7. 数据与持久化

第一版不新增数据库表。Pending steer 属于运行态 UI state：

- Renderer Redux 保存当前 session pending/rejected preview。
- Main adapter 可保存内存态 pending map，用于跨 stream event 匹配。
- 应用重启或 session reload 后，未确认 pending steer 不恢复。

如果后续需要跨重启恢复，可新增 `cowork_pending_inputs` 表，但不属于第一版。

普通降级 follow-up 的最终提交仍走现有 user message 持久化路径。

## 8. 状态机

```text
Idle
  -> user clicks Steer while session running
SteerComposing
  -> submit
PendingSteer
  -> runtime accepted
Accepted
  -> stream/history confirms user input included
Cleared

PendingSteer
  -> active turn not steerable
RejectedSteer
  -> current turn completed
QueuedFollowUp / AutoSubmit

PendingSteer
  -> user interrupt-and-send
SendingAfterInterrupt
  -> interrupted
StartNewTurnWithMergedSteers
```

### 8.1 Accepted Steer

当 OpenClaw 确认 steer 接受：

- Main 发送 `status: accepted`。
- Renderer preview 可以继续保留为“已提交，等待模型采纳”，也可以在下一条
  assistant/tool 边界后移除。
- 历史 reconciliation 如果返回对应 user input，应清理 pending preview，避免重复。

### 8.2 Rejected Steer

当 OpenClaw 返回 non-steerable：

- Main 不把它当错误弹窗打断用户。
- Renderer 将其移动到 rejected steer 区。
- 当前 turn 完成后，按普通 follow-up 自动提交；如果自动提交失败，恢复到输入框。

### 8.3 Interrupt And Submit

当用户选择立即中断：

- 若只有一个 pending steer，直接作为下一轮用户消息提交。
- 若有多个 pending steer，按创建顺序用两个换行合并。
- 合并后的消息要保留用户可见文本，不带内部 steer marker。
- 原 pending steer preview 清空。

## 9. UI 设计要求

### 9.1 输入框运行中状态

运行中状态下输入框不再完全只读，而是提供明确模式：

- 默认显示 stop 按钮和 `Steer` 按钮。
- 点击 `Steer` 后 textarea 可编辑。
- placeholder：`Ask for follow-up changes` 的 LobsterAI 文案可为
  “补充当前任务的调整要求”。
- 发送按钮 tooltip：`Steer current task` / `引导当前任务`。

### 9.2 Preview 区

Preview 位于 prompt input 上方，与 permission、media polling、goal chip、plan
confirmation 不重叠。它应：

- 最多展示 3 行正文，超出折叠。
- 区分 pending、rejected、queued follow-up。
- 支持移除单条 pending/rejected steer。
- 支持点击恢复到输入框编辑。

### 9.3 i18n

新增 key 示例：

- `coworkSteer`
- `coworkSteerPlaceholder`
- `coworkSteerSubmit`
- `coworkSteerPendingHeader`
- `coworkSteerRejectedHeader`
- `coworkSteerInterruptAndSend`
- `coworkSteerNotSupportedThisTurn`
- `coworkSteerQueuedAfterTurn`

中英文必须同时添加。

## 10. 与现有功能交互

### 10.1 Plan Mode

- 计划模式 running turn 中允许 steer 调整计划。
- 允许的同轮 steer 类型：
  - “补充考虑 X 风险”
  - “计划里不要改数据库”
  - “把方案拆成更小步骤”
  - “先比较 A/B 两个实现路径”
- 不允许作为同轮 steer 的类型：
  - “按这个计划执行”
  - “开始写代码”
  - “直接修改文件”
  - “不用计划了，马上实现”
- 如果 steer 文案表达“确认执行”，应走计划确认逻辑，触发 interrupt-and-submit 或在
  当前 turn 结束后以默认模式提交。
- steer 不得让 plan mode 中的工具限制失效。
- `OpenClawRuntimeAdapter` 现有 plan mode safety guard 会拦截写入类工具，并在重复
  blocked tool call 时 stop/recover。Steer 不能绕过 `turn.planMode` 和这些 guard。
- 当前 `CoworkSessionDetail` 只在 `!isSessionBusy` 时设置 awaiting plan
  confirmation；因此运行中的计划结果未完成前，不应展示“确认执行”作为 steer 操作。

### 10.2 Goal Mode

- Goal command 控制不作为 steer，优先级高于 steer。
- 运行中目标会话可 steer 目标执行方向。
- 目标暂停/完成/阻塞仍走 goal IPC，不经过 steer。
- 当前 Goal input 可以在 running 时提交，因为 `goalCommandCanRunWhileStreaming`
  放开了 streaming guard。Steer 不能复用这个 flag，而应有自己的
  `steerCommandCanRunWhileStreaming` 或显式 input mode。
- 如果输入框处于 Goal composing：
  - Enter/Send 提交 `/goal ...`；
  - 不展示或不启用 Steer submit；
  - 成功后按现有逻辑清空 goal draft。
- 如果 session 有 active goal，但输入框不在 Goal composing：
  - 用户可以点击 Steer 调整当前执行方向；
  - Steer 文案作为当前 turn 指令，不改变 goal status；
  - “暂停目标/恢复目标/完成目标/阻塞目标”仍必须通过 Goal action。

### 10.3 Permissions

- 有权限弹窗时可以允许用户写 steer，但默认不立即发送，避免同时改变审批上下文。
- 如果 steer 明确否定当前工具行为，用户应优先 deny 当前权限请求并补充 steer。
- 未来可提供“拒绝并发送 steer”组合操作，不属于第一版。
- 如果权限请求来自 Plan mode 中被拦截/恢复的 tool call，Steer 不应自动批准或
  自动重试该 tool call。

### 10.4 Attachments / Images / Selected Text

第一版 steer 只支持纯文本：

- 不支持新增文件附件。
- 不支持图片输入。
- 不支持 selected text snippet 自动绑定。
- 如果用户在 steer composing 前已有普通 draft 附件，切换 steer 时不得丢失普通
  draft；退出 steer 后恢复。

### 10.5 IM / Scheduled Tasks / Subagents

第一版不在这些入口展示 steer UI：

- IM 中运行中的新消息继续按当前 session mapping 策略处理。
- Scheduled task 不接受用户 steer。
- Subagent session 可后续复用同一 adapter 能力，但第一版不暴露入口。

## 11. 实施计划

### Phase 0: OpenClaw 能力确认

1. 确认 pinned OpenClaw gateway 是否有同轮 active-run queue / steering RPC。
2. 明确排除会 abort active run 的 `sessions.steer` 主路径，除非用于“立即中断并
   发送”。
3. 验证能否通过现有 `agent` active-run queue fallback、`chat.send` 参数，或新增
   RPC 调用 OpenClaw 内部 `queueEmbeddedAgentMessageWithOutcomeAsync(...,
   { steeringMode: "all" })`。
4. 记录方法名、参数、session key 解析、返回结构、错误 reason 和 active turn
   结束前后的行为。
5. 若无可用同轮 API，决定是否先做降级 UI，或添加 OpenClaw version scoped patch。

### Phase 1: Renderer 输入模式与 Preview

1. 在 `coworkSlice` 增加 steer draft 和 pending steer state。
2. 在 `CoworkPromptInput` 增加运行中 `Steer` 模式，并实现 Goal/Steer/Plan/Normal
   的显式 submit intent 派生。
3. 在 `CoworkSessionDetail` 增加 pending/rejected preview。
4. 禁用 steer 模式下的附件、技能切换和媒体入口。
5. 增加中英文 i18n。
6. 确认进入/退出 Steer 不会清空普通 draft、Goal draft、Plan mode 状态或 awaiting
   plan confirmation。

### Phase 2: IPC 与 Adapter

1. 增加 shared IPC channel 和类型。
2. preload 暴露 `submitSteer` 与 `interruptAndSubmitSteers`。
3. main 注册 handler。
4. `CoworkEngineRouter` 转发到 OpenClaw adapter。
5. OpenClaw adapter 实现 steer 或明确返回 not-supported。
6. 保证 `submitSteer` 不调用 `continueSession`，不触发 `runTurn()` 的 active
   session guard，也不预先写普通 user message。

### Phase 3: Runtime Reconciliation

1. 监听 runtime accepted/rejected/turn completed 事件。
2. 清理 pending preview。
3. non-steerable 时移动到 rejected。
4. turn 完成后自动提交 rejected steer 或恢复输入框。
5. stop/interrupt 后合并 pending steers。
6. 在 `cleanupSessionTurn()` 类似时机处理 pending steer，避免 session 切换或
   active turn 结束后残留。

### Phase 4: Tests And Manual Validation

1. Unit test：steer state reducer。
2. Unit test：输入框 streaming 状态下允许 steer 但禁用附件。
3. Unit test：adapter active turn mismatch 重试一次。
4. Unit test：non-steerable 降级为 rejected。
5. Unit test：Goal composing + streaming 时 Enter 仍提交 goal command，不触发 steer。
6. Unit test：Plan mode + running + normal draft 时普通 Enter 仍被阻止；点击 Steer
   后才提交 steer。
7. Unit test：Plan implementation approval 文案不作为同轮 steer，必须走 plan
   confirmation / interrupt-and-submit 路径。
8. Unit test：进入/退出 Steer 不丢失普通 draft、Goal draft、Plan mode。
9. Manual：Electron 中运行长任务，提交 steer，确认任务采纳新要求。
10. Manual：Plan mode 生成计划时 steer “调整计划”，确认不会开始写文件。
11. Manual：Goal running session 中分别测试 goal pause/resume 和 steer direction，
   确认两条控制路径互不污染。

## 12. 验收标准

1. 运行中 Cowork session 显示 `Steer` 入口，普通停止任务仍可用。
2. 点击 `Steer` 后可以输入纯文本并提交，不需要等待当前任务结束。
3. Pending steer 在输入区上方可见，显示生效时机。
4. runtime 接受 steer 后，pending 状态正确清理或标记为 accepted。
5. runtime 拒绝 steer 时，消息降级为本轮结束后的 follow-up，用户可见。
6. 用户可选择“立即中断并发送”，任务停止后自动以合并 steer 开始新 turn。
7. 普通运行中附件、图片、文件拖拽仍被禁用，不破坏原 draft。
8. Plan mode、Goal mode、权限弹窗和 stop 行为不回归。
9. 所有新增用户可见文案有中英文翻译。
10. touched TypeScript/TSX 文件通过 changed-file ESLint。
11. Goal/Plan/Steer/Normal submit intent 在运行中和空闲状态均有明确、可测试结果。

## 13. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| OpenClaw 当前版本没有 steer API | Phase 1 只做 UI 降级，或使用 version scoped OpenClaw patch，不做 brittle transcript 写入。 |
| 用户以为 steer 一定立即生效 | Preview 明确展示“下个工具/结果边界”或“本轮结束后”。 |
| active turn id race 导致 steer 发给错误 turn | 请求带 expected turn id，mismatch 最多重试一次。 |
| steer 与普通 queued follow-up 混淆 | 数据结构和 UI 分区独立，文案区分 pending steer/rejected steer/queued follow-up。 |
| 权限弹窗期间 steer 改变审批上下文 | 权限弹窗 active 时默认 pending，不自动批准或改变当前审批结果。 |
| 计划模式被 steer 绕过 | Main runtime 继续应用 plan mode 工具限制和批准实现兜底。 |
| pending state 跨 session 泄漏 | 所有 pending steer 带 sessionId，session 切换时只显示当前 session。 |
| Goal/Plan/Steer 都占用输入框导致提交语义混乱 | 引入显式 submit intent 派生和优先级：Goal > Steer > Plan > Normal，并补对应单测。 |
| 用户把“开始实现计划”作为 steer 提交 | 将 plan implementation approval 文案识别为 plan confirmation/interrupt-and-submit，不进入同轮 steer。 |

## 14. 待确认问题

1. 当前 pinned OpenClaw 是否已经暴露同轮 steer API？如果没有，第一版是否接受“UI
   降级为 queued follow-up”的有限版本？
2. Steer 的主入口文案采用英文 `Steer`、中文“引导”，还是更明确的“调整方向”？
3. runtime 接受 steer 后，是否需要在历史中显示一条轻量 user steer 气泡，还是只在
   preview 清理？
4. 多条 pending steer 是逐条发送给 active turn，还是合并后发送？
5. 权限弹窗场景是否需要第一版提供“拒绝并发送 steer”的组合按钮？
