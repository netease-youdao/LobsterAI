# OpenClaw 工具中止后继续模型轮次修复设计

## 1. 概述

### 1.1 问题

LobsterAI 用户在工具执行期间手动停止任务后，紧接着发送新消息，偶发收到：

```text
session file locked (timeout 60000ms): pid=... alive=true ageMs=...
```

失败后继续向同一会话发送消息，仍会等待并命中同一个存活进程持有的 session lock。现场日志还出现 `embedded abort settle timed out`，并显示旧 run 在 abort 后又进入了一次模型请求。

### 1.2 实际运行包核查

问题修复前，Windows 实际运行包 `vendor/openclaw-runtime/win-x64/runtime-build-info.json` 记录：

- OpenClaw 版本：`v2026.6.1`
- OpenClaw commit：`2e08f0f4221f522b60423ed6ffd83427942b28de`
- 构建时间：`2026-07-13T06:22:34.083Z`

运行包已有 LobsterAI 的 `openclaw-aborted-tool-loop-breaker.patch`，但该补丁只负责累计 aborted tool outcome 的历史清理和循环熔断。运行 bundle 中不存在上游 #94412 新增的 `Agent run aborted` 终止路径，因此没有覆盖“单次工具执行被 abort 后立即停止 agent loop”的场景。

### 1.3 根因

OpenClaw `v2026.6.1` 的 `packages/agent-core/src/agent-loop.ts` 在 `executeToolCalls()` 返回后，会继续执行：

1. `turn_end`；
2. `prepareNextTurn()`；
3. `shouldStopAfterTurn()`；
4. `getSteeringMessages()`；
5. 下一次 `streamAssistantResponse()`。

这些边界没有重新检查当前 `AbortSignal`。如果停止发生在工具执行期间，工具完成或延迟完成后，旧 run 仍可能请求下一轮模型。LobsterAI 此时可能已把本地会话标记为 idle 并提交排队消息，新旧 run 竞争同一个 OpenClaw session write lock，最终表现为 live-pid lock timeout。

## 2. 上游修复依据

上游 OpenClaw 已在以下提交修复：

- commit：`7fe287b0d30d9ae3998dbf4da04f9498dd37f7a6`
- 标题：`fix(agent-core): stop loop after aborted tool run (#94412)`
- 合并日期：2026-06-22
- 首个包含该提交的稳定标签：`v2026.6.11`

上游修复在 agent loop 的关键异步边界重复检查 abort，并在退出前追加一个 `stopReason: "aborted"` 的 assistant message，完整发出 `message_start`、`message_end`、`turn_end` 和 `agent_end`，避免 transcript 停留在未闭合的 `toolUse` 轮次。

## 3. 修复目标

1. 工具执行期间停止 run 后，旧 run 不得再调用模型。
2. 异步 `prepareNextTurn()` 期间发生 abort 后，同样不得再调用模型。
3. 保持 Agent 事件生命周期闭合，持久化明确的 aborted assistant outcome。
4. 以 `v2026.6.1` 版本专属 patch 移植，不在 LobsterAI 业务层复制 OpenClaw agent loop。
5. 保留明确的补丁下线条件，避免未来升级后重复套用上游修复。

## 4. 实现方案

新增：

```text
scripts/patches/v2026.6.1/openclaw-stop-loop-after-aborted-tool-run.patch
```

补丁修改 OpenClaw：

- `packages/agent-core/src/agent-loop.ts`
  - 增加 `stopIfAborted()`。
  - 跟踪当前 turn 是否处于打开状态。
  - 在进入下一轮、注入 pending message 后、工具轮次结束后、`prepareNextTurn()` 后和读取 steering message 后检查 abort。
  - abort 时写入 aborted assistant message 并发出完整的终止事件。
- `packages/agent-core/src/agent-loop.test.ts`
  - 覆盖工具执行函数触发 abort。
  - 覆盖异步 turn hook 触发 abort。
  - 两个场景都断言模型 stream 只调用一次。

`scripts/apply-openclaw-patches.cjs` 增加强校验，防止 patch 因上下文变化被误判为已应用；LobsterAI 侧增加 patch 内容测试，确保关键源码和回归测试不会从版本补丁中意外丢失。

## 5. 补丁生命周期

该补丁只适用于 LobsterAI 当前固定的 OpenClaw `v2026.6.1`。

未来将 `package.json` 中的 `openclaw.version` 升级到 `v2026.6.11` 或更高稳定版本时，应执行以下审计：

1. 确认目标 tag 包含 commit `7fe287b0d3`，或包含语义等价的 abort boundary 修复和回归测试。
2. 不要把 `openclaw-stop-loop-after-aborted-tool-run.patch` 迁移到新版本 patch 目录。
3. 删除或调整 `abortedToolRunExitPatch.test.ts` 中要求当前版本携带该 patch 的断言。
4. 删除 `apply-openclaw-patches.cjs` 中该 patch 的强校验；如保留旧版本 patch 作为历史构建输入，则只保留与旧版本目录相匹配的校验。
5. 在新 runtime bundle 中确认 abort 后不再出现同一旧 run 的后续 provider request。

完成上述核查后，可去除本补丁，避免与上游实现重复。

## 6. 边界情况

| 场景 | 预期处理 |
|------|----------|
| 工具执行前 signal 已 abort | 不调用模型，直接记录 aborted outcome 并结束 |
| 工具执行期间 abort，工具快速返回 | 完成当前工具结果事件后结束，不进入下一模型轮次 |
| 工具执行期间 abort，工具延迟返回 | 工具返回后在首个 agent-loop 边界结束，不进入下一模型轮次 |
| `prepareNextTurn()` 异步执行期间 abort | hook 返回后立即结束，不执行 stop hook、steering 或模型请求 |
| 上一个 `turn_end` 已发出 | 先补发 `turn_start`，再写 aborted message，保证事件配对 |

## 7. 验收标准

1. 新 patch 能从干净 OpenClaw `v2026.6.1` 与其余 LobsterAI patch 一起应用。
2. patch 强校验和 LobsterAI patch 内容测试通过。
3. OpenClaw 回归测试中，工具 abort 和 async turn hook abort 的 `streamCalls` 都为 1。
4. 构建后的 gateway bundle 包含 `Agent run aborted` 终止路径。
5. LobsterAI 中停止长时间 browser 工具并立即提交排队消息时，旧 run 不再发起额外模型请求。
6. 同一会话后续消息不再因为该路径出现 live-pid `session file locked`。

## 8. 验证计划

```bash
npm run openclaw:patch
npm test -- src/main/libs/openclawPatches/abortedToolRunExitPatch.test.ts
npm run openclaw:runtime:host
```

OpenClaw 源码侧 focused test：

```bash
node_modules/.bin/vitest.cmd run packages/agent-core/src/agent-loop.test.ts --reporter verbose
```

手工验证沿用 browser `act/wait` 中止场景，并检查 gateway 日志中 stop 之后是否仍出现旧 run 的 provider request。
