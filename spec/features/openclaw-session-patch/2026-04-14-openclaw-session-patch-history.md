# OpenClaw Session Patch History

**Feature ID**: openclaw-session-patch
**Created**: 2026-04-14
**Status**: Implemented
**Last Updated**: 2026-04-14

## Background

Cowork 区之前的模型切换逻辑并不是会话级能力。

在以下位置，模型选择器会直接写回当前 agent 的默认模型：

- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/CoworkView.tsx`

这带来两个问题：

1. 用户在某个会话里切换模型，实际上污染了 `agent.model`
2. OpenClaw 已经提供 `sessions.patch` 的会话级 override，但 LobsterAI 没有接这条能力

同时，channel / IM 创建的 remote-managed 会话原本不显示模型选择器，导致这些会话无法在 UI 上改当前会话模型。

## Goals

本次改动的目标是：

1. 引入通用的 OpenClaw session patch 能力，而不是仅为模型做专用接口
2. 先把 `model` 作为 patch 的首个落地字段
3. 让 active session 的模型选择器改为 patch 当前会话，不再改 agent 默认模型
4. 让 remote-managed / channel 会话也能在 UI 中切换当前会话模型

## Key Design Decisions

## 1. 接口设计成通用 patch

没有新增 `setSessionModel()` 这种专用接口，而是新增了：

- `src/common/openclawSession.ts`
- `src/main/openclawSession/constants.ts`

核心抽象是：

- `OpenClawSessionPatch`
- IPC `openclaw:session:patch`
- runtime `patchSession(sessionId, patch)`

这样后续如果要支持：

- `thinkingLevel`
- `reasoningLevel`
- `elevatedLevel`
- `responseUsage`
- `sendPolicy`

不需要重做接口层。

## 2. 本地会话持久化 `modelOverride`

为了让 UI 在应用重启、会话切换、重新载入时仍能显示会话级模型，给 `cowork_sessions` 加了：

- `model_override TEXT NOT NULL DEFAULT ''`

并在 renderer / main 的 `CoworkSession` 类型里补了：

- `modelOverride: string`

这里没有持久化“effectiveModel”，因为它是派生值，不是 source of truth。

## 3. Active session 优先读取会话 override

`resolveAgentModelSelection(...)` 被扩展为优先考虑：

1. `sessionModel`
2. `agentModel`
3. `fallbackModel`

所以详情页输入框中的模型选择器现在优先反映当前会话的 override。

## 4. remote-managed 会话只放开模型切换，不放开发消息

对于 channel / IM 创建的会话，仍然保持：

- 输入框 disabled
- 附件按钮隐藏
- 技能按钮隐藏

但模型选择器改为可见且可用。

这确保：

- UI 不能向 remote-managed 会话主动发消息
- 但可以修改该会话后续在 OpenClaw 中使用的模型

## 5. patch 必须命中真实 channel sessionKey

这是本次实现里最关键的修正。

初版 `patchSession()` 使用：

- `toSessionKey(sessionId, agentId)`

这对本地 managed 会话可行，但对 channel 会话不对。channel 会话真正执行时使用的是类似：

- `agent:main:openclaw-weixin:...`

的真实 channel `sessionKey`。

这导致一个隐蔽 bug：

1. UI 执行 `sessions.patch` 返回成功
2. 但 patch 到的是 managed key，而不是正在跑的 channel key
3. IM 通道后续 `/new` 或继续对话时，实际仍然走旧模型

修复后，`OpenClawRuntimeAdapter.patchSession()` 的 key 选择顺序变成：

1. 当前 active turn 的 `sessionKey`
2. 已记住的非 managed `sessionKey`
3. `toSessionKey(sessionId, agentId)` 作为兜底

也就是说，channel 会话优先 patch 到真实 channel key。

## Files Changed

核心新增：

- `src/common/openclawSession.ts`
- `src/main/openclawSession/constants.ts`
- `docs/openclaw-session-model-override-plan.md`

主进程与 runtime：

- `src/main/main.ts`
- `src/main/preload.ts`
- `src/main/sqliteStore.ts`
- `src/main/coworkStore.ts`
- `src/main/libs/agentEngine/types.ts`
- `src/main/libs/agentEngine/claudeRuntimeAdapter.ts`
- `src/main/libs/agentEngine/coworkEngineRouter.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

Renderer：

- `src/renderer/services/cowork.ts`
- `src/renderer/types/cowork.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/components/cowork/CoworkView.tsx`
- `src/renderer/components/cowork/agentModelSelection.ts`
- `src/renderer/components/cowork/agentModelSelection.test.ts`

测试补充：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`

## Verification

本次改动完成后做过的验证：

- `./node_modules/.bin/vitest run src/renderer/components/cowork/agentModelSelection.test.ts`
- `npx tsc -p tsconfig.json --noEmit`
- `npx tsc -p electron-tsconfig.json --noEmit`

定向 eslint 只剩仓库原本就存在于 `openclawRuntimeAdapter.ts` 的 warning，没有新增 error。

## Known Gaps

本次没有一起完成的部分：

1. Home 空态的新会话草稿模型选择，还没有完全切到“草稿态 session override”语义
2. 主进程目前只把 `patch.model` 同步回本地 SQLite；其他 patch 字段虽然接口预留了，但还没做本地持久化展示
3. 没有补一条专门覆盖“channel 会话 patch 后 IM `/new` 继续沿用 override”的自动化测试

## Why This Matters

从行为上看，这次改动把“模型切换”从 agent 级别拉回到了真正的会话级别。

对用户来说，最重要的结果是：

- 在普通 cowork 会话里切换模型，不再改 agent 默认模型
- 在 remote-managed/channel 会话里，即使不能回复消息，也能改当前会话模型
- 对 channel 会话，patch 现在会命中真实运行中的 sessionKey，而不是写到错误的 managed key 上

